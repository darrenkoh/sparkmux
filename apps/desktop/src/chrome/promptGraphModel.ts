// Pure prompt-graph model. No React and no DOM, so node:test can import it.
// Layout is one flow-axis / cross-axis pass. Orientation only maps those axes
// onto x and y.

import type { AnalyticsEvent, PromptStatus } from "../api";

export type NodeKind =
  | "user"
  | "think"
  | "reply"
  | "tool"
  | "ask"
  | "complete"
  | "interrupted"
  | "pending";

export type Orientation = "vertical" | "horizontal";

export interface GraphStep {
  ev: AnalyticsEvent;
  done?: AnalyticsEvent;
  result?: AnalyticsEvent;
}

export interface GraphNode {
  /** Stable: `${lane}:${firstEventT}:${kind}:${ordinal}`. */
  id: string;
  kind: NodeKind;
  /** `"main"` or a subagent id (`ev.g`). */
  lane: string;
  laneLabel?: string;
  /** More than one step means a cluster. */
  steps: GraphStep[];
  t0: number;
  t1: number;
  /** Sum of `done.ms` for tools, wait time for an ask, otherwise `t1 - t0`. */
  durationMs: number;
  errCount: number;
  /** Output tokens from usage events that fall inside `[t0, t1]`. */
  tokensOut: number;
  title: string;
  subtitle: string;
  /** Last content node of an in-progress prompt, and its pending ghost. */
  live: boolean;
  x: number;
  y: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "flow" | "fork" | "join";
  durationMs: number;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  totals: {
    durationMs: number;
    tools: number;
    asks: number;
    errors: number;
    askWaitMs: number;
  };
}

export interface GraphBuildOptions {
  liveNeedsUser?: boolean;
  expanded?: Set<string>;
  /** Clock for an unanswered ask. Tests pass a fixed value. */
  now?: number;
}

export const KIND_COLOR: Record<NodeKind, string> = {
  user: "#ff9a3c",
  think: "#c084fc",
  reply: "#5b8def",
  tool: "#2dd4bf",
  ask: "#f472b6",
  complete: "#cbd5e1",
  interrupted: "#f87171",
  pending: "#94a3b8",
};

const PAD = 16;

/**
 * Horizontal only when the pane is clearly wider than it is tall.
 * Near a square, `prev` keeps the current orientation until the 1.1 ratio flips.
 */
export function pickOrientation(width: number, height: number, prev?: Orientation): Orientation {
  if (prev === "horizontal") {
    return height > width * 1.1 ? "vertical" : "horizontal";
  }
  if (prev === "vertical") {
    return width > height * 1.1 ? "horizontal" : "vertical";
  }
  return width > height ? "horizontal" : "vertical";
}

export function nodeSize(node: Pick<GraphNode, "lane">, orientation: Orientation): { w: number; h: number } {
  const sub = node.lane !== "main";
  if (orientation === "horizontal") {
    return { w: sub ? 104 : 132, h: 52 };
  }
  return { w: sub ? 120 : 168, h: 44 };
}

export function isAwaitingNode(node: GraphNode): boolean {
  return node.kind === "pending" && node.title.startsWith("AWAITING");
}

