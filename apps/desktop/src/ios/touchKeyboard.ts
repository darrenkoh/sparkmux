import { isMobilePosture, type FormFactorPosture } from "./posture.ts";

export interface TerminalTouch {
  /** Focus xterm's helper textarea. On iOS that opens the software keyboard. */
  focusHelper: boolean;
  /** Blur the composer or helper so a scroll does not keep the keyboard up. */
  dismissKeyboard: boolean;
  /** Move the host so the cursor cell is visible. That fights a scroll-up. */
  revealCursor: boolean;
}

/** Phone and iPad use the composer for typing. The terminal is a scroll surface. */
export function terminalScrollsWithoutKeyboard(posture: FormFactorPosture): boolean {
  return isMobilePosture(posture);
}

export function terminalTouchPolicy(scrollWithoutKeyboard: boolean): TerminalTouch {
  if (scrollWithoutKeyboard) {
    return { focusHelper: false, dismissKeyboard: true, revealCursor: false };
  }
  return { focusHelper: true, dismissKeyboard: false, revealCursor: true };
}

type HelperAttrs = {
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  inputMode?: string;
  readOnly?: boolean;
  disabled?: boolean;
  tabIndex?: number;
};

/**
 * Lines for the local scrollback. Positive moves toward newer lines.
 * The drag does not type into the pane. Finger down (negative px) reveals older lines.
 */
export function localScrollLines(deltaPx: number, rowHeight: number): number {
  if (deltaPx === 0 || !(rowHeight > 0)) return 0;
  const lines = deltaPx / rowHeight;
  if (Math.abs(lines) < 1) return Math.sign(deltaPx);
  return Math.round(lines);
}

/**
 * UIScrollView's normal deceleration, applied per millisecond.
 * A flick keeps moving and slows down. A slow drag stops where the finger lifts.
 */
export const SCROLL_DECAY_PER_MS = 0.998;

/** Below this release speed (px/ms) the coast does not start. */
export const SCROLL_COAST_MIN = 0.08;

export function clampScrollTop(top: number, max: number): number {
  if (!(max > 0) || top <= 0) return 0;
  if (top >= max) return max;
  return top;
}

/** Screen pixels to terminal pixels. `scale` is on-screen height / layout height. */
export function localFingerDelta(screenDelta: number, scale: number): number {
  if (!(scale > 0)) return screenDelta;
  return screenDelta / scale;
}

/**
 * Where the phone canvas sits for a pixel scroll position.
 * `scrollPx` 0 is the top of the history. `maxRows * rowHeight` is the live bottom.
 * xterm only redraws whole rows, so the leftover pixels are a CSS translate of the
 * screen. Callers paint one extra row and clip it, which fills the gap that
 * translate would otherwise leave.
 */
export function placementFromScrollPx(
  scrollPx: number,
  rowHeight: number,
  maxRows: number,
): { ydisp: number; translateY: number } {
  if (!(rowHeight > 0) || !(maxRows > 0)) return { ydisp: 0, translateY: 0 };
  const maxPx = maxRows * rowHeight;
  const px = clampScrollTop(scrollPx, maxPx);
  const fromBottom = maxPx - px;
  const rowsUp = Math.floor(fromBottom / rowHeight);
  const frac = fromBottom - rowsUp * rowHeight;
  if (frac === 0) return { ydisp: maxRows - rowsUp, translateY: 0 };
  const ydisp = maxRows - rowsUp - 1;
  if (ydisp < 0) return { ydisp: 0, translateY: 0 };
  return { ydisp, translateY: -(rowHeight - frac) };
}

/**
 * The phone scroller is on the live screen when its tail is in view.
 * A zero-height scroller has not been laid out yet, so it still follows.
 */
export function phoneScrollFollowsBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  slop = 8,
): boolean {
  if (!(clientHeight > 0) || !(scrollHeight > 0)) return true;
  return scrollTop + clientHeight >= scrollHeight - slop;
}

/** Inverse of `placementFromScrollPx` for the position under the finger. */
export function scrollPxFromPlacement(
  ydisp: number,
  translateY: number,
  rowHeight: number,
  maxRows: number,
): number {
  if (!(rowHeight > 0)) return 0;
  const maxPx = Math.max(0, maxRows) * rowHeight;
  return clampScrollTop(ydisp * rowHeight - translateY, maxPx);
}

/**
 * Viewport scrollTop for a finger still on the glass.
 * One pixel of finger travel moves one pixel of transcript. Finger down
 * (currentY greater than startY) reveals older lines.
 */
export function fingerScrollTop(
  startScroll: number,
  startY: number,
  currentY: number,
  maxScroll: number,
): number {
  return clampScrollTop(startScroll + (startY - currentY), maxScroll);
}

/**
 * ScrollTop velocity in px/ms from recent finger samples.
 * Positive moves toward newer lines (the finger was moving up).
 */
export function touchScrollVelocity(
  samples: { y: number; t: number }[],
  windowMs = 100,
): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = last;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (last.t - samples[i].t > windowMs) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return (first.y - last.y) / dt;
}

/**
 * One coast frame. `velocity` is px/ms. The distance is the integral of
 * exponential decay over `dtMs`, so a stalled frame does not teleport.
 */
export function inertialScrollStep(
  velocityPxPerMs: number,
  dtMs: number,
  decayPerMs = SCROLL_DECAY_PER_MS,
): { deltaPx: number; velocity: number } {
  if (!(dtMs > 0) || velocityPxPerMs === 0 || !(decayPerMs > 0) || decayPerMs >= 1) {
    return { deltaPx: 0, velocity: 0 };
  }
  const dt = Math.min(32, dtMs);
  const factor = Math.pow(decayPerMs, dt);
  const deltaPx = (velocityPxPerMs * (factor - 1)) / Math.log(decayPerMs);
  const velocity = Math.abs(velocityPxPerMs * factor) < 0.01 ? 0 : velocityPxPerMs * factor;
  return { deltaPx, velocity };
}

/**
 * A focused helper opens the iOS keyboard. `inputmode=none` plus `readonly`
 * keeps programmatic focus from summoning it. Desktop typing clears both.
 * The IDL properties are set too: Safari reads those, not only the attributes.
 */
export function quietTerminalHelper(area: HelperAttrs, quiet: boolean): void {
  if (quiet) {
    area.inputMode = "none";
    area.readOnly = true;
    area.disabled = true;
    area.tabIndex = -1;
    area.setAttribute("inputmode", "none");
    area.setAttribute("readonly", "true");
    area.setAttribute("disabled", "true");
    area.setAttribute("tabindex", "-1");
    return;
  }
  area.inputMode = "";
  area.readOnly = false;
  area.disabled = false;
  area.tabIndex = 0;
  area.removeAttribute("inputmode");
  area.removeAttribute("readonly");
  area.removeAttribute("disabled");
  area.setAttribute("tabindex", "0");
}
