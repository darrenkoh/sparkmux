import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  changeGraph,
  clearChronicleCache,
  fileDiff,
  openEditorPath,
  searchChangedFiles,
  type ChangeGraphResponse,
  type FileDiffResponse,
} from "../api";
import {
  arrangeCards,
  computeFitCamera,
  fileBasename,
  parseSideBySideDiff,
  statusColor,
  statusLabel,
  CARD_WIDTH,
  CARD_HEIGHT,
  type CardOrganizationMode,
  type GraphFile,
  type GraphRepo,
} from "./changeGraphLayout";
import {
  applyChronicleKeyEvent,
  chronicleKeyAction,
  ENABLED_CHRONICLE_SCENES,
  type ChronicleKeyAction,
  type ChronicleKeyState,
} from "./chronicleKeys";
import VerticalZoomDial from "./VerticalZoomDial";

const ChronicleView = lazy(() => import("./ChronicleView"));
const GitHistoryView = lazy(() => import("./GitHistoryView"));

const GITS_VIEW_KEY = "sparkmux.gitsView";

export type GitsView = "canvas" | "chronicle" | "history";

const ORG_MODES: { id: CardOrganizationMode; label: string; title: string }[] = [
  { id: "grid", label: "⊞ GRID", title: "Auto-Fit Grid: Balanced responsive matrix fitting screen" },
  { id: "pipeline", label: "▥ PIPELINE", title: "Pipeline: Lifecycle kanban (Agent, Modified, Added, Other)" },
  { id: "modules", label: "🗂 MODULES", title: "Modules: Grouped by directory / subsystem hierarchy" },
  { id: "impact", label: "🔥 IMPACT", title: "Impact: Priority waterfall ranked by change churn" },
  { id: "radial", label: "◎ RADIAL", title: "Radial: Orbit constellation radiating from primary hub" },
];

function readGitsView(): GitsView {
  try {
    const v = sessionStorage.getItem(GITS_VIEW_KEY);
    if (v === "chronicle" || v === "history") return v;
    return "canvas";
  } catch {
    return "canvas";
  }
}

function writeGitsView(view: GitsView) {
  try {
    sessionStorage.setItem(GITS_VIEW_KEY, view);
  } catch {
    // Private mode can reject storage. The in-memory view still switches.
  }
}

export interface ChangeGraphProps {
  sessionName?: string;
  tabId?: string;
  tabName?: string;
  command: string;
  cwd: string;
  title: string;
  pid: number;
  onClose: () => void;
  onPopOut?: () => void;
  isStandaloneWindow?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
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

function renderHighlightedText(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q || !text) return text;
  const lowerText = text.toLowerCase();
  const lowerQuery = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let matchIdx = lowerText.indexOf(lowerQuery, lastIdx);

  if (matchIdx === -1) return text;

  while (matchIdx !== -1) {
    if (matchIdx > lastIdx) {
      parts.push(text.slice(lastIdx, matchIdx));
    }
    parts.push(
      <mark
        key={matchIdx}
        style={{
          background: "rgba(250, 204, 21, 0.4)",
          color: "#fef08a",
          borderRadius: "2px",
          padding: "0 1px",
          fontWeight: 700,
        }}
      >
        {text.slice(matchIdx, matchIdx + q.length)}
      </mark>
    );
    lastIdx = matchIdx + q.length;
    matchIdx = lowerText.indexOf(lowerQuery, lastIdx);
  }

  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }

  return <>{parts}</>;
}

