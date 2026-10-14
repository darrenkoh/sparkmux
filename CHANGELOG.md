# Changelog

## 0.1.41

### Improvements

- The Gits header wraps onto extra rows instead of scrolling sideways.
- Canvas layout modes are a dropdown: Grid, Pipeline, Modules, Impact, and Radial.

## 0.1.40

### Bug Fixes

- Restored Claude Code LLM usage and cost tracking for sessions running on AWS Bedrock. Enhanced multi-signal detection across Claude settings files, transcripts with AWS Bedrock model IDs, environment flags, and Unicode terminal title variations.

## 0.1.39

### Improvements

- The Gits screen fills the window the same way Stats does. Canvas and Chronicle cover the viewport. Close stays on the header and Escape.

## 0.1.38

### Improvements

- Token Spectrum contour and burst fold a quiet stretch longer than five minutes into a short seam labeled with the real duration, such as +2h. A column stays in place when it has tokens or an event. Clock labels stay on wall-clock time.

## 0.1.37

### Improvements

- Redesigned Chronicle in the Gits screen as a pure 2D Sci-Fi Timeline & Diff Studio:
  - Top horizontal scrubbable Cybernetic Revision Deck with revision counters, tool badges, file extension tags, and real-time churn metrics (+add / −del).
  - Split studio workspace with an Intel Sidebar featuring file path, execution status, proportional churn ratio meter, and clickable Diff Hunk index to jump directly to code lines.
  - Native DOM code viewer with dual line numbers (`old-ln` / `new-ln`), diff syntax highlighting, search/filter input, and one-click clipboard copy.

## 0.1.36

### Improvements

- The Area Map folds a quiet stretch longer than five minutes into a short seam labeled with the real duration, such as +2h. Activity on either side keeps its spacing. The time window and scrubber follow that compressed axis.
- Chronicle in the Gits screen draws the session's edits as a 3D topographical relief. Click a peak to open that file. A timeline scrubber plays through the session, and the hologram panel shows the diff.

## 0.1.35

### Bug Fixes

- Clicking [Dashboard] in a Grok Build session still works after switching tabs. The terminal keeps the mouse tracking Grok already turned on.

## 0.1.34

### Bug Fixes

- Fixed UI freezing when switching to a tab running Antigravity. Antigravity usage quota is now fetched asynchronously in a background thread and cached without blocking the main UI thread or tab switching.

## 0.1.33

### Improvements

- The status bar shows Bedrock API cost for the focused Claude conversation and for today when that Claude process is using Bedrock. The chip uses Claude's recorded cost, or an estimate from token rates when Claude recorded no price. There is no quota meter. Subscription Claude is unchanged.

## 0.1.32

### Improvements

- Added support for text search across changed files in the Gits screen, reusing the file search input field:
  - **Unified search**: typing a query instantly filters for matching file paths, repository clusters, and text content within the files.
  - **Quick Scope Toggle**: added a header button (`⚡ DIFF` / `📄 FULL`) to toggle between searching only changed diff lines (additions/deletions) and searching full working copy file contents.
  - **Graph Card Badges**: cards with matching text display an amber match count badge (e.g. `⌕ 3`) and border glow.
  - **Diff Highlighting**: matching occurrences are highlighted in yellow (`<mark>`) in both Unified Diff and Split Diff views, with an active match badge in the diff header.

## 0.1.31

### Improvements

- Enhanced the Gits screen with screen real-estate adaptive card organization and added 5 selectable organization modes:
  - **Auto-Fit Grid**: Responsive balanced matrix optimizing space usage based on current viewport dimensions.
  - **Pipeline**: Git change lifecycle stages (Agent Edits, Modified, Added, Other) rendered in structured Kanban columns with headers and counts.
  - **Modules**: Architectural subsystem clusters grouped by directory hierarchy with folder badges.
  - **Impact**: Churn magnitude waterfall prioritized by lines delta and AI agent edit weights.
  - **Radial**: Sci-fi constellation layout orbiting radiating rings with SVG guides.
- Added a one-click **AUTO FIT** button to recalculate card positions and camera framing to fit the available screen.
- Added smooth positional transitions when toggling between card organization modes.
- Added a dedicated **Vertical Zoom Dial** widget with graduated tick marks (35% to 200%), interactive drag physics, zoom steppers, quick 1:1 reset, and Auto-Fit buttons.
- Replaced mouse wheel zooming with multi-touch pinch-to-zoom (trackpad pinch, touchscreen gestures, WebKit native gestures) and repurposed regular mouse wheel / swipe gestures to smoothly pan the workspace.

