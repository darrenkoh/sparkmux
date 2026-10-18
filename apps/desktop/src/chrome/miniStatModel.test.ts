import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { SubagentStat, TabAnalyticsStats } from "../api.ts";
import { estimateTotalCost } from "./analyticsFormat.ts";
import {
  LIVE_THRESHOLD_MS,
  aggregateMiniStats,
  buildChannelBreakdown,
  buildSubagentsSummary,
  isLiveAt,
  shortModelName,
  type AggregatedMiniStats,
} from "./miniStatModel.ts";

function stats(partial: Partial<TabAnalyticsStats> = {}): TabAnalyticsStats {
  return {
    total_events: 0,
    user_prompts: 0,
    thinking_blocks: 0,
    assistant_replies: 0,
    tool_calls: 0,
    tool_results: 0,
    tool_errors: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_reasoning_tokens: 0,
    avg_turn_duration_ms: 0,
    max_turn_duration_ms: 0,
    total_turn_duration_ms: 0,
    turn_count: 0,
    context_tokens_used: 0,
    context_window_tokens: 0,
    ttft_ms: 0,
    lines_added: 0,
    lines_removed: 0,
    active_model: "",
    tools: [],
    models: [],
    timeline: [],
    recent_events: [],
    ...partial,
  };
}

function sub(partial: Partial<SubagentStat> & Pick<SubagentStat, "id">): SubagentStat {
  return {
    id: partial.id,
    label: partial.label ?? "",
    model: partial.model ?? "",
    tool_calls: partial.tool_calls ?? 0,
    tool_errors: partial.tool_errors ?? 0,
    thinking_blocks: 0,
    replies: 0,
    input_tokens: partial.input_tokens ?? 0,
    output_tokens: partial.output_tokens ?? 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: partial.reasoning_tokens ?? 0,
    lines_added: partial.lines_added ?? 0,
    lines_removed: partial.lines_removed ?? 0,
    last_ts: partial.last_ts ?? 0,
    turn_ms: 0,
  };
}

