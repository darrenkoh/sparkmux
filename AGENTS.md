# sparkmux

Desktop app that owns a private tmux server (`-L sparkmux`) and shows tiled real terminals (one xterm.js per pane) via tmux control mode, accompanied by real-time AI session telemetry and interactive 3D Area Maps.

## Architecture

- `crates/sparkmux-core` — argv tmux I/O, snapshot parse, `window_layout` parser, control-mode client (`tmux -C`). **All tmux I/O goes through here.**
- `crates/sparkmux` — thin CLI: `dump`, `version`, `doctor`. Default socket `-L sparkmux`. `--system` is `-L default`.
- `apps/desktop` — Tauri 2 + React UI. Never spawn `tmux` except through core.
  - `src-tauri/src/analytics/`: Incremental transcript follower (`ingest.rs`, `stats.rs`, `storage.rs`, `event.rs`) for Grok Build CLI (`~/.grok`), Claude Code CLI (`~/.claude`), and Antigravity CLI (`~/.gemini/antigravity-cli`). Real-time token analytics (input, output, cache reads/writes, reasoning tokens estimation) and tool code delta tracking (+lines / -lines).
  - `src-tauri/src/artifacts.rs`: Read-only follower for AI agent conversation steps (prompts, thinking, replies, tools, results).
  - `src-tauri/src/helper.rs` / `helper_model.rs`: Local Command Helper model runner (Qwen GGUF).
  - `src/chrome/TerrainViewport.tsx`: WebGL2 interactive 3D Topographical Area Map with organic irregular island coastlines, Gaussian mountain ridges across session channels (User, Think, Reply, Tool), elevation contours, particle fields, and camera controls.
  - `src/chrome/AnalyticsHud.tsx`: Sci-Fi Telemetry HUD with live Neural Cortex synaptogenesis visualization, Actions/Tools matrix, Token Spectrum gauge, Context buffer & TTFT metrics, and filtered Event Stream Log.
  - `src/chrome/PromptGraph.tsx`: Prompt Graph split beside the Area Map. One user prompt as an SVG node flow (adaptive horizontal or vertical), with a scrubber and a live awaiting-input beacon.
  - `src-tauri/src/analytics/prompt_graph.rs`: Read-only prompt segmentation for that graph. It does not ingest; `tab_analytics` already does.
  - `src/chrome/DockedStatsPanel.tsx`: Dockable Area Map panel.

## Product rules

- App owns `-L sparkmux`. Do not list or mutate the user's default server in the GUI.
- Quit detaches the control client; tmux server stays up.
- Named New Session uses `new_session_ex` only — never `ensure_ready` (no leftover `main`).
- Live terminal path is control-mode `%output` / `send-keys -H`. `capture-pane` is seed-only, not polled.
- AI transcript reading is strictly read-only (`ingest.rs`); never modify CLI directories or write into external agent logs.
- No Ratatui TUI. No `portable-pty` attach-session.

## Test

```bash
cargo test --workspace
cargo clippy --workspace -- -D warnings
cargo fmt
pnpm --dir apps/desktop run build
```

MSRV: rustc 1.88+. Targets: `aarch64-apple-darwin`, `aarch64-unknown-linux-gnu`.
