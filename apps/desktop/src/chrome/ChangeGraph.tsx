import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { changeGraph, type ChangeGraphResponse } from "../api";
import {
  fileBasename,
  layoutConstellation,
  statusColor,
  statusLabel,
  type LayoutNode,
} from "./changeGraphLayout";

export interface ChangeGraphProps {
  command: string;
  cwd: string;
  title: string;
  pid: number;
  onClose: () => void;
}

export default function ChangeGraph({ command, cwd, title, pid, onClose }: ChangeGraphProps) {
  const [data, setData] = useState<ChangeGraphResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 960, height: 560 });
  const [hover, setHover] = useState<LayoutNode | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    let cancel = false;
    let generation = 0;
    const load = () => {
      const token = ++generation;
      changeGraph(command, cwd, title, pid)
        .then((graph) => {
          if (!cancel && token === generation) {
            setData(graph);
            setLoadError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancel && token === generation) {
            setLoadError(err instanceof Error ? err.message : "Could not read the worktree.");
          }
        });
    };
    load();
    const id = window.setInterval(load, 2000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [command, cwd, title, pid]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 40) {
        setSize({ width: rect.width, height: rect.height });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () => layoutConstellation(data?.repos ?? [], data?.edges ?? [], size.width, size.height),
    [data, size.width, size.height],
  );
  const pinned = layout.nodes.find((node) => node.id === pinnedId) ?? null;
  const repoName = (id: string) => layout.clusters.find((cluster) => cluster.id === id)?.name ?? id;
  const linksFor = (node: LayoutNode) =>
    (data?.edges ?? []).filter((edge) => edge.from_repo === node.repoId && edge.via === node.path);

  const fileCount = (data?.repos ?? []).reduce((sum, repo) => sum + repo.files.length, 0);
  const repoCount = data?.repos.length ?? 0;
  const edgeCount = data?.edges.length ?? 0;
  const cwdName = cwd.split(/[/\\]/).filter(Boolean).pop() ?? "pane";

  const hitTest = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * size.width;
    const y = ((event.clientY - rect.top) / rect.height) * size.height;
    let best: LayoutNode | null = null;
    let bestDistance = 14;
    for (const node of layout.nodes) {
      const distance = Math.hypot(node.x - x, node.y - y);
      if (distance <= node.r + 8 && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  };

  return (
    <div
      className="scifi-hud-overlay graph-overlay"
      onClick={onClose}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div
        className="scifi-hud-frame graph-frame"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Changed files graph"
      >
        <header className="scifi-top">
          <div className="scifi-brand graph-brand">
            <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
              <circle cx="8" cy="16" r="3.2" />
              <circle cx="20" cy="9" r="2.4" />
              <circle cx="21" cy="20" r="2" />
              <path d="M11 15.2 L17.8 10.2" />
              <path d="M10.6 17.4 L19.2 19.4" />
            </svg>
            <div>
              <b>SPARKMUX // LATTICE</b>
              <small>FILE CLUSTERS · LOCAL LINKS</small>
            </div>
          </div>
          <div className="scifi-ticker">
            <span>
              PANE: <strong>{cwdName}</strong>
            </span>
            <span>
              REPOS: <strong>{repoCount}</strong>
            </span>
            <span>
              FILES: <strong>{fileCount}</strong>
            </span>
            <span>
              LINKS: <strong>{edgeCount}</strong>
            </span>
          </div>
          <button type="button" className="scifi-close graph-close" onClick={onClose} aria-label="Close graph">
            ×
          </button>
        </header>

        <div className="graph-stage" ref={stageRef}>
          {data == null || data.repos.length === 0 ? (
            <div className="graph-empty">
              <b>{data == null ? (loadError ? "SCAN FAILED" : "SCANNING WORKTREE") : "NO CHANGED FILES"}</b>
              <span>
                {data == null
                  ? (loadError ?? "Reading git status and this agent's edits.")
                  : "Dirty git files and files this agent edits show up here."}
              </span>
            </div>
          ) : (
            <svg
              className="graph-svg"
              viewBox={`0 0 ${size.width} ${size.height}`}
              role="img"
              aria-label="Repository file clusters"
              onMouseMove={(event) => setHover(hitTest(event))}
              onMouseLeave={() => setHover(null)}
              onClick={(event) => {
                const hit = hitTest(event);
                setPinnedId(hit ? hit.id : null);
              }}
            >
              <defs>
                <pattern id="graph-grid" width="36" height="36" patternUnits="userSpaceOnUse">
                  <path d="M 36 0 L 0 0 0 36" fill="none" stroke="rgba(45,212,191,0.08)" strokeWidth="1" />
                </pattern>
                <radialGradient id="graph-vignette" cx="50%" cy="45%" r="65%">
                  <stop offset="0%" stopColor="rgba(18, 28, 36, 0.2)" />
                  <stop offset="100%" stopColor="rgba(2, 4, 8, 0.72)" />
                </radialGradient>
                <filter id="graph-glow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="2.2" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
              <rect width={size.width} height={size.height} fill="#070b10" />
              <rect width={size.width} height={size.height} fill="url(#graph-grid)" />
              <rect width={size.width} height={size.height} fill="url(#graph-vignette)" />
              <line className="graph-scan" x1="0" y1="0" x2={size.width} y2="0" />
              {stars(size.width, size.height).map((star) => (
                <circle key={star.id} cx={star.x} cy={star.y} r={star.r} fill="rgba(186, 230, 253, 0.35)" />
              ))}
              {layout.links.map((link) => (
                <g key={`${link.from}-${link.to}-${link.label}`}>
                  <path
                    className="graph-link"
                    d={`M ${link.x1} ${link.y1} Q ${link.cx} ${link.cy} ${link.x2} ${link.y2}`}
                    fill="none"
                  />
                  {link.label && (
                    <g transform={`translate(${link.cx} ${link.cy})`}>
                      <rect
                        x={-link.label.length * 3.3 - 8}
                        y={-10}
                        width={link.label.length * 6.6 + 16}
                        height={18}
                        rx="9"
                        className="graph-link-chip"
                      />
                      <text className="graph-link-label" textAnchor="middle" y="3">
                        {link.label}
                      </text>
                    </g>
                  )}
                </g>
              ))}
              {layout.clusters.map((cluster) => (
                <g key={cluster.id}>
                  <circle
                    cx={cluster.x}
                    cy={cluster.y}
                    r={cluster.r}
                    className={cluster.primary ? "graph-nebula primary" : "graph-nebula"}
                  />
                  <circle
                    cx={cluster.x}
                    cy={cluster.y}
                    r={cluster.r}
                    className={cluster.primary ? "graph-orbit primary" : "graph-orbit"}
                  />
                  <text
                    className="graph-cluster-name"
                    x={cluster.x}
                    y={cluster.y - cluster.r - 10}
                    textAnchor="middle"
                  >
                    {cluster.primary ? `${cluster.name} · PRIMARY` : cluster.name}
                  </text>
                </g>
              ))}
              {layout.nodes.map((node) => {
                const color = statusColor(node.status);
                const active = hover?.id === node.id || pinned?.id === node.id;
                return (
                  <g key={node.id} className={node.agentEdited ? "graph-node agent" : "graph-node"}>
                    {node.agentEdited && (
                      <circle cx={node.x} cy={node.y} r={node.r + 5} fill="none" stroke={color} strokeWidth="1" />
                    )}
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={active ? node.r + 2 : node.r}
                      fill={color}
                      filter="url(#graph-glow)"
                    />
                    {layout.nodes.filter((item) => item.repoId === node.repoId).length <= 18 && (
                      <text className="graph-file-label" x={node.x + 9} y={node.y + 3}>
                        {fileBasename(node.path)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
          {hover && hover.id !== pinned?.id && (
            <FileCard node={hover} repo={repoName(hover.repoId)} links={linksFor(hover)} floating />
          )}
          {pinned && <FileCard node={pinned} repo={repoName(pinned.repoId)} links={linksFor(pinned)} pinned />}
        </div>

        <footer className="graph-foot">
          <span className="graph-legend">
            <i style={{ background: "#e8a849" }} /> Modified
            <i style={{ background: "#2dd4bf" }} /> Added
            <i style={{ background: "#f87171" }} /> Deleted
            <i style={{ background: "#7aa2f7" }} /> Untracked
            <i style={{ background: "#c084fc" }} /> Renamed
            <i className="agent" /> Agent edit
          </span>
          <span className="graph-note">
            {data?.truncated ? "Showing the first files. " : ""}
            {loadError || data?.error || "Read only. Nothing is written to the terminal."}
          </span>
        </footer>
      </div>
    </div>
  );
}

function FileCard({
  node,
  repo,
  links,
  floating,
  pinned,
}: {
  node: LayoutNode;
  repo: string;
  links: { label: string; to_repo: string }[];
  floating?: boolean;
  pinned?: boolean;
}) {
  return (
    <aside className={`graph-card${floating ? " float" : ""}${pinned ? " pinned" : ""}`}>
      <b>{node.path}</b>
      <span>
        {statusLabel(node.status)}
        {node.agentEdited ? " · Agent edit" : ""}
      </span>
      {(node.linesAdded > 0 || node.linesRemoved > 0) && (
        <span className="graph-delta">
          +{node.linesAdded} / -{node.linesRemoved}
        </span>
      )}
      <span className="graph-repo">{repo}</span>
      {links.length > 0 && (
        <span className="graph-via">Links {links.map((link) => link.label).join(" · ")}</span>
      )}
    </aside>
  );
}

function stars(width: number, height: number) {
  const out: { id: number; x: number; y: number; r: number }[] = [];
  let seed = 0x51a7;
  for (let index = 0; index < 48; index += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const x = (seed % 1000) / 1000;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const y = (seed % 1000) / 1000;
    out.push({ id: index, x: x * width, y: y * height, r: index % 5 === 0 ? 1.4 : 0.7 });
  }
  return out;
}
