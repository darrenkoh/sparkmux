import { useEffect, useRef, useState } from "react";
import {
  tabAnalytics,
  setAnalyticsEnabled,
  clearAnalyticsData,
  type TabAnalyticsResponse,
} from "../api";
import { cliLabel } from "./artifactModel";
import { formatBytes, formatNum, formatMs } from "./analyticsFormat";
import TerrainViewport from "./TerrainViewport";

export interface AnalyticsHudProps {
  sessionName: string;
  tabId: string;
  tabName: string;
  command: string;
  cwd: string;
  title: string;
  pid: number;
  onClose: () => void;
  onDock?: () => void;
}

export { formatBytes, formatNum, formatMs };

// 3D Brain Neural Cortex Nodes (x, y, z coordinates mapped in 3D space)
// Categories match Area Map: user (amber), think (purple), reply (blue), tool (teal)
export interface Brain3DNode {
  id: number;
  x: number; // Left (-) / Right (+)
  y: number; // Superior (+) / Inferior (-)
  z: number; // Anterior (+) / Posterior (-)
  cat: "user" | "think" | "reply" | "tool";
  color: string;
}

const BRAIN_3D_NODES: Brain3DNode[] = [
  // 1. FRONTAL LOBE (Anterior cortex / User Queries): Amber #ff9a3c
  { id: 0, x: -0.32, y: 0.35, z: 0.72, cat: "user", color: "#ff9a3c" },
  { id: 1, x: 0.32, y: 0.35, z: 0.72, cat: "user", color: "#ff9a3c" },
  { id: 2, x: -0.16, y: 0.52, z: 0.65, cat: "user", color: "#ff9a3c" },
  { id: 3, x: 0.16, y: 0.52, z: 0.65, cat: "user", color: "#ff9a3c" },
  { id: 4, x: -0.45, y: 0.18, z: 0.54, cat: "user", color: "#ff9a3c" },
  { id: 5, x: 0.45, y: 0.18, z: 0.54, cat: "user", color: "#ff9a3c" },
  { id: 6, x: 0.0, y: 0.28, z: 0.80, cat: "user", color: "#ff9a3c" },

  // 2. PARIETAL & CENTRAL CORTEX (Superior / Reasoning & Thinking): Purple #c084fc
  { id: 7, x: -0.52, y: 0.62, z: 0.12, cat: "think", color: "#c084fc" },
  { id: 8, x: 0.52, y: 0.62, z: 0.12, cat: "think", color: "#c084fc" },
  { id: 9, x: -0.22, y: 0.78, z: 0.18, cat: "think", color: "#c084fc" },
  { id: 10, x: 0.22, y: 0.78, z: 0.18, cat: "think", color: "#c084fc" },
  { id: 11, x: 0.0, y: 0.82, z: 0.0, cat: "think", color: "#c084fc" },
  { id: 12, x: -0.36, y: 0.68, z: -0.15, cat: "think", color: "#c084fc" },
  { id: 13, x: 0.36, y: 0.68, z: -0.15, cat: "think", color: "#c084fc" },
  { id: 14, x: -0.60, y: 0.36, z: 0.08, cat: "think", color: "#c084fc" },
  { id: 15, x: 0.60, y: 0.36, z: 0.08, cat: "think", color: "#c084fc" },

  // 3. TEMPORAL & OCCIPITAL LOBE (Lateral & Posterior / Reply & Assistant): Cobalt Blue #5b8def
  { id: 16, x: -0.66, y: -0.12, z: 0.05, cat: "reply", color: "#5b8def" },
  { id: 17, x: 0.66, y: -0.12, z: 0.05, cat: "reply", color: "#5b8def" },
  { id: 18, x: -0.42, y: 0.24, z: -0.62, cat: "reply", color: "#5b8def" },
  { id: 19, x: 0.42, y: 0.24, z: -0.62, cat: "reply", color: "#5b8def" },
  { id: 20, x: -0.18, y: 0.38, z: -0.74, cat: "reply", color: "#5b8def" },
  { id: 21, x: 0.18, y: 0.38, z: -0.74, cat: "reply", color: "#5b8def" },
  { id: 22, x: 0.0, y: 0.15, z: -0.80, cat: "reply", color: "#5b8def" },

  // 4. CEREBELLUM & BRAINSTEM (Inferior-Posterior / Tools Execution): Teal #2dd4bf
  { id: 23, x: -0.34, y: -0.48, z: -0.45, cat: "tool", color: "#2dd4bf" },
  { id: 24, x: 0.34, y: -0.48, z: -0.45, cat: "tool", color: "#2dd4bf" },
  { id: 25, x: -0.18, y: -0.62, z: -0.36, cat: "tool", color: "#2dd4bf" },
  { id: 26, x: 0.18, y: -0.62, z: -0.36, cat: "tool", color: "#2dd4bf" },
  { id: 27, x: 0.0, y: -0.72, z: -0.12, cat: "tool", color: "#2dd4bf" }, // Brainstem base
  { id: 28, x: 0.0, y: -0.45, z: 0.0, cat: "tool", color: "#2dd4bf" },   // Pons / Core junction
];

