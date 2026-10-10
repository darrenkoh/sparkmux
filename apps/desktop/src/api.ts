import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { AppTelemetry, LayoutChangePayload, LayoutNode, Snapshot, TmuxStatus } from "./types";

export function tmuxStatus(): Promise<TmuxStatus> {
  return invoke("tmux_status");
}

export function snapshot(): Promise<Snapshot> {
  return invoke("snapshot");
}

export function ensureReady(): Promise<Snapshot> {
  return invoke("ensure_ready");
}

export function newSession(name: string): Promise<void> {
  return invoke("new_session", { name });
}

export function renameSession(target: string, newName: string): Promise<void> {
  return invoke("rename_session", { target, newName });
}

export function killSession(target: string): Promise<void> {
  return invoke("kill_session", { target });
}

export function newWindow(session: string, name: string): Promise<void> {
  return invoke("new_window", { session, name });
}

export function selectWindow(windowId: string): Promise<void> {
  return invoke("select_window", { windowId });
}

export function renameWindow(windowId: string, name: string): Promise<void> {
  return invoke("rename_window", { windowId, name });
}

export function killWindow(windowId: string): Promise<void> {
  return invoke("kill_window", { windowId });
}

export function killPane(paneId: string): Promise<void> {
  return invoke("kill_pane", { paneId });
}

export function splitPane(paneId: string, vertical: boolean): Promise<void> {
  return invoke("split_pane", { paneId, vertical });
}

export function controlConnect(session: string, cols: number, rows: number): Promise<void> {
  return invoke("control_connect", { session, cols, rows });
}

export function controlDisconnect(): Promise<void> {
  return invoke("control_disconnect");
}

export function paneSubscribe(
  paneId: string,
  onData: Channel<ArrayBuffer | Uint8Array | number[]>,
): Promise<void> {
  return invoke("pane_subscribe", { paneId, onData });
}

export function paneUnsubscribe(paneId: string): Promise<void> {
  return invoke("pane_unsubscribe", { paneId });
}

export function paneWrite(paneId: string, data: number[]): Promise<void> {
  return invoke("pane_write", { paneId, data });
}

export function windowResize(cols: number, rows: number): Promise<void> {
  return invoke("window_resize", { cols, rows });
}

export function paneCursor(paneId: string): Promise<{ y: number; x: number }> {
  return invoke("pane_cursor", { paneId });
}

export function focusPane(paneId: string): Promise<void> {
  return invoke("focus_pane", { paneId });
}

export function stopServer(): Promise<void> {
  return invoke("stop_server");
}

export function rememberSession(name: string): Promise<void> {
  return invoke("remember_session", { name });
}

export function parseLayout(layout: string): Promise<LayoutNode> {
  return invoke("parse_layout", { layout });
}

export function attachTargetName(): Promise<string | null> {
  return invoke("attach_target_name");
}

export function pasteIntoPane(paneId: string, bracket: boolean): Promise<void> {
  return invoke("paste_into_pane", { paneId, bracket });
}

export function clipboardWrite(text: string): Promise<void> {
  return invoke("clipboard_write", { text });
}

export function openHttpUrl(url: string): Promise<void> {
  return invoke("open_http_url", { url });
}

export interface ArtifactEntry {
  id: string;
  offset: number;
  kind: string;
  label: string;
  body: string;
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
  return invoke("pane_artifacts", { command, cwd, title, pid });
}

export interface ActivityPoint {
  timestamp: number;
  user_count: number;
  think_count: number;
  reply_count: number;
  tool_count: number;
  tokens: number;
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
  reasoning_tokens: number;
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
  recent_events: AnalyticsEvent[];
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
  return invoke("tab_analytics", {
    sessionName,
    tabId,
    command,
    cwd,
    title,
    pid,
  });
}

export function setAnalyticsEnabled(enabled: boolean): Promise<void> {
  return invoke("set_analytics_enabled", { enabled });
}

export function clearAnalyticsData(): Promise<void> {
  return invoke("clear_analytics_data");
}

export function analyticsConfig(): Promise<AnalyticsConfig> {
  return invoke("analytics_config");
}

export interface HelperStatus {
  enabled: boolean;
  weight_path: string | null;
  usage: string;
}

export interface ShellSuggestion {
  command: string;
  destructive: boolean;
  raw: string;
}

export function commandHelperStatus(): Promise<HelperStatus> {
  return invoke("command_helper_status");
}

export function appTelemetry(): Promise<AppTelemetry> {
  return invoke("app_telemetry");
}

export function enableCommandHelper(): Promise<HelperStatus> {
  return invoke("enable_command_helper");
}

export function disableCommandHelper(): Promise<HelperStatus> {
  return invoke("disable_command_helper");
}

export function suggestShellCommand(
  request: string,
  shell: string,
  alternate: boolean,
): Promise<ShellSuggestion> {
  return invoke("suggest_shell_command", { request, shell, alternate });
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
  return listen<LayoutChangePayload>("layout-change", (e) => handler(e.payload));
}

export async function listenTreeDirty(handler: () => void): Promise<UnlistenFn> {
  return listen("tree-dirty", () => handler());
}

export async function listenControlExit(handler: () => void): Promise<UnlistenFn> {
  return listen("control-exit", () => handler());
}

export async function listenServerStopped(handler: () => void): Promise<UnlistenFn> {
  return listen("server-stopped", () => handler());
}

export async function listenMenu(handler: (id: string) => void): Promise<UnlistenFn> {
  return listen<string>("menu", (e) => handler(e.payload));
}
