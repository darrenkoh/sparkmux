/** Globe-mode instrument geometry for the area map. Rect mode does not use this. */

export const GLOBE_RADIUS = 18;

/** One outward radar ping at 1x sweep speed. */
export const RADAR_PERIOD_S = 18;

/**
 * Channel tracks, hub outward: USER, THINK, ASSISTANT, TOOL.
 * They stay inside the disc so the ping still has an outer lane.
 */
export const CHANNEL_RING_FRAC = [0.22, 0.38, 0.54, 0.7] as const;

/** Empty wedge so the start of the window and now do not sit on the same ray. */
export const RING_TIME_GAP = 0.42;

const TAU = Math.PI * 2;
const RING_RADIAL_SIGMA = 0.62;
const RING_TIME_SIGMA = 0.05;

export interface RingPeak {
  frac: number;
  h: readonly [number, number, number, number];
}

function wrapTau(delta: number): number {
  const m = delta % TAU;
  return m < 0 ? m + TAU : m;
}

/** 0 is the left side of the disc (−X). Time runs counterclockwise. */
export function timeFracToAngle(frac: number): number {
  return Math.PI + frac * (TAU - RING_TIME_GAP);
}

/** Inverse of `timeFracToAngle`. Null inside the start/now notch. */
export function angleToTimeFrac(angle: number): number | null {
  const span = TAU - RING_TIME_GAP;
  const delta = wrapTau(angle - Math.PI);
  if (delta > span + 1e-4) return null;
  return delta / span;
}

export function ringXZ(channel: number, frac: number, radius = GLOBE_RADIUS): [number, number] {
  const ang = timeFracToAngle(frac);
  const r = radius * CHANNEL_RING_FRAC[channel];
  return [Math.cos(ang) * r, Math.sin(ang) * r];
}

/** Activity for the four channel rings. Zero in the notch and off a track. */
export function globeRingRidges(
  x: number,
  z: number,
  peaks: readonly RingPeak[],
  radius = GLOBE_RADIUS,
): number {
  const frac = angleToTimeFrac(Math.atan2(z, x));
  if (frac == null) return 0;
  const r = Math.hypot(x, z);
  const radialDen = 2 * RING_RADIAL_SIGMA * RING_RADIAL_SIGMA;
  const timeDen = 2 * RING_TIME_SIGMA * RING_TIME_SIGMA;
  let ridges = 0;
  for (let c = 0; c < CHANNEL_RING_FRAC.length; c++) {
    const dr = r - radius * CHANNEL_RING_FRAC[c];
    if (Math.abs(dr) > 2.4) continue;
    const radial = Math.exp(-(dr * dr) / radialDen);
    let along = 0;
    for (let p = 0; p < peaks.length; p++) {
      const d = Math.abs(frac - peaks[p].frac);
      if (d > 0.2) continue;
      along += Math.exp(-(d * d) / timeDen) * peaks[p].h[c];
    }
    ridges += radial * along;
  }
  return ridges;
}

export interface ElevField {
  map: Float32Array;
  gridX: number;
  gridZ: number;
  originX: number;
  originZ: number;
  invStepX: number;
  invStepZ: number;
}

type Sample = (x: number, z: number) => number;

function pushSeg(
  out: number[],
  x0: number, y0: number, z0: number, a0: number,
  x1: number, y1: number, z1: number, a1: number,
) {
  out.push(x0, y0, z0, a0, x1, y1, z1, a1);
}

function pushFlatRing(out: number[], radius: number, y: number, alpha: number, segs: number) {
  for (let i = 0; i < segs; i++) {
    const th0 = (i / segs) * Math.PI * 2;
    const th1 = ((i + 1) / segs) * Math.PI * 2;
    pushSeg(
      out,
      Math.cos(th0) * radius, y, Math.sin(th0) * radius, alpha,
      Math.cos(th1) * radius, y, Math.sin(th1) * radius, alpha,
    );
  }
}

/** Rim, cardinal ticks, and degree ticks. Sits on the coast, not on the dome. */
export function globeBezelVerts(radius = GLOBE_RADIUS): Float32Array {
  const verts: number[] = [];
  const rimSegs = 180;
  pushFlatRing(verts, radius, 0.045, 0.92, rimSegs);
  pushFlatRing(verts, radius * 0.972, 0.03, 0.34, rimSegs);

  const ticks = 36;
  for (let i = 0; i < ticks; i++) {
    const th = (i / ticks) * Math.PI * 2;
    const cardinal = i % 9 === 0;
    const major = i % 3 === 0;
    const inner = radius * (cardinal ? 0.955 : 0.978);
    const outer = radius * (cardinal ? 1.09 : major ? 1.055 : 1.028);
    const alpha = cardinal ? 0.95 : major ? 0.58 : 0.28;
    const y = cardinal ? 0.08 : 0.05;
    pushSeg(
      verts,
      Math.cos(th) * inner, y, Math.sin(th) * inner, alpha,
      Math.cos(th) * outer, y, Math.sin(th) * outer, alpha,
    );
  }

  return new Float32Array(verts);
}

