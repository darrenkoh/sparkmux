import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { tabPromptGraph, type PromptGraphResponse, type PromptSummary } from "../api";
import { formatDuration, formatMs, formatNum } from "./analyticsFormat";
import {
  buildPromptGraph,
  isAwaitingNode,
  KIND_COLOR,
  layout,
  nodeSize,
  pickOrientation,
  type GraphNode,
  type Orientation,
} from "./promptGraphModel";

export interface PromptGraphProps {
  sessionName: string;
  tabId: string;
  /** True when the window classifier says the agent is waiting on the user. */
  liveNeedsUser?: boolean;
  /** Bumped by the HUD when the latest analytics event timestamp changes. */
  refreshKey: number;
  headerActions?: React.ReactNode;
  /** Skip the SVG and the wait clock. Fetch state stays mounted. */
  collapsed?: boolean;
}

const CULL_AT = 300;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function clusterKeyOf(id: string): string {
  return id.replace(/\.\d+$/, "");
}

function isPieceId(id: string): boolean {
  return /\.\d+$/.test(id);
}

function fitText(text: string, px: number, fontPx: number): string {
  const max = Math.max(1, Math.floor(Math.max(4, px) / (fontPx * 0.62)));
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1))}…`;
}

function domId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}_`);
}

function summaryLine(prompt: PromptSummary): string {
  return `${formatDuration(prompt.duration_ms)} · ${prompt.tool_count} tools · ${prompt.ask_count} ask · ${prompt.err_count} err · ${formatNum(prompt.tokens_out)} out`;
}

function nodeColor(node: GraphNode): string {
  if (isAwaitingNode(node)) return KIND_COLOR.ask;
  return KIND_COLOR[node.kind];
}

function chamferPath(w: number, h: number, cut: number): string {
  const c = Math.min(cut, w / 3, h / 3);
  return `M ${c} 0 H ${w - c} L ${w} ${c} V ${h - c} L ${w - c} ${h} H ${c} L 0 ${h - c} V ${c} Z`;
}

function hexPath(w: number, h: number): string {
  const inset = Math.min(w * 0.16, 18);
  return `M ${inset} 0 H ${w - inset} L ${w} ${h / 2} L ${w - inset} ${h} H ${inset} L 0 ${h / 2} Z`;
}

function octPath(w: number, h: number): string {
  const c = Math.min(w, h) * 0.22;
  return `M ${c} 0 H ${w - c} L ${w} ${c} V ${h - c} L ${w - c} ${h} H ${c} L 0 ${h - c} V ${c} Z`;
}

function bracketPath(w: number, h: number): string {
  const s = 6;
  return `M 1 ${s} V 1 H ${s} M ${w - s} 1 H ${w - 1} V ${s} M ${w - 1} ${h - s} V ${h - 1} H ${w - s} M ${s} ${h - 1} H 1 V ${h - s}`;
}

function glyphFor(node: GraphNode): string {
  if (isAwaitingNode(node)) return "?";
  if (node.kind === "user") return "◆";
  if (node.kind === "think") return "⬡";
  if (node.kind === "tool") return "▣";
  if (node.kind === "ask") return "✦";
  if (node.kind === "reply") return "◉";
  if (node.kind === "complete") return "✔";
  if (node.kind === "interrupted") return "✕";
  return "…";
}

