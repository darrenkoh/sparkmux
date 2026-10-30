import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { agentOffice } from "../../api.ts";
import type { Snapshot } from "../../types.ts";
import { boardPanesFromSnapshot } from "../agentBoard.ts";
import { layoutOffice } from "./officeLayout.ts";
import {
  CLI_ACCENT,
  agentColor,
  TEAM_RENAME_MS,
  agentForPick,
  agentKey,
  callsign,
  counters,
  diffFeed,
  poseAfterSucceeded,
  resolvePose,
  softFeedDue,
  statusText,
  teamClickPlan,
  teamOrder,
} from "./officeModel.ts";
import { createSim } from "./officeSim.ts";
import { mountOffice, type OfficeHandle, type StageAgent } from "./OfficeStage.ts";
import type { FeedLine, OfficeAgent, OfficeSnapshot, TimeOfDay } from "./officeTypes.ts";
import "./office.css";

const NAMES_KEY = "sparkmux.office.names";
const TOD_KEY = "sparkmux.office.tod";
const NAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_MS = 2000;
const TODS: TimeOfDay[] = ["now", "day", "evening", "night"];

const LEGEND: Array<{ label: string; color: string }> = [
  { label: "Coding", color: "#8b7cf6" },
  { label: "Browsing", color: "#4ade80" },
  { label: "In terminal", color: "#f59e0b" },
  { label: "Thinking", color: "#facc15" },
  { label: "Error", color: "#ef4444" },
  { label: "Idle", color: "#6b7280" },
];

interface StoredName {
  name: string;
  seen: number;
}

