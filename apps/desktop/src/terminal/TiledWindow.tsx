import type { LayoutNode, Snapshot } from "../types";
import type { PaneInputMode } from "./promptScroll";
import XtermView from "./XtermView";

export function paneInputModes(snap: Snapshot): Map<string, PaneInputMode> {
  const modes = new Map<string, PaneInputMode>();
  for (const session of snap.sessions) {
    for (const win of session.windows) {
      for (const pane of win.panes) {
        modes.set(pane.id, {
          alternate: pane.alternate,
          mouse: pane.mouse,
          mouseDrag: pane.mouse_drag,
          mouseAny: pane.mouse_any,
          mouseSgr: pane.mouse_sgr,
        });
      }
    }
  }
  return modes;
}

export default function TiledWindow({
  node,
  focusedPane,
  zoomedPaneId = null,
  onToggleZoomPane,
  dropTarget,
  onFocus,
  onCellSize,
  fontSize,
  paneModes,
}: {
  node: LayoutNode;
  focusedPane: string | null;
  zoomedPaneId?: string | null;
  onToggleZoomPane?: (paneId: string) => void;
  dropTarget: string | null;
  onFocus: (paneId: string) => void;
  onCellSize?: (
    paneId: string,
    w: number,
    h: number,
    cols: number,
    rows: number,
  ) => void;
  fontSize: number;
  paneModes?: ReadonlyMap<string, PaneInputMode>;
}) {
  if ("Pane" in node) {
    const paneId = `%${node.Pane.pane_id}`;
    const focused = focusedPane === paneId;
    const dropping = dropTarget === paneId;
    const hiddenByZoom = Boolean(zoomedPaneId && zoomedPaneId !== paneId);
    return (
      <div
        key={paneId}
        data-pane-id={paneId}
        style={hiddenByZoom ? { display: "none" } : undefined}
        className={`tile-leaf pane-frame${focused ? " focused" : ""}${dropping ? " drop-target" : ""}${zoomedPaneId === paneId ? " zoomed" : ""}`}
        onDoubleClick={(event) => {
          if (event.target instanceof HTMLElement && event.target.closest(".pane-find")) return;
          onToggleZoomPane?.(paneId);
        }}
      >
        <XtermView
          key={paneId}
          paneId={paneId}
          focused={focused}
          onFocus={onFocus}
          onCellSize={
            onCellSize
              ? (w, h, cols, rows) => onCellSize(paneId, w, h, cols, rows)
              : undefined
          }
          fontSize={fontSize}
          inputMode={paneModes?.get(paneId)}
        />
      </div>
    );
  }
  const split = node.Split;
  const dir = split.dir === "LeftRight" ? "row" : "column";
  const parentSize = split.dir === "LeftRight" ? split.w : split.h;
  return (
    <div className={`tile-split ${dir === "row" ? "row" : "col"}`} style={{ flexDirection: dir }}>
      {split.children.map((child, i) => {
        const size = nodeSize(child, split.dir === "LeftRight");
        const pct = parentSize > 0 ? (size / parentSize) * 100 : 100 / split.children.length;
        const containsZoomed = zoomedPaneId ? subtreeHasPane(child, zoomedPaneId) : true;
        return (
          <div
            key={leafKey(child, i)}
            className="tile-child"
            style={{
              flex: zoomedPaneId ? (containsZoomed ? "1 1 100%" : "0 0 0%") : `${pct} 1 0%`,
              display: zoomedPaneId && !containsZoomed ? "none" : undefined,
              minWidth: 0,
              minHeight: 0,
            }}
          >
            <TiledWindow
              node={child}
              focusedPane={focusedPane}
              zoomedPaneId={zoomedPaneId}
              onToggleZoomPane={onToggleZoomPane}
              dropTarget={dropTarget}
              onFocus={onFocus}
              onCellSize={onCellSize}
              fontSize={fontSize}
              paneModes={paneModes}
            />
          </div>
        );
      })}
    </div>
  );
}

function subtreeHasPane(node: LayoutNode, targetPaneId: string): boolean {
  if ("Pane" in node) return `%${node.Pane.pane_id}` === targetPaneId;
  return node.Split.children.some((child) => subtreeHasPane(child, targetPaneId));
}

function nodeSize(node: LayoutNode, horizontal: boolean): number {
  if ("Pane" in node) return horizontal ? node.Pane.w : node.Pane.h;
  return horizontal ? node.Split.w : node.Split.h;
}

function leafKey(node: LayoutNode, i: number): string {
  if ("Pane" in node) return `p-${node.Pane.pane_id}`;
  return `s-${i}-${node.Split.dir}`;
}

export function fallbackLayout(paneId: string): LayoutNode {
  const n = Number(paneId.replace("%", "")) || 0;
  return { Pane: { w: 80, h: 24, x: 0, y: 0, pane_id: n } };
}

/** Tmux client size that matches fitted xterm cells. Split separators are 1 col/row. */
export function clientSizeFromFits(
  node: LayoutNode,
  fits: Map<string, { cols: number; rows: number }>,
): { cols: number; rows: number } | null {
  if ("Pane" in node) {
    return fits.get(`%${node.Pane.pane_id}`) ?? null;
  }
  const kids: { cols: number; rows: number }[] = [];
  for (const child of node.Split.children) {
    const size = clientSizeFromFits(child, fits);
    if (!size) return null;
    kids.push(size);
  }
  if (kids.length === 0) return null;
  if (node.Split.dir === "LeftRight") {
    return {
      cols: kids.reduce((n, k) => n + k.cols, 0) + (kids.length - 1),
      rows: Math.max(...kids.map((k) => k.rows)),
    };
  }
  return {
    cols: Math.max(...kids.map((k) => k.cols)),
    rows: kids.reduce((n, k) => n + k.rows, 0) + (kids.length - 1),
  };
}
