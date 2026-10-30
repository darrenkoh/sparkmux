import type { ActiveTarget } from "../api";
import type { Pane, Snapshot } from "../types";

export type PopoutWindowKind = "stats" | "gits" | "office";

export interface PinnedTarget {
  sessionName: string;
  tabId: string;
  paneId?: string;
}

export const ACTIVE_TARGET_STORAGE_KEY = "sparkmux.activeTarget";

export function parsePopoutWindowKind(search: string): PopoutWindowKind | null {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const val = params.get("window")?.trim().toLowerCase();
  if (val === "stats" || val === "gits" || val === "office") return val;
  return null;
}

function selectPaneForTab(
  win: { panes: Pane[] } | null | undefined,
  focusedPaneId: string | null | undefined,
): Pane | null {
  if (!win || win.panes.length === 0) return null;
  if (focusedPaneId) {
    const focused = win.panes.find((pane) => pane.id === focusedPaneId);
    if (focused) return focused;
  }
  return win.panes.find((pane) => pane.active) ?? win.panes[0];
}

export function resolvePopoutTarget(
  snapshot: Snapshot,
  followTarget: ActiveTarget | null,
  pinnedTarget: PinnedTarget | null,
): ActiveTarget {
  // 1. Pinned mode: lock to the pinned session/tab and refresh live pane details from snapshot
  if (pinnedTarget) {
    const sess = snapshot.sessions.find((s) => s.name === pinnedTarget.sessionName);
    const win =
      sess?.windows.find((w) => w.id === pinnedTarget.tabId) ??
      sess?.windows.find((w) => w.active) ??
      sess?.windows[0];
    const pane = selectPaneForTab(win, pinnedTarget.paneId);
    if (sess && win) {
      return {
        session_name: sess.name,
        tab_id: win.id,
        tab_name: win.name || "shell",
        focused_pane: pane?.id ?? pinnedTarget.paneId ?? "",
        command: pane?.command ?? followTarget?.command ?? "",
        cwd: pane?.path ?? followTarget?.cwd ?? "",
        title: pane?.title ?? followTarget?.title ?? "",
        pid: pane?.pid ?? followTarget?.pid ?? 0,
      };
    }
    return {
      session_name: pinnedTarget.sessionName,
      tab_id: pinnedTarget.tabId,
      tab_name:
        followTarget &&
        followTarget.session_name === pinnedTarget.sessionName &&
        followTarget.tab_id === pinnedTarget.tabId
          ? followTarget.tab_name || "shell"
          : "shell",
      focused_pane: pinnedTarget.paneId ?? followTarget?.focused_pane ?? "",
      command: followTarget?.command ?? "",
      cwd: followTarget?.cwd ?? "",
      title: followTarget?.title ?? "",
      pid: followTarget?.pid ?? 0,
    };
  }

  // 2. Follow mode: track the main window's active session/tab, enriched by live snapshot pane info
  if (followTarget && followTarget.session_name && followTarget.tab_id) {
    const sess = snapshot.sessions.find((s) => s.name === followTarget.session_name);
    const win = sess?.windows.find((w) => w.id === followTarget.tab_id);
    const pane = selectPaneForTab(win, followTarget.focused_pane);
    if (sess && win && pane) {
      return {
        session_name: sess.name,
        tab_id: win.id,
        tab_name: win.name || followTarget.tab_name || "shell",
        focused_pane: pane.id,
        command: pane.command,
        cwd: pane.path,
        title: pane.title,
        pid: pane.pid,
      };
    }
    return {
      ...followTarget,
      tab_name: followTarget.tab_name || "shell",
    };
  }

  // 3. Fallback when no main window target has been broadcast yet
  const fallbackSession =
    snapshot.sessions.find((s) => Boolean(s.attached)) ?? snapshot.sessions[0];
  const fallbackWin =
    fallbackSession?.windows.find((w) => w.active) ?? fallbackSession?.windows[0];
  const fallbackPane = selectPaneForTab(fallbackWin, null);

  return {
    session_name: fallbackSession?.name ?? "sparkmux",
    tab_id: fallbackWin?.id ?? "main",
    tab_name: fallbackWin?.name ?? "shell",
    focused_pane: fallbackPane?.id ?? "",
    command: fallbackPane?.command ?? "",
    cwd: fallbackPane?.path ?? "",
    title: fallbackPane?.title ?? "",
    pid: fallbackPane?.pid ?? 0,
  };
}

export function readStoredActiveTarget(raw: string | null): ActiveTarget | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ActiveTarget>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.session_name !== "string" ||
      typeof parsed.tab_id !== "string"
    ) {
      return null;
    }
    return {
      session_name: parsed.session_name,
      tab_id: parsed.tab_id,
      tab_name: typeof parsed.tab_name === "string" ? parsed.tab_name : "shell",
      focused_pane: typeof parsed.focused_pane === "string" ? parsed.focused_pane : "",
      command: typeof parsed.command === "string" ? parsed.command : "",
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      title: typeof parsed.title === "string" ? parsed.title : "",
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
    };
  } catch {
    return null;
  }
}
