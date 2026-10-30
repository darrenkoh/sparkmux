import {
  BoxGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
} from "three";
import type { OfficeMarker, Pose } from "./officeTypes.ts";

export interface AvatarUpdate {
  pose: Pose;
  moving: boolean;
  yaw: number;
  reduced: boolean;
  marker: OfficeMarker;
  selected: boolean;
  time: number;
}

export interface AvatarRig {
  root: Group;
  pick: Mesh;
  apply(update: AvatarUpdate, dt: number): void;
  dispose(): void;
}

const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524];

export function createAvatar(key: string, color: number, accent: number, skinIndex: number): AvatarRig {
  const root = new Group();
  root.userData.key = key;
  const hips = new Group();
  hips.position.y = 0.9;
  const torso = new Mesh(
    new CapsuleGeometry(0.22, 0.4, 4, 8),
    new MeshStandardMaterial({ color, roughness: 0.8, metalness: 0 }),
  );
  torso.castShadow = true;
  torso.position.y = 0.35;
  const head = new Mesh(
    new SphereGeometry(0.2, 12, 10),
    new MeshStandardMaterial({ color: SKIN[skinIndex % SKIN.length] ?? SKIN[0], roughness: 0.7, metalness: 0 }),
  );
  head.position.y = 0.78;
  head.castShadow = true;
  const hair = new Mesh(
    new SphereGeometry(0.18, 10, 8),
    new MeshStandardMaterial({ color: 0x1f2937, roughness: 0.9, metalness: 0 }),
  );
  hair.position.y = 0.1;
  hair.scale.set(1, 0.6, 1);
  head.add(hair);
  const badge = new Mesh(
    new BoxGeometry(0.12, 0.08, 0.03),
    new MeshStandardMaterial({ color: accent, roughness: 0.4, metalness: 0.1, emissive: accent, emissiveIntensity: 0.25 }),
  );
  badge.position.set(0, 0.42, 0.2);
  const armL = pivotArm(true);
  const armR = pivotArm(false);
  armL.position.set(-0.28, 0.55, 0);
  armR.position.set(0.28, 0.55, 0);
  const legL = pivotLeg();
  const legR = pivotLeg();
  legL.position.set(-0.1, 0, 0);
  legR.position.set(0.1, 0, 0);
  torso.add(head, badge, armL, armR);
  hips.add(torso, legL, legR);

  const ring = new Mesh(
    new RingGeometry(0.32, 0.42, 24),
    new MeshBasicMaterial({ color: 0xf97316, transparent: true, opacity: 0.85, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.04;
  ring.visible = false;

  const marker = new Sprite(
    new SpriteMaterial({ map: markerTexture("!"), transparent: true, depthWrite: false }),
  );
  marker.position.set(0, 1.85, 0);
  marker.scale.set(0.35, 0.35, 0.35);
  marker.visible = false;

  const pick = new Mesh(
    new CylinderGeometry(0.45, 0.45, 1.8, 10),
    new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  pick.position.y = 0.9;
  pick.userData.key = key;

  root.add(hips, ring, marker, pick);

  const mug = new Mesh(
    new CylinderGeometry(0.05, 0.04, 0.08, 8),
    new MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4, metalness: 0 }),
  );
  mug.visible = false;
  armR.add(mug);
  mug.position.set(0, -0.45, 0.08);

  const paper = new Mesh(
    new BoxGeometry(0.18, 0.02, 0.24),
    new MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.9, metalness: 0 }),
  );
  paper.visible = false;
  armL.add(paper);
  paper.position.set(0.05, -0.4, 0.1);

  let blend = 0;
  let shown: Pose = "type_slow";

  return {
    root,
    pick,
    apply(update, dt) {
      const amp = update.reduced ? 0.3 : 1;
      blend = Math.min(1, blend + dt / 0.3);
      if (shown !== update.pose) {
        shown = update.pose;
        blend = 0;
      }
      const seated = isSeated(update.pose);
      hips.position.y = seated ? 0.45 : 0.9;
      legL.rotation.x = seated ? -Math.PI / 2 : 0;
      legR.rotation.x = seated ? -Math.PI / 2 : 0;
      torso.rotation.set(0, 0, 0);
      head.rotation.set(0, 0, 0);
      armL.rotation.set(0, 0, 0.15);
      armR.rotation.set(0, 0, -0.15);
      mug.visible = update.pose === "coffee";
      paper.visible = update.pose === "read_standing";
      if (update.moving) {
        const swing = Math.sin(update.time * 8) * 0.6 * amp;
        legL.rotation.x = swing;
        legR.rotation.x = -swing;
        armL.rotation.x = -swing;
        armR.rotation.x = swing;
        hips.position.y = (seated ? 0.45 : 0.9) + Math.sin(update.time * 8) * 0.03 * amp;
      } else {
        poseJoints(update.pose, update.time, amp, torso, head, armL, armR);
      }
      const yawDelta = normalizeAngle(update.yaw - root.rotation.y);
      root.rotation.y += update.reduced ? yawDelta : yawDelta * Math.min(1, dt * 8);
      const showRing = update.marker === "ask" || update.marker === "error" || update.selected;
      ring.visible = showRing;
      const ringMat = ring.material;
      if (ringMat instanceof MeshBasicMaterial) {
        ringMat.color.set(update.marker === "error" ? 0xef4444 : update.marker === "ask" ? 0xf97316 : 0xe5e7eb);
      }
      if (update.marker === "ask") {
        const pulse = 1 + Math.abs(Math.sin(update.time * 4)) * 0.4;
        ring.scale.set(pulse, pulse, pulse);
      } else ring.scale.set(1, 1, 1);
      applyMarker(marker, update);
    },
    dispose() {
      // The marker canvas is shared. Stage dispose releases it once.
      marker.material.map = null;
      marker.material.dispose();
    },
  };
}

