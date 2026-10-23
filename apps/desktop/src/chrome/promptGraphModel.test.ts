import assert from "node:assert/strict";
import { test } from "node:test";

import type { AnalyticsEvent } from "../api.ts";
import {
  buildPromptGraph,
  isAwaitingNode,
  layout,
  nodeSize,
  pickOrientation,
  type GraphModel,
  type Orientation,
} from "./promptGraphModel.ts";

function ev(partial: Partial<AnalyticsEvent> & Pick<AnalyticsEvent, "t" | "k">): AnalyticsEvent {
  return partial;
}

function flowOf(model: GraphModel, orientation: Orientation): number[] {
  return [...model.nodes]
    .sort((a, b) => a.t0 - b.t0 || a.id.localeCompare(b.id))
    .map((node) => (orientation === "vertical" ? node.y : node.x));
}

test("linear flow collapses three tools and adds COMPLETE", () => {
  const events = [
    ev({ t: 1_000, k: "user", b: "refactor the follower" }),
    ev({ t: 1_100, k: "think", b: "look at ingest" }),
    ev({ t: 1_200, k: "tool", n: "Read", a: "ingest.rs" }),
    ev({ t: 1_200, k: "usage", to: 50 }),
    ev({ t: 1_300, k: "tool", n: "Edit", a: "ingest.rs" }),
    ev({ t: 1_400, k: "tool", n: "Bash", a: "cargo test" }),
    ev({ t: 1_500, k: "reply", b: "done" }),
    ev({ t: 2_000, k: "turn", ms: 1_000 }),
  ];
  const model = buildPromptGraph(events, "complete");
  assert.equal(model.nodes.length, 5);
  assert.equal(model.nodes.at(-1)?.kind, "complete");
  const tools = model.nodes.find((node) => node.kind === "tool");
  assert.ok(tools);
  assert.equal(tools?.title, "TOOLS ×3");
  assert.equal(tools?.steps.length, 3);
  assert.equal(tools?.subtitle, "Read · Edit · Bash");
  assert.equal(tools?.tokensOut, 50);
  assert.equal(model.totals.tools, 3);
  assert.equal(model.totals.durationMs, 1_000);

  const expanded = buildPromptGraph(events, "complete", { expanded: new Set([tools.id]) });
  assert.equal(expanded.nodes.filter((node) => node.kind === "tool").length, 3);
  assert.equal(expanded.nodes.length, 7);
});

test("an ask absorbs its tool and an unanswered ask awaits input", () => {
  const answered = buildPromptGraph(
    [
      ev({ t: 1_000, k: "user", b: "ship?" }),
      ev({ t: 1_100, k: "tool", n: "AskUserQuestion" }),
      ev({ t: 1_100, k: "ask", n: "AskUserQuestion", b: "Ship it?" }),
      ev({ t: 43_100, k: "done", n: "AskUserQuestion", ms: 42_000 }),
      ev({ t: 44_000, k: "reply", b: "shipping" }),
      ev({ t: 45_000, k: "turn", ms: 44_000 }),
    ],
    "complete",
    { now: 50_000 },
  );
  assert.equal(answered.nodes.filter((node) => node.kind === "tool").length, 0);
  const ask = answered.nodes.find((node) => node.kind === "ask");
  assert.ok(ask);
  assert.equal(ask?.durationMs, 42_000);
  assert.equal(ask?.subtitle, "waited 42s");
  assert.equal(answered.nodes.some(isAwaitingNode), false);

  const waiting = buildPromptGraph(
    [
      ev({ t: 1_000, k: "user", b: "ship?" }),
      ev({ t: 2_000, k: "tool", n: "ask_question" }),
      ev({ t: 2_000, k: "ask", n: "ask_question", b: "Continue?" }),
    ],
    "in_progress",
    { now: 7_000 },
  );
  const open = waiting.nodes.find((node) => node.kind === "ask");
  assert.equal(open?.durationMs, 5_000);
  assert.equal(waiting.nodes.some(isAwaitingNode), true);
  assert.equal(waiting.nodes.find(isAwaitingNode)?.live, true);
});

test("liveNeedsUser shows the awaiting beacon without an ask event", () => {
  const model = buildPromptGraph(
    [ev({ t: 1_000, k: "user", b: "go" }), ev({ t: 1_200, k: "think", b: "working" })],
    "in_progress",
    { liveNeedsUser: true, now: 3_000 },
  );
  assert.equal(model.nodes.some((node) => node.kind === "ask"), false);
  assert.equal(model.nodes.some(isAwaitingNode), true);
});

