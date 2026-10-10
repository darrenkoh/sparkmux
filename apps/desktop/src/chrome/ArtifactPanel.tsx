import { useEffect, useRef, useState } from "react";

import { paneArtifacts } from "../api";
import {
  clearedThrough,
  cliLabel,
  directoryLabel,
  emptyOutputText,
  loadAutoScroll,
  loadClears,
  markCleared,
  nearOutputBottom,
  outputTailKey,
  saveAutoScroll,
  saveClears,
  visibleEntries,
  type ArtifactEntry,
  type ArtifactFeed,
  type ClearMap,
} from "./artifactModel";

export default function ArtifactPanel({
  command,
  cwd,
  title,
  pid,
  onCollapse,
}: {
  command: string;
  cwd: string;
  title: string;
  pid: number;
  onCollapse: () => void;
}) {
  const [feed, setFeed] = useState<ArtifactFeed | null>(null);
  const [clears, setClears] = useState<ClearMap>(() => loadClears());
  const [autoScroll, setAutoScroll] = useState(loadAutoScroll);
  const listRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(autoScroll);
  // Clicking Off while already at the bottom stays off until the user scrolls away.
  const resumeAtBottom = useRef(autoScroll);
  const ignoreScroll = useRef(false);
  const pinGen = useRef(0);
  autoScrollRef.current = autoScroll;

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
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [command, cwd, title, pid]);

  const path = feed?.transcript_path ?? null;
  const through = clearedThrough(clears, path, feed?.file_len ?? 0);
  const visible = visibleEntries(feed?.entries ?? [], through);
  const empty = emptyOutputText(feed, visible.length, through);
  const tailKey = `${feed?.file_len ?? 0}:${outputTailKey(visible)}`;

  useEffect(() => {
    saveAutoScroll(autoScroll);
  }, [autoScroll]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || autoScrollRef.current) return;
    ignoreScroll.current = true;
    el.scrollTop = 0;
    ignoreScroll.current = false;
  }, [command, cwd, title, pid]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = listRef.current;
    if (!el) return;
    const gen = ++pinGen.current;
    // The pin itself emits a scroll event. Ignore that one so it cannot turn follow off.
    ignoreScroll.current = true;
    el.scrollTop = el.scrollHeight;
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => {
        if (pinGen.current === gen) ignoreScroll.current = false;
      });
    });
    return () => {
      window.cancelAnimationFrame(outer);
      if (inner) window.cancelAnimationFrame(inner);
      if (pinGen.current === gen) ignoreScroll.current = false;
    };
  }, [autoScroll, tailKey]);

  const where = directoryLabel(cwd);
  const who = cliLabel(feed?.cli ?? null);
  const subtitle = [who, where].filter(Boolean).join(" · ");

  function clear() {
    if (!path || !feed) return;
    const next = markCleared(clears, path, feed.file_len);
    saveClears(next);
    setClears(next);
  }

  return (
    <aside
      className="artifact-panel"
      aria-label="Agent output"
      onMouseDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header className="artifact-head">
        <div className="artifact-title">
          <span>Output</span>
          {subtitle && <span className="artifact-sub">{subtitle}</span>}
        </div>
        <div className="artifact-actions">
          <button
            type="button"
            aria-pressed={autoScroll}
            onClick={() => {
              setAutoScroll((on) => {
                const next = !on;
                resumeAtBottom.current = next;
                return next;
              });
            }}
          >
            Auto scroll {autoScroll ? "On" : "Off"}
          </button>
          <button type="button" onClick={clear} disabled={!path} aria-label="Clear output">
            Clear
          </button>
          <button type="button" onClick={onCollapse} aria-label="Collapse output">
            Collapse
          </button>
        </div>
      </header>
      <div
        className="artifact-list"
        ref={listRef}
        onScroll={() => {
          if (ignoreScroll.current) return;
          const el = listRef.current;
          if (!el) return;
          const near = nearOutputBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
          if (!near) {
            resumeAtBottom.current = true;
            setAutoScroll(false);
            return;
          }
          if (resumeAtBottom.current) setAutoScroll(true);
        }}
      >
        {empty ? (
          <p className="artifact-empty">{empty}</p>
        ) : (
          visible.map((entry) => <Entry key={entry.id} entry={entry} />)
        )}
      </div>
    </aside>
  );
}

function Entry({ entry }: { entry: ArtifactEntry }) {
  if (entry.kind === "reasoning") {
    return (
      <details className="artifact-item reasoning">
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
