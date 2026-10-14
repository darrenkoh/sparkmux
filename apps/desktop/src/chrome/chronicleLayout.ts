// y-up, right-handed. forward (0,0,-1) × up (0,1,0) = right (1,0,0).
// cross(up, forward) is left. Transit shards are unrotated; no lookAt.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface StationLayoutInput {
  id: string;
  ordinal: number;
  lane: number;
  added: number;
  removed: number;
  kind: "replace" | "write" | "delete" | "patch" | "notebook" | "now";
  outcome: "unknown" | "ok" | "error";
  path?: string;
  preview?: string;
}

export type ChronicleScene = "transit" | "rivers" | "helix" | "ridge";

export const TRANSIT_GATE_GAP = 8;
export const TRANSIT_CAMERA_Z = 4.5;
export const TRANSIT_NOW_Z = 2.4;
export const TRANSIT_TARGET_Y = 1.15;
export const TRANSIT_CAMERA_OFFSET: Vec3 = { x: 0, y: 0.55, z: TRANSIT_CAMERA_Z };
// PlaneGeometry's +z normal. rotation.x = -PI/2 sends (0,0,1) to (0,1,0). Do not also set rotation.y.
export const FLOOR_ROTATION_X = -Math.PI / 2;

export const RIVER_STEP_X = 1.6;
export const RIVER_LANE_Z = 1.35;

export const HELIX_R = 3.2;
export const HELIX_DTHETA = 0.55;
export const HELIX_DY = 0.42;

export const RIDGE_STEP_X = 1.2;
export const RIDGE_LANE_Z = 1.35;
export const RIDGE_HEIGHT = 0.85;
export const RIDGE_HEIGHT_MAX = 4;

// A product with a zero factor is -0 in IEEE math. Object.is treats that as different from 0.
function real(n: number): number {
  return n === 0 ? 0 : n;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: real(a.y * b.z - a.z * b.y),
    y: real(a.z * b.x - a.x * b.z),
    z: real(a.x * b.y - a.y * b.x),
  };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function transitZ(ordinal: number, count: number): number {
  return (ordinal - (count - 1)) * TRANSIT_GATE_GAP;
}

export function transitShardX(lane: number): number {
  const side = lane % 2 === 0 ? 1 : -1;
  return side * (1.2 + Math.floor(lane / 2) * 0.9);
}

export function transitShardScaleY(
  station: Pick<StationLayoutInput, "added" | "removed" | "kind" | "outcome">,
): number {
  if (station.outcome === "error" || station.kind === "delete") return 0.12;
  const y = 0.15 + 0.35 * Math.log1p(station.added + station.removed);
  return Math.min(1.8, Math.max(0.15, y));
}

export function initialTransitCamera(targetZ: number): { target: Vec3; camera: Vec3 } {
  const target = { x: 0, y: TRANSIT_TARGET_Y, z: targetZ };
  return {
    target,
    camera: {
      x: target.x + TRANSIT_CAMERA_OFFSET.x,
      y: target.y + TRANSIT_CAMERA_OFFSET.y,
      z: target.z + TRANSIT_CAMERA_OFFSET.z,
    },
  };
}

export function riverPoint(ordinal: number, lane: number, added: number, removed: number): Vec3 {
  return {
    x: ordinal * RIVER_STEP_X,
    y: 0.02 + 0.12 * Math.log1p(added + removed),
    z: lane * RIVER_LANE_Z,
  };
}

export function helixPoint(ordinal: number): Vec3 {
  const theta = ordinal * HELIX_DTHETA;
  return {
    x: HELIX_R * Math.sin(theta),
    y: ordinal * HELIX_DY,
    z: HELIX_R * Math.cos(theta),
  };
}

export function ridgeHeight(added: number, removed: number): number {
  return Math.min(RIDGE_HEIGHT_MAX, RIDGE_HEIGHT * Math.log1p(added + removed));
}

export function ridgeCellCorners(
  i: number,
  lane: number,
  heightAt: (ordinal: number, lane: number) => number,
): { v00: Vec3; v10: Vec3; v01: Vec3; v11: Vec3 } {
  const x = (ordinal: number) => ordinal * RIDGE_STEP_X;
  const z = (row: number) => row * RIDGE_LANE_Z;
  return {
    v00: { x: x(i), y: heightAt(i, lane), z: z(lane) },
    v10: { x: x(i + 1), y: heightAt(i + 1, lane), z: z(lane) },
    v01: { x: x(i), y: heightAt(i, lane + 1), z: z(lane + 1) },
    v11: { x: x(i + 1), y: heightAt(i + 1, lane + 1), z: z(lane + 1) },
  };
}

export function stationWorld(scene: ChronicleScene, station: StationLayoutInput, count: number): Vec3 {
  if (scene === "transit") {
    const z = station.kind === "now" ? TRANSIT_NOW_Z : transitZ(station.ordinal, count);
    return { x: 0, y: TRANSIT_TARGET_Y, z };
  }
  if (scene === "rivers") {
    if (station.kind === "now") {
      return { x: count * RIVER_STEP_X, y: 0.08, z: station.lane * RIVER_LANE_Z };
    }
    return riverPoint(station.ordinal, station.lane, station.added, station.removed);
  }
  if (scene === "helix") {
    return helixPoint(station.kind === "now" ? count : station.ordinal);
  }
  if (station.kind === "now") {
    return { x: count * RIDGE_STEP_X, y: 0.15, z: station.lane * RIDGE_LANE_Z };
  }
  return {
    x: station.ordinal * RIDGE_STEP_X,
    y: ridgeHeight(station.added, station.removed),
    z: station.lane * RIDGE_LANE_Z,
  };
}
