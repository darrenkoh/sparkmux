import { useCallback, useRef } from "react";

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 440;
export const SIDEBAR_DEFAULT = 260;

export default function Splitter({
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
        const next = Math.min(
          SIDEBAR_MAX,
          Math.max(SIDEBAR_MIN, startW + ev.clientX - startX),
        );
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
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(width)}
      onMouseDown={onMouseDown}
    />
  );
}
