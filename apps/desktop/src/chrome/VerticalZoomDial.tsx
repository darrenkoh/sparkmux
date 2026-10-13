import { useRef, useState } from "react";

export interface VerticalZoomDialProps {
  zoom: number;
  minZoom?: number;
  maxZoom?: number;
  onZoomChange: (newZoom: number) => void;
  onFit?: () => void;
  onReset?: () => void;
}

const TICKS = [
  { level: 2.0, label: "200%" },
  { level: 1.5, label: "150%" },
  { level: 1.0, label: "100%" },
  { level: 0.75, label: "75%" },
  { level: 0.5, label: "50%" },
  { level: 0.35, label: "35%" },
];

export default function VerticalZoomDial({
  zoom,
  minZoom = 0.35,
  maxZoom = 2.5,
  onZoomChange,
  onFit,
  onReset,
}: VerticalZoomDialProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ startY: 0, startZoom: zoom });

  const clampZoom = (val: number) => Math.min(maxZoom, Math.max(minZoom, val));

  // Fractional position along vertical track: 0 at bottom (minZoom), 1 at top (maxZoom)
  const norm = (zoom - minZoom) / (maxZoom - minZoom);
  const percentY = (1 - norm) * 100; // 0% at top, 100% at bottom

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    setIsDragging(true);
    dragStartRef.current = { startY: e.clientY, startZoom: zoom };

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const trackH = rect.height;
    // Moving up (negative dy) increases zoom
    const dy = dragStartRef.current.startY - e.clientY;
    const deltaZoom = (dy / trackH) * (maxZoom - minZoom);
    onZoomChange(clampZoom(dragStartRef.current.startZoom + deltaZoom));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging) {
      setIsDragging(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {}
    }
  };

  // Clicking directly on track jumps to that position
  const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const ratio = 1 - Math.max(0, Math.min(1, clickY / rect.height));
    const targetZoom = minZoom + ratio * (maxZoom - minZoom);
    onZoomChange(clampZoom(targetZoom));
  };

  // Wheel interaction on dial itself spins zoom smoothly
  const handleWheelOnDial = (e: React.WheelEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.deltaY === 0) return;
    const factor = e.deltaY < 0 ? 1.08 : 0.92;
    onZoomChange(clampZoom(zoom * factor));
  };

  // Steppers
  const handleStepUp = (e: React.MouseEvent) => {
    e.stopPropagation();
    onZoomChange(clampZoom(zoom * 1.15));
  };

  const handleStepDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    onZoomChange(clampZoom(zoom * 0.85));
  };

  return (
    <div
      className="vertical-zoom-dial-container"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={handleWheelOnDial}
      style={{
        position: "absolute",
        top: "56px",
        right: "16px",
        width: "56px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        background: "rgba(5, 10, 16, 0.92)",
        backdropFilter: "blur(8px)",
        border: "1px solid rgba(45, 212, 191, 0.35)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.8), inset 0 0 14px rgba(45, 212, 191, 0.06)",
        borderRadius: "6px",
        padding: "8px 4px 6px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        zIndex: 35,
        userSelect: "none",
        cursor: isDragging ? "ns-resize" : "default",
      }}
      role="region"
      aria-label="Vertical Zoom Dial"
    >
      {/* Dial Top Title / Badge */}
      <div
        style={{
          fontSize: "7.5px",
          letterSpacing: "0.12em",
          color: "#2dd4bf",
          textTransform: "uppercase",
          fontWeight: 700,
          marginBottom: "4px",
          textAlign: "center",
        }}
      >
        ZOOM
      </div>

      {/* Step Zoom In Button (+) */}
      <button
        type="button"
        onClick={handleStepUp}
        title="Zoom In (+15%)"
        style={{
          width: "36px",
          height: "22px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(45, 212, 191, 0.12)",
          border: "1px solid rgba(45, 212, 191, 0.35)",
          borderRadius: "3px",
          color: "#99f6e4",
          fontSize: "13px",
          fontWeight: "bold",
          cursor: "pointer",
          marginBottom: "6px",
          transition: "all 0.12s ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(45, 212, 191, 0.25)";
          e.currentTarget.style.color = "#fff";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "rgba(45, 212, 191, 0.12)";
          e.currentTarget.style.color = "#99f6e4";
        }}
      >
        +
      </button>

      {/* Vertical Cylindrical Dial Track */}
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleTrackClick}
        style={{
          position: "relative",
          width: "44px",
          height: "170px",
          background: "radial-gradient(ellipse at center, rgba(13, 27, 42, 0.9) 0%, rgba(3, 7, 12, 0.98) 100%)",
          border: "1px solid rgba(45, 212, 191, 0.25)",
          borderRadius: "4px",
          overflow: "hidden",
          cursor: "ns-resize",
          boxShadow: "inset 0 0 10px rgba(0, 0, 0, 0.9)",
        }}
        role="slider"
        aria-label="Zoom Level Dial"
        aria-valuemin={Math.round(minZoom * 100)}
        aria-valuemax={Math.round(maxZoom * 100)}
        aria-valuenow={Math.round(zoom * 100)}
      >
        {/* Subtle Horizontal Dial Grooves Background */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: "repeating-linear-gradient(180deg, transparent, transparent 5px, rgba(45, 212, 191, 0.08) 6px)",
            pointerEvents: "none",
          }}
        />

        {/* Graduated Tick Marks on Track */}
        {TICKS.map((t) => {
          const tNorm = (t.level - minZoom) / (maxZoom - minZoom);
          const topPercent = (1 - tNorm) * 100;
          const isNear = Math.abs(zoom - t.level) < 0.1;
          return (
            <div
              key={t.level}
              onClick={(e) => {
                e.stopPropagation();
                onZoomChange(clampZoom(t.level));
              }}
              title={`Snap to ${t.label}`}
              style={{
                position: "absolute",
                top: `${topPercent}%`,
                left: 0,
                right: 0,
                transform: "translateY(-50%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 4px",
                cursor: "pointer",
                pointerEvents: "auto",
              }}
            >
              <span
                style={{
                  width: t.level === 1.0 ? "10px" : "6px",
                  height: "1.5px",
                  background: isNear ? "#2dd4bf" : t.level === 1.0 ? "rgba(45, 212, 191, 0.7)" : "rgba(255, 255, 255, 0.25)",
                }}
              />
              <span
                style={{
                  fontSize: "7px",
                  color: isNear ? "#5eead4" : t.level === 1.0 ? "rgba(45, 212, 191, 0.8)" : "rgba(255, 255, 255, 0.35)",
                  fontWeight: t.level === 1.0 || isNear ? 700 : 400,
                }}
              >
                {t.label}
              </span>
            </div>
          );
        })}

        {/* Dynamic Dial Laser Thumb / Indicator */}
        <div
          style={{
            position: "absolute",
            top: `${percentY}%`,
            left: 0,
            right: 0,
            transform: "translateY(-50%)",
            height: "18px",
            background: "rgba(45, 212, 191, 0.28)",
            borderTop: "1.5px solid #2dd4bf",
            borderBottom: "1.5px solid #2dd4bf",
            boxShadow: "0 0 12px rgba(45, 212, 191, 0.5), inset 0 0 6px rgba(45, 212, 191, 0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            transition: isDragging ? "none" : "top 0.08s ease-out",
          }}
        >
          <div
            style={{
              width: "16px",
              height: "2px",
              background: "#fff",
              borderRadius: "1px",
              boxShadow: "0 0 4px #2dd4bf",
            }}
          />
        </div>
      </div>

      {/* Step Zoom Out Button (-) */}
      <button
        type="button"
        onClick={handleStepDown}
        title="Zoom Out (-15%)"
        style={{
          width: "36px",
          height: "22px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(45, 212, 191, 0.12)",
          border: "1px solid rgba(45, 212, 191, 0.35)",
          borderRadius: "3px",
          color: "#99f6e4",
          fontSize: "13px",
          fontWeight: "bold",
          cursor: "pointer",
          marginTop: "6px",
          transition: "all 0.12s ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(45, 212, 191, 0.25)";
          e.currentTarget.style.color = "#fff";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "rgba(45, 212, 191, 0.12)";
          e.currentTarget.style.color = "#99f6e4";
        }}
      >
        -
      </button>

      {/* Zoom Readout Value */}
      <div
        style={{
          fontSize: "9px",
          fontWeight: "bold",
          color: "#2dd4bf",
          marginTop: "6px",
          textAlign: "center",
        }}
      >
        {Math.round(zoom * 100)}%
      </div>

      {/* Quick Action: 1:1 Reset or Fit */}
      <div style={{ display: "flex", gap: "3px", marginTop: "4px", width: "100%" }}>
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            title="Reset to 100% (1:1)"
            style={{
              flex: 1,
              background: zoom === 1.0 ? "rgba(45, 212, 191, 0.25)" : "transparent",
              border: "1px solid rgba(45, 212, 191, 0.3)",
              borderRadius: "2px",
              color: zoom === 1.0 ? "#5eead4" : "rgba(255, 255, 255, 0.6)",
              fontSize: "7.5px",
              padding: "2px 0",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            1:1
          </button>
        )}
        {onFit && (
          <button
            type="button"
            onClick={onFit}
            title="Auto Fit to Screen"
            style={{
              flex: 1,
              background: "rgba(45, 212, 191, 0.15)",
              border: "1px solid rgba(45, 212, 191, 0.4)",
              borderRadius: "2px",
              color: "#2dd4bf",
              fontSize: "7.5px",
              fontWeight: 600,
              padding: "2px 0",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            FIT
          </button>
        )}
      </div>
    </div>
  );
}
