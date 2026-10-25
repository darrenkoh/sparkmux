import { useEffect, useState } from "react";

import { isIOSDevice } from "../transport";
import {
  readPostureOverride,
  resolvePosture,
  writePostureOverride,
  type FormFactorPosture,
  type SegmentRect,
  type ViewportGeometry,
} from "./posture";

export type { FormFactorPosture, ViewportGeometry };

function readSegments(): SegmentRect[] | undefined {
  const view = window.visualViewport as VisualViewport & { segments?: DOMRect[] };
  const raw =
    view?.segments ??
    (window as Window & { getWindowSegments?: () => DOMRect[] }).getWindowSegments?.();
  if (!raw || raw.length < 2) return undefined;
  return raw.map((rect) => ({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.right,
    bottom: rect.bottom,
  }));
}

function readLive(): ViewportGeometry {
  const override = readPostureOverride(window.localStorage);
  const vv = window.visualViewport;
  const touch =
    navigator.maxTouchPoints > 0 ||
    "ontouchstart" in window ||
    window.matchMedia("(pointer: coarse)").matches ||
    isIOSDevice();
  const postureType = (navigator as Navigator & { devicePosture?: { type?: string } }).devicePosture
    ?.type;
  return resolvePosture({
    width: window.innerWidth,
    height: window.innerHeight,
    isTouch: touch,
    segments: readSegments(),
    devicePostureType: postureType,
    override,
    visualHeight: vv ? vv.height : window.innerHeight,
    visualOffsetTop: vv ? vv.offsetTop : 0,
  });
}

export function useDevicePosture(): ViewportGeometry & {
  setPostureOverride: (override: FormFactorPosture | null) => void;
  postureOverride: FormFactorPosture | null;
} {
  const [postureOverride, setPostureOverrideState] = useState<FormFactorPosture | null>(() => {
    try {
      return readPostureOverride(window.localStorage);
    } catch {
      return null;
    }
  });
  const [geo, setGeo] = useState<ViewportGeometry>(() => {
    if (typeof window === "undefined") {
      return resolvePosture({ width: 1280, height: 800, isTouch: false });
    }
    return readLive();
  });

  const setPostureOverride = (next: FormFactorPosture | null) => {
    setPostureOverrideState(next);
    try {
      writePostureOverride(window.localStorage, next);
    } catch {
      /* private mode */
    }
  };

  useEffect(() => {
    const update = () => setGeo(readLive());
    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    const posture = (navigator as Navigator & { devicePosture?: EventTarget }).devicePosture;
    posture?.addEventListener?.("change", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      posture?.removeEventListener?.("change", update);
    };
  }, [postureOverride]);

  return { ...geo, postureOverride, setPostureOverride };
}
