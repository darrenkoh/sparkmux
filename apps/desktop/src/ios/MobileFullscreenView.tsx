import { useEffect } from "react";

import AnalyticsHud from "../chrome/AnalyticsHud";
import ArtifactPanel from "../chrome/ArtifactPanel";
import ChangeGraph from "../chrome/ChangeGraph";
import type { MobileCompanion } from "./MobileTopBar";

export interface MobileFullscreenViewProps {
  kind: MobileCompanion;
  sessionName: string;
  tabId: string;
  windowName: string;
  command: string;
  cwd: string;
  title: string;
  pid: number;
  onBack: () => void;
  onChange: (kind: MobileCompanion) => void;
  onPopOutStats?: () => void;
  onPopOutGits?: () => void;
}

const SWITCH: { id: MobileCompanion; label: string }[] = [
  { id: "output", label: "Logs" },
  { id: "gits", label: "Gits" },
  { id: "stats", label: "Stats" },
  { id: "map", label: "3D Map" },
];

export default function MobileFullscreenView({
  kind,
  sessionName,
  tabId,
  windowName,
  command,
  cwd,
  title,
  pid,
  onBack,
  onChange,
  onPopOutStats,
  onPopOutGits,
}: MobileFullscreenViewProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const sessionLabel = `${sessionName || "Session"} › ${windowName || "Window"}`;

  return (
    <div className="mobile-fullscreen-view" role="dialog" aria-modal="true" aria-label={sessionLabel}>
      <header className="mobile-fullscreen-bar">
        <button type="button" className="mobile-back" onClick={onBack}>
          ← Terminal
        </button>
        <strong className="mobile-fullscreen-title">{sessionLabel}</strong>
        <div className="mobile-fullscreen-switch" role="tablist" aria-label="Logs Gits Stats 3D Map">
          {SWITCH.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={kind === item.id}
              className={kind === item.id ? "on" : ""}
              onClick={() => onChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>
      <div className="mobile-fullscreen-body">
        {kind === "output" && (
          <ArtifactPanel
            key={`${pid}:${cwd}`}
            command={command}
            cwd={cwd}
            title={title}
            pid={pid}
            onCollapse={onBack}
            isDocked
          />
        )}
        {kind === "gits" && (
          <ChangeGraph
            sessionName={sessionName || "sparkmux"}
            tabId={tabId || "main"}
            tabName={windowName || "shell"}
            command={command}
            cwd={cwd}
            title={title}
            pid={pid}
            onClose={onBack}
            onPopOut={onPopOutGits}
          />
        )}
        {(kind === "stats" || kind === "map") && (
          <AnalyticsHud
            sessionName={sessionName || "sparkmux"}
            tabId={tabId || "main"}
            tabName={windowName || "shell"}
            command={command}
            cwd={cwd}
            title={title}
            pid={pid}
            phoneLayout
            initialPhonePane={kind === "stats" ? "telemetry" : "map"}
            onClose={onBack}
            onPopOut={onPopOutStats}
          />
        )}
      </div>
    </div>
  );
}
