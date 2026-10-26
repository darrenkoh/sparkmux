/** A session the private tmux server still has. */
export interface OffScreenSession {
  name: string;
  /** True when some tmux client is attached. The desktop tiles may still be elsewhere. */
  attached: boolean;
  windows: OffScreenWindow[];
}

export interface OffScreenWindow {
  name: string;
  active: boolean;
  panes: OffScreenPane[];
}

export interface OffScreenPane {
  command: string;
  active: boolean;
}

/**
 * Sessions that are still on `-L sparkmux` while the terminal is showing a
 * different session. A missing visible name means the tiles are showing none
 * of them.
 */
export function offScreenSessions<T extends { name: string }>(
  sessions: readonly T[],
  visibleSession: string | null,
): T[] {
  if (!visibleSession) return [...sessions];
  return sessions.filter((session) => session.name !== visibleSession);
}

/** One-line description of what that session is running. */
export function offScreenHint(session: OffScreenSession): string {
  const win = session.windows.find((window) => window.active) ?? session.windows[0];
  const pane = win?.panes.find((item) => item.active) ?? win?.panes[0];
  const winName = win?.name.trim() ?? "";
  const command = pane?.command.trim() ?? "";
  const parts = [`${session.windows.length}w`];
  if (winName) parts.push(winName);
  if (command && command !== winName) parts.push(command);
  if (session.attached) parts.push("client attached");
  return parts.join(" · ");
}
