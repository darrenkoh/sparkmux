import type { SubagentStat, TabAnalyticsStats, ToolStat } from "../api";
import { estimateTotalCost } from "./analyticsFormat.ts";
import { cliLabel } from "./artifactModel.ts";

/** A primary agent or subagent is live when its last event is this recent. */
export const LIVE_THRESHOLD_MS = 30_000;

export interface AggregatedAgentSummary {
  cliBadge: string;
  activeModel: string;
  isLive: boolean;
  turnCount: number;
  avgTurnMs: number;
  ttftMs: number;
}

export interface AggregatedSubagentRow {
  id: string;
  name: string;
  modelShort: string;
  totalTokens: number;
  toolCalls: number;
  toolErrors: number;
  linesAdded: number;
  linesRemoved: number;
  isLive: boolean;
  lastTs: number;
}

export interface AggregatedSubagentsSummary {
  totalCount: number;
  activeCount: number;
  totalTokens: number;
  totalToolCalls: number;
  totalErrors: number;
  rows: AggregatedSubagentRow[];
}

export interface ChannelBreakdownItem {
  key: "user" | "think" | "reply" | "tool";
  label: string;
  color: string;
  count: number;
  pct: number;
}

export interface AggregatedMiniStats {
  agent: AggregatedAgentSummary;
  subagents: AggregatedSubagentsSummary;
  channels: ChannelBreakdownItem[];
  totalEvents: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number;
  estimatedCostUsd: number;
  toolCalls: number;
  toolErrors: number;
  avgToolLatencyMs: number;
  linesAdded: number;
  linesRemoved: number;
  netLines: number;
  addRatioPct: number;
}

const CHANNEL_DEFS = [
  { key: "user", label: "USER", color: "#ff9a3c" },
  { key: "think", label: "THINK", color: "#c084fc" },
  { key: "reply", label: "REPLY", color: "#5b8def" },
  { key: "tool", label: "TOOL", color: "#2dd4bf" },
] as const;

