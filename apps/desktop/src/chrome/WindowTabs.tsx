import type { Window as TmuxWindow } from "../types";

export default function WindowTabs({
  windows,
  visibleWindowId,
  onSelect,
  onNewTab,
}: {
  windows: TmuxWindow[];
  visibleWindowId: string | null;
  onSelect: (windowId: string) => void;
  onNewTab: () => void;
}) {
  return (
    <div className="window-tabs" role="tablist">
      {windows.map((win) => {
        const active = win.id === visibleWindowId;
        return (
          <button
            key={win.id}
            role="tab"
            aria-selected={active}
            className={`window-tab ${active ? "active" : ""}`}
            onClick={() => onSelect(win.id)}
            title={`${win.index}: ${win.name}`}
          >
            <span className="window-tab-idx">{win.index}</span>
            <span className="window-tab-name">{win.name}</span>
            {win.panes.length > 1 && (
              <span className="window-tab-meta">{win.panes.length}p</span>
            )}
          </button>
        );
      })}
      <button
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
