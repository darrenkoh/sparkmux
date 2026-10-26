/** Per-client terminal geometry. The top bar and the tests both call this. */

export type MobileSizingMode = "mirror" | "fit-phone";

export const SIZING_MODE_KEY = "sparkmux.mobileSizingMode";

export interface SizingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function defaultSizingMode(isHeadless: boolean): MobileSizingMode {
  return isHeadless ? "fit-phone" : "mirror";
}

export function readSizingMode(storage: SizingStorage, isHeadless: boolean): MobileSizingMode {
  try {
    const raw = storage.getItem(SIZING_MODE_KEY);
    if (raw === "mirror" || raw === "fit-phone") return raw;
  } catch {
    /* private mode */
  }
  return defaultSizingMode(isHeadless);
}

export function writeSizingMode(storage: SizingStorage, mode: MobileSizingMode): void {
  try {
    storage.setItem(SIZING_MODE_KEY, mode);
  } catch {
    /* private mode */
  }
}

/** Desktop always fits the window. A phone in mirror mode keeps the server grid. */
export function shouldFixTerminalSize(
  isTauri: boolean,
  _isHeadless: boolean,
  mode: MobileSizingMode,
): boolean {
  if (isTauri) return false;
  return mode !== "fit-phone";
}

/**
 * Overview scale for a wide desktop pane in mirror mode.
 * A pane that already fits returns 1. A wider pane scales down, never below 0.45.
 */
export function computeOverviewScale(
  paneCols: number,
  cellWidth: number,
  viewportWidth: number,
): number {
  if (!(paneCols > 0) || !(cellWidth > 0) || !(viewportWidth > 0)) return 1;
  const content = paneCols * cellWidth;
  if (content <= viewportWidth) return 1;
  return Math.max(0.45, viewportWidth / content);
}

export interface ForcedResize {
  cols: number;
  rows: number;
  force: true;
}

/** Mirror keeps the server grid. Fit-phone asks the server to resize with force. */
export function resizeForSizingMode(
  mode: MobileSizingMode,
  cols: number,
  rows: number,
): ForcedResize | null {
  if (mode !== "fit-phone") return null;
  return { cols, rows, force: true };
}
