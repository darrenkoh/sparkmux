import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { extractQuickOptions, quickOptionBytes } from "../../ios/quickReplyLogic.ts";
import type { OfficeAgent, OfficeSnapshot } from "../office/officeTypes.ts";
import {
  askOptions,
  contextPercent,
  EMPTY_COPY,
  hqCounts,
  layoutFloors,
  replyBytes,
  usageCaption,
  visualToken,
} from "./hqModel.ts";

function agent(partial: Partial<OfficeAgent> & Pick<OfficeAgent, "session" | "pane_id">): OfficeAgent {
  return {
    window_id: "@1",
    window_name: partial.pane_id,
    cli: "claude",
    model: "Claude",
    state: "running",
    activity: "coding",
    tool: "Edit",
    tool_arg: "src/App.tsx",
    detail: "",
    ask: "",
    last_activity_ms: 0,
    last_entry_id: "e0",
    recent: [],
    project: "sparkmux",
    ...partial,
  };
}

function snap(agents: OfficeAgent[], free: OfficeSnapshot["free_desks"] = []): OfficeSnapshot {
  return { agents, free_desks: free, now_ms: 1 };
}

test("floors group by session in a stable order", () => {
  const agents = [
    agent({ session: "zeta", pane_id: "%2", window_name: "b", state: "failed" }),
    agent({ session: "alpha", pane_id: "%9", window_name: "z" }),
    agent({ session: "alpha", pane_id: "%1", window_name: "a", state: "needs_user" }),
    agent({ session: "zeta", pane_id: "%1", window_name: "a", state: "idle" }),
  ];
  const forward = layoutFloors(snap(agents));
  const backward = layoutFloors(snap([...agents].reverse()));
  assert.deepEqual(
    forward.map((floor) => floor.session),
    ["alpha", "zeta"],
  );
  assert.deepEqual(
    forward.map((floor) => floor.rooms.map((room) => room.key)),
    backward.map((floor) => floor.rooms.map((room) => room.key)),
  );
  assert.deepEqual(
    forward[0]?.rooms.map((room) => room.agent.pane_id),
    ["%1", "%9"],
  );
  assert.deepEqual(forward[0]?.counts, { working: 1, waiting: 1, failed: 0, idle: 0 });
  assert.deepEqual(forward[1]?.counts, { working: 0, waiting: 0, failed: 1, idle: 1 });
});

test("one session is one floor", () => {
  const floors = layoutFloors(
    snap([
      agent({ session: "main", pane_id: "%2", window_name: "b" }),
      agent({ session: "main", pane_id: "%1", window_name: "a", state: "succeeded" }),
    ]),
  );
  assert.equal(floors.length, 1);
  assert.equal(floors[0]?.session, "main");
  assert.equal(floors[0]?.rooms.length, 2);
  assert.deepEqual(floors[0]?.counts, { working: 1, waiting: 0, failed: 0, idle: 1 });
});

test("an empty snapshot has no floors", () => {
  assert.deepEqual(layoutFloors(snap([])), []);
});

test("a free desk is a shell, not an agent room", () => {
  const floors = layoutFloors(
    snap(
      [agent({ session: "main", pane_id: "%1", state: "running" })],
      [
        { session: "main", pane_id: "%9", window_name: "shell" },
        { session: "logs", pane_id: "%3", window_name: "tail" },
      ],
    ),
  );
  const main = floors.find((floor) => floor.session === "main");
  const logs = floors.find((floor) => floor.session === "logs");
  assert.deepEqual(
    main?.rooms.map((room) => room.agent.pane_id),
    ["%1"],
  );
  assert.equal(main?.shells.length, 1);
  assert.equal(main?.shells[0]?.paneId, "%9");
  assert.equal(logs?.rooms.length, 0);
  assert.equal(logs?.shells[0]?.windowName, "tail");
  assert.deepEqual(hqCounts([]), { working: 0, waiting: 0, failed: 0, idle: 0 });
  const states = ["running", "needs_user", "failed", "idle", "succeeded"];
  assert.deepEqual(hqCounts(states.map((state) => ({ state }))), {
    working: 1,
    waiting: 1,
    failed: 1,
    idle: 2,
  });
});

