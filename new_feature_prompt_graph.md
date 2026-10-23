# Feature: Prompt Graph (split view with the 3D Area Map)

> Hand-off spec for an implementing agent. Read `AGENTS.md` first and obey its product rules
> (read-only transcript ingestion, all tmux I/O via core, etc.).

## 1. Summary

Add a **Prompt Graph** panel to the Stats HUD
([AnalyticsHud.tsx](apps/desktop/src/chrome/AnalyticsHud.tsx)). It shares the **3D Area Map's**
space at the top of the center column, **side by side** (Area Map left, Prompt Graph right). It
shows one user prompt's path through the agent as a sci-fi node graph:

```
USER PROMPT → THINK → TOOLS ×7 → THINK → ASK USER (waited 42s) → TOOLS ×3 → REPLY → COMPLETE
                         └─ subagent lane: THINK → TOOLS ×4 → REPLY
```

### Decisions already taken (do not re-litigate)

| # | Decision |
|---|----------|
| D1 | **Placement:** the center-column Area Map slot is split **side by side**: Area Map on the left, Prompt Graph on the right, with a **draggable vertical splitter** (default 50/50). Each half can be **maximized** or **collapsed**. Double-clicking the splitter resets to 50/50. The ratio and collapse state are saved in `localStorage`. The Event Stream Log stays a **pure list** (no GRAPH toggle), and only gains the `ask` styling. The docked mini Area Map (`DockedStatsPanel`) is **unchanged**. |
| D2 | **Scope:** shows the latest prompt by default, plus a **prompt selector/scrubber** to go back to earlier prompts. |
| D3 | **Rendering:** **SVG + CSS**: neon nodes, animated flowing-energy edges, SVG glow filters, existing HUD palette. No new npm dependencies. |
| D4 | **Layout:** **adaptive**. The flow is **horizontal (left → right)** when the graph panel is wider than it is tall (`width > height`), and **vertical (top → bottom)** otherwise. It switches live as the splitter, window, or bottom row is resized. |
| D5 | **Ask detection:** a new backend event kind **`ask`** emitted in `ingest.rs` for ask-type tools, **plus** the live `NeedsUser` attention label for the "waiting now" state. |
| D6 | **Granularity:** consecutive same-kind steps **merge into cluster nodes** (`TOOLS ×7`) that expand on click. Subagent steps (`ev.g` non-empty) go in a **branched side lane**. |
| D7 | **Data:** a new Tauri command **`tab_prompt_graph`** returns the full event list for one prompt from `events.jsonl`, so the graph is not limited by the 60-event `recent_events` cap. |

---

## 2. Existing code to know

| Area | File | Notes |
|------|------|-------|
| Event schema | [event.rs](apps/desktop/src-tauri/src/analytics/event.rs) | `Event { t, k, s, cli, n, a, b, c, ms, err, ti, to, tc, tw, tr, g, h }`. Kinds: `user think reply tool result done usage turn`. |
| Ingest | [ingest.rs](apps/desktop/src-tauri/src/analytics/ingest.rs) | Tool events are emitted in `grok_chat` (~L869), `claude_block` `"tool_use"` arm (~L1207), and `agy_step` (~L1326). |
| Stats | [stats.rs](apps/desktop/src-tauri/src/analytics/stats.rs) | `match ev.k.as_str() { … _ => {} }` (~L220/L337), so unknown kinds are ignored safely. `recent_events` is the last 60 events. |
| Storage | [storage.rs](apps/desktop/src-tauri/src/analytics/storage.rs) | `read_tab_events(session, tab, 0)` returns up to `MAX_TAB_EVENTS = 20_000`. |
| Commands | [mod.rs](apps/desktop/src-tauri/src/analytics/mod.rs) | `tab_analytics` (L117) ingests and reads. It is registered in [lib.rs](apps/desktop/src-tauri/src/lib.rs) L80. |
| TS API | [api.ts](apps/desktop/src/api.ts) ~L471–545 | `TabAnalyticsStats`, `tabAnalytics()`. |
| HUD center | [AnalyticsHud.tsx](apps/desktop/src/chrome/AnalyticsHud.tsx) L1177–1265 | `<main className="scifi-center">` renders `<TerrainViewport …/>` (L1182), then the `.scifi-splitter-h` (L1192), then `.scifi-row` (sections 04/05). **The split goes here.** |
| HUD splitters | AnalyticsHud.tsx L401–503 | Existing drag patterns `onStartDragV` / `onStartDragH` / `onStartDragCenterH`, plus `getInitial*` helpers (L47–86) that read `localStorage` with clamping. Copy this pattern. |
| Area Map | [TerrainViewport.tsx](apps/desktop/src/chrome/TerrainViewport.tsx) L2229 | Root is `<section className="scifi-panel viewport">`. It resizes its canvas from `getBoundingClientRect()` every frame (~L1455), so a narrower container just works. Do not change its internals. |
| HUD log | AnalyticsHud.tsx L1268–1366 | Event Stream Log panel. It polls `tabAnalytics` every 1 s (L534). `eventFilter` state is at L359. |
| CSS | [index.css](apps/desktop/src/index.css) L2634–2654, ~L3588–3740 | `.scifi-center`, `.scifi-center > .scifi-panel.viewport { flex: 1 1 0 }`, `.scifi-splitter-h`, `.scifi-row`; `.scifi-log-item.*`, `.stream-filter-btn`, `.ev-tag.*` palette. |
| Attention | [attentionNotify.ts](apps/desktop/src/chrome/attentionNotify.ts), `commands.rs` L342 | `NoteLabel = "needs_user" \| "failed" \| "succeeded" \| "running"`, carried on window snapshots as `attention_label`. |
| Tests (TS) | e.g. `changeGraphLayout.test.ts` | Uses `node:test` + `node:assert/strict`. Put pure logic in a `*Model.ts` file and test it. |

