import { useEffect, useRef, useState } from "react";

import type { Window as TmuxWindow } from "../types";

export default function WindowTabs({
  windows,
  visibleWindowId,
  onSelect,
  onNewTab,
  onCloseTab,
  onRenameTab,
}: {
  windows: TmuxWindow[];
  visibleWindowId: string | null;
  onSelect: (windowId: string) => void;
  onNewTab: () => void;
  onCloseTab: (windowId: string) => void;
  onRenameTab: (windowId: string, name: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editingId) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editingId]);

  function startRename(win: TmuxWindow) {
    setDraft(win.name);
    setEditingId(win.id);
  }

  function commitRename() {
    const id = editingId;
    const name = draft.trim();
    setEditingId(null);
    if (!id || !name) return;
    const current = windows.find((w) => w.id === id)?.name;
    if (name !== current) onRenameTab(id, name);
  }

  function cancelRename() {
    setEditingId(null);
  }

  return (
    <div className="window-tabs" role="tablist">
      {windows.map((win) => {
        const active = win.id === visibleWindowId;
        const editing = editingId === win.id;
        const unread = win.unread && !active;
        const pendingAsk = unread && win.pending_ask ? win.pending_ask : "";
        const finished = win.finished && !active;
        const tabLabel = [
          win.name,
          unread ? "unread" : "",
          pendingAsk,
          finished ? "finished" : "",
        ]
          .filter(Boolean)
          .join(", ");
        return (
          <div
            key={win.id}
            className={`window-tab ${active ? "active" : ""} ${editing ? "editing" : ""}`}
            role="tab"
            aria-selected={active}
          >
            {editing ? (
              <div className="window-tab-main">
                <span className="window-tab-idx">{win.index}</span>
                <input
                  ref={inputRef}
                  className="window-tab-rename"
                  value={draft}
                  aria-label="Tab name"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename();
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  onBlur={commitRename}
                />
              </div>
            ) : (
              <button
                type="button"
                className="window-tab-main"
                onClick={(e) => {
                  e.currentTarget.blur();
                  onSelect(win.id);
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.blur();
                  onSelect(win.id);
                  startRename(win);
                }}
                title={
                  pendingAsk
                    ? `${win.index}: ${win.name} — ${pendingAsk}`
                    : unread
                      ? `${win.index}: ${win.name} (unread)`
                      : finished
                        ? `${win.index}: ${win.name} (finished)`
                        : `${win.index}: ${win.name}`
                }
                aria-label={tabLabel}
              >
                <span className="window-tab-idx">{win.index}</span>
                <span className="window-tab-copy">
                  <span className="window-tab-name">{win.name}</span>
                  {pendingAsk && <span className="window-tab-ask">{pendingAsk}</span>}
                </span>
                {unread && <span className="attn" title="unread" aria-hidden="true" />}
                {finished && (
                  <span className="attn-finished" title="finished" aria-hidden="true" />
                )}
                {win.panes.length > 1 && (
                  <span className="window-tab-meta">{win.panes.length}p</span>
                )}
              </button>
            )}
            <button
              type="button"
              className="window-tab-close"
              title="Close tab"
              aria-label={`Close ${win.name}`}
              onClick={() => onCloseTab(win.id)}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="window-tab window-tab-add"
        title="New tab"
        aria-label="New tab"
        onClick={onNewTab}
      >
        +
      </button>
    </div>
  );
}
