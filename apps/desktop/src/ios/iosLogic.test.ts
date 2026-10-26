import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  agentAttentionRank,
  appShellHeight,
  cycleTargetIndex,
  headerClickOpens,
  headerControlFromAttr,
  idleHeaderPointer,
  isMobilePosture,
  paneStripTiled,
  readPostureOverride,
  reduceHeaderPointer,
  resolvePosture,
  paneStateAfterHubOpen,
  togglePaneZoom,
  writePostureOverride,
  zoomAfterPaneOpen,
  type HeaderPointerState,
  type PostureStorage,
  type SegmentRect,
} from "./posture.ts";
import { extractQuickOptions } from "./quickReplyLogic.ts";
import { sheetDetentHeight, snapSheetDetent } from "./sheetLogic.ts";
import {
  computeOverviewScale,
  defaultSizingMode,
  readSizingMode,
  resizeForSizingMode,
  shouldFixTerminalSize,
  writeSizingMode,
  type SizingStorage,
} from "./terminalSizing.ts";
import {
  arrowBytes,
  consumeModifierPhase,
  encodeCtrlLetter,
  escBytes,
  nextModifierPhase,
  pinchFontSize,
  shiftTabBytes,
  tabBytes,
  textBytes,
  TMUX_CTRL,
  touchDragDelta,
  touchTrackpadSteps,
} from "./touchKeys.ts";
import { windowResizeArgs } from "../api.ts";
import {
  connectionHealthFromPing,
  loadWsToken,
  persistWsToken,
  shouldImmediateReseed,
  type TokenBag,
} from "../transport.ts";
import { phoneMapFillsSegment } from "../chrome/phoneHudLayout.ts";
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

test("iPhone 17 Pro Max portrait, landscape, and iPad Pro stay distinct", () => {
  const portrait = resolvePosture({ width: 440, height: 956, isTouch: true });
  assert.equal(portrait.posture, "phone-compact");
  assert.equal(portrait.isPhone, true);
  assert.equal(portrait.orientation, "portrait");

  const landscape = resolvePosture({ width: 956, height: 440, isTouch: true });
  assert.equal(landscape.posture, "phone-landscape");
  assert.equal(landscape.isPhone, true);
  assert.equal(landscape.orientation, "landscape");
  assert.notEqual(landscape.posture, "ipad-pro");

  const ipad = resolvePosture({ width: 1024, height: 768, isTouch: true });
  assert.equal(ipad.posture, "ipad-pro");
  assert.equal(ipad.isPhone, false);

  const phone = resolvePosture({ width: 390, height: 844, isTouch: true });
  assert.equal(phone.posture, "phone-compact");
  assert.equal(phone.isPhone, true);
  assert.equal(resolvePosture({ width: 1440, height: 900, isTouch: false }).posture, "desktop");
});

test("quick replies extract yes/no, numbered choices, and enter approval", () => {
  const yesNo = extractQuickOptions("Apply the patch? [y/n]");
  assert.deepEqual(
    yesNo.map((option) => option.send),
    ["y", "n"],
  );
  const numbered = extractQuickOptions("Pick one:\n1. Keep the branch\n2) Rebase onto main");
  assert.deepEqual(
    numbered.map((option) => [option.label, option.send, option.enter]),
    [
      ["1: Keep the branch", "1", true],
      ["2: Rebase onto main", "2", true],
    ],
  );
  const approve = extractQuickOptions("Confirmation required. Press enter to allow this.");
  assert.equal(approve.at(-1)?.label, "Approve (Enter)");
  assert.equal(approve.at(-1)?.send, "");
  assert.equal(approve.at(-1)?.enter, true);
});