### Palette (reuse exactly)

| Kind | Color | Node label |
|------|-------|-----------|
| user | `#ff9a3c` | USER PROMPT |
| think | `#c084fc` | THINK |
| reply | `#5b8def` | REPLY |
| tool / done | `#2dd4bf` | TOOL / TOOLS ×N |
| result | `#3dd68c` | (merged into its tool node, not a node of its own) |
| **ask (new)** | **`#f472b6`** | ASK USER |
| turn / complete | `#cbd5e1` | COMPLETE |
| error accent | `#f87171` | red ring / ✕ badge on errored tool nodes |
| usage | `#facc15` | not a node; token totals are shown as node metadata |

---

## 3. Backend changes (Rust)

### 3.1 New event kind `ask`

In `event.rs`:

```rust
/// The agent asked the user a question or for approval (ask-type tool).
/// Emitted next to the matching TOOL event, with the same timestamp.
pub const ASK: &str = "ask";
```

In `ingest.rs`, add a helper:

```rust
/// Tool names that block on the user. Compare case-insensitively.
const ASK_TOOLS: &[&str] = &[
    "askuserquestion",   // Claude Code
    "exitplanmode",      // Claude Code plan approval
    "ask_question",      // Antigravity
    "ask_user", "request_user_input", "notify_user", // defensive, for Grok and Antigravity variants
];

fn is_ask_tool(name: &str) -> bool { ASK_TOOLS.iter().any(|t| name.eq_ignore_ascii_case(t)) }

/// Question text for an ask tool: `question`, `questions[0].question`, `plan`, `message`, or `prompt`.
fn ask_text(args: &Value) -> String { /* use str_of_any + the questions[0] fallback */ }
```

At **each of the three TOOL emit sites** (Grok, Claude, Antigravity), right after `out.push(ev)` for the TOOL:

```rust
if is_ask_tool(&name) {
    let mut ask = Event::new(ts, event::ASK);
    ask.n = name.clone();
    let (b, c) = body(&ask_text(parsed_args), BODY_CAP); // reuse the existing body() cap
    ask.b = b; ask.c = c;
    ask.g = tool_ev_g.clone(); ask.h = tool_ev_h.clone(); // keep subagent attribution
    out.push(ask);
}
```

**Keep the TOOL event.** The Actions/Tools matrix and tool counts must not change. `ASK` is an extra
marker. `stats.rs` ignores it through `_ => {}`. Check that `ASK` does not break
`without_recorded` dedup (it compares whole events, so it should not).

Answer and wait time: the matching `DONE` event (same tool name, the next one after the ASK
in the same lane) carries `ms`, which is how long the user took to answer. The frontend pairs them,
so no backend pairing is needed.

**Tests** (`ingest.rs` test module): one fixture per CLI with an ask tool. Assert that the output
contains `TOOL` and then `ASK` with the same `t`, the right `n`, and the question text in `b`. Also
assert that a non-ask tool emits no `ASK`.

### 3.2 New module `analytics/prompt_graph.rs`

Pure functions plus serde types, so they are easy to unit-test.

