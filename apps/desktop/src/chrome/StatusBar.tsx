import type { TmuxStatus } from "../types";
import {
  formatCpu,
  formatMemory,
  helperStatusText,
  helperStatusTitle,
  type AppTelemetry,
} from "./telemetry";

export default function StatusBar({
  status,
  session,
  windowName,
  telemetry,
  outputOpen,
  analyticsOpen,
  onOutput,
  onAnalytics,
  onAsk,
}: {
  status: TmuxStatus | null;
  session: string | null;
  windowName: string | null;
  telemetry: AppTelemetry | null;
  outputOpen: boolean;
  analyticsOpen?: boolean;
  onOutput: () => void;
  onAnalytics?: () => void;
  onAsk?: () => void;
}) {
  const tmux = status?.version ?? "tmux";
  const sock = status?.socket_name ? `-L ${status.socket_name}` : "-L sparkmux";
  const loc =
    session && windowName ? `${session}:${windowName}` : session ?? "—";
  const helper = helperStatusText(telemetry);
  const memory = formatMemory(telemetry?.memory_bytes);
  const cpu = formatCpu(telemetry?.cpu_percent);
  return (
    <footer className="status">
      <span>{tmux}</span>
      <span className="sep">·</span>
      <span>{sock}</span>
      <span className="sep">·</span>
      <span className="status-loc">{loc}</span>
      <span className="status-metrics">
        <span
          className="status-helper"
          title={helperStatusTitle(telemetry)}
          aria-label={`Command helper model: ${helper}`}
        >
          {helper}
        </span>
        <span className="sep">·</span>
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
      {onAsk && (
        <button type="button" className="status-ask" onClick={onAsk} aria-label="Ask">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M2.5 3.25h11a1.25 1.25 0 0 1 1.25 1.25v6.1a1.25 1.25 0 0 1-1.25 1.25H8.1L4.4 14.2v-2.35H2.5a1.25 1.25 0 0 1-1.25-1.25V4.5A1.25 1.25 0 0 1 2.5 3.25z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
          Ask
        </button>
      )}
    </footer>
  );
}
