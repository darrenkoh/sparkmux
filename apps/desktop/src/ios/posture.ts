/** Foldable and touch layout geometry. The hook and the tests both call this. */

export type FormFactorPosture =
  | "desktop"
  | "ipad-pro"
  | "duo-book"
  | "duo-clamshell"
  | "phone-compact"
  | "phone-landscape";

export type PhoneOrientation = "portrait" | "landscape";

export interface SegmentRect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

export interface HingeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportGeometry {
  posture: FormFactorPosture;
  isTouch: boolean;
  /** True for portrait and landscape phones, including an overridden phone posture. */
  isPhone: boolean;
  orientation: PhoneOrientation;
  hingeRect: HingeRect | null;
  leftSegmentWidth: number | null;
  topSegmentHeight: number | null;
  visualHeight: number;
  visualOffsetTop: number;
  keyboardInsetBottom: number;
}

export interface PostureInput {
  width: number;
  height: number;
  isTouch: boolean;
  segments?: SegmentRect[];
  devicePostureType?: string;
  override?: FormFactorPosture | null;
  visualHeight?: number;
  visualOffsetTop?: number;
}

export const POSTURE_OVERRIDE_KEY = "sparkmux.postureOverride";

const POSTURES: readonly FormFactorPosture[] = [
  "desktop",
  "ipad-pro",
  "duo-book",
  "duo-clamshell",
  "phone-compact",
  "phone-landscape",
];

export interface PostureStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readPostureOverride(storage: PostureStorage): FormFactorPosture | null {
  try {
    const raw = storage.getItem(POSTURE_OVERRIDE_KEY);
    if (raw && (POSTURES as readonly string[]).includes(raw)) {
      return raw as FormFactorPosture;
    }
  } catch {
    /* private mode */
  }
  return null;
}

export function writePostureOverride(
  storage: PostureStorage,
  next: FormFactorPosture | null,
): void {
  try {
    if (next) storage.setItem(POSTURE_OVERRIDE_KEY, next);
    else storage.removeItem(POSTURE_OVERRIDE_KEY);
  } catch {
    /* private mode */
  }
}

export function resolvePosture(input: PostureInput): ViewportGeometry {
  const w = input.width;
  const h = input.height;
  const visualHeight = input.visualHeight ?? h;
  const visualOffsetTop = input.visualOffsetTop ?? 0;
  const keyboardInsetBottom = Math.max(0, Math.round(h - visualHeight - visualOffsetTop));
  const isTouch = input.isTouch;

  let hingeRect: HingeRect | null = null;
  let leftSegmentWidth: number | null = null;
  let topSegmentHeight: number | null = null;
  let detected: FormFactorPosture = "desktop";

  const segments = input.segments;
  if (segments && segments.length >= 2) {
    const s0 = segments[0];
    const s1 = segments[1];
    if (s1.left > s0.left) {
      detected = "duo-book";
      leftSegmentWidth = s0.width;
      hingeRect = {
        x: s0.right,
        y: 0,
        width: Math.max(0, s1.left - s0.right),
        height: h,
      };
    } else if (s1.top > s0.top) {
      detected = "duo-clamshell";
      topSegmentHeight = s0.height;
      hingeRect = {
        x: 0,
        y: s0.bottom,
        width: w,
        height: Math.max(0, s1.top - s0.bottom),
      };
    }
  } else if (isTouch) {
    const aspect = w / Math.max(1, h);
    const folded = input.devicePostureType === "folded";
    if (folded && w > h) {
      detected = "duo-book";
      leftSegmentWidth = Math.floor(w / 2);
    } else if (folded && h >= w) {
      detected = "duo-clamshell";
      topSegmentHeight = Math.floor(h * 0.45);
    } else if (w < 680) {
      detected = "phone-compact";
    } else if (h < 500 && w > h && Math.max(w, h) <= 1024) {
      // iPhone 17 Pro Max landscape is 956×440. A short wide touch canvas is
      // still a phone, not an iPad.
      detected = "phone-landscape";
    } else if (w >= 680 && w <= 960 && aspect >= 0.82 && aspect <= 1.28) {
      detected = "duo-book";
      leftSegmentWidth = Math.floor(w / 2);
    } else {
      detected = "ipad-pro";
    }
  }

  const posture = input.override ?? detected;
  if (posture === "duo-book" && leftSegmentWidth === null) {
    leftSegmentWidth = Math.floor(w / 2);
  }
  if (posture === "duo-clamshell" && topSegmentHeight === null) {
    topSegmentHeight = Math.floor(visualHeight * 0.44);
  }

  return {
    posture,
    isTouch,
    isPhone: posture === "phone-compact" || posture === "phone-landscape",
    orientation: orientationFor(posture, w, h),
    hingeRect,
    leftSegmentWidth,
    topSegmentHeight,
    visualHeight,
    visualOffsetTop,
    keyboardInsetBottom,
  };
}

function orientationFor(posture: FormFactorPosture, width: number, height: number): PhoneOrientation {
  if (posture === "phone-landscape") return "landscape";
  if (posture === "phone-compact") return "portrait";
  return width >= height ? "landscape" : "portrait";
}

