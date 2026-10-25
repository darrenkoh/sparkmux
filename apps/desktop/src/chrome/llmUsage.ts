import { estimateTotalCost } from "./analyticsFormat.ts";
import type { LlmUsage, UsageBar, UsageCostPart } from "../types";

export type { LlmUsage, UsageBar };

export type UsageTone = "ok" | "warn" | "hot" | "cost";

export interface ModelWindowDetail {
  label: string;
  shortLabel: string;
  percent: number;
  fill: number;
  tone: UsageTone;
  resetsAtMs: number | null;
  resetsAtFormatted: string | null;
  countdown: string | null;
  /** Fraction of time remaining in this window (0..1). */
  timeFraction: number;
  isTighter: boolean;
}

export interface UsageCostDetail {
  sessionUsd: string;
  todayUsd: string;
  estimated: boolean;
}

export interface UsageChip {
  text: string;
  title: string;
  /** Width of the meter, matching the percent the label quotes. */
  fill: number;
  tone: UsageTone;
  /** Quota chips draw a remaining-percent bar. A Bedrock cost chip does not. */
  meter: boolean;
  /** Short model / group identifier, e.g. "Gemini", "Argon", "Claude", "Grok". */
  model?: string;
  /** Limit window label, e.g. "5h", "Wk". */
  window?: string;
  /** Formatted percentage number, e.g. 52. */
  percent?: number;
  /** Countdown string if available, e.g. "8h 55m". */
  resetsIn?: string | null;
  /** Fraction of time remaining until reset (0..1). 1 = full, 0 = expired. */
  timeFraction?: number;
  /** Milliseconds until reset. */
  timeRemainingMs?: number | null;
  /** Detailed window limits for the model info card popup. */
  details?: ModelWindowDetail[];
  /** When this payload was fetched (ms epoch). */
  fetchedAtMs?: number | null;
  /** Human-formatted age, e.g. "fetched just now". */
  fetchedAgeText?: string | null;
  /** Bedrock cost breakdown if applicable. */
  costDetail?: UsageCostDetail;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Identity for the allowance poll. A Grok title that changes from
 * `thinking - grok` to `editing - grok` stays on the same key.
 */
export function allowanceWatchKey(command: string, title: string): string {
  const base = (command.split(/[/\\]/).pop() ?? command).trim().toLowerCase();
  const last = title.toLowerCase().split(" - ").pop()?.trim() ?? "";
  const cleanLast = last.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const first = title.toLowerCase().split(" - ")[0]?.trim() ?? "";
  const cleanFirst = first.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const lowerTitle = title.toLowerCase();
  const versioned = /^(grok|claude|claude-code|agy)-\d/.test(base);
  const named =
    base === "grok" ||
    base === "claude" ||
    base === "claude-code" ||
    base.startsWith("claude-code") ||
    base === "agy" ||
    versioned;
  const titled =
    cleanLast === "grok" ||
    cleanLast === "claude" ||
    cleanLast === "claude code" ||
    cleanLast === "agy" ||
    cleanLast === "antigravity" ||
    cleanFirst === "grok" ||
    cleanFirst === "claude" ||
    cleanFirst === "claude code" ||
    cleanFirst === "agy" ||
    cleanFirst === "antigravity" ||
    lowerTitle.includes("antigravity") ||
    lowerTitle.includes("claude code") ||
    lowerTitle.includes("claude-code") ||
    (lowerTitle.includes("claude") && (lowerTitle.includes("bedrock") || lowerTitle.includes("amazon")));
  if (!named && !titled) return "shell";
  const label =
    cleanLast === "grok" ||
    cleanLast === "claude" ||
    cleanLast === "claude code" ||
    cleanLast === "agy" ||
    cleanLast === "antigravity"
      ? cleanLast
      : cleanFirst === "grok" ||
          cleanFirst === "claude" ||
          cleanFirst === "claude code" ||
          cleanFirst === "agy" ||
          cleanFirst === "antigravity"
        ? cleanFirst
        : lowerTitle.includes("claude code") || lowerTitle.includes("claude-code")
          ? "claude code"
          : lowerTitle.includes("claude")
            ? "claude"
            : last;
  return `agent:${named ? base : "shell"}:${titled ? label : ""}`;
}

export function resetTimeFraction(
  resetsAtMs: number | null | undefined,
  windowLabel: string | null | undefined,
  now: number,
): number {
  if (resetsAtMs == null) return 1;
  const remaining = Math.max(0, resetsAtMs - now);
  if (remaining === 0) return 0;
  const lower = (windowLabel ?? "").toLowerCase();
  let totalMs = 7 * 24 * 3600_000;
  if (lower.includes("five") || lower.includes("5") || lower.includes("5h")) {
    totalMs = 5 * 3600_000;
  } else if (lower.includes("day") || lower.includes("daily")) {
    totalMs = 24 * 3600_000;
  } else if (lower.includes("week") || lower.includes("wk")) {
    totalMs = 7 * 24 * 3600_000;
  } else if (remaining <= 5 * 3600_000) {
    totalMs = 5 * 3600_000;
  } else if (remaining <= 24 * 3600_000) {
    totalMs = 24 * 3600_000;
  }
  return Math.min(1, Math.max(0, remaining / totalMs));
}

/** Chips for the status bar. A shell pane and a CLI with no local payload yield none. */
export function usageChips(
  usage: LlmUsage | null | undefined,
  now: number,
  timeZone?: string,
): UsageChip[] {
  if (!usage?.cli) return [];
  if (usage.cli === "claude" && usage.cost) {
    return [costChip(usage.cost)];
  }
  if (usage.bars.length === 0) return [];
  const title = tooltip(usage, now, timeZone);
  const fetchedAgeText = usage.fetched_at_ms != null ? fetchedAge(usage.fetched_at_ms, now) : null;
  if (usage.cli === "grok") {
    const bar = usage.bars[0];
    if (!bar) return [];
    const left = amountLeft(bar);
    const timeRemainingMs = bar.resets_at_ms != null ? Math.max(0, bar.resets_at_ms - now) : null;
    const timeFraction = resetTimeFraction(bar.resets_at_ms, bar.label, now);
    const details: ModelWindowDetail[] = [
      {
        label: bar.label || "Weekly Limit",
        shortLabel: shortWindow(bar.label) ?? "Wk",
        percent: whole(left),
        fill: left,
        tone: usageTone(left),
        resetsAtMs: bar.resets_at_ms,
        resetsAtFormatted: bar.resets_at_ms ? formatAbsolute(bar.resets_at_ms, timeZone) : null,
        countdown: countdown(bar.resets_at_ms, now),
        timeFraction,
        isTighter: true,
      },
    ];
    return [
      {
        text: grokText(bar, now),
        title,
        fill: left,
        tone: usageTone(left),
        meter: true,
        model: "Grok",
        window: shortWindow(bar.label),
        percent: whole(left),
        resetsIn: countdown(bar.resets_at_ms, now),
        timeFraction,
        timeRemainingMs,
        details,
        fetchedAtMs: usage.fetched_at_ms,
        fetchedAgeText,
      },
    ];
  }
  if (usage.cli === "claude") {
    const bar = tighter(usage.bars);
    const left = amountLeft(bar);
    const timeRemainingMs = bar.resets_at_ms != null ? Math.max(0, bar.resets_at_ms - now) : null;
    const timeFraction = resetTimeFraction(bar.resets_at_ms, bar.label, now);
    const details: ModelWindowDetail[] = usage.bars.map((m) => {
      const mLeft = amountLeft(m);
      return {
        label: m.label,
        shortLabel: shortWindow(m.label) ?? m.label,
        percent: whole(mLeft),
        fill: mLeft,
        tone: usageTone(mLeft),
        resetsAtMs: m.resets_at_ms,
        resetsAtFormatted: m.resets_at_ms ? formatAbsolute(m.resets_at_ms, timeZone) : null,
        countdown: countdown(m.resets_at_ms, now),
        timeFraction: resetTimeFraction(m.resets_at_ms, m.label, now),
        isTighter: m === bar,
      };
    });
    return [
      {
        text: claudeText(usage.bars, now),
        title,
        fill: left,
        tone: usageTone(left),
        meter: true,
        model: "Claude",
        window: shortWindow(bar.label),
        percent: whole(left),
        resetsIn: countdown(bar.resets_at_ms, now),
        timeFraction,
        timeRemainingMs,
        details,
        fetchedAtMs: usage.fetched_at_ms,
        fetchedAgeText,
      },
    ];
  }
  if (usage.cli === "antigravity") {
    return groupChips(usage.bars, title, now, timeZone, usage.fetched_at_ms);
  }
  return [];
}

export function shortWindow(label: string | null | undefined): string | undefined {
  if (!label) return undefined;
  const lower = label.toLowerCase();
  if (lower.includes("five") || lower.includes("5") || lower.includes("5h")) return "5h";
  if (lower.includes("week") || lower.includes("wk")) return "Wk";
  if (lower.includes("day")) return "Day";
  return label.slice(0, 4);
}

export function amountLeft(bar: UsageBar): number {
  const percent = clamp(bar.percent);
  return bar.direction === "remaining" ? percent : clamp(100 - percent);
}

export function usageTone(left: number): UsageTone {
  if (left > 50) return "ok";
  if (left >= 20) return "warn";
  return "hot";
}

/** `Oct 13, 14:22` in `timeZone`. Omitted zone uses the machine zone. */
export function formatAbsolute(ms: number, timeZone?: string): string {
  const date = new Date(ms);
  if (timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    const hour = get("hour").replace(/\D/g, "") || "0";
    const minute = (get("minute").replace(/\D/g, "") || "0").padStart(2, "0");
    return `${get("month")} ${get("day")}, ${hour}:${minute}`;
  }
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function grokText(bar: UsageBar, now: number): string {
  return allowanceText("Grok", bar, now);
}

function claudeText(bars: UsageBar[], now: number): string {
  const five = bars.find((bar) => bar.label === "5 hour");
  const week = bars.find((bar) => bar.label === "Week");
  const parts: string[] = [];
  if (five) parts.push(allowanceText("5h", five, now));
  if (week) parts.push(allowanceText("wk", week, now));
  if (parts.length === 0) {
    const first = bars[0];
    parts.push(allowanceText(first.label, first, now));
  }
  return `Claude ${parts.join(" · ")}`;
}

/** `Grok 26% Remaining - Resets:1d 20h 50m 10s` */
function allowanceText(name: string, bar: UsageBar, now: number): string {
  const head = `${name} ${whole(amountLeft(bar))}% Remaining`;
  const left = countdown(bar.resets_at_ms, now);
  return left ? `${head} - Resets:${left}` : head;
}

function modelGroupTooltip(
  groupName: string,
  members: UsageBar[],
  tighterBar: UsageBar,
  now: number,
  timeZone?: string,
  fetchedAt?: number | null,
): string {
  const lines: string[] = [];
  const headName = groupName || "Model Quota";
  const tighterPercent = whole(amountLeft(tighterBar));
  const tighterLabel = tighterBar.label ? ` (tighter: ${tighterBar.label})` : "";
  lines.push(`${headName} · ${tighterPercent}% Remaining${tighterLabel}`);
  for (const bar of members) {
    const pct = precise(amountLeft(bar));
    const countdownStr = countdown(bar.resets_at_ms, now);
    const resetPart =
      bar.resets_at_ms != null
        ? `, resets ${formatAbsolute(bar.resets_at_ms, timeZone)}${countdownStr ? ` (in ${countdownStr})` : ""}`
        : "";
    lines.push(`• ${bar.label}: ${pct} Remaining${resetPart}`);
  }
  if (fetchedAt != null) {
    lines.push(fetchedAge(fetchedAt, now));
  }
  return lines.join("\n");
}

function groupChips(
  bars: UsageBar[],
  title: string,
  now: number,
  timeZone?: string,
  fetchedAt?: number | null,
): UsageChip[] {
  const groups: string[] = [];
  for (const bar of bars) {
    const name = bar.group ?? "";
    if (!groups.includes(name)) groups.push(name);
  }
  const chips: UsageChip[] = [];
  for (const name of groups) {
    const members = bars.filter((bar) => (bar.group ?? "") === name);
    const bar = tighter(members);
    const label = name || bar.label;
    const modelTitle = modelGroupTooltip(name, members, bar, now, timeZone, fetchedAt);
    const windowTag = shortWindow(bar.label);
    const left = amountLeft(bar);
    const timeRemainingMs = bar.resets_at_ms != null ? Math.max(0, bar.resets_at_ms - now) : null;
    const timeFraction = resetTimeFraction(bar.resets_at_ms, bar.label, now);
    const details: ModelWindowDetail[] = members.map((m) => {
      const mLeft = amountLeft(m);
      return {
        label: m.label,
        shortLabel: shortWindow(m.label) ?? m.label,
        percent: whole(mLeft),
        fill: mLeft,
        tone: usageTone(mLeft),
        resetsAtMs: m.resets_at_ms,
        resetsAtFormatted: m.resets_at_ms ? formatAbsolute(m.resets_at_ms, timeZone) : null,
        countdown: countdown(m.resets_at_ms, now),
        timeFraction: resetTimeFraction(m.resets_at_ms, m.label, now),
        isTighter: m === bar,
      };
    });
    chips.push({
      text: allowanceText(label, bar, now),
      title: modelTitle || title,
      fill: left,
      tone: usageTone(left),
      meter: true,
      model: name || bar.label,
      window: windowTag,
      percent: whole(left),
      resetsIn: countdown(bar.resets_at_ms, now),
      timeFraction,
      timeRemainingMs,
      details,
      fetchedAtMs: fetchedAt,
      fetchedAgeText: fetchedAt != null ? fetchedAge(fetchedAt, now) : null,
    });
  }
  return chips;
}

/** Remaining time as `1d 20h 50m 10s`, `3h 55m 0s`, or `12s`. */
function countdown(resetsAt: number | null, now: number): string | null {
  if (resetsAt == null) return null;
  return formatCountdown(resetsAt - now);
}

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3_600);
  const minutes = Math.floor((totalSec % 3_600) / 60);
  const seconds = totalSec % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function tighter(bars: UsageBar[]): UsageBar {
  let best = bars[0];
  for (const bar of bars.slice(1)) {
    const left = amountLeft(bar);
    const bestLeft = amountLeft(best);
    if (left < bestLeft - 0.05) {
      best = bar;
      continue;
    }
    if (Math.abs(left - bestLeft) <= 0.05) {
      const at = bar.resets_at_ms ?? Number.POSITIVE_INFINITY;
      const bestAt = best.resets_at_ms ?? Number.POSITIVE_INFINITY;
      if (at < bestAt) best = bar;
    }
  }
  return best;
}

function costChip(cost: NonNullable<LlmUsage["cost"]>): UsageChip {
  const session = pricePart(cost.session);
  const today = pricePart(cost.today);
  const sessionFormatted = costAmount(session.usd, session.estimated);
  const todayFormatted = costAmount(today.usd, today.estimated);
  const text = `Claude ${sessionFormatted} session · ${todayFormatted} today`;
  return {
    text,
    title: costTooltip(session, today),
    fill: 0,
    tone: "cost",
    meter: false,
    model: "Claude",
    costDetail: {
      sessionUsd: sessionFormatted,
      todayUsd: todayFormatted,
      estimated: session.estimated || today.estimated,
    },
  };
}

function pricePart(part: UsageCostPart): { usd: number; estimated: boolean } {
  const models = part.models ?? [];
  const extra = models.length > 0 ? estimateTotalCost(models, undefined, 0, 0, 0, 0) : 0;
  return {
    usd: finiteUsd(part.known_usd) + finiteUsd(extra),
    estimated: part.estimated || models.length > 0,
  };
}

function finiteUsd(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/** `$1.23`, or four decimals under one cent so a new session can move. */
function formatCostUsd(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function costAmount(usd: number, estimated: boolean): string {
  const body = formatCostUsd(usd);
  return estimated ? `est. ${body}` : body;
}

function costTooltip(
  session: { usd: number; estimated: boolean },
  today: { usd: number; estimated: boolean },
): string {
  const lines = [
    "Bedrock API",
    `Session ${costAmount(session.usd, session.estimated)}`,
    `Today ${costAmount(today.usd, today.estimated)} since local midnight`,
  ];
  if (session.estimated || today.estimated) {
    lines.push("Estimated from token rates where Claude recorded no price");
  } else {
    lines.push("Recorded by Claude");
  }
  return lines.join("\n");
}

function tooltip(usage: LlmUsage, now: number, timeZone?: string): string {
  const lines: string[] = [];
  if (usage.plan) lines.push(usage.plan);
  for (const bar of usage.bars) lines.push(barDetail(bar, timeZone));
  if (usage.credits_usd != null && Number.isFinite(usage.credits_usd)) {
    lines.push(`Credits $${usage.credits_usd.toFixed(2)}`);
  }
  if (usage.fetched_at_ms != null) lines.push(fetchedAge(usage.fetched_at_ms, now));
  return lines.join("\n");
}

function barDetail(bar: UsageBar, timeZone?: string): string {
  const name = [bar.group, bar.label].filter(Boolean).join(" ");
  const percent = precise(amountLeft(bar));
  if (bar.resets_at_ms == null) return `${name} ${percent} Remaining`;
  return `${name} ${percent} Remaining, resets ${formatAbsolute(bar.resets_at_ms, timeZone)}`;
}

function fetchedAge(fetchedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  if (sec < 60) return "fetched just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `fetched ${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `fetched ${hours}h ago`;
  return `fetched ${Math.floor(hours / 24)}d ago`;
}

function whole(percent: number): number {
  return Math.round(clamp(percent));
}

function precise(percent: number): string {
  const rounded = Math.round(clamp(percent) * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 0.05) return `${Math.round(rounded)}%`;
  return `${rounded.toFixed(1)}%`;
}

function clamp(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/**
 * Antigravity paints quota only on its usage view. The CLI does not write
 * that payload to disk, so the footer reads the screen text.
 * A chat transcript returns null.
 */
export function parseAgyUsageScreen(text: string, now: number): LlmUsage | null {
  const bars: UsageBar[] = [];
  let group: string | null = null;
  let label: string | null = null;
  let percent: number | null = null;

  const dropPending = () => {
    label = null;
    percent = null;
  };
  const push = (resetsAt: number | null) => {
    if (label == null || percent == null) {
      dropPending();
      return;
    }
    bars.push({
      group,
      label,
      percent: Math.round(percent * 100) / 100,
      direction: "remaining",
      resets_at_ms: resetsAt,
    });
    dropPending();
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (isAgyGroupHeader(line)) {
      dropPending();
      group = shortAgyGroup(line);
      continue;
    }
    if (/weekly/i.test(line) && /limit/i.test(line)) {
      label = "Weekly";
      percent = null;
      continue;
    }
    if (/(five hour|5.?hour|5h)/i.test(line) && /limit/i.test(line)) {
      label = "5 hour";
      percent = null;
      continue;
    }
    if (label && percent == null) {
      const match = /(\d+(?:\.\d+)?)%/.exec(line);
      if (match) {
        percent = Number(match[1]);
        continue;
      }
    }
    if (label && percent != null && /refreshes in/i.test(line)) {
      push(parseRefresh(line, now));
      continue;
    }
    if (label && percent != null && /quota available/i.test(line)) {
      push(null);
    }
  }

  if (bars.length === 0) return null;
  return {
    cli: "antigravity",
    bars,
    fetched_at_ms: now,
    plan: null,
    credits_usd: null,
    cost: null,
  };
}

function isAgyGroupHeader(line: string): boolean {
  if (line.length >= 48) return false;
  const upper = line.toUpperCase();
  if (line !== upper) return false;
  if (/^(QUOTA|USAGE|LIMITS|WEEKLY|FIVE HOUR)/i.test(line)) return false;
  return (
    /models$/i.test(line) ||
    /^(GEMINI|CLAUDE|GPT|ARGON|GROK|O1|O3|SONNET|OPUS|HAIKU)/i.test(line)
  );
}

function shortAgyGroup(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("argon")) return "Argon";
  if (lower.includes("flash")) return "Flash";
  if (lower.includes("pro")) return "Pro";
  if (lower.includes("gemini")) return "Gemini";
  if (lower.includes("claude")) return "Claude";
  if (lower.includes("grok")) return "Grok";
  return (name.split(/\s+/)[0] ?? name).slice(0, 16);
}

/** `Refreshes in 134h 57m` measured from `now`. */
function parseRefresh(line: string, now: number): number | null {
  const match = /refreshes in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i.exec(line);
  if (!match || (match[1] == null && match[2] == null)) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = match[2] ? Number(match[2]) : 0;
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return now + (hours * 60 + minutes) * 60_000;
}
