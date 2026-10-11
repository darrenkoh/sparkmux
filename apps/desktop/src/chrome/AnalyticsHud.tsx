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

// 18 Brain Neural Cortex Nodes matching Area Map categories and colors
const BRAIN_NODES = [
  // Frontal lobe (USER queries): Amber #ff9a3c
  { id: 0, x: -0.32, y: -0.66, cat: "user", color: "#ff9a3c" },
  { id: 1, x: 0.32, y: -0.66, cat: "user", color: "#ff9a3c" },
  { id: 2, x: -0.15, y: -0.50, cat: "user", color: "#ff9a3c" },
  { id: 3, x: 0.15, y: -0.50, cat: "user", color: "#ff9a3c" },

  // Parietal & Central lobe (THINK / reasoning): Purple #c084fc
  { id: 4, x: -0.54, y: -0.26, cat: "think", color: "#c084fc" },
  { id: 5, x: 0.54, y: -0.26, cat: "think", color: "#c084fc" },
  { id: 6, x: -0.22, y: -0.16, cat: "think", color: "#c084fc" },
  { id: 7, x: 0.22, y: -0.16, cat: "think", color: "#c084fc" },
  { id: 8, x: 0.0, y: -0.04, cat: "think", color: "#c084fc" },

  // Temporal & Occipital lobe (REPLY / assistant): Cobalt Blue #5b8def
  { id: 9, x: -0.56, y: 0.16, cat: "reply", color: "#5b8def" },
  { id: 10, x: 0.56, y: 0.16, cat: "reply", color: "#5b8def" },
  { id: 11, x: -0.28, y: 0.28, cat: "reply", color: "#5b8def" },
  { id: 12, x: 0.28, y: 0.28, cat: "reply", color: "#5b8def" },
  { id: 13, x: 0.0, y: 0.38, cat: "reply", color: "#5b8def" },

  // Cerebellum & Brainstem (TOOL executions): Teal #2dd4bf
  { id: 14, x: -0.36, y: 0.58, cat: "tool", color: "#2dd4bf" },
  { id: 15, x: 0.36, y: 0.58, cat: "tool", color: "#2dd4bf" },
  { id: 16, x: -0.16, y: 0.72, cat: "tool", color: "#2dd4bf" },
  { id: 17, x: 0.16, y: 0.72, cat: "tool", color: "#2dd4bf" },
];

