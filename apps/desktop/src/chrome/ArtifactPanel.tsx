import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { openEditorPath, paneArtifacts } from "../api";
import { toolRowPath } from "./openPath";
import {
  calculatePreservedScrollTop,
  emptyOutputText,
  groupArtifactTurns,
  hasNewTopContent,
  previewLine,
  TURN_PENDING_LABEL,
  TURN_REPLY_LABEL,
  type ArtifactEntry,
  type ArtifactFeed,
  type ArtifactTurn,
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
  const [turnOpen, setTurnOpen] = useState<Record<string, boolean>>({});
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

  const [filterText, setFilterText] = useState("");
  const rawEntries = feed?.entries ?? [];
  const turns = groupArtifactTurns(rawEntries);
  const empty = emptyOutputText(feed, rawEntries.length, 0);

  const normalizedFilter = filterText.trim().toLowerCase();
  const visibleTurns = normalizedFilter
    ? turns.filter((turn) => {
        if (turn.user?.body.toLowerCase().includes(normalizedFilter)) return true;
        if (turn.reply?.body.toLowerCase().includes(normalizedFilter)) return true;
        return turn.steps.some(
          (step) =>
            step.label.toLowerCase().includes(normalizedFilter) ||
            step.body.toLowerCase().includes(normalizedFilter),
        );
      })
    : turns;

  const allOpen =
    visibleTurns.length > 0 &&
    visibleTurns.every((t) => turnOpen[t.id] === true);

  const toggleAll = () => {
    const nextState = !allOpen;
    setTurnOpen((prev) => {
      const updated = { ...prev };
      for (const t of visibleTurns) {
        updated[t.id] = nextState;
      }
      return updated;
    });
  };

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
  }, [feed, turnOpen]);

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
          {visibleTurns.length > 0 && (
            <button
              type="button"
              onClick={toggleAll}
              aria-label={allOpen ? "Collapse all turns" : "Expand all turns"}
              title={allOpen ? "Collapse all turns" : "Expand all turns"}
            >
              {allOpen ? "Collapse Turns" : "Expand Turns"}
            </button>
          )}
          <button type="button" onClick={onCollapse} aria-label="Collapse logs">
            Collapse
          </button>
        </div>
      </header>
      <div className="artifact-filter-bar">
        <input
          type="search"
          className="artifact-filter-input"
          placeholder="Filter logs or turns..."
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          aria-label="Filter logs or turns"
        />
        {filterText && (
          <button
            type="button"
            className="artifact-filter-clear"
            onClick={() => setFilterText("")}
            aria-label="Clear filter"
          >
            ✕
          </button>
        )}
      </div>
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
        ) : visibleTurns.length === 0 ? (
          <p className="artifact-empty">No logs match &ldquo;{filterText}&rdquo;.</p>
        ) : (
          visibleTurns.map((turn) => (
            <Turn
              key={turn.id}
              turn={turn}
              cwd={cwd}
              open={Boolean(normalizedFilter ? true : turnOpen[turn.id])}
              onToggle={(open) => {
                setTurnOpen((prev) => ({ ...prev, [turn.id]: open }));
              }}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function stepBreakdown(steps: ArtifactEntry[]): string {
  const reasoningCount = steps.filter((s) => s.kind === "reasoning").length;
  const toolCount = steps.filter((s) => s.kind === "tool" || s.kind === "tool_result").length;
  const parts: string[] = [];
  if (reasoningCount > 0) {
    parts.push(`${reasoningCount} ${reasoningCount === 1 ? "thought" : "thoughts"}`);
  }
  if (toolCount > 0) {
    parts.push(`${toolCount} ${toolCount === 1 ? "tool event" : "tool events"}`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function Turn({
  turn,
  cwd,
  open,
  onToggle,
}: {
  turn: ArtifactTurn;
  cwd: string;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const prompt = turn.user?.body ?? "";
  const reply = turn.reply?.body ?? "";
  const intermediateSteps = turn.steps.filter((step) => step !== turn.reply);
  const stepCount = intermediateSteps.length;
  const promptPreview = previewLine(prompt, 240);
  const replyPreview = previewLine(reply, 240);

  return (
    <details
      className="artifact-turn"
      open={open}
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        const next = event.currentTarget.open;
        if (next === open) return;
        onToggle(next);
      }}
    >
      <summary>
        <span className="artifact-turn-lines">
          <span className={`artifact-turn-line${turn.user ? " user" : ""}`}>
            <span className="artifact-label">{turn.user ? "You" : "Earlier"}</span>
            {prompt && <span className="artifact-preview">{promptPreview}</span>}
            {!prompt && turn.steps[0] && (
              <span className="artifact-preview">{previewLine(turn.steps[0].body, 240)}</span>
            )}
          </span>
          <span className="artifact-turn-extra">
            {turn.reply && (
              <span className="artifact-turn-line">
                <span className="artifact-label">{TURN_REPLY_LABEL}</span>
                {reply && <span className="artifact-preview">{replyPreview}</span>}
              </span>
            )}
            {turn.pending && <span className="artifact-pending-label">{TURN_PENDING_LABEL}</span>}
            {stepCount > 0 && (
              <span className="artifact-steps">
                {stepCount === 1 ? "1 step" : `${stepCount} steps`}
              </span>
            )}
          </span>
        </span>
      </summary>
      <div className="artifact-turn-body">
        {turn.user && <Block entry={turn.user} cwd={cwd} />}
        {intermediateSteps.length > 0 && (
          <details
            className="artifact-steps-fold"
            open={turn.pending || !turn.reply ? true : undefined}
          >
            <summary className="artifact-steps-summary">
              <span className="artifact-steps-toggle-label">
                {intermediateSteps.length === 1
                  ? "1 intermediate step"
                  : `${intermediateSteps.length} intermediate steps`}
                {stepBreakdown(intermediateSteps)}
              </span>
            </summary>
            <div className="artifact-steps-content">
              {intermediateSteps.map((step) => (
                <Block key={step.id} entry={step} cwd={cwd} />
              ))}
            </div>
          </details>
        )}
        {turn.reply && (
          <Block
            key={turn.reply.id}
            entry={turn.reply}
            cwd={cwd}
            label={TURN_REPLY_LABEL}
            final={true}
          />
        )}
        {turn.pending && <p className="artifact-pending">{TURN_PENDING_LABEL}</p>}
      </div>
    </details>
  );
}

function Block({
  entry,
  cwd,
  label,
  final = false,
}: {
  entry: ArtifactEntry;
  cwd: string;
  label?: string;
  final?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const recordedPath = entry.kind === "tool" ? toolRowPath(entry.body) : null;
  const isLongContent =
    (entry.body && (entry.body.length > 400 || entry.body.split("\n").length > 10)) ?? false;

  return (
    <div className={`artifact-item ${entry.kind}${final ? " final" : ""}`}>
      <div className="artifact-block-head">
        <span className="artifact-label">{label ?? entry.label}</span>
        <div className="artifact-block-actions">
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
          {isLongContent && (
            <button
              type="button"
              className="artifact-expand-btn"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setExpanded((prev) => !prev);
              }}
              title={expanded ? "Cap height" : "Expand full height"}
            >
              {expanded ? "Cap" : "Expand"}
            </button>
          )}
          {entry.body && (
            <button
              type="button"
              className="artifact-copy-btn"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void navigator.clipboard.writeText(entry.body);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              title="Copy content"
            >
              {copied ? "✓ Copied" : "Copy"}
            </button>
          )}
        </div>
      </div>
      {entry.body && (
        <div className={`artifact-body${expanded ? " expanded" : ""}`}>
          {entry.body}
        </div>
      )}
    </div>
  );
}
