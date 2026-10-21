//! Account allowance for the focused pane's CLI.
//!
//! Grok writes the weekly used percent to `~/.grok/logs/unified.jsonl`.
//! Claude keeps its reset meter inside the CLI process, so those bars stay
//! empty until a local payload is handed to the parser. A Claude process with
//! `CLAUDE_CODE_USE_BEDROCK` set reports session and today API cost instead.
//! Antigravity prints the same table as `/usage` from `agy --print /usage`.
//! While an agy pane is focused, that command runs on a periodic interval
//! (defaulting to 5 minutes, configurable via `agy-usage.toml`).
//! Its log goes to a temp file. This module does not open credential files.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::artifacts::{cli_kind, CliKind};

const GROK_MARKER: &str = "billing: fetched credits config";
const CHUNK: u64 = 256 * 1024;
const MAX_SCAN: u64 = 8 * 1024 * 1024;
const AGY_PRINT_TIMEOUT: Duration = Duration::from_secs(15);
const AGY_PRINT_STDOUT_CAP: u64 = 64 * 1024;
/// Default minutes between Antigravity usage refreshes.
const DEFAULT_AGY_MINUTES: u32 = 5;
const AGY_USAGE_FILE: &str = "agy-usage.toml";

static AGY_MINUTES: AtomicU32 = AtomicU32::new(DEFAULT_AGY_MINUTES);

#[derive(Debug, Deserialize)]
struct AgyUsageFile {
    minutes: u32,
}

struct AgyPrintState {
    usage: Option<LlmUsage>,
    attempted_at_ms: i64,
    inflight: bool,
}

static AGY_PRINT: LazyLock<Mutex<AgyPrintState>> = LazyLock::new(|| {
    Mutex::new(AgyPrintState {
        usage: None,
        attempted_at_ms: 0,
        inflight: false,
    })
});

/// Clears the in-flight flag if a print finishes, is cancelled, or panics.
struct AgyPrintFinish;

