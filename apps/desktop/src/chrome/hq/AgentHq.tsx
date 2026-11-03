import { useEffect, useMemo, useState } from "react";

import { agentOffice, paneWrite } from "../../api.ts";
import type { QuickOption } from "../../ios/quickReplyLogic.ts";
import type { Snapshot } from "../../types.ts";
import { boardPanesFromSnapshot } from "../agentBoard.ts";
import { CLI_ACCENT, statusText, teamOrder } from "../office/officeModel.ts";
import type { OfficeAgent, OfficeSnapshot } from "../office/officeTypes.ts";
import {
  askOptions,
  EMPTY_COPY,
  hqCounts,
  layoutFloors,
  replyBytes,
  roomName,
  roomSubtitle,
  visualToken,
  type HqFloor,
} from "./hqModel.ts";
import "./hq.css";

const POLL_MS = 2000;
const NAMES_KEY = "sparkmux.office.names";
const NAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export default function AgentHq(props: {
  snap: Snapshot;
  variant: "overlay" | "popout";
  onClose?: () => void;
  onPopOut?: () => void;
  onSelectAgent: (session: string, windowId: string, paneId: string) => void;
  /** Screenshot fixture. When set, the view does not poll and does not read the office sim. */
  fixture?: OfficeSnapshot;
}) {
  const [office, setOffice] = useState<OfficeSnapshot | null>(props.fixture ?? null);
  const [stale, setStale] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [names, setNames] = useState<Map<string, string>>(() => loadOfficeNames());

  const panes = useMemo(
    () => (props.fixture ? [] : boardPanesFromSnapshot(props.snap)),
    [props.fixture, props.snap],
  );
  const panesKey = useMemo(() => JSON.stringify(panes), [panes]);

  useEffect(() => {
    if (props.fixture) {
      setOffice(props.fixture);
      return;
    }
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
  }, [panes, panesKey, props.fixture]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === NAMES_KEY) setNames(loadOfficeNames());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const snapshot = props.fixture ?? office;
  const floors = useMemo(() => (snapshot ? layoutFloors(snapshot) : []), [snapshot]);
  const counts = snapshot ? hqCounts(snapshot.agents) : hqCounts([]);
  const ordered = useMemo(() => teamOrder(snapshot?.agents ?? []), [snapshot]);

  async function send(agent: OfficeAgent, option: QuickOption) {
    const bytes = replyBytes(agent, option);
    if (!bytes) return;
    setReplyError(null);
    try {
      await paneWrite(agent.pane_id, bytes);
    } catch (err) {
      setReplyError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className={`hq-overlay${props.variant === "popout" ? " popout" : ""}`}>
      <section className="hq-frame" role="dialog" aria-label="Agent HQ">
        <header className="hq-header">
          <div className="hq-title">
            <span>Agent HQ · sparkmux</span>
            {props.fixture && <span className="hq-chip fixture">FIXTURE</span>}
            {stale && <span className="hq-chip stale">stale</span>}
          </div>
          <div className="hq-counts">
            <span>{counts.working} working</span>
            <span>{counts.waiting} waiting</span>
            <span>{counts.failed} failed</span>
            <span>{counts.idle} idle</span>
          </div>
          <div className="hq-header-actions">
            {props.onPopOut && (
              <button type="button" onClick={props.onPopOut}>
                Pop out
              </button>
            )}
            {props.onClose && (
              <button type="button" onClick={props.onClose} aria-label="Close Agent HQ">
                Close
              </button>
            )}
          </div>
        </header>
        <div className="hq-body">
          <div className="hq-building" aria-label="Floors">
            <div className="hq-roof" aria-hidden="true" />
            {snapshot && snapshot.agents.length === 0 && <p className="hq-empty">{EMPTY_COPY}</p>}
            {floors.map((floor) => (
              <Floor
                key={floor.session}
                floor={floor}
                names={names}
                onOpen={(agent) => props.onSelectAgent(agent.session, agent.window_id, agent.pane_id)}
              />
            ))}
          </div>
          <aside className="hq-roster">
            <h2>Team</h2>
            {ordered.length === 0 && <p className="hq-roster-empty">No agents yet.</p>}
            <ul>
              {ordered.map((agent) => {
                const key = `${agent.session}:${agent.pane_id}`;
                const name = roomName(agent, names.get(key));
                const options = askOptions(agent);
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className="hq-roster-row"
                      onClick={() => props.onSelectAgent(agent.session, agent.window_id, agent.pane_id)}
                    >
                      <i className={`hq-dot ring-${visualToken(agent.state).ring}`} />
                      <strong>{name}</strong>
                      <em>{agent.session}</em>
                      <span>{statusText(agent)}</span>
                    </button>
                    {agent.state === "needs_user" && (
                      <div className="hq-ask">
                        <p>{agent.ask || agent.detail || "Needs you"}</p>
                        {options.length > 0 && (
                          <div className="hq-pills">
                            {options.map((option) => (
                              <button
                                key={option.label}
                                type="button"
                                onClick={() => {
                                  void send(agent, option);
                                }}
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {replyError && <p className="hq-reply-error">{replyError}</p>}
          </aside>
        </div>
      </section>
    </div>
  );
}

function Floor(props: {
  floor: HqFloor;
  names: Map<string, string>;
  onOpen: (agent: OfficeAgent) => void;
}) {
  const { floor } = props;
  return (
    <section className="hq-floor" aria-label={`${floor.session} floor`}>
      <header>
        <h3>{floor.session}</h3>
        <span>
          {floor.counts.working} run · {floor.counts.waiting} wait · {floor.counts.failed} err
        </span>
      </header>
      <div className="hq-rooms">
        {floor.rooms.map((room) => {
          const token = visualToken(room.agent.state);
          const name = roomName(room.agent, props.names.get(room.key));
          const line = statusText(room.agent);
          const cli = room.agent.cli === "grok" || room.agent.cli === "claude" || room.agent.cli === "antigravity"
            ? room.agent.cli
            : "claude";
          return (
            <button
              key={room.key}
              type="button"
              className="hq-room"
              onClick={() => props.onOpen(room.agent)}
              aria-label={`${name}, ${line}`}
            >
              <span className="hq-figure">
                {token.mark === "zzz" && <span className="hq-zzz">zZ</span>}
                <span
                  className={`hq-blob${token.motion === "bob" ? " bob" : ""}${token.dim ? " dim" : ""}`}
                  style={{ background: cssColor(CLI_ACCENT[cli]) }}
                >
                  <span className="hq-eyes" aria-hidden="true">
                    <i />
                    <i />
                  </span>
                </span>
                <span className={`hq-ring ${token.ring}`} />
              </span>
              <strong>{name}</strong>
              <em>{roomSubtitle(room.agent)}</em>
              <span className="hq-line">{line}</span>
            </button>
          );
        })}
        {floor.shells.map((shell) => (
          <div key={shell.key} className="hq-shell" aria-label={`${shell.windowName || "shell"}, not an agent`}>
            <span>shell</span>
            <strong>{shell.windowName || "shell"}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function cssColor(value: number): string {
  return `#${value.toString(16).padStart(6, "0")}`;
}

function loadOfficeNames(): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const raw = window.localStorage.getItem(NAMES_KEY);
    if (!raw) return names;
    const parsed = JSON.parse(raw) as Record<string, { name?: string; seen?: number }>;
    const now = Date.now();
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value.name !== "string") continue;
      if (typeof value.seen === "number" && now - value.seen > NAME_TTL_MS) continue;
      names.set(key, value.name);
    }
  } catch {
    /* ignore broken storage */
  }
  return names;
}