interface Anchors {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function edgeAnchors(
  from: GraphNode,
  to: GraphNode,
  kind: "flow" | "fork" | "join",
  orientation: Orientation,
): Anchors {
  const fs = nodeSize(from, orientation);
  const ts = nodeSize(to, orientation);
  if (kind === "flow") {
    if (orientation === "vertical") {
      return {
        x1: from.x + fs.w / 2,
        y1: from.y + fs.h,
        x2: to.x + ts.w / 2,
        y2: to.y,
      };
    }
    return {
      x1: from.x + fs.w,
      y1: from.y + fs.h / 2,
      x2: to.x,
      y2: to.y + ts.h / 2,
    };
  }
  if (orientation === "vertical") {
    const forward = to.x >= from.x;
    return {
      x1: from.x + (forward ? fs.w : 0),
      y1: from.y + fs.h / 2,
      x2: to.x + (forward ? 0 : ts.w),
      y2: to.y + ts.h / 2,
    };
  }
  const down = to.y >= from.y;
  return {
    x1: from.x + fs.w / 2,
    y1: from.y + (down ? fs.h : 0),
    x2: to.x + ts.w / 2,
    y2: to.y + (down ? 0 : ts.h),
  };
}

function edgePath(anchors: Anchors, kind: "flow" | "fork" | "join", orientation: Orientation): string {
  const { x1, y1, x2, y2 } = anchors;
  if (kind === "flow") {
    if (orientation === "vertical") {
      const dy = Math.max(12, (y2 - y1) / 2);
      return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
    }
    const dx = Math.max(12, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }
  if (orientation === "vertical") {
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  }
  const my = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
}

export default function PromptGraph({
  sessionName,
  tabId,
  liveNeedsUser = false,
  refreshKey,
  headerActions,
  collapsed = false,
}: PromptGraphProps) {
  const [turnIndex, setTurnIndex] = useState<number | null>(null);
  const [resp, setResp] = useState<PromptGraphResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<Orientation>("vertical");
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollPos, setScrollPos] = useState(0);
  const [viewSpan, setViewSpan] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [hidden, setHidden] = useState(() => document.hidden);
  const [bound, setBound] = useState({ sessionName, tabId });
  const [seenPrompt, setSeenPrompt] = useState<number | null>(null);

  const fetchGen = useRef(0);
  const refreshSeen = useRef(refreshKey);
  const stickRef = useRef(true);
  const canvasRef = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/:/g, "");

  if (bound.sessionName !== sessionName || bound.tabId !== tabId) {
    fetchGen.current += 1;
    setBound({ sessionName, tabId });
    setTurnIndex(null);
    setResp(null);
    setExpanded(new Set());
    setSelectedNodeId(null);
    setSeenPrompt(null);
  }

  const selectedMark = resp?.selected ?? null;
  if (selectedMark !== seenPrompt) {
    setSeenPrompt(selectedMark);
    setExpanded(new Set());
    setSelectedNodeId(null);
  }

  const shownIndex = turnIndex ?? resp?.selected ?? null;
  const summary =
    shownIndex == null ? undefined : resp?.prompts.find((prompt) => prompt.index === shownIndex);
  const paused = collapsed || hidden;

  const model = useMemo(() => {
    if (!resp || resp.selected == null) return null;
    if (turnIndex !== null && resp.selected !== turnIndex) return null;
    const status = resp.prompts.find((prompt) => prompt.index === resp.selected)?.status;
    if (!status) return null;
    const built = buildPromptGraph(resp.events, status, {
      liveNeedsUser,
      expanded,
      now,
    });
    return layout(built, viewport, orientation);
  }, [resp, turnIndex, liveNeedsUser, expanded, now, viewport, orientation]);

  const load = useCallback(
    (index: number | null) => {
      const gen = ++fetchGen.current;
      tabPromptGraph(sessionName, tabId, index)
        .then((next) => {
          if (gen !== fetchGen.current) return;
          setResp(next);
        })
        .catch((err) => console.error("tabPromptGraph error:", err));
    },
    [sessionName, tabId],
  );

  useEffect(() => {
    load(turnIndex);
  }, [load, turnIndex]);

