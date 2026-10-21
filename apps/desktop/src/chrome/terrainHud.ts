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
