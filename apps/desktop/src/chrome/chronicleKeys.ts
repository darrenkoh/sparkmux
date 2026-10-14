import type { ChronicleScene } from "./chronicleLayout";

export type ChronicleKeyAction =
  | { swallow: false }
  | { swallow: true; action: "latest" | "close" | "none" }
  | { swallow: true; action: "step"; delta: number }
  | { swallow: true; action: "lane"; stationId: string }
  | { swallow: true; action: "scene"; scene: ChronicleScene };

export interface ChronicleKeyFile {
  path: string;
  lane: number;
}

export interface ChronicleKeyStation {
  id: string;
  path: string;
  ordinal: number;
}

export interface ChronicleKeyInput {
  key: string;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
  inHologram: boolean;
  onNewest: boolean;
  enabledScenes: readonly ChronicleScene[];
  scene: ChronicleScene;
  files: readonly ChronicleKeyFile[];
  stations: readonly ChronicleKeyStation[];
  activeId: string;
  nowAvailable: (path: string) => boolean;
}

export interface ChronicleKeyState {
  onNewest: boolean;
  scene: ChronicleScene;
  files: ChronicleKeyFile[];
  stations: ChronicleKeyStation[];
  activeId: string;
  nowAvailable: (path: string) => boolean;
}

const SCENE_BY_KEY: Record<string, ChronicleScene> = {
  "1": "transit",
  "2": "rivers",
  "3": "helix",
  "4": "ridge",
};

const HOLOGRAM_KEYS = new Set([
  "Tab",
  "Enter",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export function isNewestScrubStop(
  activeId: string,
  stations: readonly { id: string; path: string }[],
  nowAvailable: (path: string) => boolean,
): boolean {
  if (stations.length === 0) return true;
  const path = activeId.startsWith("now:")
    ? activeId.slice(4)
    : stations.find((station) => station.id === activeId)?.path;
  if (!path) return false;
  if (nowAvailable(path)) return activeId === `now:${path}`;
  return activeId === stations[stations.length - 1]?.id;
}

export function laneTarget(
  files: readonly ChronicleKeyFile[],
  stations: readonly ChronicleKeyStation[],
  nowAvailable: (path: string) => boolean,
  activeId: string,
  delta: -1 | 1,
): ChronicleKeyAction {
  const ordered = [...files].sort((a, b) => a.lane - b.lane || a.path.localeCompare(b.path));
  const activePath = activeId.startsWith("now:")
    ? activeId.slice(4)
    : stations.find((station) => station.id === activeId)?.path;
  if (!activePath) return { swallow: true, action: "none" };
  const index = ordered.findIndex((file) => file.path === activePath);
  if (index < 0) return { swallow: true, action: "none" };
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= ordered.length) return { swallow: true, action: "none" };
  const path2 = ordered[nextIndex]?.path;
  if (!path2) return { swallow: true, action: "none" };
  if (activeId === `now:${activePath}` && nowAvailable(path2)) {
    return { swallow: true, action: "lane", stationId: `now:${path2}` };
  }
  const current = activeId.startsWith("now:")
    ? stations.length
    : (stations.find((station) => station.id === activeId)?.ordinal ?? 0);
  let best: ChronicleKeyStation | null = null;
  let bestDist = Infinity;
  for (const station of stations) {
    if (station.path !== path2) continue;
    const dist = Math.abs(station.ordinal - current);
    if (best == null || dist < bestDist || (dist === bestDist && station.ordinal > best.ordinal)) {
      best = station;
      bestDist = dist;
    }
  }
  if (!best) return { swallow: true, action: "none" };
  return { swallow: true, action: "lane", stationId: best.id };
}

export function chronicleKeyAction(input: ChronicleKeyInput): ChronicleKeyAction {
  const lower = input.key.toLowerCase();
  if (
    input.inHologram &&
    (input.meta || input.ctrl) &&
    !input.shift &&
    (lower === "c" || lower === "a")
  ) {
    return { swallow: false };
  }
  if (input.inHologram && HOLOGRAM_KEYS.has(input.key)) return { swallow: false };
  if (input.key === "Escape") {
    return { swallow: true, action: input.onNewest ? "close" : "latest" };
  }
  if (input.key === "ArrowLeft" || input.key === "ArrowRight") {
    return { swallow: true, action: "step", delta: input.key === "ArrowLeft" ? -1 : 1 };
  }
  if (input.key === "ArrowUp" || input.key === "ArrowDown") {
    const dir: -1 | 1 = input.key === "ArrowDown" ? 1 : -1;
    if (input.scene === "helix") {
      return { swallow: true, action: "step", delta: input.shift ? dir * 4 : dir };
    }
    if (input.scene === "rivers" || input.scene === "ridge") {
      return laneTarget(input.files, input.stations, input.nowAvailable, input.activeId, dir);
    }
    return { swallow: true, action: "none" };
  }
  const scene = SCENE_BY_KEY[input.key];
  if (scene && !input.meta && !input.ctrl) {
    if (input.key === "1" || input.enabledScenes.includes(scene)) {
      return { swallow: true, action: "scene", scene };
    }
    return { swallow: true, action: "none" };
  }
  return { swallow: true, action: "none" };
}

export function applyChronicleKeyEvent(
  event: { preventDefault(): void; stopImmediatePropagation(): void },
  action: ChronicleKeyAction,
): boolean {
  if (!action.swallow) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  return true;
}
