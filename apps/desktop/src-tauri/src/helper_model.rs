//! CPU-only generation for Qwen2.5-Coder-1.5B-Instruct.
//! `n_gpu_layers` is 0, so a compiled GPU backend is not given any layers.

use std::num::NonZeroU32;
use std::path::Path;
use std::time::Duration;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::{send_logs_to_tracing, LogOptions};

use crate::helper::{command_prompt, extract_command, is_destructive, ExtractError};

const MAX_NEW_TOKENS: i32 = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Generated {
    pub raw: String,
    pub command: Result<String, String>,
    pub destructive: bool,
    pub elapsed: Duration,
}

pub struct ShellGenerator {
    backend: LlamaBackend,
    model: LlamaModel,
    device_note: String,
}

impl ShellGenerator {
    pub fn load(path: &Path) -> Result<Self, String> {
        send_logs_to_tracing(LogOptions::default().with_logs_enabled(false));
        let backend = LlamaBackend::init().map_err(|e| e.to_string())?;
        let devices = llama_cpp_2::list_llama_ggml_backend_devices();
        let device_note = if devices.is_empty() {
            "no ggml devices reported; n_gpu_layers=0".to_string()
        } else {
            devices
                .iter()
                .map(|device| {
                    format!(
                        "{} {} ({:?})",
                        device.index, device.backend, device.device_type
                    )
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        // 0 keeps every layer on the CPU. GPU devices may be compiled in;
        // they are not given any layers.
        let params = LlamaModelParams::default().with_n_gpu_layers(0);
        let model = LlamaModel::load_from_file(&backend, path, &params)
            .map_err(|e| format!("load {}: {e}", path.display()))?;
        let loaded = Self {
            backend,
            model,
            device_note,
        };
        tracing::info!(
            devices = %loaded.device_note(),
            n_gpu_layers = 0,
            "loaded command helper on CPU"
        );
        Ok(loaded)
    }

    pub fn device_note(&self) -> &str {
        &self.device_note
    }

    pub fn generate(&self, os: &str, shell: &str, request: &str) -> Result<Generated, String> {
        let started = std::time::Instant::now();
        let prompt = command_prompt(os, shell, request);
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(1024))
            .with_n_batch(512);
        let mut ctx = self
            .model
            .new_context(&self.backend, ctx_params)
            .map_err(|e| format!("context: {e}"))?;
        let tokens = self.model.vocab().tokenize(prompt.as_bytes(), false, true);
        if tokens.is_empty() {
            return Err("prompt tokenized to nothing".into());
        }
        if tokens.len() + MAX_NEW_TOKENS as usize > ctx.n_ctx() as usize {
            return Err("prompt does not fit in the 1024-token context".into());
        }
        let mut batch = LlamaBatch::new(512, 1);
        let last = tokens.len() - 1;
        for (i, token) in tokens.iter().copied().enumerate() {
            batch
                .add(token, i as i32, &[0], i == last)
                .map_err(|e| format!("batch: {e}"))?;
        }
        ctx.decode(&mut batch).map_err(|e| format!("decode: {e}"))?;

        let mut sampler = LlamaSampler::chain_simple([LlamaSampler::greedy()]);
        let mut raw_bytes = Vec::new();
        let prompt_len = batch.n_tokens();
        for n_cur in prompt_len..prompt_len.saturating_add(MAX_NEW_TOKENS) {
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            sampler.accept(token);
            if self.model.vocab().is_eog(token) {
                break;
            }
            let piece = self.model.vocab().token_to_piece(token, true, None);
            raw_bytes.extend_from_slice(&piece);
            if raw_bytes.contains(&b'\n') {
                break;
            }
            batch.clear();
            batch
                .add(token, n_cur, &[0], true)
                .map_err(|e| format!("batch: {e}"))?;
            ctx.decode(&mut batch).map_err(|e| format!("decode: {e}"))?;
        }
        let raw = String::from_utf8_lossy(&raw_bytes).into_owned();
        let command = extract_command(&raw).map_err(|err| match err {
            ExtractError::ProseOnly => "prose".to_string(),
            ExtractError::MultipleCommands => "multiple".to_string(),
        });
        let destructive = command
            .as_ref()
            .map(|cmd| is_destructive(cmd))
            .unwrap_or(false);
        Ok(Generated {
            raw,
            command,
            destructive,
            elapsed: started.elapsed(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    struct Case {
        name: &'static str,
        os: &'static str,
        shell: &'static str,
        request: &'static str,
        check: fn(&str) -> bool,
    }

    fn cases() -> Vec<Case> {
        vec![
            Case {
                name: "a named file",
                os: "darwin",
                shell: "zsh",
                request: "find files named notes.txt under the current directory",
                check: |cmd| {
                    cmd.contains("find")
                        && cmd.contains("-name")
                        && cmd.contains("notes.txt")
                        && !cmd.contains("-printf")
                },
            },
            Case {
                name: "size",
                os: "darwin",
                shell: "zsh",
                request: "find files larger than 10 megabytes under the current directory",
                check: |cmd| {
                    cmd.contains("find")
                        && cmd.contains("-size")
                        && (cmd.contains("10M") || cmd.contains("10m") || cmd.contains("10485760"))
                },
            },
            Case {
                name: "delete logs",
                os: "darwin",
                shell: "zsh",
                request: "delete files matching *.log in the current directory",
                check: |cmd| {
                    (cmd.contains("rm") || (cmd.contains("find") && cmd.contains("-delete")))
                        && cmd.to_ascii_lowercase().contains("log")
                },
            },
            Case {
                name: "mtime",
                os: "linux",
                shell: "bash",
                request: "find files modified in the last 24 hours",
                check: |cmd| cmd.contains("find") && cmd.contains("-mtime"),
            },
            Case {
                name: "disk",
                os: "darwin",
                shell: "fish",
                request: "show disk usage of this directory",
                check: |cmd| cmd.contains("du"),
            },
            Case {
                name: "grep",
                os: "darwin",
                shell: "zsh",
                request: "search the current directory for the text TODO",
                check: |cmd| cmd.contains("grep") && cmd.contains("TODO"),
            },
        ]
    }

    #[test]
    #[ignore = "loads the official 491MB GGUF on CPU; set SPARKMUX_QWEN_GGUF and SPARKMUX_QWEN_EVAL_OUT"]
    fn eval_official_prompts() {
        let model_path =
            PathBuf::from(std::env::var("SPARKMUX_QWEN_GGUF").expect("SPARKMUX_QWEN_GGUF"));
        let out_dir =
            PathBuf::from(std::env::var("SPARKMUX_QWEN_EVAL_OUT").expect("SPARKMUX_QWEN_EVAL_OUT"));
        fs::create_dir_all(&out_dir).unwrap();
        let started = std::time::Instant::now();
        let generator = ShellGenerator::load(&model_path).expect("load");
        let load_elapsed = started.elapsed();
        let mut rows = String::new();
        let mut failed = Vec::new();
        for case in cases() {
            let generated = generator.generate(case.os, case.shell, case.request);
            let (elapsed_ms, raw, command, ok) = match generated {
                Ok(generated) => {
                    let command = generated.command.clone().unwrap_or_default();
                    let ok = generated.command.is_ok()
                        && (case.check)(&command)
                        && generated.elapsed < Duration::from_secs(60);
                    (generated.elapsed.as_millis(), generated.raw, command, ok)
                }
                Err(err) => (0, err, String::new(), false),
            };
            if !ok {
                failed.push(case.name);
            }
            rows.push_str(&format!(
                "### {} ({}/{})\n\n- request: `{}`\n- elapsed_ms: {elapsed_ms}\n- pass: {ok}\n- raw: `{}`\n- command: `{}`\n\n",
                case.name,
                case.os,
                case.shell,
                case.request,
                raw.replace('`', "'"),
                command.replace('`', "'"),
            ));
            let partial = format!(
                "# partial\n\n- load_ms: {}\n- devices: {}\n\n{rows}",
                load_elapsed.as_millis(),
                generator.device_note(),
            );
            fs::write(out_dir.join("results.md"), partial).unwrap();
        }
        let bytes = fs::metadata(&model_path).unwrap().len();
        let report = format!(
            "# Qwen2.5-Coder-1.5B-Instruct Q4_K_M CPU eval\n\n\
- model: `{}`\n\
- bytes: {bytes}\n\
- load_ms: {}\n\
- devices: {}\n\
- n_gpu_layers: 0\n\
- entry: `ShellGenerator::generate`\n\n\
{rows}",
            model_path.display(),
            load_elapsed.as_millis(),
            generator.device_note(),
        );
        fs::write(out_dir.join("results.md"), &report).unwrap();
        let license = include_str!("../models/Qwen2.5-Coder-1.5B-Instruct.LICENSE");
        let provenance = format!(
            "# Provenance\n\n\
- file: `{WEIGHT}`\n\
- bytes: {bytes}\n\
- url: {URL}\n\
- license: Apache-2.0\n\
- license notice shipped at `apps/desktop/src-tauri/models/Qwen2.5-Coder-1.5B-Instruct.LICENSE` ({license_bytes} bytes)\n\
- first line of shipped notice: {first}\n",
            WEIGHT = crate::helper::WEIGHT_NAME,
            URL = crate::helper::WEIGHT_URL,
            license_bytes = license.len(),
            first = license.lines().nth(1).unwrap_or("").trim(),
        );
        fs::write(out_dir.join("provenance.md"), provenance).unwrap();
        assert!(failed.is_empty(), "failed prompts: {failed:?}\n{report}");
    }

    /// Scores `Generated.command` from `ShellGenerator::generate` only.
    /// `align_content_search` is not applied, so a find-name miss stays a miss.
    #[test]
    #[ignore = "CPU compare of a local GGUF; set SPARKMUX_QWEN_GGUF and SPARKMUX_QWEN_EVAL_OUT"]
    fn eval_compare_holdouts() {
        let model_path =
            PathBuf::from(std::env::var("SPARKMUX_QWEN_GGUF").expect("SPARKMUX_QWEN_GGUF"));
        let out_dir =
            PathBuf::from(std::env::var("SPARKMUX_QWEN_EVAL_OUT").expect("SPARKMUX_QWEN_EVAL_OUT"));
        fs::create_dir_all(&out_dir).unwrap();
        let title = std::env::var("SPARKMUX_QWEN_EVAL_TITLE")
            .unwrap_or_else(|_| "Qwen coder CPU compare".to_string());
        let bytes = fs::metadata(&model_path).map(|m| m.len()).unwrap_or(0);
        let started = std::time::Instant::now();
        let generator = match ShellGenerator::load(&model_path) {
            Ok(generator) => generator,
            Err(err) => {
                let report = format!(
                    "# {title}\n\n- model: `{}`\n- bytes: {bytes}\n- load_ms: 0\n- devices: load failed\n- n_gpu_layers: 0\n- entry: `ShellGenerator::generate`\n- eligible: false\n\nload error: {err}\n",
                    model_path.display()
                );
                fs::write(out_dir.join("results.md"), report).unwrap();
                return;
            }
        };
        let load_elapsed = started.elapsed();

        struct Run {
            name: &'static str,
            os: &'static str,
            shell: &'static str,
            request: &'static str,
            check: fn(&str) -> bool,
        }
        let content =
            |cmd: &str| cmd.contains("grep") && cmd.contains("error") && !cmd.contains("-name");
        let named = |cmd: &str| {
            cmd.contains("find") && cmd.contains("-name") && !cmd.trim_start().starts_with("grep")
        };
        let mut runs = Vec::new();
        for case in cases() {
            runs.push(Run {
                name: case.name,
                os: case.os,
                shell: case.shell,
                request: case.request,
                check: case.check,
            });
        }
        runs.push(Run {
            name: "holdout content error",
            os: "darwin",
            shell: "zsh",
            request: "find the file containing the content of \"error\"",
            check: content,
        });
        runs.push(Run {
            name: "holdout content error repeat",
            os: "darwin",
            shell: "zsh",
            request: "find the file containing the content of \"error\"",
            check: content,
        });
        runs.push(Run {
            name: "holdout named error",
            os: "darwin",
            shell: "zsh",
            request: "find the file named error",
            check: named,
        });
        runs.push(Run {
            name: "holdout named error repeat",
            os: "darwin",
            shell: "zsh",
            request: "find the file named error",
            check: named,
        });
        runs.push(Run {
            name: "holdout include string",
            os: "darwin",
            shell: "zsh",
            request: "which files include the string error",
            check: content,
        });

        struct Row {
            name: String,
            os: String,
            shell: String,
            request: String,
            elapsed_ms: u128,
            pass: bool,
            raw: String,
            command: String,
        }
        let mut rows = Vec::new();
        for run in &runs {
            let generated = generator.generate(run.os, run.shell, run.request);
            let row = match generated {
                Ok(generated) => {
                    let command = match &generated.command {
                        Ok(cmd) => cmd.clone(),
                        Err(err) => format!("error: {err}"),
                    };
                    let predicate = generated
                        .command
                        .as_ref()
                        .map(|cmd| (run.check)(cmd))
                        .unwrap_or(false);
                    let pass = predicate && generated.elapsed < Duration::from_secs(60);
                    Row {
                        name: run.name.to_string(),
                        os: run.os.to_string(),
                        shell: run.shell.to_string(),
                        request: run.request.to_string(),
                        elapsed_ms: generated.elapsed.as_millis(),
                        pass,
                        raw: generated.raw,
                        command,
                    }
                }
                Err(err) => Row {
                    name: run.name.to_string(),
                    os: run.os.to_string(),
                    shell: run.shell.to_string(),
                    request: run.request.to_string(),
                    elapsed_ms: 0,
                    pass: false,
                    raw: err,
                    command: "error: generation".into(),
                },
            };
            rows.push(row);
        }
        fn same_command(rows: &[Row], left: &str, right: &str) -> bool {
            let a = rows
                .iter()
                .find(|row| row.name == left)
                .map(|row| row.command.as_str());
            let b = rows
                .iter()
                .find(|row| row.name == right)
                .map(|row| row.command.as_str());
            a.is_some() && a == b
        }
        if !same_command(
            &rows,
            "holdout content error",
            "holdout content error repeat",
        ) {
            for row in &mut rows {
                if row.name == "holdout content error" || row.name == "holdout content error repeat"
                {
                    row.pass = false;
                }
            }
        }
        if !same_command(&rows, "holdout named error", "holdout named error repeat") {
            for row in &mut rows {
                if row.name == "holdout named error" || row.name == "holdout named error repeat" {
                    row.pass = false;
                }
            }
        }

        let mut body = String::new();
        for row in &rows {
            body.push_str(&format!(
                "### {} ({}/{})\n\n- request: `{}`\n- elapsed_ms: {}\n- pass: {}\n- raw: `{}`\n- command: `{}`\n\n",
                row.name,
                row.os,
                row.shell,
                row.request,
                row.elapsed_ms,
                row.pass,
                row.raw.replace('`', "'"),
                row.command.replace('`', "'"),
            ));
        }
        let eligible = rows.iter().all(|row| row.pass);
        let report = format!(
            "# {title}\n\n\
- model: `{}`\n\
- bytes: {bytes}\n\
- load_ms: {}\n\
- devices: {}\n\
- n_gpu_layers: 0\n\
- entry: `ShellGenerator::generate`\n\
- scored: `Generated.command` before `align_content_search`\n\
- eligible: {eligible}\n\n\
{body}",
            model_path.display(),
            load_elapsed.as_millis(),
            generator.device_note(),
        );
        fs::write(out_dir.join("results.md"), &report).unwrap();
    }
}
