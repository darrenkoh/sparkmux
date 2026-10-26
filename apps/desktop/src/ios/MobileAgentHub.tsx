import { useEffect } from "react";

import { agentAttentionRank } from "./posture";
import { extractQuickOptions, quickOptionBytes, type QuickOption } from "./quickReplyLogic";

export interface HubAgent {
  session: string;
  windowId: string;
  windowName: string;
  paneId: string;
  state: string;
  model: string;
  detail: string;
  pendingAsk: string;
  waiting: boolean;
}

export interface HubWindow {
  id: string;
  name: string;
  paneCount: number;
  attention: boolean;
}

export interface HubSession {
  name: string;
  windows: HubWindow[];
}

export interface MobileAgentHubProps {
  agents: HubAgent[];
  sessions: HubSession[];
  onClose: () => void;
  onOpenAgent: (session: string, windowId: string, paneId: string) => void;
  onSend: (paneId: string, bytes: number[]) => void;
  onSelectWindow: (sessionName: string, windowId: string) => void;
  onNewSession: () => void;
  onNewTab: (sessionName: string) => void;
  onCloseTab: (sessionName: string, windowId: string) => void;
  onCloseSession: (sessionName: string) => void;
}

function orderOf(agent: HubAgent): number {
  if (agent.waiting) return 0;
  return agentAttentionRank(agent.state);
}

export default function MobileAgentHub({
  agents,
  sessions,
  onClose,
  onOpenAgent,
  onSend,
  onSelectWindow,
  onNewSession,
  onNewTab,
  onCloseTab,
  onCloseSession,
}: MobileAgentHubProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ranked = [...agents].sort(
    (a, b) => orderOf(a) - orderOf(b) || a.windowName.localeCompare(b.windowName),
  );
  const needs = ranked.filter((agent) => agent.waiting);
  const active = ranked.filter((agent) => !agent.waiting);

  function sendOption(paneId: string, option: QuickOption) {
    onSend(paneId, quickOptionBytes(option));
  }

  return (
    <div className="mobile-agent-hub" role="dialog" aria-modal="true" aria-label="Agents and sessions">
      <header className="hub-bar">
        <h1>⚡ Agents</h1>
        <button type="button" onClick={onNewSession}>
          + New Session
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="hub-scroll">
        <section aria-label="Needs input">
          <h2>Needs input ({needs.length})</h2>
          {needs.length === 0 && <p className="hub-empty">No agents are waiting.</p>}
          {needs.map((agent) => {
            const question = (agent.pendingAsk || agent.detail).trim();
            const options = extractQuickOptions(question);
            return (
              <article key={`${agent.session}:${agent.paneId}`} className="hub-agent waiting">
                <header>
                  <strong>
                    {agent.session} › {agent.windowName} ({agent.paneId})
                  </strong>
                  <span>{agent.model || agent.state}</span>
                </header>
                {question && <p>{question}</p>}
                <div className="hub-actions">
                  {options.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      onClick={() => sendOption(agent.paneId, option)}
                    >
                      {option.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => onOpenAgent(agent.session, agent.windowId, agent.paneId)}
                  >
                    Open →
                  </button>
                </div>
              </article>
            );
          })}
        </section>

        <section aria-label="Active agents">
          <h2>Active agents ({active.length})</h2>
          {active.map((agent) => (
            <article key={`${agent.session}:${agent.paneId}`} className="hub-agent">
              <header>
                <strong>
                  {agent.state} · {agent.session} › {agent.windowName} ({agent.paneId})
                </strong>
                <span>{agent.model}</span>
              </header>
              {agent.detail.trim() && <p>{agent.detail}</p>}
              <div className="hub-actions">
                <button
                  type="button"
                  onClick={() => onOpenAgent(agent.session, agent.windowId, agent.paneId)}
                >
                  Open →
                </button>
              </div>
            </article>
          ))}
        </section>

        <section aria-label="All sessions and windows">
          <h2>All sessions</h2>
          {sessions.map((session) => (
            <div key={session.name} className="hub-session">
              <div className="hub-session-head">
                <strong>{session.name}</strong>
                <button type="button" onClick={() => onNewTab(session.name)}>
                  + New Tab
                </button>
                <button type="button" onClick={() => onCloseSession(session.name)}>
                  Close session
                </button>
              </div>
              <div className="hub-window-grid">
                {session.windows.map((win) => (
                  <div key={win.id} className="hub-window-card">
                    <button type="button" onClick={() => onSelectWindow(session.name, win.id)}>
                      <span>{win.name || win.id}</span>
                      <small>
                        {win.paneCount} pane{win.paneCount === 1 ? "" : "s"}
                        {win.attention ? " · waiting" : ""}
                      </small>
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${win.name || win.id}`}
                      onClick={() => onCloseTab(session.name, win.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
