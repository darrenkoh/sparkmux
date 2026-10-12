import { useCallback, useEffect, useRef, useState } from "react";
import {
  tabAnalytics,
  setAnalyticsEnabled,
  clearAnalyticsData,
  type TabAnalyticsResponse,
} from "../api";
import { cliLabel } from "./artifactModel";
import {
  formatBytes,
  formatNum,
  formatMs,
  formatUsd,
  estimateCost,
  estimateTotalCost,
} from "./analyticsFormat";
import TerrainViewport from "./TerrainViewport";
import TokenSpectrumChart from "./TokenSpectrumChart";

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

export { formatBytes, formatNum, formatMs, formatUsd, estimateCost, estimateTotalCost };

const STORAGE_KEY_HUD_LEFT_WIDTH = "sparkmux_hud_left_width";
const STORAGE_KEY_HUD_TELEMETRY_SPLIT = "sparkmux_hud_telemetry_split";
const STORAGE_KEY_HUD_VIEW_MODE = "sparkmux_hud_view_mode";
const STORAGE_KEY_HUD_CENTER_ROW_HEIGHT = "sparkmux_hud_center_row_height";

function getInitialCenterRowHeight(): number {
  try {
    const val = localStorage.getItem(STORAGE_KEY_HUD_CENTER_ROW_HEIGHT);
    if (val) {
      const num = parseInt(val, 10);
      if (!isNaN(num) && num >= 140 && num <= 380) return num;
    }
  } catch {}
  return 200;
}

function getInitialViewMode(): "current" | "lifetime" {
  try {
    const val = localStorage.getItem(STORAGE_KEY_HUD_VIEW_MODE);
    if (val === "lifetime") return "lifetime";
  } catch {}
  return "current";
}

function getInitialLeftWidth(): number {
  try {
    const val = localStorage.getItem(STORAGE_KEY_HUD_LEFT_WIDTH);
    if (val) {
      const num = parseInt(val, 10);
      if (!isNaN(num) && num >= 240 && num <= 600) return num;
    }
  } catch {}
  return 340;
}

