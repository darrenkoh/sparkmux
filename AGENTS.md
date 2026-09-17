# sparkmux

Desktop app that owns a private tmux server (`-L sparkmux`) and shows tiled real terminals (one xterm.js per pane) via tmux control mode.

## Crate split

- `crates/sparkmux-core` — argv tmux I/O, snapshot parse, `window_layout` parser, control-mode client (`tmux -C`). **All tmux I/O goes through here.**
- `crates/sparkmux` — thin CLI: `dump`, `version`, `doctor`. Default socket `-L sparkmux`. `--system` is `-L default`.
- `apps/desktop` — Tauri 2 + React UI. Never spawn `tmux` except through core.

## Product rules

- App owns `-L sparkmux`. Do not list or mutate the user's default server in the GUI.
- Quit detaches the control client; tmux server stays up. Stop server is a confirmed menu action.
- Named New Session uses `new_session_ex` only — never `ensure_ready` (no leftover `main`).
- Live terminal path is control-mode `%output` / `send-keys -H`. `capture-pane` is seed-only, not polled.
- No Ratatui TUI. No `portable-pty` attach-session.

## Test

```bash
cargo test --workspace
cargo clippy --workspace -- -D warnings
cargo fmt
```

MSRV: rustc 1.88+. Targets: `aarch64-apple-darwin`, `aarch64-unknown-linux-gnu`.
