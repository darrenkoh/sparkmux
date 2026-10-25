import assert from "node:assert/strict";
import { test } from "node:test";

import { placeDockedNodeLabels, valueAxisFrame, valueAxisStep } from "./terrainHud.ts";

test("fullscreen VALUE ruler keeps its toolbar inset", () => {
  const frame = valueAxisFrame(640, false);
  assert.equal(frame.top, 78);
  assert.equal(frame.bottom, 550);
  assert.equal(frame.labelY, 70);
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

test("docked node values stay on the map and avoid each other", () => {
  const [user, tool] = placeDockedNodeLabels(
    [
      { x: 40, y: 70, textWidth: 70 },
      { x: 48, y: 72, textWidth: 64 },
    ],
    280,
    120,
  );
  assert.ok(user.x >= 4 && user.x + user.w <= 276);
  assert.ok(user.y >= 4 && user.y + user.h <= 116);
  assert.ok(tool.y >= user.y + user.h || tool.x >= user.x + user.w || user.x >= tool.x + tool.w);

  const [flipped] = placeDockedNodeLabels([{ x: 250, y: 40, textWidth: 80 }], 280, 120);
  assert.ok(flipped.x + flipped.w <= 276);
  assert.ok(flipped.x < 250);
});

test("docked tick step widens when the ruler is short", () => {
  assert.equal(valueAxisStep(4, 200, false), 1);
  assert.equal(valueAxisStep(8, 200, false), 2);
  assert.equal(valueAxisStep(8, 40, true), 4);
  assert.equal(valueAxisStep(4, 30, true), 2);
});
