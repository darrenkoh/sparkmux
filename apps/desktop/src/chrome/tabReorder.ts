// Reorder a session's tabs from the sidebar or the main tab bar.
// A drop that would not change order is skipped so tmux is not asked to renumber a no-op.

export type DropEdge = "before" | "after";

export interface TabDrag {
  session: string;
  windowId: string;
}

export interface TabDragHint {
  session: string;
  id: string;
  edge: DropEdge;
}

export interface TabDrop {
  session: string;
  srcWindowId: string;
  dstWindowId: string;
  before: boolean;
}

const WINDOW_ID = /^@\d+$/;
const DRAG_SLOP = 4;

let active: TabDrag | null = null;
let suppressClick = false;
let hint: TabDragHint | null = null;
let press: {
  session: string;
  windowId: string;
  pointerId: number;
  x: number;
  y: number;
  dragging: boolean;
} | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

function setReordering(on: boolean): void {
  if (typeof document === "undefined") return;
  document.body.classList.toggle("tab-reordering", on);
}

export function subscribeTabDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function tabDragHint(): TabDragHint | null {
  return hint;
}

export function tabDraggingId(): string | null {
  return active?.windowId ?? null;
}

export function shouldIgnoreTabClick(): boolean {
  return suppressClick;
}

function beginTabDrag(drag: TabDrag): void {
  active = { session: drag.session, windowId: drag.windowId };
  suppressClick = true;
}

function endTabDrag(): void {
  active = null;
  // click is dispatched after pointerup. Clear the guard after that click.
  globalThis.setTimeout(() => {
    suppressClick = false;
  }, 50);
}

/** Top/left half inserts before the row under the pointer. The midpoint inserts after. */
export function dropEdge(offset: number, size: number): DropEdge {
  if (!(size > 0) || !(offset >= 0)) return "before";
  return offset < size / 2 ? "before" : "after";
}

export function edgeFromPointer(
  point: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
  axis: "horizontal" | "vertical",
): DropEdge {
  if (axis === "vertical") return dropEdge(point.clientY - rect.top, rect.height);
  return dropEdge(point.clientX - rect.left, rect.width);
}

/**
 * Window ids after dropping `dragId` on `overId`.
 * Null when the drop is the same tab, an unknown id, or already in that slot.
 */
export function orderAfterDrop(
  orderedIds: readonly string[],
  dragId: string,
  overId: string,
  edge: DropEdge,
): string[] | null {
  if (!dragId || !overId || dragId === overId) return null;
  const from = orderedIds.indexOf(dragId);
  const over = orderedIds.indexOf(overId);
  if (from < 0 || over < 0) return null;
  if (edge === "before" && from + 1 === over) return null;
  if (edge === "after" && from === over + 1) return null;
  const next = orderedIds.filter((id) => id !== dragId);
  const slot = next.indexOf(overId);
  if (slot < 0) return null;
  next.splice(edge === "before" ? slot : slot + 1, 0, dragId);
  if (next.length !== orderedIds.length) return null;
  if (next.every((id, index) => id === orderedIds[index])) return null;
  return next;
}

/** Apply a new id order and pack indexes from the session's current base. */
export function windowsInOrder<T extends { id: string; index: number }>(
  windows: readonly T[],
  orderedIds: readonly string[],
): T[] {
  const known = new Set(orderedIds);
  const base = windows.reduce(
    (min, window) => Math.min(min, window.index),
    windows.length > 0 ? windows[0].index : 0,
  );
  const byId = new Map(windows.map((window) => [window.id, window]));
  const next: T[] = [];
  orderedIds.forEach((id, offset) => {
    const window = byId.get(id);
    if (window) next.push({ ...window, index: base + offset });
  });
  for (const window of windows) {
    if (!known.has(window.id)) next.push(window);
  }
  return next;
}

export function onTabPointerDown(
  event: {
    button: number;
    pointerId: number;
    clientX: number;
    clientY: number;
    target: EventTarget | null;
  },
  drag: TabDrag,
): void {
  if (event.button !== 0) return;
  const target = event.target;
  if (target instanceof Element && target.closest("[data-no-drag], input, textarea")) return;
  if (!drag.session || !WINDOW_ID.test(drag.windowId)) return;
  press = {
    session: drag.session,
    windowId: drag.windowId,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    dragging: false,
  };
}

export function trackTabPointer(event: {
  pointerId: number;
  clientX: number;
  clientY: number;
}): void {
  if (!press || press.pointerId !== event.pointerId) return;
  if (!press.dragging) {
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (Math.hypot(dx, dy) < DRAG_SLOP) return;
    press.dragging = true;
    beginTabDrag({ session: press.session, windowId: press.windowId });
    setReordering(true);
    publish();
  }
  const row = rowUnder(event.clientX, event.clientY);
  let next: TabDragHint | null = null;
  if (row) {
    const session = row.dataset.tabSession ?? "";
    const id = row.dataset.tabWindow ?? "";
    const axis = row.dataset.tabAxis === "vertical" ? "vertical" : "horizontal";
    if (session === press.session && id !== press.windowId && WINDOW_ID.test(id)) {
      next = {
        session,
        id,
        edge: edgeFromPointer(event, row.getBoundingClientRect(), axis),
      };
    }
  }
  if (hint?.session === next?.session && hint?.id === next?.id && hint?.edge === next?.edge) return;
  hint = next;
  publish();
}

export function takeTabDrop(
  event: { pointerId: number },
  commit: boolean,
): TabDrop | null {
  if (!press || press.pointerId !== event.pointerId) return null;
  const was = press;
  const current = hint;
  press = null;
  hint = null;
  setReordering(false);
  if (was.dragging) endTabDrag();
  publish();
  if (!commit || !was.dragging || !current) return null;
  if (current.session !== was.session || current.id === was.windowId) return null;
  if (!WINDOW_ID.test(current.id)) return null;
  return {
    session: was.session,
    srcWindowId: was.windowId,
    dstWindowId: current.id,
    before: current.edge === "before",
  };
}

export function cancelTabDrag(): void {
  if (!press && !hint && !active) return;
  press = null;
  hint = null;
  setReordering(false);
  if (active) endTabDrag();
  publish();
}

export function installWindowTabDrag(
  onReorder: (
    session: string,
    srcWindowId: string,
    dstWindowId: string,
    before: boolean,
  ) => void,
): () => void {
  const move = (event: PointerEvent) => trackTabPointer(event);
  const up = (event: PointerEvent) => {
    const drop = takeTabDrop(event, true);
    if (drop) onReorder(drop.session, drop.srcWindowId, drop.dstWindowId, drop.before);
  };
  const cancel = (event: PointerEvent) => {
    takeTabDrop(event, false);
  };
  const blur = () => cancelTabDrag();
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", blur);
  return () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", blur);
    cancelTabDrag();
  };
}

function rowUnder(x: number, y: number): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const node = document.elementFromPoint(x, y);
  if (!(node instanceof Element)) return null;
  const row = node.closest("[data-tab-window]");
  return row instanceof HTMLElement ? row : null;
}
