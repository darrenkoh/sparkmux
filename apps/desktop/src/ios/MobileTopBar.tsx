import { useEffect, useState } from "react";

import {
  getConnectionHealth,
  subscribeConnectionHealth,
  wsTransport,
  isTauriRuntime,
  type ConnectionHealth,
} from "../transport";
import type { MobileSizingMode } from "./terminalSizing";

export interface MobileWindowChoice {
  id: string;
  name: string;
}

export interface MobileSessionChoice {
  name: string;
  windows: MobileWindowChoice[];
}

export interface MobilePaneChoice {
  id: string;
  command: string;
}

export type MobileCompanion = "output" | "map" | "gits" | "stats";

export interface MobileTopBarProps {
  posture: "phone-compact" | "phone-landscape";
  zen: boolean;
  onToggleZen: () => void;
  sessionName: string;
  windowName: string;
  sessions: MobileSessionChoice[];
  onSelectWindow: (sessionName: string, windowId: string) => void;
  panes: MobilePaneChoice[];
  activePaneId: string | null;
  tiled: boolean;
  onSelectPane: (paneId: string) => void;
  onToggleTile: () => void;
  sizingMode: MobileSizingMode;
  cols: number;
  rows: number;
  onToggleSizing: () => void;
  attention: boolean;
  onOpenSessions: () => void;
  onOpenCompanion: (which: MobileCompanion) => void;
}

function useConnectionHealth(): ConnectionHealth {
  const [health, setHealth] = useState<ConnectionHealth>(() => getConnectionHealth());
  useEffect(() => subscribeConnectionHealth(setHealth), []);
  return health;
}

export default function MobileTopBar({
  posture,
  zen,
  onToggleZen,
  sessionName,
  windowName,
  sessions,
  onSelectWindow,
  panes,
  activePaneId,
  tiled,
  onSelectPane,
  onToggleTile,
  sizingMode,
  cols,
  rows,
  onToggleSizing,
  attention,
  onOpenSessions,
  onOpenCompanion,
}: MobileTopBarProps) {
  const health = useConnectionHealth();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const landscape = posture === "phone-landscape";
  const reconnecting = health.state === "reconnecting" || health.state === "connecting";
  const rtt =
    health.rttMs == null ? "● …" : `● ${health.rttMs}ms`;

  if (zen && landscape) {
    return (
      <button
        type="button"
        className="mobile-zen-pill"
        aria-label="Leave fullscreen"
        onClick={onToggleZen}
      >
        ⤢
      </button>
    );
  }

  return (
    <header className={`mobile-top-bar ${landscape ? "landscape" : "portrait"}`}>
      <button
        type="button"
        className={`mobile-icon-btn ${attention ? "attn-pulse" : ""}`}
        aria-label="Sessions and agents"
        onClick={onOpenSessions}
      >
        ≡
        {attention && <span className="attn-dot" aria-hidden="true" />}
      </button>

      <div className="mobile-switcher">
        <button
          type="button"
          className="mobile-crumb"
          aria-expanded={switcherOpen}
          aria-label="Session and window switcher"
          onClick={() => setSwitcherOpen((open) => !open)}
        >
          {sessionName || "Session"} › {windowName || "Window"} ▾
        </button>
        {switcherOpen && (
          <div className="mobile-switcher-pop" role="menu">
            {sessions.map((session) =>
              session.windows.map((win) => (
                <button
                  key={`${session.name}:${win.id}`}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSwitcherOpen(false);
                    onSelectWindow(session.name, win.id);
                  }}
                >
                  {session.name} › {win.name}
                </button>
              )),
            )}
          </div>
        )}
      </div>

      <div className="mobile-pane-pills" role="tablist" aria-label="Panes">
        {panes.map((pane) => (
          <button
            key={pane.id}
            type="button"
            role="tab"
            className={activePaneId === pane.id ? "active" : ""}
            aria-selected={activePaneId === pane.id}
            onClick={() => onSelectPane(pane.id)}
          >
            {pane.id} {pane.command}
          </button>
        ))}
        {panes.length > 1 && (
          <button type="button" onClick={onToggleTile}>
            {tiled ? "⤢ Zoom" : "⊞ Tile"}
          </button>
        )}
      </div>

      <button
        type="button"
        className="mobile-size-btn"
        aria-label={sizingMode === "fit-phone" ? "Fit phone" : "Mirror desktop"}
        onClick={onToggleSizing}
      >
        {sizingMode === "fit-phone" ? "⊡ Fit" : "⇄ Mirror"} {cols}×{rows}
      </button>

      <div className="mobile-companions" role="group" aria-label="Companion views">
        <button type="button" onClick={() => onOpenCompanion("output")}>
          Output
        </button>
        <button type="button" onClick={() => onOpenCompanion("map")}>
          3D Map
        </button>
        <button type="button" onClick={() => onOpenCompanion("gits")}>
          Gits
        </button>
        <button type="button" onClick={() => onOpenCompanion("stats")}>
          Stats
        </button>
      </div>

      {landscape && (
        <button
          type="button"
          className="mobile-icon-btn"
          aria-label="Zen fullscreen"
          onClick={onToggleZen}
        >
          ⤢
        </button>
      )}

      <button
        type="button"
        className={`mobile-rtt ${reconnecting ? "reconnecting" : "live"}`}
        aria-label={reconnecting ? "Reconnecting" : `Latency ${health.rttMs ?? "unknown"} milliseconds`}
        onClick={() => {
          if (!isTauriRuntime()) void wsTransport.ensureConnected(true);
        }}
      >
        {reconnecting ? "⟳ Reconnecting" : rtt}
      </button>
    </header>
  );
}