test("trackpad scrub steps reset the residual on an exact multiple", () => {
  const across = touchTrackpadSteps(28, 0, 0, 0);
  assert.equal(across.horizontal, 2);
  assert.equal(across.vertical, 0);
  assert.equal(across.residualX, 0);
  assert.equal(across.residualY, 0);

  const down = touchTrackpadSteps(0, 44, 0, 0);
  assert.equal(down.vertical, 2);
  assert.equal(down.residualY, 0);

  const leftover = touchTrackpadSteps(15, 10, 0, 0);
  assert.equal(leftover.horizontal, 1);
  assert.equal(leftover.residualX, 1);
  assert.equal(leftover.vertical, 0);
  assert.equal(leftover.residualY, 10);

  const left = touchTrackpadSteps(-14, -22, 0, 0);
  assert.equal(left.horizontal, -1);
  assert.equal(left.vertical, -1);
  assert.equal(left.residualX, 0);
  assert.equal(left.residualY, 0);
});

test("ctrl and opt cycle idle, latched, and locked", () => {
  assert.equal(nextModifierPhase("idle", false), "latched");
  assert.equal(nextModifierPhase("latched", true), "locked");
  assert.equal(nextModifierPhase("latched", false), "idle");
  assert.equal(nextModifierPhase("locked", false), "idle");
  assert.equal(consumeModifierPhase("latched"), "idle");
  assert.equal(consumeModifierPhase("locked"), "locked");
});

test("sheet release snaps to closed, peek, half, and full", () => {
  const height = 1000;
  assert.equal(sheetDetentHeight("peek", height), 64);
  assert.equal(sheetDetentHeight("half", height), 480);
  assert.equal(sheetDetentHeight("full", height), 860);
  assert.equal(snapSheetDetent(0, 0, height), "closed");
  assert.equal(snapSheetDetent(64, 0, height), "peek");
  assert.equal(snapSheetDetent(480, 0, height), "half");
  assert.equal(snapSheetDetent(860, 0, height), "full");
  assert.equal(snapSheetDetent(480, 0.5, height), "peek");
  assert.equal(snapSheetDetent(480, -0.5, height), "full");
});

function sizingBag(): SizingStorage {
  const bag = new Map<string, string>();
  return {
    getItem: (key) => bag.get(key) ?? null,
    setItem: (key, value) => {
      bag.set(key, value);
    },
  };
}

test("fit-phone is the default and a stored mirror choice stays", () => {
  assert.equal(defaultSizingMode(false), "fit-phone");
  assert.equal(defaultSizingMode(true), "fit-phone");
  const storage = sizingBag();
  assert.equal(readSizingMode(storage, false), "fit-phone");
  assert.equal(readSizingMode(storage, true), "fit-phone");
  writeSizingMode(storage, "mirror");
  assert.equal(readSizingMode(storage, false), "mirror");
  assert.equal(readSizingMode(storage, true), "mirror");
  assert.equal(storage.getItem("sparkmux.mobileSizingMode"), "mirror");

  const scale = computeOverviewScale(200, 8, 400);
  assert.ok(scale < 1);
  assert.equal(scale, 0.45);
  assert.equal(computeOverviewScale(40, 8, 400), 1);
  assert.equal(resizeForSizingMode("mirror", 80, 24), null);
  assert.deepEqual(resizeForSizingMode("fit-phone", 80, 24), { cols: 80, rows: 24, force: true });
  assert.equal(shouldFixTerminalSize(true, false, "mirror"), false);
  assert.equal(shouldFixTerminalSize(false, false, "mirror"), true);
  assert.equal(shouldFixTerminalSize(false, true, "fit-phone"), false);
});

test("isMobilePosture is phone and ipad only", () => {
  assert.equal(isMobilePosture("phone-compact"), true);
  assert.equal(isMobilePosture("phone-landscape"), true);
  assert.equal(isMobilePosture("ipad-pro"), true);
  assert.equal(isMobilePosture("desktop"), false);
  assert.equal(isMobilePosture("duo-book"), false);
  assert.equal(isMobilePosture("duo-clamshell"), false);
});

