---
name: sparkmux
description: >
  Maintain the sparkmux tmux TUI (Ratatui dashboard for sessions/windows/panes).
  Use when working on sparkmux, the TUI, keybinds, attach/switch, config, preview worker, or shipping v0.
  Triggers: sparkmux, tmux TUI, ratatui tmux, attach-session, switch-client, /sparkmux.
---

# sparkmux TUI

Layout: 3 columns when width ≥ 100 (Sessions | Windows/Panes | Preview); stacked when narrower. Footer: key hints + 4s error toast.

## Keybinds

| Key | Action |
|---|---|
| j/k ↓/↑ | next/prev in focused list |
| h/l ←/→ | collapse/parent/prev panel · expand/child/next panel |
| Tab / S-Tab | cycle Sessions ↔ Windows |
| g/G | first/last |
| Enter | attach or switch, then leave the TUI |
| n | new session (or new window if Windows panel focused) |
| r | rename focused session/window (not pane) |
| d | kill focused session/window/pane |
| Space | expand/collapse window |
| R | force snapshot refresh |
| ? | help overlay |
| q / Ctrl-c / Esc | quit (only when no modal) |

## Attach

- `TMUX` set (inside): `switch-client` + optional `select-window`/`select-pane`, then **quit**. Never `attach-session`.
- Outside: restore terminal, `exec` `tmux attach-session -t SESSION`. Never `switch-client`.
- Decide with `sparkmux_core::decide_attach`. Restore terminal before exec.

## Refresh

Snapshot every 1.0s and after mutations / `R`. Preview every 0.4s for the selected pane only, on a tokio task — UI thread never calls `capture-pane`.

## Empty / old tmux

Missing binary or down server: TUI still starts, sessions pane says start tmux or check `-L`/`-S`. tmux < 3.2: read-only banner; `sparkmux version` exits 2.

## Modals

New/rename: one-line input at the bottom. Esc cancels, Enter commits (reject empty names). Kill: confirm `y`/`n` showing the target name.

Config merge: flag > env > config.toml > default. See `config.rs`.

tmux commands: use the sparkmux-core skill; do not `Command::new("tmux")` from this crate.
