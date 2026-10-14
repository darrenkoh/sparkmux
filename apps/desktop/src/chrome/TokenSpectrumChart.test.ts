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
  const { buckets, seams } = processTimelineData([]);
  assert.equal(buckets.length, 16);
  assert.equal(seams.length, 0);
  assert.equal(buckets[0].total, 0);
  assert.equal(buckets[0].cacheHitRate, 0);
  assert.equal(buckets[0].xFraction, 0);
  assert.equal(buckets[15].xFraction, 1);
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

  const { buckets, seams } = processTimelineData(timeline);
  assert.equal(seams.length, 0);
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

  // Bucket 1 (offset: 60s). A one-minute gap stays on the real axis.
  assert.equal(buckets[0].xFraction, 0);
  assert.equal(buckets[1].xFraction, 1);
  assert.equal(buckets[1].timeLabel, "+01:00");
  assert.equal(buckets[1].cache, 800);
  assert.equal(buckets[1].input, 200);
  assert.ok(Math.abs(buckets[1].cacheHitRate - 80) < 0.01);
});

function tokenPoint(timestamp: number, tokens: number): ActivityPoint {
  return {
    timestamp,
    user_count: tokens > 0 ? 1 : 0,
    think_count: 0,
    reply_count: 0,
    tool_count: 0,
    tokens,
    input_tokens: tokens,
    output_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
  };
}

test("a gap longer than 5 minutes shrinks on the token spectrum axis", () => {
  const start = 1_000_000;
  const minute = 60_000;
  const burst = 10 * minute;
  const gap = 2 * 60 * minute;
  const timeline: ActivityPoint[] = [];
  for (let t = 0; t <= burst; t += minute) timeline.push(tokenPoint(start + t, 20));
  timeline.push(tokenPoint(start + burst + gap / 2, 0));
  for (let t = 0; t <= burst; t += minute) timeline.push(tokenPoint(start + burst + gap + t, 20));

  const { buckets, seams } = processTimelineData(timeline);
  assert.equal(seams.length, 1);
  assert.equal(seams[0].label, "+2h");
  assert.ok(Math.abs(seams[0].fraction - 11 / 22) < 0.001);

  const before = buckets.find((bucket) => bucket.timestamp === start + burst);
  const idle = buckets.find((bucket) => bucket.timestamp === start + burst + gap / 2);
  const after = buckets.find((bucket) => bucket.timestamp === start + burst + gap);
  assert.ok(before && idle && after);
  assert.ok(Math.abs(before.xFraction - 10 / 22) < 0.001);
  assert.ok(idle.xFraction > before.xFraction && idle.xFraction < after.xFraction);
  assert.ok(Math.abs(after.xFraction - 12 / 22) < 0.001);
  assert.ok(after.xFraction - before.xFraction < (gap / (burst + gap + burst)) * 0.5);
});

test("a token spike with no map events stays an anchor on the spectrum axis", () => {
  const start = 1_000_000;
  const minute = 60_000;
  const spikeAt = start + 6 * minute;
  const end = spikeAt + 2 * 60 * minute;
  const timeline: ActivityPoint[] = [
    tokenPoint(start, 20),
    {
      timestamp: spikeAt,
      user_count: 0,
      think_count: 0,
      reply_count: 0,
      tool_count: 0,
      tokens: 40,
      input_tokens: 40,
    },
    tokenPoint(end, 20),
  ];

  const { buckets, seams } = processTimelineData(timeline);
  const spike = buckets.find((bucket) => bucket.timestamp === spikeAt);
  assert.ok(spike);
  assert.equal(seams.length, 2);
  assert.ok(Math.abs(spike.xFraction - 0.5) < 0.001);
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
