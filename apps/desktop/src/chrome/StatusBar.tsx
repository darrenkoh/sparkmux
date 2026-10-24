import type { LlmUsage, TmuxStatus } from "../types";
import { usageChips, type UsageChip } from "./llmUsage";
import { formatCpu, formatMemory, type AppTelemetry } from "./telemetry";

function ModelIcon({ model }: { model?: string }) {
  const lower = (model ?? "").toLowerCase();
  if (
    lower.includes("gemini") ||
    lower.includes("argon") ||
    lower.includes("flash") ||
    lower.includes("pro")
  ) {
    return (
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
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
      >
        <path d="M8 2.5v11M3.5 5.25l9 5.5M3.5 10.75l9-5.5" />
      </svg>
    );
  }
  if (lower.includes("grok")) {
    return (
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M3 13.5L10.5 2h2.5L5.5 13.5H3z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
    </svg>
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
            <ModelIcon model={chip.model} />
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
          <div className="cost-row">
            <span>Today's Total</span>
            <b>{cost.todayUsd}</b>
          </div>
          <div className="cost-note">
            {cost.estimated
              ? "Estimated from token consumption"
              : "Direct Bedrock API metrics"}
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

export default function StatusBar({
  status,
  session,
  windowName,
  telemetry,
  usage,
  outputOpen,
  analyticsOpen,
  graphOpen,
  onOutput,
  onAnalytics,
  onGraph,
}: {
  status: TmuxStatus | null;
  session: string | null;
  windowName: string | null;
  telemetry: AppTelemetry | null;
  usage?: LlmUsage | null;
  outputOpen: boolean;
  analyticsOpen?: boolean;
  graphOpen?: boolean;
  onOutput: () => void;
  onAnalytics?: () => void;
  onGraph?: () => void;
}) {
  const tmux = status?.version ?? "tmux";
  const sock = status?.socket_name ? `-L ${status.socket_name}` : "-L sparkmux";
  const loc =
    session && windowName ? `${session}:${windowName}` : session ?? "—";
  const memory = formatMemory(telemetry?.memory_bytes);
  const cpu = formatCpu(telemetry?.cpu_percent);
  const chips = usageChips(usage, Date.now());
  return (
    <footer className="status">
      <span>{tmux}</span>
      <span className="sep">·</span>
      <span>{sock}</span>
      <span className="sep">·</span>
      <span className="status-loc">{loc}</span>
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
                        <ModelIcon model={chip.model} />
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
        <span title={`Sparkmux memory: ${memory}`} aria-label={`Sparkmux memory: ${memory}`}>
          {memory}
        </span>
        <span className="sep">·</span>
        <span
          title={`Sparkmux CPU: ${cpu}, percent of one core`}
          aria-label={`Sparkmux CPU: ${cpu}`}
        >
          {cpu}
        </span>
      </span>
      <button
        type="button"
        className={`status-output${outputOpen ? " open" : ""}`}
        aria-pressed={outputOpen}
        aria-label="Agent output"
        title="Show Grok, Claude, and Antigravity output"
        onClick={onOutput}
      >
        Output
      </button>
      {onAnalytics && (
        <button
          type="button"
          className={`status-stats${analyticsOpen ? " open" : ""}`}
          aria-pressed={analyticsOpen}
          aria-label="Agent telemetry & stats HUD"
          title="Show Sci-Fi Telemetry & Analytics HUD"
          onClick={onAnalytics}
        >
          ◈ Stats
        </button>
      )}
      {onGraph && (
        <button
          type="button"
          className={`status-graph${graphOpen ? " open" : ""}`}
          aria-pressed={graphOpen}
          aria-label="Changed files graph"
          title="Show files changing in this repo"
          onClick={onGraph}
        >
          ⬡ Gits
        </button>
      )}
    </footer>
  );
}
