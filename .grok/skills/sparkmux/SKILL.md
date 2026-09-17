---
name: sparkmux
description: >
  Maintain the sparkmux desktop tmux app (Tauri + tiled xterm.js).
  Use when working on sparkmux, the desktop UI, sidebar, tiled terminals, attach, or shipping v0.
  Triggers: sparkmux, tmux desktop, Tauri tmux, tiled xterm, /sparkmux.
---

# sparkmux desktop

Layout: sidebar (sessions/windows/panes of `-L sparkmux` only) + tiled xterm.js, one per pane of the selected window, geometry from `window_layout`.

## Rules

- Quit = `control_disconnect` (server stays up). Stop server is nested + confirm.
- New Session… = `new_session_ex` only. Never `ensure_ready` on that path.
- Live bytes: control-mode `%output`. `capture-pane` is a one-time seed.
- Linux: no Ctrl+D/W/Q GUI chords.
- tmux I/O: sparkmux-core skill. Do not `Command::new("tmux")` from the desktop crate.
