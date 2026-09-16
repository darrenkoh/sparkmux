---
name: sparkmux-core
description: >
  Change sparkmux-core tmux I/O only: TmuxClient, snapshot parse, capture-pane, version, mutations, binary discovery.
  Use when adding a tmux command, fixing list-* parsing, preview, sockets, or any subprocess.
  Triggers: TmuxClient, list-sessions, capture-pane, tmux -V, sparkmux-core, /sparkmux-core.
---

# sparkmux-core

The TUI crate must not spawn `tmux`. Every subprocess goes through `TmuxClient` (`Command` argv tokens, never `sh -c`). User names are separate `-t`/`-s`/`-n`/`--` args so they cannot inject flags.

## Discover

1. `--tmux-bin` / `SPARKMUX_TMUX` / `config.tmux_bin`
2. `$PATH` lookup of `tmux`
3. `/opt/homebrew/bin/tmux`, `/usr/local/bin/tmux`, `/usr/bin/tmux`

Socket: `-S` path wins over `-L` name; pass the chosen one on every command except `tmux -V`.

## list-* formats (`\x1f` delim)

```
list-sessions -F "#{session_id}\x1f#{session_name}\x1f#{session_attached}\x1f#{session_windows}\x1f#{session_created}\x1f#{session_activity}\x1f#{session_path}"
list-windows -a -F "#{session_id}\x1f#{window_id}\x1f#{window_index}\x1f#{window_name}\x1f#{window_active}\x1f#{window_panes}\x1f#{window_layout}"
list-panes -a -F "#{session_id}\x1f#{window_id}\x1f#{pane_id}\x1f#{pane_index}\x1f#{pane_current_command}\x1f#{pane_current_path}\x1f#{pane_pid}\x1f#{pane_active}\x1f#{pane_width}\x1f#{pane_height}\x1f#{pane_title}"
```

Tolerate missing/empty fields. Cursor is `(session_id, Option<window_id>, Option<pane_id>)`; restore by id, else nearest neighbor.

## Preview

`capture-pane -p -e -t PANE_ID`, timeout 300ms, cap last N lines (default 200). On timeout/error keep last good preview or `(no preview)`.

## Mutations

| Action | argv |
|---|---|
| new session | `new-session -d -s NAME` |
| rename session | `rename-session -t ID -- NEW` |
| kill session | `kill-session -t ID` |
| new window | `new-window -t SESSION -n NAME` |
| rename window | `rename-window -t WINDOW -- NAME` |
| kill window | `kill-window -t WINDOW` |
| kill pane | `kill-pane -t PANE` |
| switch (inside) | `switch-client -t SESSION` + `select-window` / `select-pane` |
| attach (outside) | `attach-session -t SESSION` via `CommandExt::exec` |

Version: parse `tmux 3.2`, `3.5a`, `next-3.6`; require ≥ 3.2 for writes.
