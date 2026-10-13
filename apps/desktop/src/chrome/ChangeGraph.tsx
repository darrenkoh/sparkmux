import { useEffect, useMemo, useRef, useState } from "react";
import { changeGraph, fileDiff, type ChangeGraphResponse, type FileDiffResponse } from "../api";
import {
  fileBasename,
  statusColor,
  statusLabel,
  type GraphFile,
  type GraphRepo,
} from "./changeGraphLayout";

export interface ChangeGraphProps {
  command: string;
  cwd: string;
  title: string;
  pid: number;
  onClose: () => void;
}

export interface FileCardData {
  id: string; // `${repoId}::${path}`
  repoId: string;
  repoName: string;
  isPrimaryRepo: boolean;
  path: string;
  filename: string;
  dir: string;
  extension: string;
  status: string;
  agentEdited: boolean;
  linesAdded: number;
  linesRemoved: number;
  // Layout physics
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  column: number;
  depth: number;
}

export interface FileChainLink {
  id: string;
  fromId: string;
  toId: string;
  reason: "sibling" | "import" | "cross_repo";
  label: string;
}

// Extract directory and filename from path
function splitPath(fullPath: string): { dir: string; filename: string; ext: string } {
  const parts = fullPath.split(/[/\\]/);
  const filename = parts.pop() || fullPath;
  const dir = parts.join("/") || ".";
  const extParts = filename.split(".");
  const ext = extParts.length > 1 ? extParts.pop()!.toLowerCase() : "";
  return { dir, filename, ext };
}

// Color badges for languages/extensions
function extensionBadgeColor(ext: string): { bg: string; text: string; border: string } {
  switch (ext) {
    case "ts":
    case "tsx":
      return { bg: "rgba(49, 120, 198, 0.2)", text: "#60a5fa", border: "rgba(59, 130, 246, 0.4)" };
    case "rs":
      return { bg: "rgba(222, 90, 54, 0.2)", text: "#fb923c", border: "rgba(249, 115, 22, 0.4)" };
    case "py":
      return { bg: "rgba(234, 179, 8, 0.2)", text: "#facc15", border: "rgba(234, 179, 8, 0.4)" };
    case "js":
    case "jsx":
      return { bg: "rgba(250, 204, 21, 0.2)", text: "#fde047", border: "rgba(250, 204, 21, 0.4)" };
    case "json":
    case "toml":
    case "yaml":
    case "yml":
      return { bg: "rgba(168, 85, 247, 0.2)", text: "#c084fc", border: "rgba(168, 85, 247, 0.4)" };
    case "css":
    case "scss":
      return { bg: "rgba(56, 189, 248, 0.2)", text: "#38bdf8", border: "rgba(56, 189, 248, 0.4)" };
    case "md":
      return { bg: "rgba(148, 163, 184, 0.2)", text: "#cbd5e1", border: "rgba(148, 163, 184, 0.4)" };
    default:
      return { bg: "rgba(45, 212, 191, 0.15)", text: "#2dd4bf", border: "rgba(45, 212, 191, 0.35)" };
  }
}

