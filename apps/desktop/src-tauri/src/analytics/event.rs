//! One normalized analytics record. Grok and Claude transcripts both reduce to
//! this shape, one JSON object per line in a tab's `events.jsonl`.

use serde::{Deserialize, Serialize};

/// Event kinds. Short strings keep the on-disk lines small.
pub const USER: &str = "user";
pub const THINK: &str = "think";
pub const REPLY: &str = "reply";
pub const TOOL: &str = "tool";
pub const RESULT: &str = "result";
/// A finished tool call with its duration and outcome.
pub const DONE: &str = "done";
/// Token usage for one model call (Claude) or one turn (Grok).
pub const USAGE: &str = "usage";
/// A finished user turn with its wall time.
pub const TURN: &str = "turn";

fn zero(value: &u64) -> bool {
    *value == 0
}

fn no(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Event {
    /// Unix milliseconds.
    pub t: i64,
    pub k: String,
    /// Short transcript id (first 8 chars of the session id or file stem).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub s: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cli: String,
    /// Tool name, or model id on replies and usage.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub n: String,
    /// Tool argument summary: a path, pattern, or command.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub a: String,
    /// Body preview, capped.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub b: String,
    /// Character count of the full body before the cap.
    #[serde(default, skip_serializing_if = "zero")]
    pub c: u64,
    #[serde(default, skip_serializing_if = "zero")]
    pub ms: u64,
    #[serde(default, skip_serializing_if = "no")]
    pub err: bool,
    /// Input tokens.
    #[serde(default, skip_serializing_if = "zero")]
    pub ti: u64,
    /// Output tokens.
    #[serde(default, skip_serializing_if = "zero")]
    pub to: u64,
    /// Cache read tokens.
    #[serde(default, skip_serializing_if = "zero")]
    pub tc: u64,
    /// Cache write tokens.
    #[serde(default, skip_serializing_if = "zero")]
    pub tw: u64,
    /// Reasoning tokens.
    #[serde(default, skip_serializing_if = "zero")]
    pub tr: u64,
}

impl Event {
    pub fn new(t: i64, k: &str) -> Self {
        Self {
            t,
            k: k.to_string(),
            ..Self::default()
        }
    }
}

/// Parses `2026-10-10T08:55:25.349Z`, `2026-10-10T08:56:02.853932+00:00`, and
/// the same without fractions. Returns Unix milliseconds.
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    let text = text.trim();
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = text.get(from..from + len)?;
        if !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let year = num(0, 4)?;
    let month = num(5, 2)?;
    let day = num(8, 2)?;
    let hour = num(11, 2)?;
    let minute = num(14, 2)?;
    let second = num(17, 2)?;
    if bytes[4] != b'-' || bytes[7] != b'-' || !matches!(bytes[10], b'T' | b't' | b' ') {
        return None;
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    let mut idx = 19;
    let mut millis = 0i64;
    if bytes.get(idx) == Some(&b'.') {
        idx += 1;
        let mut digits = 0;
        while let Some(b) = bytes.get(idx) {
            if !b.is_ascii_digit() {
                break;
            }
            if digits < 3 {
                millis = millis * 10 + i64::from(b - b'0');
            }
            digits += 1;
            idx += 1;
        }
        for _ in digits..3 {
            millis *= 10;
        }
    }
    let offset_min = match bytes.get(idx) {
        None | Some(b'Z') | Some(b'z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            let oh = num(idx + 1, 2)?;
            let om = if bytes.get(idx + 3) == Some(&b':') {
                num(idx + 4, 2)?
            } else {
                num(idx + 3, 2).unwrap_or(0)
            };
            let total = oh * 60 + om;
            if *sign == b'+' {
                total
            } else {
                -total
            }
        }
        _ => return None,
    };
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_min * 60;
    Some(secs * 1_000 + millis)
}

/// Howard Hinnant's days-from-civil. Day 0 is 1970-01-01.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_parses_z_offset_and_fractions() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01.5Z"), Some(1_500));
        assert_eq!(
            parse_iso_ms("2026-10-10T08:55:25.349Z"),
            Some(1_791_622_525_349)
        );
        assert_eq!(
            parse_iso_ms("2026-10-10T08:56:02.853932+00:00"),
            Some(1_791_622_562_853)
        );
        assert_eq!(
            parse_iso_ms("2026-10-10T01:56:02-07:00"),
            parse_iso_ms("2026-10-10T08:56:02Z")
        );
        assert_eq!(parse_iso_ms("not a time"), None);
        assert_eq!(parse_iso_ms("2026-13-10T08:56:02Z"), None);
    }

    #[test]
    fn event_lines_skip_empty_fields() {
        let mut event = Event::new(5, TOOL);
        event.n = "grep".into();
        let line = serde_json::to_string(&event).unwrap();
        assert_eq!(line, r#"{"t":5,"k":"tool","n":"grep"}"#);
        let back: Event = serde_json::from_str(&line).unwrap();
        assert_eq!(back, event);
    }
}
