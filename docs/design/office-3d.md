# 3D Office

| | |
|---|---|
| **Status** | Draft. Haku approves this before any feature code. |
| **Builds on** | Shipped ⌂ Office (`office.rs`, `apps/desktop/src/chrome/office/`). Does not replace it. |
| **Reference** | Attached `office3d-ref` clip. It is a pre-rendered mock: the set is lit until `sleep 8h`, the floors are open slabs, and a click types the bottom prompt. Copy the interaction. Do not copy its numbers. |

A floor is a tmux session. A bot is one Claude Code, Grok Build, or Antigravity pane on `-L sparkmux`. The view reads the snapshot the office already polls. It never invents a bot, a question, a quota, or a schedule.

## 1. Reuse, and the smallest later diff

`agent_office` (`apps/desktop/src-tauri/src/office.rs`) already returns one `OfficeAgent` per agent pane: `session`, `pane_id`, `cli`, `state` (`running` | `needs_user` | `failed` | `succeeded` | `idle`), `activity`, `tool`, `tool_arg`, `ask`, `detail`, `project` (cwd basename), `last_activity_ms`. It calls `attention::label_from_feed` and `pending_question`. SSH panes are skipped. `OfficeView` polls `agentOffice()` every 2s. `office_state` turns `running` into `idle` after 5 minutes without transcript growth (`STALE_MS`).

`attention.rs` emits `NeedsUser`, `Failed`, `Succeeded`, `Running`. The sidebar already shows `window.pending_ask`. That string is display-only on the desktop. There is no reply queue and no stored outbox. The phone answers immediately: `extractQuickOptions` in `apps/desktop/src/ios/quickReplyLogic.ts`, then `paneWrite` → `pane_write` → `send_keys_raw`. The shipped office click only navigates (`onSelectAgent`). Inline [y]/[n] reuses the phone write path, and only while `state == needs_user`.

Usage that exists, and what it measures:

- `tab_analytics` → `TabAnalyticsStats`: tokens and tool counts for one transcript. Not a share of a weekly cap.
- `llm_usage`: account allowance for a CLI family. Grok's weekly used percent comes from `~/.grok/logs/unified.jsonl`. Antigravity comes from periodic `agy --print /usage`. Claude subscription bars stay empty unless a local payload is parsed; a Bedrock pane carries session USD from `bedrock_cost` instead of a percent.

`three` 0.186.1 already drives `OfficeStage.ts` (orthographic room, humanoid avatars, day/evening/night) and Chronicle, inside the Tauri webview. The CLI is `dump | version | doctor | serve` and has no channel into the open window.

Smallest code diff, after approval: a sibling view under `apps/desktop/src/chrome/office3d/` that consumes `OfficeAgent[]`, plus a control on the existing office so `telemetry.rs` status-bar strings stay untouched. No Rust, no new dependency, no sim data on the shipping path.

## 2. Visual signal → real signal

| Demo | Sparkmux | Now |
|---|---|---|
| Green ring, bob, `RUN` | `state == running`. Popup text is `activity` + `tool` + `tool_arg`. | Detected. No percent-complete exists, so the panel has no progress bar. |
| Amber ring, `WAIT`, question, [y]/[n] | `needs_user` and `ask`. Buttons from `extractQuickOptions`. `y`/`n` go out through `paneWrite`. | Detected. Desktop office does not write keys; the phone path does. If the ask yields no option, the panel offers "focus terminal" only. |
| Red ring, stuck | `failed` (last assistant text reports failure). | Detected as failed. A tool that never returns becomes `idle` after 5 quiet minutes, not red. A separate hung-tool rule would be new classifier work and is out of the MVP. |
| Red `HOG`, ~5× swell, runs/day, empty runs, share of the weekly limit, `fix --on-change` | No field. | Not detectable. No per-bot cap, no empty-run counter, no cron, no API that reschedules an agent. Do not draw a swell, a fix button, or a percent. |
| `top --by usage` | Account bars from `llm_usage`, or transcript token totals. | Real only with those captions ("Grok weekly used", "tokens this transcript"). Never "this bot used N% of the limit." |
| `done --since 1h` | Agents with `succeeded` and `last_activity_ms` inside the hour. | Partial. There is no stored completion log. The office activity feed exists only while the view is open. |
| `ls floors/`, `ps --team` | Group agents by `session`. Columns: callsign, `state`, `cli`, `activity`. | Real. `counters()` folds `failed` into idle; the floor list must count `failed` itself. Omit a usage column. |
| `cronjob -l` | None. | Omit. |
| `sleep 8h` | Night preset already implemented on `OfficeStage`. | Lighting only. It does not sleep the Mac or the agents, and the `8h` is not a timer. |

`succeeded` and `idle` are still bots: they sit at the desk with no alarm ring. Header counts may include them. They are not `RUN`.

## 3. What a floor is

A floor is one tmux session that contains at least one agent pane. The sign is a stable index plus the session name (`01_main`), sessions sorted by name. Desks on that slab are that session's agents. `project` is the desk subtitle. CLI type is the blob accent (`CLI_ACCENT`: claude / grok / antigravity), not a floor. Sessions made only of shells are omitted. SSH panes stay omitted. Callsigns stay the client-side names in `officeModel.ts` (`sparkmux.office.names`).

## 4. Renderer and commands

Stay on three.js in the existing webview. A new stage builds open slabs and glossy blobs (sphere, teardrop, star, icosahedron) with procedural geometry, an orthographic camera, and HTML glass panels. SceneKit or RealityKit would be a second, macOS-only renderer and would miss Linux (`aarch64-unknown-linux-gnu`), macos-15's shared web build, and `sparkmux serve`. WKWebView will not match the mock's studio lighting. A few physical-material blobs will. Night uses the existing preset and a small set of lights, not one lamp per desk.

The prompt is a bar in the view, not `sparkmux office --explode`. Parsed locally, unmatched text does nothing and never reaches a pane:

- `explode` — lift the slabs apart on Y.
- `open <callsign>` and `watch <callsign>` — ease the camera, bot left of center so the panel fits. Click does the same.
- `y` / `n` — only for the open bot, and only when it is `needs_user` and the option was parsed from `ask`.
- `night` — the night light preset.

## 5. Phases, tests, risks

**MVP.** Stacked session floors, one blob per agent, bob while `running`, rings for `running` / `needs_user` / `failed`, explode, click and `open` zoom, panel with the tool line or the ask plus [y]/[n]. Idle and succeeded sit quiet.

**Later, still only real fields.** Floor counts, team list, succeeded-within-the-hour list, night preset, one account meter captioned with the CLI family. `HOG`, empty runs, cron, and `fix --on-change` wait until a real signal exists.

**Tests.** Pure functions beside `officeModel.test.ts`: ring for each `state`, session grouping, command parse, reply bytes only for `needs_user`. No sim mode on this view (the old office's `?sim=1` stays there). Rust is unchanged if the MVP stays in TypeScript. Manual check on macos-15: one real waiting pane, answer [y], confirm those bytes hit that pane and the ring leaves amber when the transcript moves.

**Risks.** `paneWrite` types into the live pane; the `needs_user` gate is what keeps a stray `y` off a shell. Two scenes will drift if they fork `office.rs` — share the snapshot and `officeTypes`. A quota painted on a bot will be read as that bot's fault. `telemetry.rs` locks status-bar copy and the `.status` CSS block; add the entry inside the office, not by editing that block. Per-desk lights are the likely WebKit cost. The mock's 152 bots is not a target.
