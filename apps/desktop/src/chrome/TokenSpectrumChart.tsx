import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import type { ActivityPoint, TabAnalyticsStats } from "../api";
import { formatNum } from "./analyticsFormat";
import {
  type TokenChartMode,
  type ChannelKey,
  type ChannelDef,
  type ProcessedBucket,
  CHANNELS,
  processTimelineData,
  perspective,
  lookAt,
  multiply,
  projectPoint,
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
      if (saved === "perspective" || saved === "contour" || saved === "burst" || saved === "gauge") {
        return saved;
      }
    } catch {}
    return "perspective";
  });

  const [activeChannel, setActiveChannel] = useState<ChannelKey | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

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

  const processedData = useMemo(() => {
    return processTimelineData(timeline, stats);
  }, [timeline, stats]);

  const handleModeChange = (newMode: TokenChartMode) => {
    setMode(newMode);
    setHoverIndex(null);
    cam3dRef.current.isDragging = false;
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

      if (mode === "perspective") {
        drawPerspectiveMode(ctx, w, h, processedData, activeChannel, hoverIndex, elapsed, cam3dRef.current);
      } else if (mode === "gauge") {
        drawGaugeMode(ctx, w, h, stats, activeChannel);
      } else if (mode === "burst") {
        drawBurstMode(ctx, w, h, processedData, activeChannel, hoverIndex);
      } else {
        drawContourMode(ctx, w, h, processedData, activeChannel, hoverIndex, elapsed);
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
  }, [mode, processedData, stats, activeChannel, hoverIndex]);

  // Pointer event handlers for 45° orbit and crosshair inspection
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode === "perspective") {
      cam3dRef.current.isDragging = true;
      cam3dRef.current.lastX = e.clientX;
      cam3dRef.current.lastY = e.clientY;
    }
  }, [mode]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (mode === "perspective" && cam3dRef.current.isDragging) {
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
        return;
      }

      const rect = e.currentTarget.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const padLeft = mode === "perspective" ? 40 : 54;
      const padRight = 20;
      const plotW = Math.max(1, rect.width - padLeft - padRight);

      const ratio = Math.max(0, Math.min(1, (clientX - padLeft) / plotW));
      const idx = Math.round(ratio * (processedData.length - 1));
      setHoverIndex(idx >= 0 && idx < processedData.length ? idx : null);
    },
    [mode, processedData],
  );

  const onPointerUp = useCallback(() => {
    cam3dRef.current.isDragging = false;
  }, []);

  const onPointerLeave = useCallback(() => {
    cam3dRef.current.isDragging = false;
    setHoverIndex(null);
  }, []);

  const onDoubleClick = useCallback(() => {
    if (mode === "perspective") {
      cam3dRef.current.azimuth = -0.42;
      cam3dRef.current.elevation = 0.62;
    }
  }, [mode]);

  const hoveredBucket = hoverIndex !== null && processedData[hoverIndex] ? processedData[hoverIndex] : null;

  return (
    <div className="token-spectrum-root" ref={containerRef}>
      {/* Sci-Fi Header Toolbar */}
      <div className="token-chart-toolbar">
        <div className="token-chart-modes">
          <button
            type="button"
            className={mode === "perspective" ? "on" : ""}
            onClick={() => handleModeChange("perspective")}
            title="45° axonometric 3D topographical relief view"
          >
            45° RELIEF
          </button>
          <button
            type="button"
            className={mode === "contour" ? "on" : ""}
            onClick={() => handleModeChange("contour")}
            title="Stacked topographical elevation contours"
          >
            CONTOUR
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
      <div className="token-chart-viewport">
        <canvas
          ref={canvasRef}
          className="token-spectrum-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
          onDoubleClick={onDoubleClick}
        />

        {/* Hover Holographic Tooltip HUD */}
        {hoveredBucket && mode !== "gauge" && (
          <div
            className="token-hud-tooltip"
            style={{
              left: `${Math.min(
                82,
                Math.max(18, ((hoverIndex ?? 0) / Math.max(1, processedData.length - 1)) * 100),
              )}%`,
            }}
          >
            <div className="hud-tooltip-header">
              <span className="time-tag">{hoveredBucket.timeLabel}</span>
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
// Canvas Drawing: 45-Degree Axonometric 3D Topographical Relief View
// ---------------------------------------------------------------------------

function drawPerspectiveMode(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: ProcessedBucket[],
  activeChannel: ChannelKey | null,
  hoverIndex: number | null,
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

  const xSpan = 22.0;
  const xMin = -xSpan / 2;
  const xMax = xSpan / 2;

  // Z-depth parallel lanes for the 4 channels (matching Area Map 3D channels)
  const zLanes: Record<ChannelKey, number> = {
    cache: -4.5,
    input: -1.5,
    reasoning: 1.5,
    output: 4.5,
  };

  let maxAltitude = 1;
  for (const d of data) {
    if (activeChannel) {
      maxAltitude = Math.max(maxAltitude, d[activeChannel]);
    } else {
      maxAltitude = Math.max(maxAltitude, d.cache, d.input, d.reasoning, d.output);
    }
  }
  maxAltitude = Math.max(50, Math.ceil(maxAltitude * 1.15));
  const maxVisualY = 6.2; // 3D units maximum altitude

  // 1. Draw 3D Base Matrix Platform Grid
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;

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

  // Base platform outer perimeter box
  ctx.strokeStyle = "rgba(255, 154, 60, 0.4)";
  ctx.lineWidth = 1.2;
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
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "right";
  CHANNELS.forEach((ch) => {
    const isSelected = activeChannel === ch.key;
    const isFaded = activeChannel !== null && !isSelected;
    const z = zLanes[ch.key];
    const pt = project([xMin - 0.5, 0, z]);
    if (pt) {
      ctx.fillStyle = isFaded ? "rgba(255, 255, 255, 0.2)" : ch.color;
      ctx.fillText(`[${ch.tag}] ${ch.label}`, pt[0] - 6, pt[1] + 3);
    }
  });

  // Time Axis text along the front
  const tStart = project([xMin, 0, 6.6]);
  const tEnd = project([xMax, 0, 6.6]);
  if (tStart && tEnd) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.fillText("◄ T0 (SESSION START)", tStart[0], tStart[1]);
    ctx.textAlign = "right";
    ctx.fillText("NOW (LATEST) ►", tEnd[0], tEnd[1]);
  }
  ctx.restore();

  // 2. Draw 3D Topographical Ridge Curtains
  // Painter's algorithm: sort channels from back to front based on camera distance
  const sortedChannels = [...CHANNELS].sort((a, b) => {
    const distA = Math.hypot(eyeX, eyeY, eyeZ - zLanes[a.key]);
    const distB = Math.hypot(eyeX, eyeY, eyeZ - zLanes[b.key]);
    return distB - distA; // furthest first
  });

  const n = data.length;
  if (n >= 2) {
    for (const ch of sortedChannels) {
      const isSelected = activeChannel === ch.key;
      const isFaded = activeChannel !== null && !isSelected;
      if (isFaded) continue;

      const z = zLanes[ch.key];

      const topPts: Array<[number, number, number] | null> = [];
      const botPts: Array<[number, number, number] | null> = [];

      for (let i = 0; i < n; i++) {
        const frac = i / (n - 1);
        const x = xMin + frac * xSpan;
        const val = data[i][ch.key];
        const y = (val / maxAltitude) * maxVisualY;

        topPts.push(project([x, y, z]));
        botPts.push(project([x, 0, z]));
      }

      // 2A. Vertical Ribbon Curtain Drop (fading downward to baseline)
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

      // 2B. Transverse vertical struts (waterfall waveform profile)
      ctx.strokeStyle = ch.color;
      ctx.globalAlpha = 0.28;
      ctx.lineWidth = 0.8;
      const step = Math.max(1, Math.floor(n / 18));
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

      // 2C. Glowing Top Ridge Crest
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = ch.color;
      ctx.shadowColor = ch.glow;
      ctx.shadowBlur = 8;
      ctx.lineWidth = isSelected ? 2.6 : 1.8;

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

      // 2D. Glowing Crest Core Beads on Non-Zero Points
      ctx.shadowBlur = 0;
      for (let i = 0; i < n; i++) {
        const pt = topPts[i];
        if (!pt || data[i][ch.key] === 0) continue;
        ctx.beginPath();
        ctx.arc(pt[0], pt[1], 2.2, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // 3. 3D Laser Scan Sweep Line across time
  const sweepFrac = (elapsed * 0.22) % 1.0;
  const sweepX = xMin + sweepFrac * xSpan;
  const swP0 = project([sweepX, 0, -5.5]);
  const swP1 = project([sweepX, 0, 5.5]);
  const swTop = project([sweepX, maxVisualY * 0.8, 0]);

  if (swP0 && swP1) {
    ctx.save();
    ctx.strokeStyle = "rgba(255, 154, 60, 0.7)";
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "#ff9a3c";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(swP0[0], swP0[1]);
    ctx.lineTo(swP1[0], swP1[1]);
    ctx.stroke();

    if (swTop) {
      ctx.fillStyle = "rgba(255, 154, 60, 0.12)";
      ctx.beginPath();
      ctx.moveTo(swP0[0], swP0[1]);
      ctx.lineTo(swTop[0], swTop[1]);
      ctx.lineTo(swP1[0], swP1[1]);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // 4. Interactive 3D Waypoint Pin for Hovered Bucket
  if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < n) {
    const frac = hoverIndex / (n - 1);
    const hX = xMin + frac * xSpan;
    const d = data[hoverIndex];

    let topChanKey: ChannelKey = "cache";
    let topVal = d.cache;
    CHANNELS.forEach((c) => {
      if (d[c.key] > topVal) {
        topVal = d[c.key];
        topChanKey = c.key;
      }
    });

    const ch = CHANNELS.find((c) => c.key === topChanKey)!;
    const z = zLanes[topChanKey];
    const peakY = (topVal / maxAltitude) * maxVisualY;

    const basePt = project([hX, 0, z]);
    const pinPt = project([hX, peakY + 1.2, z]);

    if (basePt && pinPt) {
      ctx.save();
      ctx.strokeStyle = ch.color;
      ctx.lineWidth = 1.4;
      ctx.shadowColor = ch.glow;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(basePt[0], basePt[1]);
      ctx.lineTo(pinPt[0], pinPt[1]);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(pinPt[0], pinPt[1], 5.5, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(pinPt[0], pinPt[1], 2.2, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.shadowBlur = 0;
      ctx.fill();

      ctx.restore();
    }
  }

  // 5. Camera Control Hint
  ctx.save();
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
  ctx.textAlign = "left";
  ctx.fillText("DRAG · 45° ORBIT   DBL-CLICK · RESET", 14, h - 8);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Canvas Drawing: 2D Topographical Contour Mode
// ---------------------------------------------------------------------------

function drawContourMode(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: ProcessedBucket[],
  activeChannel: ChannelKey | null,
  hoverIndex: number | null,
  elapsed: number,
) {
  const padL = 54;
  const padR = 16;
  const padT = 12;
  const padB = 24;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, h - padT - padB);

  let maxAltitude = 1;
  if (activeChannel) {
    for (const d of data) {
      maxAltitude = Math.max(maxAltitude, d[activeChannel]);
    }
  } else {
    for (const d of data) {
      maxAltitude = Math.max(maxAltitude, d.stackOutput);
    }
  }
  maxAltitude = Math.max(100, Math.ceil(maxAltitude * 1.15));

  drawGridAndContours(ctx, padL, padT, plotW, plotH, maxAltitude, data);

  if (data.length < 2) return;

  const n = data.length;
  const getX = (i: number) => padL + (i / (n - 1)) * plotW;
  const getY = (val: number) => padT + plotH - (Math.min(maxAltitude, val) / maxAltitude) * plotH;

  if (activeChannel) {
    const chDef = CHANNELS.find((c) => c.key === activeChannel)!;
    drawSingleArea(ctx, data, getX, getY, (d) => d[activeChannel], chDef, padT + plotH);
  } else {
    const layers = [
      {
        key: "output",
        def: CHANNELS[3],
        getTop: (d: ProcessedBucket) => d.stackOutput,
        getBot: (d: ProcessedBucket) => d.stackReasoning,
      },
      {
        key: "reasoning",
        def: CHANNELS[2],
        getTop: (d: ProcessedBucket) => d.stackReasoning,
        getBot: (d: ProcessedBucket) => d.stackInput,
      },
      {
        key: "input",
        def: CHANNELS[1],
        getTop: (d: ProcessedBucket) => d.stackInput,
        getBot: (d: ProcessedBucket) => d.stackCache,
      },
      {
        key: "cache",
        def: CHANNELS[0],
        getTop: (d: ProcessedBucket) => d.stackCache,
        getBot: () => 0,
      },
    ];

    for (const layer of layers) {
      drawStackedBand(ctx, data, getX, getY, layer.getTop, layer.getBot, layer.def);
    }
  }

  // Radar sweep line
  const sweepProgress = (elapsed * 0.25) % 1.0;
  const sweepX = padL + sweepProgress * plotW;
  ctx.save();
  const sweepGrad = ctx.createLinearGradient(sweepX - 25, 0, sweepX, 0);
  sweepGrad.addColorStop(0, "rgba(255, 154, 60, 0)");
  sweepGrad.addColorStop(1, "rgba(255, 154, 60, 0.22)");
  ctx.fillStyle = sweepGrad;
  ctx.fillRect(sweepX - 25, padT, 25, plotH);

  ctx.strokeStyle = "rgba(255, 154, 60, 0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(sweepX, padT);
  ctx.lineTo(sweepX, padT + plotH);
  ctx.stroke();
  ctx.restore();

  // Crosshair
  if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < data.length) {
    const hX = getX(hoverIndex);
    const d = data[hoverIndex];

    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(hX, padT);
    ctx.lineTo(hX, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    const pointsToMark: Array<{ y: number; color: string }> = [];
    if (activeChannel) {
      const ch = CHANNELS.find((c) => c.key === activeChannel)!;
      pointsToMark.push({ y: getY(d[activeChannel]), color: ch.color });
    } else {
      if (d.output > 0) pointsToMark.push({ y: getY(d.stackOutput), color: CHANNELS[3].color });
      if (d.reasoning > 0) pointsToMark.push({ y: getY(d.stackReasoning), color: CHANNELS[2].color });
      if (d.input > 0) pointsToMark.push({ y: getY(d.stackInput), color: CHANNELS[1].color });
      if (d.cache > 0) pointsToMark.push({ y: getY(d.stackCache), color: CHANNELS[0].color });
    }

    for (const pt of pointsToMark) {
      ctx.beginPath();
      ctx.arc(hX, pt.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = pt.color;
      ctx.shadowColor = pt.color;
      ctx.shadowBlur = 8;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(hX, pt.y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.shadowBlur = 0;
      ctx.fill();
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Canvas Drawing: Burst Velocity Mode
// ---------------------------------------------------------------------------

function drawBurstMode(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: ProcessedBucket[],
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

  drawGridAndContours(ctx, padL, padT, plotW, plotH, maxAltitude, data);

  const n = data.length;
  if (n === 0) return;
  const slotW = plotW / n;
  const barGap = Math.max(1, slotW * 0.2);
  const barW = Math.max(2, slotW - barGap);

  data.forEach((d, i) => {
    const x = padL + i * slotW + barGap / 2;
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
  const numTimeTicks = Math.min(5, data.length);
  for (let i = 0; i < numTimeTicks; i++) {
    const dataIdx = Math.round((i / (numTimeTicks - 1)) * (data.length - 1));
    const x = padL + (dataIdx / Math.max(1, data.length - 1)) * plotW;
    const label = data[dataIdx]?.timeLabel ?? "";

    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.beginPath();
    ctx.moveTo(x, padT + plotH);
    ctx.lineTo(x, padT + plotH + 4);
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
    ctx.fillText(label, x, padT + plotH + 15);
  }

  ctx.restore();
}

function drawStackedBand(
  ctx: CanvasRenderingContext2D,
  data: ProcessedBucket[],
  getX: (i: number) => number,
  getY: (v: number) => number,
  getTop: (d: ProcessedBucket) => number,
  getBot: (d: ProcessedBucket) => number,
  def: ChannelDef,
) {
  const n = data.length;
  if (n < 2) return;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(getX(0), getY(getTop(data[0])));

  for (let i = 1; i < n; i++) {
    const x0 = getX(i - 1);
    const y0 = getY(getTop(data[i - 1]));
    const x1 = getX(i);
    const y1 = getY(getTop(data[i]));
    const mx = (x0 + x1) / 2;
    ctx.bezierCurveTo(mx, y0, mx, y1, x1, y1);
  }

  for (let i = n - 1; i >= 0; i--) {
    const x = getX(i);
    const y = getY(getBot(data[i]));
    if (i === n - 1) {
      ctx.lineTo(x, y);
    } else {
      const prevX = getX(i + 1);
      const prevY = getY(getBot(data[i + 1]));
      const mx = (prevX + x) / 2;
      ctx.bezierCurveTo(mx, prevY, mx, y, x, y);
    }
  }

  ctx.closePath();
  ctx.fillStyle = def.bgGradient;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(getX(0), getY(getTop(data[0])));
  for (let i = 1; i < n; i++) {
    const x0 = getX(i - 1);
    const y0 = getY(getTop(data[i - 1]));
    const x1 = getX(i);
    const y1 = getY(getTop(data[i]));
    const mx = (x0 + x1) / 2;
    ctx.bezierCurveTo(mx, y0, mx, y1, x1, y1);
  }
  ctx.strokeStyle = def.color;
  ctx.shadowColor = def.glow;
  ctx.shadowBlur = 6;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.restore();
}

function drawSingleArea(
  ctx: CanvasRenderingContext2D,
  data: ProcessedBucket[],
  getX: (i: number) => number,
  getY: (v: number) => number,
  getValue: (d: ProcessedBucket) => number,
  def: ChannelDef,
  baseY: number,
) {
  const n = data.length;
  if (n < 2) return;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(getX(0), baseY);
  ctx.lineTo(getX(0), getY(getValue(data[0])));

  for (let i = 1; i < n; i++) {
    const x0 = getX(i - 1);
    const y0 = getY(getValue(data[i - 1]));
    const x1 = getX(i);
    const y1 = getY(getValue(data[i]));
    const mx = (x0 + x1) / 2;
    ctx.bezierCurveTo(mx, y0, mx, y1, x1, y1);
  }

  ctx.lineTo(getX(n - 1), baseY);
  ctx.closePath();

  ctx.fillStyle = def.bgGradient;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(getX(0), getY(getValue(data[0])));
  for (let i = 1; i < n; i++) {
    const x0 = getX(i - 1);
    const y0 = getY(getValue(data[i - 1]));
    const x1 = getX(i);
    const y1 = getY(getValue(data[i]));
    const mx = (x0 + x1) / 2;
    ctx.bezierCurveTo(mx, y0, mx, y1, x1, y1);
  }
  ctx.strokeStyle = def.color;
  ctx.shadowColor = def.glow;
  ctx.shadowBlur = 7;
  ctx.lineWidth = 1.8;
  ctx.stroke();

  ctx.restore();
}