```rust
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PromptStatus { Complete, InProgress, Interrupted }

#[derive(Serialize, Clone, Debug)]
pub struct PromptSummary {
    pub index: usize,        // 0-based, chronological
    pub t_start: i64,
    pub t_end: i64,          // last event t (or the TURN t)
    pub duration_ms: u64,    // TURN.ms if present, else t_end - t_start
    pub preview: String,     // first 80 chars of the USER body, whitespace collapsed
    pub status: PromptStatus,
    pub event_count: usize,
    pub tool_count: usize,
    pub ask_count: usize,
    pub err_count: usize,
    pub subagent_count: usize, // distinct non-empty g
    pub tokens_in: u64, pub tokens_out: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct PromptGraphResponse {
    pub prompts: Vec<PromptSummary>,  // all prompts, light (for the scrubber)
    pub selected: Option<usize>,
    pub events: Vec<Event>,           // full events of the selected prompt
    pub truncated: bool,              // true if events were capped
}

pub const MAX_PROMPT_EVENTS: usize = 3_000;

/// Splits a tab's events into prompts. Returns (start, end_exclusive) index ranges.
pub fn segment_prompts(events: &[Event]) -> Vec<(usize, usize)>;
pub fn summarize(events: &[Event], idx: usize, range: (usize, usize), is_last: bool) -> PromptSummary;
pub fn build(events: &[Event], turn_index: Option<i64>) -> PromptGraphResponse;
```

**Segmentation rules:**
1. A prompt **starts** at each `k == "user"` event with `g.is_empty()` (main agent only; subagent
   "user" messages are task inputs and stay inside the parent prompt).
2. A prompt **ends** right before the next main-agent `user` event, or at the end of the array.
3. Events before the first main `user` are dropped (preamble).
4. Status:
   * `Complete` if the range contains a `turn` event with `g.is_empty()`.
   * `InProgress` if it has no such `turn` **and** it is the last prompt.
   * otherwise `Interrupted`.
5. If several transcripts (`s`) are mixed in one tab file, segment over the whole file in
   chronological order. Do not split by `s`.

**`turn_index` semantics:** `None` or `-1` means the latest prompt. Values `>= 0` are absolute indexes.
Negative values `< -1` count from the end (`-2` = the second latest). Clamp to range. Empty
input gives `prompts: [], selected: None, events: []`.

**Truncation:** if the selected range has more than `MAX_PROMPT_EVENTS` events, keep the first `user`
event plus the **last** `MAX_PROMPT_EVENTS - 1` events, and set `truncated = true`.

### 3.3 New Tauri command

In `analytics/mod.rs`:

```rust
#[tauri::command]
pub async fn tab_prompt_graph(
    session_name: String,
    tab_id: String,
    turn_index: Option<i64>,
) -> Result<PromptGraphResponse, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = live_lock();                 // same lock as tab_analytics, to avoid a purge race
        let events = read_tab_events(&session_name, &tab_id, 0);
        drop(_guard);
        Ok(prompt_graph::build(&events, turn_index))
    }).await.map_err(|e| e.to_string())?
}
```

* **Read-only.** It does **not** ingest; `tab_analytics` polling already does that.
* Register it in `lib.rs` next to `analytics::tab_analytics`.

**Rust tests** for `prompt_graph.rs`: segmentation with a preamble, subagent `user` events not
splitting a prompt, the three statuses, `turn_index` handling (latest, absolute, negative, clamp),
truncation, and summary counts (tools, asks, errors, subagents, tokens).

---

## 4. Frontend changes

### 4.1 API ([api.ts](apps/desktop/src/api.ts))

```ts
export type PromptStatus = "complete" | "in_progress" | "interrupted";
export interface PromptSummary { index: number; t_start: number; t_end: number; duration_ms: number;
  preview: string; status: PromptStatus; event_count: number; tool_count: number; ask_count: number;
  err_count: number; subagent_count: number; tokens_in: number; tokens_out: number; }
export interface PromptGraphResponse { prompts: PromptSummary[]; selected: number | null;
  events: AnalyticsEvent[]; truncated: boolean; }   // reuse the existing recent_events element type
export function tabPromptGraph(sessionName: string, tabId: string, turnIndex: number | null)
  : Promise<PromptGraphResponse> { return invoke("tab_prompt_graph", { sessionName, tabId, turnIndex }); }
```

Add `"ask"` wherever the event kind union or type is declared.

### 4.2 Pure model: `src/chrome/promptGraphModel.ts` (+ `promptGraphModel.test.ts`)

All logic goes here, with no React and no DOM.

```ts
export type NodeKind = "user" | "think" | "reply" | "tool" | "ask" | "complete" | "interrupted" | "pending";
export interface GraphStep { ev: AnalyticsEvent; done?: AnalyticsEvent; result?: AnalyticsEvent; }
export interface GraphNode {
  id: string;              // stable: `${lane}:${firstEventT}:${kind}:${ordinal}`
  kind: NodeKind;
  lane: string;            // "main" or a subagent id (ev.g)
  laneLabel?: string;      // ev.h
  steps: GraphStep[];      // more than one means a cluster
  t0: number; t1: number;  // first and last timestamp in the node
  durationMs: number;      // sum of done.ms for tools; t1 - t0 otherwise; wait time for ask
  errCount: number;
  tokensOut: number;       // from usage events that fall inside [t0, t1]
  title: string;           // "TOOLS ×7", "THINK", "ASK USER"
  subtitle: string;        // e.g. "Read ×3 · Edit ×2 · Bash ×2" or a body preview
  live: boolean;           // the last node of an in-progress prompt
  x: number; y: number;    // filled in by layout()
}
export interface GraphEdge { id: string; from: string; to: string; kind: "flow" | "fork" | "join"; durationMs: number; }
export interface GraphModel { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number;
  totals: { durationMs: number; tools: number; asks: number; errors: number; askWaitMs: number }; }

export function buildPromptGraph(events: AnalyticsEvent[], status: PromptStatus,
  opts?: { liveNeedsUser?: boolean; expanded?: Set<string> }): GraphModel;
export type Orientation = "vertical" | "horizontal";
export function pickOrientation(width: number, height: number): Orientation; // width > height → "horizontal"
export function layout(model: GraphModel, viewport: { width: number; height: number },
  orientation: Orientation): GraphModel;
```