impl Drop for AgyPrintFinish {
    fn drop(&mut self) {
        let mut guard = AGY_PRINT.lock().unwrap_or_else(|err| err.into_inner());
        guard.inflight = false;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageDirection {
    Used,
    Remaining,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageBar {
    pub group: Option<String>,
    pub label: String,
    pub percent: f64,
    pub direction: UsageDirection,
    pub resets_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LlmUsage {
    pub cli: Option<String>,
    pub bars: Vec<UsageBar>,
    pub fetched_at_ms: Option<i64>,
    pub plan: Option<String>,
    pub credits_usd: Option<f64>,
    /// Bedrock API cost for this pane. Absent for subscription Claude, Grok, and Antigravity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<crate::bedrock_cost::BedrockCost>,
}

impl LlmUsage {
    fn empty() -> Self {
        Self {
            cli: None,
            bars: Vec::new(),
            fetched_at_ms: None,
            plan: None,
            credits_usd: None,
            cost: None,
        }
    }

    fn recognized(cli: &str) -> Self {
        Self {
            cli: Some(cli.to_string()),
            bars: Vec::new(),
            fetched_at_ms: None,
            plan: None,
            credits_usd: None,
            cost: None,
        }
    }
}

struct UsagePaths {
    grok_log: PathBuf,
    claude_usage: Option<PathBuf>,
    agy_usage: Option<PathBuf>,
}

#[tauri::command]
pub async fn llm_usage(command: String, title: String, cwd: String, pid: u32) -> LlmUsage {
    if crate::ssh_bind::ssh_foreground(&command) {
        return tokio::task::spawn_blocking(move || {
            if crate::ssh_bind::remote_roots(pid).is_none() {
                return LlmUsage::empty();
            }
            let mut usage = LlmUsage::empty();
            usage.cost = crate::bedrock_cost::cost_for(&command, &cwd, &title, pid, now_ms());
            usage
        })
        .await
        .unwrap_or_else(|_| LlmUsage::empty());
    }
    let now = now_ms();
    let family = crate::artifacts::pane_family(pid);
    let detected_kind = crate::artifacts::detect_cli(&command, &title, &family);
    let mut usage = match detected_kind {
        Some(crate::artifacts::CliKind::Grok) => usage_for(&command, &title, &default_paths(), now),
        Some(crate::artifacts::CliKind::Claude) => LlmUsage::recognized("claude"),
        Some(crate::artifacts::CliKind::Antigravity) => {
            let mut u = usage_for(&command, &title, &default_paths(), now);
            if u.cli.is_none() {
                u = LlmUsage::recognized("antigravity");
            }
            u
        }
        None => usage_for(&command, &title, &default_paths(), now),
    };
    if usage.cli.as_deref() == Some("antigravity") {
        if agy_refresh_minutes() == 0 {
            return LlmUsage::empty();
        }
        if usage.bars.is_empty() {
            return agy_print_cached(now);
        }
    }
    let is_claude = usage.cli.as_deref() == Some("claude")
        || detected_kind == Some(crate::artifacts::CliKind::Claude);
    if is_claude {
        if let Some(cost) = crate::bedrock_cost::cost_for(&command, &cwd, &title, pid, now) {
            usage.cli = Some("claude".to_string());
            usage.cost = Some(cost);
        }
    } else if let Some(cost) = crate::bedrock_cost::cost_for(&command, &cwd, &title, pid, now) {
        usage.cli = Some("claude".to_string());
        usage.cost = Some(cost);
    }
    usage
}

pub fn agy_refresh_minutes() -> u32 {
    AGY_MINUTES.load(Ordering::Relaxed)
}

/// Loads the saved interval. A missing or invalid file keeps the default (5 minutes).
pub fn init_agy_usage() {
    let Some(path) = agy_usage_path() else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    if let Some(minutes) = parse_agy_minutes(&text) {
        AGY_MINUTES.store(minutes, Ordering::Relaxed);
    }
}

fn valid_agy_minutes(minutes: u32) -> bool {
    matches!(minutes, 0..=60)
}

fn agy_refresh_interval_ms() -> Option<i64> {
    match agy_refresh_minutes() {
        0 => None,
        minutes => Some(i64::from(minutes) * 60_000),
    }
}

fn agy_usage_path() -> Option<PathBuf> {
    directories::ProjectDirs::from("", "", "sparkmux")
        .map(|dirs| dirs.config_dir().join(AGY_USAGE_FILE))
}

fn parse_agy_minutes(text: &str) -> Option<u32> {
    let file: AgyUsageFile = toml::from_str(text).ok()?;
    valid_agy_minutes(file.minutes).then_some(file.minutes)
}

#[cfg(test)]
fn write_agy_minutes(path: &Path, minutes: u32) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let body = format!("minutes = {minutes}\n");
    std::fs::write(path, body).map_err(|err| err.to_string())
}

fn default_paths() -> UsagePaths {
    let home = directories::UserDirs::new().map(|dirs| dirs.home_dir().to_path_buf());
    UsagePaths {
        grok_log: home
            .unwrap_or_default()
            .join(".grok")
            .join("logs")
            .join("unified.jsonl"),
        claude_usage: None,
        agy_usage: None,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_millis() as i64)
        .unwrap_or(0)
}

fn usage_for(command: &str, title: &str, paths: &UsagePaths, now: i64) -> LlmUsage {
    let Some(kind) = cli_kind(command).or_else(|| cli_kind(title)) else {
        return LlmUsage::empty();
    };
    match kind {
        CliKind::Grok => read_grok(&paths.grok_log),
        CliKind::Claude => read_claude(paths.claude_usage.as_deref()),
        CliKind::Antigravity => read_agy(paths.agy_usage.as_deref(), now),
    }
}

fn read_grok(path: &Path) -> LlmUsage {
    let mut usage = LlmUsage::recognized("grok");
    let Some(text) = read_log_tail(path, GROK_MARKER) else {
        return usage;
    };
    if let Some(parsed) = parse_grok_log(&text) {
        usage = parsed;
    }
    usage
}

fn read_claude(path: Option<&Path>) -> LlmUsage {
    let mut usage = LlmUsage::recognized("claude");
    let Some(path) = path else {
        return usage;
    };
    let Some(text) = read_small(path) else {
        return usage;
    };
    if let Some(parsed) = parse_claude_usage(&text) {
        usage = parsed;
    }
    usage
}

fn read_agy(path: Option<&Path>, now: i64) -> LlmUsage {
    let mut usage = LlmUsage::recognized("antigravity");
    let Some(path) = path else {
        return usage;
    };
    let Some(text) = read_small(path) else {
        return usage;
    };
    if let Some(parsed) = parse_agy_usage(&text, now) {
        usage = parsed;
    }
    usage
}

/// Last successful `agy --print /usage` table, refreshed on the menu interval in a background thread.
fn agy_print_cached(now: i64) -> LlmUsage {
    let mut guard = AGY_PRINT.lock().unwrap_or_else(|err| err.into_inner());
    let Some(refresh_ms) = agy_refresh_interval_ms() else {
        return guard
            .usage
            .clone()
            .unwrap_or_else(|| LlmUsage::recognized("antigravity"));
    };
    if !guard.inflight && now.saturating_sub(guard.attempted_at_ms) >= refresh_ms {
        guard.inflight = true;
        guard.attempted_at_ms = now;
        thread::Builder::new()
            .name("sparkmux-agy-usage".to_string())
            .spawn(move || {
                let _finish = AgyPrintFinish;
                if let Some(fetched) = run_agy_print(now) {
                    let mut guard = AGY_PRINT.lock().unwrap_or_else(|err| err.into_inner());
                    if !fetched.bars.is_empty() {
                        guard.usage = Some(fetched);
                    }
                }
            })
            .ok();
    }
    guard
        .usage
        .clone()
        .unwrap_or_else(|| LlmUsage::recognized("antigravity"))
}

fn run_agy_print(now: i64) -> Option<LlmUsage> {
    let bin = agy_binary()?;
    let dir = std::env::temp_dir();
    let log_path = dir.join("sparkmux-agy-usage.log");
    let _ = File::create(&log_path);
    let mut command = Command::new(bin);
    command
        .arg("--log-file")
        .arg(&log_path)
        .arg("--print")
        .arg("/usage")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if dir.is_dir() {
        command.current_dir(&dir);
    }
    let mut child = command.spawn().ok()?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= AGY_PRINT_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }
    let stdout = child.stdout.take()?;
    let mut buf = Vec::new();
    stdout
        .take(AGY_PRINT_STDOUT_CAP)
        .read_to_end(&mut buf)
        .ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut usage = parse_agy_print(&text)?;
    usage.fetched_at_ms = Some(now);
    Some(usage)
}

pub(crate) fn agy_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("agy");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let home = directories::UserDirs::new()?
        .home_dir()
        .join(".local/bin/agy");
    home.is_file().then_some(home)
}

fn read_small(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() == 0 || meta.len() > 1024 * 1024 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// Last slice of `path` that contains `marker`, up to [`MAX_SCAN`] bytes.
/// A read that starts mid-file drops the partial first line.
fn read_log_tail(path: &Path, marker: &str) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len == 0 || marker.is_empty() {
        return None;
    }
    let mut start = len;
    let mut collected: Vec<u8> = Vec::new();
    let mut scanned = 0u64;
    let marker_bytes = marker.as_bytes();
    loop {
        if start == 0 || scanned >= MAX_SCAN {
            break;
        }
        let take = CHUNK.min(start);
        start -= take;
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = vec![0u8; take as usize];
        file.read_exact(&mut buf).ok()?;
        buf.append(&mut collected);
        collected = buf;
        scanned += take;
        if start == 0
            || collected
                .windows(marker_bytes.len())
                .any(|window| window == marker_bytes)
        {
            break;
        }
    }
    if start != 0 {
        // The billing line can begin in the previous chunk. Pull that line in
        // before discarding a partial first line.
        let extra = (64 * 1024).min(start);
        let back = start - extra;
        file.seek(SeekFrom::Start(back)).ok()?;
        let mut buf = vec![0u8; extra as usize];
        file.read_exact(&mut buf).ok()?;
        buf.append(&mut collected);
        collected = buf;
        start = back;
    }
    if start != 0 {
        if let Some(pos) = collected.iter().position(|byte| *byte == b'\n') {
            collected.drain(..=pos);
        }
    }
    if collected.is_empty() {
        return None;
    }
    Some(String::from_utf8_lossy(&collected).into_owned())
}

fn parse_grok_log(text: &str) -> Option<LlmUsage> {
    let mut last: Option<LlmUsage> = None;
    for line in text.lines() {
        let line = line.trim();
        if !line.contains(GROK_MARKER) {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("msg").and_then(Value::as_str) != Some(GROK_MARKER) {
            continue;
        }
        let Some(parsed) = grok_from_value(&value) else {
            continue;
        };
        last = Some(parsed);
    }
    last
}

fn grok_from_value(value: &Value) -> Option<LlmUsage> {
    let config = value.get("ctx")?.get("config")?;
    let percent = clamp_percent(config.get("creditUsagePercent")?.as_f64()?)?;
    let resets_at_ms = config
        .get("currentPeriod")
        .and_then(|period| period.get("end"))
        .and_then(Value::as_str)
        .and_then(parse_rfc3339_ms);
    let plan = value
        .get("ctx")
        .and_then(|ctx| ctx.get("subscriptionTier"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    let credits_usd = config.get("prepaidBalance").and_then(cents_to_dollars);
    let fetched_at_ms = value
        .get("ts")
        .and_then(Value::as_str)
        .and_then(parse_rfc3339_ms);
    Some(LlmUsage {
        cli: Some("grok".to_string()),
        bars: vec![UsageBar {
            group: None,
            label: "Weekly".to_string(),
            percent,
            direction: UsageDirection::Used,
            resets_at_ms,
        }],
        fetched_at_ms,
        plan,
        credits_usd,
        cost: None,
    })
}

fn cents_to_dollars(value: &Value) -> Option<f64> {
    let raw = value.get("val").unwrap_or(value);
    let cents = raw.as_f64()?;
    if !cents.is_finite() || cents < 0.0 {
        return None;
    }
    Some((cents / 100.0 * 100.0).round() / 100.0)
}

fn parse_claude_usage(text: &str) -> Option<LlmUsage> {
    let value: Value = serde_json::from_str(text).ok()?;
    let mut bars = Vec::new();
    push_claude_bar(&value, "five_hour", "5 hour", &mut bars);
    push_claude_bar(&value, "seven_day", "Week", &mut bars);
    push_claude_bar(&value, "seven_day_sonnet", "Week Sonnet", &mut bars);
    push_claude_bar(&value, "seven_day_opus", "Week Opus", &mut bars);
    if bars.is_empty() {
        return None;
    }
    Some(LlmUsage {
        cli: Some("claude".to_string()),
        bars,
        fetched_at_ms: None,
        plan: None,
        credits_usd: None,
        cost: None,
    })
}

fn push_claude_bar(value: &Value, key: &str, label: &str, bars: &mut Vec<UsageBar>) {
    let Some(window) = value.get(key).filter(|item| !item.is_null()) else {
        return;
    };
    let Some(percent) = window
        .get("utilization")
        .and_then(Value::as_f64)
        .and_then(clamp_percent)
    else {
        return;
    };
    let resets_at_ms = window
        .get("resetsAt")
        .and_then(Value::as_i64)
        .map(epoch_to_ms);
    bars.push(UsageBar {
        group: None,
        label: label.to_string(),
        percent,
        direction: UsageDirection::Used,
        resets_at_ms,
    });
}

fn parse_agy_usage(text: &str, now: i64) -> Option<LlmUsage> {
    let value: Value = serde_json::from_str(text).ok()?;
    let groups = value.get("groups")?.as_array()?;
    let mut bars = Vec::new();
    for group in groups {
        let group_name = group
            .get("name")
            .and_then(Value::as_str)
            .map(short_group)
            .filter(|name| !name.is_empty());
        let Some(buckets) = group.get("buckets").and_then(Value::as_array) else {
            continue;
        };
        for bucket in buckets {
            let Some(label) = bucket
                .get("kind")
                .and_then(Value::as_str)
                .and_then(bucket_label)
            else {
                continue;
            };
            let Some(fraction) = bucket.get("remainingFraction").and_then(Value::as_f64) else {
                continue;
            };
            if !fraction.is_finite() {
                continue;
            }
            let Some(percent) = clamp_percent((fraction * 100.0 * 100.0).round() / 100.0) else {
                continue;
            };
            bars.push(UsageBar {
                group: group_name.clone(),
                label: label.to_string(),
                percent,
                direction: UsageDirection::Remaining,
                resets_at_ms: bucket_reset(bucket, now),
            });
        }
    }
    if bars.is_empty() {
        return None;
    }
    Some(LlmUsage {
        cli: Some("antigravity".to_string()),
        bars,
        fetched_at_ms: None,
        plan: None,
        credits_usd: None,
        cost: None,
    })
}

fn short_group(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.contains("gemini") {
        return "Gemini".to_string();
    }
    if lower.contains("claude") {
        return "Claude".to_string();
    }
    name.split_whitespace()
        .next()
        .unwrap_or(name)
        .chars()
        .take(16)
        .collect()
}

fn bucket_label(kind: &str) -> Option<&'static str> {
    let key = kind.to_ascii_lowercase().replace(['-', ' '], "_");
    if key.contains("five") || key.contains("5_hour") || key == "5h" {
        return Some("5 hour");
    }
    if key.contains("week") {
        return Some("Weekly");
    }
    None
}

/// `agy --print /usage` table. A pipe prints tab-separated UTC timestamps.
/// A terminal prints aligned columns and a local clock such as `02:32 PDT`.
fn parse_agy_print(text: &str) -> Option<LlmUsage> {
    let mut bars = Vec::new();
    for line in text.lines() {
        if let Some(bar) = parse_agy_print_line(line) {
            bars.push(bar);
        }
    }
    if bars.is_empty() {
        return None;
    }
    Some(LlmUsage {
        cli: Some("antigravity".to_string()),
        bars,
        fetched_at_ms: None,
        plan: None,
        credits_usd: None,
        cost: None,
    })
}

fn parse_agy_print_line(line: &str) -> Option<UsageBar> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    if line.contains('\t') {
        let parts: Vec<&str> = line
            .split('\t')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect();
        if parts.len() < 3 {
            return None;
        }
        let label = bucket_label(parts[1])?;
        let percent = parse_percent_token(parts[2])?;
        let resets_at_ms = parts.get(3).and_then(|stamp| parse_agy_stamp(stamp));
        return Some(print_bar(parts[0], label, percent, resets_at_ms));
    }
    let lower = line.to_ascii_lowercase();
    let (idx, label_len, label) = if let Some(idx) = lower.find("five hour limit remaining") {
        (idx, "five hour limit remaining".len(), "5 hour")
    } else {
        let idx = lower.find("weekly limit remaining")?;
        (idx, "weekly limit remaining".len(), "Weekly")
    };
    let rest = line.get(idx + label_len..)?.trim();
    let (percent_token, stamp) = split_percent(rest)?;
    let percent = parse_percent_token(percent_token)?;
    Some(print_bar(
        line.get(..idx)?.trim(),
        label,
        percent,
        parse_agy_stamp(stamp),
    ))
}

fn print_bar(group: &str, label: &str, percent: f64, resets_at_ms: Option<i64>) -> UsageBar {
    let group = short_group(group);
    UsageBar {
        group: if group.is_empty() { None } else { Some(group) },
        label: label.to_string(),
        percent,
        direction: UsageDirection::Remaining,
        resets_at_ms,
    }
}

fn split_percent(rest: &str) -> Option<(&str, &str)> {
    let idx = rest.find('%')?;
    Some((rest.get(..idx)?.trim(), rest.get(idx + 1..)?.trim()))
}

fn parse_percent_token(token: &str) -> Option<f64> {
    let number = token.trim().trim_end_matches('%').trim();
    clamp_percent(number.parse().ok()?)
}

fn parse_agy_stamp(stamp: &str) -> Option<i64> {
    let stamp = stamp.trim();
    if let Some(ms) = parse_rfc3339_ms(stamp) {
        return Some(ms);
    }
    let mut parts = stamp.split_whitespace();
    let date = parts.next()?;
    let time = parts.next()?;
    let zone = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let offset = zone_offset_min(zone)?;
    let mut clock = time.split(':');
    let hour: u32 = clock.next()?.parse().ok()?;
    let minute: u32 = clock.next()?.parse().ok()?;
    let second: u32 = match clock.next() {
        Some(value) => value.parse().ok()?,
        None => 0,
    };
    if clock.next().is_some() || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let utc = parse_rfc3339_ms(&format!("{date}T{hour:02}:{minute:02}:{second:02}Z"))?;
    Some(utc - i64::from(offset) * 60_000)
}

fn zone_offset_min(zone: &str) -> Option<i32> {
    match zone.trim().to_ascii_lowercase().as_str() {
        "z" | "utc" | "gmt" => Some(0),
        "pdt" => Some(-7 * 60),
        "pst" => Some(-8 * 60),
        _ => None,
    }
}

fn bucket_reset(bucket: &Value, now: i64) -> Option<i64> {
    if let Some(at) = bucket.get("resetsAt").and_then(Value::as_i64) {
        return Some(epoch_to_ms(at));
    }
    if let Some(at) = bucket.get("refreshAt").and_then(Value::as_i64) {
        return Some(epoch_to_ms(at));
    }
    let seconds = bucket.get("resetsInSeconds").and_then(Value::as_i64)?;
    if seconds < 0 {
        return None;
    }
    Some(now.saturating_add(seconds.saturating_mul(1000)))
}

fn epoch_to_ms(value: i64) -> i64 {
    if value.abs() < 1_000_000_000_000 {
        value.saturating_mul(1000)
    } else {
        value
    }
}

fn clamp_percent(percent: f64) -> Option<f64> {
    if !percent.is_finite() {
        return None;
    }
    Some(percent.clamp(0.0, 100.0))
}

pub(crate) fn parse_rfc3339_ms(input: &str) -> Option<i64> {
    let text = input.trim();
    if text.len() < 20 {
        return None;
    }
    let bytes = text.as_bytes();
    let year: i32 = text.get(0..4)?.parse().ok()?;
    if bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    let month: u32 = text.get(5..7)?.parse().ok()?;
    let day: u32 = text.get(8..10)?.parse().ok()?;
    if bytes.get(10) != Some(&b'T') && bytes.get(10) != Some(&b't') {
        return None;
    }
    if bytes.get(13) != Some(&b':') || bytes.get(16) != Some(&b':') {
        return None;
    }
    let hour: u32 = text.get(11..13)?.parse().ok()?;
    let minute: u32 = text.get(14..16)?.parse().ok()?;
    let second: u32 = text.get(17..19)?.parse().ok()?;
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let (millis, rest) = parse_fraction(text.get(19..)?)?;
    let offset_min = parse_offset(rest)?;
    let unix = civil_unix_ms(year, month, day, hour, minute, second, millis)?;
    Some(unix - i64::from(offset_min) * 60_000)
}

fn parse_fraction(rest: &str) -> Option<(u32, &str)> {
    if let Some(stripped) = rest.strip_prefix('.') {
        let digits: String = stripped
            .chars()
            .take_while(|ch| ch.is_ascii_digit())
            .collect();
        if digits.is_empty() {
            return None;
        }
        let padded = format!("{digits:0<3}");
        let millis: u32 = padded.get(0..3)?.parse().ok()?;
        Some((millis, stripped.get(digits.len()..)?))
    } else {
        Some((0, rest))
    }
}

fn parse_offset(rest: &str) -> Option<i32> {
    if rest == "Z" || rest == "z" {
        return Some(0);
    }
    let sign = match rest.as_bytes().first() {
        Some(b'+') => 1,
        Some(b'-') => -1,
        _ => return None,
    };
    let body = rest.get(1..)?;
    let (hour, minute) = if body.len() >= 5 && body.as_bytes().get(2) == Some(&b':') {
        (
            body.get(0..2)?.parse::<i32>().ok()?,
            body.get(3..5)?.parse::<i32>().ok()?,
        )
    } else if body.len() >= 4 {
        (
            body.get(0..2)?.parse::<i32>().ok()?,
            body.get(2..4)?.parse::<i32>().ok()?,
        )
    } else {
        return None;
    };
    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) {
        return None;
    }
    Some(sign * (hour * 60 + minute))
}

/// Days since the Unix epoch, then the clock, via Howard Hinnant's civil algorithm.
fn civil_unix_ms(
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    millis: u32,
) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || millis > 999 {
        return None;
    }
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = (year - era * 400) as u32;
    let month_prime = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = i64::from(era) * 146097 + i64::from(day_of_era) - 719468;
    let secs = days
        .checked_mul(86_400)?
        .checked_add(i64::from(hour) * 3600)?
        .checked_add(i64::from(minute) * 60)?
        .checked_add(i64::from(second))?;
    secs.checked_mul(1000)?.checked_add(i64::from(millis))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn billing(percent: f64, end: &str, ts: &str) -> String {
        format!(
            r#"{{"ts":"{ts}","msg":"billing: fetched credits config","ctx":{{"config":{{"creditUsagePercent":{percent},"currentPeriod":{{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"{end}"}},"prepaidBalance":{{"val":1000}}}},"subscriptionTier":"SuperGrok Plus"}}}}"#
        )
    }

