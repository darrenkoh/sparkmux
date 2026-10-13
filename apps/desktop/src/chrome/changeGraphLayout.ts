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

export type CardOrganizationMode = "grid" | "pipeline" | "modules" | "impact" | "radial";

export interface CardLayoutInput {
  id: string;
  repoId: string;
  repoName: string;
  isPrimaryRepo: boolean;
  path: string;
  filename: string;
  dir: string;
  extension: string;
  status: string;
  agentEdited: boolean;
  linesAdded: number;
  linesRemoved: number;
}

export interface CardPosition {
  x: number;
  y: number;
  column?: number;
}

export interface LaneHeader {
  id: string;
  title: string;
  count: number;
  x: number;
  y: number;
  width: number;
  color: string;
  badge?: string;
}

export interface OrbitRing {
  cx: number;
  cy: number;
  r: number;
  label: string;
}

export interface CardArrangementResult {
  positions: { [id: string]: CardPosition };
  laneHeaders: LaneHeader[];
  orbitRings: OrbitRing[];
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    width: number;
    height: number;
  };
}

export const CARD_WIDTH = 270;
export const CARD_HEIGHT = 138;

export function arrangeCards(
  cards: CardLayoutInput[],
  mode: CardOrganizationMode,
  viewportWidth: number,
  viewportHeight: number,
): CardArrangementResult {
  const vw = Math.max(viewportWidth, 600);
  const vh = Math.max(viewportHeight, 400);

  const positions: { [id: string]: CardPosition } = {};
  const laneHeaders: LaneHeader[] = [];
  const orbitRings: OrbitRing[] = [];

  if (cards.length === 0) {
    return {
      positions: {},
      laneHeaders: [],
      orbitRings: [],
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 },
    };
  }

  switch (mode) {
    case "pipeline": {
      // 1. PIPELINE: Git change lifecycle kanban lanes
      const laneDefs = [
        {
          id: "agent",
          title: "⚡ AGENT EDITS",
          badge: "AI MODIFIED",
          color: "#e8a849",
          filter: (c: CardLayoutInput) => c.agentEdited,
        },
        {
          id: "modified",
          title: "✏️ MODIFIED",
          badge: "STAGED / WORKTREE",
          color: "#2dd4bf",
          filter: (c: CardLayoutInput) => !c.agentEdited && (c.status === "modified" || c.status === "edited"),
        },
        {
          id: "added",
          title: "＋ ADDED & NEW",
          badge: "UNTRACKED / ADDED",
          color: "#38bdf8",
          filter: (c: CardLayoutInput) => !c.agentEdited && (c.status === "added" || c.status === "untracked"),
        },
        {
          id: "other",
          title: "🗂 OTHER CHANGES",
          badge: "DELETED / RENAMED",
          color: "#c084fc",
          filter: (c: CardLayoutInput) =>
            !c.agentEdited &&
            c.status !== "modified" &&
            c.status !== "edited" &&
            c.status !== "added" &&
            c.status !== "untracked",
        },
      ];

      const lanes = laneDefs.map((def) => ({
        ...def,
        items: cards.filter(def.filter),
      }));

      // Keep lanes that have items, or show at least the first 2 lanes if empty
      const activeLanes = lanes.filter((l) => l.items.length > 0);
      const displayLanes = activeLanes.length > 0 ? activeLanes : lanes.slice(0, 3);

      const numLanes = displayLanes.length;
      const gap = 36;
      const laneW = Math.max(CARD_WIDTH, Math.floor((vw - 80 - (numLanes - 1) * gap) / numLanes));
      const totalW = numLanes * laneW + (numLanes - 1) * gap;
      const startX = Math.max(40, (vw - totalW) / 2);
      const startY = 96;

      displayLanes.forEach((lane, laneIdx) => {
        const lx = startX + laneIdx * (laneW + gap);
        laneHeaders.push({
          id: `lane-header-${lane.id}`,
          title: lane.title,
          badge: lane.badge,
          count: lane.items.length,
          x: lx,
          y: 48,
          width: laneW,
          color: lane.color,
        });

        lane.items.forEach((card, itemIdx) => {
          const cardX = lx + (laneW - CARD_WIDTH) / 2;
          const cardY = startY + itemIdx * (CARD_HEIGHT + 24);
          positions[card.id] = { x: cardX, y: cardY, column: laneIdx };
        });
      });
      break;
    }

    case "modules": {
      // 2. MODULES: Group by directory / subsystem clusters
      const dirMap: { [dir: string]: CardLayoutInput[] } = {};
      cards.forEach((c) => {
        const key = c.dir || ".";
        if (!dirMap[key]) dirMap[key] = [];
        dirMap[key].push(c);
      });

      const dirEntries = Object.entries(dirMap).sort((a, b) => {
        const aHasAgent = a[1].some((c) => c.agentEdited);
        const bHasAgent = b[1].some((c) => c.agentEdited);
        if (aHasAgent !== bHasAgent) return aHasAgent ? -1 : 1;
        return a[0].localeCompare(b[0]);
      });

      const colGap = 40;
      const rowGap = 20;
      const colWidth = CARD_WIDTH;
      const numCols = Math.max(1, Math.min(dirEntries.length, Math.floor((vw - 80) / (colWidth + colGap))));
      const totalW = numCols * colWidth + (numCols - 1) * colGap;
      const startX = Math.max(40, (vw - totalW) / 2);

      // Distribute directory clusters across columns using shortest column heuristic
      const colHeights = new Array(numCols).fill(80);

      dirEntries.forEach(([dirName, groupCards]) => {
        // Find shortest column
        let shortestCol = 0;
        let minH = colHeights[0];
        for (let i = 1; i < numCols; i++) {
          if (colHeights[i] < minH) {
            minH = colHeights[i];
            shortestCol = i;
          }
        }

        const colX = startX + shortestCol * (colWidth + colGap);
        const headerY = colHeights[shortestCol]!;

        laneHeaders.push({
          id: `dir-header-${dirName}`,
          title: `📁 ${dirName}`,
          badge: `${groupCards.length} files`,
          count: groupCards.length,
          x: colX,
          y: headerY - 32,
          width: colWidth,
          color: groupCards.some((c) => c.agentEdited) ? "#e8a849" : "#2dd4bf",
        });

        groupCards.forEach((card, idx) => {
          const cardY = colHeights[shortestCol]! + idx * (CARD_HEIGHT + rowGap);
          positions[card.id] = { x: colX, y: cardY, column: shortestCol };
        });

        colHeights[shortestCol] += groupCards.length * (CARD_HEIGHT + rowGap) + 54;
      });
      break;
    }

    case "impact": {
      // 3. IMPACT: Churn magnitude waterfall
      const sorted = [...cards].sort((a, b) => {
        const scoreA = (a.agentEdited ? 3000 : 0) + (a.linesAdded + a.linesRemoved) * 10;
        const scoreB = (b.agentEdited ? 3000 : 0) + (b.linesAdded + b.linesRemoved) * 10;
        return scoreB - scoreA;
      });

      const gapX = 36;
      const gapY = 28;
      const maxCols = Math.max(1, Math.min(sorted.length, Math.floor((vw - 80) / (CARD_WIDTH + gapX))));
      const totalW = maxCols * CARD_WIDTH + (maxCols - 1) * gapX;
      const startX = Math.max(40, (vw - totalW) / 2);
      const startY = 80;

      sorted.forEach((card, idx) => {
        const col = idx % maxCols;
        const row = Math.floor(idx / maxCols);
        positions[card.id] = {
          x: startX + col * (CARD_WIDTH + gapX),
          y: startY + row * (CARD_HEIGHT + gapY),
          column: col,
        };
      });

      // Add high-impact summary badge
      const topCount = Math.min(3, sorted.length);
      laneHeaders.push({
        id: "impact-header-top",
        title: "🔥 HIGHEST CHURN & HOTSPOTS",
        badge: `TOP ${topCount}`,
        count: sorted.length,
        x: startX,
        y: 40,
        width: totalW,
        color: "#f87171",
      });
      break;
    }

    case "radial": {
      // 4. RADIAL: Constellation orbit layout
      const cx = vw / 2;
      const cy = vh / 2 + 10;

      const sorted = [...cards].sort((a, b) => {
        if (a.agentEdited !== b.agentEdited) return a.agentEdited ? -1 : 1;
        return b.linesAdded + b.linesRemoved - (a.linesAdded + a.linesRemoved);
      });

      // Rings allocation
      const ringCards: CardLayoutInput[][] = [];
      if (sorted.length <= 4) {
        ringCards.push(sorted);
      } else if (sorted.length <= 12) {
        ringCards.push(sorted.slice(0, 3));
        ringCards.push(sorted.slice(3));
      } else {
        ringCards.push(sorted.slice(0, 3));
        ringCards.push(sorted.slice(3, 10));
        ringCards.push(sorted.slice(10));
      }

      const baseR = Math.max(170, Math.min(vw, vh) * 0.22);
      const rStep = CARD_HEIGHT + 64;

      ringCards.forEach((group, ringIdx) => {
        const r = baseR + ringIdx * rStep;
        orbitRings.push({
          cx,
          cy,
          r,
          label: ringIdx === 0 ? "CORE ORBIT (PRIMARY / AI)" : `RING ${ringIdx + 1}`,
        });

        const count = group.length;
        group.forEach((card, idx) => {
          const angle = -Math.PI / 2 + (idx * 2 * Math.PI) / count;
          const x = cx + r * Math.cos(angle) - CARD_WIDTH / 2;
          const y = cy + r * Math.sin(angle) - CARD_HEIGHT / 2;
          positions[card.id] = { x, y, column: ringIdx };
        });
      });
      break;
    }

    case "grid":
    default: {
      // 5. GRID: Responsive balanced matrix
      const gapX = 36;
      const gapY = 28;
      const padX = 40;
      const padY = 40;
      const availW = Math.max(CARD_WIDTH, vw - padX * 2);

      const maxFitCols = Math.max(1, Math.floor((availW + gapX) / (CARD_WIDTH + gapX)));
      const cols = Math.max(1, Math.min(cards.length, maxFitCols));

      const rows = Math.ceil(cards.length / cols);
      const totalW = cols * CARD_WIDTH + (cols - 1) * gapX;
      const totalH = rows * CARD_HEIGHT + (rows - 1) * gapY;

      const startX = Math.max(padX, (vw - totalW) / 2);
      const startY = Math.max(padY, (vh - totalH) / 2);

      cards.forEach((card, idx) => {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        positions[card.id] = {
          x: startX + col * (CARD_WIDTH + gapX),
          y: startY + row * (CARD_HEIGHT + gapY),
          column: col,
        };
      });
      break;
    }
  }

  // Compute overall bounds
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const card of cards) {
    const pos = positions[card.id];
    if (!pos) continue;
    if (pos.x < minX) minX = pos.x;
    if (pos.x + CARD_WIDTH > maxX) maxX = pos.x + CARD_WIDTH;
    if (pos.y < minY) minY = pos.y;
    if (pos.y + CARD_HEIGHT > maxY) maxY = pos.y + CARD_HEIGHT;
  }

  if (minX === Infinity) {
    minX = 0;
    maxX = 0;
    minY = 0;
    maxY = 0;
  }

  return {
    positions,
    laneHeaders,
    orbitRings,
    bounds: {
      minX,
      maxX,
      minY,
      maxY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
    },
  };
}

