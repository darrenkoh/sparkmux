import assert from "node:assert/strict";
import { test } from "node:test";
import xtermPkg from "@xterm/xterm";
const { Terminal } = xtermPkg;

import { screenDumpToXterm } from "../api.ts";

test("screenDumpToXterm strips trailing newline before CSI CUP to avoid terminal scroll", async () => {
  const t = new Terminal({ cols: 80, rows: 24 });

  // Simulate a 24-row tmux capture with trailing newline before cursor CUP
  let text = "";
  for (let i = 0; i < 24; i++) {
    text += (i === 5 ? "prompt$ " : "") + "\n";
  }
  text += "\x1b[6;9H"; // tmux cursor at row 5 (0-based), col 8 (0-based) -> CSI CUP 6;9H

  const bytes = new TextEncoder().encode(text);
  const dump = screenDumpToXterm(bytes);

  await new Promise<void>((resolve) => {
    t.write(dump, () => {
      // Must not scroll: baseY must stay 0
      assert.equal(t.buffer.active.baseY, 0, "buffer should not have scrolled up");
      assert.equal(t.buffer.active.cursorY, 5, "cursorY should match prompt line (0-based 5)");
      assert.equal(t.buffer.active.cursorX, 8, "cursorX should match prompt col (0-based 8)");

      const cursorLine = t.buffer.active.getLine(t.buffer.active.baseY + t.buffer.active.cursorY);
      assert.equal(
        cursorLine?.translateToString(true),
        "prompt$ ",
        "cursor should sit on the prompt line, not on an empty row below it",
      );
      resolve();
    });
  });
});

test("screenDumpToXterm handles dump without trailing CSI CUP", () => {
  const bytes = new TextEncoder().encode("line 1\nline 2\n");
  const dump = screenDumpToXterm(bytes);
  assert.equal(dump, "\x1b[H\x1b[2J\x1b[1;1Hline 1\x1b[2;1Hline 2");
});

test("screenDumpToXterm prevents scroll even when lines wrap past terminal width", async () => {
  const t = new Terminal({ cols: 80, rows: 24 });

  // Simulate a dump where line 10 wraps past 80 cols and prompt is at row 23
  let text = "";
  for (let i = 0; i < 24; i++) {
    if (i === 10) text += "W".repeat(120) + "\n";
    else if (i === 23) text += "prompt$ \n";
    else text += `line ${i}\n`;
  }
  text += "\x1b[24;9H";

  const bytes = new TextEncoder().encode(text);
  const dump = screenDumpToXterm(bytes);

  await new Promise<void>((resolve) => {
    t.write(dump, () => {
      assert.equal(t.buffer.active.baseY, 0, "wrapped line must not scroll buffer");
      assert.equal(t.buffer.active.cursorY, 23, "cursorY must be row 23");
      assert.equal(t.buffer.active.cursorX, 8, "cursorX must be col 8");
      resolve();
    });
  });
});

test("bare line feed preserves column position without resetting to column 0", async () => {
  const t = new Terminal({ cols: 80, rows: 24 });
  t.write("\x1b[6;11H> /"); // row 5, col 13 (col 10 + 3 chars)
  await new Promise<void>((resolve) => {
    // Move up, write text (col 13 + 20 + 6 = 39), move down with bare line feeds, and shift back left 26 -> col 13
    t.write("\x1b[2A\x1b[20Cstatus\n\n\x1b[26D", () => {
      assert.equal(t.buffer.active.cursorY, 5, "cursorY should be row 5");
      assert.equal(t.buffer.active.cursorX, 13, "cursorX should return to col 13, not clamped to 0");
      resolve();
    });
  });

  // Verify that with convertEol: true, cursorX would be clamped to 0
  const tCorrupted = new Terminal({ cols: 80, rows: 24, convertEol: true });
  tCorrupted.write("\x1b[6;11H> /");
  await new Promise<void>((resolve) => {
    tCorrupted.write("\x1b[2A\x1b[20Cstatus\n\n\x1b[26D", () => {
      assert.equal(tCorrupted.buffer.active.cursorX, 0, "convertEol: true corrupts cursorX to 0");
      resolve();
    });
  });
});