    fn paths(dir: &Path) -> UsagePaths {
        UsagePaths {
            grok_log: dir.join("unified.jsonl"),
            claude_usage: None,
            agy_usage: None,
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sparkmux-llm-usage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn grok_keeps_the_later_billing_line() {
        let text = format!(
            "{}\nnot json\n{}\n",
            billing(41.0, "2026-10-06T21:22:33Z", "2026-10-10T03:54:27.218Z"),
            billing(
                70.0,
                "2026-10-13T21:22:33.541807+00:00",
                "2026-10-11T05:02:48.003Z"
            )
        );
        let usage = parse_grok_log(&text).unwrap();
        assert_eq!(usage.cli.as_deref(), Some("grok"));
        assert_eq!(usage.plan.as_deref(), Some("SuperGrok Plus"));
        assert_eq!(usage.credits_usd, Some(10.0));
        assert_eq!(usage.fetched_at_ms, Some(1_791_694_968_003));
        assert_eq!(usage.bars.len(), 1);
        let bar = &usage.bars[0];
        assert_eq!(bar.label, "Weekly");
        assert_eq!(bar.percent, 70.0);
        assert_eq!(bar.direction, UsageDirection::Used);
        assert_eq!(bar.resets_at_ms, Some(1_791_926_553_541));
        assert!(bar.group.is_none());
    }

    #[test]
    fn a_log_without_billing_and_a_missing_file_have_no_bars() {
        assert!(parse_grok_log("{\"msg\":\"other\"}\n").is_none());
        let dir = scratch("missing");
        let usage = usage_for("grok", "", &paths(&dir), 0);
        assert_eq!(usage.cli.as_deref(), Some("grok"));
        assert!(usage.bars.is_empty());
        let _ = fs::remove_dir_all(&dir);

        let dir = scratch("empty-log");
        fs::write(dir.join("unified.jsonl"), "{\"msg\":\"ready\"}\n").unwrap();
        let usage = usage_for("grok-1.0.50", "zsh", &paths(&dir), 0);
        assert_eq!(usage.cli.as_deref(), Some("grok"));
        assert!(usage.bars.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_reader_walks_back_when_the_tail_has_no_billing_line() {
        let dir = scratch("walk");
        let path = dir.join("unified.jsonl");
        let head = format!(
            "{}\n",
            billing(70.0, "2026-10-13T21:22:33Z", "2026-10-11T05:02:48.003Z")
        );
        let mut body = head;
        while body.len() < (CHUNK as usize) + 4096 {
            body.push_str("{\"msg\":\"noise\",\"n\":1}\n");
        }
        fs::write(&path, &body).unwrap();
        let usage = read_grok(&path);
        assert_eq!(usage.bars.len(), 1);
        assert_eq!(usage.bars[0].percent, 70.0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_windows_are_percent_used() {
        let text = r#"{"five_hour":{"utilization":20,"resetsAt":1791694968},"seven_day":{"utilization":55,"resetsAt":1791926553541},"seven_day_sonnet":{"utilization":10,"resetsAt":1791926553}}"#;
        let usage = parse_claude_usage(text).unwrap();
        assert_eq!(usage.cli.as_deref(), Some("claude"));
        assert_eq!(usage.bars.len(), 3);
        assert_eq!(usage.bars[0].label, "5 hour");
        assert_eq!(usage.bars[0].percent, 20.0);
        assert_eq!(usage.bars[0].direction, UsageDirection::Used);
        assert_eq!(usage.bars[0].resets_at_ms, Some(1_791_694_968_000));
        assert_eq!(usage.bars[1].label, "Week");
        assert_eq!(usage.bars[1].percent, 55.0);
        assert_eq!(usage.bars[1].resets_at_ms, Some(1_791_926_553_541));
        assert_eq!(usage.bars[2].label, "Week Sonnet");
        assert_eq!(usage.bars[2].resets_at_ms, Some(1_791_926_553_000));
    }

    #[test]
    fn agy_remaining_fraction_becomes_a_percent() {
        let now = 1_700_000_000_000_i64;
        let text = r#"{"groups":[{"name":"GEMINI MODELS","buckets":[{"kind":"weekly","remainingFraction":0.8396,"resetsInSeconds":536000},{"kind":"five_hour","remainingFraction":0.7986,"resetsInSeconds":14100}]},{"name":"CLAUDE AND GPT MODELS","buckets":[{"kind":"weekly","remainingFraction":0.4891,"resetsAt":1791926553}]}]}"#;
        let usage = parse_agy_usage(text, now).unwrap();
        assert_eq!(usage.cli.as_deref(), Some("antigravity"));
        assert_eq!(usage.bars.len(), 3);
        assert_eq!(usage.bars[0].group.as_deref(), Some("Gemini"));
        assert_eq!(usage.bars[0].label, "Weekly");
        assert_eq!(usage.bars[0].percent, 83.96);
        assert_eq!(usage.bars[0].direction, UsageDirection::Remaining);
        assert_eq!(usage.bars[0].resets_at_ms, Some(now + 536_000 * 1000));
        assert_eq!(usage.bars[1].label, "5 hour");
        assert_eq!(usage.bars[1].percent, 79.86);
        assert_eq!(usage.bars[2].group.as_deref(), Some("Claude"));
        assert_eq!(usage.bars[2].percent, 48.91);
        assert_eq!(usage.bars[2].resets_at_ms, Some(1_791_926_553_000));
    }

    #[test]
    fn the_pane_command_selects_the_reader() {
        let dir = scratch("select");
        let line = format!(
            "{}\n",
            billing(70.0, "2026-10-13T21:22:33Z", "2026-10-11T05:02:48.003Z")
        );
        fs::write(dir.join("unified.jsonl"), line).unwrap();
        let paths = paths(&dir);
        let grok = usage_for("grok-1.0.50", "zsh", &paths, 0);
        assert_eq!(grok.cli.as_deref(), Some("grok"));
        assert_eq!(grok.bars.len(), 1);
        assert_eq!(grok.bars[0].percent, 70.0);

        let shell = usage_for("zsh", "zsh", &paths, 0);
        assert!(shell.cli.is_none());
        assert!(shell.bars.is_empty());

        let claude = usage_for("node", "Claude Code", &paths, 0);
        assert_eq!(claude.cli.as_deref(), Some("claude"));
        assert!(claude.bars.is_empty());

        let agy = usage_for("agy", "", &paths, 0);
        assert_eq!(agy.cli.as_deref(), Some("antigravity"));
        assert!(agy.bars.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn agy_print_table_is_remaining_quota() {
        let piped = "\
Gemini Models\tWeekly Limit Remaining\t75%\t2026-10-17T09:32:43Z
Gemini Models\tFive Hour Limit Remaining\t86%\t2026-10-11T23:25:06Z
Claude and GPT models\tWeekly Limit Remaining\t49%\t2026-10-17T09:29:22Z
Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-11T23:53:32Z
";
        let usage = parse_agy_print(piped).unwrap();
        assert_eq!(usage.cli.as_deref(), Some("antigravity"));
        assert_eq!(usage.bars.len(), 4);
        assert_eq!(usage.bars[0].group.as_deref(), Some("Gemini"));
        assert_eq!(usage.bars[0].label, "Weekly");
        assert_eq!(usage.bars[0].percent, 75.0);
        assert_eq!(usage.bars[0].direction, UsageDirection::Remaining);
        assert_eq!(
            usage.bars[0].resets_at_ms,
            parse_rfc3339_ms("2026-10-17T09:32:43Z")
        );
        assert_eq!(usage.bars[1].label, "5 hour");
        assert_eq!(usage.bars[1].percent, 86.0);
        assert_eq!(usage.bars[3].group.as_deref(), Some("Claude"));
        assert_eq!(usage.bars[3].percent, 100.0);

        let pretty = "\
Quota:
Gemini Models          Weekly Limit Remaining     75%   2026-10-17 02:32 PDT
Gemini Models          Five Hour Limit Remaining  86%   2026-10-11 16:25 PDT
Claude and GPT models  Weekly Limit Remaining     49%   2026-10-17 02:29 PDT
Claude and GPT models  Five Hour Limit Remaining  100%  2026-10-11 16:48 PDT
";
        let usage = parse_agy_print(pretty).unwrap();
        assert_eq!(usage.bars[0].percent, 75.0);
        assert_eq!(
            usage.bars[0].resets_at_ms,
            parse_rfc3339_ms("2026-10-17T09:32:00Z")
        );
        assert_eq!(
            usage.bars[1].resets_at_ms,
            parse_rfc3339_ms("2026-10-11T23:25:00Z")
        );
        assert_eq!(usage.bars[2].group.as_deref(), Some("Claude"));
        assert_eq!(usage.bars[2].percent, 49.0);
        assert_eq!(
            usage.bars[2].resets_at_ms,
            parse_rfc3339_ms("2026-10-17T09:29:00Z")
        );
        assert_eq!(
            usage.bars[3].resets_at_ms,
            parse_rfc3339_ms("2026-10-11T23:48:00Z")
        );
        assert!(parse_agy_print("just a shell prompt\n%").is_none());
    }

    #[test]
    fn agy_usage_reads_the_saved_choice_or_keeps_default() {
        assert!(valid_agy_minutes(0));
        assert!(valid_agy_minutes(1));
        assert!(valid_agy_minutes(5));
        assert!(valid_agy_minutes(60));
        assert!(!valid_agy_minutes(61));
        assert_eq!(parse_agy_minutes("minutes = 15\n"), Some(15));
        assert_eq!(parse_agy_minutes("minutes = 3\n"), Some(3));
        assert_eq!(parse_agy_minutes("minutes = 0\n"), Some(0));
        assert_eq!(parse_agy_minutes("minutes = 120\n"), None);
        assert_eq!(parse_agy_minutes("nope"), None);
        let dir = scratch("agy-config");
        let path = dir.join("agy-usage.toml");
        write_agy_minutes(&path, 10).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(parse_agy_minutes(&text), Some(10));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_status_bar_polls_llm_usage() {
        let bar = include_str!("../../src/chrome/StatusBar.tsx");
        assert!(bar.contains("status-usage"));
        let app = include_str!("../../src/App.tsx");
        assert!(app.contains("llmUsage"));
        assert!(app.contains("usageCwdRef"));
        assert!(app.contains("usagePidRef"));
        assert!(app.contains("15_000"));
        let lib = include_str!("lib.rs");
        assert!(lib.contains("llm_usage::llm_usage"));
        assert!(lib.contains("init_agy_usage"));
        let menu = include_str!("menu.rs");
        assert!(!menu.contains("Antigravity (Usage Refresh)"));
        assert!(!menu.contains("agy-usage-"));
    }
}
