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
// 3D Anatomical Human Brain Connectome Mesh
// Generates realistic cerebral cortex with bilateral hemispheres, gyral sulci,
// cerebellar folia, and brainstem (matching reference 3)
// ---------------------------------------------------------------------------
export interface ConnectomeNode {
  x: number;
  y: number;
  z: number;
  cat: "user" | "think" | "reply" | "tool";
  color: string;
  isCortical: boolean;
}

export interface ConnectomeFiber {
  p0: [number, number, number];
  p1: [number, number, number];
  cat: "user" | "think" | "reply" | "tool";
  color: string;
}

function generateAnatomicalBrain(): {
  nodes: ConnectomeNode[];
  fibers: ConnectomeFiber[];
} {
  const nodes: ConnectomeNode[] = [];
  const fibers: ConnectomeFiber[] = [];

  let s = 2026;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };

  // 1. Bilateral Cerebral Hemispheres (Left & Right)
  // Lobes mapped to categories:
  // - Anterior / Frontal Lobe (Z > 0.15, Y > -0.15): USER (Amber #ff9a3c)
  // - Superior / Parietal Lobe (Y > 0.22, -0.2 < Z < 0.25): THINK (Purple #c084fc)
  // - Lateral & Posterior / Temporal & Occipital (Z < -0.05): REPLY (Blue #5b8def)
  // - Inferior-Posterior / Cerebellum & Brainstem (Y < -0.20): TOOL (Teal #2dd4bf)
  
  const CEREBRUM_COUNT = 320;
  for (let i = 0; i < CEREBRUM_COUNT; i++) {
    // Hemispherical coordinates
    const side = i % 2 === 0 ? 1 : -1; // 1 = right, -1 = left
    const u = rnd();
    const v = rnd();
    const theta = u * Math.PI; // 0 to PI (curving over the hemisphere)
    const phi = (v * 0.95 - 0.45) * Math.PI; // -0.45*PI to 0.5*PI

    // Base anatomical ellipsoid radii for cerebrum
    const aX = 0.48; // Half-width per hemisphere
    const aY = 0.52; // Height
    const aZ = 0.72; // Length (anterior to posterior)

    let bx = Math.sin(theta) * Math.cos(phi) * aX;
    let by = Math.sin(phi) * aY + 0.12;
    let bz = Math.cos(theta) * aZ;

    // Separate hemispheres along the longitudinal fissure
    bx = (Math.abs(bx) + 0.05) * side;

    // Organic Gyri & Sulci convolutions (cortical folding wrinkles)
    const sulcus =
      0.035 * Math.sin(bx * 14.0 + bz * 10.0) * Math.cos(by * 12.0) +
      0.025 * Math.sin(bz * 18.0) * Math.cos(bx * 10.0);
    bx += sulcus * 0.5;
    by += sulcus;
    bz += sulcus * 0.5;

    // Temporal lobe lower dip
    if (bz > -0.2 && bz < 0.3 && by < 0.1) {
      by -= 0.08;
      bx *= 1.08;
    }

    // Determine category based on anatomical region
    let cat: "user" | "think" | "reply" | "tool" = "reply";
    let color = "#5b8def";

    if (by < -0.15) {
      cat = "tool";
      color = "#2dd4bf";
    } else if (bz > 0.18) {
      cat = "user";
      color = "#ff9a3c";
    } else if (by > 0.22) {
      cat = "think";
      color = "#c084fc";
    } else {
      cat = "reply";
      color = "#5b8def";
    }

    nodes.push({ x: bx, y: by, z: bz, cat, color, isCortical: true });
  }

  // 2. Cerebellum (Inferior posterior cauliflower lobes)
  const CEREBELLUM_COUNT = 60;
  for (let i = 0; i < CEREBELLUM_COUNT; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const r = Math.pow(rnd(), 0.6) * 0.28;
    const ang = rnd() * Math.PI * 2;
    const cx = (0.16 + r * Math.cos(ang) * 0.7) * side;
    const cy = -0.32 + (rnd() - 0.5) * 0.18;
    const cz = -0.42 + r * Math.sin(ang) * 0.9;
    nodes.push({ x: cx, y: cy, z: cz, cat: "tool", color: "#2dd4bf", isCortical: false });
  }

  // 3. Brainstem (Central descending neural stalk)
  const BRAINSTEM_COUNT = 24;
  for (let i = 0; i < BRAINSTEM_COUNT; i++) {
    const t = i / (BRAINSTEM_COUNT - 1); // 0 at top, 1 at bottom
    const sy = -0.18 - t * 0.42;
    const sx = (rnd() - 0.5) * (0.10 - t * 0.04);
    const sz = -0.12 - t * 0.10 + (rnd() - 0.5) * 0.06;
    nodes.push({ x: sx, y: sy, z: sz, cat: "tool", color: "#2dd4bf", isCortical: false });
  }

  // 4. Generate Dense Connectome Fiber Tracts (axon pathways)
  const totalNodes = nodes.length;
  for (let i = 0; i < totalNodes; i++) {
    const nA = nodes[i];
    let connCount = 0;
    for (let j = i + 1; j < totalNodes; j++) {
      const nB = nodes[j];
      const dist = Math.hypot(nA.x - nB.x, nA.y - nB.y, nA.z - nB.z);
      const isSameCat = nA.cat === nB.cat;

      // Intra-regional tract
      if (isSameCat && dist < 0.24 && connCount < 4) {
        fibers.push({
          p0: [nA.x, nA.y, nA.z],
          p1: [nB.x, nB.y, nB.z],
          cat: nA.cat,
          color: nA.color,
        });
        connCount++;
      } else if (!isSameCat && dist < 0.30 && rnd() < 0.08) {
        // Inter-regional associative bundle
        fibers.push({
          p0: [nA.x, nA.y, nA.z],
          p1: [nB.x, nB.y, nB.z],
          cat: rnd() < 0.5 ? nA.cat : nB.cat,
          color: rnd() < 0.5 ? nA.color : nB.color,
        });
      }
    }
  }

  return { nodes, fibers };
}

