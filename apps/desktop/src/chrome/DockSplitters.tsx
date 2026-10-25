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

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = widthRef.current;
      const prevSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";
      document.body.classList.add("is-resizing");

      const move = (ev: PointerEvent) => {
        const delta = startX - ev.clientX;
        const maxW = Math.min(960, Math.max(340, window.innerWidth - 280));
        const next = Math.min(maxW, Math.max(DOCK_MIN_WIDTH, startW + delta));
        onWidth(next);
      };

      const up = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        document.body.style.userSelect = prevSelect;
        document.body.classList.remove("is-resizing");
      };

      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
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
      onPointerDown={onPointerDown}
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

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const rect = container.getBoundingClientRect();
      const prevSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";
      document.body.classList.add("is-resizing");

      const move = (ev: PointerEvent) => {
        const totalHeight = rect.height;
        if (totalHeight <= 40) return;
        const offsetY = ev.clientY - rect.top;
        const next = Math.min(0.85, Math.max(0.15, offsetY / totalHeight));
        onRatio(next);
      };

      const up = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        document.body.style.userSelect = prevSelect;
        document.body.classList.remove("is-resizing");
      };

      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
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
      onPointerDown={onPointerDown}
      onDoubleClick={() => onRatio(0.5)}
    >
      <span className="dock-splitter-rule" aria-hidden="true" />
    </div>
  );
}
