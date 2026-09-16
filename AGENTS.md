# sparkmux

Ratatui dashboard for a live tmux server (sessions / windows / panes / preview / attach). v0 talks to tmux via subprocess `list-*` and `capture-pane`. No web UI, Tauri, plugins, or control mode.

## Crate split

- `crates/sparkmux-core` — discover tmux, snapshot parse, capture-pane, version, mutations. **All tmux I/O goes through here.**
- `crates/sparkmux` — CLI + TUI. Never shells out to `tmux` directly.

Skills: `.grok/skills/sparkmux/SKILL.md` (TUI) and `.grok/skills/sparkmux-core/SKILL.md` (tmux I/O).

## v0 non-goals

Control mode, clipboard, web/Tauri, plugin marketplace, agent badges, layout JSON, GPU/AI crates.

## Test

```bash
cargo test
cargo clippy -- -D warnings
cargo fmt
```

MSRV: rustc 1.88+. Targets: `aarch64-apple-darwin`, `aarch64-unknown-linux-gnu`.
