/** Foldable and touch layout geometry. The hook and the tests both call this. */

export type FormFactorPosture =
  | "desktop"
  | "ipad-pro"
  | "duo-book"
  | "duo-clamshell"
  | "phone-compact";

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
    hingeRect,
    leftSegmentWidth,
    topSegmentHeight,
    visualHeight,
    visualOffsetTop,
    keyboardInsetBottom,
  };
}

/** Visible app height while the software keyboard is open. */
export function appShellHeight(geo: ViewportGeometry): string {
  if (geo.keyboardInsetBottom > 0) return `${geo.visualHeight}px`;
  return "100%";
}