## 0.1.30

### Improvements

- In the Gits screen, clicking a file card now displays an inline, resizable 50% split-pane git diff viewer instead of a floating popup inspector card or modal dialog.
- Added a draggable vertical splitter between the 2D graph canvas and the git changes panel, supporting double-click to reset back to 50%.
- Added support for both Unified and synchronized Side-by-Side diff viewing modes with a header toggle.
- Integrated file details, line deltas, and quick-jump connected chain links directly into the diff panel header.

## 0.1.29

### Fixes

- Fixed lines added and removed count discrepancy in the Gits screen when viewing committed files (aligned card metrics and file inspector with git commit numstat).
- Added additions and deletions badge (`+added` / `-removed`) in the Git Changes diff viewer header.
- Improved diff viewer responsiveness and added commit details banner for clean working tree files.

## 0.1.28

### Improvements

- The Graph button is now **Gits**. In the Gits screen, select a card and choose View Git Changes, or press `diff` beside a connected file, to open a diff view for that file with line numbers and colored additions and deletions. `Esc` closes it.

### Fixes

- Fixed the same file appearing twice in the Gits screen (e.g. `lib.rs` and `"lib.rs"`) when an agent transcript stored the path wrapped in quotes.

## 0.1.27

### Fixes

- Fixed 3D CONTOUR mode in Section 04 (TOKEN SPECTRUM) where the time-axis laser scanning line was moving slower than the ridge crest nodes; unified sweep velocity and synchronized the scanning line with the crest node pulses in lockstep across all channels.

## 0.1.26

### Improvements

- Agent Logs and the Event Stream Log open to the full text of each entry. A tool call shows every argument, and a tool result keeps the rest of the output.
- A Claude turn in the event stream shows how long the turn took and how many messages it contained.

### Fixes

- Claude thinking blocks that have no text no longer appear as empty THINK rows.

## 0.1.25

### Improvements

- Accurate EST. COST calculation aligned with Claude Code `/usage` breakdown.
- Added tiered pricing for Claude Haiku (3.5, 4.5, 5.5), Sonnet (3.5, 3.7, 4.x, 5, 5.5), Opus (4.0, 4.1, 4.5–5, 5.5), Grok, and Gemini models.
- Support prompt cache creation (write) token accounting across model stats and telemetry.
- Multi-model cost estimation calculates precise aggregate totals across all models used in a session.

### Fixes

- Fixed Claude fresh input tokens double-counting cache read and write tokens in usage events.

## 0.1.24

### Improvements

- Support Claude Code running via Amazon Bedrock, custom wrappers, and modern Bun/Node runtime layouts.
- Enhance CLI detection across title spinner symbols (e.g. `✳ Claude Code`) and live process trees.
- Automatically bind active Claude Code conversation transcripts during turn pauses when no open file descriptors are held.

### Fixes

- Fixed Agent Logs showing "This pane is not running Grok, Claude, or Antigravity" when Claude Code runs via Amazon Bedrock or with title spinner prefixes.

## 0.1.23

### Improvements

- 3D Area Map GLOBE mode bounds and camera framing: dynamic timeline scrubbing extent adapts seamlessly to spherical and rectangular geometry without edge truncation.
- Base grid and perimeter ring are preserved continuously during timeline playback.
- Interactive milestone hit testing and 3D axis coordinates dynamically scale to active base geometry.

### Fixes

- Fixed East / right-side clipping in 3D Area Map GLOBE mode caused by hardcoded rectangular timeline clipping boundaries.
- Adjusted camera framing and double-click reset distance in GLOBE mode so the spherical dome remains fully in view without edge cutoff.

## 0.1.22

### Improvements

- Stats Token Spectrum features a 3D isometric 45° perspective relief mode with interactive orbital rotation and altitude iso-contours alongside Contour, Burst Velocity, and Gauge views.
- 3D Area Map and Neural Cortex Telemetry feature dense multi-tiered topographical contours, bio-neural connectome network firing, and custom base geometries (Island, Chamfer, Rect, Globe).
- Telemetry telemetry HUD displays real-time cache efficiency metrics, input/output/reasoning token breakdown, code line deltas, and session-scoped cost estimates.
- Status bar displays live Antigravity quota and Grok weekly allowance reset countdowns.

