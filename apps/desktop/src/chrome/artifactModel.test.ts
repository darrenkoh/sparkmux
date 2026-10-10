import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearedThrough,
  emptyOutputText,
  markCleared,
  nearOutputBottom,
  outputTailKey,
  parseAutoScroll,
  visibleEntries,
  type ArtifactFeed,
} from "./artifactModel.ts";

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

test("a shell pane and a missing transcript explain themselves", () => {
  assert.equal(
    emptyOutputText({ ...feed, cli: null, transcript_path: null, entries: [] }, 0, 0),
    "This pane is not running Grok or Claude.",
  );
  assert.equal(
    emptyOutputText({ ...feed, transcript_path: null, entries: [] }, 0, 0),
    "No transcript for this directory yet.",
  );
});
