import assert from "node:assert/strict";
import { test } from "node:test";

import { dockedValueTicks, valueAxisFrame, valueAxisStep } from "./terrainHud.ts";

test("fullscreen VALUE ruler keeps its toolbar inset", () => {
  const frame = valueAxisFrame(640, false);
  assert.equal(frame.top, 70);
  assert.equal(frame.bottom, 590);
  assert.equal(frame.labelY, 62);
  assert.equal(frame.showTicks, true);
});

test("docked VALUE label sits under the badge and above the bottom chip", () => {
  const frame = valueAxisFrame(110, true);
  assert.equal(frame.labelY, 36);
  assert.ok(frame.labelY > 26, "label clears the corner badge");
  assert.ok(frame.top > frame.labelY);
  assert.ok(frame.bottom <= 110 - 26);
  assert.equal(frame.showTicks, true);
  assert.ok(frame.bottom > frame.top);
});

test("a short docked canvas still places the VALUE label on screen", () => {
  const frame = valueAxisFrame(70, true);
  assert.ok(frame.labelY >= 14);
  assert.ok(frame.labelY <= 70 - 12);
  assert.equal(frame.showTicks, false);
});

test("docked VALUE ticks run from the peak down to zero", () => {
  const ticks = dockedValueTicks(8, 100);
  assert.equal(ticks[0], 100);
  assert.equal(ticks[ticks.length - 1], 0);
  assert.ok(ticks.length >= 2);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] < ticks[i - 1]);
});

test("docked tick step widens when the ruler is short", () => {
  assert.equal(valueAxisStep(4, 200, false), 1);
  assert.equal(valueAxisStep(8, 200, false), 2);
  assert.equal(valueAxisStep(8, 40, true), 4);
  assert.equal(valueAxisStep(4, 30, true), 2);
});
