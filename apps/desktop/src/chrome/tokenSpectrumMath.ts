import type { ActivityPoint, TabAnalyticsStats } from "../api";
import { activityAxis, wallToCompressed } from "./terrainWindow.ts";

export type TokenChartMode = "contour" | "burst" | "gauge";
export type ChannelKey = "cache" | "input" | "reasoning" | "output";

export interface ChannelDef {
  key: ChannelKey;
  label: string;
  tag: string;
  color: string;
  glow: string;
  bgGradient: string;
}

export const CHANNELS: ChannelDef[] = [
  {
    key: "cache",
    label: "CACHE READ",
    tag: "CR",
    color: "#ff9a3c",
    glow: "rgba(255, 154, 60, 0.6)",
    bgGradient: "rgba(255, 154, 60, 0.28)",
  },
  {
    key: "input",
    label: "INPUT",
    tag: "IN",
    color: "#5b8def",
    glow: "rgba(91, 141, 239, 0.6)",
    bgGradient: "rgba(91, 141, 239, 0.26)",
  },
  {
    key: "reasoning",
    label: "REASONING",
    tag: "RS",
    color: "#c084fc",
    glow: "rgba(192, 132, 252, 0.6)",
    bgGradient: "rgba(192, 132, 252, 0.24)",
  },
  {
    key: "output",
    label: "OUTPUT",
    tag: "OUT",
    color: "#3dd68c",
    glow: "rgba(61, 214, 140, 0.6)",
    bgGradient: "rgba(61, 214, 140, 0.26)",
  },
];

export interface ProcessedBucket {
  timestamp: number;
  timeLabel: string;
  /** Position on the compressed time axis. 0 is the session start, 1 is the latest bucket. */
  xFraction: number;
  cache: number;
  input: number;
  reasoning: number;
  output: number;
  total: number;
  stackCache: number;
  stackInput: number;
  stackReasoning: number;
  stackOutput: number;
  cacheHitRate: number;
}

export interface SpectrumSeam {
  /** Center of the folded gap on the same 0–1 axis as `xFraction`. */
  fraction: number;
  /** Real duration, such as `+2h`. */
  label: string;
  /** Wall-clock duration that was folded. */
  gapMs: number;
  wallStart: number;
  wallEnd: number;
}

export interface ProcessedTimeline {
  buckets: ProcessedBucket[];
  seams: SpectrumSeam[];
  /** Sum over seams of wall duration minus compressed width. */
  totalFoldedMs: number;
}

/** A spectrum column is active when it has tokens or a map event. */
export function isSpectrumActivity(point: Partial<ActivityPoint>): boolean {
  return (point.tokens ?? 0) > 0
    || (point.input_tokens ?? 0) > 0
    || (point.output_tokens ?? 0) > 0
    || (point.cache_read_tokens ?? 0) > 0
    || (point.cache_write_tokens ?? 0) > 0
    || (point.reasoning_tokens ?? 0) > 0
    || (point.user_count ?? 0) > 0
    || (point.think_count ?? 0) > 0
    || (point.reply_count ?? 0) > 0
    || (point.tool_count ?? 0) > 0;
}