test("a subagent lane forks and joins", () => {
  const model = buildPromptGraph(
    [
      ev({ t: 1_000, k: "user", b: "delegate" }),
      ev({ t: 2_000, k: "tool", n: "Read" }),
      ev({ t: 2_000, k: "tool", n: "Bash", g: "child-1", h: "worker" }),
      ev({ t: 5_000, k: "reply", b: "sub done", g: "child-1", h: "worker" }),
      ev({ t: 6_000, k: "reply", b: "main done" }),
      ev({ t: 7_000, k: "turn", ms: 6_000 }),
    ],
    "complete",
  );
  assert.equal(model.edges.filter((edge) => edge.kind === "fork").length, 1);
  assert.equal(model.edges.filter((edge) => edge.kind === "join").length, 1);
  const fork = model.edges.find((edge) => edge.kind === "fork");
  const join = model.edges.find((edge) => edge.kind === "join");
  assert.equal(model.nodes.find((node) => node.id === fork?.from)?.lane, "main");
  assert.equal(model.nodes.find((node) => node.id === fork?.to)?.lane, "child-1");
  assert.equal(model.nodes.find((node) => node.id === join?.to)?.lane, "main");

  const vertical = layout(model, { width: 900, height: 800 }, "vertical");
  const horizontal = layout(model, { width: 900, height: 500 }, "horizontal");
  const subV = vertical.nodes.find((node) => node.lane === "child-1");
  const mainV = vertical.nodes.find((node) => node.lane === "main" && node.kind === "tool");
  const subH = horizontal.nodes.find((node) => node.lane === "child-1");
  const mainH = horizontal.nodes.find((node) => node.lane === "main" && node.kind === "tool");
  assert.ok(subV && mainV && subH && mainH);
  assert.ok(subV.x > mainV.x, "vertical subagent lane sits to the right");
  assert.ok(subH.y > mainH.y, "horizontal subagent lane sits below");
});

test("an errored tool sets errCount and blank thinks are dropped", () => {
  const model = buildPromptGraph(
    [
      ev({ t: 1_000, k: "user", b: "fix" }),
      ev({ t: 1_100, k: "think", b: "   " }),
      ev({ t: 1_150, k: "think", b: "" }),
      ev({ t: 1_200, k: "think", b: "real thought" }),
      ev({ t: 1_300, k: "tool", n: "Bash" }),
      ev({ t: 1_400, k: "tool", n: "Bash" }),
      ev({ t: 1_500, k: "done", n: "Bash", err: true, ms: 40 }),
      ev({ t: 1_600, k: "turn", ms: 600 }),
    ],
    "complete",
  );
  assert.equal(model.nodes.filter((node) => node.kind === "think").length, 1);
  const tools = model.nodes.find((node) => node.kind === "tool");
  assert.equal(tools?.title, "TOOLS ×2");
  assert.equal(tools?.errCount, 1);
});

test("layout is deterministic and flow follows time in both orientations", () => {
  const built = buildPromptGraph(
    [
      ev({ t: 1_000, k: "user", b: "a" }),
      ev({ t: 2_000, k: "think", b: "b" }),
      ev({ t: 3_000, k: "tool", n: "Read" }),
      ev({ t: 3_000, k: "tool", n: "Edit", g: "child", h: "edit" }),
      ev({ t: 4_000, k: "reply", b: "c" }),
      ev({ t: 5_000, k: "turn", ms: 4_000 }),
    ],
    "complete",
  );
  const verticalBox = { width: 900, height: 800 };
  const horizontalBox = { width: 900, height: 420 };
  const once = layout(built, verticalBox, "vertical");
  const twice = layout(built, verticalBox, "vertical");
  assert.deepEqual(
    once.nodes.map((node) => [node.id, node.x, node.y]),
    twice.nodes.map((node) => [node.id, node.x, node.y]),
  );

  const vertical = once;
  const horizontal = layout(built, horizontalBox, "horizontal");
  assert.deepEqual(
    vertical.nodes.map((node) => node.id),
    horizontal.nodes.map((node) => node.id),
  );
  assert.deepEqual(
    vertical.edges.map((edge) => edge.id),
    horizontal.edges.map((edge) => edge.id),
  );

  for (const [model, orientation, box] of [
    [vertical, "vertical", verticalBox],
    [horizontal, "horizontal", horizontalBox],
  ] as const) {
    const flows = flowOf(model, orientation);
    for (let i = 1; i < flows.length; i++) {
      assert.ok(flows[i]! >= flows[i - 1]!, `${orientation} flow went backwards`);
    }
    for (const node of model.nodes) {
      const size = nodeSize(node, orientation);
      if (orientation === "vertical") {
        assert.ok(node.x >= -0.5, node.id);
        assert.ok(node.x + size.w <= box.width + 0.5, node.id);
      } else {
        assert.ok(node.y >= -0.5, node.id);
        assert.ok(node.y + size.h <= box.height + 0.5, node.id);
      }
    }
  }

  const verticalOrder = [...vertical.nodes].sort((a, b) => a.y - b.y || a.x - b.x).map((node) => node.id);
  const horizontalOrder = [...horizontal.nodes].sort((a, b) => a.x - b.x || a.y - b.y).map((node) => node.id);
  assert.deepEqual(verticalOrder, horizontalOrder);
});

test("pickOrientation uses a 1.1 hysteresis band", () => {
  assert.equal(pickOrientation(800, 400), "horizontal");
  assert.equal(pickOrientation(400, 800), "vertical");
  assert.equal(pickOrientation(500, 480, "vertical"), "vertical");
  assert.equal(pickOrientation(800, 400, "vertical"), "horizontal");
  assert.equal(pickOrientation(400, 800, "horizontal"), "vertical");
});
