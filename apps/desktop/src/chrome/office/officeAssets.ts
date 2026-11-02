import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
  type Material,
  type Object3D,
} from "three";
import type { Fixture, OfficeLayout, Pod } from "./officeLayout.ts";

// Clean Modern Office Palette - Muted Scandinavian Aesthetic
const WOOD_OAK_A = 0xbaa386; // Muted natural sand-oak plank
const WOOD_OAK_B = 0xb0987a; // Subtle alternating oak plank
const SLAB_BASE = 0x141a24;  // Deep neutral foundation
const WALL_DARK = 0x2d3748;  // Lighter warm Nordic slate wall
const MULLION_DARK = 0x1e293b; // Clean matte slate window frames

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
  tick?: (time: number) => void;
  setTod?: (preset: "day" | "evening" | "night") => void;
}

const palette = new Map<string, MeshStandardMaterial>();

function mat(
  color: number,
  extras?: {
    roughness?: number;
    metalness?: number;
    emissive?: number;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    side?: number;
  },
): MeshStandardMaterial {
  const key = `${color}:${extras?.roughness ?? 0.7}:${extras?.metalness ?? 0.05}:${extras?.emissive ?? 0}:${extras?.emissiveIntensity ?? 0}:${extras?.opacity ?? 1}:${extras?.side ?? 0}`;
  const cached = palette.get(key);
  if (cached) return cached;
  const material = new MeshStandardMaterial({
    color,
    roughness: extras?.roughness ?? 0.7,
    metalness: extras?.metalness ?? 0.05,
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
  const kinds = [
    "coding",
    "terminal",
    "reading",
    "browsing",
    "delegating",
    "thinking",
    "replying",
    "planning",
    "error",
    "off",
  ];
  const canvases = new Map<string, HTMLCanvasElement>();
  const materials = new Map<string, MeshBasicMaterial>();
  for (const kind of kinds) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 128;
    canvases.set(kind, canvas);
    const material = new MeshBasicMaterial({ map: new CanvasTexture(canvas) });
    materials.set(kind, material);
    drawModernScreen(kind, canvas, 0);
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
        if (kind !== "terminal" && kind !== "thinking" && kind !== "coding") continue;
        drawModernScreen(kind, canvas, time);
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

function drawModernScreen(kind: string, canvas: HTMLCanvasElement, time: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (kind === "coding") {
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(0, 0, 24, h);
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(0, 0, w, 14);
    ctx.fillStyle = "#38bdf8";
    ctx.fillRect(4, 3, 40, 8);
    const colors = ["#a855f7", "#38bdf8", "#22c55e", "#f59e0b", "#94a3b8"];
    const scroll = Math.floor(time * 3) % 4;
    for (let row = 0; row < 6; row += 1) {
      const y = 22 + row * 15;
      ctx.fillStyle = "#475569";
      ctx.fillRect(6, y + 2, 8, 4);
      const indent = ((row + scroll) % 3) * 12;
      let curX = 28 + indent;
      for (let t = 0; t < 3; t += 1) {
        const len = 16 + ((row * 17 + t * 29) % 42);
        ctx.fillStyle = colors[(row + t + scroll) % colors.length]!;
        ctx.fillRect(curX, y + 2, len, 5);
        curX += len + 6;
      }
    }
  } else if (kind === "terminal") {
    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, w, 14);
    ctx.fillStyle = "#22c55e";
    ctx.beginPath();
    ctx.arc(8, 7, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#38bdf8";
    ctx.font = "bold 9px monospace";
    ctx.fillText("bot:~$ sparkmux", 8, 28);
    ctx.fillStyle = "#22c55e";
    ctx.fillText("✔ session connected", 8, 44);
    ctx.fillStyle = "#64748b";
    ctx.fillText("listening on [::]:7880", 8, 58);
    ctx.fillText("bot swarm synchronized", 8, 72);
    const cursorOn = Math.floor(time * 4) % 2 === 0;
    if (cursorOn) {
      ctx.fillStyle = "#22c55e";
      ctx.fillRect(8, 82, 8, 12);
    }
  } else if (kind === "thinking") {
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, w, h);
    const cx = 128;
    const cy = 64;
    ctx.fillStyle = "#facc15";
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.fill();
    const pulse = (time * 2) % 1;
    ctx.strokeStyle = `rgba(250, 204, 21, ${1 - pulse})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, 14 + pulse * 40, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#94a3b8";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("ANALYZING...", cx, cy + 38);
  } else if (kind === "error") {
    ctx.fillStyle = "#1e1014";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(128, 20); ctx.lineTo(172, 94); ctx.lineTo(84, 94); ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(125, 42, 6, 26);
    ctx.beginPath(); ctx.arc(128, 80, 3.5, 0, Math.PI * 2); ctx.fill();
  } else {
    // off / idle
    ctx.fillStyle = "#090d16";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#334155";
    ctx.fillRect(20, 30, w - 40, 6);
    ctx.fillRect(20, 48, w - 80, 6);
  }
}

export function buildOfficeRoom(
  layout: OfficeLayout,
  screens: ScreenSet,
  kpi: number,
): RoomBuild {
  const root = new Group();
  const cx = layout.room.w / 2;
  const cz = layout.room.d / 2;
  const radius = Math.max(layout.room.w, layout.room.d) * 0.58 + 0.6;

  // 1. Circular Foundation & Parquet Sand-Oak Floor
  root.add(buildCircularFloor(cx, cz, radius));

  // 2. Panoramic Circular Rotunda Walls, Coffee Bar, Door, TV & Glass Perimeter
  const walls = buildCircularWalls(cx, cz, radius, layout.room.w, layout.room.d, kpi, layout.pods.length);
  root.add(walls.group);

  // 3. Central Overhead Halo Ring Chandelier
  root.add(buildHaloChandelier(cx, cz, radius));

  // 4. Pod Rugs with Glowing Neon Borders
  for (const pod of layout.pods) root.add(buildNeonPodRug(pod));

  // 4. Desks with Dual Monitors & Ergonomic Chairs
  const deskScreens = new Map<string, Mesh>();
  const deskPicks: Mesh[] = [];
  const deskPickMat = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  const deskPickGeo = new BoxGeometry(1.7, 1.5, 1.0);

  for (const pod of layout.pods) {
    for (const desk of pod.desks) {
      const group = buildModernDesk();
      group.position.set(desk.pos[0], 0, desk.pos[1]);

      const screen = group.children.find((child) => child.userData.screen === true);
      if (screen instanceof Mesh) {
        screen.material = screens.material("off");
        deskScreens.set(desk.key, screen);
      }

      const chair = buildChair();
      chair.position.set(desk.chair[0], 0, desk.chair[1]);

      const lamp = buildPendantLamp(desk.pos[0], desk.pos[1], 2.25);

      const pick = new Mesh(deskPickGeo, deskPickMat);
      pick.position.set(desk.pos[0], 0.75, desk.pos[1]);
      pick.userData.key = desk.key;

      root.add(group);
      root.add(chair);
      root.add(lamp);
      root.add(pick);
      deskPicks.push(pick);
    }
  }

  // 5. Fixtures (Server Rack, Lounge Sofa with Green Rug, Meeting Table, Plants)
  let clockHands: Group | null = walls.clockHands;
  let setKpi: (percent: number) => void = walls.setKpi;
  const leds: Mesh[] = [];

  for (const fixture of layout.fixtures) {
    const built = buildModernFixture(fixture);
    built.group.position.set(fixture.pos[0], 0, fixture.pos[1]);
    built.group.rotation.y = fixture.rot;
    root.add(built.group);
    if (built.hands) clockHands = built.hands;
    leds.push(...built.leds);
  }

  if (deskPicks.length === 0) {
    deskPickGeo.dispose();
    deskPickMat.dispose();
  }

  return { root, screens: deskScreens, deskPicks, leds, clockHands, setKpi };
}

function buildCircularFloor(cx: number, cz: number, radius: number): Group {
  const group = new Group();

  // Circular Foundation Slab
  const slab = new Mesh(
    new CylinderGeometry(radius + 0.25, radius + 0.25, 0.35, 64),
    mat(SLAB_BASE, { roughness: 0.95 }),
  );
  slab.position.set(cx, -0.175, cz);
  slab.receiveShadow = true;
  group.add(slab);

  // Circular Sand-Oak Parquet Surface
  const floor = new Mesh(
    new CylinderGeometry(radius, radius, 0.04, 64),
    mat(WOOD_OAK_A, { roughness: 0.65 }),
  );
  floor.position.set(cx, 0.02, cz);
  floor.receiveShadow = true;
  group.add(floor);

  // Outer Dark Baseboard Rim
  const outerRim = new Mesh(
    new RingGeometry(radius - 0.32, radius, 64),
    mat(0x151b24, { roughness: 0.8 }),
  );
  outerRim.rotation.x = -Math.PI / 2;
  outerRim.position.set(cx, 0.042, cz);
  group.add(outerRim);

  // Soft Ambient Perimeter Mood Strip
  const perimeterLed = new Mesh(
    new RingGeometry(radius - 0.06, radius, 64),
    mat(0x38bdf8, { emissive: 0x38bdf8, emissiveIntensity: 0.25 }),
  );
  perimeterLed.rotation.x = -Math.PI / 2;
  perimeterLed.position.set(cx, 0.043, cz);
  group.add(perimeterLed);

  // Middle Concentric Inlay Ring
  const midRing = new Mesh(
    new RingGeometry(radius * 0.52, radius * 0.55, 64),
    mat(WOOD_OAK_B, { roughness: 0.6 }),
  );
  midRing.rotation.x = -Math.PI / 2;
  midRing.position.set(cx, 0.041, cz);
  group.add(midRing);

  // Central Hub Ring
  const centerRing = new Mesh(
    new RingGeometry(radius * 0.24, radius * 0.26, 48),
    mat(0x151b24, { roughness: 0.8 }),
  );
  centerRing.rotation.x = -Math.PI / 2;
  centerRing.position.set(cx, 0.041, cz);
  group.add(centerRing);

  // 16 Radial Parquet Inlay Lines radiating outward
  const lineMat = mat(0x151b24, { roughness: 0.8 });
  const innerR = radius * 0.26;
  const outerR = radius - 0.32;
  const lineLen = outerR - innerR;
  for (let i = 0; i < 16; i++) {
    const ang = (i / 16) * Math.PI * 2;
    const midDist = (innerR + outerR) / 2;
    const lineMesh = new Mesh(new BoxGeometry(0.025, 0.005, lineLen), lineMat);
    lineMesh.position.set(
      cx + Math.sin(ang) * midDist,
      0.042,
      cz + Math.cos(ang) * midDist,
    );
    lineMesh.rotation.y = ang;
    group.add(lineMesh);
  }

  return group;
}

function buildCircularWalls(
  cx: number,
  cz: number,
  radius: number,
  _w: number,
  _d: number,
  kpi: number,
  podCount = 6,
): {
  group: Group;
  clockHands: Group | null;
  setKpi: (percent: number) => void;
} {
  const group = new Group();
  const wallMat = mat(WALL_DARK, { roughness: 0.85 });
  const mullionMat = mat(MULLION_DARK, { metalness: 0.7, roughness: 0.3 });
  const glassMat = mat(0xaec1d6, {
    transparent: true,
    opacity: 0.18,
    roughness: 0.05,
    side: DoubleSide,
  });

  // 32-segment Faceted Rotunda Perimeter
  const segments = 32;
  const step = (Math.PI * 2) / segments;
  const chord = 2 * radius * Math.tan(step / 2) + 0.06;

  for (let i = 0; i < segments; i++) {
    const midAngle = (i + 0.5) * step;
    const px = cx + Math.cos(midAngle) * radius;
    const pz = cz + Math.sin(midAngle) * radius;
    const deg = ((midAngle * 180) / Math.PI + 360) % 360;
    const rotY = -midAngle + Math.PI / 2;

    // Corner mullion column at each segment vertex
    const vx = cx + Math.cos(i * step) * radius;
    const vz = cz + Math.sin(i * step) * radius;

    if (deg >= 25 && deg < 115) {
      // 1. Foreground Viewing Arc: Low Curved Panoramic Glass Railing
      const railGlass = new Mesh(new BoxGeometry(chord, 0.95, 0.04), glassMat);
      railGlass.position.set(px, 0.475, pz);
      railGlass.rotation.y = rotY;

      const topRail = new Mesh(new BoxGeometry(chord, 0.04, 0.06), mullionMat);
      topRail.position.set(px, 0.95, pz);
      topRail.rotation.y = rotY;

      const post = new Mesh(new BoxGeometry(0.06, 0.95, 0.06), mullionMat);
      post.position.set(vx, 0.475, vz);

      group.add(railGlass, topRail, post);
    } else if ((deg >= 245 && deg < 360) || (deg >= 0 && deg < 25)) {
      // 2. Panoramic Window Arc: Full-Height Floor-to-Ceiling Curved Glass
      const winGlass = new Mesh(new BoxGeometry(chord, 3.2, 0.04), glassMat);
      winGlass.position.set(px, 1.6, pz);
      winGlass.rotation.y = rotY;

      const post = new Mesh(new BoxGeometry(0.08, 3.2, 0.08), mullionMat);
      post.position.set(vx, 1.6, vz);

      // Horizontal Mullion Rings
      const hBar1 = new Mesh(new BoxGeometry(chord, 0.05, 0.06), mullionMat);
      hBar1.position.set(px, 1.05, pz);
      hBar1.rotation.y = rotY;

      const hBar2 = new Mesh(new BoxGeometry(chord, 0.05, 0.06), mullionMat);
      hBar2.position.set(px, 2.15, pz);
      hBar2.rotation.y = rotY;

      group.add(winGlass, post, hBar1, hBar2);
    } else {
      // 3. Solid Curved Architectural Wall Arc: Deep Slate Half-Wall / Cutaway Style
      const wallHeight = 2.6;
      const wallPanel = new Mesh(new BoxGeometry(chord, wallHeight, 0.16), wallMat);
      wallPanel.position.set(px, wallHeight / 2, pz);
      wallPanel.rotation.y = rotY;
      wallPanel.castShadow = true;
      wallPanel.receiveShadow = true;

      const column = new Mesh(new BoxGeometry(0.08, wallHeight, 0.18), mullionMat);
      column.position.set(vx, wallHeight / 2, vz);

      group.add(wallPanel, column);
    }
  }

  // --- WALL FIXTURES ALONG THE CURVED WALL ---

  // 1. Entrance Door with Glowing Green EXIT Sign (Left side, θ ≈ 180°)
  const doorAng = Math.PI;
  const doorR = radius - 0.15;
  const doorX = cx + Math.cos(doorAng) * doorR;
  const doorZ = cz + Math.sin(doorAng) * doorR;

  const doorWood = mat(0x5c3a21, { roughness: 0.7 });
  const door = new Mesh(new BoxGeometry(1.1, 2.2, 0.06), doorWood);
  door.position.set(doorX, 1.1, doorZ);
  door.rotation.y = Math.PI / 2;

  const exitSign = new Mesh(
    new BoxGeometry(0.4, 0.16, 0.06),
    mat(0x10b981, { emissive: 0x10b981, emissiveIntensity: 0.5 }),
  );
  exitSign.position.set(doorX, 2.35, doorZ);
  exitSign.rotation.y = Math.PI / 2;
  group.add(door, exitSign);

  // 2. Wall Mount TV / KPI Allowance Dashboard Screen (θ ≈ 205°)
  const tvAng = (205 * Math.PI) / 180;
  const tvR = radius - 0.12;
  const tvX = cx + Math.cos(tvAng) * tvR;
  const tvZ = cz + Math.sin(tvAng) * tvR;
  const tvRotY = -tvAng + Math.PI / 2;

  const tvCanvas = document.createElement("canvas");
  tvCanvas.width = 256;
  tvCanvas.height = 128;
  const tvTexture = new CanvasTexture(tvCanvas);
  const tvScreenMat = new MeshBasicMaterial({ map: tvTexture });

  const tvFrame = new Mesh(new BoxGeometry(1.5, 0.9, 0.04), mat(0x0f172a));
  tvFrame.position.set(tvX, 2.1, tvZ);
  tvFrame.rotation.y = tvRotY;

  const tvScreen = new Mesh(new PlaneGeometry(1.42, 0.82), tvScreenMat);
  tvScreen.position.set(
    tvX + Math.sin(tvRotY) * 0.03,
    2.1,
    tvZ + Math.cos(tvRotY) * 0.03,
  );
  tvScreen.rotation.y = tvRotY;
  group.add(tvFrame, tvScreen);

  const drawKpi = (percent: number) => {
    const ctx = tvCanvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#090d16";
    ctx.fillRect(0, 0, 256, 128);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "bold 12px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText("SWARM UTILIZATION", 24, 32);

    ctx.fillStyle = "#22c55e";
    ctx.font = "bold 32px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(`${percent.toFixed(0)}% active`, 24, 68);

    ctx.fillStyle = "#1e293b";
    ctx.fillRect(24, 82, 208, 12);
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(24, 82, Math.max(4, (percent / 100) * 208), 12);

    ctx.fillStyle = "#64748b";
    ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(`● SYSTEM ONLINE · ${podCount} POD${podCount === 1 ? "" : "S"} ACTIVE`, 24, 112);

    tvTexture.needsUpdate = true;
  };

  drawKpi(kpi);

  // 3. Wall Clock (θ ≈ 230°)
  const clockAng = (230 * Math.PI) / 180;
  const clockR = radius - 0.12;
  const clockX = cx + Math.cos(clockAng) * clockR;
  const clockZ = cz + Math.sin(clockAng) * clockR;
  const clockRotY = -clockAng + Math.PI / 2;

  const clockFace = new Mesh(new CylinderGeometry(0.24, 0.24, 0.04, 24), mat(0xffffff));
  clockFace.position.set(clockX, 2.3, clockZ);
  clockFace.rotation.x = Math.PI / 2;
  clockFace.rotation.z = -clockRotY;

  const clockHands = new Group();
  clockHands.position.set(
    clockX + Math.sin(clockRotY) * 0.03,
    2.3,
    clockZ + Math.cos(clockRotY) * 0.03,
  );
  clockHands.rotation.y = clockRotY;

  const hourHand = new Mesh(new BoxGeometry(0.02, 0.1, 0.02), mat(0x111827));
  hourHand.position.y = 0.04;
  hourHand.userData.hour = true;
  const minuteHand = new Mesh(new BoxGeometry(0.015, 0.15, 0.02), mat(0x111827));
  minuteHand.position.y = 0.06;
  minuteHand.userData.minute = true;
  clockHands.add(hourHand, minuteHand);
  group.add(clockFace, clockHands);

  // 4. Modern Coffee Bar nestled along the Curved Wall (θ ≈ 155°)
  const coffeeAng = (155 * Math.PI) / 180;
  const barTop = mat(WOOD_OAK_A, { roughness: 0.6 });
  const counterWhite = mat(0xf8fafc, { roughness: 0.4 });
  const barRotY = -coffeeAng + Math.PI / 2;

  const barDist = radius - 1.2;
  const barX = cx + Math.cos(coffeeAng) * barDist;
  const barZ = cz + Math.sin(coffeeAng) * barDist;

  const coffeeCounter = new Mesh(new BoxGeometry(2.2, 0.9, 0.8), counterWhite);
  coffeeCounter.position.set(barX, 0.45, barZ);
  coffeeCounter.rotation.y = barRotY;

  const coffeeTop = new Mesh(new BoxGeometry(2.24, 0.05, 0.84), barTop);
  coffeeTop.position.set(barX, 0.92, barZ);
  coffeeTop.rotation.y = barRotY;

  // Fridge
  const fridgeAng = (140 * Math.PI) / 180;
  const fridgeX = cx + Math.cos(fridgeAng) * (radius - 1.1);
  const fridgeZ = cz + Math.sin(fridgeAng) * (radius - 1.1);
  const fridge = new Mesh(new BoxGeometry(0.65, 1.4, 0.65), mat(0x334155, { metalness: 0.3 }));
  fridge.position.set(fridgeX, 0.7, fridgeZ);
  fridge.rotation.y = -fridgeAng + Math.PI / 2;

  // Espresso Machine
  const espresso = new Mesh(new BoxGeometry(0.48, 0.36, 0.38), mat(0x0f172a, { metalness: 0.6 }));
  espresso.position.set(barX, 1.12, barZ);
  espresso.rotation.y = barRotY;

  // Floating Shelves with Mugs
  const shelfX = cx + Math.cos(coffeeAng) * (radius - 0.2);
  const shelfZ = cz + Math.sin(coffeeAng) * (radius - 0.2);
  const shelf1 = new Mesh(new BoxGeometry(2.0, 0.04, 0.18), barTop);
  shelf1.position.set(shelfX, 1.45, shelfZ);
  shelf1.rotation.y = barRotY;
  const shelf2 = new Mesh(new BoxGeometry(2.0, 0.04, 0.18), barTop);
  shelf2.position.set(shelfX, 1.8, shelfZ);
  shelf2.rotation.y = barRotY;
  group.add(shelf1, shelf2);

  const mugColors = [0x9e5252, 0x4f709c, 0x4e8065, 0xad824a, 0x766699];
  for (let m = 0; m < 5; m++) {
    const mug = new Mesh(new CylinderGeometry(0.035, 0.035, 0.08, 8), mat(mugColors[m]!));
    const offset = (m - 2) * 0.35;
    mug.position.set(
      shelfX + Math.cos(barRotY) * offset,
      1.51,
      shelfZ - Math.sin(barRotY) * offset,
    );
    group.add(mug);
  }

  // Bar Stools in front of island
  const stoolMat = mat(0xffffff);
  const stoolDist = radius - 2.1;
  for (let s = 0; s < 3; s++) {
    const sAng = ((150 + s * 5) * Math.PI) / 180;
    const sx = cx + Math.cos(sAng) * stoolDist;
    const sz = cz + Math.sin(sAng) * stoolDist;
    const seat = new Mesh(new CylinderGeometry(0.16, 0.16, 0.04, 16), barTop);
    seat.position.set(sx, 0.62, sz);
    const leg = new Mesh(new CylinderGeometry(0.02, 0.02, 0.6, 8), stoolMat);
    leg.position.set(sx, 0.3, sz);
    group.add(seat, leg);
  }

  group.add(coffeeCounter, coffeeTop, fridge, espresso);

  return { group, clockHands, setKpi: drawKpi };
}

function buildPendantLamp(x: number, z: number, y = 2.2): Group {
  const group = new Group();
  const wire = new Mesh(new CylinderGeometry(0.006, 0.006, 3.2 - y, 6), mat(0x111827));
  wire.position.set(x, (3.2 + y) / 2, z);
  const shade = new Mesh(new ConeGeometry(0.2, 0.2, 16), mat(0x181f2a));
  shade.position.set(x, y, z);
  const glow = new Mesh(
    new CircleGeometry(0.16, 12),
    mat(0xf5eedb, { emissive: 0xf5eedb, emissiveIntensity: 0.35 }),
  );
  glow.rotation.x = Math.PI / 2;
  glow.position.set(x, y - 0.08, z);
  group.add(wire, shade, glow);
  return group;
}

function buildHaloChandelier(cx: number, cz: number, radius: number): Group {
  const group = new Group();
  const ringR = Math.min(radius * 0.32, 4.0);
  const ringMat = mat(0xf5eedb, { emissive: 0xf5eedb, emissiveIntensity: 0.4 });
  const ringMesh = new Mesh(new TorusGeometry(ringR, 0.04, 12, 48), ringMat);
  ringMesh.rotation.x = Math.PI / 2;
  ringMesh.position.set(cx, 2.7, cz);
  group.add(ringMesh);

  // 4 Thin Suspension Cables to ceiling
  const cableMat = mat(0x1f2937);
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2;
    const cable = new Mesh(new CylinderGeometry(0.005, 0.005, 0.7, 6), cableMat);
    cable.position.set(
      cx + Math.cos(ang) * ringR,
      3.05,
      cz + Math.sin(ang) * ringR,
    );
    group.add(cable);
  }
  return group;
}

function buildNeonPodRug(pod: Pod): Group {
  const group = new Group();

  // Dark matte floor mat
  const rug = new Mesh(
    new BoxGeometry(pod.rect.w, 0.02, pod.rect.d),
    mat(0x141a24, { roughness: 0.95 }),
  );
  rug.position.set(pod.rect.x + pod.rect.w / 2, 0.02, pod.rect.z + pod.rect.d / 2);
  rug.receiveShadow = true;
  group.add(rug);

  // Subtle glowing accent border in pod color
  const neon = mat(pod.color, { emissive: pod.color, emissiveIntensity: 0.35, roughness: 0.5 });
  const y = 0.038;
  const x = pod.rect.x;
  const z = pod.rect.z;
  const edges: Array<[number, number, number, number]> = [
    [pod.rect.w, 0.025, x + pod.rect.w / 2, z],
    [pod.rect.w, 0.025, x + pod.rect.w / 2, z + pod.rect.d],
    [0.025, pod.rect.d, x, z + pod.rect.d / 2],
    [0.025, pod.rect.d, x + pod.rect.w, z + pod.rect.d / 2],
  ];
  for (const [width, depth, cx, cz] of edges) {
    const edge = new Mesh(new BoxGeometry(width, 0.025, depth), neon);
    edge.position.set(cx, y, cz);
    group.add(edge);
  }

  // Pod Label printed along the edge
  const label = podLabelTexture(pod.label, pod.color);
  const plate = new Mesh(
    new PlaneGeometry(Math.min(pod.rect.w * 0.85, 2.6), 0.26),
    new MeshBasicMaterial({ map: label, transparent: true }),
  );
  plate.rotation.x = -Math.PI / 2;
  plate.position.set(pod.rect.x + pod.rect.w / 2, 0.045, pod.rect.z + 0.2);
  group.add(plate);

  return group;
}

function podLabelTexture(text: string, colorHex: number): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const hex = `#${colorHex.toString(16).padStart(6, "0")}`;
    ctx.fillStyle = hex;
    ctx.font = "bold 26px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 256, 32);
  }
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function buildModernDesk(): Group {
  const group = new Group();

  // Clean Light Wood Desktop
  const top = new Mesh(
    new BoxGeometry(1.6, 0.06, 0.82),
    mat(WOOD_OAK_A, { roughness: 0.6 }),
  );
  top.position.y = 0.75;
  top.castShadow = true;
  top.receiveShadow = true;
  group.add(top);

  // Slim Black Metal Legs
  const legMat = mat(0x1f2937, { metalness: 0.6, roughness: 0.4 });
  for (const [x, z] of [[-0.7, -0.32], [0.7, -0.32], [-0.7, 0.32], [0.7, 0.32]] as Array<[number, number]>) {
    const leg = new Mesh(new BoxGeometry(0.06, 0.74, 0.06), legMat);
    leg.position.set(x, 0.37, z);
    leg.castShadow = true;
    group.add(leg);
  }

  // Desk Mat
  const matMesh = new Mesh(new BoxGeometry(1.1, 0.006, 0.48), mat(0x18202c));
  matMesh.position.set(0, 0.784, 0.06);
  group.add(matMesh);

  // Black Keyboard and Mouse
  const kb = new Mesh(new BoxGeometry(0.38, 0.015, 0.14), mat(0x111827));
  kb.position.set(-0.06, 0.793, 0.12);
  const mouse = new Mesh(new BoxGeometry(0.06, 0.018, 0.09), mat(0x1e293b));
  mouse.position.set(0.3, 0.793, 0.12);
  group.add(kb, mouse);

  // Dual Black Monitors on Articulated Stand
  const stand = new Mesh(new CylinderGeometry(0.025, 0.025, 0.4, 8), legMat);
  stand.position.set(0, 0.95, -0.18);
  const arm = new Mesh(new BoxGeometry(0.85, 0.03, 0.03), legMat);
  arm.position.set(0, 1.15, -0.18);
  group.add(stand, arm);

  // Primary Monitor (Screen)
  const mainFrame = new Mesh(new BoxGeometry(0.68, 0.42, 0.03), mat(0x0f172a));
  mainFrame.position.set(-0.12, 1.18, -0.18);
  mainFrame.castShadow = true;

  const screen = new Mesh(new PlaneGeometry(0.64, 0.38), mat(0x020617));
  screen.position.set(-0.12, 1.18, -0.16);
  screen.userData.screen = true; // Crucial: picked up by stage deskScreens map

  // Secondary Monitor (tilted inward)
  const sideFrame = new Mesh(new BoxGeometry(0.32, 0.42, 0.03), mat(0x0f172a));
  sideFrame.position.set(0.42, 1.18, -0.14);
  sideFrame.rotation.y = -0.35;
  const sideScreen = new Mesh(
    new PlaneGeometry(0.28, 0.38),
    mat(0x0f172a, { emissive: 0x38bdf8, emissiveIntensity: 0.2 }),
  );
  sideScreen.position.set(0.42, 1.18, -0.12);
  sideScreen.rotation.y = -0.35;

  group.add(mainFrame, screen, sideFrame, sideScreen);
  return group;
}

export function buildChair(): Group {
  const group = new Group();

  // 5-Spoke Wheel Base
  const hub = new Mesh(new CylinderGeometry(0.08, 0.08, 0.04, 8), mat(0x1f2937));
  hub.position.y = 0.08;
  group.add(hub);

  const pole = new Mesh(
    new CylinderGeometry(0.03, 0.03, 0.3, 8),
    mat(0x64748b, { metalness: 0.8 }),
  );
  pole.position.y = 0.23;
  group.add(pole);

  // Black contoured seat
  const seat = new Mesh(
    new BoxGeometry(0.48, 0.06, 0.46),
    mat(0x111827, { roughness: 0.8 }),
  );
  seat.position.y = 0.46;
  seat.castShadow = true;

  // Modern black mesh ergonomic backrest
  const back = new Mesh(
    new BoxGeometry(0.46, 0.48, 0.05),
    mat(0x111827, { roughness: 0.8 }),
  );
  back.position.set(0, 0.7, -0.21);
  back.castShadow = true;

  group.add(seat, back);
  return group;
}

function buildModernFixture(
  fixture: Fixture,
): {
  group: Group;
  leds: Mesh[];
  hands: Group | null;
} {
  const group = new Group();
  const leds: Mesh[] = [];
  let hands: Group | null = null;

  if (fixture.kind === "sofa") group.add(buildLoungeSofa());
  else if (fixture.kind === "meeting") group.add(buildMeetingBooth());
  else if (fixture.kind === "server") {
    // Tall Server Rack with green blinking LEDs
    const rack = buildServerRack();
    group.add(rack.group);
    leds.push(...rack.leds);
  } else if (fixture.kind === "whiteboard") group.add(buildModernWhiteboard());
  else if (fixture.kind === "plant") group.add(buildModernFicusPlant());
  else if (fixture.kind === "bookshelf") group.add(buildOfficeBookshelf());

  return { group, leds, hands };
}

function buildLoungeSofa(): Group {
  const group = new Group();

  // Circular Sage Green Rug (calm muted tone matching Scandinavian aesthetic)
  const rug = new Mesh(
    new CircleGeometry(2.6, 28),
    mat(0x445e4e, { roughness: 0.95 }),
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.025;
  rug.receiveShadow = true;
  group.add(rug);

  // Modern Sectional L-Sofa in Slate Grey / Teal fabric
  const sofaMat = mat(0x28313d, { roughness: 0.85 });
  const cushionMat = mat(0x384a5c, { roughness: 0.85 });
  const seatA = new Mesh(new BoxGeometry(2.4, 0.3, 0.8), cushionMat);
  seatA.position.set(0, 0.38, 0);
  const seatB = new Mesh(new BoxGeometry(0.8, 0.3, 1.5), cushionMat);
  seatB.position.set(1.0, 0.38, -0.75);

  const backA = new Mesh(new BoxGeometry(2.4, 0.55, 0.16), sofaMat);
  backA.position.set(0, 0.72, -0.34);
  const backB = new Mesh(new BoxGeometry(0.16, 0.55, 1.6), sofaMat);
  backB.position.set(1.38, 0.72, -0.75);

  // Low Wooden Coffee Table
  const table = new Mesh(new BoxGeometry(0.9, 0.28, 0.5), mat(WOOD_OAK_A));
  table.position.set(0.1, 0.15, 0.7);

  // Tiny Potted Succulent on Coffee Table
  const tinyPot = new Mesh(new CylinderGeometry(0.04, 0.03, 0.06, 8), mat(0xffffff));
  tinyPot.position.set(0.1, 0.32, 0.7);
  const tinyPlant = new Mesh(new SphereGeometry(0.04, 6, 6), mat(0x446e52));
  tinyPlant.position.set(0.1, 0.37, 0.7);

  // Tall Minimalist Arched Floor Lamp
  const lampBase = new Mesh(new CylinderGeometry(0.18, 0.18, 0.03, 16), mat(0x1f2937));
  lampBase.position.set(-1.1, 0.03, -0.8);
  const lampPole = new Mesh(new CylinderGeometry(0.02, 0.02, 2.2, 8), mat(0x1f2937));
  lampPole.position.set(-1.1, 1.1, -0.8);
  const lampShade = new Mesh(
    new ConeGeometry(0.18, 0.22, 16),
    mat(0xf5eedb, { emissive: 0xf5eedb, emissiveIntensity: 0.35 }),
  );
  lampShade.position.set(-0.7, 2.2, -0.4);

  group.add(seatA, seatB, backA, backB, table, tinyPot, tinyPlant, lampBase, lampPole, lampShade);
  return group;
}

function buildMeetingBooth(): Group {
  const group = new Group();

  // Glass Meeting Booth Partition (matching screenshot with black metal mullions)
  const glassMat = mat(0xaec1d6, { transparent: true, opacity: 0.18, side: DoubleSide });
  const frameMat = mat(MULLION_DARK);
  const frostedMat = mat(0xffffff, { transparent: true, opacity: 0.45, side: DoubleSide });

  // Front Glass Wall
  const glassWall = new Mesh(new BoxGeometry(2.8, 2.8, 0.04), glassMat);
  glassWall.position.set(0, 1.4, 0);
  const frostedStripe = new Mesh(new BoxGeometry(2.8, 0.18, 0.045), frostedMat);
  frostedStripe.position.set(0, 1.35, 0);

  const frameL = new Mesh(new BoxGeometry(0.06, 2.8, 0.06), frameMat);
  frameL.position.set(-1.4, 1.4, 0);
  const frameR = new Mesh(new BoxGeometry(0.06, 2.8, 0.06), frameMat);
  frameR.position.set(1.4, 1.4, 0);
  const frameT = new Mesh(new BoxGeometry(2.86, 0.06, 0.06), frameMat);
  frameT.position.set(0, 2.8, 0);

  // Side Glass Partition
  const sideGlass = new Mesh(new BoxGeometry(0.04, 2.8, 2.4), glassMat);
  sideGlass.position.set(-1.4, 1.4, 1.2);
  const sideFrosted = new Mesh(new BoxGeometry(0.045, 0.18, 2.4), frostedMat);
  sideFrosted.position.set(-1.4, 1.35, 1.2);
  const sideFrameT = new Mesh(new BoxGeometry(0.06, 0.06, 2.4), frameMat);
  sideFrameT.position.set(-1.4, 2.8, 1.2);

  // Round Meeting Table inside
  const table = new Mesh(new CylinderGeometry(0.85, 0.85, 0.06, 20), mat(WOOD_OAK_A));
  table.position.set(0, 0.75, 1.2);
  const leg = new Mesh(new CylinderGeometry(0.08, 0.1, 0.72, 10), mat(0x1f2937));
  leg.position.set(0, 0.36, 1.2);

  // Hanging Black Industrial Cone Pendant Lamp over meeting table
  const lampWire = new Mesh(new CylinderGeometry(0.006, 0.006, 0.9, 6), mat(0x111827));
  lampWire.position.set(0, 2.35, 1.2);
  const lampShade = new Mesh(new ConeGeometry(0.24, 0.22, 16), mat(0x181f2a));
  lampShade.position.set(0, 1.9, 1.2);
  const lampGlow = new Mesh(
    new CircleGeometry(0.2, 12),
    mat(0xf5eedb, { emissive: 0xf5eedb, emissiveIntensity: 0.35 }),
  );
  lampGlow.rotation.x = Math.PI / 2;
  lampGlow.position.set(0, 1.79, 1.2);

  // Bookshelf inside meeting room
  const bookshelf = buildOfficeBookshelf();
  bookshelf.position.set(0.6, 0, 2.2);
  bookshelf.rotation.y = -Math.PI / 2;

  group.add(
    glassWall,
    frostedStripe,
    frameL,
    frameR,
    frameT,
    sideGlass,
    sideFrosted,
    sideFrameT,
    table,
    leg,
    lampWire,
    lampShade,
    lampGlow,
    bookshelf,
  );

  // 4 Modern Meeting Chairs around table
  for (let c = 0; c < 4; c++) {
    const chair = buildChair();
    const angle = (c / 4) * Math.PI * 2;
    chair.position.set(Math.cos(angle) * 1.25, 0, 1.2 + Math.sin(angle) * 1.25);
    chair.rotation.y = -angle + Math.PI / 2;
    group.add(chair);
  }

  return group;
}

function buildServerRack(): { group: Group; leds: Mesh[] } {
  const group = new Group();

  // Modern Slate Server Cabinet
  const cabinet = new Mesh(
    new BoxGeometry(0.8, 1.75, 0.55),
    mat(0x1e293b, { metalness: 0.5, roughness: 0.4 }),
  );
  cabinet.position.y = 0.875;
  cabinet.castShadow = true;
  group.add(cabinet);

  // Vertical Columns of Blinking Green LEDs
  const leds: Mesh[] = [];
  const ledMat = mat(0x10b981, { emissive: 0x10b981, emissiveIntensity: 0.6 });

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 3; col++) {
      const led = new Mesh(new BoxGeometry(0.06, 0.03, 0.02), ledMat);
      led.position.set(-0.2 + col * 0.2, 0.28 + row * 0.16, 0.28);
      group.add(led);
      leds.push(led);
    }
  }

  return { group, leds };
}

function buildModernWhiteboard(): Group {
  const group = new Group();

  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 3;
    ctx.strokeRect(16, 20, 90, 50);
    ctx.fillStyle = "#1e293b";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText("ARCHITECTURE", 22, 42);
    ctx.strokeStyle = "#22c55e";
    ctx.strokeRect(145, 45, 95, 48);
    ctx.fillText("DEPLOYMENT", 152, 68);
    ctx.beginPath();
    ctx.moveTo(106, 45); ctx.lineTo(145, 68);
    ctx.stroke();
  }
  const texture = new CanvasTexture(canvas);
  const board = new Mesh(
    new PlaneGeometry(1.5, 0.9),
    new MeshBasicMaterial({ map: texture, side: DoubleSide }),
  );
  board.position.set(0, 1.45, 0);

  const standMat = mat(0x64748b);
  const legL = new Mesh(new BoxGeometry(0.05, 1.35, 0.05), standMat);
  legL.position.set(-0.68, 0.675, 0);
  const legR = legL.clone();
  legR.position.x = 0.68;

  group.add(board, legL, legR);
  return group;
}

function buildModernFicusPlant(): Group {
  const group = new Group();

  // Clean White Tapered Ceramic Pot (directly like the screenshot!)
  const pot = new Mesh(
    new CylinderGeometry(0.2, 0.14, 0.45, 16),
    mat(0xffffff, { roughness: 0.3 }),
  );
  pot.position.y = 0.225;
  pot.castShadow = true;

  // Lush Green Ficus/Monstera Leaves
  const stem = new Mesh(new CylinderGeometry(0.04, 0.05, 0.6, 8), mat(0x5c3a21));
  stem.position.y = 0.55;

  const leafMat = mat(0x16a34a, { roughness: 0.7 });
  for (let l = 0; l < 6; l++) {
    const leaf = new Mesh(new SphereGeometry(0.18, 8, 6), leafMat);
    const ang = (l / 6) * Math.PI * 2;
    leaf.scale.set(1.4, 0.3, 0.8);
    leaf.position.set(Math.cos(ang) * 0.18, 0.7 + (l % 3) * 0.15, Math.sin(ang) * 0.18);
    leaf.rotation.y = ang;
    group.add(leaf);
  }

  group.add(pot, stem);
  return group;
}

function buildOfficeBookshelf(): Group {
  const group = new Group();
  const frame = mat(WOOD_OAK_B, { roughness: 0.65 });
  const body = new Mesh(new BoxGeometry(1.4, 1.85, 0.35), frame);
  body.position.y = 0.925;
  body.castShadow = true;
  group.add(body);

  for (let shelf = 0; shelf < 3; shelf += 1) {
    const board = new Mesh(new BoxGeometry(1.3, 0.03, 0.3), mat(WOOD_OAK_A));
    board.position.y = 0.4 + shelf * 0.52;
    group.add(board);

    for (let book = 0; book < 7; book += 1) {
      const colors = [0x4a6d8c, 0x9e5b52, 0x4d755c, 0xa37e4c, 0x63577d];
      const vol = new Mesh(
        new BoxGeometry(0.07, 0.26, 0.22),
        mat(colors[(book + shelf) % colors.length]!),
      );
      vol.position.set(-0.5 + book * 0.16, 0.55 + shelf * 0.52, 0);
      group.add(vol);
    }
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
