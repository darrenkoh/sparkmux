import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyChronicleKeyEvent,
  chronicleKeyAction,
  ENABLED_CHRONICLE_SCENES,
  isNewestScrubStop,
  laneTarget,
  scrubDomain,
  stepScrub,
  type ChronicleKeyAction,
  type ChronicleKeyInput,
} from "./chronicleKeys.ts";

function input(partial: Partial<ChronicleKeyInput>): ChronicleKeyInput {
  return {
    key: "x",
    shift: false,
    meta: false,
    ctrl: false,
    inHologram: false,
    onNewest: false,
    enabledScenes: ["transit"],
    scene: "transit",
    files: [],
    stations: [],
    activeId: "",
    nowAvailable: () => false,
    ...partial,
  };
}

function fakeEvent() {
  const calls: string[] = [];
  return {
    calls,
    preventDefault() {
      calls.push("preventDefault");
    },
    stopImmediatePropagation() {
      calls.push("stopImmediatePropagation");
    },
  };
}

function dispatch(action: ChronicleKeyAction, onClose: () => void) {
  const event = fakeEvent();
  const swallowed = applyChronicleKeyEvent(event, action);
  if (swallowed && action.swallow && action.action === "close") onClose();
  return event;
}

const files = [
  { path: "A", lane: 0 },
  { path: "B", lane: 1 },
  { path: "C", lane: 2 },
];

const stations = [
  { id: "a", path: "A", ordinal: 0 },
  { id: "c1", path: "C", ordinal: 1 },
  { id: "b", path: "B", ordinal: 4 },
  { id: "c6", path: "C", ordinal: 6 },
];

test("escape on an older stop jumps latest and does not close", () => {
  let closed = false;
  const action = chronicleKeyAction(input({ key: "Escape", onNewest: false }));
  assert.deepEqual(action, { swallow: true, action: "latest" });
  dispatch(action, () => {
    closed = true;
  });
  assert.equal(closed, false);
});

test("escape on the newest scrub stop closes", () => {
  let closed = false;
  const action = chronicleKeyAction(input({ key: "Escape", onNewest: true }));
  assert.deepEqual(action, { swallow: true, action: "close" });
  const event = dispatch(action, () => {
    closed = true;
  });
  assert.equal(closed, true);
  assert.deepEqual(event.calls, ["preventDefault", "stopImmediatePropagation"]);
});

test("a swallowed letter calls preventDefault and stopImmediatePropagation", () => {
  const action = chronicleKeyAction(input({ key: "x" }));
  assert.deepEqual(action, { swallow: true, action: "none" });
  const event = fakeEvent();
  assert.equal(applyChronicleKeyEvent(event, action), true);
  assert.deepEqual(event.calls, ["preventDefault", "stopImmediatePropagation"]);
});

test("meta+c inside the hologram is not swallowed", () => {
  const action = chronicleKeyAction(input({ key: "c", meta: true, inHologram: true }));
  assert.deepEqual(action, { swallow: false });
  const event = fakeEvent();
  assert.equal(applyChronicleKeyEvent(event, action), false);
  assert.deepEqual(event.calls, []);
});

test("key 2 swallows with action none until that scene is enabled", () => {
  const disabled = chronicleKeyAction(input({ key: "2", enabledScenes: ["transit"] }));
  assert.deepEqual(disabled, { swallow: true, action: "none" });
  const event = fakeEvent();
  assert.equal(applyChronicleKeyEvent(event, disabled), true);
  assert.deepEqual(event.calls, ["preventDefault", "stopImmediatePropagation"]);

  const enabled = chronicleKeyAction(input({ key: "2", enabledScenes: ["transit", "rivers"] }));
  assert.deepEqual(enabled, { swallow: true, action: "scene", scene: "rivers" });
  assert.deepEqual(chronicleKeyAction(input({ key: "3" })), { swallow: true, action: "none" });
  assert.deepEqual(chronicleKeyAction(input({ key: "4" })), { swallow: true, action: "none" });
  assert.deepEqual(chronicleKeyAction(input({ key: "1" })), {
    swallow: true,
    action: "scene",
    scene: "transit",
  });
});

test("arrow left inside the hologram is not swallowed", () => {
  const action = chronicleKeyAction(input({ key: "ArrowLeft", inHologram: true }));
  assert.deepEqual(action, { swallow: false });
  const event = fakeEvent();
  assert.equal(applyChronicleKeyEvent(event, action), false);
  assert.deepEqual(event.calls, []);
});

test("transit arrow up does not move the selection", () => {
  const action = chronicleKeyAction(
    input({ key: "ArrowUp", scene: "transit", files, stations, activeId: "b" }),
  );
  assert.deepEqual(action, { swallow: true, action: "none" });
});