/** iPhone portrait, iPhone landscape, and iPad share the minimalist mobile shell. */
export function isMobilePosture(posture: FormFactorPosture): boolean {
  return posture === "phone-compact" || posture === "phone-landscape" || posture === "ipad-pro";
}

/**
 * Header swipe. A move of 48px or less keeps the index.
 * A larger positive delta steps forward and wraps. A larger negative delta steps back and wraps.
 */
export function cycleTargetIndex(currentIndex: number, total: number, deltaX: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const count = Math.floor(total);
  const raw = Number.isFinite(currentIndex) ? Math.trunc(currentIndex) : 0;
  const index = ((raw % count) + count) % count;
  if (!Number.isFinite(deltaX) || Math.abs(deltaX) <= 48) return index;
  const step = deltaX > 0 ? 1 : -1;
  return (index + step + count) % count;
}

/** Horizontal travel before the header captures the pointer. */
export const HEADER_SWIPE_CAPTURE_PX = 10;

export interface HeaderPointerState {
  tracking: boolean;
  originX: number;
  originY: number;
  capture: boolean;
  /** The click after a real swipe must not open the hub or Views. */
  suppressClick: boolean;
}

export function idleHeaderPointer(): HeaderPointerState {
  return { tracking: false, originX: 0, originY: 0, capture: false, suppressClick: false };
}

export interface HeaderPointerEvent {
  type: "down" | "move" | "up" | "cancel";
  x: number;
  y: number;
}

/**
 * Header swipe state. `down` always clears `suppressClick`, so a swipe whose click
 * never arrives (the finger ended on a different control) does not swallow the next tap.
 * `move` asks for pointer capture once the gesture is clearly horizontal, so `up` still
 * arrives after the finger leaves the 36–44px bar.
 */
export function reduceHeaderPointer(
  state: HeaderPointerState,
  event: HeaderPointerEvent,
  currentIndex: number,
  total: number,
): { state: HeaderPointerState; nextIndex: number | null; captureNow: boolean } {
  if (event.type === "down") {
    return {
      state: {
        tracking: true,
        originX: event.x,
        originY: event.y,
        capture: false,
        suppressClick: false,
      },
      nextIndex: null,
      captureNow: false,
    };
  }
  if (!state.tracking) return { state, nextIndex: null, captureNow: false };
  if (event.type === "cancel") {
    return {
      state: { ...state, tracking: false, capture: false, suppressClick: false },
      nextIndex: null,
      captureNow: false,
    };
  }
  if (event.type === "move") {
    const dx = event.x - state.originX;
    const dy = event.y - state.originY;
    const captureNow =
      !state.capture &&
      Math.abs(dx) >= HEADER_SWIPE_CAPTURE_PX &&
      Math.abs(dx) > Math.abs(dy);
    return {
      state: captureNow ? { ...state, capture: true } : state,
      nextIndex: null,
      captureNow,
    };
  }
  const nextIndex = cycleTargetIndex(currentIndex, total, event.x - state.originX);
  const changed = nextIndex !== currentIndex;
  return {
    state: {
      tracking: false,
      originX: state.originX,
      originY: state.originY,
      capture: false,
      suppressClick: changed,
    },
    nextIndex: changed ? nextIndex : null,
    captureNow: false,
  };
}

/** Consume a swipe so the following click does not also open a menu. */
export function headerClickOpens(state: HeaderPointerState): { opens: boolean; state: HeaderPointerState } {
  if (!state.suppressClick) return { opens: true, state };
  return { opens: false, state: { ...state, suppressClick: false } };
}

export interface PaneZoomState {
  phoneTiled: boolean;
  zoomedPaneId: string | null;
}

/** True while every pane is visible, so the strip offers Zoom. A zoomed pane offers Tile. */
export function paneStripTiled(state: PaneZoomState): boolean {
  return state.zoomedPaneId == null;
}

/**
 * Zoom fills one pane. Tile clears that zoom and sets `phoneTiled` so phone-compact
 * does not immediately zoom again. Landscape and iPad start tiled (`phoneTiled` false
 * and no zoom), so zoom must not turn `phoneTiled` on.
 */
export function togglePaneZoom(state: PaneZoomState, focusId: string | null): PaneZoomState {
  if (state.zoomedPaneId != null) return { phoneTiled: true, zoomedPaneId: null };
  return { phoneTiled: false, zoomedPaneId: focusId };
}

/** 0 waiting, 1 failed, 2 running, 3 finished. Unknown states stay with running. */
export function agentAttentionRank(state: string): number {
  const normalized = state.trim().toLowerCase();
  if (normalized.includes("wait") || normalized === "needs_user") return 0;
  if (normalized.includes("fail")) return 1;
  if (normalized.includes("finish") || normalized === "succeeded" || normalized.includes("done")) {
    return 3;
  }
  return 2;
}

/** Visible app height while the software keyboard is open. */
export function appShellHeight(geo: ViewportGeometry): string {
  if (geo.keyboardInsetBottom > 0) return `${geo.visualHeight}px`;
  return "100%";
}
