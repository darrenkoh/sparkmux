# Sparkmux 1.5 — local agent awareness

Status: installed locally for review as `/Applications/Sparkmux.app` `0.1.45`. No tag and no GitHub Release.

This release makes the private `-L sparkmux` socket understandable when several agents run at once. It does not add Tailscale, a second tmux server, or a multi-host fleet.

Sparkmux remains a local front end. tmux I/O stays in `sparkmux-core`. The new work is classification, transcript binding, and chrome around the socket this app already owns.

## Out of scope

- Tailscale, tsnet, Serve, Funnel, or a host list.
- Typing an approval into a pane. Choosing a board row only selects that pane.
- Codex or any CLI other than Grok, Claude, and Antigravity.
- An in-window toast. The notification is a system notification, and only when Sparkmux is not the front window.
- Writing into `~/.grok`, `~/.claude`, `~/.gemini`, or a remote home. Remote reads are read-only.
- Island or Globe map changes, a larger Command Helper, prefix keys, or the default tmux server.
- A version bump.

## 1. Agent board

One board lists every Grok, Claude, and Antigravity pane on `-L sparkmux`. A shell pane is absent. An `ssh` pane is absent from this board (its transcript is the SSH feature, not a local agent row).

Each row shows:

- State: `Running`, `Waiting on you`, `Failed`, or `Finished`.
- Session name and window name.
- Model when the transcript records one, otherwise the CLI name (`Grok`, `Claude`, or `Antigravity`).
- The last ask when the agent is waiting, otherwise the last assistant line. One line, trimmed, capped at 160 characters.

Choosing a row selects that session, window, and pane through the existing select path. The board does not call `pane_write`, `send-keys`, or paste.

The board is a section at the top of the sidebar, titled `Agents`. It scrolls inside the sidebar. An empty socket shows `No agents on this socket`.

State comes from the transcript label already used for unread:

| Label | Row state |
|---|---|
| `NeedsUser` | Waiting on you |
| `Failed` | Failed |
| `Succeeded` | Finished |
| `Running`, or no label yet | Running |

`prompts_user` / ask markers supply the ask text. The last non-empty assistant body supplies the assistant line. Model is the name the transcript record already stores (`message.model` for Claude, a top-level `model` string for Grok and Antigravity). It is not copied into the visible body. Missing model falls back to the CLI name.

Pure function: `board_row` in `apps/desktop/src-tauri/src/attention.rs`. It takes already extracted fields and returns a row or nothing when the command and title are not one of the three CLIs. Tests call `board_row` directly.

## 2. Pending question on the unread row

A hidden window that is waiting shows the pending question on its existing unread row in the sidebar and on the window tab. The text is the same one-line ask, capped at 120 characters, as the row subtitle. The danger unread dot stays. Failed and bell-only unread rows do not gain this subtitle.

Opening the window clears unread, which removes the subtitle.

Pure function: `pending_question(entries) -> Option<String>` next to `classify_entries`. The sidebar renders `window.pending_ask` only when that window is unread and not the visible window.

## 3. Quiet finished mark

When a hidden agent changes from `Running` to `Succeeded`, a finished mark appears once. It is a calm mark, class `attn-finished`, not the pulsing danger disc `.attn`. Needs-user and failed keep the danger dot and do not set the finished mark. A still-running tool, a repaint (same transcript token), or a first sight that is already finished does not set the mark.

The mark clears when that window becomes the visible window of the attached session. It stays up through later polls until then.

The sidebar window row and the window tab both show it. The session row shows it when any hidden window has it. It is never drawn on the visible window.

Pure function: `AttentionBook::finished` in `attention.rs`. Tests drive it from a fresh book: running then succeeded on a hidden window sets it once; opening the window clears it; running, repaint, needs-user, and failed do not set it.

`Window` in `crates/sparkmux-core/src/snapshot.rs` gains `pending_ask: String` and `finished: bool`. The parser leaves them empty and false. The desktop `annotate_attention` path fills them. Existing `unread` rules do not change: needs-user and failed light the danger dot; running, succeeded, and a repaint do not.

## 4. SSH transcript binding

A pane whose foreground command is `ssh` (the executable basename, including a path such as `/usr/bin/ssh`) must not bind a local Mac transcript.

- Output, Stats, the area map, and Gits (change graph and chronicle) stay empty for that pane when the remote store cannot be read. A dirty git checkout on the Mac does not appear. An ssh pane never mixes in that Mac worktree's `git status`. When a remote store is readable, Gits shows only that transcript's edits.
- A title that contains `grok`, `Claude Code`, or `Antigravity` does not override this. The local `~/.grok`, `~/.claude`, and `~/.gemini` trees are not opened for that pane.
- When a remote store is readable, those surfaces follow that store for that pane only. The remote store is a `TranscriptRoots` value pointed at a cache directory for that pane, never at the Mac's own CLI directories.
- A second pane, local or ssh, does not receive the first pane's remote files.

Readable means a read-only fetch of the remote home's three CLI roots succeeded and the cache directory contains a transcript `select_transcript` can open. The fetch uses `ssh` argv from the pane pid, `BatchMode=yes`, a short connect timeout, and a validated `user@host`. It does not pass the host through a local shell. Failure, pid 0, or an unparseable argv yields an empty binding.

Pure function: `bind_transcript(command, remote_readable) -> Local | Empty | Remote` in `apps/desktop/src-tauri/src/ssh_bind.rs`.

