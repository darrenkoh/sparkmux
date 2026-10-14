import { useEffect, useMemo, useRef, useState } from "react";
import {
  chronicleHologram,
  chronicleSession,
  clearChronicleCache,
  type ChronicleHologram as HologramPayload,
  type ChronicleSession,
} from "../api";
import ChronicleHologramPanel, { chroniclePanelBanners, chroniclePanelText } from "./ChronicleHologram";
import { mountChronicle, type ChronicleHandle, type ChronicleHooks } from "./ChronicleStage";
import { isNewestScrubStop, stepScrub, type ChronicleKeyAction, type ChronicleKeyState } from "./chronicleKeys";
import {
  type ChronicleScene,
  type StationLayoutInput,
} from "./chronicleLayout";
import {
  acceptHologram,
  generationFromSession,
  resolveActiveAfterPoll,
  sameGeneration,
  shouldRefetchHologram,
  type ChronicleGeneration,
} from "./chroniclePoll";

function asKind(kind: string): StationLayoutInput["kind"] {
  if (kind === "replace" || kind === "write" || kind === "delete" || kind === "patch" || kind === "notebook") {
    return kind;
  }
  return "patch";
}

function asOutcome(outcome: string): StationLayoutInput["outcome"] {
  if (outcome === "ok" || outcome === "error" || outcome === "unknown") return outcome;
  return "unknown";
}

function timeLabel(ms: number | null | undefined): string {
  if (ms == null) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString();
}