### Fixes

- Stats hover popups properly dismiss when switching modes or moving the cursor away.
- Fixed canvas sizing and auto-rotation smoothness when docking or expanding panels.
- Agent log scroll position is preserved when new streaming steps arrive.

## 0.1.21

### Improvements

- Output and Stats follow Google Antigravity the same way they follow Grok and Claude. The panel shows the prompt, thinking, the planner reply, and each tool call. Stats counts those steps, and token totals only when the transcript records them.
- Output stays on the newest reply. Auto scroll can be turned off, and scrolling up pauses it. You, Thinking, Assistant, tools, and results each have their own color. Each tab keeps its own transcript.
- Stats records the session and shows activity, tokens, tools, and a terrain map of the transcript.
- The mouse wheel scrolls a program that is using the alternate screen.

## 0.1.20

### Improvements

- Output, on the status bar, shows Grok and Claude replies beside the terminal. Collapse hides the panel. Clear hides what it has already shown. The terminal keeps running.

## 0.1.19

### Fixes

- Scrolling up while Grok Build is running shows the earlier console output. The scrollbar and composer stay on the alternate screen.

## 0.1.18

### Improvements

- Dropping a file or folder on a console pastes its path into the prompt. The prompt is not submitted.
- The bottom panel shows the Command Helper model, and Sparkmux memory and CPU use. Sparkmux Help shows the same figures.

## 0.1.17

### Fixes

- Ask stays on the bottom panel after Command Helper is turned on.
- A content search looks for the word itself, not the quotes around it.

## 0.1.16

### Improvements

- Command Helper can be turned on from the Sparkmux menu. It downloads a local model once from GitHub.
- Ask, on the right of the bottom panel, takes a plain-language request and inserts one shell command. You run it. It is offered only at a normal shell.

## 0.1.15

### Improvements

- A notice appears when a newer Sparkmux release is available. Update Now installs it and relaunches the app.

## 0.1.14

### Fixes

- With text already in the console prompt, scrolling up to select earlier output stays on that text.

## 0.1.13

### Fixes

- After the app restarts, opening a session tab can scroll up through the console output that was already there.

## 0.1.12

### Fixes

- Clicking an http or https link in the session console opens it in the default browser.

## 0.1.11

### Improvements

- Removed the light blue focus border around the console terminal pane.

## 0.1.10

### Fixes

- Terminal character alignment and cursor positions are preserved during relative cursor indexing. Bare line feeds no longer force the cursor column to zero, preventing CLI tools such as Antigravity (`agy`) from corrupting prompts or cutting off characters when rendering interactive slash menus.
- Unicode 11 addon is enabled in xterm.js for accurate emoji, wide-character, and symbol measuring.
- Control client and GUI spawn environments enforce UTF-8 mode (`tmux -u`, `LANG=en_US.UTF-8`, `COLORTERM=truecolor`).

## 0.1.9

### Fixes

- Console rendering and caret alignment no longer desync when switching sessions. Screen dumps use explicit row positioning to prevent buffer scrolling on wrapped or full-height lines, cursor queries use the control client directly without subprocess timeouts, and session window layouts are preserved during client switch.

## 0.1.8

### Fixes

- Switching sessions and clicking the console keeps the terminal caret aligned with the prompt. Full-height seed dumps no longer scroll the buffer by a row, and the caret resyncs with tmux on focus and mouse click.

## 0.1.7

### Fixes

- Resizing the window no longer leaves the terminal caret on the wrong cell. It follows tmux again without needing a keypress.

## 0.1.6

### Fixes

- Characters stay intact while Grok or Claude is streaming. A character split across two pane updates is drawn whole instead of being replaced.

## 0.1.5

### Fixes

- Choice lists from Grok and Claude stay in order. The terminal no longer types a second cursor or size reply into the pane, and the tmux status line no longer shortens the pane by a row.

## 0.1.4

### Fixes

- Opening a session works when tmux splits the list format on a tab. The session id and name are separated with a printable token, and a plain `name: N windows` line is accepted.

## 0.1.3

### Fixes

- Opening the app no longer stays on “Connecting…” when a session list line has no name. Those lines are ignored, and a failed attach stays on screen with Retry instead of repeating the error.

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
