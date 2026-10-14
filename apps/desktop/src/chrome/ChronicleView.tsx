import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  chronicleHologram,
  chronicleSession,
  clearChronicleCache,
  type ChronicleHologram as HologramPayload,
  type ChronicleSession,
} from "../api";
import ChronicleHologramPanel, { chroniclePanelBanners, chroniclePanelText } from "./ChronicleHologram";
import { mountChronicle, type ChronicleHandle, type ChronicleHooks } from "./ChronicleStage";
import {
  isNewestScrubStop,
  scrubDomain,
  stepScrub,
  type ChronicleKeyAction,
  type ChronicleKeyState,
} from "./chronicleKeys";
import { type StationLayoutInput } from "./chronicleLayout";
import {
  acceptHologram,
  generationFromSession,
  resolveActiveAfterPoll,
  sameGeneration,
  shouldRefetchHologram,
  type ChronicleGeneration,
} from "./chroniclePoll";

function asKind(kind: string): StationLayoutInput["kind"] {
  if (kind === "replace" || kind === "write" || kind === "delete" || kind === "patch" || kind === "notebook") {
    return kind;
  }
  return "patch";
}

function asOutcome(outcome: string): StationLayoutInput["outcome"] {
  if (outcome === "ok" || outcome === "error" || outcome === "unknown") return outcome;
  return "unknown";
}

function timeLabel(ms: number | null | undefined): string {
  if (ms == null) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString();
}

