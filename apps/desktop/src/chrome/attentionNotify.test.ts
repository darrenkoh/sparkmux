import assert from "node:assert/strict";
import { test } from "node:test";

import {
  notificationAllowed,
  trackAttention,
  type AttentionSample,
} from "./attentionNotify.ts";

test("notification is allowed only for a hidden new needs-user while the app is in the background", () => {
  assert.equal(notificationAllowed(false, true, null, "needs_user"), true);
  assert.equal(notificationAllowed(false, true, "running", "needs_user"), true);
  assert.equal(notificationAllowed(false, true, "failed", "needs_user"), false);
  assert.equal(notificationAllowed(false, true, "succeeded", "needs_user"), false);
  assert.equal(notificationAllowed(true, true, "running", "needs_user"), false);
  assert.equal(notificationAllowed(false, false, "running", "needs_user"), false);
  assert.equal(notificationAllowed(false, true, "needs_user", "needs_user"), false);
  assert.equal(notificationAllowed(false, true, null, "failed"), false);
  assert.equal(notificationAllowed(false, true, null, "running"), false);
  assert.equal(notificationAllowed(false, true, null, null), false);
});

test("a visible fetch keeps needs-user when unread is already cleared", () => {
  const waiting: AttentionSample = {
    active: false,
    attention_label: "needs_user",
    unread: true,
    pending_ask: "Ship it?",
  };
  const collapsed: AttentionSample = {
    active: true,
    attention_label: "needs_user",
    unread: false,
    pending_ask: "",
  };
  let label: AttentionSample["attention_label"] = null;

  const first = trackAttention(label, true, waiting);
  assert.equal(first.notify, true);
  assert.equal(first.label, "needs_user");
  label = first.label;

  const looking = trackAttention(label, false, collapsed);
  assert.equal(looking.notify, false);
  assert.equal(looking.label, "needs_user");
  label = looking.label;

  // A later fetch, still tmux-active, whose classifier label is still needs-user.
  const visibleSnap = { snapId: "snap-visible", sample: collapsed };
  const inFlightSnap = {
    snapId: "snap-inflight",
    sample: {
      active: true,
      attention_label: "needs_user" as const,
      unread: false,
      pending_ask: "",
    },
  };
  assert.notEqual(visibleSnap.snapId, inFlightSnap.snapId);
  const inFlight = trackAttention(label, true, inFlightSnap.sample);
  assert.equal(inFlight.notify, false);
  assert.equal(inFlight.label, "needs_user");
  label = inFlight.label;

  // The current window of a session that is not on screen. tmux still marks it
  // active. A running classifier must be stored so the next wait can notify.
  const hiddenCurrent = {
    snapId: "snap-hidden-current",
    sample: {
      active: true,
      attention_label: "running" as const,
      unread: false,
      pending_ask: "",
    },
  };
  assert.notEqual(hiddenCurrent.snapId, inFlightSnap.snapId);
  const runningOffScreen = trackAttention(label, true, hiddenCurrent.sample);
  assert.equal(runningOffScreen.notify, false);
  assert.equal(runningOffScreen.label, "running");
  label = runningOffScreen.label;

  const again = trackAttention(label, true, {
    active: true,
    attention_label: "needs_user",
    unread: true,
    pending_ask: "Again?",
  });
  assert.equal(again.notify, true);
  assert.equal(again.label, "needs_user");
});
