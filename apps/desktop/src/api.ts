import { Channel } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  acceptPaneSubscriptionMessage,
  type PaneFrameSink,
  type PaneServerFrame,
} from "./terminal/paneFrame.ts";
import { isTauriRuntime, rpcInvoke, rpcListen, wsTransport } from "./transport.ts";

import type { AgentBoardRow } from "./chrome/agentBoard";
import type {
  AppTelemetry,
  LayoutChangePayload,
  LayoutNode,
  LlmUsage,
  Snapshot,
  TmuxStatus,
} from "./types";

export function tmuxStatus(): Promise<TmuxStatus> {
  return rpcInvoke("tmux_status");
}

export function snapshot(): Promise<Snapshot> {
  return rpcInvoke("snapshot");
}

export function ensureReady(): Promise<Snapshot> {
  return rpcInvoke("ensure_ready");
}

export function newSession(name: string): Promise<void> {
  return rpcInvoke("new_session", { name });
}

export function renameSession(target: string, newName: string): Promise<void> {
  return rpcInvoke("rename_session", { target, newName });
}

export function killSession(target: string): Promise<void> {
  return rpcInvoke("kill_session", { target });
}

export function newWindow(session: string, name: string): Promise<void> {
  return rpcInvoke("new_window", { session, name });
}

export function selectWindow(windowId: string): Promise<void> {
  return rpcInvoke("select_window", { windowId });
}

export function renameWindow(windowId: string, name: string): Promise<void> {
  return rpcInvoke("rename_window", { windowId, name });
}

export function killWindow(windowId: string): Promise<void> {
  return rpcInvoke("kill_window", { windowId });
}

export function killPane(paneId: string): Promise<void> {
  return rpcInvoke("kill_pane", { paneId });
}

export function splitPane(paneId: string, vertical: boolean): Promise<void> {
  return rpcInvoke("split_pane", { paneId, vertical });
}

export function controlConnect(session: string, cols: number, rows: number): Promise<void> {
  return rpcInvoke("control_connect", { session, cols, rows });
}

export function controlDisconnect(): Promise<void> {
  return rpcInvoke("control_disconnect");
}

/** A Tauri `Channel` inside the desktop shell, otherwise a plain listener. */
export type PaneDataListener = {
  onmessage?: (msg: unknown) => void;
};

export function createPaneDataListener(): PaneDataListener {
  if (isTauriRuntime()) {
    return new Channel<ArrayBuffer | Uint8Array | number[]>() as PaneDataListener;
  }
  return {};
}

/** Registers `listener.onmessage` on the transport. `paneSubscribe` uses this on the web. */
export function connectPaneListener(
  transport: { attachPaneHandler(paneId: string, onData: (frame: PaneServerFrame) => void): void },
  paneId: string,
  listener: PaneDataListener,
): void {
  transport.attachPaneHandler(paneId, (frame) => {
    listener.onmessage?.(frame);
  });
}

/** The pane effect calls this. Outside Tauri it never constructs a Tauri `Channel`. */
export function bindPaneOutput(
  paneId: string,
  state: { seeded: boolean },
  sink: PaneFrameSink,
): Promise<void> {
  const listener = createPaneDataListener();
  listener.onmessage = (msg) => acceptPaneSubscriptionMessage(msg, state, sink);
  return paneSubscribe(paneId, listener);
}

export function paneSubscribe(paneId: string, onData: PaneDataListener): Promise<void> {
  if (isTauriRuntime()) {
    return rpcInvoke("pane_subscribe", { paneId, onData });
  }
  connectPaneListener(wsTransport, paneId, onData);
  return wsTransport.invoke("pane_subscribe", { paneId });
}

export function paneUnsubscribe(paneId: string): Promise<void> {
  if (isTauriRuntime()) return rpcInvoke("pane_unsubscribe", { paneId });
  return wsTransport.unsubscribePane(paneId);
}

export function paneWrite(paneId: string, data: number[]): Promise<void> {
  if (isTauriRuntime()) return rpcInvoke("pane_write", { paneId, data });
  return wsTransport.sendPaneWriteBinary(paneId, data);
}

/** Tauri ignores `force`. The web RPC includes it so a phone can resize a desktop server. */
export function windowResizeArgs(
  cols: number,
  rows: number,
  force = false,
  tauri = false,
): Record<string, unknown> {
  if (tauri) return { cols, rows };
  return { cols, rows, force: Boolean(force) };
}

export function windowResize(cols: number, rows: number, force = false): Promise<void> {
  return rpcInvoke("window_resize", windowResizeArgs(cols, rows, force, isTauriRuntime()));
}

export function paneCursor(paneId: string): Promise<{ y: number; x: number }> {
  return rpcInvoke("pane_cursor", { paneId });
}

