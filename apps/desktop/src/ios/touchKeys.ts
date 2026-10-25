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
