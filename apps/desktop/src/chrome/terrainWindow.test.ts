import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AREA_MAP_WINDOW_MS,
  COMPRESSED_GAP_MS,
  activityAxis,
  compressedToWall,
  mapWindow,
  pointsInWindow,
  sessionSpan,
  viewWindow,
  wallToCompressed,
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

function activeAt(timestamp: number, active = true) {
  return {
    timestamp,
    user_count: active ? 1 : 0,
    think_count: 0,
    reply_count: 0,
    tool_count: 0,
  };
}

test("a gap longer than 5 minutes shrinks to a 2 minute seam", () => {
  const start = 1_000_000;
  const burst = 10 * MINUTE;
  const gap = 2 * 60 * MINUTE;
  const end = start + burst + gap + burst;
  const points = [];
  for (let t = 0; t <= burst; t += MINUTE) points.push(activeAt(start + t));
  for (let t = 0; t <= burst; t += MINUTE) points.push(activeAt(start + burst + gap + t));

  const axis = activityAxis(points, { timeline_start: start, timeline_end: end });
  assert.equal(axis.seams.length, 1);
  assert.equal(axis.seams[0].gapMs, gap);
  assert.equal(axis.seams[0].label, "+2h");
  assert.equal(axis.spanMs, burst + COMPRESSED_GAP_MS + burst);

  const live = mapWindow(axis, windowStartFromFraction(0, axis.spanMs, 1));
  assert.equal(live.slidable, false);
  assert.equal(live.start, start);
  assert.equal(live.end, end);
  assert.equal(live.compStart, 0);
  assert.equal(live.compEnd, axis.spanMs);
});

test("a gap of 5 minutes keeps its real spacing", () => {
  const start = 10_000;
  const end = start + 5 * MINUTE;
  const axis = activityAxis(
    [activeAt(start), activeAt(end)],
    { timeline_start: start, timeline_end: end },
  );
  assert.equal(axis.seams.length, 0);
  assert.equal(axis.spanMs, 5 * MINUTE);
});

test("continuous activity still slides a 30 minute window", () => {
  const start = 1_000_000;
  const end = start + 2 * 60 * MINUTE;
  const points = [];
  for (let t = start; t <= end; t += MINUTE) points.push(activeAt(t));
  const axis = activityAxis(points, { timeline_start: start, timeline_end: end });
  assert.equal(axis.seams.length, 0);
  assert.equal(axis.spanMs, end - start);

  const atEnd = mapWindow(axis, windowStartFromFraction(0, axis.spanMs, 1));
  assert.equal(atEnd.slidable, true);
  assert.equal(atEnd.end, end);
  assert.equal(atEnd.start, end - AREA_MAP_WINDOW_MS);
  const track = windowTrack(atEnd);
  assert.ok(Math.abs(track.widthPct - 25) < 0.01);
  assert.ok(Math.abs(track.leftPct - 75) < 0.01);
});

test("the scrubber measures compressed time, so a long gap does not widen the thumb", () => {
  const start = 1_000_000;
  const first = 20 * MINUTE;
  const gap = 3 * 60 * MINUTE;
  const second = 40 * MINUTE;
  const end = start + first + gap + second;
  const points = [];
  for (let t = 0; t <= first; t += MINUTE) points.push(activeAt(start + t));
  for (let t = MINUTE; t < gap; t += MINUTE) points.push(activeAt(start + first + t, false));
  for (let t = 0; t <= second; t += MINUTE) points.push(activeAt(start + first + gap + t));
  const axis = activityAxis(points, { timeline_start: start, timeline_end: end });
  assert.equal(axis.seams.length, 1);
  assert.equal(axis.spanMs, first + COMPRESSED_GAP_MS + second);
  assert.equal(axis.seams[0].label, "+3h");

  const atStart = mapWindow(axis, windowStartFromFraction(0, axis.spanMs, 0));
  const track = windowTrack(atStart);
  const expected = (AREA_MAP_WINDOW_MS / axis.spanMs) * 100;
  assert.ok(Math.abs(track.widthPct - expected) < 0.01);
  assert.equal(track.leftPct, 0);
  assert.ok(track.widthPct > (AREA_MAP_WINDOW_MS / (end - start)) * 100);
});

test("wall time round-trips through a compressed seam", () => {
  const start = 5_000;
  const burst = 10 * MINUTE;
  const gap = 90 * MINUTE;
  const end = start + burst + gap + burst;
  const points = [];
  for (let t = 0; t <= burst; t += MINUTE) points.push(activeAt(start + t));
  for (let t = 0; t <= burst; t += MINUTE) points.push(activeAt(start + burst + gap + t));
  const axis = activityAxis(points, { timeline_start: start, timeline_end: end });
  assert.equal(axis.seams[0].label, "+1h 30m");

  const midWall = start + burst + gap / 2;
  const comp = wallToCompressed(axis, midWall);
  assert.ok(comp > burst && comp < burst + COMPRESSED_GAP_MS);
  assert.ok(Math.abs(compressedToWall(axis, comp) - midWall) < 2);

  assert.equal(wallToCompressed(axis, start + burst), burst);
  assert.equal(wallToCompressed(axis, start + burst + gap), burst + COMPRESSED_GAP_MS);
  assert.equal(compressedToWall(axis, burst + COMPRESSED_GAP_MS), start + burst + gap);
});
