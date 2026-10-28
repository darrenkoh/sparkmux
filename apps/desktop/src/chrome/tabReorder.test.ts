import assert from "node:assert/strict";
import { test } from "node:test";

import { dropEdge, orderAfterDrop, windowsInOrder } from "./tabReorder.ts";

const ids = ["@0", "@1", "@2", "@3"];

test("dropEdge splits a row at its midpoint", () => {
  assert.equal(dropEdge(0, 20), "before");
  assert.equal(dropEdge(9, 20), "before");
  assert.equal(dropEdge(10, 20), "after");
  assert.equal(dropEdge(19, 20), "after");
  assert.equal(dropEdge(-1, 20), "before");
  assert.equal(dropEdge(4, 0), "before");
});

test("orderAfterDrop inserts before or after the tab under the pointer", () => {
  assert.deepEqual(orderAfterDrop(ids, "@0", "@2", "before"), ["@1", "@0", "@2", "@3"]);
  assert.deepEqual(orderAfterDrop(ids, "@0", "@2", "after"), ["@1", "@2", "@0", "@3"]);
  assert.deepEqual(orderAfterDrop(ids, "@3", "@1", "before"), ["@0", "@3", "@1", "@2"]);
  assert.deepEqual(orderAfterDrop(ids, "@2", "@0", "after"), ["@0", "@2", "@1", "@3"]);
  assert.deepEqual(orderAfterDrop(ids, "@1", "@0", "before"), ["@1", "@0", "@2", "@3"]);
  assert.deepEqual(orderAfterDrop(ids, "@0", "@3", "after"), ["@1", "@2", "@3", "@0"]);
});

test("orderAfterDrop ignores a drop that is already in place", () => {
  assert.equal(orderAfterDrop(ids, "@0", "@1", "before"), null);
  assert.equal(orderAfterDrop(ids, "@1", "@0", "after"), null);
  assert.equal(orderAfterDrop(ids, "@2", "@2", "before"), null);
  assert.equal(orderAfterDrop(ids, "@9", "@1", "after"), null);
  assert.equal(orderAfterDrop(ids, "@0", "@9", "before"), null);
});

test("windowsInOrder packs indexes from the current base", () => {
  const windows = [
    { id: "@0", index: 1, name: "A" },
    { id: "@1", index: 2, name: "B" },
    { id: "@2", index: 3, name: "C" },
  ];
  const next = windowsInOrder(windows, ["@2", "@0", "@1"]);
  assert.deepEqual(
    next.map((window) => [window.id, window.index, window.name]),
    [
      ["@2", 1, "C"],
      ["@0", 2, "A"],
      ["@1", 3, "B"],
    ],
  );
  assert.equal(windows[0].index, 1);
});
