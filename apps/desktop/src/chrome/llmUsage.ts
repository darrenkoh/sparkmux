import type { LlmUsage, UsageBar } from "../types";

export type { LlmUsage, UsageBar };

export type UsageTone = "ok" | "warn" | "hot";

export interface UsageChip {
  text: string;
  title: string;
  /** Width of the meter, matching the percent the label quotes. */
  fill: number;
  tone: UsageTone;
}

const DAY_MS = 24 * 60 * 60 * 1000;
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
  const versioned = /^(grok|claude|agy)-\d/.test(base);
  const named = base === "grok" || base === "claude" || base === "agy" || versioned;
  const titled =
    last === "grok" ||
    last === "claude" ||
    last === "claude code" ||
    last === "agy" ||
    last === "antigravity" ||
    title.toLowerCase().includes("antigravity");
  if (!named && !titled) return "shell";
  return `agent:${named ? base : "shell"}:${titled ? last : ""}`;
}

/** Chips for the status bar. A shell pane and a CLI with no local payload yield none. */
export function usageChips(
  usage: LlmUsage | null | undefined,
  now: number,
  timeZone?: string,
): UsageChip[] {
  if (!usage?.cli || usage.bars.length === 0) return [];
  const title = tooltip(usage, now, timeZone);
  if (usage.cli === "grok") {
    const bar = usage.bars[0];
    if (!bar) return [];
    return [chip(grokText(bar, now, timeZone), title, bar)];
  }
  if (usage.cli === "claude") {
    return [chip(claudeText(usage.bars), title, tighter(usage.bars))];
  }
  if (usage.cli === "antigravity") {
    return groupChips(usage.bars, title, now);
  }
  return [];
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

function grokText(bar: UsageBar, now: number, timeZone?: string): string {
  const when = resetPhrase(bar.resets_at_ms, now, timeZone);
  const head = `Grok ${whole(bar.percent)}% used`;
  return when ? `${head} · ${when}` : head;
}

function resetPhrase(resetsAt: number | null, now: number, timeZone?: string): string | null {
  if (resetsAt == null) return null;
  const delta = resetsAt - now;
  if (delta <= 60_000) return "resets now";
  if (delta < DAY_MS) return `resets in ${formatSpan(delta)}`;
  return `resets ${formatAbsolute(resetsAt, timeZone)}`;
}

function claudeText(bars: UsageBar[]): string {
  const five = bars.find((bar) => bar.label === "5 hour");
  const week = bars.find((bar) => bar.label === "Week");
  const parts: string[] = [];
  if (five) parts.push(`5h ${whole(five.percent)}% used`);
  if (week) parts.push(`wk ${whole(week.percent)}% used`);
  if (parts.length === 0) {
    const first = bars[0];
    parts.push(`${first.label} ${whole(first.percent)}% used`);
  }
  return `Claude ${parts.join(" · ")}`;
}

function groupChips(bars: UsageBar[], title: string, now: number): UsageChip[] {
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
    const when = agyWhen(bar.resets_at_ms, now);
    const text = when
      ? `${label} ${whole(bar.percent)}% left · ${when}`
      : `${label} ${whole(bar.percent)}% left`;
    chips.push(chip(text, title, bar));
  }
  return chips;
}

function agyWhen(resetsAt: number | null, now: number): string | null {
  if (resetsAt == null) return null;
  const delta = resetsAt - now;
  if (delta <= 60_000) return "now";
  if (delta < DAY_MS) return `in ${formatSpan(delta)}`;
  const hours = Math.round(delta / 3_600_000);
  return `${hours}h`;
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

function chip(text: string, title: string, bar: UsageBar): UsageChip {
  return {
    text,
    title,
    fill: clamp(bar.percent),
    tone: usageTone(amountLeft(bar)),
  };
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
  const dir = bar.direction === "remaining" ? "left" : "used";
  const percent = precise(bar.percent);
  if (bar.resets_at_ms == null) return `${name} ${percent} ${dir}`;
  return `${name} ${percent} ${dir}, resets ${formatAbsolute(bar.resets_at_ms, timeZone)}`;
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

function formatSpan(ms: number): string {
  const totalMin = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
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
    if (/^weekly limit remaining$/i.test(line)) {
      label = "Weekly";
      percent = null;
      continue;
    }
    if (/^five hour limit remaining$/i.test(line)) {
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
  };
}

function isAgyGroupHeader(line: string): boolean {
  return line.length < 48 && /models$/i.test(line) && line === line.toUpperCase();
}

function shortAgyGroup(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("gemini")) return "Gemini";
  if (lower.includes("claude")) return "Claude";
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
