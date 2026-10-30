import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentColor,
  agentForPick,
  agentKey,
  callsign,
  counters,
  diffFeed,
  resolvePose,
  statusText,
  teamClickPlan,
  teamOrder,
} from "./officeModel.ts";
import type { OfficeAgent, OfficeSnapshot } from "./officeTypes.ts";

function agent(partial: Partial<OfficeAgent> & Pick<OfficeAgent, "session" | "pane_id">): OfficeAgent {
  return {
    window_id: "@1",
    window_name: partial.session,
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
    project: partial.session,
    ...partial,
  };
}

function snap(agents: OfficeAgent[], free = 0): OfficeSnapshot {
  return {
    agents,
    free_desks: Array.from({ length: free }, (_, index) => ({
      session: "spark",
      pane_id: `%f${index}`,
      window_name: "shell",
    })),
    now_ms: 1,
  };
}

test("callsigns are stable and collision-free for 30 keys", () => {
  const keys = Array.from({ length: 30 }, (_, index) => `spark:%${index}`);
  const taken = new Set<string>();
  const names = keys.map((key) => {
    const name = callsign(key, taken);
    taken.add(name);
    return name;
  });
  assert.equal(new Set(names).size, 30);
  const again = new Set<string>();
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] ?? "";
    assert.equal(callsign(key, again), names[index]);
    again.add(names[index] ?? "");
  }
  assert.equal(callsign(keys[0] ?? "", new Set()), names[0]);
});

test("agent color is deterministic", () => {
  assert.equal(agentColor("spark:%1"), agentColor("spark:%1"));
  assert.equal(typeof agentColor("ops:%2"), "number");
});

test("resolvePose covers every state and activity", () => {
  const activities = [
    "coding",
    "terminal",
    "reading",
    "browsing",
    "delegating",
    "thinking",
    "replying",
    "planning",
    "",
  ];
  const expected: Record<string, { pose: string; zone: string; marker: string | null }> = {
    coding: { pose: "type_fast", zone: "desk", marker: null },
    terminal: { pose: "terminal", zone: "desk", marker: null },
    reading: { pose: "read_standing", zone: "bookshelf", marker: null },
    delegating: { pose: "meeting", zone: "meeting", marker: null },
    thinking: { pose: "lean_back", zone: "desk", marker: "thought" },
    replying: { pose: "type_slow", zone: "desk", marker: null },
    planning: { pose: "whiteboard", zone: "whiteboard", marker: null },
    "": { pose: "type_slow", zone: "desk", marker: null },
  };
  const browseZones = new Set<string>();
  for (const activity of activities) {
    for (let index = 0; index < 12; index += 1) {
      const row = agent({ session: "s", pane_id: `%${index}`, state: "running", activity });
      const pose = resolvePose(row);
      if (activity === "browsing") {
        browseZones.add(pose.zone);
        assert.equal(pose.pose, "browse");
        assert.equal(pose.marker, null);
        assert.equal(resolvePose(row).zone, pose.zone);
      } else {
        assert.deepEqual(pose, expected[activity]);
      }
      assert.deepEqual(resolvePose({ ...row, state: "needs_user" }), {
        pose: "raise_hand",
        zone: "desk",
        marker: "ask",
      });
      assert.deepEqual(resolvePose({ ...row, state: "failed" }), {
        pose: "slump",
        zone: "desk",
        marker: "error",
      });
      assert.deepEqual(resolvePose({ ...row, state: "succeeded" }), {
        pose: "coffee",
        zone: "coffee",
        marker: null,
      });
      assert.deepEqual(resolvePose({ ...row, state: "idle" }), {
        pose: "sofa",
        zone: "sofa",
        marker: "zzz",
      });
    }
  }
  assert.ok(browseZones.has("desk"));
  assert.ok(browseZones.has("window"));
});

test("counters count free desks and do not count needs_user as working", () => {
  const rows = [
    agent({ session: "a", pane_id: "%1", state: "running" }),
    agent({ session: "a", pane_id: "%2", state: "needs_user" }),
    agent({ session: "b", pane_id: "%3", state: "idle" }),
    agent({ session: "b", pane_id: "%4", state: "failed" }),
    agent({ session: "b", pane_id: "%5", state: "succeeded" }),
  ];
  const counted = counters(snap(rows, 2));
  assert.equal(counted.working, 1);
  assert.equal(counted.needYou, 1);
  assert.equal(counted.idle, 3);
  assert.equal(counted.freeDesks, 2);
  assert.equal(counted.working + counted.needYou + counted.idle, rows.length);
});

