import { extractQuickOptions, quickOptionBytes, type QuickOption } from "../../ios/quickReplyLogic.ts";
import { agentKey } from "../office/officeModel.ts";
import type { OfficeAgent, OfficeSnapshot } from "../office/officeTypes.ts";

/** Same sentence as the office empty state. */
export const EMPTY_COPY = "No agents on this socket. Start `claude`, `grok`, or `agy` in a pane.";

export interface HqCounts {
  working: number;
  waiting: number;
  failed: number;
  idle: number;
}

export interface HqRoom {
  key: string;
  agent: OfficeAgent;
}

export interface HqShell {
  key: string;
  session: string;
  paneId: string;
  windowName: string;
}

export interface HqFloor {
  session: string;
  rooms: HqRoom[];
  shells: HqShell[];
  counts: HqCounts;
}

export interface HqToken {
  ring: "green" | "amber" | "red" | "none";
  motion: "bob" | "still";
  dim: boolean;
  mark: "zzz" | null;
}

/** Failed stays its own count. Succeeded joins idle. Shells are not counted. */
export function hqCounts(agents: readonly { state: string }[]): HqCounts {
  const counts: HqCounts = { working: 0, waiting: 0, failed: 0, idle: 0 };
  for (const agent of agents) {
    if (agent.state === "running") counts.working += 1;
    else if (agent.state === "needs_user") counts.waiting += 1;
    else if (agent.state === "failed") counts.failed += 1;
    else counts.idle += 1;
  }
  return counts;
}

/**
 * One floor per tmux session, one room per agent pane.
 * Session order and room order follow names, so a state change does not reshuffle the building.
 * A free desk is a shell on its session's floor, never a room.
 */
export function layoutFloors(snapshot: OfficeSnapshot): HqFloor[] {
  const bySession = new Map<string, { rooms: OfficeAgent[]; shells: HqShell[] }>();
  const ensure = (session: string) => {
    let row = bySession.get(session);
    if (!row) {
      row = { rooms: [], shells: [] };
      bySession.set(session, row);
    }
    return row;
  };
  for (const agent of snapshot.agents) ensure(agent.session).rooms.push(agent);
  for (const desk of snapshot.free_desks) {
    ensure(desk.session).shells.push({
      key: `${desk.session}:${desk.pane_id}`,
      session: desk.session,
      paneId: desk.pane_id,
      windowName: desk.window_name,
    });
  }
  return [...bySession.keys()].sort(compareText).map((session) => {
    const row = bySession.get(session);
    const rooms = [...(row?.rooms ?? [])].sort(compareRooms).map((agent) => ({
      key: agentKey(agent),
      agent,
    }));
    const shells = [...(row?.shells ?? [])].sort((left, right) => compareText(left.paneId, right.paneId));
    return { session, rooms, shells, counts: hqCounts(rooms.map((room) => room.agent)) };
  });
}

export function visualToken(state: string): HqToken {
  switch (state) {
    case "running":
      return { ring: "green", motion: "bob", dim: false, mark: null };
    case "needs_user":
      return { ring: "amber", motion: "still", dim: false, mark: null };
    case "failed":
      return { ring: "red", motion: "still", dim: false, mark: null };
    case "idle":
    case "succeeded":
      return { ring: "none", motion: "still", dim: true, mark: "zzz" };
    default:
      return { ring: "none", motion: "still", dim: false, mark: null };
  }
}

/** Office callsign when one is stored, otherwise the tmux window name. */
export function roomName(agent: Pick<OfficeAgent, "window_name" | "project">, stored: string | undefined): string {
  const name = stored?.trim();
  if (name) return name;
  const windowName = agent.window_name.trim();
  if (windowName) return windowName;
  const project = agent.project.trim();
  if (project) return project;
  return "Agent";
}

export function roomSubtitle(agent: Pick<OfficeAgent, "cli" | "project">): string {
  const cli = agent.cli.trim();
  const project = agent.project.trim();
  if (cli && project) return `${cli} · ${project}`;
  return cli || project;
}

/** Pills only for a needs-user row, and only for an option parsed from that ask. */
export function replyBytes(agent: { state: string; ask: string }, option: QuickOption): number[] | null {
  if (agent.state !== "needs_user") return null;
  const match = extractQuickOptions(agent.ask).find(
    (item) => item.label === option.label && item.send === option.send && item.enter === option.enter,
  );
  if (!match) return null;
  return quickOptionBytes(match);
}

export function askOptions(agent: { state: string; ask: string }): QuickOption[] {
  if (agent.state !== "needs_user") return [];
  return extractQuickOptions(agent.ask);
}

/**
 * Phase 2 guard. The MVP does not draw a context badge.
 * A missing window (Antigravity leaves this at 0) is not a percent.
 */
export function contextPercent(used: number, windowTokens: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(windowTokens) || windowTokens <= 0 || used < 0) return null;
  return (used / windowTokens) * 100;
}

/**
 * Phase 2 guard. The MVP does not draw usage bars.
 * An account meter is the account's, never one pane's share of the limit.
 */
export function usageCaption(input: { scope: "account" | "session"; cli: string; label: string }): string {
  if (input.scope === "account") return `${input.cli} ${input.label} (account)`;
  return `${input.cli} ${input.label} (this session)`;
}

function compareRooms(left: OfficeAgent, right: OfficeAgent): number {
  const byWindow = compareText(left.window_name, right.window_name);
  if (byWindow !== 0) return byWindow;
  return compareText(left.pane_id, right.pane_id);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
