import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSparklinePaths,
  cpuTone,
  formatCpu,
  formatMemory,
  memoryTone,
} from "./telemetry.ts";

test("memory is shown in MB or GB, and a failed read is a dash", () => {
  assert.equal(formatMemory(null), "—");
  assert.equal(formatMemory(0), "—");
  assert.equal(formatMemory(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatMemory(186 * 1024 * 1024), "186 MB");
  assert.equal(formatMemory(1.5 * 1024 * 1024 * 1024), "1.5 GB");
  assert.equal(formatMemory(12 * 1024 * 1024 * 1024), "12 GB");
});

test("cpu is a percent of one core, and the first sample is unknown", () => {
  assert.equal(formatCpu(null), "CPU —");
  assert.equal(formatCpu(0), "CPU 0%");
  assert.equal(formatCpu(1.2), "CPU 1.2%");
  assert.equal(formatCpu(42.4), "CPU 42%");
  assert.equal(formatCpu(150), "CPU 150%");
  assert.equal(formatCpu(-1), "CPU —");
});

test("cpu and memory tones categorize resource pressure", () => {
  assert.equal(cpuTone(null), "ok");
  assert.equal(cpuTone(15), "ok");
  assert.equal(cpuTone(35), "warn");
  assert.equal(cpuTone(85), "hot");

  assert.equal(memoryTone(null), "ok");
  assert.equal(memoryTone(200 * 1024 * 1024), "ok");
  assert.equal(memoryTone(800 * 1024 * 1024), "warn");
  assert.equal(memoryTone(1500 * 1024 * 1024), "hot");
});

test("sparkline path builder produces svg path strings", () => {
  const empty = buildSparklinePaths([], 30, 10);
  assert.equal(empty.strokePath, "");
  assert.equal(empty.areaPath, "");
  assert.equal(empty.latestPoint, null);

  const res = buildSparklinePaths([10, 50, 90], 30, 10, { minVal: 0, maxVal: 100 });
  assert.ok(res.strokePath.startsWith("M 0.0"));
  assert.ok(res.strokePath.includes("L 30.0"));
  assert.ok(res.areaPath.endsWith("Z"));
  assert.equal(res.latestPoint?.x, 30);
});



