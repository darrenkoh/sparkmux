import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

import { isTauriRuntime } from "./transport";
import { appShellHeight } from "./ios/posture";
import { pinchFontSize } from "./ios/touchKeys";
import { useDevicePosture } from "./ios/useDevicePosture";

import {
  agentBoard,
  attachTargetName,
  clipboardWrite,
  webServeToggle,
  webServeStatus,
  type WebServeStatus,
  appTelemetry,
  llmUsage,
  paneWrite,
  pasteIntoPane,
  controlConnect,
  ensureReady,
  focusPane,
  killSession,
  killWindow,
  listenControlExit,
  listenLayoutChange,
  listenMenu,
  listenServerStopped,
  listenTreeDirty,
  newSession,
  newWindow,
  openPopoutWindow,
  parseLayout,
  selectWindow,
  rememberSession,
  renameSession,
  renameWindow,
  snapshot as fetchSnapshot,
  splitPane,
  stopServer,
  syncActiveTarget,
  tmuxStatus,
  windowResize,
  type ActiveTarget,
} from "./api";
import type { AgentBoardRow } from "./chrome/agentBoard";
import {
  postAttentionNotification,
  trackAttention,
  type NoteLabel,
} from "./chrome/attentionNotify";
import ArtifactPanel from "./chrome/ArtifactPanel";
import AnalyticsHud from "./chrome/AnalyticsHud";
import ChangeGraph from "./chrome/ChangeGraph";
import DockedStatsPanel from "./chrome/DockedStatsPanel";
import {
  DockWidthSplitter,
  DockHeightSplitter,
  DOCK_MIN_WIDTH,
  DOCK_DEFAULT_WIDTH,
} from "./chrome/DockSplitters";
import { outputPaneForTab } from "./chrome/artifactModel";
import { allowanceWatchKey, parseAgyUsageScreen } from "./chrome/llmUsage";
import { ACTIVE_TARGET_STORAGE_KEY } from "./chrome/popoutModel";
import ErrorPanel from "./chrome/ErrorPanel";
import RecipesDialog from "./chrome/RecipesDialog";
import Splitter, {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from "./chrome/Splitter";
import StatusBar from "./chrome/StatusBar";
import { formatCpu, formatMemory } from "./chrome/telemetry";
import WindowTabs from "./chrome/WindowTabs";
import Modal from "./dialogs/Modal";
import Sidebar from "./sidebar/Sidebar";
import UpdateNotice from "./update/UpdateNotice";
import { useUpdateNotice } from "./update/useUpdateNotice";
import {
  charBeforeCursor,
  clientPointFromDrop,
  insertDroppedPaths,
  paneIdFromHit,
} from "./terminal/fileDrop";
import TiledWindow, {
  clientSizeFromFits,
  fallbackLayout,
  paneInputModes,
} from "./terminal/TiledWindow";
import { canInsertRecipe } from "./terminal/recipes";
import { getTerm } from "./terminal/XtermView";
import type {
  GuiError,
  LayoutNode,
  Selection,
  Snapshot,
  TmuxStatus,
  Window as TmuxWindow,
  AppTelemetry,
  LlmUsage,
} from "./types";

type Dialog =
  | { kind: "new-session" }
  | { kind: "new-window" }
  | { kind: "rename"; value: string }
  | { kind: "close-tab"; id: string; name: string; last: boolean; session: string }
  | { kind: "close-session"; name: string; tabs: number }
  | { kind: "stop"; socket: string; count: number }
  | { kind: "help" }
  | { kind: "recipes" }
  | {
      kind: "web-serve";
      running: boolean;
      links: { url: string; modules: string }[];
      selected: string;
    };

function namedSession(name: string | null | undefined): string | null {
  const trimmed = name?.trim() ?? "";
  return trimmed ? trimmed : null;
}

/** Lines currently painted in the pane. Antigravity quota lives on this screen. */
function agyUsageFromTerminal(paneId: string, now: number): LlmUsage | null {
  const term = getTerm(paneId);
  if (!term) return null;
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buf.length; row += 1) {
    lines.push(buf.getLine(row)?.translateToString(true) ?? "");
  }
  return parseAgyUsageScreen(lines.join("\n"), now);
}

function QrMark({ modules }: { modules: string }) {
  const rows = modules.split("\n").filter((row) => row.length > 0);
  const size = rows[0]?.length ?? 0;
  if (size === 0 || rows.some((row) => row.length !== size)) return null;
  return (
    <div
      className="web-serve-qr-grid"
      style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}
      role="img"
      aria-label="QR code for the selected address"
    >
      {rows.map((row, y) =>
        Array.from(row, (cell, x) => (
          <span key={`${y}-${x}`} className={cell === "1" ? "on" : "off"} />
        )),
      )}
    </div>
  );
}

const FONT_MIN = 11;
const FONT_MAX = 22;
const FONT_DEFAULT = 13;

