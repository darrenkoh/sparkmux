// Wheel and caret handling for a prompt that already contains typed text.
//
// On the alternate screen xterm turns the wheel into arrow keys. Claude, Grok,
// and similar TUIs treat Up as transcript scroll only while the draft is
// empty; with characters in the prompt, Up edits that draft and the view
// jumps back to it. Page Up / Page Down scroll the transcript and leave the
// draft alone.
//
// On the normal buffer the wheel is the terminal's own scrollback. Snapping
// back to the cursor (scroll-on-input, caret resync) cancels a selection.

const ESC = "\x1b";

export interface WheelContext {
  alt: boolean;
  /** Application asked for wheel reports (VT200 / drag / any). */
  mouseWheel: boolean;
  /** Scrollback lines above the live screen. */
  baseY: number;
  rows: number;
  /** Cursor row, 0-based, within the live screen. */
  cursorY: number;
  cursorX: number;
  /** Cursor row text. Trailing spaces may be included. */
  cursorLine: string;
  deltaY: number;
  /** WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  shiftKey: boolean;
  rowHeight: number;
}

export type WheelDecision =
  | { kind: "scroll"; lines: number }
  | { kind: "page"; lines: number }
  | { kind: "passthrough" };

export function viewportAtBottom(viewportY: number, baseY: number): boolean {
  return viewportY >= baseY;
}

/** Printable input and editing keys. Escape sequences (arrows, mouse) do not. */
export function inputFollowsPrompt(data: string): boolean {
  return data.length > 0 && !data.includes(ESC);
}

/**
 * True when the cursor is in the bottom band and there is typed text before it.
 * A bare prompt marker (`>`, `❯`, `$`) does not count. A cursor higher on the
 * screen is an editor, not the composer.
 */
export function promptHasDraft(
  rows: number,
  cursorY: number,
  cursorX: number,
  cursorLine: string,
): boolean {
  if (rows <= 0 || cursorY < rows - 8) return false;
  const before = cursorLine.slice(0, Math.max(0, cursorX));
  const body = before.replace(/^[\s❯›>$%#λ│┃▌]+/, "").trim();
  return body.length > 0;
}

export function wheelLineCount(
  deltaY: number,
  deltaMode: number,
  rowHeight: number,
  rows: number,
): number {
  if (deltaY === 0) return 0;
  let amount = deltaY;
  if (deltaMode === 1) {
    // already in lines
  } else if (deltaMode === 2) {
    amount *= Math.max(1, rows);
  } else {
    amount /= Math.max(1, rowHeight);
  }
  if (Math.abs(amount) < 1) return Math.sign(amount);
  return Math.round(amount);
}

export function decideWheel(ctx: WheelContext): WheelDecision {
  if (ctx.shiftKey || ctx.deltaY === 0) return { kind: "passthrough" };
  const lines = wheelLineCount(ctx.deltaY, ctx.deltaMode, ctx.rowHeight, ctx.rows);
  if (lines === 0) return { kind: "passthrough" };

  // Inline sessions (Grok under tmux, a shell) keep the transcript in scrollback.
  // Giving the wheel to the app types into the draft and yanks the viewport down.
  if (!ctx.alt && ctx.baseY > 0 && ctx.mouseWheel) {
    return { kind: "scroll", lines };
  }

  if (
    ctx.alt &&
    !ctx.mouseWheel &&
    promptHasDraft(ctx.rows, ctx.cursorY, ctx.cursorX, ctx.cursorLine)
  ) {
    // Negative lines scroll toward older output (Page Up).
    return { kind: "page", lines };
  }

  return { kind: "passthrough" };
}
