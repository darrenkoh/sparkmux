# Agent HQ

| | |
|---|---|
| Status | Approved. The MVP in section 6 is implemented. Later phases are not. |
| References | Version A, isometric diorama (`office3d-ref`). Version B, 2D night-shift cross-section (`hq3d-ref`). |
| Bots | Claude Code, Grok Build, and Antigravity panes on the private `-L sparkmux` socket. |

A building view of those live sessions. The blend below is Version B's cross-section and panels, plus Version A's status rings. Anything with no real signal is cut or named as a later phase.

## 1. What already exists, and the smallest diff

The walking office is already shipped: `agent_office` in `office.rs`, polled every 2s by `OfficeView`, drawn with Three.js in `OfficeStage`. One row is one Grok, Claude, or Antigravity pane. SSH panes are skipped. A plain shell is a `FreeDesk`.

Each `OfficeAgent` already carries `state` (`needs_user`, `failed`, `succeeded`, `running`, `idle`), `activity` (`coding`, `terminal`, `reading`, `browsing`, `delegating`, `thinking`, `replying`, `planning`), `tool`, `tool_arg`, `detail`, `ask`, the last six `recent` steps, `cli`, `model`, `project` (cwd basename), `session`, and `window_name`. `office_state` turns a still-running transcript into `idle` after 5 minutes of no mtime change. Needs-user, failed, and succeeded are never demoted.

Those labels come from `attention.rs` `classify_entries`. `pending_question` is the one-line ask. `Window.pending_ask` is cleared while that window is on screen; `OfficeAgent.ask` is not. HQ reads the office field.

The only legal way to type into a pane is `paneWrite` → `pane_write` → `send-keys -H`. Mobile already turns an ask into pills (`extractQuickOptions` / `quickOptionBytes` in `quickReplyLogic.ts`) and writes them. The desktop office and the agent board only select the pane. There is no prompt queue and no launcher. `newSession` / `newWindow` start an empty shell (`new_session_ex` / `new_window_ex`: cwd and env, no command). Recipes insert text and do not press Enter.

`tab_analytics` has context tokens, a timeline, tool errors, subagents, and line counts, for the pane the HUD is following. `llm_usage` is the account allowance for the focused CLI, plus Grok `session_usd` and Bedrock dollars. The repo has no PR, CI, cron, or per-bot share of a weekly limit.

Smallest diff: a new React view that polls `agent_office` and, for a needs-user row, calls the existing pill encoder and `paneWrite`. No new tmux command, no new transcript parser, no change to `OfficeStage`. The walking office stays.

## 2. Signal map

**now** — on `OfficeAgent`, or an existing command. **fan-out** — real, but computed for the focused pane only; HQ would have to call it per pane. **new** — detector we do not have. **cut** — no source; do not draw it.

| Visual | Signal | Verdict |
|---|---|---|
| Green RUN, bobbing | `state=running` | now |
| Head line ("reading…", "coding…") | `activity` + `tool_arg`, the same text as `statusText()` | now |
| Amber WAIT, the question, [y] / [n] / Approve | `needs_user`, `ask`, `extractQuickOptions`, `paneWrite` | now. The missing piece is the desktop button, not a detector |
| Red error | `failed`, from `reports_failure` on the last assistant body | now |
| Red STUCK | none. Silence past 5 minutes is already `idle` | new, deferred. Do not paint idle red |
| Asleep, zZ, translucent | `idle`, and `succeeded` once the task has ended | now. Label it idle. It is not a nap pod |
| Top counts: working / waiting / asleep | `counters()` is working / need-you / idle, and it folds failed into idle. HQ counts failed on its own | now |
| Per-floor run / wait / err | the same states, grouped by session | now |
| Room name | office callsign, else the tmux window name | now |
| Charter ("opens PRs, never merges") | none | cut. Subtitle is `cli · project` |
| Department floors (content, research, ops, finance) | none | cut |
| Task card and step list | `detail`, `recent`, `activity` | now. A step is shown only when that step exists |
| `done --since 1h` | no completion log. `diffFeed` sees transitions only while a view is open. Analytics `TURN` events are timestamped | fan-out for a true last hour. Until then: current `succeeded` rows, plus transitions since the view opened, with that label |
| Context % | Grok: `contextTokensUsed / contextWindowTokens` (256k stand-in until the signal file arrives). Claude: input + cache over a hardcoded `200_000`. Antigravity: last input-token count, window stays 0 | fan-out. Show Grok as recorded. Show Claude and say the 200k is a constant. Hide Antigravity until a window exists. No "saving state → nap pod": we never move or clone a session |
| Weekly limit | Grok `creditUsagePercent` in `~/.grok/logs/unified.jsonl`. Antigravity `agy --print /usage` (weekly and 5h remaining). Claude's parser runs only if a usage file is configured; the live path leaves the bars empty. Bedrock is dollars, not a limit | fan-out. One bar per CLI, never per bot |
| HOG: 5× swell, "% of your limit", empty runs, a suggested fix | nothing attributes the account limit to one pane | cut. A later phase may lamp the floor when that CLI's real weekly bar is high. The bot does not grow |
| `ps --team` name / state | the office row | now. A usage column is session tokens or Grok `session_usd`, labeled as session usage |
| `top --by usage` | the same ledgers | fan-out. Omit the column when the pane has no ledger |
| Prompt Forge, dispatch tube, file-on-desk | no queue. `paneWrite` can deliver text the user just typed | phase 2, and only for a prompt the user wrote. No bot-to-bot tubes: a subagent (`SubagentStat`) stays inside its parent pane and is not a room |
| Launcher (start a CLI from a prompt) | `newWindow`, then `send-keys` of an explicit command. `new_session_ex` cannot take a command | phase 2, after a confirm |
| Hour timeline and playhead | `TabAnalyticsStats.timeline` | fan-out for a last-hour strip pinned to now. A playhead that replays the building is cut |
| Killswitch | `kill_pane` and `kill_session` already live in the session UI | cut. Do not add a second switch |
| `cronjob -l` | none | cut |
| `sleep 8h` / night | office `TimeOfDay` is a lighting preset in localStorage | HQ may reuse the toggle. It does not change agent state, and it is not a sleep command |
| Rocket, PR opened, build shipped | `change_graph` is dirty files and `agent_edited`. `git_history` is local commits. No GitHub PR and no CI | cut. A commit, or the words "pushed to", is not a launch |
| `--explode`, zoom-to-bot | there is no multi-floor scene | cut with Version A's camera. Clicking a room focuses that pane (`jumpToTarget`), which is the real "open" |
| Morning paper | open asks are real. "16 things shipped" is not | phase 2: the asks still waiting, with the same YES/NO pills, plus `succeeded` transitions recorded while the view was open |

