import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Color,
  DoubleSide,
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
  TRANSIT_CAMERA_OFFSET,
  TRANSIT_GATE_GAP,
  TRANSIT_TARGET_Y,
  initialTransitCamera,
  stationWorld,
  transitShardScaleY,
  transitShardX,
  transitZ,
  type ChronicleScene,
  type StationLayoutInput,
} from "./chronicleLayout";
import { stepScrub } from "./chronicleKeys";

const TEAL = 0x2dd4bf;
const GOLD = 0xe8a849;
const BLUE = 0x5b8def;
const RED = 0xf87171;
const FLOOR = 0x0b1c24;
const VOID = 0x070b10;

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
  let laidOut: StationLayoutInput[] = [];
  let nowReady = new Set<string>();
  let realCount = 0;
  let currentActive = "";
  let built = "";
  let gates: InstancedMesh | null = null;
  let shards: InstancedMesh | null = null;
  let nowGate: Mesh | null = null;
  let gateIds: string[] = [];
  let shardIds: string[] = [];
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
    pick.length = 0;
    for (const child of [...root.children]) {
      root.remove(child);
      disposeObject(child);
    }
  };

  const placeLabel = () => {
    if (!hoveredId || !hoverPoint) return;
    const station = laidOut.find((entry) => entry.id === hoveredId);
    if (!station) {
      hideLabel();
      return;
    }
    const world = stationWorld("transit", station, realCount);
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

  const focus = (stations: StationLayoutInput[], activeId: string) => {
    const real = stations.filter((entry) => entry.kind !== "now");
    const count = real.length;
    const active =
      stations.find((entry) => entry.id === activeId) ??
      (activeId.startsWith("now:")
        ? {
            id: activeId,
            ordinal: count,
            lane: 0,
            added: 0,
            removed: 0,
            kind: "now" as const,
            outcome: "ok" as const,
          }
        : undefined);
    const z = active ? stationWorld("transit", active, count).z : count > 0 ? transitZ(count - 1, count) : 0;
    offset.subVectors(camera.position, controls.target);
    if (offset.lengthSq() < 1e-6) {
      offset.set(TRANSIT_CAMERA_OFFSET.x, TRANSIT_CAMERA_OFFSET.y, TRANSIT_CAMERA_OFFSET.z);
    }
    controls.target.set(0, TRANSIT_TARGET_Y, z);
    camera.position.copy(controls.target).add(offset);
    controls.update();
    scan.position.z = z;
  };

  const rebuild = (stations: StationLayoutInput[]) => {
    clearRoot();
    const real = stations.filter((entry) => entry.kind !== "now");
    realCount = real.length;
    if (real.length >= 2) {
      const span = (real.length - 1) * TRANSIT_GATE_GAP;
      const beam = new Mesh(new BoxGeometry(0.045, 0.045, span), new MeshBasicMaterial({ color: TEAL }));
      beam.position.set(0, TRANSIT_TARGET_Y, -span / 2);
      root.add(beam);
    }
    if (real.length > 0) {
      const gateMesh = new InstancedMesh(
        new BoxGeometry(1, 1, 1),
        new MeshBasicMaterial({ color: 0xffffff }),
        real.length,
      );
      const shardMesh = new InstancedMesh(
        new BoxGeometry(1, 1, 1),
        new MeshBasicMaterial({ color: 0xffffff }),
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
      root.add(gateMesh);
      root.add(shardMesh);
      gates = gateMesh;
      shards = shardMesh;
      gateIds = real.map((entry) => entry.id);
      shardIds = real.map((entry) => entry.id);
      pick.push(gateMesh, shardMesh);
    }
  };

  const paintActiveGate = (activeId: string) => {
    if (!gates) return;
    for (let index = 0; index < gateIds.length; index += 1) {
      gates.setColorAt(index, color.set(gateIds[index] === activeId ? GOLD : TEAL));
    }
    if (gates.instanceColor) gates.instanceColor.needsUpdate = true;
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
      nowGate = new Mesh(new BoxGeometry(2.4, 1.6, 0.06), new MeshBasicMaterial({ color: GOLD }));
      root.add(nowGate);
      pick.push(nowGate);
    }
    const world = stationWorld("transit", now, realCount);
    nowGate.position.set(world.x, world.y, world.z);
    nowGate.userData.stationId = now.id;
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const nextId = stepScrub(laidOut, currentActive, (path) => nowReady.has(path), event.deltaY > 0 ? -1 : 1);
    if (!nextId) return;
    currentActive = nextId;
    focus(laidOut, nextId);
    paintActiveGate(nextId);
    hooks.onActiveId(nextId);
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
    let id: string | undefined;
    if (hit.instanceId != null && hit.object === gates) id = gateIds[hit.instanceId];
    else if (hit.instanceId != null && hit.object === shards) id = shardIds[hit.instanceId];
    else if (typeof hit.object.userData.stationId === "string") id = hit.object.userData.stationId;
    hoveredId = id ?? null;
    if (!hoveredId) hideLabel();
  };

  const onPointerLeave = () => hideLabel();

  renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerleave", onPointerLeave);
  motionQuery.addEventListener("change", syncMotion);

  const frame = (now: number) => {
    raf = 0;
    if (disposed || document.hidden) return;
    if (!motionQuery.matches) {
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
      realCount = stations.filter((entry) => entry.kind !== "now").length;
      currentActive = activeId;
      if (scene !== "transit") {
        clearRoot();
        built = "";
        return;
      }
      const signature = stations
        .filter((entry) => entry.kind !== "now")
        .map((entry) =>
          [entry.id, entry.ordinal, entry.lane, entry.added, entry.removed, entry.kind, entry.outcome].join(":"),
        )
        .join("\n");
      if (signature !== built) {
        built = signature;
        rebuild(stations);
      }
      paintActiveGate(activeId);
      syncNow(stations);
      focus(stations, activeId);
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
      renderer.domElement.removeEventListener("wheel", onWheel);
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
