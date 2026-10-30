# sparkmux

Desktop app that owns a private tmux server (`-L sparkmux`) and shows tiled real terminals (one xterm.js per pane) via tmux control mode, accompanied by real-time AI session telemetry, interactive 3D Area Maps, and Git Change Graph / Chronicle explorers.

## Architecture

- `crates/sparkmux-core` — argv tmux I/O, snapshot parse, `window_layout` parser, `pane_seed` scrollback/cursor formatter, read-only `ScreenClient`, and control-mode client (`tmux -C`). **All tmux I/O goes through here.**
- `crates/sparkmux` — thin CLI: `dump`, `version`, `doctor`. Default socket `-L sparkmux`. `--system` is `-L default`.
- `apps/desktop` — Tauri 2 + React 19 UI. Never spawn `tmux` except through core.
  - `src-tauri/src/analytics/`: Incremental transcript follower (`ingest.rs`, `stats.rs`, `storage.rs`, `event.rs`) for Grok Build CLI (`~/.grok`), Claude Code CLI (`~/.claude`), and Antigravity CLI (`~/.gemini/antigravity-cli`). Real-time token analytics (input, output, cache reads/writes, reasoning tokens estimation), subagent tracking, and tool code delta tracking (+lines / -lines).
  - `src-tauri/src/artifacts.rs`: Read-only follower for AI agent conversation steps (prompts, thinking, replies, tools, results).
  - `src-tauri/src/ssh_bind.rs`: SSH remote transcript isolation. An `ssh` foreground command never opens local `~/.grok`, `~/.claude`, or `~/.gemini` trees; remote transcripts are staged read-only into a jailed cache directory.
  - `src-tauri/src/attention.rs`, `notify_attention.rs`, `board_api.rs`, `window_label.rs`: Hidden agent state classifier (`needs_user`, `failed`, `succeeded`, `running`), pending question extraction (`pending_ask`), background notifications, auto-renaming default `shell` tabs to the running CLI version, and Sidebar Agent Board rows.
  - `src-tauri/src/change_graph.rs` & `chronicle.rs`: Multi-repo git change graph, unified/side-by-side diffs, changed-file search, git commit history, and Chronicle transit-map timeline with historical file holograms.
  - `src-tauri/src/llm_usage.rs`, `bedrock_cost.rs`, `telemetry.rs`: Model quota allowance windows, Bedrock USD cost estimation, and Sparkmux process RSS memory & CPU telemetry.
  - `src/chrome/TerrainViewport.tsx` (`globeSensor.ts`, `terrainWindow.ts`, `terrainHud.ts`): WebGL2 interactive 3D Topographical Area Map with `RECT` (Cartesian island ridges) and `GLOBE` (polar channel rings + outward radar ping) modes across session channels (User, Think, Reply, Tool), compressed idle-gap time windows, elevation contours, and 50k particle fields.
  - `src/chrome/AnalyticsHud.tsx` & `DockedStatsPanel.tsx`: Fullscreen and dockable Sci-Fi Telemetry HUD with Neural Cortex synaptogenesis visualization, Actions/Tools matrix, Token Spectrum gauge, Context buffer & TTFT metrics, and filtered Event Stream Log.
  - `src/chrome/ChangeGraph.tsx`, `ChronicleView.tsx`, `GitHistoryView.tsx`: Interactive `⬡ Gits` explorer with Canvas card layouts (`grid`, `pipeline`, `modules`, `impact`, `radial`), Chronicle transit timeline, and Git commit history.
  - `src/chrome/PopoutWindow.tsx` (`popoutModel.ts`): Standalone popout windows (`?window=stats`, `?window=gits`, `?window=office`) synchronized with the active terminal target (`sync_active_target`) with target pinning.
  - `src/chrome/office/` and `src-tauri/src/office.rs`: Isometric Agent Office. Read-only `agent_office` rows for Grok, Claude, and Antigravity panes become avatars, a team list, and an activity feed. SSH panes are skipped.

## Product rules

- App owns `-L sparkmux`. Do not list or mutate the user's default server in the GUI.
- Quit detaches the control client; tmux server stays up.
- Named New Session uses `new_session_ex` only — never `ensure_ready` (no leftover `main`).
- Live terminal path is control-mode `%output` / `send-keys -H`. `capture-pane` is seed-only, not polled.
- AI transcript reading is strictly read-only (`ingest.rs`, `artifacts.rs`, `ssh_bind.rs`); never modify CLI directories or write into external agent logs.
- An `ssh` foreground pane never binds the local host's `~/.grok`, `~/.claude`, or `~/.gemini` directories.
- Preserve status bar and telemetry UI test invariants enforced by `src-tauri/src/telemetry.rs`.
- No Ratatui TUI. No `portable-pty` attach-session.

## Test

```bash
cargo test --workspace
cargo clippy --workspace -- -D warnings
cargo fmt
pnpm --dir apps/desktop run build
```

MSRV: rustc 1.88+. Targets: `aarch64-apple-darwin`, `aarch64-unknown-linux-gnu`.
