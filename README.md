# sparkmux

A desktop app that **launches and owns** a private tmux server, then shows **tiled real terminals** — one xterm.js view per pane — laid out from tmux itself.

Works on Apple Silicon macOS and NVIDIA DGX Spark (ARM64 Ubuntu 24.04). Requires **tmux 3.2+**.

Your default tmux server is never touched. sparkmux uses `-L sparkmux`.

## Install

CLI:

```bash
cargo install --path crates/sparkmux
```

Desktop (from a clone):

```bash
cd apps/desktop
npm install
cd ../..
cargo tauri dev --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Release binary for the CLI is `target/release/sparkmux`. The desktop crate is `sparkmux-desktop` (`Sparkmux.app` / Linux `sparkmux-desktop`).

## CLI

```bash
sparkmux                 # usage (exit 2) — the TUI is gone
sparkmux dump            # session tree JSON on -L sparkmux (starts default session if empty)
sparkmux version         # sparkmux + detected tmux
sparkmux doctor          # binary, socket path, sessions
sparkmux --system dump   # user's default tmux server
sparkmux -L other dump
```

Flag > env (`SPARKMUX_TMUX`) > config file > default.

## Desktop

- Sidebar: sessions / windows / panes of `-L sparkmux` only.
- Main: tiled xterm.js matching `window_layout`. Typing goes to the focused pane.
- File → New Session… creates that name only (does not also create `main`).
- tmux → Stop tmux server… asks for confirm, then `kill-server`.
- Quit detaches; the tmux server keeps running. Reopen the app to reconnect.
- Attach from a real terminal: `tmux -L sparkmux attach`

Missing tmux: in-window error with `brew install tmux` / `sudo apt install tmux`.

## Config

- Linux: `~/.config/sparkmux/config.toml`
- macOS: `~/Library/Application Support/sparkmux/config.toml`

```toml
tmux_bin = ""
socket_name = "sparkmux"
refresh_ms = 1000
default_session = "main"
```

## v0 non-goals

Notarized Mac builds, Homebrew cask, Windows/x86, listing the default tmux server in the GUI, Ratatui TUI, Electron, bundled tmux, prefix-key emulation, SSH fleet manager.

## License

MIT. Copyright (c) 2026 Darren Koh.
