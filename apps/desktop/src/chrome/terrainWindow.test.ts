import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AREA_MAP_WINDOW_MS,
  COMPRESSED_GAP_MS,
  activityAxis,
  compressedToWall,
  effectiveCompressedGapMs,
  effectiveIdleGapMs,
  mapWindow,
  pointsInWindow,
  seamIdleText,
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

test("idle threshold steps at the exact hour boundaries", () => {
  const hour = 60 * MINUTE;
  assert.equal(effectiveIdleGapMs(hour), 5 * MINUTE);
  assert.equal(effectiveIdleGapMs(hour + 1), 10 * MINUTE);
  assert.equal(effectiveIdleGapMs(6 * hour), 10 * MINUTE);
  assert.equal(effectiveIdleGapMs(6 * hour + 1), 15 * MINUTE);
  assert.equal(effectiveIdleGapMs(24 * hour), 15 * MINUTE);
  assert.equal(effectiveIdleGapMs(24 * hour + 1), 30 * MINUTE);
  assert.equal(effectiveCompressedGapMs(8), COMPRESSED_GAP_MS);
  assert.equal(effectiveCompressedGapMs(9), 60_000);
  assert.equal(effectiveCompressedGapMs(16), 60_000);
  assert.equal(effectiveCompressedGapMs(17), 45_000);
});

/** One quiet gap centered in a session, with real activity on both sides. */
function sessionWithGap(spanMs: number, gapMs: number) {
  const start = 1_000_000;
  const side = (spanMs - gapMs) / 2;
  const points = [];
  const pushRange = (from: number, to: number) => {
    points.push(activeAt(from));
    for (let t = from + MINUTE; t < to; t += MINUTE) points.push(activeAt(t));
    if (to !== from) points.push(activeAt(to));
  };
  pushRange(start, start + side);
  pushRange(start + side + gapMs, start + spanMs);
  return activityAxis(points, { timeline_start: start, timeline_end: start + spanMs });
}

test("sessions up to one hour fold a gap only when it is longer than 5 minutes", () => {
  const span = 60 * MINUTE;
  const folded = sessionWithGap(span, 6 * MINUTE);
  assert.equal(folded.seamCount, 1);
  assert.equal(folded.seams[0].compEnd - folded.seams[0].compStart, COMPRESSED_GAP_MS);
  assert.equal(folded.spanMs, span - 6 * MINUTE + COMPRESSED_GAP_MS);

  const kept = sessionWithGap(span, 5 * MINUTE);
  assert.equal(kept.seamCount, 0);
  assert.equal(kept.spanMs, span);
});

test("a three hour session folds gaps longer than 10 minutes", () => {
  const span = 3 * 60 * MINUTE;
  const quiet = sessionWithGap(span, 8 * MINUTE);
  assert.equal(quiet.seamCount, 0);
  assert.equal(quiet.spanMs, span);

  const folded = sessionWithGap(span, 12 * MINUTE);
  assert.equal(folded.seamCount, 1);
  assert.equal(folded.seams[0].gapMs, 12 * MINUTE);
  assert.equal(folded.seams[0].compEnd - folded.seams[0].compStart, COMPRESSED_GAP_MS);
});

test("an eight hour session folds gaps longer than 15 minutes", () => {
  const span = 8 * 60 * MINUTE;
  const quiet = sessionWithGap(span, 12 * MINUTE);
  assert.equal(quiet.seamCount, 0);
  assert.equal(quiet.spanMs, span);

  const folded = sessionWithGap(span, 20 * MINUTE);
  assert.equal(folded.seamCount, 1);
  assert.equal(folded.seams[0].gapMs, 20 * MINUTE);
  assert.equal(folded.seams[0].compEnd - folded.seams[0].compStart, COMPRESSED_GAP_MS);
});

test("a thirty hour session folds gaps longer than 30 minutes", () => {
  const span = 30 * 60 * MINUTE;
  const quiet = sessionWithGap(span, 20 * MINUTE);
  assert.equal(quiet.seamCount, 0);
  assert.equal(quiet.spanMs, span);

  const folded = sessionWithGap(span, 40 * MINUTE);
  assert.equal(folded.seamCount, 1);
  assert.equal(folded.seams[0].gapMs, 40 * MINUTE);
  assert.equal(folded.seams[0].compEnd - folded.seams[0].compStart, COMPRESSED_GAP_MS);
});

