import { useEffect, useRef, useState } from "react";

import { paneArtifacts } from "../api";
import {
  cliLabel,
  directoryLabel,
  emptyOutputText,
  type ArtifactEntry,
  type ArtifactFeed,
} from "./artifactModel";

export default function ArtifactPanel({
  command,
  cwd,
  title,
  pid,
  onCollapse,
  onOpenAnalytics,
  isDocked = false,
}: {
  command: string;
  cwd: string;
  title: string;
  pid: number;
  onCollapse: () => void;
  onOpenAnalytics?: () => void;
  isDocked?: boolean;
}) {
  const [feed, setFeed] = useState<ArtifactFeed | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      void paneArtifacts(command, cwd, title, pid)
        .then((next) => {
          if (!cancelled) setFeed(next);
        })
        .catch(() => {
          if (cancelled) return;
          setFeed((prev) =>
            prev ?? {
              cli: null,
              transcript_path: null,
              file_len: 0,
              entries: [],
              error: "Could not read the transcript.",
            },
          );
        });
    };
    setFeed(null);
    setExpandedIds(new Set());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [command, cwd, title, pid]);

  const rawEntries = feed?.entries ?? [];
  const empty = emptyOutputText(feed, rawEntries.length, 0);
  // Latest logs on top
  const displayed = [...rawEntries].reverse();

  const where = directoryLabel(cwd);
  const who = cliLabel(feed?.cli ?? null);
  const subtitle = [who, where].filter(Boolean).join(" · ");

  const handleToggle = (id: string, open: boolean) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (open) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  return (
    <aside
      className={`artifact-panel${isDocked ? " docked" : ""}`}
      aria-label="Agent logs"
      onMouseDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header className="artifact-head">
        <div className="artifact-title">
          <span>AGENT LOGS</span>
          {subtitle && <span className="artifact-sub">{subtitle}</span>}
        </div>
        <div className="artifact-actions">
          {onOpenAnalytics && (
            <button
              type="button"
              className="artifact-stats-btn"
              onClick={onOpenAnalytics}
              aria-label="Open Sci-Fi Telemetry & Analytics HUD"
              title="Open Sci-Fi Telemetry & Analytics HUD"
            >
              ◈ Stats
            </button>
          )}
          <button type="button" onClick={onCollapse} aria-label="Collapse logs">
            Collapse
          </button>
        </div>
      </header>
      <div className="artifact-list" ref={listRef}>
        {empty ? (
          <p className="artifact-empty">{empty}</p>
        ) : (
          displayed.map((entry) => (
            <Entry
              key={entry.id}
              entry={entry}
              expanded={expandedIds.has(entry.id)}
              onToggle={(open) => handleToggle(entry.id, open)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function Entry({
  entry,
  expanded,
  onToggle,
}: {
  entry: ArtifactEntry;
  expanded: boolean;
  onToggle: (open: boolean) => void;
}) {
  if (entry.kind === "reasoning") {
    return (
      <details
        className="artifact-item reasoning"
        open={expanded}
        onToggle={(event) => {
          onToggle(event.currentTarget.open);
        }}
      >
        <summary>{entry.label}</summary>
        <div className="artifact-body">{entry.body}</div>
      </details>
    );
  }
  if (entry.kind === "tool" || entry.kind === "tool_result") {
    return (
      <div className={`artifact-item ${entry.kind}`}>
        <span className="artifact-label">{entry.label}</span>
        {entry.body && <span className="artifact-body">{entry.body}</span>}
      </div>
    );
  }
  return (
    <article className={`artifact-item ${entry.kind}`}>
      <div className="artifact-label">{entry.label}</div>
      <div className="artifact-body">{entry.body}</div>
    </article>
  );
}
