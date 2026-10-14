import {
  ACESFilmicToneMapping,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  GridHelper,
  Group,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
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
  RIDGE_HEIGHT_MAX,
  RIDGE_LANE_Z,
  RIDGE_STEP_X,
  ridgeCellCorners,
  ridgeHeight,
  stationWorld,
  type ChronicleScene,
  type StationLayoutInput,
  type Vec3,
} from "./chronicleLayout";
import { stepScrub } from "./chronicleKeys";

// Cybernetic Sci-Fi Palette
const TEAL = 0x2dd4bf;
const CYAN = 0x38bdf8;
const GOLD = 0xff9a3c;
const RED = 0xf87171;
const FLOOR = 0x050e18;
const VOID = 0x020408;
const RIDGE_LIFT = 0.04;

const RIDGE_LOW = new Color(0x061524);
const RIDGE_MID = new Color(TEAL);
const RIDGE_HIGH = new Color(GOLD);
const RIDGE_PEAK = new Color(RED);
const colorScratch = new Color();

function ridgeColor(height: number, isActiveLane: boolean): [number, number, number] {
  const t = Math.min(1, Math.max(0, height / RIDGE_HEIGHT_MAX));
  if (t < 0.3) {
    colorScratch.copy(RIDGE_LOW).lerp(RIDGE_MID, t / 0.3);
  } else if (t < 0.75) {
    colorScratch.copy(RIDGE_MID).lerp(RIDGE_HIGH, (t - 0.3) / 0.45);
  } else {
    colorScratch.copy(RIDGE_HIGH).lerp(RIDGE_PEAK, (t - 0.75) / 0.25);
  }
  if (isActiveLane) {
    colorScratch.lerp(RIDGE_HIGH, 0.25);
  }
  return [colorScratch.r, colorScratch.g, colorScratch.b];
}

function realStations(stations: StationLayoutInput[]): StationLayoutInput[] {
  return stations.filter((station) => station.kind !== "now");
}

function ridgeCentroid(stations: StationLayoutInput[], count: number): Vec3 {
  const real = realStations(stations);
  if (real.length === 0) return { x: 0, y: 0.5, z: 0 };
  let x = 0;
  let y = 0;
  let z = 0;
  for (const station of real) {
    const point = stationWorld("ridge", station, count);
    x += point.x;
    y += point.y;
    z += point.z;
  }
  return { x: x / real.length, y: y / real.length, z: z / real.length };
}

