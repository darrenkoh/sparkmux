//! Shell-command helper decisions. The model runtime lives in `helper_model`.
//! Capability, extraction, and danger marking stay pure so tests call them
//! without loading weights.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Official Qwen2.5-Coder-1.5B-Instruct Q4_K_M file, hosted on the Sparkmux GitHub release.
/// Apache-2.0, Copyright 2024 Alibaba Cloud. Unmodified from the Qwen Hugging Face repo.
pub const WEIGHT_URL: &str = "https://github.com/darrenkoh/sparkmux/releases/download/model-qwen2.5-coder-1.5b/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf";
pub const WEIGHT_NAME: &str = "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf";
/// Byte size of that exact Q4_K_M file.
pub const WEIGHT_BYTES: u64 = 1_117_320_768;
pub const MIN_MEMORY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const CONFIG_NAME: &str = "command-helper.toml";

pub const USAGE_TEXT: &str = "Ask only at a bare shell. Type a plain-language request. The app inserts the command. You run it.";

const SHELLS: &[&str] = &["zsh", "bash", "fish", "sh", "dash"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineFacts {
    pub arch: String,
    pub free_disk_bytes: u64,
    pub available_memory_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortResource {
    Disk,
    Memory,
    Cpu,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityDecision {
    pub allow: bool,
    pub request_download: bool,
    pub short: Option<ShortResource>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnableRequest {
    pub facts: MachineFacts,
    pub config_path: PathBuf,
    pub weight_dest: PathBuf,
    pub weight_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnabledHelper {
    pub enabled: bool,
    pub weight_path: PathBuf,
    pub already_enabled: bool,
    pub usage: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnableError {
    Refused {
        resource: ShortResource,
        message: String,
    },
    Io(String),
}

impl std::fmt::Display for EnableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EnableError::Refused { message, .. } => f.write_str(message),
            EnableError::Io(message) => f.write_str(message),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtractError {
    ProseOnly,
    MultipleCommands,
}

impl std::fmt::Display for ExtractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExtractError::ProseOnly => f.write_str("model returned prose, not a command"),
            ExtractError::MultipleCommands => f.write_str("model returned more than one command"),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct HelperFile {
    enabled: bool,
    weight_path: String,
}

pub fn decide_capability(facts: &MachineFacts, weight_bytes: u64) -> CapabilityDecision {
    if facts.arch != "aarch64" {
        return CapabilityDecision {
            allow: false,
            request_download: false,
            short: Some(ShortResource::Cpu),
            message: format!(
                "This CPU architecture ({}) cannot run the helper. It needs aarch64.",
                facts.arch
            ),
        };
    }
    if facts.available_memory_bytes < MIN_MEMORY_BYTES {
        return CapabilityDecision {
            allow: false,
            request_download: false,
            short: Some(ShortResource::Memory),
            message: format!(
                "Not enough available memory ({} bytes). The helper needs at least 2 GB.",
                facts.available_memory_bytes
            ),
        };
    }
    if facts.free_disk_bytes < weight_bytes {
        return CapabilityDecision {
            allow: false,
            request_download: false,
            short: Some(ShortResource::Disk),
            message: format!(
                "Not enough free disk ({} bytes). The model file is {} bytes.",
                facts.free_disk_bytes, weight_bytes
            ),
        };
    }
    CapabilityDecision {
        allow: true,
        request_download: true,
        short: None,
        message: String::new(),
    }
}

pub fn shell_eligible(command: &str, alternate_on: bool) -> bool {
    if alternate_on {
        return false;
    }
    let base = command.rsplit(['/', '\\']).next().unwrap_or(command);
    let name = base.strip_prefix('-').unwrap_or(base);
    SHELLS.contains(&name)
}

pub fn command_prompt(os: &str, shell: &str, request: &str) -> String {
    format!(
        "<|im_start|>system\n\
You translate one request into one POSIX shell command.\n\
Operating system: {os}\n\
Shell: {shell}\n\
Reply with that command only, on one line. No markdown. No explanation.\n\
Do not join commands with ; or && or || or a pipe.\n\
The current directory is `.`.\n\
A size question is only find -size, not du.\n\
File names use find . -name. File contents, the word \"containing\", and the word \"text\" use grep -l, never find -name.\n\
Disk usage uses du. Deletes use rm or find -delete.\n\
On darwin, find has no -printf. A size in megabytes uses an M suffix, such as 2M.\n\
Modification time uses find -mtime.\n\
A name pattern that contains * or ? is quoted, such as find . -name 't*'.\n\
<|im_end|>\n\
<|im_start|>user\n\
find files named readme.md under the current directory\n\
<|im_end|>\n\
<|im_start|>assistant\n\
find . -name readme.md\n\
<|im_end|>\n\
<|im_start|>user\n\
search the current directory for the text FIXME\n\
<|im_end|>\n\
<|im_start|>assistant\n\
grep -R FIXME .\n\
<|im_end|>\n\
<|im_start|>user\n\
find the file containing the content of FIXME\n\
<|im_end|>\n\
<|im_start|>assistant\n\
grep -l -F -R -- FIXME .\n\
<|im_end|>\n\
<|im_start|>user\n\
find files larger than 2 megabytes under the current directory\n\
<|im_end|>\n\
<|im_start|>assistant\n\
find . -size +2M\n\
<|im_end|>\n\
<|im_start|>user\n\
{request}\n\
<|im_end|>\n\
<|im_start|>assistant\n"
    )
}

pub fn extract_command(raw: &str) -> Result<String, ExtractError> {
    let without_end = raw.replace("<|im_end|>", "").replace("<|endoftext|>", "");
    let fenced = strip_fence(without_end.trim());
    let commands: Vec<String> = fenced
        .lines()
        .map(|line| line.trim().trim_end_matches('\r'))
        .filter(|line| !line.is_empty())
        .filter(|line| !line.starts_with("```"))
        .map(|line| line.trim_start_matches("$ ").trim_start_matches("$").trim())
        .filter(|line| looks_like_command(line))
        .map(|line| line.to_string())
        .collect();
    match commands.as_slice() {
        [one] if !has_command_joiner(one) => Ok(quote_find_globs(strip_wrapping_quotes(one))),
        [] => Err(ExtractError::ProseOnly),
        _ => Err(ExtractError::MultipleCommands),
    }
}

pub fn is_destructive(command: &str) -> bool {
    has_file_redirect(command)
        || command.split_whitespace().any(|token| {
            let word = token.trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '\\'));
            matches!(word, "rm" | "mv" | "-delete")
        })
}

pub fn enable_helper(
    req: &EnableRequest,
    fetch: &mut dyn FnMut(&Path) -> Result<(), String>,
) -> Result<EnabledHelper, EnableError> {
    if let Some(existing) = read_helper_file(&req.config_path) {
        let path = PathBuf::from(&existing.weight_path);
        if existing.enabled && path == req.weight_dest && path.is_file() {
            return Ok(EnabledHelper {
                enabled: true,
                weight_path: path,
                already_enabled: true,
                usage: USAGE_TEXT.to_string(),
            });
        }
    }
    if weight_matches(&req.weight_dest, req.weight_bytes) {
        if let Some(err) = refuse_runtime(&req.facts) {
            return Err(err);
        }
        write_helper_file(&req.config_path, &req.weight_dest).map_err(EnableError::Io)?;
        return Ok(EnabledHelper {
            enabled: true,
            weight_path: req.weight_dest.clone(),
            already_enabled: false,
            usage: USAGE_TEXT.to_string(),
        });
    }
    let decision = decide_capability(&req.facts, req.weight_bytes);
    if !decision.allow {
        return Err(EnableError::Refused {
            resource: decision.short.unwrap_or(ShortResource::Cpu),
            message: decision.message,
        });
    }
    if let Some(parent) = req.weight_dest.parent() {
        fs::create_dir_all(parent).map_err(|e| EnableError::Io(e.to_string()))?;
    }
    fetch(&req.weight_dest).map_err(EnableError::Io)?;
    if !req.weight_dest.is_file() {
        return Err(EnableError::Io("weight file was not saved".into()));
    }
    write_helper_file(&req.config_path, &req.weight_dest).map_err(EnableError::Io)?;
    Ok(EnabledHelper {
        enabled: true,
        weight_path: req.weight_dest.clone(),
        already_enabled: false,
        usage: USAGE_TEXT.to_string(),
    })
}

pub fn read_enabled_config(config_path: &Path) -> Option<EnabledHelper> {
    let existing = read_helper_file(config_path)?;
    let path = PathBuf::from(&existing.weight_path);
    let current = path.file_name().and_then(|name| name.to_str()) == Some(WEIGHT_NAME);
    if existing.enabled && current && path.is_file() {
        Some(EnabledHelper {
            enabled: true,
            weight_path: path,
            already_enabled: true,
            usage: USAGE_TEXT.to_string(),
        })
    } else {
        None
    }
}

fn shell_basename(command: &str) -> String {
    let base = command.rsplit(['/', '\\']).next().unwrap_or(command);
    base.strip_prefix('-').unwrap_or(base).to_string()
}

#[derive(Debug, Serialize)]
pub struct HelperStatus {
    pub enabled: bool,
    pub weight_path: Option<String>,
    pub usage: String,
}

#[derive(Debug, Serialize)]
pub struct Suggestion {
    pub command: String,
    pub destructive: bool,
    pub raw: String,
}

static GENERATOR: std::sync::Mutex<Option<crate::helper_model::ShellGenerator>> =
    std::sync::Mutex::new(None);
static ENABLE_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tauri::command]
pub fn command_helper_status() -> HelperStatus {
    match helper_paths()
        .ok()
        .and_then(|(config, _)| read_enabled_config(&config))
    {
        Some(enabled) => HelperStatus {
            enabled: true,
            weight_path: Some(enabled.weight_path.display().to_string()),
            usage: enabled.usage,
        },
        None => HelperStatus {
            enabled: false,
            weight_path: None,
            usage: USAGE_TEXT.to_string(),
        },
    }
}

#[tauri::command]
pub async fn enable_command_helper(app: AppHandle) -> Result<HelperStatus, String> {
    let (config_path, weight_dest) = helper_paths()?;
    let parent = weight_dest
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let facts = live_machine_facts(&parent);
    let req = EnableRequest {
        facts,
        config_path,
        weight_dest,
        weight_bytes: WEIGHT_BYTES,
    };
    let enabled = tokio::task::spawn_blocking(move || -> Result<EnabledHelper, String> {
        let _gate = ENABLE_GATE.lock().map_err(|e| e.to_string())?;
        let mut fetch = |dest: &Path| download_official_gguf(dest);
        enable_helper(&req, &mut fetch).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    crate::menu::set_command_helper_label(&app, true);
    Ok(HelperStatus {
        enabled: enabled.enabled,
        weight_path: Some(enabled.weight_path.display().to_string()),
        usage: enabled.usage,
    })
}

#[tauri::command]
pub async fn disable_command_helper(app: AppHandle) -> Result<HelperStatus, String> {
    let (config_path, _) = helper_paths()?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let _gate = ENABLE_GATE.lock().map_err(|e| e.to_string())?;
        if let Ok(mut slot) = GENERATOR.lock() {
            *slot = None;
        }
        disable_helper(&config_path)
    })
    .await
    .map_err(|e| e.to_string())??;
    crate::menu::set_command_helper_label(&app, false);
    Ok(command_helper_status())
}

pub fn disable_helper(config_path: &Path) -> Result<(), String> {
    let Some(existing) = read_helper_file(config_path) else {
        return Ok(());
    };
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = HelperFile {
        enabled: false,
        weight_path: existing.weight_path,
    };
    let text = toml::to_string(&file).map_err(|e| e.to_string())?;
    fs::write(config_path, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn suggest_shell_command(
    request: String,
    shell: String,
    alternate: bool,
) -> Result<Suggestion, String> {
    if !shell_eligible(&shell, alternate) {
        return Err("Command helper is only available at a bare shell.".into());
    }
    let request = request.trim().to_string();
    if request.is_empty() {
        return Err("Type a plain-language request.".into());
    }
    let (config, _) = helper_paths()?;
    let Some(enabled) = read_enabled_config(&config) else {
        return Err("Turn on Enable Command Helper from the menu first.".into());
    };
    let os = model_os_name().to_string();
    let shell_name = shell_basename(&shell);
    let asked = request.clone();
    let generated = tokio::task::spawn_blocking(move || {
        let mut slot = GENERATOR.lock().map_err(|e| e.to_string())?;
        if slot.is_none() {
            *slot = Some(crate::helper_model::ShellGenerator::load(
                &enabled.weight_path,
            )?);
        }
        let generator = slot.as_ref().expect("generator was just loaded");
        generator.generate(&os, &shell_name, &request)
    })
    .await
    .map_err(|e| e.to_string())??;
    let command = generated
        .command
        .map_err(|kind| format!("Could not read one command from the model ({kind})."))?;
    let command = align_content_search(&asked, &command);
    Ok(Suggestion {
        destructive: is_destructive(&command),
        command,
        raw: generated.raw,
    })
}

pub fn helper_paths() -> Result<(PathBuf, PathBuf), String> {
    let dirs = directories::ProjectDirs::from("", "", "sparkmux")
        .ok_or_else(|| "could not resolve the Sparkmux config directory".to_string())?;
    let config_path = dirs.config_dir().join(CONFIG_NAME);
    let weight_dest = dirs.data_dir().join("models").join(WEIGHT_NAME);
    Ok((config_path, weight_dest))
}

pub fn live_machine_facts(weight_dir: &Path) -> MachineFacts {
    MachineFacts {
        arch: std::env::consts::ARCH.to_string(),
        free_disk_bytes: free_disk_bytes(weight_dir),
        available_memory_bytes: available_memory_bytes(),
    }
}

pub fn model_os_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        other => other,
    }
}

pub fn download_official_gguf(dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if weight_matches(dest, WEIGHT_BYTES) {
        return Ok(());
    }
    let tmp = dest.with_extension(format!("partial-{}", std::process::id()));
    let response = ureq::get(WEIGHT_URL)
        .call()
        .map_err(|e| format!("download failed: {e}"))?;
    let mut reader = response.into_reader();
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    std::io::copy(&mut reader, &mut file).map_err(|e| e.to_string())?;
    drop(file);
    let len = fs::metadata(&tmp).map_err(|e| e.to_string())?.len();
    if len != WEIGHT_BYTES {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "downloaded {len} bytes, expected the official {WEIGHT_BYTES}-byte Q4_K_M file"
        ));
    }
    let mut magic = [0_u8; 4];
    {
        use std::io::Read;
        let mut check = fs::File::open(&tmp).map_err(|e| e.to_string())?;
        check.read_exact(&mut magic).map_err(|e| e.to_string())?;
    }
    if &magic != b"GGUF" {
        let _ = fs::remove_file(&tmp);
        return Err("download is not a GGUF file".into());
    }
    fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok(())
}

fn refuse_runtime(facts: &MachineFacts) -> Option<EnableError> {
    if facts.arch != "aarch64" {
        return Some(EnableError::Refused {
            resource: ShortResource::Cpu,
            message: format!(
                "This CPU architecture ({}) cannot run the helper. It needs aarch64.",
                facts.arch
            ),
        });
    }
    if facts.available_memory_bytes < MIN_MEMORY_BYTES {
        return Some(EnableError::Refused {
            resource: ShortResource::Memory,
            message: format!(
                "Not enough available memory ({} bytes). The helper needs at least 2 GB.",
                facts.available_memory_bytes
            ),
        });
    }
    None
}

fn weight_matches(path: &Path, expected: u64) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if meta.len() != expected || expected < 4 {
        return false;
    }
    let mut magic = [0_u8; 4];
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    use std::io::Read;
    file.read_exact(&mut magic).is_ok() && &magic == b"GGUF"
}

