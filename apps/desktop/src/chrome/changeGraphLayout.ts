export interface GraphFile {
  path: string;
  status: string;
  agent_edited: boolean;
  lines_added: number;
  lines_removed: number;
}

export interface GraphRepo {
  id: string;
  name: string;
  primary: boolean;
  files: GraphFile[];
}

export interface GraphEdge {
  from_repo: string;
  to_repo: string;
  label: string;
  via: string;
}

export interface LayoutNode {
  id: string;
  repoId: string;
  path: string;
  status: string;
  agentEdited: boolean;
  linesAdded: number;
  linesRemoved: number;
  x: number;
  y: number;
  r: number;
}

export interface LayoutCluster {
  id: string;
  name: string;
  primary: boolean;
  x: number;
  y: number;
  r: number;
}

export interface LayoutLink {
  from: string;
  to: string;
  label: string;
  via: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx: number;
  cy: number;
}

export interface ConstellationLayout {
  clusters: LayoutCluster[];
  nodes: LayoutNode[];
  links: LayoutLink[];
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export function statusLabel(status: string): string {
  switch (status) {
    case "modified":
      return "Modified";
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "untracked":
      return "Untracked";
    case "renamed":
      return "Renamed";
    case "edited":
      return "Edited this session";
    case "library":
      return "Library";
    case "referenced":
      return "Referenced";
    default:
      return status;
  }
}

export function statusColor(status: string): string {
  switch (status) {
    case "modified":
    case "edited":
      return "#e8a849";
    case "added":
      return "#2dd4bf";
    case "deleted":
      return "#f87171";
    case "untracked":
      return "#7aa2f7";
    case "renamed":
      return "#c084fc";
    case "referenced":
      return "#5eead4";
    case "library":
      return "#94a3b8";
    default:
      return "#e9e9e9";
  }
}

export function fileBasename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function layoutConstellation(
  repos: GraphRepo[],
  edges: GraphEdge[],
  width: number,
  height: number,
): ConstellationLayout {
  const w = Math.max(width, 320);
  const h = Math.max(height, 240);
  const ordered = [...repos].sort((left, right) => {
    if (left.primary !== right.primary) return left.primary ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  const radii = ordered.map((repo) => clusterRadius(repo.files.length, Math.min(w, h)));
  const centers = placeClusters(ordered.length, w, h, radii);
  const clusters: LayoutCluster[] = ordered.map((repo, index) => {
    const radius = radii[index] ?? 72;
    const center = clampCenter(centers[index]?.x ?? w / 2, centers[index]?.y ?? h / 2, radius, w, h);
    return {
      id: repo.id,
      name: repo.name,
      primary: repo.primary,
      x: center.x,
      y: center.y,
      r: radius,
    };
  });

  const nodes: LayoutNode[] = [];
  ordered.forEach((repo, index) => {
    const cluster = clusters[index];
    if (!cluster) return;
    const count = Math.max(repo.files.length, 1);
    repo.files.forEach((file, fileIndex) => {
      const point =
        repo.files.length === 1
          ? { x: cluster.x, y: cluster.y }
          : phyllotaxis(cluster.x, cluster.y, cluster.r, fileIndex, count);
      nodes.push({
        id: `${repo.id}\n${file.path}`,
        repoId: repo.id,
        path: file.path,
        status: file.status,
        agentEdited: file.agent_edited,
        linesAdded: file.lines_added,
        linesRemoved: file.lines_removed,
        x: point.x,
        y: point.y,
        r: repo.files.length > 28 ? 4.5 : 6.5,
      });
    });
  });

  const byPair = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const key = `${edge.from_repo}\n${edge.to_repo}`;
    const list = byPair.get(key) ?? [];
    list.push(edge);
    byPair.set(key, list);
  }
  const links: LayoutLink[] = [];
  let pairIndex = 0;
  for (const group of byPair.values()) {
    const first = group[0];
    if (!first) continue;
    const from = clusters.find((cluster) => cluster.id === first.from_repo);
    const to = clusters.find((cluster) => cluster.id === first.to_repo);
    if (!from || !to) continue;
    const labels = group
      .map((edge) => edge.label)
      .filter((label, index, all) => label && all.indexOf(label) === index)
      .slice(0, 3);
    const via = group.find((edge) => edge.via)?.via ?? "";
    links.push(curveBetween(from, to, labels.join(" · "), via, pairIndex));
    pairIndex += 1;
  }

  return { clusters, nodes, links };
}

function clusterRadius(count: number, room: number): number {
  const grown = 78 + Math.sqrt(Math.max(count, 1)) * 16;
  return Math.max(70, Math.min(grown, room * 0.28, 168));
}

function placeClusters(count: number, width: number, height: number, radii: number[]): { x: number; y: number }[] {
  if (count <= 0) return [];
  if (count === 1) return [{ x: width / 2, y: height / 2 }];
  const cx = width / 2;
  const cy = height / 2 + 6;
  const primary = radii[0] ?? 80;
  const rx = Math.max(120, width * 0.33 - primary * 0.2);
  const ry = Math.max(90, height * 0.3 - primary * 0.15);
  return radii.map((_, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
    return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
  });
}

function clampCenter(x: number, y: number, radius: number, width: number, height: number) {
  const pad = 28;
  return {
    x: Math.min(width - radius - pad, Math.max(radius + pad, x)),
    y: Math.min(height - radius - pad, Math.max(radius + pad, y)),
  };
}

function phyllotaxis(cx: number, cy: number, radius: number, index: number, count: number) {
  const distance = radius * (0.22 + 0.68 * Math.sqrt((index + 0.5) / count));
  const angle = index * GOLDEN;
  return {
    x: cx + distance * Math.cos(angle),
    y: cy + distance * Math.sin(angle),
  };
}

function curveBetween(
  from: LayoutCluster,
  to: LayoutCluster,
  label: string,
  via: string,
  index: number,
): LayoutLink {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const x1 = from.x + ux * (from.r + 8);
  const y1 = from.y + uy * (from.r + 8);
  const x2 = to.x - ux * (to.r + 8);
  const y2 = to.y - uy * (to.r + 8);
  const bend = (index % 2 === 0 ? 1 : -1) * (42 + (index % 3) * 16);
  return {
    from: from.id,
    to: to.id,
    label,
    via,
    x1,
    y1,
    x2,
    y2,
    cx: (x1 + x2) / 2 + -uy * bend,
    cy: (y1 + y2) / 2 + ux * bend,
  };
}

export interface SplitDiffRow {
  type: "meta" | "hunk" | "line";
  metaText?: string;
  oldLineNo?: number | null;
  oldText?: string;
  oldKind?: "context" | "removed" | "empty";
  newLineNo?: number | null;
  newText?: string;
  newKind?: "context" | "added" | "empty";
}

export function parseSideBySideDiff(rawDiff: string): SplitDiffRow[] {
  if (!rawDiff) return [];
  const lines = rawDiff.split("\n");
  const rows: SplitDiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;

  let pendingRemovals: { lineNo: number; text: string }[] = [];
  let pendingAdditions: { lineNo: number; text: string }[] = [];

  const flushPending = () => {
    const maxLen = Math.max(pendingRemovals.length, pendingAdditions.length);
    for (let i = 0; i < maxLen; i++) {
      const rem = pendingRemovals[i];
      const add = pendingAdditions[i];
      rows.push({
        type: "line",
        oldLineNo: rem ? rem.lineNo : null,
        oldText: rem ? rem.text : "",
        oldKind: rem ? "removed" : "empty",
        newLineNo: add ? add.lineNo : null,
        newText: add ? add.text : "",
        newKind: add ? "added" : "empty",
      });
    }
    pendingRemovals = [];
    pendingAdditions = [];
  };

  for (const line of lines) {
    if (line.startsWith("@@")) {
      flushPending();
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1]!, 10);
        newLine = parseInt(match[2]!, 10);
      }
      rows.push({
        type: "hunk",
        metaText: line,
      });
    } else if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      flushPending();
      rows.push({
        type: "meta",
        metaText: line,
      });
    } else if (line.startsWith("-")) {
      pendingRemovals.push({
        lineNo: oldLine++,
        text: line.slice(1),
      });
    } else if (line.startsWith("+")) {
      pendingAdditions.push({
        lineNo: newLine++,
        text: line.slice(1),
      });
    } else if (line.startsWith(" ")) {
      flushPending();
      rows.push({
        type: "line",
        oldLineNo: oldLine++,
        oldText: line.slice(1),
        oldKind: "context",
        newLineNo: newLine++,
        newText: line.slice(1),
        newKind: "context",
      });
    } else if (line.trim().length > 0) {
      flushPending();
      rows.push({
        type: "meta",
        metaText: line,
      });
    }
  }
  flushPending();
  return rows;
}

