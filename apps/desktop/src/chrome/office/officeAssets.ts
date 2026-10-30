import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  type BufferGeometry,
  type Material,
  type Object3D,
} from "three";
import type { Fixture, OfficeLayout, Pod } from "./officeLayout.ts";

const WOOD = 0xb07a45;
const SLAB = 0x2a1d12;
const WALL = 0x2b3240;
const DESK = 0xe8e4dc;

export interface ScreenSet {
  material(activity: string): MeshBasicMaterial;
  tick(time: number): void;
  dispose(): void;
  readonly shared: Set<Material>;
}

export interface RoomBuild {
  root: Group;
  screens: Map<string, Mesh>;
  /** Invisible boxes, one per desk, with `userData.key` set to the desk key. */
  deskPicks: Mesh[];
  leds: Mesh[];
  clockHands: Group | null;
  setKpi: (percent: number) => void;
}

const palette = new Map<string, MeshStandardMaterial>();

function mat(color: number, extras?: { roughness?: number; metalness?: number; emissive?: number; emissiveIntensity?: number; transparent?: boolean; opacity?: number; side?: number }): MeshStandardMaterial {
  const key = `${color}:${extras?.roughness ?? 0.8}:${extras?.metalness ?? 0}:${extras?.emissive ?? 0}:${extras?.opacity ?? 1}:${extras?.side ?? 0}`;
  const cached = palette.get(key);
  if (cached) return cached;
  const material = new MeshStandardMaterial({
    color,
    roughness: extras?.roughness ?? 0.8,
    metalness: extras?.metalness ?? 0,
    emissive: extras?.emissive ?? 0x000000,
    emissiveIntensity: extras?.emissiveIntensity ?? (extras?.emissive ? 0.6 : 0),
    transparent: extras?.transparent,
    opacity: extras?.opacity,
    side: extras?.side,
  });
  palette.set(key, material);
  return material;
}

export function sharedMaterials(): Material[] {
  return [...palette.values()];
}

export function disposeSharedMaterials() {
  for (const material of palette.values()) material.dispose();
  palette.clear();
}

export function createScreens(): ScreenSet {
  const kinds = ["coding", "terminal", "reading", "browsing", "delegating", "thinking", "replying", "planning", "error", "off"];
  const canvases = new Map<string, HTMLCanvasElement>();
  const materials = new Map<string, MeshBasicMaterial>();
  for (const kind of kinds) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 128;
    canvases.set(kind, canvas);
    const material = new MeshBasicMaterial({ map: new CanvasTexture(canvas) });
    materials.set(kind, material);
    drawScreen(kind, canvas, 0);
    const texture = material.map;
    if (texture) texture.needsUpdate = true;
  }
  return {
    shared: new Set(materials.values()),
    material(activity: string) {
      return materials.get(activity) ?? materials.get("off") ?? materials.get("coding")!;
    },
    tick(time: number) {
      for (const [kind, canvas] of canvases) {
        if (kind !== "terminal" && kind !== "thinking") continue;
        drawScreen(kind, canvas, time);
        const texture = materials.get(kind)?.map;
        if (texture) texture.needsUpdate = true;
      }
    },
    dispose() {
      for (const material of materials.values()) {
        material.map?.dispose();
        material.dispose();
      }
    },
  };
}