export default function ChangeGraph({
  sessionName,
  tabId,
  tabName,
  command,
  cwd,
  title,
  pid,
  onClose,
  onPopOut,
  isStandaloneWindow = false,
  pinned = false,
  onTogglePin,
}: ChangeGraphProps) {
  const [data, setData] = useState<ChangeGraphResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const [filterRepo, setFilterRepo] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [searchScope, setSearchScope] = useState<"diff" | "full">("diff");
  const [searchMatches, setSearchMatches] = useState<Record<string, number>>({});
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [animatePulses, setAnimatePulses] = useState<boolean>(true);
  // Split pane & Git Diff state
  const [splitRatio, setSplitRatio] = useState<number>(0.5);
  const [isResizingSplit, setIsResizingSplit] = useState<boolean>(false);
  const [diffViewMode, setDiffViewMode] = useState<"unified" | "split">("unified");
  const [diffLoading, setDiffLoading] = useState<boolean>(false);
  const [diffData, setDiffData] = useState<FileDiffResponse | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const mainContainerRef = useRef<HTMLDivElement>(null);

  // Pan & Zoom viewport state
  const [zoom, setZoom] = useState<number>(1.0);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const panOriginRef = useRef({ x: 0, y: 0 });

  // Organization mode & screen real-estate tracking
  const [orgMode, setOrgMode] = useState<CardOrganizationMode>("grid");
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>({ width: 900, height: 600 });
  const hasInitialFitRef = useRef(false);
  const [view, setView] = useState<GitsView>(readGitsView);
  const [historyFileFilter, setHistoryFileFilter] = useState<string | null>(null);
  const chronicleApplyRef = useRef<(action: ChronicleKeyAction) => void>(() => {});
  const sceneSlotRef = useRef<HTMLDivElement>(null);
  const [chronicleKeys, setChronicleKeys] = useState<ChronicleKeyState>({
    onNewest: true,
    scene: "transit",
    files: [],
    stations: [],
    activeId: "",
    nowAvailable: () => false,
  });
  const chronicleKeysRef = useRef(chronicleKeys);
  chronicleKeysRef.current = chronicleKeys;
  const onChronicleKeyContext = useCallback((state: ChronicleKeyState) => {
    setChronicleKeys(state);
  }, []);
  const closeGraph = useCallback(() => {
    void clearChronicleCache().catch((err: unknown) => {
      console.error(err);
    });
    onClose();
  }, [onClose]);
  const setGitsView = useCallback((next: GitsView) => {
    writeGitsView(next);
    setView(next);
  }, []);

  // Multi-touch pinch state for touchscreen
  const touchPinchRef = useRef<{
    initialDist: number;
    initialZoom: number;
    midX: number;
    midY: number;
    initialPan: { x: number; y: number };
  } | null>(null);

  // Track viewport real-estate with ResizeObserver
  useEffect(() => {
    if (view !== "canvas") return;
    const el = viewportRef.current;
    if (!el) return;
    const updateSize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        setViewportSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
      }
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  // WebKit native trackpad multi-touch gestures (Safari/macOS WKWebView)
  useEffect(() => {
    if (view !== "canvas") return;
    const el = viewportRef.current;
    if (!el) return;

    let initialGestureZoom = zoom;
    let gestureMid = { x: 0, y: 0 };
    let initialGesturePan = { ...pan };

    const onGestureStart = (e: any) => {
      e.preventDefault();
      initialGestureZoom = zoom;
      initialGesturePan = { ...pan };
      const rect = el.getBoundingClientRect();
      gestureMid = {
        x: (e.clientX || rect.width / 2) - rect.left,
        y: (e.clientY || rect.height / 2) - rect.top,
      };
    };

    const onGestureChange = (e: any) => {
      e.preventDefault();
      if (e.scale) {
        const newZoom = Math.min(2.5, Math.max(0.35, initialGestureZoom * e.scale));
        const ratio = newZoom / initialGestureZoom;
        setPan({
          x: gestureMid.x - (gestureMid.x - initialGesturePan.x) * ratio,
          y: gestureMid.y - (gestureMid.y - initialGesturePan.y) * ratio,
        });
        setZoom(newZoom);
      }
    };

    el.addEventListener("gesturestart", onGestureStart, { passive: false });
    el.addEventListener("gesturechange", onGestureChange, { passive: false });
    return () => {
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, [view, zoom, pan]);

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

  // One capture listener. Canvas and History stay Escape-only; Chronicle swallows before xterm sees the key.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (view === "canvas" || view === "history") {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (view === "canvas" && selectedCardId) {
          setSelectedCardId(null);
        } else if (!isStandaloneWindow) {
          closeGraph();
        }
        return;
      }
      const state = chronicleKeysRef.current;
      const action = chronicleKeyAction({
        key: event.key,
        shift: event.shiftKey,
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        inHologram: event.target instanceof Element && event.target.closest(".chronicle-hologram") != null,
        onNewest: state.onNewest,
        enabledScenes: ENABLED_CHRONICLE_SCENES,
        scene: state.scene,
        files: state.files,
        stations: state.stations,
        activeId: state.activeId,
        nowAvailable: state.nowAvailable,
      });
      if (!applyChronicleKeyEvent(event, action)) return;
      if (!action.swallow || action.action === "none") return;
      if (action.action === "close") {
        if (!isStandaloneWindow) closeGraph();
        return;
      }
      chronicleApplyRef.current(action);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [view, selectedCardId, closeGraph, isStandaloneWindow]);

  useEffect(() => {
    if (view !== "chronicle") return;
    const blurXterm = (event?: FocusEvent) => {
      const node = (event?.target ?? document.activeElement) as Element | null;
      if (node instanceof HTMLElement && node.matches(".xterm-helper-textarea")) node.blur();
    };
    blurXterm();
    document.addEventListener("focusin", blurXterm, true);
    return () => document.removeEventListener("focusin", blurXterm, true);
  }, [view]);

  // Fetch changeGraph API
  useEffect(() => {
    if (view !== "canvas") return;
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
  }, [command, cwd, title, pid, view]);

  // Construct Cards and Chain Connections
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

  const availableHistoryFiles = useMemo(() => {
    return cards.map((c) => ({ path: c.path, repoId: c.repoId }));
  }, [cards]);

  // Text search across changed files (diff changes or full content)
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || cards.length === 0) {
      setSearchMatches({});
      setIsSearching(false);
      return;
    }

    let cancel = false;
    setIsSearching(true);

    const timer = setTimeout(() => {
      const targets = cards.map((c) => ({
        repo_id: c.repoId,
        path: c.path,
      }));

      searchChangedFiles(targets, q, searchScope, cwd)
        .then((matches) => {
          if (!cancel) {
            const map: Record<string, number> = {};
            for (const m of matches) {
              const cardId = `${m.repo_id}::${m.path}`;
              map[cardId] = m.match_count;
            }
            setSearchMatches(map);
            setIsSearching(false);
          }
        })
        .catch((err) => {
          if (!cancel) {
            console.error("searchChangedFiles error:", err);
            setIsSearching(false);
          }
        });
    }, 150);

    return () => {
      cancel = true;
      clearTimeout(timer);
    };
  }, [searchQuery, searchScope, cards, cwd]);

  // Filtered Cards: unified matching (path, repoName, or text in diff/file)
  const visibleCards = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const effectiveFilter = filterRepo && repos.some((r) => r.id === filterRepo) ? filterRepo : null;
    return cards.filter((c) => {
      if (effectiveFilter && c.repoId !== effectiveFilter) return false;
      if (!q) return true;
      const pathMatch = c.path.toLowerCase().includes(q) || c.repoName.toLowerCase().includes(q);
      const textMatch = (searchMatches[c.id] ?? 0) > 0;
      return pathMatch || textMatch;
    });
  }, [cards, repos, filterRepo, searchQuery, searchMatches]);

  // Dynamic Card Organization Layout fitting current viewport real-estate
  const arrangement = useMemo(() => {
    return arrangeCards(visibleCards, orgMode, viewportSize.width, viewportSize.height);
  }, [visibleCards, orgMode, viewportSize.width, viewportSize.height]);

  // Card Positions Map (allows dragging individual cards)
  const [customPositions, setCustomPositions] = useState<{ [id: string]: { x: number; y: number } }>({});

  const getCardPos = (c: FileCardData) => {
    return customPositions[c.id] || arrangement.positions[c.id] || { x: c.x, y: c.y };
  };

  const visibleCardIds = useMemo(() => new Set(visibleCards.map((c) => c.id)), [visibleCards]);

  // Initial Auto-Fit Camera framing once cards are loaded
  useEffect(() => {
    if (!hasInitialFitRef.current && visibleCards.length > 0 && viewportSize.width > 0) {
      hasInitialFitRef.current = true;
      const result = arrangeCards(visibleCards, orgMode, viewportSize.width, viewportSize.height);
      const fit = computeFitCamera(result.positions, viewportSize.width, viewportSize.height, CARD_WIDTH, CARD_HEIGHT);
      setZoom(fit.zoom);
      setPan(fit.pan);
    }
  }, [visibleCards.length, orgMode, viewportSize.width, viewportSize.height]);

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

  // Wheel control now PANS workspace instead of zooming, unless trackpad pinch (ctrlKey) is active
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    // Multi-touch trackpad pinch (dispatched with ctrlKey === true)
    if (e.ctrlKey) {
      const factor = e.deltaY < 0 ? 1.05 : 0.95;
      const newZoom = Math.min(2.5, Math.max(0.35, zoom * factor));
      if (viewportRef.current) {
        const rect = viewportRef.current.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const ratio = newZoom / zoom;
        setPan((prev) => ({
          x: mouseX - (mouseX - prev.x) * ratio,
          y: mouseY - (mouseY - prev.y) * ratio,
        }));
      }
      setZoom(newZoom);
      return;
    }

    // Regular mouse wheel / scroll gesture: PAN WORKSPACE
    setPan((prev) => ({
      x: prev.x - e.deltaX,
      y: prev.y - e.deltaY,
    }));
  };

  // Multi-touch gestures (touchscreen 2-finger pinch to zoom)
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      const t0 = e.touches[0]!;
      const t1 = e.touches[1]!;
      const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      const rect = viewportRef.current?.getBoundingClientRect();
      const midX = (t0.clientX + t1.clientX) / 2 - (rect?.left ?? 0);
      const midY = (t0.clientY + t1.clientY) / 2 - (rect?.top ?? 0);
      touchPinchRef.current = {
        initialDist: dist,
        initialZoom: zoom,
        midX,
        midY,
        initialPan: { ...pan },
      };
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && touchPinchRef.current && touchPinchRef.current.initialDist > 0) {
      e.preventDefault();
      const t0 = e.touches[0]!;
      const t1 = e.touches[1]!;
      const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      const scale = dist / touchPinchRef.current.initialDist;
      const newZoom = Math.min(2.5, Math.max(0.35, touchPinchRef.current.initialZoom * scale));
      const ratio = newZoom / touchPinchRef.current.initialZoom;
      const { midX, midY, initialPan } = touchPinchRef.current;
      setPan({
        x: midX - (midX - initialPan.x) * ratio,
        y: midY - (midY - initialPan.y) * ratio,
      });
      setZoom(newZoom);
    }
  };

  const handleTouchEnd = () => {
    touchPinchRef.current = null;
  };

  // Auto-arrange and fit camera to screen
  const handleAutoFit = () => {
    setCustomPositions({});
    const result = arrangeCards(visibleCards, orgMode, viewportSize.width, viewportSize.height);
    const fit = computeFitCamera(result.positions, viewportSize.width, viewportSize.height, CARD_WIDTH, CARD_HEIGHT);
    setZoom(fit.zoom);
    setPan(fit.pan);
  };

  // Switch organization mode and auto-frame
  const handleToggleOrgMode = (newMode: CardOrganizationMode) => {
    setOrgMode(newMode);
    setCustomPositions({});
    const result = arrangeCards(visibleCards, newMode, viewportSize.width, viewportSize.height);
    const fit = computeFitCamera(result.positions, viewportSize.width, viewportSize.height, CARD_WIDTH, CARD_HEIGHT);
    setZoom(fit.zoom);
    setPan(fit.pan);
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
  const selectedFile = useMemo(() => {
    return cards.find((c) => c.id === selectedCardId) ?? null;
  }, [cards, selectedCardId]);

  // Fetch diff when selectedFile changes
  useEffect(() => {
    if (!selectedFile) {
      setDiffData(null);
      setDiffError(null);
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiffData(null);
    setDiffLoading(true);
    setDiffError(null);
    fileDiff(selectedFile.repoId, selectedFile.path, cwd)
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
  }, [selectedFile?.repoId, selectedFile?.path, cwd]);

  // Diff metrics
  const diffStats = useMemo(() => {
    if (!diffData?.diff) return { adds: 0, rems: 0 };
    let adds = 0;
    let rems = 0;
    for (const l of diffData.diff.split("\n")) {
      if (l.startsWith("+") && !l.startsWith("+++")) adds++;
      else if (l.startsWith("-") && !l.startsWith("---")) rems++;
    }
    return { adds, rems };
  }, [diffData]);

  // Parsed side-by-side diff
  const splitDiffRows = useMemo(() => {
    if (!diffData?.diff || diffViewMode !== "split") return [];
    return parseSideBySideDiff(diffData.diff);
  }, [diffData, diffViewMode]);

  // Connected links for selected file
  const selectedFileLinks = useMemo(() => {
    if (!selectedFile) return [];
    return links.filter((l) => l.fromId === selectedFile.id || l.toId === selectedFile.id);
  }, [selectedFile, links]);

  // Splitter drag resize handler
  const handleSplitterPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const container = mainContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const prevSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    document.body.classList.add("is-resizing");
    setIsResizingSplit(true);

    const onPointerMove = (ev: PointerEvent) => {
      const offset = ev.clientX - rect.left;
      const ratio = offset / rect.width;
      setSplitRatio(Math.min(0.8, Math.max(0.2, ratio)));
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.style.userSelect = prevSelect;
      document.body.style.cursor = prevCursor;
      document.body.classList.remove("is-resizing");
      setIsResizingSplit(false);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  return (
    <div
      className="scifi-hud-overlay graph-overlay"
      onClick={isStandaloneWindow ? undefined : closeGraph}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="scifi-hud-frame graph-frame fullscreen"
        style={{
          display: "flex",
          flexDirection: "column",
          padding: 0,
          background: "#05070a",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={
          view === "chronicle"
            ? "Gits Chronicle"
            : view === "history"
            ? "Gits History"
            : "File Change Card Chain Graph"
        }
      >
        {/* 1. TOP HEADER & FILTER TOOLBAR */}
        <div className="gits-toolbar">
          {/* Logo / Badge */}
          <div className="gits-brand">
            <span className="gits-brand-mark" aria-hidden="true">⬡</span>
            <span className="gits-brand-title">
              {view === "chronicle"
                ? "GITS · CHRONICLE"
                : view === "history"
                ? "GITS · HISTORY"
                : "GITS · CHAIN GRAPH"}
            </span>
            {sessionName && (
              <span
                className="gits-session"
                title={`Active target: ${sessionName}:${tabName ?? "shell"}${tabId ? ` (${tabId})` : ""}`}
              >
                {sessionName}:{tabName ?? "shell"}
              </span>
            )}
          </div>

          {/* Repo Cluster Filter Tabs */}
          {view === "canvas" && (
          <div className="gits-clusters">
            <button
              type="button"
              onClick={() => setFilterRepo(null)}
              title="Show every cluster"
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
              ALL ({repos.length})
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
          )}

          {/* Search Box & Quick Scope Toggle */}
          {view === "canvas" && (
          <div className="gits-search-row">
            <div style={{ display: "flex", alignItems: "center", position: "relative", flex: "1 1 auto", minWidth: 0 }}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={
                  searchScope === "diff"
                    ? "Search path or diff..."
                    : "Search path or full file..."
                }
                className="gits-search"
                style={{
                  background: "rgba(0, 0, 0, 0.45)",
                  border: isSearching
                    ? "1px solid rgba(250, 204, 21, 0.6)"
                    : searchQuery.trim()
                    ? "1px solid rgba(45, 212, 191, 0.55)"
                    : "1px solid rgba(45, 212, 191, 0.25)",
                  borderRadius: "3px",
                  padding: "3px 22px 3px 8px",
                  fontSize: "10px",
                  color: "#fff",
                  outline: "none",
                  fontFamily: "inherit",
                  transition: "border-color 0.15s ease",
                }}
              />
              {isSearching && (
                <span
                  title="Searching changed files..."
                  style={{
                    position: "absolute",
                    right: searchQuery ? 18 : 6,
                    fontSize: "9px",
                    color: "#fde047",
                    pointerEvents: "none",
                  }}
                >
                  ⏳
                </span>
              )}
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
                    lineHeight: 1,
                    padding: 0,
                  }}
                  title="Clear search"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Scope Quick Toggle */}
            <button
              type="button"
              onClick={() => setSearchScope(searchScope === "diff" ? "full" : "diff")}
              title={
                searchScope === "diff"
                  ? "Current Scope: Diff changes only. Click to toggle Full file content search."
                  : "Current Scope: Full file contents. Click to toggle Diff changes only search."
              }
              style={{
                background:
                  searchScope === "diff"
                    ? "rgba(45, 212, 191, 0.14)"
                    : "rgba(168, 85, 247, 0.16)",
                border:
                  searchScope === "diff"
                    ? "1px solid rgba(45, 212, 191, 0.4)"
                    : "1px solid rgba(168, 85, 247, 0.45)",
                color: searchScope === "diff" ? "#2dd4bf" : "#c084fc",
                padding: "3px 7px",
                borderRadius: "3px",
                fontSize: "9px",
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: "inherit",
                letterSpacing: "0.06em",
                whiteSpace: "nowrap",
                display: "inline-flex",
                alignItems: "center",
                gap: "3px",
              }}
            >
              <span>{searchScope === "diff" ? "⚡ DIFF" : "📄 FULL"}</span>
            </button>
          </div>
          )}

          {/* Card Organization Modes Toggle & Auto-Fit */}
          <div className="gits-toolbar-modes">
            <div className="graph-mode-group" role="group" aria-label="Gits view">
              <button
                type="button"
                className={`graph-mode-btn ${view === "canvas" ? "on" : ""}`}
                aria-pressed={view === "canvas"}
                onClick={() => setGitsView("canvas")}
              >
                Canvas
              </button>
              <button
                type="button"
                className={`graph-mode-btn ${view === "chronicle" ? "on" : ""}`}
                aria-pressed={view === "chronicle"}
                onClick={() => setGitsView("chronicle")}
              >
                Chronicle
              </button>
              <button
                type="button"
                className={`graph-mode-btn ${view === "history" ? "on" : ""}`}
                aria-pressed={view === "history"}
                onClick={() => setGitsView("history")}
              >
                History
              </button>
            </div>
            {view === "canvas" ? (
            <select
              className="gits-mode-select"
              value={orgMode}
              aria-label="Card organization mode"
              title={ORG_MODES.find((mode) => mode.id === orgMode)?.title}
              onChange={(event) => {
                const next = ORG_MODES.find((mode) => mode.id === event.target.value);
                if (next) handleToggleOrgMode(next.id);
              }}
            >
              {ORG_MODES.map((mode) => (
                <option key={mode.id} value={mode.id} title={mode.title}>
                  {mode.label}
                </option>
              ))}
            </select>
            ) : view === "chronicle" ? (
            <div ref={sceneSlotRef} className="graph-mode-group" role="group" aria-label="Chronicle scene" />
            ) : null}

            {view === "canvas" && (
            <button
              type="button"
              onClick={handleAutoFit}
              title="Auto arrange cards to fit current screen real-estate"
              style={{
                background: "rgba(45, 212, 191, 0.16)",
                color: "#2dd4bf",
                border: "1px solid rgba(45, 212, 191, 0.4)",
                padding: "3px 8px",
                fontSize: "9px",
                borderRadius: "3px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontWeight: 600,
                letterSpacing: "0.06em",
                whiteSpace: "nowrap",
              }}
            >
              ⤢ FIT
            </button>
            )}
          </div>

          {/* Summary Metric Counters */}
          <div className="gits-toolbar-end">
            {view === "canvas" && (
            <div className="gits-metrics" title={`${totalFiles} files, +${totalAdded} -${totalRemoved}`}>
              <span style={{ color: "rgba(255,255,255,0.4)" }}>Files</span>
              <strong style={{ color: "#fff" }}>{totalFiles}</strong>
              <span style={{ color: "#2dd4bf" }}>+{totalAdded}</span>
              <span style={{ color: "#f87171" }}>-{totalRemoved}</span>
              {agentEditedCount > 0 && (
                <span
                  title={`${agentEditedCount} agent edits`}
                  style={{
                    padding: "1px 5px",
                    borderRadius: "2px",
                    background: "rgba(232, 168, 73, 0.2)",
                    color: "#e8a849",
                    border: "1px solid rgba(232, 168, 73, 0.4)",
                    fontSize: "9px",
                  }}
                >
                  ⚡ {agentEditedCount}
                </span>
              )}
            </div>
            )}

            {/* Pulse Animation Toggle */}
            {view === "canvas" && (
            <>
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
              {animatePulses ? "⚡ ON" : "⚡ OFF"}
            </button>

            {/* Reset Zoom/Pan */}
            <button
              type="button"
              onClick={handleResetView}
              title={`Reset zoom and pan (currently ${(zoom * 100).toFixed(0)}%)`}
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
              ↺ {(zoom * 100).toFixed(0)}%
            </button>
            </>
            )}

            {isStandaloneWindow && onTogglePin && (
              <button
                type="button"
                onClick={onTogglePin}
                aria-pressed={pinned}
                title={
                  pinned
                    ? `Pinned to ${sessionName ?? "sparkmux"}:${tabName ?? "shell"} — click to follow active tab in main window`
                    : "Following active tab in main window — click to pin to this tab"
                }
                style={{
                  background: pinned ? "rgba(45, 212, 191, 0.2)" : "transparent",
                  color: pinned ? "#2dd4bf" : "rgba(255, 255, 255, 0.7)",
                  border: pinned
                    ? "1px solid rgba(45, 212, 191, 0.5)"
                    : "1px solid rgba(255, 255, 255, 0.2)",
                  padding: "3px 8px",
                  fontSize: "9px",
                  borderRadius: "3px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  whiteSpace: "nowrap",
                }}
              >
                {pinned ? "📌 PINNED" : "◎ FOLLOWING"}
              </button>
            )}

            {onPopOut && !isStandaloneWindow && (
              <button
                type="button"
                onClick={onPopOut}
                title="Open Gits in a separate desktop window"
                aria-label="Open Gits in a separate window"
                style={{
                  background: "rgba(45, 212, 191, 0.14)",
                  color: "#2dd4bf",
                  border: "1px solid rgba(45, 212, 191, 0.38)",
                  padding: "3px 8px",
                  fontSize: "9px",
                  borderRadius: "3px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  whiteSpace: "nowrap",
                }}
              >
                ⧉ POP OUT
              </button>
            )}

            {/* Close Button */}
            <button
              type="button"
              className="scifi-close graph-close"
              onClick={closeGraph}
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

        {/* 2. MAIN WORKSPACE CONTAINER: 2D GRAPH + RESIZABLE GIT DIFF PANE */}
        <div
          ref={mainContainerRef}
          style={{
            flex: 1,
            display: "flex",
            minHeight: 0,
            position: "relative",
            overflow: "hidden",
          }}
        >
          {view === "chronicle" ? (
            <Suspense
              fallback={
                <div className="graph-stage chronicle-view">
                  <div className="chronicle-status">
                    <div>
                      <b>READING SESSION…</b>
                    </div>
                  </div>
                </div>
              }
            >
              <ChronicleView
                command={command}
                cwd={cwd}
                title={title}
                pid={pid}
                onKeyContext={onChronicleKeyContext}
                applyRef={chronicleApplyRef}
                sceneSlotRef={sceneSlotRef}
              />
            </Suspense>
          ) : view === "history" ? (
            <Suspense
              fallback={
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#2dd4bf",
                    fontFamily: "ui-monospace, monospace",
                    fontSize: "12px",
                  }}
                >
                  <b>READING GIT HISTORY…</b>
                </div>
              }
            >
              <GitHistoryView
                cwd={cwd}
                repoId={filterRepo ?? undefined}
                initialFileFilter={historyFileFilter}
                availableFiles={availableHistoryFiles}
                onOpenFileInEditor={(filePath) => void openEditorPath(filePath, cwd)}
              />
            </Suspense>
          ) : (
          <>
          {/* LEFT: 2D GRAPH WORKSPACE */}
          <div
            ref={viewportRef}
            onPointerDown={handleViewportPointerDown}
            onPointerMove={handleViewportPointerMove}
            onPointerUp={handleViewportPointerUp}
            onPointerCancel={handleViewportPointerUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            onWheel={handleWheel}
            style={{
              flex: selectedFile ? `0 0 calc(${splitRatio * 100}% - 3px)` : "1 1 100%",
              maxWidth: selectedFile ? `calc(${splitRatio * 100}% - 3px)` : "100%",
              width: selectedFile ? `calc(${splitRatio * 100}% - 3px)` : "100%",
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
              transition: isResizingSplit ? "none" : "flex 0.12s ease, max-width 0.12s ease",
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

              {/* Radial Orbit Rings */}
              {orgMode === "radial" &&
                arrangement.orbitRings.map((ring, idx) => (
                  <g key={`orbit-ring-${idx}`}>
                    <circle
                      cx={ring.cx}
                      cy={ring.cy}
                      r={ring.r}
                      fill="none"
                      stroke="rgba(45, 212, 191, 0.18)"
                      strokeWidth="1.2"
                      strokeDasharray="5 7"
                    />
                    <text
                      x={ring.cx}
                      y={ring.cy - ring.r - 8}
                      textAnchor="middle"
                      fill="rgba(45, 212, 191, 0.65)"
                      fontSize="9px"
                      fontFamily="ui-monospace, monospace"
                      letterSpacing="0.12em"
                    >
                      {ring.label}
                    </text>
                  </g>
                ))}

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

            {/* LANE HEADERS LAYER (PIPELINE, MODULES, IMPACT) */}
            {arrangement.laneHeaders.map((header) => (
              <div
                key={header.id}
                style={{
                  position: "absolute",
                  left: header.x,
                  top: header.y,
                  width: header.width,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 10px",
                  background: "rgba(6, 12, 18, 0.92)",
                  border: `1px solid ${header.color}40`,
                  borderTop: `2.5px solid ${header.color}`,
                  borderRadius: "4px",
                  fontSize: "9px",
                  fontFamily: "ui-monospace, monospace",
                  color: header.color,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  boxShadow: "0 4px 14px rgba(0,0,0,0.6)",
                  pointerEvents: "none",
                  zIndex: 5,
                  transition: "left 0.35s cubic-bezier(0.2, 0.8, 0.2, 1), top 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "6px", overflow: "hidden" }}>
                  <span style={{ whiteSpace: "nowrap" }}>{header.title}</span>
                  {header.badge && (
                    <span
                      style={{
                        fontSize: "7.5px",
                        padding: "1px 4px",
                        borderRadius: "2px",
                        background: `${header.color}20`,
                        border: `1px solid ${header.color}50`,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {header.badge}
                    </span>
                  )}
                </div>
                <span
                  style={{
                    background: "rgba(255,255,255,0.08)",
                    padding: "1px 6px",
                    borderRadius: "10px",
                    fontSize: "8.5px",
                    color: "#fff",
                  }}
                >
                  {header.count}
                </span>
              </div>
            ))}

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
              const matchCount = searchMatches[card.id] ?? 0;

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
                      : matchCount > 0
                      ? "rgba(250, 204, 21, 0.65)"
                      : isConnected
                      ? "rgba(45, 212, 191, 0.45)"
                      : "rgba(255, 255, 255, 0.12)",
                    boxShadow: isSelected
                      ? "0 0 25px rgba(45, 212, 191, 0.35), 0 8px 30px rgba(0,0,0,0.8)"
                      : isHovered
                      ? "0 0 16px rgba(45, 212, 191, 0.2), 0 6px 20px rgba(0,0,0,0.7)"
                      : matchCount > 0
                      ? "0 0 16px rgba(250, 204, 21, 0.25), 0 6px 20px rgba(0,0,0,0.7)"
                      : "0 4px 14px rgba(0, 0, 0, 0.6)",
                    opacity: isDimmed ? 0.3 : 1.0,
                    transform: isSelected || isHovered ? "scale(1.02)" : "scale(1.0)",
                    transition:
                      draggingCardId === card.id
                        ? "none"
                        : "left 0.35s cubic-bezier(0.2, 0.8, 0.2, 1), top 0.35s cubic-bezier(0.2, 0.8, 0.2, 1), transform 0.15s ease, border-color 0.15s ease, opacity 0.2s ease",
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

                    <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                      {matchCount > 0 && (
                        <span
                          title={`${matchCount} text match${matchCount > 1 ? "es" : ""} found in ${
                            searchScope === "diff" ? "diff changes" : "file content"
                          }`}
                          style={{
                            fontSize: "8.5px",
                            padding: "1px 5px",
                            borderRadius: "3px",
                            background: "rgba(250, 204, 21, 0.2)",
                            color: "#fde047",
                            border: "1px solid rgba(250, 204, 21, 0.5)",
                            fontWeight: 700,
                            letterSpacing: "0.04em",
                            whiteSpace: "nowrap",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "2px",
                          }}
                        >
                          ⌕ {matchCount}
                        </span>
                      )}
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
                      {renderHighlightedText(card.filename, searchQuery)}
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
                      {renderHighlightedText(card.dir, searchQuery)}
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
            <span>DRAG CARD TO REARRANGE · WHEEL / SWIPE TO PAN · PINCH OR VERTICAL DIAL TO ZOOM</span>
          </div>

          {/* Vertical Zoom In/Out Dial */}
          <VerticalZoomDial
            zoom={zoom}
            minZoom={0.35}
            maxZoom={2.5}
            onZoomChange={(newZ) => {
              if (viewportRef.current) {
                const rect = viewportRef.current.getBoundingClientRect();
                const cx = rect.width / 2;
                const cy = rect.height / 2;
                const ratio = newZ / zoom;
                setPan((prev) => ({
                  x: cx - (cx - prev.x) * ratio,
                  y: cy - (cy - prev.y) * ratio,
                }));
              }
              setZoom(newZ);
            }}
            onFit={handleAutoFit}
            onReset={() => {
              setZoom(1.0);
              setPan({ x: 0, y: 0 });
            }}
          />

          {/* Empty / Error state */}
          {cards.length === 0 && (
            <div className="graph-empty" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              <b>{data == null ? (loadError ? "SCAN FAILED" : "READING WORKSPACE...") : "NO CHANGED FILES"}</b>
              <span>{data == null ? (loadError ?? "Gathering repo git changes and agent diffs...") : "Working directory is clean."}</span>
            </div>
          )}
        </div>

        {/* DRAGGABLE RESIZABLE SPLITTER (SHOWN WHEN FILE IS SELECTED) */}
        {selectedFile && (
          <div
            className="graph-diff-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize git diff panel"
            title="Drag to resize Git Diff panel (Double-click to reset 50%)"
            onPointerDown={handleSplitterPointerDown}
            onDoubleClick={() => setSplitRatio(0.5)}
          >
            <span className="graph-diff-splitter-rule" />
          </div>
        )}

        {/* RIGHT: GIT CHANGES & DIFF PANEL */}
        {selectedFile && (
          <div
            style={{
              flex: 1,
              minWidth: "280px",
              display: "flex",
              flexDirection: "column",
              background: "#04070c",
              overflow: "hidden",
              zIndex: 20,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            {/* Diff Viewer Top Header */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                padding: "8px 12px 10px",
                background: "rgba(9, 15, 24, 0.98)",
                borderBottom: "1px solid rgba(45, 212, 191, 0.2)",
                gap: "6px",
                flexShrink: 0,
              }}
            >
              {/* Top Row: Title, Badges, Delta, Mode Toggle, Close */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, flexWrap: "wrap" }}>
                  <span style={{ fontSize: "13px", color: "#2dd4bf" }}>⬡</span>
                  <span style={{ fontSize: "11px", fontWeight: "bold", color: "#fff", letterSpacing: "0.08em" }}>
                    GIT CHANGES
                  </span>
                  <span
                    style={{
                      fontSize: "9px",
                      padding: "1px 6px",
                      borderRadius: "2px",
                      background: selectedFile.isPrimaryRepo ? "rgba(45, 212, 191, 0.15)" : "rgba(255, 154, 60, 0.15)",
                      color: selectedFile.isPrimaryRepo ? "#5eead4" : "#ff9a3c",
                      border: `1px solid ${selectedFile.isPrimaryRepo ? "rgba(45, 212, 191, 0.3)" : "rgba(255, 154, 60, 0.3)"}`,
                      textTransform: "uppercase",
                    }}
                  >
                    {selectedFile.repoName}
                  </span>
                  <span
                    style={{
                      fontSize: "9px",
                      color: statusColor(selectedFile.status),
                      fontWeight: 600,
                    }}
                  >
                    [{statusLabel(selectedFile.status)}]
                  </span>
                  {selectedFile.agentEdited && (
                    <span
                      style={{
                        fontSize: "8.5px",
                        padding: "1px 5px",
                        borderRadius: "2px",
                        background: "rgba(232, 168, 73, 0.25)",
                        color: "#e8a849",
                        border: "1px solid rgba(232, 168, 73, 0.5)",
                        fontWeight: "bold",
                      }}
                    >
                      ⚡ AGENT
                    </span>
                  )}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
                  {searchQuery.trim() && (
                    <span
                      style={{
                        fontSize: "9px",
                        padding: "2px 6px",
                        borderRadius: "3px",
                        background: "rgba(250, 204, 21, 0.15)",
                        color: "#fde047",
                        border: "1px solid rgba(250, 204, 21, 0.35)",
                        fontWeight: 600,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      ⌕ &ldquo;{searchQuery.trim()}&rdquo;
                      {selectedCardId && (searchMatches[selectedCardId] ?? 0) > 0
                        ? ` (${searchMatches[selectedCardId]} in ${searchScope})`
                        : ""}
                    </span>
                  )}
                  {!diffLoading && !diffError && diffData && !diffData.is_binary && (
                    <div style={{ display: "flex", gap: "6px", fontSize: "10px", fontWeight: "bold" }}>
                      <span style={{ color: "#2dd4bf" }}>+{diffStats.adds}</span>
                      <span style={{ color: "#f87171" }}>-{diffStats.rems}</span>
                    </div>
                  )}

                  {/* View Mode Toggle */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      background: "rgba(0, 0, 0, 0.5)",
                      padding: "2px",
                      borderRadius: "3px",
                      border: "1px solid rgba(45, 212, 191, 0.25)",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setDiffViewMode("unified")}
                      style={{
                        background: diffViewMode === "unified" ? "rgba(45, 212, 191, 0.25)" : "transparent",
                        color: diffViewMode === "unified" ? "#2dd4bf" : "rgba(255, 255, 255, 0.45)",
                        border: "none",
                        padding: "2px 7px",
                        fontSize: "8.5px",
                        borderRadius: "2px",
                        cursor: "pointer",
                        fontFamily: "inherit",
                        fontWeight: diffViewMode === "unified" ? 600 : 400,
                      }}
                      title="Unified Inline Diff View"
                    >
                      UNIFIED
                    </button>
                    <button
                      type="button"
                      onClick={() => setDiffViewMode("split")}
                      style={{
                        background: diffViewMode === "split" ? "rgba(45, 212, 191, 0.25)" : "transparent",
                        color: diffViewMode === "split" ? "#2dd4bf" : "rgba(255, 255, 255, 0.45)",
                        border: "none",
                        padding: "2px 7px",
                        fontSize: "8.5px",
                        borderRadius: "2px",
                        cursor: "pointer",
                        fontFamily: "inherit",
                        fontWeight: diffViewMode === "split" ? 600 : 400,
                      }}
                      title="Side-by-Side Split Diff View"
                    >
                      SIDE-BY-SIDE
                    </button>
                  </div>

                  {/* View History Button */}
                  <button
                    type="button"
                    onClick={() => {
                      setHistoryFileFilter(selectedFile.path);
                      setGitsView("history");
                    }}
                    style={{
                      background: "rgba(45, 212, 191, 0.12)",
                      color: "#2dd4bf",
                      border: "1px solid rgba(45, 212, 191, 0.35)",
                      padding: "2px 7px",
                      fontSize: "8.5px",
                      borderRadius: "2px",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontWeight: 600,
                    }}
                    title={`View commit history for ${selectedFile.path}`}
                  >
                    📜 HISTORY
                  </button>

                  {/* Close button */}
                  <button
                    type="button"
                    onClick={() => setSelectedCardId(null)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "rgba(255, 255, 255, 0.5)",
                      fontSize: "14px",
                      cursor: "pointer",
                      padding: "2px 6px",
                      lineHeight: 1,
                    }}
                    title="Close Diff Pane (Esc)"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Second Row: Filename & Path */}
              <div style={{ display: "flex", alignItems: "baseline", gap: "8px", overflow: "hidden" }}>
                <span style={{ fontSize: "12px", fontWeight: "bold", color: "#fff", whiteSpace: "nowrap" }}>
                  {selectedFile.filename}
                </span>
                <span
                  style={{
                    fontSize: "10px",
                    color: "rgba(255, 255, 255, 0.45)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={selectedFile.path}
                >
                  {selectedFile.path}
                </span>
                <button
                  type="button"
                  className="open-editor"
                  onClick={() => {
                    void openEditorPath(selectedFile.path, cwd);
                  }}
                >
                  Open in editor
                </button>
              </div>

              {/* Third Row: Connected Chain Links Pills (if any) */}
              {selectedFileLinks.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    flexWrap: "wrap",
                    marginTop: "2px",
                    paddingTop: "4px",
                    borderTop: "1px solid rgba(255, 255, 255, 0.05)",
                  }}
                >
                  <span style={{ fontSize: "8.5px", color: "#5eead4", fontWeight: "bold" }}>
                    CONNECTED CHAINS ({selectedFileLinks.length}):
                  </span>
                  {selectedFileLinks.map((link) => {
                    const peerId = link.fromId === selectedFile.id ? link.toId : link.fromId;
                    const peerCard = cards.find((c) => c.id === peerId);
                    if (!peerCard) return null;
                    return (
                      <button
                        key={link.id}
                        type="button"
                        onClick={() => {
                          centerOnCard(peerCard);
                          setSelectedCardId(peerCard.id);
                        }}
                        style={{
                          background: "rgba(45, 212, 191, 0.12)",
                          border: "1px solid rgba(45, 212, 191, 0.3)",
                          borderRadius: "3px",
                          padding: "1px 6px",
                          fontSize: "8.5px",
                          color: "#99f6e4",
                          cursor: "pointer",
                          fontFamily: "inherit",
                          display: "flex",
                          alignItems: "center",
                          gap: "4px",
                        }}
                        title={`View diff for ${peerCard.filename} (${link.label})`}
                      >
                        <span>{peerCard.filename}</span>
                        <span style={{ color: "rgba(255,255,255,0.3)", fontSize: "7.5px" }}>({link.label})</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Diff Viewer Body */}
            <div
              style={{
                flex: 1,
                overflow: "auto",
                padding: "10px 14px",
                background: "#04070c",
                fontSize: "11px",
                lineHeight: "1.45",
              }}
            >
              {diffLoading && (
                <div style={{ padding: "40px 20px", textAlign: "center", color: "rgba(255, 255, 255, 0.5)" }}>
                  <div style={{ color: "#2dd4bf", marginBottom: "6px" }}>⚡ RETRIEVING WORKING COPY DIFF...</div>
                  <span>Querying git repository state for {selectedFile.filename}</span>
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
                diffData.is_binary ? (
                  <div style={{ padding: "30px 16px", textAlign: "center", color: "rgba(255, 255, 255, 0.5)" }}>
                    <div style={{ color: "#ff9a3c", marginBottom: "6px", fontSize: "12px", fontWeight: "bold" }}>
                      BINARY FILE MODIFIED
                    </div>
                    <span>Binary file changes cannot be displayed as text diff.</span>
                  </div>
                ) : !diffData.diff.trim() ? (
                  <div style={{ padding: "30px 16px", textAlign: "center", color: "rgba(255, 255, 255, 0.5)" }}>
                    <div style={{ color: "#2dd4bf", marginBottom: "6px", fontSize: "12px", fontWeight: "bold" }}>
                      CLEAN WORKING COPY
                    </div>
                    <span>No unstaged or uncommitted working copy diff detected against HEAD.</span>
                  </div>
                ) : diffViewMode === "unified" ? (
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {diffData.diff.split("\n").map((line, idx) => {
                      const isAdd = line.startsWith("+") && !line.startsWith("+++");
                      const isRem = line.startsWith("-") && !line.startsWith("---");
                      const isHunk = line.startsWith("@@");
                      const isComment = line.startsWith("#");
                      const isHeader =
                        line.startsWith("diff --git") ||
                        line.startsWith("index ") ||
                        line.startsWith("---") ||
                        line.startsWith("+++");

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
                            {renderHighlightedText(line || " ", searchQuery)}
                          </pre>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  /* SIDE-BY-SIDE DIFF VIEW */
                  <div style={{ display: "flex", flexDirection: "column", minWidth: "100%" }}>
                    {/* Column Headers */}
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "38px 1fr 38px 1fr",
                        gap: "0 4px",
                        background: "rgba(255, 255, 255, 0.03)",
                        borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
                        padding: "4px 6px",
                        fontSize: "9.5px",
                        fontWeight: "bold",
                        color: "rgba(255, 255, 255, 0.4)",
                        userSelect: "none",
                        marginBottom: "4px",
                      }}
                    >
                      <span style={{ textAlign: "right" }}>#</span>
                      <span style={{ color: "#f87171" }}>HEAD (ORIGINAL)</span>
                      <span style={{ textAlign: "right" }}>#</span>
                      <span style={{ color: "#34d399" }}>WORKING COPY (MODIFIED)</span>
                    </div>

                    {splitDiffRows.map((row, idx) => {
                      if (row.type === "hunk") {
                        return (
                          <div
                            key={idx}
                            style={{
                              padding: "3px 8px",
                              margin: "4px 0",
                              background: "rgba(56, 189, 248, 0.1)",
                              border: "1px solid rgba(56, 189, 248, 0.2)",
                              borderRadius: "2px",
                              color: "#38bdf8",
                              fontSize: "10px",
                              fontWeight: 600,
                            }}
                          >
                            {row.metaText}
                          </div>
                        );
                      }

                      if (row.type === "meta") {
                        return (
                          <div
                            key={idx}
                            style={{
                              padding: "1px 8px",
                              color: "rgba(255, 255, 255, 0.35)",
                              fontSize: "9.5px",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-all",
                            }}
                          >
                            {row.metaText}
                          </div>
                        );
                      }

                      // Line row: 4 grid columns
                      const leftBg =
                        row.oldKind === "removed"
                          ? "rgba(248, 113, 113, 0.12)"
                          : "transparent";
                      const rightBg =
                        row.newKind === "added"
                          ? "rgba(45, 212, 191, 0.12)"
                          : "transparent";

                      const leftColor =
                        row.oldKind === "removed"
                          ? "#f87171"
                          : "rgba(255, 255, 255, 0.75)";
                      const rightColor =
                        row.newKind === "added"
                          ? "#34d399"
                          : "rgba(255, 255, 255, 0.75)";

                      return (
                        <div
                          key={idx}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "38px minmax(0, 1fr) 38px minmax(0, 1fr)",
                            gap: "0 4px",
                            minHeight: "18px",
                            alignItems: "stretch",
                          }}
                        >
                          {/* Left Line Number */}
                          <div
                            style={{
                              background: leftBg,
                              textAlign: "right",
                              paddingRight: "6px",
                              color: "rgba(255, 255, 255, 0.2)",
                              userSelect: "none",
                              fontSize: "9.5px",
                            }}
                          >
                            {row.oldLineNo ?? ""}
                          </div>
                          {/* Left Code Text */}
                          <div
                            style={{
                              background: leftBg,
                              padding: "0 6px",
                              overflow: "hidden",
                            }}
                          >
                            <pre
                              style={{
                                margin: 0,
                                color: leftColor,
                                fontFamily: "inherit",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-all",
                              }}
                            >
                              {renderHighlightedText(row.oldText ?? " ", searchQuery)}
                            </pre>
                          </div>

                          {/* Right Line Number */}
                          <div
                            style={{
                              background: rightBg,
                              textAlign: "right",
                              paddingRight: "6px",
                              color: "rgba(255, 255, 255, 0.2)",
                              userSelect: "none",
                              fontSize: "9.5px",
                            }}
                          >
                            {row.newLineNo ?? ""}
                          </div>
                          {/* Right Code Text */}
                          <div
                            style={{
                              background: rightBg,
                              padding: "0 6px",
                              overflow: "hidden",
                            }}
                          >
                            <pre
                              style={{
                                margin: 0,
                                color: rightColor,
                                fontFamily: "inherit",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-all",
                              }}
                            >
                              {renderHighlightedText(row.newText ?? " ", searchQuery)}
                            </pre>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              )}
            </div>

            {/* Diff Viewer Status Bar */}
            <div
              style={{
                padding: "6px 12px",
                background: "rgba(9, 15, 24, 0.9)",
                borderTop: "1px solid rgba(255, 255, 255, 0.06)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: "9px",
                color: "rgba(255, 255, 255, 0.4)",
                flexShrink: 0,
              }}
            >
              <span>HEAD ↔ WORKING COPY{diffData ? ` · ${diffData.path}` : ""}</span>
              <span>ESC: CLOSE DIFF · DOUBLE-CLICK SPLITTER: RESET 50%</span>
            </div>
          </div>
        )}
          </>
          )}
      </div>
    </div>
  </div>
);
}
