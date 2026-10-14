import assert from "node:assert/strict";
import { test } from "node:test";

import {
  calculatePreservedScrollTop,
  clearedThrough,
  cliLabel,
  emptyOutputText,
  hasNewTopContent,
  markCleared,
  nearOutputBottom,
  outputPaneForTab,
  outputTailKey,
  parseAutoScroll,
  previewLine,
  visibleEntries,
  type ArtifactFeed,
} from "./artifactModel.ts";
import type { Pane } from "../types.ts";

test("previewLine folds newlines and caps a long row", () => {
  assert.equal(previewLine("file starts here\nrest of the file"), "file starts here rest of the file");
  assert.equal(previewLine("abcdef", 4), "abc…");
});

const feed: ArtifactFeed = {
  cli: "grok",
  transcript_path: "/tmp/chat.jsonl",
  file_len: 100,
  entries: [
    { id: "0", offset: 0, kind: "user", label: "You", body: "old" },
    { id: "40", offset: 40, kind: "assistant", label: "Assistant", body: "kept" },
  ],
  error: null,
};

test("clear hides bytes already on disk and keeps later records", () => {
  const cleared = markCleared({}, feed.transcript_path!, 40);
  const through = clearedThrough(cleared, feed.transcript_path, feed.file_len);
  const visible = visibleEntries(feed.entries, through);
  assert.deepEqual(visible.map((entry) => entry.body), ["kept"]);
  assert.equal(emptyOutputText({ ...feed, entries: [] }, 0, through), "Cleared. New replies show up here.");
});

test("a replaced shorter transcript shows its records again", () => {
  const cleared = markCleared({}, "/tmp/chat.jsonl", 500);
  assert.equal(clearedThrough(cleared, "/tmp/chat.jsonl", 20), 0);
});

test("clear does not move the mark backwards", () => {
  const once = markCleared({}, "/tmp/chat.jsonl", 80);
  const twice = markCleared(once, "/tmp/chat.jsonl", 10);
  assert.equal(twice["/tmp/chat.jsonl"], 80);
});

test("auto scroll defaults on and only an explicit off is off", () => {
  assert.equal(parseAutoScroll(null), true);
  assert.equal(parseAutoScroll("1"), true);
  assert.equal(parseAutoScroll(""), true);
  assert.equal(parseAutoScroll("0"), false);
});

test("near the bottom follows, and a scrolled-up list does not", () => {
  assert.equal(nearOutputBottom(1000, 900, 80), true);
  assert.equal(nearOutputBottom(200, 0, 200), true);
  assert.equal(nearOutputBottom(1000, 100, 80), false);
});

test("a longer latest entry is new output even when its id stays", () => {
  const short = [{ id: "40", body: "hel" }];
  const grown = [{ id: "40", body: "hello" }];
  assert.notEqual(outputTailKey(short), outputTailKey(grown));
  assert.equal(outputTailKey(grown), outputTailKey([{ id: "40", body: "hello" }]));
  assert.equal(outputTailKey([]), "0");
});

function pane(id: string, active: boolean): Pane {
  return {
    id,
    index: 0,
    command: "grok-1.0.50",
    path: "/tmp/proj",
    pid: id === "a" ? 11 : 22,
    active,
    width: 80,
    height: 24,
    title: "grok",
    alternate: true,
    mouse: false,
    mouse_drag: false,
    mouse_any: false,
    mouse_sgr: false,
  };
}

test("the output pane is the focused pane of the selected tab", () => {
  const tab = { panes: [pane("a", true), pane("b", false)] };
  assert.equal(outputPaneForTab(tab, "b")?.id, "b");
  assert.equal(outputPaneForTab(tab, "other")?.id, "a");
  assert.equal(outputPaneForTab(tab, null)?.id, "a");
  assert.equal(outputPaneForTab({ panes: [pane("b", false)] }, null)?.id, "b");
  assert.equal(outputPaneForTab(null, "a"), null);
});

test("a shell pane and a missing transcript explain themselves", () => {
  assert.equal(
    emptyOutputText({ ...feed, cli: null, transcript_path: null, entries: [] }, 0, 0),
    "This pane is not running Grok, Claude, or Antigravity.",
  );
  assert.equal(cliLabel("antigravity"), "Antigravity");
  assert.equal(cliLabel("agy"), "Antigravity");
  assert.equal(cliLabel(null), "");
  assert.equal(
    emptyOutputText({ ...feed, transcript_path: null, entries: [] }, 0, 0),
    "No transcript for this pane yet.",
  );
});

test("calculatePreservedScrollTop anchors when scrolled down and stays at top otherwise", () => {
  // Scrolled down (scrollTop = 250), content grew by 80px -> adjust to 330px
  assert.equal(calculatePreservedScrollTop(250, 1000, 1080), 330);

  // At top (scrollTop = 0) -> no adjustment, stays at top
  assert.equal(calculatePreservedScrollTop(0, 1000, 1080), null);

  // Near top subpixel threshold (scrollTop = 1) -> stays at top
  assert.equal(calculatePreservedScrollTop(1, 1000, 1080), null);

  // Scrolled down, but content didn't grow or shrank -> no adjustment
  assert.equal(calculatePreservedScrollTop(250, 1000, 1000), null);
  assert.equal(calculatePreservedScrollTop(250, 1080, 1000), null);
});

test("hasNewTopContent detects prepended entries and updated latest entry body", () => {
  const e1 = { id: "1", offset: 0, kind: "user", label: "You", body: "a" };
  const e2 = { id: "2", offset: 10, kind: "assistant", label: "Assistant", body: "b" };
  const e2Grown = { id: "2", offset: 10, kind: "assistant", label: "Assistant", body: "b+" };
  const e3 = { id: "3", offset: 20, kind: "tool", label: "Tool", body: "c" };

  // New entry added
  assert.equal(hasNewTopContent([e1, e2], [e1, e2, e3]), true);

  // Latest entry grew body text (streaming)
  assert.equal(hasNewTopContent([e1, e2], [e1, e2Grown]), true);

  // Identical entries
  assert.equal(hasNewTopContent([e1, e2], [e1, e2]), false);

  // Empty lists
  assert.equal(hasNewTopContent([], []), false);
  assert.equal(hasNewTopContent([], [e1]), true);
});
