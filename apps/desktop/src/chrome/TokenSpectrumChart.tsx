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

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(performance.now());

  const processedData = useMemo(() => {
    return processTimelineData(timeline, stats);
  }, [timeline, stats]);

  const handleModeChange = (newMode: TokenChartMode) => {
    setMode(newMode);
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
        drawBurstMode(ctx, w, h, processedData, activeChannel, hoverIndex, elapsed);
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

  // Pointer event handlers for crosshair inspection
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (mode === "gauge" || processedData.length === 0) {
        setHoverIndex(null);
        return;
      }
      const rect = e.currentTarget.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const padLeft = 46;
      const padRight = 14;
      const plotW = Math.max(1, rect.width - padLeft - padRight);

      const ratio = Math.max(0, Math.min(1, (clientX - padLeft) / plotW));
      const idx = Math.round(ratio * (processedData.length - 1));
      setHoverIndex(idx >= 0 && idx < processedData.length ? idx : null);
    },
    [mode, processedData],
  );

  const onPointerLeave = useCallback(() => {
    setHoverIndex(null);
  }, []);

  const hoveredBucket = hoverIndex !== null && processedData[hoverIndex] ? processedData[hoverIndex] : null;

  return (
    <div className="token-spectrum-root" ref={containerRef}>
      {/* Sci-Fi Header Toolbar */}
      <div className="token-chart-toolbar">
        <div className="token-chart-modes">
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
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
        />

        {/* Hover Holographic Tooltip HUD */}
        {hoveredBucket && mode !== "gauge" && (
          <div
            className="token-hud-tooltip"
            style={{
              left: `${Math.min(
                85,
                Math.max(15, ((hoverIndex ?? 0) / Math.max(1, processedData.length - 1)) * 100),
              )}%`,
            }}
          >
            <div className="hud-tooltip-header">
              <span className="time-tag">{hoveredBucket.timeLabel}</span>
              <span className="total-tag">{formatNum(hoveredBucket.total)} TOK</span>
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
              <span>EFFICIENCY:</span>
              <b style={{ color: hoveredBucket.cacheHitRate > 50 ? "#3dd68c" : "#ff9a3c" }}>
                {hoveredBucket.cacheHitRate.toFixed(1)}% HIT
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
// Canvas Drawing Routines: Topographical Contour Mode
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
  const padL = 46;
  const padR = 14;
  const padT = 12;
  const padB = 22;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, h - padT - padB);

  // Compute maximum altitude
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
  // Round max altitude up slightly for nice contour headroom
  maxAltitude = Math.max(100, Math.ceil(maxAltitude * 1.15));

  // 1. Draw Sci-Fi Topographical Grid & Altitude Contours
  drawGridAndContours(ctx, padL, padT, plotW, plotH, maxAltitude, data);

  if (data.length < 2) return;

  const n = data.length;
  const getX = (i: number) => padL + (i / (n - 1)) * plotW;
  const getY = (val: number) => padT + plotH - (Math.min(maxAltitude, val) / maxAltitude) * plotH;

  // 2. Draw Layered Stacked Ribbons
  if (activeChannel) {
    // Single isolated channel
    const chDef = CHANNELS.find((c) => c.key === activeChannel)!;
    drawSingleArea(ctx, data, getX, getY, (d) => d[activeChannel], chDef, padT + plotH);
  } else {
    // 4 Stacked Layers: Output (top), Reasoning, Input, Cache (bottom)
    // Draw top-down so fills layer nicely
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

  // 3. Subtle Sci-Fi Radar Sweep Line across time axis
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

  // 4. Interactive Crosshair Reticle & Glowing Intersection Beads
  if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < data.length) {
    const hX = getX(hoverIndex);
    const d = data[hoverIndex];

    ctx.save();
    // Vertical Laser Crosshair
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(hX, padT);
    ctx.lineTo(hX, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Glowing Beads on each active layer
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
// Canvas Drawing Routines: Burst Velocity Mode
// ---------------------------------------------------------------------------

function drawBurstMode(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: ProcessedBucket[],
  activeChannel: ChannelKey | null,
  hoverIndex: number | null,
  _elapsed: number,
) {
  const padL = 46;
  const padR = 14;
  const padT = 12;
  const padB = 22;
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
      // Subdivided segmented bars for all 4 channels
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

  // Topographic baseline highlight
  ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Canvas Drawing Routines: Arc Gauge Mode (Legacy Spectrum Donut)
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
  const r = Math.min(cx, cy) - 14;

  const cache = stats?.total_cache_read_tokens ?? 0;
  const input = stats?.total_input_tokens ?? 0;
  const reasoning = stats?.total_reasoning_tokens ?? 0;
  const output = stats?.total_output_tokens ?? 0;
  const total = cache + input + reasoning + output;

  // Background ring
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 8;
  ctx.stroke();

  if (total === 0) {
    ctx.font = "8px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
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
  ctx.lineWidth = 9;

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
      ctx.lineWidth = 11;
    }
    ctx.stroke();
    ctx.restore();

    start += angle;
  }

  // Center Reticle Readout
  ctx.save();
  ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.fillText(formatNum(total), cx, cy + 1);

  ctx.font = "6.5px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
  ctx.fillText("TOTAL TOKENS", cx, cy + 11);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Helpers: Topographical Elevation Grid, Splines & Area Bands
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

  // Outer framing box border
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  ctx.strokeRect(padL, padT, plotW, plotH);

  // Horizontal elevation contour lines (4 levels)
  const steps = 4;
  ctx.font = "7.5px ui-monospace, SFMono-Regular, Menlo, monospace";
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

    // Elevation label
    ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
    ctx.fillText(`${formatNum(val)}`, padL - 6, y + 2.5);
  }

  // Time Axis Ticks (bottom)
  ctx.setLineDash([]);
  ctx.textAlign = "center";
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

    ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ctx.fillText(label, x, padT + plotH + 13);
  }

  ctx.restore();
}

/** Draws smooth stacked band between top accessor and bottom accessor */
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

  // Top Neon Glowing Contour Edge
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
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.restore();
}

/** Draws single channel area down to baseline */
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

  // Glowing Edge
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
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.restore();
}
