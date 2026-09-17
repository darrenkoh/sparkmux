---
name: sparkmux-core
description: >
  Change sparkmux-core tmux I/O: TmuxClient, snapshot, control mode, window_layout, mutations.
  Use when adding a tmux command, parsing list-* / %output / layout, or any subprocess.
  Triggers: TmuxClient, ControlClient, list-sessions, window_layout, sparkmux-core, /sparkmux-core.
---

# sparkmux-core

The desktop and CLI must not spawn `tmux` except through this crate. Argv `Command` plus `tmux -C` pipes. Never `sh -c`. `env_remove("TMUX")` / `STY` on the control process.

## Owned socket

Default `-L sparkmux`. `new_owned` fills that in. `--system` / `-L default` is the user's server (CLI only).

`snapshot()` maps `"no sessions"` to an empty tree, not `ServerDown`.

`ensure_ready` (cold start / Start / Retry) may create `config.default_session`. Named New Session is `new_session_ex(name)` only.

## Control mode

`ControlClient::spawn` waits for the handshake `%end` before sending commands. `%output` octal unescape lives in `unescape_output`. Layout: `parse_window_layout`.