/** Format milliseconds offset into +MM:SS or HH:MM:SS */
export function formatTimeOffset(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `+${h}h${rm.toString().padStart(2, "0")}m`;
  }
  return `+${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/** Calculate cache hit rate percentage */
export function computeLocalCacheHitRate(cache: number, input: number): number {
  const sum = cache + input;
  if (sum <= 0) return 0;
  return (cache / sum) * 100;
}

/**
 * Normalizes timeline buckets into stacked coordinates.
 * Generates synthetic baseline buckets if the session has fewer than 2 data points.
 */
export function processTimelineData(
  timeline: ActivityPoint[],
  stats?: TabAnalyticsStats | null,
): ProcessedTimeline {
  const points = (timeline || []).filter((p) => p && typeof p.timestamp === "number");

  if (points.length === 0) {
    // Generate empty synthetic 16-point baseline
    const now = Date.now();
    const buckets: ProcessedBucket[] = [];
    const count = 16;
    for (let i = 0; i < count; i++) {
      buckets.push({
        timestamp: now - (count - 1 - i) * 60_000,
        timeLabel: `T-${(count - 1 - i) * 60}s`,
        xFraction: count > 1 ? i / (count - 1) : 0.5,
        cache: 0,
        input: 0,
        reasoning: 0,
        output: 0,
        total: 0,
        stackCache: 0,
        stackInput: 0,
        stackReasoning: 0,
        stackOutput: 0,
        cacheHitRate: 0,
      });
    }
    return { buckets, seams: [], totalFoldedMs: 0 };
  }

  const startT = points[0].timestamp;
  const axis = activityAxis(points, stats, isSpectrumActivity);
  const span = axis.spanMs;
  const seams: SpectrumSeam[] = span <= 0
    ? []
    : axis.seams.map((seam) => ({
        fraction: ((seam.compStart + seam.compEnd) / 2) / span,
        label: seam.label,
        gapMs: seam.gapMs,
        wallStart: seam.wallStart,
        wallEnd: seam.wallEnd,
      }));

  const buckets = points.map((p, idx) => {
    // Read bucket tokens, fallback to total tokens or stats proportion if unpopulated
    let cache = p.cache_read_tokens ?? 0;
    let input = p.input_tokens ?? 0;
    let reasoning = p.reasoning_tokens ?? 0;
    let output = p.output_tokens ?? 0;

    // If explicit breakdown is zero but p.tokens > 0, estimate from stats ratio
    if (cache === 0 && input === 0 && reasoning === 0 && output === 0 && p.tokens > 0 && stats) {
      const grandTotal =
        (stats.total_cache_read_tokens || 0) +
        (stats.total_input_tokens || 0) +
        (stats.total_reasoning_tokens || 0) +
        (stats.total_output_tokens || 0);
      if (grandTotal > 0) {
        cache = Math.round((stats.total_cache_read_tokens / grandTotal) * p.tokens);
        input = Math.round((stats.total_input_tokens / grandTotal) * p.tokens);
        reasoning = Math.round((stats.total_reasoning_tokens / grandTotal) * p.tokens);
        output = Math.max(0, p.tokens - cache - input - reasoning);
      } else {
        input = p.tokens;
      }
    }

    const total = cache + input + reasoning + output;
    const stackCache = cache;
    const stackInput = stackCache + input;
    const stackReasoning = stackInput + reasoning;
    const stackOutput = stackReasoning + output;

    const offsetMs = p.timestamp - startT;
    const timeLabel = idx === 0 ? "T0" : formatTimeOffset(offsetMs);

    return {
      timestamp: p.timestamp,
      timeLabel,
      xFraction: span <= 0 ? 0.5 : wallToCompressed(axis, p.timestamp) / span,
      cache,
      input,
      reasoning,
      output,
      total,
      stackCache,
      stackInput,
      stackReasoning,
      stackOutput,
      cacheHitRate: computeLocalCacheHitRate(cache, input),
    };
  });

  return { buckets, seams, totalFoldedMs: axis.totalFoldedMs };
}

/**
 * The seam this bucket opens: the first bucket at or after `wallEnd`
 * (1 ms tolerance). A later bucket in that burst returns null.
 */
export function seamBeforeBucket(
  buckets: ProcessedBucket[],
  seams: SpectrumSeam[],
  index: number,
): SpectrumSeam | null {
  if (index < 0 || index >= buckets.length) return null;
  const bucket = buckets[index].timestamp;
  const prev = index > 0 ? buckets[index - 1].timestamp : Number.NEGATIVE_INFINITY;
  let found: SpectrumSeam | null = null;
  for (const seam of seams) {
    const end = seam.wallEnd - 1;
    if (bucket >= end && prev < end) found = seam;
  }
  return found;
}

// ---------------------------------------------------------------------------
// 3D Matrix & Perspective Projection Math (Matches Area Map)
// ---------------------------------------------------------------------------

export function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

export function lookAt(
  eye: [number, number, number],
  target: [number, number, number],
  up: [number, number, number] = [0, 1, 0],
): Float32Array {
  const z0 = eye[0] - target[0];
  const z1 = eye[1] - target[1];
  const z2 = eye[2] - target[2];
  const lenZ = Math.hypot(z0, z1, z2) || 1;
  const zx = z0 / lenZ, zy = z1 / lenZ, zz = z2 / lenZ;

  const x0 = up[1] * zz - up[2] * zy;
  const x1 = up[2] * zx - up[0] * zz;
  const x2 = up[0] * zy - up[1] * zx;
  const lenX = Math.hypot(x0, x1, x2) || 1;
  const xx = x0 / lenX, xy = x1 / lenX, xz = x2 / lenX;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

export function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] =
        a[j] * b[i * 4] +
        a[4 + j] * b[i * 4 + 1] +
        a[8 + j] * b[i * 4 + 2] +
        a[12 + j] * b[i * 4 + 3];
    }
  }
  return out;
}

export function projectPoint(
  vp: Float32Array,
  p: [number, number, number],
  width: number,
  height: number,
): [number, number, number] | null {
  const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
  const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
  const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  if (w <= 0.01) return null;
  return [((x / w) * 0.5 + 0.5) * width, (0.5 - (y / w) * 0.5) * height, w];
}

export const Z_LANES: Record<ChannelKey, number> = {
  cache: -4.5,
  input: -1.5,
  reasoning: 1.5,
  output: 4.5,
};

export const X_SPAN = 22.0;
export const X_MIN = -11.0;
export const MAX_VISUAL_Y = 6.2;
export const CONTOUR_SCAN_SPEED = 0.22;

/** Computes synchronized progress [0, 1) across the time axis for 3D contour scanning */
export function computeContourScanProgress(elapsed: number, speed: number = CONTOUR_SCAN_SPEED): number {
  const p = (elapsed * speed) % 1.0;
  return p < 0 ? p + 1.0 : p;
}

export function getCameraProjector(
  w: number,
  h: number,
  cam: { azimuth: number; elevation: number; radius: number },
) {
  const eyeX = cam.radius * Math.cos(cam.elevation) * Math.sin(cam.azimuth);
  const eyeY = cam.radius * Math.sin(cam.elevation);
  const eyeZ = cam.radius * Math.cos(cam.elevation) * Math.cos(cam.azimuth);

  const matProj = perspective((38 * Math.PI) / 180, w / h, 0.5, 200);
  const matView = lookAt([eyeX, eyeY, eyeZ], [0, 1.2, 0]);
  const matVP = multiply(matProj, matView);
  return (p: [number, number, number]) => projectPoint(matVP, p, w, h);
}