export default function App() {
  const [status, setStatus] = useState<TmuxStatus | null>(null);
  const [snap, setSnap] = useState<Snapshot>({ sessions: [] });
  const [agentRows, setAgentRows] = useState<AgentBoardRow[]>([]);
  const attentionLabels = useRef(new Map<string, NoteLabel>());
  const [error, setError] = useState<GuiError>(null);
  const [empty, setEmpty] = useState(false);
  const [attachedSession, setAttachedSession] = useState<string | null>(null);
  const [visibleWindowId, setVisibleWindowId] = useState<string | null>(null);
  const [layout, setLayout] = useState<LayoutNode | null>(null);
  const [focusedPane, setFocusedPane] = useState<string | null>(null);
  const [dropPane, setDropPane] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const updateNotice = useUpdateNotice();
  const [failMsg, setFailMsg] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [input, setInput] = useState("");
  const [telemetry, setTelemetry] = useState<AppTelemetry | null>(null);
  const [webStatus, setWebStatus] = useState<WebServeStatus | null>(null);
  const [allowance, setAllowance] = useState<LlmUsage | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const raw = Number(window.localStorage.getItem("sparkmux.sidebarWidth"));
    if (Number.isFinite(raw) && raw >= SIDEBAR_MIN && raw <= SIDEBAR_MAX) return raw;
    return SIDEBAR_DEFAULT;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem("sparkmux.sidebarCollapsed") === "1",
  );
  const [outputOpen, setOutputOpen] = useState(
    () => window.localStorage.getItem("sparkmux.artifactOpen") === "1",
  );
  const [statsDocked, setStatsDocked] = useState(
    () => window.localStorage.getItem("sparkmux.statsDocked") === "1",
  );
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [dockWidth, setDockWidth] = useState(() => {
    const raw = Number(window.localStorage.getItem("sparkmux.dockWidth"));
    if (Number.isFinite(raw) && raw >= DOCK_MIN_WIDTH && raw <= 960) return raw;
    return DOCK_DEFAULT_WIDTH;
  });
  const [dockSplitRatio, setDockSplitRatio] = useState(() => {
    const raw = Number(window.localStorage.getItem("sparkmux.dockSplitRatio"));
    if (Number.isFinite(raw) && raw >= 0.15 && raw <= 0.85) return raw;
    return 0.5;
  });
  const dockContainerRef = useRef<HTMLDivElement>(null);
  const [fontSize, setFontSize] = useState(() => {
    const raw = Number(window.localStorage.getItem("sparkmux.fontSize"));
    if (Number.isFinite(raw) && raw >= FONT_MIN && raw <= FONT_MAX) return raw;
    return FONT_DEFAULT;
  });
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const postureInfo = useDevicePosture();
  const [zoomedPaneId, setZoomedPaneId] = useState<string | null>(null);
  const [phoneTiled, setPhoneTiled] = useState(false);
  const [sidebarDrawer, setSidebarDrawer] = useState(false);
  const sidebarDisplay = sidebarCollapsed ? 0 : sidebarWidth;
  const cellRef = useRef({ w: 8, h: 16 });
  const paneFitRef = useRef(new Map<string, { cols: number; rows: number }>());
  const layoutRef = useRef<LayoutNode | null>(null);
  const sizeTimer = useRef<number | undefined>(undefined);
  layoutRef.current = layout;
  const attachedRef = useRef<string | null>(null);
  const visibleRef = useRef<string | null>(null);
  const focusedRef = useRef<string | null>(null);
  const snapRef = useRef<Snapshot>({ sessions: [] });
  const statusRef = useRef<TmuxStatus | null>(null);
  const errorRef = useRef<GuiError>(null);
  const chromeFocus = useRef<"sidebar" | "terminal">("terminal");
  const selectionRef = useRef<Selection | null>(null);

  const refreshTelemetry = useCallback(() => {
    void appTelemetry()
      .then((next) => setTelemetry(next))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshTelemetry();
    const id = window.setInterval(refreshTelemetry, 1000);
    return () => window.clearInterval(id);
  }, [refreshTelemetry]);

  const refreshWebStatus = useCallback(() => {
    void webServeStatus()
      .then((next) => setWebStatus(next))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshWebStatus();
    const id = window.setInterval(refreshWebStatus, 3000);
    return () => window.clearInterval(id);
  }, [refreshWebStatus]);

  useEffect(() => {
    attachedRef.current = attachedSession;
  }, [attachedSession]);
  useEffect(() => {
    visibleRef.current = visibleWindowId;
  }, [visibleWindowId]);
  useEffect(() => {
    focusedRef.current = focusedPane;
  }, [focusedPane]);
  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    errorRef.current = error;
  }, [error]);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);
  useEffect(() => {
    window.localStorage.setItem("sparkmux.sidebarWidth", String(Math.round(sidebarWidth)));
  }, [sidebarWidth]);
  useEffect(() => {
    window.localStorage.setItem("sparkmux.sidebarCollapsed", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);
  useEffect(() => {
    window.localStorage.setItem("sparkmux.fontSize", String(fontSize));
  }, [fontSize]);
  useEffect(() => {
    window.localStorage.setItem("sparkmux.artifactOpen", outputOpen ? "1" : "0");
  }, [outputOpen]);
  useEffect(() => {
    window.localStorage.setItem("sparkmux.statsDocked", statsDocked ? "1" : "0");
  }, [statsDocked]);
  useEffect(() => {
    window.localStorage.setItem("sparkmux.dockWidth", String(Math.round(dockWidth)));
  }, [dockWidth]);
  useEffect(() => {
    window.localStorage.setItem("sparkmux.dockSplitRatio", String(dockSplitRatio));
  }, [dockSplitRatio]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const onFileDropRef = useRef<(paneId: string, paths: readonly string[]) => void>(() => {});

  function focusTerminalPane(id: string) {
    chromeFocus.current = "terminal";
    setFocusedPane(id);
    const sess = snapRef.current.sessions.find((s) => s.name === attachedRef.current);
    const win = sess?.windows.find((w) => w.id === visibleRef.current);
    setSelection({
      kind: "pane",
      id,
      sessionName: attachedRef.current ?? "",
      windowId: win?.id ?? "",
    });
  }

  onFileDropRef.current = (paneId, paths) => {
    focusTerminalPane(paneId);
    void focusPane(paneId);
    const term = getTerm(paneId);
    if (!term) return;
    try {
      insertDroppedPaths(term, paths, charBeforeCursor(term.buffer.active));
    } catch (err) {
      showToast(String(err));
    }
  };

  const pixelClientSize = useCallback(() => {
    const cw = cellRef.current.w || 8.4;
    const ch = cellRef.current.h || 17;
    const pad = 16;
    const el = hostRef.current;
    const w =
      el && el.clientWidth > 40
        ? el.clientWidth
        : Math.max(240, window.innerWidth - sidebarDisplay - 18);
    const h =
      el && el.clientHeight > 40
        ? el.clientHeight
        : Math.max(120, window.innerHeight - 96);
    return {
      cols: Math.max(2, Math.floor(Math.max(0, w - pad) / cw)),
      rows: Math.max(1, Math.floor(Math.max(0, h - pad) / ch)),
    };
  }, [sidebarDisplay]);

  const hostSize = useCallback(() => {
    const node = layoutRef.current;
    if (node) {
      const fitted = clientSizeFromFits(node, paneFitRef.current);
      if (fitted) return fitted;
    }
    return pixelClientSize();
  }, [pixelClientSize]);

  const lastPushedSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  const pushClientSize = useCallback(() => {
    if (!isTauriRuntime() && (!status || !status.is_headless)) {
      return;
    }
    if (sizeTimer.current) window.clearTimeout(sizeTimer.current);
    sizeTimer.current = window.setTimeout(() => {
      if (!isTauriRuntime() && (!status || !status.is_headless)) {
        return;
      }
      if (typeof document !== "undefined" && !document.hasFocus() && lastPushedSizeRef.current !== null) {
        return;
      }
      const node = layoutRef.current;
      if (node && !clientSizeFromFits(node, paneFitRef.current)) {
        return;
      }
      const { cols, rows } = hostSize();
      if (
        lastPushedSizeRef.current &&
        lastPushedSizeRef.current.cols === cols &&
        lastPushedSizeRef.current.rows === rows
      ) {
        return;
      }
      lastPushedSizeRef.current = { cols, rows };
      void windowResize(cols, rows);
    }, 50);
  }, [hostSize, status]);

  const applyWindow = useCallback(
    async (win: TmuxWindow | undefined) => {
      paneFitRef.current.clear();
      setZoomedPaneId(null);
      setPhoneTiled(false);
      if (!win) {
        setVisibleWindowId(null);
        setLayout(null);
        return;
      }
      setVisibleWindowId(win.id);
      try {
        await selectWindow(win.id);
      } catch {
        /* window may already be active */
      }
      try {
        const node = await parseLayout(win.layout);
        setLayout(node);
      } catch {
        const first = win.panes[0]?.id;
        setLayout(first ? fallbackLayout(first) : null);
        showToast("could not parse window layout");
      }
      const pane = win.panes.find((p) => p.active) ?? win.panes[0];
      if (pane) {
        chromeFocus.current = "terminal";
        setFocusedPane(pane.id);
        void focusPane(pane.id);
        const existing = getTerm(pane.id);
        if (existing) {
          existing.scrollToBottom();
          existing.focus();
        }
      }
    },
    [showToast],
  );

  const connectTo = useCallback(
    async (session: string, preferredWindow?: string) => {
      const { cols, rows } = pixelClientSize();
      const curSess = snapRef.current.sessions.find((s) => s.name === session);
      const expectedWin =
        (preferredWindow
          ? curSess?.windows.find((w) => w.id === preferredWindow)
          : undefined) ??
        curSess?.windows.find((w) => w.active) ??
        curSess?.windows[0];
      if (expectedWin) {
        visibleRef.current = expectedWin.id;
      }
      await controlConnect(session, cols, rows);
      await rememberSession(session);
      setAttachedSession(session);
      setError(null);
      setFailMsg(null);
      setEmpty(false);
      const tree = await fetchSnapshot();
      setSnap(tree);
      const sess = tree.sessions.find((s) => s.name === session);
      const win =
        (preferredWindow
          ? sess?.windows.find((w) => w.id === preferredWindow)
          : undefined) ??
        sess?.windows.find((w) => w.active) ??
        sess?.windows[0];
      await applyWindow(win);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => pushClientSize());
      });
      const title = win ? `Sparkmux — ${session}:${win.name}` : `Sparkmux — ${session}`;
      if (isTauriRuntime()) {
        try {
          await getCurrentWindow().setTitle(title);
        } catch {
          /* ACL optional */
        }
      } else {
        document.title = title;
      }
    },
    [applyWindow, pixelClientSize, pushClientSize],
  );

  const boot = useCallback(async () => {
    setFailMsg(null);
    try {
      const st = await tmuxStatus();
      setStatus(st);
      if (st.error === "missing-tmux") {
        setError("missing-tmux");
        return;
      }
      if (st.error === "too-old") {
        setError("too-old");
        return;
      }
      const tree = await ensureReady();
      setSnap(tree);
      if (tree.sessions.length === 0) {
        setEmpty(true);
        setError(null);
        return;
      }
      const target = namedSession(
        (await attachTargetName()) ??
          st.last_session ??
          st.default_session ??
          tree.sessions.find((s) => namedSession(s.name))?.name,
      );
      if (!target) {
        setFailMsg('invalid tmux target: session name: ""');
        return;
      }
      await connectTo(target);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("missing-tmux")) setError("missing-tmux");
      else if (msg.includes("too-old")) setError("too-old");
      else setFailMsg(msg);
    }
  }, [connectTo]);

  useEffect(() => {
    void boot();
    // cold start only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshTree = useCallback(async () => {
    if (errorRef.current === "missing-tmux" || errorRef.current === "too-old") return;
    if (errorRef.current === "server-stopped") return;
    try {
      const tree = await fetchSnapshot();
      setSnap(tree);
      if (tree.sessions.length === 0) {
        setEmpty(true);
        setAttachedSession(null);
        setLayout(null);
        setVisibleWindowId(null);
        return;
      }
      setEmpty(false);
      const attached = attachedRef.current;
      const sess = tree.sessions.find((s) => s.name === attached);
      if (!sess) {
        const target = namedSession(
          (await attachTargetName()) ??
            tree.sessions.find((s) => namedSession(s.name))?.name,
        );
        if (!target) {
          setFailMsg('invalid tmux target: session name: ""');
          return;
        }
        await connectTo(target);
        return;
      }
      setFailMsg(null);
      const vis = visibleRef.current;
      const win = sess.windows.find((w) => w.id === vis) ?? sess.windows.find((w) => w.active) ?? sess.windows[0];
      if (win) {
        if (win.id !== vis) {
          await applyWindow(win);
        } else if (win.layout) {
          try {
            const node = await parseLayout(win.layout);
            if (JSON.stringify(node) !== JSON.stringify(layoutRef.current)) {
              setLayout(node);
            }
          } catch {
            /* layout parse error handled elsewhere */
          }
        }
      }
    } catch (e) {
      setFailMsg(String(e));
    }
  }, [applyWindow, connectTo]);

  useEffect(() => {
    if (error || empty) return;
    const id = window.setInterval(() => {
      void refreshTree();
    }, 1000);
    return () => window.clearInterval(id);
  }, [error, empty, refreshTree]);

  const onMenuRef = useRef<(id: string) => Promise<void>>(async () => {});
  const refreshTreeRef = useRef(refreshTree);
  const connectToRef = useRef(connectTo);
  refreshTreeRef.current = refreshTree;
  connectToRef.current = connectTo;

  useEffect(() => {
    const un: Array<Promise<() => void>> = [];
    un.push(
      listenLayoutChange((payload) => {
        if (payload.window_id === visibleRef.current) {
          setLayout(payload.layout);
        }
      }),
    );
    un.push(
      listenTreeDirty(() => {
        void refreshTreeRef.current();
      }),
    );
    un.push(
      listenControlExit(() => {
        void (async () => {
          try {
            const tree = await fetchSnapshot();
            setSnap(tree);
            if (tree.sessions.length === 0) {
              setEmpty(true);
              setAttachedSession(null);
              setLayout(null);
              setVisibleWindowId(null);
              return;
            }
            const target = (await attachTargetName()) ?? tree.sessions[0].name;
            await connectToRef.current(target);
          } catch {
            setError("control-dead");
          }
        })();
      }),
    );
    un.push(
      listenServerStopped(() => {
        setError("server-stopped");
        setAttachedSession(null);
        setLayout(null);
        setVisibleWindowId(null);
        setEmpty(false);
      }),
    );
    un.push(
      listenMenu((id) => {
        void onMenuRef.current(id);
      }),
    );
    return () => {
      un.forEach((p) => {
        void p.then((fn) => fn());
      });
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    if (!isTauriRuntime()) return;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          setDropPane(null);
          return;
        }
        const point = clientPointFromDrop(payload.position, {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
        });
        const paneId = paneIdFromHit(document.elementFromPoint(point.x, point.y));
        if (payload.type === "drop") {
          setDropPane(null);
          if (paneId) onFileDropRef.current(paneId, payload.paths);
          return;
        }
        setDropPane(paneId);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* The page is open outside the desktop shell. */
      });
    return () => {
      cancelled = true;
      unlisten?.();
      setDropPane(null);
    };
  }, []);

  useEffect(() => {
    const onWindowFocus = () => {
      pushClientSize();
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [pushClientSize]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let t: number | undefined;
    const ro = new ResizeObserver(() => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => pushClientSize(), 50);
    });
    ro.observe(host);
    pushClientSize();
    let pinchStart = 0;
    let pinchSize = fontSizeRef.current;
    const onTouchStart = (ev: TouchEvent) => {
      if (ev.touches.length === 2) {
        pinchStart = Math.hypot(
          ev.touches[0].clientX - ev.touches[1].clientX,
          ev.touches[0].clientY - ev.touches[1].clientY,
        );
        pinchSize = fontSizeRef.current;
      }
    };
    const onTouchMove = (ev: TouchEvent) => {
      if (ev.touches.length !== 2 || pinchStart < 10) return;
      ev.preventDefault();
      const dist = Math.hypot(
        ev.touches[0].clientX - ev.touches[1].clientX,
        ev.touches[0].clientY - ev.touches[1].clientY,
      );
      setFontSize(pinchFontSize(pinchSize, dist / pinchStart));
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      ro.disconnect();
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      if (t) window.clearTimeout(t);
    };
  }, [pushClientSize, attachedSession, visibleWindowId]);

  function currentPane(): string | null {
    if (chromeFocus.current === "terminal") return focusedRef.current;
    if (selectionRef.current?.kind === "pane") return selectionRef.current.id;
    return focusedRef.current;
  }

  async function onMenu(id: string) {
    try {
      switch (id) {
        case "new-session":
          setInput("");
          setDialog({ kind: "new-session" });
          break;
        case "new-window":
          await createNewTab();
          break;
        case "close-tab":
          requestCloseTab();
          break;
        case "zoom-in":
          setFontSize((n) => Math.min(FONT_MAX, n + 1));
          break;
        case "zoom-out":
          setFontSize((n) => Math.max(FONT_MIN, n - 1));
          break;
        case "zoom-reset":
          setFontSize(FONT_DEFAULT);
          break;
        case "split-right": {
          const pane = currentPane();
          if (pane) await splitPane(pane, false);
          else showToast("select a pane to split");
          break;
        }
        case "split-down": {
          const pane = currentPane();
          if (pane) await splitPane(pane, true);
          else showToast("select a pane to split");
          break;
        }
        case "start":
          if (errorRef.current === "server-stopped") await onStart();
          break;
        case "stop-server":
          setDialog({
            kind: "stop",
            socket: statusRef.current?.socket_path ?? `-L ${statusRef.current?.socket_name ?? "sparkmux"}`,
            count: snapRef.current.sessions.length,
          });
          break;
        case "copy":
          await doCopy();
          break;
        case "paste":
          await doPaste();
          break;
        case "help":
          setDialog({ kind: "help" });
          break;
        case "check-update": {
          showToast("Checking for updates…");
          const res = await updateNotice.checkManual();
          if (!res.found && !res.error) {
            showToast("Sparkmux is up to date.");
          }
          break;
        }
        case "web-serve":
          await toggleWebServer();
          break;
        case "web-serve-urls":
          await openWebServerDialog();
          break;
        default:
          break;
      }
    } catch (e) {
      showToast(String(e));
    }
  }
  onMenuRef.current = onMenu;

  async function openWebServerDialog() {
    try {
      const status = await webServeStatus();
      setWebStatus(status);
      setDialog({
        kind: "web-serve",
        running: status.running,
        links: status.links,
        selected: status.selected || status.links[0]?.url || "",
      });
    } catch (e) {
      showToast(String(e));
    }
  }

  async function toggleWebServer() {
    const status = await webServeToggle();
    setWebStatus(status);
    if (status.running) {
      setDialog({
        kind: "web-serve",
        running: true,
        links: status.links,
        selected: status.selected || status.links[0]?.url || "",
      });
      return;
    }
    setDialog({
      kind: "web-serve",
      running: false,
      links: [],
      selected: "",
    });
    showToast("Remote server stopped. Sessions stay up.");
  }

  async function doCopy() {
    const pane = focusedRef.current;
    if (!pane) return;
    const term = getTerm(pane);
    if (term?.hasSelection()) {
      await clipboardWrite(term.getSelection());
    }
  }

  async function doPaste() {
    const pane = focusedRef.current;
    if (!pane) return;
    const bracket = Boolean(getTerm(pane)?.modes?.bracketedPasteMode);
    await pasteIntoPane(pane, bracket);
  }

  async function onStart() {
    try {
      const tree = await ensureReady();
      setSnap(tree);
      setError(null);
      const st = await tmuxStatus();
      setStatus(st);
      const target =
        (await attachTargetName()) ??
        st.default_session ??
        tree.sessions[0]?.name;
      if (target) await connectTo(target);
    } catch (e) {
      showToast(String(e));
    }
  }

  async function submitNewSession() {
    const name = input.trim();
    if (!name) return;
    setDialog(null);
    try {
      await newSession(name);
      await connectTo(name);
    } catch (e) {
      showToast(String(e));
    }
  }

  async function submitNewWindow() {
    const name = input.trim() || "shell";
    setDialog(null);
    await createNewTab(name);
  }

  function renameTarget(
    sel: Selection | null = selectionRef.current,
  ):
    | { kind: "session"; name: string }
    | { kind: "window"; id: string; name: string }
    | null {
    if (sel?.kind === "session") return { kind: "session", name: sel.name };
    if (sel?.kind === "window") return { kind: "window", id: sel.id, name: sel.name };
    if (sel?.kind === "pane") {
      const sess = snapRef.current.sessions.find((s) => s.name === sel.sessionName);
      const win = sess?.windows.find((w) => w.id === sel.windowId);
      if (win) return { kind: "window", id: win.id, name: win.name };
    }
    if (attachedRef.current) {
      return { kind: "session", name: attachedRef.current };
    }
    return null;
  }

  function requestCloseTab(windowId?: string) {
    const id = windowId ?? visibleRef.current;
    if (!id) {
      showToast("no tab to close");
      return;
    }
    const session = attachedRef.current ?? "";
    const sess = snapRef.current.sessions.find((s) => s.name === session);
    const win = sess?.windows.find((w) => w.id === id);
    setDialog({
      kind: "close-tab",
      id,
      name: win?.name ?? id,
      last: (sess?.windows.length ?? 0) <= 1,
      session,
    });
  }

  function requestCloseSession(name: string) {
    const sess = snapRef.current.sessions.find((s) => s.name === name);
    setDialog({
      kind: "close-session",
      name,
      tabs: sess?.windows.length ?? 0,
    });
  }

  async function closeTab(windowId?: string) {
    const id = windowId ?? visibleRef.current;
    if (!id) {
      showToast("no tab to close");
      return;
    }
    const session = attachedRef.current;
    try {
      await killWindow(id);
      const tree = await fetchSnapshot();
      setSnap(tree);
      if (tree.sessions.length === 0) {
        setEmpty(true);
        setAttachedSession(null);
        setLayout(null);
        setVisibleWindowId(null);
        setSelection(null);
        return;
      }
      const sess = tree.sessions.find((s) => s.name === session);
      if (!sess) {
        await connectTo(tree.sessions[0].name);
        return;
      }
      const next =
        sess.windows.find((w) => w.active) ?? sess.windows[sess.windows.length - 1];
      if (next) {
        setSelection({
          kind: "window",
          id: next.id,
          name: next.name,
          sessionName: session ?? "",
        });
        await applyWindow(next);
      } else {
        setLayout(null);
        setVisibleWindowId(null);
      }
    } catch (e) {
      showToast(String(e));
    }
  }

  async function createNewTab(name = "shell") {
    const session = attachedRef.current;
    if (!session) {
      showToast("select a session first");
      return;
    }
    const before = new Set(
      snapRef.current.sessions.find((s) => s.name === session)?.windows.map((w) => w.id) ?? [],
    );
    try {
      await newWindow(session, name);
      const tree = await fetchSnapshot();
      setSnap(tree);
      const sess = tree.sessions.find((s) => s.name === session);
      const created =
        sess?.windows.find((w) => !before.has(w.id)) ??
        sess?.windows.find((w) => w.active) ??
        sess?.windows[sess.windows.length - 1];
      if (created) {
        setSelection({
          kind: "window",
          id: created.id,
          name: created.name,
          sessionName: session,
        });
        await applyWindow(created);
      }
    } catch (e) {
      showToast(String(e));
    }
  }

  async function submitRename() {
    const name = input.trim();
    const target = renameTarget();
    if (!name || !target) return;
    setDialog(null);
    try {
      if (target.kind === "session") {
        await renameSession(target.name, name);
        if (attachedRef.current === target.name) {
          setAttachedSession(name);
          await rememberSession(name);
        }
        setSelection({
          kind: "session",
          id: snapRef.current.sessions.find((s) => s.name === target.name)?.id ?? name,
          name,
        });
      } else {
        await renameWindow(target.id, name);
        setSelection({
          kind: "window",
          id: target.id,
          name,
          sessionName: attachedRef.current ?? "",
        });
      }
      await refreshTree();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function submitCloseSession(name: string) {
    setDialog(null);
    try {
      await killSession(name);
      const tree = await fetchSnapshot();
      setSnap(tree);
      if (tree.sessions.length === 0) {
        setEmpty(true);
        setAttachedSession(null);
        setLayout(null);
        setVisibleWindowId(null);
        setSelection(null);
        return;
      }
      if (attachedRef.current === name) {
        await connectTo(tree.sessions[0].name);
      }
    } catch (e) {
      showToast(String(e));
    }
  }

  async function renameTab(windowId: string, name: string) {
    try {
      await renameWindow(windowId, name);
      if (selectionRef.current?.kind === "window" && selectionRef.current.id === windowId) {
        setSelection({
          kind: "window",
          id: windowId,
          name,
          sessionName: attachedRef.current ?? "",
        });
      }
      await refreshTree();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function submitStop() {
    setDialog(null);
    try {
      await stopServer();
      setError("server-stopped");
      setSnap({ sessions: [] });
      setAttachedSession(null);
      setLayout(null);
    } catch (e) {
      showToast(String(e));
    }
  }

  const attached = snap.sessions.find((s) => s.name === attachedSession);
  const visibleWin = attached?.windows.find((w) => w.id === visibleWindowId);
  const winName = visibleWin?.name ?? null;
  const outputPane = outputPaneForTab(visibleWin, focusedPane);
  const usageCommand = outputPane?.command ?? "";
  const usageTitle = outputPane?.title ?? "";
  const usageCwd = outputPane?.path ?? "";
  const usagePid = outputPane?.pid ?? 0;
  const usagePaneId = outputPane?.id ?? "";
  const usageCommandRef = useRef(usageCommand);
  const usageTitleRef = useRef(usageTitle);
  const usageCwdRef = useRef(usageCwd);
  const usagePidRef = useRef(usagePid);
  const usagePaneRef = useRef(usagePaneId);
  const agyScreenRef = useRef<LlmUsage | null>(null);
  usageCommandRef.current = usageCommand;
  usageTitleRef.current = usageTitle;
  usageCwdRef.current = usageCwd;
  usagePidRef.current = usagePid;
  usagePaneRef.current = usagePaneId;
  const allowanceKey = allowanceWatchKey(usageCommand, usageTitle);

  useEffect(() => {
    if (!attachedSession) {
      setAllowance(null);
      return;
    }
    let cancel = false;
    let retryTimer: number | undefined;
    const load = () => {
      void llmUsage(
        usageCommandRef.current,
        usageTitleRef.current,
        usageCwdRef.current,
        usagePidRef.current,
      )
        .then((next) => {
          if (cancel) return;
          if (next.cli === "antigravity" && next.bars.length === 0) {
            const seen = agyUsageFromTerminal(usagePaneRef.current, Date.now());
            if (seen) agyScreenRef.current = seen;
            setAllowance(seen ?? agyScreenRef.current ?? next);
            if (!retryTimer) {
              retryTimer = window.setTimeout(() => {
                retryTimer = undefined;
                if (!cancel) load();
              }, 3_000);
            }
            return;
          }
          setAllowance(next);
        })
        .catch(() => {
          if (!cancel) setAllowance(null);
        });
    };
    load();
    const soon = window.setTimeout(load, 1_000);
    const id = window.setInterval(load, 15_000);
    return () => {
      cancel = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      window.clearTimeout(soon);
      window.clearInterval(id);
    };
  }, [attachedSession, allowanceKey, usagePaneId]);

  useEffect(() => {
    const panes = snap.sessions.flatMap((session) =>
      session.windows.flatMap((win) =>
        win.panes.map((pane) => ({
          session: session.name,
          window_id: win.id,
          window_name: win.name,
          pane_id: pane.id,
          command: pane.command,
          cwd: pane.path,
          title: pane.title,
          pid: pane.pid,
        })),
      ),
    );
    let cancel = false;
    void agentBoard(panes)
      .then((rows) => {
        if (!cancel) setAgentRows(rows);
      })
      .catch(() => {
        if (!cancel) setAgentRows([]);
      });
    return () => {
      cancel = true;
    };
  }, [snap]);

  useEffect(() => {
    const seen = attentionLabels.current;
    const liveIds = new Set<string>();
    for (const session of snap.sessions) {
      const onScreen = attachedSession === session.name;
      for (const win of session.windows) {
        liveIds.add(win.id);
        const hidden = !(onScreen && win.id === visibleWindowId);
        const previous = seen.get(win.id) ?? null;
        const step = trackAttention(previous, hidden, {
          active: win.active,
          attention_label: win.attention_label,
          unread: win.unread,
          pending_ask: win.pending_ask,
        });
        if (step.notify) {
          void postAttentionNotification({
            hidden: true,
            previous,
            next: step.label,
            body: win.pending_ask || `${session.name} ${win.name}`,
          });
        }
        if (step.label === null) seen.delete(win.id);
        else seen.set(win.id, step.label);
      }
    }
    for (const id of seen.keys()) {
      if (!liveIds.has(id)) seen.delete(id);
    }
  }, [snap, attachedSession, visibleWindowId]);
  const showTiles = !error && !empty && layout && attachedSession;
  const posture = postureInfo.posture;
  const drawerNav = posture === "phone-compact" || posture === "duo-book";
  const deck = posture === "duo-book" || posture === "duo-clamshell";
  const sheet =
    posture === "phone-compact" && (outputOpen || statsDocked || analyticsOpen || graphOpen);
  const visiblePanes = visibleWin?.panes ?? [];
  useEffect(() => {
    if (posture !== "phone-compact" || phoneTiled || visiblePanes.length < 2) return;
    if (zoomedPaneId) return;
    const id = focusedPane && visiblePanes.some((pane) => pane.id === focusedPane)
      ? focusedPane
      : visiblePanes[0]?.id;
    if (id) setZoomedPaneId(id);
  }, [posture, phoneTiled, visiblePanes, zoomedPaneId, focusedPane]);
  const isDockOpen = Boolean(showTiles) && (outputOpen || statsDocked);

  useEffect(() => {
    if (!attachedSession || !visibleWindowId) return;
    const target: ActiveTarget = {
      session_name: attachedSession,
      tab_id: visibleWindowId,
      tab_name: winName ?? "shell",
      focused_pane: usagePaneId || focusedPane || "",
      command: usageCommand,
      cwd: usageCwd,
      title: usageTitle,
      pid: usagePid,
    };
    try {
      window.localStorage.setItem(ACTIVE_TARGET_STORAGE_KEY, JSON.stringify(target));
    } catch {}
    void syncActiveTarget(target).catch(() => {});
  }, [
    attachedSession,
    visibleWindowId,
    winName,
    usagePaneId,
    focusedPane,
    usageCommand,
    usageCwd,
    usageTitle,
    usagePid,
  ]);

  const popOutStats = useCallback(() => {
    const target: ActiveTarget = {
      session_name: attachedSession ?? "sparkmux",
      tab_id: visibleWindowId ?? "main",
      tab_name: winName ?? "shell",
      focused_pane: usagePaneId || focusedPane || "",
      command: usageCommand,
      cwd: usageCwd,
      title: usageTitle,
      pid: usagePid,
    };
    try {
      window.localStorage.setItem(ACTIVE_TARGET_STORAGE_KEY, JSON.stringify(target));
    } catch {}
    setAnalyticsOpen(false);
    setStatsDocked(false);
    void openPopoutWindow("stats", target).catch((e) => showToast(String(e)));
  }, [
    attachedSession,
    visibleWindowId,
    winName,
    usagePaneId,
    focusedPane,
    usageCommand,
    usageCwd,
    usageTitle,
    usagePid,
    showToast,
  ]);

  const popOutGits = useCallback(() => {
    const target: ActiveTarget = {
      session_name: attachedSession ?? "sparkmux",
      tab_id: visibleWindowId ?? "main",
      tab_name: winName ?? "shell",
      focused_pane: usagePaneId || focusedPane || "",
      command: usageCommand,
      cwd: usageCwd,
      title: usageTitle,
      pid: usagePid,
    };
    try {
      window.localStorage.setItem(ACTIVE_TARGET_STORAGE_KEY, JSON.stringify(target));
    } catch {}
    setGraphOpen(false);
    void openPopoutWindow("gits", target).catch((e) => showToast(String(e)));
  }, [
    attachedSession,
    visibleWindowId,
    winName,
    usagePaneId,
    focusedPane,
    usageCommand,
    usageCwd,
    usageTitle,
    usagePid,
    showToast,
  ]);

  async function insertRecipe(text: string) {
    const pane = outputPane;
    if (!pane || !canInsertRecipe(pane.command, pane.alternate)) return;
    try {
      await paneWrite(pane.id, Array.from(new TextEncoder().encode(text)));
      setDialog(null);
      showToast("Inserted. Press Enter to run it.");
      getTerm(pane.id)?.focus();
    } catch (err) {
      showToast(String(err));
    }
  }

  async function copyRecipe(text: string) {
    try {
      await clipboardWrite(text);
      setDialog(null);
      showToast("Copied.");
    } catch (err) {
      showToast(String(err));
    }
  }

  const renderTabs = () => (
    <WindowTabs
      windows={attached?.windows ?? []}
      visibleWindowId={visibleWindowId}
      onSelect={(windowId) => {
        const win = attached?.windows.find((w) => w.id === windowId);
        if (win) {
          setSelection({
            kind: "window",
            id: win.id,
            name: win.name,
            sessionName: attachedSession ?? "",
          });
          void applyWindow(win);
        }
      }}
      onNewTab={() => {
        void createNewTab();
      }}
      onCloseTab={(windowId) => requestCloseTab(windowId)}
      onRenameTab={(windowId, name) => {
        void renameTab(windowId, name);
      }}
    />
  );

  return (
    <div
      className={`app posture-${posture}${sidebarDrawer ? " sidebar-drawer-open" : ""}${postureInfo.keyboardInsetBottom > 0 ? " keyboard-open" : ""}`}
      style={{
        height: appShellHeight(postureInfo),
        ["--duo-left" as string]: postureInfo.leftSegmentWidth
          ? `${postureInfo.leftSegmentWidth}px`
          : undefined,
        ["--duo-top" as string]: postureInfo.topSegmentHeight
          ? `${postureInfo.topSegmentHeight}px`
          : undefined,
      }}
    >
      <div className="body">
        <div
          className={`sidebar-slot ${drawerNav ? (sidebarDrawer ? "drawer-open" : "drawer-shut") : sidebarCollapsed ? "collapsed" : ""}`}
          style={drawerNav ? undefined : { width: sidebarDisplay, flexBasis: sidebarDisplay }}
          onMouseDown={() => {
            chromeFocus.current = "sidebar";
          }}
        >
          <Sidebar
            snapshot={snap}
            attachedSession={attachedSession}
            visibleWindowId={visibleWindowId}
            focusedPane={focusedPane}
            selection={selection}
            onNewSession={() => {
              setInput("");
              setDialog({ kind: "new-session" });
            }}
            onSelectSession={(name) => {
              chromeFocus.current = "sidebar";
              setSelection({
                kind: "session",
                id: snap.sessions.find((s) => s.name === name)?.id ?? name,
                name,
              });
              void connectTo(name);
            }}
            onSelectWindow={(sessionName, windowId) => {
              chromeFocus.current = "sidebar";
              const sess = snap.sessions.find((s) => s.name === sessionName);
              const win = sess?.windows.find((w) => w.id === windowId);
              setSelection({
                kind: "window",
                id: windowId,
                name: win?.name ?? windowId,
                sessionName,
              });
              void (async () => {
                if (attachedRef.current !== sessionName) {
                  await connectTo(sessionName, windowId);
                } else {
                  await applyWindow(win);
                }
              })();
            }}
            onSelectPane={(sessionName, windowId, paneId) => {
              chromeFocus.current = "sidebar";
              setSelection({ kind: "pane", id: paneId, sessionName, windowId });
              setFocusedPane(paneId);
              void (async () => {
                if (attachedRef.current !== sessionName) {
                  await connectTo(sessionName, windowId);
                } else if (visibleRef.current !== windowId) {
                  const sess = snapRef.current.sessions.find((s) => s.name === sessionName);
                  await applyWindow(sess?.windows.find((w) => w.id === windowId));
                }
                void focusPane(paneId);
                getTerm(paneId)?.focus();
              })();
            }}
            onCollapse={() => setSidebarCollapsed(true)}
            agentRows={agentRows}
            onSelectAgent={(sessionName, windowId, paneId) => {
              chromeFocus.current = "sidebar";
              setSelection({ kind: "pane", id: paneId, sessionName, windowId });
              setFocusedPane(paneId);
              void (async () => {
                if (attachedRef.current !== sessionName) {
                  await connectTo(sessionName, windowId);
                } else if (visibleRef.current !== windowId) {
                  const sess = snapRef.current.sessions.find((s) => s.name === sessionName);
                  await applyWindow(sess?.windows.find((w) => w.id === windowId));
                }
                void focusPane(paneId);
                getTerm(paneId)?.focus();
              })();
            }}
            onRenameSession={(name) => {
              setSelection({
                kind: "session",
                id: snap.sessions.find((s) => s.name === name)?.id ?? name,
                name,
              });
              setInput(name);
              setDialog({ kind: "rename", value: name });
            }}
            onCloseSession={(name) => requestCloseSession(name)}
          />
        </div>
        <Splitter
          width={sidebarWidth}
          collapsed={sidebarCollapsed}
          onWidth={setSidebarWidth}
          onCollapsed={setSidebarCollapsed}
        />
        <main
          className="main"
          onMouseDown={() => {
            chromeFocus.current = "terminal";
          }}
        >
          {error || empty ? (
            <ErrorPanel
              error={error ?? null}
              status={status}
              onRetry={() => void boot()}
              onStart={() => void onStart()}
              onNewSession={() => {
                setInput("");
                setDialog({ kind: "new-session" });
              }}
            />
          ) : showTiles ? (
            <>
              {!deck && renderTabs()}
              <div className="term-stage">
                <div className="term-column">
                  {deck && renderTabs()}
                  {drawerNav && (
                    <button
                      type="button"
                      className="sidebar-drawer-btn"
                      onClick={() => setSidebarDrawer((open) => !open)}
                    >
                      Sessions
                    </button>
                  )}
                  {posture === "phone-compact" && visiblePanes.length > 1 && (
                    <div className="pane-pills" role="tablist" aria-label="Panes">
                      {visiblePanes.map((pane) => (
                        <button
                          key={pane.id}
                          type="button"
                          className={zoomedPaneId === pane.id ? "active" : ""}
                          onClick={() => {
                            setPhoneTiled(false);
                            setZoomedPaneId(pane.id);
                          }}
                        >
                          {pane.id} {pane.command}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => {
                          setPhoneTiled((tiled) => !tiled);
                          setZoomedPaneId((current) => (current ? null : focusedPane ?? visiblePanes[0]?.id ?? null));
                        }}
                      >
                        {phoneTiled || !zoomedPaneId ? "Zoom" : "Tile"}
                      </button>
                    </div>
                  )}
                <div className="term-viewport" ref={hostRef}>
                  <TiledWindow
                    node={layout}
                    focusedPane={focusedPane}
                    zoomedPaneId={zoomedPaneId}
                    onToggleZoomPane={(paneId) => {
                      setPhoneTiled(false);
                      setZoomedPaneId((current) => (current === paneId ? null : paneId));
                    }}
                    dropTarget={dropPane}
                    fontSize={fontSize}
                    paneModes={paneInputModes(snap)}
                    onFocus={focusTerminalPane}
                    fixedSize={!isTauriRuntime() && (!status || !status.is_headless)}
                    onCellSize={(paneId, w, h, cols, rows) => {
                      if (w > 0 && h > 0) {
                        cellRef.current = { w, h };
                        if (cols >= 2 && rows >= 1) {
                          paneFitRef.current.set(paneId, { cols, rows });
                        }
                      }
                    }}
                  />
                </div>
                </div>
                {posture === "duo-book" && (
                  <div
                    className="duo-hinge-spacer"
                    style={{ width: Math.max(8, postureInfo.hingeRect?.width ?? 12) }}
                    aria-hidden="true"
                  />
                )}
                <div className={deck ? "companion-deck" : sheet ? "companion-sheet" : "stage-extras"}>
                {deck && (
                  <div className="companion-switch" role="tablist" aria-label="Companion deck">
                    <button
                      type="button"
                      onClick={() => {
                        setGraphOpen(false);
                        setAnalyticsOpen(true);
                      }}
                    >
                      3D map
                    </button>
                    <button type="button" onClick={() => setOutputOpen(true)}>
                      Output
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAnalyticsOpen(false);
                        setGraphOpen(true);
                      }}
                    >
                      Gits
                    </button>
                  </div>
                )}
                {isDockOpen && (
                  <>
                    <DockWidthSplitter
                      width={dockWidth}
                      onWidth={setDockWidth}
                    />
                    <aside
                      className="docked-panel-container"
                      style={{ width: dockWidth }}
                      ref={dockContainerRef}
                    >
                      {/* Both Output panel and Stat panel open: vertically split with adjustable height */}
                      {outputOpen && statsDocked && (
                        <>
                          <div
                            className="docked-panel-slot"
                            style={{ height: `${dockSplitRatio * 100}%` }}
                          >
                            <ArtifactPanel
                              key={outputPane?.id ?? "none"}
                              command={outputPane?.command ?? ""}
                              cwd={outputPane?.path ?? ""}
                              title={outputPane?.title ?? ""}
                              pid={outputPane?.pid ?? 0}
                              onCollapse={() => setOutputOpen(false)}
                              onOpenAnalytics={() => {
                                setGraphOpen(false);
                                setAnalyticsOpen(true);
                              }}
                              onOpenGraph={() => {
                                setAnalyticsOpen(false);
                                setGraphOpen(true);
                              }}
                              isDocked
                            />
                          </div>

                          <DockHeightSplitter
                            containerRef={dockContainerRef}
                            ratio={dockSplitRatio}
                            onRatio={setDockSplitRatio}
                          />

                          <div
                            className="docked-panel-slot docked-stat-slot"
                            style={{ height: `calc(${100 - dockSplitRatio * 100}% - 5px)` }}
                          >
                            <DockedStatsPanel
                              sessionName={attachedSession ?? "sparkmux"}
                              tabId={visibleWindowId ?? "main"}
                              tabName={winName ?? "shell"}
                              command={outputPane?.command ?? ""}
                              cwd={outputPane?.path ?? ""}
                              title={outputPane?.title ?? ""}
                              pid={outputPane?.pid ?? 0}
                              paused={analyticsOpen}
                              onExpand={() => setAnalyticsOpen(true)}
                              onPopOut={popOutStats}
                              onClose={() => setStatsDocked(false)}
                            />
                          </div>
                        </>
                      )}

                      {/* Only Output panel open: takes full height of the dock */}
                      {outputOpen && !statsDocked && (
                        <div className="docked-panel-slot" style={{ height: "100%" }}>
                          <ArtifactPanel
                            key={outputPane?.id ?? "none"}
                            command={outputPane?.command ?? ""}
                            cwd={outputPane?.path ?? ""}
                            title={outputPane?.title ?? ""}
                            pid={outputPane?.pid ?? 0}
                            onCollapse={() => setOutputOpen(false)}
                            onOpenAnalytics={() => {
                              setGraphOpen(false);
                              setAnalyticsOpen(true);
                            }}
                            onOpenGraph={() => {
                              setAnalyticsOpen(false);
                              setGraphOpen(true);
                            }}
                            isDocked
                          />
                        </div>
                      )}

                      {/* Only Stat panel is docked: docked to bottom right panel with adjustable height */}
                      {!outputOpen && statsDocked && (
                        <>
                          <div
                            className="docked-collapsed-output"
                            style={{ height: `${dockSplitRatio * 100}%` }}
                          >
                            <div className="docked-collapsed-inner">
                              <span>YOUR PROMPTS COLLAPSED</span>
                              <button
                                type="button"
                                className="docked-open-output-btn"
                                onClick={() => setOutputOpen(true)}
                              >
                                + OPEN PROMPTS
                              </button>
                            </div>
                          </div>

                          <DockHeightSplitter
                            containerRef={dockContainerRef}
                            ratio={dockSplitRatio}
                            onRatio={setDockSplitRatio}
                          />

                          <div
                            className="docked-panel-slot docked-stat-slot"
                            style={{ height: `calc(${100 - dockSplitRatio * 100}% - 5px)` }}
                          >
                            <DockedStatsPanel
                              sessionName={attachedSession ?? "sparkmux"}
                              tabId={visibleWindowId ?? "main"}
                              tabName={winName ?? "shell"}
                              command={outputPane?.command ?? ""}
                              cwd={outputPane?.path ?? ""}
                              title={outputPane?.title ?? ""}
                              pid={outputPane?.pid ?? 0}
                              paused={analyticsOpen}
                              onExpand={() => setAnalyticsOpen(true)}
                              onPopOut={popOutStats}
                              onClose={() => setStatsDocked(false)}
                            />
                          </div>
                        </>
                      )}
                    </aside>
                  </>
                )}

                {analyticsOpen && (
                  <AnalyticsHud
                    sessionName={attachedSession ?? "sparkmux"}
                    tabId={visibleWindowId ?? "main"}
                    tabName={winName ?? "shell"}
                    command={outputPane?.command ?? ""}
                    cwd={outputPane?.path ?? ""}
                    title={outputPane?.title ?? ""}
                    pid={outputPane?.pid ?? 0}
                    onClose={() => setAnalyticsOpen(false)}
                    onDock={() => {
                      setAnalyticsOpen(false);
                      setStatsDocked(true);
                    }}
                    onPopOut={popOutStats}
                  />
                )}
                {graphOpen && (
                  <ChangeGraph
                    sessionName={attachedSession ?? "sparkmux"}
                    tabId={visibleWindowId ?? "main"}
                    tabName={winName ?? "shell"}
                    command={outputPane?.command ?? ""}
                    cwd={outputPane?.path ?? ""}
                    title={outputPane?.title ?? ""}
                    pid={outputPane?.pid ?? 0}
                    onClose={() => setGraphOpen(false)}
                    onPopOut={popOutGits}
                  />
                )}
                </div>
              </div>
            </>
          ) : failMsg ? (
            <div className="panel">
              <h1>Could not open the session</h1>
              <p>{failMsg}</p>
              <button onClick={() => void boot()}>Retry</button>
            </div>
          ) : (
            <div className="panel">
              <p>Connecting…</p>
            </div>
          )}
        </main>
      </div>
      <StatusBar
        status={status}
        session={attachedSession}
        windowName={winName}
        telemetry={telemetry}
        usage={allowance}
        outputOpen={outputOpen && Boolean(showTiles)}
        analyticsOpen={analyticsOpen || statsDocked}
        onOutput={() => setOutputOpen((open) => !open)}
        graphOpen={graphOpen}
        onAnalytics={() => {
          setGraphOpen(false);
          setAnalyticsOpen((open) => !open);
        }}
        onGraph={() => {
          setAnalyticsOpen(false);
          setGraphOpen((open) => !open);
        }}
        onRecipes={() => setDialog({ kind: "recipes" })}
        webRunning={webStatus?.running ?? false}
        webModalOpen={dialog?.kind === "web-serve"}
        onWebServe={() => {
          if (dialog?.kind === "web-serve") {
            setDialog(null);
          } else {
            void openWebServerDialog();
          }
        }}
      />
      <UpdateNotice
        phase={updateNotice.phase}
        onUpdate={updateNotice.start}
        onDismiss={updateNotice.dismiss}
      />
      {toast && <div className="toast">{toast}</div>}
      {dialog?.kind === "new-session" && (
        <Modal title="New Session" onClose={() => setDialog(null)}>
          <p>Creates a session on the sparkmux socket. Does not run Start.</p>
          <input
            autoFocus
            value={input}
            placeholder="session name"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitNewSession();
              if (e.key === "Escape") setDialog(null);
            }}
          />
          <div className="modal-actions">
            <button onClick={() => setDialog(null)}>Cancel</button>
            <button className="primary" onClick={() => void submitNewSession()}>
              Create
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "new-window" && (
        <Modal title="New Window" onClose={() => setDialog(null)}>
          <input
            autoFocus
            value={input}
            placeholder="window name"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitNewWindow();
              if (e.key === "Escape") setDialog(null);
            }}
          />
          <div className="modal-actions">
            <button onClick={() => setDialog(null)}>Cancel</button>
            <button className="primary" onClick={() => void submitNewWindow()}>
              Create
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "rename" && (
        <Modal title="Rename" onClose={() => setDialog(null)}>
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitRename();
              if (e.key === "Escape") setDialog(null);
            }}
          />
          <div className="modal-actions">
            <button onClick={() => setDialog(null)}>Cancel</button>
            <button className="primary" onClick={() => void submitRename()}>
              Rename
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "close-tab" && (
        <Modal title="Close tab" onClose={() => setDialog(null)}>
          <p>
            Close tab <strong>{dialog.name}</strong>
            {dialog.last
              ? `? This is the last tab, so session ${dialog.session || "this session"} will end.`
              : "?"}
          </p>
          <div className="modal-actions">
            <button onClick={() => setDialog(null)}>Cancel</button>
            <button
              className="danger"
              onClick={() => {
                const id = dialog.id;
                setDialog(null);
                void closeTab(id);
              }}
            >
              Close tab
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "close-session" && (
        <Modal title="Close session" onClose={() => setDialog(null)}>
          <p>
            Close session <strong>{dialog.name}</strong>? This ends{" "}
            {dialog.tabs} tab{dialog.tabs === 1 ? "" : "s"} and all panes in it.
          </p>
          <div className="modal-actions">
            <button onClick={() => setDialog(null)}>Cancel</button>
            <button
              className="danger"
              onClick={() => void submitCloseSession(dialog.name)}
            >
              Close session
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "stop" && (
        <Modal title="Stop tmux server" onClose={() => setDialog(null)}>
          <p>
            Stop the sparkmux tmux server at <code>{dialog.socket}</code>? This
            will destroy {dialog.count} session{dialog.count === 1 ? "" : "s"}.
          </p>
          <p>Quit only detaches; this kills the server.</p>
          <div className="modal-actions">
            <button onClick={() => setDialog(null)}>Cancel</button>
            <button className="danger" onClick={() => void submitStop()}>
              Stop server
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "help" && (
        <Modal title="Sparkmux" onClose={() => setDialog(null)}>
          <p>
            Desktop {status?.app_version ?? "0.1.0"} · {status?.version ?? "tmux unknown"}
          </p>
          <dl className="help-keys">
            <dt>Memory</dt>
            <dd>
              {telemetry && telemetry.memory_bytes > 0
                ? `${formatMemory(telemetry.memory_bytes)} of Sparkmux`
                : "—"}
            </dd>
            <dt>CPU</dt>
            <dd>
              {telemetry && telemetry.cpu_percent != null
                ? `${formatCpu(telemetry.cpu_percent)} of Sparkmux`
                : "—"}
            </dd>
          </dl>
          <p>
            This window owns a <strong>private</strong> tmux server (
            <code>-L {status?.socket_name ?? "sparkmux"}</code>
            ). Your default tmux sessions are never listed or changed. Quit
            detaches; the server stays up.
          </p>
          <p>
            Attach from a real terminal:{" "}
            <code>tmux -L {status?.socket_name ?? "sparkmux"} attach</code>
          </p>
          <dl className="help-keys">
            <dt>New session</dt>
            <dd>⌘N / sidebar +</dd>
            <dt>New tab</dt>
            <dd>⌘T / tab bar +</dd>
            <dt>Rename tab</dt>
            <dd>Double-click the tab name</dd>
            <dt>Close tab</dt>
            <dd>⌘W / tab × (asks first)</dd>
            <dt>Copy / paste</dt>
            <dd>⌘C ⌘V / Ctrl+Shift+V</dd>
            <dt>Drop a file</dt>
            <dd>Pastes its path into the prompt</dd>
            <dt>?</dt>
            <dd>Frequently Used Command. Inserts a folder, find, grep, or git command. You press Enter</dd>
            <dt>Output</dt>
            <dd>Status bar. Follows the latest Grok, Claude, or Antigravity reply. Auto scroll can be turned off</dd>
            <dt>Split</dt>
            <dd>⌘D and ⇧⌘D (macOS)</dd>
            <dt>Text size</dt>
            <dd>⌘+ ⌘- ⌘0 / Ctrl+ ± 0</dd>
            <dt>Quit</dt>
            <dd>⌘Q — detaches only</dd>
            <dt>Remote Server</dt>
            <dd>Status bar "Remote", Sparkmux menu, or File on Linux</dd>
          </dl>
          <p className="hint">
            Prefix keys are not emulated here; they still work in a real attach.
            macOS builds are unsigned: right-click Sparkmux.app → Open the first
            time.
          </p>
          <div className="modal-actions">
            <button className="primary" onClick={() => setDialog(null)}>
              Close
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "web-serve" && (
        <Modal
          title="Remote Server"
          className="web-serve-modal"
          onClose={() => setDialog(null)}
        >
          {dialog.running ? (
            <>
              <div className="web-serve-status-badge running">
                <span className="status-remote-dot active" /> Online · Port 7420
              </div>
              {(() => {
                const link =
                  dialog.links.find((item) => item.url === dialog.selected) ?? dialog.links[0];
                if (!link) return null;
                const local = link.url.includes("127.0.0.1");
                return (
                  <div className="web-serve-qr">
                    <QrMark modules={link.modules} />
                    <p>
                      {local
                        ? "This code only opens on this computer."
                        : "Scan the selected address with the iPhone camera."}
                    </p>
                  </div>
                );
              })()}
              <p>Select an address. 127.0.0.1 is this computer. In Safari, use Share, then Add to Home Screen.</p>
              {dialog.links.map((link) => (
                <div
                  key={link.url}
                  className={link.url === dialog.selected ? "web-serve-url selected" : "web-serve-url"}
                >
                  <button
                    type="button"
                    className="web-serve-pick"
                    aria-pressed={link.url === dialog.selected}
                    onClick={() =>
                      setDialog((current) =>
                        current?.kind === "web-serve" ? { ...current, selected: link.url } : current,
                      )
                    }
                  >
                    <code>{link.url}</code>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void clipboardWrite(link.url)
                        .then(() => showToast("Copied."))
                        .catch((err) => showToast(String(err)))
                    }
                  >
                    Copy
                  </button>
                </div>
              ))}
              <p className="hint">Stopping this server leaves your tmux sessions running.</p>
              <div className="modal-actions">
                <button
                  className="danger"
                  onClick={() => void toggleWebServer().catch((err) => showToast(String(err)))}
                >
                  Stop Remote Server
                </button>
                <button className="primary" onClick={() => setDialog(null)}>
                  Close
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="web-serve-status-badge stopped">
                <span className="status-remote-dot" /> Offline
              </div>
              <div className="web-serve-offline-box">
                <p className="web-serve-offline-desc">
                  Start the remote server to view pairing URLs and QR code. You can mirror and control your tmux sessions securely from an iPhone, iPad, or another browser on your local network.
                </p>
              </div>
              <div className="modal-actions">
                <button
                  className="primary"
                  onClick={() => void toggleWebServer().catch((err) => showToast(String(err)))}
                >
                  Start Remote Server
                </button>
                <button onClick={() => setDialog(null)}>
                  Close
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {dialog?.kind === "recipes" && (
        <RecipesDialog
          folder={outputPane?.path ?? ""}
          command={outputPane?.command ?? ""}
          alternate={outputPane?.alternate ?? true}
          onInsert={(text) => void insertRecipe(text)}
          onCopy={(text) => void copyRecipe(text)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