export function computeFitCamera(
  positions: { [id: string]: CardPosition },
  viewportWidth: number,
  viewportHeight: number,
  cardWidth: number = CARD_WIDTH,
  cardHeight: number = CARD_HEIGHT,
): { zoom: number; pan: { x: number; y: number } } {
  const keys = Object.keys(positions);
  if (keys.length === 0) {
    return { zoom: 1.0, pan: { x: 0, y: 0 } };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const k of keys) {
    const p = positions[k]!;
    if (p.x < minX) minX = p.x;
    if (p.x + cardWidth > maxX) maxX = p.x + cardWidth;
    if (p.y < minY) minY = p.y;
    if (p.y + cardHeight > maxY) maxY = p.y + cardHeight;
  }

  const boxW = Math.max(cardWidth, maxX - minX);
  const boxH = Math.max(cardHeight, maxY - minY);
  const padX = 100;
  const padY = 100;

  const availW = Math.max(120, viewportWidth - padX);
  const availH = Math.max(120, viewportHeight - padY);

  const scaleX = availW / boxW;
  const scaleY = availH / boxH;
  const fitZoom = Math.min(1.15, Math.max(0.35, Math.min(scaleX, scaleY)));

  const centerX = minX + boxW / 2;
  const centerY = minY + boxH / 2;

  const panX = viewportWidth / 2 - centerX * fitZoom;
  const panY = viewportHeight / 2 - centerY * fitZoom;

  return { zoom: fitZoom, pan: { x: panX, y: panY } };
}


