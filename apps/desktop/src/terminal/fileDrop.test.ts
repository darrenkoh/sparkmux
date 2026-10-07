import assert from "node:assert/strict";
import { test } from "node:test";

import {
  charBeforeCursor,
  clientPointFromDrop,
  formatDroppedPaths,
  insertDroppedPaths,
  paneIdFromHit,
  type CursorBuffer,
  type PathInserter,
} from "./fileDrop.ts";

test("a plain path is pasted as itself with a trailing space", () => {
  assert.equal(
    formatDroppedPaths(["/Users/me/github/sparkmux/README.md"]),
    "/Users/me/github/sparkmux/README.md ",
  );
});

test("unicode in a path stays literal", () => {
  assert.equal(formatDroppedPaths(["/tmp/文档/笔记.ts"]), "/tmp/文档/笔记.ts ");
});

test("spaces and shell metacharacters are single-quoted", () => {
  assert.equal(formatDroppedPaths(["/Users/me/My File.txt"]), "'/Users/me/My File.txt' ");
  assert.equal(formatDroppedPaths(["/tmp/$HOME"]), "'/tmp/$HOME' ");
  assert.equal(formatDroppedPaths(["/tmp/a*.ts"]), "'/tmp/a*.ts' ");
  assert.equal(formatDroppedPaths(["/tmp/it's.txt"]), "'/tmp/it'\\''s.txt' ");
});

test("several files are separated by spaces and a word before the cursor is too", () => {
  assert.equal(formatDroppedPaths(["/tmp/a.ts", "/tmp/b.ts"]), "/tmp/a.ts /tmp/b.ts ");
  assert.equal(formatDroppedPaths(["/tmp/a.ts"], "t"), " /tmp/a.ts ");
  assert.equal(formatDroppedPaths(["/tmp/a.ts"], " "), "/tmp/a.ts ");
  assert.equal(formatDroppedPaths(["/tmp/a.ts"], ">"), " /tmp/a.ts ");
});

test("a newline or escape in a name is not pasted and does not press Enter", () => {
  assert.equal(formatDroppedPaths(["/tmp/a\nrm -rf /"]), null);
  assert.equal(formatDroppedPaths(["/tmp/a\r"]), null);
  assert.equal(formatDroppedPaths(["/tmp/ok\x1b[A"]), null);
  assert.equal(formatDroppedPaths(["/tmp/ok", "/tmp/bad\nname"]), "/tmp/ok ");
  const text = formatDroppedPaths(["/tmp/a.ts", "/tmp/my file.ts"])!;
  assert.equal(text.includes("\n"), false);
  assert.equal(text.includes("\r"), false);
  assert.equal(text, "/tmp/a.ts '/tmp/my file.ts' ");
});

test("relative names and empty drops are ignored", () => {
  assert.equal(formatDroppedPaths(["notes.txt", "", "  "]), null);
  assert.equal(formatDroppedPaths(["notes.txt", "/tmp/ok"]), "/tmp/ok ");
});

test("the paste is capped and still does not submit the prompt", () => {
  const many = Array.from({ length: 70 }, (_, i) => `/tmp/f${i}`);
  const text = formatDroppedPaths(many)!;
  assert.equal(text.split(" ").filter(Boolean).length, 64);
  assert.equal(text.endsWith(" "), true);
  assert.equal(text.includes("\n"), false);
  assert.equal(formatDroppedPaths([`/${"a".repeat(5000)}`]), null);
});

test("insert pastes the path at the prompt and clears a selection", () => {
  const calls: string[] = [];
  const term: PathInserter = {
    paste: (text) => calls.push(`paste:${text}`),
    scrollToBottom: () => calls.push("scroll"),
    focus: () => calls.push("focus"),
    clearSelection: () => calls.push("clear"),
  };
  assert.equal(insertDroppedPaths(term, ["/tmp/a.ts"], null), true);
  assert.deepEqual(calls, ["clear", "scroll", "focus", "paste:/tmp/a.ts "]);
  assert.equal(insertDroppedPaths(term, ["notes.txt"], null), false);
});

test("drop coordinates stay in CSS pixels unless they are outside the viewport", () => {
  const view = { width: 1200, height: 800, devicePixelRatio: 2 };
  assert.deepEqual(clientPointFromDrop({ x: 100, y: 80 }, view), { x: 100, y: 80 });
  assert.deepEqual(clientPointFromDrop({ x: 2000, y: 1000 }, view), { x: 1000, y: 500 });
  assert.deepEqual(
    clientPointFromDrop({ x: 100, y: 80 }, { width: 1200, height: 800, devicePixelRatio: 1 }),
    { x: 100, y: 80 },
  );
});

test("only a pane id under the pointer accepts the drop", () => {
  const pane = hit("%3");
  assert.equal(paneIdFromHit(pane), "%3");
  assert.equal(
    paneIdFromHit({
      closest: () => pane,
    }),
    "%3",
  );
  assert.equal(paneIdFromHit({ closest: () => null }), null);
  assert.equal(paneIdFromHit(hit("%")), null);
  assert.equal(paneIdFromHit(hit("3")), null);
  assert.equal(paneIdFromHit(hit("%x")), null);
  assert.equal(paneIdFromHit(null), null);
});

test("the cell before a wrapped cursor is the end of the previous line", () => {
  const lines = new Map<number, { text: string; wrapped: boolean }>([
    [4, { text: "hello", wrapped: false }],
    [5, { text: "world", wrapped: true }],
  ]);
  const buffer: CursorBuffer = {
    cursorX: 0,
    cursorY: 1,
    baseY: 4,
    getLine(y) {
      const row = lines.get(y);
      if (!row) return null;
      return {
        isWrapped: row.wrapped,
        length: row.text.length,
        translateToString(_trim, start = 0, end = row.text.length) {
          return row.text.slice(start, end);
        },
      };
    },
  };
  assert.equal(charBeforeCursor(buffer), "o");
  buffer.cursorX = 3;
  buffer.cursorY = 0;
  assert.equal(charBeforeCursor(buffer), "l");
});

function hit(id: string) {
  return {
    closest(selector: string) {
      return selector === "[data-pane-id]" ? this : null;
    },
    getAttribute(name: string) {
      return name === "data-pane-id" ? id : null;
    },
  };
}
