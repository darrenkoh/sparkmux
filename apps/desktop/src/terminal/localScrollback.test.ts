import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commandHasTranscript,
  filterLocalScrollback,
  independentHistoryLines,
} from "./localScrollback.ts";

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

test("filter keeps ordinary text and color sequences", () => {
  const filtered = filterLocalScrollback(bytes("hi\x1b[31mred\x1b[0m\x1b[2J"));
  assert.equal(text(filtered.out), "hi\x1b[31mred\x1b[0m\x1b[2J");
  assert.equal(filtered.rest.length, 0);
});

test("filter drops alternate-screen switches and erase-scrollback", () => {
  const filtered = filterLocalScrollback(
    bytes("A\x1b[?1049h\x1b[?1049l\x1b[?47h\x1b[?1047l\x1b[3JB"),
  );
  assert.equal(text(filtered.out), "AB");
});

test("filter keeps mouse tracking when it shares a sequence with the alternate screen", () => {
  const filtered = filterLocalScrollback(bytes("\x1b[?1000;1049h"));
  assert.equal(text(filtered.out), "\x1b[?1000h");
});

test("filter holds a sequence cut between chunks", () => {
  const first = filterLocalScrollback(bytes("go\x1b[?104"));
  assert.equal(text(first.out), "go");
  assert.equal(text(first.rest), "\x1b[?104");
  const merged = new Uint8Array(first.rest.length + bytes("9h!").length);
  merged.set(first.rest, 0);
  merged.set(bytes("9h!"), first.rest.length);
  const second = filterLocalScrollback(merged);
  assert.equal(text(second.out), "!");
  assert.equal(second.rest.length, 0);
});

test("independent history is the prompts and replies, oldest first", () => {
  const lines = independentHistoryLines([
    { kind: "user", body: "scroll the phone" },
    { kind: "tool", body: "ignored" },
    { kind: "assistant", body: "done\nnext" },
    { kind: "reasoning", body: "hidden" },
  ]);
  assert.deepEqual(lines, ["— You —", "scroll the phone", "", "— Agent —", "done", "next", ""]);
});

test("independent history strips escapes and keeps the newest lines", () => {
  const lines = independentHistoryLines(
    [
      { kind: "user", body: "one\x1b[2J" },
      { kind: "user", body: "two" },
      { kind: "assistant", body: "three" },
    ],
    5,
  );
  assert.deepEqual(lines, ["two", "", "— Agent —", "three", ""]);
  assert.equal(lines.some((line) => line.includes("[")), false);
});

test("commandHasTranscript matches the agent CLIs", () => {
  assert.equal(commandHasTranscript("grok-1.0.70"), true);
  assert.equal(commandHasTranscript("/opt/homebrew/bin/agy"), true);
  assert.equal(commandHasTranscript("claude"), true);
  assert.equal(commandHasTranscript("zsh"), false);
  assert.equal(commandHasTranscript(""), false);
});
