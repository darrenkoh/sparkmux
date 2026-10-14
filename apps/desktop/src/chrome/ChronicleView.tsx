import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  chronicleHologram,
  chronicleSession,
  clearChronicleCache,
  type ChronicleHologram as HologramPayload,
  type ChronicleSession,
} from "../api";
import { chroniclePanelBanners, chroniclePanelText } from "./ChronicleHologram";
import {
  isNewestScrubStop,
  scrubDomain,
  stepScrub,
  type ChronicleKeyAction,
  type ChronicleKeyState,
} from "./chronicleKeys";
import {
  acceptHologram,
  generationFromSession,
  resolveActiveAfterPoll,
  sameGeneration,
  shouldRefetchHologram,
  type ChronicleGeneration,
} from "./chroniclePoll";

function timeLabel(ms: number | null | undefined): string {
  if (ms == null) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString();
}

export interface DiffHunkInfo {
  id: string;
  header: string;
  oldStart: number;
  newStart: number;
  lineIndex: number;
  summary: string;
}

function parseDiffHunks(text: string): DiffHunkInfo[] {
  if (!text) return [];
  const lines = text.split("\n");
  const hunks: DiffHunkInfo[] = [];
  lines.forEach((line, idx) => {
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      const summary = match && match[3] ? match[3].trim() : "";
      hunks.push({
        id: `hunk-${idx}`,
        header: line,
        oldStart: match ? parseInt(match[1], 10) : 0,
        newStart: match ? parseInt(match[2], 10) : 0,
        lineIndex: idx,
        summary,
      });
    }
  });
  return hunks;
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
  const trackRef = useRef<HTMLDivElement>(null);
  const activeCardRef = useRef<HTMLDivElement | null>(null);
  const viewerBodyRef = useRef<HTMLDivElement | null>(null);

  const [session, setSession] = useState<ChronicleSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [tab, setTab] = useState<"file" | "diff">("diff");
  const [hologram, setHologram] = useState<HologramPayload | null>(null);
  const [hologramError, setHologramError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pollNonce, setPollNonce] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const activeRef = useRef<string | null>(null);
  const newestRef = useRef<string | null>(null);
  const genRef = useRef<ChronicleGeneration | null>(null);
  const pathRef = useRef<string | null>(null);
  const appliedRef = useRef<{ id: string; generation: ChronicleGeneration } | null>(null);
  const failedHologramRef = useRef<{ id: string; generation: ChronicleGeneration } | null>(null);

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

  // Auto-scroll the active card in the horizontal deck into view
  useEffect(() => {
    if (activeCardRef.current) {
      activeCardRef.current.scrollIntoView({
        behavior: "smooth",
        inline: "center",
        block: "nearest",
      });
    }
  }, [activeId]);

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
    }, 1400);
    return () => clearInterval(interval);
  }, [isPlaying, session]);

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
    if (action.action === "scene") return;
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
  const when = timeLabel(activeStation?.timestamp_ms);

  const hunks = useMemo(() => {
    return parseDiffHunks(text);
  }, [text]);

  const handleCopy = () => {
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  };

  const handleJumpToHunk = (lineIndex: number) => {
    const el = document.getElementById(`diff-line-${lineIndex}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  // Parse lines for two-column diff line numbering
  const parsedLines = useMemo(() => {
    if (!text) return [];
    const rawLines = text.split("\n");
    let oldLineNum = 0;
    let newLineNum = 0;

    return rawLines.map((line, idx) => {
      const isHunk = line.startsWith("@@");
      const isAdd = line.startsWith("+") && !line.startsWith("+++");
      const isDel = line.startsWith("-") && !line.startsWith("---");
      const isMeta =
        line.startsWith("diff ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ");

      let oldNum: number | null = null;
      let newNum: number | null = null;

      if (isHunk) {
        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          oldLineNum = parseInt(match[1], 10);
          newLineNum = parseInt(match[2], 10);
        }
      } else if (isAdd) {
        newNum = newLineNum++;
      } else if (isDel) {
        oldNum = oldLineNum++;
      } else if (!isMeta) {
        oldNum = oldLineNum++;
        newNum = newLineNum++;
      }

      return {
        line,
        idx,
        isHunk,
        isAdd,
        isDel,
        isMeta,
        oldNum,
        newNum,
      };
    });
  }, [text]);

  const filteredLines = useMemo(() => {
    if (!searchQuery.trim()) return parsedLines;
    const q = searchQuery.toLowerCase();
    return parsedLines.filter((item) => item.line.toLowerCase().includes(q));
  }, [parsedLines, searchQuery]);

  const totalAdded = session?.stations.reduce((acc, s) => acc + s.added, 0) ?? 0;
  const totalRemoved = session?.stations.reduce((acc, s) => acc + s.removed, 0) ?? 0;

  const toolbarControls = (
    <>
      <div className="chronicle-mode-tag">
        <span className="tag">CH</span>
        <span>DIFF STUDIO</span>
      </div>
      <button
        type="button"
        className={`graph-mode-btn ${isPlaying ? "on" : ""}`}
        aria-pressed={isPlaying}
        title={isPlaying ? "Pause auto-play" : "Auto-play revision stream"}
        onClick={() => setIsPlaying(!isPlaying)}
      >
        {isPlaying ? "❚❚ PAUSE" : "▶ PLAY"}
      </button>
      <button
        type="button"
        className="graph-mode-btn"
        title="Previous revision (Arrow Left)"
        onClick={handlePrev}
        disabled={isFirst}
      >
        ◀ PREV
      </button>
      <button
        type="button"
        className="graph-mode-btn"
        title="Next revision (Arrow Right)"
        onClick={handleNext}
        disabled={isLast}
      >
        NEXT ▶
      </button>
      {showLive && (
        <button
          type="button"
          className="graph-mode-btn on"
          title="Jump to live worktree state"
          onClick={() => {
            if (newestReal) select(newestReal, false);
          }}
        >
          ● LIVE
        </button>
      )}
    </>
  );

  return (
    <div className="graph-stage chronicle-view chronicle-studio">
      {sceneSlot ? (
        createPortal(toolbarControls, sceneSlot)
      ) : (
        <div className="graph-mode-group chronicle-scene-bar" role="group" aria-label="Chronicle Controls">
          {toolbarControls}
        </div>
      )}

      {/* 1. TOP CAROUSEL: 2D CYBERNETIC REVISION DECK */}
      <div className="chronicle-deck-section">
        <div className="chronicle-deck-header">
          <div className="deck-title-group">
            <span className="deck-tag">REVISIONS</span>
            <span className="deck-count">
              {domain.length} STEPS &nbsp;·&nbsp; {session?.files.length ?? 0} FILES MODIFIED
            </span>
          </div>
          <div className="deck-meta-stats">
            <span className="deck-churn-total add">+{totalAdded}</span>
            <span className="deck-churn-total del">−{totalRemoved}</span>
            <span className="deck-active-label">
              REV {activeOrdinal >= 0 ? activeOrdinal + 1 : domain.length} OF {Math.max(1, domain.length)}
            </span>
          </div>
        </div>

        <div className="chronicle-timeline-deck" role="region" aria-label="Revision Deck">
          {domain.map((id, index) => {
            const station = session?.stations.find((s) => s.id === id);
            const isNow = id.startsWith("now:");
            const isCurrent = id === activeId;
            const fullPath = station?.path || (isNow ? id.slice(4) : id);
            const parts = fullPath.split(".");
            const ext = parts.length > 1 ? `.${parts.pop()!.toUpperCase()}` : ".FILE";
            const baseName = fullPath.split(/[/\\]/).pop() || fullPath;
            const toolName = (station?.tool || station?.kind || (isNow ? "LIVE" : "EDIT")).toUpperCase();
            const isErr = station?.outcome === "error";

            return (
              <div
                key={id}
                ref={isCurrent ? activeCardRef : null}
                className={`chronicle-deck-card ${isCurrent ? "active" : ""} ${isNow ? "now" : ""}`}
                onClick={() => select(id, false)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    select(id, false);
                  }
                }}
                title={`Click to inspect Revision #${station?.ordinal ?? index + 1}: ${fullPath}`}
              >
                <div className="card-top-bar">
                  <span className="card-rev-badge">
                    {isNow ? "LIVE NOW" : `#${station?.ordinal ?? index + 1}`}
                  </span>
                  <span className="card-tool-badge">{toolName}</span>
                  <span className="card-ext-badge">{ext}</span>
                </div>
                <div className="card-filename" title={fullPath}>
                  {baseName}
                </div>
                <div className="card-bottom-row">
                  <span className="churn-add">+{station?.added ?? 0}</span>
                  <span className="churn-del">−{station?.removed ?? 0}</span>
                  <span className={`status-indicator ${isErr ? "err" : "ok"}`}>
                    {isErr ? "● FAILED" : "● OK"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Interactive Scrubbing Slider Track */}
        <div className="chronicle-scrubber-track-row">
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
            title="Click or drag to scrub revisions"
          >
            <div className="chronicle-track-line" />
            <div className="chronicle-track-fill" style={{ width: `${activeFraction * 100}%` }} />
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
                />
              );
            })}
            <div className="chronicle-track-thumb" style={{ left: `${activeFraction * 100}%` }} />
          </div>
        </div>
      </div>

      {/* Status Notifications */}
      {error && (
        <div className="chronicle-status-banner error">
          <b>SCAN FAILED:</b> {error}
        </div>
      )}
      {!session && !error && (
        <div className="chronicle-status-banner">
          <b>READING SESSION…</b> Gathering agent edits from the focused pane.
        </div>
      )}
      {session?.empty_reason && (
        <div className="chronicle-status-banner warning">
          <b>{session.empty_reason}</b>
        </div>
      )}
      {hologramError && (
        <div className="chronicle-status-banner error">
          <b>DIFF ERROR:</b> {hologramError}
        </div>
      )}
      {banners.map((b, i) => (
        <div key={i} className="chronicle-status-banner info">
          <span>⚠ {b}</span>
        </div>
      ))}

      {/* 2. MAIN SPLIT STUDIO: METADATA SIDEBAR & NATIVE DIFF VIEWER */}
      <div className="chronicle-studio-workspace">
        {/* LEFT COLUMN: ACTIVE STEP INTEL & HUNK NAVIGATOR */}
        <aside className="chronicle-studio-sidebar">
          <div className="studio-sidebar-card">
            <div className="sidebar-card-header">
              <span className="tag">INSPECT</span>
              <span className="sidebar-rev">
                {activeId?.startsWith("now:") ? "LIVE NOW" : `REV #${activeStation?.ordinal ?? ""}`}
              </span>
              <span className="sidebar-time">{when}</span>
            </div>

            <div className="sidebar-filepath-group">
              <span className="sidebar-label">FILE PATH</span>
              <div className="sidebar-filepath" title={activePath ?? ""}>
                {activePath ?? "No file selected"}
              </div>
            </div>

            {/* Churn Meter */}
            {activeStation && (
              <div className="sidebar-churn-box">
                <div className="churn-counts">
                  <span className="churn-stat-add">+{activeStation.added} ADDED</span>
                  <span className="churn-stat-del">−{activeStation.removed} REMOVED</span>
                </div>
                <div className="churn-ratio-meter">
                  {activeStation.added + activeStation.removed > 0 ? (
                    <>
                      <div
                        className="churn-bar-add"
                        style={{
                          width: `${(activeStation.added / (activeStation.added + activeStation.removed)) * 100}%`,
                        }}
                      />
                      <div
                        className="churn-bar-del"
                        style={{
                          width: `${(activeStation.removed / (activeStation.added + activeStation.removed)) * 100}%`,
                        }}
                      />
                    </>
                  ) : (
                    <div className="churn-bar-empty" />
                  )}
                </div>
              </div>
            )}

            {/* Tool & Execution Details */}
            <div className="sidebar-details-grid">
              <div className="detail-item">
                <span className="detail-label">TOOL</span>
                <span className="detail-value">{activeStation?.tool || activeStation?.kind || "N/A"}</span>
              </div>
              <div className="detail-item">
                <span className="detail-label">OUTCOME</span>
                <span
                  className={`detail-value status ${activeStation?.outcome === "error" ? "err" : "ok"}`}
                >
                  {activeStation?.outcome === "error" ? "FAILED" : "APPLIED OK"}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">LANE</span>
                <span className="detail-value">LANE {activeStation?.lane ?? 0}</span>
              </div>
              <div className="detail-item">
                <span className="detail-label">TOTAL LINES</span>
                <span className="detail-value">{parsedLines.length}</span>
              </div>
            </div>
          </div>

          {/* Hunk Navigator */}
          {hunks.length > 0 && tab === "diff" && (
            <div className="studio-hunks-section">
              <div className="hunks-header">
                <span className="hunks-title">DIFF HUNKS ({hunks.length})</span>
                <span className="hunks-hint">CLICK TO JUMP</span>
              </div>
              <div className="hunks-list">
                {hunks.map((hunk, i) => (
                  <button
                    key={hunk.id}
                    type="button"
                    className="hunk-pill"
                    onClick={() => handleJumpToHunk(hunk.lineIndex)}
                    title={`Jump to line ${hunk.newStart}: ${hunk.header}`}
                  >
                    <span className="hunk-num">#{i + 1}</span>
                    <span className="hunk-lines">L{hunk.newStart}</span>
                    <span className="hunk-summary">{hunk.summary || hunk.header}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Session Files List */}
          {session && session.files.length > 1 && (
            <div className="studio-files-section">
              <div className="files-header">
                <span>FILES IN SESSION ({session.files.length})</span>
              </div>
              <div className="files-list">
                {session.files.map((file) => {
                  const base = file.path.split(/[/\\]/).pop() || file.path;
                  const isCurrent = file.path === activePath;
                  return (
                    <button
                      key={file.path}
                      type="button"
                      className={`session-file-item ${isCurrent ? "active" : ""}`}
                      onClick={() => {
                        const target =
                          session.stations
                            .slice()
                            .reverse()
                            .find((s) => s.path === file.path)?.id ?? null;
                        if (target) select(target, false);
                      }}
                      title={file.path}
                    >
                      <span className="file-name">{base}</span>
                      <span className="file-lane">LANE {file.lane}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </aside>

        {/* RIGHT COLUMN: FULL-BLEED NATIVE DIFF & SNAPSHOT VIEWER */}
        <main className="chronicle-studio-viewer">
          <header className="viewer-header-bar">
            <div className="viewer-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "diff"}
                className={`viewer-tab ${tab === "diff" ? "active" : ""}`}
                onClick={() => setTab("diff")}
              >
                SESSION DIFF
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "file"}
                className={`viewer-tab ${tab === "file" ? "active" : ""}`}
                onClick={() => setTab("file")}
              >
                FILE SNAPSHOT
              </button>
            </div>

            <div className="viewer-actions">
              <input
                type="text"
                className="viewer-search-input"
                placeholder="Search lines…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search code lines"
              />
              <span className="viewer-line-count">
                {filteredLines.length} {filteredLines.length === 1 ? "LINE" : "LINES"}
              </span>
              <button
                type="button"
                className={`viewer-btn-copy ${copied ? "copied" : ""}`}
                onClick={handleCopy}
                title="Copy all code to clipboard"
              >
                {copied ? "COPIED ✓" : "COPY CODE"}
              </button>
            </div>
          </header>

          <div ref={viewerBodyRef} className="viewer-code-container" tabIndex={0}>
            {loading ? (
              <div className="viewer-loading-state">
                <span className="scifi-spinner" />
                <span>RECONSTRUCTING STEP CODE…</span>
              </div>
            ) : filteredLines.length === 0 ? (
              <div className="viewer-empty-state">
                <span>{searchQuery ? "No matching lines found" : "No content available for this step"}</span>
              </div>
            ) : tab === "diff" ? (
              <div className="diff-table">
                {filteredLines.map((item) => {
                  let rowClass = "diff-row";
                  if (item.isHunk) rowClass += " hunk-row";
                  else if (item.isAdd) rowClass += " add-row";
                  else if (item.isDel) rowClass += " del-row";
                  else if (item.isMeta) rowClass += " meta-row";

                  return (
                    <div key={item.idx} id={`diff-line-${item.idx}`} className={rowClass}>
                      <span className="ln old-ln">{item.oldNum ?? " "}</span>
                      <span className="ln new-ln">{item.newNum ?? " "}</span>
                      <span className="prefix">
                        {item.isAdd ? "+" : item.isDel ? "−" : item.isHunk ? " " : " "}
                      </span>
                      <span className="code-content">{item.line || " "}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="file-table">
                {filteredLines.map((item) => (
                  <div key={item.idx} id={`file-line-${item.idx}`} className="file-row">
                    <span className="ln">{item.idx + 1}</span>
                    <span className="code-content">{item.line || " "}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
