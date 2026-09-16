use crate::error::{Error, Result};

pub const MIN_MAJOR: u32 = 3;
pub const MIN_MINOR: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxVersion {
    pub major: u32,
    pub minor: u32,
    pub raw: String,
}

impl TmuxVersion {
    pub fn is_supported(&self) -> bool {
        self.major > MIN_MAJOR || (self.major == MIN_MAJOR && self.minor >= MIN_MINOR)
    }
}

/// Parse `tmux -V` output (`tmux 3.2`, `tmux 3.5a`, `tmux next-3.6`).
pub fn parse_version(s: &str) -> Result<TmuxVersion> {
    let raw = s.trim().to_string();
    let rest = raw.strip_prefix("tmux").unwrap_or(raw.as_str()).trim();
    let rest = rest.strip_prefix("next-").unwrap_or(rest).trim();

    let mut chars = rest.chars().peekable();
    let mut major = String::new();
    while let Some(c) = chars.peek().copied() {
        if c.is_ascii_digit() {
            major.push(c);
            chars.next();
        } else {
            break;
        }
    }
    if major.is_empty() || chars.next() != Some('.') {
        return Err(Error::Parse(format!("unrecognized tmux version: {raw}")));
    }
    let mut minor = String::new();
    while let Some(c) = chars.peek().copied() {
        if c.is_ascii_digit() {
            minor.push(c);
            chars.next();
        } else {
            break;
        }
    }
    if minor.is_empty() {
        return Err(Error::Parse(format!("unrecognized tmux version: {raw}")));
    }

    let major: u32 = major
        .parse()
        .map_err(|_| Error::Parse(format!("unrecognized tmux version: {raw}")))?;
    let minor: u32 = minor
        .parse()
        .map_err(|_| Error::Parse(format!("unrecognized tmux version: {raw}")))?;

    Ok(TmuxVersion { major, minor, raw })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tmux_3_2() {
        let v = parse_version("tmux 3.2").unwrap();
        assert_eq!(v.major, 3);
        assert_eq!(v.minor, 2);
        assert!(v.is_supported());
    }

    #[test]
    fn parse_tmux_3_5a() {
        let v = parse_version("tmux 3.5a").unwrap();
        assert_eq!((v.major, v.minor), (3, 5));
        assert!(v.is_supported());
    }

    #[test]
    fn parse_tmux_3_7c() {
        let v = parse_version("tmux 3.7c").unwrap();
        assert_eq!((v.major, v.minor), (3, 7));
        assert!(v.is_supported());
    }

    #[test]
    fn parse_tmux_next_3_6() {
        let v = parse_version("tmux next-3.6").unwrap();
        assert_eq!((v.major, v.minor), (3, 6));
        assert!(v.is_supported());
    }

    #[test]
    fn parse_tmux_too_old() {
        let v = parse_version("tmux 3.1a").unwrap();
        assert_eq!((v.major, v.minor), (3, 1));
        assert!(!v.is_supported());
    }
}