  useEffect(() => {
    if (refreshSeen.current === refreshKey) return;
    refreshSeen.current = refreshKey;
    if (turnIndex !== null && summary?.status !== "in_progress") return;
    load(turnIndex);
  }, [refreshKey, turnIndex, summary?.status, load]);

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    if (paused || summary?.status !== "in_progress") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [paused, summary?.status, summary?.index]);

  useEffect(() => {
    stickRef.current = true;
  }, [summary?.index, sessionName, tabId]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || collapsed) return;
    const measure = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (width < 1 || height < 1) return;
      setViewport((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      setOrientation((prev) => pickOrientation(width, height, prev));
      setViewSpan(width > height ? width : height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [collapsed]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || collapsed || !stickRef.current) return;
    if (!(turnIndex === null || summary?.status === "in_progress")) return;
    if (orientation === "horizontal") el.scrollLeft = el.scrollWidth;
    else el.scrollTop = el.scrollHeight;
  }, [model, orientation, turnIndex, summary?.status, collapsed]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || collapsed || orientation !== "horizontal") return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      el.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [collapsed, orientation]);

  useEffect(() => {
    if (!selectedNodeId || !model) return;
    if (model.nodes.some((node) => node.id === selectedNodeId)) return;
    setSelectedNodeId(null);
  }, [model, selectedNodeId]);

  const stepPrompt = (delta: number) => {
    if (!resp || resp.prompts.length === 0) return;
    const max = resp.prompts.length - 1;
    const current = turnIndex ?? resp.selected ?? max;
    const next = Math.max(0, Math.min(max, current + delta));
    setTurnIndex(next);
  };

  const toggleCluster = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (isPieceId(id)) next.delete(clusterKeyOf(id));
      else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onGraphKey = (event: React.KeyboardEvent) => {
    if (isTypingTarget(event.target)) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "[" && event.key !== "]") {
      return;
    }
    event.preventDefault();
    stepPrompt(event.key === "ArrowLeft" || event.key === "[" ? -1 : 1);
  };

  if (collapsed) {
    return <section className="prompt-graph-panel pg-collapsed" hidden />;
  }

  const total = resp?.prompts.length ?? 0;
  const statusLabel =
    turnIndex === null
      ? "LIVE"
      : shownIndex == null || total === 0
        ? ""
        : `PROMPT ${shownIndex + 1} / ${total}`;
  const bars = (resp?.prompts ?? []).slice(-60);
  const maxDur = Math.max(1, ...bars.map((prompt) => prompt.duration_ms));
  const selectedNode = model?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const horizontal = orientation === "horizontal";

  const selector = (
    <div className="pg-selector">
      <button type="button" className="stream-filter-btn pg-viz-btn" onClick={() => stepPrompt(-1)} aria-label="Previous prompt">
        ◀
      </button>
      <span>{total === 0 || shownIndex == null ? "PROMPT —" : `PROMPT ${shownIndex + 1} / ${total}`}</span>
      <button type="button" className="stream-filter-btn pg-viz-btn" onClick={() => stepPrompt(1)} aria-label="Next prompt">
        ▶
      </button>
      <button
        type="button"
        className={`stream-filter-btn pg-viz-btn ${turnIndex === null ? "active" : ""}`}
        onClick={() => setTurnIndex(null)}
      >
        ● LIVE
      </button>
    </div>
  );

  const scrubber = (
    <div className="pg-scrubber" role="listbox" aria-label="Prompts">
      {bars.map((prompt) => (
        <button
          key={prompt.index}
          type="button"
          role="option"
          aria-selected={prompt.index === shownIndex}
          className={`pg-bar ${prompt.status} ${prompt.index === shownIndex ? "current" : ""}`}
          style={{ height: `${Math.max(22, (prompt.duration_ms / maxDur) * 100)}%` }}
          title={prompt.preview || `Prompt ${prompt.index + 1}`}
          aria-label={`Prompt ${prompt.index + 1}`}
          onClick={() => setTurnIndex(prompt.index)}
        >
          {prompt.ask_count > 0 ? <i className="pg-ask-dot" /> : null}
        </button>
      ))}
    </div>
  );

  const meta = summary ? <span className="pg-summary">{summaryLine(summary)}</span> : null;
  const preview = summary?.preview ? <p className="pg-preview">"{summary.preview}"</p> : null;

  return (
    <section
      className={`scifi-panel prompt-graph-panel ${orientation} ${paused ? "pg-paused" : ""}`}
      tabIndex={0}
      aria-label="Prompt Graph"
      onKeyDown={onGraphKey}
    >
      <header>
        <span className="tag">07</span>
        <span>PROMPT GRAPH</span>
        {horizontal ? (
          <div className="pg-inline">
            {selector}
            {scrubber}
            {meta}
          </div>
        ) : null}
        {statusLabel ? <small>{statusLabel}</small> : null}
        {headerActions ? <div className="pg-header-actions">{headerActions}</div> : null}
      </header>
      {horizontal ? preview : null}
      {!horizontal ? (
        <div className="pg-chrome">
          <div className="pg-chrome-row">
            {selector}
            {scrubber}
          </div>
          {preview}
          {meta}
        </div>
      ) : null}
      {resp?.truncated ? <p className="pg-truncated">SHOWING LAST 3000 EVENTS</p> : null}
      <div className="pg-stage">
        <div
          className="pg-canvas"
          ref={canvasRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            const gap =
              orientation === "horizontal"
                ? el.scrollWidth - el.clientWidth - el.scrollLeft
                : el.scrollHeight - el.clientHeight - el.scrollTop;
            stickRef.current = gap < 48;
            if ((model?.nodes.length ?? 0) > CULL_AT) {
              setScrollPos(orientation === "horizontal" ? el.scrollLeft : el.scrollTop);
              setViewSpan(orientation === "horizontal" ? el.clientWidth : el.clientHeight);
            }
          }}
        >
          {resp && resp.prompts.length === 0 ? <div className="empty-log">NO PROMPTS CAPTURED</div> : null}
          {model && model.nodes.length > 0 ? (
            <GraphSvg
              modelNodes={model.nodes}
              modelEdges={model.edges}
              width={model.width}
              height={model.height}
              orientation={orientation}
              uid={uid}
              scrollPos={scrollPos}
              viewSpan={viewSpan}
              selectedNodeId={selectedNodeId}
              onSelect={(id) => setSelectedNodeId((current) => (current === id ? null : id))}
              onToggle={toggleCluster}
            />
          ) : null}
        </div>
        {selectedNode ? (
          <NodeDrawer node={selectedNode} onExpand={() => toggleCluster(selectedNode.id)} onClose={() => setSelectedNodeId(null)} />
        ) : null}
      </div>
    </section>
  );
}

