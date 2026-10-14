import {
  ACESFilmicToneMapping,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  GridHelper,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Raycaster,
  RingGeometry,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D as Object3DType,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import {
  FLOOR_ROTATION_X,
  type ChronicleScene,
  type StationLayoutInput,
  type Vec3,
} from "./chronicleLayout";

// Cybernetic Sci-Fi Palette
const TEAL = 0x2dd4bf;
const GOLD = 0xff9a3c;
const FLOOR = 0x050e18;
const VOID = 0x020408;

// 3D Card Architecture Constants
const CARD_WIDTH = 2.8;
const CARD_HEIGHT = 1.84;
const CARD_SPACING_X = 2.2;
const CARD_BASE_Y = 1.02;
// Stood vertically at ~50° angle (resting rolodex gallery tilt)
const RESTING_ROTATION_Y = -0.8726; // -50 degrees in radians

function realStations(stations: StationLayoutInput[]): StationLayoutInput[] {
  return stations.filter((station) => station.kind !== "now");
}

function cardCentroid(stations: StationLayoutInput[], _count?: number): Vec3 {
  const real = realStations(stations);
  if (real.length === 0) return { x: 0, y: CARD_BASE_Y, z: 0 };
  let maxOrdinal = 0;
  let maxLane = 0;
  for (const s of real) {
    maxOrdinal = Math.max(maxOrdinal, s.ordinal);
    maxLane = Math.max(maxLane, s.lane);
  }
  return {
    x: (maxOrdinal * CARD_SPACING_X) / 2,
    y: CARD_BASE_Y,
    z: (maxLane * 1.1) / 2,
  };
}

function cardCameraOffset(stations: StationLayoutInput[]): Vec3 {
  const count = stations.length;
  const spanX = Math.max(3, count * CARD_SPACING_X);
  return {
    x: 0,
    y: 2.1,
    z: Math.max(5.6, Math.min(16, spanX * 0.52)),
  };
}

// ---------------------------------------------------------------------------
// 3D Transparent Station Card Canvas Renderer with Scrollable Diff
// ---------------------------------------------------------------------------
function redrawStationCard(
  canvas: HTMLCanvasElement,
  station: StationLayoutInput,
  isActive: boolean,
  isHovered: boolean,
  scrollLine = 0,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // 1. Semi-transparent Cybernetic Glass Panel Background
  const r = 14;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(w - r, 0);
  ctx.quadraticCurveTo(w, 0, w, r);
  ctx.lineTo(w, h - r);
  ctx.quadraticCurveTo(w, h, w - r, h);
  ctx.lineTo(r, h);
  ctx.quadraticCurveTo(0, h, 0, h - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  if (isActive) {
    grad.addColorStop(0, "rgba(22, 32, 46, 0.95)");
    grad.addColorStop(1, "rgba(10, 16, 26, 0.97)");
  } else if (isHovered) {
    grad.addColorStop(0, "rgba(16, 26, 38, 0.93)");
    grad.addColorStop(1, "rgba(8, 14, 24, 0.95)");
  } else {
    grad.addColorStop(0, "rgba(8, 16, 26, 0.86)");
    grad.addColorStop(1, "rgba(5, 10, 18, 0.88)");
  }
  ctx.fillStyle = grad;
  ctx.fill();

  // Card Border
  ctx.lineWidth = isActive ? 3 : isHovered ? 2.5 : 1.5;
  ctx.strokeStyle = isActive
    ? "rgba(255, 154, 60, 0.95)"
    : isHovered
    ? "rgba(45, 212, 191, 0.95)"
    : "rgba(45, 212, 191, 0.45)";
  ctx.stroke();

  // Corner Accents (Sci-fi brackets)
  const cSize = 12;
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = isActive ? "#ff9a3c" : "#2dd4bf";
  ctx.beginPath();
  ctx.moveTo(2, cSize);
  ctx.lineTo(2, 2);
  ctx.lineTo(cSize, 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w - 2 - cSize, 2);
  ctx.lineTo(w - 2, 2);
  ctx.lineTo(w - 2, cSize);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(2, h - 2 - cSize);
  ctx.lineTo(2, h - 2);
  ctx.lineTo(cSize, h - 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w - 2 - cSize, h - 2);
  ctx.lineTo(w - 2, h - 2);
  ctx.lineTo(w - 2, h - 2 - cSize);
  ctx.stroke();

  // 2. Header Bar
  ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
  ctx.fillRect(4, 4, w - 8, 46);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(4, 50);
  ctx.lineTo(w - 4, 50);
  ctx.stroke();

  // Revision Chip
  const isNow = station.kind === "now";
  const revLabel = isNow ? "LIVE NOW" : `#${station.ordinal}`;
  ctx.font = "bold 14px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = isActive ? "#ff9a3c" : "#2dd4bf";
  ctx.fillText(revLabel, 16, 32);

  // Tool / Kind Tag
  const toolName = (station.tool || station.kind || "edit").toUpperCase();
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  const toolW = ctx.measureText(toolName).width + 12;
  const toolX = isNow ? 104 : 64;
  ctx.fillStyle = "rgba(91, 141, 239, 0.22)";
  ctx.fillRect(toolX, 18, toolW, 20);
  ctx.strokeStyle = "rgba(91, 141, 239, 0.45)";
  ctx.strokeRect(toolX, 18, toolW, 20);
  ctx.fillStyle = "#93c5fd";
  ctx.fillText(toolName, toolX + 6, 32);

  // File Extension Badge
  const fullPath = station.path || station.id;
  const parts = fullPath.split(".");
  const ext = parts.length > 1 ? `.${parts.pop()!.toUpperCase()}` : ".FILE";
  const extW = ctx.measureText(ext).width + 12;
  const extX = w - 16 - extW;
  ctx.fillStyle = "rgba(45, 212, 191, 0.15)";
  ctx.fillRect(extX, 18, extW, 20);
  ctx.strokeStyle = "rgba(45, 212, 191, 0.4)";
  ctx.strokeRect(extX, 18, extW, 20);
  ctx.fillStyle = "#2dd4bf";
  ctx.fillText(ext, extX + 6, 32);

  // 3. Filename & Churn Metrics
  const baseName = fullPath.split(/[/\\]/).pop() || fullPath;
  ctx.font = "bold 17px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(baseName, 16, 78);

  ctx.font = "bold 13px ui-monospace, SFMono-Regular, Menlo, monospace";
  const plusText = `+${station.added}`;
  const minusText = `−${station.removed}`;
  ctx.fillStyle = "#2dd4bf";
  ctx.fillText(plusText, 16, 100);
  const plusW = ctx.measureText(plusText).width;
  ctx.fillStyle = "#f87171";
  ctx.fillText(minusText, 16 + plusW + 10, 100);

  // Outcome Tag
  const isErr = station.outcome === "error";
  const statusLabel = isErr ? "● FAILED" : "● OK";
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = isErr ? "#f87171" : "rgba(45, 212, 191, 0.75)";
  ctx.fillText(statusLabel, 16 + plusW + 10 + ctx.measureText(minusText).width + 12, 100);

  // 4. Actual Content of the Changes (Scrollable Diff Box)
  const previewBoxX = 14;
  const previewBoxY = 114;
  const previewBoxW = w - 28;
  const previewBoxH = h - 146;

  ctx.fillStyle = "rgba(3, 7, 14, 0.88)";
  ctx.fillRect(previewBoxX, previewBoxY, previewBoxW, previewBoxH);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.strokeRect(previewBoxX, previewBoxY, previewBoxW, previewBoxH);

  // Header of diff container
  ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
  ctx.fillRect(previewBoxX, previewBoxY, previewBoxW, 22);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.beginPath();
  ctx.moveTo(previewBoxX, previewBoxY + 22);
  ctx.lineTo(previewBoxX + previewBoxW, previewBoxY + 22);
  ctx.stroke();

  const rawPreview = station.preview || (isNow ? "Current worktree state" : "No preview available");
  const allLines = rawPreview.split("\n");
  const visibleLines = 12;
  const maxScroll = Math.max(0, allLines.length - visibleLines);
  const safeScroll = Math.max(0, Math.min(maxScroll, scrollLine));
  const linesToRender = allLines.slice(safeScroll, safeScroll + visibleLines);

  ctx.font = "9.5px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "rgba(226, 232, 240, 0.55)";
  const rangeEnd = Math.min(allLines.length, safeScroll + visibleLines);
  ctx.fillText(
    `CHANGES // L ${safeScroll + 1}–${rangeEnd} OF ${allLines.length}`,
    previewBoxX + 8,
    previewBoxY + 15,
  );

  if (maxScroll > 0) {
    ctx.fillStyle = isHovered ? "#ff9a3c" : "#38bdf8";
    ctx.fillText("↕ WHEEL TO SCROLL", previewBoxX + previewBoxW - 110, previewBoxY + 15);
  }

  // Render Diff Lines
  const lineH = 20;
  ctx.font = "11.5px ui-monospace, SFMono-Regular, Menlo, monospace";

  linesToRender.forEach((line, idx) => {
    const yLine = previewBoxY + 38 + idx * lineH;
    if (yLine > previewBoxY + previewBoxH - 4) return;

    const lineNum = (safeScroll + idx + 1).toString().padStart(2, "0");
    const isAdd = line.startsWith("+") && !line.startsWith("+++");
    const isDel = line.startsWith("-") && !line.startsWith("---");
    const isHunk = line.startsWith("@@");

    if (isAdd) {
      ctx.fillStyle = "rgba(45, 212, 191, 0.14)";
      ctx.fillRect(previewBoxX + 1, yLine - 13, previewBoxW - 8, lineH);
      ctx.fillStyle = "#2dd4bf";
    } else if (isDel) {
      ctx.fillStyle = "rgba(248, 113, 113, 0.14)";
      ctx.fillRect(previewBoxX + 1, yLine - 13, previewBoxW - 8, lineH);
      ctx.fillStyle = "#f87171";
    } else if (isHunk) {
      ctx.fillStyle = "rgba(56, 189, 248, 0.12)";
      ctx.fillRect(previewBoxX + 1, yLine - 13, previewBoxW - 8, lineH);
      ctx.fillStyle = "#38bdf8";
    } else {
      ctx.fillStyle = "rgba(226, 232, 240, 0.75)";
    }

    // Line number prefix
    ctx.fillStyle = "rgba(148, 163, 184, 0.38)";
    ctx.fillText(lineNum, previewBoxX + 6, yLine);

    // Line text
    if (isAdd) ctx.fillStyle = "#2dd4bf";
    else if (isDel) ctx.fillStyle = "#f87171";
    else if (isHunk) ctx.fillStyle = "#38bdf8";
    else ctx.fillStyle = "rgba(226, 232, 240, 0.75)";

    const displayLine = line.length > 58 ? line.slice(0, 55) + "…" : line;
    ctx.fillText(displayLine, previewBoxX + 28, yLine);
  });

  // Sci-Fi Scrollbar Track & Thumb
  if (maxScroll > 0) {
    const sbTrackX = previewBoxX + previewBoxW - 6;
    const sbTrackY = previewBoxY + 23;
    const sbTrackH = previewBoxH - 24;

    ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
    ctx.fillRect(sbTrackX, sbTrackY, 4, sbTrackH);

    const thumbH = Math.max(16, (visibleLines / allLines.length) * sbTrackH);
    const thumbY = sbTrackY + (safeScroll / maxScroll) * (sbTrackH - thumbH);

    ctx.fillStyle = isHovered ? "#ff9a3c" : "#2dd4bf";
    ctx.fillRect(sbTrackX, thumbY, 4, thumbH);
  }

  // 5. Card Footer Interaction Hint
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = isHovered ? "rgba(255, 154, 60, 0.85)" : "rgba(226, 232, 240, 0.4)";
  ctx.fillText(
    isHovered
      ? "⚡ ACTIVE INSPECTION · SCROLL WHEEL TO BROWSE DIFF"
      : "HOVER TO EXPAND · CLICK TO SELECT",
    16,
    h - 12,
  );

  ctx.restore();
}

function drawStationCardCanvas(
  station: StationLayoutInput,
  isActive: boolean,
  isHovered: boolean,
  scrollLine = 0,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 420;
  redrawStationCard(canvas, station, isActive, isHovered, scrollLine);
  return canvas;
}

export interface ChronicleHooks {
  onActiveId: (id: string) => void;
}

export interface ChronicleHandle {
  setStations(
    stations: StationLayoutInput[],
    scene: ChronicleScene,
    activeId: string,
    nowPaths?: readonly string[],
  ): void;
  setSize(width: number, height: number): void;
  setAutoRotate(enabled: boolean): void;
  resetCamera(): void;
  dispose(): void;
}

interface Station3DCard {
  mesh: Mesh;
  pedestalMesh: Mesh;
  pedestalMat: MeshBasicMaterial;
  texture: CanvasTexture;
  canvas: HTMLCanvasElement;
  station: StationLayoutInput;
  baseX: number;
  baseY: number;
  baseZ: number;
  scrollLine: number;
  allLines: string[];
  visibleLines: number;
  maxScroll: number;
}

function disposeMaterial(material: Material) {
  const mapped = material as Material & { map?: { dispose(): void } | null };
  mapped.map?.dispose();
  material.dispose();
}

function disposeObject(object: Object3DType) {
  const meshed = object as Mesh;
  meshed.geometry?.dispose();
  const material = meshed.material;
  if (Array.isArray(material)) material.forEach(disposeMaterial);
  else if (material) disposeMaterial(material);
}

export function mountChronicle(host: HTMLElement, hooks: ChronicleHooks): ChronicleHandle {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const renderer = new WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(pixelRatio);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.cursor = "grab";
  host.appendChild(renderer.domElement);

  // 2D Tactical HUD Canvas layered directly on top of 3D WebGL canvas
  const hudCanvas = document.createElement("canvas");
  hudCanvas.className = "chronicle-hud-canvas";
  hudCanvas.style.position = "absolute";
  hudCanvas.style.inset = "0";
  hudCanvas.style.width = "100%";
  hudCanvas.style.height = "100%";
  hudCanvas.style.pointerEvents = "none";
  hudCanvas.style.zIndex = "3";
  host.appendChild(hudCanvas);
  const hud = hudCanvas.getContext("2d");

  const scene = new Scene();
  scene.background = new Color(VOID);
  const camera = new PerspectiveCamera(48, 1, 0.1, 500);
  camera.up.set(0, 1, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.enableZoom = true;
  controls.minDistance = 2.5;
  controls.maxDistance = 60;
  controls.minPolarAngle = 0.12;
  controls.maxPolarAngle = Math.PI / 2 - 0.04;
  controls.dampingFactor = 0.08;

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const syncMotion = () => {
    controls.enableDamping = !motionQuery.matches;
  };
  syncMotion();

  let hostWidth = Math.max(1, host.clientWidth);
  let hostHeight = Math.max(1, host.clientHeight);
  renderer.setSize(hostWidth, hostHeight, false);
  camera.aspect = hostWidth / hostHeight;
  camera.updateProjectionMatrix();

  hudCanvas.width = hostWidth * pixelRatio;
  hudCanvas.height = hostHeight * pixelRatio;
  if (hud) hud.scale(pixelRatio, pixelRatio);

  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  const bloomPass = new UnrealBloomPass(new Vector2(hostWidth, hostHeight), 0.55, 0.4, 0.25);
  const outputPass = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);

  // Deep cybernetic base floor
  const floor = new Mesh(new PlaneGeometry(4000, 4000), new MeshBasicMaterial({ color: FLOOR }));
  floor.rotation.x = FLOOR_ROTATION_X;
  floor.position.set(0, 0, 0);
  scene.add(floor);

  // Subdued neon floor grid
  const grid = new GridHelper(2000, 100, TEAL, TEAL);
  grid.position.y = 0.015;
  const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
  for (const m of gridMaterials) {
    m.transparent = true;
    m.opacity = 0.14;
  }
  scene.add(grid);

  // Floating Cybernetic Dust Constellation
  const particleCount = 450;
  const particlePositions = new Float32Array(particleCount * 3);
  const particleColors = new Float32Array(particleCount * 3);
  let pSeed = 1337;
  const pRng = () => {
    pSeed = (pSeed * 16807 + 11) % 2147483647;
    return (pSeed - 1) / 2147483646;
  };
  for (let i = 0; i < particleCount; i++) {
    particlePositions[i * 3] = (pRng() - 0.5) * 80;
    particlePositions[i * 3 + 1] = pRng() * 24 - 1;
    particlePositions[i * 3 + 2] = (pRng() - 0.5) * 80;
    const isTeal = pRng() > 0.4;
    particleColors[i * 3] = isTeal ? 0.17 : 0.95;
    particleColors[i * 3 + 1] = isTeal ? 0.83 : 0.62;
    particleColors[i * 3 + 2] = isTeal ? 0.75 : 0.24;
  }
  const particleGeo = new BufferGeometry();
  particleGeo.setAttribute("position", new Float32BufferAttribute(particlePositions, 3));
  particleGeo.setAttribute("color", new Float32BufferAttribute(particleColors, 3));
  const particleMat = new PointsMaterial({
    size: 0.22,
    vertexColors: true,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });
  const particles = new Points(particleGeo, particleMat);
  scene.add(particles);

  // Animated Chronological Laser Scanning Plane
  const scanMat = new MeshBasicMaterial({
    color: GOLD,
    side: DoubleSide,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
  });
  const scanPlane = new Mesh(new PlaneGeometry(40, 8), scanMat);
  scanPlane.position.set(0, 2.5, 0);
  scanPlane.rotation.y = Math.PI / 2;
  scene.add(scanPlane);

  // Active Station Landmark Telemetry Beacon
  const beaconGroup = new Group();
  beaconGroup.visible = false;
  scene.add(beaconGroup);

  const pillarMat = new MeshBasicMaterial({
    color: GOLD,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
  });
  const pillar = new Mesh(new CylinderGeometry(0.035, 0.035, 4.8, 16), pillarMat);
  pillar.position.y = 2.4;
  beaconGroup.add(pillar);

  const ringGeo = new RingGeometry(0.24, 0.36, 32);
  const ringMat1 = new MeshBasicMaterial({
    color: GOLD,
    side: DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const ring1 = new Mesh(ringGeo, ringMat1);
  ring1.rotation.x = -Math.PI / 2;
  ring1.position.y = 0.05;
  beaconGroup.add(ring1);

  const ringMat2 = new MeshBasicMaterial({
    color: TEAL,
    side: DoubleSide,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  const ring2 = new Mesh(ringGeo, ringMat2);
  ring2.rotation.x = -Math.PI / 2;
  ring2.position.y = 0.05;
  beaconGroup.add(ring2);

  const root = new Group();
  scene.add(root);

  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const offset = new Vector3();
  const pick: Object3DType[] = [];
  const nodeMeshById = new Map<Object3DType, string>();

  let laidOut: StationLayoutInput[] = [];
  let realCount = 0;
  let currentActive = "";
  let framedPath: string | null = null;
  let built = "";
  let hoveredId: string | null = null;
  let directFrames = 0;
  let raf = 0;
  let disposed = false;
  let downPos = { x: 0, y: 0 };
  let isDown = false;
  let timelineSpanX = 10;

  // 3D Standing Station Cards
  const stationCards: Station3DCard[] = [];

  const clearRoot = () => {
    for (const card of stationCards) {
      card.texture.dispose();
    }
    stationCards.length = 0;
    nodeMeshById.clear();
    pick.length = 0;
    for (const child of [...root.children]) {
      root.remove(child);
      child.traverse(disposeObject);
    }
  };

  const resolveActive = (): StationLayoutInput | undefined => {
    const found = laidOut.find((s) => s.id === currentActive);
    if (found) return found;
    if (!currentActive.startsWith("now:")) return undefined;
    return {
      id: currentActive,
      ordinal: realCount,
      lane: 0,
      added: 0,
      removed: 0,
      kind: "now",
      outcome: "ok",
    };
  };

  const placeTarget = (x: number, y: number, z: number) => {
    offset.subVectors(camera.position, controls.target);
    if (offset.lengthSq() < 1e-8) {
      const fallback = cardCameraOffset(laidOut);
      offset.set(fallback.x, fallback.y, fallback.z);
    }
    controls.target.set(x, y, z);
    camera.position.copy(controls.target).add(offset);
    controls.update();
  };

  const follow = (fresh: boolean, rebuilt: boolean) => {
    const center = cardCentroid(laidOut, realCount);
    const active = resolveActive();
    const activeCard = stationCards.find((c) => c.station.id === active?.id);
    const activeX = activeCard ? activeCard.baseX : center.x;
    const activeZ = activeCard ? activeCard.baseZ : center.z;
    const path = active?.path ?? (active?.id.startsWith("now:") ? active.id.slice(4) : null);

    if (fresh) {
      const off = cardCameraOffset(laidOut);
      controls.target.set(center.x, center.y, center.z);
      camera.position.set(center.x + off.x, center.y + off.y, center.z + off.z);
      controls.update();
      framedPath = path;
      return;
    }
    if (path !== framedPath || rebuilt) {
      placeTarget(activeX, center.y, activeZ);
      framedPath = path;
      return;
    }
    placeTarget(activeX, controls.target.y, activeZ);
  };

  const rebuildRidgeScene = (stations: StationLayoutInput[]) => {
    const real = realStations(stations);
    realCount = real.length;

    let maxOrdinal = 0;
    for (const s of real) {
      maxOrdinal = Math.max(maxOrdinal, s.ordinal);
    }

    timelineSpanX = Math.max(2, (maxOrdinal + 1) * CARD_SPACING_X);

    // Reposition laser scan curtain
    scanPlane.geometry?.dispose();
    scanPlane.geometry = new PlaneGeometry(8, 8);

    // Timeline Runway Ground Rails (Cybernetic track under cards)
    const railMat = new MeshBasicMaterial({
      color: TEAL,
      transparent: true,
      opacity: 0.25,
      side: DoubleSide,
    });
    const railGeo = new PlaneGeometry(timelineSpanX + 4, 0.06);
    const railMesh = new Mesh(railGeo, railMat);
    railMesh.rotation.x = -Math.PI / 2;
    railMesh.position.set(timelineSpanX / 2 - 1, 0.02, 0);
    root.add(railMesh);

    // 3D Station Cards standing vertically at ~50° angle
    const cardGeo = new PlaneGeometry(CARD_WIDTH, CARD_HEIGHT);
    const padGeo = new PlaneGeometry(CARD_WIDTH * 0.95, 0.35);

    for (const station of real) {
      const baseX = station.ordinal * CARD_SPACING_X;
      const baseY = CARD_BASE_Y;
      const baseZ = station.lane * 1.1;

      const isAct = station.id === currentActive;
      const canvas = drawStationCardCanvas(station, isAct, false, 0);
      const texture = new CanvasTexture(canvas);
      const cardMat = new MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0.95,
        side: DoubleSide,
        depthWrite: false,
      });

      const cardMesh = new Mesh(cardGeo, cardMat);
      cardMesh.position.set(baseX, baseY, baseZ);
      cardMesh.rotation.y = RESTING_ROTATION_Y;
      cardMesh.userData.stationId = station.id;
      root.add(cardMesh);
      pick.push(cardMesh);
      nodeMeshById.set(cardMesh, station.id);

      // Floor Pedestal Pad under each card
      const padMat = new MeshBasicMaterial({
        color: isAct ? GOLD : TEAL,
        wireframe: true,
        transparent: true,
        opacity: isAct ? 0.75 : 0.35,
        side: DoubleSide,
      });
      const padMesh = new Mesh(padGeo, padMat);
      padMesh.rotation.x = -Math.PI / 2;
      padMesh.rotation.z = -RESTING_ROTATION_Y;
      padMesh.position.set(baseX, 0.02, baseZ);
      root.add(padMesh);

      const rawPreview =
        station.preview || (station.kind === "now" ? "Current worktree state" : "No preview available");
      const allLines = rawPreview.split("\n");
      const visibleLines = 12;
      const maxScroll = Math.max(0, allLines.length - visibleLines);

      stationCards.push({
        mesh: cardMesh,
        pedestalMesh: padMesh,
        pedestalMat: padMat,
        texture,
        canvas,
        station,
        baseX,
        baseY,
        baseZ,
        scrollLine: 0,
        allLines,
        visibleLines,
        maxScroll,
      });
    }
  };

  const paintActiveNodes = (activeId: string) => {
    for (const entry of stationCards) {
      const isAct = entry.station.id === activeId;
      const isHov = entry.station.id === hoveredId;
      redrawStationCard(entry.canvas, entry.station, isAct, isHov, entry.scrollLine);
      entry.texture.needsUpdate = true;

      // Update pedestal color
      entry.pedestalMat.color.set(isAct ? GOLD : TEAL);
      entry.pedestalMat.opacity = isAct ? 0.8 : isHov ? 0.6 : 0.35;
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    downPos = { x: event.clientX, y: event.clientY };
    isDown = true;
    renderer.domElement.style.cursor = "grabbing";
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!isDown) return;
    isDown = false;
    renderer.domElement.style.cursor = hoveredId ? "pointer" : "grab";
    const dx = event.clientX - downPos.x;
    const dy = event.clientY - downPos.y;
    if (dx * dx + dy * dy > 36) return;

    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(pick, false)[0];
    if (!hit) return;

    let id: string | null = null;
    if (typeof hit.object.userData.stationId === "string") id = hit.object.userData.stationId;

    if (id && id !== currentActive) {
      currentActive = id;
      follow(false, false);
      paintActiveNodes(id);
      hooks.onActiveId(id);
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(pick, false)[0];
    if (!hit) {
      if (hoveredId != null) {
        hoveredId = null;
        paintActiveNodes(currentActive);
      }
      if (!isDown) renderer.domElement.style.cursor = "grab";
      return;
    }

    let id: string | null = null;
    if (typeof hit.object.userData.stationId === "string") id = hit.object.userData.stationId;

    if (id !== hoveredId) {
      hoveredId = id;
      paintActiveNodes(currentActive);
    }
    if (!isDown) {
      renderer.domElement.style.cursor = hoveredId ? "pointer" : "grab";
    }
  };

  const onPointerLeave = () => {
    isDown = false;
    if (hoveredId != null) {
      hoveredId = null;
      paintActiveNodes(currentActive);
    }
    renderer.domElement.style.cursor = "grab";
  };

  const onWheel = (event: WheelEvent) => {
    // If hovering over a card with scrollable diff lines, wheel scrolls inside the card!
    if (hoveredId) {
      const card = stationCards.find((c) => c.station.id === hoveredId);
      if (card && card.maxScroll > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const dir = event.deltaY > 0 ? 1 : -1;
        card.scrollLine = Math.max(0, Math.min(card.maxScroll, card.scrollLine + dir * 2));
        redrawStationCard(
          card.canvas,
          card.station,
          card.station.id === currentActive,
          true,
          card.scrollLine,
        );
        card.texture.needsUpdate = true;
      }
    }
  };

  renderer.domElement.addEventListener("wheel", onWheel, { passive: false, capture: true });
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerleave", onPointerLeave);
  motionQuery.addEventListener("change", syncMotion);

  // ---------------------------------------------------------------------------
  // 2D Tactical HUD Canvas Draw Routine
  // ---------------------------------------------------------------------------
  const renderHud = (now: number, scanX: number) => {
    if (!hud) return;
    hud.clearRect(0, 0, hostWidth, hostHeight);

    // 1. Radar Compass (Top Left)
    const rcX = 52;
    const rcY = 52;
    const rcRad = 34;

    hud.save();
    hud.strokeStyle = "rgba(45, 212, 191, 0.45)";
    hud.lineWidth = 1;
    hud.beginPath();
    hud.arc(rcX, rcY, rcRad, 0, Math.PI * 2);
    hud.arc(rcX, rcY, rcRad * 0.55, 0, Math.PI * 2);
    hud.stroke();

    hud.strokeStyle = "rgba(45, 212, 191, 0.25)";
    hud.beginPath();
    hud.moveTo(rcX - rcRad - 4, rcY);
    hud.lineTo(rcX + rcRad + 4, rcY);
    hud.moveTo(rcX, rcY - rcRad - 4);
    hud.lineTo(rcX, rcY + rcRad + 4);
    hud.stroke();

    hud.font = "7.5px ui-monospace, SFMono-Regular, Menlo, monospace";
    hud.fillStyle = "rgba(45, 212, 191, 0.75)";
    hud.textAlign = "center";
    hud.fillText("N", rcX, rcY - rcRad + 9);
    hud.fillText("S", rcX, rcY + rcRad - 3);
    hud.textAlign = "left";
    hud.fillText("E", rcX + rcRad - 8, rcY + 3);
    hud.textAlign = "right";
    hud.fillText("W", rcX - rcRad + 8, rcY + 3);

    const sweepAngle = (now * 0.002) % (Math.PI * 2);
    hud.strokeStyle = "#ff9a3c";
    hud.lineWidth = 1.5;
    hud.beginPath();
    hud.moveTo(rcX, rcY);
    hud.lineTo(rcX + Math.cos(sweepAngle) * rcRad, rcY + Math.sin(sweepAngle) * rcRad);
    hud.stroke();

    hud.textAlign = "left";
    hud.fillStyle = "rgba(226, 232, 240, 0.5)";
    hud.fillText("RADAR // 360° SWEEP", rcX + rcRad + 12, rcY - 4);
    hud.fillStyle = "#ff9a3c";
    hud.fillText(`BEARING ${((sweepAngle * 180) / Math.PI).toFixed(0)}°`, rcX + rcRad + 12, rcY + 8);
    hud.restore();

    // 2. Vertical Revision Ladder (Left Screen Edge)
    const ladderTop = 110;
    const ladderBottom = hostHeight - 75;
    const ladderH = Math.max(10, ladderBottom - ladderTop);

    hud.save();
    hud.strokeStyle = "rgba(45, 212, 191, 0.3)";
    hud.fillStyle = "rgba(226, 232, 240, 0.4)";
    hud.lineWidth = 1;
    hud.beginPath();
    hud.moveTo(18, ladderTop);
    hud.lineTo(18, ladderBottom);
    hud.stroke();

    hud.font = "8px ui-monospace, SFMono-Regular, Menlo, monospace";
    hud.textAlign = "left";
    hud.fillStyle = "rgba(45, 212, 191, 0.75)";
    hud.fillText("REVS ▼", 14, ladderTop - 8);

    const act = resolveActive();
    const actOrd = act ? act.ordinal : 0;
    const totalRev = Math.max(1, realCount);

    if (totalRev > 1) {
      const stepCount = Math.min(8, totalRev);
      for (let s = 0; s < stepCount; s++) {
        const frac = s / (stepCount - 1);
        const y = ladderTop + frac * ladderH;
        const revIdx = Math.round(frac * (totalRev - 1));
        const isCurrent = revIdx === actOrd;

        hud.strokeStyle = isCurrent ? "#ff9a3c" : "rgba(45, 212, 191, 0.35)";
        hud.beginPath();
        hud.moveTo(18, y);
        hud.lineTo(26, y);
        hud.stroke();

        hud.fillStyle = isCurrent ? "#ff9a3c" : "rgba(226, 232, 240, 0.45)";
        hud.fillText(`#${revIdx}`, 30, y + 3);
      }
    }
    hud.restore();

    // 3. Bottom Right Telemetry Stream
    if (hostWidth >= 520) {
      hud.save();
      hud.font = "8px ui-monospace, SFMono-Regular, Menlo, monospace";
      hud.textAlign = "right";
      hud.fillStyle = "rgba(226, 232, 240, 0.45)";
      hud.fillText(
        `SWEEP X: ${scanX.toFixed(1)}   REVS: ${realCount}   ACTIVE: ${act ? `#${act.ordinal}` : "NONE"}   60 FPS`,
        hostWidth - 16,
        hostHeight - 14,
      );
      hud.restore();
    }
  };

  const frame = (now: number) => {
    raf = 0;
    if (disposed || document.hidden) return;

    // 1. Animate Chronological Laser Scanning Plane
    const scanPeriod = Math.max(timelineSpanX * 250, 3000);
    const scanProgress = (now % scanPeriod) / scanPeriod;
    const scanX = scanProgress * (timelineSpanX + 2) - 1;
    scanPlane.position.x = scanX;
    scanPlane.position.z = 0;
    scanMat.opacity = 0.16 + 0.12 * Math.sin(now * 0.004);

    // 2. Smoothly Animate 3D Cards: Tilt, Face-front on Hover, Scale & Lift
    for (const card of stationCards) {
      const isHov = card.station.id === hoveredId;
      const isAct = card.station.id === currentActive;
      const faceFront = isHov || (isAct && hoveredId === null);

      const targetRotY = faceFront ? 0 : RESTING_ROTATION_Y;
      const targetScale = isHov ? 1.22 : isAct ? 1.10 : 1.0;
      const targetZ = card.baseZ + (isHov ? 0.65 : isAct ? 0.35 : 0);
      const targetY = card.baseY + (isHov ? 0.12 : isAct ? 0.05 : 0);

      // Smooth damping interpolation
      card.mesh.rotation.y += (targetRotY - card.mesh.rotation.y) * 0.14;
      card.mesh.position.z += (targetZ - card.mesh.position.z) * 0.14;
      card.mesh.position.y += (targetY - card.mesh.position.y) * 0.14;

      const s = card.mesh.scale.x;
      const nextScale = s + (targetScale - s) * 0.14;
      card.mesh.scale.set(nextScale, nextScale, nextScale);
    }

    // 3. Telemetry Landmark Beacon tracking and sonar animation on the floor
    const act = resolveActive();
    const actCard = stationCards.find((c) => c.station.id === act?.id);
    if (actCard) {
      beaconGroup.position.set(actCard.baseX, 0, actCard.baseZ);
      beaconGroup.visible = true;

      const phase1 = (now % 1600) / 1600;
      const phase2 = ((now + 800) % 1600) / 1600;
      const s1 = 0.8 + phase1 * 2.4;
      const s2 = 0.8 + phase2 * 2.4;
      ring1.scale.set(s1, s1, 1);
      ringMat1.opacity = Math.max(0, 0.85 * (1 - phase1));
      ring2.scale.set(s2, s2, 1);
      ringMat2.opacity = Math.max(0, 0.6 * (1 - phase2));

      pillarMat.opacity = 0.45 + 0.25 * Math.sin(now * 0.005);
    } else {
      beaconGroup.visible = false;
    }

    // 4. Cosmic dust slow drift
    particles.rotation.y = now * 0.00003;

    if (controls.autoRotate || controls.enableDamping) controls.update();

    // 5. 3D WebGL Render
    const started = performance.now();
    if (motionQuery.matches || directFrames > 0) {
      renderer.render(scene, camera);
      if (directFrames > 0) directFrames -= 1;
    } else {
      composer.render();
    }
    if (performance.now() - started > 20) directFrames = 120;

    // 6. 2D Tactical HUD Canvas Render
    renderHud(now, scanX);

    raf = requestAnimationFrame(frame);
  };

  const onVisibility = () => {
    if (disposed) return;
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      return;
    }
    if (!raf) raf = requestAnimationFrame(frame);
  };
  document.addEventListener("visibilitychange", onVisibility);
  raf = requestAnimationFrame(frame);

  return {
    setStations(stations, _scene, activeId) {
      if (disposed) return;
      laidOut = stations;
      realCount = realStations(stations).length;
      currentActive = activeId;
      const signature = `timeline\n${stations.map((s) => `${s.id}:${s.ordinal}:${s.lane}:${s.added}:${s.removed}`).join("\n")}`;
      const rebuilt = signature !== built;
      if (rebuilt) {
        built = signature;
        clearRoot();
        rebuildRidgeScene(stations);
      }
      paintActiveNodes(activeId);
      follow(false, rebuilt);
    },
    setSize(nextWidth, nextHeight) {
      if (disposed) return;
      hostWidth = Math.max(1, Math.floor(nextWidth));
      hostHeight = Math.max(1, Math.floor(nextHeight));
      renderer.setSize(hostWidth, hostHeight, false);
      composer.setSize(hostWidth, hostHeight);
      camera.aspect = hostWidth / hostHeight;
      camera.updateProjectionMatrix();

      hudCanvas.width = hostWidth * pixelRatio;
      hudCanvas.height = hostHeight * pixelRatio;
      if (hud) hud.scale(pixelRatio, pixelRatio);
    },
    setAutoRotate(enabled) {
      controls.autoRotate = enabled;
      controls.autoRotateSpeed = 1.0;
    },
    resetCamera() {
      follow(true, true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      motionQuery.removeEventListener("change", syncMotion);
      renderer.domElement.removeEventListener("wheel", onWheel, { capture: true });
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      controls.dispose();
      composer.dispose();
      renderPass.dispose();
      bloomPass.dispose();
      outputPass.dispose();
      for (const card of stationCards) {
        card.texture.dispose();
      }
      scene.traverse(disposeObject);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      hudCanvas.remove();
    },
  };
}
