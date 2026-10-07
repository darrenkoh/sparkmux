//! Memory and CPU of this Sparkmux process, plus the command-helper model.
//! The figures stay in the app. Nothing here is sent off the machine.
//!
//! CPU is a percent of one core since the previous sample, so several busy
//! threads can report more than 100.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::helper::{command_helper_loaded, command_helper_status, MODEL_NAME};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AppTelemetry {
    /// Resident memory of this Sparkmux process, in bytes. Zero means the read failed.
    pub memory_bytes: u64,
    /// Absent on the first sample. Later samples are a percent of one core.
    pub cpu_percent: Option<f64>,
    pub helper_enabled: bool,
    pub model_name: String,
    pub model_loaded: bool,
}

struct Tick {
    at: Instant,
    cpu: Duration,
}

static PREV: Mutex<Option<Tick>> = Mutex::new(None);

#[tauri::command]
pub fn app_telemetry() -> AppTelemetry {
    let (memory_bytes, cpu_percent) = sample_process();
    let helper = command_helper_status();
    AppTelemetry {
        memory_bytes,
        cpu_percent,
        helper_enabled: helper.enabled,
        model_name: MODEL_NAME.to_string(),
        model_loaded: helper.enabled && command_helper_loaded(),
    }
}

fn sample_process() -> (u64, Option<f64>) {
    let memory_bytes = resident_bytes();
    let cpu = process_cpu();
    let now = Instant::now();
    let mut prev = PREV.lock().unwrap_or_else(|err| err.into_inner());
    let percent = next_percent(&mut prev, now, cpu);
    (memory_bytes, percent)
}

fn next_percent(prev: &mut Option<Tick>, now: Instant, cpu: Duration) -> Option<f64> {
    let percent = prev.as_ref().map(|old| {
        let wall = now.saturating_duration_since(old.at);
        let used = cpu.saturating_sub(old.cpu);
        cpu_percent(wall, used)
    });
    *prev = Some(Tick { at: now, cpu });
    percent
}

/// `cpu / wall * 100`, rounded to one decimal. Zero wall time is 0.
fn cpu_percent(wall: Duration, cpu: Duration) -> f64 {
    let wall_s = wall.as_secs_f64();
    if wall_s <= 0.0 {
        return 0.0;
    }
    let pct = cpu.as_secs_f64() / wall_s * 100.0;
    if !pct.is_finite() || pct < 0.0 {
        return 0.0;
    }
    (pct * 10.0).round() / 10.0
}

fn process_cpu() -> Duration {
    let mut usage = unsafe { std::mem::zeroed::<libc::rusage>() };
    let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    if rc != 0 {
        return Duration::ZERO;
    }
    timeval_duration(usage.ru_utime).saturating_add(timeval_duration(usage.ru_stime))
}

fn timeval_duration(tv: libc::timeval) -> Duration {
    let secs = u64::try_from(tv.tv_sec).unwrap_or(0);
    let micros = u64::try_from(tv.tv_usec).unwrap_or(0).min(1_000_000);
    Duration::from_secs(secs).saturating_add(Duration::from_micros(micros))
}

fn resident_bytes() -> u64 {
    #[cfg(target_os = "linux")]
    {
        linux_resident_bytes()
    }
    #[cfg(target_os = "macos")]
    {
        macos_resident_bytes()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        0
    }
}

#[cfg(target_os = "linux")]
fn linux_resident_bytes() -> u64 {
    let text = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
    let page = page_size();
    parse_statm_resident(&text, page).unwrap_or(0)
}

#[cfg(target_os = "linux")]
fn page_size() -> u64 {
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    match u64::try_from(page) {
        Ok(n) if n > 0 => n,
        _ => 4096,
    }
}

/// Second field of `/proc/self/statm` is resident pages.
#[cfg(any(test, target_os = "linux"))]
fn parse_statm_resident(text: &str, page_size: u64) -> Option<u64> {
    if page_size == 0 {
        return None;
    }
    let pages = text.split_whitespace().nth(1)?.parse::<u64>().ok()?;
    Some(pages.saturating_mul(page_size))
}

