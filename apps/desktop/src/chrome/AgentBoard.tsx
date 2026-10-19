import { boardSelectTarget, type AgentBoardRow } from "./agentBoard";

function stateClass(state: string): string {
  if (state === "Waiting on you") return "waiting";
  if (state === "Failed") return "failed";
  if (state === "Finished") return "finished";
  return "running";
}

export default function AgentBoard({
  rows,
  onSelect,
}: {
  rows: AgentBoardRow[];
  onSelect: (session: string, windowId: string, paneId: string) => void;
}) {
  return (
    <section className="agent-board" aria-label="Agents">
      <div className="agent-board-title">Agents</div>
      {rows.length === 0 ? (
        <div className="agent-board-empty">No agents on this socket</div>
      ) : (
        <ul className="agent-board-list">
          {rows.map((row) => (
            <li key={`${row.session}:${row.pane_id}`}>
              <button
                type="button"
                className="agent-row"
                onClick={() => {
                  const target = boardSelectTarget(row);
                  onSelect(target.session, target.windowId, target.paneId);
                }}
              >
                <span className="agent-row-top">
                  <span className={`agent-state ${stateClass(row.state)}`}>{row.state}</span>
                  <span className="agent-where">
                    {row.session} · {row.window_name}
                  </span>
                  <span className="agent-model">{row.model}</span>
                </span>
                {row.detail && <span className="agent-detail">{row.detail}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
