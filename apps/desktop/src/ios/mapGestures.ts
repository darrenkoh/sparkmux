/** Camera updates for the 3D area map. TerrainViewport and the tests call these. */

export interface MapCamera {
  azimuth: number;
  elevation: number;
  radius: number;
  target: [number, number, number];
}

export const RADIUS_MIN = 14;
export const RADIUS_MAX = 90;

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function orbitCamera(cam: MapCamera, dx: number, dy: number): void {
  cam.azimuth -= dx * 0.005;
  cam.elevation = clamp(cam.elevation + dy * 0.004, 0.06, 1.35);
}

export function pinchRadius(radius: number, prevDist: number, dist: number): number {
  if (prevDist <= 10 || dist <= 10) return clamp(radius, RADIUS_MIN, RADIUS_MAX);
  const scale = prevDist / dist;
  return clamp(radius * scale, RADIUS_MIN, RADIUS_MAX);
}

export function panCameraTarget(cam: MapCamera, dx: number, dy: number): void {
  const cosA = Math.cos(cam.azimuth);
  const sinA = Math.sin(cam.azimuth);
  const panScale = cam.radius * 0.0012;
  cam.target[0] = clamp(cam.target[0] - dx * cosA * panScale, -10, 10);
  cam.target[2] = clamp(cam.target[2] + (dx * sinA + dy) * panScale, -8, 8);
}

/** Pen and touch pins use a larger finger target than a mouse. */
export function milestoneHitRadius(pointerType: string): number {
  if (pointerType === "pen" || pointerType === "touch") return 28;
  return 18;
}

export function isDoubleTap(
  previousAt: number,
  now: number,
  previousX: number,
  previousY: number,
  x: number,
  y: number,
): boolean {
  if (previousAt <= 0) return false;
  return now - previousAt < 280 && Math.hypot(x - previousX, y - previousY) < 24;
}

export function resetCamera(shape: "globe" | "rect"): Pick<MapCamera, "azimuth" | "elevation" | "radius"> {
  return {
    azimuth: 0.38,
    elevation: 0.48,
    radius: shape === "globe" ? 54 : 46,
  };
}
