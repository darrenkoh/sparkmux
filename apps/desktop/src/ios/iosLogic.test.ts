import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appShellHeight,
  readPostureOverride,
  resolvePosture,
  writePostureOverride,
  type PostureStorage,
  type SegmentRect,
} from "./posture.ts";
import {
  arrowBytes,
  encodeCtrlLetter,
  escBytes,
  pinchFontSize,
  shiftTabBytes,
  tabBytes,
  textBytes,
  TMUX_CTRL,
  touchDragDelta,
} from "./touchKeys.ts";
import { decideWheel } from "../terminal/promptScroll.ts";
import {
  isDoubleTap,
  milestoneHitRadius,
  orbitCamera,
  panCameraTarget,
  pinchRadius,
  resetCamera,
  type MapCamera,
} from "./mapGestures.ts";

function seg(left: number, top: number, width: number, height: number): SegmentRect {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function memoryStorage(): PostureStorage {
  const bag = new Map<string, string>();
  return {
    getItem: (key) => bag.get(key) ?? null,
    setItem: (key, value) => {
      bag.set(key, value);
    },
    removeItem: (key) => {
      bag.delete(key);
    },
  };
}

test("horizontal segments resolve to duo-book with a hinge gutter", () => {
  const geo = resolvePosture({
    width: 900,
    height: 700,
    isTouch: true,
    segments: [seg(0, 0, 430, 700), seg(454, 0, 446, 700)],
  });
  assert.equal(geo.posture, "duo-book");
  assert.equal(geo.leftSegmentWidth, 430);
  assert.deepEqual(geo.hingeRect, { x: 430, y: 0, width: 24, height: 700 });
});

test("vertical segments resolve to duo-clamshell", () => {
  const geo = resolvePosture({
    width: 400,
    height: 900,
    isTouch: true,
    segments: [seg(0, 0, 400, 420), seg(0, 444, 400, 456)],
  });
  assert.equal(geo.posture, "duo-clamshell");
  assert.equal(geo.topSegmentHeight, 420);
  assert.ok(geo.hingeRect);
  assert.equal(geo.hingeRect?.height, 24);
});

test("a folded or square touch canvas is duo-book", () => {
  const folded = resolvePosture({
    width: 900,
    height: 500,
    isTouch: true,
    devicePostureType: "folded",
  });
  assert.equal(folded.posture, "duo-book");
  assert.equal(folded.leftSegmentWidth, 450);
  const square = resolvePosture({ width: 800, height: 800, isTouch: true });
  assert.equal(square.posture, "duo-book");
  assert.equal(square.leftSegmentWidth, 400);
});

test("touch width 600 is phone-compact and 1024 is ipad-pro", () => {
  assert.equal(resolvePosture({ width: 600, height: 900, isTouch: true }).posture, "phone-compact");
  assert.equal(resolvePosture({ width: 1024, height: 768, isTouch: true }).posture, "ipad-pro");
  assert.equal(resolvePosture({ width: 1440, height: 900, isTouch: false }).posture, "desktop");
});

test("a stored posture override wins and survives a reload", () => {
  const storage = memoryStorage();
  writePostureOverride(storage, "phone-compact");
  assert.equal(readPostureOverride(storage), "phone-compact");
  const geo = resolvePosture({
    width: 1440,
    height: 900,
    isTouch: false,
    override: readPostureOverride(storage),
  });
  assert.equal(geo.posture, "phone-compact");
  writePostureOverride(storage, null);
  assert.equal(readPostureOverride(storage), null);
});

test("the keyboard inset shrinks the shell to the visible viewport", () => {
  const geo = resolvePosture({
    width: 390,
    height: 844,
    isTouch: true,
    visualHeight: 520,
    visualOffsetTop: 0,
  });
  assert.equal(geo.keyboardInsetBottom, 324);
  assert.equal(appShellHeight(geo), "520px");
  assert.equal(appShellHeight({ ...geo, keyboardInsetBottom: 0 }), "100%");
});

test("TouchKeyBar bytes cover esc, ctrl-c, opt, tab, and arrows", () => {
  assert.deepEqual(escBytes(), [27]);
  assert.equal(encodeCtrlLetter("c"), 3);
  assert.deepEqual(TMUX_CTRL.interrupt, [3]);
  assert.deepEqual(TMUX_CTRL.eof, [4]);
  assert.deepEqual(TMUX_CTRL.suspend, [26]);
  assert.deepEqual(TMUX_CTRL.clear, [12]);
  assert.deepEqual(tabBytes(), [9]);
  assert.deepEqual(shiftTabBytes(), [0x1b, 0x5b, 0x5a]);
  assert.deepEqual(arrowBytes("A", false), [0x1b, 0x5b, 0x41]);
  assert.deepEqual(arrowBytes("C", true), [0x1b, 0x4f, 0x43]);
  assert.deepEqual(textBytes("x", true)[0], 0x1b);
});

test("a one-finger drag feeds the existing wheel decision", () => {
  const deltaY = touchDragDelta(200, 80);
  assert.ok(deltaY > 0);
  const decision = decideWheel({
    alt: false,
    mouseWheel: true,
    paneAlt: false,
    mouseReport: false,
    baseY: 12,
    rows: 40,
    cursorY: 30,
    cursorX: 0,
    cursorLine: "",
    deltaY,
    deltaMode: 0,
    shiftKey: false,
    rowHeight: 16,
  });
  assert.equal(decision.kind, "scroll");
  if (decision.kind === "scroll") assert.ok(decision.lines > 0);
});

test("pinch font stays between 11 and 22", () => {
  assert.equal(pinchFontSize(13, 2), 22);
  assert.equal(pinchFontSize(13, 0.2), 11);
  assert.equal(pinchFontSize(16, 1), 16);
});

test("map pinch clamps radius, pan moves the target, and a double tap resets", () => {
  assert.equal(pinchRadius(40, 100, 20), 90);
  assert.equal(pinchRadius(20, 40, 200), 14);
  const cam: MapCamera = { azimuth: 0, elevation: 0.48, radius: 46, target: [0, 1.2, 0] };
  const before = cam.target[0];
  panCameraTarget(cam, 40, 0);
  assert.notEqual(cam.target[0], before);
  orbitCamera(cam, 10, 4);
  assert.notEqual(cam.azimuth, 0);
  assert.equal(milestoneHitRadius("touch"), 28);
  assert.equal(milestoneHitRadius("pen"), 28);
  assert.equal(milestoneHitRadius("mouse"), 18);
  assert.equal(isDoubleTap(1_000, 1_200, 10, 10, 20, 12), true);
  assert.equal(isDoubleTap(1_000, 1_400, 10, 10, 12, 12), false);
  assert.equal(isDoubleTap(1_000, 1_100, 0, 0, 40, 0), false);
  const reset = resetCamera("rect");
  assert.equal(reset.azimuth, 0.38);
  assert.equal(reset.elevation, 0.48);
  assert.equal(reset.radius, 46);
});
