import { useState, useMemo } from "react";
import type { ChronicleHologram as HologramPayload } from "../api";

export function chroniclePanelText(input: {
  tab: "file" | "diff";
  loading: boolean;
  preview: string;
  hologram: Pick<HologramPayload, "fidelity" | "file_text" | "diff_text"> | null;
}): string {
  if (!input.hologram) {
    if (!input.loading) return input.preview;
    return input.preview ? `${input.preview}\nLoading…` : "Loading…";
  }
  if (input.tab === "diff") return input.hologram.diff_text;
  if (input.hologram.file_text != null) return input.hologram.file_text;
  if (input.hologram.fidelity === "patch") return input.hologram.diff_text;
  return "";
}

export function chroniclePanelBanners(hologram: HologramPayload | null): string[] {
  if (!hologram) return [];
  const banners: string[] = [];
  if (hologram.fidelity === "patch") {
    banners.push("Patch only. The full file at this step could not be rebuilt.");
  }
  if (hologram.fidelity === "deleted") banners.push("Deleted at this step.");
  if (hologram.fidelity === "binary") banners.push("Binary file. No preview.");
  if (hologram.reason) banners.push(hologram.reason);
  if (hologram.file_truncated) {
    banners.push(`Showing a window from line ${hologram.window_start_line} of ${hologram.total_lines}.`);
  }
  if (hologram.diff_truncated) banners.push("Diff truncated.");
  return banners;
}

export default function ChronicleHologram(props: {
  title: string;
  banners: readonly string[];
  tab: "file" | "diff";
  onTab: (tab: "file" | "diff") => void;
  text: string;
}) {
  const [minimized, setMinimized] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!props.text) return;
    navigator.clipboard.writeText(props.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };

  const lines = useMemo(() => {
    if (!props.text) return [];
    return props.text.split("\n");
  }, [props.text]);

  if (minimized) {
    return (
      <aside className="chronicle-hologram-minimized" aria-live="polite">
        <button
          type="button"
          className="chronicle-hologram-min-pill"
          onClick={() => setMinimized(false)}
          title="Expand hologram inspector"
        >
          <span className="tag">HOLO</span>
          <span className="min-title">{props.title || "Inspect Step"}</span>
          <span className="min-action">EXPAND ▢</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="chronicle-hologram scifi-panel" aria-live="polite">
      <header>
        <span className="tag">HOLO</span>
        <span className="chronicle-hologram-title" title={props.title}>
          {props.title}
        </span>
        <div className="chronicle-hologram-actions">
          <button
            type="button"
            className="chronicle-btn-icon"
            onClick={handleCopy}
            title={copied ? "Copied to clipboard" : "Copy text"}
          >
            {copied ? "COPIED" : "COPY"}
          </button>
          <button
            type="button"
            className="chronicle-btn-icon"
            onClick={() => setMinimized(true)}
            title="Minimize hologram panel"
            aria-label="Minimize hologram panel"
          >
            −
          </button>
        </div>
      </header>

      {props.banners.map((banner, index) => (
        <div key={`${index}:${banner}`} className="chronicle-note">
          <span className="note-icon">⚠</span>
          <span>{banner}</span>
        </div>
      ))}

      <div className="chronicle-tabs-bar">
        <div className="chronicle-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={props.tab === "file"}
            className={props.tab === "file" ? "on" : ""}
            onClick={() => props.onTab("file")}
          >
            FILE SNAPSHOT
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={props.tab === "diff"}
            className={props.tab === "diff" ? "on" : ""}
            onClick={() => props.onTab("diff")}
          >
            SESSION DIFF
          </button>
        </div>
        <span className="chronicle-line-count">
          {lines.length} {lines.length === 1 ? "LINE" : "LINES"}
        </span>
      </div>

      <div className="chronicle-hologram-body" tabIndex={0}>
        {props.tab === "diff" ? (
          <div className="chronicle-diff-viewer">
            {lines.map((line, idx) => {
              const isHunk = line.startsWith("@@");
              const isAdd = line.startsWith("+") && !line.startsWith("+++");
              const isDel = line.startsWith("-") && !line.startsWith("---");
              const isMeta =
                line.startsWith("diff ") ||
                line.startsWith("index ") ||
                line.startsWith("--- ") ||
                line.startsWith("+++ ");

              let lineClass = "diff-line";
              if (isHunk) lineClass += " hunk";
              else if (isAdd) lineClass += " added";
              else if (isDel) lineClass += " removed";
              else if (isMeta) lineClass += " meta";

              return (
                <div key={idx} className={lineClass}>
                  <span className="line-num">{idx + 1}</span>
                  <span className="line-prefix">
                    {isAdd ? "+" : isDel ? "−" : isHunk ? " " : " "}
                  </span>
                  <span className="line-content">{line || " "}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="chronicle-file-viewer">
            {lines.map((line, idx) => (
              <div key={idx} className="file-line">
                <span className="line-num">{idx + 1}</span>
                <span className="line-content">{line || " "}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
