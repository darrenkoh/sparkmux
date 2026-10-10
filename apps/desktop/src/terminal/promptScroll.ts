// Wheel and caret handling for a prompt that already contains typed text.
//
// On the alternate screen xterm turns the wheel into arrow keys. Claude, Grok,
// and similar TUIs treat Up as transcript scroll only while the draft is
// empty; with characters in the prompt, Up edits that draft and the view
// jumps back to it. Page Up / Page Down scroll the transcript and leave the
// draft alone. When the program asked for mouse reports, the wheel is one
// SGR or legacy report instead. Grok Build scrolls its transcript from that.
//
// A seeded xterm often stays on the normal buffer after tmux has already
// entered the alternate screen: the seed is a text dump, not the mode
// sequences. Scrolling that viewport shows nothing. The wheel has to be
// handed to the program.
//
// On the normal buffer the wheel is the terminal's own scrollback. Snapping
// back to the cursor (scroll-on-input, caret resync) cancels a selection.

const ESC = "\x1b";

export interface WheelContext {
  alt: boolean;
  /** xterm.js itself is sending wheel reports (VT200 / drag / any). */
  mouseWheel: boolean;
  /** tmux says this pane is on the alternate screen. */
  paneAlt: boolean;
  /** The program asked tmux for mouse-wheel reports. */
  mouseReport: boolean;
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
  | { kind: "report"; up: boolean }
  | { kind: "arrows"; lines: number }
  | { kind: "passthrough" };

export interface PaneInputMode {
  alternate: boolean;
  mouse: boolean;
  mouseSgr: boolean;
}

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

  // tmux is on the alternate screen, but this xterm was seeded onto the
  // normal buffer and will not turn the wheel into reports or arrow keys.
  if (ctx.paneAlt && !ctx.alt && !ctx.mouseWheel) {
    if (ctx.mouseReport) return { kind: "report", up: lines < 0 };
    if (promptHasDraft(ctx.rows, ctx.cursorY, ctx.cursorX, ctx.cursorLine)) {
      return { kind: "page", lines };
    }
    return { kind: "arrows", lines };
  }

  // Inline sessions (Grok under tmux, a shell) keep the transcript in scrollback.
  // Giving the wheel to the app types into the draft and yanks the viewport down.
  if (!ctx.alt && !ctx.paneAlt && ctx.baseY > 0 && ctx.mouseWheel) {
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

/** One mouse-wheel report. Columns and rows are 1-based, matching SGR and X10. */
export function wheelReport(up: boolean, col: number, row: number, sgr: boolean): number[] {
  const limit = sgr ? 9999 : 223;
  const column = Math.max(1, Math.min(limit, col));
  const line = Math.max(1, Math.min(limit, row));
  if (sgr) {
    const button = up ? 64 : 65;
    return Array.from(new TextEncoder().encode(`\x1b[<${button};${column};${line}M`));
  }
  return [0x1b, 0x5b, 0x4d, (up ? 64 : 65) + 32, column + 32, line + 32];
}

/** Arrow keys for an alternate-screen program that does not take mouse reports. */
export function altScreenArrows(
  up: boolean,
  count: number,
  applicationCursor: boolean,
): number[] {
  const n = Math.min(8, Math.max(1, count));
  const seq = applicationCursor ? (up ? "\x1bOA" : "\x1bOB") : up ? "\x1b[A" : "\x1b[B";
  const one = Array.from(new TextEncoder().encode(seq));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(...one);
  return out;
}