export default function OfficeView(props: {
  snap: Snapshot;
  onClose?: () => void;
  onPopOut?: () => void;
  onSelectAgent: (session: string, windowId: string, paneId: string) => void;
  onOpenStats?: (session: string, windowId: string, paneId: string) => void;
  variant: "overlay" | "popout";
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<OfficeHandle | null>(null);
  const namesRef = useRef<Map<string, string>>(loadNames());
  const prevRef = useRef<OfficeSnapshot | null>(null);
  const softRef = useRef<Map<string, number>>(new Map());
  const succeededRef = useRef<Map<string, number>>(new Map());
  const orderedRef = useRef<OfficeAgent[]>([]);
  const goToAgentRef = useRef<(agent: OfficeAgent) => void>(() => {});
  const pendingNav = useRef<number | undefined>(undefined);
  const [office, setOffice] = useState<OfficeSnapshot | null>(null);
  const [stale, setStale] = useState(false);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [webglOk, setWebglOk] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [simMode, setSimMode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("window") === "office" && params.get("sim") === "1";
  });
  const [tod, setTod] = useState<TimeOfDay>(() => readTod());
  const [glow, setGlow] = useState(false);
  const [namesVersion, setNamesVersion] = useState(0);
  const [poseTick, setPoseTick] = useState(0);

  const panes = useMemo(() => boardPanesFromSnapshot(props.snap), [props.snap]);
  const panesKey = useMemo(() => JSON.stringify(panes), [panes]);

  useEffect(() => {
    if (simMode) return;
    let cancel = false;
    let inflight = false;
    const load = () => {
      if (cancel || document.hidden || inflight) return;
      inflight = true;
      void agentOffice(panes)
        .then((next) => {
          if (cancel) return;
          setOffice(next);
          setStale(false);
        })
        .catch(() => {
          if (!cancel) setStale(true);
        })
        .finally(() => {
          inflight = false;
        });
    };
    const debounce = window.setTimeout(load, 250);
    const timer = window.setInterval(load, POLL_MS);
    const onVis = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancel = true;
      window.clearTimeout(debounce);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [panes, panesKey, simMode]);

  useEffect(() => {
    if (!simMode) return;
    const sim = createSim(1, 8);
    const tick = () => setOffice(sim.tick(Date.now()));
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(timer);
  }, [simMode]);

  useEffect(() => {
    if (!office) return;
    const taken = new Set(namesRef.current.values());
    let changed = false;
    const now = Date.now();
    for (const agent of office.agents) {
      const key = agentKey(agent);
      if (!namesRef.current.has(key)) {
        const name = callsign(key, taken);
        namesRef.current.set(key, name);
        taken.add(name);
        changed = true;
      }
    }
    if (changed) {
      saveNames(namesRef.current, now);
      setNamesVersion((version) => version + 1);
    }
    const lines = diffFeed(prevRef.current, office, namesRef.current, now).filter((line) => {
      const soft = line.text.endsWith("is thinking") || line.text.endsWith("is replying");
      if (!soft) return true;
      if (!softFeedDue(softRef.current.get(line.key), line.at)) return false;
      softRef.current.set(line.key, line.at);
      return true;
    });
    if (lines.length > 0) {
      setFeed((prev) => [...lines].reverse().concat(prev).slice(0, 200));
    }
    prevRef.current = office;
    const anySucceeded = office.agents.some((agent) => agent.state === "succeeded");
    for (const agent of office.agents) {
      const key = agentKey(agent);
      if (agent.state === "succeeded") {
        if (!succeededRef.current.has(key)) succeededRef.current.set(key, now);
      } else succeededRef.current.delete(key);
    }
    if (!anySucceeded) return;
    const timer = window.setInterval(() => setPoseTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [office]);

  const ordered = useMemo(() => teamOrder(office?.agents ?? []), [office]);
  orderedRef.current = ordered;
  const counted = office ? counters(office) : { working: 0, needYou: 0, idle: 0, freeDesks: 0 };
  const layoutKey = useMemo(() => {
    if (!office) return "";
    const groups = new Map<string, string[]>();
    for (const agent of office.agents) {
      const key = agentKey(agent);
      const list = groups.get(agent.session) ?? [];
      list.push(key);
      groups.set(agent.session, list);
    }
    for (const desk of office.free_desks) {
      const key = `${desk.session}:${desk.pane_id}`;
      const list = groups.get(desk.session) ?? [];
      list.push(key);
      groups.set(desk.session, list);
    }
    return JSON.stringify([...groups.entries()]);
  }, [office]);
  const layout = useMemo(() => {
    if (!layoutKey) return null;
    const groups = JSON.parse(layoutKey) as Array<[string, string[]]>;
    return layoutOffice(groups.map(([session, keys]) => ({ session, keys })));
  }, [layoutKey]);

  const stageAgents = useMemo<StageAgent[]>(() => {
    void namesVersion;
    void poseTick;
    return ordered.map((agent) => {
      const key = agentKey(agent);
      const pose =
        agent.state === "succeeded"
          ? poseAfterSucceeded(Date.now() - (succeededRef.current.get(key) ?? Date.now()))
          : resolvePose(agent);
      const cli = agent.cli === "grok" || agent.cli === "antigravity" || agent.cli === "claude" ? agent.cli : "claude";
      return {
        key,
        name: namesRef.current.get(key) ?? "Agent",
        color: agentColor(key),
        accent: CLI_ACCENT[cli],
        pose: pose.pose,
        zone: pose.zone,
        marker: pose.marker,
        deskKey: key,
        ask: agent.ask,
        state: agent.state,
      };
    });
  }, [ordered, namesVersion, poseTick]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !webglOk) return;
    let handle: OfficeHandle;
    try {
      handle = mountOffice(host, {
        onPick: (key) => {
          const agent = agentForPick(orderedRef.current, key);
          if (!agent) {
            stageRef.current?.focus(null);
            setSelected(null);
            return;
          }
          goToAgentRef.current(agent);
        },
        onHover: (key, screen) => {
          setHover(key && screen ? { key, x: screen.x, y: screen.y } : null);
        },
      });
    } catch {
      setWebglOk(false);
      return;
    }
    stageRef.current = handle;
    handle.setTimeOfDay(tod);
    return () => {
      handle.dispose();
      stageRef.current = null;
    };
    // The stage is created once. Time of day is pushed by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webglOk]);

  useEffect(() => {
    if (!layout) return;
    stageRef.current?.update({ layout, agents: stageAgents });
  }, [layout, stageAgents]);

  useEffect(() => {
    stageRef.current?.setGlow(glow);
  }, [glow]);

  useEffect(() => {
    stageRef.current?.setTimeOfDay(tod);
    try {
      window.localStorage.setItem(TOD_KEY, tod);
    } catch {
      /* private mode */
    }
  }, [tod]);

  useEffect(() => {
    const root = hostRef.current?.parentElement;
    if (!root) return;
    const observer = new ResizeObserver(() => setNarrow(root.clientWidth < 900));
    observer.observe(root);
    setNarrow(root.clientWidth < 900);
    return () => observer.disconnect();
  }, [webglOk]);

  const goToAgent = useCallback(
    (agent: OfficeAgent) => {
      const key = agentKey(agent);
      stageRef.current?.focus(key);
      setSelected(key);
      props.onSelectAgent(agent.session, agent.window_id, agent.pane_id);
    },
    [props],
  );
  goToAgentRef.current = goToAgent;

  const onTeamClick = (agent: OfficeAgent, clickCount: number) => {
    if (teamClickPlan(clickCount) === "rename") {
      if (pendingNav.current !== undefined) {
        window.clearTimeout(pendingNav.current);
        pendingNav.current = undefined;
      }
      setEditing(agentKey(agent));
      return;
    }
    if (pendingNav.current !== undefined) window.clearTimeout(pendingNav.current);
    pendingNav.current = window.setTimeout(() => {
      pendingNav.current = undefined;
      goToAgent(agent);
    }, TEAM_RENAME_MS);
  };

  useEffect(() => {
    return () => {
      if (pendingNav.current !== undefined) window.clearTimeout(pendingNav.current);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (event.key === "Escape" && props.variant === "overlay") {
        props.onClose?.();
        return;
      }
      if (event.key >= "1" && event.key <= "4") {
        const next = TODS[Number(event.key) - 1];
        if (next) setTod(next);
        return;
      }
      if (ordered.length === 0) return;
      if (event.key === "Tab") {
        event.preventDefault();
        const current = selected ? ordered.findIndex((agent) => agentKey(agent) === selected) : -1;
        const step = event.shiftKey ? -1 : 1;
        const index = (current + step + ordered.length) % ordered.length;
        const agent = ordered[index];
        if (!agent) return;
        const key = agentKey(agent);
        setSelected(key);
        stageRef.current?.focus(key);
      } else if (event.key === "Enter" && selected) {
        const agent = ordered.find((row) => agentKey(row) === selected);
        if (agent) goToAgent(agent);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goToAgent, ordered, props, selected]);

  const hovered = hover ? ordered.find((agent) => agentKey(agent) === hover.key) : undefined;
  const summary = `${counted.working} working, ${counted.needYou} need you, ${counted.idle} idle, ${counted.freeDesks} free desks`;

  return (
    <div className={`office-overlay${props.variant === "popout" ? " popout" : ""}`}>
      <section className="office-frame" role="dialog" aria-label="Agent office">
        <header className="office-header">
          <div className="office-title">
            <span>Agent Office · sparkmux</span>
            <span className={`office-chip${simMode ? " sim" : ""}`}>{simMode ? "SIMULATION" : "LIVE"}</span>
            {stale && <span className="office-chip stale">stale</span>}
          </div>
          <div className="office-counters">
            <span>{counted.working} working</span>
            <span>{counted.needYou} need you</span>
            <span>{counted.idle} idle</span>
            <span>{counted.freeDesks} free desks</span>
          </div>
          <div className="office-header-actions">
            {narrow && (
              <button type="button" onClick={() => setPanelOpen((open) => !open)}>
                Team
              </button>
            )}
            {props.onPopOut && (
              <button type="button" onClick={props.onPopOut}>
                Pop out
              </button>
            )}
            {props.onClose && (
              <button type="button" onClick={props.onClose} aria-label="Close office">
                Close
              </button>
            )}
          </div>
        </header>
        <div className="office-body">
          <div className="office-stage-wrap">
            {webglOk ? (
              <div ref={hostRef} className="office-stage-host" role="img" aria-label={summary} />
            ) : (
              <div className="office-fallback" role="img" aria-label={summary}>
                WebGL is unavailable. The team list still shows every agent.
              </div>
            )}
            <div className="office-legend">
              {LEGEND.map((item) => (
                <span key={item.label}>
                  <i style={{ background: item.color }} />
                  {item.label}
                </span>
              ))}
            </div>
            <div className="office-tod" role="group" aria-label="Time of day">
              {TODS.map((mode) => (
                <button key={mode} type="button" className={tod === mode ? "on" : ""} onClick={() => setTod(mode)}>
                  {mode}
                </button>
              ))}
            </div>
            <button type="button" className="office-glow" onClick={() => setGlow((on) => !on)} aria-pressed={glow}>
              Glow
            </button>
            <button type="button" className="office-sim" onClick={() => setSimMode((on) => !on)}>
              {simMode ? "Stop Simulation" : "Simulation"}
            </button>
            {office && office.agents.length === 0 && (
              <p className="office-empty">No agents on this socket. Start `claude`, `grok`, or `agy` in a pane.</p>
            )}
            {hovered && hover && (
              <aside className="office-hover" style={{ left: hover.x + 12, top: hover.y + 12 }}>
                <strong>{namesRef.current.get(agentKey(hovered)) ?? "Agent"}</strong>
                <span>
                  {hovered.cli} · {hovered.model}
                </span>
                <span>
                  {hovered.session} · {hovered.window_name}
                </span>
                <span>{hovered.project}</span>
                <span>{statusText(hovered)}</span>
                <ul>
                  {hovered.recent.slice(-6).map((step) => (
                    <li key={step.id}>
                      {step.kind}: {step.text || step.label}
                    </li>
                  ))}
                </ul>
                <span>{relativeTime(hovered.last_activity_ms, office?.now_ms ?? Date.now())}</span>
                <div>
                  <button type="button" onClick={() => goToAgent(hovered)}>
                    Go to pane
                  </button>
                  {props.onOpenStats && (
                    <button
                      type="button"
                      onClick={() => props.onOpenStats?.(hovered.session, hovered.window_id, hovered.pane_id)}
                    >
                      Open Stats
                    </button>
                  )}
                </div>
              </aside>
            )}
          </div>
          {(panelOpen || !narrow) && (
            <aside className="office-side">
              <h2>Team</h2>
              <ul className="office-team">
                {ordered.map((agent) => {
                  const key = agentKey(agent);
                  const name = namesRef.current.get(key) ?? "Agent";
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        className={selected === key ? "selected" : ""}
                        onClick={() => onTeamClick(agent, 1)}
                        onDoubleClick={() => onTeamClick(agent, 2)}
                        onMouseEnter={() => stageRef.current?.highlight(key)}
                        onMouseLeave={() => stageRef.current?.highlight(null)}
                      >
                        <i style={{ background: stateColor(agent.state) }} />
                        {editing === key ? (
                          <input
                            autoFocus
                            defaultValue={name}
                            aria-label={`Rename ${name}`}
                            onClick={(event) => event.stopPropagation()}
                            onBlur={(event) => rename(key, event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") rename(key, event.currentTarget.value);
                              if (event.key === "Escape") setEditing(null);
                            }}
                          />
                        ) : (
                          <strong>{name}</strong>
                        )}
                        <em>{agent.window_name || agent.project}</em>
                        <span style={{ color: stateColor(agent.state) }}>{statusText(agent)}</span>
                        <small>{agent.detail}</small>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <h2>Activity</h2>
              <ul className="office-feed">
                {feed.map((line) => (
                  <li key={line.id} data-tone={line.tone}>
                    <time>{formatClock(line.at)}</time>
                    <span>{line.text}</span>
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </div>
      </section>
    </div>
  );

  function rename(key: string, value: string) {
    const next = value.trim();
    if (next) {
      namesRef.current.set(key, next);
      saveNames(namesRef.current, Date.now());
      setNamesVersion((version) => version + 1);
    }
    setEditing(null);
  }
}

function stateColor(state: string): string {
  if (state === "needs_user") return "#f97316";
  if (state === "failed") return "#ef4444";
  if (state === "succeeded") return "#22c55e";
  if (state === "idle") return "#6b7280";
  return "#8b7cf6";
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function relativeTime(then: number, now: number): string {
  if (!then) return "last activity unknown";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `last activity ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `last activity ${minutes}m ago`;
}

function loadNames(): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const raw = window.localStorage.getItem(NAMES_KEY);
    if (!raw) return names;
    const parsed = JSON.parse(raw) as Record<string, StoredName>;
    const now = Date.now();
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value.name !== "string") continue;
      if (now - value.seen > NAME_TTL_MS) continue;
      names.set(key, value.name);
    }
  } catch {
    /* ignore broken storage */
  }
  return names;
}

function saveNames(names: Map<string, string>, now: number) {
  const stored: Record<string, StoredName> = {};
  for (const [key, name] of names) stored[key] = { name, seen: now };
  try {
    window.localStorage.setItem(NAMES_KEY, JSON.stringify(stored));
  } catch {
    /* private mode */
  }
}

function readTod(): TimeOfDay {
  try {
    const value = window.localStorage.getItem(TOD_KEY);
    if (value === "now" || value === "day" || value === "evening" || value === "night") return value;
  } catch {
    /* private mode */
  }
  return "now";
}
