import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FLOOR_ROTATION_X,
  HELIX_R,
  RIDGE_LANE_Z,
  RIDGE_STEP_X,
  RIVER_LANE_Z,
  RIVER_STEP_X,
  TRANSIT_CAMERA_OFFSET,
  TRANSIT_CAMERA_Z,
  TRANSIT_GATE_GAP,
  TRANSIT_NOW_Z,
  cross,
  helixPoint,
  initialTransitCamera,
  ridgeCellCorners,
  ridgeHeight,
  riverPoint,
  stationWorld,
  sub,
  transitZ,
  type StationLayoutInput,
} from "./chronicleLayout.ts";

function station(partial: Partial<StationLayoutInput> & Pick<StationLayoutInput, "id" | "ordinal">): StationLayoutInput {
  return {
    lane: 0,
    added: 0,
    removed: 0,
    kind: "replace",
    outcome: "ok",
    ...partial,
  };
}

test("transit places the newest station at z 0 and the past toward -z", () => {
  assert.equal(transitZ(4, 5), 0);
  assert.equal(transitZ(0, 5), -32);
  assert.ok(transitZ(0, 5) < transitZ(4, 5));
  const newest = stationWorld("transit", station({ id: "new", ordinal: 4 }), 5);
  assert.equal(newest.z, 0);
  assert.equal(newest.x, 0);
});

test("Now sits strictly between the newest gate and the camera", () => {
  assert.ok(TRANSIT_NOW_Z > 0);
  assert.ok(TRANSIT_NOW_Z < TRANSIT_CAMERA_Z);
  assert.equal(TRANSIT_NOW_Z, 2.4);
  assert.equal(TRANSIT_CAMERA_Z, 4.5);
  assert.notEqual(TRANSIT_NOW_Z, TRANSIT_GATE_GAP * 0.65);
  assert.ok(TRANSIT_GATE_GAP * 0.65 > TRANSIT_CAMERA_Z);
  const now = stationWorld("transit", station({ id: "now:a", ordinal: 5, kind: "now" }), 5);
  assert.equal(now.z, TRANSIT_NOW_Z);
  assert.ok(now.z > 0 && now.z < TRANSIT_CAMERA_Z);
});

test("forward cross up is +x and the floor normal points up", () => {
  const right = cross({ x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
  assert.deepEqual(right, { x: 1, y: 0, z: 0 });
  const left = cross({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 });
  assert.deepEqual(left, { x: -1, y: 0, z: 0 });

  const angle = FLOOR_ROTATION_X;
  const y = 0 * Math.cos(angle) - 1 * Math.sin(angle);
  const z = 0 * Math.sin(angle) + 1 * Math.cos(angle);
  assert.ok(y > 0);
  assert.ok(Math.abs(y - 1) < 1e-9);
  assert.ok(Math.abs(z) < 1e-9);
});

test("the default transit camera sits on +z of the newest station", () => {
  const placed = initialTransitCamera(transitZ(2, 3));
  assert.equal(placed.target.z, 0);
  assert.equal(TRANSIT_CAMERA_OFFSET.z, 4.5);
  assert.equal(placed.camera.z, placed.target.z + TRANSIT_CAMERA_OFFSET.z);
  assert.ok(placed.camera.z > placed.target.z);
  assert.equal(placed.camera.x, 0);
});

test("helix rises with ordinal and Now is the next step", () => {
  assert.deepEqual(helixPoint(0), { x: 0, y: 0, z: HELIX_R });
  let prevY = -1;
  for (let ordinal = 0; ordinal < 6; ordinal += 1) {
    const point = helixPoint(ordinal);
    assert.ok(point.y > prevY);
    prevY = point.y;
    assert.ok(Math.abs(Math.hypot(point.x, point.z) - HELIX_R) < 1e-9);
  }
  const count = 6;
  const now = stationWorld("helix", station({ id: "now:a", ordinal: count, kind: "now" }), count);
  assert.deepEqual(now, helixPoint(count));
  assert.ok(now.y > helixPoint(count - 1).y);
});

test("river ordinal runs +x and lanes differ only in z", () => {
  const quiet = riverPoint(0, 0, 0, 0);
  const next = riverPoint(1, 0, 0, 0);
  const otherLane = riverPoint(1, 1, 0, 0);
  assert.ok(next.x > quiet.x);
  assert.equal(quiet.y, 0.02);
  assert.ok(riverPoint(0, 0, 2, 1).y > quiet.y);
  assert.equal(next.y, otherLane.y);
  assert.notEqual(next.z, otherLane.z);
  assert.equal(next.x, otherLane.x);
  const now = stationWorld("rivers", station({ id: "now:a", ordinal: 4, lane: 2, kind: "now" }), 4);
  assert.equal(now.x, 4 * RIVER_STEP_X);
  assert.equal(now.y, 0.08);
  assert.equal(now.z, 2 * RIVER_LANE_Z);
});

test("ridge height stays in range and the cell winding faces +y", () => {
  assert.equal(ridgeHeight(0, 0), 0);
  assert.ok(ridgeHeight(1, 0) > 0);
  assert.ok(ridgeHeight(8, 8) >= ridgeHeight(1, 0));
  assert.ok(ridgeHeight(1_000_000, 1_000_000) <= 4);
  assert.ok(ridgeHeight(3, 1) >= 0);

  const { v00, v10, v01, v11 } = ridgeCellCorners(0, 0, () => 0);
  assert.deepEqual(v00, { x: 0, y: 0, z: 0 });
  assert.deepEqual(v10, { x: RIDGE_STEP_X, y: 0, z: 0 });
  assert.deepEqual(v01, { x: 0, y: 0, z: RIDGE_LANE_Z });
  assert.deepEqual(v11, { x: RIDGE_STEP_X, y: 0, z: RIDGE_LANE_Z });
  // (v00, v01, v11) then (v00, v11, v10). The y term is edge.z * edge.x, not a simplified stand-in.
  const first = cross(sub(v01, v00), sub(v11, v00));
  const second = cross(sub(v11, v00), sub(v10, v00));
  assert.ok(first.y > 0);
  assert.ok(second.y > 0);
  assert.ok(Math.abs(first.y - RIDGE_STEP_X * RIDGE_LANE_Z) < 1e-9);
  assert.ok(Math.abs(second.y - RIDGE_STEP_X * RIDGE_LANE_Z) < 1e-9);

  const sloped = ridgeCellCorners(0, 0, (ordinal, lane) => ordinal + lane);
  const slopeNormal = cross(sub(sloped.v01, sloped.v00), sub(sloped.v11, sloped.v00));
  const slopeSecond = cross(sub(sloped.v11, sloped.v00), sub(sloped.v10, sloped.v00));
  assert.ok(slopeNormal.y > 0);
  assert.ok(slopeSecond.y > 0);

  const now = stationWorld("ridge", station({ id: "now:a", ordinal: 3, lane: 1, kind: "now" }), 3);
  assert.equal(now.x, 3 * RIDGE_STEP_X);
  assert.equal(now.y, 0.15);
  assert.equal(now.z, RIDGE_LANE_Z);
});
