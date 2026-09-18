import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  attachTargetName,
  controlConnect,
  ensureReady,
  focusPane,
  killPane,
  killSession,
  killWindow,
  listenControlExit,
  listenLayoutChange,
  listenMenu,
  listenServerStopped,
  listenTreeDirty,
  newSession,
  newWindow,
  parseLayout,
  selectWindow,
  paneWrite,
  rememberSession,
  renameSession,
  renameWindow,
  snapshot as fetchSnapshot,
  splitPane,
  stopServer,
  tmuxStatus,
  windowResize,
} from "./api";
import ErrorPanel from "./chrome/ErrorPanel";
import Splitter, {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from "./chrome/Splitter";
import StatusBar from "./chrome/StatusBar";
import WindowTabs from "./chrome/WindowTabs";
import Modal from "./dialogs/Modal";
import Sidebar from "./sidebar/Sidebar";
import TiledWindow, { fallbackLayout } from "./terminal/TiledWindow";
import { getTerm } from "./terminal/XtermView";
import type {
  GuiError,
  LayoutNode,
  Selection,
  Snapshot,
  TmuxStatus,
  Window as TmuxWindow,
} from "./types";

type Dialog =
  | { kind: "new-session" }
  | { kind: "new-window" }
  | { kind: "rename"; value: string }
  | { kind: "kill"; message: string }
  | { kind: "stop"; socket: string; count: number }
  | { kind: "help" };

export default function App() {
  const [status, setStatus] = useState<TmuxStatus | null>(null);
  const [snap, setSnap] = useState<Snapshot>({ sessions: [] });
  const [error, setError] = useState<GuiError>(null);
  const [empty, setEmpty] = useState(false);
  const [attachedSession, setAttachedSession] = useState<string | null>(null);
  const [visibleWindowId, setVisibleWindowId] = useState<string | null>(null);
  const [layout, setLayout] = useState<LayoutNode | null>(null);
  const [focusedPane, setFocusedPane] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [input, setInput] = useState("");
  const hostRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const raw = Number(window.localStorage.getItem("sparkmux.sidebarWidth"));
    if (Number.isFinite(raw) && raw >= SIDEBAR_MIN && raw <= SIDEBAR_MAX) return raw;
    return SIDEBAR_DEFAULT;
  });
  const cellRef = useRef({ w: 8, h: 16 });
  const attachedRef = useRef<string | null>(null);
  const visibleRef = useRef<string | null>(null);
  const focusedRef = useRef<string | null>(null);
  const snapRef = useRef<Snapshot>({ sessions: [] });
  const statusRef = useRef<TmuxStatus | null>(null);
  const errorRef = useRef<GuiError>(null);
  const chromeFocus = useRef<"sidebar" | "terminal">("terminal");
  const selectionRef = useRef<Selection | null>(null);

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

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const hostSize = useCallback(() => {
    const cw = cellRef.current.w || 8.4;
    const ch = cellRef.current.h || 17;
    const pad = 16;
    const el = hostRef.current;
    const w =
      el && el.clientWidth > 40
        ? el.clientWidth
        : Math.max(240, window.innerWidth - sidebarWidth - 5);
    const h =
      el && el.clientHeight > 40
        ? el.clientHeight
        : Math.max(120, window.innerHeight - 96);
    return {
      cols: Math.max(2, Math.floor(Math.max(0, w - pad) / cw)),
      rows: Math.max(1, Math.floor(Math.max(0, h - pad) / ch)),
    };
  }, [sidebarWidth]);

  const pushClientSize = useCallback(() => {
    const { cols, rows } = hostSize();
    void windowResize(cols, rows);
  }, [hostSize]);

  const applyWindow = useCallback(
    async (win: TmuxWindow | undefined) => {
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
        setFocusedPane(pane.id);
        void focusPane(pane.id);
      }
    },
    [showToast],
  );

  const connectTo = useCallback(
    async (session: string, preferredWindow?: string) => {
      const { cols, rows } = hostSize();
      await controlConnect(session, cols, rows);
      await rememberSession(session);
      setAttachedSession(session);
      setError(null);
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
      try {
        await getCurrentWindow().setTitle(title);
      } catch {
        /* ACL optional */
      }
    },
    [applyWindow, hostSize, pushClientSize],
  );

  const boot = useCallback(async () => {
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
      const target =
        (await attachTargetName()) ??
        st.last_session ??
        st.default_session ??
        tree.sessions[0].name;
      await connectTo(target);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("missing-tmux")) setError("missing-tmux");
      else if (msg.includes("too-old")) setError("too-old");
      else showToast(msg);
    }
  }, [connectTo, showToast]);

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
        const target = (await attachTargetName()) ?? tree.sessions[0].name;
        await connectTo(target);
        return;
      }
      const vis = visibleRef.current;
      const win = sess.windows.find((w) => w.id === vis) ?? sess.windows.find((w) => w.active) ?? sess.windows[0];
      if (win && win.id !== vis) {
        await applyWindow(win);
      }
    } catch (e) {
      showToast(String(e));
    }
  }, [applyWindow, connectTo, showToast]);

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
    const host = hostRef.current;
    if (!host) return;
    let t: number | undefined;
    const ro = new ResizeObserver(() => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => pushClientSize(), 50);
    });
    ro.observe(host);
    pushClientSize();
    return () => {
      ro.disconnect();
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
        default:
          break;
      }
    } catch (e) {
      showToast(String(e));
    }
  }
  onMenuRef.current = onMenu;

  async function doCopy() {
    const pane = focusedRef.current;
    if (!pane) return;
    const term = getTerm(pane);
    if (term?.hasSelection()) {
      await navigator.clipboard.writeText(term.getSelection());
    }
  }

  async function doPaste() {
    const pane = focusedRef.current;
    if (!pane) return;
    const text = await navigator.clipboard.readText();
    await paneWrite(pane, Array.from(new TextEncoder().encode(text)));
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

  async function submitKill() {
    if (!selection) return;
    setDialog(null);
    try {
      if (selection.kind === "session") await killSession(selection.name);
      else if (selection.kind === "window") await killWindow(selection.id);
      else await killPane(selection.id);
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
  const showTiles = !error && !empty && layout && attachedSession;

  return (
    <div className="app">
      <div className="body">
        <div
          className="sidebar-slot"
          style={{ width: sidebarWidth }}
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
            onNewTab={() => {
              void createNewTab();
            }}
            onRename={() => {
              const target = renameTarget(selection);
              if (!target) {
                showToast("select a session or window");
                return;
              }
              setInput(target.name);
              setDialog({ kind: "rename", value: target.name });
            }}
            onKill={() => {
              if (!selection) return;
              const message =
                selection.kind === "session"
                  ? `Kill session ${selection.name}?`
                  : selection.kind === "window"
                    ? `Kill window ${selection.name}?`
                    : `Kill pane ${selection.id}?`;
              setDialog({ kind: "kill", message });
            }}
          />
        </div>
        <Splitter width={sidebarWidth} onWidth={setSidebarWidth} />
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
              />
              <div className="term-stage" ref={hostRef}>
                <TiledWindow
                  node={layout}
                  focusedPane={focusedPane}
                  onFocus={(id) => {
                    chromeFocus.current = "terminal";
                    setFocusedPane(id);
                    const sess = snapRef.current.sessions.find(
                      (s) => s.name === attachedRef.current,
                    );
                    const win = sess?.windows.find((w) => w.id === visibleRef.current);
                    setSelection({
                      kind: "pane",
                      id,
                      sessionName: attachedRef.current ?? "",
                      windowId: win?.id ?? "",
                    });
                  }}
                  onCellSize={(w, h) => {
                    if (w > 0 && h > 0) {
                      cellRef.current = { w, h };
                      pushClientSize();
                    }
                  }}
                />
              </div>
            </>
          ) : (
            <div className="panel">
              <p>Connecting…</p>
            </div>
          )}
        </main>
      </div>
      <StatusBar status={status} session={attachedSession} windowName={winName} />
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
      {dialog?.kind === "kill" && (
        <Modal title="Confirm" onClose={() => setDialog(null)}>
          <p>{dialog.message}</p>
          <div className="modal-actions">
            <button onClick={() => setDialog(null)}>Cancel</button>
            <button className="danger" onClick={() => void submitKill()}>
              Kill
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
          <p>Desktop {status?.app_version ?? "0.1.0"}</p>
          <p>{status?.version ?? "tmux unknown"}</p>
          <p>
            Socket: <code>{status?.socket_path ?? `-L ${status?.socket_name ?? "sparkmux"}`}</code>
          </p>
          <p>
            Real terminal attach:{" "}
            <code>tmux -L {status?.socket_name ?? "sparkmux"} attach</code>
          </p>
          <p>Prefix bindings are not emulated in the GUI.</p>
          <div className="modal-actions">
            <button className="primary" onClick={() => setDialog(null)}>
              Close
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
