import assert from "node:assert/strict";
import { test } from "node:test";

import { cursorCup } from "./cursorCup.ts";

test("cursorCup is one-based CSI CUP", () => {
  assert.equal(cursorCup(0, 0), "\x1b[1;1H");
  assert.equal(cursorCup(3, 10), "\x1b[4;11H");
});

test("cursorCup clamps negative cells", () => {
  assert.equal(cursorCup(-1, -4), "\x1b[1;1H");
});
