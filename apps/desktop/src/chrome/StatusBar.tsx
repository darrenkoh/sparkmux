import { useEffect, useState } from "react";
import type { LlmUsage } from "../types";
import { usageChips, type UsageChip } from "./llmUsage";
import {
  buildSparklinePaths,
  cpuTone,
  formatCpu,
  formatMemory,
  memoryTone,
  padCpu,
  type AppTelemetry,
  type TelemetryTone,
} from "./telemetry";

function ModelIconCore({ model }: { model?: string }) {
  const lower = (model ?? "").toLowerCase();
  if (
    lower.includes("gemini") ||
    lower.includes("argon") ||
    lower.includes("flash") ||
    lower.includes("pro")
  ) {
    return (
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="halo-icon-core">
        <path d="M8 1c.3 2.8 1.9 4.4 4.7 4.7-2.8.3-4.4 1.9-4.7 4.7C7.7 7.6 6.1 6 3.3 5.7 6.1 5.4 7.7 3.8 8 1z" />
        <path
          d="M12.5 10c.2 1.4 1 2.2 2.4 2.4-1.4.2-2.2 1-2.4 2.4-.2-1.4-1-2.2-2.4-2.4 1.4-.2 2.2-1 2.4-2.4z"
          opacity="0.75"
        />
      </svg>
    );
  }
  if (lower.includes("claude")) {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        aria-hidden="true"
        className="halo-icon-core"
      >
        <path d="M8 2.5v11M3.5 5.25l9 5.5M3.5 10.75l9-5.5" />
      </svg>
    );
  }
  if (lower.includes("grok")) {
    return (
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="halo-icon-core">
        <path d="M3 13.5L10.5 2h2.5L5.5 13.5H3z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="halo-icon-core">
      <circle cx="8" cy="8" r="3" />
    </svg>
  );
}

export function ModelHaloIcon({
  model,
  timeFraction,
  timeRemainingMs,
  tone,
  title,
}: {
  model?: string;
  timeFraction?: number;
  timeRemainingMs?: number | null;
  tone?: string;
  title?: string;
}) {
  const hasTime = timeFraction != null;
  // Progress towards reset: 0 at window start, fills up to 1.0 at reset time
  const elapsed = Math.min(1, Math.max(0, 1 - (timeFraction ?? 1)));
  const r = 7;
  const circumference = 2 * Math.PI * r;
  const strokeDashoffset = circumference * (1 - elapsed);
  const isUrgent = timeRemainingMs != null && timeRemainingMs <= 3600_000 && timeRemainingMs > 0;

  return (
    <div
      className={`model-halo-ring ${tone ?? "ok"}${isUrgent ? " is-urgent" : ""}`}
      title={title}
      aria-hidden="true"
    >
      {hasTime && (
        <svg
          className="halo-svg"
          viewBox="0 0 18 18"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle
            className="halo-track"
            cx="9"
            cy="9"
            r={r}
            strokeWidth="1.5"
          />
          <circle
            className="halo-fill"
            cx="9"
            cy="9"
            r={r}
            strokeWidth="1.5"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            transform="rotate(-90 9 9)"
          />
        </svg>
      )}
      <div className="halo-icon-wrap">
        <ModelIconCore model={model} />
      </div>
    </div>
  );
}

