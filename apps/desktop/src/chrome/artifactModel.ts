import type { ArtifactEntry, ArtifactFeed } from "../api";
import type { Pane, Snapshot } from "../types";

export type { ArtifactEntry, ArtifactFeed } from "../api";

export type ClearMap = Record<string, number>;

const CLEAR_KEY = "sparkmux.artifactClear";
const CLEAR_LIMIT = 64;
const AUTO_SCROLL_KEY = "sparkmux.artifactAutoScroll";

/** Unset storage stays on. Only an explicit "0" turns auto scroll off. */
export function parseAutoScroll(stored: string | null): boolean {
  return stored !== "0";
}

export function loadAutoScroll(): boolean {
  try {
    return parseAutoScroll(window.localStorage.getItem(AUTO_SCROLL_KEY));
  } catch {
    return true;
  }
}

export function saveAutoScroll(on: boolean) {
  try {
    window.localStorage.setItem(AUTO_SCROLL_KEY, on ? "1" : "0");
  } catch {
    // Storage can be blocked; the toggle still works for this view.
  }
}

/** True when the viewport is within a few lines of the latest output. */
export function nearOutputBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight < 48;
}

/** One line for a collapsed log row. Newlines fold into spaces. */
export function previewLine(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/** Changes when a new entry arrives or the latest entry's text grows. */
export function outputTailKey(entries: { id: string; body: string }[]): string {
  const last = entries[entries.length - 1];
  if (!last) return "0";
  return `${entries.length}\n${last.id}\n${last.body.length}\n${last.body.slice(-32)}`;
}

/**
 * Calculates scroll adjustment when new items are prepended to the top of an inverted list.
 * If the user was scrolled down (prevScrollTop > threshold), and height was added (deltaScrollHeight > 0),
 * returns the new scrollTop that preserves their scrolled position.
 * If the user was at the top (prevScrollTop <= threshold), returns null (no adjustment, stay at top).
 */
export function calculatePreservedScrollTop(
  prevScrollTop: number,
  prevScrollHeight: number,
  currentScrollHeight: number,
  threshold = 2,
): number | null {
  if (prevScrollTop <= threshold) {
    return null;
  }
  const delta = currentScrollHeight - prevScrollHeight;
  if (delta <= 0) {
    return null;
  }
  return prevScrollTop + delta;
}

/**
 * Checks whether new entries arrived at the top or the topmost entry grew in size.
 */
export function hasNewTopContent(
  prevEntries: ArtifactEntry[],
  nextEntries: ArtifactEntry[],
): boolean {
  if (nextEntries.length > prevEntries.length) {
    return true;
  }
  if (nextEntries.length === 0 || prevEntries.length === 0) {
    return false;
  }
  const prevLast = prevEntries[prevEntries.length - 1];
  const nextLast = nextEntries[nextEntries.length - 1];
  return (
    prevLast.id !== nextLast.id ||
    prevLast.body !== nextLast.body ||
    prevLast.label !== nextLast.label
  );
}

export function markCleared(map: ClearMap, path: string, fileLen: number): ClearMap {
  if (!path) return map;
  const prev = map[path] ?? 0;
  const next = Math.max(prev, Math.max(0, fileLen));
  if (map[path] === next) return map;
  const updated: ClearMap = { ...map, [path]: next };
  const keys = Object.keys(updated);
  if (keys.length <= CLEAR_LIMIT) return updated;
  const trimmed: ClearMap = {};
  for (const key of keys.slice(keys.length - (CLEAR_LIMIT - 1))) {
    trimmed[key] = updated[key];
  }
  trimmed[path] = next;
  return trimmed;
}

export function clearedThrough(map: ClearMap, path: string | null, fileLen: number): number {
  if (!path) return 0;
  const mark = map[path] ?? 0;
  if (!Number.isFinite(mark) || mark <= 0) return 0;
  if (mark > fileLen) return 0;
  return mark;
}

export function visibleEntries<T extends { offset: number }>(entries: T[], through: number): T[] {
  if (through <= 0) return entries;
  return entries.filter((entry) => entry.offset >= through);
}

export function emptyOutputText(
  feed: ArtifactFeed | null,
  visibleCount: number,
  through: number,
): string | null {
  if (!feed) return "Reading the transcript…";
  if (feed.error) return feed.error;
  if (!feed.cli) return "This pane is not running Grok, Claude, or Antigravity.";
  if (!feed.transcript_path) return "No transcript for this pane yet.";
  if (visibleCount > 0) return null;
  if (through > 0) return "Cleared. New replies show up here.";
  return "No reply in this transcript yet.";
}

export function cliLabel(cli: string | null): string {
  if (cli === "grok") return "Grok";
  if (cli === "claude") return "Claude";
  if (cli === "antigravity" || cli === "agy") return "Antigravity";
  return "";
}

/** The selected tab's pane. A focused pane from another tab is not used. */
export function outputPaneForTab(
  win: { panes: Pane[] } | null | undefined,
  focusedPaneId: string | null,
): Pane | null {
  if (!win || win.panes.length === 0) return null;
  if (focusedPaneId) {
    const focused = win.panes.find((pane) => pane.id === focusedPaneId);
    if (focused) return focused;
  }
  return win.panes.find((pane) => pane.active) ?? win.panes[0];
}

export function findPane(snap: Snapshot, paneId: string | null): Pane | null {
  if (!paneId) return null;
  for (const session of snap.sessions) {
    for (const win of session.windows) {
      for (const pane of win.panes) {
        if (pane.id === paneId) return pane;
      }
    }
  }
  return null;
}

export function directoryLabel(cwd: string): string {
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export function loadClears(): ClearMap {
  try {
    const raw = window.localStorage.getItem(CLEAR_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: ClearMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveClears(map: ClearMap) {
  window.localStorage.setItem(CLEAR_KEY, JSON.stringify(map));
}