## 3. Floor and room

A **room** is one agent pane. A **floor** is one tmux session, which is already the office `Pod`. The user names sessions; that is the only grouping that is both real and chosen. The room subtitle is `cli · project`. CLI stays a color (`CLI_ACCENT`), not a floor.

One session means one floor. HQ does not invent departments. A floor wraps as many rooms as it has agents, rather than Version B's fixed pair. A free desk is a dim shell slot, not an agent. SSH panes stay absent. A subagent is a count on the parent room.

## 4. Recommendation

Ship the blend, closer to B, and smaller than either video.

Take B's static cross-section, left roster, and top counts. Take A's ring: green running, amber needs-user, red failed, plus the ask card. Leave out A's explode, department signs, night command, and HOG monster. Leave out B's nap pods, rocket, charters, killswitch, inter-bot tubes, and the invented newspaper.

The live data is a handful of panes with a five-way label, an activity verb, and an ask string. That fills a 2D section and a roster. It does not fill a 152-bot diorama or a night of scripted handoffs. The walking office already spent the Three.js budget on one room; a second 3D building would duplicate it and still hide the missing signals. B's panels are also the right place for a real reply, and later a real launcher, because the inject path is `paneWrite`.

## 5. Rendering

Stay in the Tauri webview. The UI is React 19, Vite, and `three` 0.186.1 (office and Chronicle), with raw WebGL2 for the area map. There is no SwiftUI, SpriteKit, SceneKit, or RealityKit, and a native view would not run on the Linux target.

Use React DOM and CSS. Floors and rooms are elements. The blob bobs with a CSS animation; idle drops the animation and the opacity. The ring is a border. The panels follow the office side panel. Layout and the state-to-token map are pure functions, tested the way `officeLayout.ts` is. No new dependency.

A canvas, or a new Three.js building, can do tubes, explode, and a swelling bot. Those are the effects this plan cuts, and `OfficeView` already has a WebGL fallback (`webglOk`). Extending `OfficeStage` into stacked floors would keep HQ in 3D for what is really a table of sessions. SpriteKit, SceneKit, and RealityKit would be a second toolkit inside a WKWebView app. None of those for the first cut.

Clicking a room calls the existing `jumpToTarget`. A popout is a new kind beside `office` (`?window=hq`), using the same `open_popout_window` path.

## 6. Phases, tests, risks

**MVP.** `apps/desktop/src/chrome/hq/`. Poll `agentOffice`. Floors, rooms, rings, bob, zZ, the head line, top counts, the roster, and an ask card. Pills call `paneWrite` only when `state === "needs_user"`. Click selects the pane. Empty copy matches the office. No sim mode: office `?sim=1` is fake, and HQ never reads it. No Rust work beyond a popout size arm if that window is added. The status-bar invariants in `telemetry.rs` stay as they are.

**Next.** Fan `tab_analytics` and `llm_usage` out per pane through the existing cursor cache, not a second follower. Context badge under the rules in the table. One account limit bar per CLI. A session-usage column only where a ledger exists. A last-hour strip from real timeline buckets. A local prompt list: confirm, then `newWindow` plus `send-keys` of an explicit CLI command, or a reply into a needs-user pane. A morning card from the open asks and the in-view succeeded feed.

**Only after a real signal exists.** Stuck: the transcript is still fresh, and the last step is a tool with no result for N minutes. That rule must not reuse the 5-minute idle cutoff. A per-bot share of the weekly limit, if a CLI ever writes one. PR or CI, if we add a real GitHub read.

**Tests.** Node tests for layout (group by session, stable order, a single floor, empty, free desks are not agents) and for the visual token map. Running, idle, and failed never produce reply bytes; a needs-user pill's bytes equal `quickOptionBytes`. The context helper returns no percent when `context_window_tokens === 0`. The usage helper will not label an account bar as one pane's share. Existing office, attention, and quick-reply tests stay green. Then `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, and `pnpm --dir apps/desktop run build`.

**Risks.** `prompts_user` treats any `?` as needs-user, so a wrong pill can type into a live TUI. The card shows the ask, and it sends only on a click. Claude's 200k constant is wrong for a larger window, so the badge has to say it is a constant. A Grok weekly percent drawn on a bot would blame one session for the account; the bar stays on the CLI. Polling analytics for every pane, on top of the office's 2s artifact read, can get heavy; the next phase reuses the analytics cache and waits until the MVP is in. Two building views can drift; HQ does not fork the classifier.
