import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
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

/**
 * Creates a cute blocky Grok-Bot style character matching the Skydive
 * virtual office reference: cubic head with LED face visor, box torso,
 * box arms and box legs with natural walking/typing/sitting kinematics.
 */
export function createAvatar(
  key: string,
  color: number,
  accent: number,
  _skinIndex: number,
  cli?: string,
): AvatarRig {
  const root = new Group();
  root.userData.key = key;

  // Bot Chassis Container (root of character body)
  const botBody = new Group();
  botBody.position.y = 0.46;

  // Primary Bot Material (vibrant agent color)
  const botMat = new MeshStandardMaterial({
    color,
    roughness: 0.35,
    metalness: 0.15,
  });

  // Secondary Dark Chassis Material
  const darkMat = new MeshStandardMaterial({
    color: 0x1f2937,
    roughness: 0.4,
    metalness: 0.6,
  });

  // White Accent Material (hands, trim)
  const whiteMat = new MeshStandardMaterial({
    color: 0xf8fafc,
    roughness: 0.3,
    metalness: 0.1,
  });

  // --- 1. TORSO ---
  const torsoGroup = new Group();
  torsoGroup.position.y = 0.38; // relative to botBody
  const torso = new Mesh(new BoxGeometry(0.36, 0.42, 0.24), botMat);
  torso.castShadow = true;
  torso.receiveShadow = true;

  // Glowing Chest Power Core / Battery Emblem
  const chestCore = new Mesh(
    new SphereGeometry(0.045, 8, 8),
    new MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.5 }),
  );
  chestCore.position.set(0, 0.05, 0.125);
  torso.add(chestCore);
  torsoGroup.add(torso);

  // --- 2. HEAD ---
  const headGroup = new Group();
  headGroup.position.set(0, 0.44, 0); // on top of torso

  // Cubic Bot Head (Crossy Road / Skydive toy box shape)
  const head = new Mesh(new BoxGeometry(0.36, 0.36, 0.34), botMat);
  head.castShadow = true;
  head.receiveShadow = true;
  head.position.y = 0;

  // Dark Glossy Visor Screen
  const visor = new Mesh(
    new BoxGeometry(0.34, 0.22, 0.04),
    new MeshStandardMaterial({ color: 0x090d16, roughness: 0.2, metalness: 0.8 }),
  );
  visor.position.set(0, 0.02, 0.16);

  // Dynamic LED Face Canvas (shows cute expressive eyes)
  const eyeCanvas = document.createElement("canvas");
  eyeCanvas.width = 128;
  eyeCanvas.height = 64;
  const eyeTexture = new CanvasTexture(eyeCanvas);
  const eyeMat = new MeshBasicMaterial({ map: eyeTexture, transparent: true });
  const eyeScreen = new Mesh(new PlaneGeometry(0.32, 0.18), eyeMat);
  eyeScreen.position.set(0, 0.02, 0.182);

  // Springy Top Antenna with Glowing Beacon / CLI Custom Head Accessory
  const antenna = new Group();
  antenna.position.set(0, 0.18, 0);
  let haloMesh: Mesh | null = null;

  if (cli === "antigravity") {
    // Glowing levitating halo ring above head
    haloMesh = new Mesh(
      new TorusGeometry(0.14, 0.014, 8, 24),
      new MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.8 }),
    );
    haloMesh.rotation.x = Math.PI / 2;
    haloMesh.position.set(0, 0.22, 0);
    headGroup.add(haloMesh);

    const antennaStem = new Mesh(new CylinderGeometry(0.012, 0.012, 0.12, 8), darkMat);
    antennaStem.position.y = 0.06;
    const antennaBall = new Mesh(
      new SphereGeometry(0.04, 8, 8),
      new MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.6 }),
    );
    antennaBall.position.y = 0.13;
    antenna.add(antennaStem, antennaBall);
  } else if (cli === "grok") {
    const antennaStem = new Mesh(new CylinderGeometry(0.014, 0.014, 0.16, 8), darkMat);
    antennaStem.position.y = 0.08;
    const antennaBall = new Mesh(
      new SphereGeometry(0.045, 8, 8),
      new MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.7 }),
    );
    antennaBall.position.y = 0.18;
    // Angled orbital ring around antennaBall
    const orbitRing = new Mesh(
      new TorusGeometry(0.08, 0.01, 6, 18),
      new MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.5 }),
    );
    orbitRing.position.y = 0.18;
    orbitRing.rotation.x = Math.PI / 3;
    antenna.add(antennaStem, antennaBall, orbitRing);
  } else if (cli === "claude") {
    // Twin antenna beacon array
    const stemL = new Mesh(new CylinderGeometry(0.012, 0.012, 0.14, 8), darkMat);
    stemL.position.set(-0.06, 0.07, 0);
    const ballL = new Mesh(
      new SphereGeometry(0.038, 8, 8),
      new MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.6 }),
    );
    ballL.position.set(-0.06, 0.15, 0);

    const stemR = new Mesh(new CylinderGeometry(0.012, 0.012, 0.11, 8), darkMat);
    stemR.position.set(0.06, 0.055, 0);
    const ballR = new Mesh(
      new SphereGeometry(0.032, 8, 8),
      new MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.6 }),
    );
    ballR.position.set(0.06, 0.12, 0);

    antenna.add(stemL, ballL, stemR, ballR);
  } else {
    // Default single antenna
    const antennaStem = new Mesh(new CylinderGeometry(0.014, 0.014, 0.15, 8), darkMat);
    antennaStem.position.y = 0.075;
    const antennaBall = new Mesh(
      new SphereGeometry(0.045, 8, 8),
      new MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.6 }),
    );
    antennaBall.position.y = 0.17;
    antenna.add(antennaStem, antennaBall);
  }

  // Side Ear Pods / Dials
  const earL = new Mesh(new CylinderGeometry(0.06, 0.06, 0.035, 12), darkMat);
  earL.position.set(-0.19, 0.02, 0);
  earL.rotation.z = Math.PI / 2;
  const earRingL = new Mesh(
    new TorusGeometry(0.05, 0.008, 6, 12),
    new MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.4 }),
  );
  earRingL.position.set(-0.205, 0.02, 0);
  earRingL.rotation.y = Math.PI / 2;

  const earR = new Mesh(new CylinderGeometry(0.06, 0.06, 0.035, 12), darkMat);
  earR.position.set(0.19, 0.02, 0);
  earR.rotation.z = Math.PI / 2;
  const earRingR = new Mesh(
    new TorusGeometry(0.05, 0.008, 6, 12),
    new MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.4 }),
  );
  earRingR.position.set(0.205, 0.02, 0);
  earRingR.rotation.y = Math.PI / 2;

  headGroup.add(head, visor, eyeScreen, antenna, earL, earRingL, earR, earRingR);
  torsoGroup.add(headGroup);

  // --- 3. ARMS ---
  const armL = createLimb(true, botMat, darkMat, whiteMat);
  const armR = createLimb(false, botMat, darkMat, whiteMat);
  armL.position.set(-0.24, 0.16, 0);
  armR.position.set(0.24, 0.16, 0);
  torsoGroup.add(armL, armR);

  // Coffee Can / Mug attached to right hand
  const botDrink = new Mesh(
    new CylinderGeometry(0.04, 0.04, 0.1, 10),
    new MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.6, roughness: 0.3 }),
  );
  botDrink.visible = false;
  armR.add(botDrink);
  botDrink.position.set(0, -0.32, 0.08);

  // --- 4. LEGS ---
  const legL = createLeg(darkMat, botMat);
  const legR = createLeg(darkMat, botMat);
  legL.position.set(-0.1, -0.19, 0); // hips relative to torsoGroup
  legR.position.set(0.1, -0.19, 0);
  torsoGroup.add(legL, legR);

  botBody.add(torsoGroup);

  // --- 5. DROP SHADOW & STATUS RINGS ---
  const dropShadow = new Mesh(
    new CircleGeometry(0.3, 20),
    new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  dropShadow.rotation.x = -Math.PI / 2;
  dropShadow.position.y = 0.02;

  // Selection / Status Ring on floor
  const ring = new Mesh(
    new RingGeometry(0.34, 0.44, 24),
    new MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.035;
  ring.visible = false;

  // Floating Status Marker (Sprite above bot)
  const marker = new Sprite(
    new SpriteMaterial({ map: markerTexture("!"), transparent: true, depthWrite: false }),
  );
  marker.position.set(0, 1.75, 0);
  marker.scale.set(0.36, 0.36, 0.36);
  marker.visible = false;

  // Raycast Pick Box
  const pick = new Mesh(
    new CylinderGeometry(0.42, 0.42, 1.6, 10),
    new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  pick.position.y = 0.8;
  pick.userData.key = key;

  root.add(botBody, dropShadow, ring, marker, pick);

  let prevPose: Pose = "type_slow";
  let prevMarker: OfficeMarker = null;

  const drawEyes = (pose: Pose, statusKind: OfficeMarker) => {
    const ctx = eyeCanvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 128, 64);
    ctx.fillStyle = "#67c3e8";

    if (statusKind === "error" || pose === "slump") {
      // > < or X X error eyes
      ctx.strokeStyle = "#e05252";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(30, 22); ctx.lineTo(46, 38);
      ctx.moveTo(46, 22); ctx.lineTo(30, 38);
      ctx.moveTo(82, 22); ctx.lineTo(98, 38);
      ctx.moveTo(98, 22); ctx.lineTo(82, 38);
      ctx.stroke();
    } else if (statusKind === "ask" || pose === "raise_hand") {
      // Big wide surprised / question eyes [ ! ! ]
      ctx.beginPath();
      ctx.arc(38, 30, 11, 0, Math.PI * 2);
      ctx.arc(90, 30, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(36, 26, 3.5, 0, Math.PI * 2);
      ctx.arc(88, 26, 3.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (pose === "type_fast" || pose === "terminal") {
      // Happy focus arcs ^ ^
      ctx.strokeStyle = "#67c3e8";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(38, 32, 9, Math.PI, 0);
      ctx.arc(90, 32, 9, Math.PI, 0);
      ctx.stroke();
    } else if (pose === "lean_back") {
      // Content relaxed smile eyes
      ctx.strokeStyle = "#e2b842";
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(38, 34, 8, Math.PI, 0);
      ctx.arc(90, 34, 8, Math.PI, 0);
      ctx.stroke();
    } else {
      // Normal cute glowing rounded eyes with highlights
      ctx.beginPath();
      ctx.ellipse(38, 30, 7, 11, 0, 0, Math.PI * 2);
      ctx.ellipse(90, 30, 7, 11, 0, 0, Math.PI * 2);
      ctx.fill();
      // Soft white glint
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(36, 26, 2.5, 0, Math.PI * 2);
      ctx.arc(88, 26, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    eyeTexture.needsUpdate = true;
  };

  drawEyes("type_slow", null);

  return {
    root,
    pick,
    apply(update, dt) {
      const amp = update.reduced ? 0.3 : 1;
      const seated = isSeated(update.pose);

      // Redraw eyes ONLY when pose or marker changes (avoids redundant 2D canvas draws)
      if (prevPose !== update.pose || prevMarker !== update.marker) {
        prevPose = update.pose;
        prevMarker = update.marker;
        drawEyes(update.pose, update.marker);
      }

      // Antenna springy wiggle
      antenna.rotation.z = Math.sin(update.time * 6) * 0.12 * amp;
      antenna.rotation.x = Math.cos(update.time * 5) * 0.08 * amp;
      if (haloMesh) {
        haloMesh.position.y = 0.22 + Math.sin(update.time * 4) * 0.015 * amp;
      }

      botDrink.visible = update.pose === "coffee";

      if (seated) {
        // Seated at desk or sofa
        botBody.position.y = 0.44; // aligns with chair seat height
        torsoGroup.rotation.x = 0;
        torsoGroup.rotation.z = 0;

        // Legs bend forward 90 degrees at hips
        legL.rotation.x = -Math.PI / 2;
        legR.rotation.x = -Math.PI / 2;
        legL.rotation.z = -0.06;
        legR.rotation.z = 0.06;

        // Typing / relaxed arm poses
        poseSeatedArms(update.pose, update.time, amp, armL, armR, torso);
      } else if (update.moving) {
        // Walking Kinematics (Crossy Road / Voxel Bot walking)
        const walkSpeed = 9;
        const swing = Math.sin(update.time * walkSpeed) * 0.55 * amp;
        const bounce = Math.abs(Math.sin(update.time * walkSpeed)) * 0.04 * amp;

        botBody.position.y = 0.46 + bounce;
        torsoGroup.rotation.x = 0.08 * amp; // slight forward lean
        torsoGroup.rotation.z = Math.sin(update.time * walkSpeed * 0.5) * 0.04 * amp;

        // Opposite arm & leg swings
        legL.rotation.x = swing;
        legR.rotation.x = -swing;
        legL.rotation.z = 0;
        legR.rotation.z = 0;

        armL.rotation.x = -swing * 0.85;
        armR.rotation.x = swing * 0.85;
        armL.rotation.z = 0.1;
        armR.rotation.z = -0.1;
      } else {
        // Standing Idle Kinematics
        const breath = Math.sin(update.time * 3) * 0.015 * amp;
        botBody.position.y = 0.46 + breath;
        torsoGroup.rotation.x = 0;
        torsoGroup.rotation.z = 0;

        legL.rotation.x = 0;
        legR.rotation.x = 0;
        legL.rotation.z = 0;
        legR.rotation.z = 0;

        poseStandingArms(update.pose, update.time, amp, armL, armR);
      }

      // Smooth yaw rotation
      const yawDelta = normalizeAngle(update.yaw - root.rotation.y);
      root.rotation.y += update.reduced ? yawDelta : yawDelta * Math.min(1, dt * 8);

      // Selection ring
      const showRing = update.marker === "ask" || update.marker === "error" || update.selected;
      ring.visible = showRing;
      const ringMat = ring.material;
      if (ringMat instanceof MeshBasicMaterial) {
        ringMat.color.set(update.marker === "error" ? 0xef4444 : update.marker === "ask" ? 0xf59e0b : 0x38bdf8);
      }
      if (update.marker === "ask") {
        const pulse = 1 + Math.abs(Math.sin(update.time * 4)) * 0.35;
        ring.scale.set(pulse, pulse, pulse);
      } else ring.scale.set(1, 1, 1);

      applyMarker(marker, update);
    },
    dispose() {
      eyeTexture.dispose();
      eyeMat.dispose();
      marker.material.map = null;
      marker.material.dispose();
      root.traverse((obj) => {
        const mesh = obj as Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) {
          if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
          else mesh.material.dispose();
        }
      });
    },
  };
}

/** Creates a blocky box arm with shoulder pivot */
function createLimb(
  left: boolean,
  botMat: MeshStandardMaterial,
  darkMat: MeshStandardMaterial,
  whiteMat: MeshStandardMaterial,
): Group {
  const arm = new Group();

  // Shoulder hinge
  const shoulder = new Mesh(new SphereGeometry(0.04, 8, 8), darkMat);
  shoulder.position.y = 0;

  // Box Arm
  const armBox = new Mesh(new BoxGeometry(0.09, 0.3, 0.09), botMat);
  armBox.position.y = -0.15;

  // White cuff / robotic hand
  const hand = new Mesh(new BoxGeometry(0.08, 0.06, 0.08), whiteMat);
  hand.position.y = -0.32;

  arm.add(shoulder, armBox, hand);
  arm.rotation.z = left ? 0.08 : -0.08;
  return arm;
}

/** Creates a blocky box leg with hip pivot */
function createLeg(
  darkMat: MeshStandardMaterial,
  botMat: MeshStandardMaterial,
): Group {
  const leg = new Group();

  // Hip pivot point
  const hip = new Mesh(new SphereGeometry(0.04, 8, 8), darkMat);
  hip.position.y = 0;

  // Box Leg
  const legBox = new Mesh(new BoxGeometry(0.11, 0.34, 0.11), botMat);
  legBox.position.y = -0.17;

  // Shoe / foot cuff
  const shoe = new Mesh(new BoxGeometry(0.12, 0.06, 0.15), darkMat);
  shoe.position.set(0, -0.32, 0.02);

  leg.add(hip, legBox, shoe);
  return leg;
}

function isSeated(pose: Pose): boolean {
  return (
    pose === "type_fast" ||
    pose === "type_slow" ||
    pose === "terminal" ||
    pose === "lean_back" ||
    pose === "slump" ||
    pose === "browse" ||
    pose === "meeting" ||
    pose === "sofa"
  );
}

function poseSeatedArms(
  pose: Pose,
  time: number,
  amp: number,
  armL: Group,
  armR: Group,
  torso: Mesh,
) {
  if (pose === "type_fast" || pose === "type_slow" || pose === "terminal" || pose === "browse") {
    const speed = pose === "type_fast" ? 16 : 8;
    // Both arms forward typing on keyboard
    armL.rotation.x = -1.25 + Math.sin(time * speed) * 0.12 * amp;
    armR.rotation.x = -1.25 + Math.sin(time * speed + Math.PI) * 0.12 * amp;
    armL.rotation.y = 0.2;
    armR.rotation.y = -0.2;
    armL.rotation.z = 0;
    armR.rotation.z = 0;
    torso.position.y = Math.sin(time * 4) * 0.008 * amp;
  } else if (pose === "lean_back") {
    armL.rotation.x = -0.4;
    armR.rotation.x = -0.4;
    armL.rotation.y = 0;
    armR.rotation.y = 0;
    torso.rotation.x = (-12 * Math.PI) / 180;
  } else if (pose === "slump") {
    armL.rotation.x = -0.2;
    armR.rotation.x = -0.2;
    armL.rotation.y = 0;
    armR.rotation.y = 0;
    torso.rotation.x = (10 * Math.PI) / 180;
  } else {
    // Meeting / sofa relaxed arms
    armL.rotation.x = -0.8;
    armR.rotation.x = -0.8;
    armL.rotation.y = 0.15;
    armR.rotation.y = -0.15;
    torso.rotation.x = 0;
  }
}

function poseStandingArms(
  pose: Pose,
  time: number,
  amp: number,
  armL: Group,
  armR: Group,
) {
  if (pose === "raise_hand") {
    // Cheerful bot wave
    armR.rotation.x = (-165 * Math.PI) / 180 + Math.sin(time * 6) * ((15 * Math.PI) / 180) * amp;
    armR.rotation.y = 0;
    armR.rotation.z = 0.15;
    armL.rotation.x = -0.2;
    armL.rotation.y = 0;
  } else if (pose === "coffee") {
    // Holding coffee can
    armR.rotation.x = -1.35;
    armR.rotation.y = -0.25;
    armL.rotation.x = -0.15;
    armL.rotation.y = 0;
  } else {
    // Normal standing arms
    armL.rotation.x = Math.sin(time * 2.5) * 0.04 * amp;
    armR.rotation.x = -Math.sin(time * 2.5) * 0.04 * amp;
    armL.rotation.y = 0;
    armR.rotation.y = 0;
    armL.rotation.z = 0.08;
    armR.rotation.z = -0.08;
  }
}

function applyMarker(marker: Sprite, update: AvatarUpdate) {
  if (update.marker === "ask") {
    marker.material.map = markerTexture("?");
    marker.visible = true;
    marker.material.needsUpdate = true;
  } else if (update.marker === "error") {
    marker.material.map = markerTexture("!");
    marker.visible = true;
    marker.material.needsUpdate = true;
  } else {
    marker.visible = false;
  }
  if (marker.visible) {
    marker.position.y = 1.75 + Math.sin(update.time * 4) * 0.06;
  }
}

const markerCache = new Map<string, CanvasTexture>();

function markerTexture(glyph: string): CanvasTexture {
  const cached = markerCache.get(glyph);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, 64, 64);
    ctx.beginPath();
    ctx.arc(32, 32, 28, 0, Math.PI * 2);
    ctx.fillStyle = glyph === "?" ? "#f59e0b" : "#ef4444";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 34px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(glyph, 32, 34);
  }
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  markerCache.set(glyph, texture);
  return texture;
}

export function disposeMarkerTextures() {
  for (const texture of markerCache.values()) texture.dispose();
  markerCache.clear();
}

export function yawToward(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
