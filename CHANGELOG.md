# Changelog

## 0.1.2

### Install

- The curl installer accepts the DMG license agreement. Mounting no longer cancels when the script is piped into bash.
- If tmux is missing or older than 3.2, the installer installs it with Homebrew or apt. `curl | bash` finds Homebrew even when the shell profile was not sourced.
- `tmux next-X.Y` builds count as new enough, the same rule the app uses.

## 0.1.1

### Fixes

- Control mode no longer deadlocks when pane output fills the pipe. New windows and keystrokes finish while a pane is flooding output, including non-UTF-8 bytes.
- `%output` and layout changes that arrive during a command are delivered to the terminal. They are not folded into the command result.
- A stuck tmux server cannot freeze the window. Desktop tmux calls run off the app lock and fail after 5 seconds.

### Security

- Pane, window, and session targets must be a single tmux token. Control commands cannot contain a newline.
- Paste reads the OS clipboard inside the app and sends it to the pane. Clipboard text is not returned to the webview. Copy and paste are capped at 1 MiB.

## 0.1.0

First public desktop release. Sparkmux is a native window that **owns** a private tmux server (`-L sparkmux`) and tiles **real terminals** (xterm.js, one per pane) from `window_layout`.

### App

- Sessions sidebar with resizable, fully collapsible sash
- Window tabs, in-session New Tab, close tab (⌘W / tab ×)
- Unread pip on hidden windows (tmux bell or activity)
- Tiled xterm.js via tmux control mode (`%output` / `send-keys`)
- Native copy/paste (⌘V / Ctrl+Shift+V) through the app, not the WebKit clipboard prompt
- File / Edit / View / tmux / Help menus
- Text size (⌘+/⌘-/⌘0)
- Quit detaches the control client (including macOS ⌘Q and the window close button); **Stop tmux server…** is a confirmed kill
- Missing or too-old tmux is an in-window setup screen, not a crash

### Terminal

- Pane seed from `capture-pane` plus tmux cursor position; live bytes stay on `%output`
- xterm columns match the tmux client, including splits, so zsh does not print a trailing `%` after `ls`
- Resize no longer reseeds the pane (avoids wiping output)

### Install

- `scripts/install.sh` for Apple Silicon macOS and ARM64 Linux
- GitHub Actions builds unsigned `.dmg` / `.app` and `.deb` on `v*` tags
- `sparkmux doctor` prints a setup checklist

### Not in 0.1.0

Notarized Mac builds, Homebrew cask, Windows/x86, bundled tmux, listing the default tmux server in the GUI.
