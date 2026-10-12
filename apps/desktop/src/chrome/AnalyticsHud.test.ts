import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatBytes,
  formatNum,
  formatMs,
  formatUsd,
  estimateCost,
  estimateTotalCost,
  getModelPricing,
} from "./analyticsFormat.ts";

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

test("estimateCost accurately calculates Claude Haiku 4.5 pricing", () => {
  const pricing = getModelPricing("claude-haiku-4-5-20251001");
  assert.equal(pricing.inRate, 1.0);
  assert.equal(pricing.outRate, 5.0);
  assert.equal(pricing.cacheReadRate, 0.1);
  assert.equal(pricing.cacheWriteRate, 1.25);

  // Haiku 4.5 with 803 in, 23 out, 12M cache read, 600k cache write
  const haikuCost = estimateCost("claude-haiku-4-5-20251001", 803, 23, 12_000_000, 600_000);
  // 803/1e6*1 + 23/1e6*5 + 12*0.1 + 0.6*1.25 = 0.000803 + 0.000115 + 1.20 + 0.75 = 1.9509
  assert.ok(Math.abs(haikuCost - 1.950918) < 0.001);
});

test("estimateTotalCost calculates cost per model breakdown", () => {
  const models = [
    {
      model: "claude-haiku-4-5-20251001",
      input_tokens: 803,
      output_tokens: 23,
      cache_read_tokens: 12_000_000,
      cache_write_tokens: 600_000,
    },
  ];
  const totalCost = estimateTotalCost(models, "claude-haiku-4-5", 803, 23, 12_000_000, 600_000);
  assert.ok(Math.abs(totalCost - 1.950918) < 0.001);
});

