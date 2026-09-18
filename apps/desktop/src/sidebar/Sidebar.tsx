import { useState } from "react";

import type { Selection, Snapshot } from "../types";

export default function Sidebar({
  snapshot,
  attachedSession,
  visibleWindowId,
  focusedPane,
  selection,
  onSelectSession,
  onSelectWindow,
  onSelectPane,
  onRename,
  onKill,
  onNewSession,
  onNewTab,
}: {
  snapshot: Snapshot;
  attachedSession: string | null;
  visibleWindowId: string | null;
  focusedPane: string | null;
  selection: Selection | null;
  onSelectSession: (name: string) => void;
  onSelectWindow: (sessionName: string, windowId: string) => void;
  onSelectPane: (sessionName: string, windowId: string, paneId: string) => void;
  onRename: () => void;
  onKill: () => void;
  onNewSession: () => void;
  onNewTab: () => void;
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

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <div className="sidebar-kicker">Sessions</div>
        <div className="sidebar-count">{n}</div>
      </header>
      <div className="sidebar-tree">
        {n === 0 && <div className="sidebar-empty">No sessions on this socket</div>}
        {snapshot.sessions.map((session) => {
          const sessCollapsed = collapsed.has(session.id);
          const sessSelected =
            selection?.kind === "session" && selection.name === session.name;
          const live = attachedSession === session.name;
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
                  onClick={() => onSelectSession(session.name)}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onSelectSession(session.name);
                    window.setTimeout(() => onRename(), 0);
                  }}
                >
                  <span className={`live-dot ${live ? "on" : ""}`} />
                  <span className="name">{session.name}</span>
                  <span className="meta">
                    {session.windows.length}w
                  </span>
                </button>
              </div>
              {!sessCollapsed &&
                session.windows.map((win) => {
                  const winCollapsed = collapsed.has(win.id);
                  const winSelected =
                    selection?.kind === "window" && selection.id === win.id;
                  const winVisible = visibleWindowId === win.id && live;
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
                          onClick={() => onSelectWindow(session.name, win.id)}
                        >
                          <span className="badge">{win.index}</span>
                          <span className="name">{win.name}</span>
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
      <div className="sidebar-actions">
        <button className="ghost" onClick={onNewSession} title="New session">
          Session
        </button>
        <button
          className="ghost"
          onClick={onNewTab}
          disabled={!attachedSession}
          title="New tab in this session"
        >
          Tab
        </button>
        <button disabled={!selection && !attachedSession} onClick={onRename}>
          Rename
        </button>
        <button disabled={!selection} className="danger" onClick={onKill}>
          Kill
        </button>
      </div>
    </aside>
  );
}