fn write_helper_file(config_path: &Path, weight: &Path) -> Result<(), String> {
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = HelperFile {
        enabled: true,
        weight_path: weight.display().to_string(),
    };
    let text = toml::to_string(&file).map_err(|e| e.to_string())?;
    fs::write(config_path, text).map_err(|e| e.to_string())
}

fn read_helper_file(config_path: &Path) -> Option<HelperFile> {
    let text = fs::read_to_string(config_path).ok()?;
    toml::from_str(&text).ok()
}

fn strip_fence(text: &str) -> String {
    let Some(start) = text.find("```") else {
        return text.to_string();
    };
    let rest = &text[start + 3..];
    let rest = rest.trim_start_matches(|c: char| c.is_ascii_alphanumeric() || c == '+');
    let rest = rest.trim_start_matches(['\n', '\r']);
    match rest.find("```") {
        Some(end) => rest[..end].to_string(),
        None => rest.to_string(),
    }
}

/// Quote an unquoted `find` name or path pattern so the shell does not expand `*`.
pub fn quote_find_globs(command: &str) -> String {
    const PRIMARIES: &[&str] = &[
        "-name",
        "-iname",
        "-path",
        "-ipath",
        "-regex",
        "-iregex",
        "-wholename",
        "-iwholename",
        "-lname",
        "-ilname",
    ];
    let tokens = shell_tokens(command);
    let mut out = Vec::with_capacity(tokens.len());
    let mut i = 0;
    while i < tokens.len() {
        let token = &tokens[i];
        out.push(token.clone());
        let bare = token.trim_matches(['\'', '"']);
        if PRIMARIES.contains(&bare) {
            if let Some(pattern) = tokens.get(i + 1) {
                out.push(quote_glob_pattern(pattern));
                i += 1;
            }
        }
        i += 1;
    }
    out.join(" ")
}

