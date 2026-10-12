import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatTimeOffset,
  computeLocalCacheHitRate,
  processTimelineData,
  CHANNELS,
} from "./tokenSpectrumMath.ts";
import type { ActivityPoint } from "../api.ts";

test("formatTimeOffset formats seconds, minutes and hours correctly", () => {
  assert.equal(formatTimeOffset(0), "+00:00");
  assert.equal(formatTimeOffset(45_000), "+00:45");
  assert.equal(formatTimeOffset(125_000), "+02:05");
  assert.equal(formatTimeOffset(3665_000), "+1h01m");
});

test("computeLocalCacheHitRate computes hit rate percentage", () => {
  assert.equal(computeLocalCacheHitRate(0, 0), 0);
  assert.equal(computeLocalCacheHitRate(100, 100), 50);
  assert.equal(computeLocalCacheHitRate(800, 200), 80);
});

test("processTimelineData handles empty timeline with synthetic baseline", () => {
  const buckets = processTimelineData([]);
  assert.equal(buckets.length, 16);
  assert.equal(buckets[0].total, 0);
  assert.equal(buckets[0].cacheHitRate, 0);
});

test("processTimelineData processes real activity points and accumulates stacks", () => {
  const timeline: ActivityPoint[] = [
    {
      timestamp: 1000,
      user_count: 1,
      think_count: 0,
      reply_count: 0,
      tool_count: 0,
      tokens: 600,
      input_tokens: 500,
      output_tokens: 100,
      cache_read_tokens: 200,
      reasoning_tokens: 50,
    },
    {
      timestamp: 61000,
      user_count: 0,
      think_count: 1,
      reply_count: 1,
      tool_count: 0,
      tokens: 300,
      input_tokens: 200,
      output_tokens: 100,
      cache_read_tokens: 800,
      reasoning_tokens: 20,
    },
  ];

  const buckets = processTimelineData(timeline);
  assert.equal(buckets.length, 2);

  // Bucket 0
  assert.equal(buckets[0].timeLabel, "T0");
  assert.equal(buckets[0].cache, 200);
  assert.equal(buckets[0].input, 500);
  assert.equal(buckets[0].reasoning, 50);
  assert.equal(buckets[0].output, 100);
  assert.equal(buckets[0].stackCache, 200);
  assert.equal(buckets[0].stackInput, 700); // 200 + 500
  assert.equal(buckets[0].stackReasoning, 750); // 700 + 50
  assert.equal(buckets[0].stackOutput, 850); // 750 + 100
  assert.ok(Math.abs(buckets[0].cacheHitRate - (200 / 700) * 100) < 0.01);

  // Bucket 1 (offset: 60s)
  assert.equal(buckets[1].timeLabel, "+01:00");
  assert.equal(buckets[1].cache, 800);
  assert.equal(buckets[1].input, 200);
  assert.ok(Math.abs(buckets[1].cacheHitRate - 80) < 0.01);
});

test("CHANNELS definitions contain all 4 channels with colors", () => {
  assert.equal(CHANNELS.length, 4);
  const keys = CHANNELS.map((c) => c.key);
  assert.deepEqual(keys, ["cache", "input", "reasoning", "output"]);
});

test("3D perspective projection projects center point accurately", async () => {
  const { perspective, lookAt, multiply, projectPoint } = await import("./tokenSpectrumMath.ts");
  const proj = perspective((45 * Math.PI) / 180, 1.0, 0.1, 100);
  const view = lookAt([0, 0, 10], [0, 0, 0]);
  const vp = multiply(proj, view);

  const pt = projectPoint(vp, [0, 0, 0], 400, 400);
  assert.ok(pt !== null);
  // Center of 400x400 should be (200, 200)
  assert.ok(Math.abs(pt[0] - 200) < 0.1);
  assert.ok(Math.abs(pt[1] - 200) < 0.1);
});

test("computeContourScanProgress synchronizes scanning sweep across [0, 1)", async () => {
  const { computeContourScanProgress, CONTOUR_SCAN_SPEED } = await import("./tokenSpectrumMath.ts");
  assert.equal(CONTOUR_SCAN_SPEED, 0.22);
  assert.equal(computeContourScanProgress(0), 0);
  // Halfway through a sweep cycle: elapsed = 0.5 / 0.22
  const halfCycleElapsed = 0.5 / CONTOUR_SCAN_SPEED;
  assert.ok(Math.abs(computeContourScanProgress(halfCycleElapsed) - 0.5) < 0.001);
  // Full cycle wrap around
  const fullCycleElapsed = 1.0 / CONTOUR_SCAN_SPEED;
  assert.ok(Math.abs(computeContourScanProgress(fullCycleElapsed)) < 0.001);
});
