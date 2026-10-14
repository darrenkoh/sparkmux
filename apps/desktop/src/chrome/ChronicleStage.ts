import {
  ACESFilmicToneMapping,
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  GridHelper,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
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
  HELIX_R,
  RIDGE_HEIGHT_MAX,
  RIDGE_LANE_Z,
  RIVER_STEP_X,
  TRANSIT_CAMERA_OFFSET,
  TRANSIT_GATE_GAP,
  TRANSIT_TARGET_Y,
  initialTransitCamera,
  ridgeCellCorners,
  ridgeHeight,
  riverPoint,
  stationWorld,
  transitShardScaleY,
  transitShardX,
  transitZ,
  type ChronicleScene,
  type StationLayoutInput,
  type Vec3,
} from "./chronicleLayout";
import { stepScrub } from "./chronicleKeys";

const TEAL = 0x2dd4bf;
const GOLD = 0xe8a849;
const BLUE = 0x5b8def;
const RED = 0xf87171;
const VIOLET = 0xc084fc;
const FLOOR = 0x0b1c24;
const VOID = 0x070b10;
const RIVER_BASE_Y = 0.02;
// Valleys sit just above the floor so FrontSide does not z-fight it. Winding is unchanged.
const RIDGE_LIFT = 0.04;
const RIVER_OFFSET = { x: 0, y: 8, z: 10 };
const HELIX_OFFSET = { x: HELIX_R + 6, y: 0.4, z: HELIX_R + 6 };

const RIDGE_LOW = new Color(FLOOR);
const RIDGE_MID = new Color(TEAL);
const RIDGE_HIGH = new Color(GOLD);
const ridgeScratch = new Color();

function ridgeChannels(height: number, active: boolean): [number, number, number] {
  const t = Math.min(1, Math.max(0, height / RIDGE_HEIGHT_MAX));
  if (t < 0.5) ridgeScratch.copy(RIDGE_LOW).lerp(RIDGE_MID, t / 0.5);
  else ridgeScratch.copy(RIDGE_MID).lerp(RIDGE_HIGH, (t - 0.5) / 0.5);
  if (active) ridgeScratch.lerp(RIDGE_HIGH, 0.3);
  return [ridgeScratch.r, ridgeScratch.g, ridgeScratch.b];
}

function realStations(stations: StationLayoutInput[]): StationLayoutInput[] {
  return stations.filter((station) => station.kind !== "now");
}

function centroid(scene: ChronicleScene, stations: StationLayoutInput[], count: number): Vec3 {
  const real = realStations(stations);
  if (real.length === 0) return { x: 0, y: 0.5, z: 0 };
  let x = 0;
  let y = 0;
  let z = 0;
  for (const station of real) {
    const point = stationWorld(scene, station, count);
    x += point.x;
    y += point.y;
    z += point.z;
  }
  return { x: x / real.length, y: y / real.length, z: z / real.length };
}

function ridgeCameraOffset(stations: StationLayoutInput[]): Vec3 {
  let minLane = 0;
  let maxLane = 0;
  let any = false;
  for (const station of stations) {
    if (station.kind === "now") continue;
    if (!any) {
      minLane = station.lane;
      maxLane = station.lane;
      any = true;
    } else {
      minLane = Math.min(minLane, station.lane);
      maxLane = Math.max(maxLane, station.lane);
    }
  }
  // A zero z offset looks straight down -y, so camera.up would not define screen-right.
  const span = Math.max(1, maxLane - minLane) * RIDGE_LANE_Z;
  return { x: 0, y: 6, z: span * 0.8 };
}

