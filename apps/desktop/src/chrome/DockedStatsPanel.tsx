import { useEffect, useRef, useState } from "react";
import { tabAnalytics, type TabAnalyticsResponse } from "../api";
import { formatDuration, formatMs, formatNum, formatUsd } from "./analyticsFormat";
import { cliLabel } from "./artifactModel";
import { aggregateMiniStats, type ChannelBreakdownItem } from "./miniStatModel";
import TerrainViewport from "./TerrainViewport";

export interface DockedStatsPanelProps {
  sessionName: string;
  tabId: string;
  tabName: string;
  command: string;
  cwd: string;
  title: string;
  pid: number;
  paused?: boolean;
  onExpand: () => void;
  onPopOut?: () => void;
  onClose: () => void;
}

const CHANNEL_TAGS: Record<ChannelBreakdownItem["key"], string> = {
  user: "USR",
  think: "THK",
  reply: "RPL",
  tool: "TOL",
};

export default function DockedStatsPanel({
  sessionName,
  tabId,
  tabName,
  command,
  cwd,
  title,
  pid,
  paused = false,
  onExpand,
  onPopOut,
  onClose,
}: DockedStatsPanelProps) {
  const [data, setData] = useState<TabAnalyticsResponse | null>(null);
  const [bound, setBound] = useState({ sessionName, tabId });
  const [subsOpen, setSubsOpen] = useState(true);
  const [mapColor, setMapColor] = useState<"mono" | "color">("color");
  const fetchGen = useRef(0);
  const mapSlotRef = useRef<HTMLDivElement>(null);
  // Keep the last real transcript so a missed CLI read does not reset the pan.
  const transcriptKey = useRef("");
  if (bound.sessionName !== sessionName || bound.tabId !== tabId) {
    fetchGen.current += 1;
    transcriptKey.current = "";
    setBound({ sessionName, tabId });
    setData(null);
    setSubsOpen(true);
  }
  const path = data?.transcript_path ?? "";
  if (path) transcriptKey.current = path;

  const fetchData = () => {
    const gen = fetchGen.current;
    const session = sessionName;
    const tab = tabId;
    tabAnalytics(session, tab, command, cwd, title, pid)
      .then((res) => {
        if (gen !== fetchGen.current) return;
        if (res.session_name !== session || res.tab_id !== tab) return;
        setData(res);
      })
      .catch((err) => console.error("tabAnalytics docked error:", err));
  };

  useEffect(() => {
    if (paused) return;
    fetchData();
    const interval = setInterval(fetchData, 1000);
    return () => clearInterval(interval);
  }, [sessionName, tabId, command, cwd, title, pid, paused]);

  if (paused) {
    return <div className="docked-stats-panel" aria-label="Docked area map" />;
  }

  // Active agent session only. Tab Cumulative stays on the fullscreen counters.
  const mapStats = data?.stats;
  const mapKey = `${sessionName}\0${tabId}\0${transcriptKey.current}`;
  const summary = aggregateMiniStats(mapStats, data?.cli ?? null, Date.now());
  const cliText = (cliLabel(data?.cli ?? null) || "IDLE").toUpperCase();
  const { agent, subagents } = summary;
  const channelTotal = summary.channels.reduce((sum, ch) => sum + ch.count, 0);
  const toolHealth =
    summary.toolErrors > 0 ? `${summary.toolErrors} ERR` : "0 err";

  const resetCamera = () => {
    const canvas = mapSlotRef.current?.querySelector("canvas.scifi-terrain-canvas");
    canvas?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  };

  return (
    <div className="docked-stats-panel" aria-label="Docked area map">
      <header className="mini-stat-header">
        <div className="mini-stat-brand">
          <span className="mini-stat-title">
            <span className={`mini-stat-dot${agent.isLive ? " live" : ""}`} />
            ◈ MINI STAT
          </span>
          <span className={`mini-stat-cli${cliText === "IDLE" ? " idle" : ""}`}>{cliText}</span>
        </div>
        <div className="mini-stat-actions">
          <button
            type="button"
            className="mini-stat-btn"
            onClick={onExpand}
            title="Expand to Fullscreen Telemetry HUD"
            aria-label="Expand to Fullscreen Telemetry HUD"
          >
            ⤢
          </button>
          {onPopOut && (
            <button
              type="button"
              className="mini-stat-btn"
              onClick={onPopOut}
              title="Open Stats in a separate desktop window"
              aria-label="Open Stats in a separate window"
            >
              ⧉
            </button>
          )}
          <button
            type="button"
            className="mini-stat-btn"
            onClick={onClose}
            title="Close Docked Area Map"
            aria-label="Close Docked Area Map"
          >
            ✕
          </button>
        </div>
      </header>

      <div className="mini-stat-deck">
        <div className="mini-agent-card">
          <span className="mini-agent-model" title={mapStats?.active_model || "No model yet"}>
            {agent.activeModel || "—"}
          </span>
          <span className={`mini-live-pill${agent.isLive ? " live" : ""}`}>
            {agent.isLive ? "LIVE" : "IDLE"}
          </span>
          <span>TURNS: {agent.turnCount}</span>
          <span>AVG: {formatDuration(agent.avgTurnMs)}</span>
          <span>TTFT: {formatMs(Math.round(agent.ttftMs))}</span>
        </div>

        <div className="mini-channels-card">
          <div className="mini-channel-grid">
            {summary.channels.map((ch) => (
              <div key={ch.key} className="mini-channel-cell">
                <span className="mini-channel-dot" style={{ background: ch.color }} />
                <span className="mini-channel-tag">{CHANNEL_TAGS[ch.key]}</span>
                <span className="mini-channel-count">{formatNum(ch.count)}</span>
              </div>
            ))}
          </div>
          <div className="mini-channel-bar" aria-hidden="true">
            {channelTotal <= 0 ? (
              <span className="mini-channel-seg is-empty" />
            ) : (
              summary.channels.map((ch) => (
                <span
                  key={ch.key}
                  className="mini-channel-seg"
                  style={{ width: `${ch.pct}%`, background: ch.color }}
                />
              ))
            )}
          </div>
        </div>

        <div className="mini-kpi-grid">
          <div
            className="mini-kpi-cell"
            title={`${formatNum(summary.inputTokens)} in, ${formatNum(summary.outputTokens)} out, ${formatNum(summary.reasoningTokens)} reasoning`}
          >
            <span className="mini-kpi-label">TOKENS</span>
            <span className="mini-kpi-value">{formatNum(summary.totalTokens)}</span>
            <span className="mini-kpi-sub">
              {formatNum(summary.inputTokens)} in · {formatNum(summary.outputTokens)} out
            </span>
          </div>
          <div className="mini-kpi-cell">
            <span className="mini-kpi-label">COST · CACHE</span>
            <span className="mini-kpi-value mini-cost">{formatUsd(summary.estimatedCostUsd)}</span>
            <span className="mini-kpi-sub">{summary.cacheHitRate.toFixed(0)}% cache hit</span>
            <span className="mini-cache-bar" aria-hidden="true">
              <span style={{ width: `${Math.max(0, Math.min(100, summary.cacheHitRate))}%` }} />
            </span>
          </div>
          <div className="mini-kpi-cell">
            <span className="mini-kpi-label">TOOLS</span>
            <span className="mini-kpi-value">{formatNum(summary.toolCalls)}</span>
            <span className={`mini-kpi-sub${summary.toolErrors > 0 ? " is-err" : ""}`}>
              {toolHealth} · {formatMs(Math.round(summary.avgToolLatencyMs))} avg
            </span>
          </div>
          <div className="mini-kpi-cell">
            <span className="mini-kpi-label">CODE DELTA</span>
            <span className="mini-kpi-value">
              +{summary.linesAdded} / -{summary.linesRemoved}
            </span>
            <span className="mini-churn-bar" aria-hidden="true">
              <span className="mini-churn-add" style={{ width: `${summary.addRatioPct}%` }} />
              <span className="mini-churn-del" style={{ width: `${100 - summary.addRatioPct}%` }} />
            </span>
          </div>
        </div>

        <div className="mini-subagents-card">
          {subagents.totalCount > 0 ? (
            <button
              type="button"
              className="mini-subagents-head"
              onClick={() => setSubsOpen((open) => !open)}
              aria-expanded={subsOpen}
            >
              <span className="mini-sub-title">
                {subsOpen ? "▾" : "▸"} SUBAGENTS ({subagents.totalCount})
              </span>
              <span className="mini-sub-summary">
                {formatNum(subagents.totalTokens)} tok · {subagents.totalToolCalls} tools
                {subagents.totalErrors > 0 && (
                  <span className="mini-err">{subagents.totalErrors} ERR</span>
                )}
              </span>
            </button>
          ) : (
            <div className="mini-subagents-head">
              <span className="mini-sub-title">SUBAGENTS (0)</span>
              <span className="mini-sub-summary">0 tok · 0 tools</span>
            </div>
          )}
          {subagents.totalCount > 0 && subsOpen && (
            <div className="mini-subagent-list">
              {subagents.rows.map((row, index) => (
                <div className="mini-subagent-row" key={`${row.id}:${index}`}>
                  <span className={`sub-dot${row.isLive ? " live" : ""}`} />
                  <span
                    className="sub-name"
                    title={`${row.modelShort || "unknown model"} · +${row.linesAdded}/-${row.linesRemoved} · ${row.toolErrors} err · ${row.id}`}
                  >
                    {row.name}
                  </span>
                  <span className="sub-model">{row.modelShort || "—"}</span>
                  <span className="sub-metrics">
                    {formatNum(row.totalTokens)}t · {row.toolCalls}⚙
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mini-map-container" ref={mapSlotRef}>
        <TerrainViewport
          timeline={mapStats?.timeline ?? []}
          activeModel={mapStats?.active_model}
          sessionName={sessionName}
          tabName={tabName}
          stats={mapStats}
          mapKey={mapKey}
          docked={true}
          hideDockedControls={true}
          colorMode={mapColor}
          onExpand={onExpand}
          onPopOut={onPopOut}
          onClose={onClose}
        />
        <div className="mini-map-label">◈ 3D TOPOGRAPHY</div>
        <div className="mini-map-tools">
          <button
            type="button"
            className="mini-map-tool"
            onClick={() => setMapColor((mode) => (mode === "color" ? "mono" : "color"))}
            aria-label={mapColor === "color" ? "Switch area map to mono" : "Switch area map to spectral"}
          >
            {mapColor === "color" ? "SPECTRAL" : "MONO"}
          </button>
          <button
            type="button"
            className="mini-map-tool"
            onClick={resetCamera}
            aria-label="Reset area map camera"
          >
            RESET CAM
          </button>
        </div>
      </div>
    </div>
  );
}