test("header swipe steps one target and wraps past 48px", () => {
  assert.equal(cycleTargetIndex(0, 3, 0), 0);
  assert.equal(cycleTargetIndex(0, 3, 48), 0);
  assert.equal(cycleTargetIndex(1, 3, -48), 1);
  assert.equal(cycleTargetIndex(0, 3, 49), 1);
  assert.equal(cycleTargetIndex(1, 4, 80), 2);
  assert.equal(cycleTargetIndex(2, 3, 49), 0);
  assert.equal(cycleTargetIndex(0, 3, -49), 2);
  assert.equal(cycleTargetIndex(2, 3, -49), 1);
  assert.equal(cycleTargetIndex(5, 3, 49), 0);
  assert.equal(cycleTargetIndex(0, 0, 80), 0);
});

test("a header swipe captures before the finger leaves the bar and the next tap still opens", () => {
  const step = (
    state: HeaderPointerState,
    type: "down" | "move" | "up" | "cancel",
    x: number,
    y: number,
  ) => reduceHeaderPointer(state, { type, x, y }, 0, 3);

  let state = idleHeaderPointer();
  let moved = step(state, "down", 0, 0);
  state = moved.state;
  moved = step(state, "move", 9, 0);
  assert.equal(moved.captureNow, false);
  moved = step(state, "move", 4, 20);
  assert.equal(moved.captureNow, false);
  moved = step(state, "move", 10, 2);
  assert.equal(moved.captureNow, true);
  state = moved.state;
  // The finger keeps going and ends outside the 36–44px bar. Capture already happened.
  moved = step(state, "up", 80, 90);
  assert.equal(moved.nextIndex, 1);
  assert.equal(moved.state.suppressClick, true);
  state = moved.state;

  assert.equal(moved.activate, null);
  const swallowed = headerClickOpens(state);
  assert.equal(swallowed.opens, false);
  assert.equal(swallowed.state.suppressClick, false);

  // The click never arrived because the swipe ended on a different control.
  // The next press clears that suppression and pointerup activates the control.
  state = moved.state;
  const nextPress = reduceHeaderPointer(state, { type: "down", x: 12, y: 4, control: "agents" }, 1, 3);
  assert.equal(nextPress.state.suppressClick, false);
  const nextUp = reduceHeaderPointer(nextPress.state, { type: "up", x: 14, y: 5 }, 1, 3);
  assert.equal(nextUp.nextIndex, null);
  assert.equal(nextUp.activate, "agents");
  assert.equal(nextUp.state.suppressClick, true);
  const opened = headerClickOpens(nextUp.state);
  assert.equal(opened.opens, false);

  const bar = readFileSync(new URL("./MobileTopBar.tsx", import.meta.url), "utf8");
  assert.match(bar, /setPointerCapture\(event\.pointerId\)/);
  assert.match(bar, /reduceHeaderPointer/);
  assert.match(bar, /headerClickOpens/);
  assert.match(bar, /result\.activate/);
  assert.match(bar, /data-header-control="agents"/);
  assert.match(bar, /data-header-control="session"/);
  assert.match(bar, /data-header-control="views"/);
  assert.match(bar, /data-header-control=\{view\.id\}/);
  assert.match(bar, /data-header-control="recipes"/);
  assert.match(bar, /data-header-control="sizing"/);
  assert.match(bar, /touchAction:\s*"none"/);
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
  const barAt = css.indexOf(".mobile-top-bar {");
  const barBlock = css.slice(barAt, css.indexOf("}", barAt));
  assert.match(barBlock, /touch-action:\s*none/);
});