function GraphSvg({
  modelNodes,
  modelEdges,
  width,
  height,
  orientation,
  uid,
  scrollPos,
  viewSpan,
  selectedNodeId,
  onSelect,
  onToggle,
}: {
  modelNodes: GraphNode[];
  modelEdges: GraphModelEdges;
  width: number;
  height: number;
  orientation: Orientation;
  uid: string;
  scrollPos: number;
  viewSpan: number;
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const byId = new Map(modelNodes.map((node) => [node.id, node]));
  const cull = modelNodes.length > CULL_AT && viewSpan > 0;
  const visible = (node: GraphNode) => {
    if (!cull) return true;
    const size = nodeSize(node, orientation);
    const pad = 80;
    if (orientation === "vertical") {
      return node.y + size.h >= scrollPos - pad && node.y <= scrollPos + viewSpan + pad;
    }
    return node.x + size.w >= scrollPos - pad && node.x <= scrollPos + viewSpan + pad;
  };
  const headIds = new Set<string>();
  const seenLanes = new Set<string>();
  for (const node of modelNodes) {
    if (node.lane === "main" || seenLanes.has(node.lane)) continue;
    seenLanes.add(node.lane);
    headIds.add(node.id);
  }

  const cssVars = {
    ["--pg-dx" as string]: orientation === "horizontal" ? "-8px" : "0px",
    ["--pg-dy" as string]: orientation === "vertical" ? "-8px" : "0px",
  } as React.CSSProperties;

  return (
    <svg className="pg-svg" width={width} height={height} style={cssVars}>
      <defs>
        <filter id={`${uid}-glow`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <pattern id={`${uid}-scan`} width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="4" height="2" fill="rgba(255,255,255,0.06)" />
        </pattern>
        <pattern id={`${uid}-grid`} width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 H 0 V 24" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
        </pattern>
        {modelEdges.map((edge) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (!from || !to) return null;
          const anchors = edgeAnchors(from, to, edge.kind, orientation);
          return (
            <linearGradient
              key={edge.id}
              id={`${uid}-e-${domId(edge.id)}`}
              gradientUnits="userSpaceOnUse"
              x1={anchors.x1}
              y1={anchors.y1}
              x2={anchors.x2}
              y2={anchors.y2}
            >
              <stop offset="0" stopColor={nodeColor(from)} />
              <stop offset="1" stopColor={nodeColor(to)} />
            </linearGradient>
          );
        })}
      </defs>
      <rect width={width} height={height} fill={`url(#${uid}-grid)`} />
      <g className="pg-edges" pointerEvents="none">
        {modelEdges.map((edge) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (!from || !to) return null;
          if (!visible(from) && !visible(to)) return null;
          const anchors = edgeAnchors(from, to, edge.kind, orientation);
          const d = edgePath(anchors, edge.kind, orientation);
          const fast = to.live || to.kind === "pending";
          const grad = `url(#${uid}-e-${domId(edge.id)})`;
          return (
            <g key={edge.id}>
              <path d={d} fill="none" stroke={grad} strokeWidth={1.5} opacity={0.35} />
              <path
                d={d}
                className={`pg-energy ${fast ? "pg-energy-fast" : ""}`}
                fill="none"
                stroke={grad}
                strokeWidth={1.5}
                filter={`url(#${uid}-glow)`}
              />
              {edge.durationMs >= 1000 ? (
                <text className="pg-edge-label" x={(anchors.x1 + anchors.x2) / 2} y={(anchors.y1 + anchors.y2) / 2}>
                  +{formatMs(edge.durationMs)}
                </text>
              ) : null}
            </g>
          );
        })}
      </g>
      {modelNodes.map((node) => {
        if (!visible(node)) return null;
        const size = nodeSize(node, orientation);
        const showLane = headIds.has(node.id);
        return (
          <g key={node.id}>
            {showLane ? (
              <text className="pg-lane-label" x={node.x} y={Math.max(10, node.y - 6)}>
                {node.laneLabel || node.lane.slice(-12)}
              </text>
            ) : null}
            <GraphNodeView
              node={node}
              width={size.w}
              height={size.h}
              uid={uid}
              selected={node.id === selectedNodeId}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          </g>
        );
      })}
    </svg>
  );
}

