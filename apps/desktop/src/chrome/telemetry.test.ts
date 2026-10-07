import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatCpu,
  formatMemory,
  helperStateText,
  helperStatusText,
  modelText,
  type AppTelemetry,
} from "./telemetry.ts";

const on: AppTelemetry = {
  memory_bytes: 186 * 1024 * 1024,
  cpu_percent: 1.2,
  helper_enabled: true,
  model_name: "Qwen2.5-Coder-1.5B-Instruct",
  model_loaded: false,
};

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

test("the status names the model when the helper is on", () => {
  assert.equal(helperStatusText(null), "Helper —");
  assert.equal(helperStatusText({ ...on, helper_enabled: false }), "Helper off");
  assert.equal(helperStatusText(on), "Qwen2.5-Coder-1.5B-Instruct");
  assert.equal(helperStatusText({ ...on, model_loaded: true }), "Qwen2.5-Coder-1.5B-Instruct");
  assert.equal(helperStateText(null), "—");
  assert.equal(helperStateText({ ...on, helper_enabled: false }), "Off");
  assert.equal(helperStateText(on), "On, model not loaded");
  assert.equal(helperStateText({ ...on, model_loaded: true }), "On, model loaded");
  assert.equal(modelText(null), "—");
  assert.equal(modelText(on), "Qwen2.5-Coder-1.5B-Instruct");
  assert.equal(modelText({ ...on, helper_enabled: false }), "Qwen2.5-Coder-1.5B-Instruct");
});
