import type { FeedLine, OfficeAgent, OfficeSnapshot, PoseResult } from "./officeTypes.ts";

export const CALLSIGNS = [
  "Alfred",
  "Atlas",
  "Scout",
  "Fetch",
  "Warren",
  "Claim",
  "Radar",
  "Nova",
  "Echo",
  "Juno",
  "Orion",
  "Pixel",
  "Quill",
  "Rook",
  "Sage",
  "Vega",
  "Wren",
  "Zephyr",
  "Bolt",
  "Cleo",
  "Dash",
  "Ember",
  "Flint",
  "Gale",
];

export const AGENT_PALETTE = [
  0x3b82f6, 0xfacc15, 0xf97316, 0x38bdf8, 0x22c55e, 0x9ca3af, 0x111827, 0x8b5a2b, 0xec4899,
  0xa855f7, 0x14b8a6, 0xef4444,
];

export const CLI_ACCENT = { claude: 0xd97757, grok: 0xe5e7eb, antigravity: 0x4f8ff7 } as const;

/** How long a finished agent stays at the coffee bar before the sofa. */
export const COFFEE_HOLD_MS = 20_000;

/** Thinking and replying feed lines are at most this often per agent. The view enforces it. */
export const SOFT_FEED_MS = 15_000;

const STATE_RANK: Record<string, number> = {
  needs_user: 0,
  failed: 1,
  running: 2,
  succeeded: 3,
  idle: 4,
};

const ACTIVITY_VERB: Record<string, string> = {
  coding: "editing",
  terminal: "running",
  reading: "reading",
  browsing: "browsing",
  delegating: "delegating to a subagent",
  planning: "planning",
};

export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function agentKey(agent: { session: string; pane_id: string }): string {
  return `${agent.session}:${agent.pane_id}`;
}