export function buildPromptGraph(
  events: AnalyticsEvent[],
  status: PromptStatus,
  opts?: GraphBuildOptions,
): GraphModel {
  const now = opts?.now ?? Date.now();
  const expanded = opts?.expanded;
  const empty: GraphModel = {
    nodes: [],
    edges: [],
    width: 0,
    height: 0,
    totals: { durationMs: 0, tools: 0, asks: 0, errors: 0, askWaitMs: 0 },
  };
  if (events.length === 0) return empty;

  const { atoms, usages, turns } = walkEvents(events);
  const lanes = laneOrderFromAtoms(atoms);
  const nodes: GraphNode[] = [];
  for (const lane of lanes) {
    nodes.push(...clusterLane(lane, atoms.filter((atom) => atom.lane === lane), expanded, now));
  }
  assignUsage(nodes, usages);

  const mainTurns = turns.filter((ev) => !(ev.g ?? "").trim());
  const tStart = events[0]?.t ?? 0;
  const tEnd = events[events.length - 1]?.t ?? tStart;
  const durationMs = mainTurns.length
    ? (mainTurns[mainTurns.length - 1]?.ms ?? 0)
    : Math.max(0, tEnd - tStart);

  if (nodes.length > 0) {
    const lastT = nodes.reduce((max, node) => Math.max(max, node.t1), 0);
    if (status === "in_progress") {
      const ordered = [...nodes].sort((a, b) => a.t1 - b.t1 || a.t0 - b.t0);
      const latest = ordered[ordered.length - 1];
      if (latest) {
        latest.live = true;
        const unanswered = latest.kind === "ask" && !latest.steps.some((step) => step.done);
        const awaiting = Boolean(opts?.liveNeedsUser) || unanswered;
        const anchor = unanswered ? latest.t0 : latest.t1;
        const waited = Math.max(0, now - anchor);
        nodes.push({
          id: `${latest.lane}:pending:${lastT}`,
          kind: "pending",
          lane: latest.lane,
          laneLabel: latest.laneLabel,
          steps: [],
          t0: lastT + 1,
          t1: lastT + 1,
          durationMs: awaiting ? waited : 0,
          errCount: 0,
          tokensOut: 0,
          title: awaiting ? "AWAITING USER INPUT" : "…",
          subtitle: awaiting ? formatSpan(waited) : "",
          live: true,
          x: 0,
          y: 0,
        });
      }
    } else {
      const kind: NodeKind = status === "interrupted" ? "interrupted" : "complete";
      nodes.push({
        id: `main:${kind}:${lastT}`,
        kind,
        lane: "main",
        steps: [],
        t0: lastT + 1,
        t1: lastT + 1,
        durationMs,
        errCount: 0,
        tokensOut: 0,
        title: kind === "complete" ? "COMPLETE" : "INTERRUPTED",
        subtitle: formatSpan(durationMs),
        live: false,
        x: 0,
        y: 0,
      });
    }
  }

  const edges = linkEdges(nodes);
  const askWaitMs = nodes.filter((node) => node.kind === "ask").reduce((sum, node) => sum + node.durationMs, 0);
  nodes.sort((a, b) => a.t0 - b.t0 || laneRank(a.lane, lanes) - laneRank(b.lane, lanes) || a.id.localeCompare(b.id));

  return {
    nodes,
    edges,
    width: 0,
    height: 0,
    totals: {
      durationMs,
      tools: events.filter((ev) => ev.k === "tool").length,
      asks: events.filter((ev) => ev.k === "ask").length,
      errors: nodes.reduce((sum, node) => sum + node.errCount, 0),
      askWaitMs,
    },
  };
}

export function layout(
  model: GraphModel,
  viewport: { width: number; height: number },
  orientation: Orientation,
): GraphModel {
  const nodes = model.nodes.map((node) => ({ ...node, steps: node.steps.slice() }));
  const lanes = laneOrderFromNodes(nodes);
  const vertical = orientation === "vertical";
  const gapFlow = vertical ? 22 : 36;
  const extent = Math.max(1, vertical ? viewport.width : viewport.height);
  const crossSizes = lanes.map((lane) => {
    const sample = nodes.find((node) => node.lane === lane);
    const size = nodeSize(sample ?? { lane }, orientation);
    return vertical ? size.w : size.h;
  });
  const gap = pickGap(extent, crossSizes, orientation);
  const centers = laneCenters(lanes.length, extent, gap);

  const order = [...nodes].sort((a, b) => {
    if (a.t0 !== b.t0) return a.t0 - b.t0;
    const laneDelta = laneRank(a.lane, lanes) - laneRank(b.lane, lanes);
    if (laneDelta !== 0) return laneDelta;
    return a.id.localeCompare(b.id);
  });

  const laneFloor = new Map<string, number>();
  const flowOf = new Map<string, number>();
  let frontier = PAD;
  let bandStart = PAD;
  let lastT: number | null = null;
  for (const node of order) {
    const size = nodeSize(node, orientation);
    const flowSize = vertical ? size.h : size.w;
    const floor = laneFloor.get(node.lane) ?? PAD;
    let flow: number;
    if (lastT !== null && node.t0 === lastT) {
      flow = Math.max(bandStart, floor);
    } else {
      flow = Math.max(frontier, floor);
      bandStart = flow;
    }
    flowOf.set(node.id, flow);
    const next = flow + flowSize + gapFlow;
    laneFloor.set(node.lane, next);
    frontier = Math.max(frontier, next);
    lastT = node.t0;
  }

  for (const node of nodes) {
    const size = nodeSize(node, orientation);
    const flow = flowOf.get(node.id) ?? PAD;
    const center = centers[Math.max(0, lanes.indexOf(node.lane))] ?? extent / 2;
    if (vertical) {
      node.x = center - size.w / 2;
      node.y = flow;
    } else {
      node.x = flow;
      node.y = center - size.h / 2;
    }
  }

  shiftIntoView(nodes);
  let maxX = 0;
  let maxY = 0;
  for (const node of nodes) {
    const size = nodeSize(node, orientation);
    maxX = Math.max(maxX, node.x + size.w);
    maxY = Math.max(maxY, node.y + size.h);
  }

  return {
    nodes,
    edges: model.edges.map((edge) => ({ ...edge })),
    width: Math.max(viewport.width, maxX + PAD),
    height: Math.max(viewport.height, maxY + PAD),
    totals: model.totals,
  };
}

