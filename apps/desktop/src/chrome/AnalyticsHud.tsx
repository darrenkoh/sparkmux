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

// ---------------------------------------------------------------------------
// 3D Connectome Whole-Brain Neural Network
// Modeled after anatomical human connectome imaging (dense gyral fiber tracts)
// ---------------------------------------------------------------------------
export interface ConnectomeNode {
  x: number;
  y: number;
  z: number;
  cat: "user" | "think" | "reply" | "tool";
  color: string;
}

export interface ConnectomeFiber {
  p0: [number, number, number];
  p1: [number, number, number];
  cat: "user" | "think" | "reply" | "tool";
}

function generateWholeBrainConnectome(): {
  nodes: ConnectomeNode[];
  fibers: ConnectomeFiber[];
} {
  const nodes: ConnectomeNode[] = [];
  const fibers: ConnectomeFiber[] = [];

  let s = 1337;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };

  // Anatomical functional centers
  // USER (Frontal Pole / Broca): Amber #ff9a3c
  // THINK (Superior Parietal / Prefrontal): Purple #c084fc
  // REPLY (Temporal / Wernicke / Occipital): Blue #5b8def
  // TOOL (Cerebellar Hemisphere / Brainstem): Teal #2dd4bf
  const regions = [
    { cat: "user" as const, color: "#ff9a3c", center: [0.0, 0.22, 0.58], rX: 0.45, rY: 0.38, rZ: 0.38, n: 60 },
    { cat: "think" as const, color: "#c084fc", center: [0.0, 0.44, 0.05], rX: 0.52, rY: 0.32, rZ: 0.45, n: 75 },
    { cat: "reply" as const, color: "#5b8def", center: [0.0, 0.12, -0.45], rX: 0.52, rY: 0.40, rZ: 0.42, n: 70 },
    { cat: "tool" as const, color: "#2dd4bf", center: [0.0, -0.40, -0.20], rX: 0.38, rY: 0.28, rZ: 0.32, n: 55 },
  ];

  // Distribute cortical & subcortical neuron soma nodes within true brain morphology
  for (const reg of regions) {
    for (let i = 0; i < reg.n; i++) {
      const u = rnd();
      const v = rnd();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = Math.cbrt(rnd()) * 0.95;

      let x = reg.center[0] + r * reg.rX * Math.sin(phi) * Math.cos(theta);
      let y = reg.center[1] + r * reg.rY * Math.sin(phi) * Math.sin(theta);
      let z = reg.center[2] + r * reg.rZ * Math.cos(phi);

      // Add lateral cerebral hemisphere separation & cortical sulci waviness
      const hemiSide = x >= 0 ? 1 : -1;
      x += hemiSide * 0.05; // Interhemispheric fissure
      const sulcalRipple = 0.04 * Math.sin(x * 9.0) * Math.cos(z * 9.0);
      y += sulcalRipple;

      // Bound strictly inside cranium envelope: (x/0.82)^2 + (y/0.72)^2 + (z/0.88)^2 <= 1.0
      const ellip = Math.pow(x / 0.82, 2) + Math.pow(y / 0.72, 2) + Math.pow(z / 0.88, 2);
      if (ellip > 1.0) {
        const factor = 0.95 / Math.sqrt(ellip);
        x *= factor;
        y *= factor;
        z *= factor;
      }

      nodes.push({ x, y, z, cat: reg.cat, color: reg.color });
    }
  }

  // Generate dense connectome fiber tracts (axon bundles connecting nearby & projecting nodes)
  const totalNodes = nodes.length;
  for (let i = 0; i < totalNodes; i++) {
    const nA = nodes[i];
    // Connect to k nearest neighbors in the same region
    let connections = 0;
    for (let j = i + 1; j < totalNodes; j++) {
      const nB = nodes[j];
      const dist = Math.hypot(nA.x - nB.x, nA.y - nB.y, nA.z - nB.z);
      const isSameCat = nA.cat === nB.cat;

      if (isSameCat && dist < 0.28 && connections < 5) {
        fibers.push({
          p0: [nA.x, nA.y, nA.z],
          p1: [nB.x, nB.y, nB.z],
          cat: nA.cat,
        });
        connections++;
      } else if (!isSameCat && dist < 0.32 && rnd() < 0.12) {
        // Inter-regional associative white matter tract
        fibers.push({
          p0: [nA.x, nA.y, nA.z],
          p1: [nB.x, nB.y, nB.z],
          cat: rnd() < 0.5 ? nA.cat : nB.cat,
        });
      }
    }
  }

  return { nodes, fibers };
}

