import assert from "node:assert/strict";
import { test } from "node:test";

import { PROMPT_NEWLINE_BYTES, shiftReturnAction, type ReturnKey } from "./promptKeys.ts";

function key(over: Partial<ReturnKey> = {}): ReturnKey {
  return { key: "Enter", shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, ...over };
}

test("Shift+Return starts a new line", () => {
  assert.equal(shiftReturnAction(key()), "newline");
});

test("the new line is ESC CR, never a bare CR that would submit", () => {
  assert.deepEqual([...PROMPT_NEWLINE_BYTES], [0x1b, 0x0d]);
});

test("plain Return is left to the terminal and still submits", () => {
  assert.equal(shiftReturnAction(key({ shiftKey: false })), "pass");
});

test("Shift with another key is left alone", () => {
  assert.equal(shiftReturnAction(key({ key: "a" })), "pass");
  assert.equal(shiftReturnAction(key({ key: "Tab" })), "pass");
});

test("Return with Ctrl, Cmd, or Alt keeps its own meaning", () => {
  assert.equal(shiftReturnAction(key({ ctrlKey: true })), "pass");
  assert.equal(shiftReturnAction(key({ metaKey: true })), "pass");
  assert.equal(shiftReturnAction(key({ altKey: true })), "pass");
});

test("Shift+Return during input-method composition sends nothing", () => {
  assert.equal(shiftReturnAction(key({ isComposing: true })), "swallow");
});