interface Atom {
  kind: "user" | "think" | "reply" | "tool" | "ask";
  lane: string;
  laneLabel: string;
  ev: AnalyticsEvent;
  done?: AnalyticsEvent;
  result?: AnalyticsEvent;
  t: number;
}

function walkEvents(events: AnalyticsEvent[]): {
  atoms: Atom[];
  usages: AnalyticsEvent[];
  turns: AnalyticsEvent[];
} {
  const atoms: Atom[] = [];
  const usages: AnalyticsEvent[] = [];
  const turns: AnalyticsEvent[] = [];
  const open: Atom[] = [];

  const pair = (ev: AnalyticsEvent) => {
    const field: "done" | "result" = ev.k === "done" ? "done" : "result";
    const lane = laneOf(ev);
    const name = (ev.n ?? "").trim();
    // A result with no tool name (Claude, Grok) attaches to the oldest open
    // call in that lane. A done row matches the tool name, FIFO.
    const idx = open.findIndex((atom) => {
      if (atom.lane !== lane || atom[field]) return false;
      if (!name) return true;
      return (atom.ev.n ?? "").trim() === name;
    });
    if (idx < 0) return;
    const atom = open[idx];
    if (!atom) return;
    atom[field] = ev;
    if (atom.done) open.splice(idx, 1);
  };

  for (const ev of events) {
    if (ev.k === "usage") {
      usages.push(ev);
      continue;
    }
    if (ev.k === "turn") {
      turns.push(ev);
      continue;
    }
    if (ev.k === "think" && !(ev.b ?? "").trim()) continue;
    if (ev.k === "result" || ev.k === "done") {
      pair(ev);
      continue;
    }
    if (ev.k !== "user" && ev.k !== "think" && ev.k !== "reply" && ev.k !== "tool" && ev.k !== "ask") {
      continue;
    }
    if (ev.k === "ask" && absorbAsk(atoms, ev)) continue;

    const atom: Atom = {
      kind: ev.k,
      lane: laneOf(ev),
      laneLabel: (ev.h ?? "").trim(),
      ev,
      t: ev.t,
    };
    atoms.push(atom);
    if (atom.kind === "tool" || atom.kind === "ask") open.push(atom);
  }

  return { atoms, usages, turns };
}

function absorbAsk(atoms: Atom[], ev: AnalyticsEvent): boolean {
  const lane = laneOf(ev);
  const name = (ev.n ?? "").trim();
  for (let i = atoms.length - 1; i >= 0; i--) {
    const atom = atoms[i];
    if (!atom || atom.lane !== lane || atom.kind !== "tool") continue;
    if (atom.t !== ev.t || (atom.ev.n ?? "").trim() !== name) continue;
    atom.kind = "ask";
    atom.ev = ev;
    const label = (ev.h ?? "").trim();
    if (label) atom.laneLabel = label;
    return true;
  }
  return false;
}