export default function ChangeGraph({ command, cwd, title, pid, onClose }: ChangeGraphProps) {
  const [data, setData] = useState<ChangeGraphResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const [filterRepo, setFilterRepo] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [animatePulses, setAnimatePulses] = useState<boolean>(true);
  // File Git Diff modal state
  const [diffTarget, setDiffTarget] = useState<{ repoId: string; repoName: string; path: string; filename: string; status: string } | null>(null);
  const [diffLoading, setDiffLoading] = useState<boolean>(false);
  const [diffData, setDiffData] = useState<FileDiffResponse | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  // Fetch diff when diffTarget changes
  useEffect(() => {
    if (!diffTarget) {
      setDiffData(null);
      setDiffError(null);
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiffData(null);
    setDiffLoading(true);
    setDiffError(null);
    fileDiff(diffTarget.repoId, diffTarget.path, cwd)
      .then((res) => {
        if (!cancelled) {
          setDiffData(res);
          setDiffLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setDiffError(err instanceof Error ? err.message : String(err));
          setDiffLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [diffTarget, cwd]);

  // Pan & Zoom viewport state
  const [zoom, setZoom] = useState<number>(1.0);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const panOriginRef = useRef({ x: 0, y: 0 });

  // Dragging individual cards
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const dragCardRef = useRef({
    cardId: null as string | null,
    startX: 0,
    startY: 0,
    origCardX: 0,
    origCardY: 0,
    hasMoved: false,
  });

  // Keydown close
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (diffTarget) {
          setDiffTarget(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [diffTarget, onClose]);

  // Fetch changeGraph API
  useEffect(() => {
    let cancel = false;
    let generation = 0;
    const load = () => {
      const token = ++generation;
      changeGraph(command, cwd, title, pid)
        .then((graph) => {
          if (!cancel && token === generation) {
            setData(graph);
            setLoadError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancel && token === generation) {
            setLoadError(err instanceof Error ? err.message : String(err));
          }
        });
    };
    load();
    const interval = setInterval(load, 2500);
    return () => {
      cancel = true;
      clearInterval(interval);
    };
  }, [command, cwd, title, pid]);

  // Construct Cards and Chain Connections
  const CARD_WIDTH = 270;
  const CARD_HEIGHT = 138;
  const COL_GAP = 90;
  const ROW_GAP = 36;

  const { cards, links, repos } = useMemo(() => {
    if (!data || data.repos.length === 0) {
      return { cards: [] as FileCardData[], links: [] as FileChainLink[], repos: [] as GraphRepo[] };
    }

    const reposList = data.repos;
    const cardList: FileCardData[] = [];
    const linkList: FileChainLink[] = [];

    // Group files by repo and sub-directory
    let currentX = 80;

    reposList.forEach((repo, repoIdx) => {
      // Group repo's files by top directory or module
      const dirGroups: { [dir: string]: GraphFile[] } = {};
      repo.files.forEach((file) => {
        const { dir } = splitPath(file.path);
        const topDir = dir.split("/")[0] || ".";
        if (!dirGroups[topDir]) dirGroups[topDir] = [];
        dirGroups[topDir].push(file);
      });

      const dirKeys = Object.keys(dirGroups).sort();
      let repoColStartX = currentX;

      dirKeys.forEach((dirKey, dirIdx) => {
        const groupFiles = dirGroups[dirKey]!;
        const colX = repoColStartX + dirIdx * (CARD_WIDTH + COL_GAP);

        groupFiles.forEach((file, fileIdx) => {
          const { dir, filename, ext } = splitPath(file.path);
          const cardId = `${repo.id}::${file.path}`;
          const cardY = 80 + fileIdx * (CARD_HEIGHT + ROW_GAP);

          cardList.push({
            id: cardId,
            repoId: repo.id,
            repoName: repo.name,
            isPrimaryRepo: repo.primary,
            path: file.path,
            filename,
            dir,
            extension: ext,
            status: file.status,
            agentEdited: file.agent_edited,
            linesAdded: file.lines_added,
            linesRemoved: file.lines_removed,
            x: colX,
            y: cardY,
            vx: 0,
            vy: 0,
            width: CARD_WIDTH,
            height: CARD_HEIGHT,
            column: dirIdx,
            depth: repoIdx,
          });
        });

        // Chain files within the same directory cluster (sibling chains)
        for (let i = 0; i < groupFiles.length - 1; i++) {
          const fromId = `${repo.id}::${groupFiles[i]!.path}`;
          const toId = `${repo.id}::${groupFiles[i + 1]!.path}`;
          linkList.push({
            id: `chain::${fromId}::${toId}`,
            fromId,
            toId,
            reason: "sibling",
            label: "same module",
          });
        }
      });

      // Chain related cross-directory files if filename stems match
      // e.g. foo.rs and foo.test.ts, or ingest.rs and stats.rs
      for (let i = 0; i < repo.files.length; i++) {
        for (let j = i + 1; j < repo.files.length; j++) {
          const fA = repo.files[i]!;
          const fB = repo.files[j]!;
          const baseA = fileBasename(fA.path).replace(/\.[^.]+$/, "");
          const baseB = fileBasename(fB.path).replace(/\.[^.]+$/, "");
          if (
            (baseA.length > 2 && baseB.startsWith(baseA)) ||
            (baseB.length > 2 && baseA.startsWith(baseB)) ||
            (fA.agent_edited && fB.agent_edited && Math.abs(i - j) === 1)
          ) {
            const fromId = `${repo.id}::${fA.path}`;
            const toId = `${repo.id}::${fB.path}`;
            const linkId = `chain::${fromId}::${toId}`;
            if (!linkList.some((l) => l.id === linkId)) {
              linkList.push({
                id: linkId,
                fromId,
                toId,
                reason: "import",
                label: "co-edited",
              });
            }
          }
        }
      }

      currentX = repoColStartX + Math.max(1, dirKeys.length) * (CARD_WIDTH + COL_GAP) + 120;
    });

    // Cross-repo links from backend dependency analysis
    if (data.edges) {
      data.edges.forEach((edge) => {
        // Find matching files between from_repo and to_repo
        const fromCards = cardList.filter((c) => c.repoId === edge.from_repo);
        const toCards = cardList.filter((c) => c.repoId === edge.to_repo);
        if (fromCards.length > 0 && toCards.length > 0) {
          const fromCard = fromCards.find((c) => c.path.includes(edge.via)) || fromCards[0]!;
          const toCard = toCards[0]!;
          linkList.push({
            id: `edge::${fromCard.id}::${toCard.id}`,
            fromId: fromCard.id,
            toId: toCard.id,
            reason: "cross_repo",
            label: edge.label || "dependency",
          });
        }
      });
    }

    return { cards: cardList, links: linkList, repos: reposList };
  }, [data]);

  // Card Positions Map (allows dragging individual cards)
  const [customPositions, setCustomPositions] = useState<{ [id: string]: { x: number; y: number } }>({});

  const getCardPos = (c: FileCardData) => {
    return customPositions[c.id] || { x: c.x, y: c.y };
  };

  // Filtered Cards
  const visibleCards = useMemo(() => {
    return cards.filter((c) => {
      if (filterRepo && c.repoId !== filterRepo) return false;
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        return c.path.toLowerCase().includes(query) || c.repoName.toLowerCase().includes(query);
      }
      return true;
    });
  }, [cards, filterRepo, searchQuery]);

  const visibleCardIds = useMemo(() => new Set(visibleCards.map((c) => c.id)), [visibleCards]);

  // Filtered Links
  const visibleLinks = useMemo(() => {
    return links.filter((l) => visibleCardIds.has(l.fromId) && visibleCardIds.has(l.toId));
  }, [links, visibleCardIds]);

  // Connected card set for highlighting chains
  const activeHoverOrPin = hoveredCardId || selectedCardId;
  const connectedCardIds = useMemo(() => {
    if (!activeHoverOrPin) return new Set<string>();
    const set = new Set<string>([activeHoverOrPin]);
    visibleLinks.forEach((l) => {
      if (l.fromId === activeHoverOrPin) set.add(l.toId);
      if (l.toId === activeHoverOrPin) set.add(l.fromId);
    });
    return set;
  }, [activeHoverOrPin, visibleLinks]);

  // Viewport Pan handlers
  const handleViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only pan if clicking on empty background
    if ((e.target as HTMLElement).closest(".file-card")) return;
    isPanningRef.current = true;
    panStartRef.current = { x: e.clientX, y: e.clientY };
    panOriginRef.current = { ...pan };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  };

  const handleViewportPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      setPan({
        x: panOriginRef.current.x + dx,
        y: panOriginRef.current.y + dy,
      });
      return;
    }

    if (dragCardRef.current.cardId) {
      const dx = (e.clientX - dragCardRef.current.startX) / zoom;
      const dy = (e.clientY - dragCardRef.current.startY) / zoom;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        dragCardRef.current.hasMoved = true;
      }
      const cardId = dragCardRef.current.cardId;
      setCustomPositions((prev) => ({
        ...prev,
        [cardId]: {
          x: dragCardRef.current.origCardX + dx,
          y: dragCardRef.current.origCardY + dy,
        },
      }));
    }
  };

  const handleViewportPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    isPanningRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}

    if (dragCardRef.current.cardId) {
      const cId = dragCardRef.current.cardId;
      if (!dragCardRef.current.hasMoved) {
        // Was a simple click
        setSelectedCardId((curr) => (curr === cId ? null : cId));
      }
      dragCardRef.current.cardId = null;
      setDraggingCardId(null);
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.08 : 0.92;
    setZoom((curr) => Math.min(2.5, Math.max(0.35, curr * factor)));
  };

  const handleResetView = () => {
    setZoom(1.0);
    setPan({ x: 0, y: 0 });
    setCustomPositions({});
  };

  // Center on card
  const centerOnCard = (card: FileCardData) => {
    const pos = getCardPos(card);
    if (!viewportRef.current) return;
    const rect = viewportRef.current.getBoundingClientRect();
    const targetX = rect.width / 2 - (pos.x + CARD_WIDTH / 2) * zoom;
    const targetY = rect.height / 2 - (pos.y + CARD_HEIGHT / 2) * zoom;
    setPan({ x: targetX, y: targetY });
    setSelectedCardId(card.id);
  };

  // Aggregated Stats
  const totalFiles = cards.length;
  const totalAdded = cards.reduce((sum, c) => sum + c.linesAdded, 0);
  const totalRemoved = cards.reduce((sum, c) => sum + c.linesRemoved, 0);
  const agentEditedCount = cards.filter((c) => c.agentEdited).length;
  const selectedFile = cards.find((c) => c.id === selectedCardId);

  return (
    <div
      className="scifi-hud-overlay graph-overlay"
      onClick={onClose}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="scifi-hud-frame graph-frame"
        style={{
          width: "96vw",
          maxWidth: "1520px",
          height: "94vh",
          maxHeight: "920px",
          display: "flex",
          flexDirection: "column",
          padding: 0,
          background: "#05070a",
          border: "1px solid rgba(45, 212, 191, 0.35)",
          boxShadow: "0 0 60px rgba(0,0,0,0.9), inset 0 0 20px rgba(45,212,191,0.05)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="File Change Card Chain Graph"
      >
        {/* 1. TOP HEADER & FILTER TOOLBAR */}
        <div
          style={{
            flex: "0 0 46px",
            display: "flex",
            alignItems: "center",
            gap: "12px",
            background: "#080b11",
            borderBottom: "1px solid rgba(45, 212, 191, 0.18)",
            padding: "0 14px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "11px",
            zIndex: 10,
          }}
        >
          {/* Logo / Badge */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "bold", color: "#2dd4bf" }}>
            <span style={{ fontSize: "14px" }}>⬡</span>
            <span style={{ letterSpacing: "0.14em" }}>GITS · CHAIN GRAPH</span>
            <span
              style={{
                fontSize: "9px",
                padding: "2px 6px",
                borderRadius: "3px",
                background: "rgba(45, 212, 191, 0.15)",
                color: "#5eead4",
                border: "1px solid rgba(45, 212, 191, 0.3)",
              }}
            >
              DIFF & CHAIN FLOW
            </span>
          </div>

          {/* Repo Cluster Filter Tabs */}
          <div style={{ display: "flex", alignItems: "center", gap: "4px", marginLeft: "12px" }}>
            <button
              type="button"
              onClick={() => setFilterRepo(null)}
              style={{
                background: filterRepo === null ? "rgba(45, 212, 191, 0.22)" : "transparent",
                color: filterRepo === null ? "#99f6e4" : "rgba(255, 255, 255, 0.5)",
                border: "1px solid",
                borderColor: filterRepo === null ? "rgba(45, 212, 191, 0.5)" : "rgba(255, 255, 255, 0.1)",
                padding: "3px 9px",
                borderRadius: "3px",
                fontSize: "9.5px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              ALL CLUSTERS ({repos.length})
            </button>
            {repos.map((r) => {
              const count = cards.filter((c) => c.repoId === r.id).length;
              const isSel = filterRepo === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setFilterRepo(r.id)}
                  style={{
                    background: isSel ? "rgba(45, 212, 191, 0.22)" : "transparent",
                    color: isSel ? "#99f6e4" : "rgba(255, 255, 255, 0.5)",
                    border: "1px solid",
                    borderColor: isSel ? "rgba(45, 212, 191, 0.5)" : "rgba(255, 255, 255, 0.1)",
                    padding: "3px 9px",
                    borderRadius: "3px",
                    fontSize: "9.5px",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.name} ({count})
                </button>
              );
            })}
          </div>

          {/* Search Box */}
          <div style={{ display: "flex", alignItems: "center", position: "relative" }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter file path..."
              style={{
                background: "rgba(0, 0, 0, 0.45)",
                border: "1px solid rgba(45, 212, 191, 0.25)",
                borderRadius: "3px",
                padding: "3px 8px",
                fontSize: "10px",
                color: "#fff",
                outline: "none",
                width: "160px",
                fontFamily: "inherit",
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                style={{
                  position: "absolute",
                  right: 4,
                  background: "transparent",
                  border: "none",
                  color: "rgba(255,255,255,0.4)",
                  cursor: "pointer",
                  fontSize: "10px",
                }}
              >
                ✕
              </button>
            )}
          </div>

          {/* Summary Metric Counters */}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "10px" }}>
              <span style={{ color: "rgba(255,255,255,0.4)" }}>Files:</span>
              <strong style={{ color: "#fff" }}>{totalFiles}</strong>
              <span style={{ color: "#2dd4bf", marginLeft: "4px" }}>+{totalAdded}</span>
              <span style={{ color: "#f87171" }}>-{totalRemoved}</span>
              {agentEditedCount > 0 && (
                <span
                  style={{
                    marginLeft: "6px",
                    padding: "1px 5px",
                    borderRadius: "2px",
                    background: "rgba(232, 168, 73, 0.2)",
                    color: "#e8a849",
                    border: "1px solid rgba(232, 168, 73, 0.4)",
                    fontSize: "9px",
                  }}
                >
                  ⚡ {agentEditedCount} agent edits
                </span>
              )}
            </div>

            {/* Pulse Animation Toggle */}
            <button
              type="button"
              onClick={() => setAnimatePulses(!animatePulses)}
              title="Toggle chain pulse animation"
              style={{
                background: animatePulses ? "rgba(45, 212, 191, 0.15)" : "transparent",
                color: animatePulses ? "#2dd4bf" : "rgba(255, 255, 255, 0.4)",
                border: "1px solid rgba(45, 212, 191, 0.25)",
                padding: "3px 8px",
                fontSize: "9px",
                borderRadius: "3px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {animatePulses ? "⚡ CURRENT: ON" : "⚡ CURRENT: OFF"}
            </button>

            {/* Reset Zoom/Pan */}
            <button
              type="button"
              onClick={handleResetView}
              title="Reset Zoom & Pan"
              style={{
                background: "transparent",
                color: "rgba(255, 255, 255, 0.6)",
                border: "1px solid rgba(255, 255, 255, 0.2)",
                padding: "3px 8px",
                fontSize: "9px",
                borderRadius: "3px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              RESET VIEW ({(zoom * 100).toFixed(0)}%)
            </button>

            {/* Close Button */}
            <button
              type="button"
              className="scifi-close graph-close"
              onClick={onClose}
              aria-label="Close graph"
              style={{
                padding: "0 8px",
                border: "none",
                background: "transparent",
                color: "#2dd4bf",
                fontSize: "18px",
                cursor: "pointer",
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* 2. INFINITE 2D INTERACTIVE WORKSPACE (Canvas Connectors + Card Nodes) */}
        <div
          ref={viewportRef}
          onPointerDown={handleViewportPointerDown}
          onPointerMove={handleViewportPointerMove}
          onPointerUp={handleViewportPointerUp}
          onPointerCancel={handleViewportPointerUp}
          onWheel={handleWheel}
          style={{
            flex: 1,
            position: "relative",
            minHeight: 0,
            overflow: "hidden",
            cursor: isPanningRef.current ? "grabbing" : "grab",
            backgroundColor: "#06090e",
            backgroundImage: `
              radial-gradient(circle at 50% 50%, rgba(13, 27, 42, 0.6) 0%, rgba(5, 7, 10, 0.95) 100%),
              linear-gradient(rgba(45, 212, 191, 0.04) 1px, transparent 1px),
              linear-gradient(90deg, rgba(45, 212, 191, 0.04) 1px, transparent 1px)
            `,
            backgroundSize: `100% 100%, ${32 * zoom}px ${32 * zoom}px, ${32 * zoom}px ${32 * zoom}px`,
            backgroundPosition: `center, ${pan.x}px ${pan.y}px, ${pan.x}px ${pan.y}px`,
          }}
        >
          {/* Pan & Zoom Transform World Container */}
          <div
            style={{
              position: "absolute",
              transformOrigin: "0 0",
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              width: "100%",
              height: "100%",
              pointerEvents: "none", // child cards re-enable pointerEvents
            }}
          >
            {/* SVG LINK CHAINS LAYER */}
            <svg
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: 6000,
                height: 4000,
                pointerEvents: "none",
                overflow: "visible",
              }}
            >
              <defs>
                <linearGradient id="chainGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.8" />
                  <stop offset="100%" stopColor="#5eead4" stopOpacity="0.4" />
                </linearGradient>
                <linearGradient id="crossRepoGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#ff9a3c" stopOpacity="0.8" />
                  <stop offset="100%" stopColor="#e8a849" stopOpacity="0.4" />
                </linearGradient>
                <filter id="chainGlow" x="-20%" y="-20%" width="140%" height="140%">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feComposite in="SourceGraphic" in2="blur" operator="over" />
                </filter>
              </defs>

              {visibleLinks.map((link) => {
                const cardA = cards.find((c) => c.id === link.fromId);
                const cardB = cards.find((c) => c.id === link.toId);
                if (!cardA || !cardB) return null;

                const posA = getCardPos(cardA);
                const posB = getCardPos(cardB);

                const isConnected =
                  activeHoverOrPin && (link.fromId === activeHoverOrPin || link.toId === activeHoverOrPin);

                // Connector Anchor points: Right-center of A to Left-center of B, or Top/Bottom if stacked
                const isHorizontal = Math.abs(posB.x - posA.x) > Math.abs(posB.y - posA.y);

                let x1: number, y1: number, x2: number, y2: number, cx1: number, cy1: number, cx2: number, cy2: number;

                if (isHorizontal) {
                  const leftToRight = posB.x >= posA.x;
                  x1 = leftToRight ? posA.x + CARD_WIDTH : posA.x;
                  y1 = posA.y + CARD_HEIGHT / 2;
                  x2 = leftToRight ? posB.x : posB.x + CARD_WIDTH;
                  y2 = posB.y + CARD_HEIGHT / 2;
                  const dx = (x2 - x1) * 0.5;
                  cx1 = x1 + dx;
                  cy1 = y1;
                  cx2 = x2 - dx;
                  cy2 = y2;
                } else {
                  const topToBottom = posB.y >= posA.y;
                  x1 = posA.x + CARD_WIDTH / 2;
                  y1 = topToBottom ? posA.y + CARD_HEIGHT : posA.y;
                  x2 = posB.x + CARD_WIDTH / 2;
                  y2 = topToBottom ? posB.y : posB.y + CARD_HEIGHT;
                  const dy = (y2 - y1) * 0.5;
                  cx1 = x1;
                  cy1 = y1 + dy;
                  cx2 = x2;
                  cy2 = y2 - dy;
                }

                const pathData = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
                const isCross = link.reason === "cross_repo";
                const strokeColor = isCross ? "#ff9a3c" : "#2dd4bf";
                const strokeWidth = isConnected ? 2.5 : isCross ? 1.6 : 1.2;
                const strokeOpacity = isConnected ? 0.95 : activeHoverOrPin ? 0.15 : 0.45;

                const midX = (x1 + x2) / 2;
                const midY = (y1 + y2) / 2;

                return (
                  <g key={link.id} filter={isConnected ? "url(#chainGlow)" : undefined}>
                    {/* Shadow / Glow line */}
                    <path
                      d={pathData}
                      fill="none"
                      stroke={strokeColor}
                      strokeWidth={strokeWidth + 2}
                      strokeOpacity={strokeOpacity * 0.25}
                    />
                    {/* Main Chain Connector */}
                    <path
                      d={pathData}
                      fill="none"
                      stroke={strokeColor}
                      strokeWidth={strokeWidth}
                      strokeOpacity={strokeOpacity}
                      strokeDasharray={isCross ? "6 5" : undefined}
                    />

                    {/* Animated current pulses */}
                    {animatePulses && (
                      <circle r={isConnected ? 3.5 : 2.5} fill={isCross ? "#ffb300" : "#99f6e4"}>
                        <animateMotion
                          path={pathData}
                          dur={isCross ? "2.2s" : "3.0s"}
                          repeatCount="indefinite"
                        />
                      </circle>
                    )}

                    {/* Chain Joint Hub Pins */}
                    <circle cx={x1} cy={y1} r={3} fill="#05070a" stroke={strokeColor} strokeWidth={1.5} />
                    <circle cx={x2} cy={y2} r={3} fill="#05070a" stroke={strokeColor} strokeWidth={1.5} />

                    {/* Link Label Tag (shown if connected or cross-repo) */}
                    {(isConnected || isCross) && (
                      <g transform={`translate(${midX}, ${midY})`}>
                        <rect
                          x={-35}
                          y={-8}
                          width={70}
                          height={16}
                          rx={3}
                          fill="#090d14"
                          stroke={strokeColor}
                          strokeWidth={0.8}
                          opacity={0.9}
                        />
                        <text
                          textAnchor="middle"
                          y={3}
                          fill="#fff"
                          fontSize="8.5px"
                          fontFamily="ui-monospace, monospace"
                        >
                          {link.label}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>

            {/* CARDS LAYER */}
            {visibleCards.map((card) => {
              const pos = getCardPos(card);
              const isSelected = selectedCardId === card.id;
              const isHovered = hoveredCardId === card.id;
              const isConnected = connectedCardIds.has(card.id);
              const isDimmed = activeHoverOrPin && !isConnected;

              const extBadge = extensionBadgeColor(card.extension);
              const stColor = statusColor(card.status);
              const deltaSum = card.linesAdded + card.linesRemoved;

              return (
                <div
                  key={card.id}
                  className="file-card"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    dragCardRef.current = {
                      cardId: card.id,
                      startX: e.clientX,
                      startY: e.clientY,
                      origCardX: pos.x,
                      origCardY: pos.y,
                      hasMoved: false,
                    };
                    setDraggingCardId(card.id);
                  }}
                  onMouseEnter={() => setHoveredCardId(card.id)}
                  onMouseLeave={() => setHoveredCardId(null)}
                  style={{
                    position: "absolute",
                    left: pos.x,
                    top: pos.y,
                    width: CARD_WIDTH,
                    height: CARD_HEIGHT,
                    pointerEvents: "auto",
                    borderRadius: "6px",
                    background: isSelected
                      ? "rgba(10, 24, 30, 0.98)"
                      : isHovered
                      ? "rgba(8, 18, 24, 0.96)"
                      : "rgba(7, 13, 19, 0.92)",
                    border: "1px solid",
                    borderColor: isSelected
                      ? "#2dd4bf"
                      : isHovered
                      ? "rgba(45, 212, 191, 0.7)"
                      : isConnected
                      ? "rgba(45, 212, 191, 0.45)"
                      : "rgba(255, 255, 255, 0.12)",
                    boxShadow: isSelected
                      ? "0 0 25px rgba(45, 212, 191, 0.35), 0 8px 30px rgba(0,0,0,0.8)"
                      : isHovered
                      ? "0 0 16px rgba(45, 212, 191, 0.2), 0 6px 20px rgba(0,0,0,0.7)"
                      : "0 4px 14px rgba(0, 0, 0, 0.6)",
                    opacity: isDimmed ? 0.3 : 1.0,
                    transform: isSelected || isHovered ? "scale(1.02)" : "scale(1.0)",
                    transition:
                      draggingCardId === card.id
                        ? "none"
                        : "transform 0.15s ease, border-color 0.15s ease, opacity 0.2s ease",
                    zIndex: isSelected ? 20 : isHovered ? 15 : isConnected ? 10 : 2,
                    display: "flex",
                    flexDirection: "column",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    cursor: draggingCardId === card.id ? "grabbing" : "grab",
                    userSelect: "none",
                    overflow: "hidden",
                  }}
                >
                  {/* Card Header (Repo tag & Extension badge) */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "7px 10px 5px",
                      borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
                      background: "rgba(255, 255, 255, 0.02)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", overflow: "hidden" }}>
                      <span
                        style={{
                          fontSize: "8.5px",
                          color: card.isPrimaryRepo ? "#2dd4bf" : "#ff9a3c",
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {card.repoName}
                      </span>
                      {card.agentEdited && (
                        <span
                          title="Edited by AI Agent this session"
                          style={{
                            fontSize: "8px",
                            padding: "1px 4px",
                            borderRadius: "2px",
                            background: "rgba(232, 168, 73, 0.25)",
                            color: "#e8a849",
                            border: "1px solid rgba(232, 168, 73, 0.5)",
                            fontWeight: "bold",
                          }}
                        >
                          AGENT
                        </span>
                      )}
                    </div>

                    <span
                      style={{
                        fontSize: "8.5px",
                        padding: "1px 5px",
                        borderRadius: "3px",
                        background: extBadge.bg,
                        color: extBadge.text,
                        border: `1px solid ${extBadge.border}`,
                        fontWeight: 600,
                        textTransform: "uppercase",
                      }}
                    >
                      .{card.extension || "file"}
                    </span>
                  </div>

                  {/* Card Body (Filename and Path) */}
                  <div style={{ padding: "8px 10px 6px", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
                    <div
                      title={card.filename}
                      style={{
                        fontSize: "12px",
                        fontWeight: "bold",
                        color: "#fff",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        lineHeight: 1.25,
                      }}
                    >
                      {card.filename}
                    </div>

                    <div
                      title={card.dir}
                      style={{
                        fontSize: "9px",
                        color: "rgba(255, 255, 255, 0.4)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        marginTop: 2,
                      }}
                    >
                      {card.dir}
                    </div>

                    {/* Delta line chart preview */}
                    <div style={{ marginTop: "auto", paddingTop: "6px" }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          fontSize: "9px",
                          marginBottom: "3px",
                        }}
                      >
                        <span style={{ color: stColor, fontWeight: 600 }}>{statusLabel(card.status)}</span>
                        <div style={{ display: "flex", gap: "6px" }}>
                          <span style={{ color: "#2dd4bf" }}>+{card.linesAdded}</span>
                          <span style={{ color: "#f87171" }}>-{card.linesRemoved}</span>
                        </div>
                      </div>

                      {/* Visual line ratio bar */}
                      <div
                        style={{
                          height: "3px",
                          width: "100%",
                          background: "rgba(255, 255, 255, 0.08)",
                          borderRadius: "2px",
                          overflow: "hidden",
                          display: "flex",
                        }}
                      >
                        {deltaSum > 0 ? (
                          <>
                            <div
                              style={{
                                width: `${(card.linesAdded / deltaSum) * 100}%`,
                                background: "#2dd4bf",
                                height: "100%",
                              }}
                            />
                            <div
                              style={{
                                width: `${(card.linesRemoved / deltaSum) * 100}%`,
                                background: "#f87171",
                                height: "100%",
                              }}
                            />
                          </>
                        ) : (
                          <div style={{ width: "100%", background: stColor, opacity: 0.6 }} />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Card Chain Joint Footer */}
                  <div
                    style={{
                      height: "18px",
                      background: "rgba(0, 0, 0, 0.35)",
                      borderTop: "1px solid rgba(255, 255, 255, 0.06)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "0 8px",
                      fontSize: "8px",
                      color: "rgba(255, 255, 255, 0.35)",
                    }}
                  >
                    <span>
                      chains:{" "}
                      <strong style={{ color: "#99f6e4" }}>
                        {links.filter((l) => l.fromId === card.id || l.toId === card.id).length}
                      </strong>
                    </span>
                    <span>col {card.column}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Interactive Navigation Floating Controls (Bottom Left) */}
          <div
            style={{
              position: "absolute",
              bottom: 16,
              left: 16,
              display: "flex",
              alignItems: "center",
              gap: "6px",
              background: "rgba(6, 12, 18, 0.88)",
              border: "1px solid rgba(45, 212, 191, 0.3)",
              padding: "4px 8px",
              borderRadius: "4px",
              fontSize: "9px",
              fontFamily: "ui-monospace, monospace",
              color: "rgba(255, 255, 255, 0.6)",
              zIndex: 30,
              pointerEvents: "auto",
            }}
          >
            <span>DRAG CARD TO REARRANGE · PAN WORKSPACE · WHEEL ZOOM</span>
          </div>

          {/* Selected File Card Detail Sidebar (Floating Inspector) */}
          {selectedFile && (
            <div
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              style={{
                position: "absolute",
                top: 16,
                right: 16,
                width: "300px",
                background: "rgba(5, 10, 15, 0.96)",
                border: "1px solid rgba(45, 212, 191, 0.5)",
                borderRadius: "6px",
                padding: "12px 14px",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "10.5px",
                zIndex: 35,
                boxShadow: "0 10px 40px rgba(0,0,0,0.85)",
                pointerEvents: "auto",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <span style={{ color: "#2dd4bf", fontWeight: "bold", fontSize: "11px" }}>FILE INSPECTOR</span>
                <button
                  type="button"
                  onClick={() => setSelectedCardId(null)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "rgba(255,255,255,0.5)",
                    cursor: "pointer",
                    fontSize: "12px",
                  }}
                >
                  ✕
                </button>
              </div>

              <div style={{ fontSize: "13px", fontWeight: "bold", color: "#fff", wordBreak: "break-all", marginBottom: "4px" }}>
                {selectedFile.filename}
              </div>
              <div style={{ fontSize: "9.5px", color: "rgba(255,255,255,0.5)", wordBreak: "break-all", marginBottom: "10px" }}>
                {selectedFile.path}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", marginBottom: "10px", fontSize: "9.5px" }}>
                <div style={{ background: "rgba(255,255,255,0.03)", padding: "4px 6px", borderRadius: "3px" }}>
                  <div style={{ color: "rgba(255,255,255,0.4)" }}>Cluster</div>
                  <div style={{ color: "#fff", fontWeight: 600 }}>{selectedFile.repoName}</div>
                </div>
                <div style={{ background: "rgba(255,255,255,0.03)", padding: "4px 6px", borderRadius: "3px" }}>
                  <div style={{ color: "rgba(255,255,255,0.4)" }}>Status</div>
                  <div style={{ color: statusColor(selectedFile.status), fontWeight: 600 }}>
                    {statusLabel(selectedFile.status)}
                  </div>
                </div>
                <div style={{ background: "rgba(255,255,255,0.03)", padding: "4px 6px", borderRadius: "3px" }}>
                  <div style={{ color: "rgba(255,255,255,0.4)" }}>Lines Added</div>
                  <div style={{ color: "#2dd4bf", fontWeight: 600 }}>+{selectedFile.linesAdded}</div>
                </div>
                <div style={{ background: "rgba(255,255,255,0.03)", padding: "4px 6px", borderRadius: "3px" }}>
                  <div style={{ color: "rgba(255,255,255,0.4)" }}>Lines Removed</div>
                  <div style={{ color: "#f87171", fontWeight: 600 }}>-{selectedFile.linesRemoved}</div>
                </div>
              </div>

              {/* Primary Selected File Action Bar */}
              <div style={{ marginBottom: "10px", display: "flex", gap: "6px" }}>
                <button
                  type="button"
                  onClick={() =>
                    setDiffTarget({
                      repoId: selectedFile.repoId,
                      repoName: selectedFile.repoName,
                      path: selectedFile.path,
                      filename: selectedFile.filename,
                      status: selectedFile.status,
                    })
                  }
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "6px",
                    background: "rgba(45, 212, 191, 0.16)",
                    border: "1px solid rgba(45, 212, 191, 0.45)",
                    borderRadius: "4px",
                    padding: "6px 10px",
                    color: "#2dd4bf",
                    fontSize: "10px",
                    fontWeight: 600,
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(45, 212, 191, 0.28)";
                    e.currentTarget.style.borderColor = "#2dd4bf";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(45, 212, 191, 0.16)";
                    e.currentTarget.style.borderColor = "rgba(45, 212, 191, 0.45)";
                  }}
                  title="View Git Diff changes for this file"
                >
                  <span>⌥ VIEW GIT CHANGES</span>
                </button>
              </div>

              {/* Connected Chain Links for Selected File */}
              <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: "8px" }}>
                <div style={{ fontSize: "9px", color: "#5eead4", fontWeight: "bold", marginBottom: "6px" }}>
                  CONNECTED CHAIN LINKS ({links.filter((l) => l.fromId === selectedFile.id || l.toId === selectedFile.id).length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", maxHeight: "140px", overflowY: "auto" }}>
                  {links
                    .filter((l) => l.fromId === selectedFile.id || l.toId === selectedFile.id)
                    .map((l) => {
                      const peerId = l.fromId === selectedFile.id ? l.toId : l.fromId;
                      const peerCard = cards.find((c) => c.id === peerId);
                      if (!peerCard) return null;
                      return (
                        <div
                          key={l.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "4px 6px",
                            background: "rgba(255,255,255,0.03)",
                            borderRadius: "3px",
                            cursor: "pointer",
                            fontSize: "9px",
                            transition: "background 0.15s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = "rgba(45, 212, 191, 0.12)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "rgba(255,255,255,0.03)";
                          }}
                        >
                          <span
                            onClick={() => centerOnCard(peerCard)}
                            style={{ color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}
                            title="Focus card"
                          >
                            {peerCard.filename}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDiffTarget({
                                repoId: peerCard.repoId,
                                repoName: peerCard.repoName,
                                path: peerCard.path,
                                filename: peerCard.filename,
                                status: peerCard.status,
                              });
                            }}
                            style={{
                              marginLeft: "6px",
                              background: "rgba(45, 212, 191, 0.15)",
                              border: "1px solid rgba(45, 212, 191, 0.3)",
                              borderRadius: "2px",
                              color: "#2dd4bf",
                              fontSize: "8px",
                              padding: "1px 5px",
                              cursor: "pointer",
                              whiteSpace: "nowrap",
                            }}
                            title="View Git Diff"
                          >
                            diff
                          </button>
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>
          )}

          {/* 3. SCI-FI GIT DIFF VIEWER DRAWER / MODAL */}
          {diffTarget && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(3, 6, 10, 0.82)",
                backdropFilter: "blur(4px)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 60,
                padding: "24px",
                pointerEvents: "auto",
              }}
              onClick={() => setDiffTarget(null)}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
            >
              <div
                style={{
                  width: "100%",
                  maxWidth: "940px",
                  maxHeight: "88vh",
                  background: "#070c14",
                  border: "1px solid rgba(45, 212, 191, 0.4)",
                  boxShadow: "0 20px 60px rgba(0, 0, 0, 0.95), 0 0 30px rgba(45, 212, 191, 0.15)",
                  borderRadius: "6px",
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* Diff Viewer Top Header */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 16px",
                    background: "rgba(9, 15, 24, 0.95)",
                    borderBottom: "1px solid rgba(45, 212, 191, 0.25)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                    <span style={{ fontSize: "14px", color: "#2dd4bf" }}>⬡</span>
                    <span style={{ fontSize: "12px", fontWeight: "bold", color: "#fff", whiteSpace: "nowrap" }}>
                      GIT CHANGES
                    </span>
                    <span
                      style={{
                        fontSize: "9.5px",
                        padding: "1px 6px",
                        borderRadius: "2px",
                        background: "rgba(45, 212, 191, 0.15)",
                        color: "#5eead4",
                        border: "1px solid rgba(45, 212, 191, 0.3)",
                      }}
                    >
                      {diffTarget.repoName}
                    </span>
                    <span
                      style={{
                        fontSize: "9.5px",
                        color: statusColor(diffTarget.status),
                        fontWeight: 600,
                      }}
                    >
                      [{statusLabel(diffTarget.status)}]
                    </span>
                    <span
                      style={{
                        fontSize: "11px",
                        color: "rgba(255, 255, 255, 0.6)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={diffTarget.path}
                    >
                      {diffTarget.path}
                    </span>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    {!diffLoading && !diffError && diffData && (() => {
                      let adds = 0;
                      let rems = 0;
                      for (const l of diffData.diff.split("\n")) {
                        if (l.startsWith("+") && !l.startsWith("+++")) adds++;
                        else if (l.startsWith("-") && !l.startsWith("---")) rems++;
                      }
                      return (
                        <div style={{ display: "flex", gap: "6px", fontSize: "10px", fontWeight: "bold" }}>
                          <span style={{ color: "#2dd4bf" }}>+{adds}</span>
                          <span style={{ color: "#f87171" }}>-{rems}</span>
                        </div>
                      );
                    })()}
                    <button
                      type="button"
                      onClick={() => setDiffTarget(null)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "rgba(255, 255, 255, 0.5)",
                        fontSize: "16px",
                        cursor: "pointer",
                        padding: "2px 6px",
                        lineHeight: 1,
                      }}
                      title="Close Diff (Esc)"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* Diff Viewer Body */}
                <div
                  style={{
                    flex: 1,
                    overflow: "auto",
                    padding: "12px 16px",
                    background: "#04070c",
                    fontSize: "11px",
                    lineHeight: "1.45",
                  }}
                >
                  {diffLoading && (
                    <div style={{ padding: "40px 20px", textAlign: "center", color: "rgba(255, 255, 255, 0.5)" }}>
                      <div style={{ color: "#2dd4bf", marginBottom: "6px" }}>⚡ RETRIEVING WORKING COPY DIFF...</div>
                      <span>Querying git repository state</span>
                    </div>
                  )}

                  {diffError && (
                    <div
                      style={{
                        padding: "16px",
                        background: "rgba(248, 113, 113, 0.1)",
                        border: "1px solid rgba(248, 113, 113, 0.3)",
                        borderRadius: "4px",
                        color: "#f87171",
                      }}
                    >
                      <b>Failed to load diff:</b> {diffError}
                    </div>
                  )}

                  {!diffLoading && !diffError && diffData && (
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      {diffData.diff
                        .split("\n")
                        .map((line, idx) => {
                          const isAdd = line.startsWith("+") && !line.startsWith("+++");
                          const isRem = line.startsWith("-") && !line.startsWith("---");
                          const isHunk = line.startsWith("@@");
                          const isComment = line.startsWith("#");
                          const isHeader = line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++");

                          let bg = "transparent";
                          let color = "rgba(255, 255, 255, 0.75)";
                          if (isComment) {
                            bg = "rgba(45, 212, 191, 0.08)";
                            color = "#5eead4";
                          } else if (isAdd) {
                            bg = "rgba(45, 212, 191, 0.12)";
                            color = "#34d399";
                          } else if (isRem) {
                            bg = "rgba(248, 113, 113, 0.12)";
                            color = "#f87171";
                          } else if (isHunk) {
                            bg = "rgba(56, 189, 248, 0.08)";
                            color = "#38bdf8";
                          } else if (isHeader) {
                            color = "rgba(255, 255, 255, 0.4)";
                          }

                          return (
                            <div
                              key={idx}
                              style={{
                                display: "flex",
                                background: bg,
                                minHeight: "18px",
                                padding: "0 6px",
                                borderRadius: "2px",
                              }}
                            >
                              <span
                                style={{
                                  width: "36px",
                                  flexShrink: 0,
                                  color: "rgba(255, 255, 255, 0.2)",
                                  userSelect: "none",
                                  fontSize: "9.5px",
                                  textAlign: "right",
                                  marginRight: "12px",
                                  paddingTop: "1px",
                                }}
                              >
                                {idx + 1}
                              </span>
                              <pre
                                style={{
                                  margin: 0,
                                  color,
                                  fontFamily: "inherit",
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-all",
                                }}
                              >
                                {line || " "}
                              </pre>
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>

                {/* Diff Viewer Status Bar */}
                <div
                  style={{
                    padding: "6px 14px",
                    background: "rgba(9, 15, 24, 0.8)",
                    borderTop: "1px solid rgba(255, 255, 255, 0.06)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: "9.5px",
                    color: "rgba(255, 255, 255, 0.4)",
                  }}
                >
                  <span>HEAD ↔ WORKING COPY{diffData ? ` · ${diffData.path}` : ""}</span>
                  <span>PRESS ESC TO CLOSE</span>
                </div>
              </div>
            </div>
          )}

          {/* Empty / Error state */}
          {cards.length === 0 && (
            <div className="graph-empty" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              <b>{data == null ? (loadError ? "SCAN FAILED" : "READING WORKSPACE...") : "NO CHANGED FILES"}</b>
              <span>{data == null ? (loadError ?? "Gathering repo git changes and agent diffs...") : "Working directory is clean."}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