**Build rules:**
1. Drop `think` events with an empty body. Drop `usage` and `turn` events as nodes, but fold their
   tokens and duration into node metadata and totals.
2. Pair `tool` → `result` / `done` per lane by tool name, FIFO (the first unpaired tool with the same `n`).
   `result` and `done` never become nodes.
3. `ask` events become their own **ASK node**, never merged into a cluster. The `tool` event with the
   same `t` and `n` is **absorbed** into the ASK node (so the tool is not shown twice). Wait time is
   the paired `done.ms`, or `now - t` if it is unanswered.
4. **Clustering:** consecutive steps in the same lane with the same `kind` merge into one node
   (`tool` → `TOOLS ×N`, `think` → `THINK ×N`, `reply` → `REPLY ×N`). Clusters with **N ≥ 2** are
   collapsed by default. When `expanded` has the node id, emit one node per step instead.
5. **Subagent lanes:** steps with `g` non-empty go to lane `g`. Emit a `fork` edge from the latest
   main-lane node at or before the subagent's first event, and a `join` edge from the subagent's last
   node to the next main-lane node after its last event (only if there is one). Lanes are ordered by
   first appearance.
6. **Terminal node:**
   * `complete` → `COMPLETE` node (gray-white, with a check mark), labeled with the total duration.
   * `interrupted` → `INTERRUPTED` node (dim red, dashed border).
   * `in_progress` → `pending` node: a pulsing ghost "…" node attached to the live last node. If
     `liveNeedsUser` is true, or the last node is an unanswered ASK, the pending node becomes an
     **AWAITING INPUT** beacon (pink, strong pulse).
7. Edge `durationMs` = `to.t0 - from.t1`. It is shown as a small label on the edge if it is ≥ 1 s.

**Layout rules (adaptive).** Define the layout in abstract **flow axis / cross axis** terms, then
map those to x/y by orientation. Do not write two separate layout engines.

| | vertical (`height ≥ width`) | horizontal (`width > height`) |
|---|---|---|
| Flow axis (time) | y, top → bottom | x, left → right |
| Cross axis (lanes) | x; subagent lanes go **right** of main | y; subagent lanes go **below** main |
| Viewport extent on cross axis | `viewport.width` | `viewport.height` |
| Scroll direction | vertical scroll | horizontal scroll (also map wheel-y to scroll-x) |
| Edge curves | vertical Bézier; fork/join S-curve sideways | horizontal Bézier; fork/join S-curve downward |

* **Cross axis:** the main lane sits at the cross-axis center when there are no subagent lanes. When
  subagent lanes exist, it moves to the first third. Subagent lanes are offset by `LANE_GAP = 140`
  (vertical) or `96` (horizontal) per lane. If the lanes do not fit the cross extent, shrink the gap
  down to a minimum of `90` / `64`. Lanes beyond that overflow and scroll.
* **Flow axis:** positions are assigned in **chronological order** over all lanes (sort nodes by
  `t0`, then advance by `NODE_FLOW + GAP_FLOW`). That way a subagent node lines up with the main
  steps that ran at the same time.
* **Node sizes:**
  * vertical: `NODE_W = 168` (main) / `120` (subagent), `NODE_H = 44`, `GAP_FLOW = 22`.
  * horizontal: `NODE_W = 132` / `104`, `NODE_H = 52` (title plus 2 subtitle lines), `GAP_FLOW = 36`.
* Model output must be deterministic for a given (events, viewport, orientation), for tests and to
  avoid flicker.
* **Hysteresis:** to avoid flip-flopping at a near-square aspect, the component switches to
  horizontal only when `width > height * 1.1` and back to vertical only when `height > width * 1.1`.
  Put this logic in `pickOrientation(width, height, prev?)`.
* **Orientation change:** keep the same node ids and animate positions (CSS `transform` transition,
  300 ms) so nodes glide to their new places instead of re-mounting.

