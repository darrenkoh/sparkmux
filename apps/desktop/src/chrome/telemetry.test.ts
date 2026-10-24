import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCpu, formatMemory } from "./telemetry.ts";

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