function getInitialTelemetryPercent(): number {
  try {
    const val = localStorage.getItem(STORAGE_KEY_HUD_TELEMETRY_SPLIT);
    if (val) {
      const num = parseFloat(val);
      if (!isNaN(num) && num >= 15 && num <= 65) return num;
    }
  } catch {}
  return 25;
}

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
  // Generates smooth rounded cranial proportions matching human anatomy
  const CEREBRUM_COUNT = 320;
  for (let i = 0; i < CEREBRUM_COUNT; i++) {
    // Hemispherical coordinates
    const side = i % 2 === 0 ? 1 : -1; // 1 = right, -1 = left
    const u = rnd();
    const v = rnd();
    const theta = u * Math.PI; // 0 to PI (curving over the hemisphere)
    const phi = (v * 0.90 - 0.40) * Math.PI; // -0.40*PI to 0.50*PI

    // Rounded anatomical ellipsoid radii for cerebrum
    const aX = 0.52; // Half-width per hemisphere
    const aY = 0.52; // Height
    const aZ = 0.60; // Length (anterior to posterior)

    const cosPhi = Math.cos(phi);
    let bx = Math.sin(theta) * cosPhi * aX;
    let by = Math.sin(phi) * aY + 0.08;
    let bz = Math.cos(theta) * cosPhi * aZ;

    // Longitudinal cerebral fissure separation
    bx = (Math.abs(bx) + 0.04) * side;

    // Organic Gyri & Sulci convolutions (cortical folding wrinkles)
    const sulcus =
      0.025 * Math.sin(bx * 14.0 + bz * 10.0) * Math.cos(by * 12.0) +
      0.020 * Math.sin(bz * 16.0) * Math.cos(bx * 10.0);
    bx += sulcus * 0.4;
    by += sulcus * 0.6;
    bz += sulcus * 0.4;

    // Determine category based on anatomical region
    let cat: "user" | "think" | "reply" | "tool" = "reply";
    let color = "#5b8def";

    if (by < -0.15) {
      cat = "tool";
      color = "#2dd4bf";
    } else if (bz > 0.12) {
      cat = "user";
      color = "#ff9a3c";
    } else if (by > 0.20) {
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
    const r = Math.pow(rnd(), 0.6) * 0.22;
    const ang = rnd() * Math.PI * 2;
    const cx = (0.16 + r * Math.cos(ang) * 0.7) * side;
    const cy = -0.26 + (rnd() - 0.5) * 0.12;
    const cz = -0.28 + r * Math.sin(ang) * 0.8;
    nodes.push({ x: cx, y: cy, z: cz, cat: "tool", color: "#2dd4bf", isCortical: false });
  }

  // 3. Brainstem (Central descending neural stalk)
  const BRAINSTEM_COUNT = 24;
  for (let i = 0; i < BRAINSTEM_COUNT; i++) {
    const t = i / (BRAINSTEM_COUNT - 1); // 0 at top, 1 at bottom
    const sy = -0.20 - t * 0.24;
    const sx = (rnd() - 0.5) * (0.08 - t * 0.03);
    const sz = -0.10 - t * 0.08 + (rnd() - 0.5) * 0.04;
    nodes.push({ x: sx, y: sy, z: sz, cat: "tool", color: "#2dd4bf", isCortical: false });
  }

  // Center the entire neural mesh strictly at the origin (0, 0, 0)
  // This guarantees smooth, concentric rotation without eccentric orbit or wobble
  let sumX = 0, sumY = 0, sumZ = 0;
  for (const n of nodes) {
    sumX += n.x;
    sumY += n.y;
    sumZ += n.z;
  }
  const cX = sumX / nodes.length;
  const cY = sumY / nodes.length;
  const cZ = sumZ / nodes.length;
  for (const n of nodes) {
    n.x -= cX;
    n.y -= cY;
    n.z -= cZ;
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
  const [eventFilter, setEventFilter] = useState<"all" | "turns" | "tools" | "usage">("all");

  const radarCanvasRef = useRef<HTMLCanvasElement>(null);
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
    zoom: 1.0, // default max zoom to fill the space
    isDragging: false,
    lastX: 0,
    lastY: 0,
  });

  // Resizable splitters for Left Panel Width and Telemetry / Tools vertical ratio
  const [leftWidth, setLeftWidth] = useState<number>(getInitialLeftWidth);
  const [telemetryPercent, setTelemetryPercent] = useState<number>(getInitialTelemetryPercent);
  const [centerRowHeight, setCenterRowHeight] = useState<number>(getInitialCenterRowHeight);
  const [isDraggingV, setIsDraggingV] = useState(false);
  const [isDraggingH, setIsDraggingH] = useState(false);
  const [isDraggingCenterH, setIsDraggingCenterH] = useState(false);

  const onStartDragV = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingV(true);
    const startX = e.clientX;
    const startWidth = leftWidth;
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const next = Math.max(240, Math.min(580, startWidth + delta));
      setLeftWidth(next);
      try {
        localStorage.setItem(STORAGE_KEY_HUD_LEFT_WIDTH, String(next));
      } catch {}
    };

    const onUp = () => {
      setIsDraggingV(false);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [leftWidth]);

  const onStartDragH = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingH(true);
    const startY = e.clientY;
    const leftCol = document.querySelector(".scifi-col.left") as HTMLElement | null;
    const totalHeight = leftCol ? leftCol.clientHeight : 600;
    const startPercent = telemetryPercent;
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";

    const onMove = (ev: MouseEvent) => {
      const deltaY = ev.clientY - startY;
      const deltaPercent = (deltaY / Math.max(1, totalHeight)) * 100;
      const next = Math.max(16, Math.min(65, Math.round(startPercent + deltaPercent)));
      setTelemetryPercent(next);
      try {
        localStorage.setItem(STORAGE_KEY_HUD_TELEMETRY_SPLIT, String(next));
      } catch {}
    };

    const onUp = () => {
      setIsDraggingH(false);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [telemetryPercent]);

  const onStartDragCenterH = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingCenterH(true);
    const startY = e.clientY;
    const startHeight = centerRowHeight;
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";

    const onMove = (ev: MouseEvent) => {
      // Inverted delta because dragging upward expands the bottom row
      const deltaY = startY - ev.clientY;
      const next = Math.max(140, Math.min(380, startHeight + deltaY));
      setCenterRowHeight(next);
      try {
        localStorage.setItem(STORAGE_KEY_HUD_CENTER_ROW_HEIGHT, String(next));
      } catch {}
    };

    const onUp = () => {
      setIsDraggingCenterH(false);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [centerRowHeight]);

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

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const nextZoom = brainCamRef.current.zoom * Math.exp(-e.deltaY * 0.002);
      brainCamRef.current.zoom = Math.max(0.5, Math.min(3.5, nextZoom));
    };

    const onDblClick = () => {
      brainCamRef.current.rotY = 0.65;
      brainCamRef.current.rotX = 0.22;
      brainCamRef.current.zoom = 1.0;
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDblClick);

    const render = (time: number) => {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const container = canvas.parentElement || canvas;
        const rect = container.getBoundingClientRect();
        const cssW = Math.max(1, Math.round(rect.width || canvas.clientWidth || 300));
        const cssH = Math.max(1, Math.round(rect.height || canvas.clientHeight || 300));
        const w = Math.round(cssW * dpr);
        const h = Math.round(cssH * dpr);
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        const cx = cssW / 2;
        const cy = cssH / 2;
        // Default max zoom (0.70 factor) fills ~92% of the available viewport dimension
        const currentZoom = brainCamRef.current.zoom ?? 1.0;
        const radiusScale = Math.min(cssW, cssH) * 0.70 * currentZoom;

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

          const perspective = 3.6 / (3.6 + z2);
          const sx = cx + x1 * radiusScale * perspective;
          const sy = cy - y2 * radiusScale * perspective;
          return { sx, sy, sz: z2, perspective };
        };

        // 1. Ultra-Thin Connectome Fiber Tracts (Lines visible in their true colors!)
        ctx.lineWidth = 0.70;
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
            const rGlow = Math.max(2.4, 4.8 * node.perspective * pulse);

            // Outer Radiant Aura
            ctx.beginPath();
            ctx.arc(node.sx, node.sy, rGlow, 0, Math.PI * 2);
            ctx.fillStyle = node.color;
            ctx.globalAlpha = 0.65 * depthAlpha;
            ctx.fill();

            // Gleaming Luminous Bead Core
            ctx.beginPath();
            ctx.arc(node.sx, node.sy, 2.0 * node.perspective, 0, Math.PI * 2);
            ctx.fillStyle = "#ffffff";
            ctx.globalAlpha = depthAlpha;
            ctx.fill();
          } else {
            // Quiescent neuron point: subtle pinprick colored bead
            ctx.beginPath();
            ctx.arc(node.sx, node.sy, 1.1 * node.perspective, 0, Math.PI * 2);
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
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDblClick);
    };
  }, []);



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

  const [viewMode, setViewMode] = useState<"current" | "lifetime">(getInitialViewMode);

  const handleViewMode = (mode: "current" | "lifetime") => {
    setViewMode(mode);
    try {
      localStorage.setItem(STORAGE_KEY_HUD_VIEW_MODE, mode);
    } catch {}
  };

  const isLifetime = viewMode === "lifetime";
  const st = isLifetime ? (data?.lifetime_stats ?? data?.stats) : data?.stats;
  const storage = data?.storage;

  const promptTokens = (st?.total_input_tokens ?? 0) + (st?.total_cache_read_tokens ?? 0);
  const cacheHitRate =
    promptTokens > 0
      ? ((st?.total_cache_read_tokens ?? 0) / promptTokens) * 100
      : 0;
  const estCost = estimateTotalCost(
    st?.models,
    st?.active_model,
    st?.total_input_tokens ?? 0,
    st?.total_output_tokens ?? 0,
    st?.total_cache_read_tokens ?? 0,
    st?.total_cache_write_tokens ?? 0,
  );
  const netDiff = (st?.lines_added ?? 0) - (st?.lines_removed ?? 0);

  return (
    <div className="scifi-hud-overlay" onClick={onClose}>
      <div
        className="scifi-hud-frame fullscreen"
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
            <span
              className="scifi-badge-pill events"
              title="Total raw telemetry events captured across this session"
            >
              <span className="scifi-pill-dot" />
              TOTAL EVENTS: <strong>{st?.total_events ?? 0}</strong>
            </span>
            <span
              className="scifi-badge-pill calls"
              title="Total tool executions registered"
            >
              <span className="scifi-pill-dot" />
              TOTAL CALLS: <strong>{st?.tool_calls ?? 0}</strong>
            </span>
          </div>

          <div className="scifi-controls">
            <div className="scifi-mode-group" role="group" aria-label="Telemetry Scope Mode">
              <button
                type="button"
                className={`scifi-btn scifi-mode-btn ${!isLifetime ? "on" : "off"}`}
                onClick={() => handleViewMode("current")}
                title="Current active task (starts fresh on /new)"
              >
                CURRENT TASK
              </button>
              <button
                type="button"
                className={`scifi-btn scifi-mode-btn ${isLifetime ? "on" : "off"}`}
                onClick={() => handleViewMode("lifetime")}
                title="Cumulative metrics across all sessions in this tab"
              >
                TAB CUMULATIVE
              </button>
            </div>

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
        <div
          className="scifi-content"
          style={{ gridTemplateColumns: `${leftWidth}px 8px 1fr 340px` }}
        >
          {/* LEFT COLUMN: Telemetry Radar, KPIs & Tools */}
          <aside className="scifi-col left">
            <section
              className={`scifi-panel telemetry ${telemetryPercent >= 28 ? "expanded" : ""}`}
              style={{
                flex: `0 0 ${telemetryPercent}%`,
                maxHeight: `${telemetryPercent}%`,
              }}
            >
              <header>
                <span className="tag">01</span>
                <span>NEURAL TELEMETRY</span>
                <small>SYNAPTIC REGIONS</small>
              </header>
              <div className="body">
                <div
                  className="radar"
                  title="3D Neural Arborization: Click & Drag to Orbit · User (Amber) · Think (Purple) · Reply (Blue) · Tool (Teal)"
                >
                  <canvas
                    ref={radarCanvasRef}
                    className="scifi-radar-canvas"
                  />
                  <div className="radar-hint">DRAG · ORBIT &nbsp;&nbsp; WHEEL · ZOOM &nbsp;&nbsp; DBL-CLICK · RESET</div>
                </div>
                <div className="kpis">
                  <div title="User prompts (Frontal Lobe · Amber)">
                    <small style={{ color: "#ff9a3c" }}>
                      <span
                        className="kpi-dot"
                        style={{ backgroundColor: "#ff9a3c", boxShadow: "0 0 6px #ff9a3c" }}
                      />
                      USER PROMPTS
                    </small>
                    <b style={{ color: "#ff9a3c" }}>{st?.user_prompts ?? 0}</b>
                  </div>
                  <div title="Reasoning & thinking blocks (Dorsal Cortex · Purple)">
                    <small style={{ color: "#c084fc" }}>
                      <span
                        className="kpi-dot"
                        style={{ backgroundColor: "#c084fc", boxShadow: "0 0 6px #c084fc" }}
                      />
                      THINK BLOCKS
                    </small>
                    <b style={{ color: "#c084fc" }}>
                      {st?.thinking_blocks ?? 0}
                    </b>
                  </div>
                  <div title="Model assistant replies (Temporal Cortex · Blue)">
                    <small style={{ color: "#5b8def" }}>
                      <span
                        className="kpi-dot"
                        style={{ backgroundColor: "#5b8def", boxShadow: "0 0 6px #5b8def" }}
                      />
                      MODEL REPLIES
                    </small>
                    <b style={{ color: "#5b8def" }}>
                      {st?.assistant_replies ?? 0}
                    </b>
                  </div>
                  <div title="Tool calls executed (Cerebellum & Brainstem · Teal)">
                    <small style={{ color: "#2dd4bf" }}>
                      <span
                        className="kpi-dot"
                        style={{ backgroundColor: "#2dd4bf", boxShadow: "0 0 6px #2dd4bf" }}
                      />
                      TOOL CALLS
                    </small>
                    <b style={{ color: "#2dd4bf" }}>{st?.tool_calls ?? 0}</b>
                  </div>
                </div>
              </div>
            </section>

            {/* Horizontal resize sash between Telemetry (25%) and Tools Table */}
            <div
              className={`scifi-splitter-h ${isDraggingH ? "dragging" : ""}`}
              onMouseDown={onStartDragH}
              onDoubleClick={() => {
                setTelemetryPercent(25);
                try {
                  localStorage.setItem(STORAGE_KEY_HUD_TELEMETRY_SPLIT, "25");
                } catch {}
              }}
              title="Drag to resize NEURAL TELEMETRY height (Double-click to reset to 25%)"
            />

            {/* Tools Breakdown Table */}
            <section className="scifi-panel tools-table-panel">
              <header>
                <span className="tag">02</span>
                <span>ACTIONS / TOOLS MATRIX</span>
                <small>{st?.tool_calls ?? 0} TOTAL CALLS · {st?.tools?.length ?? 0} LOGGED</small>
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

          {/* Vertical resize sash between Left Panel and Center Viewport */}
          <div
            className={`scifi-splitter-v ${isDraggingV ? "dragging" : ""}`}
            onMouseDown={onStartDragV}
            onDoubleClick={() => {
              setLeftWidth(340);
              try {
                localStorage.setItem(STORAGE_KEY_HUD_LEFT_WIDTH, "340");
              } catch {}
            }}
            title="Drag to resize Left Panel width (Double-click to reset to default)"
          />

          <main
            className="scifi-center"
            style={{ ["--hud-bottom-row-height" as any]: `${centerRowHeight}px` }}
          >
            {/* Interactive 3D Hill Terrain Viewport with Real Session Data */}
            <TerrainViewport
              timeline={st?.timeline ?? []}
              activeModel={st?.active_model}
              sessionName={sessionName}
              tabName={tabName}
              stats={st}
            />

            {/* Horizontal Splitter between 3D Area Map and Telemetry Row */}
            <div
              className={`scifi-splitter-h ${isDraggingCenterH ? "dragging" : ""}`}
              onMouseDown={onStartDragCenterH}
              onDoubleClick={() => {
                setCenterRowHeight(200);
                try {
                  localStorage.setItem(STORAGE_KEY_HUD_CENTER_ROW_HEIGHT, "200");
                } catch {}
              }}
              title="Drag to resize Section 04/05 height (Double-click to reset to 200px)"
            />

            {/* Sub-grid: Token Allocation & Context Window Gauge */}
            <div className="scifi-row">
              <section className="scifi-panel token-panel">
                <header>
                  <span className="tag">04</span>
                  <span>TOKEN SPECTRUM</span>
                  <small>CHRONO-TOPOGRAPHY</small>
                </header>
                <div className="body">
                  <TokenSpectrumChart timeline={st?.timeline ?? []} stats={st} />
                </div>
              </section>

              <section className="scifi-panel context-panel">
                <header>
                  <span className="tag">05</span>
                  <span>CACHE EFFICIENCY & CODE DELTA</span>
                  <small>SESSION ECONOMY</small>
                </header>
                <div className="body context-body">
                  <div
                    className="context-meter"
                    title={`Context Utilization: ${formatNum(st?.context_tokens_used ?? 0)} / ${formatNum(st?.context_window_tokens ?? 200_000)} tokens`}
                  >
                    <div className="meter-label">
                      <span>CACHE HIT EFFICIENCY</span>
                      <span style={{ color: "#3dd68c", fontWeight: 600 }}>
                        {cacheHitRate.toFixed(1)}% ({formatNum(st?.total_cache_read_tokens ?? 0)} CACHED)
                      </span>
                    </div>
                    <div className="meter-bar">
                      <div
                        className="meter-fill cache-fill"
                        style={{
                          width: `${Math.min(100, Math.max(0, cacheHitRate))}%`,
                        }}
                      />
                    </div>
                  </div>

                  <div className="kpis-sub">
                    <div title="Estimated session cost based on input, output & cached token rates">
                      <small>EST. COST</small>
                      <b style={{ color: "#facc15" }}>{formatUsd(estCost)}</b>
                    </div>
                    <div title="Average duration per interaction turn">
                      <small>AVG TURN TIME</small>
                      <b>{formatMs(st?.avg_turn_duration_ms ?? 0)}</b>
                    </div>
                    <div title="Lines added & removed across tool file write/patch operations">
                      <small>TOOL FILE EDITS</small>
                      <b style={{ color: "#3dd68c" }}>
                        +{st?.lines_added ?? 0} / -{st?.lines_removed ?? 0}
                        <span className="net-diff-tag">
                          ({netDiff >= 0 ? `+${netDiff}` : netDiff} net)
                        </span>
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
          <div className="scifi-foot-right">
            <span>SPARKMUX QUANTUM ANALYTICS SYSTEM · v1.0.0</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
