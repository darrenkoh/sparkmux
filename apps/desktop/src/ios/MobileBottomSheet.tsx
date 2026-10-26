import { useRef, useState } from "react";

import {
  sheetCollapsedByKeyboard,
  sheetDetentHeight,
  snapSheetDetent,
  type SheetDetent,
} from "./sheetLogic";

export type SheetTab = "output" | "map" | "gits" | "stats" | "agents";

const TABS: { id: SheetTab; label: string }[] = [
  { id: "output", label: "Logs" },
  { id: "map", label: "3D Map" },
  { id: "gits", label: "GIT" },
  { id: "stats", label: "Stats" },
  { id: "agents", label: "Agents" },
];

export interface MobileBottomSheetProps {
  detent: SheetDetent;
  onDetent: (next: SheetDetent) => void;
  tab: SheetTab;
  onTab: (next: SheetTab) => void;
  keyboardInsetBottom: number;
  ticker: string;
  children: React.ReactNode;
}

export default function MobileBottomSheet({
  detent,
  onDetent,
  tab,
  onTab,
  keyboardInsetBottom,
  ticker,
  children,
}: MobileBottomSheetProps) {
  const collapsed = sheetCollapsedByKeyboard(detent, keyboardInsetBottom);
  const viewportHeight = typeof window === "undefined" ? 956 : window.innerHeight;
  const openHeight = collapsed ? 0 : sheetDetentHeight(detent, viewportHeight);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef({ y: 0, h: 0, t: 0 });
  const height = dragHeight ?? openHeight;

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    drag.current = { y: event.clientY, h: openHeight, t: performance.now() };
    setDragHeight(openHeight);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (dragHeight === null) return;
    const next = Math.max(0, drag.current.h - (event.clientY - drag.current.y));
    setDragHeight(Math.min(next, viewportHeight * 0.92));
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dragHeight === null) return;
    const dt = Math.max(1, performance.now() - drag.current.t);
    const velocityY = (event.clientY - drag.current.y) / dt;
    const next = snapSheetDetent(dragHeight, velocityY, viewportHeight);
    setDragHeight(null);
    onDetent(next);
  }

  return (
    <section
      className={`mobile-bottom-sheet detent-${collapsed ? "closed" : detent}`}
      style={{ height }}
      aria-label="Bottom command deck"
    >
      <div
        className="sheet-grabber-zone"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="sheet-grabber" aria-hidden="true" />
        <div className="sheet-tabs" role="tablist" aria-label="Companion tabs">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? "active" : ""}
              onClick={() => {
                onTab(item.id);
                if (detent === "closed") onDetent("peek");
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        {detent === "peek" && !collapsed && ticker && <p className="sheet-ticker">{ticker}</p>}
      </div>
      {height > SHEET_BODY_MIN && <div className="sheet-body">{children}</div>}
    </section>
  );
}

const SHEET_BODY_MIN = 80;
