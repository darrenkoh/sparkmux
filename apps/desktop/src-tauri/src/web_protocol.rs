//! Token check, session cookie, and binary terminal frames for `sparkmux serve`.
//! The HTTP server and the WebSocket pump call these functions. Tests call them too.

use subtle::ConstantTimeEq;

pub const FRAME_SEED: u8 = 0x01;
pub const FRAME_OUTPUT: u8 = 0x02;
pub const FRAME_WRITE: u8 = 0x03;
pub const SESSION_COOKIE: &str = "sparkmux_session";
pub const SESSION_MAX_AGE: u32 = 2_592_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TermFrame {
    pub kind: u8,
    pub pane_id: String,
    pub payload: Vec<u8>,
}

/// Compare two tokens without leaking the matching prefix through an early return.
pub fn tokens_match(provided: &str, expected: &str) -> bool {
    let a = provided.as_bytes();
    let b = expected.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

pub fn request_is_authenticated(
    cookie_header: Option<&str>,
    query_token: Option<&str>,
    expected: &str,
) -> bool {
    if expected.is_empty() {
        return false;
    }
    if let Some(token) = query_token {
        if tokens_match(token, expected) {
            return true;
        }
    }
    let Some(header) = cookie_header else {
        return false;
    };
    for part in header.split(';') {
        let trimmed = part.trim();
        if let Some(value) = trimmed.strip_prefix("sparkmux_session=") {
            if tokens_match(value, expected) {
                return true;
            }
        }
    }
    false
}

pub fn session_set_cookie(token: &str) -> String {
    format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_MAX_AGE}"
    )
}

pub fn encode_frame(kind: u8, pane_id: &str, payload: &[u8]) -> Result<Vec<u8>, String> {
    let id = pane_id.as_bytes();
    if id.is_empty() || id.len() > 255 {
        return Err("pane id length is out of range".into());
    }
    if !matches!(kind, FRAME_SEED | FRAME_OUTPUT | FRAME_WRITE) {
        return Err("unknown frame type".into());
    }
    let mut frame = Vec::with_capacity(2 + id.len() + payload.len());
    frame.push(kind);
    frame.push(id.len() as u8);
    frame.extend_from_slice(id);
    frame.extend_from_slice(payload);
    Ok(frame)
}

pub fn decode_frame(bytes: &[u8]) -> Option<TermFrame> {
    if bytes.len() < 2 {
        return None;
    }
    let kind = bytes[0];
    if !matches!(kind, FRAME_SEED | FRAME_OUTPUT | FRAME_WRITE) {
        return None;
    }
    let id_len = bytes[1] as usize;
    if id_len == 0 || bytes.len() < 2 + id_len {
        return None;
    }
    let pane_id = std::str::from_utf8(&bytes[2..2 + id_len]).ok()?.to_string();
    let payload = bytes[2 + id_len..].to_vec();
    Some(TermFrame {
        kind,
        pane_id,
        payload,
    })
}

pub fn pairing_url(bind: &str, port: u16, token: &str) -> String {
    let host = if bind == "0.0.0.0" || bind == "::" || bind.is_empty() {
        "127.0.0.1"
    } else {
        bind
    };
    format!("http://{host}:{port}/?token={token}")
}

/// Primary pairing URL, plus each extra address when the bind is every interface.
pub fn collect_pairing_urls(
    bind: &str,
    port: u16,
    token: &str,
    extra_ips: &[String],
) -> Vec<String> {
    let mut urls = vec![pairing_url(bind, port, token)];
    if bind == "0.0.0.0" || bind == "::" {
        for ip in extra_ips {
            let url = pairing_url(ip, port, token);
            if !urls.contains(&url) {
                urls.push(url);
            }
        }
    }
    urls
}

/// Address an iPhone can open. Prefers Wi-Fi, then other private networks, then Tailscale.
pub fn phone_scan_url(urls: &[String]) -> Option<&str> {
    urls.iter()
        .min_by_key(|url| scan_rank(pairing_host(url)))
        .map(String::as_str)
}

fn pairing_host(url: &str) -> &str {
    let rest = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let hostport = rest.split(['/', '?']).next().unwrap_or(rest);
    if let Some(host) = hostport.strip_prefix('[') {
        return host.split(']').next().unwrap_or(host);
    }
    hostport.split(':').next().unwrap_or(hostport)
}