test("laneTarget steps files by lane and breaks ordinal ties upward", () => {
  const down = laneTarget(files, stations, () => false, "b", 1);
  assert.deepEqual(down, { swallow: true, action: "lane", stationId: "c6" });

  const up = laneTarget(files, stations, () => false, "a", -1);
  assert.deepEqual(up, { swallow: true, action: "none" });

  const tieStations = [
    { id: "b", path: "B", ordinal: 4 },
    { id: "c2", path: "C", ordinal: 2 },
    { id: "c6", path: "C", ordinal: 6 },
  ];
  const tie = laneTarget(files, tieStations, () => false, "b", 1);
  assert.deepEqual(tie, { swallow: true, action: "lane", stationId: "c6" });
});

test("laneTarget keeps Now only when the next file has Now", () => {
  const withNow = laneTarget(files, stations, (path) => path === "C", "now:B", 1);
  assert.deepEqual(withNow, { swallow: true, action: "lane", stationId: "now:C" });

  const withoutNow = laneTarget(files, stations, () => false, "now:B", 1);
  assert.deepEqual(withoutNow, { swallow: true, action: "lane", stationId: "c6" });
});

test("newest scrub stop is Now when that read exists", () => {
  const nowOn = (path: string) => path === "B";
  assert.equal(isNewestScrubStop("now:B", stations, nowOn), true);
  assert.equal(isNewestScrubStop("b", stations, nowOn), false);
  assert.equal(isNewestScrubStop("c6", stations, nowOn), true);
  assert.equal(isNewestScrubStop("c6", stations, () => false), true);
  assert.equal(isNewestScrubStop("b", stations, () => false), false);
  assert.equal(isNewestScrubStop("missing", stations, () => false), false);
});

test("enabled scenes select rivers, helix, and ridge", () => {
  assert.deepEqual([...ENABLED_CHRONICLE_SCENES], ["transit", "rivers", "helix", "ridge"]);
  assert.deepEqual(chronicleKeyAction(input({ key: "2", enabledScenes: ENABLED_CHRONICLE_SCENES })), {
    swallow: true,
    action: "scene",
    scene: "rivers",
  });
  assert.deepEqual(chronicleKeyAction(input({ key: "3", enabledScenes: ENABLED_CHRONICLE_SCENES })), {
    swallow: true,
    action: "scene",
    scene: "helix",
  });
  assert.deepEqual(chronicleKeyAction(input({ key: "4", enabledScenes: ENABLED_CHRONICLE_SCENES })), {
    swallow: true,
    action: "scene",
    scene: "ridge",
  });
});

test("rivers and ridge arrows select a station and helix arrows scrub", () => {
  const enabled = { enabledScenes: ENABLED_CHRONICLE_SCENES, files, stations, activeId: "b" };
  assert.deepEqual(chronicleKeyAction(input({ ...enabled, key: "ArrowDown", scene: "rivers" })), {
    swallow: true,
    action: "lane",
    stationId: "c6",
  });
  assert.deepEqual(chronicleKeyAction(input({ ...enabled, key: "ArrowUp", scene: "ridge" })), {
    swallow: true,
    action: "lane",
    stationId: "a",
  });
  assert.deepEqual(chronicleKeyAction(input({ key: "ArrowUp", scene: "helix" })), {
    swallow: true,
    action: "step",
    delta: -1,
  });
  assert.deepEqual(chronicleKeyAction(input({ key: "ArrowDown", scene: "helix", shift: true })), {
    swallow: true,
    action: "step",
    delta: 4,
  });
  assert.deepEqual(chronicleKeyAction(input({ ...enabled, key: "ArrowDown", scene: "transit" })), {
    swallow: true,
    action: "none",
  });
});

test("a second wheel step does not keep the previous path's Now", () => {
  const laidOut = [
    { id: "a0", path: "A", kind: "replace" },
    { id: "b1", path: "B", kind: "replace" },
    { id: "now:A", path: "A", kind: "now" },
  ];
  const now = (path: string) => path === "A" || path === "B";
  const first = stepScrub(laidOut, "a0", now, 1);
  assert.equal(first, "b1");
  assert.deepEqual(scrubDomain(laidOut, "b1", now), ["a0", "b1", "now:B"]);
  assert.equal(stepScrub(laidOut, "b1", now, 1), "now:B");
  assert.deepEqual(scrubDomain(laidOut, "b1", (path) => path === "A"), ["a0", "b1"]);
  assert.equal(stepScrub(laidOut, "b1", (path) => path === "A", 1), null);
});