function ModelQuotaCard({ chip }: { chip: UsageChip }) {
  const details = chip.details ?? [];
  const cost = chip.costDetail;

  return (
    <div
      className={`status-quota-card ${chip.tone}`}
      role="tooltip"
      aria-hidden="true"
    >
      <div className="status-quota-card-header">
        <div className="status-quota-card-title">
          <span className="status-quota-card-icon">
            <ModelHaloIcon
              model={chip.model}
              timeFraction={chip.timeFraction}
              timeRemainingMs={chip.timeRemainingMs}
              tone={chip.tone}
            />
          </span>
          <span className="status-quota-card-name">
            {chip.model ?? "Model Quota"}
          </span>
        </div>
        {chip.percent != null && (
          <div className="status-quota-card-badge">
            <span className="badge-tag">{chip.window ?? "LIMIT"}</span>
            <span className="badge-val">{chip.percent}%</span>
          </div>
        )}
      </div>

      {cost && (
        <div className="status-quota-card-cost">
          <div className="cost-row">
            <span>Session Cost</span>
            <b>{cost.sessionUsd}</b>
          </div>
          {cost.todayUsd && (
            <div className="cost-row">
              <span>Today's Total</span>
              <b>{cost.todayUsd}</b>
            </div>
          )}
          <div className="cost-note">
            {cost.note ??
              (cost.estimated
                ? "Estimated from token consumption"
                : "Direct Bedrock API metrics")}
          </div>
        </div>
      )}

      {details.length > 0 && (
        <div className="status-quota-card-windows">
          {details.map((item, idx) => (
            <div
              key={`${item.label}-${idx}`}
              className={`quota-window-item ${item.tone}${item.isTighter ? " is-tighter" : ""}`}
            >
              <div className="quota-window-top">
                <div className="window-name">
                  <span>{item.label}</span>
                  {item.isTighter && <span className="tighter-pill">ACTIVE</span>}
                </div>
                <span className="window-pct">{item.percent}%</span>
              </div>

              <div className="quota-window-track">
                <div
                  className="quota-window-fill"
                  style={{ width: `${item.fill}%` }}
                />
              </div>

              <div className="quota-window-bottom">
                {item.countdown && (
                  <span className="window-reset-in">⏱ {item.countdown}</span>
                )}
                {item.resetsAtFormatted && (
                  <span className="window-reset-at">
                    Resets {item.resetsAtFormatted}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="status-quota-card-footer">
        <span className="telemetry-tag">◈ TELEMETRY</span>
        <span className="age-tag">{chip.fetchedAgeText ?? "active stream"}</span>
      </div>
    </div>
  );
}

function CpuIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="hardware-icon"
    >
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
      <rect x="6.5" y="6.5" width="3" height="3" fill="currentColor" opacity="0.6" stroke="none" />
      <line x1="6" y1="1.5" x2="6" y2="4" />
      <line x1="10" y1="1.5" x2="10" y2="4" />
      <line x1="6" y1="12" x2="6" y2="14.5" />
      <line x1="10" y1="12" x2="10" y2="14.5" />
      <line x1="1.5" y1="6" x2="4" y2="6" />
      <line x1="1.5" y1="10" x2="4" y2="10" />
      <line x1="12" y1="6" x2="14.5" y2="6" />
      <line x1="12" y1="10" x2="14.5" y2="10" />
    </svg>
  );
}

function RamIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="hardware-icon"
    >
      <rect x="2" y="4.5" width="12" height="7" rx="1" />
      <rect x="3.8" y="6" width="2" height="2.8" fill="currentColor" opacity="0.6" stroke="none" />
      <rect x="7" y="6" width="2" height="2.8" fill="currentColor" opacity="0.6" stroke="none" />
      <rect x="10.2" y="6" width="2" height="2.8" fill="currentColor" opacity="0.6" stroke="none" />
      <line x1="3.5" y1="11.5" x2="3.5" y2="13" />
      <line x1="6" y1="11.5" x2="6" y2="13" />
      <line x1="8.5" y1="11.5" x2="8.5" y2="13" />
      <line x1="11" y1="11.5" x2="11" y2="13" />
    </svg>
  );
}

function CpuHistogram({
  values,
  tone,
  barCount = 8,
}: {
  values: number[];
  tone: TelemetryTone;
  barCount?: number;
}) {
  const width = 26;
  const height = 10;
  const gap = 1.2;
  const barWidth = (width - (barCount - 1) * gap) / barCount;

  const slice = values.slice(-barCount);
  const bars: number[] = Array(Math.max(0, barCount - slice.length))
    .fill(0)
    .concat(slice);

  return (
    <span className={`status-histogram ${tone}`} aria-hidden="true">
      <svg viewBox={`0 0 ${width} ${height}`}>
        {bars.map((val, idx) => {
          const x = idx * (barWidth + gap);
          const clamped = Math.max(0, Math.min(100, val));
          const barH = clamped > 0 ? Math.max(1.2, (clamped / 100) * height) : 0;
          const y = height - barH;
          return (
            <g key={idx}>
              <rect
                x={x}
                y={0}
                width={barWidth}
                height={height}
                rx={0.5}
                className="status-histogram-slot"
              />
              {barH > 0 && (
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={barH}
                  rx={0.5}
                  className="status-histogram-bar"
                />
              )}
            </g>
          );
        })}
      </svg>
    </span>
  );
}

function MiniSparkline({
  values,
  tone,
  minVal,
  maxVal,
}: {
  values: number[];
  tone: TelemetryTone;
  minVal?: number;
  maxVal?: number;
}) {
  const width = 26;
  const height = 10;
  const series =
    values.length >= 2 ? values : values.length === 1 ? [values[0], values[0]] : [0, 0];
  const { strokePath, areaPath } = buildSparklinePaths(series, width, height, { minVal, maxVal });

  return (
    <span className={`status-sparkline ${tone}`} aria-hidden="true">
      <svg viewBox={`0 0 ${width} ${height}`}>
        <line x1="0" y1={height - 0.5} x2={width} y2={height - 0.5} className="status-sparkline-track" />
        {areaPath && <path d={areaPath} className="status-sparkline-fill" />}
        {strokePath && <path d={strokePath} className="status-sparkline-stroke" />}
      </svg>
    </span>
  );
}

function HardwareHudCard({
  type,
  cpuPercent,
  memoryBytes,
  history,
}: {
  type: "cpu" | "memory";
  cpuPercent: number | null | undefined;
  memoryBytes: number | null | undefined;
  history: Array<{ time: number; cpu: number; memory: number }>;
}) {
  const isCpu = type === "cpu";
  const tone = isCpu ? cpuTone(cpuPercent) : memoryTone(memoryBytes);
  const memoryStr = formatMemory(memoryBytes);
  const cpuStr = formatCpu(cpuPercent);

  const cpuValues = history.map((h) => h.cpu);
  const memMbValues = history.map((h) => h.memory / (1024 * 1024));

  const peakCpu = cpuValues.length > 0 ? Math.max(...cpuValues) : (cpuPercent ?? 0);
  const avgCpu =
    cpuValues.length > 0
      ? cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length
      : (cpuPercent ?? 0);

  const peakMemMb =
    memMbValues.length > 0
      ? Math.max(...memMbValues)
      : memoryBytes
        ? memoryBytes / (1024 * 1024)
        : 0;
  const avgMemMb =
    memMbValues.length > 0
      ? memMbValues.reduce((a, b) => a + b, 0) / memMbValues.length
      : peakMemMb;

  const chartWidth = 240;
  const chartHeight = 44;
  const activeSeries = isCpu ? cpuValues : memMbValues;
  const maxVal = isCpu
    ? Math.max(10, Math.ceil(peakCpu * 1.25))
    : Math.max(50, Math.ceil(peakMemMb * 1.25));
  const minVal = 0;
  const { strokePath, areaPath, latestPoint } = buildSparklinePaths(
    activeSeries.length >= 2 ? activeSeries : [0, 0],
    chartWidth,
    chartHeight,
    { minVal, maxVal },
  );

  const badgeText = tone === "ok" ? "OPTIMAL" : tone === "warn" ? "ELEVATED" : "HIGH LOAD";

  return (
    <div className={`hardware-hud-card ${tone}`} role="tooltip" aria-hidden="true">
      <div className="hardware-hud-header">
        <div className="hardware-hud-title">
          <span className="hardware-hud-icon">
            {isCpu ? <CpuIcon /> : <RamIcon />}
          </span>
          <span className="hardware-hud-name">
            {isCpu ? "CPU TELEMETRY" : "MEMORY TELEMETRY"}
          </span>
        </div>
        <div className="hardware-hud-badge">
          <span className="badge-tag">STATUS</span>
          <span className="badge-val">{badgeText}</span>
        </div>
      </div>

      <div className="hardware-hud-chart-wrap">
        <div className="chart-meta-row">
          <span className="chart-label">
            {isCpu ? "CPU LOAD (30s REAL-TIME)" : "RESIDENT SET SIZE (RSS)"}
          </span>
          <span className="chart-current">
            {isCpu ? `${(cpuPercent ?? 0).toFixed(1)}%` : memoryStr}
          </span>
        </div>
        <svg className="hardware-hud-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`}>
          <defs>
            <linearGradient id={`grad-hw-${type}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.32" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <line
            x1="0"
            y1={chartHeight * 0.25}
            x2={chartWidth}
            y2={chartHeight * 0.25}
            className="hud-grid-line"
          />
          <line
            x1="0"
            y1={chartHeight * 0.5}
            x2={chartWidth}
            y2={chartHeight * 0.5}
            className="hud-grid-line"
          />
          <line
            x1="0"
            y1={chartHeight * 0.75}
            x2={chartWidth}
            y2={chartHeight * 0.75}
            className="hud-grid-line"
          />
          {areaPath && <path d={areaPath} fill={`url(#grad-hw-${type})`} />}
          {strokePath && <path d={strokePath} className="hud-chart-stroke" />}
          {latestPoint && (
            <circle cx={latestPoint.x} cy={latestPoint.y} r="2.5" className="hud-chart-point" />
          )}
        </svg>
      </div>

      <div className="hardware-hud-grid">
        <div className="hud-stat-cell">
          <span className="stat-label">CURRENT</span>
          <span className="stat-val">{isCpu ? cpuStr.replace("CPU ", "") : memoryStr}</span>
        </div>
        <div className="hud-stat-cell">
          <span className="stat-label">30s AVG</span>
          <span className="stat-val">
            {isCpu ? `${avgCpu.toFixed(1)}%` : `${Math.round(avgMemMb)} MB`}
          </span>
        </div>
        <div className="hud-stat-cell">
          <span className="stat-label">PEAK</span>
          <span className="stat-val">
            {isCpu ? `${peakCpu.toFixed(1)}%` : `${Math.round(peakMemMb)} MB`}
          </span>
        </div>
      </div>

      <div className="hardware-hud-meta">
        <span>Process: <b>sparkmux-desktop</b></span>
        <span>Polling: <b>1.0s delta</b></span>
      </div>

      <div className="hardware-hud-footer">
        <span className="telemetry-tag">◈ SYS-TELEMETRY</span>
        <span className="age-tag">live stream</span>
      </div>
    </div>
  );
}

export default function StatusBar({
  telemetry,
  usage,
  outputOpen,
  analyticsOpen,
  graphOpen,
  officeOpen,
  onOutput,
  onAnalytics,
  onGraph,
  onOffice,
  onRecipes,
  webRunning,
  webModalOpen,
  onWebServe,
}: {
  telemetry: AppTelemetry | null;
  usage?: LlmUsage | null;
  outputOpen: boolean;
  analyticsOpen?: boolean;
  graphOpen?: boolean;
  officeOpen?: boolean;
  onOutput: () => void;
  onAnalytics?: () => void;
  onGraph?: () => void;
  onOffice?: () => void;
  onRecipes: () => void;
  webRunning?: boolean;
  webModalOpen?: boolean;
  onWebServe?: () => void;
}) {
  const memory = formatMemory(telemetry?.memory_bytes);
  const cpu = formatCpu(telemetry?.cpu_percent);
  const chips = usageChips(usage, Date.now());

  const [telemetryHistory, setTelemetryHistory] = useState<
    Array<{ time: number; cpu: number; memory: number }>
  >([]);

  useEffect(() => {
    if (!telemetry) return;
    const sample = {
      time: Date.now(),
      cpu: telemetry.cpu_percent ?? 0,
      memory: telemetry.memory_bytes ?? 0,
    };
    setTelemetryHistory((prev) => {
      const next = [...prev, sample];
      return next.length > 30 ? next.slice(next.length - 30) : next;
    });
  }, [telemetry]);

  const memTone = memoryTone(telemetry?.memory_bytes);
  const cpuToneVal = cpuTone(telemetry?.cpu_percent);
  const cpuSeries = telemetryHistory.map((s) => s.cpu);
  const memSeries = telemetryHistory.map((s) => s.memory / (1024 * 1024));

  return (
    <footer className="status">
      <span className="status-metrics">
        {chips.length > 0 && (
          <span className="status-usage-row" role="region" aria-label="Model Quotas">
            {chips.map((chip, index) => {
              const label = chip.model ?? chip.text;
              return (
                <div
                  key={`${chip.model ?? chip.text}-${index}`}
                  className="status-pill-anchor"
                >
                  <span
                    className={`status-pill status-usage ${chip.tone}`}
                    tabIndex={0}
                    aria-label={
                      chip.meter
                        ? `Model allowance: ${chip.text}`
                        : `Bedrock usage: ${chip.text}`
                    }
                  >
                    <span className="status-pill-head">
                      <span className="status-pill-icon" aria-hidden="true">
                        <ModelHaloIcon
                          model={chip.model}
                          timeFraction={chip.timeFraction}
                          timeRemainingMs={chip.timeRemainingMs}
                          tone={chip.tone}
                          title={chip.resetsIn ? `Resets in ${chip.resetsIn}` : undefined}
                        />
                      </span>
                      <span className="status-pill-name">{label}</span>
                      {chip.window && (
                        <span className="status-pill-window">{chip.window}</span>
                      )}
                    </span>
                    {chip.percent != null && (
                      <span className="status-pill-value">{chip.percent}%</span>
                    )}
                    {chip.meter && (
                      <span className="status-pill-track" aria-hidden="true">
                        <span
                          className="status-pill-fill"
                          style={{ width: `${chip.fill}%` }}
                        />
                      </span>
                    )}
                  </span>
                  <ModelQuotaCard chip={chip} />
                </div>
              );
            })}
          </span>
        )}
        {chips.length > 0 && <span className="sep">·</span>}
        <div className="status-pill-anchor">
          <span
            className={`status-pill status-hardware ${memTone}`}
            tabIndex={0}
            title={`Sparkmux memory: ${memory}`}
            aria-label={`Sparkmux memory: ${memory}`}
          >
            <span className="status-pill-head">
              <span className="status-pill-icon hardware-pill-icon" aria-hidden="true">
                <RamIcon />
              </span>
              <span className="status-pill-name">{memory}</span>
            </span>
            <MiniSparkline values={memSeries} tone={memTone} />
          </span>
          <HardwareHudCard
            type="memory"
            cpuPercent={telemetry?.cpu_percent}
            memoryBytes={telemetry?.memory_bytes}
            history={telemetryHistory}
          />
        </div>
        <span className="sep">·</span>
        <div className="status-pill-anchor">
          <span
            className={`status-pill status-hardware ${cpuToneVal}`}
            tabIndex={0}
            title={`Sparkmux CPU: ${cpu}, percent of one core`}
            aria-label={`Sparkmux CPU: ${cpu}`}
          >
            <span className="status-pill-head">
              <span className="status-pill-icon hardware-pill-icon" aria-hidden="true">
                <CpuIcon />
              </span>
              <span className="status-pill-name cpu-pill-name">{padCpu(cpu)}</span>
            </span>
            <CpuHistogram values={cpuSeries} tone={cpuToneVal} />
          </span>
          <HardwareHudCard
            type="cpu"
            cpuPercent={telemetry?.cpu_percent}
            memoryBytes={telemetry?.memory_bytes}
            history={telemetryHistory}
          />
        </div>
      </span>
      <div className="status-action-pill" role="group" aria-label="Status actions">
        <button
          type="button"
          className={`status-pill-btn status-output${outputOpen ? " open" : ""}`}
          aria-pressed={outputOpen}
          aria-label="Agent output"
          title="Show Grok, Claude, and Antigravity logs"
          onClick={onOutput}
        >
          <span className="status-pill-btn-icon" aria-hidden="true">
            <svg
              className="status-pill-btn-svg"
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            >
              <path d="M3 4.5h10M3 8h10M3 11.5h6" />
            </svg>
          </span>
          <span className="status-pill-btn-text">Logs</span>
        </button>
        {onAnalytics && (
          <button
            type="button"
            className={`status-pill-btn status-stats${analyticsOpen ? " open" : ""}`}
            aria-pressed={analyticsOpen}
            aria-label="Agent telemetry & stats HUD"
            title="Show Sci-Fi Telemetry & Analytics HUD"
            onClick={onAnalytics}
          >
            <span className="status-pill-btn-icon" aria-hidden="true">◈</span>
            <span className="status-pill-btn-text">Stats</span>
          </button>
        )}
        {onGraph && (
          <button
            type="button"
            className={`status-pill-btn status-graph${graphOpen ? " open" : ""}`}
            aria-pressed={graphOpen}
            aria-label="Changed files graph"
            title="Show files changing in this repo"
            onClick={onGraph}
          >
            <span className="status-pill-btn-icon" aria-hidden="true">⬡</span>
            <span className="status-pill-btn-text">GIT</span>
          </button>
        )}
        {onOffice && (
          <button
            type="button"
            className={`status-pill-btn status-office${officeOpen ? " open" : ""}`}
            aria-pressed={officeOpen}
            aria-label="Agent office"
            title="Show agents in the 3D office"
            onClick={onOffice}
          >
            <span className="status-pill-btn-icon" aria-hidden="true">⌂</span>
            <span className="status-pill-btn-text">Office</span>
          </button>
        )}
        {onWebServe && (
          <button
            type="button"
            className={`status-pill-btn status-remote${webRunning ? " running" : ""}${webModalOpen ? " open" : ""}`}
            aria-pressed={webModalOpen}
            aria-label="Remote server URLs"
            title={
              webRunning
                ? "Remote server running — click to view URLs & QR code"
                : "Remote server offline — click to configure & start"
            }
            onClick={onWebServe}
          >
            <span className="status-pill-btn-icon" aria-hidden="true">
              <span className={`status-remote-dot${webRunning ? " active" : ""}`} />
            </span>
            <span className="status-pill-btn-text">Remote</span>
          </button>
        )}
      </div>
      <button
        type="button"
        className="status-recipes"
        aria-label="Frequently Used Command"
        title="Frequently Used Command"
        onClick={onRecipes}
      >
        <svg className="status-recipes-icon" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M6.15 6.15a1.85 1.85 0 1 1 2.95 1.5c-.62.32-.95.78-.95 1.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          <circle cx="8.15" cy="11.45" r="0.7" fill="currentColor" />
        </svg>
      </button>
    </footer>
  );
}