type GraphModelEdges = {
  id: string;
  from: string;
  to: string;
  kind: "flow" | "fork" | "join";
  durationMs: number;
}[];

function GraphNodeView({
  node,
  width,
  height,
  uid,
  selected,
  onSelect,
  onToggle,
}: {
  node: GraphNode;
  width: number;
  height: number;
  uid: string;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const color = nodeColor(node);
  const awaiting = isAwaitingNode(node);
  const textX = node.kind === "complete" || node.kind === "interrupted" ? 40 : 22;
  const title = fitText(node.title, width - textX - 36, 11);
  const subtitle = node.subtitle ? fitText(node.subtitle, width - textX - 8, 10) : "";
  const showDur = node.durationMs > 0 || node.kind === "complete" || node.kind === "interrupted";
  const clustered = node.steps.length >= 2;
  const piece = isPieceId(node.id);
  const tooltip = [
    new Date(node.t0).toLocaleString(),
    formatDuration(node.durationMs),
    node.steps.map((step) => step.ev.b || step.ev.a || "").filter(Boolean).join("\n") || node.subtitle,
  ]
    .filter(Boolean)
    .join("\n");
  const aria = [node.title, node.subtitle].filter(Boolean).join(", ");

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(node.id);
  };

  return (
    <g
      className={`pg-node ${selected ? "is-selected" : ""} ${node.live ? "is-live" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={aria}
      aria-pressed={selected}
      style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
      onClick={() => onSelect(node.id)}
      onKeyDown={onKey}
    >
      <title>{tooltip}</title>
      <g className="pg-node-enter" style={{ color }}>
        {clustered ? (
          <g className="pg-ghosts" filter={`url(#${uid}-glow)`}>
            <rect className="pg-ghost" x={6} y={6} width={width} height={height} stroke={color} />
            <rect className="pg-ghost" x={3} y={3} width={width} height={height} stroke={color} />
          </g>
        ) : null}
        <g filter={`url(#${uid}-glow)`}>
          <NodeShape kind={node.kind} w={width} h={height} color={color} awaiting={awaiting} uid={uid} />
        </g>
        {(node.live || awaiting) && (
          <rect
            className={`pg-pulse ${awaiting ? "pg-pulse-strong" : ""}`}
            x={1}
            y={1}
            width={width - 2}
            height={height - 2}
            rx={node.kind === "reply" || node.kind === "pending" ? (height - 2) / 2 : 8}
            stroke={color}
          />
        )}
        {awaiting ? (
          <rect
            className="pg-pulse pg-pulse-strong pg-pulse-late"
            x={1}
            y={1}
            width={width - 2}
            height={height - 2}
            rx={(height - 2) / 2}
            stroke={color}
          />
        ) : null}
        <text className="pg-glyph" x={node.kind === "complete" || node.kind === "interrupted" ? 22 : 8} y={height / 2 + 4} fill={color}>
          {glyphFor(node)}
        </text>
        <text className="pg-title" x={textX} y={height > 48 ? 20 : 16}>
          {title}
        </text>
        {subtitle ? (
          <text className="pg-sub" x={textX} y={height > 48 ? 36 : 31}>
            {subtitle}
          </text>
        ) : null}
        {showDur ? (
          <text className="pg-dur" x={width - 8} y={14} textAnchor="end">
            {formatDuration(node.durationMs)}
          </text>
        ) : null}
        {node.errCount > 0 ? (
          <g className="pg-err" transform={`translate(${width - 2} 2)`}>
            <circle r="7" fill="#1a0b0d" stroke="#f87171" />
            <text textAnchor="middle" y="3">
              ✕{node.errCount}
            </text>
          </g>
        ) : null}
        {clustered || piece ? (
          <g
            className="pg-toggle"
            role="button"
            tabIndex={0}
            aria-label={piece ? "Collapse cluster" : "Expand cluster"}
            transform={`translate(${width - 8} ${height - 4})`}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(node.id);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              onToggle(node.id);
            }}
          >
            <text textAnchor="end">{piece ? "⊖" : "⊕"}</text>
          </g>
        ) : null}
      </g>
    </g>
  );
}

