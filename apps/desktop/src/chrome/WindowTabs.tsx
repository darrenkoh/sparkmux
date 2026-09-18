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
                onClick={() => onSelect(win.id)}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSelect(win.id);
                  startRename(win);
                }}
                title={`${win.index}: ${win.name}`}
              >
                <span className="window-tab-idx">{win.index}</span>
                <span className="window-tab-name">{win.name}</span>
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
