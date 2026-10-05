import assert from "node:assert/strict";
import { test } from "node:test";

import {
  availablePhase,
  downloadPercent,
  errorText,
  noticeModel,
  updateNotes,
} from "./noticeModel.ts";

test("an available update names the version and offers Update Now", () => {
  const model = noticeModel(availablePhase("v0.1.15", "Keeps the caret put."));
  assert.ok(model);
  assert.equal(model.title, "Sparkmux 0.1.15 is available");
  assert.equal(model.detail, "Keeps the caret put.");
  assert.equal(model.primary, "Update Now");
  assert.equal(model.secondary, "Later");
  assert.equal(model.busy, false);
});

test("release notes collapse whitespace and stay short", () => {
  const notes = updateNotes(`  line one\n\n${"x".repeat(200)}  `);
  assert.equal(notes.startsWith("line one "), true);
  assert.equal(notes.endsWith("…"), true);
  assert.ok(notes.length <= 140);
});

test("download progress reports a percent only when the size is known", () => {
  assert.equal(downloadPercent(50, 200), 25);
  assert.equal(downloadPercent(500, 200), 100);
  assert.equal(downloadPercent(10, null), null);
  assert.equal(downloadPercent(10, 0), null);
  const model = noticeModel({
    status: "downloading",
    version: "0.1.15",
    downloaded: 25,
    total: 100,
  });
  assert.equal(model?.title, "Downloading Sparkmux 0.1.15 · 25%");
  assert.equal(model?.percent, 25);
  assert.equal(model?.busy, true);
  assert.equal(model?.primary, null);
});

test("install tells the user the app will relaunch", () => {
  const model = noticeModel({ status: "installing", version: "0.1.15" });
  assert.equal(model?.title, "Installing Sparkmux 0.1.15");
  assert.match(model?.detail ?? "", /relaunch/);
  assert.equal(model?.primary, null);
});

test("a failed install can be dismissed", () => {
  const model = noticeModel({
    status: "error",
    message: errorText(new Error("signature mismatch")),
  });
  assert.equal(model?.title, "Could not install the update");
  assert.equal(model?.detail, "signature mismatch");
  assert.equal(model?.secondary, "Dismiss");
  assert.equal(noticeModel({ status: "hidden" }), null);
});

test("empty failures get a short fallback", () => {
  assert.equal(errorText(""), "Something went wrong.");
  assert.equal(errorText(new Error("  ")), "Something went wrong.");
  assert.equal(errorText("disk full"), "disk full");
  assert.equal(errorText({ message: "signature mismatch" }), "signature mismatch");
});
