import { fnv1a } from "./officeModel.ts";

export interface DeskSlot {
  key: string;
  pod: string;
  pos: [number, number];
  /** Radians. π faces the back wall (−Z). */
  facing: number;
  chair: [number, number];
}

export interface Pod {
  session: string;
  rect: { x: number; z: number; w: number; d: number };
  color: number;
  label: string;
  desks: DeskSlot[];
}

export type FixtureKind =
  | "bookshelf"
  | "coffee"
  | "sofa"
  | "meeting"
  | "whiteboard"
  | "server"
  | "tv"
  | "clock"
  | "plant";

export interface Fixture {
  kind: FixtureKind;
  pos: [number, number];
  rot: number;
  anchors: [number, number][];
}

export interface OfficeLayout {
  room: { w: number; d: number };
  pods: Pod[];
  fixtures: Fixture[];
  waypoints: { nodes: [number, number][]; edges: [number, number][] };
}

export interface LayoutSession {
  session: string;
  /** Agent and free-desk keys. Sorted inside the layout. */
  keys: string[];
}

const POD_COLORS = [
  0x1e3a5f, 0x4c1d95, 0x115e59, 0x14532d, 0x7f1d1d, 0x78350f, 0x334155, 0x312e81,
];

const DESK_W = 1.6;
const DESK_D = 0.8;
const PITCH_X = 2.4;
const PITCH_Z = 2.2;
const PAD = 0.6;
const AISLE = 1.6;
const BACK = 3.5;
const FRONT = 3.5;

interface Aabb {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export function layoutOffice(input: LayoutSession[]): OfficeLayout {
  const sessions = input
    .map((row) => ({ session: row.session, keys: [...row.keys].sort() }))
    .sort((left, right) => (left.session < right.session ? -1 : left.session > right.session ? 1 : 0));
  const total = sessions.reduce((sum, row) => sum + row.keys.length, 0);
  const packW = Math.max(14, Math.ceil(Math.sqrt(total)) * 5);

  const pods: Pod[] = [];
  let cursorX = 0;
  let cursorZ = BACK;
  let rowH = 0;
  let placed = 0;
  for (const row of sessions) {
    if (row.keys.length === 0) continue;
    const size = podSize(row.keys.length);
    if (cursorX > 0 && cursorX + size.w > packW + 1e-6) {
      cursorX = 0;
      cursorZ = round3(cursorZ + rowH + AISLE);
      rowH = 0;
    }
    const pod = makePod(row.session, row.keys, cursorX, cursorZ, size);
    pods.push(pod);
    cursorX = round3(cursorX + size.w + AISLE);
    rowH = Math.max(rowH, size.d);
    placed += 1;
  }
  const podDepth = placed === 0 ? 0 : round3(cursorZ - BACK + rowH);
  const room = { w: round3(packW + 6), d: round3(podDepth + BACK + FRONT) };
  const fixtures = placeFixtures(room, pods);
  const desks = pods.flatMap((pod) => pod.desks);
  const obstacles = desks.map((desk) => deskBox(desk));
  const chairs = desks.map((desk) => desk.chair);
  const anchors = fixtures.flatMap((fixture) => fixture.anchors);
  const windows = windowAnchors(room);
  const waypoints = buildWaypoints(room, obstacles, chairs, [...anchors, ...windows]);
  return { room, pods, fixtures, waypoints };
}

export function routeBetween(
  layout: OfficeLayout,
  from: [number, number],
  to: [number, number],
): [number, number][] {
  const { nodes, edges } = layout.waypoints;
  if (nodes.length === 0) return [];
  const start = nearest(nodes, from);
  const goal = nearest(nodes, to);
  if (start === goal) return [nodes[start] ?? from];
  const adj: number[][] = nodes.map(() => []);
  for (const [left, right] of edges) {
    adj[left]?.push(right);
    adj[right]?.push(left);
  }
  const prev = new Array<number>(nodes.length).fill(-1);
  const queue = [start];
  prev[start] = start;
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index] ?? 0;
    if (current === goal) break;
    for (const next of adj[current] ?? []) {
      if (prev[next] !== -1) continue;
      prev[next] = current;
      queue.push(next);
    }
  }
  if (prev[goal] === -1) return [nodes[start] ?? from, nodes[goal] ?? to];
  const path: [number, number][] = [];
  let cursor = goal;
  while (cursor !== start) {
    const point = nodes[cursor];
    if (!point) break;
    path.push(point);
    cursor = prev[cursor] ?? start;
  }
  const origin = nodes[start];
  if (origin) path.push(origin);
  path.reverse();
  return path;
}

export function windowAnchors(room: { w: number; d: number }): [number, number][] {
  const points: [number, number][] = [];
  const x = round3(Math.max(0.8, room.w - 1.2));
  for (let z = 2.4; z < room.d - 1; z += 2.4) points.push([x, round3(z)]);
  if (points.length === 0) points.push([x, round3(room.d / 2)]);
  return points;
}

