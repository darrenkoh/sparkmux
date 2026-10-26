/** Portrait bottom-sheet detents. The sheet component and the tests share this. */

export type SheetDetent = "closed" | "peek" | "half" | "full";

export const SHEET_PEEK_PX = 64;
export const SHEET_HALF_RATIO = 0.48;
export const SHEET_FULL_RATIO = 0.86;
/** A release faster than this flings to the next detent. Positive is downward. */
export const SHEET_FLING_PX_PER_MS = 0.4;

const STOPS: readonly SheetDetent[] = ["closed", "peek", "half", "full"];

export function sheetDetentHeight(detent: SheetDetent, viewportHeight: number): number {
  const height = Math.max(0, viewportHeight);
  if (detent === "closed") return 0;
  if (detent === "peek") return SHEET_PEEK_PX;
  if (detent === "half") return height * SHEET_HALF_RATIO;
  return height * SHEET_FULL_RATIO;
}

/**
 * Snap a released sheet. `currentY` is the sheet height in pixels.
 * `velocityY` is px/ms and positive when the finger is moving down.
 */
export function snapSheetDetent(
  currentY: number,
  velocityY: number,
  viewportHeight: number,
): SheetDetent {
  const heights = STOPS.map((name) => sheetDetentHeight(name, viewportHeight));
  let index = 0;
  let best = Infinity;
  for (let i = 0; i < heights.length; i++) {
    const dist = Math.abs(currentY - heights[i]);
    if (dist < best) {
      best = dist;
      index = i;
    }
  }
  if (velocityY > SHEET_FLING_PX_PER_MS) index = Math.max(0, index - 1);
  else if (velocityY < -SHEET_FLING_PX_PER_MS) index = Math.min(STOPS.length - 1, index + 1);
  return STOPS[index];
}

/** Half and peek hide while the software keyboard covers the prompt. */
export function sheetCollapsedByKeyboard(
  detent: SheetDetent,
  keyboardInsetBottom: number,
): boolean {
  return keyboardInsetBottom > 80 && (detent === "half" || detent === "peek");
}