export default function ChronicleView(props: {
  command: string;
  cwd: string;
  title: string;
  pid: number;
  onKeyContext: (state: ChronicleKeyState) => void;
  applyRef: { current: (action: ChronicleKeyAction) => void };
  sceneSlotRef: RefObject<HTMLDivElement | null>;
}) {
  const { command, cwd, title, pid, onKeyContext, applyRef, sceneSlotRef } = props;
  const [sceneSlot, setSceneSlot] = useState<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ChronicleHandle | null>(null);
  const [session, setSession] = useState<ChronicleSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [tab, setTab] = useState<"file" | "diff">("file");
  const [hologram, setHologram] = useState<HologramPayload | null>(null);
  const [hologramError, setHologramError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pollNonce, setPollNonce] = useState(0);
  const [autoRotate, setAutoRotate] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const activeRef = useRef<string | null>(null);
  const newestRef = useRef<string | null>(null);
  const genRef = useRef<ChronicleGeneration | null>(null);
  const pathRef = useRef<string | null>(null);
  const appliedRef = useRef<{ id: string; generation: ChronicleGeneration } | null>(null);
  const failedHologramRef = useRef<{ id: string; generation: ChronicleGeneration } | null>(null);
  const hooksRef = useRef<ChronicleHooks>({ onActiveId: () => {} });

  const activeStation = session?.stations.find((station) => station.id === activeId) ?? null;
  const activePath = activeId?.startsWith("now:") ? activeId.slice(4) : (activeStation?.path ?? pathRef.current);
  if (activePath) pathRef.current = activePath;

  const nowAvailable = (path: string) =>
    session?.now.some((entry) => entry.path === path && entry.available) ?? false;

  const select = (id: string | null, nextStale: boolean) => {
    activeRef.current = id;
    setActiveId(id);
    setStale(nextStale);
  };

  const domain = useMemo(() => {
    if (!session) return [];
    return scrubDomain(session.stations, activeId ?? "", nowAvailable);
  }, [session, activeId]);

  const activeIndex = domain.indexOf(activeId ?? "");
  const activeFraction = domain.length > 1 && activeIndex >= 0 ? activeIndex / (domain.length - 1) : 1;
  const isFirst = activeIndex <= 0;
  const isLast = activeIndex >= domain.length - 1;
  const activeOrdinal = activeStation ? activeStation.ordinal : (activeId?.startsWith("now:") ? session?.stations.length ?? 0 : -1);

  // Auto-play timeline revisions
  useEffect(() => {
    if (!isPlaying || !session || session.stations.length === 0) return;
    const interval = setInterval(() => {
      const nextId = stepScrub(session.stations, activeRef.current ?? "", nowAvailable, 1);
      if (nextId) {
        select(nextId, false);
      } else {
        setIsPlaying(false);
      }
    }, 1200);
    return () => clearInterval(interval);
  }, [isPlaying, session]);

  const toggleAutoRotate = () => {
    const next = !autoRotate;
    setAutoRotate(next);
    handleRef.current?.setAutoRotate(next);
  };

  const handleResetCamera = () => {
    handleRef.current?.resetCamera();
  };

  const handlePrev = () => {
    if (!session) return;
    const nextId = stepScrub(session.stations, activeId ?? "", nowAvailable, -1);
    if (nextId) select(nextId, false);
  };

  const handleNext = () => {
    if (!session) return;
    const nextId = stepScrub(session.stations, activeId ?? "", nowAvailable, 1);
    if (nextId) select(nextId, false);
  };

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track || !session || session.stations.length === 0) return;
    const rect = track.getBoundingClientRect();
    const updateFromPointer = (clientX: number) => {
      const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const dom = scrubDomain(session.stations, activeRef.current ?? "", nowAvailable);
      if (dom.length === 0) return;
      const index = Math.min(dom.length - 1, Math.round(fraction * (dom.length - 1)));
      const targetId = dom[index];
      if (targetId) select(targetId, false);
    };
    updateFromPointer(e.clientX);
    const onMove = (ev: PointerEvent) => updateFromPointer(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  applyRef.current = (action) => {
    if (!action.swallow) return;
    if (action.action === "scene") {
      return;
    }
    if (!session) return;
    if (action.action === "latest") {
      const path = activePath;
      const latest =
        path && nowAvailable(path) ? `now:${path}` : (session.stations[session.stations.length - 1]?.id ?? null);
      select(latest, false);
      return;
    }
    if (action.action === "step") {
      if (stale) return;
      const nextId = stepScrub(session.stations, activeId ?? "", nowAvailable, action.delta);
      if (nextId) select(nextId, false);
      return;
    }
    if (action.action === "lane") {
      select(action.stationId, false);
    }
  };

  useLayoutEffect(() => {
    setSceneSlot(sceneSlotRef.current);
  }, [sceneSlotRef]);

  hooksRef.current.onActiveId = (id) => select(id, false);

  useEffect(() => {
    let cancel = false;
    let token = 0;
    activeRef.current = null;
    newestRef.current = null;
    genRef.current = null;
    appliedRef.current = null;
    failedHologramRef.current = null;
    pathRef.current = null;
    setSession(null);
    setActiveId(null);
    setStale(false);
    setHologram(null);
    setHologramError(null);
    setError(null);
    setLoading(false);
    const load = () => {
      const my = ++token;
      chronicleSession(command, cwd, title, pid)
        .then((next) => {
          if (cancel || my !== token) return;
          const generation = generationFromSession(next);
          if (genRef.current && sameGeneration(genRef.current, generation)) {
            if (failedHologramRef.current) setPollNonce((n) => n + 1);
            return;
          }
          const ordered = [...next.stations].sort((a, b) => a.ordinal - b.ordinal);
          const nowIds = next.now.filter((entry) => entry.available).map((entry) => `now:${entry.path}`);
          const resolved = resolveActiveAfterPoll(
            activeRef.current,
            newestRef.current,
            ordered.map((station) => station.id),
            nowIds,
          );
          genRef.current = generation;
          newestRef.current = resolved.newestRealId;
          activeRef.current = resolved.id;
          setSession({ ...next, stations: ordered });
          setActiveId(resolved.id);
          setStale(resolved.stale);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancel || my !== token) return;
          console.error(err);
          setError(err instanceof Error ? err.message : String(err));
        });
    };
    load();
    const interval = setInterval(load, 2500);
    return () => {
      cancel = true;
      clearInterval(interval);
    };
  }, [command, cwd, title, pid]);

  useEffect(() => {
    return () => {
      void clearChronicleCache().catch((err: unknown) => {
        console.error(err);
      });
    };
  }, []);

  useEffect(() => {
    onKeyContext({
      onNewest: isNewestScrubStop(activeId ?? "", session?.stations ?? [], nowAvailable),
      scene: "ridge",
      files: (session?.files ?? []).map((file) => ({ path: file.path, lane: file.lane })),
      stations: (session?.stations ?? []).map((station) => ({
        id: station.id,
        path: station.path,
        ordinal: station.ordinal,
      })),
      activeId: activeId ?? "",
      nowAvailable,
    });
  }, [onKeyContext, activeId, session]);

  const layoutStations = useMemo(() => {
    if (!session) return [];
    const real: StationLayoutInput[] = session.stations.map((station) => ({
      id: station.id,
      ordinal: station.ordinal,
      lane: station.lane,
      added: station.added,
      removed: station.removed,
      kind: asKind(station.kind),
      outcome: asOutcome(station.outcome),
      path: station.path,
      preview: station.preview,
      tool: station.tool,
    }));
    if (activePath && session.now.some((entry) => entry.path === activePath && entry.available)) {
      const file = session.files.find((entry) => entry.path === activePath);
      real.push({
        id: `now:${activePath}`,
        ordinal: session.stations.length,
        lane: file?.lane ?? 0,
        added: 0,
        removed: 0,
        kind: "now",
        outcome: "ok",
        path: activePath,
        preview: "",
      });
    }
    return real;
  }, [session, activePath]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = mountChronicle(host, hooksRef.current);
    handleRef.current = handle;
    const observer = new ResizeObserver(() => {
      handle.setSize(host.clientWidth, host.clientHeight);
    });
    observer.observe(host);
    handle.setSize(host.clientWidth, host.clientHeight);
    return () => {
      observer.disconnect();
      handleRef.current = null;
      handle.dispose();
    };
  }, []);

  useEffect(() => {
    const nowPaths = session?.now.filter((entry) => entry.available).map((entry) => entry.path) ?? [];
    handleRef.current?.setStations(layoutStations, "ridge", activeId ?? "", nowPaths);
  }, [layoutStations, activeId, session]);

  useEffect(() => {
    if (!session || !activeId || stale) {
      if (stale) setLoading(false);
      return;
    }
    const generation = generationFromSession(session);
    const next = { id: activeId, generation };
    if (!shouldRefetchHologram(appliedRef.current, next)) return;
    let cancel = false;
    failedHologramRef.current = null;
    setHologramError(null);
    setLoading(true);
    setHologram(null);
    chronicleHologram(command, cwd, title, pid, activeId)
      .then((body) => {
        if (cancel) return;
        const current = genRef.current;
        const currentId = activeRef.current ?? "";
        if (!current || !acceptHologram(body.station_id, currentId, generation, current)) {
          setLoading(false);
          return;
        }
        appliedRef.current = next;
        failedHologramRef.current = null;
        setHologram(body);
        setHologramError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancel) return;
        console.error(err);
        failedHologramRef.current = next;
        setHologramError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [session, activeId, stale, command, cwd, title, pid, pollNonce]);

  const newestReal = session?.stations[session.stations.length - 1]?.id ?? null;
  const showLive =
    !stale && newestReal != null && activeId != null && activeId !== newestReal && !activeId.startsWith("now:");
  const preview = activeStation?.preview ?? "";
  const text = chroniclePanelText({ tab, loading, preview, hologram });
  const banners = chroniclePanelBanners(hologram);

  useEffect(() => {
    if (!activeId || !text) return;
    handleRef.current?.setActiveContent(activeId, text);
  }, [activeId, text]);

  const when = timeLabel(activeStation?.timestamp_ms);
  const panelTitle =
    activePath == null
      ? ""
      : activeId?.startsWith("now:")
        ? `${activePath} · Now`
        : `${activePath} · #${activeStation?.ordinal ?? ""} · ${activeStation?.tool ?? ""} · +${activeStation?.added ?? 0} −${activeStation?.removed ?? 0}${when ? ` · ${when}` : ""}`;

  const toolbarControls = (
    <>
      <div className="chronicle-mode-tag">
        <span className="tag">01</span>
        <span>QUANTUM TOPOGRAPHY</span>
      </div>
      <button
        type="button"
        className={`graph-mode-btn ${autoRotate ? "on" : ""}`}
        aria-pressed={autoRotate}
        title="Toggle auto-rotation"
        onClick={toggleAutoRotate}
      >
        {autoRotate ? "AUTO: ON" : "AUTO: OFF"}
      </button>
      <button
        type="button"
        className="graph-mode-btn"
        title="Reset camera perspective"
        onClick={handleResetCamera}
      >
        RESET CAM
      </button>
    </>
  );

  return (
    <div className="graph-stage chronicle-view">
      {sceneSlot ? (
        createPortal(toolbarControls, sceneSlot)
      ) : (
        <div className="graph-mode-group chronicle-scene-bar" role="group" aria-label="Chronicle Controls">
          {toolbarControls}
        </div>
      )}

      {/* 3D Canvas Host with WebGL2 + 2D Tactical HUD */}
      <div ref={hostRef} className="chronicle-canvas-host" />

      {/* Top HUD Overlay Header & Viewport Hint */}
      <div className="chronicle-hud-overlay">
        <div className="chronicle-hud-badge">
          <span className="tag">CH</span>
          <span className="hud-title">CHRONICLE // QUANTUM TOPOGRAPHICAL RELIEF</span>
          {session && (
            <span className="hud-metric">
              {session.stations.length} EDITS · {session.files.length} FILES
            </span>
          )}
        </div>
        <div className="chronicle-viewport-hint">
          DRAG · ORBIT &nbsp;&nbsp; CLICK · SELECT &nbsp;&nbsp; WHEEL/ARROWS · SCRUB
        </div>
      </div>

      {/* Status Notifications */}
      <div className="chronicle-status">
        {error && (
          <div className="scifi-status-card error">
            <b>SCAN FAILED</b>
            <span>{error}</span>
          </div>
        )}
        {!session && !error && (
          <div className="scifi-status-card">
            <b>READING SESSION…</b>
            <span>Gathering the focused pane's agent edits.</span>
          </div>
        )}
        {session?.empty_reason && (
          <div className="scifi-status-card">
            <b>{session.empty_reason}</b>
            <span>
              Chronicle follows the focused pane's Grok, Claude, or Antigravity session and does not read git history.
            </span>
          </div>
        )}
        {(session?.truncated_tail || (session?.omitted ?? 0) > 0) && (
          <p className="scifi-status-notice">Showing latest part of this session. Earlier edits are not loaded.</p>
        )}
        {hologramError && (
          <div className="scifi-status-card error">
            <b>SCAN FAILED</b>
            <span>{hologramError}</span>
          </div>
        )}
        {stale && <p className="scifi-status-notice">This edit is no longer in the loaded window.</p>}
      </div>

      {/* Interactive Bottom Timeline Scrubber */}
      <div className="chronicle-bottombar">
        <div className="chronicle-playback-controls">
          <button
            type="button"
            className="chronicle-scrub-btn"
            onClick={handlePrev}
            disabled={isFirst}
            title="Previous revision (Arrow Left)"
          >
            ◀
          </button>
          <button
            type="button"
            className={`chronicle-scrub-btn play-btn ${isPlaying ? "on" : ""}`}
            onClick={() => setIsPlaying(!isPlaying)}
            title={isPlaying ? "Pause timeline playback" : "Auto-play revision timeline"}
          >
            {isPlaying ? "❚❚ PAUSE" : "▶ PLAY"}
          </button>
          <button
            type="button"
            className="chronicle-scrub-btn"
            onClick={handleNext}
            disabled={isLast}
            title="Next revision (Arrow Right)"
          >
            ▶
          </button>
          <span className="chronicle-step-counter">
            REV {activeOrdinal >= 0 ? activeOrdinal + 1 : domain.length} / {Math.max(1, domain.length)}
          </span>
        </div>

        <div
          ref={trackRef}
          className="chronicle-track-container"
          onPointerDown={handleTrackPointerDown}
          role="slider"
          aria-label="Chronicle Revision Timeline"
          aria-valuemin={1}
          aria-valuemax={Math.max(1, domain.length)}
          aria-valuenow={activeOrdinal >= 0 ? activeOrdinal + 1 : domain.length}
          tabIndex={0}
          title="Click or drag across the timeline track to scrub revisions"
        >
          <div className="chronicle-track-line" />
          {domain.map((id, index) => {
            const station = session?.stations.find((s) => s.id === id);
            const isNow = id.startsWith("now:");
            const frac = domain.length > 1 ? index / (domain.length - 1) : 0.5;
            const tickKind = isNow ? "now" : (station?.kind ?? "patch");
            const isCurrent = id === activeId;
            return (
              <div
                key={id}
                className={`chronicle-tick ${tickKind} ${isCurrent ? "active" : ""}`}
                style={{ left: `${frac * 100}%` }}
                title={isNow ? "Live Now" : `#${station?.ordinal} ${station?.path} (+${station?.added}/-${station?.removed})`}
              />
            );
          })}
          <div
            className="chronicle-track-thumb"
            style={{ left: `${activeFraction * 100}%` }}
          />
        </div>

        <div className="chronicle-meta-chips">
          {activeStation && (
            <>
              {activeStation.tool && (
                <span className="chronicle-chip tool" title={`Tool: ${activeStation.tool}`}>
                  {activeStation.tool}
                </span>
              )}
              <span className="chronicle-chip diff">
                +{activeStation.added} −{activeStation.removed}
              </span>
            </>
          )}
          {showLive && (
            <button
              type="button"
              className="chronicle-chip live-btn"
              onClick={() => {
                if (newestReal) select(newestReal, false);
              }}
              title="Jump to newest revision"
            >
              ● LIVE
            </button>
          )}
        </div>
      </div>

      {/* Hologram Inspector Panel */}
      {activeId && activePath && (
        <ChronicleHologramPanel title={panelTitle} banners={banners} tab={tab} onTab={setTab} text={text} />
      )}
    </div>
  );
}
