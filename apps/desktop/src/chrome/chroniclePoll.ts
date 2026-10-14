export interface ChronicleGeneration {
  transcriptLen: number;
  transcriptMtimeMs: number;
  eventsMtimeMs: number | null;
  truncatedTail: boolean;
  outcomes: string;
  nowMtimes: string;
}

export interface ChronicleGenerationSource {
  transcript_len: number;
  transcript_mtime_ms: number;
  events_mtime_ms: number | null;
  truncated_tail: boolean;
  stations: readonly { id: string; outcome: string; ordinal: number }[];
  now: readonly { path: string; worktree_mtime_ms: number | null }[];
}

export function generationFromSession(session: ChronicleGenerationSource): ChronicleGeneration {
  const stations = [...session.stations].sort((a, b) => a.ordinal - b.ordinal);
  const now = [...session.now].sort((a, b) => a.path.localeCompare(b.path));
  return {
    transcriptLen: session.transcript_len,
    transcriptMtimeMs: session.transcript_mtime_ms,
    eventsMtimeMs: session.events_mtime_ms,
    truncatedTail: session.truncated_tail,
    outcomes: stations.map((station) => `${station.id}=${station.outcome}`).join("\n"),
    nowMtimes: now.map((entry) => `${entry.path}=${entry.worktree_mtime_ms ?? ""}`).join("\n"),
  };
}

export function sameGeneration(a: ChronicleGeneration, b: ChronicleGeneration): boolean {
  return (
    a.transcriptLen === b.transcriptLen &&
    a.transcriptMtimeMs === b.transcriptMtimeMs &&
    a.eventsMtimeMs === b.eventsMtimeMs &&
    a.truncatedTail === b.truncatedTail &&
    a.outcomes === b.outcomes &&
    a.nowMtimes === b.nowMtimes
  );
}

export function shouldRefetchHologram(
  prev: { id: string; generation: ChronicleGeneration } | null,
  next: { id: string; generation: ChronicleGeneration },
): boolean {
  if (!prev || prev.id !== next.id) return true;
  return !sameGeneration(prev.generation, next.generation);
}

export function acceptHologram(
  responseStationId: string,
  activeId: string,
  requestGeneration: ChronicleGeneration,
  currentGeneration: ChronicleGeneration,
): boolean {
  return responseStationId === activeId && sameGeneration(requestGeneration, currentGeneration);
}

export function nextActive(prevId: string, ids: readonly string[]): { id: string; stale: boolean } {
  if (ids.includes(prevId)) return { id: prevId, stale: false };
  return { id: prevId, stale: true };
}

export function resolveActiveAfterPoll(
  prevActiveId: string | null,
  prevNewestRealId: string | null,
  stationIds: readonly string[],
  nowIds: readonly string[],
): { id: string | null; stale: boolean; newestRealId: string | null } {
  const newestRealId = stationIds.length > 0 ? (stationIds[stationIds.length - 1] ?? null) : null;
  const ids = [...stationIds, ...nowIds];
  if (prevActiveId == null) return { id: newestRealId, stale: false, newestRealId };
  if (!ids.includes(prevActiveId)) return { id: prevActiveId, stale: true, newestRealId };
  if (
    prevNewestRealId != null &&
    newestRealId != null &&
    prevActiveId === prevNewestRealId &&
    prevActiveId !== newestRealId
  ) {
    return { id: newestRealId, stale: false, newestRealId };
  }
  return { id: prevActiveId, stale: false, newestRealId };
}