export function zoneAnchors(
  layout: OfficeLayout,
  zone: "desk" | "bookshelf" | "window" | "meeting" | "whiteboard" | "coffee" | "sofa",
): [number, number][] {
  if (zone === "desk") return layout.pods.flatMap((pod) => pod.desks.map((desk) => desk.chair));
  if (zone === "window") return windowAnchors(layout.room);
  return layout.fixtures.filter((fixture) => fixture.kind === zone).flatMap((fixture) => fixture.anchors);
}

function podSize(count: number): { w: number; d: number } {
  const cols = Math.min(2, count);
  const rows = Math.ceil(count / 2);
  return {
    w: round3(PAD * 2 + DESK_W + (cols - 1) * PITCH_X),
    d: round3(PAD * 2 + DESK_D + (rows - 1) * PITCH_Z),
  };
}

function makePod(
  session: string,
  keys: string[],
  x: number,
  z: number,
  size: { w: number; d: number },
): Pod {
  const desks: DeskSlot[] = keys.map((key, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const cx = round3(x + PAD + DESK_W / 2 + col * PITCH_X);
    const cz = round3(z + PAD + DESK_D / 2 + row * PITCH_Z);
    return {
      key,
      pod: session,
      pos: [cx, cz],
      // rotation.y 0 looks down −Z, toward the back wall.
      facing: 0,
      chair: [cx, round3(cz + DESK_D / 2 + 0.35)],
    };
  });
  return {
    session,
    rect: { x: round3(x), z: round3(z), w: size.w, d: size.d },
    color: POD_COLORS[fnv1a(session) % POD_COLORS.length] ?? POD_COLORS[0] ?? 0x1e3a5f,
    label: session.toUpperCase().slice(0, 24),
    desks,
  };
}

function placeFixtures(room: { w: number; d: number }, pods: Pod[]): Fixture[] {
  const backZ = 1.15;
  const fixtures: Fixture[] = [
    {
      kind: "coffee",
      pos: [1.6, backZ],
      rot: 0,
      anchors: shiftAnchors([1.6, backZ], [
        [0, 1.15],
        [-0.7, 1.15],
        [0.7, 1.15],
      ]),
    },
    {
      kind: "bookshelf",
      pos: [4.4, backZ],
      rot: 0,
      anchors: shiftAnchors([4.4, backZ], [
        [-0.6, 1.2],
        [0, 1.2],
        [0.6, 1.2],
      ]),
    },
    {
      kind: "bookshelf",
      pos: [6.8, backZ],
      rot: 0,
      anchors: shiftAnchors([6.8, backZ], [
        [-0.6, 1.2],
        [0, 1.2],
        [0.6, 1.2],
      ]),
    },
    {
      kind: "whiteboard",
      pos: [9.4, backZ],
      rot: 0,
      anchors: shiftAnchors([9.4, backZ], [
        [-0.45, 1.2],
        [0.45, 1.2],
      ]),
    },
    {
      kind: "server",
      pos: [11.6, backZ],
      rot: 0,
      anchors: [],
    },
    {
      kind: "tv",
      pos: [13.2, 0.7],
      rot: 0,
      anchors: [],
    },
    {
      kind: "clock",
      pos: clampPoint(room, [14.6, 0.85]),
      rot: 0,
      anchors: [],
    },
  ];
  const meet: [number, number] = clampPoint(room, [room.w - 4.5, room.d * 0.48]);
  fixtures.push({
    kind: "meeting",
    pos: meet,
    rot: 0,
    anchors: shiftAnchors(meet, [
      [-1.1, 0],
      [1.1, 0],
      [0, -1.1],
      [0, 1.1],
    ]).map((point) => clampPoint(room, point)),
  });
  const sofa: [number, number] = clampPoint(room, [room.w - 3, room.d - 2.2]);
  fixtures.push({
    kind: "sofa",
    pos: sofa,
    rot: 0,
    anchors: [
      [-1.4, 0.4],
      [-0.7, 0.4],
      [0, 0.4],
      [0.7, 0.4],
      [1.3, -0.6],
    ].map(([dx, dz]) => clampPoint(room, [sofa[0] + dx, sofa[1] + dz])),
  });
  for (const pod of pods) {
    const corner = fnv1a(pod.session) % 4;
    const inset = 0.35;
    const px =
      corner === 0 || corner === 1 ? pod.rect.x + inset : pod.rect.x + pod.rect.w - inset;
    const pz = corner === 0 || corner === 2 ? pod.rect.z + inset : pod.rect.z + pod.rect.d - inset;
    fixtures.push({
      kind: "plant",
      pos: clampPoint(room, [px, pz]),
      rot: 0,
      anchors: [],
    });
  }
  return fixtures;
}

