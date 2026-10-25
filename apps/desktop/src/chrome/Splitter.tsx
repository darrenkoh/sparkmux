import { useCallback, useRef } from "react";

export const SIDEBAR_MIN = 152;
export const SIDEBAR_MAX = 440;
export const SIDEBAR_DEFAULT = 260;
const COLLAPSE_PX = 72;

function Chevron({ dir }: { dir: "left" | "right" }) {
  const d = dir === "left" ? "M7.25 2.2 3.2 6l4.05 3.8" : "M4.75 2.2 8.8 6l-4.05 3.8";
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Splitter({
  width,
  collapsed,
  onWidth,
  onCollapsed,
}: {
  width: number;
  collapsed: boolean;
  onWidth: (w: number) => void;
  onCollapsed: (c: boolean) => void;
}) {
  const widthRef = useRef(width);
  const collapsedRef = useRef(collapsed);
  widthRef.current = width;
  collapsedRef.current = collapsed;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest(".splitter-toggle")) return;
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = collapsedRef.current ? 0 : widthRef.current;
      const prevSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";
      document.body.classList.add("is-resizing");

      const move = (ev: PointerEvent) => {
        const raw = startW + ev.clientX - startX;
        if (raw < COLLAPSE_PX) {
          onCollapsed(true);
          return;
        }
        onCollapsed(false);
        onWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, raw)));
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
    [onWidth, onCollapsed],
  );

  return (
    <div
      className={`splitter ${collapsed ? "collapsed" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={collapsed ? 0 : Math.round(width)}
      aria-valuemin={0}
      aria-valuemax={SIDEBAR_MAX}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onCollapsed(!collapsedRef.current)}
    >
      <span className="splitter-rule" aria-hidden="true" />
      <button
        type="button"
        className="splitter-toggle"
        title={collapsed ? "Show sessions" : "Hide sessions"}
        aria-label={collapsed ? "Show sessions" : "Hide sessions"}
        aria-expanded={!collapsed}
        onClick={(e) => {
          e.stopPropagation();
          onCollapsed(!collapsedRef.current);
        }}
      >
        <Chevron dir={collapsed ? "right" : "left"} />
      </button>
    </div>
  );
}
