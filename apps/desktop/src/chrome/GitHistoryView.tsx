import { useCallback, useEffect, useMemo, useState } from "react";
import {
  gitCommitDetail,
  gitCommitDiff,
  gitHistory,
  openEditorPath,
  type FileDiffResponse,
  type GitCommitDetail,
  type GitCommitFile,
  type GitCommitItem,
} from "../api";
import { parseSideBySideDiff } from "./changeGraphLayout";
import {
  buildFileTree,
  filterCommits,
  filterTreeNodes,
  formatCommitDate,
  formatRelativeTime,
  getAllDirPaths,
  statusBadgeColor,
  statusBadgeLabel,
  type FileTreeNode,
} from "./gitHistoryModel";

export interface GitHistoryViewProps {
  cwd: string;
  repoId?: string;
  initialFileFilter?: string | null;
  availableFiles?: { path: string; repoId: string }[];
  onOpenFileInEditor?: (path: string) => void;
}

export default function GitHistoryView({
  cwd,
  repoId = "",
  initialFileFilter = null,
  availableFiles = [],
  onOpenFileInEditor,
}: GitHistoryViewProps) {
  const [commits, setCommits] = useState<GitCommitItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [commitSearchQuery, setCommitSearchQuery] = useState<string>("");
  const [fileFilter, setFileFilter] = useState<string | null>(initialFileFilter);

  // Selected commit state
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<GitCommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Changed files tree state
  const [fileViewMode, setFileViewMode] = useState<"tree" | "flat">("tree");
  const [treeSearchQuery, setTreeSearchQuery] = useState<string>("");
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  // Selected file in commit diff
  const [selectedCommitFile, setSelectedCommitFile] = useState<string | null>(null);
  const [fileDiffData, setFileDiffData] = useState<FileDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState<boolean>(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffViewMode, setDiffViewMode] = useState<"unified" | "split">("unified");
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  // Load commit history
  const loadHistory = useCallback(
    async (path?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const res = await gitHistory(repoId, cwd, path ?? null, 100);
        setCommits(res.commits);
        if (res.commits.length > 0) {
          // If no commit selected or selected commit is not in list, select first
          setSelectedHash((prev) => {
            if (prev && res.commits.some((c) => c.hash === prev)) return prev;
            return res.commits[0].hash;
          });
        } else {
          setSelectedHash(null);
          setCommitDetail(null);
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [repoId, cwd],
  );

  useEffect(() => {
    void loadHistory(fileFilter);
  }, [loadHistory, fileFilter]);

  // Load commit detail whenever selectedHash changes
  useEffect(() => {
    if (!selectedHash) {
      setCommitDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);

    gitCommitDetail(repoId, cwd, selectedHash)
      .then((detail) => {
        if (cancelled) return;
        setCommitDetail(detail);
        // Auto-select a file in the commit: prefer the active fileFilter if present in commit
        if (detail.files.length > 0) {
          const matchFilter = fileFilter
            ? detail.files.find((f) => f.path === fileFilter)
            : null;
          const nextFile = matchFilter ? matchFilter.path : detail.files[0].path;
          setSelectedCommitFile(nextFile);
        } else {
          setSelectedCommitFile(null);
          setFileDiffData(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setDetailError(String(err));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedHash, repoId, cwd, fileFilter]);

  // Build hierarchical file tree for active commit
  const rawFileTree = useMemo(() => {
    if (!commitDetail || commitDetail.files.length === 0) return [];
    return buildFileTree(commitDetail.files);
  }, [commitDetail]);

  // Auto-expand all directory paths when commit changes
  useEffect(() => {
    if (rawFileTree.length > 0) {
      const allDirs = getAllDirPaths(rawFileTree);
      setExpandedDirs(new Set(allDirs));
    }
  }, [rawFileTree]);

  // Filtered tree nodes
  const displayTree = useMemo(() => {
    return filterTreeNodes(rawFileTree, treeSearchQuery);
  }, [rawFileTree, treeSearchQuery]);

  // Filtered flat files
  const displayFlatFiles = useMemo(() => {
    if (!commitDetail) return [];
    const q = treeSearchQuery.trim().toLowerCase();
    if (!q) return commitDetail.files;
    return commitDetail.files.filter((f) => f.path.toLowerCase().includes(q));
  }, [commitDetail, treeSearchQuery]);

  // Toggle directory expansion
  const toggleDir = useCallback((dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  }, []);

  const handleToggleExpandAll = useCallback(() => {
    if (expandedDirs.size > 0) {
      setExpandedDirs(new Set());
    } else {
      const allDirs = getAllDirPaths(rawFileTree);
      setExpandedDirs(new Set(allDirs));
    }
  }, [expandedDirs.size, rawFileTree]);

  // Load file diff whenever selectedCommitFile or selectedHash changes
  useEffect(() => {
    if (!selectedHash || !selectedCommitFile) {
      setFileDiffData(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);

    gitCommitDiff(repoId, cwd, selectedHash, selectedCommitFile)
      .then((diff) => {
        if (!cancelled) setFileDiffData(diff);
      })
      .catch((err) => {
        if (!cancelled) setDiffError(String(err));
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedHash, selectedCommitFile, repoId, cwd]);

  // Filter commits by search query
  const filteredCommits = useMemo(() => {
    return filterCommits(commits, commitSearchQuery);
  }, [commits, commitSearchQuery]);

  // Side-by-side parsed rows
  const splitDiffRows = useMemo(() => {
    if (diffViewMode !== "split" || !fileDiffData || fileDiffData.is_binary) return [];
    return parseSideBySideDiff(fileDiffData.diff);
  }, [fileDiffData, diffViewMode]);

  const handleCopyHash = useCallback((hash: string) => {
    void navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    setTimeout(() => {
      setCopiedHash((prev) => (prev === hash ? null : prev));
    }, 2000);
  }, []);

  const handleOpenEditor = useCallback(
    (path: string) => {
      if (onOpenFileInEditor) {
        onOpenFileInEditor(path);
      } else {
        void openEditorPath(path, cwd);
      }
    },
    [cwd, onOpenFileInEditor],
  );

  // Render a tree node recursively
  const renderTreeNode = useCallback(
    (node: FileTreeNode, depth = 0) => {
      if (node.isDir) {
        const isExpanded = expandedDirs.has(node.path);
        return (
          <div key={node.id}>
            <div
              onClick={() => toggleDir(node.path)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") toggleDir(node.path);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "4px 8px",
                paddingLeft: `${8 + depth * 14}px`,
                cursor: "pointer",
                color: "rgba(255, 255, 255, 0.75)",
                fontSize: "11px",
                userSelect: "none",
                background: "transparent",
                transition: "background 0.1s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(255, 255, 255, 0.04)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                <span style={{ fontSize: "9px", color: "rgba(255, 255, 255, 0.4)", width: "10px" }}>
                  {isExpanded ? "▼" : "▶"}
                </span>
                <span style={{ fontSize: "11px", opacity: 0.85 }}>📁</span>
                <span
                  style={{
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {node.name}
                </span>
                <span style={{ fontSize: "9px", color: "rgba(255, 255, 255, 0.35)" }}>
                  ({node.fileCount})
                </span>
              </div>
              <div style={{ display: "flex", gap: "4px", fontSize: "8.5px", flexShrink: 0 }}>
                {node.added > 0 && <span style={{ color: "#34d399" }}>+{node.added}</span>}
                {node.removed > 0 && <span style={{ color: "#f87171" }}>-{node.removed}</span>}
              </div>
            </div>

            {isExpanded && node.children.map((child) => renderTreeNode(child, depth + 1))}
          </div>
        );
      }

      // Leaf file node
      const isFileSelected = selectedCommitFile === node.path;
      const stColor = node.file ? statusBadgeColor(node.file.status) : "#38bdf8";
      const stLabel = node.file ? statusBadgeLabel(node.file.status) : "M";

      return (
        <div
          key={node.id}
          onClick={() => setSelectedCommitFile(node.path)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") setSelectedCommitFile(node.path);
          }}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "4px 8px",
            paddingLeft: `${16 + depth * 14}px`,
            cursor: "pointer",
            fontSize: "11px",
            borderLeft: isFileSelected ? "3px solid #2dd4bf" : "3px solid transparent",
            background: isFileSelected ? "rgba(45, 212, 191, 0.2)" : "transparent",
            color: isFileSelected ? "#fff" : "rgba(255, 255, 255, 0.85)",
            transition: "background 0.1s ease",
          }}
          onMouseEnter={(e) => {
            if (!isFileSelected) e.currentTarget.style.background = "rgba(255, 255, 255, 0.04)";
          }}
          onMouseLeave={(e) => {
            if (!isFileSelected) e.currentTarget.style.background = "transparent";
          }}
          title={node.path}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
            <span
              style={{
                fontSize: "9px",
                fontWeight: 700,
                color: stColor,
                minWidth: "14px",
              }}
            >
              [{stLabel}]
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontWeight: isFileSelected ? 600 : 400,
              }}
            >
              {node.name}
            </span>
          </div>

          <div style={{ display: "flex", gap: "4px", fontSize: "8.5px", flexShrink: 0 }}>
            {node.added > 0 && <span style={{ color: "#34d399" }}>+{node.added}</span>}
            {node.removed > 0 && <span style={{ color: "#f87171" }}>-{node.removed}</span>}
          </div>
        </div>
      );
    },
    [expandedDirs, selectedCommitFile, toggleDir],
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "#05070a",
        color: "#e2e8f0",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        overflow: "hidden",
      }}
    >
      {/* 1. TOP SUB-TOOLBAR: Global filter & Refresh */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 14px",
          background: "rgba(10, 16, 26, 0.95)",
          borderBottom: "1px solid rgba(45, 212, 191, 0.2)",
          gap: "12px",
          flexWrap: "wrap",
          flexShrink: 0,
        }}
      >
        {/* Left: Commit search input & File filter chip */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: "260px" }}>
          <input
            type="search"
            value={commitSearchQuery}
            onChange={(e) => setCommitSearchQuery(e.target.value)}
            placeholder="Filter commits by message, author, or SHA..."
            style={{
              flex: "0 1 320px",
              background: "rgba(6, 12, 18, 0.9)",
              border: "1px solid rgba(45, 212, 191, 0.3)",
              borderRadius: "3px",
              padding: "4px 8px",
              color: "#fff",
              fontSize: "11px",
              fontFamily: "inherit",
              outline: "none",
            }}
          />

          {fileFilter ? (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                background: "rgba(45, 212, 191, 0.15)",
                border: "1px solid rgba(45, 212, 191, 0.4)",
                padding: "2px 8px",
                borderRadius: "3px",
                fontSize: "10px",
                color: "#2dd4bf",
                fontWeight: 600,
              }}
            >
              <span>📄 {fileFilter}</span>
              <button
                type="button"
                onClick={() => setFileFilter(null)}
                title="Clear file filter (show all commits)"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#2dd4bf",
                  cursor: "pointer",
                  fontSize: "12px",
                  padding: 0,
                  marginLeft: "2px",
                }}
              >
                ×
              </button>
            </div>
          ) : availableFiles.length > 0 ? (
            <select
              aria-label="Filter by changed file"
              onChange={(e) => setFileFilter(e.target.value || null)}
              value=""
              style={{
                background: "rgba(6, 12, 18, 0.9)",
                border: "1px solid rgba(45, 212, 191, 0.3)",
                borderRadius: "3px",
                padding: "3px 6px",
                color: "rgba(226, 232, 240, 0.7)",
                fontSize: "10px",
                fontFamily: "inherit",
                cursor: "pointer",
                maxWidth: "220px",
              }}
            >
              <option value="">Filter commits by file...</option>
              {availableFiles.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        {/* Right: Refresh button and count */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "10px", color: "rgba(255, 255, 255, 0.5)" }}>
            {filteredCommits.length} {filteredCommits.length === 1 ? "COMMIT" : "COMMITS"}
            {fileFilter ? " (FILE FILTERED)" : ""}
          </span>
          <button
            type="button"
            onClick={() => void loadHistory(fileFilter)}
            title="Refresh git history"
            style={{
              background: "rgba(45, 212, 191, 0.12)",
              border: "1px solid rgba(45, 212, 191, 0.35)",
              color: "#2dd4bf",
              padding: "3px 8px",
              borderRadius: "3px",
              fontSize: "10px",
              cursor: "pointer",
              fontFamily: "inherit",
              fontWeight: 600,
            }}
          >
            ↻ REFRESH
          </button>
        </div>
      </div>

      {/* 2. 3-COLUMN MAIN WORKSPACE: [COMMITS LIST] | [CHANGED FILES TREE] | [DIFF VIEWER] */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>
        {/* COLUMN 1: COMMITS LIST */}
        <div
          style={{
            flex: "0 0 310px",
            minWidth: "250px",
            maxWidth: "400px",
            borderRight: "1px solid rgba(45, 212, 191, 0.18)",
            display: "flex",
            flexDirection: "column",
            background: "#070b12",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "7px 10px",
              background: "rgba(9, 15, 24, 0.96)",
              borderBottom: "1px solid rgba(45, 212, 191, 0.15)",
              fontSize: "9.5px",
              fontWeight: 700,
              color: "rgba(255, 255, 255, 0.5)",
              letterSpacing: "0.06em",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>COMMITS ({filteredCommits.length})</span>
          </div>

          {loading ? (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "rgba(255, 255, 255, 0.5)" }}>
              <div style={{ color: "#2dd4bf", marginBottom: "6px" }}>⚡ READING GIT LOG...</div>
              <span>Fetching commit timeline</span>
            </div>
          ) : error ? (
            <div style={{ padding: "16px", color: "#f87171" }}>
              <b>Failed to load history:</b> {error}
            </div>
          ) : filteredCommits.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "rgba(255, 255, 255, 0.4)" }}>
              {commitSearchQuery ? "No commits matching search" : "No commits found in repository"}
            </div>
          ) : (
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
              {filteredCommits.map((c) => {
                const isSelected = selectedHash === c.hash;
                const relTime = formatRelativeTime(c.timestamp);
                return (
                  <div
                    key={c.hash}
                    onClick={() => setSelectedHash(c.hash)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setSelectedHash(c.hash);
                    }}
                    style={{
                      padding: "8px 12px",
                      borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
                      borderLeft: isSelected ? "3px solid #2dd4bf" : "3px solid transparent",
                      background: isSelected ? "rgba(45, 212, 191, 0.12)" : "transparent",
                      cursor: "pointer",
                      transition: "background 0.1s ease",
                    }}
                  >
                    {/* Top row: hash, relative time */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "6px",
                        marginBottom: "3px",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "10px",
                          fontWeight: 700,
                          color: isSelected ? "#5eead4" : "#2dd4bf",
                          letterSpacing: "0.04em",
                        }}
                      >
                        {c.short_hash}
                      </span>
                      <span
                        style={{
                          fontSize: "9.5px",
                          color: "rgba(255, 255, 255, 0.45)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {relTime}
                      </span>
                    </div>

                    {/* Commit summary */}
                    <div
                      style={{
                        fontSize: "11px",
                        fontWeight: 600,
                        color: isSelected ? "#fff" : "rgba(255, 255, 255, 0.88)",
                        marginBottom: "4px",
                        lineHeight: 1.35,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                      }}
                      title={c.summary}
                    >
                      {c.summary}
                    </div>

                    {/* Bottom row: Author and change stats */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        fontSize: "9.5px",
                        color: "rgba(255, 255, 255, 0.5)",
                      }}
                    >
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: "150px",
                        }}
                      >
                        {c.author_name}
                      </span>
                      {c.files_changed > 0 && (
                        <div style={{ display: "flex", gap: "5px", alignItems: "center" }}>
                          <span style={{ color: "#34d399" }}>+{c.insertions}</span>
                          <span style={{ color: "#f87171" }}>-{c.deletions}</span>
                          <span>({c.files_changed}f)</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* COLUMN 2: CHANGED FILES TREE VIEW */}
        <div
          style={{
            flex: "0 0 270px",
            minWidth: "210px",
            maxWidth: "360px",
            borderRight: "1px solid rgba(45, 212, 191, 0.18)",
            display: "flex",
            flexDirection: "column",
            background: "#060910",
            overflow: "hidden",
          }}
        >
          {/* Header toolbar for files panel */}
          <div
            style={{
              padding: "6px 10px",
              background: "rgba(9, 15, 24, 0.96)",
              borderBottom: "1px solid rgba(45, 212, 191, 0.15)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "6px",
            }}
          >
            <span style={{ fontSize: "9.5px", fontWeight: 700, color: "rgba(255, 255, 255, 0.6)", letterSpacing: "0.06em" }}>
              FILES {commitDetail ? `(${commitDetail.files.length})` : ""}
            </span>

            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              {fileViewMode === "tree" && (
                <button
                  type="button"
                  onClick={handleToggleExpandAll}
                  title={expandedDirs.size > 0 ? "Collapse all folders" : "Expand all folders"}
                  style={{
                    background: "rgba(255, 255, 255, 0.05)",
                    border: "1px solid rgba(255, 255, 255, 0.12)",
                    color: "rgba(255, 255, 255, 0.7)",
                    padding: "1px 5px",
                    borderRadius: "2px",
                    fontSize: "9px",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  {expandedDirs.size > 0 ? "▲" : "▼"}
                </button>
              )}

              <button
                type="button"
                onClick={() => setFileViewMode((m) => (m === "tree" ? "flat" : "tree"))}
                title={`Switch to ${fileViewMode === "tree" ? "flat list" : "tree view"}`}
                style={{
                  background: "rgba(45, 212, 191, 0.12)",
                  border: "1px solid rgba(45, 212, 191, 0.3)",
                  color: "#2dd4bf",
                  padding: "1px 6px",
                  borderRadius: "2px",
                  fontSize: "8.5px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontWeight: 600,
                }}
              >
                {fileViewMode === "tree" ? "⊞ TREE" : "☰ FLAT"}
              </button>
            </div>
          </div>

          {/* Search/filter inside this commit's files */}
          <div style={{ padding: "5px 8px", borderBottom: "1px solid rgba(255, 255, 255, 0.05)" }}>
            <input
              type="search"
              value={treeSearchQuery}
              onChange={(e) => setTreeSearchQuery(e.target.value)}
              placeholder="Filter changed files..."
              style={{
                width: "100%",
                background: "rgba(0, 0, 0, 0.4)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                borderRadius: "2px",
                padding: "3px 6px",
                color: "#fff",
                fontSize: "10px",
                fontFamily: "inherit",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          {/* File Tree / Flat List Content */}
          <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "4px 0" }}>
            {detailLoading ? (
              <div style={{ padding: "30px 14px", textAlign: "center", color: "rgba(255, 255, 255, 0.4)", fontSize: "10.5px" }}>
                Loading files…
              </div>
            ) : !commitDetail || commitDetail.files.length === 0 ? (
              <div style={{ padding: "30px 14px", textAlign: "center", color: "rgba(255, 255, 255, 0.35)", fontSize: "10.5px" }}>
                No files modified in this commit.
              </div>
            ) : fileViewMode === "tree" ? (
              displayTree.length === 0 ? (
                <div style={{ padding: "20px 14px", textAlign: "center", color: "rgba(255, 255, 255, 0.35)", fontSize: "10.5px" }}>
                  No matching files.
                </div>
              ) : (
                displayTree.map((node) => renderTreeNode(node, 0))
              )
            ) : (
              /* Flat Mode */
              displayFlatFiles.map((file: GitCommitFile) => {
                const isFileSelected = selectedCommitFile === file.path;
                const stColor = statusBadgeColor(file.status);
                const stLabel = statusBadgeLabel(file.status);
                return (
                  <div
                    key={file.path}
                    onClick={() => setSelectedCommitFile(file.path)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setSelectedCommitFile(file.path);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "4px 10px",
                      cursor: "pointer",
                      fontSize: "11px",
                      borderLeft: isFileSelected ? "3px solid #2dd4bf" : "3px solid transparent",
                      background: isFileSelected ? "rgba(45, 212, 191, 0.2)" : "transparent",
                      color: isFileSelected ? "#fff" : "rgba(255, 255, 255, 0.85)",
                    }}
                    title={file.path}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                      <span style={{ fontSize: "9px", fontWeight: 700, color: stColor }}>[{stLabel}]</span>
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {file.path}
                      </span>
                    </div>

                    <div style={{ display: "flex", gap: "4px", fontSize: "8.5px", flexShrink: 0 }}>
                      {file.added > 0 && <span style={{ color: "#34d399" }}>+{file.added}</span>}
                      {file.removed > 0 && <span style={{ color: "#f87171" }}>-{file.removed}</span>}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* COLUMN 3: SELECTED COMMIT DETAIL & FILE DIFF VIEWER */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            background: "#04070c",
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          {detailLoading && !commitDetail ? (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "rgba(255, 255, 255, 0.5)" }}>
              <div style={{ color: "#2dd4bf", marginBottom: "6px" }}>⚡ LOADING COMMIT DETAILS...</div>
              <span>Inspecting commit snapshot</span>
            </div>
          ) : detailError ? (
            <div style={{ padding: "20px", color: "#f87171" }}>
              <b>Error:</b> {detailError}
            </div>
          ) : !commitDetail ? (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "rgba(255, 255, 255, 0.35)" }}>
              Select a commit from the timeline to view details and inspect file diffs.
            </div>
          ) : (
            <>
              {/* Commit Header Card */}
              <div
                style={{
                  padding: "10px 14px",
                  background: "rgba(8, 14, 22, 0.98)",
                  borderBottom: "1px solid rgba(45, 212, 191, 0.2)",
                  flexShrink: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                {/* Summary & Copy SHA */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "10px" }}>
                  <div style={{ fontSize: "13px", fontWeight: 700, color: "#fff", lineHeight: 1.4 }}>
                    {commitDetail.summary}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopyHash(commitDetail.hash)}
                    title="Copy full commit SHA"
                    style={{
                      background: "rgba(45, 212, 191, 0.12)",
                      border: "1px solid rgba(45, 212, 191, 0.3)",
                      color: "#2dd4bf",
                      padding: "2px 8px",
                      borderRadius: "3px",
                      fontSize: "9.5px",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {copiedHash === commitDetail.hash ? "✓ COPIED" : `⧉ ${commitDetail.short_hash}`}
                  </button>
                </div>

                {/* Body message if multi-line */}
                {commitDetail.body && (
                  <div
                    style={{
                      fontSize: "11px",
                      color: "rgba(255, 255, 255, 0.7)",
                      whiteSpace: "pre-wrap",
                      background: "rgba(0, 0, 0, 0.25)",
                      padding: "6px 8px",
                      borderRadius: "3px",
                      maxHeight: "80px",
                      overflowY: "auto",
                      border: "1px solid rgba(255, 255, 255, 0.05)",
                    }}
                  >
                    {commitDetail.body}
                  </div>
                )}

                {/* Metadata strip: Author, date, parents */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "14px",
                    fontSize: "9.5px",
                    color: "rgba(255, 255, 255, 0.5)",
                    flexWrap: "wrap",
                  }}
                >
                  <span>
                    <b>Author:</b> {commitDetail.author_name} &lt;{commitDetail.author_email}&gt;
                  </span>
                  <span>
                    <b>Date:</b> {formatCommitDate(commitDetail.timestamp)}
                  </span>
                  {commitDetail.parents.length > 0 && (
                    <span>
                      <b>Parent:</b> {commitDetail.parents.map((p) => p.slice(0, 7)).join(", ")}
                    </span>
                  )}
                </div>
              </div>

              {/* Active File Bar & View Controls */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 12px",
                  background: "rgba(5, 9, 15, 0.95)",
                  borderBottom: "1px solid rgba(45, 212, 191, 0.15)",
                  gap: "8px",
                  flexShrink: 0,
                  flexWrap: "wrap",
                }}
              >
                {/* Active file path badge */}
                <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, flex: 1 }}>
                  {selectedCommitFile ? (
                    <>
                      <span style={{ fontSize: "11px", color: "#2dd4bf" }}>📄</span>
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 600,
                          color: "#fff",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {selectedCommitFile}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleOpenEditor(selectedCommitFile)}
                        title={`Open ${selectedCommitFile} in editor`}
                        style={{
                          background: "rgba(255, 255, 255, 0.06)",
                          border: "1px solid rgba(255, 255, 255, 0.15)",
                          color: "rgba(255, 255, 255, 0.8)",
                          padding: "2px 7px",
                          fontSize: "9px",
                          borderRadius: "3px",
                          cursor: "pointer",
                          fontFamily: "inherit",
                          marginLeft: "4px",
                        }}
                      >
                        ↗ OPEN IN EDITOR
                      </button>
                    </>
                  ) : (
                    <span style={{ fontSize: "11px", color: "rgba(255, 255, 255, 0.4)" }}>
                      Select a file from the tree to inspect diff
                    </span>
                  )}
                </div>

                {/* Unified / Side-by-Side toggle */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    background: "rgba(0, 0, 0, 0.5)",
                    padding: "2px",
                    borderRadius: "3px",
                    border: "1px solid rgba(45, 212, 191, 0.25)",
                    flexShrink: 0,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setDiffViewMode("unified")}
                    style={{
                      background: diffViewMode === "unified" ? "rgba(45, 212, 191, 0.25)" : "transparent",
                      color: diffViewMode === "unified" ? "#2dd4bf" : "rgba(255, 255, 255, 0.45)",
                      border: "none",
                      padding: "2px 7px",
                      fontSize: "8.5px",
                      borderRadius: "2px",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontWeight: diffViewMode === "unified" ? 600 : 400,
                    }}
                  >
                    UNIFIED
                  </button>
                  <button
                    type="button"
                    onClick={() => setDiffViewMode("split")}
                    style={{
                      background: diffViewMode === "split" ? "rgba(45, 212, 191, 0.25)" : "transparent",
                      color: diffViewMode === "split" ? "#2dd4bf" : "rgba(255, 255, 255, 0.45)",
                      border: "none",
                      padding: "2px 7px",
                      fontSize: "8.5px",
                      borderRadius: "2px",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontWeight: diffViewMode === "split" ? 600 : 400,
                    }}
                  >
                    SIDE-BY-SIDE
                  </button>
                </div>
              </div>

              {/* Diff Content Body */}
              <div
                style={{
                  flex: 1,
                  overflow: "auto",
                  padding: "10px 14px",
                  background: "#04070c",
                  fontSize: "11px",
                  lineHeight: "1.45",
                }}
              >
                {diffLoading ? (
                  <div style={{ padding: "40px 20px", textAlign: "center", color: "rgba(255, 255, 255, 0.5)" }}>
                    <div style={{ color: "#2dd4bf", marginBottom: "6px" }}>⚡ COMPUTING COMMIT DIFF...</div>
                    <span>Loading diff for {selectedCommitFile}</span>
                  </div>
                ) : diffError ? (
                  <div style={{ padding: "16px", color: "#f87171" }}>
                    <b>Failed to load file diff:</b> {diffError}
                  </div>
                ) : !fileDiffData ? (
                  <div style={{ padding: "30px 16px", textAlign: "center", color: "rgba(255, 255, 255, 0.4)" }}>
                    Select a modified file from the tree to view diff.
                  </div>
                ) : fileDiffData.is_binary ? (
                  <div style={{ padding: "30px 16px", textAlign: "center", color: "rgba(255, 255, 255, 0.5)" }}>
                    <div style={{ color: "#ff9a3c", marginBottom: "6px", fontWeight: "bold" }}>
                      BINARY FILE MODIFIED
                    </div>
                    <span>Binary file diff cannot be displayed as text.</span>
                  </div>
                ) : !fileDiffData.diff.trim() ? (
                  <div style={{ padding: "30px 16px", textAlign: "center", color: "rgba(255, 255, 255, 0.5)" }}>
                    <span>No textual differences recorded for this file in commit.</span>
                  </div>
                ) : diffViewMode === "unified" ? (
                  /* UNIFIED DIFF VIEW */
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {fileDiffData.diff.split("\n").map((line, idx) => {
                      const isAdd = line.startsWith("+") && !line.startsWith("+++");
                      const isRem = line.startsWith("-") && !line.startsWith("---");
                      const isHunk = line.startsWith("@@");
                      const isHeader =
                        line.startsWith("diff --git") ||
                        line.startsWith("index ") ||
                        line.startsWith("---") ||
                        line.startsWith("+++");

                      let bg = "transparent";
                      let color = "rgba(255, 255, 255, 0.75)";
                      if (isAdd) {
                        bg = "rgba(45, 212, 191, 0.12)";
                        color = "#34d399";
                      } else if (isRem) {
                        bg = "rgba(248, 113, 113, 0.12)";
                        color = "#f87171";
                      } else if (isHunk) {
                        bg = "rgba(56, 189, 248, 0.08)";
                        color = "#38bdf8";
                      } else if (isHeader) {
                        color = "rgba(255, 255, 255, 0.4)";
                      }

                      return (
                        <div
                          key={idx}
                          style={{
                            display: "flex",
                            background: bg,
                            minHeight: "18px",
                            padding: "0 6px",
                            borderRadius: "2px",
                          }}
                        >
                          <span
                            style={{
                              width: "36px",
                              flexShrink: 0,
                              color: "rgba(255, 255, 255, 0.2)",
                              userSelect: "none",
                              fontSize: "9.5px",
                              textAlign: "right",
                              marginRight: "12px",
                              paddingTop: "1px",
                            }}
                          >
                            {idx + 1}
                          </span>
                          <pre
                            style={{
                              margin: 0,
                              color,
                              fontFamily: "inherit",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-all",
                            }}
                          >
                            {line || " "}
                          </pre>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  /* SIDE-BY-SIDE DIFF VIEW */
                  <div style={{ display: "flex", flexDirection: "column", minWidth: "100%" }}>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "38px 1fr 38px 1fr",
                        gap: "0 4px",
                        background: "rgba(255, 255, 255, 0.03)",
                        borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
                        padding: "4px 6px",
                        fontSize: "9.5px",
                        fontWeight: "bold",
                        color: "rgba(255, 255, 255, 0.4)",
                        userSelect: "none",
                        marginBottom: "4px",
                      }}
                    >
                      <span style={{ textAlign: "right" }}>#</span>
                      <span style={{ color: "#f87171" }}>PARENT COMMIT</span>
                      <span style={{ textAlign: "right" }}>#</span>
                      <span style={{ color: "#34d399" }}>COMMIT {commitDetail.short_hash}</span>
                    </div>

                    {splitDiffRows.map((row, idx) => {
                      if (row.type === "hunk") {
                        return (
                          <div
                            key={idx}
                            style={{
                              padding: "3px 8px",
                              margin: "4px 0",
                              background: "rgba(56, 189, 248, 0.1)",
                              border: "1px solid rgba(56, 189, 248, 0.2)",
                              borderRadius: "2px",
                              color: "#38bdf8",
                              fontSize: "10px",
                              fontWeight: 600,
                            }}
                          >
                            {row.metaText}
                          </div>
                        );
                      }

                      const oldBg =
                        row.oldKind === "removed" ? "rgba(248, 113, 113, 0.15)" : "transparent";
                      const newBg =
                        row.newKind === "added" ? "rgba(45, 212, 191, 0.15)" : "transparent";

                      return (
                        <div
                          key={idx}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "38px 1fr 38px 1fr",
                            gap: "0 4px",
                            minHeight: "18px",
                            padding: "0 2px",
                          }}
                        >
                          <span
                            style={{
                              color: "rgba(255, 255, 255, 0.2)",
                              userSelect: "none",
                              fontSize: "9.5px",
                              textAlign: "right",
                              paddingRight: "6px",
                            }}
                          >
                            {row.oldLineNo ?? ""}
                          </span>
                          <pre
                            style={{
                              margin: 0,
                              background: oldBg,
                              color: row.oldKind === "removed" ? "#f87171" : "rgba(255, 255, 255, 0.75)",
                              fontFamily: "inherit",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-all",
                              padding: "0 4px",
                              borderRadius: "2px",
                            }}
                          >
                            {row.oldText || " "}
                          </pre>
                          <span
                            style={{
                              color: "rgba(255, 255, 255, 0.2)",
                              userSelect: "none",
                              fontSize: "9.5px",
                              textAlign: "right",
                              paddingRight: "6px",
                            }}
                          >
                            {row.newLineNo ?? ""}
                          </span>
                          <pre
                            style={{
                              margin: 0,
                              background: newBg,
                              color: row.newKind === "added" ? "#34d399" : "rgba(255, 255, 255, 0.75)",
                              fontFamily: "inherit",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-all",
                              padding: "0 4px",
                              borderRadius: "2px",
                            }}
                          >
                            {row.newText || " "}
                          </pre>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