test("a 10 second blip between two idle gaps collapses into one seam", () => {
  const start = 1_000_000;
  const side = 30 * MINUTE;
  const gap = 12 * MINUTE;
  const blip = 10_000;
  const points = [];
  for (let t = 0; t <= side; t += MINUTE) points.push(activeAt(start + t));
  const blipStart = start + side + gap;
  points.push(activeAt(blipStart));
  points.push(activeAt(blipStart + blip));
  const tail = blipStart + blip + gap;
  for (let t = 0; t <= side; t += MINUTE) points.push(activeAt(tail + t));
  const end = tail + side;

  const axis = activityAxis(points, { timeline_start: start, timeline_end: end });
  const gapMs = gap + blip + gap;
  assert.equal(axis.seamCount, 1);
  assert.equal(axis.seams[0].gapMs, gapMs);
  assert.equal(axis.seams[0].wallStart, start + side);
  assert.equal(axis.seams[0].wallEnd, tail);
  assert.equal(axis.totalFoldedMs, gapMs - COMPRESSED_GAP_MS);
  assert.equal(axis.spanMs, side + COMPRESSED_GAP_MS + side);
});

test("isolated turns keep a seam per gap instead of one canyon", () => {
  const start = 1_000_000;
  const gap = 20 * MINUTE;
  const turns = 10;
  const points = [];
  for (let i = 0; i < turns; i++) points.push(activeAt(start + i * gap));
  const end = start + (turns - 1) * gap;
  const axis = activityAxis(points, { timeline_start: start, timeline_end: end });
  assert.equal(axis.seamCount, turns - 1);
  assert.equal(axis.seams[0].gapMs, gap);
  assert.equal(axis.spanMs, (turns - 1) * 60_000);
  const mid = start + gap;
  assert.equal(wallToCompressed(axis, mid), 60_000);
  assert.equal(compressedToWall(axis, 60_000), mid);
});

test("a 30 second burst between idle gaps stays real and leaves two seams", () => {
  const start = 1_000_000;
  const side = 30 * MINUTE;
  const gap = 12 * MINUTE;
  const burst = 30_000;
  const points = [];
  for (let t = 0; t <= side; t += MINUTE) points.push(activeAt(start + t));
  const burstStart = start + side + gap;
  points.push(activeAt(burstStart));
  points.push(activeAt(burstStart + burst));
  const tail = burstStart + burst + gap;
  for (let t = 0; t <= side; t += MINUTE) points.push(activeAt(tail + t));
  const end = tail + side;

  const axis = activityAxis(points, { timeline_start: start, timeline_end: end });
  assert.equal(axis.seamCount, 2);
  assert.equal(axis.seams[0].gapMs, gap);
  assert.equal(axis.seams[1].gapMs, gap);
  const kept = axis.pieces.find((piece) => !piece.seam && piece.wallEnd - piece.wallStart === burst);
  assert.ok(kept);
  assert.equal(axis.spanMs, side + COMPRESSED_GAP_MS + burst + COMPRESSED_GAP_MS + side);
});

function seamsSeparatedByBursts(seamCount: number) {
  const start = 1_000_000;
  const burst = 45_000;
  const gap = 11 * MINUTE;
  const points = [];
  for (let i = 0; i <= seamCount; i++) {
    const at = start + i * (burst + gap);
    points.push(activeAt(at));
    points.push(activeAt(at + burst));
  }
  const end = start + seamCount * (burst + gap) + burst;
  return activityAxis(points, { timeline_start: start, timeline_end: end });
}

test("nine seams use a one minute compressed width", () => {
  const seamCount = 9;
  const gap = 11 * MINUTE;
  const burst = 45_000;
  const width = 60_000;
  const axis = seamsSeparatedByBursts(seamCount);
  assert.equal(axis.seamCount, seamCount);
  assert.equal(axis.spanMs, (seamCount + 1) * burst + seamCount * width);
  assert.equal(axis.totalFoldedMs, seamCount * (gap - width));
  assert.equal(axis.seams[0].compEnd - axis.seams[0].compStart, width);
});

test("seventeen seams use a 45 second compressed width", () => {
  const seamCount = 17;
  const gap = 11 * MINUTE;
  const burst = 45_000;
  const width = 45_000;
  const axis = seamsSeparatedByBursts(seamCount);
  assert.equal(axis.seamCount, seamCount);
  assert.equal(axis.spanMs, (seamCount + 1) * burst + seamCount * width);
  assert.equal(axis.totalFoldedMs, seamCount * (gap - width));
  assert.equal(axis.seams[0].compEnd - axis.seams[0].compStart, width);
});

test("seam idle text uses the local clock", () => {
  const wallStart = new Date(2026, 0, 15, 14, 10, 45).getTime();
  const wallEnd = new Date(2026, 0, 15, 14, 52, 5).getTime();
  assert.equal(
    seamIdleText({ label: "+42m", wallStart, wallEnd }),
    "Idle: +42m (14:10 → 14:52)",
  );
  const morning = new Date(2026, 0, 15, 9, 5, 0).getTime();
  assert.equal(
    seamIdleText({ label: "+6m", wallStart: morning, wallEnd: morning + 6 * MINUTE }),
    "Idle: +6m (09:05 → 09:11)",
  );
});
