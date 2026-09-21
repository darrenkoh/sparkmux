import type { LayoutNode } from "../types";
import XtermView from "./XtermView";

export default function TiledWindow({
  node,
  focusedPane,
  onFocus,
  onCellSize,
  fontSize,
}: {
  node: LayoutNode;
  focusedPane: string | null;
  onFocus: (paneId: string) => void;
  onCellSize?: (
    paneId: string,
    w: number,
    h: number,
    cols: number,
    rows: number,
  ) => void;
  fontSize: number;
}) {
  if ("Pane" in node) {
    const paneId = `%${node.Pane.pane_id}`;
    const focused = focusedPane === paneId;
    return (
      <div className={`tile-leaf pane-frame ${focused ? "focused" : ""}`}>
        <XtermView
          paneId={paneId}
          focused={focused}
          onFocus={onFocus}
          onCellSize={
            onCellSize
              ? (w, h, cols, rows) => onCellSize(paneId, w, h, cols, rows)
              : undefined
          }
          fontSize={fontSize}
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
        return (
          <div
            key={leafKey(child, i)}
            className="tile-child"
            style={{ flex: `${pct} 1 0%`, minWidth: 0, minHeight: 0 }}
          >
            <TiledWindow
              node={child}
              focusedPane={focusedPane}
              onFocus={onFocus}
              onCellSize={onCellSize}
              fontSize={fontSize}
            />
          </div>
        );
      })}
    </div>
  );
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
