//! Session and today cost for a Claude pane that is calling Bedrock.
//!
//! The chip appears only when a Claude process in the pane has
//! `CLAUDE_CODE_USE_BEDROCK` set to `1`, `true`, or `yes`. The process
//! environment is scanned for that one key and then discarded. AWS credentials
//! in the same environment are not stored or logged, and this module does not
//! call AWS.
//!
//! The session figure is the latest `cost-state.totalCostUSD` in the focused
//! transcript (the same total Claude's `/cost` uses). When Claude recorded no
//! price, the tokens are returned so the UI can price them with the Stats
//! table and label the figure estimated.
//!
//! Today is spend since local midnight. A Bedrock transcript that started
//! today contributes Claude's total. One that started earlier contributes only
//! messages timestamped today, priced as an estimate. A transcript counts as
//! Bedrock when it is the focused pane's file, or when a model id looks like a
//! Bedrock id (`us.anthropic.claude-…`). Subscription sessions stay out of the sum.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::artifacts::{default_roots, pane_family, select_transcript, CliKind};
use crate::llm_usage::parse_rfc3339_ms;

const ENV_KEY: &str = "CLAUDE_CODE_USE_BEDROCK";
const FILE_CAP: usize = 400;
const LINE_CAP: usize = 2_000_000;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageCostModel {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageCostPart {
    pub known_usd: f64,
    pub estimated: bool,
    pub models: Vec<UsageCostModel>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BedrockCost {
    pub session: UsageCostPart,
    pub today: UsageCostPart,
}

impl UsageCostPart {
    fn zero() -> Self {
        Self {
            known_usd: 0.0,
            estimated: false,
            models: Vec::new(),
        }
    }
}

impl BedrockCost {
    fn zero() -> Self {
        Self {
            session: UsageCostPart::zero(),
            today: UsageCostPart::zero(),
        }
    }
}

struct MsgUse {
    model: String,
    ts: i64,
    input: u64,
    output: u64,
    read: u64,
    write: u64,
}

struct Summary {
    start_ms: Option<i64>,
    total_usd: Option<f64>,
    unknown: bool,
    saw_cost: bool,
    priced_models: bool,
    bedrock_model: bool,
    messages: HashMap<String, MsgUse>,
    anon: u32,
}

impl Summary {
    fn new() -> Self {
        Self {
            start_ms: None,
            total_usd: None,
            unknown: false,
            saw_cost: false,
            priced_models: false,
            bedrock_model: false,
            messages: HashMap::new(),
            anon: 0,
        }
    }
}

/// Cost for a Bedrock Claude pane. `None` when that pane's Claude process is
/// not using Bedrock, so a subscription session keeps the quota chip.
pub(crate) fn cost_for(
    command: &str,
    cwd: &str,
    title: &str,
    pid: u32,
    now_ms: i64,
) -> Option<BedrockCost> {
    if crate::ssh_bind::ssh_foreground(command) {
        // Remote transcript only. Do not read the Mac's Claude settings or the ssh process env.
        let (kind, path, roots) =
            crate::artifacts::resolve_pane_transcript(command, cwd, title, pid, &default_roots())?;
        if kind != CliKind::Claude || !is_bedrock_transcript(&path) {
            return None;
        }
        return Some(rollup_dir(
            &roots.claude_projects,
            Some(&path),
            local_midnight_ms(now_ms),
        ));
    }
    let roots = default_roots();
    let family = pane_family(pid);
    let focused = select_transcript(CliKind::Claude, cwd, title, &family, &roots);
    let is_bedrock = family_uses_bedrock(pid, command, &family)
        || settings_use_bedrock(cwd)
        || focused
            .as_deref()
            .map(is_bedrock_transcript)
            .unwrap_or(false);
    if !is_bedrock {
        return None;
    }
    Some(rollup_dir(
        &roots.claude_projects,
        focused.as_deref(),
        local_midnight_ms(now_ms),
    ))
}

fn is_bedrock_transcript(path: &Path) -> bool {
    let summary = summarize(path);
    summary.bedrock_model
}

fn family_uses_bedrock(pid: u32, command: &str, family: &[(u32, u8)]) -> bool {
    if let Ok(val) = std::env::var(ENV_KEY) {
        if truthy_str(&val) {
            return true;
        }
    }
    if pid == 0 {
        return false;
    }
    let skip_root = is_shell_command(command) && family.len() > 1;
    family.iter().any(|(proc_pid, depth)| {
        if skip_root && *depth == 0 {
            return false;
        }
        process_bedrock_flag(*proc_pid)
    })
}

pub(crate) fn settings_use_bedrock(cwd: &str) -> bool {
    if let Some(home) = directories::UserDirs::new().map(|d| d.home_dir().to_path_buf()) {
        let claude_dir = home.join(".claude");
        if file_enables_bedrock(&claude_dir.join("settings.json"))
            || file_enables_bedrock(&claude_dir.join("settings.local.json"))
            || file_enables_bedrock(&home.join(".claude.json"))
        {
            return true;
        }
    }
    if !cwd.is_empty() {
        let mut cur = Path::new(cwd);
        for _ in 0..6 {
            let dot_claude = cur.join(".claude");
            if file_enables_bedrock(&dot_claude.join("settings.json"))
                || file_enables_bedrock(&dot_claude.join("settings.local.json"))
                || file_enables_bedrock(&cur.join(".claude.json"))
            {
                return true;
            }
            let Some(parent) = cur.parent() else {
                break;
            };
            cur = parent;
        }
    }
    false
}

fn file_enables_bedrock(path: &Path) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_reader::<_, Value>(file.take(256 * 1024)) else {
        return false;
    };
    json_enables_bedrock(&value)
}

fn json_enables_bedrock(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    if let Some(env) = obj.get("env").and_then(Value::as_object) {
        if check_bedrock_val(env.get(ENV_KEY)) {
            return true;
        }
        if env
            .get("AWS_BEARER_TOKEN_BEDROCK")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
        {
            return true;
        }
        if env
            .get("ANTHROPIC_BEDROCK_BASE_URL")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
        {
            return true;
        }
        for model_key in [
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
        ] {
            if let Some(m) = env.get(model_key).and_then(Value::as_str) {
                if bedrock_model_id(m) {
                    return true;
                }
            }
        }
    }
    if check_bedrock_val(obj.get(ENV_KEY)) {
        return true;
    }
    if obj.get("bedrock").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    if let Some(m) = obj.get("model").and_then(Value::as_str) {
        if bedrock_model_id(m) {
            return true;
        }
    }
    false
}

fn check_bedrock_val(val: Option<&Value>) -> bool {
    let Some(v) = val else {
        return false;
    };
    if let Some(b) = v.as_bool() {
        return b;
    }
    if let Some(n) = v.as_u64() {
        return n == 1;
    }
    if let Some(s) = v.as_str() {
        return truthy_str(s);
    }
    false
}

fn truthy_str(text: &str) -> bool {
    matches!(
        text.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes"
    )
}

fn is_shell_command(command: &str) -> bool {
    let base = command.rsplit(['/', '\\']).next().unwrap_or(command).trim();
    let base = base.strip_prefix('-').unwrap_or(base);
    matches!(
        base.to_ascii_lowercase().as_str(),
        "zsh" | "bash" | "fish" | "sh" | "dash"
    )
}

fn process_bedrock_flag(pid: u32) -> bool {
    let Some(buf) = process_args(pid) else {
        return false;
    };
    let enabled = flag_enabled(&buf, ENV_KEY)
        || env_var_non_empty(&buf, "AWS_BEARER_TOKEN_BEDROCK")
        || env_var_non_empty(&buf, "ANTHROPIC_BEDROCK_BASE_URL");
    drop(buf);
    enabled
}

fn env_var_non_empty(buf: &[u8], key: &str) -> bool {
    let needle = format!("{key}=");
    let needle = needle.as_bytes();
    let mut at = 0;
    while at < buf.len() {
        if buf[at..].starts_with(needle) {
            let start = at + needle.len();
            let end = buf[start..]
                .iter()
                .position(|byte| *byte == 0)
                .map(|pos| start + pos)
                .unwrap_or(buf.len());
            return !buf[start..end].iter().all(|b| b.is_ascii_whitespace());
        }
        let Some(pos) = buf[at..].iter().position(|byte| *byte == 0) else {
            break;
        };
        at += pos + 1;
    }
    false
}

/// `CLAUDE_CODE_USE_BEDROCK=1|true|yes`, matched only at the start of an
/// environment entry. The buffer is the raw process environment.
fn flag_enabled(buf: &[u8], key: &str) -> bool {
    let needle = format!("{key}=");
    let needle = needle.as_bytes();
    let mut at = 0;
    while at < buf.len() {
        if buf[at..].starts_with(needle) {
            let start = at + needle.len();
            let end = buf[start..]
                .iter()
                .position(|byte| *byte == 0)
                .map(|pos| start + pos)
                .unwrap_or(buf.len());
            return truthy(&buf[start..end]);
        }
        let Some(pos) = buf[at..].iter().position(|byte| *byte == 0) else {
            break;
        };
        at += pos + 1;
    }
    false
}

fn truthy(value: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(value) else {
        return false;
    };
    truthy_str(text)
}

#[cfg(target_os = "macos")]
fn process_args(pid: u32) -> Option<Vec<u8>> {
    const CTL_KERN: libc::c_int = 1;
    const KERN_PROCARGS2: libc::c_int = 49;
    const CAP: usize = 1024 * 1024;
    let pid = libc::c_int::try_from(pid).ok()?;
    let mut mib = [CTL_KERN, KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    // Safety: the size query writes only through `size`. No buffer is filled.
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size == 0 || size > CAP {
        return None;
    }
    let mut buf = vec![0u8; size];
    // Safety: `buf` is `size` bytes and `size` is updated to the bytes written.
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size > buf.len() {
        return None;
    }
    buf.truncate(size);
    Some(buf)
}

#[cfg(target_os = "linux")]
fn process_args(pid: u32) -> Option<Vec<u8>> {
    if pid == 0 {
        return None;
    }
    let file = File::open(format!("/proc/{pid}/environ")).ok()?;
    let mut buf = Vec::new();
    file.take(1024 * 1024).read_to_end(&mut buf).ok()?;
    Some(buf)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_args(pid: u32) -> Option<Vec<u8>> {
    let _ = pid;
    None
}

fn local_midnight_ms(now_ms: i64) -> i64 {
    let secs = now_ms.div_euclid(1000);
    let mut tm = unsafe { std::mem::zeroed::<libc::tm>() };
    let clock = secs as libc::time_t;
    // Safety: `tm` is zeroed and `localtime_r` writes that struct only.
    let ptr = unsafe { libc::localtime_r(&clock, &mut tm) };
    if ptr.is_null() {
        return secs.div_euclid(86_400) * 86_400 * 1000;
    }
    let since = i64::from(tm.tm_hour) * 3600 + i64::from(tm.tm_min) * 60 + i64::from(tm.tm_sec);
    (secs - since) * 1000
}

fn rollup_dir(root: &Path, focused: Option<&Path>, midnight_ms: i64) -> BedrockCost {
    let Some(jail) = root.canonicalize().ok() else {
        return BedrockCost::zero();
    };
    let focused = focused.and_then(|path| {
        let canon = path.canonicalize().ok()?;
        canon.starts_with(&jail).then_some(canon)
    });
    let mut files = Vec::new();
    collect_jsonl(&jail, &jail, midnight_ms, 0, &mut files);
    if let Some(path) = &focused {
        if !files.iter().any(|item| item == path) {
            files.push(path.clone());
        }
    }
    rollup_files(&files, focused.as_deref(), midnight_ms)
}

fn collect_jsonl(jail: &Path, dir: &Path, midnight_ms: i64, depth: u8, out: &mut Vec<PathBuf>) {
    if depth > 6 || out.len() >= FILE_CAP {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= FILE_CAP {
            return;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            collect_jsonl(jail, &path, midnight_ms, depth + 1, out);
            continue;
        }
        if !kind.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(modified) = mtime_ms(&path) else {
            continue;
        };
        if modified < midnight_ms {
            continue;
        }
        let Ok(canon) = path.canonicalize() else {
            continue;
        };
        if canon.starts_with(jail) {
            out.push(canon);
        }
    }
}

fn mtime_ms(path: &Path) -> Option<i64> {
    let modified = path.metadata().ok()?.modified().ok()?;
    let dur = modified.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(dur.as_millis()).ok()
}

fn rollup_files(files: &[PathBuf], focused: Option<&Path>, midnight_ms: i64) -> BedrockCost {
    let mut cost = BedrockCost::zero();
    for path in files {
        let summary = summarize(path);
        let is_focused = focused.is_some_and(|item| item == path);
        if is_focused {
            cost.session = session_part(&summary);
        }
        if is_focused || summary.bedrock_model {
            add_today(&mut cost.today, &summary, midnight_ms);
        }
    }
    cost
}

fn session_part(summary: &Summary) -> UsageCostPart {
    if let Some(usd) = trusted_usd(summary) {
        return UsageCostPart {
            known_usd: usd,
            estimated: false,
            models: Vec::new(),
        };
    }
    let models = fold_models(&summary.messages, |_| true);
    UsageCostPart {
        known_usd: 0.0,
        estimated: !models.is_empty(),
        models,
    }
}

fn add_today(part: &mut UsageCostPart, summary: &Summary, midnight_ms: i64) {
    let today = started_today(summary, midnight_ms);
    if today {
        if let Some(usd) = trusted_usd(summary) {
            part.known_usd += usd;
            return;
        }
    }
    let models = if today {
        fold_models(&summary.messages, |_| true)
    } else {
        fold_models(&summary.messages, |msg| msg.ts >= midnight_ms)
    };
    if models.is_empty() {
        return;
    }
    part.estimated = true;
    merge_models(&mut part.models, &models);
}

fn started_today(summary: &Summary, midnight_ms: i64) -> bool {
    summary.start_ms.is_some_and(|ts| ts >= midnight_ms)
}

fn trusted_usd(summary: &Summary) -> Option<f64> {
    if !summary.saw_cost || summary.unknown {
        return None;
    }
    let total = summary.total_usd.unwrap_or(0.0);
    if total > 0.0 || summary.priced_models {
        return Some(total);
    }
    if summary.messages.is_empty() {
        return Some(0.0);
    }
    None
}

fn summarize(path: &Path) -> Summary {
    let Ok(file) = File::open(path) else {
        return Summary::new();
    };
    let mut reader = BufReader::new(file);
    let mut summary = Summary::new();
    while let Some(line) = read_capped_line(&mut reader) {
        if line.is_empty() {
            continue;
        }
        if !line.contains("\"cost-state\"")
            && !line.contains("\"assistant\"")
            && !line.contains("\"attachment\"")
        {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(obj) = value.as_object() else {
            continue;
        };
        match obj.get("type").and_then(Value::as_str) {
            Some("cost-state") => take_cost(&mut summary, obj),
            Some("assistant") => take_assistant(&mut summary, obj),
            Some("attachment") => take_attachment(&mut summary, obj),
            _ => {}
        }
    }
    summary
}

enum LineStep {
    Eof,
    Done(usize),
    More(usize),
    Overflow(usize),
}

fn read_capped_line(reader: &mut BufReader<File>) -> Option<String> {
    let mut buf = Vec::new();
    loop {
        let step = {
            let available = reader.fill_buf().ok()?;
            if available.is_empty() {
                LineStep::Eof
            } else if let Some(pos) = available.iter().position(|byte| *byte == b'\n') {
                if buf.len() + pos <= LINE_CAP {
                    buf.extend_from_slice(&available[..=pos]);
                } else {
                    buf.clear();
                }
                LineStep::Done(pos + 1)
            } else if buf.len() + available.len() > LINE_CAP {
                LineStep::Overflow(available.len())
            } else {
                let n = available.len();
                buf.extend_from_slice(available);
                LineStep::More(n)
            }
        };
        match step {
            LineStep::Eof => {
                if buf.is_empty() {
                    return None;
                }
                break;
            }
            LineStep::Done(n) => {
                reader.consume(n);
                break;
            }
            LineStep::More(n) => reader.consume(n),
            LineStep::Overflow(n) => {
                reader.consume(n);
                discard_until_newline(reader)?;
                return Some(String::new());
            }
        }
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
    }
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn discard_until_newline(reader: &mut BufReader<File>) -> Option<()> {
    loop {
        let step = {
            let available = reader.fill_buf().ok()?;
            if available.is_empty() {
                return Some(());
            }
            if let Some(pos) = available.iter().position(|byte| *byte == b'\n') {
                LineStep::Done(pos + 1)
            } else {
                LineStep::More(available.len())
            }
        };
        match step {
            LineStep::Done(n) => {
                reader.consume(n);
                return Some(());
            }
            LineStep::More(n) => reader.consume(n),
            LineStep::Eof | LineStep::Overflow(_) => return Some(()),
        }
    }
}

fn take_cost(summary: &mut Summary, obj: &Map<String, Value>) {
    summary.saw_cost = true;
    if let Some(usd) = obj.get("totalCostUSD").and_then(nonneg_f64) {
        summary.total_usd = Some(usd);
    }
    if obj.get("hasUnknownModelCost").and_then(Value::as_bool) == Some(true) {
        summary.unknown = true;
    }
    if let Some(ts) = obj.get("startTime").and_then(timestamp_ms) {
        note_start(summary, ts);
    }
    if let Some(models) = obj.get("modelUsage").and_then(Value::as_object) {
        if !models.is_empty() {
            summary.priced_models = true;
        }
        for key in models.keys() {
            note_model(summary, key);
        }
    }
}

fn take_assistant(summary: &mut Summary, obj: &Map<String, Value>) {
    let Some(message) = obj.get("message").and_then(Value::as_object) else {
        return;
    };
    let model = message.get("model").and_then(Value::as_str).unwrap_or("");
    if model.starts_with('<') {
        return;
    }
    note_model(summary, model);
    if let Some(ts) = obj.get("timestamp").and_then(timestamp_ms) {
        note_start(summary, ts);
    }
    let Some(usage) = message.get("usage").and_then(Value::as_object) else {
        return;
    };
    let id = message.get("id").and_then(Value::as_str).unwrap_or("");
    let key = if id.is_empty() {
        summary.anon += 1;
        format!("anon-{}", summary.anon)
    } else {
        id.to_string()
    };
    let ts = obj.get("timestamp").and_then(timestamp_ms).unwrap_or(0);
    summary.messages.insert(
        key,
        MsgUse {
            model: if model.is_empty() {
                "unknown".to_string()
            } else {
                model.to_string()
            },
            ts,
            input: u64_of(usage, "input_tokens"),
            output: u64_of(usage, "output_tokens"),
            read: u64_of(usage, "cache_read_input_tokens"),
            write: u64_of(usage, "cache_creation_input_tokens"),
        },
    );
}

fn take_attachment(summary: &mut Summary, obj: &Map<String, Value>) {
    let Some(attachment) = obj.get("attachment").and_then(Value::as_object) else {
        return;
    };
    if attachment.get("type").and_then(Value::as_str) == Some("model") {
        if let Some(identity) = attachment.get("identity").and_then(Value::as_object) {
            if let Some(model_id) = identity.get("modelId").and_then(Value::as_str) {
                note_model(summary, model_id);
            }
        }
    }
}

fn note_start(summary: &mut Summary, ts: i64) {
    summary.start_ms = Some(summary.start_ms.map(|cur| cur.min(ts)).unwrap_or(ts));
}

fn note_model(summary: &mut Summary, model: &str) {
    if bedrock_model_id(model) {
        summary.bedrock_model = true;
    }
}

pub(crate) fn bedrock_model_id(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    if model.is_empty() || model.starts_with('<') {
        return false;
    }
    model.contains("anthropic.")
        || model.contains("amazon.")
        || model.contains("bedrock")
        || model.starts_with("arn:aws:")
        || model.contains(":inference-profile/")
}

fn fold_models(
    messages: &HashMap<String, MsgUse>,
    keep: impl Fn(&MsgUse) -> bool,
) -> Vec<UsageCostModel> {
    let mut models = Vec::new();
    for msg in messages.values() {
        if !keep(msg) || msg.input + msg.output + msg.read + msg.write == 0 {
            continue;
        }
        merge_one(
            &mut models,
            UsageCostModel {
                model: msg.model.clone(),
                input_tokens: msg.input,
                output_tokens: msg.output,
                cache_read_tokens: msg.read,
                cache_write_tokens: msg.write,
            },
        );
    }
    models.sort_by(|left, right| left.model.cmp(&right.model));
    models
}

fn merge_models(into: &mut Vec<UsageCostModel>, extra: &[UsageCostModel]) {
    for model in extra {
        merge_one(into, model.clone());
    }
    into.sort_by(|left, right| left.model.cmp(&right.model));
}

fn merge_one(into: &mut Vec<UsageCostModel>, model: UsageCostModel) {
    if let Some(found) = into.iter_mut().find(|item| item.model == model.model) {
        found.input_tokens += model.input_tokens;
        found.output_tokens += model.output_tokens;
        found.cache_read_tokens += model.cache_read_tokens;
        found.cache_write_tokens += model.cache_write_tokens;
        return;
    }
    into.push(model);
}

fn u64_of(obj: &Map<String, Value>, key: &str) -> u64 {
    let Some(value) = obj.get(key) else {
        return 0;
    };
    if let Some(n) = value.as_u64() {
        return n;
    }
    let Some(n) = value.as_f64() else {
        return 0;
    };
    if n.is_finite() && n > 0.0 {
        n.min(u64::MAX as f64) as u64
    } else {
        0
    }
}

fn nonneg_f64(value: &Value) -> Option<f64> {
    let n = value.as_f64()?;
    (n.is_finite() && n >= 0.0).then_some(n)
}

fn timestamp_ms(value: &Value) -> Option<i64> {
    if let Some(text) = value.as_str() {
        return parse_rfc3339_ms(text).filter(|ts| plausible(*ts));
    }
    let n = value.as_i64().or_else(|| {
        value
            .as_f64()
            .and_then(|n| if n.is_finite() { Some(n as i64) } else { None })
    })?;
    let ms = if n < 10_000_000_000 {
        n.saturating_mul(1000)
    } else {
        n
    };
    plausible(ms).then_some(ms)
}

fn plausible(ms: i64) -> bool {
    (1_000_000_000_000..4_000_000_000_000).contains(&ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    const MIDNIGHT: i64 = 1_700_000_000_000;
    const TODAY: &str = "2023-11-14T22:13:20Z";
    const YESTERDAY: &str = "2023-11-13T22:13:20Z";

    #[test]
    fn env_flag_matches_only_the_bedrock_entry() {
        assert!(flag_enabled(
            b"CLAUDE_CODE_USE_BEDROCK=1\0PATH=/bin",
            ENV_KEY
        ));
        assert!(flag_enabled(
            b"PATH=/bin\0CLAUDE_CODE_USE_BEDROCK=true\0",
            ENV_KEY
        ));
        assert!(flag_enabled(
            b"PATH=/bin\0CLAUDE_CODE_USE_BEDROCK=YES\0",
            ENV_KEY
        ));
        assert!(!flag_enabled(b"CLAUDE_CODE_USE_BEDROCK=0\0", ENV_KEY));
        assert!(!flag_enabled(b"CLAUDE_CODE_USE_BEDROCK=\0", ENV_KEY));
        assert!(!flag_enabled(b"CLAUDE_CODE_USE_BEDROCK=false\0", ENV_KEY));
        assert!(!flag_enabled(
            b"PATH=/bin\0OTHER=CLAUDE_CODE_USE_BEDROCK=1\0",
            ENV_KEY
        ));
        assert!(!flag_enabled(
            b"AWS_SECRET_ACCESS_KEY=not-a-real-secret\0",
            ENV_KEY
        ));
    }

    #[test]
    fn shell_commands_are_not_the_claude_process() {
        assert!(is_shell_command("/bin/zsh"));
        assert!(is_shell_command("-bash"));
        assert!(!is_shell_command("2.1.123"));
        assert!(!is_shell_command("claude"));
    }

    #[test]
    fn bedrock_ids_are_not_subscription_model_names() {
        assert!(bedrock_model_id(
            "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
        ));
        assert!(bedrock_model_id("anthropic.claude-3-5-haiku"));
        assert!(!bedrock_model_id("claude-sonnet-4-5"));
        assert!(!bedrock_model_id("mymodel"));
    }

    #[test]
    fn trusted_session_started_today_uses_claude_total() {
        let dir = scratch("trusted");
        let path = write_jsonl(
            &dir,
            "session.jsonl",
            &format!(
                "{{\"type\":\"assistant\",\"timestamp\":\"{TODAY}\",\"message\":{{\"id\":\"m1\",\"model\":\"claude-sonnet-4-5\",\"usage\":{{\"input_tokens\":10,\"output_tokens\":2}}}}}}\n\
                 {{\"type\":\"cost-state\",\"totalCostUSD\":1.5,\"hasUnknownModelCost\":false,\"startTime\":\"{TODAY}\",\"modelUsage\":{{\"claude-sonnet-4-5\":{{\"costUSD\":1.5}}}}}}\n"
            ),
        );
        let cost = rollup_files(std::slice::from_ref(&path), Some(&path), MIDNIGHT);
        assert_eq!(cost.session.known_usd, 1.5);
        assert!(!cost.session.estimated);
        assert!(cost.session.models.is_empty());
        assert_eq!(cost.today.known_usd, 1.5);
        assert!(!cost.today.estimated);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_price_returns_tokens_for_an_estimate() {
        let dir = scratch("unknown");
        let path = write_jsonl(
            &dir,
            "session.jsonl",
            &format!(
                "{{\"type\":\"assistant\",\"timestamp\":\"{TODAY}\",\"message\":{{\"id\":\"m1\",\"model\":\"mymodel\",\"usage\":{{\"input_tokens\":100,\"output_tokens\":5,\"cache_read_input_tokens\":7,\"cache_creation_input_tokens\":3}}}}}}\n\
                 {{\"type\":\"assistant\",\"timestamp\":\"{TODAY}\",\"message\":{{\"id\":\"m1\",\"model\":\"mymodel\",\"usage\":{{\"input_tokens\":10,\"output_tokens\":1}}}}}}\n\
                 {{\"type\":\"cost-state\",\"totalCostUSD\":0,\"hasUnknownModelCost\":true,\"startTime\":\"{TODAY}\",\"modelUsage\":{{}}}}\n"
            ),
        );
        let cost = rollup_files(std::slice::from_ref(&path), Some(&path), MIDNIGHT);
        assert_eq!(cost.session.known_usd, 0.0);
        assert!(cost.session.estimated);
        assert_eq!(cost.session.models.len(), 1);
        assert_eq!(cost.session.models[0].input_tokens, 10);
        assert_eq!(cost.session.models[0].output_tokens, 1);
        assert_eq!(cost.session.models[0].cache_read_tokens, 0);
        assert!(cost.today.estimated);
        assert_eq!(cost.today.models[0].input_tokens, 10);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zero_total_with_tokens_and_no_model_price_is_an_estimate() {
        let dir = scratch("empty-price");
        let path = write_jsonl(
            &dir,
            "session.jsonl",
            &format!(
                "{{\"type\":\"assistant\",\"timestamp\":\"{TODAY}\",\"message\":{{\"id\":\"m1\",\"model\":\"claude-sonnet-4-5\",\"usage\":{{\"input_tokens\":1000,\"output_tokens\":0}}}}}}\n\
                 {{\"type\":\"cost-state\",\"totalCostUSD\":0,\"hasUnknownModelCost\":false,\"startTime\":\"{TODAY}\",\"modelUsage\":{{}}}}\n"
            ),
        );
        let cost = rollup_files(std::slice::from_ref(&path), Some(&path), MIDNIGHT);
        assert!(cost.session.estimated);
        assert_eq!(cost.session.models[0].input_tokens, 1000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fresh_session_is_zero_and_not_an_estimate() {
        let dir = scratch("fresh");
        let path = write_jsonl(
            &dir,
            "session.jsonl",
            &format!(
                "{{\"type\":\"cost-state\",\"totalCostUSD\":0,\"hasUnknownModelCost\":false,\"startTime\":\"{TODAY}\",\"modelUsage\":{{}}}}\n"
            ),
        );
        let cost = rollup_files(std::slice::from_ref(&path), Some(&path), MIDNIGHT);
        assert_eq!(cost.session.known_usd, 0.0);
        assert!(!cost.session.estimated);
        assert!(cost.session.models.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_session_started_yesterday_counts_only_today_toward_today() {
        let dir = scratch("span");
        let path = write_jsonl(
            &dir,
            "session.jsonl",
            &format!(
                "{{\"type\":\"assistant\",\"timestamp\":\"{YESTERDAY}\",\"message\":{{\"id\":\"old\",\"model\":\"claude-sonnet-4-5\",\"usage\":{{\"input_tokens\":999,\"output_tokens\":1}}}}}}\n\
                 {{\"type\":\"assistant\",\"timestamp\":\"{TODAY}\",\"message\":{{\"id\":\"new\",\"model\":\"claude-sonnet-4-5\",\"usage\":{{\"input_tokens\":50,\"output_tokens\":4}}}}}}\n\
                 {{\"type\":\"cost-state\",\"totalCostUSD\":5,\"hasUnknownModelCost\":false,\"startTime\":\"{YESTERDAY}\",\"modelUsage\":{{\"claude-sonnet-4-5\":{{\"costUSD\":5}}}}}}\n"
            ),
        );
        let cost = rollup_files(std::slice::from_ref(&path), Some(&path), MIDNIGHT);
        assert_eq!(cost.session.known_usd, 5.0);
        assert!(!cost.session.estimated);
        assert_eq!(cost.today.known_usd, 0.0);
        assert!(cost.today.estimated);
        assert_eq!(cost.today.models[0].input_tokens, 50);
        assert_eq!(cost.today.models[0].output_tokens, 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn today_includes_other_bedrock_transcripts_and_skips_plain_ones() {
        let dir = scratch("today");
        let focused = write_jsonl(
            &dir,
            "focused.jsonl",
            &format!(
                "{{\"type\":\"cost-state\",\"totalCostUSD\":1.5,\"hasUnknownModelCost\":false,\"startTime\":\"{TODAY}\",\"modelUsage\":{{\"claude-sonnet-4-5\":{{\"costUSD\":1.5}}}}}}\n"
            ),
        );
        let plain = write_jsonl(
            &dir,
            "plain.jsonl",
            &format!(
                "{{\"type\":\"cost-state\",\"totalCostUSD\":9,\"hasUnknownModelCost\":false,\"startTime\":\"{TODAY}\",\"modelUsage\":{{\"claude-sonnet-4-5\":{{\"costUSD\":9}}}}}}\n"
            ),
        );
        let bedrock = write_jsonl(
            &dir,
            "bedrock.jsonl",
            &format!(
                "{{\"type\":\"assistant\",\"timestamp\":\"{TODAY}\",\"message\":{{\"id\":\"m1\",\"model\":\"us.anthropic.claude-sonnet-4-5-20250929-v1:0\",\"usage\":{{\"input_tokens\":1,\"output_tokens\":1}}}}}}\n\
                 {{\"type\":\"cost-state\",\"totalCostUSD\":2,\"hasUnknownModelCost\":false,\"startTime\":\"{TODAY}\",\"modelUsage\":{{\"us.anthropic.claude-sonnet-4-5-20250929-v1:0\":{{\"costUSD\":2}}}}}}\n"
            ),
        );
        let files = vec![focused.clone(), plain, bedrock];
        let cost = rollup_files(&files, Some(&focused), MIDNIGHT);
        assert_eq!(cost.session.known_usd, 1.5);
        assert_eq!(cost.today.known_usd, 3.5);
        assert!(!cost.today.estimated);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn files_modified_before_midnight_are_not_scanned() {
        let dir = scratch("old");
        let old = write_jsonl(
            &dir,
            "old.jsonl",
            &format!(
                "{{\"type\":\"assistant\",\"timestamp\":\"{TODAY}\",\"message\":{{\"id\":\"old\",\"model\":\"us.anthropic.claude-sonnet-4-5\",\"usage\":{{\"input_tokens\":80,\"output_tokens\":1}}}}}}\n\
                 {{\"type\":\"cost-state\",\"totalCostUSD\":20,\"hasUnknownModelCost\":false,\"startTime\":\"{YESTERDAY}\",\"modelUsage\":{{\"us.anthropic.claude-sonnet-4-5\":{{\"costUSD\":20}}}}}}\n"
            ),
        );
        set_mtime(&old, MIDNIGHT - 60_000);
        let live = write_jsonl(
            &dir,
            "live.jsonl",
            &format!(
                "{{\"type\":\"cost-state\",\"totalCostUSD\":1,\"hasUnknownModelCost\":false,\"startTime\":\"{TODAY}\",\"modelUsage\":{{\"us.anthropic.claude-sonnet-4-5\":{{\"costUSD\":1}}}}}}\n"
            ),
        );
        set_mtime(&live, MIDNIGHT + 60_000);
        let cost = rollup_dir(&dir, Some(&live), MIDNIGHT);
        assert_eq!(cost.session.known_usd, 1.0);
        assert_eq!(cost.today.known_usd, 1.0);
        assert!(!cost.today.estimated);
        assert!(cost.today.models.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_midnight_is_within_the_past_day() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let midnight = local_midnight_ms(now);
        assert!(midnight <= now);
        assert!(now - midnight < 86_400_000);
    }

    #[test]
    fn json_settings_detects_bedrock_configurations() {
        assert!(json_enables_bedrock(&serde_json::json!({
            "env": { "CLAUDE_CODE_USE_BEDROCK": "1" }
        })));
        assert!(json_enables_bedrock(&serde_json::json!({
            "env": { "CLAUDE_CODE_USE_BEDROCK": true }
        })));
        assert!(json_enables_bedrock(&serde_json::json!({
            "env": { "AWS_BEARER_TOKEN_BEDROCK": "token-123" }
        })));
        assert!(json_enables_bedrock(&serde_json::json!({
            "env": { "ANTHROPIC_BEDROCK_BASE_URL": "https://bedrock-runtime.us-east-1.amazonaws.com" }
        })));
        assert!(json_enables_bedrock(&serde_json::json!({
            "env": { "ANTHROPIC_MODEL": "us.anthropic.claude-sonnet-4-5-20250929-v1:0" }
        })));
        assert!(json_enables_bedrock(&serde_json::json!({
            "bedrock": true
        })));
        assert!(json_enables_bedrock(&serde_json::json!({
            "CLAUDE_CODE_USE_BEDROCK": "1"
        })));
        assert!(json_enables_bedrock(&serde_json::json!({
            "model": "anthropic.claude-3-5-sonnet-20241022-v2:0"
        })));

        assert!(!json_enables_bedrock(&serde_json::json!({
            "env": { "CLAUDE_CODE_USE_BEDROCK": "0" }
        })));
        assert!(!json_enables_bedrock(&serde_json::json!({
            "env": { "ANTHROPIC_MODEL": "claude-sonnet-4-5" }
        })));
        assert!(!json_enables_bedrock(&serde_json::json!({
            "model": "claude-3-5-sonnet-20241022"
        })));
    }

    #[test]
    fn settings_use_bedrock_walks_parent_cwd() {
        let dir = scratch("cwd-settings");
        let project_dir = dir.join("nested").join("subproject");
        std::fs::create_dir_all(&project_dir).unwrap();
        let dot_claude = dir.join(".claude");
        std::fs::create_dir_all(&dot_claude).unwrap();
        std::fs::write(
            dot_claude.join("settings.json"),
            r#"{"env": {"CLAUDE_CODE_USE_BEDROCK": "1"}}"#,
        )
        .unwrap();

        assert!(settings_use_bedrock(project_dir.to_str().unwrap()));
        assert!(!settings_use_bedrock(
            "/nonexistent/path/that/does/not/exist"
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_bedrock_transcript_identifies_bedrock_models() {
        let dir = scratch("transcript-bedrock");
        let bedrock_path = write_jsonl(
            &dir,
            "bedrock.jsonl",
            &format!(
                "{{\"type\":\"assistant\",\"timestamp\":\"{TODAY}\",\"message\":{{\"id\":\"m1\",\"model\":\"us.anthropic.claude-sonnet-4-5-20250929-v1:0\",\"usage\":{{\"input_tokens\":10,\"output_tokens\":2}}}}}}\n"
            ),
        );
        let non_bedrock_path = write_jsonl(
            &dir,
            "non_bedrock.jsonl",
            &format!(
                "{{\"type\":\"assistant\",\"timestamp\":\"{TODAY}\",\"message\":{{\"id\":\"m1\",\"model\":\"claude-sonnet-4-5\",\"usage\":{{\"input_tokens\":10,\"output_tokens\":2}}}}}}\n"
            ),
        );
        let attachment_bedrock_path = write_jsonl(
            &dir,
            "attachment.jsonl",
            &format!(
                "{{\"type\":\"attachment\",\"attachment\":{{\"type\":\"model\",\"identity\":{{\"modelId\":\"arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0\"}}}}}}\n"
            ),
        );

        assert!(is_bedrock_transcript(&bedrock_path));
        assert!(is_bedrock_transcript(&attachment_bedrock_path));
        assert!(!is_bedrock_transcript(&non_bedrock_path));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sparkmux-bedrock-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_jsonl(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    fn set_mtime(path: &Path, ms: i64) {
        let file = std::fs::File::options().write(true).open(path).unwrap();
        let when = UNIX_EPOCH + Duration::from_millis(ms as u64);
        file.set_modified(when).unwrap();
    }
}
