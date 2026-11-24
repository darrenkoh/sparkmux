export interface FocusTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  classList?: { contains(token: string): boolean };
}

export function canFocusTerminal(
  activeElement: FocusTargetLike | null | undefined,
): boolean {
  if (!activeElement) return true;
  if (activeElement.classList?.contains("xterm-helper-textarea")) return true;
  const tag = activeElement.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  if (activeElement.isContentEditable) return false;
  return true;
}
