import type { TmuxStatus } from "../types";

export default function StatusBar({
  status,
  session,
  windowName,
}: {
  status: TmuxStatus | null;
  session: string | null;
  windowName: string | null;
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
    </footer>
  );
}