function ridgeCameraOffset(stations: StationLayoutInput[]): Vec3 {
  let minLane = 0;
  let maxLane = 0;
  let maxOrdinal = 0;
  let any = false;
  for (const station of stations) {
    if (station.kind === "now") continue;
    if (!any) {
      minLane = station.lane;
      maxLane = station.lane;
      maxOrdinal = station.ordinal;
      any = true;
    } else {
      minLane = Math.min(minLane, station.lane);
      maxLane = Math.max(maxLane, station.lane);
      maxOrdinal = Math.max(maxOrdinal, station.ordinal);
    }
  }
  const spanZ = Math.max(1, maxLane - minLane) * RIDGE_LANE_Z;
  const spanX = Math.max(2, maxOrdinal * RIDGE_STEP_X);
  const dist = Math.max(spanZ, spanX * 0.6) * 1.25;
  return { x: 0, y: Math.max(5, dist * 0.55), z: Math.max(6, dist * 0.75) };
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
  controls.maxPolarAngle = Math.PI / 2 - 0.06;
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

  // Subdued neon grid
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
  const projVec = new Vector3();
  const offset = new Vector3();
  const pick: Object3DType[] = [];
  const nodeMeshById = new Map<Object3DType, string>();

  let laidOut: StationLayoutInput[] = [];
  let nowReady = new Set<string>();
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
  let terrainWidth = 10;
  let terrainDepth = 6;
  let maxTerrainChurn = 10;

  // Station diamond nodes
  const nodeDiamonds: { mesh: Mesh; station: StationLayoutInput }[] = [];
  let ridgePaint: { attr: Float32BufferAttribute; lanes: number[]; heights: number[] } | null = null;

  const projectToScreen = (p: { x: number; y: number; z: number }): [number, number] | null => {
    projVec.set(p.x, p.y, p.z).project(camera);
    if (projVec.z > 1.0) return null; // behind camera
    const sx = (projVec.x * 0.5 + 0.5) * hostWidth;
    const sy = (-projVec.y * 0.5 + 0.5) * hostHeight;
    return [sx, sy];
  };

  const clearRoot = () => {
    nodeDiamonds.length = 0;
    ridgePaint = null;
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
      const fallback = ridgeCameraOffset(laidOut);
      offset.set(fallback.x, fallback.y, fallback.z);
    }
    controls.target.set(x, y, z);
    camera.position.copy(controls.target).add(offset);
    controls.update();
  };

  const follow = (fresh: boolean, rebuilt: boolean) => {
    const center = ridgeCentroid(laidOut, realCount);
    const active = resolveActive();
    const point = active ? stationWorld("ridge", active, realCount) : center;
    const path = active?.path ?? (active?.id.startsWith("now:") ? active.id.slice(4) : null);
    if (fresh) {
      const off = ridgeCameraOffset(laidOut);
      controls.target.set(center.x, center.y, center.z);
      camera.position.set(center.x + off.x, center.y + off.y, center.z + off.z);
      controls.update();
      framedPath = path;
      return;
    }
    if (path !== framedPath || rebuilt) {
      placeTarget(point.x, center.y, center.z);
      framedPath = path;
      return;
    }
    placeTarget(point.x, controls.target.y, controls.target.z);
  };

  const nearestStation = (point: Vector3): string | null => {
    let best: string | null = null;
    let bestD = Infinity;
    for (const station of laidOut) {
      const world = stationWorld("ridge", station, realCount);
      const dx = world.x - point.x;
      const dy = world.y - point.y;
      const dz = world.z - point.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = station.id;
      }
    }
    return best;
  };

  const rebuildRidgeScene = (stations: StationLayoutInput[]) => {
    const real = realStations(stations);
    realCount = real.length;

    const byOrdinal = new Map<number, StationLayoutInput>();
    let maxOrdinal = 0;
    let maxLane = 0;
    let maxChurn = 1;
    for (const s of real) {
      byOrdinal.set(s.ordinal, s);
      maxOrdinal = Math.max(maxOrdinal, s.ordinal);
      maxLane = Math.max(maxLane, s.lane);
      maxChurn = Math.max(maxChurn, s.added + s.removed);
    }
    maxTerrainChurn = maxChurn;
    const columns = Math.max(real.length, maxOrdinal + 1);
    const laneCount = maxLane + 1;
    const xCells = Math.max(0, columns - 1);
    const zCells = Math.max(0, laneCount);

    terrainWidth = Math.max(xCells * RIDGE_STEP_X, 2);
    terrainDepth = Math.max(zCells * RIDGE_LANE_Z, 2);

    // Reposition laser scan curtain
    scanPlane.geometry?.dispose();
    scanPlane.geometry = new PlaneGeometry(terrainDepth + 4, 8);

    const heightAt = (ordinal: number, lane: number) => {
      const s = byOrdinal.get(ordinal);
      if (!s || s.lane !== lane) return 0;
      return ridgeHeight(s.added, s.removed);
    };

    const positions: number[] = [];
    const lanes: number[] = [];
    const heights: number[] = [];

    const pushVertex = (vertex: Vec3, lane: number) => {
      positions.push(vertex.x, vertex.y + RIDGE_LIFT, vertex.z);
      lanes.push(lane);
      heights.push(vertex.y);
    };

    for (let i = 0; i < xCells; i += 1) {
      for (let lane = 0; lane < zCells; lane += 1) {
        const cell = ridgeCellCorners(i, lane, heightAt);
        pushVertex(cell.v00, lane);
        pushVertex(cell.v01, lane);
        pushVertex(cell.v11, lane);
        pushVertex(cell.v00, lane);
        pushVertex(cell.v11, lane);
        pushVertex(cell.v10, lane);
      }
    }

    if (positions.length >= 9) {
      // 1. Solid Topographical Terrain with dynamic vertex color shading
      const terrainGeo = new BufferGeometry();
      terrainGeo.setAttribute("position", new Float32BufferAttribute(positions, 3));
      const colorAttr = new Float32BufferAttribute(new Float32Array(lanes.length * 3), 3);
      terrainGeo.setAttribute("color", colorAttr);
      const terrainMat = new MeshBasicMaterial({ vertexColors: true, side: FrontSide });
      const terrainMesh = new Mesh(terrainGeo, terrainMat);
      terrainMesh.userData.surface = true;
      root.add(terrainMesh);
      pick.push(terrainMesh);

      // 2. Holographic Digital Elevation Model (DEM) Wireframe Overlay
      const wireframeMat = new MeshBasicMaterial({
        color: CYAN,
        wireframe: true,
        transparent: true,
        opacity: 0.28,
        side: FrontSide,
      });
      const wireframeMesh = new Mesh(terrainGeo, wireframeMat);
      wireframeMesh.position.y = 0.005; // avoid z-fighting
      root.add(wireframeMesh);

      ridgePaint = { attr: colorAttr, lanes, heights };
    }

    // 3. Station Waypoint Diamond Nodes
    const octGeo = new OctahedronGeometry(0.18, 0);
    for (const station of real) {
      const pt = stationWorld("ridge", station, real.length);
      const mat = new MeshBasicMaterial({
        color: station.id === currentActive ? GOLD : TEAL,
        wireframe: false,
      });
      const nodeMesh = new Mesh(octGeo, mat);
      nodeMesh.position.set(pt.x, pt.y + 0.24, pt.z);
      nodeMesh.userData.stationId = station.id;
      root.add(nodeMesh);
      pick.push(nodeMesh);
      nodeMeshById.set(nodeMesh, station.id);
      nodeDiamonds.push({ mesh: nodeMesh, station });

      // Ground stem / leader ray to terrain peak
      const stemMat = new MeshBasicMaterial({
        color: TEAL,
        transparent: true,
        opacity: 0.45,
      });
      const stem = new Mesh(new CylinderGeometry(0.015, 0.015, 0.24, 6), stemMat);
      stem.position.set(pt.x, pt.y + 0.12, pt.z);
      root.add(stem);
    }
  };

  const paintActiveNodes = (activeId: string) => {
    const activeLane = laidOut.find((s) => s.id === activeId)?.lane ?? -1;
    for (const entry of nodeDiamonds) {
      const isAct = entry.station.id === activeId;
      const mat = entry.mesh.material as MeshBasicMaterial;
      if (mat) {
        mat.color.set(isAct ? GOLD : TEAL);
      }
    }
    if (!ridgePaint) return;
    for (let index = 0; index < ridgePaint.lanes.length; index += 1) {
      const [r, g, b] = ridgeColor(
        ridgePaint.heights[index] ?? 0,
        ridgePaint.lanes[index] === activeLane,
      );
      ridgePaint.attr.setXYZ(index, r, g, b);
    }
    ridgePaint.attr.needsUpdate = true;
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
    else if (hit.object.userData.surface === true) id = nearestStation(hit.point);

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
      hoveredId = null;
      if (!isDown) renderer.domElement.style.cursor = "grab";
      return;
    }
    let id: string | null = null;
    if (typeof hit.object.userData.stationId === "string") id = hit.object.userData.stationId;
    else if (hit.object.userData.surface === true) id = nearestStation(hit.point);
    hoveredId = id;
    if (!isDown) {
      renderer.domElement.style.cursor = hoveredId ? "pointer" : "grab";
    }
  };

  const onPointerLeave = () => {
    isDown = false;
    hoveredId = null;
    renderer.domElement.style.cursor = "grab";
  };

  const stopWheel = (event: WheelEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const onWheel = (event: WheelEvent) => {
    if (!event.shiftKey && laidOut.length > 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const dir = event.deltaY > 0 ? -1 : 1;
      const nextId = stepScrub(laidOut, currentActive, (path) => nowReady.has(path), dir);
      if (!nextId) return;
      currentActive = nextId;
      follow(false, false);
      paintActiveNodes(nextId);
      hooks.onActiveId(nextId);
    }
  };

  renderer.domElement.addEventListener("wheel", onWheel, { passive: false, capture: true });
  renderer.domElement.addEventListener("wheel", stopWheel, { passive: false });
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

    // Crosshairs
    hud.strokeStyle = "rgba(45, 212, 191, 0.25)";
    hud.beginPath();
    hud.moveTo(rcX - rcRad - 4, rcY);
    hud.lineTo(rcX + rcRad + 4, rcY);
    hud.moveTo(rcX, rcY - rcRad - 4);
    hud.lineTo(rcX, rcY + rcRad + 4);
    hud.stroke();

    // Cardinal ticks & labels
    hud.font = "7.5px ui-monospace, SFMono-Regular, Menlo, monospace";
    hud.fillStyle = "rgba(45, 212, 191, 0.75)";
    hud.textAlign = "center";
    hud.fillText("N", rcX, rcY - rcRad + 9);
    hud.fillText("S", rcX, rcY + rcRad - 3);
    hud.textAlign = "left";
    hud.fillText("E", rcX + rcRad - 8, rcY + 3);
    hud.textAlign = "right";
    hud.fillText("W", rcX - rcRad + 8, rcY + 3);

    // Rotating Radar Sweep Beam
    const sweepAngle = (now * 0.002) % (Math.PI * 2);
    hud.strokeStyle = "#ff9a3c";
    hud.lineWidth = 1.5;
    hud.beginPath();
    hud.moveTo(rcX, rcY);
    hud.lineTo(rcX + Math.cos(sweepAngle) * rcRad, rcY + Math.sin(sweepAngle) * rcRad);
    hud.stroke();

    // Radar Tag
    hud.textAlign = "left";
    hud.fillStyle = "rgba(226, 232, 240, 0.5)";
    hud.fillText("RADAR // 360° SWEEP", rcX + rcRad + 12, rcY - 4);
    hud.fillStyle = "#ff9a3c";
    hud.fillText(`BEARING ${((sweepAngle * 180) / Math.PI).toFixed(0)}°`, rcX + rcRad + 12, rcY + 8);
    hud.restore();

    // 2. Churn Altitude Value Ruler (Left Screen Edge)
    const rulerTop = 110;
    const rulerBottom = hostHeight - 75;
    const rulerH = Math.max(10, rulerBottom - rulerTop);

    hud.save();
    hud.strokeStyle = "rgba(45, 212, 191, 0.35)";
    hud.fillStyle = "rgba(226, 232, 240, 0.4)";
    hud.lineWidth = 1;
    hud.beginPath();
    hud.moveTo(18, rulerTop);
    hud.lineTo(18, rulerBottom);

    const steps = 4;
    for (let s = 0; s <= steps; s++) {
      const y = rulerBottom - (s / steps) * rulerH;
      hud.moveTo(18, y);
      hud.lineTo(26, y);
    }
    hud.stroke();

    hud.font = "8px ui-monospace, SFMono-Regular, Menlo, monospace";
    hud.textAlign = "left";
    hud.fillText("CHURN ▲", 14, rulerTop - 8);

    for (let s = 0; s <= steps; s++) {
      const y = rulerBottom - (s / steps) * rulerH;
      const val = Math.round((s / steps) * maxTerrainChurn);
      hud.fillText(`+${val}`, 30, y + 3);
    }

    // Active Altitude Pointer
    const act = resolveActive();
    const actChurn = act ? act.added + act.removed : 0;
    const actFrac = maxTerrainChurn > 0 ? Math.min(1, actChurn / maxTerrainChurn) : 0;
    const curY = rulerBottom - actFrac * rulerH;

    hud.fillStyle = "#ff9a3c";
    hud.beginPath();
    hud.moveTo(18, curY);
    hud.lineTo(10, curY - 4);
    hud.lineTo(10, curY + 4);
    hud.closePath();
    hud.fill();
    hud.restore();

    // 3. File Lane Ground Labels (Z-Axis)
    hud.save();
    hud.font = "8.5px ui-monospace, SFMono-Regular, Menlo, monospace";
    hud.textAlign = "right";
    const uniqueFiles = new Map<number, string>();
    for (const s of laidOut) {
      if (s.path && !uniqueFiles.has(s.lane)) {
        const base = s.path.split(/[/\\]/).pop() || s.path;
        uniqueFiles.set(s.lane, base);
      }
    }
    const actLane = act?.lane ?? -1;
    for (const [lane, fname] of uniqueFiles.entries()) {
      const sp = projectToScreen({ x: -0.8, y: 0, z: lane * RIDGE_LANE_Z });
      if (sp && sp[0] > 0 && sp[0] < hostWidth && sp[1] > 0 && sp[1] < hostHeight) {
        hud.fillStyle = lane === actLane ? "#ff9a3c" : "rgba(45, 212, 191, 0.55)";
        hud.fillText(`[LANE ${lane}] ${fname}`, sp[0] - 8, sp[1]);
        hud.strokeStyle = lane === actLane ? "rgba(255, 154, 60, 0.4)" : "rgba(45, 212, 191, 0.2)";
        hud.beginPath();
        hud.moveTo(sp[0] - 4, sp[1] - 3);
        hud.lineTo(sp[0] + 12, sp[1] - 3);
        hud.stroke();
      }
    }
    hud.restore();

    // 4. Target Reticle on Active Station
    if (act) {
      const pt = stationWorld("ridge", act, realCount);
      const sp = projectToScreen({ x: pt.x, y: pt.y + 0.24, z: pt.z });
      if (sp && sp[0] > 0 && sp[0] < hostWidth && sp[1] > 0 && sp[1] < hostHeight) {
        hud.save();
        const retSize = 15;

        // Target Bracket Corners [ ]
        hud.strokeStyle = "#ff9a3c";
        hud.lineWidth = 1.5;
        hud.beginPath();
        // Top-left
        hud.moveTo(sp[0] - retSize, sp[1] - retSize + 5);
        hud.lineTo(sp[0] - retSize, sp[1] - retSize);
        hud.lineTo(sp[0] - retSize + 5, sp[1] - retSize);
        // Top-right
        hud.moveTo(sp[0] + retSize - 5, sp[1] - retSize);
        hud.lineTo(sp[0] + retSize, sp[1] - retSize);
        hud.lineTo(sp[0] + retSize, sp[1] - retSize + 5);
        // Bottom-left
        hud.moveTo(sp[0] - retSize, sp[1] + retSize - 5);
        hud.lineTo(sp[0] - retSize, sp[1] + retSize);
        hud.lineTo(sp[0] - retSize + 5, sp[1] + retSize);
        // Bottom-right
        hud.moveTo(sp[0] + retSize - 5, sp[1] + retSize);
        hud.lineTo(sp[0] + retSize, sp[1] + retSize);
        hud.lineTo(sp[0] + retSize, sp[1] + retSize - 5);
        hud.stroke();

        // Target Center Dot
        hud.fillStyle = "#ff9a3c";
        hud.beginPath();
        hud.arc(sp[0], sp[1], 2, 0, Math.PI * 2);
        hud.fill();

        // Diagonal Leader Line to Tactical Badge
        const badgeW = 200;
        const badgeH = 46;
        const badgeX = sp[0] + 28 + badgeW > hostWidth - 16 ? sp[0] - badgeW - 28 : sp[0] + 28;
        const badgeY = sp[1] - 40 < 40 ? sp[1] + 20 : sp[1] - 40;

        hud.strokeStyle = "rgba(255, 154, 60, 0.7)";
        hud.lineWidth = 1;
        hud.beginPath();
        hud.moveTo(sp[0] + (badgeX > sp[0] ? retSize : -retSize), sp[1]);
        hud.lineTo(badgeX > sp[0] ? badgeX : badgeX + badgeW, badgeY + badgeH / 2);
        hud.stroke();

        // Tactical HUD Badge Card
        hud.fillStyle = "rgba(6, 10, 16, 0.92)";
        hud.fillRect(badgeX, badgeY, badgeW, badgeH);
        hud.strokeStyle = "rgba(255, 154, 60, 0.65)";
        hud.lineWidth = 1;
        hud.strokeRect(badgeX, badgeY, badgeW, badgeH);

        hud.font = "8.5px ui-monospace, SFMono-Regular, Menlo, monospace";
        hud.fillStyle = "#ff9a3c";
        hud.textAlign = "left";
        const fname = act.path ? act.path.split(/[/\\]/).pop() || act.path : act.id;
        hud.fillText(`[REV #${act.ordinal}] ${fname}`, badgeX + 8, badgeY + 13);

        hud.fillStyle = "rgba(45, 212, 191, 0.95)";
        hud.fillText(`CHURN: +${act.added} −${act.removed} · ${act.outcome.toUpperCase()}`, badgeX + 8, badgeY + 26);

        hud.fillStyle = "rgba(226, 232, 240, 0.6)";
        hud.fillText(`ALTITUDE: ${pt.y.toFixed(2)}m   LANE: ${act.lane}`, badgeX + 8, badgeY + 39);
        hud.restore();
      }
    }

    // 5. Bottom Right Telemetry Stream
    if (hostWidth >= 520) {
      hud.save();
      hud.font = "8px ui-monospace, SFMono-Regular, Menlo, monospace";
      hud.textAlign = "right";
      hud.fillStyle = "rgba(226, 232, 240, 0.45)";
      hud.fillText(
        `SWEEP X: ${scanX.toFixed(1)}   REVS: ${realCount}   MAX CHURN: +${maxTerrainChurn}   60 FPS`,
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
    const scanPeriod = Math.max(terrainWidth * 250, 3000);
    const scanProgress = (now % scanPeriod) / scanPeriod;
    const scanX = scanProgress * (terrainWidth + 2) - 1;
    scanPlane.position.x = scanX;
    scanPlane.position.z = terrainDepth / 2;
    scanMat.opacity = 0.16 + 0.12 * Math.sin(now * 0.004);

    // 2. Animate Diamond Nodes (Spinning in air)
    for (const entry of nodeDiamonds) {
      entry.mesh.rotation.y = now * 0.0015 + entry.station.ordinal * 0.2;
    }

    // 3. Telemetry Landmark Beacon tracking and sonar animation
    const act = resolveActive();
    if (act) {
      const worldPos = stationWorld("ridge", act, realCount);
      beaconGroup.position.set(worldPos.x, worldPos.y, worldPos.z);
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
    setStations(stations, _scene, activeId, nowPaths = []) {
      if (disposed) return;
      laidOut = stations;
      nowReady = new Set(nowPaths);
      realCount = realStations(stations).length;
      currentActive = activeId;
      const signature = `ridge\n${stations.map((s) => `${s.id}:${s.ordinal}:${s.lane}:${s.added}:${s.removed}`).join("\n")}`;
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
      renderer.domElement.removeEventListener("wheel", stopWheel);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      controls.dispose();
      composer.dispose();
      renderPass.dispose();
      bloomPass.dispose();
      outputPass.dispose();
      scene.traverse(disposeObject);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      hudCanvas.remove();
    },
  };
}