**Tests (`node:test`):**
* Linear flow user→think→tool×3→reply→turn gives 5 nodes plus COMPLETE, and TOOLS×3 is collapsed.
* Expanding the cluster gives 3 tool nodes.
* Ask absorbs its tool, wait time comes from `done.ms`, and an unanswered ask in an in-progress
  prompt gives the AWAITING beacon.
* `liveNeedsUser=true` gives the AWAITING beacon even without an ask event.
* Subagent fork and join edges, with the lane offset on x (vertical) or y (horizontal).
* Errored tool sets `errCount` on its cluster.
* Empty-body think events are dropped.
* Layout is deterministic. In both orientations, every node fits inside the cross extent when lanes
  fit, and the flow coordinates increase monotonically with `t0`.
* `pickOrientation`: 800×400 → horizontal; 400×800 → vertical; 500×480 with `prev = "vertical"`
  stays vertical (hysteresis).
* Horizontal and vertical layouts of the same model have the same node ids and edge set, with
  x and y swapped in role.

### 4.3 Component: `src/chrome/PromptGraph.tsx`

The root is `<section className="scifi-panel prompt-graph-panel">`, styled like the other HUD panels.
Its header has tag `07`, the title `PROMPT GRAPH`, a status subtitle (`LIVE` / `PROMPT 12 / 14`), and
the panel-level maximize/collapse buttons (§4.5).

```ts
interface PromptGraphProps {
  sessionName: string; tabId: string;
  liveNeedsUser?: boolean;     // optional: the parent passes window.attention_label === "needs_user"
  refreshKey: number;          // bump on each tabAnalytics poll so the latest prompt stays live
  headerActions?: React.ReactNode; // maximize/collapse buttons rendered by the HUD
}
```

**Data flow:**
* State: `turnIndex: number | null` (`null` = follow latest), `resp`, `expanded: Set<string>`,
  `selectedNodeId`, `orientation`.
* Fetch `tabPromptGraph(sessionName, tabId, turnIndex)` on mount, on `turnIndex` change, and on
  `refreshKey` change **only while** `turnIndex === null` or the selected prompt is `in_progress`.
  Use a stale-response guard (request counter), the same pattern as `bound` in AnalyticsHud.
* A `ResizeObserver` on the **graph canvas container** (not the whole panel) gives `{width, height}`.
  Then `orientation = pickOrientation(width, height, prevOrientation)`.
* `useMemo(() => layout(buildPromptGraph(...), {width, height}, orientation))`.
* Reset `expanded` and `selectedNodeId` when the prompt changes.
* When the panel is collapsed, skip rendering the SVG and pause the 1 s wait-counter interval, but
  keep the fetch state.

**Structure (vertical orientation, a tall half-panel):**

```
┌ 07 PROMPT GRAPH ─────────── LIVE ───── [⤢][–]┐
│ ◀  PROMPT 12 / 14  ▶   [● LIVE]              │  ← arrows; LIVE chip = follow latest
│ ▁▃▂▅█▂▁▃▆▂▁▄▇▅  (mini scrubber bars)         │  ← one bar per prompt, height = duration,
│ "refactor the ingest follower so that…"      │    color = status, pink dot if ask_count > 0
│ 3m12s · 24 tools · 1 ask · 0 err · 18.2k out │
├ GRAPH (scrollable, SVG) ─────────────────────┤
│        ◆ USER PROMPT                          │
│        │ (energy edge)                        │
│        ⬡ THINK                                │
│        ▣ TOOLS ×7  Read×3 Edit×2 Bash×2  ┐    │
│        │                     fork ──────▶ ▣ subagent lane
│        ✦ ASK USER   waited 42s            │   │
│        │                     join ◀───────┘   │
│        ◉ REPLY                                │
│        ✔ COMPLETE   3m12s                     │
├ NODE DETAIL DRAWER (bottom, when selected) ──┤
│ kind · time · duration · tokens · full body   │
└──────────────────────────────────────────────┘
```

**Structure (horizontal orientation, a wide or short panel):**

```
┌ 07 PROMPT GRAPH ── ◀ PROMPT 12/14 ▶ [● LIVE] ▁▃▂▅█▂▁▃▆ ── 3m12s · 24 tools · 1 ask ── [⤢][–]┐
│ "refactor the ingest follower so that…"                                                  │
├ GRAPH (horizontal scroll, SVG) ───────────────────────────────────────┬ DETAIL (right) ──┤
│ ◆ USER ─▶ ⬡ THINK ─▶ ▣ TOOLS ×7 ─▶ ✦ ASK USER ─▶ ◉ REPLY ─▶ ✔ DONE   │ kind · time ·    │
│                         └─fork─▶ ▣ sub: TOOLS ×4 ─join─┘              │ duration · body  │
└───────────────────────────────────────────────────────────────────────┴──────────────────┘
```

* In horizontal mode, the selector, scrubber, and summary collapse into **one header row** to
  save height. The node detail opens as a **right-side drawer** (width 38%, max 320 px) instead
  of a bottom drawer.