function clusterLane(lane: string, list: Atom[], expanded: Set<string> | undefined, now: number): GraphNode[] {
  const nodes: GraphNode[] = [];
  let index = 0;
  while (index < list.length) {
    const kind = list[index]?.kind;
    if (!kind) break;
    let end = index + 1;
    if (kind !== "ask") {
      while (end < list.length && list[end]?.kind === kind) end += 1;
    }
    const run = list.slice(index, end);
    const first = run[0];
    if (!first) break;
    const id = `${lane}:${first.t}:${kind}:${index}`;
    if (run.length >= 2 && expanded?.has(id)) {
      run.forEach((atom, step) => {
        nodes.push(makeNode(`${id}.${step}`, kind, lane, [atom], now));
      });
    } else {
      nodes.push(makeNode(id, kind, lane, run, now));
    }
    index = end;
  }
  return nodes;
}

function makeNode(id: string, kind: Atom["kind"], lane: string, run: Atom[], now: number): GraphNode {
  const steps = run.map((atom) => ({ ev: atom.ev, done: atom.done, result: atom.result }));
  const { t0, t1 } = spanOf(steps);
  const laneLabel = run.map((atom) => atom.laneLabel).find((label) => label);
  return {
    id,
    kind,
    lane,
    laneLabel: laneLabel || undefined,
    steps,
    t0,
    t1,
    durationMs: durationOf(kind, steps, t0, t1, now),
    errCount: steps.filter((step) => step.ev.err || step.done?.err || step.result?.err).length,
    tokensOut: 0,
    title: titleOf(kind, steps.length),
    subtitle: subtitleOf(kind, steps),
    live: false,
    x: 0,
    y: 0,
  };
}

function spanOf(steps: GraphStep[]): { t0: number; t1: number } {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const step of steps) {
    const times = [step.ev.t, step.done?.t, step.result?.t];
    for (const time of times) {
      if (typeof time !== "number") continue;
      t0 = Math.min(t0, time);
      t1 = Math.max(t1, time);
    }
  }
  if (!Number.isFinite(t0)) t0 = 0;
  if (!Number.isFinite(t1)) t1 = t0;
  return { t0, t1 };
}

function durationOf(kind: Atom["kind"], steps: GraphStep[], t0: number, t1: number, now: number): number {
  if (kind === "tool") {
    const sum = steps.reduce((total, step) => total + (step.done?.ms ?? 0), 0);
    return sum > 0 ? sum : Math.max(0, t1 - t0);
  }
  if (kind === "ask") {
    const done = steps[0]?.done;
    if (done) return done.ms ?? 0;
    return Math.max(0, now - (steps[0]?.ev.t ?? now));
  }
  return Math.max(0, t1 - t0);
}

function titleOf(kind: Atom["kind"], count: number): string {
  if (kind === "user") return count > 1 ? `USER ×${count}` : "USER PROMPT";
  if (kind === "think") return count > 1 ? `THINK ×${count}` : "THINK";
  if (kind === "reply") return count > 1 ? `REPLY ×${count}` : "REPLY";
  if (kind === "tool") return count > 1 ? `TOOLS ×${count}` : "TOOL";
  return "ASK USER";
}

