import type { ActivityPoint, TabAnalyticsStats } from "../api";

/** Visible slice of a long session. Dragging moves this across the compressed span. */
export const AREA_MAP_WINDOW_MS = 30 * 60 * 1000;

/**
 * Quiet stretch longer than this collapses. Five minutes of silence between
 * buckets is still real spacing; anything longer is idle.
 */
export const IDLE_GAP_MS = 5 * 60 * 1000;

/**
 * Display width of a collapsed gap, in compressed time. Two minutes is a
 * short seam on the 30-minute window, wide enough to label.
 */
export const COMPRESSED_GAP_MS = 2 * 60 * 1000;

export interface SessionSpan {
  start: number;
  end: number;
}

export interface TimeSeam {
  /** Wall-clock start of the quiet stretch. */
  wallStart: number;
  /** Wall-clock end of the quiet stretch. */
  wallEnd: number;
  /** Real duration that was folded away. */
  gapMs: number;
  /** Compressed-axis offset of the seam from the session start. */
  compStart: number;
  compEnd: number;
  /** Short label such as `+2h` or `+14m`. */
  label: string;
}

interface TimePiece {
  wallStart: number;
  wallEnd: number;
  compStart: number;
  compEnd: number;
  seam: boolean;
}

/** Piecewise map from wall-clock time to a span that skips long idle. */
export interface CompressedAxis {
  wallStart: number;
  wallEnd: number;
  /** Duration after long gaps have been folded. */
  spanMs: number;
  pieces: TimePiece[];
  seams: TimeSeam[];
}

export interface TimeWindow {
  /** Wall-clock bounds of the visible slice. */
  start: number;
  end: number;
  spanStart: number;
  spanEnd: number;
  /** The compressed session is longer than the window, so the window can move. */
  slidable: boolean;
  /** Compressed-axis bounds. The scrubber and column placement use these. */
  compStart?: number;
  compEnd?: number;
  compSpanStart?: number;
  compSpanEnd?: number;
  seams?: TimeSeam[];
}

type ActivityStamp = Pick<ActivityPoint, "timestamp" | "user_count" | "think_count" | "reply_count" | "tool_count">;

export function sessionSpan(
  timeline: readonly Pick<ActivityPoint, "timestamp">[],
  stats?: Pick<TabAnalyticsStats, "timeline_start" | "timeline_end"> | null,
): SessionSpan {
  let first = 0;
  let last = 0;
  for (const point of timeline) {
    if (typeof point.timestamp !== "number") continue;
    if (first === 0 || point.timestamp < first) first = point.timestamp;
    if (point.timestamp > last) last = point.timestamp;
  }
  const start = stats?.timeline_start && stats.timeline_start > 0 ? stats.timeline_start : first;
  const endFromStats = stats?.timeline_end && stats.timeline_end > 0 ? stats.timeline_end : last;
  return { start, end: Math.max(start, endFromStats, last) };
}

/** A column raises terrain when a user, think, reply, or tool event landed in it. */
export function isMapActivity(point: Pick<ActivityStamp, "user_count" | "think_count" | "reply_count" | "tool_count">): boolean {
  return (point.user_count ?? 0) > 0
    || (point.think_count ?? 0) > 0
    || (point.reply_count ?? 0) > 0
    || (point.tool_count ?? 0) > 0;
}

/** `+2h`, `+14m`, or `+2h 14m`. Minutes are rounded. */
export function formatGap(ms: number): string {
  const totalMin = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours <= 0) return `+${minutes}m`;
  if (minutes === 0) return `+${hours}h`;
  return `+${hours}h ${minutes}m`;
}

/**
 * Fold quiet stretches longer than five minutes down to a two-minute seam.
 * Activity on either side keeps its real spacing.
 */
export function activityAxis<T extends { timestamp: number }>(
  timeline: readonly T[],
  stats?: Pick<TabAnalyticsStats, "timeline_start" | "timeline_end"> | null,
  isActive?: (point: T) => boolean,
): CompressedAxis {
  const activeCheck = isActive ?? ((point: T) => isMapActivity(point as unknown as ActivityStamp));
  const span = sessionSpan(timeline, stats);
  const active: number[] = [];
  for (const point of timeline) {
    if (typeof point.timestamp !== "number" || !activeCheck(point)) continue;
    active.push(point.timestamp);
  }
  active.sort((a, b) => a - b);

  const anchors: number[] = [span.start];
  for (const timestamp of active) {
    if (timestamp < span.start || timestamp > span.end) continue;
    if (anchors[anchors.length - 1] !== timestamp) anchors.push(timestamp);
  }
  if (anchors[anchors.length - 1] !== span.end) anchors.push(span.end);

  const pieces: TimePiece[] = [];
  const seams: TimeSeam[] = [];
  let comp = 0;
  for (let i = 0; i < anchors.length - 1; i++) {
    const wallStart = anchors[i];
    const wallEnd = anchors[i + 1];
    const delta = wallEnd - wallStart;
    if (delta <= 0) continue;
    const seam = delta > IDLE_GAP_MS;
    const width = seam ? COMPRESSED_GAP_MS : delta;
    pieces.push({
      wallStart,
      wallEnd,
      compStart: comp,
      compEnd: comp + width,
      seam,
    });
    if (seam) {
      seams.push({
        wallStart,
        wallEnd,
        gapMs: delta,
        compStart: comp,
        compEnd: comp + width,
        label: formatGap(delta),
      });
    }
    comp += width;
  }

  return { wallStart: span.start, wallEnd: span.end, spanMs: comp, pieces, seams };
}

