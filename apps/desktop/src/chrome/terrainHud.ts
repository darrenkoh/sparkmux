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

export interface DockedNodeLabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Screen box for one docked channel node value. The box sits just above the
 * peak and stays on the canvas. A later node steps down when it would cover
 * an earlier one.
 */
export function placeDockedNodeLabels(
  items: Array<{ x: number; y: number; textWidth: number }>,
  canvasWidth: number,
  canvasHeight: number,
  inset?: { top?: number; right?: number; bottom?: number; left?: number },
): DockedNodeLabelBox[] {
  const placed: DockedNodeLabelBox[] = [];
  const h = 13;
  const top = inset?.top ?? 4;
  const right = inset?.right ?? 4;
  const bottom = inset?.bottom ?? 4;
  const left = inset?.left ?? 4;
  for (const item of items) {
    const w = Math.max(16, Math.ceil(item.textWidth) + 8);
    let x = item.x + 8;
    if (x + w > canvasWidth - right) x = item.x - w - 8;
    const maxX = Math.max(left, canvasWidth - w - right);
    x = Math.max(left, Math.min(x, maxX));
    const maxY = Math.max(top, canvasHeight - h - bottom);
    let y = item.y - h - 4;
    y = Math.max(top, Math.min(y, maxY));
    for (let guard = 0; guard < items.length; guard++) {
      const hit = placed.some(
        (box) => x < box.x + box.w && x + w > box.x && y < box.y + box.h && y + h > box.y,
      );
      if (!hit) break;
      const down = y + h + 2;
      y = down <= maxY ? down : Math.max(top, y - (h + 2));
    }
    placed.push({ x, y, w, h });
  }
  return placed;
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