const CONNECTOME_MODEL = generateWholeBrainConnectome();

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

  // Interactive 3D Orbit Camera for the Brain Viewport
  const brainCamRef = useRef({
    rotY: 0.65,
    rotX: 0.18,
    isDragging: false,
    lastX: 0,
    lastY: 0,
  });

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

  // Sci-Fi 3D Brain Neural Cortex auto-rotation, synaptic firing & interactive orbit
  useEffect(() => {
    const canvas = radarCanvasRef.current;
    if (!canvas) return;

    // Pointer event listeners for interactive 3D rotation
    const onPointerDown = (e: PointerEvent) => {
      brainCamRef.current.isDragging = true;
      brainCamRef.current.lastX = e.clientX;
      brainCamRef.current.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!brainCamRef.current.isDragging) return;
      const dx = e.clientX - brainCamRef.current.lastX;
      const dy = e.clientY - brainCamRef.current.lastY;
      brainCamRef.current.lastX = e.clientX;
      brainCamRef.current.lastY = e.clientY;
      brainCamRef.current.rotY += dx * 0.018;
      brainCamRef.current.rotX = Math.max(-1.1, Math.min(1.1, brainCamRef.current.rotX + dy * 0.018));
    };

    const onPointerUp = (e: PointerEvent) => {
      brainCamRef.current.isDragging = false;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {}
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);

    const render = (time: number) => {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssW = 120;
        const cssH = 120;
        if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
          canvas.width = cssW * dpr;
          canvas.height = cssH * dpr;
        }

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        const cx = cssW / 2;
        const cy = cssH / 2;
        const radiusScale = (cssW / 2) * 0.90;

        const st = statsRef.current;
        const recentEvents = st?.recent_events ?? [];
        const lastEventKind = recentEvents.length > 0 ? recentEvents[recentEvents.length - 1].k : null;

        // Auto-rotation when user is not actively dragging
        const activityLevel = Math.min(3.0, 1.0 + (st?.total_events ?? 0) * 0.06);
        if (!brainCamRef.current.isDragging) {
          brainCamRef.current.rotY += 0.009 * Math.min(activityLevel, 1.8);
        }

        const angleY = brainCamRef.current.rotY;
        const angleX = brainCamRef.current.rotX;

        const cosY = Math.cos(angleY);
        const sinY = Math.sin(angleY);
        const cosX = Math.cos(angleX);
        const sinX = Math.sin(angleX);

        // 3D Projection Matrix Transformation
        const project3D = (x: number, y: number, z: number) => {
          const x1 = x * cosY - z * sinY;
          const z1 = x * sinY + z * cosY;
          const y2 = y * cosX - z1 * sinX;
          const z2 = y * sinX + z1 * cosX;

          const perspective = 2.4 / (2.4 + z2);
          const sx = cx + x1 * radiusScale * perspective;
          const sy = cy - y2 * radiusScale * perspective;
          return { sx, sy, sz: z2, perspective };
        };

        // 1. Ultra-Thin Fiber Tracts (Connectome mesh, matching reference 3)
        // Default color is electric ice blue; active firing region illuminates in corresponding category hue
        ctx.lineWidth = 0.55;
        for (const fib of CONNECTOME_MODEL.fibers) {
          const p0 = project3D(fib.p0[0], fib.p0[1], fib.p0[2]);
          const p1 = project3D(fib.p1[0], fib.p1[1], fib.p1[2]);

          const avgZ = (p0.sz + p1.sz) / 2;
          const depthAlpha = Math.max(0.08, Math.min(0.70, 0.28 + avgZ * 0.25));

          const isFiring =
            (fib.cat === "user" && lastEventKind === "user") ||
            (fib.cat === "think" && lastEventKind === "think") ||
            (fib.cat === "reply" && lastEventKind === "reply") ||
            (fib.cat === "tool" && (lastEventKind === "tool" || lastEventKind === "done"));

          ctx.beginPath();
          ctx.moveTo(p0.sx, p0.sy);
          ctx.lineTo(p1.sx, p1.sy);

          if (isFiring) {
            // Illuminated tract in category color
            const catColor = fib.cat === "user" ? "#ff9a3c" : fib.cat === "think" ? "#c084fc" : fib.cat === "reply" ? "#5b8def" : "#2dd4bf";
            ctx.strokeStyle = catColor;
            ctx.globalAlpha = Math.min(0.95, depthAlpha * 2.2);
          } else {
            // Delicate anatomical ice blue tract
            ctx.strokeStyle = "rgba(100, 185, 255, 0.85)";
            ctx.globalAlpha = depthAlpha * 0.75;
          }
          ctx.stroke();
        }

        // 2. Synaptic Soma Beads / Neurons (Only the firing neurons light up brightly!)
        const projectedNodes = CONNECTOME_MODEL.nodes.map((n) => ({
          ...n,
          ...project3D(n.x, n.y, n.z),
        }));
        projectedNodes.sort((a, b) => a.sz - b.sz);

        for (const node of projectedNodes) {
          const isFiring =
            (node.cat === "user" && lastEventKind === "user") ||
            (node.cat === "think" && lastEventKind === "think") ||
            (node.cat === "reply" && lastEventKind === "reply") ||
            (node.cat === "tool" && (lastEventKind === "tool" || lastEventKind === "done"));

          const depthAlpha = Math.max(0.20, Math.min(1.0, 0.50 + node.sz * 0.35));

          if (isFiring) {
            // Targeted Neuron Firing: Radiant flash and gleaming white core!
            const pulse = Math.sin(time * 0.012 + (node.x + node.z) * 10) * 0.4 + 0.6;
            const rGlow = 3.6 * node.perspective * pulse;

            // Outer Aura
            ctx.beginPath();
            ctx.arc(node.sx, node.sy, rGlow, 0, Math.PI * 2);
            ctx.fillStyle = node.color;
            ctx.globalAlpha = 0.55 * depthAlpha;
            ctx.fill();

            // Luminous Core
            ctx.beginPath();
            ctx.arc(node.sx, node.sy, 1.6 * node.perspective, 0, Math.PI * 2);
            ctx.fillStyle = "#ffffff";
            ctx.globalAlpha = depthAlpha;
            ctx.fill();
          } else {
            // Quiescent delicate synapse puncta (subtle, tiny pinprick point)
            ctx.beginPath();
            ctx.arc(node.sx, node.sy, 0.85 * node.perspective, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(130, 200, 255, 0.70)";
            ctx.globalAlpha = depthAlpha * 0.60;
            ctx.fill();
          }
        }
      }

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
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
                  title="3D Neural Arborization: Click & Drag to Orbit · User (Amber) · Think (Purple) · Reply (Blue) · Tool (Teal)"
                >
                  <canvas
                    ref={radarCanvasRef}
                    width={120}
                    height={120}
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
