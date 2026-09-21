import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { LayoutChangePayload, LayoutNode, Snapshot, TmuxStatus } from "./types";

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

export function toBytes(msg: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (msg instanceof ArrayBuffer) return new Uint8Array(msg);
  if (msg instanceof Uint8Array) return msg;
  if (Array.isArray(msg)) return Uint8Array.from(msg);
  return new Uint8Array();
}

/** capture-pane -p emits LF-only rows; xterm treats LF as down-without-CR (staircase).
 *  A trailing CSI CUP from the seed (tmux cursor) is preserved so the caret
 *  is not left on the last blank row of the dump. */
export function screenDumpToXterm(bytes: Uint8Array): string {
  const s = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n/g, "\r\n");
  return `\x1b[H\x1b[2J${s}`;
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
