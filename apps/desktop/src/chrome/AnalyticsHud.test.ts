import assert from "node:assert/strict";
import { test } from "node:test";

import { formatBytes, formatNum, formatMs } from "./analyticsFormat.ts";

test("formatBytes formats small and large bytes correctly", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(1048576 * 3.5), "3.50 MB");
});

test("formatNum formats metric counts with suffixes", () => {
  assert.equal(formatNum(42), "42");
  assert.equal(formatNum(1200), "1.2k");
  assert.equal(formatNum(3500000), "3.50M");
});

test("formatMs formats milliseconds and seconds", () => {
  assert.equal(formatMs(50), "50ms");
  assert.equal(formatMs(1200), "1.2s");
});