/** Stable callsign. The caller adds the result to `taken` so later agents probe past it. */
export function callsign(key: string, taken: Set<string>): string {
  const start = fnv1a(key) % CALLSIGNS.length;
  for (let i = 0; i < CALLSIGNS.length; i += 1) {
    const name = CALLSIGNS[(start + i) % CALLSIGNS.length] ?? "Agent";
    if (!taken.has(name)) return name;
  }
  const base = CALLSIGNS[start] ?? "Agent";
  let suffix = 2;
  while (taken.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

export function agentColor(key: string): number {
  return AGENT_PALETTE[fnv1a(key) % AGENT_PALETTE.length] ?? AGENT_PALETTE[0] ?? 0x3b82f6;
}

export function resolvePose(agent: OfficeAgent): PoseResult {
  switch (agent.state) {
    case "needs_user":
      return { pose: "raise_hand", zone: "desk", marker: "ask" };
    case "failed":
      return { pose: "slump", zone: "desk", marker: "error" };
    case "succeeded":
      return { pose: "coffee", zone: "coffee", marker: null };
    case "idle":
      return { pose: "sofa", zone: "sofa", marker: "zzz" };
    default:
      return poseForActivity(agent);
  }
}

/** Sofa after the coffee hold. `elapsedMs` is how long the agent has been succeeded. */
export function poseAfterSucceeded(elapsedMs: number): PoseResult {
  if (elapsedMs >= COFFEE_HOLD_MS) return { pose: "sofa", zone: "sofa", marker: null };
  return { pose: "coffee", zone: "coffee", marker: null };
}

export function softFeedDue(lastAt: number | undefined, now: number): boolean {
  return lastAt === undefined || now - lastAt >= SOFT_FEED_MS;
}

/** Wait this long so a second click can rename instead of leaving the office. */
export const TEAM_RENAME_MS = 400;

/** One click opens the pane. A second click inside the window renames the avatar. */
export function teamClickPlan(clickCount: number): "rename" | "navigate" {
  return clickCount >= 2 ? "rename" : "navigate";
}

/** Desk and avatar picks share `session:pane_id`. Unknown keys are not agents. */
export function agentForPick(agents: readonly OfficeAgent[], key: string | null): OfficeAgent | null {
  if (!key) return null;
  return agents.find((agent) => agentKey(agent) === key) ?? null;
}

function poseForActivity(agent: OfficeAgent): PoseResult {
  switch (agent.activity) {
    case "coding":
      return { pose: "type_fast", zone: "desk", marker: null };
    case "terminal":
      return { pose: "terminal", zone: "desk", marker: null };
    case "reading":
      return { pose: "read_standing", zone: "bookshelf", marker: null };
    case "browsing":
      return {
        pose: "browse",
        zone: fnv1a(agentKey(agent)) % 2 === 1 ? "window" : "desk",
        marker: null,
      };
    case "delegating":
      return { pose: "meeting", zone: "meeting", marker: null };
    case "thinking":
      return { pose: "lean_back", zone: "desk", marker: "thought" };
    case "planning":
      return { pose: "whiteboard", zone: "whiteboard", marker: null };
    case "replying":
    default:
      return { pose: "type_slow", zone: "desk", marker: null };
  }
}

/**
 * Header counters. `needs_user` is need-you, never working.
 * Failed and finished agents count as idle so the three agent counters cover every row.
 * Free desks are the non-agent panes, not a slice of `agents`.
 */
export function counters(snapshot: OfficeSnapshot): {
  working: number;
  needYou: number;
  idle: number;
  freeDesks: number;
} {
  let working = 0;
  let needYou = 0;
  let idle = 0;
  for (const agent of snapshot.agents) {
    if (agent.state === "running") working += 1;
    else if (agent.state === "needs_user") needYou += 1;
    else idle += 1;
  }
  return { working, needYou, idle, freeDesks: snapshot.free_desks.length };
}

export function statusText(agent: OfficeAgent): string {
  switch (agent.state) {
    case "needs_user":
      return "Needs you";
    case "failed":
      return "Failed";
    case "succeeded":
      return "Finished";
    case "idle":
      return "Idle";
    default:
      break;
  }
  switch (agent.activity) {
    case "thinking":
      return "Thinking";
    case "replying":
      return "Replying";
    case "planning":
      return agent.tool_arg ? `Planning ${agent.tool_arg}` : "Planning";
    case "delegating":
      return agent.tool_arg ? `Delegating ${agent.tool_arg}` : "Delegating";
    case "reading":
      return agent.tool_arg ? `Reading ${agent.tool_arg}` : "Reading";
    case "browsing":
      return agent.tool_arg ? `Browsing ${agent.tool_arg}` : "Browsing";
    case "coding":
      return agent.tool_arg ? `Editing ${agent.tool_arg}` : "Editing";
    case "terminal":
      if (agent.tool && agent.tool_arg) return `Running ${agent.tool}: ${agent.tool_arg}`;
      if (agent.tool) return `Running ${agent.tool}`;
      return "In terminal";
    default:
      return "Working";
  }
}

export function teamOrder(agents: OfficeAgent[]): OfficeAgent[] {
  return [...agents].sort((left, right) => {
    const byState = (STATE_RANK[left.state] ?? 9) - (STATE_RANK[right.state] ?? 9);
    if (byState !== 0) return byState;
    if (left.session !== right.session) return left.session < right.session ? -1 : 1;
    if (left.window_name !== right.window_name) {
      return left.window_name < right.window_name ? -1 : 1;
    }
    if (left.pane_id !== right.pane_id) return left.pane_id < right.pane_id ? -1 : 1;
    return 0;
  });
}

export function diffFeed(
  prev: OfficeSnapshot | null,
  next: OfficeSnapshot,
  names: Map<string, string>,
  now: number,
): FeedLine[] {
  const lines: FeedLine[] = [];
  let serial = 0;
  const nameOf = (key: string) => names.get(key) ?? "Agent";
  const push = (key: string, tone: FeedLine["tone"], text: string) => {
    lines.push({
      id: `${now}:${key}:${serial}`,
      at: now,
      key,
      name: nameOf(key),
      tone,
      text,
    });
    serial += 1;
  };

  if (prev === null) {
    for (const agent of next.agents) {
      const key = agentKey(agent);
      push(key, "work", `${nameOf(key)} arrived at ${agent.session} · ${agent.window_name}`);
    }
    return lines;
  }

  const nextBy = new Map(next.agents.map((agent) => [agentKey(agent), agent]));
  const prevBy = new Map(prev.agents.map((agent) => [agentKey(agent), agent]));
  for (const agent of prev.agents) {
    const key = agentKey(agent);
    if (!nextBy.has(key)) push(key, "idle", `${nameOf(key)} left the office`);
  }
  for (const agent of next.agents) {
    const key = agentKey(agent);
    const was = prevBy.get(key);
    if (!was) {
      push(key, "work", `${nameOf(key)} arrived at ${agent.session} · ${agent.window_name}`);
      continue;
    }
    if (was.state !== agent.state) {
      const [tone, text] = stateLine(agent, nameOf(key));
      push(key, tone, text);
      continue;
    }
    const entryChanged = was.last_entry_id !== agent.last_entry_id;
    if (!entryChanged) continue;
    if (was.tool !== agent.tool) {
      const verb = ACTIVITY_VERB[agent.activity];
      if (verb) {
        const arg = clip(agent.tool_arg, 50);
        push(key, "work", arg ? `${nameOf(key)} is ${verb} ${arg}` : `${nameOf(key)} is ${verb}`);
        continue;
      }
    }
    if (agent.activity === "thinking" || agent.activity === "replying") {
      const verb = agent.activity === "thinking" ? "thinking" : "replying";
      push(key, "work", `${nameOf(key)} is ${verb}`);
    }
  }
  return lines;
}

function stateLine(agent: OfficeAgent, name: string): [FeedLine["tone"], string] {
  switch (agent.state) {
    case "needs_user":
      return ["ask", `${name} needs you: ${clip(agent.ask, 60)}`];
    case "failed":
      return ["error", `${name} hit an error`];
    case "succeeded":
      return ["ok", `${name} finished the task`];
    case "idle":
      return ["idle", `${name} is taking a break`];
    case "running":
      return ["work", `${name} started working`];
    default:
      return ["work", `${name} updated`];
  }
}

function clip(text: string, cap: number): string {
  return [...text].slice(0, cap).join("");
}
