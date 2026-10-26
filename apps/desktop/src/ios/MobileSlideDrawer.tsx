export interface MobileSlideDrawerProps {
  side: "left" | "right";
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

/** Closed drawers render nothing, so the terminal stage keeps the full width. */
export default function MobileSlideDrawer({
  side,
  open,
  title,
  onClose,
  children,
}: MobileSlideDrawerProps) {
  if (!open) return null;
  return (
    <aside
      className={`mobile-slide-drawer ${side}`}
      role="dialog"
      aria-label={title}
    >
      <header className="mobile-drawer-head">
        <strong>{title}</strong>
        <button type="button" onClick={onClose} aria-label={`Close ${title}`}>
          ✕
        </button>
      </header>
      <div className="mobile-drawer-body">{children}</div>
    </aside>
  );
}
