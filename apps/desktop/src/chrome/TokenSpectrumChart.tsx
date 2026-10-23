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
  seamBeforeBucket,
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
      if (saved === "stack" || saved === "burst" || saved === "gauge") {
        return saved;
      }
      if (saved === "contour") {
        return "stack";
      }
    } catch {}
    return "stack";
  });

  const [activeChannel, setActiveChannel] = useState<ChannelKey | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverChannel, setHoverChannel] = useState<ChannelKey | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number | null>(null);
  const pointerXRef = useRef<number | null>(null);

  const processed = useMemo(() => processTimelineData(timeline, stats), [timeline, stats]);
  const processedData = processed.buckets;
  const seams = processed.seams;

  const clearHover = useCallback(() => {
    pointerXRef.current = null;
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
        drawBurstMode(ctx, w, h, processedData, seams, activeChannel, hoverIndex, pointerXRef.current);
      } else {
        draw2DStackMode(
          ctx,
          w,
          h,
          processedData,
          seams,
          activeChannel,
          hoverIndex,
          hoverChannel,
          pointerXRef.current,
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

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (mode === "gauge" || processedData.length === 0) {
        pointerXRef.current = null;
        setHoverIndex(null);
        setHoverChannel(null);
        return;
      }

      const rect = e.currentTarget.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;

      // Clear immediately if cursor is outside viewport boundaries
      if (clientX < 0 || clientX > rect.width || clientY < 0 || clientY > rect.height) {
        pointerXRef.current = null;
        setHoverIndex(null);
        setHoverChannel(null);
        return;
      }

      const padLeft = 54;
      const padRight = 16;
      const plotW = Math.max(1, rect.width - padLeft - padRight);
      if (clientX < padLeft || clientX > rect.width - padRight) {
        pointerXRef.current = null;
        setHoverIndex(null);
        setHoverChannel(null);
        return;
      }

      pointerXRef.current = clientX;

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
      setHoverIndex(best);

      if (mode === "stack") {
        const d = processedData[best];
        let maxAltitude = 1;
        for (const item of processedData) {
          if (activeChannel) {
            maxAltitude = Math.max(maxAltitude, item[activeChannel]);
          } else {
            maxAltitude = Math.max(maxAltitude, item.stackOutput, item.total);
          }
        }
        maxAltitude = Math.max(100, Math.ceil(maxAltitude * 1.15));

        const padT = 16;
        const padB = 26;
        const plotH = Math.max(1, rect.height - padT - padB);
        const yBase = padT + plotH;

        if (activeChannel) {
          setHoverChannel(activeChannel);
        } else {
          // Identify which stacked layer is under the cursor
          const yCache = yBase - (d.stackCache / maxAltitude) * plotH;
          const yInput = yBase - (d.stackInput / maxAltitude) * plotH;
          const yReasoning = yBase - (d.stackReasoning / maxAltitude) * plotH;
          const yOutput = yBase - (d.stackOutput / maxAltitude) * plotH;

          if (clientY >= yCache && clientY <= yBase + 10) {
            setHoverChannel("cache");
          } else if (clientY >= yInput && clientY < yCache) {
            setHoverChannel("input");
          } else if (clientY >= yReasoning && clientY < yInput) {
            setHoverChannel("reasoning");
          } else if (clientY >= yOutput - 10 && clientY < yReasoning) {
            setHoverChannel("output");
          } else {
            setHoverChannel(null);
          }
        }
      } else {
        setHoverChannel(activeChannel);
      }
    },
    [mode, processedData, activeChannel],
  );

  const hoveredBucket = hoverIndex !== null && processedData[hoverIndex] ? processedData[hoverIndex] : null;
  const gappedSeam = hoverIndex === null ? null : seamBeforeBucket(processedData, seams, hoverIndex);

  return (
    <div className="token-spectrum-root" ref={containerRef} onPointerLeave={clearHover}>
      {/* Sci-Fi Header Toolbar */}
      <div className="token-chart-toolbar">
        <div className="token-chart-modes">
          <button
            type="button"
            className={mode === "stack" ? "on" : ""}
            onClick={() => handleModeChange("stack")}
            title="Continuous 2D stacked token distribution over time with neon contours"
          >
            2D STACK
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
          <span className="status-blink">● LIVE</span>
        </div>
      </div>

      {/* Main Canvas Viewport */}
      <div className="token-chart-viewport" onPointerLeave={clearHover}>
        <canvas
          ref={canvasRef}
          className="token-spectrum-canvas"
          onPointerMove={onPointerMove}
          onPointerLeave={clearHover}
        />

        {/* Hover Holographic Tooltip HUD */}
        {hoveredBucket && mode !== "gauge" && (
          <div
            className={`token-hud-tooltip${
              hoveredBucket.xFraction < 0.28 ? " tip-start" : hoveredBucket.xFraction > 0.72 ? " tip-end" : ""
            }`}
            style={
              hoveredBucket.xFraction >= 0.28 && hoveredBucket.xFraction <= 0.72
                ? { left: `${hoveredBucket.xFraction * 100}%` }
                : undefined
            }
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
            {gappedSeam && (
              <div className="hud-tooltip-gapped">
                ⏳ GAPPED: {gappedSeam.label} idle folded prior to this turn
              </div>
            )}
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
// Canvas Drawing: 2D Continuous Stacked Area Mode
// ---------------------------------------------------------------------------

function draw2DStackMode(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: ProcessedBucket[],
  seams: SpectrumSeam[],
  activeChannel: ChannelKey | null,
  hoverIndex: number | null,
  hoverChannel: ChannelKey | null,
  pointerX: number | null,
) {
  const padL = 54;
  const padR = 16;
  const padT = 16;
  const padB = 26;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, h - padT - padB);
  const yBase = padT + plotH;

  let maxAltitude = 1;
  for (const d of data) {
    if (activeChannel) {
      maxAltitude = Math.max(maxAltitude, d[activeChannel]);
    } else {
      maxAltitude = Math.max(maxAltitude, d.stackOutput, d.total);
    }
  }
  maxAltitude = Math.max(100, Math.ceil(maxAltitude * 1.15));

  // 1. Grid, Iso-Contours and Time Seams
  drawGridAndContours(ctx, padL, padT, plotW, plotH, maxAltitude, data, seams);

  const n = data.length;
  if (n === 0) return;

  // 2. Compute 2D coordinates for all data points
  // Order of stack from bottom to top: Cache -> Input -> Reasoning -> Output
  const pts = data.map((d) => {
    const x = padL + d.xFraction * plotW;
    return {
      x,
      yBase,
      yCache: yBase - (d.stackCache / maxAltitude) * plotH,
      yInput: yBase - (d.stackInput / maxAltitude) * plotH,
      yReasoning: yBase - (d.stackReasoning / maxAltitude) * plotH,
      yOutput: yBase - (d.stackOutput / maxAltitude) * plotH,
      yIsolated: activeChannel ? yBase - (d[activeChannel] / maxAltitude) * plotH : yBase,
    };
  });

  // Helper to draw smooth horizontal monotonic bezier splines
  const drawSpline = (points: Array<{ x: number; y: number }>, reverse = false) => {
    if (points.length === 0) return;
    const list = reverse ? [...points].reverse() : points;
    if (!reverse) {
      ctx.lineTo(list[0].x, list[0].y);
    }
    for (let i = 0; i < list.length - 1; i++) {
      const p0 = list[i];
      const p1 = list[i + 1];
      const midX = (p0.x + p1.x) / 2;
      ctx.bezierCurveTo(midX, p0.y, midX, p1.y, p1.x, p1.y);
    }
  };

  const drawLayer = (
    topPts: Array<{ x: number; y: number }>,
    botPts: Array<{ x: number; y: number }>,
    ch: (typeof CHANNELS)[number],
    isTargeted: boolean,
    isDimmed: boolean,
  ) => {
    ctx.save();

    // Layer fill polygon
    ctx.beginPath();
    ctx.moveTo(topPts[0].x, topPts[0].y);
    drawSpline(topPts, false);
    ctx.lineTo(botPts[botPts.length - 1].x, botPts[botPts.length - 1].y);
    drawSpline(botPts, true);
    ctx.closePath();

    // Linear gradient from top to bottom of chart
    const grad = ctx.createLinearGradient(0, padT, 0, yBase);
    if (isDimmed) {
      grad.addColorStop(0, "rgba(255, 255, 255, 0.05)");
      grad.addColorStop(1, "rgba(255, 255, 255, 0.01)");
    } else {
      const topAlpha = isTargeted ? 0.42 : 0.28;
      const botAlpha = isTargeted ? 0.15 : 0.08;
      grad.addColorStop(0, ch.glow.replace(/[\d.]+\)$/, `${topAlpha})`));
      grad.addColorStop(1, ch.glow.replace(/[\d.]+\)$/, `${botAlpha})`));
    }
    ctx.fillStyle = grad;
    ctx.fill();

    // Glowing Neon Contour Top Edge
    ctx.beginPath();
    ctx.moveTo(topPts[0].x, topPts[0].y);
    drawSpline(topPts, false);
    ctx.strokeStyle = isDimmed ? "rgba(255, 255, 255, 0.15)" : ch.color;
    ctx.lineWidth = isTargeted ? 2.2 : isDimmed ? 0.8 : 1.4;
    if (!isDimmed) {
      ctx.shadowColor = ch.glow;
      ctx.shadowBlur = isTargeted ? 10 : 5;
    }
    ctx.stroke();

    ctx.restore();
  };

  if (activeChannel) {
    // Isolated Channel Mode
    const ch = CHANNELS.find((c) => c.key === activeChannel)!;
    const topPts = pts.map((p) => ({ x: p.x, y: p.yIsolated }));
    const botPts = pts.map((p) => ({ x: p.x, y: p.yBase }));
    drawLayer(topPts, botPts, ch, true, false);
  } else {
    // 4 Stacked Layers from Bottom to Top: Cache -> Input -> Reasoning -> Output
    const layers = [
      {
        channel: CHANNELS[0], // cache
        top: pts.map((p) => ({ x: p.x, y: p.yCache })),
        bot: pts.map((p) => ({ x: p.x, y: p.yBase })),
      },
      {
        channel: CHANNELS[1], // input
        top: pts.map((p) => ({ x: p.x, y: p.yInput })),
        bot: pts.map((p) => ({ x: p.x, y: p.yCache })),
      },
      {
        channel: CHANNELS[2], // reasoning
        top: pts.map((p) => ({ x: p.x, y: p.yReasoning })),
        bot: pts.map((p) => ({ x: p.x, y: p.yInput })),
      },
      {
        channel: CHANNELS[3], // output
        top: pts.map((p) => ({ x: p.x, y: p.yOutput })),
        bot: pts.map((p) => ({ x: p.x, y: p.yReasoning })),
      },
    ];

    for (const lay of layers) {
      const isTargeted = hoverChannel === lay.channel.key;
      const isDimmed = hoverChannel !== null && !isTargeted;
      drawLayer(lay.top, lay.bot, lay.channel, isTargeted, isDimmed);
    }
  }

  // 3. Hover Crosshair & Reticle Nodes
  if (hoverIndex !== null && data[hoverIndex]) {
    const hd = data[hoverIndex];
    const hp = pts[hoverIndex];
    const hx = hp.x;

    // Vertical dashed crosshair
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hx, padT);
    ctx.lineTo(hx, yBase);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Node points at the stack boundaries
    if (activeChannel) {
      const ch = CHANNELS.find((c) => c.key === activeChannel)!;
      drawTargetReticle(ctx, hx, hp.yIsolated, ch, hd[activeChannel]);
    } else {
      const nodes = [
        { key: "cache" as ChannelKey, y: hp.yCache, val: hd.cache, ch: CHANNELS[0] },
        { key: "input" as ChannelKey, y: hp.yInput, val: hd.input, ch: CHANNELS[1] },
        { key: "reasoning" as ChannelKey, y: hp.yReasoning, val: hd.reasoning, ch: CHANNELS[2] },
        { key: "output" as ChannelKey, y: hp.yOutput, val: hd.output, ch: CHANNELS[3] },
      ];

      for (const node of nodes) {
        if (node.val <= 0) continue;
        const isHovered = hoverChannel === node.key;

        if (isHovered) {
          drawTargetReticle(ctx, hx, node.y, node.ch, node.val);
        } else {
          // Subtle core bead for unhovered stack boundaries
          ctx.save();
          ctx.fillStyle = node.ch.color;
          ctx.beginPath();
          ctx.arc(hx, node.y, 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }
  }

  // 5. Idle Seam Fold Hover Labels
  if (pointerX !== null) {
    ctx.save();
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const seam of seams) {
      const x = padL + seam.fraction * plotW;
      if (Math.abs(pointerX - x) > 8) continue;
      const width = ctx.measureText(seam.label).width;
      const y = padT + 11;
      ctx.fillStyle = "rgba(10, 12, 16, 0.92)";
      ctx.fillRect(x - width / 2 - 4, y - 7, width + 8, 14);
      ctx.fillStyle = "#ff9a3c";
      ctx.fillText(seam.label, x, y);
    }
    ctx.restore();
  }
}

function drawTargetReticle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ch: (typeof CHANNELS)[number],
  val: number,
) {
  ctx.save();
  ctx.strokeStyle = ch.color;
  ctx.lineWidth = 1.2;
  ctx.shadowColor = ch.glow;
  ctx.shadowBlur = 8;

  // Outer target ring
  ctx.beginPath();
  ctx.arc(x, y, 5.5, 0, Math.PI * 2);
  ctx.stroke();

  // Glowing center dot
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(x, y, 2.2, 0, Math.PI * 2);
  ctx.fill();

  // Floating Pill Callout Tag
  const tagText = `[${ch.tag}: ${formatNum(val)}]`;
  ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
  const tm = ctx.measureText(tagText);
  const tagX = x + 10;
  const tagY = y - 4;

  ctx.fillStyle = "rgba(10, 14, 20, 0.88)";
  ctx.fillRect(tagX - 3, tagY - 9, tm.width + 6, 12);
  ctx.strokeStyle = ch.color;
  ctx.lineWidth = 0.8;
  ctx.strokeRect(tagX - 3, tagY - 9, tm.width + 6, 12);

  ctx.fillStyle = ch.color;
  ctx.fillText(tagText, tagX, tagY);
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
  pointerX: number | null,
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
  if (n > 0) data.forEach((d, i) => {
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

  if (n > 0) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();
  }

  if (pointerX === null) return;
  ctx.save();
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const seam of seams) {
    const x = padL + seam.fraction * plotW;
    if (Math.abs(pointerX - x) > 8) continue;
    const width = ctx.measureText(seam.label).width;
    const y = padT + 11;
    ctx.fillStyle = "rgba(10, 12, 16, 0.92)";
    ctx.fillRect(x - width / 2 - 4, y - 7, width + 8, 14);
    ctx.fillStyle = "#ff9a3c";
    ctx.fillText(seam.label, x, y);
  }
  ctx.restore();
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
  ctx.font = "8.5px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "rgba(255, 255, 255, 0.45)";

  if (data.length > 0) {
    const yTick = padT + plotH;
    const yText = yTick + 13;

    // Left start time
    const startLabel = data[0]?.timeLabel || "T0";
    ctx.textAlign = "left";
    ctx.fillText(startLabel, padL, yText);

    // Left tick
    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, yTick);
    ctx.lineTo(padL, yTick + 3);
    ctx.stroke();

    // Right latest time
    const endLabel = data[data.length - 1]?.timeLabel || "LATEST";
    ctx.textAlign = "right";
    ctx.fillText(endLabel, padL + plotW, yText);

    // Right tick
    ctx.beginPath();
    ctx.moveTo(padL + plotW, yTick);
    ctx.lineTo(padL + plotW, yTick + 3);
    ctx.stroke();

    // Clean single midpoint only when wide enough to avoid any clutter
    if (plotW >= 240 && data.length >= 3) {
      let midIdx = 0;
      let bestDist = Infinity;
      for (let p = 0; p < data.length; p++) {
        const dist = Math.abs(data[p].xFraction - 0.5);
        if (dist < bestDist) {
          bestDist = dist;
          midIdx = p;
        }
      }
      const midX = padL + data[midIdx].xFraction * plotW;
      const midLabel = data[midIdx]?.timeLabel ?? "";
      if (midX > padL + 45 && midX < padL + plotW - 45) {
        ctx.textAlign = "center";
        ctx.fillText(midLabel, midX, yText);

        ctx.beginPath();
        ctx.moveTo(midX, yTick);
        ctx.lineTo(midX, yTick + 3);
        ctx.stroke();
      }
    }
  }

  if (seams.length > 0) {
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = "rgba(255, 154, 60, 0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const seam of seams) {
      const x = padL + seam.fraction * plotW;
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
}

