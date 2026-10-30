import type { OfficeAgent, OfficeSnapshot, OfficeStep } from "./officeTypes.ts";

interface ActivityPick {
  activity: string;
  tool: string;
  tool_arg: string;
  detail: string;
}

const ACTIVITIES: ActivityPick[] = [
  { activity: "coding", tool: "Edit", tool_arg: "src/App.tsx", detail: "Editing src/App.tsx" },
  { activity: "terminal", tool: "Bash", tool_arg: "cargo test", detail: "Running cargo test" },
  { activity: "reading", tool: "Read", tool_arg: "src/main.rs", detail: "Reading src/main.rs" },
  { activity: "browsing", tool: "web_search", tool_arg: "sparkmux office", detail: "Searching the web" },
  { activity: "thinking", tool: "", tool_arg: "", detail: "Thinking" },
  { activity: "replying", tool: "", tool_arg: "", detail: "Writing a reply" },
  { activity: "planning", tool: "TodoWrite", tool_arg: "ship the office", detail: "Planning the work" },
  { activity: "delegating", tool: "Task", tool_arg: "research the layout", detail: "Delegating research" },
];

const SESSIONS = ["research", "ops", "frontend"];
const ASK = "Approve running `rm -rf target`?";

interface SimAgent {
  session: string;
  window_id: string;
  window_name: string;
  pane_id: string;
  cli: string;
  model: string;
  project: string;
  state: string;
  activity: string;
  tool: string;
  tool_arg: string;
  detail: string;
  ask: string;
  last_entry_id: string;
  entryN: number;
  recent: OfficeStep[];
  phaseUntil: number;
}

/** Deterministic office. The same seed and the same tick times replay the same snapshots. */
export function createSim(seed: number, count = 8): { tick(nowMs: number): OfficeSnapshot } {
  const rand = mulberry32(seed);
  const agents: SimAgent[] = [];
  for (let index = 0; index < count; index += 1) {
    const cli = index % 4 === 2 ? "grok" : index % 4 === 3 ? "antigravity" : "claude";
    const model = cli === "grok" ? "Grok" : cli === "antigravity" ? "Antigravity" : "Claude";
    const session = SESSIONS[index % SESSIONS.length] ?? "research";
    const picked = pickActivity(rand);
    const agent: SimAgent = {
      session,
      window_id: `@${(index % 3) + 1}`,
      window_name: session,
      pane_id: `%${index + 1}`,
      cli,
      model,
      project: session,
      state: "running",
      activity: picked.activity,
      tool: picked.tool,
      tool_arg: picked.tool_arg,
      detail: picked.detail,
      ask: "",
      last_entry_id: "",
      entryN: 0,
      recent: [],
      phaseUntil: 0,
    };
    touch(agent);
    agents.push(agent);
  }
  let lastMs: number | null = null;

  return {
    tick(nowMs: number): OfficeSnapshot {
      if (lastMs === null) {
        for (const agent of agents) agent.phaseUntil = nowMs + durationMs(rand);
        lastMs = nowMs;
        return snapshot(agents, nowMs);
      }
      let guard = 0;
      while (lastMs < nowMs && guard < 20_000) {
        guard += 1;
        let next = nowMs;
        for (const agent of agents) {
          if (agent.phaseUntil > lastMs && agent.phaseUntil < next) next = agent.phaseUntil;
        }
        const dt = next - lastMs;
        const minute = dt / 60_000;
        for (const agent of agents) {
          if (agent.state !== "running") continue;
          if (rand() < Math.min(1, 0.05 * minute)) {
            enterState(agent, "needs_user", next, 45_000);
            continue;
          }
          if (rand() < Math.min(1, 0.02 * minute)) enterState(agent, "failed", next, 30_000);
        }
        lastMs = next;
        for (const agent of agents) {
          if (agent.phaseUntil <= lastMs) advance(agent, lastMs, rand);
        }
        if (next === nowMs) break;
      }
      return snapshot(agents, nowMs);
    },
  };
}

function enterState(agent: SimAgent, state: "needs_user" | "failed", now: number, holdMs: number) {
  agent.state = state;
  agent.activity = "";
  agent.tool = "";
  agent.tool_arg = "";
  agent.ask = state === "needs_user" ? ASK : "";
  agent.detail = state === "needs_user" ? ASK : "The command failed";
  agent.phaseUntil = now + holdMs;
  touch(agent);
}

function advance(agent: SimAgent, now: number, rand: () => number) {
  if (agent.state === "needs_user" || agent.state === "failed" || agent.state === "idle") {
    startRunning(agent, now, rand);
    return;
  }
  if (agent.state === "succeeded") {
    agent.state = "idle";
    agent.activity = "";
    agent.tool = "";
    agent.tool_arg = "";
    agent.ask = "";
    agent.detail = "Taking a break";
    agent.phaseUntil = now + 30_000;
    touch(agent);
    return;
  }
  if (rand() < 0.18) {
    agent.state = "succeeded";
    agent.activity = "";
    agent.tool = "";
    agent.tool_arg = "";
    agent.ask = "";
    agent.detail = "Finished the task";
    agent.phaseUntil = now + 60_000;
    touch(agent);
    return;
  }
  startRunning(agent, now, rand);
}

function startRunning(agent: SimAgent, now: number, rand: () => number) {
  const picked = pickActivity(rand);
  agent.state = "running";
  agent.activity = picked.activity;
  agent.tool = picked.tool;
  agent.tool_arg = picked.tool_arg;
  agent.detail = picked.detail;
  agent.ask = "";
  agent.phaseUntil = now + durationMs(rand);
  touch(agent);
}

function pickActivity(rand: () => number): ActivityPick {
  const index = Math.floor(rand() * ACTIVITIES.length) % ACTIVITIES.length;
  return ACTIVITIES[index] ?? ACTIVITIES[0]!;
}

function durationMs(rand: () => number): number {
  return 6_000 + Math.floor(rand() * 14_001);
}

function touch(agent: SimAgent) {
  agent.entryN += 1;
  agent.last_entry_id = `${agent.pane_id}:${agent.entryN}`;
  const kind =
    agent.activity === "thinking" ? "thinking" : agent.activity === "replying" ? "assistant" : "tool";
  agent.recent.push({
    id: agent.last_entry_id,
    kind,
    label: agent.tool || agent.state,
    text: agent.detail,
  });
  if (agent.recent.length > 6) agent.recent.splice(0, agent.recent.length - 6);
}

function snapshot(agents: SimAgent[], nowMs: number): OfficeSnapshot {
  return {
    agents: agents.map((agent) => toOffice(agent, nowMs)),
    free_desks: [
      { session: "research", pane_id: "%free1", window_name: "shell" },
      { session: "ops", pane_id: "%free2", window_name: "shell" },
    ],
    now_ms: nowMs,
  };
}

function toOffice(agent: SimAgent, nowMs: number): OfficeAgent {
  return {
    session: agent.session,
    window_id: agent.window_id,
    window_name: agent.window_name,
    pane_id: agent.pane_id,
    cli: agent.cli,
    model: agent.model,
    state: agent.state,
    activity: agent.state === "running" ? agent.activity : "",
    tool: agent.tool,
    tool_arg: agent.tool_arg,
    detail: agent.detail,
    ask: agent.state === "needs_user" ? agent.ask : "",
    last_activity_ms: nowMs,
    last_entry_id: agent.last_entry_id,
    recent: agent.recent.map((step) => ({ ...step })),
    project: agent.project,
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}