test("a 10–48px header move activates the pointerdown control", () => {
  assert.equal(headerControlFromAttr("views"), "views");
  assert.equal(headerControlFromAttr("output"), "output");
  assert.equal(headerControlFromAttr("nope"), null);

  let state = idleHeaderPointer();
  let step = reduceHeaderPointer(state, { type: "down", x: 0, y: 0, control: "views" }, 0, 3);
  state = step.state;
  step = reduceHeaderPointer(state, { type: "move", x: 20, y: 1 }, 0, 3);
  assert.equal(step.captureNow, true);
  assert.equal(step.activate, null);
  state = step.state;
  step = reduceHeaderPointer(state, { type: "up", x: 40, y: 2 }, 0, 3);
  assert.equal(step.nextIndex, null);
  assert.equal(step.activate, "views");
  assert.equal(headerClickOpens(step.state).opens, false);

  state = idleHeaderPointer();
  step = reduceHeaderPointer(state, { type: "down", x: 0, y: 0, control: "output" }, 0, 3);
  state = step.state;
  step = reduceHeaderPointer(state, { type: "move", x: 16, y: 0 }, 0, 3);
  state = step.state;
  step = reduceHeaderPointer(state, { type: "up", x: 16, y: 30 }, 0, 3);
  assert.equal(step.nextIndex, null);
  assert.equal(step.activate, "output");

  state = idleHeaderPointer();
  step = reduceHeaderPointer(state, { type: "down", x: 0, y: 0, control: "sizing" }, 1, 4);
  state = step.state;
  step = reduceHeaderPointer(state, { type: "move", x: 60, y: 0 }, 1, 4);
  state = step.state;
  step = reduceHeaderPointer(state, { type: "up", x: 70, y: 4 }, 1, 4);
  assert.equal(step.nextIndex, 2);
  assert.equal(step.activate, null);
});