`load_artifacts` keeps its signature. When the command is ssh and no remote roots were staged for that pid, it returns an empty feed (`cli: None`, no path, no entries) even if the title names an agent and the local roots hold a transcript. `tab_analytics`, `change_graph` session edits, `chronicle` session lookup, allowance (`llm_usage`), and Bedrock cost use the same gate before `detect_cli` / `select_transcript`.

Tests build two fixture homes. An `ssh` command with no remote fixture returns an empty feed and the transcript path is not the local file. An `ssh` command with a readable remote fixture returns that fixture's transcript path and not the other home's file.

## 5. Focused-pane scrollback search

The focused pane opens a find bar with `⌘F` or `Ctrl+F`. The bar does not take keys while it is closed. While it is open, typing stays in the find field and is not sent to the pane. Enter finds the next match. Shift+Enter finds the previous match. Escape closes the bar and returns focus to the terminal. The match is case-insensitive. An empty needle matches nothing.

The search walks the pane's xterm scrollback text. A pure function `findScrollback(text, needle, fromIndex)` in `apps/desktop/src/terminal/scrollbackSearch.ts` returns the next match index or nothing. The view highlights that span in the buffer.

Linux does not gain `Ctrl+D`, `Ctrl+W`, or `Ctrl+Q` chords.

## 6. Open an agent-edited file in the editor

A Gits changed-file node and an Output tool row that names a file offer `Open in editor`.

The recorded path is what opens. A relative path is resolved against the pane cwd. The request rejects an empty path, a path over 4096 characters, and any control character or newline. The open spawns `/usr/bin/open` on macOS or `xdg-open` on Linux with that one path argument and no shell. Nothing is sent to the pane: no `pane_write`, no paste, no Enter.

Pure functions:

- `editor_open_request(path, cwd) -> { path, pane_write: false }` in `apps/desktop/src-tauri/src/open_path.rs`. `pane_write` is always false.
- `toolRowPath(body)` in `apps/desktop/src/chrome/openPath.ts` reads the first `file_path`, `target_file`, `path`, `AbsolutePath`, or `TargetFile` line from a tool body (`file_path: src/App.tsx`).

The Gits card uses its existing `path` field. The Output row shows the action only when `toolRowPath` returns a path.

## 7. Background needs-user notification

A macOS notification fires only when all of these are true:

- Sparkmux is not the front window (no Sparkmux window is focused, and the document is hidden).
- The agent window is hidden (not the visible window of the attached session).
- The label moves from unseen or `Running` into `NeedsUser`. A change from `Failed` or `Succeeded` into waiting does not notify. The classifier label is `attention_label` on the snapshot. A visible visit clears unread and the pending question and leaves that label in place. Blank unread is not a running label. The tmux current window of a session that is not on screen can be `active` and still `running`; that label is stored, so the next wait can notify.

A repaint that is already waiting does not notify again. A focused Sparkmux window does not notify. Running, finished, and failed do not notify. There is no in-app toast.

Pure function: `notification_allowed(app_focused, hidden, previous, next)` in `apps/desktop/src-tauri/src/notify_attention.rs`.

The poster re-checks focus on the Tauri windows before it runs `osascript`. The notification text is the pending question, passed as an argv item, not interpolated into the script. The title is `Sparkmux`.

## File ownership

Shared files (`App.tsx`, `lib.rs`, `api.ts`, `commands.rs` except the attention fill, `index.css` except appended classes) are wired by the integrator after the feature modules land.

| Feature | Files |
|---|---|
| Board, pending ask, finished mark | `attention.rs`, `snapshot.rs` `Window` fields, `Sidebar.tsx`, `WindowTabs.tsx`, `AgentBoard.tsx`, `agentBoard.ts`, `agentBoard.test.ts`, attention section of `commands.rs` |
| SSH binding | `ssh_bind.rs`, the gate inside `load_artifacts`, `analytics/mod.rs`, `change_graph.rs`, `chronicle.rs`, `llm_usage.rs`, `bedrock_cost.rs` |
| Search and open | `scrollbackSearch.ts`, `scrollbackSearch.test.ts`, `XtermView.tsx`, `open_path.rs`, `openPath.ts`, `openPath.test.ts`, `ArtifactPanel.tsx`, `ChangeGraph.tsx` |
| Notification | `notify_attention.rs` |

## Tests that must pass

- Needs-user and failed set the danger unread state. Running and a repeated token do not.
- Hidden running then succeeded sets the finished mark once. Opening the window clears it.
- `ssh` with no readable remote store returns an empty transcript binding and not a different local session.
- `ssh` with a readable remote fixture binds only that fixture for that call.
- `findScrollback` finds a needle in scrollback text.
- `editor_open_request` carries the recorded path and `pane_write` is false.
- `notification_allowed` is true only for an unfocused app, a hidden window, and a transition from no label or running into needs-user.
- A visible visit keeps the cached needs-user label. `attention_label` stays `needs_user` when unread and the pending question are blank. `trackAttention` stores that label. A tmux-active window that is not on screen and whose label is `running` stores `running`, and the next `needs_user` notifies once.

## Deploy

From `apps/desktop`, `npm run tauri build -- --bundles app` with `DEVELOPER_DIR=/Library/Developer/CommandLineTools`. Quit the Sparkmux app, wait for that pid to exit, `ditto` the bundle over `/Applications/Sparkmux.app`, `xattr -cr`, and `open` it. Do not run `tmux kill-server`. `CFBundleShortVersionString` stays `0.1.45`. `tmux -L sparkmux ls` still lists the server.