test("adding a room on a later floor does not reorder an earlier floor", () => {
  const before = layoutFloors(
    snap([
      agent({ session: "alpha", pane_id: "%2", window_name: "b" }),
      agent({ session: "alpha", pane_id: "%1", window_name: "a" }),
    ]),
  );
  const after = layoutFloors(
    snap([
      agent({ session: "beta", pane_id: "%8", window_name: "new", state: "failed" }),
      agent({ session: "alpha", pane_id: "%1", window_name: "a", state: "idle" }),
      agent({ session: "alpha", pane_id: "%2", window_name: "b", state: "needs_user" }),
    ]),
  );
  assert.deepEqual(
    before[0]?.rooms.map((room) => room.key),
    after.find((floor) => floor.session === "alpha")?.rooms.map((room) => room.key),
  );
});

test("visual tokens map the five office states", () => {
  assert.deepEqual(visualToken("running"), { ring: "green", motion: "bob", dim: false, mark: null });
  assert.deepEqual(visualToken("needs_user"), { ring: "amber", motion: "still", dim: false, mark: null });
  assert.deepEqual(visualToken("failed"), { ring: "red", motion: "still", dim: false, mark: null });
  assert.deepEqual(visualToken("idle"), { ring: "none", motion: "still", dim: true, mark: "zzz" });
  assert.deepEqual(visualToken("succeeded"), { ring: "none", motion: "still", dim: true, mark: "zzz" });
  assert.notEqual(visualToken("idle").ring, "red");
  assert.notEqual(visualToken("succeeded").ring, "red");
});

test("running, idle, and failed never produce reply bytes", () => {
  const ask = "Apply the patch? [y/n]";
  const yes = extractQuickOptions(ask)[0];
  assert.ok(yes);
  for (const state of ["running", "idle", "failed", "succeeded"]) {
    assert.equal(replyBytes({ state, ask }, yes), null);
    assert.deepEqual(askOptions({ state, ask }), []);
  }
  assert.deepEqual(replyBytes({ state: "needs_user", ask }, yes), quickOptionBytes(yes));
  assert.equal(replyBytes({ state: "needs_user", ask: "hello" }, yes), null);
});

test("empty copy matches the office", () => {
  const office = readFileSync(new URL("../office/OfficeView.tsx", import.meta.url), "utf8");
  assert.equal(EMPTY_COPY, "No agents on this socket. Start `claude`, `grok`, or `agy` in a pane.");
  assert.ok(office.includes(EMPTY_COPY));
});

test("the hq view does not read the office sim", () => {
  const view = readFileSync(new URL("./AgentHq.tsx", import.meta.url), "utf8");
  const model = readFileSync(new URL("./hqModel.ts", import.meta.url), "utf8");
  assert.equal(view.includes("officeSim"), false);
  assert.equal(view.includes("sim=1"), false);
  assert.equal(model.includes("officeSim"), false);
});

test("context percent is absent when the window is unknown", () => {
  assert.equal(contextPercent(1200, 0), null);
  assert.equal(contextPercent(1200, -1), null);
  assert.equal(contextPercent(Number.NaN, 200_000), null);
  assert.equal(contextPercent(0, 200_000), 0);
  assert.equal(contextPercent(50_000, 200_000), 25);
});

test("an account usage bar is not labeled as one pane's share", () => {
  const caption = usageCaption({ scope: "account", cli: "grok", label: "Weekly" });
  assert.match(caption, /account/);
  assert.doesNotMatch(caption, /share/i);
  assert.doesNotMatch(caption, /pane/i);
  assert.equal(caption.includes("%"), false);
  const session = usageCaption({ scope: "session", cli: "grok", label: "session" });
  assert.match(session, /this session/);
  assert.equal(session.includes("account"), false);
});
