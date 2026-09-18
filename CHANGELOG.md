# Changelog

## 0.1.0

First public desktop release. Sparkmux is a native window that **owns** a private tmux server (`-L sparkmux`) and tiles **real terminals** (xterm.js, one per pane) from `window_layout`.

### App

- Sessions sidebar with resizable, fully collapsible sash
- Window tabs, in-session New Tab, close tab (⌘W / tab ×)
- Tiled xterm.js via tmux control mode (`%output` / `send-keys`)
- File / Edit / View / tmux / Help menus
- Text size (⌘+/⌘-/⌘0)
- Quit detaches; **Stop tmux server…** is a confirmed kill
- Missing or too-old tmux is an in-window setup screen, not a crash

### Install

- `scripts/install.sh` for Apple Silicon macOS and ARM64 Linux
- GitHub Actions builds unsigned `.dmg` / `.app` and `.deb` on `v*` tags
- `sparkmux doctor` prints a setup checklist

### Not in 0.1.0

Notarized Mac builds, Homebrew cask, Windows/x86, bundled tmux, listing the default tmux server in the GUI.