function drawScreen(kind: string, canvas: HTMLCanvasElement, time: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = kind === "terminal" || kind === "off" ? "#07080c" : "#10151c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (kind === "coding") {
    ctx.fillStyle = "#86efac";
    for (let row = 0; row < 7; row += 1) {
      ctx.fillRect(16, 16 + row * 14, 40 + ((row * 37) % 150), 6);
    }
  } else if (kind === "terminal") {
    const on = Math.floor(time * 4) % 2 === 0;
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(18, 28, 90, 6);
    if (on) ctx.fillRect(18, 48, 10, 14);
  } else if (kind === "browsing") {
    ctx.strokeStyle = "#4ade80";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(128, 64, 36, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(128, 64, 16, 36, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (kind === "error") {
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(90, 30);
    ctx.lineTo(166, 98);
    ctx.moveTo(166, 30);
    ctx.lineTo(90, 98);
    ctx.stroke();
  } else if (kind === "thinking") {
    ctx.fillStyle = "#facc15";
    const pulse = Math.floor(time * 3) % 3;
    for (let dot = 0; dot < 3; dot += 1) {
      ctx.globalAlpha = dot === pulse ? 1 : 0.35;
      ctx.beginPath();
      ctx.arc(96 + dot * 28, 64, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else {
    const color = kind === "planning" ? "#a3e635" : kind === "delegating" ? "#f472b6" : "#e5e7eb";
    ctx.fillStyle = color;
    for (let row = 0; row < 5; row += 1) ctx.fillRect(20, 22 + row * 18, 80 + row * 16, 6);
  }
}

export function buildOfficeRoom(layout: OfficeLayout, screens: ScreenSet, kpi: number): RoomBuild {
  const root = new Group();
  root.add(buildFloor(layout.room.w, layout.room.d));
  root.add(buildWalls(layout.room.w, layout.room.d));
  for (const pod of layout.pods) root.add(buildRug(pod));
  const deskScreens = new Map<string, Mesh>();
  const deskPicks: Mesh[] = [];
  const deskPickMat = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  const deskPickGeo = new BoxGeometry(1.7, 1.5, 1.0);
  for (const pod of layout.pods) {
    for (const desk of pod.desks) {
      const group = buildDesk();
      group.position.set(desk.pos[0], 0, desk.pos[1]);
      const screen = group.children.find((child) => child.userData.screen === true);
      if (screen instanceof Mesh) {
        screen.material = screens.material("off");
        deskScreens.set(desk.key, screen);
      }
      const chair = buildChair();
      chair.position.set(desk.chair[0], 0, desk.chair[1]);
      const pick = new Mesh(deskPickGeo, deskPickMat);
      pick.position.set(desk.pos[0], 0.75, desk.pos[1]);
      pick.userData.key = desk.key;
      root.add(group);
      root.add(chair);
      root.add(pick);
      deskPicks.push(pick);
    }
  }
  let clockHands: Group | null = null;
  let setKpi = (_percent: number) => {};
  const leds: Mesh[] = [];
  for (const fixture of layout.fixtures) {
    const built = buildFixture(fixture, kpi);
    built.group.position.set(fixture.pos[0], 0, fixture.pos[1]);
    built.group.rotation.y = fixture.rot;
    root.add(built.group);
    if (built.hands) clockHands = built.hands;
    if (built.setKpi) setKpi = built.setKpi;
    leds.push(...built.leds);
  }
  if (deskPicks.length === 0) {
    deskPickGeo.dispose();
    deskPickMat.dispose();
  }
  return { root, screens: deskScreens, deskPicks, leds, clockHands, setKpi };
}

function buildFloor(w: number, d: number): Group {
  const group = new Group();
  const slab = new Mesh(new BoxGeometry(w, 0.3, d), mat(SLAB, { roughness: 0.95 }));
  slab.position.set(w / 2, -0.15, d / 2);
  slab.receiveShadow = true;
  group.add(slab);
  const plankW = 0.2;
  const plankD = 2;
  const cols = Math.max(1, Math.floor(w / plankW));
  const rows = Math.max(1, Math.floor(d / plankD));
  const count = cols * rows;
  const geometry = new BoxGeometry(plankW * 0.96, 0.04, plankD * 0.96);
  const material = mat(WOOD);
  if (count > 8) {
    const mesh = new InstancedMesh(geometry, material, count);
    const matrix = new Matrix4();
    const tint = new Color(WOOD);
    let index = 0;
    for (let col = 0; col < cols; col += 1) {
      for (let row = 0; row < rows; row += 1) {
        matrix.makeTranslation(plankW * (col + 0.5), 0.02, plankD * (row + 0.5));
        mesh.setMatrixAt(index, matrix);
        const jitter = new Color(WOOD);
        jitter.lerp(tint, 0);
        jitter.lerp(new Color(0x8a5a2b), (col % 5) / 12);
        mesh.setColorAt(index, jitter);
        index += 1;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    group.add(mesh);
  }
  return group;
}

function buildWalls(w: number, d: number): Group {
  const group = new Group();
  const back = new Mesh(new BoxGeometry(w, 3.2, 0.15), mat(WALL));
  back.position.set(w / 2, 1.6, 0.08);
  back.castShadow = true;
  back.receiveShadow = true;
  const left = new Mesh(new BoxGeometry(0.15, 3.2, d), mat(WALL));
  left.position.set(0.08, 1.6, d / 2);
  left.castShadow = true;
  const glass = mat(0x9cc9ff, { transparent: true, opacity: 0.18, roughness: 0.05, side: DoubleSide });
  const right = new Mesh(new BoxGeometry(0.06, 3.2, d), glass);
  right.position.set(w - 0.04, 1.6, d / 2);
  const front = new Mesh(new BoxGeometry(w, 1, 0.06), glass);
  front.position.set(w / 2, 0.5, d - 0.04);
  group.add(back, left, right, front);
  const mullion = mat(0x111827);
  for (let z = 0.2; z < d; z += 1.4) {
    const bar = new Mesh(new BoxGeometry(0.04, 3.2, 0.04), mullion);
    bar.position.set(w - 0.04, 1.6, z);
    group.add(bar);
  }
  return group;
}

function buildRug(pod: Pod): Group {
  const group = new Group();
  const rug = new Mesh(new BoxGeometry(pod.rect.w, 0.02, pod.rect.d), mat(pod.color, { roughness: 1 }));
  rug.position.set(pod.rect.x + pod.rect.w / 2, 0.02, pod.rect.z + pod.rect.d / 2);
  rug.receiveShadow = true;
  group.add(rug);
  const neon = mat(0x67e8f9, { emissive: 0x22d3ee, emissiveIntensity: 0.8 });
  const y = 0.04;
  const x = pod.rect.x;
  const z = pod.rect.z;
  const edges: Array<[number, number, number, number]> = [
    [pod.rect.w, 0.03, x + pod.rect.w / 2, z],
    [pod.rect.w, 0.03, x + pod.rect.w / 2, z + pod.rect.d],
    [0.03, pod.rect.d, x, z + pod.rect.d / 2],
    [0.03, pod.rect.d, x + pod.rect.w, z + pod.rect.d / 2],
  ];
  for (const [width, depth, cx, cz] of edges) {
    const edge = new Mesh(new BoxGeometry(width, 0.03, depth), neon);
    edge.position.set(cx, y, cz);
    group.add(edge);
  }
  const label = labelTexture(pod.label);
  const plate = new Mesh(new PlaneGeometry(Math.min(pod.rect.w * 0.8, 2.4), 0.28), new MeshBasicMaterial({ map: label, transparent: true }));
  plate.rotation.x = -Math.PI / 2;
  plate.position.set(pod.rect.x + pod.rect.w / 2, 0.05, pod.rect.z + 0.22);
  group.add(plate);
  return group;
}

function labelTexture(text: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#e5e7eb";
    ctx.font = "600 28px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 256, 32);
  }
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function buildDesk(): Group {
  const group = new Group();
  const top = new Mesh(new BoxGeometry(1.6, 0.06, 0.8), mat(DESK));
  top.position.y = 0.75;
  top.castShadow = true;
  top.receiveShadow = true;
  group.add(top);
  for (const [x, z] of [[-0.7, -0.32], [0.7, -0.32], [-0.7, 0.32], [0.7, 0.32]] as Array<[number, number]>) {
    const leg = new Mesh(new BoxGeometry(0.06, 0.74, 0.06), mat(0x374151));
    leg.position.set(x, 0.37, z);
    leg.castShadow = true;
    group.add(leg);
  }
  const drawer = new Mesh(new BoxGeometry(0.7, 0.18, 0.7), mat(0xd6d3d1));
  drawer.position.set(0.35, 0.55, 0);
  drawer.castShadow = true;
  group.add(drawer);
  const stand = new Mesh(new BoxGeometry(0.08, 0.18, 0.08), mat(0x1f2937));
  stand.position.set(0, 0.87, -0.18);
  const panel = new Mesh(new BoxGeometry(0.62, 0.38, 0.04), mat(0x111827));
  panel.position.set(0, 1.12, -0.2);
  panel.castShadow = true;
  const screen = new Mesh(new PlaneGeometry(0.56, 0.32), mat(0x020617));
  screen.position.set(0, 1.12, -0.17);
  screen.userData.screen = true;
  group.add(stand, panel, screen);
  return group;
}

export function buildChair(): Group {
  const group = new Group();
  const seat = new Mesh(new BoxGeometry(0.46, 0.06, 0.46), mat(0x1f2937));
  seat.position.y = 0.48;
  seat.castShadow = true;
  const back = new Mesh(new BoxGeometry(0.46, 0.42, 0.06), mat(0x1f2937));
  back.position.set(0, 0.72, -0.2);
  back.castShadow = true;
  const pole = new Mesh(new CylinderGeometry(0.04, 0.04, 0.28, 8), mat(0x374151, { metalness: 0.4 }));
  pole.position.y = 0.3;
  group.add(seat, back, pole);
  return group;
}

function buildFixture(fixture: Fixture, kpi: number): { group: Group; leds: Mesh[]; hands: Group | null; setKpi: ((percent: number) => void) | null } {
  const group = new Group();
  const leds: Mesh[] = [];
  let hands: Group | null = null;
  let setKpi: ((percent: number) => void) | null = null;
  if (fixture.kind === "bookshelf") group.add(buildBookshelf());
  else if (fixture.kind === "coffee") group.add(buildCoffee());
  else if (fixture.kind === "sofa") group.add(buildSofa());
  else if (fixture.kind === "meeting") group.add(buildMeeting());
  else if (fixture.kind === "whiteboard") group.add(buildWhiteboard());
  else if (fixture.kind === "server") {
    const rack = buildServer();
    group.add(rack.group);
    leds.push(...rack.leds);
  } else if (fixture.kind === "tv") {
    const tv = buildTv(kpi);
    group.add(tv.group);
    setKpi = tv.setPercent;
  } else if (fixture.kind === "clock") {
    const clock = buildClock();
    group.add(clock.group);
    hands = clock.hands;
  } else if (fixture.kind === "plant") group.add(buildPlant());
  return { group, leds, hands, setKpi };
}

function buildBookshelf(): Group {
  const group = new Group();
  const frame = mat(0x3f2a1d);
  const body = new Mesh(new BoxGeometry(1.4, 1.8, 0.35), frame);
  body.position.y = 0.9;
  body.castShadow = true;
  group.add(body);
  for (let shelf = 0; shelf < 3; shelf += 1) {
    const board = new Mesh(new BoxGeometry(1.3, 0.04, 0.3), mat(0x5c4033));
    board.position.y = 0.4 + shelf * 0.5;
    group.add(board);
    for (let book = 0; book < 6; book += 1) {
      const color = [0x7f1d1d, 0x1e3a8a, 0x14532d, 0x78350f, 0x4c1d95, 0x0f766e][book] ?? 0x444444;
      const volume = new Mesh(new BoxGeometry(0.08, 0.28, 0.22), mat(color));
      volume.position.set(-0.5 + book * 0.18, 0.56 + shelf * 0.5, 0);
      group.add(volume);
    }
  }
  return group;
}

function buildCoffee(): Group {
  const group = new Group();
  const counter = new Mesh(new BoxGeometry(1.8, 0.9, 0.6), mat(0xd6d3d1));
  counter.position.y = 0.45;
  counter.castShadow = true;
  const fridge = new Mesh(new BoxGeometry(0.5, 1.3, 0.5), mat(0xe5e7eb));
  fridge.position.set(-0.85, 0.65, -0.2);
  const machine = new Mesh(new BoxGeometry(0.35, 0.32, 0.3), mat(0x111827, { metalness: 0.3 }));
  machine.position.set(0.2, 1.05, 0);
  group.add(counter, fridge, machine);
  for (const x of [-0.2, 0.15, 0.5]) {
    const mug = new Mesh(new CylinderGeometry(0.06, 0.05, 0.1, 8), mat(0xf8fafc));
    mug.position.set(x, 0.95, 0.12);
    group.add(mug);
  }
  return group;
}

function buildSofa(): Group {
  const group = new Group();
  const rug = new Mesh(new CircleGeometry(3, 28), mat(0x2e7d4f));
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.025;
  rug.receiveShadow = true;
  const frame = mat(0x374151);
  const cushion = mat(0x2f6f73);
  const seatA = new Mesh(new BoxGeometry(2.2, 0.28, 0.8), cushion);
  seatA.position.set(0, 0.4, 0);
  const seatB = new Mesh(new BoxGeometry(0.8, 0.28, 1.4), cushion);
  seatB.position.set(0.9, 0.4, -0.7);
  const backA = new Mesh(new BoxGeometry(2.2, 0.55, 0.16), frame);
  backA.position.set(0, 0.75, -0.34);
  const backB = new Mesh(new BoxGeometry(0.16, 0.55, 1.5), frame);
  backB.position.set(1.28, 0.75, -0.7);
  group.add(rug, seatA, seatB, backA, backB);
  for (const part of [seatA, seatB, backA, backB]) part.castShadow = true;
  return group;
}

function buildMeeting(): Group {
  const group = new Group();
  const top = new Mesh(new CylinderGeometry(1.05, 1.05, 0.08, 20), mat(0xd6d3d1));
  top.position.y = 0.75;
  top.castShadow = true;
  top.receiveShadow = true;
  const pole = new Mesh(new CylinderGeometry(0.08, 0.1, 0.7, 10), mat(0x374151, { metalness: 0.3 }));
  pole.position.y = 0.36;
  group.add(top, pole);
  for (let seat = 0; seat < 4; seat += 1) {
    const chair = buildChair();
    const angle = (seat / 4) * Math.PI * 2;
    chair.position.set(Math.cos(angle) * 1.45, 0, Math.sin(angle) * 1.45);
    chair.rotation.y = -angle + Math.PI / 2;
    group.add(chair);
  }
  return group;
}

function buildWhiteboard(): Group {
  const group = new Group();
  const board = new Mesh(new BoxGeometry(1.5, 0.9, 0.05), mat(0xf8fafc));
  board.position.y = 1.45;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 4;
    ctx.strokeRect(20, 20, 90, 50);
    ctx.strokeStyle = "#16a34a";
    ctx.beginPath();
    ctx.moveTo(140, 90);
    ctx.lineTo(180, 30);
    ctx.lineTo(230, 80);
    ctx.stroke();
  }
  const texture = new CanvasTexture(canvas);
  const ink = new Mesh(new PlaneGeometry(1.4, 0.8), new MeshBasicMaterial({ map: texture }));
  ink.position.set(0, 1.45, 0.03);
  const legL = new Mesh(new BoxGeometry(0.06, 1.3, 0.06), mat(0x94a3b8));
  legL.position.set(-0.6, 0.65, 0);
  const legR = legL.clone();
  legR.position.x = 0.6;
  group.add(board, ink, legL, legR);
  return group;
}

function buildServer(): { group: Group; leds: Mesh[] } {
  const group = new Group();
  const body = new Mesh(new BoxGeometry(0.7, 1.8, 0.45), mat(0x0b0f14, { metalness: 0.5, roughness: 0.4 }));
  body.position.y = 0.9;
  body.castShadow = true;
  group.add(body);
  const leds: Mesh[] = [];
  const ledMat = mat(0x22c55e, { emissive: 0x22c55e, emissiveIntensity: 1 });
  for (let row = 0; row < 6; row += 1) {
    const led = new Mesh(new BoxGeometry(0.45, 0.05, 0.02), ledMat);
    led.position.set(0, 0.4 + row * 0.22, 0.24);
    group.add(led);
    leds.push(led);
  }
  return { group, leds };
}

function buildTv(percent: number): { group: Group; setPercent: (value: number) => void } {
  const group = new Group();
  const frame = new Mesh(new BoxGeometry(1.6, 0.9, 0.06), mat(0x111827));
  frame.position.y = 2.1;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const texture = new CanvasTexture(canvas);
  const screen = new Mesh(new PlaneGeometry(1.46, 0.76), new MeshBasicMaterial({ map: texture }));
  screen.position.set(0, 2.1, 0.04);
  const paint = (value: number) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = "#8b7cf6";
    ctx.font = "700 54px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${value.toFixed(1)}%`, 128, 64);
    texture.needsUpdate = true;
  };
  paint(percent);
  group.add(frame, screen);
  return { group, setPercent: paint };
}

function buildClock(): { group: Group; hands: Group } {
  const group = new Group();
  const face = new Mesh(new CylinderGeometry(0.28, 0.28, 0.04, 20), mat(0xf8fafc));
  face.rotation.x = Math.PI / 2;
  face.position.y = 2.35;
  const hands = new Group();
  hands.position.y = 2.35;
  const hour = new Mesh(new BoxGeometry(0.03, 0.12, 0.02), mat(0x111827));
  hour.position.y = 0.05;
  const minute = new Mesh(new BoxGeometry(0.02, 0.18, 0.02), mat(0x111827));
  minute.position.y = 0.08;
  minute.userData.minute = true;
  hour.userData.hour = true;
  hands.add(hour, minute);
  group.add(face, hands);
  return { group, hands };
}

function buildPlant(): Group {
  const group = new Group();
  const pot = new Mesh(new CylinderGeometry(0.16, 0.12, 0.22, 10), mat(0xf8fafc));
  pot.position.y = 0.12;
  pot.castShadow = true;
  group.add(pot);
  const leafMat = mat(0x2f7d32);
  for (let leaf = 0; leaf < 4; leaf += 1) {
    const cone = new Mesh(
      leaf === 0 ? new IcosahedronGeometry(0.12, 0) : new ConeGeometry(0.1, 0.38, 5),
      leafMat,
    );
    cone.position.set(Math.cos(leaf) * 0.06, 0.4, Math.sin(leaf) * 0.06);
    cone.rotation.z = (leaf - 1.5) * 0.25;
    cone.castShadow = true;
    group.add(cone);
  }
  return group;
}

export function disposeObject(root: Object3D, keep: Set<Material>) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse((obj) => {
    const meshed = obj as Mesh;
    if (meshed.geometry) geometries.add(meshed.geometry);
    const material = meshed.material;
    if (Array.isArray(material)) {
      for (const item of material) materials.add(item);
    } else if (material) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) {
    if (keep.has(material)) continue;
    const textured = material as MeshBasicMaterial;
    if (textured.map && !keep.has(material)) textured.map.dispose();
    material.dispose();
  }
}