* Clusters in the detail drawer list their steps (name, `a`, `ms`, `err`). Clicking one expands the cluster.
* Scrubber: up to the last 60 prompts as bars. Clicking a bar sets `turnIndex`. `←`/`→` (and `[`/`]`)
  keys work when the graph is focused. The LIVE chip sets `turnIndex = null`.
* While following a live prompt, the graph auto-scrolls to the **end of the flow axis** (bottom in
  vertical, right in horizontal), unless the user has scrolled away (sticky-end pattern).
* Show a `truncated` notice ("SHOWING LAST 3000 EVENTS") when that flag is set.
* Empty state: `NO PROMPTS CAPTURED`, styled like the existing `.empty-log`.

### 4.4 Visual design (sci-fi, high quality)

**Node shapes**, one per kind, so the graph reads at a glance even in monochrome:

| Kind | Shape | Icon glyph |
|------|-------|-----------|
| user | diamond-cut rectangle (chamfered corners) | `◆` |
| think | hexagon | `⬡` |
| tool cluster | rectangle with corner brackets `⌜⌝⌞⌟` plus `×N` badge | `▣` |
| ask | octagon with a double outline | `✦` |
| reply | pill (fully rounded) | `◉` |
| complete | circle with a check mark | `✔` |
| interrupted | dashed circle | `✕` |
| pending / awaiting | ghost pill with scanline fill | `…` / `?` |

**SVG `<defs>`** (define them once per component instance and prefix ids with a `useId()` value):
* `filter#glow`: `feGaussianBlur stdDeviation=3` + `feMerge` (blur + source). Applied to node
  strokes and edges.
* `linearGradient#edge-<kind>`: from the source node color to the target node color.
* `pattern#scan`: 2 px horizontal scanlines at 6% opacity, used as an overlay fill on nodes.
* Optional faint background `pattern#grid` (24 px) at 4% opacity, matching the HUD.

**Node body:** fill `rgba(8,12,20,0.85)`, 1.25 px stroke in the kind color, scanline overlay,
uppercase title in the HUD monospace font (11 px, letter-spacing .12em), subtitle at 10 px and 55%
opacity, duration right-aligned in tabular numbers. Error count is a small red `✕N` badge at the top
right. Cluster nodes get a stacked-card offset shadow (2 ghost outlines offset 3 px and 6 px) to show
there are several items.

**Edges:** cubic Bézier along the flow axis (vertical or horizontal by orientation), S-curves for
fork and join.
* Base stroke: 1.5 px, gradient, 35% opacity.
* **Energy overlay:** the same path with `stroke-dasharray: 4 14` and a CSS animation on
  `stroke-dashoffset` (1.2 s linear infinite), full opacity, glow filter. That gives the
  "flowing energy" look.
* Edges into a live, pending, or awaiting node animate 2× faster.
* Gaps of 1 s or more show a tiny label at the edge midpoint: `+4.2s`.

**Live and attention states:**
* Live node: outer ring with a `@keyframes pulse` (scale 1 → 1.15, opacity .8 → 0, 1.6 s).
* AWAITING INPUT: pink beacon with two staggered concentric pulse rings, the label
  `AWAITING USER INPUT`, and the elapsed wait counter (ticks every second, client-side).
* Entry animation: new nodes fade and slide in 8 px along the flow axis (200 ms). Key nodes by
  their stable `id` so existing nodes do not re-animate. Position nodes with
  `transform: translate(x, y)` and `transition: transform 300ms` so orientation changes and
  cluster expand/collapse glide.
* Hover: brighten the stroke, show a tooltip with full time, duration, and preview. Click: select the
  node (open the detail drawer); clusters also get an expand/collapse affordance (`⊕` / `⊖`).

**Accessibility and performance:**
* Respect `prefers-reduced-motion` by turning off dash and pulse animations.
* Nodes are `<g role="button" tabIndex=0 aria-label="…">`, and Enter/Space selects.
* Over 300 rendered nodes is unlikely with clustering, but if it happens, render only the nodes in
  the viewport (simple flow-axis range culling on the scroll container).
* Both halves are animated (WebGL map plus SVG dash animations). Pause the SVG animations
  (`animation-play-state: paused` via a class) when the panel is collapsed or the HUD window is
  hidden (`document.hidden`).
* CSS goes in `index.css` under a `/* ---- Prompt Graph ---- */` block, with all classes prefixed `pg-`.

### 4.5 HUD integration ([AnalyticsHud.tsx](apps/desktop/src/chrome/AnalyticsHud.tsx))

#### 4.5.1 Split the Area Map slot

Wrap the current `<TerrainViewport …/>` (L1182–1189) in a new horizontal split row. The splitter
between the map and sections 04/05 (`.scifi-splitter-h`) and `.scifi-row` stay **below** this
row, unchanged.