function shiftAnchors(origin: [number, number], deltas: [number, number][]): [number, number][] {
  return deltas.map(([dx, dz]) => [round3(origin[0] + dx), round3(origin[1] + dz)]);
}

function clampPoint(room: { w: number; d: number }, point: [number, number]): [number, number] {
  const margin = 0.45;
  return [
    round3(Math.min(room.w - margin, Math.max(margin, point[0]))),
    round3(Math.min(room.d - margin, Math.max(margin, point[1]))),
  ];
}

function deskBox(desk: DeskSlot): Aabb {
  return {
    x0: desk.pos[0] - DESK_W / 2,
    z0: desk.pos[1] - DESK_D / 2,
    x1: desk.pos[0] + DESK_W / 2,
    z1: desk.pos[1] + DESK_D / 2,
  };
}

function blocked(x: number, z: number, obstacles: Aabb[]): boolean {
  for (const box of obstacles) {
    if (x > box.x0 + 0.05 && x < box.x1 - 0.05 && z > box.z0 + 0.05 && z < box.z1 - 0.05) {
      return true;
    }
  }
  return false;
}

function buildWaypoints(
  room: { w: number; d: number },
  obstacles: Aabb[],
  chairs: [number, number][],
  anchors: [number, number][],
): OfficeLayout["waypoints"] {
  const nodes: [number, number][] = [];
  const indexOf = new Map<string, number>();
  const add = (point: [number, number]): number => {
    const rounded: [number, number] = [round3(point[0]), round3(point[1])];
    const key = `${rounded[0]},${rounded[1]}`;
    const existing = indexOf.get(key);
    if (existing !== undefined) return existing;
    const index = nodes.length;
    indexOf.set(key, index);
    nodes.push(rounded);
    return index;
  };
  const step = 1.2;
  const grid: number[] = [];
  for (let ix = 1; ix * step < room.w - 0.25; ix += 1) {
    for (let iz = 1; iz * step < room.d - 0.25; iz += 1) {
      const x = round3(ix * step);
      const z = round3(iz * step);
      if (blocked(x, z, obstacles)) continue;
      grid.push(add([x, z]));
    }
  }
  const gridSet = new Set(grid);
  const specials: number[] = [];
  for (const point of [...chairs, ...anchors]) {
    const index = add(point);
    if (!gridSet.has(index)) specials.push(index);
  }
  const edges: [number, number][] = [];
  const seen = new Set<string>();
  const link = (left: number, right: number) => {
    if (left === right) return;
    const a = Math.min(left, right);
    const b = Math.max(left, right);
    const key = `${a}:${b}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push([a, b]);
  };
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const left = nodes[i];
      const right = nodes[j];
      if (!left || !right) continue;
      const dx = Math.abs(left[0] - right[0]);
      const dz = Math.abs(left[1] - right[1]);
      const aligned = dx < 0.02 || dz < 0.02;
      const dist = Math.hypot(dx, dz);
      if (aligned && dist > 0.4 && dist < 1.35) link(i, j);
    }
  }
  for (const special of specials) {
    const origin = nodes[special];
    if (!origin) continue;
    let best = -1;
    let bestD = Infinity;
    for (const gridIndex of grid) {
      const point = nodes[gridIndex];
      if (!point) continue;
      const dist = Math.hypot(point[0] - origin[0], point[1] - origin[1]);
      if (dist < bestD) {
        bestD = dist;
        best = gridIndex;
      }
    }
    if (best >= 0) link(special, best);
  }
  connectComponents(nodes, edges, link);
  return { nodes, edges };
}

function connectComponents(
  nodes: [number, number][],
  edges: [number, number][],
  link: (left: number, right: number) => void,
) {
  const parent = nodes.map((_, index) => index);
  const find = (index: number): number => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor] ?? cursor] ?? cursor;
      cursor = parent[cursor] ?? cursor;
    }
    return cursor;
  };
  const unite = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  for (const [left, right] of edges) unite(left, right);
  const roots = () => new Set(nodes.map((_, index) => find(index))).size;
  let guard = 0;
  while (roots() > 1 && guard < nodes.length) {
    guard += 1;
    let bestI = 0;
    let bestJ = 1;
    let bestD = Infinity;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        if (find(i) === find(j)) continue;
        const left = nodes[i];
        const right = nodes[j];
        if (!left || !right) continue;
        const dist = Math.hypot(left[0] - right[0], left[1] - right[1]);
        if (dist < bestD) {
          bestD = dist;
          bestI = i;
          bestJ = j;
        }
      }
    }
    link(bestI, bestJ);
    unite(bestI, bestJ);
  }
}

function nearest(nodes: [number, number][], point: [number, number]): number {
  let best = 0;
  let bestD = Infinity;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) continue;
    const dist = (node[0] - point[0]) ** 2 + (node[1] - point[1]) ** 2;
    if (dist < bestD) {
      bestD = dist;
      best = index;
    }
  }
  return best;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