const BRAIN_SYNAPSES: Array<[number, number]> = [
  // Frontal
  [0, 1], [0, 2], [1, 3], [2, 3],
  // Frontal to Parietal
  [0, 4], [1, 5], [2, 6], [3, 7],
  // Parietal internal
  [4, 6], [5, 7], [6, 8], [7, 8], [6, 7],
  // Parietal to Temporal
  [4, 9], [5, 10], [6, 11], [7, 12], [8, 13],
  // Temporal internal
  [9, 11], [10, 12], [11, 13], [12, 13],
  // Temporal to Cerebellum
  [9, 14], [10, 15], [11, 14], [12, 15], [13, 16], [13, 17],
  // Cerebellum internal
  [14, 16], [15, 17], [16, 17],
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

  // Sci-Fi Brain Neural Cortex synaptogenesis & neuron firing animation
  useEffect(() => {
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
          const scaleX = (w / 2) - 6;
          const scaleY = (h / 2) - 6;

          const st = statsRef.current;
          const recentEvents = st?.recent_events ?? [];
          const lastEventKind = recentEvents.length > 0 ? recentEvents[recentEvents.length - 1].k : null;

          // Activity factor accelerates pulse speed during busy turns
          const activityLevel = Math.min(3.0, 1.0 + (st?.total_events ?? 0) * 0.05);

          // 1. Faint Brain Hemisphere Silhouette Outline
          ctx.beginPath();
          // Left hemisphere lobe
          ctx.ellipse(cx - scaleX * 0.28, cy - scaleY * 0.08, scaleX * 0.58, scaleY * 0.76, -0.05, 0, Math.PI * 2);
          // Right hemisphere lobe
          ctx.ellipse(cx + scaleX * 0.28, cy - scaleY * 0.08, scaleX * 0.58, scaleY * 0.76, 0.05, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
          ctx.lineWidth = 1;
          ctx.stroke();

          // 2. Synaptic Edges connecting brain neurons
          ctx.lineWidth = 1.0;
          for (const [fromIdx, toIdx] of BRAIN_SYNAPSES) {
            const nA = BRAIN_NODES[fromIdx];
            const nB = BRAIN_NODES[toIdx];
            const x1 = cx + nA.x * scaleX;
            const y1 = cy + nA.y * scaleY;
            const x2 = cx + nB.x * scaleX;
            const y2 = cy + nB.y * scaleY;

            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
            ctx.stroke();
          }

          // 3. Firing Synaptic Action Potentials (Pulses traveling along neural pathways)
          const pulseCount = 14;
          for (let p = 0; p < pulseCount; p++) {
            const synIdx = (p * 3) % BRAIN_SYNAPSES.length;
            const [fromIdx, toIdx] = BRAIN_SYNAPSES[synIdx];
            const nA = BRAIN_NODES[fromIdx];
            const nB = BRAIN_NODES[toIdx];

            // Progress along the axon/synapse
            const offset = (p * 0.18 + fromIdx * 0.05);
            const progress = ((time * 0.0012 * activityLevel + offset) % 1.0);

            const x1 = cx + nA.x * scaleX;
            const y1 = cy + nA.y * scaleY;
            const x2 = cx + nB.x * scaleX;
            const y2 = cy + nB.y * scaleY;

            const px = x1 + (x2 - x1) * progress;
            const py = y1 + (y2 - y1) * progress;

            // Draw traveling synaptic pulse
            ctx.beginPath();
            ctx.arc(px, py, 1.4, 0, Math.PI * 2);
            ctx.fillStyle = nA.color;
            ctx.globalAlpha = 0.85;
            ctx.fill();
            ctx.globalAlpha = 1.0;
          }

          // 4. Brain Neurons (Hubs firing in category colors: Amber, Purple, Cobalt, Teal)
          for (const node of BRAIN_NODES) {
            const nx = cx + node.x * scaleX;
            const ny = cy + node.y * scaleY;

            // Check if this node matches the most recent active event kind
            const isFiring =
              (node.cat === "user" && lastEventKind === "user") ||
              (node.cat === "think" && lastEventKind === "think") ||
              (node.cat === "reply" && lastEventKind === "reply") ||
              (node.cat === "tool" && (lastEventKind === "tool" || lastEventKind === "done"));

            // Pulse wave oscillation
            const phase = (time * 0.0035 + node.id * 0.5) % (Math.PI * 2);
            const auraR = 3.0 + (isFiring ? 3.0 : 1.4) * Math.sin(phase);

            // Glowing Outer Aura
            ctx.beginPath();
            ctx.arc(nx, ny, Math.max(1.5, auraR), 0, Math.PI * 2);
            ctx.fillStyle = node.color;
            ctx.globalAlpha = isFiring ? 0.45 : 0.18;
            ctx.fill();

            // Core Neuron Bead
            ctx.beginPath();
            ctx.arc(nx, ny, isFiring ? 2.6 : 2.0, 0, Math.PI * 2);
            ctx.fillStyle = isFiring ? "#ffffff" : node.color;
            ctx.globalAlpha = 0.95;
            ctx.fill();
            ctx.globalAlpha = 1.0;
          }

          // 5. Central Synaptogenesis Wave Pulse (Encephalogram ripple)
          const wavePhase = (time * 0.001) % 1.0;
          const waveR = wavePhase * (Math.min(scaleX, scaleY) * 0.95);
          ctx.beginPath();
          ctx.arc(cx, cy, waveR, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(192, 132, 252, " + ((1.0 - wavePhase) * 0.25).toFixed(2) + ")";
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
        className="scifi-hud-frame"
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
                <small>SYNAPTIC CORE</small>
              </header>
              <div className="body">
                <div
                  className="radar"
                  title="Neural Cortex: User (Amber) · Think (Purple) · Reply (Blue) · Tool (Teal)"
                >
                  <canvas
                    ref={radarCanvasRef}
                    width={84}
                    height={84}
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