function assertFiniteTree(value: unknown): void {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `expected finite number, got ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertFiniteTree(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) assertFiniteTree(item);
  }
}

test("empty and missing stats stay at safe zeroes", () => {
  for (const input of [null, undefined]) {
    const agg = aggregateMiniStats(input, null, 1_000_000);
    assertFiniteTree(agg);
    assert.equal(agg.agent.cliBadge, "IDLE");
    assert.equal(agg.agent.activeModel, "");
    assert.equal(agg.agent.isLive, false);
    assert.equal(agg.agent.turnCount, 0);
    assert.equal(agg.totalTokens, 0);
    assert.equal(agg.cacheHitRate, 0);
    assert.equal(agg.estimatedCostUsd, 0);
    assert.equal(agg.avgToolLatencyMs, 0);
    assert.equal(agg.addRatioPct, 50);
    assert.equal(agg.netLines, 0);
    assert.equal(agg.subagents.totalCount, 0);
    assert.equal(agg.subagents.rows.length, 0);
    assert.deepEqual(
      agg.channels.map((ch) => ch.pct),
      [0, 0, 0, 0],
    );
  }
});

test("shortModelName drops provider, date, and build suffixes", () => {
  assert.equal(shortModelName("claude-sonnet-4-5-20250929"), "sonnet-4-5");
  assert.equal(shortModelName("grok-4.7-build"), "grok-4.7");
  assert.equal(shortModelName("models/gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(shortModelName("claude-opus-4-5-20251101"), "opus-4-5");
  assert.equal(shortModelName("grok-4"), "grok-4");
  assert.equal(shortModelName("models/claude-sonnet-4-5-20250929-build"), "sonnet-4-5");
  assert.equal(shortModelName("  "), "");
  assert.equal(shortModelName(null), "");
});

test("primary agent is live only inside the 30s window", () => {
  const now = 1_700_000_000_000;
  const live = aggregateMiniStats(
    stats({
      timeline_end: now - LIVE_THRESHOLD_MS,
      active_model: "claude-sonnet-4-5-20250929",
      turn_count: 4,
      avg_turn_duration_ms: 12_000,
      ttft_ms: 800,
    }),
    "claude",
    now,
  );
  assert.equal(live.agent.isLive, true);
  assert.equal(live.agent.activeModel, "sonnet-4-5");
  assert.equal(live.agent.cliBadge, "CLAUDE");
  assert.equal(live.agent.turnCount, 4);
  assert.equal(live.agent.avgTurnMs, 12_000);
  assert.equal(live.agent.ttftMs, 800);

  const idle = aggregateMiniStats(
    stats({ timeline_end: now - LIVE_THRESHOLD_MS - 1 }),
    "grok",
    now,
  );
  assert.equal(idle.agent.isLive, false);
  assert.equal(idle.agent.cliBadge, "GROK");

  const missing = aggregateMiniStats(stats({ timeline_end: 0 }), "agy", now);
  assert.equal(missing.agent.isLive, false);
  assert.equal(missing.agent.cliBadge, "ANTIGRAVITY");
});

test("subagents sum tokens, tools, and errors and sort live rows first", () => {
  const now = 5_000_000;
  const summary = buildSubagentsSummary(
    [
      sub({
        id: "",
        label: "",
        input_tokens: 999,
        tool_calls: 9,
      }),
      sub({
        id: "old",
        label: "Idle writer",
        model: "claude-haiku-4-5-20251001",
        input_tokens: 100,
        output_tokens: 40,
        reasoning_tokens: 10,
        tool_calls: 2,
        tool_errors: 1,
        lines_added: 8,
        lines_removed: 3,
        last_ts: now - 120_000,
      }),
      sub({
        id: "fresh",
        label: "",
        model: "grok-4.7-build",
        input_tokens: 5,
        output_tokens: 1,
        tool_calls: 1,
        last_ts: now - 1_000,
      }),
      sub({
        id: "busy",
        label: "Reviewer",
        model: "models/gemini-2.5-flash",
        input_tokens: 50,
        output_tokens: 20,
        reasoning_tokens: 5,
        tool_calls: 4,
        tool_errors: 2,
        last_ts: now - 20_000,
      }),
    ],
    now,
  );

  assert.equal(summary.totalCount, 3);
  assert.equal(summary.activeCount, 2);
  assert.equal(summary.totalTokens, 100 + 40 + 10 + 5 + 1 + 50 + 20 + 5);
  assert.equal(summary.totalToolCalls, 2 + 1 + 4);
  assert.equal(summary.totalErrors, 3);
  assert.deepEqual(
    summary.rows.map((row) => row.id),
    ["fresh", "busy", "old"],
  );
  assert.equal(summary.rows[0].isLive, true);
  assert.equal(summary.rows[0].name, "fresh");
  assert.equal(summary.rows[0].modelShort, "grok-4.7");
  assert.equal(summary.rows[1].modelShort, "gemini-2.5-flash");
  assert.equal(summary.rows[1].totalTokens, 75);
  assert.equal(summary.rows[1].isLive, true);
  assert.equal(summary.rows[2].isLive, false);
  assert.equal(summary.rows[2].modelShort, "haiku-4-5");
  assert.equal(summary.rows[2].linesAdded, 8);
  assert.equal(summary.rows[2].linesRemoved, 3);
});

test("a non-finite clock does not mark a recent event live", () => {
  const now = 1_000_000;
  assert.equal(isLiveAt(now - 1_000, Number.NaN), false);
  assert.equal(isLiveAt(now - 1_000, Number.POSITIVE_INFINITY), false);
  const agg = aggregateMiniStats(
    stats({
      timeline_end: now - 500,
      subagents: [sub({ id: "child", label: "Scout", last_ts: now - 500 })],
    }),
    "grok",
    Number.NaN,
  );
  assert.equal(agg.agent.isLive, false);
  assert.equal(agg.subagents.activeCount, 0);
  assert.equal(agg.subagents.rows[0].isLive, false);
});

test("a live child does not mark the primary agent live", () => {
  const now = 9_000_000;
  const agg = aggregateMiniStats(
    stats({
      timeline_end: now - 60_000,
      subagents: [sub({ id: "child", label: "Scout", last_ts: now - 500, tool_calls: 1 })],
    }),
    "grok",
    now,
  );
  assert.equal(agg.agent.isLive, false);
  assert.equal(agg.subagents.activeCount, 1);
  assert.equal(agg.subagents.rows[0].isLive, true);
});

test("channel percentages and an empty mix stay finite", () => {
  const mixed = buildChannelBreakdown(
    stats({
      user_prompts: 1,
      thinking_blocks: 2,
      assistant_replies: 1,
      tool_calls: 0,
    }),
  );
  assert.deepEqual(
    mixed.map((ch) => [ch.key, ch.color, ch.count, ch.pct]),
    [
      ["user", "#ff9a3c", 1, 25],
      ["think", "#c084fc", 2, 50],
      ["reply", "#5b8def", 1, 25],
      ["tool", "#2dd4bf", 0, 0],
    ],
  );
  assert.equal(
    mixed.reduce((sum, ch) => sum + ch.pct, 0),
    100,
  );

  const empty = buildChannelBreakdown(null);
  assert.equal(empty.length, 4);
  assert.ok(empty.every((ch) => ch.count === 0 && ch.pct === 0));
});

test("cache hit, cost, tool latency, and code churn", () => {
  const models = [
    {
      model: "claude-3-5-sonnet",
      calls: 1,
      input_tokens: 10_000,
      output_tokens: 2_000,
      cache_read_tokens: 30_000,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    },
  ];
  const agg = aggregateMiniStats(
    stats({
      total_input_tokens: 10_000,
      total_output_tokens: 2_000,
      total_cache_read_tokens: 30_000,
      total_cache_write_tokens: 1_000,
      total_reasoning_tokens: 500,
      tool_calls: 6,
      tool_errors: 2,
      lines_added: 30,
      lines_removed: 10,
      active_model: "claude-3-5-sonnet",
      models,
      tools: [
        { name: "edit", calls: 4, errors: 1, avg_duration_ms: 10, max_duration_ms: 20, last_used: 1 },
        { name: "read", calls: 1, errors: 0, avg_duration_ms: 50, max_duration_ms: 50, last_used: 2 },
        { name: "idle", calls: 0, errors: 0, avg_duration_ms: 999, max_duration_ms: 999, last_used: 0 },
      ],
    }),
    "claude",
    0,
  );

  assert.equal(agg.cacheHitRate, 75);
  assert.equal(agg.totalTokens, 12_500);
  assert.equal(agg.inputTokens, 10_000);
  assert.equal(agg.outputTokens, 2_000);
  assert.equal(agg.reasoningTokens, 500);
  const expected = estimateTotalCost(models, "claude-3-5-sonnet", 10_000, 2_000, 30_000, 1_000);
  assert.ok(Math.abs(agg.estimatedCostUsd - expected) < 1e-9);
  assert.equal(agg.avgToolLatencyMs, 18);
  assert.equal(agg.linesAdded, 30);
  assert.equal(agg.linesRemoved, 10);
  assert.equal(agg.netLines, 20);
  assert.equal(agg.addRatioPct, 75);
  assert.equal(agg.toolCalls, 6);
  assert.equal(agg.toolErrors, 2);
  assertFiniteTree(agg satisfies AggregatedMiniStats);
});

test("zero tool calls and zero line churn do not produce NaN", () => {
  const agg = aggregateMiniStats(
    stats({
      tools: [{ name: "noop", calls: 0, errors: 0, avg_duration_ms: Number.NaN, max_duration_ms: 0, last_used: 0 }],
      lines_added: 0,
      lines_removed: 0,
      total_input_tokens: Number.NaN as unknown as number,
    }),
    "claude",
    Number.NaN,
  );
  assertFiniteTree(agg);
  assert.equal(agg.avgToolLatencyMs, 0);
  assert.equal(agg.addRatioPct, 50);
  assert.equal(agg.cacheHitRate, 0);
  assert.equal(agg.totalTokens, 0);
  assert.equal(agg.agent.isLive, false);
});

test("docked panel keeps the action labels and the decluttered map", () => {
  const panel = readFileSync(new URL("./DockedStatsPanel.tsx", import.meta.url), "utf8");
  const terrain = readFileSync(new URL("./TerrainViewport.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

  assert.match(panel, /aria-label="Expand to Fullscreen Telemetry HUD"/);
  assert.match(panel, /aria-label="Open Stats in a separate window"/);
  assert.match(panel, /aria-label="Close Docked Area Map"/);
  assert.match(panel, /aggregateMiniStats/);
  assert.match(panel, /hideDockedControls=\{true\}/);
  assert.match(panel, /className="mini-stat-deck"/);
  assert.match(panel, /className="mini-kpi-grid"/);
  assert.match(panel, /className="mini-subagent-list"/);
  assert.match(panel, /className="mini-channel-bar"/);
  assert.match(panel, /SUBAGENTS/);
  assert.match(panel, /CODE DELTA/);
  assert.match(panel, /COST · CACHE/);
  assert.match(panel, /3D TOPOGRAPHY/);

  const guard = terrain.indexOf("if (!dockedRef.current)");
  const pins = terrain.indexOf("(C) Waypoint Target Pins");
  const ruler = terrain.indexOf("(D) Left Y-Axis Altitude Ruler");
  assert.ok(guard !== -1 && guard < pins && pins < ruler);
  assert.match(terrain, /CHANNEL_TAGS/);
  assert.match(terrain, /"USR", "THK", "RPL", "TOL"/);
  assert.match(terrain, /CHRONO TIME: 00:00 \(START\)/);
  assert.match(terrain, /hideDockedControls/);

  for (const rule of [
    ".mini-stat-header",
    ".mini-stat-deck",
    ".mini-agent-card",
    ".mini-channels-card",
    ".mini-kpi-grid",
    ".mini-subagents-card",
    ".mini-subagent-list",
    ".mini-map-container",
  ]) {
    assert.ok(css.includes(rule), `missing ${rule}`);
  }
});
