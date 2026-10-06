import type { TmuxStatus } from "../types";

export default function StatusBar({
  status,
  session,
  windowName,
  onAsk,
}: {
  status: TmuxStatus | null;
  session: string | null;
  windowName: string | null;
  onAsk?: () => void;
}) {
  const tmux = status?.version ?? "tmux";
  const sock = status?.socket_name ? `-L ${status.socket_name}` : "-L sparkmux";
  const loc =
    session && windowName ? `${session}:${windowName}` : session ?? "—";
  return (
    <footer className="status">
      <span>{tmux}</span>
      <span className="sep">·</span>
      <span>{sock}</span>
      <span className="sep">·</span>
      <span>{loc}</span>
      {onAsk && (
        <button type="button" className="status-ask" onClick={onAsk} aria-label="Ask">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M2.5 3.25h11a1.25 1.25 0 0 1 1.25 1.25v6.1a1.25 1.25 0 0 1-1.25 1.25H8.1L4.4 14.2v-2.35H2.5a1.25 1.25 0 0 1-1.25-1.25V4.5A1.25 1.25 0 0 1 2.5 3.25z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
          Ask
        </button>
      )}
    </footer>
  );
}
