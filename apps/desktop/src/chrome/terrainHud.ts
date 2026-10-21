/** Pixel frame of the VALUE altitude ruler. */
export interface ValueAxisFrame {
  top: number;
  bottom: number;
  labelY: number;
  /** False when a short docked canvas cannot fit tick marks. The label still draws. */
  showTicks: boolean;
}

/**
 * Fullscreen keeps the original ruler under the toolbar.
 * Docked maps draw the label under the corner badge and above the
 * "3D TOPOGRAPHY" chip, and drop ticks when the canvas is too short.
 */
export function valueAxisFrame(height: number, docked: boolean): ValueAxisFrame {
  if (!docked) {
    const top = 70;
    return { top, bottom: height - 50, labelY: top - 8, showTicks: true };
  }
  const labelY = Math.min(36, Math.max(14, height - 12));
  const top = labelY + 8;
  const bottom = Math.min(height - 8, Math.max(top + 12, height - 26));
  const showTicks = height >= 88 && bottom > top + 10;
  return { top, bottom, labelY, showTicks };
}

/** Metric ticks for the docked VALUE chip, highest first, always including 0. */
export function dockedValueTicks(maxAltitude: number, maxMetric: number): number[] {
  if (!(maxAltitude > 0) || !Number.isFinite(maxAltitude) || !Number.isFinite(maxMetric)) return [0];
  const step = valueAxisStep(maxAltitude, 64, true);
  const ticks: number[] = [];
  const seen = new Set<number>();
  const push = (metric: number) => {
    const rounded = Math.round(metric);
    if (seen.has(rounded)) return;
    seen.add(rounded);
    ticks.push(rounded);
  };
  for (let v = maxAltitude; v >= -0.05; v -= step) {
    push((Math.max(0, v) / maxAltitude) * Math.max(0, maxMetric));
  }
  push(0);
  return ticks;
}

/** Major tick spacing. A short docked ruler widens the step so the numbers do not stack. */
export function valueAxisStep(maxAltitude: number, spanPx: number, docked: boolean): number {
  const base = maxAltitude <= 5 ? 1 : 2;
  if (!docked || !(spanPx > 0) || !(maxAltitude > 0)) return base;
  let step = base;
  while (step < maxAltitude && spanPx / (maxAltitude / step) < 12) {
    const next = step * 2;
    if (next === step) break;
    step = next;
  }
  return step;
}
