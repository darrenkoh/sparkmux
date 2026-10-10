import type { ArtifactFeed } from "../api";
import type { Pane, Snapshot } from "../types";

export type { ArtifactEntry, ArtifactFeed } from "../api";

export type ClearMap = Record<string, number>;

const CLEAR_KEY = "sparkmux.artifactClear";
const CLEAR_LIMIT = 64;

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
  if (!feed.cli) return "This pane is not running Grok or Claude.";
  if (!feed.transcript_path) return "No transcript for this directory yet.";
  if (visibleCount > 0) return null;
  if (through > 0) return "Cleared. New replies show up here.";
  return "No reply in this transcript yet.";
}

export function cliLabel(cli: string | null): string {
  if (cli === "grok") return "Grok";
  if (cli === "claude") return "Claude";
  return "";
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
