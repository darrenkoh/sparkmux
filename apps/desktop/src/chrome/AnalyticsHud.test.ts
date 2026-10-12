import assert from "node:assert/strict";
import { test } from "node:test";

import { formatBytes, formatNum, formatMs, formatUsd, estimateCost } from "./analyticsFormat.ts";

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

test("formatUsd formats dollar values correctly", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.004), "< $0.01");
  assert.equal(formatUsd(0.143), "$0.14");
  assert.equal(formatUsd(2.5), "$2.50");
});

test("estimateCost computes cost for standard and light models", () => {
  const standardCost = estimateCost("claude-3-5-sonnet", 10_000, 2_000, 50_000);
  // (10000 / 1M) * 3 + (2000 / 1M) * 15 + (50000 / 1M) * 0.3 = 0.03 + 0.03 + 0.015 = 0.075
  assert.ok(Math.abs(standardCost - 0.075) < 0.0001);

  const flashCost = estimateCost("gemini-2.0-flash", 100_000, 10_000, 200_000);
  // (100k / 1M) * 0.25 + (10k / 1M) * 1.25 + (200k / 1M) * 0.03 = 0.025 + 0.0125 + 0.006 = 0.0435
  assert.ok(Math.abs(flashCost - 0.0435) < 0.0001);
});
