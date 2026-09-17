import type { GuiError, TmuxStatus } from "../types";

export default function ErrorPanel({
  error,
  status,
  onRetry,
  onStart,
  onNewSession,
}: {
  error: GuiError;
  status: TmuxStatus | null;
  onRetry: () => void;
  onStart: () => void;
  onNewSession: () => void;
}) {
  if (error === "missing-tmux") {
    return (
      <div className="panel">
        <h1>tmux not found</h1>
        <p>
          sparkmux needs tmux 3.2 or newer on this machine. Install it, then retry.
        </p>
        <pre>brew install tmux
sudo apt install tmux</pre>
        {status?.hint && <p className="hint">{status.hint}</p>}
        <button onClick={onRetry}>Retry</button>
      </div>
    );
  }
  if (error === "too-old") {
    return (
      <div className="panel">
        <h1>tmux is too old</h1>
        <p>{status?.hint ?? "sparkmux requires tmux 3.2 or newer."}</p>
        <button onClick={onRetry}>Retry</button>
      </div>
    );
  }
  if (error === "server-stopped") {
    return (
      <div className="panel">
        <h1>tmux server stopped</h1>
        <p>
          The dedicated <code>-L {status?.socket_name ?? "sparkmux"}</code> server was
          killed. Start recreates the default session.
        </p>
        <button onClick={onStart}>Start</button>
      </div>
    );
  }
  if (error === "control-dead") {
    return (
      <div className="panel">
        <h1>control client disconnected</h1>
        <p>The tmux control connection exited. Sessions may still exist.</p>
        <button onClick={onRetry}>Reconnect</button>
        <button onClick={onNewSession}>New Session…</button>
      </div>
    );
  }
  return (
    <div className="panel">
      <h1>No sessions</h1>
      <p>
        The <code>-L {status?.socket_name ?? "sparkmux"}</code> server has no sessions.
        Create one — this will not spawn a leftover <code>main</code>.
      </p>
      <button onClick={onNewSession}>New Session…</button>
    </div>
  );
}
