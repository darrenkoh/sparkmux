import type { LayoutNode } from "../types";
import XtermView from "./XtermView";

export default function TiledWindow({
  node,
  focusedPane,
  onFocus,
  onCellSize,
}: {
  node: LayoutNode;
  focusedPane: string | null;
  onFocus: (paneId: string) => void;
  onCellSize?: (w: number, h: number) => void;
}) {
  if ("Pane" in node) {
    const paneId = `%${node.Pane.pane_id}`;
    return (
      <div className="tile-leaf">
        <XtermView
          paneId={paneId}
          focused={focusedPane === paneId}
          onFocus={onFocus}
          onCellSize={onCellSize}
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
