import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DOCKED_CHANNEL_TAGS,
  cameraKey,
  decideMapFrame,
  dockedPeakLabel,
  dockedPresentMode,
  restReveal,
  shouldRebuildTerrain,
  type MapFrameInput,
} from "./terrainFrame.ts";

function idle(): MapFrameInput {
  const camera = cameraKey(0.38, 0.48, 46, 0, 1.2, 0);
  return {
    docked: true,
    dragging: false,
    zooming: false,
    playing: false,
    rotationOn: false,
    fullscreenAutoRotate: true,
    telemetry: "tab:4:1:0:1:2",
    previousTelemetry: "tab:4:1:0:1:2",
    width: 320,
    height: 180,
    previousWidth: 320,
    previousHeight: 180,
    camera,
    previousCamera: camera,
    color: "color",
    previousColor: "color",
    geometryReady: true,
    extent: 14,
    reset: false,
  };
}

test("an idle docked map does not follow up or rebuild, even if fullscreen auto-rotate is on", () => {
  const decision = decideMapFrame(idle());
  assert.equal(decision.scheduleFollowUp, false);
  assert.equal(decision.requestRedraw, false);
  assert.equal(decision.rebuildTerrain, false);
  assert.equal(decision.settled, true);
  assert.equal(shouldRebuildTerrain(idle().telemetry, idle().telemetry), false);
});

test("an unchanged analytics signature skips the terrain rebuild", () => {
  const same = decideMapFrame({ ...idle(), fullscreenAutoRotate: true });
  assert.equal(same.rebuildTerrain, false);
  const next = decideMapFrame({ ...idle(), telemetry: "tab:5:1:0:1:2" });
  assert.equal(next.rebuildTerrain, true);
  assert.equal(next.requestRedraw, true);
  assert.equal(next.scheduleFollowUp, false);
  assert.equal(shouldRebuildTerrain("tab:4", "tab:4"), false);
  assert.equal(shouldRebuildTerrain("tab:4", "tab:5"), true);
});

test("a real size change redraws once and an identical size does not", () => {
  const changed = decideMapFrame({ ...idle(), width: 400, previousWidth: 320 });
  assert.equal(changed.requestRedraw, true);
  assert.equal(changed.scheduleFollowUp, false);
  assert.equal(changed.rebuildTerrain, false);
  const same = decideMapFrame({ ...idle(), width: 400, previousWidth: 400 });
  assert.equal(same.requestRedraw, false);
  assert.equal(same.scheduleFollowUp, false);
  const subpixel = decideMapFrame({ ...idle(), width: 320.4, previousWidth: 320.2, height: 180.4, previousHeight: 180.2 });
  assert.equal(subpixel.requestRedraw, false);
  assert.equal(subpixel.scheduleFollowUp, false);
});

test("drag, zoom, camera reset, and playback redraw, then stop when the gesture ends", () => {
  const base = idle();
  assert.equal(decideMapFrame({ ...base, dragging: true }).scheduleFollowUp, true);
  const dragged = cameraKey(0.5, 0.48, 46, 0, 1.2, 0);
  const afterDrag = decideMapFrame({ ...base, camera: dragged });
  assert.equal(afterDrag.requestRedraw, true);
  assert.equal(afterDrag.scheduleFollowUp, false);
  const zoom = decideMapFrame({ ...base, zooming: true });
  assert.equal(zoom.requestRedraw, true);
  assert.equal(zoom.scheduleFollowUp, false);
  const reset = decideMapFrame({ ...base, reset: true });
  assert.equal(reset.requestRedraw, true);
  assert.equal(reset.scheduleFollowUp, false);
  assert.equal(decideMapFrame({ ...base, playing: true }).scheduleFollowUp, true);
  const stopped = decideMapFrame(base);
  assert.equal(stopped.scheduleFollowUp, false);
  assert.equal(stopped.requestRedraw, false);
});