function num(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function raw(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Recent enough to paint a live dot. A missing or zero timestamp is idle. */
export function isLiveAt(ts: number | null | undefined, nowMs: number): boolean {
  const t = raw(ts);
  if (t <= 0) return false;
  // A bad clock must not collapse to 0, or every past event looks live.
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return false;
  return nowMs - t <= LIVE_THRESHOLD_MS;
}

/**
 * Fits a model id into a narrow badge.
 * `claude-sonnet-4-5-20250929` -> `sonnet-4-5`, `grok-4.7-build` -> `grok-4.7`.
 */
export function shortModelName(model: string | null | undefined): string {
  let name = (model ?? "").trim();
  if (!name) return "";
  name = name.replace(/^models\//, "");
  name = name.replace(/^claude-/, "");
  name = name.replace(/-build$/, "");
  name = name.replace(/-\d{8}$/, "");
  return name;
}

export function cliBadge(cli: string | null | undefined): string {
  const label = cliLabel(cli ?? null);
  return label ? label.toUpperCase() : "IDLE";
}

export function buildChannelBreakdown(
  stats: Pick<
    TabAnalyticsStats,
    "user_prompts" | "thinking_blocks" | "assistant_replies" | "tool_calls"
  > | null | undefined,
): ChannelBreakdownItem[] {
  const counts = [
    num(stats?.user_prompts),
    num(stats?.thinking_blocks),
    num(stats?.assistant_replies),
    num(stats?.tool_calls),
  ];
  const total = counts.reduce((sum, count) => sum + count, 0);
  return CHANNEL_DEFS.map((ch, index) => ({
    key: ch.key,
    label: ch.label,
    color: ch.color,
    count: counts[index],
    pct: total > 0 ? (counts[index] / total) * 100 : 0,
  }));
}

function isPlaceholder(row: SubagentStat): boolean {
  return (row.id ?? "").trim() === "" && (row.label ?? "").trim() === "";
}

export function buildSubagentsSummary(
  subagents: SubagentStat[] | null | undefined,
  nowMs: number,
): AggregatedSubagentsSummary {
  const rows: AggregatedSubagentRow[] = [];
  for (const row of subagents ?? []) {
    if (!row || isPlaceholder(row)) continue;
    const id = (row.id ?? "").trim();
    const label = (row.label ?? "").trim();
    const totalTokens = num(row.input_tokens) + num(row.output_tokens) + num(row.reasoning_tokens);
    rows.push({
      id,
      name: label || id,
      modelShort: shortModelName(row.model),
      totalTokens,
      toolCalls: num(row.tool_calls),
      toolErrors: num(row.tool_errors),
      linesAdded: num(row.lines_added),
      linesRemoved: num(row.lines_removed),
      isLive: isLiveAt(row.last_ts, nowMs),
      lastTs: raw(row.last_ts),
    });
  }

  rows.sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    if (a.lastTs !== b.lastTs) return b.lastTs - a.lastTs;
    return b.totalTokens - a.totalTokens;
  });

  let totalTokens = 0;
  let totalToolCalls = 0;
  let totalErrors = 0;
  let activeCount = 0;
  for (const row of rows) {
    totalTokens += row.totalTokens;
    totalToolCalls += row.toolCalls;
    totalErrors += row.toolErrors;
    if (row.isLive) activeCount += 1;
  }

  return {
    totalCount: rows.length,
    activeCount,
    totalTokens,
    totalToolCalls,
    totalErrors,
    rows,
  };
}

function avgToolLatencyMs(tools: ToolStat[] | null | undefined): number {
  let weighted = 0;
  let calls = 0;
  for (const tool of tools ?? []) {
    const n = num(tool?.calls);
    weighted += num(tool?.avg_duration_ms) * n;
    calls += n;
  }
  if (calls <= 0) return 0;
  return finite(weighted / calls);
}

export function aggregateMiniStats(
  stats: TabAnalyticsStats | null | undefined,
  cli: string | null | undefined,
  nowMs: number,
): AggregatedMiniStats {
  const inputTokens = num(stats?.total_input_tokens);
  const outputTokens = num(stats?.total_output_tokens);
  const reasoningTokens = num(stats?.total_reasoning_tokens);
  const cacheReadTokens = num(stats?.total_cache_read_tokens);
  const cacheWriteTokens = num(stats?.total_cache_write_tokens);
  const cacheBase = inputTokens + cacheReadTokens;
  const linesAdded = num(stats?.lines_added);
  const linesRemoved = num(stats?.lines_removed);
  const lineBase = linesAdded + linesRemoved;

  const cost = stats
    ? estimateTotalCost(
        stats.models ?? [],
        stats.active_model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      )
    : 0;

  return {
    agent: {
      cliBadge: cliBadge(cli),
      activeModel: shortModelName(stats?.active_model),
      isLive: isLiveAt(stats?.timeline_end, nowMs),
      turnCount: num(stats?.turn_count),
      avgTurnMs: num(stats?.avg_turn_duration_ms),
      ttftMs: num(stats?.ttft_ms),
    },
    subagents: buildSubagentsSummary(stats?.subagents, nowMs),
    channels: buildChannelBreakdown(stats),
    totalEvents: num(stats?.total_events),
    totalTokens: inputTokens + outputTokens + reasoningTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheHitRate: cacheBase > 0 ? (cacheReadTokens / cacheBase) * 100 : 0,
    estimatedCostUsd: finite(Math.max(0, cost)),
    toolCalls: num(stats?.tool_calls),
    toolErrors: num(stats?.tool_errors),
    avgToolLatencyMs: avgToolLatencyMs(stats?.tools),
    linesAdded,
    linesRemoved,
    netLines: linesAdded - linesRemoved,
    addRatioPct: lineBase > 0 ? (linesAdded / lineBase) * 100 : 50,
  };
}