fn scan_rank(host: &str) -> u8 {
    let Ok(ip) = host.parse::<std::net::Ipv4Addr>() else {
        return 5;
    };
    if ip.is_loopback() {
        return 9;
    }
    if ip.is_link_local() {
        return 8;
    }
    let [a, b, _, _] = ip.octets();
    if a == 192 && b == 168 {
        return 0;
    }
    if a == 10 {
        return 1;
    }
    if a == 100 && (b & 0xc0) == 64 {
        return 2;
    }
    if a == 172 && (16..=31).contains(&b) {
        return 3;
    }
    4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_accepts_query_token_and_cookie_and_rejects_a_mismatch() {
        let expected = "abc123token";
        assert!(request_is_authenticated(None, Some(expected), expected));
        assert!(request_is_authenticated(
            Some("other=1; sparkmux_session=abc123token"),
            None,
            expected
        ));
        assert!(request_is_authenticated(
            Some("sparkmux_session=abc123token"),
            Some("wrong-token"),
            expected
        ));
        assert!(!request_is_authenticated(
            None,
            Some("wrong-token"),
            expected
        ));
        assert!(!request_is_authenticated(None, None, expected));
        assert!(!request_is_authenticated(
            Some("sparkmux_session=nope"),
            None,
            expected
        ));
    }

    #[test]
    fn pairing_urls_use_loopback_for_the_wildcard_and_keep_lan_addresses() {
        let urls = collect_pairing_urls("0.0.0.0", 7420, "tok", &["10.0.0.8".into()]);
        assert_eq!(
            urls,
            vec![
                "http://127.0.0.1:7420/?token=tok".to_string(),
                "http://10.0.0.8:7420/?token=tok".to_string(),
            ]
        );
        let local = collect_pairing_urls("127.0.0.1", 7420, "tok", &["10.0.0.8".into()]);
        assert_eq!(local, vec!["http://127.0.0.1:7420/?token=tok".to_string()]);
    }

    #[test]
    fn the_scan_url_prefers_wifi_over_docker_tailscale_and_loopback() {
        let urls = vec![
            "http://127.0.0.1:7420/?token=tok".to_string(),
            "http://172.17.0.1:7420/?token=tok".to_string(),
            "http://100.64.1.2:7420/?token=tok".to_string(),
            "http://192.168.1.20:7420/?token=tok".to_string(),
        ];
        assert_eq!(
            phone_scan_url(&urls),
            Some("http://192.168.1.20:7420/?token=tok")
        );
        let remote = vec![
            "http://127.0.0.1:7420/?token=tok".to_string(),
            "http://100.64.1.2:7420/?token=tok".to_string(),
        ];
        assert_eq!(
            phone_scan_url(&remote),
            Some("http://100.64.1.2:7420/?token=tok")
        );
        let local = vec!["http://127.0.0.1:7420/?token=tok".to_string()];
        assert_eq!(phone_scan_url(&local), Some(local[0].as_str()));
        assert_eq!(phone_scan_url(&[]), None);
    }

    #[test]
    fn session_cookie_is_http_only_strict_and_thirty_days() {
        let header = session_set_cookie("tok");
        assert!(header.starts_with("sparkmux_session=tok;"));
        assert!(header.contains("HttpOnly"));
        assert!(header.contains("SameSite=Strict"));
        assert!(header.contains("Max-Age=2592000"));
    }

    #[test]
    fn frames_round_trip_for_edge_pane_ids() {
        let payload = b"hello-\x1b[32mterm";
        for pane in ["%0", "%999"] {
            for kind in [FRAME_SEED, FRAME_OUTPUT, FRAME_WRITE] {
                let encoded = encode_frame(kind, pane, payload).unwrap();
                assert_eq!(encoded[0], kind);
                assert_eq!(encoded[1] as usize, pane.len());
                assert_eq!(&encoded[2..2 + pane.len()], pane.as_bytes());
                let decoded = decode_frame(&encoded).unwrap();
                assert_eq!(decoded.kind, kind);
                assert_eq!(decoded.pane_id, pane);
                assert_eq!(decoded.payload, payload);
            }
        }
    }
}
