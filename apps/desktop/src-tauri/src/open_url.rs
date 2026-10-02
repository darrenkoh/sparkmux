//! Open an http(s) link in the default browser.
//!
//! The terminal webview cannot navigate with `window.open`. Pane output is
//! untrusted, so only http and https URLs with a host and no credentials are
//! handed to the system opener, as one argument and not through a shell.

use std::process::{Command, Stdio};

const MAX_URL_LEN: usize = 8192;

pub fn http_url_to_open(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("link is empty".into());
    }
    if raw.len() > MAX_URL_LEN {
        return Err("link is too long".into());
    }
    // Reject before parsing. The URL parser strips newlines and encodes
    // spaces, which can glue two links into one host.
    if raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("link is not a valid url".into());
    }
    let parsed = url::Url::parse(raw).map_err(|_| "link is not a valid url".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("only http and https links can be opened".into()),
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err("link is missing a host".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("link must not include credentials".into());
    }
    let opened = parsed.as_str();
    if opened.len() > MAX_URL_LEN
        || opened.chars().any(|c| c.is_control() || c.is_whitespace())
        || !(opened.starts_with("http://") || opened.starts_with("https://"))
    {
        return Err("link is not a valid url".into());
    }
    Ok(opened.to_string())
}

#[tauri::command]
pub fn open_http_url(url: String) -> Result<(), String> {
    let url = http_url_to_open(&url)?;
    spawn_opener(&url)
}

fn spawn_opener(url: &str) -> Result<(), String> {
    let mut child = opener_command()?
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not open link: {e}"))?;
    // `open` / `xdg-open` exit after handing the URL off. Reap so a click
    // does not leave a zombie, and do not wait on the UI thread.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn opener_command() -> Result<Command, String> {
    Ok(Command::new("/usr/bin/open"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn opener_command() -> Result<Command, String> {
    Ok(Command::new("xdg-open"))
}

#[cfg(not(unix))]
fn opener_command() -> Result<Command, String> {
    Err("opening links is not supported on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::http_url_to_open;

    #[test]
    fn accepts_http_and_https() {
        assert_eq!(
            http_url_to_open("https://example.com/a/b?q=1#h").unwrap(),
            "https://example.com/a/b?q=1#h"
        );
        assert_eq!(
            http_url_to_open("  http://localhost:3000/docs  ").unwrap(),
            "http://localhost:3000/docs"
        );
        assert_eq!(
            http_url_to_open("HTTPS://Example.COM/Path").unwrap(),
            "https://example.com/Path"
        );
        assert_eq!(
            http_url_to_open("https://[2001:db8::1]/index").unwrap(),
            "https://[2001:db8::1]/index"
        );
    }

    #[test]
    fn rejects_other_schemes_and_credentials() {
        assert!(http_url_to_open("javascript:alert(1)").is_err());
        assert!(http_url_to_open("file:///etc/passwd").is_err());
        assert!(http_url_to_open("data:text/html,hi").is_err());
        assert!(http_url_to_open("ftp://example.com/file").is_err());
        assert!(http_url_to_open("https://user:secret@example.com/").is_err());
        assert!(http_url_to_open("https://user@example.com/").is_err());
        assert!(http_url_to_open("").is_err());
        assert!(http_url_to_open("https://").is_err());
        assert!(http_url_to_open("https://example.com/a b").is_err());
        assert!(http_url_to_open(&format!("https://example.com/{}", "a".repeat(9000))).is_err());
        let slashed = http_url_to_open(r"https://example.com\@evil.com/a").unwrap();
        assert!(slashed.starts_with("https://example.com/"), "{slashed}");
    }

    #[test]
    fn rejects_embedded_whitespace_and_controls() {
        assert!(http_url_to_open("https://example.com/a\nb").is_err());
        assert!(http_url_to_open("https://example.com/a\tb").is_err());
        assert!(http_url_to_open("https://good.example\n.evil.com").is_err());
    }
}
