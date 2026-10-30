import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  MeshStandardMaterial,
  OrthographicCamera,
  PCFSoftShadowMap,
  PointLight,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import {
  buildOfficeRoom,
  createScreens,
  disposeObject,
  disposeSharedMaterials,
  sharedMaterials,
  type RoomBuild,
} from "./officeAssets.ts";
import { createAvatar, disposeMarkerTextures, yawToward, type AvatarRig } from "./officeAvatar.ts";
import { routeBetween, windowAnchors, zoneAnchors, type OfficeLayout } from "./officeLayout.ts";
import { fnv1a } from "./officeModel.ts";
import type { OfficeMarker, Pose, TimeOfDay, Zone } from "./officeTypes.ts";

export interface StageAgent {
  key: string;
  name: string;
  color: number;
  accent: number;
  pose: Pose;
  zone: Zone;
  marker: OfficeMarker;
  deskKey: string;
  ask: string;
  state: string;
}

export interface OfficeHooks {
  onPick(key: string | null): void;
  onHover(key: string | null, screen: { x: number; y: number } | null): void;
}

export interface OfficeHandle {
  update(next: { layout: OfficeLayout; agents: StageAgent[]; kpi?: number }): void;
  setTimeOfDay(tod: TimeOfDay): void;
  setGlow(enabled: boolean): void;
  focus(key: string | null): void;
  /** Team-list hover. Lights the ring and does not move the camera. */
  highlight(key: string | null): void;
  resize(): void;
  setPaused(paused: boolean): void;
  dispose(): void;
}

interface Walker {
  rig: AvatarRig;
  key: string;
  x: number;
  z: number;
  path: [number, number][];
  pose: Pose;
  marker: OfficeMarker;
  ask: string;
  name: string;
  state: string;
  leaving: boolean;
  intern: boolean;
}

const DOOR = { x: 0.9, z: 0 };
const SPEED = 1.4;