```tsx
<main className="scifi-center" style={{ "--hud-bottom-row-height": … }}>
  <div
    className={`scifi-viz-split ${vizMode}`}           // vizMode: "split" | "map" | "graph"
    style={{ "--viz-map-pct": `${vizSplitPct}%` } as React.CSSProperties}
  >
    {vizMode !== "graph" && (
      <div className="scifi-viz-pane map">
        <TerrainViewport …unchanged props… />
      </div>
    )}
    {vizMode === "split" && (
      <div
        className={`scifi-splitter-v viz ${isDraggingViz ? "dragging" : ""}`}
        onMouseDown={onStartDragViz}
        onDoubleClick={resetViz}                       // → 50 and vizMode "split"
        title="Drag to resize Area Map / Prompt Graph (Double-click to reset 50/50)"
      />
    )}
    {vizMode !== "map" && (
      <div className="scifi-viz-pane graph">
        <PromptGraph sessionName={sessionName} tabId={tabId}
          liveNeedsUser={attentionLabel === "needs_user"} refreshKey={graphRefreshKey}
          headerActions={<VizPaneButtons pane="graph" … />} />
      </div>
    )}
  </div>
  {/* existing .scifi-splitter-h and .scifi-row (04/05) unchanged */}
</main>
```

**State, with the same pattern as the existing `getInitial*` and `onStartDrag*` code:**

| State | Default | localStorage key | Clamp |
|---|---|---|---|
| `vizSplitPct` (map width %) | `50` | `sparkmux.hud.vizSplitPct` | 20–80 while dragging. Values outside 15–85 in storage fall back to 50. |
| `vizMode` | `"split"` | `sparkmux.hud.vizMode` | `"split" \| "map" \| "graph"` |

* `onStartDragViz`: same as `onStartDragV`, but it measures `.scifi-viz-split` `clientWidth` and
  turns the drag delta into a percentage. Set `body.style.cursor = "col-resize"` while dragging.
  **Snap-to-collapse:** if the drag ends below 12%, set `vizMode = "graph"` (map collapsed). If it
  ends above 88%, set `vizMode = "map"` (graph collapsed). In both cases keep the last valid
  `vizSplitPct`, so restoring returns to the earlier ratio.
* **Maximize and collapse buttons (`VizPaneButtons`):** small `⤢` (maximize / restore) and `–`
  (collapse) icon buttons, styled like `.stream-filter-btn`.
  * **Prompt Graph:** pass them through the `headerActions` prop so they render in the graph header.
  * **Area Map:** `TerrainViewport` has no header slot, so do not edit its internals. Overlay the
    buttons absolutely in the top-right corner of `.scifi-viz-pane.map` (`z-index` above the canvas,
    `pointer-events: auto` on the buttons only).
  * Behavior:
    * maximize map → `vizMode = "map"`; maximize graph → `"graph"`
    * collapse map → `"graph"`; collapse graph → `"map"`
    * restore (`⤢` while maximized) → `"split"`
* A collapsed pane leaves a **14 px vertical rail** on its edge with a rotated label
  (`AREA MAP ▸` or `◂ PROMPT GRAPH`). Clicking the rail restores `"split"`. This way a collapsed
  pane is always discoverable.
* Keyboard (only when focus is inside the HUD and not in an input):
  * `Alt+1` → map maximized
  * `Alt+2` → graph maximized
  * `Alt+0` → split

**CSS** (add next to `.scifi-center` rules at index.css ~L2634):

```css
.scifi-center > .scifi-viz-split { flex: 1 1 0; min-height: 140px; display: flex; gap: 0; min-width: 0; }
.scifi-viz-pane { position: relative; min-width: 0; min-height: 0; display: flex; }
.scifi-viz-split.split .scifi-viz-pane.map   { flex: 0 0 calc(var(--viz-map-pct) - 4px); }
.scifi-viz-split.split .scifi-viz-pane.graph { flex: 1 1 0; }
.scifi-viz-split.map   .scifi-viz-pane.map,
.scifi-viz-split.graph .scifi-viz-pane.graph { flex: 1 1 0; }
.scifi-viz-pane > .scifi-panel { flex: 1 1 0; min-width: 0; }
.scifi-splitter-v.viz { flex: 0 0 8px; margin: 0 2px; }   /* reuse the existing vertical splitter look */
```

* Move the existing `.scifi-center > .scifi-panel.viewport { flex: 1 1 0; min-height: 140px }`
  rule so it still applies inside `.scifi-viz-pane` (`.scifi-viz-pane > .scifi-panel.viewport`).
* Minimum pane width is **220 px**. If the split would make either pane narrower, clamp
  `vizSplitPct` during the drag and on window resize.