function subtitleOf(kind: Atom["kind"], steps: GraphStep[]): string {
  if (kind === "tool") {
    if (steps.length === 1) return clip(steps[0]?.ev.a || steps[0]?.ev.b || "");
    const counts = new Map<string, number>();
    for (const step of steps) {
      const name = step.ev.n || "tool";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(" · ");
  }
  if (kind === "ask") {
    const done = steps[0]?.done;
    if (done) return `waited ${formatSpan(done.ms ?? 0)}`;
    return clip(steps[0]?.ev.b || steps[0]?.ev.a || "");
  }
  const text = steps.map((step) => step.ev.b || step.ev.a || "").filter(Boolean).join(" · ");
  return clip(text);
}

function assignUsage(nodes: GraphNode[], usages: AnalyticsEvent[]) {
  for (const usage of usages) {
    const lane = laneOf(usage);
    const matches = nodes.filter(
      (node) => node.lane === lane && node.t0 <= usage.t && usage.t <= node.t1,
    );
    matches.sort((a, b) => b.t0 - a.t0);
    const host = matches[0];
    if (host) host.tokensOut += usage.to ?? 0;
  }
}

function linkEdges(nodes: GraphNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const byLane = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const list = byLane.get(node.lane) ?? [];
    list.push(node);
    byLane.set(node.lane, list);
  }
  for (const list of byLane.values()) {
    list.sort((a, b) => a.t0 - b.t0 || a.id.localeCompare(b.id));
    for (let i = 1; i < list.length; i++) {
      const from = list[i - 1];
      const to = list[i];
      if (!from || !to) continue;
      edges.push(edge("flow", from, to));
    }
  }

  const mains = (byLane.get("main") ?? []).slice().sort((a, b) => a.t0 - b.t0);
  for (const [lane, list] of byLane) {
    if (lane === "main" || list.length === 0) continue;
    const ordered = list.slice().sort((a, b) => a.t0 - b.t0);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    if (!first || !last) continue;
    const source = [...mains].reverse().find((node) => node.t0 <= first.t0 && !isTerminal(node));
    if (source) edges.push(edge("fork", source, first));
    const join = mains.find((node) => node.t0 >= last.t1);
    if (join) edges.push(edge("join", last, join));
  }
  return edges;
}

function edge(kind: GraphEdge["kind"], from: GraphNode, to: GraphNode): GraphEdge {
  return {
    id: `${kind}:${from.id}>${to.id}`,
    from: from.id,
    to: to.id,
    kind,
    durationMs: Math.max(0, to.t0 - from.t1),
  };
}

function isTerminal(node: GraphNode): boolean {
  return node.kind === "complete" || node.kind === "interrupted" || node.kind === "pending";
}

function laneOf(ev: AnalyticsEvent): string {
  const id = (ev.g ?? "").trim();
  return id || "main";
}

function laneOrderFromAtoms(atoms: Atom[]): string[] {
  const seen: string[] = [];
  for (const atom of atoms) {
    if (!seen.includes(atom.lane)) seen.push(atom.lane);
  }
  return [...seen.filter((lane) => lane === "main"), ...seen.filter((lane) => lane !== "main")];
}

function laneOrderFromNodes(nodes: GraphNode[]): string[] {
  const seen: string[] = [];
  const chronological = [...nodes].sort((a, b) => a.t0 - b.t0 || a.id.localeCompare(b.id));
  for (const node of chronological) {
    if (!seen.includes(node.lane)) seen.push(node.lane);
  }
  return [...seen.filter((lane) => lane === "main"), ...seen.filter((lane) => lane !== "main")];
}

function laneRank(lane: string, lanes: string[]): number {
  const index = lanes.indexOf(lane);
  return index < 0 ? lanes.length : index;
}

function laneCenters(count: number, extent: number, gap: number): number[] {
  if (count <= 1) return [extent / 2];
  const main = extent / 3;
  const centers = [main];
  for (let i = 1; i < count; i++) centers.push(main + i * gap);
  return centers;
}

function crossFits(centers: number[], sizes: number[], extent: number): boolean {
  return centers.every((center, index) => {
    const half = (sizes[index] ?? 0) / 2;
    return center - half >= -0.01 && center + half <= extent + 0.01;
  });
}

function pickGap(extent: number, sizes: number[], orientation: Orientation): number {
  const base = orientation === "horizontal" ? 96 : 140;
  const min = orientation === "horizontal" ? 64 : 90;
  if (sizes.length <= 1) return base;
  if (crossFits(laneCenters(sizes.length, extent, base), sizes, extent)) return base;
  for (let gap = base - 1; gap >= min; gap -= 1) {
    if (crossFits(laneCenters(sizes.length, extent, gap), sizes, extent)) return gap;
  }
  return min;
}

function shiftIntoView(nodes: GraphNode[]) {
  let minX = 0;
  let minY = 0;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
  }
  if (minX >= 0 && minY >= 0) return;
  for (const node of nodes) {
    node.x -= minX;
    node.y -= minY;
  }
}

function clip(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remain = minutes % 60;
  return remain ? `${hours}h ${remain}m` : `${hours}h`;
}