function NodeShape({
  kind,
  w,
  h,
  color,
  awaiting,
  uid,
}: {
  kind: GraphNode["kind"];
  w: number;
  h: number;
  color: string;
  awaiting: boolean;
  uid: string;
}) {
  const scan = `url(#${uid}-scan)`;
  if (kind === "complete" || kind === "interrupted") {
    const r = Math.min(15, h / 2 - 3);
    return (
      <g className="pg-shape" stroke={color} strokeDasharray={kind === "interrupted" ? "3 3" : undefined}>
        <circle cx={r + 6} cy={h / 2} r={r} fill="rgba(8,12,20,0.85)" />
        <circle cx={r + 6} cy={h / 2} r={r} fill={scan} stroke="none" />
      </g>
    );
  }
  if (kind === "reply" || kind === "pending") {
    return (
      <g className="pg-shape" stroke={color} strokeDasharray={kind === "pending" && !awaiting ? "3 3" : undefined}>
        <rect x={1} y={1} width={w - 2} height={h - 2} rx={(h - 2) / 2} fill="rgba(8,12,20,0.85)" />
        <rect x={1} y={1} width={w - 2} height={h - 2} rx={(h - 2) / 2} fill={scan} stroke="none" />
      </g>
    );
  }
  if (kind === "tool") {
    return (
      <g className="pg-shape" stroke={color}>
        <rect x={1} y={1} width={w - 2} height={h - 2} fill="rgba(8,12,20,0.85)" />
        <rect x={1} y={1} width={w - 2} height={h - 2} fill={scan} stroke="none" />
        <path className="pg-brackets" d={bracketPath(w, h)} fill="none" />
      </g>
    );
  }
  const d = kind === "think" ? hexPath(w, h) : kind === "ask" ? octPath(w, h) : chamferPath(w, h, 8);
  return (
    <g className="pg-shape" stroke={color}>
      <path d={d} fill="rgba(8,12,20,0.85)" />
      <path d={d} fill={scan} stroke="none" />
      {kind === "ask" ? (
        <path d={octPath(w - 6, h - 6)} transform="translate(3 3)" fill="none" />
      ) : null}
    </g>
  );
}

function NodeDrawer({
  node,
  onExpand,
  onClose,
}: {
  node: GraphNode;
  onExpand: () => void;
  onClose: () => void;
}) {
  const bodies = node.steps.map((step) => step.ev.b || step.ev.a || "").filter(Boolean);
  return (
    <aside className="pg-drawer">
      <div className="pg-drawer-head">
        <strong style={{ color: nodeColor(node) }}>{node.title}</strong>
        <button type="button" className="stream-filter-btn pg-viz-btn" onClick={onClose} aria-label="Close detail">
          ✕
        </button>
      </div>
      <dl>
        <div>
          <dt>TIME</dt>
          <dd>{new Date(node.t0).toLocaleString()}</dd>
        </div>
        <div>
          <dt>DURATION</dt>
          <dd>{formatDuration(node.durationMs)}</dd>
        </div>
        <div>
          <dt>TOKENS</dt>
          <dd>{formatNum(node.tokensOut)} out</dd>
        </div>
        {node.errCount > 0 ? (
          <div>
            <dt>ERRORS</dt>
            <dd>{node.errCount}</dd>
          </div>
        ) : null}
      </dl>
      {bodies.length > 0 ? <pre className="pg-drawer-body">{bodies.join("\n\n")}</pre> : null}
      {node.steps.length > 1 ? (
        <ul className="pg-steps">
          {node.steps.map((step, index) => {
            const erred = Boolean(step.ev.err || step.done?.err || step.result?.err);
            const ms = step.done?.ms ?? step.ev.ms ?? 0;
            return (
              <li key={`${step.ev.t}-${step.ev.n ?? ""}-${index}`}>
                <button type="button" onClick={onExpand}>
                  <strong>{step.ev.n || node.kind}</strong>
                  {step.ev.a ? <span>{step.ev.a}</span> : null}
                  {ms > 0 ? <span>{formatDuration(ms)}</span> : null}
                  {erred ? <span className="pg-step-err">ERR</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </aside>
  );
}
