import assert from "node:assert/strict";
import { test } from "node:test";

import { findNext, findPrevious, findScrollback, matchLineColumn } from "./scrollbackSearch.ts";

const SCROLLBACK = "boot\ncompiling crate\nNEEDLE in the middle\nmore output\nneedle again\n";

test("findScrollback finds a needle in pane scrollback text", () => {
  const hit = findScrollback(SCROLLBACK, "needle");
  assert.ok(hit);
  assert.equal(SCROLLBACK.slice(hit.index, hit.index + hit.length).toLowerCase(), "needle");
  const next = findScrollback(SCROLLBACK, "needle", hit.index + 1);
  assert.ok(next);
  assert.ok(next.index > hit.index);
  assert.equal(findScrollback(SCROLLBACK, "missing"), null);
  assert.equal(findScrollback(SCROLLBACK, ""), null);
  assert.deepEqual(matchLineColumn(SCROLLBACK, hit.index), { line: 2, column: 0 });
});

test("findNext wraps and findPrevious walks backward", () => {
  const first = findScrollback(SCROLLBACK, "needle");
  assert.ok(first);
  const second = findNext(SCROLLBACK, "needle", first.index + 1);
  assert.ok(second);
  const wrapped = findNext(SCROLLBACK, "needle", second.index + 1);
  assert.equal(wrapped?.index, first.index);
  const back = findPrevious(SCROLLBACK, "needle", second.index);
  assert.equal(back?.index, first.index);
});