test("team order is state, then session, then window", () => {
  const rows = [
    agent({ session: "b", pane_id: "%2", window_name: "z", state: "idle" }),
    agent({ session: "a", pane_id: "%9", window_name: "m", state: "running" }),
    agent({ session: "a", pane_id: "%1", window_name: "m", state: "needs_user" }),
    agent({ session: "a", pane_id: "%3", window_name: "a", state: "failed" }),
    agent({ session: "b", pane_id: "%4", window_name: "a", state: "succeeded" }),
    agent({ session: "a", pane_id: "%8", window_name: "b", state: "running" }),
  ];
  assert.deepEqual(
    teamOrder(rows).map((row) => `${row.state}:${row.session}:${row.window_name}:${row.pane_id}`),
    [
      "needs_user:a:m:%1",
      "failed:a:a:%3",
      "running:a:b:%8",
      "running:a:m:%9",
      "succeeded:b:a:%4",
      "idle:b:z:%2",
    ],
  );
});

test("a desk or avatar pick resolves to that agent, and a second team click renames", () => {
  const scout = agent({ session: "spark", pane_id: "%1", window_name: "dev" });
  const nova = agent({ session: "spark", pane_id: "%2", window_name: "ops", state: "idle" });
  assert.equal(agentForPick([scout, nova], "spark:%2"), nova);
  assert.equal(agentForPick([scout, nova], "spark:%9"), null);
  assert.equal(agentForPick([scout, nova], null), null);
  assert.equal(teamClickPlan(1), "navigate");
  assert.equal(teamClickPlan(2), "rename");
});

test("status text names the live tool", () => {
  assert.equal(
    statusText(agent({ session: "s", pane_id: "%1", activity: "terminal", tool: "Bash", tool_arg: "cargo test" })),
    "Running Bash: cargo test",
  );
  assert.equal(statusText(agent({ session: "s", pane_id: "%1", activity: "thinking", tool: "" })), "Thinking");
  assert.equal(statusText(agent({ session: "s", pane_id: "%1", state: "needs_user" })), "Needs you");
});

test("diffFeed records arrive, leave, state changes, tool changes, and nothing else", () => {
  const names = new Map<string, string>([
    ["spark:%1", "Scout"],
    ["spark:%2", "Nova"],
  ]);
  const first = agent({ session: "spark", pane_id: "%1", window_name: "dev", state: "running" });
  const second = agent({
    session: "spark",
    pane_id: "%2",
    window_name: "ops",
    state: "idle",
    activity: "",
  });
  const now = 5_000;
  const opened = diffFeed(null, snap([first, second]), names, now);
  assert.equal(opened.length, 2);
  assert.equal(opened[0]?.text, "Scout arrived at spark · dev");
  assert.equal(opened[0]?.at, now);
  assert.equal(opened[0]?.tone, "work");
  assert.equal(opened[1]?.text, "Nova arrived at spark · ops");
  assert.deepEqual(diffFeed(snap([first, second]), snap([first, second]), names, now + 1), []);

  const left = diffFeed(snap([first, second]), snap([first]), names, now);
  assert.equal(left.length, 1);
  assert.equal(left[0]?.text, "Nova left the office");
  assert.equal(left[0]?.tone, "idle");

  const arrived = diffFeed(snap([first]), snap([first, second]), names, now);
  assert.equal(arrived[0]?.text, "Nova arrived at spark · ops");

  const states: Array<[string, string, string]> = [
    ["needs_user", "ask", "Scout needs you: Approve the plan?"],
    ["failed", "error", "Scout hit an error"],
    ["succeeded", "ok", "Scout finished the task"],
    ["idle", "idle", "Scout is taking a break"],
    ["running", "work", "Scout started working"],
  ];
  for (const [state, tone, text] of states) {
    const base = agent({ ...first, state: state === "running" ? "idle" : "running" });
    const next = agent({
      ...base,
      state,
      ask: "Approve the plan? and then a lot of extra words that should be clipped at sixty characters",
    });
    const lines = diffFeed(snap([base]), snap([next]), names, now);
    assert.equal(lines.length, 1, state);
    assert.equal(lines[0]?.tone, tone, state);
    if (state === "needs_user") {
      assert.equal(lines[0]?.text.startsWith("Scout needs you: "), true);
      assert.ok((lines[0]?.text.length ?? 0) <= "Scout needs you: ".length + 60);
    } else {
      assert.equal(lines[0]?.text, text, state);
    }
  }

  const edited = agent({
    ...first,
    activity: "terminal",
    tool: "Bash",
    tool_arg: "cargo test --lib",
    last_entry_id: "e1",
  });
  const toolLine = diffFeed(snap([first]), snap([edited]), names, now);
  assert.equal(toolLine.length, 1);
  assert.equal(toolLine[0]?.text, "Scout is running cargo test --lib");

  const sameTool = agent({ ...first, last_entry_id: "e2", activity: "coding" });
  assert.deepEqual(diffFeed(snap([first]), snap([sameTool]), names, now), []);

  const thinking = agent({
    ...first,
    activity: "thinking",
    tool: "Read",
    last_entry_id: "e3",
  });
  assert.equal(diffFeed(snap([first]), snap([thinking]), names, now)[0]?.text, "Scout is thinking");
  assert.equal(agentKey(first), "spark:%1");
});
