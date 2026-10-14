import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import type { ActivityPoint, TabAnalyticsStats } from "../api";
import { formatNum } from "./analyticsFormat";
import {
  type TokenChartMode,
  type ChannelKey,
  type ChannelDef,
  type ProcessedBucket,
  type SpectrumSeam,
  CHANNELS,
  processTimelineData,
  perspective,
  lookAt,
  multiply,
  projectPoint,
  Z_LANES,
  X_SPAN,
  X_MIN,
  MAX_VISUAL_Y,
  getCameraProjector,
  computeContourScanProgress,
} from "./tokenSpectrumMath";

export type { TokenChartMode, ChannelKey, ChannelDef, ProcessedBucket };
export { CHANNELS };

export interface TokenSpectrumChartProps {
  timeline: ActivityPoint[];
  stats?: TabAnalyticsStats | null;
}

const STORAGE_KEY_MODE = "sparkmux_hud_token_chart_mode";

export default function TokenSpectrumChart({ timeline, stats }: TokenSpectrumChartProps) {
  const [mode, setMode] = useState<TokenChartMode>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_MODE);
      if (saved === "contour" || saved === "burst" || saved === "gauge") {
        return saved;
      }
    } catch {}
    return "contour";
  });

  const [activeChannel, setActiveChannel] = useState<ChannelKey | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverChannel, setHoverChannel] = useState<ChannelKey | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(performance.now());

  // 45° Perspective Camera State (matching Area Map Orbit)
  const cam3dRef = useRef({
    azimuth: -0.42, // ~24° orbit
    elevation: 0.62, // ~35.5° pitch
    radius: 34,
    isDragging: false,
    lastX: 0,
    lastY: 0,
  });

  const processed = useMemo(() => processTimelineData(timeline, stats), [timeline, stats]);
  const processedData = processed.buckets;
  const seams = processed.seams;

  const clearHover = useCallback(() => {
    cam3dRef.current.isDragging = false;
    setHoverIndex(null);
    setHoverChannel(null);
  }, []);

  const handleModeChange = (newMode: TokenChartMode) => {
    setMode(newMode);
    clearHover();
    try {
      localStorage.setItem(STORAGE_KEY_MODE, newMode);
    } catch {}
  };

  const toggleChannel = (key: ChannelKey) => {
    setActiveChannel((cur) => (cur === key ? null : key));
  };

  // High-DPI Canvas Rendering Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let destroyed = false;

    const render = () => {
      if (destroyed) return;
      const now = performance.now();
      const elapsed = (now - startTimeRef.current) / 1000;

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(10, Math.floor(rect.width));
      const h = Math.max(10, Math.floor(rect.height));

      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      if (mode === "gauge") {
        drawGaugeMode(ctx, w, h, stats, activeChannel);
      } else if (mode === "burst") {
        drawBurstMode(ctx, w, h, processedData, seams, activeChannel, hoverIndex);
      } else {
        draw3DContourMode(
          ctx,
          w,
          h,
          processedData,
          seams,
          activeChannel,
          hoverIndex,
          hoverChannel,
          elapsed,
          cam3dRef.current,
        );
      }

      ctx.restore();
      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      destroyed = true;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [mode, processedData, seams, stats, activeChannel, hoverIndex, hoverChannel]);

  // Pointer event handlers for 3D contour orbit and crosshair inspection
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode === "contour") {
      cam3dRef.current.isDragging = true;
      cam3dRef.current.lastX = e.clientX;
      cam3dRef.current.lastY = e.clientY;
    }
  }, [mode]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (mode === "contour" && cam3dRef.current.isDragging) {
        const dx = e.clientX - cam3dRef.current.lastX;
        const dy = e.clientY - cam3dRef.current.lastY;
        cam3dRef.current.lastX = e.clientX;
        cam3dRef.current.lastY = e.clientY;

        cam3dRef.current.azimuth -= dx * 0.007;
        cam3dRef.current.elevation = Math.max(0.12, Math.min(1.4, cam3dRef.current.elevation + dy * 0.006));
        return;
      }

      if (mode === "gauge" || processedData.length === 0) {
        setHoverIndex(null);
        setHoverChannel(null);
        return;
      }

      const rect = e.currentTarget.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;

      // Clear immediately if cursor is outside viewport boundaries
      if (clientX < 0 || clientX > rect.width || clientY < 0 || clientY > rect.height) {
        setHoverIndex(null);
        setHoverChannel(null);
        return;
      }

      if (mode === "contour") {
        const projector = getCameraProjector(rect.width, rect.height, cam3dRef.current);
        let closestDist = Infinity;
        let bestIdx: number | null = null;
        let bestChan: ChannelKey | null = null;

        const n = processedData.length;
        if (n >= 1) {
          let maxAltitude = 1;
          for (const d of processedData) {
            maxAltitude = Math.max(maxAltitude, d.cache, d.input, d.reasoning, d.output);
          }
          maxAltitude = Math.max(50, Math.ceil(maxAltitude * 1.15));

          for (let i = 0; i < n; i++) {
            const x = X_MIN + processedData[i].xFraction * X_SPAN;
            for (const ch of CHANNELS) {
              if (activeChannel && activeChannel !== ch.key) continue;
              const val = processedData[i][ch.key];
              const y = (val / maxAltitude) * MAX_VISUAL_Y;
              const z = Z_LANES[ch.key];
              const pt = projector([x, y, z]);
              if (pt) {
                const dist = Math.hypot(clientX - pt[0], clientY - pt[1]);
                if (dist < closestDist) {
                  closestDist = dist;
                  bestIdx = i;
                  bestChan = ch.key;
                }
              }
            }
          }
        }

        // Proximity threshold: lock-on if within 46px, otherwise dismiss popup immediately
        if (closestDist <= 46 && bestIdx !== null && bestChan !== null) {
          setHoverIndex(bestIdx);
          setHoverChannel(bestChan);
        } else {
          setHoverIndex(null);
          setHoverChannel(null);
        }
      } else {
        const padLeft = 54;
        const padRight = 16;
        const plotW = Math.max(1, rect.width - padLeft - padRight);
        if (clientX < padLeft || clientX > rect.width - padRight) {
          setHoverIndex(null);
          setHoverChannel(null);
          return;
        }
        const ratio = Math.max(0, Math.min(1, (clientX - padLeft) / plotW));
        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < processedData.length; i++) {
          const dist = Math.abs(processedData[i].xFraction - ratio);
          if (dist < bestDist) {
            best = i;
            bestDist = dist;
          }
        }
        setHoverIndex(processedData.length > 0 ? best : null);
        setHoverChannel(null);
      }
    },
    [mode, processedData, activeChannel],
  );

  const onPointerUp = useCallback(() => {
    cam3dRef.current.isDragging = false;
  }, []);

  const onDoubleClick = useCallback(() => {
    if (mode === "contour") {
      cam3dRef.current.azimuth = -0.42;
      cam3dRef.current.elevation = 0.62;
    }
  }, [mode]);

  const hoveredBucket = hoverIndex !== null && processedData[hoverIndex] ? processedData[hoverIndex] : null;

  return (
    <div className="token-spectrum-root" ref={containerRef} onPointerLeave={clearHover}>
      {/* Sci-Fi Header Toolbar */}
      <div className="token-chart-toolbar">
        <div className="token-chart-modes">
          <button
            type="button"
            className={mode === "contour" ? "on" : ""}
            onClick={() => handleModeChange("contour")}
            title="3D topographical contour elevation relief with orbital camera"
          >
            3D CONTOUR
          </button>
          <button
            type="button"
            className={mode === "burst" ? "on" : ""}
            onClick={() => handleModeChange("burst")}
            title="Interval token pulse velocity"
          >
            BURST
          </button>
          <button
            type="button"
            className={mode === "gauge" ? "on" : ""}
            onClick={() => handleModeChange("gauge")}
            title="Circular distribution arc gauge"
          >
            ARC GAUGE
          </button>
        </div>

        <div className="token-chart-telemetry-tag">
          <span className="spec-label">[0x04-SPEC]</span>
          <span className="status-blink">● LIVE</span>
        </div>
      </div>

      {/* Main Canvas Viewport */}
      <div className="token-chart-viewport" onPointerLeave={clearHover}>
        <canvas
          ref={canvasRef}
          className="token-spectrum-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={clearHover}
          onDoubleClick={onDoubleClick}
        />

        {/* Hover Holographic Tooltip HUD */}
        {hoveredBucket && mode !== "gauge" && (
          <div
            className="token-hud-tooltip"
            style={{
              left: `${Math.min(82, Math.max(18, hoveredBucket.xFraction * 100))}%`,
            }}
          >
            <div className="hud-tooltip-header">
              <span className="time-tag">{hoveredBucket.timeLabel}</span>
              {hoverChannel && (
                <span
                  className="active-chan-tag"
                  style={{
                    color: CHANNELS.find((c) => c.key === hoverChannel)?.color,
                    fontWeight: 700,
                    fontSize: "9px",
                    letterSpacing: "0.05em",
                  }}
                >
                  TARGET: {hoverChannel.toUpperCase()}
                </span>
              )}
              <span className="total-tag">{formatNum(hoveredBucket.total)} TOKENS</span>
            </div>
            <div className="hud-tooltip-grid">
              <div className="item" style={{ color: "#ff9a3c" }}>
                <span>CACHE:</span>
                <b>{formatNum(hoveredBucket.cache)}</b>
              </div>
              <div className="item" style={{ color: "#5b8def" }}>
                <span>INPUT:</span>
                <b>{formatNum(hoveredBucket.input)}</b>
              </div>
              <div className="item" style={{ color: "#c084fc" }}>
                <span>RSNG:</span>
                <b>{formatNum(hoveredBucket.reasoning)}</b>
              </div>
              <div className="item" style={{ color: "#3dd68c" }}>
                <span>OUTPUT:</span>
                <b>{formatNum(hoveredBucket.output)}</b>
              </div>
            </div>
            <div className="hud-tooltip-footer">
              <span>CACHE HIT EFFICIENCY:</span>
              <b style={{ color: hoveredBucket.cacheHitRate > 50 ? "#3dd68c" : "#ff9a3c" }}>
                {hoveredBucket.cacheHitRate.toFixed(1)}%
              </b>
            </div>
          </div>
        )}
      </div>

      {/* Interactive Channel Legend Pills */}
      <div className="token-legend-pills">
        {CHANNELS.map((ch) => {
          let count = 0;
          if (stats) {
            if (ch.key === "cache") count = stats.total_cache_read_tokens ?? 0;
            if (ch.key === "input") count = stats.total_input_tokens ?? 0;
            if (ch.key === "reasoning") count = stats.total_reasoning_tokens ?? 0;
            if (ch.key === "output") count = stats.total_output_tokens ?? 0;
          }
          const isSelected = activeChannel === ch.key;
          const isFaded = activeChannel !== null && !isSelected;

          return (
            <button
              key={ch.key}
              type="button"
              className={`token-legend-pill ${isSelected ? "selected" : ""} ${isFaded ? "faded" : ""}`}
              onClick={() => toggleChannel(ch.key)}
              title={`Click to isolate ${ch.label} channel`}
            >
              <span className="dot" style={{ backgroundColor: ch.color, boxShadow: `0 0 6px ${ch.color}` }} />
              <span className="name">{ch.tag}</span>
              <span className="val">{formatNum(count)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Canvas Drawing: 3D Topographical Contour Elevation Mode
// ---------------------------------------------------------------------------

function draw3DContourMode(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: ProcessedBucket[],
  seams: SpectrumSeam[],
  activeChannel: ChannelKey | null,
  hoverIndex: number | null,
  hoverChannel: ChannelKey | null,
  elapsed: number,
  cam: { azimuth: number; elevation: number; radius: number },
) {
  const eyeX = cam.radius * Math.cos(cam.elevation) * Math.sin(cam.azimuth);
  const eyeY = cam.radius * Math.sin(cam.elevation);
  const eyeZ = cam.radius * Math.cos(cam.elevation) * Math.cos(cam.azimuth);

  const matProj = perspective((38 * Math.PI) / 180, w / h, 0.5, 200);
  const matView = lookAt([eyeX, eyeY, eyeZ], [0, 1.2, 0]);
  const matVP = multiply(matProj, matView);
  const project = (p: [number, number, number]) => projectPoint(matVP, p, w, h);

  const xSpan = X_SPAN;
  const xMin = X_MIN;
  const xMax = xMin + xSpan;
  const zLanes = Z_LANES;

  let maxAltitude = 1;
  for (const d of data) {
    if (activeChannel) {
      maxAltitude = Math.max(maxAltitude, d[activeChannel]);
    } else {
      maxAltitude = Math.max(maxAltitude, d.cache, d.input, d.reasoning, d.output);
    }
  }
  maxAltitude = Math.max(50, Math.ceil(maxAltitude * 1.15));
  const maxVisualY = MAX_VISUAL_Y;
  // Synchronized chronological scan sweep progress across time [0, 1)
  const sweepFrac = computeContourScanProgress(elapsed);
  const sweepX = xMin + sweepFrac * xSpan;

  // 1. Draw 3D Base Matrix Platform Grid (Razor-thin 0.6px lines with holographic crosses)
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.lineWidth = 0.6;

  // Longitudinal channel lanes along X
  const allLanes = [-6.0, -4.5, -1.5, 1.5, 4.5, 6.0];
  for (const z of allLanes) {
    const p0 = project([xMin, 0, z]);
    const p1 = project([xMax, 0, z]);
    if (p0 && p1) {
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.stroke();
    }
  }

  // Transverse time steps across X
  const numGridSteps = 12;
  for (let s = 0; s <= numGridSteps; s++) {
    const gx = xMin + (s / numGridSteps) * xSpan;
    const p0 = project([gx, 0, -6.0]);
    const p1 = project([gx, 0, 6.0]);
    if (p0 && p1) {
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.stroke();
    }
  }

  // Grid intersection holographic tick marks (+)
  ctx.strokeStyle = "rgba(255, 154, 60, 0.25)";
  ctx.lineWidth = 0.6;
  for (let s = 0; s <= numGridSteps; s += 2) {
    const gx = xMin + (s / numGridSteps) * xSpan;
    for (const z of [-4.5, -1.5, 1.5, 4.5]) {
      const gp = project([gx, 0, z]);
      if (gp) {
        ctx.beginPath();
        ctx.moveTo(gp[0] - 2.5, gp[1]);
        ctx.lineTo(gp[0] + 2.5, gp[1]);
        ctx.moveTo(gp[0], gp[1] - 2.5);
        ctx.lineTo(gp[0], gp[1] + 2.5);
        ctx.stroke();
      }
    }
  }

  // Base platform outer perimeter box
  ctx.strokeStyle = "rgba(255, 154, 60, 0.35)";
  ctx.lineWidth = 0.8;
  const c0 = project([xMin, 0, -6.0]);
  const c1 = project([xMax, 0, -6.0]);
  const c2 = project([xMax, 0, 6.0]);
  const c3 = project([xMin, 0, 6.0]);
  if (c0 && c1 && c2 && c3) {
    ctx.beginPath();
    ctx.moveTo(c0[0], c0[1]);
    ctx.lineTo(c1[0], c1[1]);
    ctx.lineTo(c2[0], c2[1]);
    ctx.lineTo(c3[0], c3[1]);
    ctx.closePath();
    ctx.stroke();
  }

  // Lane Labels on the left edge in 3D
  ctx.textAlign = "right";
  CHANNELS.forEach((ch) => {
    const isSelected = activeChannel === ch.key || hoverChannel === ch.key;
    const isFaded =
      (activeChannel !== null && activeChannel !== ch.key) ||
      (hoverChannel !== null && hoverChannel !== ch.key && activeChannel === null);
    const z = zLanes[ch.key];
    const pt = project([xMin - 0.5, 0, z]);
    if (pt) {
      ctx.fillStyle = isFaded ? "rgba(255, 255, 255, 0.22)" : ch.color;
      ctx.font = isSelected
        ? "bold 10px ui-monospace, SFMono-Regular, Menlo, monospace"
        : "9.5px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillText(`[${ch.tag}] ${ch.label}`, pt[0] - 6, pt[1] + 3);
    }
  });

  // Time Axis text along the front
  const tStart = project([xMin, 0, 6.6]);
  const tEnd = project([xMax, 0, 6.6]);
  if (tStart && tEnd) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
    ctx.font = "9.5px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.fillText("◄ T0 (START)", tStart[0], tStart[1]);
    ctx.textAlign = "right";
    ctx.fillText("LATEST ►", tEnd[0], tEnd[1]);
  }
  ctx.fillStyle = "#ff9a3c";
  ctx.font = "9.5px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  for (const seam of seams) {
    const seamX = xMin + seam.fraction * xSpan;
    const pt = project([seamX, 0, 6.6]);
    if (!pt) continue;
    ctx.fillText(seam.label, pt[0], pt[1] - 12);
  }
  ctx.restore();

  const n = data.length;

  // 2. Cyber Matrix Terrain Mesh: Cross-Channel Transverse Wireframe Ribs
  if (n >= 2 && !activeChannel) {
    ctx.save();
    ctx.lineWidth = 0.65;
    ctx.strokeStyle = "rgba(120, 200, 255, 0.16)";
    const meshStep = Math.max(1, Math.floor(n / 14));
    for (let i = 0; i < n; i += meshStep) {
      const x = xMin + data[i].xFraction * xSpan;
      ctx.beginPath();
      let firstMesh = false;
      for (const ch of CHANNELS) {
        const z = zLanes[ch.key];
        const val = data[i][ch.key];
        const y = (val / maxAltitude) * maxVisualY;
        const pt = project([x, y, z]);
        if (!pt) continue;
        if (!firstMesh) {
          ctx.moveTo(pt[0], pt[1]);
          firstMesh = true;
        } else {
          ctx.lineTo(pt[0], pt[1]);
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // 3. Draw 3D Topographical Ridge Curtains
  const sortedChannels = [...CHANNELS].sort((a, b) => {
    const distA = Math.hypot(eyeX, eyeY, eyeZ - zLanes[a.key]);
    const distB = Math.hypot(eyeX, eyeY, eyeZ - zLanes[b.key]);
    return distB - distA;
  });

  if (n >= 2) {
    sortedChannels.forEach((ch) => {
      const isSelected = activeChannel === ch.key || hoverChannel === ch.key;
      const isFaded = activeChannel !== null && !isSelected;
      if (isFaded) return;

      const z = zLanes[ch.key];

      const topPts: Array<[number, number, number] | null> = [];
      const botPts: Array<[number, number, number] | null> = [];

      for (let i = 0; i < n; i++) {
        const x = xMin + data[i].xFraction * xSpan;
        const val = data[i][ch.key];
        const y = (val / maxAltitude) * maxVisualY;

        topPts.push(project([x, y, z]));
        botPts.push(project([x, 0, z]));
      }

      // 3A. Vertical Ribbon Curtain Drop (fading downward to baseline)
      ctx.save();
      ctx.beginPath();
      let firstValid = false;

      for (let i = 0; i < n; i++) {
        const pt = topPts[i];
        if (!pt) continue;
        if (!firstValid) {
          ctx.moveTo(pt[0], pt[1]);
          firstValid = true;
        } else {
          ctx.lineTo(pt[0], pt[1]);
        }
      }

      for (let i = n - 1; i >= 0; i--) {
        const pt = botPts[i];
        if (pt) ctx.lineTo(pt[0], pt[1]);
      }
      ctx.closePath();

      ctx.fillStyle = ch.bgGradient;
      ctx.fill();

      // 3B. Transverse vertical struts (thin 0.6px lines)
      ctx.strokeStyle = ch.color;
      ctx.globalAlpha = 0.2;
      ctx.lineWidth = 0.6;
      const step = Math.max(1, Math.floor(n / 20));
      for (let i = 0; i < n; i += step) {
        const tP = topPts[i];
        const bP = botPts[i];
        if (tP && bP) {
          ctx.beginPath();
          ctx.moveTo(tP[0], tP[1]);
          ctx.lineTo(bP[0], bP[1]);
          ctx.stroke();
        }
      }

      // 3C. 3D Elevation Iso-Contours (topographical height tiers at 25%, 50%, 75%)
      const contourTiers = [0.25, 0.5, 0.75];
      ctx.strokeStyle = ch.color;
      ctx.lineWidth = 0.75;
      for (const tier of contourTiers) {
        ctx.globalAlpha = 0.32;
        ctx.beginPath();
        let startedContour = false;
        for (let i = 0; i < n; i++) {
          const val = data[i][ch.key];
          const y = (val / maxAltitude) * maxVisualY * tier;
          if (y < 0.04) continue;
          const x = xMin + data[i].xFraction * xSpan;
          const pt = project([x, y, z]);
          if (!pt) continue;
          if (!startedContour) {
            ctx.moveTo(pt[0], pt[1]);
            startedContour = true;
          } else {
            ctx.lineTo(pt[0], pt[1]);
          }
        }
        ctx.stroke();
      }

      // 3D. Glowing Top Ridge Crest (Thinned to 0.95px / 1.4px)
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = ch.color;
      ctx.shadowColor = ch.glow;
      ctx.shadowBlur = isSelected ? 10 : 5;
      ctx.lineWidth = isSelected ? 1.4 : 0.95;

      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const pt = topPts[i];
        if (!pt) continue;
        if (!started) {
          ctx.moveTo(pt[0], pt[1]);
          started = true;
        } else {
          ctx.lineTo(pt[0], pt[1]);
        }
      }
      ctx.stroke();

      // 3E. Glowing Crest Core Beads on Non-Zero Points (thin 1.8px)
      ctx.shadowBlur = 0;
      for (let i = 0; i < n; i++) {
        const pt = topPts[i];
        if (!pt || data[i][ch.key] === 0) continue;
        ctx.beginPath();
        ctx.arc(pt[0], pt[1], 1.8, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
      }

      // 3F. Bioluminescent Energy Pulse Surging Along Ridge Crest (synchronized with 3D scan sweep line)
      const pulsePhase = sweepFrac;
      let pIdx = 0;
      for (let i = 0; i < n - 1; i++) {
        if (data[i + 1].xFraction >= pulsePhase) {
          pIdx = i;
          break;
        }
        pIdx = i;
      }
      const pNext = Math.min(n - 1, pIdx + 1);
      const spanFrac = data[pNext].xFraction - data[pIdx].xFraction;
      const sub = spanFrac <= 0 ? 0 : (pulsePhase - data[pIdx].xFraction) / spanFrac;
      const xPulse = sweepX;
      const valPulse = data[pIdx][ch.key] * (1 - sub) + data[pNext][ch.key] * sub;
      const yPulse = (valPulse / maxAltitude) * maxVisualY;
      const pulsePt = project([xPulse, yPulse, z]);

      if (pulsePt && (yPulse > 0.04 || valPulse > 0)) {
        ctx.shadowColor = ch.glow;
        ctx.shadowBlur = 12;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(pulsePt[0], pulsePt[1], 2.4, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = ch.color;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(pulsePt[0], pulsePt[1], 5.0, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    });
  }

  // 4. 3D Laser Scan Sweep Line across time + Spark Dust
  const swP0 = project([sweepX, 0, -5.5]);
  const swP1 = project([sweepX, 0, 5.5]);
  const swTop = project([sweepX, maxVisualY * 1.02, 0]);

  if (swP0 && swP1) {
    ctx.save();
    ctx.strokeStyle = "rgba(255, 154, 60, 0.75)";
    ctx.lineWidth = 0.9;
    ctx.shadowColor = "#ff9a3c";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(swP0[0], swP0[1]);
    ctx.lineTo(swP1[0], swP1[1]);
    ctx.stroke();

    if (swTop) {
      ctx.fillStyle = "rgba(255, 154, 60, 0.1)";
      ctx.beginPath();
      ctx.moveTo(swP0[0], swP0[1]);
      ctx.lineTo(swTop[0], swTop[1]);
      ctx.lineTo(swP1[0], swP1[1]);
      ctx.closePath();
      ctx.fill();
    }

    // Floating spark particles rising along sweep plane
    for (let p = 0; p < 4; p++) {
      const pPhase = (elapsed * 1.4 + p * 0.25) % 1.0;
      const pY = pPhase * maxVisualY * 0.85;
      const pZ = -4.5 + ((p * 2.8 + elapsed * 1.2) % 9.0);
      const spPt = project([sweepX, pY, pZ]);
      if (spPt) {
        ctx.fillStyle = `rgba(255, 190, 80, ${1 - pPhase})`;
        ctx.beginPath();
        ctx.arc(spPt[0], spPt[1], 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // 5. Direct Node Lock-on Tactical Reticle on the EXACT Hovered Node
  if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < n) {
    const hX = xMin + data[hoverIndex].xFraction * xSpan;
    const d = data[hoverIndex];

    // Determine target channel: prefer hoverChannel if detected, else channel with highest value
    let targetChan: ChannelKey = hoverChannel ?? "cache";
    if (!hoverChannel) {
      let maxV = -1;
      CHANNELS.forEach((c) => {
        if (d[c.key] > maxV) {
          maxV = d[c.key];
          targetChan = c.key;
        }
      });
    }

    const ch = CHANNELS.find((c) => c.key === targetChan)!;
    const z = zLanes[targetChan];
    const val = d[targetChan];
    const peakY = (val / maxAltitude) * maxVisualY;

    const basePt = project([hX, 0, z]);
    const nodePt = project([hX, peakY, z]);
    const topPinPt = project([hX, peakY + 0.9, z]);

    if (basePt && nodePt) {
      ctx.save();

      // 5A. Ground waypoint radar ellipse
      ctx.strokeStyle = ch.color;
      ctx.lineWidth = 0.8;
      ctx.shadowColor = ch.glow;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.ellipse(basePt[0], basePt[1], 6, 3, 0, 0, Math.PI * 2);
      ctx.stroke();

      // 5B. Razor-thin vertical altitude drop line (dashed 2,2)
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      ctx.lineWidth = 0.75;
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(basePt[0], basePt[1]);
      ctx.lineTo(nodePt[0], nodePt[1]);
      ctx.stroke();
      ctx.setLineDash([]);

      // 5C. Laser pin antenna to beacon point
      if (topPinPt) {
        ctx.strokeStyle = ch.color;
        ctx.lineWidth = 0.85;
        ctx.shadowColor = ch.glow;
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.moveTo(nodePt[0], nodePt[1]);
        ctx.lineTo(topPinPt[0], topPinPt[1]);
        ctx.stroke();
      }

      // 5D. Tactical Holographic Lock-on Reticle around Node
      const reticleAngle = elapsed * 2.2;
      const reticleR = 8.5;

      ctx.strokeStyle = ch.color;
      ctx.lineWidth = 1.0;
      ctx.shadowColor = ch.glow;
      ctx.shadowBlur = 8;

      // Rotating 4-corner targeting brackets
      for (let k = 0; k < 4; k++) {
        const a = reticleAngle + (k * Math.PI) / 2;
        ctx.beginPath();
        ctx.arc(nodePt[0], nodePt[1], reticleR, a - 0.25, a + 0.25);
        ctx.stroke();
      }

      // Cardinal crosshair ticks
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2;
        const tx0 = nodePt[0] + Math.cos(a) * (reticleR + 2);
        const ty0 = nodePt[1] + Math.sin(a) * (reticleR + 2);
        const tx1 = nodePt[0] + Math.cos(a) * (reticleR + 5);
        const ty1 = nodePt[1] + Math.sin(a) * (reticleR + 5);
        ctx.beginPath();
        ctx.moveTo(tx0, ty0);
        ctx.lineTo(tx1, ty1);
        ctx.stroke();
      }

      // Glowing core node bead
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(nodePt[0], nodePt[1], 2.2, 0, Math.PI * 2);
      ctx.fill();

      // 5E. Floating Holographic Data Callout Pill
      const tagText = `[${ch.tag}: ${formatNum(val)}]`;
      ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
      const tm = ctx.measureText(tagText);
      const tagX = nodePt[0] + 14;
      const tagY = nodePt[1] - 6;

      ctx.fillStyle = "rgba(10, 14, 20, 0.88)";
      ctx.fillRect(tagX - 3, tagY - 9, tm.width + 6, 12);
      ctx.strokeStyle = ch.color;
      ctx.lineWidth = 0.7;
      ctx.strokeRect(tagX - 3, tagY - 9, tm.width + 6, 12);

      ctx.fillStyle = ch.color;
      ctx.fillText(tagText, tagX, tagY);

      ctx.restore();
    }
  }

  // 6. Camera Control Hint
  ctx.save();
  ctx.font = "9.5px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "rgba(255, 255, 255, 0.38)";
  ctx.textAlign = "left";
  ctx.fillText("DRAG · 3D ORBIT   DBL-CLICK · RESET", 14, h - 8);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Canvas Drawing: Burst Velocity Mode
// ---------------------------------------------------------------------------

function drawBurstMode(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: ProcessedBucket[],
  seams: SpectrumSeam[],
  activeChannel: ChannelKey | null,
  hoverIndex: number | null,
) {
  const padL = 54;
  const padR = 16;
  const padT = 12;
  const padB = 24;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, h - padT - padB);

  let maxAltitude = 1;
  for (const d of data) {
    if (activeChannel) {
      maxAltitude = Math.max(maxAltitude, d[activeChannel]);
    } else {
      maxAltitude = Math.max(maxAltitude, d.cache, d.input, d.reasoning, d.output);
    }
  }
  maxAltitude = Math.max(100, Math.ceil(maxAltitude * 1.15));

  drawGridAndContours(ctx, padL, padT, plotW, plotH, maxAltitude, data, seams);

  const n = data.length;
  if (n === 0) return;

  data.forEach((d, i) => {
    const prev = i > 0 ? data[i - 1].xFraction : d.xFraction;
    const next = i < n - 1 ? data[i + 1].xFraction : d.xFraction;
    const slot = Math.max(d.xFraction - prev, next - d.xFraction, 1 / n) * plotW;
    const barW = Math.max(2, Math.min(slot * 0.72, plotW / 8));
    const x = Math.min(padL + plotW - barW, Math.max(padL, padL + d.xFraction * plotW - barW / 2));
    const isHovered = hoverIndex === i;

    if (activeChannel) {
      const val = d[activeChannel];
      const ch = CHANNELS.find((c) => c.key === activeChannel)!;
      const barH = (val / maxAltitude) * plotH;
      const y = padT + plotH - barH;

      ctx.fillStyle = isHovered ? "#fff" : ch.color;
      ctx.fillRect(x, y, barW, barH);
    } else {
      const segments = [
        { val: d.cache, color: CHANNELS[0].color },
        { val: d.input, color: CHANNELS[1].color },
        { val: d.reasoning, color: CHANNELS[2].color },
        { val: d.output, color: CHANNELS[3].color },
      ];

      const subW = Math.max(1, (barW - 3) / 4);
      segments.forEach((seg, sIdx) => {
        const segH = (seg.val / maxAltitude) * plotH;
        const segY = padT + plotH - segH;
        const segX = x + sIdx * subW;

        ctx.fillStyle = isHovered ? "#fff" : seg.color;
        ctx.fillRect(segX, segY, subW - 0.5, segH);
      });
    }
  });

  ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Canvas Drawing: Arc Gauge Mode
// ---------------------------------------------------------------------------

function drawGaugeMode(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  stats: TabAnalyticsStats | null | undefined,
  activeChannel: ChannelKey | null,
) {
  const cx = w / 2;
  const cy = h / 2 - 4;
  const r = Math.min(cx, cy) - 16;

  const cache = stats?.total_cache_read_tokens ?? 0;
  const input = stats?.total_input_tokens ?? 0;
  const reasoning = stats?.total_reasoning_tokens ?? 0;
  const output = stats?.total_output_tokens ?? 0;
  const total = cache + input + reasoning + output;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 9;
  ctx.stroke();

  if (total === 0) {
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ctx.textAlign = "center";
    ctx.fillText("NO TELEMETRY", cx, cy + 3);
    return;
  }

  const segments = [
    { key: "cache", val: cache, color: "#ff9a3c" },
    { key: "input", val: input, color: "#5b8def" },
    { key: "reasoning", val: reasoning, color: "#c084fc" },
    { key: "output", val: output, color: "#3dd68c" },
  ];

  let start = -Math.PI / 2;
  ctx.lineWidth = 10;

  for (const seg of segments) {
    if (seg.val <= 0) continue;
    const angle = (seg.val / total) * Math.PI * 2;
    const isSelected = activeChannel === seg.key;
    const isFaded = activeChannel !== null && !isSelected;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + angle);
    ctx.strokeStyle = isFaded ? "rgba(255, 255, 255, 0.12)" : seg.color;
    if (isSelected) {
      ctx.shadowColor = seg.color;
      ctx.shadowBlur = 10;
      ctx.lineWidth = 12;
    }
    ctx.stroke();
    ctx.restore();

    start += angle;
  }

  ctx.save();
  ctx.font = "14px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.fillText(formatNum(total), cx, cy + 1);

  ctx.font = "8.5px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
  ctx.fillText("TOTAL TOKENS", cx, cy + 13);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Helpers: Topographical Elevation Grid & Splines
// ---------------------------------------------------------------------------

function drawGridAndContours(
  ctx: CanvasRenderingContext2D,
  padL: number,
  padT: number,
  plotW: number,
  plotH: number,
  maxAltitude: number,
  data: ProcessedBucket[],
  seams: SpectrumSeam[],
) {
  ctx.save();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  ctx.strokeRect(padL, padT, plotW, plotH);

  const steps = 4;
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "right";

  for (let i = 0; i <= steps; i++) {
    const y = padT + (i / steps) * plotH;
    const val = Math.round(maxAltitude * (1 - i / steps));

    ctx.strokeStyle = i === steps ? "rgba(255, 255, 255, 0.2)" : "rgba(255, 255, 255, 0.05)";
    ctx.setLineDash(i === steps ? [] : [3, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
    ctx.fillText(`${formatNum(val)}`, padL - 6, y + 3);
  }

  ctx.setLineDash([]);
  ctx.textAlign = "center";
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  if (data.length > 0) {
    const tickCount = Math.min(5, data.length);
    for (let i = 0; i < tickCount; i++) {
      const fraction = tickCount === 1 ? data[0].xFraction : i / (tickCount - 1);
      let dataIdx = 0;
      let bestDist = Infinity;
      for (let p = 0; p < data.length; p++) {
        const dist = Math.abs(data[p].xFraction - fraction);
        if (dist < bestDist) {
          bestDist = dist;
          dataIdx = p;
        }
      }
      const x = padL + data[dataIdx].xFraction * plotW;
      const label = data[dataIdx]?.timeLabel ?? "";

      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.beginPath();
      ctx.moveTo(x, padT + plotH);
      ctx.lineTo(x, padT + plotH + 4);
      ctx.stroke();

      ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
      ctx.fillText(label, x, padT + plotH + 15);
    }
  }

  ctx.fillStyle = "#ff9a3c";
  for (const seam of seams) {
    const x = padL + seam.fraction * plotW;
    ctx.fillText(seam.label, x, padT + plotH - 6);
  }

  ctx.restore();
}

