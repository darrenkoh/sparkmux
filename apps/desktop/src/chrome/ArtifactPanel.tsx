import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { openEditorPath, paneArtifacts } from "../api";
import { MarkdownContent } from "./MarkdownContent";
import { toolRowPath } from "./openPath";
import {
  calculatePreservedScrollTop,
  emptyOutputText,
  formatStepCount,
  groupArtifactTurns,
  hasNewTopContent,
  previewLine,
  TURN_PENDING_LABEL,
  TURN_REPLY_LABEL,
  turnIntermediateSteps,
  turnStatus,
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
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
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

  const selectedIndex =
    selectedTurnId !== null
      ? visibleTurns.findIndex((t) => t.id === selectedTurnId)
      : -1;
  const selectedTurn =
    selectedIndex >= 0
      ? visibleTurns[selectedIndex]
      : selectedTurnId !== null
        ? turns.find((t) => t.id === selectedTurnId) ?? null
        : null;

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
  }, [feed]);

  return (
    <aside
      className={`artifact-panel${isDocked ? " docked" : ""}`}
      aria-label="Your Prompts"
      onMouseDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header className="artifact-head">
        <div className="artifact-title">
          <span>Your Prompts</span>
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
          <button
            type="button"
            className="mini-stat-btn"
            onClick={onCollapse}
            title="Close Your Prompts"
            aria-label="Close Your Prompts"
          >
            ✕
          </button>
        </div>
      </header>
      <div className="artifact-filter-bar">
        <input
          type="search"
          className="artifact-filter-input"
          placeholder="Filter prompts..."
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          aria-label="Filter prompts"
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
          <p className="artifact-empty">No prompts match &ldquo;{filterText}&rdquo;.</p>
        ) : (
          visibleTurns.map((turn) => (
            <PromptCard
              key={turn.id}
              turn={turn}
              selected={turn.id === selectedTurnId}
              onSelect={() => setSelectedTurnId(turn.id)}
            />
          ))
        )}
      </div>
      {selectedTurn &&
        createPortal(
          <PromptDetailModal
            turn={selectedTurn}
            cwd={cwd}
            index={selectedIndex >= 0 ? selectedIndex : 0}
            total={visibleTurns.length}
            onPrev={
              selectedIndex > 0
                ? () => setSelectedTurnId(visibleTurns[selectedIndex - 1].id)
                : undefined
            }
            onNext={
              selectedIndex >= 0 && selectedIndex < visibleTurns.length - 1
                ? () => setSelectedTurnId(visibleTurns[selectedIndex + 1].id)
                : undefined
            }
            onClose={() => setSelectedTurnId(null)}
          />,
          document.body,
        )}
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

function PromptCard({
  turn,
  selected,
  onSelect,
}: {
  turn: ArtifactTurn;
  selected: boolean;
  onSelect: () => void;
}) {
  const prompt = turn.user?.body ?? turn.steps[0]?.body ?? "";
  const promptPreview = previewLine(prompt, 200) || "(Empty prompt)";
  const intermediateSteps = turnIntermediateSteps(turn);
  const stepCount = intermediateSteps.length;
  const status = turnStatus(turn);
  const breakdown = stepBreakdown(intermediateSteps);

  return (
    <button
      type="button"
      className={`prompt-card${selected ? " selected" : ""} status-${status.kind}`}
      onClick={onSelect}
      aria-label={`Prompt: ${promptPreview}`}
    >
      <div className="prompt-card-content">{promptPreview}</div>
      <div className="prompt-card-meta">
        <span className={`prompt-status-badge ${status.kind}`}>
          <span className="prompt-status-dot" aria-hidden="true" />
          {status.label}
        </span>
        <span
          className="prompt-steps-badge"
          title={breakdown ? `${formatStepCount(stepCount)}${breakdown}` : undefined}
        >
          {formatStepCount(stepCount)}
        </span>
      </div>
    </button>
  );
}

function PromptDetailModal({
  turn,
  cwd,
  index,
  total,
  onPrev,
  onNext,
  onClose,
}: {
  turn: ArtifactTurn;
  cwd: string;
  index: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
}) {
  const intermediateSteps = turnIntermediateSteps(turn);
  const stepCount = intermediateSteps.length;
  const status = turnStatus(turn);
  const [stepsOpen, setStepsOpen] = useState(() => turn.pending || !turn.reply);

  useEffect(() => {
    setStepsOpen(turn.pending || !turn.reply);
  }, [turn.id]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowLeft" && onPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === "ArrowRight" && onNext) {
        e.preventDefault();
        onNext();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onPrev, onNext]);

  return (
    <div
      className="prompt-modal-backdrop"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        className="prompt-modal-window"
        role="dialog"
        aria-modal="true"
        aria-label="Prompt details"
      >
        <header className="prompt-modal-head">
          <div className="prompt-modal-title-group">
            <span className="prompt-modal-title">Prompt Details</span>
            {total > 0 && (
              <span className="prompt-modal-counter">
                {index + 1} / {total}
              </span>
            )}
            <span className={`prompt-status-badge ${status.kind}`}>
              <span className="prompt-status-dot" aria-hidden="true" />
              {status.label}
            </span>
            <span className="prompt-steps-badge">
              {formatStepCount(stepCount)}
              {stepBreakdown(intermediateSteps)}
            </span>
          </div>
          <div className="prompt-modal-actions">
            <div className="prompt-modal-nav">
              <button
                type="button"
                className="prompt-nav-btn"
                onClick={onPrev}
                disabled={!onPrev}
                title="Newer prompt (←)"
                aria-label="Newer prompt"
              >
                ← Prev
              </button>
              <button
                type="button"
                className="prompt-nav-btn"
                onClick={onNext}
                disabled={!onNext}
                title="Older prompt (→)"
                aria-label="Older prompt"
              >
                Next →
              </button>
            </div>
            <button
              type="button"
              className="prompt-modal-close"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close prompt details"
            >
              ✕
            </button>
          </div>
        </header>
        <div className="prompt-modal-body">
          {turn.user && <Block entry={turn.user} cwd={cwd} label="Prompt" />}
          {intermediateSteps.length > 0 && (
            <div className={`artifact-steps-fold${stepsOpen ? " open" : ""}`}>
              <button
                type="button"
                className="artifact-steps-summary"
                aria-expanded={stepsOpen}
                onClick={() => setStepsOpen((open) => !open)}
              >
                <span className="artifact-steps-toggle-label">
                  {intermediateSteps.length === 1
                    ? "1 intermediate step"
                    : `${intermediateSteps.length} intermediate steps`}
                  {stepBreakdown(intermediateSteps)}
                </span>
              </button>
              {stepsOpen && (
                <div className="artifact-steps-content">
                  {intermediateSteps.map((step) => (
                    <Block key={step.id} entry={step} cwd={cwd} />
                  ))}
                </div>
              )}
            </div>
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
          {turn.pending && <p className="artifact-pending">{TURN_PENDING_LABEL}…</p>}
        </div>
      </div>
    </div>
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
        {entry.model && <span className="artifact-model-tag">{entry.model}</span>}
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
          <MarkdownContent content={entry.body} kind={entry.kind} />
        </div>
      )}
    </div>
  );
}
