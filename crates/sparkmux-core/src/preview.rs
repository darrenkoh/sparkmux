/// Keep the last `n` lines of captured pane text.
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

/// Strip CSI/OSC sequences when the TUI cannot render ANSI.
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('[') => {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out
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
    fn strip_ansi_colors() {
        let s = "\u{1b}[32mhi\u{1b}[0m";
        assert_eq!(strip_ansi(s), "hi");
    }
}
