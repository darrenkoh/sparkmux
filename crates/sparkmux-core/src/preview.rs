// `str::lines` drops a trailing newline, so this returns at most `n` content lines.
pub fn cap_lines(text: &str, n: usize) -> String {
    if n == 0 {
        return String::new();
    }
    let total = text.lines().count();
    if total <= n {
        return text.to_string();
    }
    text.lines().skip(total - n).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_lines_keeps_tail() {
        let text = "a\nb\nc\nd\n";
        assert_eq!(cap_lines(text, 2), "c\nd");
    }

    #[test]
    fn cap_lines_zero_is_empty() {
        assert_eq!(cap_lines("a\nb", 0), "");
    }

    #[test]
    fn cap_lines_identity_when_short() {
        let text = "a\nb\n";
        assert_eq!(cap_lines(text, 10), text);
    }
}
