import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANNEL_RING_FRAC,
  GLOBE_RADIUS,
  RING_TIME_GAP,
  angleToTimeFrac,
  globeBezelVerts,
  globeHaloVerts,
  globeRadarVerts,
  globeRingRidges,
  globeTrackVerts,
  ringXZ,
  sampleElev,
  timeFracToAngle,
  type ElevField,
} from "./globeSensor.ts";

type Vert = [number, number, number, number];

function vertsOf(data: Float32Array): Vert[] {
  const out: Vert[] = [];
  for (let i = 0; i < data.length; i += 4) {
    out.push([data[i], data[i + 1], data[i + 2], data[i + 3]]);
  }
  return out;
}

function radiusOf(v: Vert): number {
  return Math.hypot(v[0], v[2]);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

test("the compass bezel rings the coast and ticks past the rim", () => {
  const verts = vertsOf(globeBezelVerts());
  assert.ok(verts.length > 200);
  assert.equal(verts.length % 2, 0);
  assert.ok(verts.every((v) => v[3] > 0 && v[3] <= 1));
  const radii = verts.map(radiusOf);
  assert.ok(radii.some((r) => Math.abs(r - GLOBE_RADIUS) < 0.05));
  assert.ok(Math.max(...radii) > GLOBE_RADIUS * 1.06);
  assert.ok(Math.min(...radii) > GLOBE_RADIUS * 0.94);
});

test("the atmosphere halo sits outside the disc and rises as it thins", () => {
  const verts = vertsOf(globeHaloVerts(1));
  assert.ok(verts.every((v) => radiusOf(v) > GLOBE_RADIUS));
  const inner = verts.filter((v) => radiusOf(v) < GLOBE_RADIUS * 1.04);
  const outer = verts.filter((v) => radiusOf(v) > GLOBE_RADIUS * 1.16);
  assert.ok(inner.length > 0 && outer.length > 0);
  assert.ok(mean(outer.map((v) => v[1])) > mean(inner.map((v) => v[1])));
  assert.ok(mean(outer.map((v) => v[3])) < mean(inner.map((v) => v[3])));

  const dim = globeHaloVerts(0.5);
  const full = globeHaloVerts(1);
  let dimSum = 0;
  let fullSum = 0;
  for (let i = 3; i < dim.length; i += 4) {
    dimSum += dim[i];
    fullSum += full[i];
  }
  assert.ok(Math.abs(dimSum * 2 - fullSum) < 1e-3);
});

test("channel tracks sit on four inner rings and follow the dome", () => {
  const dome = (x: number, z: number) => {
    const dist = Math.hypot(x, z) / GLOBE_RADIUS;
    if (dist >= 1) return 0;
    return Math.sqrt(1 - dist * dist) * 4;
  };
  const verts = vertsOf(globeTrackVerts(dome));
  for (const frac of CHANNEL_RING_FRAC) {
    const onRing = verts.filter((v) => Math.abs(radiusOf(v) - GLOBE_RADIUS * frac) < 0.15);
    assert.ok(onRing.length > 50, `missing ring at ${frac}`);
  }
  const inner = verts.filter((v) => Math.abs(radiusOf(v) - GLOBE_RADIUS * CHANNEL_RING_FRAC[0]) < 0.15);
  const outer = verts.filter((v) => Math.abs(radiusOf(v) - GLOBE_RADIUS * CHANNEL_RING_FRAC[3]) < 0.15);
  assert.ok(mean(inner.map((v) => v[1])) > mean(outer.map((v) => v[1])) + 0.4);
  assert.ok(Math.max(...verts.map(radiusOf)) < GLOBE_RADIUS * 0.75);
});

test("a ridge lifts the channel track that crosses it", () => {
  const flat = globeTrackVerts(() => 0.2);
  const ridged = globeTrackVerts((x) => (Math.abs(x) < 0.45 ? 3.4 : 0.2));
  const maxY = (data: Float32Array) => {
    let peak = 0;
    for (let i = 1; i < data.length; i += 4) peak = Math.max(peak, data[i]);
    return peak;
  };
  assert.ok(maxY(ridged) > maxY(flat) + 2);
});

test("time runs around the rings and the notch is empty", () => {
  const start = timeFracToAngle(0);
  assert.ok(Math.abs(Math.cos(start) + 1) < 1e-6);
  assert.ok(Math.abs(Math.sin(start)) < 1e-6);
  assert.ok(Math.cos(timeFracToAngle(0.5)) > 0.9);

  for (const frac of [0, 0.25, 0.5, 0.73, 1]) {
    const ang = timeFracToAngle(frac);
    const back = angleToTimeFrac(Math.atan2(Math.sin(ang), Math.cos(ang)));
    assert.ok(back != null && Math.abs(back - frac) < 1e-6);
  }

  const gapMid = timeFracToAngle(1) + RING_TIME_GAP / 2;
  assert.equal(angleToTimeFrac(gapMid), null);

  const [userX, userZ] = ringXZ(0, 0);
  const [toolX, toolZ] = ringXZ(3, 0);
  assert.ok(Math.hypot(userX, userZ) < Math.hypot(toolX, toolZ));
});

test("a channel peak stays on its own ring", () => {
  const peaks = [{ frac: 0.5, h: [4, 0, 0, 0] as const }];
  const [ux, uz] = ringXZ(0, 0.5);
  const [tx, tz] = ringXZ(3, 0.5);
  const [earlyX, earlyZ] = ringXZ(0, 0.05);
  assert.ok(globeRingRidges(ux, uz, peaks) > 3);
  assert.ok(globeRingRidges(tx, tz, peaks) < 0.15);
  assert.ok(globeRingRidges(earlyX, earlyZ, peaks) < 0.2);
});

test("the radar lead is an expanding ring and the trail sits inside it", () => {
  const lead = 0.62;
  const verts = vertsOf(globeRadarVerts(lead, () => 1.2));
  const radii = verts.map(radiusOf);
  assert.ok(Math.max(...radii) < GLOBE_RADIUS * 0.99);
  assert.ok(Math.abs(Math.max(...radii) - GLOBE_RADIUS * lead) < 0.4);
  assert.ok(Math.min(...radii) < GLOBE_RADIUS * (lead - 0.12));
  const bright = verts.filter((v) => v[3] > 0.7);
  const dim = verts.filter((v) => v[3] < 0.15);
  assert.ok(bright.length > 0 && dim.length > 0);
  assert.ok(mean(bright.map(radiusOf)) > mean(dim.map(radiusOf)));
});

test("elevation sampling bilinear-interpolates the particle grid", () => {
  const field: ElevField = {
    map: new Float32Array([0, 0, 0, 4]),
    gridX: 2,
    gridZ: 2,
    originX: -1,
    originZ: -1,
    invStepX: 0.5,
    invStepZ: 0.5,
  };
  assert.equal(sampleElev(field, -1, -1), 0);
  assert.equal(sampleElev(field, 1, 1), 4);
  assert.ok(Math.abs(sampleElev(field, 0, 0) - 1) < 1e-5);
});