export function wallToCompressed(axis: CompressedAxis, wall: number): number {
  if (axis.pieces.length === 0 || wall <= axis.wallStart) return 0;
  if (wall >= axis.wallEnd) return axis.spanMs;
  for (const piece of axis.pieces) {
    if (wall > piece.wallEnd) continue;
    const wallSpan = piece.wallEnd - piece.wallStart;
    const fraction = wallSpan <= 0 ? 0 : (wall - piece.wallStart) / wallSpan;
    return piece.compStart + fraction * (piece.compEnd - piece.compStart);
  }
  return axis.spanMs;
}

export function compressedToWall(axis: CompressedAxis, comp: number): number {
  if (axis.pieces.length === 0 || comp <= 0) return axis.wallStart;
  if (comp >= axis.spanMs) return axis.wallEnd;
  for (const piece of axis.pieces) {
    if (comp > piece.compEnd) continue;
    const compSpan = piece.compEnd - piece.compStart;
    const fraction = compSpan <= 0 ? 0 : (comp - piece.compStart) / compSpan;
    return piece.wallStart + fraction * (piece.wallEnd - piece.wallStart);
  }
  return axis.wallEnd;
}

/** Clamp a window start so a 30-minute slice stays inside the session. */
export function viewWindow(spanStart: number, spanEnd: number, windowStart: number): TimeWindow {
  const span = Math.max(0, spanEnd - spanStart);
  if (span <= 0) {
    return { start: spanStart, end: spanStart, spanStart, spanEnd: spanStart, slidable: false };
  }
  const width = Math.min(AREA_MAP_WINDOW_MS, span);
  const maxStart = spanStart + (span - width);
  const start = Math.min(Math.max(windowStart, spanStart), maxStart);
  return {
    start,
    end: start + width,
    spanStart,
    spanEnd,
    slidable: span > AREA_MAP_WINDOW_MS + 1000,
  };
}

/**
 * A 30-minute window on the compressed axis. `compressedStart` is an offset
 * from the start of that axis, not a wall-clock timestamp.
 */
export function mapWindow(axis: CompressedAxis, compressedStart: number): TimeWindow {
  const sliced = viewWindow(0, axis.spanMs, compressedStart);
  return {
    start: compressedToWall(axis, sliced.start),
    end: compressedToWall(axis, sliced.end),
    spanStart: axis.wallStart,
    spanEnd: axis.wallEnd,
    slidable: sliced.slidable,
    compStart: sliced.start,
    compEnd: sliced.end,
    compSpanStart: 0,
    compSpanEnd: axis.spanMs,
    seams: axis.seams.filter((seam) => seam.compEnd > sliced.start && seam.compStart < sliced.end),
  };
}

/** `fraction` 0 is the start of the session. 1 is the latest slice. */
export function windowStartFromFraction(spanStart: number, spanEnd: number, fraction: number): number {
  const span = Math.max(0, spanEnd - spanStart);
  const width = Math.min(AREA_MAP_WINDOW_MS, span);
  const maxOffset = Math.max(0, span - width);
  const clamped = Math.min(1, Math.max(0, fraction));
  return spanStart + clamped * maxOffset;
}

export function windowTrack(
  view: TimeWindow,
): { leftPct: number; widthPct: number } {
  const spanStart = view.compSpanStart ?? view.spanStart;
  const spanEnd = view.compSpanEnd ?? view.spanEnd;
  const start = view.compStart ?? view.start;
  const end = view.compEnd ?? view.end;
  const span = Math.max(1, spanEnd - spanStart);
  const widthPct = Math.min(100, Math.max(1.5, ((end - start) / span) * 100));
  const leftPct = Math.min(100 - widthPct, Math.max(0, ((start - spanStart) / span) * 100));
  return { leftPct, widthPct };
}

export function pointsInWindow<T extends { timestamp: number }>(
  points: readonly T[],
  start: number,
  end: number,
): T[] {
  return points.filter((point) => point.timestamp >= start && point.timestamp <= end);
}
