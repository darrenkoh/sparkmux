import { useState } from "react";

import AgentBoard from "../chrome/AgentBoard.tsx";
import type { AgentBoardRow } from "../chrome/agentBoard.ts";
import type { Selection, Snapshot } from "../types";
import { offScreenHint, offScreenSessions } from "./orphanSessions";

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

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const n = snapshot.sessions.length;
  const offScreen = offScreenSessions(snapshot.sessions, attachedSession);

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
      {offScreen.length > 0 && (
        <section className="offscreen" aria-label="Off screen sessions">
          <div className="offscreen-head">
            <div className="sidebar-kicker" title="Still running. The terminal is showing a different session.">
              Off screen
            </div>
            <div className="sidebar-count">{offScreen.length}</div>
          </div>
          <div className="offscreen-list">
            {offScreen.map((session) => {
              const hint = offScreenHint(session);
              return (
                <div key={session.id} className="row sess-row offscreen-row">
                  <button
                    type="button"
                    className="row-main"
                    title={`${session.name}\n${hint}\nOpen in the terminal`}
                    aria-label={`${session.name}, off screen, ${hint}`}
                    onClick={() => onSelectSession(session.name)}
                  >
                    <span className="live-dot" aria-hidden="true" />
                    <span className="name">{session.name}</span>
                    <span className="offscreen-hint">{hint}</span>
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
              );
            })}
          </div>
        </section>
      )}
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
                        }`}
                      >
                        <button
                          className="twist"
                          aria-label={winCollapsed ? "Expand panes" : "Collapse panes"}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(win.id);
                          }}
                        >
                          {winCollapsed ? "▸" : "▾"}
                        </button>
                        <button
                          className="row-main"
                          aria-label={winLabel}
                          onClick={() => onSelectWindow(session.name, win.id)}
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
