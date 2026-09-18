import { useState } from "react";

import type { GuiError, TmuxStatus } from "../types";

function isMac(): boolean {
  return /Mac|iPhone|iPad/i.test(navigator.userAgent);
}

function tmuxInstallCmd(): string {
  return isMac() ? "brew install tmux" : "sudo apt install tmux";
}

function tmuxUpgradeCmd(): string {
  return isMac() ? "brew upgrade tmux" : "sudo apt install --only-upgrade tmux";
}

function CopyCmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="panel-cmd">
      <pre>{cmd}</pre>
      <button
        type="button"
        className="ghost"
        onClick={() => {
          void navigator.clipboard.writeText(cmd).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

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
        <h1>Install tmux to finish setup</h1>
        <p>
          Sparkmux is a desktop front-end for a <strong>private</strong> tmux
          server (<code>-L sparkmux</code>). It never touches your default tmux
          sessions. The app is installed; tmux 3.2+ is the only extra
          dependency.
        </p>
        <ol className="panel-steps">
          <li>Install tmux with the command for this machine.</li>
          <li>Click Retry. Sparkmux will start its own server.</li>
        </ol>
        <CopyCmd cmd={tmuxInstallCmd()} />
        {status?.hint && <p className="hint">{status.hint}</p>}
        <button onClick={onRetry}>Retry</button>
      </div>
    );
  }
  if (error === "too-old") {
    return (
      <div className="panel">
        <h1>tmux is too old</h1>
        <p>{status?.hint ?? "Sparkmux requires tmux 3.2 or newer."}</p>
        <CopyCmd cmd={tmuxUpgradeCmd()} />
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
      <h1>Create your first session</h1>
      <p>
        Sparkmux is ready. This window talks only to{" "}
        <code>-L {status?.socket_name ?? "sparkmux"}</code> — your default tmux
        server is unchanged. New Session creates that name only.
      </p>
      <button className="primary" onClick={onNewSession}>
        New Session…
      </button>
    </div>
  );
}
