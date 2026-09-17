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
}) {
  return (
    <aside className="sidebar" onMouseDown={(e) => e.stopPropagation()}>
      <div className="sidebar-title">Sessions</div>
      <div className="sidebar-tree">
        {snapshot.sessions.length === 0 && (
          <div className="sidebar-empty">No sessions</div>
        )}
        {snapshot.sessions.map((session) => {
          const open = true;
          const sessSelected =
            selection?.kind === "session" && selection.name === session.name;
          return (
            <div key={session.id} className="sess">
              <button
                className={`row sess-row ${sessSelected ? "selected" : ""}`}
                onClick={() => onSelectSession(session.name)}
              >
                <span className="twist">{open ? "▾" : "▸"}</span>
                <span className="name">{session.name}</span>
                {attachedSession === session.name && <span className="dot">●</span>}
              </button>
              {open &&
                session.windows.map((win) => {
                  const winSelected =
                    selection?.kind === "window" && selection.id === win.id;
                  return (
                    <div key={win.id}>
                      <button
                        className={`row win-row ${winSelected ? "selected" : ""} ${
                          visibleWindowId === win.id ? "visible" : ""
                        }`}
                        onClick={() => onSelectWindow(session.name, win.id)}
                      >
                        <span className="name">
                          {win.index}: {win.name}
                        </span>
                        <span className="meta">{win.panes.length}p</span>
                      </button>
                      {win.panes.map((pane) => {
                        const paneSelected =
                          selection?.kind === "pane" && selection.id === pane.id;
                        return (
                          <button
                            key={pane.id}
                            className={`row pane-row ${paneSelected ? "selected" : ""} ${
                              focusedPane === pane.id ? "focused" : ""
                            }`}
                            onClick={() => onSelectPane(session.name, win.id, pane.id)}
                          >
                            <span className="name">
                              {pane.id} {pane.command || "zsh"}
                            </span>
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
        <button disabled={!selection} onClick={onRename}>
          Rename…
        </button>
        <button disabled={!selection} className="danger" onClick={onKill}>
          Kill
        </button>
      </div>
    </aside>
  );
}
