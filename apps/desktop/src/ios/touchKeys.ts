/** Bytes the TouchKeyBar sends into a pane. The bar and the tests share this. */

export type ArrowDir = "A" | "B" | "C" | "D";

export function encodeCtrlLetter(ch: string): number | null {
  if (ch.length !== 1) return null;
  const code = ch.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return code - 64;
  return null;
}

export function escBytes(): number[] {
  return [27];
}

export function tabBytes(): number[] {
  return [9];
}

export function shiftTabBytes(): number[] {
  return Array.from(new TextEncoder().encode("\x1b[Z"));
}

export function arrowBytes(dir: ArrowDir, applicationCursor: boolean): number[] {
  const seq = applicationCursor ? `\x1bO${dir}` : `\x1b[${dir}`;
  return Array.from(new TextEncoder().encode(seq));
}

export function textBytes(text: string, altLatched: boolean): number[] {
  const prefix = altLatched ? "\x1b" : "";
  return Array.from(new TextEncoder().encode(prefix + text));
}

export const TMUX_CTRL = {
  interrupt: [3],
  eof: [4],
  suspend: [26],
  clear: [12],
} as const;

export function consumeLatchedModifiers(
  data: string,
  ctrlLatched: boolean,
  altLatched: boolean,
): { text: string; used: boolean } {
  if (!ctrlLatched && !altLatched) return { text: data, used: false };
  let out = data;
  if (ctrlLatched && data.length === 1) {
    const code = encodeCtrlLetter(data);
    if (code !== null) out = String.fromCharCode(code);
  }
  if (altLatched) out = `\x1b${out}`;
  return { text: out, used: true };
}

export const FONT_MIN = 11;
export const FONT_MAX = 22;

export function pinchFontSize(start: number, scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return clampFont(start);
  return clampFont(start * scale);
}

function clampFont(n: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, n));
}

/** Finger moving up produces a positive wheel delta (scroll toward newer lines). */
export function touchDragDelta(previousY: number, currentY: number): number {
  return previousY - currentY;
}

/** Horizontal finger travel that emits one left or right arrow. */
export const TRACKPAD_X_PX = 14;
/** Vertical finger travel that emits one up or down arrow. */
export const TRACKPAD_Y_PX = 22;

export type ModifierPhase = "idle" | "latched" | "locked";

export interface TrackpadStepResult {
  /** Positive is right, negative is left. */
  horizontal: number;
  /** Positive is down, negative is up. */
  vertical: number;
  residualX: number;
  residualY: number;
}

/**
 * Turn finger travel into arrow steps. An exact multiple of the step size
 * leaves a zero residual. Leftover travel stays in the residual for the next move.
 */
export function touchTrackpadSteps(
  deltaX: number,
  deltaY: number,
  residualX = 0,
  residualY = 0,
): TrackpadStepResult {
  const x = residualX + deltaX;
  const y = residualY + deltaY;
  const horizontal = Math.trunc(x / TRACKPAD_X_PX);
  const vertical = Math.trunc(y / TRACKPAD_Y_PX);
  return {
    horizontal,
    vertical,
    residualX: x - horizontal * TRACKPAD_X_PX,
    residualY: y - vertical * TRACKPAD_Y_PX,
  };
}

/** Idle → latched on a tap, latched → locked on a double-tap, locked → idle. */
export function nextModifierPhase(current: ModifierPhase, doubleTap: boolean): ModifierPhase {
  if (current === "locked") return "idle";
  if (current === "latched" && doubleTap) return "locked";
  if (current === "latched") return "idle";
  return "latched";
}

/** A latched modifier clears after one key. A lock stays until it is tapped off. */
export function consumeModifierPhase(phase: ModifierPhase): ModifierPhase {
  return phase === "locked" ? "locked" : "idle";
}

export function trackpadMotionBytes(
  horizontal: number,
  vertical: number,
  applicationCursor: boolean,
  opt: boolean,
): number[] {
  const bytes: number[] = [];
  const across = Math.abs(horizontal);
  if (opt && horizontal !== 0) {
    const word = horizontal > 0 ? "\x1bf" : "\x1bb";
    const encoded = Array.from(new TextEncoder().encode(word));
    for (let i = 0; i < across; i++) bytes.push(...encoded);
  } else if (horizontal !== 0) {
    const dir: ArrowDir = horizontal > 0 ? "C" : "D";
    const one = arrowBytes(dir, applicationCursor);
    for (let i = 0; i < across; i++) bytes.push(...one);
  }
  if (vertical !== 0) {
    const dir: ArrowDir = vertical > 0 ? "B" : "A";
    const one = arrowBytes(dir, applicationCursor);
    for (let i = 0; i < Math.abs(vertical); i++) bytes.push(...one);
  }
  return bytes;
}
