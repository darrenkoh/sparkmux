import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatBytes,
  formatNum,
  formatMs,
  formatDuration,
  formatUsd,
  estimateCost,
  estimateTotalCost,
  estimateCostSavings,
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

test("formatDuration reads as a clock span", () => {
  assert.equal(formatDuration(50), "50ms");
  assert.equal(formatDuration(10530), "11s");
  assert.equal(formatDuration(113540), "1m 54s");
  assert.equal(formatDuration(3_600_000), "1h");
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

test("estimateCost accurately calculates Grok 4.7 pricing matching /usage ticks", () => {
  const pricing47 = getModelPricing("grok-4.7-build");
  assert.equal(pricing47.inRate, 0.68);
  assert.equal(pricing47.outRate, 2.04);
  assert.equal(pricing47.cacheReadRate, 0.17);
  assert.equal(pricing47.cacheWriteRate, 0.68);

  // Exact real Grok session: 275,458 uncached input, 8,007,040 cached read, 104,402 output
  // costUsdTicks = 17,614,883,200 ($1.76148832)
  const grokCost = estimateCost("grok-4.7-build", 275_458, 104_402, 8_007_040);
  assert.ok(Math.abs(grokCost - 1.761488) < 0.0001);

  const pricing46 = getModelPricing("grok-4.6-build");
  assert.equal(pricing46.inRate, 1.36);
  assert.equal(pricing46.outRate, 4.08);
  assert.equal(pricing46.cacheReadRate, 0.34);
});

test("estimateCostSavings computes prompt caching discount correctly", () => {
  // Claude 3.5 Sonnet: inRate $3.00, cacheReadRate $0.30 -> discount is $2.70 per 1M tokens
  const savings = estimateCostSavings(undefined, "claude-3-5-sonnet", 1_000_000);
  assert.ok(Math.abs(savings - 2.70) < 0.0001);

  // With explicit models array: Haiku 4.5 inRate $1.00, cacheRead $0.10 -> discount is $0.90 per 1M tokens
  const models = [
    {
      model: "claude-haiku-4-5",
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 2_000_000,
    },
  ];
  const modelSavings = estimateCostSavings(models, undefined, 0);
  assert.ok(Math.abs(modelSavings - 1.80) < 0.0001);
});


