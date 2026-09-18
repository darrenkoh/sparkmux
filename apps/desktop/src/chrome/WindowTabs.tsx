import type { Window as TmuxWindow } from "../types";

export default function WindowTabs({
  windows,
  visibleWindowId,
  onSelect,
  onNewTab,
  onCloseTab,
}: {
  windows: TmuxWindow[];
  visibleWindowId: string | null;
  onSelect: (windowId: string) => void;
  onNewTab: () => void;
  onCloseTab: (windowId: string) => void;
}) {
  return (
    <div className="window-tabs" role="tablist">
      {windows.map((win) => {
        const active = win.id === visibleWindowId;
        return (
          <div
            key={win.id}
            className={`window-tab ${active ? "active" : ""}`}
            role="tab"
            aria-selected={active}
          >
            <button
              type="button"
              className="window-tab-main"
              onClick={() => onSelect(win.id)}
              title={`${win.index}: ${win.name}`}
            >
              <span className="window-tab-idx">{win.index}</span>
              <span className="window-tab-name">{win.name}</span>
              {win.panes.length > 1 && (
                <span className="window-tab-meta">{win.panes.length}p</span>
              )}
            </button>
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
