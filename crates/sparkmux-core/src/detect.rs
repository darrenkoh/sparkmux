use std::ffi::OsStr;

pub fn is_inside_tmux() -> bool {
    is_inside_tmux_from(std::env::var_os("TMUX"))
}

pub fn is_inside_tmux_from(tmux: Option<impl AsRef<OsStr>>) -> bool {
    tmux.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inside_tmux_when_env_set() {
        assert!(is_inside_tmux_from(Some("/tmp/tmux-501/default,123,0")));
    }

    #[test]
    fn inside_tmux_when_env_missing() {
        assert!(!is_inside_tmux_from(None::<&str>));
    }
}