/// A content question answered with `find -name` searches the wrong thing.
/// List the files whose contents match instead.
pub fn align_content_search(request: &str, command: &str) -> String {
    if !asks_for_file_content(request) {
        return command.to_string();
    }
    if command.split_whitespace().next() == Some("grep") {
        return normalize_grep_pattern(command);
    }
    let Some(needle) = find_name_argument(command).or_else(|| content_needle(request)) else {
        return command.to_string();
    };
    let needle = strip_all_quotes(&needle);
    if needle.is_empty() {
        return command.to_string();
    }
    format!("grep -l -F -R -- {} .", shell_word(&needle))
}

/// The quotes in the request mark the word. They are not part of the text to find.
fn normalize_grep_pattern(command: &str) -> String {
    let mut tokens = shell_tokens(command);
    let mut index = 1;
    let mut pattern_at = None;
    while index < tokens.len() {
        let token = &tokens[index];
        if token == "--" {
            pattern_at = Some(index + 1);
            break;
        }
        if token.starts_with('-') {
            index += 1;
            continue;
        }
        pattern_at = Some(index);
        break;
    }
    let Some(at) = pattern_at else {
        return command.to_string();
    };
    let Some(pattern) = tokens.get(at) else {
        return command.to_string();
    };
    let bare = strip_all_quotes(pattern);
    if bare.is_empty() {
        return command.to_string();
    }
    tokens[at] = shell_word(&bare);
    tokens.join(" ")
}

