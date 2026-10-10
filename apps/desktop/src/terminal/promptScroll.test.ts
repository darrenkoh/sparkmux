import assert from "node:assert/strict";
import { test } from "node:test";

import {
  altScreenArrows,
  decideWheel,
  inputFollowsPrompt,
  promptHasDraft,
  viewportAtBottom,
  wheelLineCount,
  wheelReport,
  type WheelContext,
} from "./promptScroll.ts";

const ESC = "\x1b";

function wheel(over: Partial<WheelContext> = {}): WheelContext {
  return {
    alt: false,
    mouseWheel: false,
    paneAlt: false,
    mouseReport: false,
    baseY: 20,
    rows: 40,
    cursorY: 39,
    cursorX: 2,
    cursorLine: "> ",
    deltaY: -120,
    deltaMode: 0,
    shiftKey: false,
    rowHeight: 20,
    ...over,
  };
}

test("viewport is at the bottom only when it has not moved up", () => {
  assert.equal(viewportAtBottom(10, 10), true);
  assert.equal(viewportAtBottom(4, 10), false);
});

test("typed text follows the prompt and mouse or arrow reports do not", () => {
  assert.equal(inputFollowsPrompt("a"), true);
  assert.equal(inputFollowsPrompt("hi"), true);
  assert.equal(inputFollowsPrompt("\r"), true);
  assert.equal(inputFollowsPrompt("\x7f"), true);
  assert.equal(inputFollowsPrompt(`${ESC}[A`), false);
  assert.equal(inputFollowsPrompt(`${ESC}[<64;1;1M`), false);
  assert.equal(inputFollowsPrompt(`${ESC}[I`), false);
  assert.equal(inputFollowsPrompt(""), false);
});

test("a draft is typed text on a bottom row, not a bare prompt", () => {
  assert.equal(promptHasDraft(40, 39, 2, "> "), false);
  assert.equal(promptHasDraft(40, 39, 4, "> hi"), true);
  assert.equal(promptHasDraft(40, 39, 7, "❯ hello"), true);
  assert.equal(promptHasDraft(40, 39, 5, "hello"), true);
  assert.equal(promptHasDraft(40, 39, 2, "% "), false);
  assert.equal(promptHasDraft(40, 39, 4, "% ls"), true);
  assert.equal(promptHasDraft(40, 10, 8, "    return"), false);
});

test("pixel wheel deltas become lines", () => {
  assert.equal(wheelLineCount(-120, 0, 20, 40), -6);
  assert.equal(wheelLineCount(10, 0, 20, 40), 1);
  assert.equal(wheelLineCount(-3, 1, 20, 40), -3);
  assert.equal(wheelLineCount(1, 2, 20, 40), 40);
  assert.equal(wheelLineCount(0, 0, 20, 40), 0);
});

test("mouse wheel on inline scrollback stays in the terminal", () => {
  const decision = decideWheel(wheel({ mouseWheel: true, deltaY: -40 }));
  assert.deepEqual(decision, { kind: "scroll", lines: -2 });
});

test("inline scrollback without mouse tracking keeps xterm's own wheel", () => {
  assert.equal(decideWheel(wheel()).kind, "passthrough");
});

test("shift wheel is left to xterm", () => {
  assert.equal(decideWheel(wheel({ shiftKey: true, mouseWheel: true })).kind, "passthrough");
});

test("alternate screen with an empty prompt still passes the wheel through", () => {
  const decision = decideWheel(
    wheel({ alt: true, baseY: 0, cursorLine: "> ", cursorX: 2 }),
  );
  assert.equal(decision.kind, "passthrough");
});

test("alternate screen with a draft scrolls by page, not arrows", () => {
  const decision = decideWheel(
    wheel({ alt: true, baseY: 0, cursorLine: "> hello", cursorX: 7, deltaY: -48 }),
  );
  assert.deepEqual(decision, { kind: "page", lines: -2 });
});

test("alternate screen draft scrolling down is a positive page", () => {
  const decision = decideWheel(
    wheel({ alt: true, baseY: 0, cursorLine: "❯ x", cursorX: 3, deltaY: 80 }),
  );
  assert.deepEqual(decision, { kind: "page", lines: 4 });
});

test("alternate screen mouse tracking keeps the app's wheel reports", () => {
  const decision = decideWheel(
    wheel({ alt: true, mouseWheel: true, baseY: 0, cursorLine: "> hello", cursorX: 7 }),
  );
  assert.equal(decision.kind, "passthrough");
});

test("tmux alternate screen with mouse reports is not local scrollback", () => {
  const decision = decideWheel(
    wheel({
      paneAlt: true,
      mouseReport: true,
      alt: false,
      mouseWheel: false,
      baseY: 4,
      cursorLine: "> hello",
      cursorX: 7,
    }),
  );
  assert.deepEqual(decision, { kind: "report", up: true });
});

test("tmux alternate screen without mouse sends arrows, not a viewport scroll", () => {
  const decision = decideWheel(
    wheel({ paneAlt: true, alt: false, mouseWheel: false, baseY: 4, cursorLine: "> ", cursorX: 2 }),
  );
  assert.deepEqual(decision, { kind: "arrows", lines: -6 });
});

test("tmux alternate screen with a draft and no mouse still pages", () => {
  const decision = decideWheel(
    wheel({
      paneAlt: true,
      alt: false,
      baseY: 0,
      cursorLine: "> hello",
      cursorX: 7,
      deltaY: -48,
    }),
  );
  assert.deepEqual(decision, { kind: "page", lines: -2 });
});

test("wheel reports are one SGR or X10 sequence", () => {
  assert.deepEqual(
    wheelReport(true, 12, 4, true),
    Array.from(new TextEncoder().encode("\x1b[<64;12;4M")),
  );
  assert.deepEqual(
    wheelReport(false, 3, 9, true),
    Array.from(new TextEncoder().encode("\x1b[<65;3;9M")),
  );
  assert.deepEqual(wheelReport(true, 2, 5, false), [0x1b, 0x5b, 0x4d, 96, 34, 37]);
  assert.deepEqual(wheelReport(false, 0, 400, false), [0x1b, 0x5b, 0x4d, 97, 33, 255]);
});

test("alternate-screen arrows repeat and stay within a short burst", () => {
  const up = altScreenArrows(true, 2, false);
  assert.equal(new TextDecoder().decode(new Uint8Array(up)), "\x1b[A\x1b[A");
  assert.equal(altScreenArrows(false, 1, true).length, 3);
  assert.equal(altScreenArrows(true, 40, false).length, 8 * 3);
});
