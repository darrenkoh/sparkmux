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
    let Some((maj, min)) = rest.split_once('.') else {
        return Err(Error::Parse(format!("unrecognized tmux version: {raw}")));
    };
    let maj: String = maj.chars().take_while(|c| c.is_ascii_digit()).collect();
    let min: String = min.chars().take_while(|c| c.is_ascii_digit()).collect();
    if maj.is_empty() || min.is_empty() {
        return Err(Error::Parse(format!("unrecognized tmux version: {raw}")));
    }
    let major: u32 = maj
        .parse()
        .map_err(|_| Error::Parse(format!("unrecognized tmux version: {raw}")))?;
    let minor: u32 = min
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

    #[test]
    fn parse_version_rejects_junk() {
        assert!(parse_version("tmux").is_err());
        assert!(parse_version("tmux abc").is_err());
        assert!(parse_version("tmux 3").is_err());
        assert!(parse_version("").is_err());
    }
}