fn strip_all_quotes(token: &str) -> String {
    let mut out = token.trim().to_string();
    loop {
        let bytes = out.as_bytes();
        if bytes.len() >= 2
            && ((bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'')
                || (bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"'))
        {
            out = out[1..out.len() - 1].to_string();
            continue;
        }
        break;
    }
    out
}

fn asks_for_file_content(request: &str) -> bool {
    let lower = request.to_ascii_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    let content = words.iter().any(|word| {
        matches!(
            *word,
            "content" | "containing" | "contains" | "contain" | "text"
        )
    });
    if !content {
        return false;
    }
    let named = words
        .iter()
        .any(|word| matches!(*word, "named" | "called" | "filename"));
    !named
        || words
            .iter()
            .any(|word| matches!(*word, "content" | "containing" | "contains" | "contain"))
}

fn find_name_argument(command: &str) -> Option<String> {
    let tokens = shell_tokens(command);
    for (i, token) in tokens.iter().enumerate() {
        let bare = token.trim_matches(['\'', '"']);
        if matches!(bare, "-name" | "-iname") {
            return tokens.get(i + 1).map(|pattern| strip_token_quotes(pattern));
        }
    }
    None
}

fn content_needle(request: &str) -> Option<String> {
    if let Some(quoted) = first_quoted(request) {
        return Some(quoted);
    }
    let lower = request.to_ascii_lowercase();
    for marker in ["content of ", "text "] {
        let Some(idx) = lower.find(marker) else {
            continue;
        };
        let rest = request[idx + marker.len()..].trim();
        let word = rest.split_whitespace().next()?;
        let clean = word
            .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_' && c != '.');
        if !clean.is_empty() {
            return Some(clean.to_string());
        }
    }
    None
}

fn first_quoted(request: &str) -> Option<String> {
    let mut chars = request.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '"' && ch != '\'' {
            continue;
        }
        let mut inner = String::new();
        for next in chars.by_ref() {
            if next == ch {
                return Some(inner);
            }
            inner.push(next);
        }
    }
    None
}

fn strip_token_quotes(token: &str) -> String {
    let bytes = token.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'')
            || (bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"'))
    {
        return token[1..token.len() - 1].to_string();
    }
    token.to_string()
}

fn shell_word(word: &str) -> String {
    if word
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
    {
        return word.to_string();
    }
    format!("'{}'", word.replace('\'', "'\\''"))
}

fn quote_glob_pattern(token: &str) -> String {
    let bytes = token.as_bytes();
    let quoted = bytes.len() >= 2
        && ((bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'')
            || (bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"'));
    if quoted || !token.contains(['*', '?', '[']) {
        return token.to_string();
    }
    format!("'{}'", token.replace('\'', "'\\''"))
}

fn shell_tokens(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in command.chars() {
        if let Some(mark) = quote {
            current.push(ch);
            if ch == mark {
                quote = None;
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            current.push(ch);
            continue;
        }
        if ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(ch);
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn strip_wrapping_quotes(line: &str) -> &str {
    let bytes = line.as_bytes();
    if bytes.len() >= 2 {
        let (open, close) = (bytes[0], bytes[bytes.len() - 1]);
        if (open == b'\'' && close == b'\'')
            || (open == b'"' && close == b'"')
            || (open == b'`' && close == b'`')
        {
            return &line[1..line.len() - 1];
        }
    }
    line
}

fn looks_like_command(line: &str) -> bool {
    if line.is_empty() {
        return false;
    }
    // A final path component of `.` or `..` is a directory (`cd ../..`, `ls .`).
    // A word that itself ends in `.`, `?`, or `!` is a sentence.
    if ends_as_prose(line) {
        return false;
    }
    let first = line.split_whitespace().next().unwrap_or("");
    let first = first.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-');
    let lower = first.to_ascii_lowercase();
    const PROSE: &[&str] = &[
        "here", "sure", "the", "this", "i", "you", "sorry", "command", "that", "to",
    ];
    !PROSE.contains(&lower.as_str())
}

fn ends_as_prose(line: &str) -> bool {
    let Some(last) = line.split_whitespace().last() else {
        return false;
    };
    let token = last.trim_matches(|c: char| matches!(c, '"' | '\'' | '`'));
    // `../..`, `./.`, and `foo/..` end in a directory component, not a sentence.
    let component = token.rsplit(['/', '\\']).next().unwrap_or(token);
    if component == "." || component == ".." {
        return false;
    }
    token.ends_with(['.', '?', '!'])
}

fn has_command_joiner(command: &str) -> bool {
    // `\;` ends a find -exec action. It is not a second shell command.
    let without_exec = command.replace("\\;", "");
    without_exec.contains("&&")
        || without_exec.contains('|')
        || without_exec.contains(';')
        || without_exec.contains('\n')
}

fn has_file_redirect(command: &str) -> bool {
    let bytes = command.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'>' {
            let next = bytes.get(i + 1).copied();
            if next == Some(b'>') {
                let after = command[i + 2..].trim_start();
                if !after.is_empty() && !after.starts_with('&') {
                    return true;
                }
                i += 2;
                continue;
            }
            if next == Some(b'&') {
                i += 2;
                continue;
            }
            let after = command[i + 1..].trim_start();
            if !after.is_empty() {
                return true;
            }
        }
        i += 1;
    }
    false
}

pub fn parse_memavailable(text: &str) -> Option<u64> {
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix("MemAvailable:") else {
            continue;
        };
        let kb = rest.split_whitespace().next()?.parse::<u64>().ok()?;
        return Some(kb.saturating_mul(1024));
    }
    None
}

pub fn parse_vm_stat(text: &str) -> Option<u64> {
    let page = text
        .lines()
        .find_map(|line| {
            let start = line.find("page size of ")?;
            let rest = &line[start + "page size of ".len()..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u64>().ok()
        })
        .filter(|n| *n > 0)?;
    let mut pages = 0_u64;
    for key in [
        "Pages free:",
        "Pages inactive:",
        "Pages speculative:",
        "Pages purgeable:",
    ] {
        if let Some(count) = vm_stat_count(text, key) {
            pages = pages.saturating_add(count);
        }
    }
    Some(pages.saturating_mul(page))
}

fn vm_stat_count(text: &str, key: &str) -> Option<u64> {
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix(key) else {
            continue;
        };
        let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
        return digits.parse().ok();
    }
    None
}

fn available_memory_bytes() -> u64 {
    if cfg!(target_os = "linux") {
        let text = fs::read_to_string("/proc/meminfo").unwrap_or_default();
        return parse_memavailable(&text).unwrap_or(0);
    }
    if cfg!(target_os = "macos") {
        let output = Command::new("vm_stat").output();
        if let Ok(output) = output {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                return parse_vm_stat(&text).unwrap_or(0);
            }
        }
    }
    0
}

fn free_disk_bytes(dir: &Path) -> u64 {
    let _ = fs::create_dir_all(dir);
    let probe = if dir.exists() {
        dir.to_path_buf()
    } else {
        std::env::temp_dir()
    };
    let Ok(c_path) = std::ffi::CString::new(probe.to_string_lossy().as_bytes()) else {
        return 0;
    };
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if rc != 0 {
        return 0;
    }
    (stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn passing(weight: u64) -> MachineFacts {
        MachineFacts {
            arch: "aarch64".into(),
            free_disk_bytes: weight,
            available_memory_bytes: MIN_MEMORY_BYTES,
        }
    }

    #[test]
    fn capability_refuses_short_resources_and_allows_one_download() {
        let weight = WEIGHT_BYTES;
        let disk = decide_capability(
            &MachineFacts {
                free_disk_bytes: weight - 1,
                ..passing(weight)
            },
            weight,
        );
        let memory = decide_capability(
            &MachineFacts {
                available_memory_bytes: MIN_MEMORY_BYTES - 1,
                ..passing(weight)
            },
            weight,
        );
        let cpu = decide_capability(
            &MachineFacts {
                arch: "x86_64".into(),
                ..passing(weight)
            },
            weight,
        );
        let ok = decide_capability(&passing(weight), weight);

        assert!(!disk.allow && !disk.request_download);
        assert_eq!(disk.short, Some(ShortResource::Disk));
        assert!(disk.message.contains("disk"));
        assert!(!memory.allow && !memory.request_download);
        assert_eq!(memory.short, Some(ShortResource::Memory));
        assert!(memory.message.contains("memory"));
        assert!(!cpu.allow && !cpu.request_download);
        assert_eq!(cpu.short, Some(ShortResource::Cpu));
        assert!(cpu.message.contains("architecture"));
        assert!(ok.allow && ok.request_download);
        assert!(ok.short.is_none());

        let downloads = [&disk, &memory, &cpu, &ok]
            .into_iter()
            .filter(|d| d.request_download)
            .count();
        assert_eq!(downloads, 1);
    }

    #[test]
    fn refused_enable_does_not_fetch() {
        let dir =
            std::env::temp_dir().join(format!("sparkmux-helper-refuse-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let req = EnableRequest {
            facts: MachineFacts {
                available_memory_bytes: 0,
                ..passing(WEIGHT_BYTES)
            },
            config_path: dir.join(CONFIG_NAME),
            weight_dest: dir.join(WEIGHT_NAME),
            weight_bytes: WEIGHT_BYTES,
        };
        let mut fetches = 0;
        let err = enable_helper(&req, &mut |_| {
            fetches += 1;
            Ok(())
        })
        .unwrap_err();
        assert_eq!(fetches, 0);
        match err {
            EnableError::Refused {
                resource: ShortResource::Memory,
                message,
            } => assert!(message.contains("memory")),
            other => panic!("unexpected {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn enable_persists_weight_and_second_call_does_not_fetch() {
        let dir =
            std::env::temp_dir().join(format!("sparkmux-helper-enable-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let source = if let Ok(path) = std::env::var("SPARKMUX_QWEN_GGUF") {
            let path = PathBuf::from(path);
            assert!(path.is_file(), "SPARKMUX_QWEN_GGUF is not a file");
            path
        } else {
            let path = dir.join("source.gguf");
            fs::write(&path, b"GGUF-stand-in").unwrap();
            path
        };
        let dest = dir.join("models").join(WEIGHT_NAME);
        let config = dir.join(CONFIG_NAME);
        let req = EnableRequest {
            facts: passing(1),
            config_path: config.clone(),
            weight_dest: dest.clone(),
            weight_bytes: 1,
        };
        let source_for_fetch = source.clone();
        let mut fetches = 0;
        let enabled = enable_helper(&req, &mut |dest| {
            fetches += 1;
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(&source_for_fetch, dest).map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap();
        assert_eq!(fetches, 1);
        assert!(enabled.enabled);
        assert!(!enabled.already_enabled);
        assert_eq!(enabled.weight_path, dest);
        assert_eq!(fs::read(&dest).unwrap(), fs::read(&source).unwrap());
        let text = fs::read_to_string(&config).unwrap();
        assert!(text.contains("enabled = true"));
        assert!(text.contains(&dest.display().to_string()));
        assert!(enabled.usage.contains("Ask only at a bare shell."));
        assert!(enabled.usage.contains("plain-language request"));
        assert!(enabled.usage.contains("inserts the command"));
        assert!(enabled.usage.contains("You run it."));

        let again = enable_helper(&req, &mut |_| {
            fetches += 1;
            Err("second enable must not fetch".into())
        })
        .unwrap();
        assert!(again.already_enabled);
        assert_eq!(again.weight_path, dest);
        assert_eq!(fetches, 1);

        let stale = dir
            .join("models")
            .join("qwen2.5-coder-0.5b-instruct-q4_k_m.gguf");
        fs::write(&stale, b"GGUF-old").unwrap();
        let stale_req = EnableRequest {
            config_path: dir.join("stale.toml"),
            weight_dest: dir
                .join("models")
                .join("qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"),
            ..req.clone()
        };
        write_helper_file(&stale_req.config_path, &stale).unwrap();
        assert!(read_enabled_config(&stale_req.config_path).is_none());
        let replaced = enable_helper(&stale_req, &mut |dest| {
            fetches += 1;
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(dest, b"GGUF-new").map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap();
        assert!(!replaced.already_enabled);
        assert_eq!(fetches, 2);
        assert_eq!(
            replaced.weight_path,
            dir.join("models")
                .join("qwen2.5-coder-1.5b-instruct-q4_k_m.gguf")
        );

        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let status = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&repo)
            .output()
            .unwrap();
        let porcelain = String::from_utf8_lossy(&status.stdout);
        assert!(
            !porcelain.contains(".gguf"),
            "weight showed up in git status:\n{porcelain}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn existing_weight_enables_without_fetch_when_disk_is_short() {
        let dir =
            std::env::temp_dir().join(format!("sparkmux-helper-reuse-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let dest = dir.join(WEIGHT_NAME);
        let mut bytes = vec![0_u8; 16];
        bytes[..4].copy_from_slice(b"GGUF");
        fs::write(&dest, &bytes).unwrap();
        let req = EnableRequest {
            facts: MachineFacts {
                free_disk_bytes: 0,
                ..passing(16)
            },
            config_path: dir.join(CONFIG_NAME),
            weight_dest: dest.clone(),
            weight_bytes: 16,
        };
        let mut fetches = 0;
        let enabled = enable_helper(&req, &mut |_| {
            fetches += 1;
            Err("must not download when the weight is already present".into())
        })
        .unwrap();
        assert_eq!(fetches, 0);
        assert!(enabled.enabled);
        assert_eq!(enabled.weight_path, dest);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn shells_on_the_primary_screen_are_eligible() {
        for name in ["zsh", "bash", "fish", "sh", "dash"] {
            assert!(shell_eligible(name, false), "{name}");
        }
        assert!(shell_eligible("/bin/zsh", false));
        assert!(shell_eligible("-bash", false));
        for name in ["claude", "grok", "node", "vim", "less", "ssh"] {
            assert!(!shell_eligible(name, false), "{name}");
        }
        assert!(!shell_eligible("zsh", true));
    }

    #[test]
    fn prompt_names_the_os_shell_and_request() {
        let prompt = command_prompt(
            "darwin",
            "zsh",
            "find files named notes.txt under the current directory",
        );
        assert!(prompt.contains("Operating system: darwin"));
        assert!(prompt.contains("Shell: zsh"));
        assert!(prompt.contains("find files named notes.txt under the current directory"));
        assert!(prompt.contains("-printf"));
        assert!(prompt.contains("find . -name 't*'"));
        assert!(prompt.contains("find the file containing the content of FIXME"));
        assert!(prompt.contains("grep -l -F -R -- FIXME ."));
    }

    #[test]
    fn extract_keeps_one_command_line() {
        assert_eq!(
            extract_command("find . -name notes.txt\n").unwrap(),
            "find . -name notes.txt"
        );
        assert_eq!(
            extract_command("```sh\nfind . -name notes.txt\n```\n").unwrap(),
            "find . -name notes.txt"
        );
        assert_eq!(extract_command("$ du -sh .\n").unwrap(), "du -sh .");
        assert_eq!(extract_command("'du -sh'\n").unwrap(), "du -sh");
        for command in [
            "grep TODO .",
            "du .",
            "find .",
            "cd ..",
            "ls .",
            "cd ../..",
            "du -sh ../..",
            "grep -R TODO ../..",
            "ls ./..",
            "cd foo/..",
            "cd ./.",
            "ls ./.",
        ] {
            assert_eq!(extract_command(command).unwrap(), command, "{command}");
            assert_eq!(
                extract_command(&format!("{command}\n")).unwrap(),
                command,
                "{command}"
            );
        }
        assert!(extract_command("Sure, here is a command.\n").is_err());
        assert!(extract_command("What files are here ?").is_err());
        assert!(extract_command("Please run this !").is_err());
        assert!(extract_command("find . -name notes.txt\nrm *.log\n").is_err());
        assert!(extract_command("ls && rm notes.txt").is_err());
        assert_eq!(
            extract_command("find . -name *.log -exec rm {} \\;\n").unwrap(),
            "find . -name '*.log' -exec rm {} \\;"
        );
        assert_eq!(
            extract_command("find . -name t*\n").unwrap(),
            "find . -name 't*'"
        );
        assert_eq!(
            quote_find_globs("find . -name '*.log'"),
            "find . -name '*.log'"
        );
        assert_eq!(
            quote_find_globs("find . -name readme.md"),
            "find . -name readme.md"
        );
        assert_eq!(quote_find_globs("grep -R FIXME ."), "grep -R FIXME .");
    }

    #[test]
    fn content_request_is_grep_even_when_the_model_uses_find_name() {
        assert_eq!(
            align_content_search(
                "find the file containing the content of \"error\"",
                "find . -name \"error\"",
            ),
            "grep -l -F -R -- error ."
        );
        assert_eq!(
            align_content_search(
                "find files named notes.txt under the current directory",
                "find . -name notes.txt",
            ),
            "find . -name notes.txt"
        );
        assert_eq!(
            align_content_search(
                "search the current directory for the text TODO",
                "grep -R TODO .",
            ),
            "grep -R TODO ."
        );
        assert_eq!(
            align_content_search("find file with content \"box\"", "grep -l -F -R -- 'box' .",),
            "grep -l -F -R -- box ."
        );
        assert_eq!(
            align_content_search(
                "find file with content \"box\"",
                "grep -l -F -R -- ''box'' .",
            ),
            "grep -l -F -R -- box ."
        );
        assert_eq!(
            align_content_search(
                "find file with content \"box\"",
                "grep -l -F -R -- \"box\" .",
            ),
            "grep -l -F -R -- box ."
        );
    }

    #[test]
    fn delete_sample_is_destructive_and_insert_has_no_enter() {
        assert!(is_destructive("rm *.log"));
        assert!(is_destructive("find . -name '*.log' -delete"));
        assert!(is_destructive("mv a.log b.log"));
        assert!(is_destructive("echo hi > notes.txt"));
        assert!(is_destructive("cat notes.txt >> out.log"));
        assert!(!is_destructive("find . -name notes.txt"));
        assert!(!is_destructive("grep TODO ."));
        assert!(!is_destructive("du -sh ."));
        assert!(!is_destructive("ls 2>&1"));
        assert!(is_destructive("find . -name *.log -exec rm {} \\;"));
    }

    #[test]
    fn memory_parsers_read_available_bytes() {
        let linux = "MemTotal: 2048 kB\nMemAvailable: 1048576 kB\n";
        assert_eq!(parse_memavailable(linux), Some(1048576 * 1024));
        let mac = "\
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 10.
Pages active: 99.
Pages inactive: 20.
Pages speculative: 5.
Pages purgeable: 1.
";
        assert_eq!(parse_vm_stat(mac), Some(36 * 16384));
    }

    #[test]
    fn usage_text_matches_the_setup_copy() {
        assert!(USAGE_TEXT.contains("Ask only at a bare shell."));
        assert!(USAGE_TEXT.contains("plain-language request"));
        assert!(USAGE_TEXT.contains("inserts the command"));
        assert!(USAGE_TEXT.contains("You run it."));
    }

    #[test]
    fn disable_keeps_the_weight_and_enable_again_does_not_fetch() {
        let dir =
            std::env::temp_dir().join(format!("sparkmux-helper-disable-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let dest = dir.join("models").join(WEIGHT_NAME);
        let config = dir.join(CONFIG_NAME);
        let mut bytes = b"GGUF".to_vec();
        bytes.extend_from_slice(&[0, 1, 2, 3]);
        let weight_bytes = bytes.len() as u64;
        let req = EnableRequest {
            facts: passing(weight_bytes),
            config_path: config.clone(),
            weight_dest: dest.clone(),
            weight_bytes,
        };
        let payload = bytes.clone();
        let mut fetches = 0;
        enable_helper(&req, &mut |dest| {
            fetches += 1;
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(dest, &payload).map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap();
        disable_helper(&config).unwrap();
        assert!(dest.is_file());
        assert!(read_enabled_config(&config).is_none());
        let text = fs::read_to_string(&config).unwrap();
        assert!(text.contains("enabled = false"));
        let again = enable_helper(&req, &mut |_| {
            fetches += 1;
            Err("must not download again".into())
        })
        .unwrap();
        assert!(again.enabled);
        assert_eq!(fetches, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn menu_item_is_wired_to_enable() {
        let menu = include_str!("menu.rs");
        assert!(menu.contains("Enable Command Helper"));
        assert!(menu.contains("Disable Command Helper"));
        assert!(menu.contains("enable-command-helper"));
        let app = include_str!("../../src/App.tsx");
        assert!(app.contains("enable-command-helper"));
        assert!(app.contains("enableCommandHelper"));
        assert!(app.contains("disableCommandHelper"));
        assert!(app.contains("usageText()"));
        assert!(app.contains("isDestructive("));
        assert!(app.contains("insertPayload("));
        assert!(app.contains("shellEligible("));
        assert!(app.contains("helper-progress"));
        assert!(app.contains("onAsk"));
        let bar = include_str!("../../src/chrome/StatusBar.tsx");
        assert!(bar.contains("status-ask"));
        assert!(bar.contains("aria-label=\"Ask\""));
    }
}