// 3D Synaptic Axons connecting the brain lobes
const BRAIN_3D_SYNAPSES: Array<[number, number]> = [
  // Frontal lobe mesh
  [0, 1], [0, 2], [1, 3], [2, 3], [0, 4], [1, 5], [2, 6], [3, 6], [4, 6], [5, 6],
  // Frontal to Parietal
  [2, 9], [3, 10], [4, 7], [5, 8], [6, 11], [4, 14], [5, 15],
  // Parietal mesh
  [7, 9], [8, 10], [9, 11], [10, 11], [9, 12], [10, 13], [12, 13], [7, 14], [8, 15],
  // Parietal to Temporal/Occipital
  [14, 16], [15, 17], [12, 18], [13, 19], [11, 20], [11, 21],
  // Occipital & Temporal mesh
  [16, 18], [17, 19], [18, 20], [19, 21], [20, 21], [20, 22], [21, 22], [18, 22], [19, 22],
  // Occipital/Temporal to Cerebellum & Brainstem
  [18, 23], [19, 24], [22, 23], [22, 24], [23, 25], [24, 26], [25, 26], [25, 27], [26, 27],
  // Brainstem central hub
  [28, 27], [28, 11], [28, 6], [28, 22], [28, 16], [28, 17],
];

export default function AnalyticsHud({
  sessionName,
  tabId,
  tabName,
  command,
  cwd,
  title,
  pid,
  onClose,
  onDock,
}: AnalyticsHudProps) {
  const [data, setData] = useState<TabAnalyticsResponse | null>(null);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [eventFilter, setEventFilter] = useState<"all" | "turns" | "tools" | "usage">("all");

  const radarCanvasRef = useRef<HTMLCanvasElement>(null);
  const tokenCanvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number | null>(null);
  const statsRef = useRef(data?.stats);
  statsRef.current = data?.stats;

  const fetchData = () => {
    tabAnalytics(sessionName, tabId, command, cwd, title, pid)
      .then((res) => {
        setData(res);
        statsRef.current = res.stats;
      })
      .catch((err) => console.error("tabAnalytics error:", err));
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 1000);
    return () => clearInterval(interval);
  }, [sessionName, tabId, command, cwd, title, pid]);

  // Sci-Fi 3D Brain Neural Cortex auto-rotation & live synaptogenesis firing
  useEffect(() => {
    let angleY = 0.4;
    const angleX = 0.22; // slight tilt forward to see top lobes clearly

    const render = (time: number) => {
      const canvas = radarCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const w = canvas.width;
          const h = canvas.height;
          ctx.clearRect(0, 0, w, h);

          const cx = w / 2;
          const cy = h / 2;
          const radiusScale = (Math.min(w, h) / 2) * 0.78;

          const st = statsRef.current;
          const recentEvents = st?.recent_events ?? [];
          const lastEventKind = recentEvents.length > 0 ? recentEvents[recentEvents.length - 1].k : null;

          // Activity factor: speeds up rotation & action potentials during busy turns
          const activityLevel = Math.min(3.0, 1.0 + (st?.total_events ?? 0) * 0.05);
          angleY += 0.015 * Math.min(activityLevel, 2.0);

          const cosY = Math.cos(angleY);
          const sinY = Math.sin(angleY);
          const cosX = Math.cos(angleX);
          const sinX = Math.sin(angleX);

          // 3D Projection Helper
          const project3D = (x: number, y: number, z: number) => {
            // Rotate around Y-axis (Yaw)
            const x1 = x * cosY - z * sinY;
            const z1 = x * sinY + z * cosY;
            // Rotate around X-axis (Pitch)
            const y2 = y * cosX - z1 * sinX;
            const z2 = y * sinX + z1 * cosX;

            const perspective = 2.4 / (2.4 + z2);
            const sx = cx + x1 * radiusScale * perspective;
            const sy = cy - y2 * radiusScale * perspective; // Invert Y for screen space
            return { sx, sy, sz: z2, perspective };
          };

          // Project all 3D brain nodes
          const projectedNodes = BRAIN_3D_NODES.map((node) => {
            const p = project3D(node.x, node.y, node.z);
            return { ...node, ...p };
          });

          // Sort nodes and elements for depth rendering
          const projectedSynapses = BRAIN_3D_SYNAPSES.map(([fromIdx, toIdx], synId) => {
            const pA = projectedNodes[fromIdx];
            const pB = projectedNodes[toIdx];
            const avgZ = (pA.sz + pB.sz) / 2;
            return { synId, fromIdx, toIdx, pA, pB, avgZ };
          });
          projectedSynapses.sort((a, b) => a.avgZ - b.avgZ);

          // 1. Draw Faint 3D Brain Cortex Cage Outline (Rib arcs connecting lobes)
          ctx.lineWidth = 0.8;
          for (const syn of projectedSynapses) {
            const alpha = Math.max(0.06, Math.min(0.28, 0.16 + syn.avgZ * 0.1));
            ctx.beginPath();
            ctx.moveTo(syn.pA.sx, syn.pA.sy);
            ctx.lineTo(syn.pB.sx, syn.pB.sy);
            ctx.strokeStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
            ctx.stroke();
          }

          // 2. Firing Synaptic Action Potentials traveling along 3D pathways
          const pulseCount = 18;
          for (let p = 0; p < pulseCount; p++) {
            const synIdx = (p * 2 + Math.floor(time * 0.001)) % BRAIN_3D_SYNAPSES.length;
            const [fromIdx, toIdx] = BRAIN_3D_SYNAPSES[synIdx];
            const nA = projectedNodes[fromIdx];
            const nB = projectedNodes[toIdx];

            const offset = (p * 0.14 + fromIdx * 0.08);
            const progress = ((time * 0.0016 * activityLevel + offset) % 1.0);

            const px = nA.sx + (nB.sx - nA.sx) * progress;
            const py = nA.sy + (nB.sy - nA.sy) * progress;
            const pz = nA.sz + (nB.sz - nA.sz) * progress;

            const pulseAlpha = Math.max(0.2, Math.min(0.95, 0.65 + pz * 0.3));
            ctx.beginPath();
            ctx.arc(px, py, 1.5 * nA.perspective, 0, Math.PI * 2);
            ctx.fillStyle = nA.color;
            ctx.globalAlpha = pulseAlpha;
            ctx.fill();
            ctx.globalAlpha = 1.0;
          }

          // 3. Render 3D Brain Neurons with Live Firing Highlights
          // Sort nodes back-to-front so closer neurons overlay distant ones
          const sortedNodes = [...projectedNodes].sort((a, b) => a.sz - b.sz);
          for (const node of sortedNodes) {
            const isFiring =
              (node.cat === "user" && lastEventKind === "user") ||
              (node.cat === "think" && lastEventKind === "think") ||
              (node.cat === "reply" && lastEventKind === "reply") ||
              (node.cat === "tool" && (lastEventKind === "tool" || lastEventKind === "done"));

            const depthAlpha = Math.max(0.35, Math.min(1.0, 0.72 + node.sz * 0.35));
            const nodeR = (isFiring ? 3.6 : 2.2) * node.perspective;

            // Firing Lobe Radiant Aura
            if (isFiring) {
              const pulse = Math.sin(time * 0.01 + node.id) * 0.5 + 0.5;
              ctx.beginPath();
              ctx.arc(node.sx, node.sy, (nodeR * 2.4) + pulse * 2.0, 0, Math.PI * 2);
              ctx.fillStyle = node.color;
              ctx.globalAlpha = 0.40 * depthAlpha;
              ctx.fill();
            }

            // Outer Halo
            ctx.beginPath();
            ctx.arc(node.sx, node.sy, nodeR * 1.3, 0, Math.PI * 2);
            ctx.fillStyle = node.color;
            ctx.globalAlpha = (isFiring ? 0.85 : 0.4) * depthAlpha;
            ctx.fill();

            // Core Luminous Bead
            ctx.beginPath();
            ctx.arc(node.sx, node.sy, nodeR * 0.85, 0, Math.PI * 2);
            ctx.fillStyle = isFiring ? "#ffffff" : node.color;
            ctx.globalAlpha = depthAlpha;
            ctx.fill();
            ctx.globalAlpha = 1.0;
          }

          // 4. Equatorial Synaptic Scan Ring
          const ringRadius = radiusScale * 1.05;
          ctx.beginPath();
          ctx.ellipse(cx, cy + radiusScale * 0.2, ringRadius, ringRadius * 0.32, 0, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255, 154, 60, 0.12)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  // Draw Token Distribution Arc Gauge Canvas
  useEffect(() => {
    const canvas = tokenCanvasRef.current;
    if (!canvas || !data?.stats) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const st = data.stats;
    const total =
      st.total_input_tokens +
      st.total_output_tokens +
      st.total_cache_read_tokens +
      st.total_reasoning_tokens;

    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(cx, cy) - 6;

    if (total === 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
      ctx.lineWidth = 6;
      ctx.stroke();
      return;
    }

    const segments = [
      { val: st.total_input_tokens, color: "#5b8def" },
      { val: st.total_output_tokens, color: "#3dd68c" },
      { val: st.total_cache_read_tokens, color: "#ff9a3c" },
      { val: st.total_reasoning_tokens, color: "#c084fc" },
    ];

    let start = -Math.PI / 2;
    ctx.lineWidth = 7;

    for (const seg of segments) {
      if (seg.val <= 0) continue;
      const angle = (seg.val / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, start, start + angle);
      ctx.strokeStyle = seg.color;
      ctx.stroke();
      start += angle;
    }
  }, [data]);

  const handleToggle = async () => {
    if (!data) return;
    const next = !data.enabled;
    await setAnalyticsEnabled(next);
    fetchData();
  };

  const handleClear = async () => {
    setClearing(true);
    await clearAnalyticsData();
    setClearing(false);
    setConfirmClear(false);
    fetchData();
  };

  const st = data?.stats;
  const storage = data?.storage;

  return (
    <div className="scifi-hud-overlay" onClick={onClose}>
      <div
        className={`scifi-hud-frame ${isFullscreen ? "fullscreen" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Sci-Fi Analytics HUD"
      >
        {/* Top Header Banner */}
        <header className="scifi-top">
          <div className="scifi-brand">
            <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0.5" y="0.5" width="27" height="27" />
              <path d="M5 21 L11 9 L15 16 L18 12 L23 21 Z" />
              <path d="M6 23 L22 5" strokeDasharray="1 2" />
            </svg>
            <div>
              <b>SPARKMUX // STATS</b>
              <small>SESSION TELEMETRY · QUANTUM CORE</small>
            </div>
          </div>

          <div className="scifi-ticker">
            <span>
              SESSION: <strong>{sessionName}</strong>
            </span>
            <span>
              TAB: <strong>{tabName}</strong> ({tabId})
            </span>
            <span>
              ENGINE:{" "}
              <strong>{cliLabel(data?.cli ?? null) || "STANDBY"}</strong>
            </span>
            {st?.active_model && (
              <span>
                MODEL: <strong>{st.active_model}</strong>
              </span>
            )}
          </div>

          <div className="scifi-controls">
            <button
              type="button"
              className={`scifi-btn ${data?.enabled ? "on" : "off"}`}
              onClick={handleToggle}
              title="Toggle automatic persistence & statistics gathering"
            >
              RECORDING: {data?.enabled ? "ACTIVE" : "STANDBY"}
            </button>

            {confirmClear ? (
              <div className="scifi-confirm-box">
                <span>WIPE DISK?</span>
                <button
                  type="button"
                  className="scifi-btn danger"
                  disabled={clearing}
                  onClick={handleClear}
                >
                  YES
                </button>
                <button
                  type="button"
                  className="scifi-btn"
                  onClick={() => setConfirmClear(false)}
                >
                  NO
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="scifi-btn"
                onClick={() => setConfirmClear(true)}
                title="Wipe all captured telemetry from disk"
              >
                PURGE DATA
              </button>
            )}

            <button
              type="button"
              className={`scifi-btn ${isFullscreen ? "on" : ""}`}
              onClick={() => setIsFullscreen(!isFullscreen)}
              title={isFullscreen ? "Exit Fullscreen HUD" : "Expand to Fullscreen HUD"}
              aria-label={isFullscreen ? "Exit Fullscreen HUD" : "Expand to Fullscreen HUD"}
            >
              {isFullscreen ? "🗗 RESTORE" : "⤢ FULLSCREEN"}
            </button>

            {onDock && (
              <button
                type="button"
                className="scifi-btn"
                onClick={onDock}
                title="Dock area map to the bottom right panel"
              >
                ⇲ DOCK
              </button>
            )}

            <button type="button" className="scifi-close" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>

        {/* 3-Column Sci-Fi Grid Layout */}
        <div className="scifi-content">
          {/* LEFT COLUMN: Telemetry Radar, KPIs & Tools */}
          <aside className="scifi-col left">
            <section className="scifi-panel telemetry">
              <header>
                <span className="tag">01</span>
                <span>NEURAL TELEMETRY</span>
                <small>3D SYNAPTIC CORE</small>
              </header>
              <div className="body">
                <div
                  className="radar"
                  title="3D Neural Cortex: User (Amber) · Think (Purple) · Reply (Blue) · Tool (Teal)"
                >
                  <canvas
                    ref={radarCanvasRef}
                    width={100}
                    height={100}
                    className="scifi-radar-canvas"
                  />
                </div>
                <div className="kpis">
                  <div>
                    <small>TOTAL EVENTS</small>
                    <b>{st?.total_events ?? 0}</b>
                  </div>
                  <div>
                    <small>PROMPTS / REPLIES</small>
                    <b>
                      {st?.user_prompts ?? 0} / {st?.assistant_replies ?? 0}
                    </b>
                  </div>
                  <div>
                    <small>THINK BLOCKS</small>
                    <b style={{ color: "#c084fc" }}>
                      {st?.thinking_blocks ?? 0}
                    </b>
                  </div>
                  <div>
                    <small>TOOL CALLS</small>
                    <b style={{ color: "#2dd4bf" }}>{st?.tool_calls ?? 0}</b>
                  </div>
                </div>
              </div>
            </section>

            {/* Tools Breakdown Table */}
            <section className="scifi-panel tools-table-panel">
              <header>
                <span className="tag">02</span>
                <span>ACTIONS / TOOLS MATRIX</span>
                <small>{st?.tools?.length ?? 0} LOGGED</small>
              </header>
              <div className="body table-scroll">
                <table className="scifi-table">
                  <thead>
                    <tr>
                      <th>TOOL</th>
                      <th className="num">CALLS</th>
                      <th className="num">LATENCY</th>
                      <th className="num">STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(!st?.tools || st.tools.length === 0) && (
                      <tr>
                        <td colSpan={4} className="empty-row">
                          NO ACTIONS REGISTERED
                        </td>
                      </tr>
                    )}
                    {st?.tools?.map((t) => (
                      <tr key={t.name}>
                        <td className="tool-name" title={t.name}>
                          {t.name}
                        </td>
                        <td className="num">{t.calls}</td>
                        <td className="num">{formatMs(t.avg_duration_ms)}</td>
                        <td className="num">
                          {t.errors > 0 ? (
                            <span className="scifi-status error">
                              {t.errors} ERR
                            </span>
                          ) : (
                            <span className="scifi-status ok">OK</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </aside>

          <main className="scifi-center">
            {/* Interactive 3D Hill Terrain Viewport with Real Session Data */}
            <TerrainViewport
              timeline={st?.timeline ?? []}
              activeModel={st?.active_model}
              sessionName={sessionName}
              tabName={tabName}
              stats={st}
            />

            {/* Sub-grid: Token Allocation & Context Window Gauge */}
            <div className="scifi-row">
              <section className="scifi-panel token-panel">
                <header>
                  <span className="tag">04</span>
                  <span>TOKEN SPECTRUM</span>
                  <small>DISTRIBUTION</small>
                </header>
                <div className="body token-body">
                  <canvas
                    ref={tokenCanvasRef}
                    width={90}
                    height={90}
                    className="scifi-token-canvas"
                  />
                  <div className="token-stats">
                    <div>
                      <small>INPUT</small>
                      <b>{formatNum(st?.total_input_tokens ?? 0)}</b>
                    </div>
                    <div>
                      <small>OUTPUT</small>
                      <b>{formatNum(st?.total_output_tokens ?? 0)}</b>
                    </div>
                    <div>
                      <small>CACHE READ</small>
                      <b>{formatNum(st?.total_cache_read_tokens ?? 0)}</b>
                    </div>
                    <div>
                      <small>REASONING</small>
                      <b>{formatNum(st?.total_reasoning_tokens ?? 0)}</b>
                    </div>
                  </div>
                </div>
              </section>

              <section className="scifi-panel context-panel">
                <header>
                  <span className="tag">05</span>
                  <span>CONTEXT BUFFER & LATENCY</span>
                  <small>SESSION LIMIT</small>
                </header>
                <div className="body context-body">
                  <div className="context-meter">
                    <div className="meter-label">
                      <span>CONTEXT UTILIZATION</span>
                      <span>
                        {formatNum(st?.context_tokens_used ?? 0)} /{" "}
                        {formatNum(st?.context_window_tokens ?? 200_000)}
                      </span>
                    </div>
                    <div className="meter-bar">
                      <div
                        className="meter-fill"
                        style={{
                          width: `${Math.min(
                            100,
                            ((st?.context_tokens_used ?? 0) /
                              Math.max(1, st?.context_window_tokens ?? 200_000)) *
                              100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>

                  <div className="kpis-sub">
                    <div>
                      <small>AVG TURN TIME</small>
                      <b>{formatMs(st?.avg_turn_duration_ms ?? 0)}</b>
                    </div>
                    <div>
                      <small>TTFT (FIRST TOKEN)</small>
                      <b>{formatMs(st?.ttft_ms ?? 0)}</b>
                    </div>
                    <div>
                      <small>CODE DELTA</small>
                      <b style={{ color: "#3dd68c" }}>
                        +{st?.lines_added ?? 0} / -{st?.lines_removed ?? 0}
                      </b>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </main>

          {/* RIGHT COLUMN: Real-Time Event Stream Log */}
          <aside className="scifi-col right">
            <section className="scifi-panel stream-panel">
              <header>
                <span className="tag">06</span>
                <span>EVENT STREAM LOG</span>
                <small>LIVE REPLAY</small>
              </header>
              <div className="stream-filters">
                {(["all", "turns", "tools", "usage"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`stream-filter-btn ${eventFilter === mode ? "active" : ""}`}
                    onClick={() => setEventFilter(mode)}
                  >
                    {mode.toUpperCase()}
                  </button>
                ))}
              </div>
              <div className="body stream-body">
                <ul className="scifi-log-list">
                  {(!st?.recent_events || st.recent_events.length === 0) && (
                    <li className="empty-log">NO LOGGED EVENTS CAPTURED</li>
                  )}
                  {st?.recent_events
                    ?.filter((ev) => {
                      if (eventFilter === "all") return true;
                      if (eventFilter === "turns")
                        return ev.k === "user" || ev.k === "reply" || ev.k === "think";
                      if (eventFilter === "tools")
                        return ev.k === "tool" || ev.k === "result" || ev.k === "done";
                      if (eventFilter === "usage") return ev.k === "usage";
                      return true;
                    })
                    .slice()
                    .reverse()
                    .map((ev, i) => {
                      const isUsage = ev.k === "usage";
                      return (
                        <li key={`${ev.t}-${i}`} className={`scifi-log-item ${ev.k}`}>
                          <span className="ev-time">
                            {new Date(ev.t).toLocaleTimeString()}
                          </span>
                          <span className={`ev-tag ${ev.k}`}>
                            [{ev.k.toUpperCase()}]
                          </span>
                          {isUsage ? (
                            <span
                              className="ev-content ev-usage-content"
                              title={`Token Checkpoint: ${formatNum(ev.ti ?? 0)} in, ${formatNum(ev.to ?? 0)} out, ${formatNum(ev.tc ?? 0)} cached, ${formatNum(ev.tr ?? 0)} reasoning`}
                            >
                              {ev.n ? <strong>{ev.n}: </strong> : null}
                              <span className="ev-usage-metric">
                                +{formatNum(ev.ti ?? 0)} in / {formatNum(ev.to ?? 0)} out
                                {(ev.tc ?? 0) > 0 ? ` (${formatNum(ev.tc ?? 0)} cached)` : ""}
                                {(ev.tr ?? 0) > 0 ? ` [${formatNum(ev.tr ?? 0)} reasoning]` : ""}
                              </span>
                            </span>
                          ) : (
                            <span
                              className="ev-content"
                              title={ev.b || ev.a || ev.n || ""}
                            >
                              {ev.n ? <strong>{ev.n}: </strong> : null}
                              {ev.a || ev.b || (ev.ms ? `${ev.ms}ms` : "")}
                            </span>
                          )}
                        </li>
                      );
                    })}
                </ul>
              </div>
            </section>
          </aside>
        </div>

        {/* Footer Status Bar */}
        <footer className="scifi-footer">
          <div>
            <i className="amber" />
            <span>
              STATUS: {data?.enabled ? "ONLINE // RECORDING" : "OFFLINE // IDLE"}
            </span>
          </div>
          <div>
            <span>
              STORAGE ALLOCATION:{" "}
              <strong>{formatBytes(storage?.total_bytes ?? 0)}</strong> ON DISK
            </span>
          </div>
          <div>
            <span>
              TOTAL MONITORED: {storage?.session_count ?? 0} SESSIONS /{" "}
              {storage?.tab_count ?? 0} TABS
            </span>
          </div>
          <div className="scifi-foot-right">
            <span>SPARKMUX QUANTUM ANALYTICS SYSTEM · v1.0.0</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
