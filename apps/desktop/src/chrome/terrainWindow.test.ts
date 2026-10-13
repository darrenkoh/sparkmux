import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AREA_MAP_WINDOW_MS,
  pointsInWindow,
  sessionSpan,
  viewWindow,
  windowStartFromFraction,
  windowTrack,
} from "./terrainWindow.ts";

const MINUTE = 60_000;

test("a 2 hour session slides a 30 minute window from the start to the end", () => {
  const start = 1_000_000;
  const end = start + 2 * 60 * MINUTE;

  const atStart = viewWindow(start, end, windowStartFromFraction(start, end, 0));
  assert.equal(atStart.slidable, true);
  assert.equal(atStart.start, start);
  assert.equal(atStart.end - atStart.start, AREA_MAP_WINDOW_MS);

  const atEnd = viewWindow(start, end, windowStartFromFraction(start, end, 1));
  assert.equal(atEnd.end, end);
  assert.equal(atEnd.start, end - AREA_MAP_WINDOW_MS);

  const mid = viewWindow(start, end, windowStartFromFraction(start, end, 0.5));
  assert.equal(mid.start, start + 45 * MINUTE);
  assert.equal(mid.end, start + 75 * MINUTE);
});

test("a session shorter than 30 minutes fills the map and does not slide", () => {
  const start = 5_000;
  const end = start + 10 * MINUTE;
  const view = viewWindow(start, end, windowStartFromFraction(start, end, 1));
  assert.equal(view.slidable, false);
  assert.equal(view.start, start);
  assert.equal(view.end, end);
});

test("dragging past either end stays inside the session", () => {
  const start = 50_000;
  const end = start + 90 * MINUTE;
  const tooEarly = viewWindow(start, end, start - 60 * MINUTE);
  assert.equal(tooEarly.start, start);
  const tooLate = viewWindow(start, end, end + 60 * MINUTE);
  assert.equal(tooLate.end, end);
  assert.equal(tooLate.start, end - AREA_MAP_WINDOW_MS);
});

test("the thumb width matches the window's share of the session", () => {
  const start = 0;
  const end = 2 * 60 * MINUTE;
  const view = viewWindow(start, end, windowStartFromFraction(start, end, 0));
  const track = windowTrack(view);
  assert.equal(track.leftPct, 0);
  assert.ok(Math.abs(track.widthPct - 25) < 0.01);
});

test("only columns inside the window are drawn", () => {
  const start = 1_000;
  const points = [0, 10, 30, 40, 80].map((minute) => ({ timestamp: start + minute * MINUTE }));
  const view = viewWindow(start, start + 90 * MINUTE, start + 20 * MINUTE);
  const visible = pointsInWindow(points, view.start, view.end);
  assert.deepEqual(visible.map((point) => point.timestamp), [
    start + 30 * MINUTE,
    start + 40 * MINUTE,
  ]);
});

test("session bounds prefer the stats span over the first column", () => {
  const span = sessionSpan(
    [{ timestamp: 5_000 }, { timestamp: 9_000 }],
    { timeline_start: 1_000, timeline_end: 20_000 },
  );
  assert.deepEqual(span, { start: 1_000, end: 20_000 });
});