* **Narrow HUD fallback:** if `.scifi-viz-split` is narrower than **560 px** (measure it with a
  `ResizeObserver`) and `vizMode === "split"`, render it as `"map"` with the graph rail visible.
  Do not overwrite the stored preference.
* Check that `TerrainViewport`'s pointer drag (orbit camera) does not trigger while dragging the
  new splitter. The splitter sits outside the canvas, so this should already hold.

#### 4.5.2 Other HUD changes

1. `graphRefreshKey`: increment it in the existing 1 s `fetchData` success path, but only when
   the last `t` of `stats.recent_events` changed, so the graph does not refetch when nothing happened.
2. `liveNeedsUser`: add an optional `attentionLabel?: NoteLabel | null` prop to `AnalyticsHud` and
   pass it from wherever the HUD is mounted, if the window snapshot is available there (App.tsx,
   PopoutWindow). If it is not easily available, leave it `undefined`; the ASK event path still
   covers the transcript-visible asks.
3. **Event Stream Log (section 06) stays a list.** Do **not** add a GRAPH toggle there. Only add
   `ask` to the `turns` filter, add the `.scifi-log-item.ask` and `.ev-tag.ask` CSS (`#f472b6`), and
   make `eventPreview` and `eventDetail` show the question text.
4. **`DockedStatsPanel` is unchanged.** It renders `TerrainViewport` in docked mode and must not
   get the split.
5. Standalone or pop-out HUD (`isStandaloneWindow`) gets the same split. The localStorage keys are
   shared.

---

## 5. Implementation order (checklist)

1. [ ] `event.rs`: `ASK` const.
2. [ ] `ingest.rs`: `is_ask_tool`, `ask_text`, emit at the 3 sites, plus tests.
3. [ ] `prompt_graph.rs`: types, `segment_prompts`, `summarize`, `build`, plus tests.
4. [ ] `mod.rs` and `lib.rs`: `tab_prompt_graph` command and registration.
5. [ ] `api.ts`: types and `tabPromptGraph`.
6. [ ] `promptGraphModel.ts` (build, `pickOrientation`, adaptive `layout`) plus `promptGraphModel.test.ts`.
7. [ ] `PromptGraph.tsx` and the `pg-*` CSS (both orientations, drawer placement).
8. [ ] `AnalyticsHud.tsx`: the `.scifi-viz-split` row, splitter, maximize/collapse, rails,
       persistence, narrow fallback, and refresh key.
9. [ ] `AnalyticsHud.tsx`: `ask` styling in the Event Stream Log list.
10. [ ] Optional: thread `attentionLabel` to the HUD mount points.
11. [ ] `AGENTS.md`: add bullets under `apps/desktop` for `PromptGraph.tsx` (split with the Area Map)
        and `prompt_graph.rs`.

## 6. Acceptance criteria

* [ ] `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo fmt`, and
      `pnpm --dir apps/desktop run build` all pass. New TS tests pass under `node --test`.
* [ ] The Area Map slot shows the map (left) and the Prompt Graph (right) at 50/50 by default.
* [ ] Dragging the splitter resizes both halves live, and the Area Map canvas re-fits with no distortion.
* [ ] Double-click resets to 50/50. The ratio and mode persist across HUD reopen.
* [ ] Maximize, collapse, restore buttons, rails, and `Alt+0/1/2` all work. Dragging past 12% or 88% collapses a pane.
* [ ] The graph shows a horizontal flow when its pane is wider than tall, and a vertical flow
      otherwise. Switching glides with no flicker or flip-flopping near square (hysteresis).
* [ ] Sections 04/05 and their splitter behave exactly as before. The Event Stream Log is a list with no GRAPH toggle.
* [ ] The docked Area Map panel is unchanged.
* [ ] With a live Claude, Grok, or Antigravity session, the graph grows in real time (≤ 1 s lag),
      auto-scrolls along the flow axis, and the live node pulses.
* [ ] An `AskUserQuestion` / `ask_question` call shows an ASK node and an AWAITING beacon until it is
      answered, then shows "waited Ns".
* [ ] Consecutive tools collapse to `TOOLS ×N` and expand on click. Subagents render in a side
      lane with fork and join edges.
* [ ] The scrubber navigates every prompt in the tab. LIVE re-follows the latest.
* [ ] Tool counts in the Actions/Tools matrix are **unchanged** by the new `ask` events.
* [ ] No writes to any CLI directory. No new npm or cargo dependencies.
* [ ] `prefers-reduced-motion` disables the animations. Animations pause when the pane is collapsed.

## 7. Out of scope

* Editing or replaying prompts, and exporting the graph as an image.
* Drawing the graph *inside* the 3D terrain scene, or adding it to the docked mini Area Map panel.
* A GRAPH view inside the Event Stream Log.
* Detecting permission prompts that do not appear in transcripts. The live `NeedsUser` label is the
  only signal for those.