function pushTri(
  dst: number[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
) {
  dst.push(ax, ay, az, bx, by, bz, cx, cy, cz);
}

// Vertical fin. Width-by-churn is y; there is no horizontal thickness.
// +z faces the default camera (offset +z). The swapped triple is the other bank after an orbit.
// Material stays FrontSide — the second pair is a real face, not DoubleSide.
function pushRiverFin(dst: number[], x0: number, y0: number, x1: number, y1: number, z: number) {
  const top0 = Math.max(y0, RIVER_BASE_Y);
  const top1 = Math.max(y1, RIVER_BASE_Y);
  if (top0 <= RIVER_BASE_Y + 1e-6 && top1 <= RIVER_BASE_Y + 1e-6) return;
  pushTri(dst, x0, RIVER_BASE_Y, z, x1, RIVER_BASE_Y, z, x1, top1, z);
  pushTri(dst, x0, RIVER_BASE_Y, z, x1, top1, z, x0, top0, z);
  pushTri(dst, x0, RIVER_BASE_Y, z, x1, top1, z, x1, RIVER_BASE_Y, z);
  pushTri(dst, x0, RIVER_BASE_Y, z, x0, top0, z, x1, top1, z);
}

function signatureOf(scene: ChronicleScene, stations: StationLayoutInput[]): string {
  const nowOn = stations.some((station) => station.kind === "now") ? "1" : "0";
  return `${scene}\n${nowOn}\n${realStations(stations)
    .map((station) =>
      [station.id, station.ordinal, station.lane, station.added, station.removed, station.kind, station.outcome].join(
        ":",
      ),
    )
    .join("\n")}`;
}

function nowBox(scene: ChronicleScene): BoxGeometry {
  if (scene === "transit") return new BoxGeometry(2.4, 1.6, 0.06);
  if (scene === "helix") return new BoxGeometry(1, 1, 1);
  return new BoxGeometry(0.22, 0.22, 0.22);
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

function labelText(station: StationLayoutInput): string {
  const path = station.path ?? "";
  const base = path.split(/[/\\]/).pop() || path || station.id;
  if (station.kind === "now") return `${base}\nNow`;
  const preview = station.preview ?? "";
  const counts = `+${station.added} −${station.removed}`;
  return preview ? `${base}\n${counts}\n${preview}` : `${base}\n${counts}`;
}

export function mountChronicle(host: HTMLElement, hooks: ChronicleHooks): ChronicleHandle {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
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
  host.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(VOID);
  const camera = new PerspectiveCamera(50, 1, 0.1, 500);
  camera.up.set(0, 1, 0);
  const initial = initialTransitCamera(0);
  camera.position.set(initial.camera.x, initial.camera.y, initial.camera.z);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(initial.target.x, initial.target.y, initial.target.z);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.dampingFactor = 0.08;
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const syncMotion = () => {
    controls.enableDamping = !motionQuery.matches;
  };
  syncMotion();
  controls.update();

  const width = Math.max(1, host.clientWidth);
  const height = Math.max(1, host.clientHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  const bloomPass = new UnrealBloomPass(new Vector2(width, height), 0.35, 0.4, 0.85);
  const outputPass = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);

  const floor = new Mesh(new PlaneGeometry(8000, 8000), new MeshBasicMaterial({ color: FLOOR }));
  // rotation.x = -PI/2 sends the plane's +z normal to world +y. No rotation.y.
  floor.rotation.x = FLOOR_ROTATION_X;
  floor.position.set(0, 0, -1600);
  scene.add(floor);

  const grid = new GridHelper(4000, 100, TEAL, TEAL);
  grid.position.y = 0.02;
  const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
  for (const material of gridMaterials) {
    material.transparent = true;
    material.opacity = 0.16;
  }
  scene.add(grid);

  // Seen from both sides on purpose. The only DoubleSide surface.
  const scanMaterial = new MeshBasicMaterial({
    color: GOLD,
    side: DoubleSide,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  });
  const scan = new Mesh(new PlaneGeometry(6.5, 3.2), scanMaterial);
  scan.position.set(0, TRANSIT_TARGET_Y, 0);
  scene.add(scan);

  const root = new Group();
  scene.add(root);

  const label = document.createElement("div");
  label.className = "chronicle-hover";
  label.hidden = true;
  host.appendChild(label);

  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const offset = new Vector3();
  const dummy = new Object3D();
  const color = new Color();
  let hoverPoint: Vector3 | null = new Vector3();
  const localZ = new Vector3(0, 0, 1);
  const radial = new Vector3();
  let laidOut: StationLayoutInput[] = [];
  let nowReady = new Set<string>();
  let realCount = 0;
  let currentActive = "";
  let currentScene: ChronicleScene = "transit";
  let posedScene: ChronicleScene | "" = "";
  // File the camera last framed. A new path takes the whole station point; the same file only slides x.
  let framedPath: string | null = null;
  let built = "";
  let gates: InstancedMesh | null = null;
  let shards: InstancedMesh | null = null;
  let nowGate: Mesh | null = null;
  let gateIds: string[] = [];
  let shardIds: string[] = [];
  let riverLanes: { lane: number; material: MeshBasicMaterial }[] = [];
  let ridgePaint: { attr: Float32BufferAttribute; lanes: number[]; heights: number[] } | null = null;
  const idsByMesh = new Map<Object3DType, string[]>();
  const pick: Object3DType[] = [];
  let hoveredId: string | null = null;
  let directFrames = 0;
  let raf = 0;
  let disposed = false;

  const hideLabel = () => {
    hoveredId = null;
    label.hidden = true;
    label.textContent = "";
    delete label.dataset.stationId;
  };

  const clearRoot = () => {
    gates = null;
    shards = null;
    nowGate = null;
    gateIds = [];
    shardIds = [];
    riverLanes = [];
    ridgePaint = null;
    idsByMesh.clear();
    pick.length = 0;
    for (const child of [...root.children]) {
      root.remove(child);
      child.traverse(disposeObject);
    }
  };

  const placeLabel = () => {
    if (!hoveredId || !hoverPoint) return;
    const station = laidOut.find((entry) => entry.id === hoveredId);
    if (!station) {
      hideLabel();
      return;
    }
    const world = stationWorld(currentScene, station, realCount);
    hoverPoint.set(world.x, world.y, world.z).project(camera);
    const rect = host.getBoundingClientRect();
    label.style.left = `${(hoverPoint.x * 0.5 + 0.5) * rect.width}px`;
    label.style.top = `${(-hoverPoint.y * 0.5 + 0.5) * rect.height}px`;
    if (label.dataset.stationId !== station.id) {
      label.dataset.stationId = station.id;
      label.textContent = labelText(station);
      label.hidden = false;
    }
  };

  const track = (mesh: Object3DType, ids?: string[]) => {
    root.add(mesh);
    pick.push(mesh);
    if (ids) idsByMesh.set(mesh, ids);
  };

  const resolveActive = (): StationLayoutInput | undefined => {
    const found = laidOut.find((station) => station.id === currentActive);
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

  const applyLimits = (scene: ChronicleScene) => {
    controls.enablePan = false;
    controls.minAzimuthAngle = -Infinity;
    controls.maxAzimuthAngle = Infinity;
    controls.minDistance = 0;
    controls.maxDistance = Infinity;
    camera.up.set(0, 1, 0);
    if (scene === "helix") {
      controls.enableZoom = true;
      controls.minPolarAngle = 0.15;
      controls.maxPolarAngle = Math.PI - 0.15;
      controls.minDistance = 1.6;
      controls.maxDistance = 80;
      return;
    }
    controls.enableZoom = false;
    if (scene === "transit") {
      controls.minPolarAngle = 0.15;
      controls.maxPolarAngle = Math.PI / 2 - 0.05;
      return;
    }
    controls.minPolarAngle = 0.12;
    controls.maxPolarAngle = Math.PI / 2 - 0.08;
  };

  // Read the orbit off the camera, then write the target. No yaw variable.
  const placeTarget = (x: number, y: number, z: number) => {
    offset.subVectors(camera.position, controls.target);
    if (offset.lengthSq() < 1e-8) {
      const fallback =
        currentScene === "helix"
          ? HELIX_OFFSET
          : currentScene === "ridge"
            ? ridgeCameraOffset(laidOut)
            : currentScene === "rivers"
              ? RIVER_OFFSET
              : TRANSIT_CAMERA_OFFSET;
      offset.set(fallback.x, fallback.y, fallback.z);
    }
    controls.target.set(x, y, z);
    camera.position.copy(controls.target).add(offset);
    controls.update();
  };

  const slideCamera = (x: number) => {
    placeTarget(x, controls.target.y, controls.target.z);
  };

  const follow = (fresh: boolean, rebuilt: boolean) => {
    scan.visible = currentScene === "transit";
    grid.visible = currentScene !== "ridge";
    if (fresh) applyLimits(currentScene);
    const active = resolveActive();
    if (currentScene === "transit") {
      const z = active
        ? stationWorld("transit", active, realCount).z
        : realCount > 0
          ? transitZ(realCount - 1, realCount)
          : 0;
      if (fresh) {
        const placed = initialTransitCamera(z);
        controls.target.set(placed.target.x, placed.target.y, placed.target.z);
        camera.position.set(placed.camera.x, placed.camera.y, placed.camera.z);
        controls.update();
      } else {
        placeTarget(0, TRANSIT_TARGET_Y, z);
      }
      scan.position.z = z;
      return;
    }
    if (currentScene === "helix") {
      const y = active ? stationWorld("helix", active, realCount).y : 0;
      if (fresh) {
        controls.target.set(0, y, 0);
        camera.position.set(HELIX_OFFSET.x, y + HELIX_OFFSET.y, HELIX_OFFSET.z);
        controls.update();
      } else {
        placeTarget(0, y, 0);
      }
      return;
    }
    const center = centroid(currentScene, laidOut, realCount);
    const point = active ? stationWorld(currentScene, active, realCount) : center;
    const path = active?.path ?? (active?.id.startsWith("now:") ? active.id.slice(4) : null);
    if (fresh) {
      const off = currentScene === "rivers" ? RIVER_OFFSET : ridgeCameraOffset(laidOut);
      controls.target.set(center.x, center.y, center.z);
      camera.position.set(center.x + off.x, center.y + off.y, center.z + off.z);
      controls.update();
      framedPath = path;
      return;
    }
    if (path !== framedPath) {
      placeTarget(point.x, point.y, point.z);
      framedPath = path;
      return;
    }
    if (rebuilt) {
      // A poll must not drop the station the hologram is showing.
      placeTarget(point.x, center.y, center.z);
      return;
    }
    slideCamera(point.x);
  };

  const addStationShards = (
    geometry: BufferGeometry,
    stations: StationLayoutInput[],
    place: (station: StationLayoutInput) => void,
  ) => {
    if (stations.length === 0) return;
    const mesh = new InstancedMesh(
      geometry,
      new MeshBasicMaterial({ color: 0xffffff, side: FrontSide }),
      stations.length,
    );
    stations.forEach((station, index) => {
      place(station);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    shards = mesh;
    shardIds = stations.map((station) => station.id);
    track(mesh, shardIds);
  };

  const rebuildTransit = (stations: StationLayoutInput[]) => {
    const real = realStations(stations);
    realCount = real.length;
    if (real.length >= 2) {
      const span = (real.length - 1) * TRANSIT_GATE_GAP;
      const beam = new Mesh(
        new BoxGeometry(0.045, 0.045, span),
        new MeshBasicMaterial({ color: TEAL, side: FrontSide }),
      );
      beam.position.set(0, TRANSIT_TARGET_Y, -span / 2);
      root.add(beam);
    }
    if (real.length === 0) return;
    const gateMesh = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshBasicMaterial({ color: 0xffffff, side: FrontSide }),
      real.length,
    );
    const shardMesh = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshBasicMaterial({ color: 0xffffff, side: FrontSide }),
      real.length,
    );
    real.forEach((entry, index) => {
      const z = transitZ(entry.ordinal, real.length);
      dummy.position.set(0, TRANSIT_TARGET_Y, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(2.4, 1.6, 0.06);
      dummy.updateMatrix();
      gateMesh.setMatrixAt(index, dummy.matrix);
      gateMesh.setColorAt(index, color.set(entry.id === currentActive ? GOLD : TEAL));

      dummy.position.set(transitShardX(entry.lane), TRANSIT_TARGET_Y, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(0.35, transitShardScaleY(entry), 0.08);
      dummy.updateMatrix();
      shardMesh.setMatrixAt(index, dummy.matrix);
      const shardColor =
        entry.outcome === "error" || entry.kind === "delete" ? RED : entry.kind === "write" ? BLUE : TEAL;
      shardMesh.setColorAt(index, color.set(shardColor));
    });
    gateMesh.instanceMatrix.needsUpdate = true;
    shardMesh.instanceMatrix.needsUpdate = true;
    if (gateMesh.instanceColor) gateMesh.instanceColor.needsUpdate = true;
    if (shardMesh.instanceColor) shardMesh.instanceColor.needsUpdate = true;
    gates = gateMesh;
    shards = shardMesh;
    gateIds = real.map((entry) => entry.id);
    shardIds = real.map((entry) => entry.id);
    track(gateMesh, gateIds);
    track(shardMesh, shardIds);
  };

  const rebuildRivers = (stations: StationLayoutInput[]) => {
    const real = realStations(stations);
    realCount = real.length;
    const lanes = [...new Set(real.map((station) => station.lane))].sort((a, b) => a - b);
    for (const lane of lanes) {
      const z = riverPoint(0, lane, 0, 0).z;
      if (realCount >= 2) {
        const width = (realCount - 1) * RIVER_STEP_X;
        const baseline = new Mesh(
          new BoxGeometry(Math.max(width, 0.2), 0.012, 0.03),
          new MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0.28, side: FrontSide }),
        );
        baseline.position.set(width / 2, RIVER_BASE_Y, z);
        root.add(baseline);
      }
      const positions: number[] = [];
      const onLane = new Map<number, StationLayoutInput>();
      for (const station of real) {
        if (station.lane === lane) onLane.set(station.ordinal, station);
      }
      if (realCount >= 2) {
        for (let ordinal = 0; ordinal < realCount - 1; ordinal += 1) {
          const left = onLane.get(ordinal);
          const right = onLane.get(ordinal + 1);
          const y0 = left ? riverPoint(left.ordinal, left.lane, left.added, left.removed).y : RIVER_BASE_Y;
          const y1 = right ? riverPoint(right.ordinal, right.lane, right.added, right.removed).y : RIVER_BASE_Y;
          pushRiverFin(positions, ordinal * RIVER_STEP_X, y0, (ordinal + 1) * RIVER_STEP_X, y1, z);
        }
      } else {
        const station = onLane.values().next().value;
        if (station) {
          const point = riverPoint(station.ordinal, station.lane, station.added, station.removed);
          pushRiverFin(positions, point.x - 0.18, point.y, point.x + 0.18, point.y, point.z);
        }
      }
      if (positions.length < 9) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
      const material = new MeshBasicMaterial({ color: TEAL, side: FrontSide });
      const mesh = new Mesh(geometry, material);
      mesh.userData.surface = true;
      riverLanes.push({ lane, material });
      track(mesh);
    }
    addStationShards(new BoxGeometry(0.14, 0.14, 0.14), real, (station) => {
      const point = stationWorld("rivers", station, real.length);
      dummy.position.set(point.x, point.y, point.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
    });
  };

  const rebuildHelix = (stations: StationLayoutInput[]) => {
    const real = realStations(stations);
    realCount = real.length;
    let top = 0;
    for (const station of stations) top = Math.max(top, stationWorld("helix", station, realCount).y);
    if (top > 0.01) {
      const tube = new Mesh(
        new CylinderGeometry(0.04, 0.04, top, 12),
        new MeshBasicMaterial({ color: VIOLET, side: FrontSide }),
      );
      tube.position.set(0, top / 2, 0);
      root.add(tube);
    }
    addStationShards(new BoxGeometry(1, 1, 1), real, (station) => {
      const point = stationWorld("helix", station, real.length);
      // Local +z points outward. At ordinal 0 the radial is (0,0,1), so the quaternion is identity.
      radial.set(point.x / HELIX_R, 0, point.z / HELIX_R);
      dummy.position.set(point.x, point.y, point.z);
      dummy.quaternion.setFromUnitVectors(localZ, radial);
      dummy.scale.set(0.34, transitShardScaleY(station), 0.55);
    });
  };

  const rebuildRidge = (stations: StationLayoutInput[]) => {
    const real = realStations(stations);
    realCount = real.length;
    const byOrdinal = new Map<number, StationLayoutInput>();
    let maxOrdinal = -1;
    let maxLane = -1;
    for (const station of real) {
      byOrdinal.set(station.ordinal, station);
      maxOrdinal = Math.max(maxOrdinal, station.ordinal);
      maxLane = Math.max(maxLane, station.lane);
    }
    const columns = Math.max(real.length, maxOrdinal + 1);
    const laneCount = maxLane + 1;
    const xCells = Math.max(0, columns - 1);
    // Each lane owns the strip that starts on its row, including a one-file session.
    // The row past the last file is a valley (height 0), not another station.
    const zCells = Math.max(0, laneCount);
    const heightAt = (ordinal: number, lane: number) => {
      const station = byOrdinal.get(ordinal);
      if (!station || station.lane !== lane) return 0;
      return ridgeHeight(station.added, station.removed);
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
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
      const attr = new Float32BufferAttribute(new Float32Array(lanes.length * 3), 3);
      geometry.setAttribute("color", attr);
      const material = new MeshBasicMaterial({ color: 0xffffff, vertexColors: true, side: FrontSide });
      const mesh = new Mesh(geometry, material);
      mesh.userData.surface = true;
      ridgePaint = { attr, lanes, heights };
      track(mesh);
    }
    addStationShards(new BoxGeometry(0.16, 0.16, 0.16), real, (station) => {
      const point = stationWorld("ridge", station, real.length);
      dummy.position.set(point.x, point.y + 0.12, point.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
    });
  };

  const paintActive = (activeId: string) => {
    if (gates) {
      for (let index = 0; index < gateIds.length; index += 1) {
        gates.setColorAt(index, color.set(gateIds[index] === activeId ? GOLD : TEAL));
      }
      if (gates.instanceColor) gates.instanceColor.needsUpdate = true;
    }
    if (shards) {
      for (let index = 0; index < shardIds.length; index += 1) {
        const station = laidOut.find((entry) => entry.id === shardIds[index]);
        if (!station) continue;
        const hex =
          currentScene !== "transit" && station.id === activeId
            ? GOLD
            : station.outcome === "error" || station.kind === "delete"
              ? RED
              : station.kind === "write"
                ? BLUE
                : TEAL;
        shards.setColorAt(index, color.set(hex));
      }
      if (shards.instanceColor) shards.instanceColor.needsUpdate = true;
    }
    const activeLane = laidOut.find((entry) => entry.id === activeId)?.lane ?? -1;
    for (const entry of riverLanes) entry.material.color.set(entry.lane === activeLane ? GOLD : TEAL);
    if (!ridgePaint) return;
    for (let index = 0; index < ridgePaint.lanes.length; index += 1) {
      const [r, g, b] = ridgeChannels(ridgePaint.heights[index] ?? 0, ridgePaint.lanes[index] === activeLane);
      ridgePaint.attr.setXYZ(index, r, g, b);
    }
    ridgePaint.attr.needsUpdate = true;
  };

  const syncNow = (stations: StationLayoutInput[]) => {
    const now = stations.find((entry) => entry.kind === "now");
    if (!now) {
      if (!nowGate) return;
      root.remove(nowGate);
      const index = pick.indexOf(nowGate);
      if (index >= 0) pick.splice(index, 1);
      disposeObject(nowGate);
      nowGate = null;
      return;
    }
    if (!nowGate) {
      nowGate = new Mesh(nowBox(currentScene), new MeshBasicMaterial({ color: GOLD, side: FrontSide }));
      root.add(nowGate);
      pick.push(nowGate);
    }
    const world = stationWorld(currentScene, now, realCount);
    nowGate.position.set(world.x, world.y, world.z);
    nowGate.userData.stationId = now.id;
    if (currentScene === "helix") {
      radial.set(world.x / HELIX_R, 0, world.z / HELIX_R);
      nowGate.quaternion.setFromUnitVectors(localZ, radial);
      nowGate.scale.set(0.34, 0.2, 0.55);
    } else {
      nowGate.rotation.set(0, 0, 0);
      nowGate.scale.set(1, 1, 1);
    }
  };

  const stopWheel = (event: WheelEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  // Capture so a scrub can stopImmediate before OrbitControls dollies.
  // Helix without shift returns without stopping, and the bubble listener still zooms.
  const onWheel = (event: WheelEvent) => {
    if (currentScene === "helix" && !event.shiftKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const dir = event.deltaY > 0 ? -1 : 1;
    const delta = currentScene === "helix" ? dir * 4 : dir;
    const nextId = stepScrub(laidOut, currentActive, (path) => nowReady.has(path), delta);
    if (!nextId) return;
    currentActive = nextId;
    follow(false, false);
    paintActive(nextId);
    hooks.onActiveId(nextId);
  };

  const nearestStation = (point: Vector3): string | null => {
    let best: string | null = null;
    let bestD = Infinity;
    for (const station of laidOut) {
      const world = stationWorld(currentScene, station, realCount);
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

  const onPointerMove = (event: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(pick, false)[0];
    if (!hit) {
      hideLabel();
      return;
    }
    let id: string | null = null;
    if (typeof hit.object.userData.stationId === "string") id = hit.object.userData.stationId;
    else if (hit.instanceId != null) id = idsByMesh.get(hit.object)?.[hit.instanceId] ?? null;
    else if (hit.object.userData.surface === true) id = nearestStation(hit.point);
    hoveredId = id;
    if (!hoveredId) hideLabel();
  };

  const onPointerLeave = () => hideLabel();

  renderer.domElement.addEventListener("wheel", onWheel, { passive: false, capture: true });
  renderer.domElement.addEventListener("wheel", stopWheel, { passive: false });
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerleave", onPointerLeave);
  motionQuery.addEventListener("change", syncMotion);

  const frame = (now: number) => {
    raf = 0;
    if (disposed || document.hidden) return;
    if (currentScene === "transit" && !motionQuery.matches) {
      // Opacity pulse only. Not a camera or shard heading.
      scanMaterial.opacity = 0.12 + 0.08 * (0.5 + 0.5 * Math.sin(now / 700));
    } else {
      scanMaterial.opacity = 0.16;
    }
    if (controls.enableDamping) controls.update();
    placeLabel();
    const started = performance.now();
    if (motionQuery.matches || directFrames > 0) {
      renderer.render(scene, camera);
      if (directFrames > 0) directFrames -= 1;
    } else {
      composer.render();
    }
    if (performance.now() - started > 20) directFrames = 120;
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
    setStations(stations, scene, activeId, nowPaths = []) {
      if (disposed) return;
      laidOut = stations;
      nowReady = new Set(nowPaths);
      realCount = realStations(stations).length;
      currentActive = activeId;
      const sceneChanged = posedScene !== scene;
      currentScene = scene;
      const signature = signatureOf(scene, stations);
      const rebuilt = signature !== built;
      if (rebuilt) {
        built = signature;
        clearRoot();
        if (scene === "transit") rebuildTransit(stations);
        else if (scene === "rivers") rebuildRivers(stations);
        else if (scene === "helix") rebuildHelix(stations);
        else rebuildRidge(stations);
      }
      paintActive(activeId);
      syncNow(stations);
      follow(sceneChanged, rebuilt && !sceneChanged);
      if (sceneChanged) posedScene = scene;
    },
    setSize(nextWidth, nextHeight) {
      if (disposed) return;
      const w = Math.max(1, Math.floor(nextWidth));
      const h = Math.max(1, Math.floor(nextHeight));
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      motionQuery.removeEventListener("change", syncMotion);
      renderer.domElement.removeEventListener("wheel", onWheel, { capture: true });
      renderer.domElement.removeEventListener("wheel", stopWheel);
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
      label.remove();
      hoverPoint = null;
    },
  };
}