test("docked rotation keeps scheduling and turning it off stops, while fullscreen always continues", () => {
  assert.equal(decideMapFrame({ ...idle(), rotationOn: true }).scheduleFollowUp, true);
  assert.equal(decideMapFrame({ ...idle(), rotationOn: false, fullscreenAutoRotate: true }).scheduleFollowUp, false);
  assert.equal(decideMapFrame({ ...idle(), docked: false, fullscreenAutoRotate: false }).scheduleFollowUp, true);
});

test("the rest pose reveals the full rect span and the full globe ring", () => {
  const reveal = restReveal(14);
  const decision = decideMapFrame({ ...idle(), extent: 14 });
  assert.equal(decision.rectMaxX, reveal.rectMaxX);
  assert.equal(decision.globeMaxFrac, reveal.globeMaxFrac);
  assert.ok(decision.rectMaxX > 14);
  assert.ok(decision.globeMaxFrac > 1);
  const phase0MaxX = (0 * 2 - 1) * 14;
  assert.ok(decision.rectMaxX > phase0MaxX);
  assert.notEqual(decision.globeMaxFrac, 0);
});

test("a frame is not settled until geometry exists and the canvas size is non-zero", () => {
  const unready = decideMapFrame({ ...idle(), geometryReady: false });
  assert.equal(unready.settled, false);
  assert.equal(unready.scheduleFollowUp, true);
  const zero = decideMapFrame({ ...idle(), width: 0, height: 0, previousWidth: 0, previousHeight: 0 });
  assert.equal(zero.settled, false);
  assert.equal(zero.scheduleFollowUp, true);
  assert.equal(decideMapFrame(idle()).settled, true);
});

test("a docked spectral or mono change redraws once from idle and does not keep scheduling", () => {
  const toMono = decideMapFrame({ ...idle(), color: "mono", previousColor: "color" });
  assert.equal(toMono.requestRedraw, true);
  assert.equal(toMono.scheduleFollowUp, false);
  assert.equal(toMono.rebuildTerrain, false);
  assert.equal(toMono.settled, false);
  const toSpectral = decideMapFrame({ ...idle(), color: "color", previousColor: "mono" });
  assert.equal(toSpectral.requestRedraw, true);
  assert.equal(toSpectral.scheduleFollowUp, false);
  const same = decideMapFrame({ ...idle(), color: "mono", previousColor: "mono" });
  assert.equal(same.requestRedraw, false);
  assert.equal(same.scheduleFollowUp, false);
  assert.equal(same.settled, true);
});

test("a settled docked picture is reused until the view or the gesture changes", () => {
  const pictureKey = "800|420|cam|sig|color|globe";
  assert.equal(
    dockedPresentMode({ docked: true, interacting: false, pictureKey, bakedKey: pictureKey }),
    "cached",
  );
  assert.equal(
    dockedPresentMode({ docked: true, interacting: false, pictureKey, bakedKey: "" }),
    "live",
  );
  assert.equal(
    dockedPresentMode({ docked: true, interacting: false, pictureKey, bakedKey: "800|420|cam|other|color|globe" }),
    "live",
  );
  assert.equal(
    dockedPresentMode({ docked: true, interacting: true, pictureKey, bakedKey: pictureKey }),
    "live",
  );
  assert.equal(
    dockedPresentMode({ docked: false, interacting: false, pictureKey, bakedKey: pictureKey }),
    "live",
  );
});

test("docked peak labels use USR THK RPL TOL and that frame's value", () => {
  assert.deepEqual([...DOCKED_CHANNEL_TAGS], ["USR", "THK", "RPL", "TOL"]);
  assert.equal(dockedPeakLabel("USR", "12 PROMPTS"), "USR 12 PROMPTS");
  assert.equal(dockedPeakLabel("THK", 3), "THK 3");
  assert.equal(dockedPeakLabel("RPL", 4), "RPL 4");
  assert.equal(dockedPeakLabel("TOL", 9), "TOL 9");
});
