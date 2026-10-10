import { useCallback, useRef } from "react";

export const DOCK_MIN_WIDTH = 260;
export const DOCK_DEFAULT_WIDTH = 420;

export function DockWidthSplitter({
  width,
  onWidth,
}: {
  width: number;
  onWidth: (w: number) => void;
}) {
  const widthRef = useRef(width);
  widthRef.current = width;

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = widthRef.current;
      const prevSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";
      document.body.classList.add("is-resizing");

      const move = (ev: MouseEvent) => {
        // Dragging left (negative deltaX) widens the right docked container
        const delta = startX - ev.clientX;
        const maxW = Math.min(960, Math.max(340, window.innerWidth - 280));
        const next = Math.min(maxW, Math.max(DOCK_MIN_WIDTH, startW + delta));
        onWidth(next);
      };

      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.style.userSelect = prevSelect;
        document.body.classList.remove("is-resizing");
      };

      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    },
    [onWidth],
  );

  return (
    <div
      className="dock-splitter dock-splitter-w"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize dock width"
      title="Drag to resize dock width (Double-click to reset)"
      onMouseDown={onMouseDown}
      onDoubleClick={() => onWidth(DOCK_DEFAULT_WIDTH)}
    >
      <span className="dock-splitter-rule" aria-hidden="true" />
    </div>
  );
}

export function DockHeightSplitter({
  containerRef,
  ratio,
  onRatio,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  ratio: number;
  onRatio: (r: number) => void;
}) {
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const prevSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";
      document.body.classList.add("is-resizing");

      const move = (ev: MouseEvent) => {
        const totalHeight = rect.height;
        if (totalHeight <= 40) return;
        const offsetY = ev.clientY - rect.top;
        // Clamp split ratio so each pane gets at least 15% (or min 90px)
        const next = Math.min(0.85, Math.max(0.15, offsetY / totalHeight));
        onRatio(next);
      };

      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.style.userSelect = prevSelect;
        document.body.classList.remove("is-resizing");
      };

      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    },
    [containerRef, onRatio],
  );

  return (
    <div
      className="dock-splitter dock-splitter-h"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize panels height split"
      title="Drag to resize panels height split (Double-click to reset)"
      onMouseDown={onMouseDown}
      onDoubleClick={() => onRatio(0.5)}
    >
      <span className="dock-splitter-rule" aria-hidden="true" />
    </div>
  );
}