test("landscape and ipad zoom shows Tile and the next tap tiles", () => {
  const start = { phoneTiled: false, zoomedPaneId: null as string | null };
  assert.equal(paneStripTiled(start), true);
  const zoomed = togglePaneZoom(start, "%0");
  assert.deepEqual(zoomed, { phoneTiled: false, zoomedPaneId: "%0" });
  assert.equal(paneStripTiled(zoomed), false);
  const tiledAgain = togglePaneZoom(zoomed, "%0");
  assert.deepEqual(tiledAgain, { phoneTiled: true, zoomedPaneId: null });
  assert.equal(paneStripTiled(tiledAgain), true);
  assert.equal(paneStripTiled({ phoneTiled: true, zoomedPaneId: "%0" }), false);

  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  const shellStart = app.indexOf("/* mobile-posture-shell */");
  const shellEnd = app.indexOf("/* end-mobile-posture-shell */");
  const mobile = app.slice(shellStart, shellEnd);
  assert.match(mobile, /paneStripTiled\(\{ phoneTiled, zoomedPaneId \}\)/);
  assert.match(mobile, /togglePaneZoom\(/);
});

test("opening another pane of a zoomed window points the zoom at that pane", () => {
  const zoomed = { phoneTiled: false, zoomedPaneId: "%0" };
  assert.deepEqual(zoomAfterPaneOpen(zoomed, "%1"), { phoneTiled: false, zoomedPaneId: "%1" });
  assert.deepEqual(zoomAfterPaneOpen(zoomed, "%0"), zoomed);
  assert.deepEqual(zoomAfterPaneOpen({ phoneTiled: false, zoomedPaneId: null }, "%1"), {
    phoneTiled: false,
    zoomedPaneId: null,
  });

  const sameWindow = {
    focusedPane: "%0",
    switchesWindow: false,
    activePaneId: "%0",
  };
  assert.deepEqual(
    paneStateAfterHubOpen({ ...sameWindow, live: zoomed, requestedPaneId: "%1" }),
    { focusedPane: "%1", zoom: { phoneTiled: false, zoomedPaneId: "%1" } },
  );
  assert.deepEqual(
    paneStateAfterHubOpen({
      ...sameWindow,
      live: { phoneTiled: false, zoomedPaneId: null },
      requestedPaneId: "%1",
    }),
    { focusedPane: "%1", zoom: { phoneTiled: false, zoomedPaneId: null } },
  );
  assert.deepEqual(
    paneStateAfterHubOpen({
      live: zoomed,
      focusedPane: "%0",
      requestedPaneId: "%1",
      switchesWindow: true,
      activePaneId: "%9",
    }),
    { focusedPane: "%1", zoom: { phoneTiled: false, zoomedPaneId: "%1" } },
  );
  assert.deepEqual(
    paneStateAfterHubOpen({
      live: { phoneTiled: false, zoomedPaneId: "%1" },
      focusedPane: "%0",
      requestedPaneId: "%1",
      switchesWindow: true,
      activePaneId: "%9",
    }),
    { focusedPane: "%1", zoom: { phoneTiled: false, zoomedPaneId: "%1" } },
  );
  assert.deepEqual(
    paneStateAfterHubOpen({
      live: { phoneTiled: true, zoomedPaneId: null },
      focusedPane: "%0",
      requestedPaneId: "%1",
      switchesWindow: true,
      activePaneId: "%9",
    }),
    { focusedPane: "%1", zoom: { phoneTiled: true, zoomedPaneId: null } },
  );
  assert.deepEqual(
    paneStateAfterHubOpen({
      live: zoomed,
      focusedPane: "%0",
      requestedPaneId: null,
      switchesWindow: true,
      activePaneId: "%9",
    }),
    { focusedPane: "%9", zoom: { phoneTiled: false, zoomedPaneId: null } },
  );

  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  const jump = app.indexOf("async function jumpToTarget");
  const nextFn = app.indexOf("function renderSidebar", jump);
  const body = app.slice(jump, nextFn);
  const connectAt = body.indexOf("await connectTo");
  const applyAt = body.indexOf("await applyWindow");
  assert.ok(connectAt !== -1 && applyAt > connectAt);
  const before = body.slice(0, connectAt);
  assert.equal(before.includes("setFocusedPane("), false);
  assert.equal(before.includes("setZoomedPaneId("), false);
  assert.match(before, /paneStateAfterHubOpen\(/);
  const after = body.slice(applyAt);
  assert.match(after, /setFocusedPane\(commit\.focusedPane\)/);
  assert.match(after, /setZoomedPaneId\(commit\.zoom\.zoomedPaneId\)/);
  assert.match(body, /await connectTo\(sessionName, windowId, commit\)/);
  assert.match(body, /await applyWindow\(win, commit\)/);
});

test("agent attention ranks waiting, then failed, then running, then finished", () => {
  assert.equal(agentAttentionRank("Waiting on you"), 0);
  assert.equal(agentAttentionRank("needs_user"), 0);
  assert.equal(agentAttentionRank("Failed"), 1);
  assert.equal(agentAttentionRank("Running"), 2);
  assert.equal(agentAttentionRank("Finished"), 3);
  assert.equal(agentAttentionRank("succeeded"), 3);
});

function tokenBag(): TokenBag & { dump: () => Map<string, string> } {
  const bag = new Map<string, string>();
  return {
    getItem: (key) => bag.get(key) ?? null,
    setItem: (key, value) => {
      bag.set(key, value);
    },
    dump: () => bag,
  };
}

test("the web token prefers localStorage and a visible wake reseeds", () => {
  const local = tokenBag();
  const session = tokenBag();
  persistWsToken("pair-token", local, session);
  assert.equal(local.getItem("sparkmux.wsToken"), "pair-token");
  assert.equal(session.getItem("sparkmux.wsToken"), "pair-token");
  assert.equal(loadWsToken(local, session), "pair-token");

  const onlySession = tokenBag();
  onlySession.setItem("sparkmux.wsToken", "from-session");
  assert.equal(loadWsToken(tokenBag(), onlySession), "from-session");

  assert.deepEqual(connectionHealthFromPing(1_000, 1_042), { state: "connected", rttMs: 42 });
  assert.equal(shouldImmediateReseed({ type: "visibilitychange", visibilityState: "visible" }), true);
  assert.equal(shouldImmediateReseed({ type: "visibilitychange", visibilityState: "hidden" }), false);
  assert.equal(shouldImmediateReseed({ type: "pageshow" }), true);
  assert.equal(shouldImmediateReseed({ type: "online" }), true);

  assert.deepEqual(windowResizeArgs(80, 24, true, false), { cols: 80, rows: 24, force: true });
  assert.deepEqual(windowResizeArgs(80, 24, true, true), { cols: 80, rows: 24 });
});

test("the phone map fills its segment and the peek stays 64px above the app inset", () => {
  assert.equal(phoneMapFillsSegment(true, "map"), true);
  assert.equal(phoneMapFillsSegment(true, "telemetry"), false);
  assert.equal(phoneMapFillsSegment(true, "events"), false);
  assert.equal(phoneMapFillsSegment(false, "map"), false);

  const hud = readFileSync(new URL("../chrome/AnalyticsHud.tsx", import.meta.url), "utf8");
  const gate = hud.indexOf("!phoneMapFillsSegment(phoneLayout, phonePane)");
  const splitter = hud.indexOf("scifi-splitter-h", gate);
  const row = hud.indexOf('className="scifi-row"', gate);
  const end = hud.indexOf("</main>", gate);
  assert.ok(gate !== -1 && splitter !== -1 && row !== -1 && end !== -1);
  assert.ok(gate < splitter && splitter < row && row < end);

  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
  const sheetStart = css.indexOf(".mobile-bottom-sheet {");
  const sheetEnd = css.indexOf(".mobile-bottom-sheet.detent-closed");
  const sheet = css.slice(sheetStart, sheetEnd);
  assert.equal(sheet.includes("padding-bottom:"), false);
  assert.match(sheet, /--sheet-peek:\s*64px/);
  const appStart = css.indexOf(".app.posture-phone-compact,");
  const appEnd = css.indexOf(".app.posture-phone-landscape .main");
  const appPad = css.slice(appStart, appEnd);
  assert.match(appPad, /padding-bottom:\s*env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.scifi-center\.phone-map-fill > \.scifi-splitter-h/);
  assert.match(css, /\.scifi-center\.phone-map-fill > \.scifi-row \{\s*display:\s*none;/);

  const scaleStart = css.indexOf(".term-overview-scale {");
  const scaleEnd = css.indexOf("}", scaleStart);
  const scaleRule = css.slice(scaleStart, scaleEnd);
  assert.match(scaleRule, /width:\s*100%/);
  assert.match(scaleRule, /height:\s*100%/);

  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  const shellStart = app.indexOf("/* mobile-posture-shell */");
  const shellEnd = app.indexOf("/* end-mobile-posture-shell */");
  assert.ok(shellStart !== -1 && shellEnd > shellStart);
  const mobile = app.slice(shellStart, shellEnd);
  for (const name of [
    "MobileTopBar",
    "MobileInputDock",
    "MobileAgentHub",
    "MobileFullscreenView",
    "TiledWindow",
  ]) {
    assert.ok(mobile.includes(`<${name}`), name);
  }
  for (const name of [
    "MobileBottomSheet",
    "MobileSlideDrawer",
    "StatusBar",
    "QuickReplyBanner",
    "TouchKeyBar",
  ]) {
    assert.equal(mobile.includes(name), false, name);
  }
  assert.equal(mobile.includes("overviewScale"), false);
  assert.equal(mobile.includes("scale("), false);
  assert.equal(app.includes("scale(${overviewScale})"), false);
  assert.equal(app.includes("transform: `scale"), false);

  for (const cls of [
    ".mobile-top-bar",
    ".mobile-agent-hub",
    ".mobile-input-dock",
    ".mobile-fullscreen-view",
  ]) {
    const at = css.indexOf(`${cls} {`);
    assert.ok(at !== -1, cls);
    const block = css.slice(at, css.indexOf("}", at));
    assert.match(block, /44px/);
    assert.match(block, /16px/);
    assert.match(block, /env\(safe-area-inset-/);
  }
  const hubAt = css.indexOf(".mobile-agent-hub {");
  const hubBlock = css.slice(hubAt, css.indexOf("}", hubAt));
  assert.match(hubBlock, /z-index:\s*520/);
  assert.match(hubBlock, /position:\s*fixed/);
  assert.match(hubBlock, /inset:\s*0/);
  const fullAt = css.indexOf(".mobile-fullscreen-view {");
  const fullBlock = css.slice(fullAt, css.indexOf("}", fullAt));
  assert.match(fullBlock, /z-index:\s*500/);
  assert.match(fullBlock, /position:\s*fixed/);
  assert.match(fullBlock, /inset:\s*0/);
});
