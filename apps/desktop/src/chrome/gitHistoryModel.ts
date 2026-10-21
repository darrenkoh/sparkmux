import type { GitCommitFile, GitCommitItem } from "../api";

/** Formats a unix timestamp (in seconds) to a human-readable relative time string. */
export function formatRelativeTime(epochSecs: number, nowSecs?: number): string {
  if (!epochSecs || epochSecs <= 0) return "";
  const current = nowSecs !== undefined ? nowSecs : Math.floor(Date.now() / 1000);
  const diffSecs = Math.max(0, current - epochSecs);

  if (diffSecs < 45) return "just now";
  if (diffSecs < 90) return "1m ago";
  const mins = Math.floor(diffSecs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

/** Formats a unix timestamp (in seconds) to an absolute readable date/time string. */
export function formatCommitDate(epochSecs: number): string {
  if (!epochSecs || epochSecs <= 0) return "";
  const date = new Date(epochSecs * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Returns status badge color matching sparkmux scifi palette. */
export function statusBadgeColor(status: string): string {
  switch (status.toLowerCase()) {
    case "added":
    case "a":
      return "#34d399"; // emerald / mint
    case "deleted":
    case "d":
      return "#f87171"; // rose red
    case "renamed":
    case "r":
      return "#fbbf24"; // amber
    case "modified":
    case "m":
    default:
      return "#38bdf8"; // sky blue
  }
}

/** Returns single-letter status label. */
export function statusBadgeLabel(status: string): string {
  switch (status.toLowerCase()) {
    case "added":
    case "a":
      return "A";
    case "deleted":
    case "d":
      return "D";
    case "renamed":
    case "r":
      return "R";
    case "modified":
    case "m":
    default:
      return "M";
  }
}

/** Filters a list of commits by query string matching summary, body, author, or hash. */
export function filterCommits(commits: GitCommitItem[], query: string): GitCommitItem[] {
  const clean = query.trim().toLowerCase();
  if (!clean) return commits;
  return commits.filter((c) => {
    return (
      c.summary.toLowerCase().includes(clean) ||
      c.author_name.toLowerCase().includes(clean) ||
      c.author_email.toLowerCase().includes(clean) ||
      c.short_hash.toLowerCase().includes(clean) ||
      c.hash.toLowerCase().includes(clean) ||
      c.body.toLowerCase().includes(clean)
    );
  });
}

export interface FileTreeNode {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
  file?: GitCommitFile;
  added: number;
  removed: number;
  fileCount: number;
}

/** Builds a hierarchical tree from a list of commit changed files. */
export function buildFileTree(files: GitCommitFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const file of files) {
    const cleanPath = file.path.replace(/\\/g, "/").replace(/^\/+/, "");
    const parts = cleanPath.split("/");
    let currentLevel = root;
    let accumulatedPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
      const isLast = i === parts.length - 1;

      if (isLast) {
        // Leaf file node
        currentLevel.push({
          id: accumulatedPath,
          name: part,
          path: accumulatedPath,
          isDir: false,
          children: [],
          file,
          added: file.added,
          removed: file.removed,
          fileCount: 1,
        });
      } else {
        // Directory node
        let dirNode = currentLevel.find((n) => n.isDir && n.name === part);
        if (!dirNode) {
          dirNode = {
            id: accumulatedPath,
            name: part,
            path: accumulatedPath,
            isDir: true,
            children: [],
            added: 0,
            removed: 0,
            fileCount: 0,
          };
          currentLevel.push(dirNode);
        }
        dirNode.added += file.added;
        dirNode.removed += file.removed;
        dirNode.fileCount += 1;
        currentLevel = dirNode.children;
      }
    }
  }

  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
    return nodes
      .sort((a, b) => {
        if (a.isDir !== b.isDir) {
          return a.isDir ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      })
      .map((node) => {
        if (node.isDir) {
          return {
            ...node,
            children: sortNodes(node.children),
          };
        }
        return node;
      });
  };

  return sortNodes(root);
}

/** Collects all directory paths in tree for auto-expansion. */
export function getAllDirPaths(nodes: FileTreeNode[]): string[] {
  const dirs: string[] = [];
  const walk = (list: FileTreeNode[]) => {
    for (const node of list) {
      if (node.isDir) {
        dirs.push(node.path);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return dirs;
}

/** Recursively filters tree nodes by file or directory name/path. */
export function filterTreeNodes(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  const clean = query.trim().toLowerCase();
  if (!clean) return nodes;

  const filterList = (list: FileTreeNode[]): FileTreeNode[] => {
    const result: FileTreeNode[] = [];
    for (const node of list) {
      if (node.isDir) {
        const filteredChildren = filterList(node.children);
        if (filteredChildren.length > 0 || node.name.toLowerCase().includes(clean)) {
          result.push({
            ...node,
            children: filteredChildren,
          });
        }
      } else if (
        node.name.toLowerCase().includes(clean) ||
        node.path.toLowerCase().includes(clean)
      ) {
        result.push(node);
      }
    }
    return result;
  };

  return filterList(nodes);
}