const CONNECTOME_MODEL = generateAnatomicalBrain();

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

  // Track the most recent active event kind and last firing timestamp
  const firingRef = useRef<{ kind: string; time: number }>({
    kind: "reply",
    time: performance.now(),
  });
  const prevEventCountRef = useRef<number>(0);

  // Interactive 3D Orbit Camera for the Brain Viewport
  const brainCamRef = useRef({
    rotY: 0.65,
    rotX: 0.22,
    isDragging: false,
    lastX: 0,
    lastY: 0,
  });

  const fetchData = () => {
    tabAnalytics(sessionName, tabId, command, cwd, title, pid)
      .then((res) => {
        setData(res);
        statsRef.current = res.stats;

        // Detect new incoming events and trigger bright firing wave
        const count = res.stats?.total_events ?? 0;
        if (count > prevEventCountRef.current) {
          prevEventCountRef.current = count;
          const evs = res.stats?.recent_events ?? [];
          if (evs.length > 0) {
            firingRef.current = {
              kind: evs[evs.length - 1].k,
              time: performance.now(),
            };
          }
        }
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
        const radiusScale = (cssW / 2) * 0.92;

        const st = statsRef.current;
        const recentEvents = st?.recent_events ?? [];
        const activeKind = firingRef.current.kind || (recentEvents.length > 0 ? recentEvents[recentEvents.length - 1].k : "reply");

        // Firing wave: periodic action-potential rhythm (bursts every 2.4s or during live turn)
        const timeSinceFire = (performance.now() - firingRef.current.time) / 1000;
        const liveBurst = Math.max(0, 1.0 - timeSinceFire / 2.5);
        const ambientBurst = Math.sin(time * 0.003) * 0.5 + 0.5;
        const firingPower = Math.max(liveBurst, ambientBurst * 0.85);

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

        // 1. Ultra-Thin Connectome Fiber Tracts (Lines visible in their true colors!)
        ctx.lineWidth = 0.50;
        for (const fib of CONNECTOME_MODEL.fibers) {
          const p0 = project3D(fib.p0[0], fib.p0[1], fib.p0[2]);
          const p1 = project3D(fib.p1[0], fib.p1[1], fib.p1[2]);

          const avgZ = (p0.sz + p1.sz) / 2;
          const depthAlpha = Math.max(0.12, Math.min(0.85, 0.35 + avgZ * 0.28));

          const isTargeted =
            (fib.cat === "user" && activeKind === "user") ||
            (fib.cat === "think" && activeKind === "think") ||
            (fib.cat === "reply" && activeKind === "reply") ||
            (fib.cat === "tool" && (activeKind === "tool" || activeKind === "done"));

          ctx.beginPath();
          ctx.moveTo(p0.sx, p0.sy);
          ctx.lineTo(p1.sx, p1.sy);

          if (isTargeted) {
            // Firing fiber tract: bright category glow boosted by firing burst
            ctx.strokeStyle = fib.color;
            ctx.globalAlpha = Math.min(1.0, depthAlpha * (1.2 + firingPower * 1.5));
          } else {
            // Quiescent fiber tract: subtle colored anatomical fiber line
            ctx.strokeStyle = fib.color;
            ctx.globalAlpha = depthAlpha * 0.45;
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
          const isTargeted =
            (node.cat === "user" && activeKind === "user") ||
            (node.cat === "think" && activeKind === "think") ||
            (node.cat === "reply" && activeKind === "reply") ||
            (node.cat === "tool" && (activeKind === "tool" || activeKind === "done"));

          const depthAlpha = Math.max(0.25, Math.min(1.0, 0.55 + node.sz * 0.35));

          if (isTargeted) {
            // Targeted Neuron Firing: lights up radiant in category color + white core
            const pulse = (Math.sin(time * 0.012 + (node.x + node.z) * 8.0) * 0.35 + 0.65) * firingPower;
            const rGlow = Math.max(1.8, 3.8 * node.perspective * pulse);

            // Outer Radiant Aura
            ctx.beginPath();
            ctx.arc(node.sx, node.sy, rGlow, 0, Math.PI * 2);
            ctx.fillStyle = node.color;
            ctx.globalAlpha = 0.65 * depthAlpha;
            ctx.fill();

            // Gleaming Luminous Bead Core
            ctx.beginPath();
            ctx.arc(node.sx, node.sy, 1.8 * node.perspective, 0, Math.PI * 2);
            ctx.fillStyle = "#ffffff";
            ctx.globalAlpha = depthAlpha;
            ctx.fill();
          } else {
            // Quiescent neuron point: subtle pinprick colored bead
            ctx.beginPath();
            ctx.arc(node.sx, node.sy, 0.95 * node.perspective, 0, Math.PI * 2);
            ctx.fillStyle = node.color;
            ctx.globalAlpha = depthAlpha * 0.55;
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