#[cfg(target_os = "macos")]
#[allow(deprecated)] // libc::mach_task_self; mach2 is not otherwise used.
fn macos_resident_bytes() -> u64 {
    // `mach_task_basic_info` is packed. Copy `resident_size` out before reading it.
    let mut info = unsafe { std::mem::zeroed::<libc::mach_task_basic_info>() };
    let mut count = libc::MACH_TASK_BASIC_INFO_COUNT;
    let rc = unsafe {
        libc::task_info(
            libc::mach_task_self(),
            libc::MACH_TASK_BASIC_INFO,
            &mut info as *mut libc::mach_task_basic_info as libc::task_info_t,
            &mut count,
        )
    };
    if rc != libc::KERN_SUCCESS {
        return 0;
    }
    unsafe { std::ptr::addr_of!(info.resident_size).read_unaligned() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_percent_is_one_core_and_rounds_to_a_tenth() {
        assert_eq!(
            cpu_percent(Duration::from_secs(1), Duration::from_millis(250)),
            25.0
        );
        assert_eq!(
            cpu_percent(Duration::from_secs(2), Duration::from_millis(10)),
            0.5
        );
        assert_eq!(cpu_percent(Duration::ZERO, Duration::from_secs(1)), 0.0);
        assert_eq!(cpu_percent(Duration::from_secs(1), Duration::ZERO), 0.0);
        assert_eq!(
            cpu_percent(Duration::from_millis(100), Duration::from_millis(150)),
            150.0
        );
    }

    #[test]
    fn statm_resident_is_the_second_field_times_page_size() {
        assert_eq!(
            parse_statm_resident("123 456 7 8 0 0\n", 4096),
            Some(456 * 4096)
        );
        assert_eq!(parse_statm_resident("", 4096), None);
        assert_eq!(parse_statm_resident("10 20", 0), None);
        assert_eq!(parse_statm_resident("nope", 4096), None);
    }

    #[test]
    fn the_first_sample_has_no_cpu_and_the_next_is_the_delta() {
        let start = Instant::now();
        let mut prev = None;
        assert_eq!(
            next_percent(&mut prev, start, Duration::from_millis(5)),
            None
        );
        let later = start + Duration::from_secs(1);
        assert_eq!(
            next_percent(&mut prev, later, Duration::from_millis(255)),
            Some(25.0)
        );
        assert_eq!(
            next_percent(&mut prev, later, Duration::from_millis(100)),
            Some(0.0)
        );
    }

    #[test]
    fn this_process_has_resident_memory_and_a_cpu_clock() {
        let memory = resident_bytes();
        assert!(memory > 1_000_000, "resident {memory}");
        let before = process_cpu();
        let mut n = 0_u64;
        for i in 0..2_000_000 {
            n = n.wrapping_add(i);
        }
        std::hint::black_box(n);
        let after = process_cpu();
        assert!(after >= before);
    }

    #[test]
    fn telemetry_names_the_command_helper_model() {
        let sample = app_telemetry();
        assert_eq!(sample.model_name, MODEL_NAME);
        assert!(sample.model_name.contains("Qwen2.5-Coder-1.5B-Instruct"));
        assert!(
            sample.memory_bytes > 1_000_000,
            "resident {}",
            sample.memory_bytes
        );
        assert!(sample.cpu_percent.is_none() || sample.cpu_percent.is_some_and(|n| n >= 0.0));
    }

    #[test]
    fn the_status_bar_shows_the_model_and_process_use() {
        let bar = include_str!("../../src/chrome/StatusBar.tsx");
        assert!(bar.contains("Command helper model:"));
        assert!(bar.contains("Sparkmux memory:"));
        assert!(bar.contains("Sparkmux CPU:"));
        let app = include_str!("../../src/App.tsx");
        assert!(app.contains("appTelemetry"));
        assert!(app.contains("formatMemory"));
        assert!(app.contains("formatCpu"));
    }
}