function pivotArm(left: boolean): Group {
  const pivot = new Group();
  const arm = new Mesh(
    new CapsuleGeometry(0.07, 0.34, 3, 6),
    new MeshStandardMaterial({ color: 0xf1c27d, roughness: 0.7, metalness: 0 }),
  );
  arm.position.y = -0.24;
  arm.castShadow = true;
  pivot.add(arm);
  pivot.rotation.z = left ? 0.15 : -0.15;
  return pivot;
}

function pivotLeg(): Group {
  const pivot = new Group();
  const leg = new Mesh(
    new CapsuleGeometry(0.08, 0.4, 3, 6),
    new MeshStandardMaterial({ color: 0x1f2937, roughness: 0.8, metalness: 0 }),
  );
  leg.position.y = -0.28;
  leg.castShadow = true;
  pivot.add(leg);
  return pivot;
}

function isSeated(pose: Pose): boolean {
  return pose === "type_fast" || pose === "type_slow" || pose === "terminal" || pose === "lean_back" || pose === "slump" || pose === "browse" || pose === "meeting" || pose === "sofa";
}

function poseJoints(pose: Pose, time: number, amp: number, torso: Mesh, head: Mesh, armL: Group, armR: Group) {
  if (pose === "type_fast" || pose === "type_slow" || pose === "terminal" || pose === "browse") {
    const speed = pose === "type_fast" ? 14 : 6;
    armL.rotation.x = -1.15 + Math.sin(time * speed) * 0.08 * amp;
    armR.rotation.x = -1.15 + Math.sin(time * speed + Math.PI) * 0.08 * amp;
    if (pose === "terminal") head.rotation.x = Math.sin(time * 0.7) * 0.08 * amp;
    if (pose === "browse") armR.rotation.x = -0.8 + Math.sin(time * 2) * 0.15 * amp;
  } else if (pose === "lean_back") {
    torso.rotation.x = (-15 * Math.PI) / 180;
    armR.rotation.x = -2.2;
  } else if (pose === "raise_hand") {
    armR.rotation.x = (-170 * Math.PI) / 180 + Math.sin(time * 2) * ((15 * Math.PI) / 180) * amp;
  } else if (pose === "slump") {
    torso.rotation.x = (25 * Math.PI) / 180;
    head.rotation.x = 0.4;
  } else if (pose === "read_standing") {
    head.rotation.x = 0.5;
    armL.rotation.x = -1.1;
    armR.rotation.x = -1.1;
    torso.rotation.z = Math.sin(time * 1.2) * 0.03 * amp;
  } else if (pose === "meeting") {
    head.rotation.y = Math.sin(time * 0.8) * 0.4 * amp;
    armL.rotation.x = -0.6;
    armR.rotation.x = -0.4;
  } else if (pose === "whiteboard") {
    armR.rotation.x = -1.2 + Math.sin(time * 3) * 0.3 * amp;
    armR.rotation.z = Math.cos(time * 3) * 0.3 * amp;
  } else if (pose === "coffee") {
    armR.rotation.x = -1.15;
    if (Math.floor(time) % 4 === 0) armR.rotation.x = -1.7;
  } else if (pose === "sofa") {
    armL.rotation.z = 0.4;
    armR.rotation.z = -0.4;
  }
}

function applyMarker(marker: Sprite, update: AvatarUpdate) {
  const kind = update.marker;
  marker.visible = kind !== null;
  if (!kind) return;
  const map = marker.material.map;
  const next = markerTexture(kind === "ask" ? "!" : kind === "error" ? "smoke" : kind === "zzz" ? "z" : "thought");
  if (map !== next) marker.material.map = next;
  if (kind === "ask") marker.position.y = 1.85 + Math.abs(Math.sin(update.time * 4)) * 0.15;
  else if (kind === "zzz") marker.position.y = 1.7 + (update.time % 3) * 0.12;
  else if (kind === "error") marker.visible = Math.floor(update.time / 2) % 2 === 0 || update.time % 2 < 0.45;
  else marker.position.y = 1.9;
}

const markerMaps = new Map<string, CanvasTexture>();

function markerTexture(kind: string): CanvasTexture {
  const cached = markerMaps.get(kind);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, 64, 64);
    ctx.fillStyle = kind === "!" ? "#f97316" : kind === "smoke" ? "#ef4444" : kind === "z" ? "#e5e7eb" : "#facc15";
    ctx.font = "700 40px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(kind === "!" ? "!" : kind === "z" ? "zZ" : kind === "smoke" ? "•" : "…", 32, 34);
  }
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  markerMaps.set(kind, texture);
  return texture;
}

/** Drop the shared marker canvases. Call once when the stage closes, after every avatar. */
export function disposeMarkerTextures() {
  for (const texture of markerMaps.values()) texture.dispose();
  markerMaps.clear();
}

function normalizeAngle(angle: number): number {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

export function yawToward(dx: number, dz: number): number {
  return Math.atan2(dx, -dz);
}
