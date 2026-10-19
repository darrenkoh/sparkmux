import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { openEditorPath, paneArtifacts } from "../api";
import { toolRowPath } from "./openPath";
import {
  calculatePreservedScrollTop,
  emptyOutputText,
  hasNewTopContent,
  previewLine,
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
  onOpenGraph,
  isDocked = false,
}: {
  command: string;
  cwd: string;
  title: string;
  pid: number;
  onCollapse: () => void;
  onOpenAnalytics?: () => void;
  onOpenGraph?: () => void;
  isDocked?: boolean;
}) {
  const [feed, setFeed] = useState<ArtifactFeed | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const unmountedRef = useRef(false);
  const paramsRef = useRef({ command, cwd, title, pid });
  paramsRef.current = { command, cwd, title, pid };

  const prevFeedRef = useRef<ArtifactFeed | null>(null);
  const scrollStateRef = useRef<{ scrollTop: number; scrollHeight: number }>({
    scrollTop: 0,
    scrollHeight: 0,
  });

  const tick = useCallback(() => {
    const { command, cwd, title, pid } = paramsRef.current;
    void paneArtifacts(command, cwd, title, pid)
      .then((next) => {
        if (unmountedRef.current) return;
        setFeed((prev) => {
          if (
            prev &&
            prev.cli === next.cli &&
            prev.transcript_path === next.transcript_path &&
            prev.file_len === next.file_len &&
            prev.entries.length === next.entries.length &&
            prev.error === next.error
          ) {
            const prevLast = prev.entries[prev.entries.length - 1];
            const nextLast = next.entries[next.entries.length - 1];
            if (
              prevLast?.id === nextLast?.id &&
              prevLast?.body === nextLast?.body &&
              prevLast?.label === nextLast?.label
            ) {
              return prev;
            }
          }
          return next;
        });
      })
      .catch(() => {
        if (unmountedRef.current) return;
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
  }, []);

  useEffect(() => {
    tick();
  }, [command, cwd, title, pid, tick]);

  useEffect(() => {
    const id = window.setInterval(tick, 1000);
    return () => {
      unmountedRef.current = true;
      window.clearInterval(id);
    };
  }, [tick]);

  const rawEntries = feed?.entries ?? [];
  const empty = emptyOutputText(feed, rawEntries.length, 0);
  // Latest logs on top
  const displayed = [...rawEntries].reverse();

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;

    const prevFeed = prevFeedRef.current;
    prevFeedRef.current = feed;

    const prevEntries = prevFeed?.entries ?? [];
    const currentEntries = feed?.entries ?? [];
    const isNewFeed = prevFeed !== feed && prevFeed !== null && feed !== null;

    if (isNewFeed && hasNewTopContent(prevEntries, currentEntries)) {
      const nextScrollTop = calculatePreservedScrollTop(
        scrollStateRef.current.scrollTop,
        scrollStateRef.current.scrollHeight,
        el.scrollHeight,
      );
      if (nextScrollTop !== null) {
        el.scrollTop = nextScrollTop;
      }
    }

    scrollStateRef.current = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
    };
  }, [feed, expandedIds]);

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
          {onOpenGraph && (
            <button
              type="button"
              className="artifact-graph-btn"
              onClick={onOpenGraph}
              aria-label="Open changed files graph"
              title="Open changed files graph"
            >
              ⬡ Gits
            </button>
          )}
          <button type="button" onClick={onCollapse} aria-label="Collapse logs">
            Collapse
          </button>
        </div>
      </header>
      <div
        className="artifact-list"
        ref={listRef}
        onScroll={() => {
          const el = listRef.current;
          if (!el) return;
          scrollStateRef.current = {
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
          };
        }}
      >
        {empty ? (
          <p className="artifact-empty">{empty}</p>
        ) : (
          displayed.map((entry) => (
            <Entry
              key={entry.id}
              entry={entry}
              cwd={cwd}
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
  cwd,
  expanded,
  onToggle,
}: {
  entry: ArtifactEntry;
  cwd: string;
  expanded: boolean;
  onToggle: (open: boolean) => void;
}) {
  const preview = previewLine(entry.body);
  const recordedPath = entry.kind === "tool" ? toolRowPath(entry.body) : null;
  return (
    <details
      className={`artifact-item ${entry.kind}`}
      open={expanded}
      onToggle={(event) => {
        onToggle(event.currentTarget.open);
      }}
    >
      <summary>
        <span className="artifact-label">{entry.label}</span>
        {preview && <span className="artifact-preview">{preview}</span>}
        {recordedPath && (
          <button
            type="button"
            className="open-editor"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void openEditorPath(recordedPath, cwd);
            }}
          >
            Open in editor
          </button>
        )}
      </summary>
      {entry.body && <div className="artifact-body">{entry.body}</div>}
    </details>
  );
}