/**
 * Soft limb outside the disc. `gain` is the breath, 0.55–1, baked into the
 * line brightness because the contour shader has no extra uniform.
 */
export function globeHaloVerts(gain = 1, radius = GLOBE_RADIUS): Float32Array {
  const layers = [
    { scale: 1.018, y: 0.07, alpha: 0.4 },
    { scale: 1.045, y: 0.13, alpha: 0.22 },
    { scale: 1.085, y: 0.21, alpha: 0.11 },
    { scale: 1.14, y: 0.31, alpha: 0.055 },
    { scale: 1.21, y: 0.43, alpha: 0.026 },
  ];
  const verts: number[] = [];
  const pulse = Math.max(0, gain);
  for (const layer of layers) {
    pushFlatRing(verts, radius * layer.scale, layer.y, layer.alpha * pulse, 120);
  }
  return new Float32Array(verts);
}

/** Segments in each channel ring. Four rings are packed in order, then the time spokes. */
export const TRACK_RING_SEGS = 128;
export const TRACK_RING_VERTS = TRACK_RING_SEGS * 2;

/** Four channel rings, then short spokes at the quarter-times. Skinned onto `sample`. */
export function globeTrackVerts(sample: Sample, radius = GLOBE_RADIUS): Float32Array {
  const verts: number[] = [];
  const lift = 0.06;

  for (let c = 0; c < CHANNEL_RING_FRAC.length; c++) {
    const r = radius * CHANNEL_RING_FRAC[c];
    for (let i = 0; i < TRACK_RING_SEGS; i++) {
      const th0 = (i / TRACK_RING_SEGS) * TAU;
      const th1 = ((i + 1) / TRACK_RING_SEGS) * TAU;
      const x0 = Math.cos(th0) * r;
      const z0 = Math.sin(th0) * r;
      const x1 = Math.cos(th1) * r;
      const z1 = Math.sin(th1) * r;
      pushSeg(
        verts,
        x0, sample(x0, z0) + lift, z0, 0.5,
        x1, sample(x1, z1) + lift, z1, 0.5,
      );
    }
  }

  const inner = radius * CHANNEL_RING_FRAC[0];
  const outer = radius * CHANNEL_RING_FRAC[CHANNEL_RING_FRAC.length - 1];
  const steps = 18;
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const ang = timeFracToAngle(frac);
    let px = Math.cos(ang) * inner;
    let pz = Math.sin(ang) * inner;
    let py = sample(px, pz) + lift;
    for (let s = 1; s <= steps; s++) {
      const r = inner + (outer - inner) * (s / steps);
      const x = Math.cos(ang) * r;
      const z = Math.sin(ang) * r;
      const y = sample(x, z) + lift;
      pushSeg(verts, px, py, pz, 0.2, x, y, z, 0.2);
      px = x;
      py = y;
      pz = z;
    }
  }

  return new Float32Array(verts);
}

/**
 * Expanding ping. `leadFrac` is the lead ring's radius as a fraction of the disc.
 * Fainter rings trail inward, so the sweep reads as moving outward.
 */
export function globeRadarVerts(leadFrac: number, sample: Sample, radius = GLOBE_RADIUS): Float32Array {
  const verts: number[] = [];
  const trails = 7;
  const segs = 80;
  for (let i = 0; i < trails; i++) {
    const rf = leadFrac - i * 0.045;
    if (rf < 0.025) continue;
    const r = Math.min(rf, 0.985) * radius;
    const fade = 1 - i / trails;
    const alpha = fade * fade * 0.78 + 0.04;
    const lift = i === 0 ? 0.11 : 0.05;
    for (let s = 0; s < segs; s++) {
      const a0 = (s / segs) * TAU;
      const a1 = ((s + 1) / segs) * TAU;
      const x0 = Math.cos(a0) * r;
      const z0 = Math.sin(a0) * r;
      const x1 = Math.cos(a1) * r;
      const z1 = Math.sin(a1) * r;
      pushSeg(
        verts,
        x0, sample(x0, z0) + lift, z0, alpha,
        x1, sample(x1, z1) + lift, z1, alpha,
      );
    }
  }
  return new Float32Array(verts);
}

/** Bilinear sample of the elevation grid the particles already use. */
export function sampleElev(field: ElevField, x: number, z: number): number {
  const fx = (x - field.originX) * field.invStepX;
  const fz = (z - field.originZ) * field.invStepZ;
  const gx0 = Math.min(field.gridX - 2, Math.max(0, Math.floor(fx)));
  const gz0 = Math.min(field.gridZ - 2, Math.max(0, Math.floor(fz)));
  const tx = fx - gx0;
  const tz = fz - gz0;
  const i00 = gz0 * field.gridX + gx0;
  const h00 = field.map[i00];
  const h10 = field.map[i00 + 1];
  const h01 = field.map[i00 + field.gridX];
  const h11 = field.map[i00 + field.gridX + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}
