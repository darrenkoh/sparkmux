import assert from "node:assert/strict";
import { test } from "node:test";
import xtermPkg from "@xterm/xterm";
const { Terminal } = xtermPkg;

import { screenDumpToXterm } from "../api.ts";

test("screenDumpToXterm strips trailing newline before CSI CUP to avoid terminal scroll", async () => {
  const t = new Terminal({ cols: 80, rows: 24, convertEol: true });

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
  assert.equal(dump, "\x1b[H\x1b[2Jline 1\r\nline 2");
});