export function focusPane(paneId: string): Promise<void> {
  return rpcInvoke("focus_pane", { paneId });
}

export function stopServer(): Promise<void> {
  return rpcInvoke("stop_server");
}

export function rememberSession(name: string): Promise<void> {
  return rpcInvoke("remember_session", { name });
}

export function parseLayout(layout: string): Promise<LayoutNode> {
  return rpcInvoke("parse_layout", { layout });
}

export function attachTargetName(): Promise<string | null> {
  return rpcInvoke("attach_target_name");
}

export async function pasteIntoPane(paneId: string, bracket: boolean): Promise<void> {
  if (isTauriRuntime()) {
    return rpcInvoke("paste_into_pane", { paneId, bracket });
  }
  const raw = await navigator.clipboard.readText();
  if (!raw) return;
  const clipped = raw.slice(0, 1_048_576);
  const cleaned = clipped.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
  const payload = bracket ? `\x1b[200~${cleaned}\x1b[201~` : cleaned;
  const bytes = Array.from(new TextEncoder().encode(payload));
  await paneWrite(paneId, bytes);
}

export type PairingLink = {
  url: string;
  modules: string;
};

export type WebServeStatus = {
  running: boolean;
  links: PairingLink[];
  selected: string;
};

export function webServeToggle(): Promise<WebServeStatus> {
  return rpcInvoke("web_serve_toggle");
}

export function webServeStatus(): Promise<WebServeStatus> {
  return rpcInvoke("web_serve_status");
}

