import assert from "node:assert/strict";
import { test } from "node:test";
import xtermPkg from "@xterm/xterm";
const { Terminal } = xtermPkg;

import { applyPaneSeed, parsePaneSeed, withExtraHistory } from "./paneSeed.ts";

function seedBytes(history: string[], visible: string): Uint8Array {
  if (history.length === 0) return new TextEncoder().encode(visible);
  const body = `\x1ehistory:${history.length}\n${history.join("\n")}\n${visible}`;
  return new TextEncoder().encode(body);
}

function lineText(term: InstanceType<typeof Terminal>, index: number): string {
  return term.buffer.active.getLine(index)?.translateToString(true) ?? "";
}

test("parsePaneSeed leaves a visible-only seed untouched", () => {
  const bytes = new TextEncoder().encode("prompt$\n\x1b[1;8H");
  const parsed = parsePaneSeed(bytes);
  assert.deepEqual(parsed.history, []);
  assert.deepEqual(parsed.visible, bytes);
});

test("parsePaneSeed splits a counted history prefix", () => {
  const parsed = parsePaneSeed(seedBytes(["h1", "h2"], "vis\x1b[1;1H"));
  assert.deepEqual(parsed.history, ["h1", "h2"]);
  assert.equal(new TextDecoder().decode(parsed.visible), "vis\x1b[1;1H");
});

test("withExtraHistory puts phone lines above tmux history and keeps the screen", () => {
  const merged = withExtraHistory(seedBytes(["tmux"], "vis\x1b[1;1H"), ["You said", ""]);
  const parsed = parsePaneSeed(merged);
  assert.deepEqual(parsed.history, ["You said", "", "tmux"]);
  assert.equal(new TextDecoder().decode(parsed.visible), "vis\x1b[1;1H");
  assert.deepEqual(withExtraHistory(seedBytes([], "only"), []), seedBytes([], "only"));
});

test("parsePaneSeed rejects a truncated history prefix", () => {
  const bytes = new TextEncoder().encode("\x1ehistory:3\nonly-one\n");
  const parsed = parsePaneSeed(bytes);
  assert.deepEqual(parsed.history, []);
  assert.deepEqual(parsed.visible, bytes);
});

test("applyPaneSeed scrolls history and keeps the visible cursor", async () => {
  const term = new Terminal({ cols: 40, rows: 6, scrollback: 5000 });
  const history = ["one", "two", "W".repeat(40), ""];
  const visible = `prompt$\n${"\n".repeat(5)}\x1b[1;8H`;
  let sawHistory = false;
  await new Promise<void>((resolve) => {
    applyPaneSeed(
      term,
      seedBytes(history, visible),
      () => resolve(),
      () => {
        sawHistory = true;
      },
    );
  });

  assert.equal(sawHistory, true);
  assert.equal(term.rows, 6);
  assert.equal(term.cols, 40);
  assert.equal(term.options.windowsMode, false);
  assert.equal(term.buffer.active.baseY, history.length);
  assert.equal(term.buffer.active.viewportY, history.length);
  assert.equal(lineText(term, 0), "one");
  assert.equal(lineText(term, 1), "two");
  assert.equal(lineText(term, 2), "W".repeat(40));
  assert.equal(lineText(term, 3), "");
  assert.equal(lineText(term, term.buffer.active.baseY), "prompt$");
  assert.equal(term.buffer.active.cursorY, 0);
  assert.equal(term.buffer.active.cursorX, 7);
});

test("applyPaneSeed keeps a wrapped history row", async () => {
  const term = new Terminal({ cols: 10, rows: 4, scrollback: 50 });
  await new Promise<void>((resolve) => {
    applyPaneSeed(term, seedBytes(["W".repeat(25), "tail"], "ok\x1b[1;3H"), resolve);
  });
  assert.equal(lineText(term, 0), "W".repeat(10));
  assert.equal(lineText(term, 1), "W".repeat(10));
  assert.equal(lineText(term, 2), "WWWWW");
  assert.equal(lineText(term, 3), "tail");
  assert.equal(term.buffer.active.baseY, 4);
  assert.equal(lineText(term, term.buffer.active.baseY), "ok");
  assert.equal(term.buffer.active.cursorX, 2);
});

test("applyPaneSeed with no history does not scroll", async () => {
  const term = new Terminal({ cols: 40, rows: 6, scrollback: 5000 });
  await new Promise<void>((resolve) => {
    applyPaneSeed(term, seedBytes([], "prompt$\n\x1b[1;8H"), resolve);
  });
  assert.equal(term.buffer.active.baseY, 0);
  assert.equal(term.rows, 6);
  assert.equal(lineText(term, 0), "prompt$");
  assert.equal(term.buffer.active.cursorY, 0);
  assert.equal(term.buffer.active.cursorX, 7);
});

test("applyPaneSeed keeps SGR text in scrollback", async () => {
  const term = new Terminal({ cols: 20, rows: 4, scrollback: 20 });
  await new Promise<void>((resolve) => {
    applyPaneSeed(term, seedBytes(["\x1b[31mred\x1b[0m"], "ok\x1b[1;1H"), resolve);
  });
  assert.equal(lineText(term, 0), "red");
  assert.equal(lineText(term, term.buffer.active.baseY), "ok");
});

test("overlapping applyPaneSeed calls preserve full height and render the latest seed cleanly", async () => {
  const term = new Terminal({ cols: 40, rows: 6, scrollback: 5000 });
  const firstHistory = ["stale-1", "stale-2", "stale-3"];
  const firstVisible = "stale-row-1\nstale-row-2\nstale-row-3\nstale-row-4\nstale-row-5\nstale-row-6\x1b[6;12H";
  const secondHistory = ["claude-hist-1", "claude-hist-2"];
  const secondVisible =
    "header-line\nstatus-line\nbody-line-1\nbody-line-2\nprompt > hi\nfooter-line\x1b[5;12H";

  await new Promise<void>((resolve) => {
    applyPaneSeed(term, seedBytes(firstHistory, firstVisible), () => {});
    // While the first seed is still in flight in WriteBuffer, term.rows is 1.
    assert.equal(term.rows, 1);
    applyPaneSeed(term, seedBytes(secondHistory, secondVisible), () => resolve());
  });

  assert.equal(term.rows, 6);
  assert.equal(term.cols, 40);
  assert.equal(term.options.windowsMode, false);
  assert.equal(term.buffer.active.baseY, secondHistory.length);
  assert.equal(term.buffer.active.viewportY, secondHistory.length);
  assert.equal(lineText(term, 0), "claude-hist-1");
  assert.equal(lineText(term, 1), "claude-hist-2");
  const base = term.buffer.active.baseY;
  assert.equal(lineText(term, base + 0), "header-line");
  assert.equal(lineText(term, base + 1), "status-line");
  assert.equal(lineText(term, base + 2), "body-line-1");
  assert.equal(lineText(term, base + 3), "body-line-2");
  assert.equal(lineText(term, base + 4), "prompt > hi");
  assert.equal(lineText(term, base + 5), "footer-line");
  assert.equal(term.buffer.active.cursorY, 4);
  assert.equal(term.buffer.active.cursorX, 11);
});