export function mountOffice(host: HTMLElement, hooks: OfficeHooks): OfficeHandle {
  const renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.display = "block";
  host.appendChild(renderer.domElement);

  const labels = document.createElement("div");
  labels.className = "office-labels";
  host.appendChild(labels);

  const scene = new Scene();
  scene.background = new Color(0x0b1220);
  const camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
  camera.position.set(40, 34, 40);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enableRotate = true;
  controls.screenSpacePanning = true;
  controls.minPolarAngle = 0.6;
  controls.maxPolarAngle = 1.1;
  controls.minAzimuthAngle = Math.PI / 4 - (60 * Math.PI) / 180;
  controls.maxAzimuthAngle = Math.PI / 4 + (60 * Math.PI) / 180;
  controls.minZoom = 0.6;
  controls.maxZoom = 3;
  controls.target.set(8, 0, 6);

  const hemi = new HemisphereLight(0xbfd8ff, 0x3a2a1a, 0.6);
  const ambient = new AmbientLight(0xffffff, 0.15);
  const sun = new DirectionalLight(0xfff4e0, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;
  scene.add(hemi, ambient, sun, sun.target);

  const lamps: PointLight[] = [];
  for (let index = 0; index < 4; index += 1) {
    const lamp = new PointLight(0xffd7a1, 0, 8);
    lamp.castShadow = false;
    lamp.visible = false;
    lamps.push(lamp);
    scene.add(lamp);
  }

  const screens = createScreens();
  const keep = new Set<Material>([...screens.shared, ...sharedMaterials()]);
  let room: RoomBuild | null = null;
  let layout: OfficeLayout | null = null;
  const walkers = new Map<string, Walker>();
  let intern: Walker | null = null;
  const labelNodes = new Map<string, HTMLDivElement>();
  let paused = false;
  let hidden = document.hidden;
  let offscreen = false;
  let glow = false;
  let tod: TimeOfDay = "now";
  let focusKey: string | null = null;
  let pointerHighlight: string | null = null;
  let listHighlight: string | null = null;
  let userGrab = false;
  let lastFrame = 0;
  let labelTick = 0;
  let hoverTick = 0;
  let shadowTick = 0;
  let screenTick = 0;
  let clockTick = 0;
  let raf = 0;
  let running = true;
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let composer: EffectComposer | null = null;
  let bloom: UnrealBloomPass | null = null;

  const fitCamera = () => {
    if (!layout) return;
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const aspect = width / height;
    const diag = Math.hypot(layout.room.w, layout.room.d) * 0.55;
    camera.top = diag;
    camera.bottom = -diag;
    camera.left = -diag * aspect;
    camera.right = diag * aspect;
    camera.zoom = MathUtils.clamp(camera.zoom, 0.6, 3);
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    composer?.setSize(width, height);
    const range = Math.max(layout.room.w, layout.room.d);
    sun.shadow.camera.left = -range;
    sun.shadow.camera.right = range;
    sun.shadow.camera.top = range;
    sun.shadow.camera.bottom = -range;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = range * 4;
    sun.shadow.camera.updateProjectionMatrix();
  };

  const placeSun = (elevDeg: number) => {
    if (!layout) return;
    const elev = (elevDeg * Math.PI) / 180;
    const dist = 40;
    const cx = layout.room.w / 2;
    const cz = layout.room.d / 2;
    sun.position.set(cx + Math.cos(elev) * dist, Math.sin(elev) * dist + 8, cz + 10);
    sun.target.position.set(cx, 0, cz);
  };

  const applyTod = (mode: TimeOfDay, now: number) => {
    const preset = mode === "now" ? todFromHour(new Date(now).getHours()) : mode;
    const goal = TOD[preset];
    sun.color.lerp(new Color(goal.sun), 1);
    sun.intensity = goal.intensity;
    hemi.intensity = goal.hemi;
    placeSun(goal.elev);
    for (const lamp of lamps) {
      lamp.visible = preset === "night";
      lamp.intensity = preset === "night" ? 1.6 : 0;
    }
    if (glow && preset === "night" && !composer) {
      composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      const pass = new UnrealBloomPass(new Vector2(host.clientWidth, host.clientHeight), 0.6, 0.4, 0.85);
      bloom = pass;
      composer.addPass(pass);
    }
    if (!(glow && preset === "night")) {
      composer?.dispose();
      bloom?.dispose();
      composer = null;
      bloom = null;
    }
  };

  const rebuild = (next: OfficeLayout) => {
    if (room) {
      scene.remove(room.root);
      disposeObject(room.root, keep);
    }
    room = buildOfficeRoom(next, screens, 0);
    scene.add(room.root);
    layout = next;
    DOOR.z = next.room.d * 0.45;
    controls.target.set(next.room.w / 2, 0, next.room.d / 2);
    const elev = Math.asin(1 / Math.sqrt(3));
    const az = Math.PI / 4;
    const dist = 60;
    camera.position.set(
      next.room.w / 2 + dist * Math.cos(elev) * Math.sin(az),
      dist * Math.sin(elev),
      next.room.d / 2 + dist * Math.cos(elev) * Math.cos(az),
    );
    fitCamera();
    placeSun(55);
    sun.shadow.needsUpdate = true;
    const spots = [
      [next.room.w * 0.3, next.room.d * 0.3],
      [next.room.w * 0.7, next.room.d * 0.4],
      [next.room.w * 0.4, next.room.d * 0.7],
      [next.room.w * 0.8, next.room.d * 0.75],
    ];
    lamps.forEach((lamp, index) => {
      const spot = spots[index] ?? spots[0]!;
      lamp.position.set(spot[0], 2.2, spot[1]);
    });
  };

  const ensureWalker = (agent: StageAgent, fromDoor: boolean): Walker => {
    let walker = walkers.get(agent.key);
    if (!walker) {
      const rig = createAvatar(agent.key, agent.color, agent.accent, fnv1a(agent.key) % 4);
      const startX = fromDoor ? DOOR.x : agentTarget(agent).x;
      const startZ = fromDoor ? DOOR.z : agentTarget(agent).z;
      rig.root.position.set(startX, 0, startZ);
      scene.add(rig.root);
      walker = {
        rig,
        key: agent.key,
        x: startX,
        z: startZ,
        path: [],
        pose: agent.pose,
        marker: agent.marker,
        ask: agent.ask,
        name: agent.name,
        state: agent.state,
        leaving: false,
        intern: false,
      };
      walkers.set(agent.key, walker);
      if (fromDoor && !reduced) routeWalker(walker, agentTarget(agent));
    }
    return walker;
  };

  const agentTarget = (agent: StageAgent): { x: number; z: number; pose: Pose } => {
    if (!layout) return { x: 1, z: 1, pose: agent.pose };
    const desk = layout.pods.flatMap((pod) => pod.desks).find((slot) => slot.key === agent.deskKey);
    const chair = desk?.chair ?? [1, 1];
    const anchors = zoneAnchors(layout, agent.zone);
    const claim = claimAnchor(agent.key, agent.zone, anchors);
    if (!claim) return { x: chair[0], z: chair[1], pose: seatedFallback(agent.pose) };
    return { x: claim[0], z: claim[1], pose: agent.pose };
  };

  const routeWalker = (walker: Walker, target: { x: number; z: number }) => {
    if (!layout) return;
    if (reduced) {
      walker.x = target.x;
      walker.z = target.z;
      walker.path = [];
      walker.rig.root.position.set(target.x, 0, target.z);
      return;
    }
    walker.path = routeBetween(layout, [walker.x, walker.z], [target.x, target.z]);
  };

  const sync = (agents: StageAgent[]) => {
    const live = new Set(agents.map((agent) => agent.key));
    for (const [key, walker] of walkers) {
      if (walker.intern) continue;
      if (!live.has(key) && !walker.leaving) {
        walker.leaving = true;
        routeWalker(walker, DOOR);
      }
    }
    const claims = resetClaims();
    for (const agent of agents) {
      const walker = ensureWalker(agent, true);
      walker.leaving = false;
      const target = targetFor(agent, claims);
      const moved = walker.pose !== target.pose || Math.hypot(walker.x - target.x, walker.z - target.z) > 0.4;
      walker.pose = target.pose;
      walker.marker = agent.marker;
      walker.ask = agent.ask.slice(0, 80);
      walker.name = agent.name;
      walker.state = agent.state;
      if (moved && !walker.leaving) routeWalker(walker, target);
      const screen = room?.screens.get(agent.deskKey);
      if (screen) screen.material = screens.material(screenActivity(agent));
    }
    const delegating = agents.some((agent) => agent.pose === "meeting");
    if (delegating && !intern && layout) {
      const rig = createAvatar("intern", 0xf472b6, 0xf472b6, 1);
      rig.root.scale.set(0.7, 0.7, 0.7);
      const anchor = zoneAnchors(layout, "meeting")[0] ?? [layout.room.w - 4, layout.room.d / 2];
      rig.root.position.set(anchor[0], 0, anchor[1]);
      scene.add(rig.root);
      intern = {
        rig,
        key: "intern",
        x: anchor[0],
        z: anchor[1],
        path: [],
        pose: "meeting",
        marker: null,
        ask: "",
        name: "Intern",
        state: "running",
        leaving: false,
        intern: true,
      };
    } else if (!delegating && intern) {
      scene.remove(intern.rig.root);
      intern.rig.dispose();
      intern = null;
    }
  };

  const frame = (now: number) => {
    if (!running) return;
    raf = 0;
    if (paused || hidden || offscreen) return;
    if (now - lastFrame < 33) {
      raf = requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(0.1, (now - lastFrame) / 1000 || 0.016);
    lastFrame = now;
    const time = now / 1000;
    let walking = false;
    const stepWalker = (walker: Walker) => {
      const next = walker.path[0];
      if (next) {
        const dx = next[0] - walker.x;
        const dz = next[1] - walker.z;
        const dist = Math.hypot(dx, dz);
        const step = SPEED * dt;
        if (dist <= step || reduced) {
          walker.x = next[0];
          walker.z = next[1];
          walker.path.shift();
        } else {
          walker.x += (dx / dist) * step;
          walker.z += (dz / dist) * step;
          walking = true;
        }
        walker.rig.root.position.set(walker.x, 0, walker.z);
      }
      const ahead = walker.path[0];
      const yaw = ahead ? yawToward(ahead[0] - walker.x, ahead[1] - walker.z) : walker.rig.root.rotation.y;
      walker.rig.apply(
        {
          pose: walker.pose,
          moving: Boolean(ahead),
          yaw,
          reduced,
          marker: walker.marker,
          selected: walker.key === focusKey || walker.key === pointerHighlight || walker.key === listHighlight,
          time,
        },
        dt,
      );
      if (walker.leaving && walker.path.length === 0) {
        scene.remove(walker.rig.root);
        walker.rig.dispose();
        walkers.delete(walker.key);
        labelNodes.get(walker.key)?.remove();
        labelNodes.delete(walker.key);
      }
    };
    for (const walker of walkers.values()) stepWalker(walker);
    if (intern) stepWalker(intern);
    controls.target.x = MathUtils.clamp(controls.target.x, 0, layout?.room.w ?? 20);
    controls.target.z = MathUtils.clamp(controls.target.z, 0, layout?.room.d ?? 16);
    if (focusKey && !userGrab) {
      const walker = walkers.get(focusKey);
      if (walker) {
        controls.target.x = MathUtils.damp(controls.target.x, walker.x, 3, dt);
        controls.target.z = MathUtils.damp(controls.target.z, walker.z, 3, dt);
      }
    }
    controls.update();
    if (now - screenTick > 250) {
      screenTick = now;
      screens.tick(time);
      for (const led of room?.leds ?? []) {
        const material = led.material;
        if (material instanceof MeshStandardMaterial) {
          material.emissiveIntensity = Math.sin(time * 8 + led.position.y) > 0 ? 1.4 : 0.2;
        }
      }
    }
    if (now - clockTick > 1000 && room?.clockHands) {
      clockTick = now;
      const date = new Date();
      const hour = room.clockHands.children.find((child) => child.userData.hour === true);
      const minute = room.clockHands.children.find((child) => child.userData.minute === true);
      if (hour) hour.rotation.z = -((date.getHours() % 12) / 12) * Math.PI * 2;
      if (minute) minute.rotation.z = -(date.getMinutes() / 60) * Math.PI * 2;
    }
    sun.shadow.needsUpdate = walking || now - shadowTick > 200;
    if (sun.shadow.needsUpdate) shadowTick = now;
    if (composer && glow) composer.render();
    else renderer.render(scene, camera);
    if (now - labelTick > 66) {
      labelTick = now;
      projectLabels();
    }
    raf = requestAnimationFrame(frame);
  };

  const projectLabels = () => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    const placed: Array<{ y: number; node: HTMLDivElement }> = [];
    for (const walker of walkers.values()) {
      let node = labelNodes.get(walker.key);
      if (!node) {
        node = document.createElement("div");
        node.className = "office-label";
        labels.appendChild(node);
        labelNodes.set(walker.key, node);
      }
      const dot = stateColor(walker.state);
      const ask = walker.marker === "ask" && walker.ask ? `<span class="office-ask">${escapeHtml(walker.ask)}</span>` : "";
      const warn = walker.marker === "error" ? `<span class="office-warn">⚠</span>` : "";
      node.innerHTML = `<span class="office-label-name" style="--dot:${dot}">${escapeHtml(walker.name)}</span>${warn}${ask}`;
      const vector = new Vector3(walker.x, 1.7, walker.z);
      vector.project(camera);
      const x = (vector.x * 0.5 + 0.5) * width;
      const y = (-vector.y * 0.5 + 0.5) * height;
      const visible = vector.z < 1 && x > -40 && x < width + 40 && y > -40 && y < height + 40;
      node.style.display = visible ? "block" : "none";
      if (!visible) continue;
      let stack = 0;
      for (const other of placed) {
        if (Math.abs(other.y - y) < 18) stack += 16;
      }
      node.style.transform = `translate(${x}px, ${y - stack}px)`;
      placed.push({ y, node });
    }
  };

  const pick = (event: PointerEvent, click: boolean) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const targets: Object3D[] = [];
    for (const walker of walkers.values()) {
      if (!walker.intern) targets.push(walker.rig.pick);
    }
    for (const desk of room?.deskPicks ?? []) targets.push(desk);
    const hits = raycaster.intersectObjects(targets, false);
    const key = typeof hits[0]?.object.userData.key === "string" ? hits[0].object.userData.key : null;
    if (click) hooks.onPick(key);
    else if (performance.now() - hoverTick > 33) {
      hoverTick = performance.now();
      pointerHighlight = key;
      hooks.onHover(key, key ? { x: event.clientX, y: event.clientY } : null);
    }
  };

  const onPointer = (event: PointerEvent) => pick(event, event.type === "pointerdown");
  const onLeave = () => {
    pointerHighlight = null;
    hooks.onHover(null, null);
  };
  const resetCamera = () => {
    focusKey = null;
    if (!layout) return;
    controls.target.set(layout.room.w / 2, 0, layout.room.d / 2);
    fitCamera();
  };
  const onGrabStart = () => {
    userGrab = true;
  };
  const onGrabEnd = () => {
    userGrab = false;
  };
  const onGrabChange = () => {
    if (userGrab) focusKey = null;
  };
  controls.addEventListener("start", onGrabStart);
  controls.addEventListener("end", onGrabEnd);
  controls.addEventListener("change", onGrabChange);
  renderer.domElement.addEventListener("pointerdown", onPointer);
  renderer.domElement.addEventListener("pointermove", onPointer);
  renderer.domElement.addEventListener("pointerleave", onLeave);
  renderer.domElement.addEventListener("dblclick", resetCamera);

  const resizeObserver = new ResizeObserver(() => fitCamera());
  resizeObserver.observe(host);
  const intersection = new IntersectionObserver((entries) => {
    offscreen = entries[0]?.isIntersecting === false;
    if (!offscreen) kick();
  });
  intersection.observe(host);
  const onVisibility = () => {
    hidden = document.hidden;
    if (!hidden) kick();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const kick = () => {
    if (!running || paused || hidden || offscreen || raf) return;
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  };

  const claims = new Map<string, number>();
  const resetClaims = () => {
    claims.clear();
    return claims;
  };
  const targetFor = (agent: StageAgent, used: Map<string, number>) => {
    if (!layout) return { x: 1, z: 1, pose: agent.pose };
    const desk = layout.pods.flatMap((pod) => pod.desks).find((slot) => slot.key === agent.deskKey);
    const chair = desk ? { x: desk.chair[0], z: desk.chair[1] } : { x: 1, z: 1 };
    if (agent.zone === "desk") return { x: chair.x, z: chair.z, pose: agent.pose };
    const anchors = agent.zone === "window" ? windowAnchors(layout.room) : zoneAnchors(layout, agent.zone);
    const index = used.get(agent.zone) ?? 0;
    if (index >= anchors.length) return { x: chair.x, z: chair.z, pose: seatedFallback(agent.pose) };
    used.set(agent.zone, index + 1);
    const point = anchors[index] ?? [chair.x, chair.z];
    return { x: point[0], z: point[1], pose: agent.pose };
  };
  const claimAnchor = (key: string, zone: Zone, anchors: [number, number][]) => {
    if (anchors.length === 0) return null;
    const index = Math.abs(fnv1a(key)) % anchors.length;
    return zone === "desk" ? null : anchors[index];
  };

  kick();
  void renderer.info.memory.geometries;

  return {
    update(next) {
      const deskKeys = (value: OfficeLayout) =>
        value.pods.map((pod) => `${pod.session}:${pod.desks.map((desk) => desk.key).join(",")}`).join("|");
      const same = layout && deskKeys(layout) === deskKeys(next.layout) && layout.room.w === next.layout.room.w;
      if (!same) rebuild(next.layout);
      else layout = next.layout;
      const working = next.agents.filter((agent) => agent.state === "running").length;
      const kpi = next.agents.length === 0 ? 0 : (working / next.agents.length) * 100;
      room?.setKpi(next.kpi ?? kpi);
      sync(next.agents);
      keep.clear();
      for (const material of screens.shared) keep.add(material);
      for (const material of sharedMaterials()) keep.add(material);
      kick();
    },
    setTimeOfDay(next) {
      tod = next;
      applyTod(next, performance.now());
    },
    setGlow(enabled) {
      glow = enabled;
      applyTod(tod, performance.now());
    },
    focus(key) {
      focusKey = key;
    },
    highlight(key) {
      listHighlight = key;
    },
    resize: fitCamera,
    setPaused(next) {
      paused = next;
      if (!paused) kick();
      else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    dispose() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      renderer.domElement.removeEventListener("pointerdown", onPointer);
      renderer.domElement.removeEventListener("pointermove", onPointer);
      renderer.domElement.removeEventListener("pointerleave", onLeave);
      renderer.domElement.removeEventListener("dblclick", resetCamera);
      controls.removeEventListener("start", onGrabStart);
      controls.removeEventListener("end", onGrabEnd);
      controls.removeEventListener("change", onGrabChange);
      for (const walker of walkers.values()) walker.rig.dispose();
      intern?.rig.dispose();
      disposeMarkerTextures();
      if (room) disposeObject(room.root, keep);
      screens.dispose();
      disposeSharedMaterials();
      composer?.dispose();
      bloom?.dispose();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labels.remove();
    },
  };
}

const TOD = {
  day: { sun: 0xfff4e0, intensity: 2.2, hemi: 0.7, elev: 55 },
  evening: { sun: 0xffb070, intensity: 1.4, hemi: 0.45, elev: 15 },
  night: { sun: 0x7a8cff, intensity: 0.25, hemi: 0.2, elev: 40 },
};

function todFromHour(hour: number): "day" | "evening" | "night" {
  if (hour >= 7 && hour < 17) return "day";
  if (hour >= 17 && hour < 20) return "evening";
  return "night";
}

function screenActivity(agent: StageAgent): string {
  if (agent.state === "failed") return "error";
  if (agent.state !== "running") return "off";
  return agent.pose === "terminal"
    ? "terminal"
    : agent.pose === "type_fast"
      ? "coding"
      : agent.pose === "browse"
        ? "browsing"
        : agent.pose === "meeting"
          ? "delegating"
          : agent.pose === "lean_back"
            ? "thinking"
            : agent.pose === "whiteboard"
              ? "planning"
              : agent.pose === "read_standing"
                ? "reading"
                : agent.pose === "type_slow"
                  ? "replying"
                  : "off";
}

function seatedFallback(pose: Pose): Pose {
  if (pose === "read_standing" || pose === "whiteboard" || pose === "meeting" || pose === "coffee" || pose === "sofa") {
    return "type_slow";
  }
  return pose;
}

function stateColor(state: string): string {
  if (state === "needs_user") return "#f97316";
  if (state === "failed") return "#ef4444";
  if (state === "succeeded") return "#22c55e";
  if (state === "idle") return "#6b7280";
  return "#8b7cf6";
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
