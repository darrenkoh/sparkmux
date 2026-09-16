# sparkmux

A fast Ratatui dashboard for a live tmux server — sessions, windows, panes, live preview, attach.

Works on Apple Silicon macOS and NVIDIA DGX Spark (ARM64 Ubuntu 24.04).

Requires **tmux 3.2+**.

## Install

```bash
cargo install --path crates/sparkmux
```

Or from a clone:

```bash
git clone https://github.com/darrenkoh/sparkmux
cd sparkmux
cargo install --path crates/sparkmux
```

Build a release binary with `cargo build --release`. The binary is `target/release/sparkmux`.

## Usage

```bash
sparkmux                 # open the TUI
sparkmux dump            # print the session tree as JSON
sparkmux version         # sparkmux + detected tmux version
sparkmux --tmux-bin /opt/homebrew/bin/tmux
sparkmux -L other        # tmux -L
sparkmux -S /tmp/tmux.sock
```

Flag > env (`SPARKMUX_TMUX`) > config file > default.

If `tmux` is missing or the server is down, the TUI still starts and shows an empty/error state.

## Keybinds

| Key | Action |
|---|---|
| `j` / `↓` | next item in focused list |
| `k` / `↑` | prev item |
| `h` / `←` | collapse / parent / prev panel |
| `l` / `→` | expand / child / next panel |
| `Tab` / `Shift-Tab` | cycle panels |
| `g` / `G` | first / last |
| `Enter` | attach or switch to target |
| `n` | new session (or new window if the window panel is focused) |
| `r` | rename focused session/window |
| `d` | kill focused session/window/pane (`y`/`n` confirm) |
| `Space` | expand / collapse window |
| `R` | force refresh |
| `?` | toggle help overlay |
| `q` / `Ctrl-c` / `Esc` (no modal) | quit |

## Attach vs switch

- **Outside tmux:** Enter `exec`s `tmux attach-session` so the TUI does not linger.
- **Inside tmux** (`TMUX` set): Enter runs `switch-client` / `select-window` / `select-pane`, then **quits**. Never `attach-session` from inside.
- `q` / `Esc` always quit without switching.

Popup launch (tmux 3.2+): see [`examples/tmux.conf.snippet`](examples/tmux.conf.snippet).

```tmux
bind-key o display-popup -E -w 90% -h 90% "sparkmux"
```

## Config

Missing file = all defaults. Invalid file: warn and continue.

- Linux (Spark): `~/.config/sparkmux/config.toml`
- macOS: `~/Library/Application Support/sparkmux/config.toml`

```toml
tmux_bin = ""          # empty = PATH
socket_name = ""
refresh_ms = 1000
preview_ms = 400
preview_lines = 200
```

Set `SPARKMUX_LOG=1` to write a log under the platform cache dir.

## Platform notes

| | macOS (Apple Silicon) | DGX Spark (Ubuntu 24.04 ARM) |
|---|---|---|
| tmux | Homebrew `/opt/homebrew/bin/tmux` | apt `/usr/bin/tmux` |
| Config | `~/Library/Application Support/sparkmux/` | `~/.config/sparkmux/` |
| SSH | TUI uses crossterm raw mode + alternate screen | same |

sparkmux also looks for tmux on `PATH`, then `/opt/homebrew/bin/tmux`, `/usr/local/bin/tmux`, `/usr/bin/tmux`.

Clipboard yank is **v1**, not implemented in v0.

## v0 non-goals

- Web UI, Tauri, xterm.js, SSE, tmux control mode (`tmux -C`)
- SSH multi-host fleet manager
- Plugin manager / TPM replacement
- Layout save/restore
- Agent badges, image protocols, markdown preview
- Reimplementing a terminal emulator
- Clipboard backend
- Windows / x86 as a required target

## License

MIT. Copyright (c) 2026 Darren Koh.
