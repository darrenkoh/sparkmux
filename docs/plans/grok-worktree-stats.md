# Sparkmux Stats for Grok Build worktree agents

Sparkmux Stats stays empty or sticks to the wrong transcript when a Grok Build pane is running agents in git worktrees. Output, the area map, and Gits use the same transcript picker, so they miss the same session. This plan changes that picker. It does not redesign those views, and it does not write under `~/.grok` or read pane output.

Public behavior is [Grok Build worktrees](https://docs.x.ai/build/features/worktrees). A worktree is an isolated checkout at `~/.grok/worktrees/<repo>/<name>`, started from the current HEAD. The CLI starts one with `grok -w`, `grok --worktree=<name>`, or `grok -w --ref <ref>`. Inside the TUI, `/fork --worktree` forks the current session into a worktree, Ctrl+W on the welcome screen opens the New Worktree dialog, and Ctrl+W in the [Agent Dashboard](https://docs.x.ai/build/features/dashboard) dispatches new agents into worktrees. Whether `/new` and `/fork` offer a worktree is `new_session_worktree_mode` (default `never`) and `fork_worktree_mode` (default `ask`) under `[hints]` in the [settings reference](https://docs.x.ai/build/settings/reference). Subagents can also ask for a worktree; those stay children of the session that spawned them and are not the case this plan fixes.

## Root cause

Stats calls `tab_analytics`, which calls `resolve_pane_transcript` (`apps/desktop/src-tauri/src/analytics/mod.rs`). That function calls `select_transcript`, which returns on the first hit from `grok_active_transcript` (`apps/desktop/src-tauri/src/artifacts.rs`). Later fallbacks (pane title, a single file in the cwd directory, an open file) never run once an active-session row matches.

`grok_active_transcript` reads `~/.grok/active_sessions.json` and keeps the row from `best_active`. The comparator is, in order:

1. Shallower pid in the pane's process tree (`pane_family` depth). The shell is depth 0. The Grok child is depth 1. A deeper pid never beats a shallower one.
2. Pane-cwd equality. `normalize_cwd` of the row's `cwd` equals `normalize_cwd` of the tmux pane cwd.
3. Later `opened_at`, compared as a string. Grok writes RFC3339 timestamps, so lexicographic order is time order.

The transcript path is then built only from the winning row:

```text
<grok_sessions>/<percent-encode(row.cwd)>/<session_id>/chat_history.jsonl
```

`encode_grok_path` percent-encodes every byte outside the unreserved set, including `/`. A worktree checkout therefore lives at `~/.grok/sessions/%2F…%2F.grok%2Fworktrees%2F<repo>%2F<name>/<session-id>/chat_history.jsonl`, not beside the source repo's sessions.

One Grok process writes several `active_sessions.json` rows that share `pid` and `pid_start` and differ in `cwd`. Checked on 2026-10-26 against a running `grok` (tmux pane command `grok-1.0.70`): six rows, one pid. Four rows used the source repo as `cwd`. Two used `~/.grok/worktrees/<repo>/<name>`. `lsof` reported that process's cwd as the source repo, and `tmux -L sparkmux list-panes` reported the same path in `pane_current_path`. The pane cwd therefore equals the source-repo rows and does not equal the worktree rows. Rule 2 selects a source-repo row. Rule 3 then keeps the source row with the latest `opened_at`, even when that session has almost no transcript. The worktree rows are skipped. Selection never requires the worktree path, and the current code never accepts it while a same-cwd source row exists.

Those skipped sessions are real transcripts. Their `summary.json` has `session_kind` `worktree`, `source_workspace_dir` set to the source repo, `worktree_label` set, and no `parent_session_id`. `opened_at` on the active row matches `created_at` on the summary. `last_active_at` moves later, when the session records activity. `grok_index` in `apps/desktop/src-tauri/src/analytics/subagents.rs` inserts a summary into the child map only when `parent_session_id` is set and `session_kind` starts with `subagent` (`subagent`, `subagent_resume`, `subagent_fork`). `worktree` fails that prefix check, and the live worktree summaries have no parent id, so the worktree transcript is not folded into the source session either. `ingest_session` counts tokens, tools, and event-stream rows only for the path it was given, then walks children of that path. The source row's path has the source session's bytes. The worktree agent's `usage.json` and `chat_history.jsonl` stay unread. Stats for that pane shows the source session, which is often idle, so the HUD looks empty.

`worktree_label` is not a substitute for `session_kind`. On the same day, 32 summaries carried `worktree_label` and only 2 of those had `session_kind` `worktree`. The rest were subagent sessions that happened to run inside a worktree checkout. Treating the label as "this is the pane session" would bind a child.

The comment on `TranscriptRoots.grok_active_sessions` says one record per live Grok process. The file is one record per session inside that process. Update the comment with the code change.

## Signals that do not name the focused session

No file was found that updates when the TUI focuses an existing session. These were read only, as shapes, and are not an oracle for tests:

| Location | What it actually stores | Use for selection |
| --- | --- | --- |
| `active_sessions.json` `opened_at` | Creation time. It matches `summary.json` `created_at` and stays put after `last_active_at` moves. | Tie-break only. |
| `active_sessions.json` `pid_start` | Same value on every row of one process start. The resolver does not read it today. | Leave unused. |
| Process cwd and tmux pane cwd | Stay on the source repo while worktree agents run. | Must not be required to equal the worktree path. |
| `summary.json` `last_active_at` | Activity clock. It advances when that session writes. Two sessions in one process can sit within a second of each other. | Rank worktree rows. It is not a verified focus signal. |
| `summary.json` `session_kind` | `worktree` for the human worktree agent. Subagents keep a `subagent*` kind. | Classify the row. Do not add `worktree` to the child index. |
| `~/.grok/worktrees.db` `session_id` | Pager id (`pager-…`), not the transcript session id. The two live fork rows also store `kind=fork`, `creator_pid` of the Grok process, `path` under `~/.grok/worktrees/<repo>/<name>`, and `last_accessed_at`. Subagent checkouts in the same table store the parent transcript id, not a pager id. | Do not join this column to `active_sessions.json`. |
| `~/.grok/dashboard/workspace.db` `members` | `is_worktree` is 1 for the worktree transcript ids. `pin_rank` and `order_rank` were NULL on every row. `meta.grouping` was `state`. Historical members stay in the table after they leave `active_sessions.json`. | Do not read it for selection. It can mark a worktree and still has no focus rank. |

Open file descriptors are also the wrong signal. The running process held several session directories open at once. A higher fd count is not a focus rank.

## Implementation

Read-only. Open `active_sessions.json`, `summary.json`, `chat_history.jsonl`, `usage.json`, `updates.jsonl`, `events.jsonl`, and `signals.json` the way ingest already does. Create nothing under `~/.grok`. Do not scrape `%output` or poll `capture-pane`. Keep `under_jail` on every path. SSH panes stay on `ssh_bind` and are out of scope.

### Choice rule

Keep `best_active`'s depth rule exactly. The shallowest pid in the pane family still wins, so another console's Grok stays out.

At that winning depth, split the rows:

- A row is a **worktree agent** when its `cwd` normalizes to `…/.grok/worktrees/<repo>/<name>`, `<name>` does not start with `subagent-`, and a readable `summary.json` for that row has `session_kind` `worktree`. If the summary is missing, the cwd shape is enough: the active row still points at a transcript directory, and a `subagent-` directory name stays excluded. If the summary exists and `session_kind` starts with `subagent`, the row is not a worktree agent. Those children stay on `grok_family`.
- Every other row at that depth is an **ordinary** row.

Then:

1. **No worktree-agent row at the winning depth.** Call today's `best_active` unchanged: pane-cwd equality, then later `opened_at`. One ordinary Grok session keeps today's binding, including a single row whose cwd does not match the pane. Several ordinary rows on one pid also keep today's binding.
2. **One or more worktree-agent rows.** Ignore pane-cwd equality for this pid. The pane cwd is the source repo, so equality would select a source row and hide the worktree transcript. Choose only among worktree-agent rows:
   - Greatest `summary.json` `last_active_at`. Compare the strings. A missing `last_active_at` ranks below any present value.
   - Tie-break: later `active_sessions.json` `opened_at`.
   - Final tie-break: lexicographically greater `session_id`, so the result is stable.
3. Build the path the way `grok_active_transcript` already does, from the **chosen row's** `cwd` and `session_id`. `select_transcript` then returns that `chat_history.jsonl`. `tab_analytics` passes it to `ingest_session`. Existing ingest counts that file's recorded tokens (`usage.json` turns: `inputTokens`, `outputTokens`, `cachedReadTokens`, `reasoningTokens`), tool rows, and event-stream lines. No new counter.

`grok_index` stays as it is. A `session_kind` of `worktree` is the selected parent transcript, so the child filter must not see it as a candidate to drop. Once the worktree file is the parent path, `ingest_session` still folds descendants whose `session_kind` starts with `subagent`. A peer worktree with no `parent_session_id` is not a child of the source session and is not a child of the other worktree.

`last_active_at` is an activity clock. It was not shown to move when the TUI focuses a session that is not writing. If several worktree agents share the pid and the user focuses a quieter one without a new turn, Stats stays on the worktree that last wrote `last_active_at`. That can disagree with the session on screen. `opened_at` would instead prefer a freshly created idle worktree, which is worse. There is no focused-session file to consult. If Grok later writes one, read it. Do not invent the path.

The same rule hides a source-repo session while any worktree agent row exists on that pid. A TUI focused on the source session, with worktree agents only in the dashboard, will show a worktree transcript. That is the tradeoff that makes the worktree agent's own Stats appear. Depth still isolates a different pane's process.

### Where the code goes

All of the decision sits in `apps/desktop/src-tauri/src/artifacts.rs`, beside `best_active` and `grok_active_transcript`.

- Extend the active-row read with a jailed summary read: `session_kind` and `last_active_at` only. Cap the read (the child index uses 1 MiB). A symlink that leaves `grok_sessions` fails `under_jail` and the row falls through to the ordinary comparator.
- Keep `best_active` as the ordinary comparator so the current tests keep calling the same order: shallower pid, then pane-cwd equality, then later `opened_at`.
- Add the worktree split in `grok_active_transcript` before it builds the path, so every caller of `select_transcript` picks up the rule in one place.
- Update the `grok_active_sessions` comment: several rows can share one pid.

Do not change `apps/desktop/src-tauri/src/analytics/ingest.rs`. Do not change `grok_index`'s prefix check. Do not add a dashboard or `worktrees.db` reader.

### Surfaces that follow the same path

These already call `resolve_pane_transcript` or `tab_analytics` and need no view work:

- Stats HUD and Mini Stat: `tab_analytics`, then the area map's timeline from those events.
- Output / Logs: `pane_artifacts` → `load_for_family` → `select_transcript`.
- Gits agent edits and Chronicle stations: `change_graph.rs` `session_edits` and `chronicle.rs` `load_for_pane`.

Git status inside Gits still uses the tmux pane cwd. After this change the agent-edit half follows the worktree transcript, and the git-status half still describes the source repo, because the pane cwd never moved. Leave that split alone. Retargeting `git` at `~/.grok/worktrees/<repo>/<name>` is a separate change.

Bedrock cost uses the same resolver and only prices Claude. A Grok worktree row does not change that chip.

## Fixture tests

Synthetic directories only. Do not open the developer `~/.grok` tree. Drive `load_for_family` (it takes an explicit pid family, so the test does not walk the live process tree) and, in the analytics crate, `ingest_session` plus `grok_index`. Helpers already in `artifacts.rs` tests: `scratch`, `roots`, `write_grok`, `encode_grok_path`.

Shared fixture shape:

```text
<scratch>/active_sessions.json
<scratch>/sessions/<percent-encode(source cwd)>/<id>/{chat_history.jsonl,summary.json}
<scratch>/sessions/<percent-encode(worktree cwd)>/<id>/{chat_history.jsonl,summary.json,usage.json}
```

Use absolute cwds the encoder accepts, for example source `/repo/app` and worktree `/home/u/.grok/worktrees/app/feat`. Pane family `[(7, 0), (42, 1)]`. Pane cwd is the source path. Every worktree row uses pid 42. `summary.json` for a worktree id is `session_kind` `worktree`, `source_workspace_dir` the source path, `worktree_label` a short name, `last_active_at` an RFC3339 timestamp, and no `parent_session_id`. Chat bodies are one distinct assistant line per session so the assertion can see which file was bound. `usage.json` for the selected worktree is one turn, same shape as `grok_aligns_tools_and_turns_with_events_file`:

```json
{"turns":[{"endedAt":"2026-10-10T08:56:02.853932+00:00","inputTokens":900,"outputTokens":30,"cachedReadTokens":500,"reasoningTokens":20,"primaryModelId":"grok-4.7-build","modelCalls":1}]}
```

`load_for_family` arguments: command `grok-1.0.70`, title `grok`, the source cwd, the family above, and `TranscriptRoots` whose `grok_sessions` and `grok_active_sessions` point at the scratch files.

### 1. Same-pid source row loses to the worktree row

`worktree_row_beats_same_pid_source_row`

- Source row `src`, pid 42, cwd `/repo/app`, `opened_at` `2026-10-26T16:42:22Z`. This is the row today's comparator picks: same cwd as the pane, and the later `opened_at` among source rows if a second source row is included.
- Optional earlier source row, pid 42, same cwd, earlier `opened_at`, different reply text.
- Worktree row `wt`, pid 42, cwd `/home/u/.grok/worktrees/app/feat`, `opened_at` **earlier** than the source row (`2026-10-26T16:40:00Z`), `last_active_at` `2026-10-26T17:04:06Z`.
- A second pid 99 with a newer `opened_at` and its own reply, to prove depth still wins.

Assert the feed's transcript path ends with `encode_grok_path(worktree cwd)/wt/chat_history.jsonl`, the worktree reply is present, and neither source reply nor pid 99's reply is present. Assert the path does not sit under the encoded source cwd.

### 2. `session_kind` `worktree` is the selected session

`worktree_kind_is_ingested_as_the_selected_session` in `analytics/subagents.rs` tests, using the path from test 1 (or the same fixture built again).

- `grok_index` on that sessions root does **not** list `wt` under any parent. `session_kind` `worktree` still fails `starts_with("subagent")`. Add a decoy child with `session_kind` `subagent`, `parent_session_id` `wt`, and its own `usage.json` turn of `outputTokens` 7. `grok_index` lists that decoy under `wt` only.
- `ingest_session(CliKind::Grok, <wt chat path>, …)` returns a `usage` event whose `(ti, to, tc, tr)` is `(400, 30, 500, 20)` from the worktree `usage.json`, plus the decoy child's usage. The parent path is ingested even though its summary kind is `worktree`. The filter that skips non-subagent summaries applies to the child walk, not to the selected file.
- A second worktree peer, `session_kind` `worktree`, no `parent_session_id`, with its own reply, does not appear in `grok_index` and its tokens are absent from this `ingest_session` result.

### 3. One ordinary session stays on today's binding

`ordinary_session_binding_unchanged`

- Only `src`, pid 42, cwd equal to the pane cwd, no worktree row. The feed is `src`'s reply. This matches `pane_process_selects_its_session_and_other_consoles_stay_out`, which must keep passing: two different pids, same cwd, the family pid wins over a later `opened_at` on the other pid.
- Two ordinary rows, same pid, same cwd, no worktree row. The later `opened_at` wins. The new branch does not run.
- One ordinary row whose cwd is `/repo/app`, pane cwd `/repo/app/sub`. Still that row. A single candidate already wins today with `same_cwd` false. Keep it.
- One worktree row and no source row, pane cwd `/repo/app`. The feed is the worktree file. Today's third clause already allows this, because every candidate has `same_cwd` false and the only row is kept. The new branch must still return it.

### 4. Several worktree agents on one pid

`later_worktree_activity_wins_over_newer_opened_at`

- `old-busy`, `opened_at` `2026-10-26T16:40:00Z`, `last_active_at` `2026-10-26T17:04:06Z`.
- `new-idle`, `opened_at` `2026-10-26T16:57:22Z`, `last_active_at` `2026-10-26T16:42:00Z`.
- Both pid 42, both worktree cwds, plus a source row with a still later `opened_at`.

Assert `old-busy`. Then a twin fixture where both `last_active_at` values are equal: the later `opened_at` wins. Then both timestamps missing: the later `opened_at` wins. Then equal `opened_at` and equal `last_active_at`: the greater `session_id` wins.

A `subagent-` cwd with `session_kind` `subagent` on pid 42 must not beat `old-busy`.

Run:

```bash
cargo test -p sparkmux-desktop --lib artifacts::tests::worktree_row_beats_same_pid_source_row
cargo test -p sparkmux-desktop --lib artifacts::tests::ordinary_session_binding_unchanged
cargo test -p sparkmux-desktop --lib artifacts::tests::later_worktree_activity_wins_over_newer_opened_at
cargo test -p sparkmux-desktop --lib analytics::subagents::tests::worktree_kind_is_ingested_as_the_selected_session
cargo test -p sparkmux-desktop --lib artifacts::tests::pane_process_selects_its_session_and_other_consoles_stay_out
```

## Out of scope

- Shipping the Rust change, the HUD, or a new counter. The work above is the change to make later.
- Writing into `~/.grok`, or parsing the pane to discover which session the TUI has focused.
- Listing every historical worktree in one Stats view, or merging a worktree branch back to the source repo.
- SSH remote stores, Claude, Antigravity, and Codex worktrees.
- Pointing Gits' `git status` at the worktree checkout. Transcript selection is the shared piece. The git cwd stays the pane cwd.