export default function ChronicleView(props: {
  command: string;
  cwd: string;
  title: string;
  pid: number;
  onKeyContext: (state: ChronicleKeyState) => void;
  applyRef: { current: (action: ChronicleKeyAction) => void };
}) {
  const { command, cwd, title, pid, onKeyContext, applyRef } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ChronicleHandle | null>(null);
  const [session, setSession] = useState<ChronicleSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [tab, setTab] = useState<"file" | "diff">("file");
  const [hologram, setHologram] = useState<HologramPayload | null>(null);
  const [hologramError, setHologramError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pollNonce, setPollNonce] = useState(0);
  const [scene, setScene] = useState<ChronicleScene>("transit");
  const activeRef = useRef<string | null>(null);
  const newestRef = useRef<string | null>(null);
  const genRef = useRef<ChronicleGeneration | null>(null);
  const pathRef = useRef<string | null>(null);
  const appliedRef = useRef<{ id: string; generation: ChronicleGeneration } | null>(null);
  const failedHologramRef = useRef<{ id: string; generation: ChronicleGeneration } | null>(null);
  const hooksRef = useRef<ChronicleHooks>({ onActiveId: () => {} });

  const activeStation = session?.stations.find((station) => station.id === activeId) ?? null;
  const activePath = activeId?.startsWith("now:") ? activeId.slice(4) : (activeStation?.path ?? pathRef.current);
  if (activePath) pathRef.current = activePath;

  const nowAvailable = (path: string) =>
    session?.now.some((entry) => entry.path === path && entry.available) ?? false;

  const select = (id: string | null, nextStale: boolean) => {
    activeRef.current = id;
    setActiveId(id);
    setStale(nextStale);
  };

  applyRef.current = (action) => {
    if (!action.swallow || !session) return;
    if (action.action === "latest") {
      const path = activePath;
      const latest =
        path && nowAvailable(path) ? `now:${path}` : (session.stations[session.stations.length - 1]?.id ?? null);
      select(latest, false);
      return;
    }
    if (action.action === "step") {
      if (stale) return;
      const nextId = stepScrub(session.stations, activeId ?? "", nowAvailable, action.delta);
      if (nextId) select(nextId, false);
      return;
    }
    if (action.action === "lane") {
      select(action.stationId, false);
      return;
    }
    if (action.action === "scene" && action.scene === "transit") setScene("transit");
  };

  hooksRef.current.onActiveId = (id) => select(id, false);

  useEffect(() => {
    let cancel = false;
    let token = 0;
    // A new pane is not a slid window. Drop the previous station before the next payload.
    activeRef.current = null;
    newestRef.current = null;
    genRef.current = null;
    appliedRef.current = null;
    failedHologramRef.current = null;
    pathRef.current = null;
    setSession(null);
    setActiveId(null);
    setStale(false);
    setHologram(null);
    setHologramError(null);
    setError(null);
    setLoading(false);
    const load = () => {
      const my = ++token;
      chronicleSession(command, cwd, title, pid)
        .then((next) => {
          if (cancel || my !== token) return;
          const generation = generationFromSession(next);
          if (genRef.current && sameGeneration(genRef.current, generation)) {
            if (failedHologramRef.current) setPollNonce((n) => n + 1);
            return;
          }
          const ordered = [...next.stations].sort((a, b) => a.ordinal - b.ordinal);
          const nowIds = next.now.filter((entry) => entry.available).map((entry) => `now:${entry.path}`);
          const resolved = resolveActiveAfterPoll(
            activeRef.current,
            newestRef.current,
            ordered.map((station) => station.id),
            nowIds,
          );
          genRef.current = generation;
          newestRef.current = resolved.newestRealId;
          activeRef.current = resolved.id;
          setSession({ ...next, stations: ordered });
          setActiveId(resolved.id);
          setStale(resolved.stale);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancel || my !== token) return;
          console.error(err);
          setError(err instanceof Error ? err.message : String(err));
        });
    };
    load();
    const interval = setInterval(load, 2500);
    return () => {
      cancel = true;
      clearInterval(interval);
    };
  }, [command, cwd, title, pid]);

  useEffect(() => {
    return () => {
      void clearChronicleCache().catch((err: unknown) => {
        console.error(err);
      });
    };
  }, []);

  useEffect(() => {
    onKeyContext({
      onNewest: isNewestScrubStop(activeId ?? "", session?.stations ?? [], nowAvailable),
      scene,
      files: (session?.files ?? []).map((file) => ({ path: file.path, lane: file.lane })),
      stations: (session?.stations ?? []).map((station) => ({
        id: station.id,
        path: station.path,
        ordinal: station.ordinal,
      })),
      activeId: activeId ?? "",
      nowAvailable,
    });
    // `nowAvailable` closes over `session`. Listing the function would retrigger this effect every render.
  }, [onKeyContext, activeId, session, scene]);

  const layoutStations = useMemo(() => {
    if (!session) return [];
    const real: StationLayoutInput[] = session.stations.map((station) => ({
      id: station.id,
      ordinal: station.ordinal,
      lane: station.lane,
      added: station.added,
      removed: station.removed,
      kind: asKind(station.kind),
      outcome: asOutcome(station.outcome),
      path: station.path,
      preview: station.preview,
    }));
    if (activePath && session.now.some((entry) => entry.path === activePath && entry.available)) {
      const file = session.files.find((entry) => entry.path === activePath);
      real.push({
        id: `now:${activePath}`,
        ordinal: session.stations.length,
        lane: file?.lane ?? 0,
        added: 0,
        removed: 0,
        kind: "now",
        outcome: "ok",
        path: activePath,
        preview: "",
      });
    }
    return real;
  }, [session, activePath]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = mountChronicle(host, hooksRef.current);
    handleRef.current = handle;
    const observer = new ResizeObserver(() => {
      handle.setSize(host.clientWidth, host.clientHeight);
    });
    observer.observe(host);
    handle.setSize(host.clientWidth, host.clientHeight);
    return () => {
      observer.disconnect();
      handleRef.current = null;
      handle.dispose();
    };
  }, []);

  useEffect(() => {
    const nowPaths = session?.now.filter((entry) => entry.available).map((entry) => entry.path) ?? [];
    handleRef.current?.setStations(layoutStations, scene, activeId ?? "", nowPaths);
  }, [layoutStations, scene, activeId, session]);

  useEffect(() => {
    if (!session || !activeId || stale) {
      if (stale) setLoading(false);
      return;
    }
    const generation = generationFromSession(session);
    const next = { id: activeId, generation };
    if (!shouldRefetchHologram(appliedRef.current, next)) return;
    let cancel = false;
    failedHologramRef.current = null;
    setHologramError(null);
    setLoading(true);
    setHologram(null);
    chronicleHologram(command, cwd, title, pid, activeId)
      .then((body) => {
        if (cancel) return;
        const current = genRef.current;
        const currentId = activeRef.current ?? "";
        if (!current || !acceptHologram(body.station_id, currentId, generation, current)) {
          setLoading(false);
          return;
        }
        appliedRef.current = next;
        failedHologramRef.current = null;
        setHologram(body);
        setHologramError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancel) return;
        console.error(err);
        failedHologramRef.current = next;
        setHologramError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [session, activeId, stale, command, cwd, title, pid, pollNonce]);

  const newestReal = session?.stations[session.stations.length - 1]?.id ?? null;
  const showLive =
    !stale && newestReal != null && activeId != null && activeId !== newestReal && !activeId.startsWith("now:");
  const preview = activeStation?.preview ?? "";
  const text = chroniclePanelText({ tab, loading, preview, hologram });
  const banners = chroniclePanelBanners(hologram);
  const when = timeLabel(activeStation?.timestamp_ms);
  const panelTitle =
    activePath == null
      ? ""
      : activeId?.startsWith("now:")
        ? `${activePath} · Now`
        : `${activePath} · #${activeStation?.ordinal ?? ""} · ${activeStation?.tool ?? ""} · +${activeStation?.added ?? 0} −${activeStation?.removed ?? 0}${when ? ` · ${when}` : ""}`;

  return (
    <div className="graph-stage chronicle-view">
      <div ref={hostRef} className="chronicle-canvas-host" />
      <div className="chronicle-status">
        {error && (
          <div>
            <b>SCAN FAILED</b>
            <span>{error}</span>
          </div>
        )}
        {!session && !error && (
          <div>
            <b>READING SESSION…</b>
            <span>Gathering the focused pane's agent edits.</span>
          </div>
        )}
        {session?.empty_reason && (
          <div>
            <b>{session.empty_reason}</b>
            <span>
              Chronicle follows the focused pane's Grok, Claude, or Antigravity session and does not read git history.
            </span>
          </div>
        )}
        {(session?.truncated_tail || (session?.omitted ?? 0) > 0) && (
          <p>Showing the latest part of this session. Earlier edits are not loaded.</p>
        )}
        {hologramError && (
          <div>
            <b>SCAN FAILED</b>
            <span>{hologramError}</span>
          </div>
        )}
        {stale && <p>This edit is no longer in the loaded window.</p>}
      </div>
      {showLive && (
        <button
          type="button"
          className="chronicle-live"
          onClick={() => {
            if (newestReal) select(newestReal, false);
          }}
        >
          LIVE
        </button>
      )}
      {activeId && activePath && (
        <ChronicleHologramPanel title={panelTitle} banners={banners} tab={tab} onTab={setTab} text={text} />
      )}
    </div>
  );
}