export async function clipboardWrite(text: string): Promise<void> {
  if (isTauriRuntime()) {
    return rpcInvoke("clipboard_write", { text });
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  document.body.removeChild(area);
}

export async function openHttpUrl(url: string): Promise<void> {
  if (isTauriRuntime()) {
    return rpcInvoke("open_http_url", { url });
  }
  if (/^https?:\/\//i.test(url)) {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function openEditorPath(path: string, cwd: string): Promise<void> {
  return rpcInvoke("open_editor_path", { path, cwd });
}

export interface AgentBoardPane {
  session: string;
  window_id: string;
  window_name: string;
  pane_id: string;
  command: string;
  cwd: string;
  title: string;
  pid: number;
}

export function agentBoard(panes: AgentBoardPane[]): Promise<AgentBoardRow[]> {
  return rpcInvoke("agent_board", { panes });
}

export interface ArtifactEntry {
  id: string;
  offset: number;
  kind: string;
  label: string;
  body: string;
  /** Model copied from the transcript. Empty when the record has none. */
  model?: string;
}

export interface ArtifactFeed {
  cli: string | null;
  transcript_path: string | null;
  file_len: number;
  entries: ArtifactEntry[];
  error: string | null;
}

export function paneArtifacts(
  command: string,
  cwd: string,
  title: string,
  pid: number,
): Promise<ArtifactFeed> {
  return rpcInvoke("pane_artifacts", { command, cwd, title, pid });
}

export interface ChangeGraphFile {
  path: string;
  status: string;
  agent_edited: boolean;
  lines_added: number;
  lines_removed: number;
}

export interface ChangeGraphRepo {
  id: string;
  name: string;
  primary: boolean;
  files: ChangeGraphFile[];
}

export interface ChangeGraphEdge {
  from_repo: string;
  to_repo: string;
  label: string;
  via: string;
}

export interface ChangeGraphResponse {
  repos: ChangeGraphRepo[];
  edges: ChangeGraphEdge[];
  truncated: boolean;
  error: string | null;
}

export interface FileDiffResponse {
  path: string;
  diff: string;
  is_binary: boolean;
}

export function changeGraph(
  command: string,
  cwd: string,
  title: string,
  pid: number,
): Promise<ChangeGraphResponse> {
  return rpcInvoke("change_graph", { command, cwd, title, pid });
}

export function fileDiff(
  repoId: string,
  path: string,
  cwd: string,
): Promise<FileDiffResponse> {
  return rpcInvoke("file_diff", { repoId, path, cwd });
}

export interface SearchFileTarget {
  repo_id: string;
  path: string;
}

export interface ChangedFileMatch {
  repo_id: string;
  path: string;
  match_count: number;
}

export function searchChangedFiles(
  targets: SearchFileTarget[],
  query: string,
  scope: "diff" | "full",
  cwd: string,
): Promise<ChangedFileMatch[]> {
  return rpcInvoke("search_changed_files", { targets, query, scope, cwd });
}

export interface GitCommitItem {
  hash: string;
  short_hash: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  summary: string;
  body: string;
  parents: string[];
  files_changed: number;
  insertions: number;
  deletions: number;
}

export interface GitHistoryResponse {
  repo_id: string;
  repo_name: string;
  commits: GitCommitItem[];
  file_filter: string | null;
  total_count: number;
}

export interface GitCommitFile {
  path: string;
  status: string;
  added: number;
  removed: number;
}

export interface GitCommitDetail {
  hash: string;
  short_hash: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  summary: string;
  body: string;
  parents: string[];
  files: GitCommitFile[];
}

export function gitHistory(
  repoId: string,
  cwd: string,
  path?: string | null,
  maxCount?: number | null,
): Promise<GitHistoryResponse> {
  return rpcInvoke("git_history", { repoId, cwd, path, maxCount });
}

export function gitCommitDetail(
  repoId: string,
  cwd: string,
  commitHash: string,
): Promise<GitCommitDetail> {
  return rpcInvoke("git_commit_detail", { repoId, cwd, commitHash });
}

export function gitCommitDiff(
  repoId: string,
  cwd: string,
  commitHash: string,
  path: string,
): Promise<FileDiffResponse> {
  return rpcInvoke("git_commit_diff", { repoId, cwd, commitHash, path });
}

export interface ChronicleFile {
  lane: number;
  path: string;
  outside: boolean;
  edits: number;
  added: number;
  removed: number;
  binary: boolean;
}

export interface ChronicleStation {
  id: string;
  ordinal: number;
  lane: number;
  path: string;
  tool: string;
  kind: string;
  added: number;
  removed: number;
  preview: string;
  timestamp_ms: number | null;
  time_source: string;
  outcome: string;
}

export interface ChronicleNow {
  path: string;
  available: boolean;
  reason: string | null;
  worktree_mtime_ms: number | null;
}

export interface ChronicleSession {
  cli: string | null;
  stations: ChronicleStation[];
  files: ChronicleFile[];
  now: ChronicleNow[];
  omitted: number;
  truncated_tail: boolean;
  empty_reason: string | null;
  transcript_len: number;
  transcript_mtime_ms: number;
  events_mtime_ms: number | null;
}

export interface ChronicleHologram {
  station_id: string;
  path: string;
  fidelity: string;
  reason: string | null;
  file_text: string | null;
  file_truncated: boolean;
  window_start_line: number;
  total_lines: number;
  diff_text: string;
  diff_kind: string;
  diff_truncated: boolean;
  added: number;
  removed: number;
}

export function chronicleSession(
  command: string,
  cwd: string,
  title: string,
  pid: number,
): Promise<ChronicleSession> {
  return rpcInvoke("chronicle_session", { command, cwd, title, pid });
}

export function chronicleHologram(
  command: string,
  cwd: string,
  title: string,
  pid: number,
  stationId: string,
): Promise<ChronicleHologram> {
  return rpcInvoke("chronicle_hologram", { command, cwd, title, pid, stationId });
}

export function clearChronicleCache(): Promise<void> {
  return rpcInvoke("clear_chronicle_cache");
}

export interface ActivityPoint {
  timestamp: number;
  user_count: number;
  think_count: number;
  reply_count: number;
  tool_count: number;
  tokens: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  top_event_kind?: string;
  top_event_label?: string;
}

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  avg_duration_ms: number;
  max_duration_ms: number;
  last_used: number;
}

export interface ModelStat {
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens?: number;
  reasoning_tokens: number;
}

export interface SubagentStat {
  id: string;
  label: string;
  model: string;
  tool_calls: number;
  tool_errors: number;
  thinking_blocks: number;
  replies: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  lines_added: number;
  lines_removed: number;
  last_ts: number;
  /** Wall time of this subagent's own turns. Kept out of the human average. */
  turn_ms: number;
}

export interface AnalyticsEvent {
  t: number;
  k: string;
  s?: string;
  cli?: string;
  n?: string;
  a?: string;
  b?: string;
  c?: number;
  ms?: number;
  err?: boolean;
  ti?: number;
  to?: number;
  tc?: number;
  tw?: number;
  tr?: number;
  /** Subagent session id. Empty when the step belongs to the pane's own agent. */
  g?: string;
  /** Short label for that subagent (task title or role). */
  h?: string;
}

export interface TabAnalyticsStats {
  total_events: number;
  user_prompts: number;
  thinking_blocks: number;
  assistant_replies: number;
  tool_calls: number;
  tool_results: number;
  tool_errors: number;

  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_reasoning_tokens: number;

  avg_turn_duration_ms: number;
  max_turn_duration_ms: number;
  total_turn_duration_ms: number;
  turn_count: number;

  context_tokens_used: number;
  context_window_tokens: number;
  ttft_ms: number;
  lines_added: number;
  lines_removed: number;

  active_model: string;
  tools: ToolStat[];
  models: ModelStat[];
  timeline: ActivityPoint[];
  /** First event time. The area-map window slides between this and `timeline_end`. */
  timeline_start?: number;
  /** Last event time. */
  timeline_end?: number;
  recent_events: AnalyticsEvent[];
  /** Child agents. Their tokens and tools are already included in the totals. */
  subagents?: SubagentStat[];
  /**
   * CLI usage ledger for this session. The HUD and mini-stat pass it to
   * `sessionCost`. Empty when the CLI has not written one.
   */
  cost_ledger?: string;
}

export interface AnalyticsConfig {
  enabled: boolean;
  total_bytes: number;
  session_count: number;
  tab_count: number;
}

export interface TabAnalyticsResponse {
  enabled: boolean;
  session_name: string;
  tab_id: string;
  cli: string | null;
  transcript_path: string | null;
  stats: TabAnalyticsStats;
  lifetime_stats?: TabAnalyticsStats | null;
  storage: AnalyticsConfig;
}

export function tabAnalytics(
  sessionName: string,
  tabId: string,
  command: string,
  cwd: string,
  title: string,
  pid: number,
): Promise<TabAnalyticsResponse> {
  return rpcInvoke("tab_analytics", {
    sessionName,
    tabId,
    command,
    cwd,
    title,
    pid,
  });
}

export function setAnalyticsEnabled(enabled: boolean): Promise<void> {
  return rpcInvoke("set_analytics_enabled", { enabled });
}

export function clearAnalyticsData(): Promise<void> {
  return rpcInvoke("clear_analytics_data");
}

export function analyticsConfig(): Promise<AnalyticsConfig> {
  return rpcInvoke("analytics_config");
}

export function appTelemetry(): Promise<AppTelemetry> {
  return rpcInvoke("app_telemetry");
}

export function llmUsage(
  command: string,
  title: string,
  cwd: string,
  pid: number,
): Promise<LlmUsage> {
  return rpcInvoke("llm_usage", { command, title, cwd, pid });
}

export function toBytes(msg: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (msg instanceof ArrayBuffer) return new Uint8Array(msg);
  if (msg instanceof Uint8Array) return msg;
  if (Array.isArray(msg)) return Uint8Array.from(msg);
  return new Uint8Array();
}

/** capture-pane -p emits LF-only rows; xterm treats LF as down-without-CR (staircase).
 *  A trailing CSI CUP from the seed (tmux cursor) is preserved so the caret
 *  is positioned at the exact cursor coordinates.
 *  We position each row explicitly at \x1b[row;1H rather than joining with \r\n,
 *  preventing wrapped lines or full-height dumps from scrolling the terminal buffer
 *  up and misaligning the cursor relative to the visible prompt. */
export function screenDumpToXterm(bytes: Uint8Array): string {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const match = decoded.match(/\x1b\[\d+;\d+H$/);
  const cup = match ? match[0] : "";
  const body = match ? decoded.slice(0, match.index) : decoded;
  const stripped = body.replace(/\r?\n$/, "");
  const normalized = stripped.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  let out = "\x1b[H\x1b[2J";
  for (let i = 0; i < lines.length; i++) {
    out += `\x1b[${i + 1};1H${lines[i]}`;
  }
  return `${out}${cup}`;
}

export async function listenLayoutChange(
  handler: (payload: LayoutChangePayload) => void,
): Promise<UnlistenFn> {
  return rpcListen<LayoutChangePayload>("layout-change", handler);
}

export async function listenTreeDirty(handler: () => void): Promise<UnlistenFn> {
  return rpcListen("tree-dirty", () => handler());
}

export async function listenControlExit(handler: () => void): Promise<UnlistenFn> {
  return rpcListen("control-exit", () => handler());
}

export async function listenServerStopped(handler: () => void): Promise<UnlistenFn> {
  return rpcListen("server-stopped", () => handler());
}

export async function listenMenu(handler: (id: string) => void): Promise<UnlistenFn> {
  return rpcListen<string>("menu", handler);
}

export interface ActiveTarget {
  session_name: string;
  tab_id: string;
  tab_name: string;
  focused_pane: string;
  command: string;
  cwd: string;
  title: string;
  pid: number;
}

export function syncActiveTarget(target: ActiveTarget): Promise<void> {
  return rpcInvoke("sync_active_target", { target });
}

export function getActiveTarget(): Promise<ActiveTarget> {
  return rpcInvoke("get_active_target");
}

export async function openPopoutWindow(
  kind: "stats" | "gits",
  target?: ActiveTarget,
): Promise<void> {
  if (target) await syncActiveTarget(target).catch(() => {});
  if (isTauriRuntime()) {
    return rpcInvoke("open_popout_window", { kind, target: target ?? null });
  }
  window.open(`/?window=${kind}`, `sparkmux-${kind}`, "noopener");
}

export async function listenActiveTargetChanged(
  handler: (target: ActiveTarget) => void,
): Promise<UnlistenFn> {
  return rpcListen<ActiveTarget>("active-target-changed", handler);
}

