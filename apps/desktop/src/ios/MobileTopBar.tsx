import { useRef, useState } from "react";

import {
  headerClickOpens,
  headerControlFromAttr,
  idleHeaderPointer,
  reduceHeaderPointer,
  type HeaderControl,
  type HeaderPointerState,
} from "./posture";
import type { MobileSizingMode } from "./terminalSizing";

export interface MobilePaneChoice {
  id: string;
  command: string;
}

export type MobileCompanion = "output" | "gits" | "stats" | "map";

export interface MobileTopBarProps {
  landscape: boolean;
  sessionName: string;
  windowName: string;
  agentCount: number;
  waitingCount: number;
  currentIndex: number;
  targetCount: number;
  onCycle: (nextIndex: number) => void;
  onOpenHub: () => void;
  panes: MobilePaneChoice[];
  activePaneId: string | null;
  tiled: boolean;
  onSelectPane: (paneId: string) => void;
  onToggleTile: () => void;
  onSplit: () => void;
  onOpenView: (which: MobileCompanion) => void;
  onOpenRecipes: () => void;
  sizingMode: MobileSizingMode;
  cols: number;
  rows: number;
  onToggleSizing: () => void;
}

const VIEWS: { id: MobileCompanion; label: string }[] = [
  { id: "output", label: "Logs" },
  { id: "gits", label: "GIT" },
  { id: "stats", label: "Stats" },
  { id: "map", label: "3D Map" },
];

export default function MobileTopBar({
  landscape,
  sessionName,
  windowName,
  agentCount,
  waitingCount,
  currentIndex,
  targetCount,
  onCycle,
  onOpenHub,
  panes,
  activePaneId,
  tiled,
  onSelectPane,
  onToggleTile,
  onSplit,
  onOpenView,
  onOpenRecipes,
  sizingMode,
  cols,
  rows,
  onToggleSizing,
}: MobileTopBarProps) {
  const [viewsOpen, setViewsOpen] = useState(false);
  const pointer = useRef<HeaderPointerState>(idleHeaderPointer());
  const urgent = waitingCount > 0;
  const sessionLabel = `${sessionName || "Session"} › ${windowName || "Window"} ▾`;

  function controlFromTarget(target: EventTarget | null): HeaderControl | null {
    const el =
      target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    return headerControlFromAttr(
      el?.closest("[data-header-control]")?.getAttribute("data-header-control"),
    );
  }

  function runHeaderControl(control: HeaderControl) {
    switch (control) {
      case "agents":
      case "session":
        setViewsOpen(false);
        onOpenHub();
        return;
      case "views":
        setViewsOpen((open) => !open);
        return;
      case "recipes":
        setViewsOpen(false);
        onOpenRecipes();
        return;
      case "sizing":
        setViewsOpen(false);
        onToggleSizing();
        return;
      default:
        setViewsOpen(false);
        onOpenView(control);
    }
  }

  function applyPointer(event: React.PointerEvent<HTMLElement>, type: "down" | "move" | "up" | "cancel") {
    const result = reduceHeaderPointer(
      pointer.current,
      {
        type,
        x: event.clientX,
        y: event.clientY,
        control: type === "down" ? controlFromTarget(event.target) : null,
      },
      currentIndex,
      targetCount,
    );
    pointer.current = result.state;
    if (result.captureNow) event.currentTarget.setPointerCapture(event.pointerId);
    if (result.nextIndex != null) onCycle(result.nextIndex);
    if (result.activate) runHeaderControl(result.activate);
  }

  function onPointerDown(event: React.PointerEvent<HTMLElement>) {
    applyPointer(event, "down");
  }

  function onPointerMove(event: React.PointerEvent<HTMLElement>) {
    applyPointer(event, "move");
  }

  function onPointerUp(event: React.PointerEvent<HTMLElement>) {
    applyPointer(event, "up");
  }

  function onPointerCancel(event: React.PointerEvent<HTMLElement>) {
    applyPointer(event, "cancel");
  }

  function onPointerLeave(event: React.PointerEvent<HTMLElement>) {
    if (!pointer.current.tracking) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) return;
    applyPointer(event, "up");
  }

  function openIfTap(open: () => void) {
    const decision = headerClickOpens(pointer.current);
    pointer.current = decision.state;
    if (!decision.opens) return;
    open();
  }

  function openHub() {
    openIfTap(() => {
      setViewsOpen(false);
      onOpenHub();
    });
  }

  return (
    <div className="mobile-chrome">
      <header
        className={`mobile-top-bar ${landscape ? "landscape" : "portrait"}`}
        style={{ touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
      >
        <button
          type="button"
          className={`agents-pill${urgent ? " attn-pulse" : ""}`}
          data-header-control="agents"
          aria-label={urgent ? `${waitingCount} waiting` : `${agentCount} agents`}
          onClick={openHub}
        >
          {urgent ? `⚡ ${waitingCount} Waiting` : `⚡ Agents (${agentCount})`}
        </button>

        <button
          type="button"
          className="mobile-crumb"
          data-header-control="session"
          aria-label="Session and window"
          onClick={openHub}
        >
          {sessionLabel}
        </button>

        <button
          type="button"
          className="views-pill"
          data-header-control="views"
          aria-expanded={viewsOpen}
          aria-label="Views"
          onClick={() => {
            openIfTap(() => setViewsOpen((open) => !open));
          }}
        >
          ⋯ Views
        </button>

        {viewsOpen && (
          <div className="mobile-views-pop" role="menu" aria-label="Views">
            {VIEWS.map((view) => (
              <button
                key={view.id}
                type="button"
                role="menuitem"
                data-header-control={view.id}
                onClick={() => {
                  openIfTap(() => {
                    setViewsOpen(false);
                    onOpenView(view.id);
                  });
                }}
              >
                {view.label}
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              data-header-control="recipes"
              onClick={() => {
                openIfTap(() => {
                  setViewsOpen(false);
                  onOpenRecipes();
                });
              }}
            >
              Recipes (?)
            </button>
            <button
              type="button"
              role="menuitem"
              data-header-control="sizing"
              onClick={() => {
                openIfTap(() => {
                  setViewsOpen(false);
                  onToggleSizing();
                });
              }}
            >
              {sizingMode === "fit-phone" ? "Fit Device" : "Mirror Desktop"} ({cols}×{rows})
            </button>
          </div>
        )}
      </header>

      {panes.length > 1 && (
        <div className="mobile-pane-strip" role="tablist" aria-label="Panes">
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
          <button type="button" onClick={onToggleTile}>
            {tiled ? "⤢ Zoom" : "⊞ Tile"}
          </button>
          <button type="button" onClick={onSplit}>
            + Split
          </button>
        </div>
      )}
    </div>
  );
}
