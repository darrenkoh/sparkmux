import { useEffect, useRef, useState } from "react";

import AgentBoard from "../chrome/AgentBoard.tsx";
import type { AgentBoardRow } from "../chrome/agentBoard.ts";
import { onTabPointerDown, shouldIgnoreTabClick } from "../chrome/tabReorder.ts";
import { useTabDragIndicator } from "../chrome/useTabDragIndicator.ts";
import type { Selection, Snapshot, Window as TmuxWindow } from "../types";

export default function Sidebar({
  snapshot,
  attachedSession,
  visibleWindowId,
  focusedPane,
  selection,
  onSelectSession,
  onSelectWindow,
  onSelectPane,
  onRenameSession,
  onRenameTab,
  onCloseSession,
  onNewSession,
  onCollapse,
  agentRows = [],
  onSelectAgent,
}: {
  snapshot: Snapshot;
  attachedSession: string | null;
  visibleWindowId: string | null;
  focusedPane: string | null;
  selection: Selection | null;
  onSelectSession: (name: string) => void;
  onSelectWindow: (sessionName: string, windowId: string) => void;
  onSelectPane: (sessionName: string, windowId: string, paneId: string) => void;
  onRenameSession: (name: string) => void;
  onRenameTab?: (windowId: string, name: string) => void;
  onCloseSession: (name: string) => void;
  onNewSession: () => void;
  onCollapse?: () => void;
  /** Agent board rows. Optional; defaults to an empty board until App passes them. */
  agentRows?: AgentBoardRow[];
  /**
   * Selects the board row's session, window, and pane. Optional; defaults to
   * `onSelectPane`. The board does not write to the pane.
   */
  onSelectAgent?: (session: string, windowId: string, paneId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [editingWindowId, setEditingWindowId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const editingWindowIdRef = useRef<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const { draggingId, hint } = useTabDragIndicator();

  useEffect(() => {
    if (!editingWindowId) return;
    const el = renameInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editingWindowId]);

  useEffect(() => {
    if (!editingWindowId) return;
    const exists = snapshot.sessions.some((s) =>
      s.windows.some((w) => w.id === editingWindowId),
    );
    if (!exists) {
      editingWindowIdRef.current = null;
      setEditingWindowId(null);
    }
  }, [editingWindowId, snapshot]);

  function startRenameTab(win: TmuxWindow) {
    editingWindowIdRef.current = win.id;
    setDraft(win.name);
    setEditingWindowId(win.id);
  }

  function commitRenameTab() {
    const id = editingWindowIdRef.current;
    if (!id) return;
    editingWindowIdRef.current = null;
    const name = draft.trim();
    setEditingWindowId(null);
    if (!name || !onRenameTab) return;
    const current = snapshot.sessions
      .flatMap((s) => s.windows)
      .find((w) => w.id === id)?.name;
    if (name !== current) onRenameTab(id, name);
  }

  function cancelRenameTab() {
    if (!editingWindowIdRef.current) return;
    editingWindowIdRef.current = null;
    setEditingWindowId(null);
  }

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const n = snapshot.sessions.length;

  const selectAgent = onSelectAgent ?? onSelectPane;

  return (
    <aside className="sidebar">
      <AgentBoard rows={agentRows} onSelect={selectAgent} />
      <header className="sidebar-head">
        <div className="sidebar-kicker-row">
          <div className="sidebar-kicker">Sessions</div>
          <button
            type="button"
            className="sidebar-add"
            title="New session"
            aria-label="New session"
            onClick={onNewSession}
          >
            +
          </button>
        </div>
        <div className="sidebar-head-end">
          <div className="sidebar-count">{n}</div>
          <button
            type="button"
            className="sidebar-collapse"
            title="Hide sessions"
            aria-label="Hide sessions"
            onClick={() => onCollapse?.()}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect
                x="2.25"
                y="2.5"
                width="9.5"
                height="9"
                rx="1.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
              />
              <path
                d="M6 2.5v9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
              />
            </svg>
          </button>
        </div>
      </header>
      <div className="sidebar-tree">
        {n === 0 && <div className="sidebar-empty">No sessions on this socket</div>}
        {snapshot.sessions.map((session) => {
          const sessCollapsed = collapsed.has(session.id);
          const sessSelected =
            selection?.kind === "session" && selection.name === session.name;
          const live = attachedSession === session.name;
          const hidden = (w: { id: string }) => !(live && w.id === visibleWindowId);
          const sessAttn = session.windows.some((w) => w.unread && hidden(w));
          const sessFinished = session.windows.some((w) => w.finished && hidden(w));
          return (
            <div key={session.id} className={`sess ${live ? "live" : ""}`}>
              <div className={`row sess-row ${sessSelected ? "selected" : ""}`}>
                <button
                  className="twist"
                  aria-label={sessCollapsed ? "Expand" : "Collapse"}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(session.id);
                  }}
                >
                  {sessCollapsed ? "▸" : "▾"}
                </button>
                <button
                  className="row-main"
                  aria-expanded={!sessCollapsed}
                  aria-label={
                    sessAttn
                      ? `${session.name}, unread`
                      : sessFinished
                        ? `${session.name}, finished`
                        : session.name
                  }
                  onClick={() => {
                    toggle(session.id);
                    onSelectSession(session.name);
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onRenameSession(session.name);
                  }}
                >
                  <span className={`live-dot ${live ? "on" : ""}`} />
                  <span className="name">{session.name}</span>
                  {sessAttn && (
                    <span className="attn" title="unread" aria-hidden="true" />
                  )}
                  {sessFinished && (
                    <span className="attn-finished" title="finished" aria-hidden="true" />
                  )}
                  <span className="meta">{session.windows.length}w</span>
                </button>
                <button
                  type="button"
                  className="sess-close"
                  title={`Close session ${session.name}`}
                  aria-label={`Close session ${session.name}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onCloseSession(session.name);
                  }}
                >
                  ×
                </button>
              </div>
              {!sessCollapsed &&
                session.windows.map((win) => {
                  const winCollapsed = collapsed.has(win.id);
                  const winEditing = editingWindowId === win.id;
                  const winSelected =
                    selection?.kind === "window" && selection.id === win.id;
                  const winVisible = visibleWindowId === win.id && live;
                  const winAttn = win.unread && !winVisible;
                  const pendingAsk = winAttn && win.pending_ask ? win.pending_ask : "";
                  const winFinished = win.finished && !winVisible;
                  const winLabel = [
                    win.name,
                    winAttn ? "unread" : "",
                    pendingAsk,
                    winFinished ? "finished" : "",
                  ]
                    .filter(Boolean)
                    .join(", ");
                  return (
                    <div key={win.id} className="win-block">
                      <div
                        className={`row win-row ${winSelected ? "selected" : ""} ${
                          winVisible ? "visible" : ""
                        } ${winEditing ? "editing" : ""} ${draggingId === win.id ? "dragging" : ""} ${
                          session.windows.length > 1 ? "can-reorder" : ""
                        } ${
                          hint?.session === session.name && hint.id === win.id
                            ? hint.edge === "before"
                              ? "drop-before"
                              : "drop-after"
                            : ""
                        }`}
                        data-tab-window={win.id}
                        data-tab-session={session.name}
                        data-tab-axis="vertical"
                        onPointerDown={(event) => {
                          if (session.windows.length < 2 || winEditing) return;
                          onTabPointerDown(event, { session: session.name, windowId: win.id });
                        }}
                      >
                        <button
                          className="twist"
                          data-no-drag=""
                          aria-label={winCollapsed ? "Expand panes" : "Collapse panes"}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(win.id);
                          }}
                        >
                          {winCollapsed ? "▸" : "▾"}
                        </button>
                        {winEditing ? (
                          <div
                            className="row-main"
                            onMouseDown={(e) => {
                              if (e.target !== renameInputRef.current) e.preventDefault();
                            }}
                          >
                            <span className="badge">{win.index}</span>
                            <input
                              ref={renameInputRef}
                              autoFocus
                              className="win-row-rename"
                              value={draft}
                              aria-label="Tab name"
                              onChange={(e) => setDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.nativeEvent.isComposing) return;
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  commitRenameTab();
                                } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  cancelRenameTab();
                                }
                              }}
                              onBlur={commitRenameTab}
                            />
                          </div>
                        ) : (
                          <>
                            <button
                              className="row-main"
                              aria-label={winLabel}
                              onClick={(e) => {
                                if (shouldIgnoreTabClick()) return;
                                if (e.detail > 1) return;
                                onSelectWindow(session.name, win.id);
                              }}
                              onDoubleClick={(e) => {
                                if (!onRenameTab) return;
                                e.preventDefault();
                                e.stopPropagation();
                                startRenameTab(win);
                              }}
                            >
                              <span className="badge">{win.index}</span>
                              <span className="name-stack">
                                <span className="name">{win.name}</span>
                                {pendingAsk && <span className="pending-ask">{pendingAsk}</span>}
                              </span>
                              {winAttn && (
                                <span className="attn" title="unread" aria-hidden="true" />
                              )}
                              {winFinished && (
                                <span
                                  className="attn-finished"
                                  title="finished"
                                  aria-hidden="true"
                                />
                              )}
                              <span className="meta">{win.panes.length}p</span>
                            </button>
                            {onRenameTab && (
                              <button
                                type="button"
                                className="win-rename-btn"
                                data-no-drag=""
                                title={`Rename tab ${win.name}`}
                                aria-label={`Rename tab ${win.name}`}
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  startRenameTab(win);
                                }}
                              >
                                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                                  <path
                                    d="M8.5 1.75a1.25 1.25 0 0 1 1.75 1.75L4.4 9.35 2 10l.65-2.4z"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.2"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              </button>
                            )}
                          </>
                        )}
                      </div>
                      {!winCollapsed &&
                        win.panes.length > 1 &&
                        win.panes.map((pane) => {
                          const paneSelected =
                            selection?.kind === "pane" && selection.id === pane.id;
                          const paneFocused = focusedPane === pane.id && live;
                          const cmd = pane.command || "zsh";
                          return (
                            <button
                              key={pane.id}
                              className={`row pane-row ${paneSelected ? "selected" : ""} ${
                                paneFocused ? "focused" : ""
                              }`}
                              onClick={() =>
                                onSelectPane(session.name, win.id, pane.id)
                              }
                              title={`${pane.id} ${cmd}\n${pane.path}`}
                            >
                              <span className="pane-mark">›</span>
                              <span className="name">{cmd}</span>
                              {pane.active && <span className="star">*</span>}
                            </button>
                          );
                        })}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
