import type { ActivityPoint, TabAnalyticsStats } from "../api";

/** Visible slice of a long session. Dragging moves this across the full span. */
export const AREA_MAP_WINDOW_MS = 30 * 60 * 1000;

export interface SessionSpan {
  start: number;
  end: number;
}

export interface TimeWindow {
  start: number;
  end: number;
  spanStart: number;
  spanEnd: number;
  /** The session is longer than the window, so the window can move. */
  slidable: boolean;
}

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
  const span = Math.max(1, view.spanEnd - view.spanStart);
  const widthPct = Math.min(100, Math.max(1.5, ((view.end - view.start) / span) * 100));
  const leftPct = Math.min(100 - widthPct, Math.max(0, ((view.start - view.spanStart) / span) * 100));
  return { leftPct, widthPct };
}

export function pointsInWindow<T extends { timestamp: number }>(
  points: readonly T[],
  start: number,
  end: number,
): T[] {
  return points.filter((point) => point.timestamp >= start && point.timestamp <= end);
}
