import { useEffect, useRef, useState } from "react";
import type { ActivityPoint, TabAnalyticsStats } from "../api";
import {
  activityAxis,
  compressedToWall,
  mapWindow,
  wallToCompressed,
  windowStartFromFraction,
  windowTrack,
  type TimeWindow,
} from "./terrainWindow";

interface TerrainViewportProps {
  timeline: ActivityPoint[];
  activeModel?: string;
  sessionName?: string;
  tabName?: string;
  stats?: TabAnalyticsStats | null;
  /** Changes when the tmux tab or agent transcript changes, so a new session starts flat. */
  mapKey?: string;
  docked?: boolean;
  /** Host panel draws expand, pop-out, and close, so the canvas omits those buttons. */
  hideDockedControls?: boolean;
  /** Spectral or mono relief. Omitted keeps the viewport's own toggle. */
  colorMode?: "mono" | "color";
  onExpand?: () => void;
  onPopOut?: () => void;
  onClose?: () => void;
}

// ---------------------------------------------------------------------------
// 3D Matrix & Math Helpers
// ---------------------------------------------------------------------------
function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(eye: [number, number, number], target: [number, number, number], up: [number, number, number] = [0, 1, 0]): Float32Array {
  const z0 = eye[0] - target[0];
  const z1 = eye[1] - target[1];
  const z2 = eye[2] - target[2];
  const lenZ = Math.hypot(z0, z1, z2) || 1;
  const zx = z0 / lenZ, zy = z1 / lenZ, zz = z2 / lenZ;

  const x0 = up[1] * zz - up[2] * zy;
  const x1 = up[2] * zx - up[0] * zz;
  const x2 = up[0] * zy - up[1] * zx;
  const lenX = Math.hypot(x0, x1, x2) || 1;
  const xx = x0 / lenX, xy = x1 / lenX, xz = x2 / lenX;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] =
        a[j] * b[i * 4] +
        a[4 + j] * b[i * 4 + 1] +
        a[8 + j] * b[i * 4 + 2] +
        a[12 + j] * b[i * 4 + 3];
    }
  }
  return out;
}

function projectPoint(vp: Float32Array, p: [number, number, number], width: number, height: number): [number, number, number] | null {
  const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
  const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
  const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  if (w <= 0.01) return null;
  return [((x / w) * 0.5 + 0.5) * width, (0.5 - (y / w) * 0.5) * height, w];
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 1831565813) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// WebGL2 Shaders from beastydesign.github.io/scifi
// ---------------------------------------------------------------------------
const VS_TERRAIN = `#version 300 es
uniform mat4 uVP;
uniform float uTime, uFocus, uAperture, uDpr, uGain, uScanX, uMaxX, uReal;
in vec4 aPos;      // xyz + brightness
in vec3 aCol;      // label category color
in float aSeed;
out float vA;
out float vRing;
out vec3 vCol;
void main() {
  vec4 c = uVP * vec4(aPos.xyz, 1.0);
  gl_Position = c;
  float coc = min(abs(c.w - uFocus) * uAperture, 28.0);
  float base = 1.0 + aSeed * 1.3;
  float size = base + coc;
  gl_PointSize = size * uDpr;
  float energy = (base * base) / (size * size);
  float twinkle = 0.84 + 0.16 * sin(uTime * (0.8 + aSeed * 2.2) + aSeed * 53.0);
  
  // Chronological X-axis scanning pulse
  float scan = 1.0 + 3.2 * exp(-pow((aPos.x - uScanX) * 0.95, 2.0));
  
  // Scrubber / growth clip: hide or fade particles ahead of current timeline scrub
  float timeClip = smoothstep(uMaxX + 0.45, uMaxX - 0.2, aPos.x);
  
  float fog = exp(-max(c.w - 38.0, 0.0) * 0.035);
  vA = aPos.w * energy * twinkle * scan * fog * uGain * timeClip;
  vRing = smoothstep(5.0, 15.0, coc);
  // Maintain vivid saturated chromaticity across the entire heightmap and scan pass
  vCol = mix(vec3(1.0), aCol * 1.25, uReal);
}
`;

const FS_TERRAIN = `#version 300 es
precision highp float;
in float vA;
in float vRing;
in vec3 vCol;
out vec4 o;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  if (r > 1.0) discard;
  float disc = 1.0 - smoothstep(0.65, 1.0, r);
  float ring = smoothstep(0.55, 0.86, r) * (1.0 - smoothstep(0.88, 1.0, r));
  float a = mix(disc, disc * 0.22 + ring * 1.5, vRing);
  o = vec4(vCol * (a * vA), 1.0);
}
`;

const VS_CONTOUR = `#version 300 es
uniform mat4 uVP;
uniform vec3 uCam;
uniform float uScanX, uScanAmount, uMaxX;
in vec3 aPos;
in float aA;
out float vA;
void main() {
  gl_Position = uVP * vec4(aPos, 1.0);
  float d = length(aPos - uCam);
  float fog = exp(-max(d - 30.0, 0.0) * 0.035);
  float scan = 1.0 + uScanAmount * exp(-pow((aPos.x - uScanX) * 0.85, 2.0));
  float timeClip = smoothstep(uMaxX + 0.45, uMaxX - 0.2, aPos.x);
  vA = aA * fog * scan * timeClip;
}
`;

const FS_CONTOUR = `#version 300 es
precision highp float;
uniform vec3 uColor;
in float vA;
out vec4 o;
void main() {
  o = vec4(uColor * vA, 1.0);
}
`;

// Categories mapped along the Z-axis (Label Axis)
const CHANNELS = [
  { key: "user", label: "USER INPUT", color: [1.0, 0.62, 0.24], hex: "#ff9a3c", zIndex: 0 },
  { key: "think", label: "REASONING", color: [0.75, 0.52, 0.98], hex: "#c084fc", zIndex: 1 },
  { key: "reply", label: "ASSISTANT", color: [0.36, 0.58, 0.95], hex: "#5b8def", zIndex: 2 },
  { key: "tool", label: "TOOL RUNTIME", color: [0.18, 0.84, 0.75], hex: "#2dd4bf", zIndex: 3 },
] as const;

const CHANNEL_TAGS = ["USR", "THK", "RPL", "TOL"] as const;

const zLanes = [-6.75, -2.25, 2.25, 6.75]; // USER, THINK, REPLY, TOOL
const TIME_SPAN = 28; // X extent: -14 to +14
const RECT_HX = 14.0;
const RECT_HZ = 9.0;
const GLOBE_RADIUS = 18.0;
const POINT_COUNT = 50000;
const LIGHT_DIR = [-0.45, 0.8, 0.4];

export type BaseShape = "rect" | "globe";
export type ScanSpeed = "0.25x" | "0.5x" | "1x" | "2x" | "paused";

const STORAGE_KEY_BASE_SHAPE = "sparkmux_area_map_base_shape";
const STORAGE_KEY_SCAN_SPEED = "sparkmux_area_map_scan_speed";
const STORAGE_KEY_SHOW_TRACE = "sparkmux_area_map_show_trace";

/** Elapsed session time: `12:05`, or `1:12:05` once an hour has passed. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remain = minutes % 60;
    return `${hours}:${remain.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function getInitialBaseShape(): BaseShape {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_BASE_SHAPE);
    if (saved === "rect" || saved === "globe") {
      return saved;
    }
  } catch {}
  return "rect";
}

function getInitialScanSpeed(): ScanSpeed {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_SCAN_SPEED);
    if (saved === "0.25x" || saved === "0.5x" || saved === "1x" || saved === "2x" || saved === "paused") {
      return saved;
    }
  } catch {}
  return "1x";
}

function getInitialShowTrace(): boolean {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_SHOW_TRACE);
    if (saved !== null) {
      return saved === "true";
    }
  } catch {}
  return true;
}

let persistentBaseShape: BaseShape = getInitialBaseShape();
let persistentScanSpeed: ScanSpeed = getInitialScanSpeed();
let persistentShowTrace: boolean = getInitialShowTrace();

// Persistent camera viewing angle across re-renders and view switches
const persistentCam = {
  azimuth: 0.38,
  elevation: 0.48,
  radius: persistentBaseShape === "globe" ? 54 : 46,
  target: [0, 1.2, 0] as [number, number, number],
};

interface BaseParticle {
  rx: number;
  rz: number;
  distNorm: number;
  r: number;
  g: number;
  b: number;
  jitterY: number;
  shadeRand: number;
  seed: number;
}

function getBaseDistNorm(x: number, z: number, shape: BaseShape): number {
  if (shape === "rect") {
    return Math.max(Math.abs(x) / RECT_HX, Math.abs(z) / RECT_HZ);
  } else {
    return Math.hypot(x, z) / GLOBE_RADIUS;
  }
}

function generateBaseParticles(shape: BaseShape): BaseParticle[] {
  const particles: BaseParticle[] = [];
  const rng = makeRng(2077);
  let attempts = 0;
  const maxAttempts = POINT_COUNT * 3;
  const sampleExtentX = shape === "globe" ? GLOBE_RADIUS : RECT_HX;
  const sampleExtentZ = shape === "globe" ? GLOBE_RADIUS : RECT_HZ;

  while (particles.length < POINT_COUNT && attempts < maxAttempts) {
    attempts++;
    const rx = (rng() * 2 - 1) * sampleExtentX;
    const rz = (rng() * 2 - 1) * sampleExtentZ;
    const distNorm = getBaseDistNorm(rx, rz, shape);
    if (distNorm > 1.0) continue;

    let r = 0.2, g = 0.8, b = 0.7;
    if (rz < -4.5) {
      r = 1.0; g = 0.58; b = 0.12;
    } else if (rz < 0.0) {
      r = 0.82; g = 0.38; b = 1.0;
    } else if (rz < 4.5) {
      r = 0.22; g = 0.62; b = 1.0;
    } else {
      r = 0.10; g = 0.95; b = 0.82;
    }

    if (distNorm > 0.90) {
      const coastMix = (distNorm - 0.90) / 0.10;
      r = r * (1 - coastMix) + 0.35 * coastMix;
      g = g * (1 - coastMix) + 0.75 * coastMix;
      b = b * (1 - coastMix) + 1.00 * coastMix;
    }

    const jitterY = (rng() - 0.5) * 0.03;
    const shadeRand = 0.5 + 0.5 * rng();
    const seed = rng();

    particles.push({ rx, rz, distNorm, r, g, b, jitterY, shadeRand, seed });
  }

  return particles;
}

function generateBaseGridVerts(shape: BaseShape): Float32Array {
  const verts: number[] = [];
  const gridExtentX = shape === "globe" ? GLOBE_RADIUS : RECT_HX;
  const gridExtentZ = shape === "globe" ? GLOBE_RADIUS : RECT_HZ;
  const GRID_STEP = 0.35;
  const gridLimitX = Math.round(gridExtentX);
  const gridLimitZ = Math.round(gridExtentZ);

  for (let gx = -gridLimitX; gx <= gridLimitX; gx += 2) {
    const a = gx === 0 ? 0.35 : gx % 4 === 0 ? 0.18 : 0.07;
    let inSeg = false;
    let segStart = 0;
    for (let z = -gridLimitZ; z <= gridLimitZ + 0.001; z += GRID_STEP) {
      const inside = getBaseDistNorm(gx, z, shape) <= 1.0;
      if (inside && !inSeg) {
        inSeg = true;
        segStart = z;
      } else if (!inside && inSeg) {
        inSeg = false;
        verts.push(gx, 0, segStart, a, gx, 0, z - GRID_STEP, a);
      }
    }
    if (inSeg) {
      verts.push(gx, 0, segStart, a, gx, 0, gridLimitZ, a);
    }
  }

  for (let gz = -gridLimitZ; gz <= gridLimitZ; gz += 2) {
    const a = gz === 0 ? 0.35 : gz % 4 === 0 ? 0.18 : 0.07;
    let inSeg = false;
    let segStart = 0;
    for (let x = -gridLimitX; x <= gridLimitX + 0.001; x += GRID_STEP) {
      const inside = getBaseDistNorm(x, gz, shape) <= 1.0;
      if (inside && !inSeg) {
        inSeg = true;
        segStart = x;
      } else if (!inside && inSeg) {
        inSeg = false;
        verts.push(segStart, 0, gz, a, x - GRID_STEP, 0, gz, a);
      }
    }
    if (inSeg) {
      verts.push(segStart, 0, gz, a, gridLimitX, 0, gz, a);
    }
  }

  if (shape === "rect") {
    const rA = 0.75;
    verts.push(-RECT_HX, 0.02, -RECT_HZ, rA, RECT_HX, 0.02, -RECT_HZ, rA);
    verts.push(RECT_HX, 0.02, -RECT_HZ, rA, RECT_HX, 0.02, RECT_HZ, rA);
    verts.push(RECT_HX, 0.02, RECT_HZ, rA, -RECT_HX, 0.02, RECT_HZ, rA);
    verts.push(-RECT_HX, 0.02, RECT_HZ, rA, -RECT_HX, 0.02, -RECT_HZ, rA);
  } else {
    const GLOBE_SEGS = 240;
    for (let i = 0; i < GLOBE_SEGS; i++) {
      const th0 = (i / GLOBE_SEGS) * Math.PI * 2;
      const th1 = ((i + 1) / GLOBE_SEGS) * Math.PI * 2;
      const x0 = Math.cos(th0) * GLOBE_RADIUS;
      const z0 = Math.sin(th0) * GLOBE_RADIUS;
      const x1 = Math.cos(th1) * GLOBE_RADIUS;
      const z1 = Math.sin(th1) * GLOBE_RADIUS;
      verts.push(x0, 0.02, z0, 0.85, x1, 0.02, z1, 0.85);
    }

    for (const frac of [0.35, 0.70]) {
      const rSub = GLOBE_RADIUS * frac;
      for (let i = 0; i < 120; i++) {
        const th0 = (i / 120) * Math.PI * 2;
        const th1 = ((i + 1) / 120) * Math.PI * 2;
        const x0 = Math.cos(th0) * rSub;
        const z0 = Math.sin(th0) * rSub;
        const x1 = Math.cos(th1) * rSub;
        const z1 = Math.sin(th1) * rSub;
        verts.push(x0, 0.015, z0, 0.18, x1, 0.015, z1, 0.18);
      }
    }
  }

  return new Float32Array(verts);
}

interface MilestoneInfo {
  x: number;
  z: number;
  y: number;
  label: string;
  cat: string;
  hex: string;
  tNorm: number;
  timeStr: string;
  kindStr: string;
  detailStr: string;
}

interface TerrainMeta {
  maxAltitude: number;
  maxMetric: number;
  keyMilestones: MilestoneInfo[];
  curvedSlopeTrail: Array<[number, number, number]>;
  channelWaypoints: Array<{
    code: string;
    name: string;
    color: readonly [number, number, number];
    pos: [number, number, number];
    val: string;
  }>;
  startTime: number;
  endTime: number;
  sessionStart: number;
  live: boolean;
  dataPointCount: number;
  timeTicks: Array<{ fraction: number; label: string }>;
  seamMarks: Array<{ fraction: number; label: string }>;
}

export default function TerrainViewport({
  timeline,
  activeModel,
  sessionName,
  tabName,
  stats,
  mapKey = "",
  docked = false,
  hideDockedControls = false,
  colorMode,
  onExpand,
  onPopOut,
  onClose,
}: TerrainViewportProps) {
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const hudCanvasRef = useRef<HTMLCanvasElement>(null);
  const [realismState, setRealism] = useState<"mono" | "color">("color");
  const realism = colorMode ?? realismState;
  const realismRef = useRef<"mono" | "color">("color");
  realismRef.current = realism;

  const [baseShape, setBaseShapeState] = useState<BaseShape>(persistentBaseShape);
  const baseShapeRef = useRef<BaseShape>(persistentBaseShape);
  baseShapeRef.current = baseShape;

  const [scanSpeed, setScanSpeedState] = useState<ScanSpeed>(persistentScanSpeed);
  const scanSpeedRef = useRef<ScanSpeed>(persistentScanSpeed);

  const [showTrace, setShowTraceState] = useState<boolean>(persistentShowTrace);
  const showTraceRef = useRef<boolean>(persistentShowTrace);
  showTraceRef.current = showTrace;

  const [autoRotate, setAutoRotate] = useState<boolean>(true);
  const autoRotateRef = useRef<boolean>(true);

  // Chronological Scrubber & Playback state (1.0 = Latest / Full Terrain)
  const [scrubProgress, setScrubProgress] = useState<number>(1.0);
  const scrubProgressRef = useRef<number>(1.0);
  scrubProgressRef.current = scrubProgress;

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const isPlayingRef = useRef<boolean>(false);
  isPlayingRef.current = isPlaying;

  // Active hovered milestone for rich inspection card
  const [hoveredMilestone, setHoveredMilestone] = useState<{
    info: MilestoneInfo;
    screenX: number;
    screenY: number;
  } | null>(null);

  const setBaseShape = (next: BaseShape) => {
    persistentBaseShape = next;
    baseShapeRef.current = next;
    setBaseShapeState(next);
    if (next === "globe" && persistentCam.radius < 52) {
      persistentCam.radius = 54;
    } else if (next === "rect" && persistentCam.radius > 50) {
      persistentCam.radius = 46;
    }
    try {
      localStorage.setItem(STORAGE_KEY_BASE_SHAPE, next);
    } catch {}
  };

  const setScanSpeed = (next: ScanSpeed) => {
    persistentScanSpeed = next;
    scanSpeedRef.current = next;
    setScanSpeedState(next);
    try {
      localStorage.setItem(STORAGE_KEY_SCAN_SPEED, next);
    } catch {}
  };

  const setShowTrace = (next: boolean) => {
    persistentShowTrace = next;
    showTraceRef.current = next;
    setShowTraceState(next);
    try {
      localStorage.setItem(STORAGE_KEY_SHOW_TRACE, String(next));
    } catch {}
  };

  // Per-instance clock and pointer tracking to prevent clock starvation
  const clockRef = useRef({
    startTime: performance.now(),
    lastRenderTime: performance.now(),
    scanProgress: 0.0,
  });
  const isDraggingRef = useRef<boolean>(false);
  const lastXRef = useRef<number>(0);
  const lastYRef = useRef<number>(0);

  const statsRef = useRef(stats);
  statsRef.current = stats;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const dockedRef = useRef(docked);
  dockedRef.current = docked;

  // The map shows at most 30 minutes of compressed time. Long idle gaps are
  // already folded, so dragging moves across activity instead of empty terrain.
  const [followLive, setFollowLive] = useState(true);
  const [windowStart, setWindowStart] = useState(0);

  // A new tmux tab or a new agent transcript must not keep the previous
  // slice, replay head, or drag offset.
  useEffect(() => {
    setFollowLive(true);
    setWindowStart(0);
    setScrubProgress(1);
    scrubProgressRef.current = 1;
    setIsPlaying(false);
    isPlayingRef.current = false;
  }, [mapKey]);
  const windowTrackRef = useRef<HTMLDivElement>(null);
  const axis = activityAxis(timeline ?? [], stats);
  const axisRef = useRef(axis);
  axisRef.current = axis;
  const liveStart = windowStartFromFraction(0, axis.spanMs, 1);
  const view = mapWindow(axis, followLive ? liveStart : windowStart);
  const viewRef = useRef<TimeWindow>(view);
  viewRef.current = view;
  const liveRef = useRef(followLive);
  liveRef.current = followLive && view.end >= view.spanEnd - 1500;

  const terrainMetaRef = useRef<TerrainMeta>({
    maxAltitude: 4.0,
    maxMetric: 1,
    keyMilestones: [],
    curvedSlopeTrail: [],
    channelWaypoints: [],
    startTime: 0,
    endTime: 0,
    sessionStart: 0,
    live: true,
    dataPointCount: 0,
    timeTicks: [],
    seamMarks: [],
  });

  // Cached base particles for active baseShape
  const baseParticlesRef = useRef<BaseParticle[]>(generateBaseParticles(baseShape));
  const baseParticlesShapeRef = useRef<BaseShape>(baseShape);

  // WebGL handle refs
  const glRef = useRef<WebGL2RenderingContext | null>(null);
  const vaoTerrainRef = useRef<WebGLVertexArrayObject | null>(null);
  const bufTerrainPosRef = useRef<WebGLBuffer | null>(null);
  const bufTerrainColRef = useRef<WebGLBuffer | null>(null);
  const bufTerrainSeedRef = useRef<WebGLBuffer | null>(null);

  const vaoContoursRef = useRef<WebGLVertexArrayObject | null>(null);
  const bufContoursRef = useRef<WebGLBuffer | null>(null);
  const contoursCountRef = useRef<number>(0);

  const vaoBaseGridRef = useRef<WebGLVertexArrayObject | null>(null);
  const bufBaseGridRef = useRef<WebGLBuffer | null>(null);
  const baseGridCountRef = useRef<number>(0);

  const progTerrainRef = useRef<WebGLProgram | null>(null);
  const progContourRef = useRef<WebGLProgram | null>(null);

  const uTRef = useRef<Record<string, WebGLUniformLocation | null>>({});
  const uCRef = useRef<Record<string, WebGLUniformLocation | null>>({});

  useEffect(() => {
    if (docked) {
      autoRotateRef.current = true;
      setAutoRotate(true);
    } else {
      autoRotateRef.current = autoRotate;
    }
  }, [autoRotate, docked]);

  // Compute and update terrain geometry in WebGL buffers without freezing or restarting the render loop
  const updateGeometry = () => {
    const gl = glRef.current;
    if (!gl) return;

    const currentShape = baseShapeRef.current;
    if (baseParticlesShapeRef.current !== currentShape || baseParticlesRef.current.length === 0) {
      baseParticlesRef.current = generateBaseParticles(currentShape);
      baseParticlesShapeRef.current = currentShape;

      // Update seed buffer when base shape changes
      if (bufTerrainSeedRef.current) {
        const seedData = new Float32Array(baseParticlesRef.current.map((p) => p.seed));
        gl.bindBuffer(gl.ARRAY_BUFFER, bufTerrainSeedRef.current);
        gl.bufferData(gl.ARRAY_BUFFER, seedData, gl.STATIC_DRAW);
      }

      // Update base grid buffer
      if (bufBaseGridRef.current) {
        const gridVerts = generateBaseGridVerts(currentShape);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufBaseGridRef.current);
        gl.bufferData(gl.ARRAY_BUFFER, gridVerts, gl.STATIC_DRAW);
        baseGridCountRef.current = gridVerts.length / 4;
      }
    }

    const currentTimeline = timelineRef.current;
    const currentStats = statsRef.current;
    const view = viewRef.current;
    const axis = axisRef.current;
    const hasTimeline = !!currentTimeline && currentTimeline.length > 0;
    const winStart = hasTimeline ? view.start : 0;
    const winEnd = hasTimeline ? view.end : 0;
    const sessionStart = hasTimeline ? view.spanStart : 0;
    const compStart = view.compStart ?? 0;
    const compEnd = view.compEnd ?? 0;
    const compSpan = compEnd - compStart;

    // Columns sit on the compressed axis. A quiet minute inside a burst stays
    // flat. A gap longer than five minutes is a short seam, not a plain.
    const dataPoints: Array<{
      tNorm: number;
      user: number;
      think: number;
      reply: number;
      tool: number;
      timestamp?: number;
      topKind?: string;
      topLabel?: string;
    }> = [];
    const seamBands: Array<{ x0: number; x1: number }> = [];
    const timeTicks: Array<{ fraction: number; label: string }> = [];
    const seamMarks: Array<{ fraction: number; label: string }> = [];
    const xOfComp = (comp: number) => {
      const tNorm = compSpan <= 0 ? 0 : ((comp - compStart) / compSpan) * 2 - 1;
      return tNorm * (TIME_SPAN / 2 - 1.5);
    };
    if (hasTimeline && currentTimeline) {
      for (const pt of currentTimeline) {
        if (pt.user_count <= 0 && pt.think_count <= 0 && pt.reply_count <= 0 && pt.tool_count <= 0) continue;
        const comp = wallToCompressed(axis, pt.timestamp);
        if (comp < compStart || comp > compEnd) continue;
        const tNorm = compSpan <= 0 ? 0 : ((comp - compStart) / compSpan) * 2 - 1;
        dataPoints.push({
          tNorm,
          user: pt.user_count,
          think: pt.think_count,
          reply: pt.reply_count,
          tool: pt.tool_count,
          timestamp: pt.timestamp,
          topKind: pt.top_event_kind,
          topLabel: pt.top_event_label,
        });
      }
      for (const seam of axis.seams) {
        if (seam.compEnd <= compStart || seam.compStart >= compEnd) continue;
        seamBands.push({ x0: xOfComp(seam.compStart), x1: xOfComp(seam.compEnd) });
        const mid = (Math.max(seam.compStart, compStart) + Math.min(seam.compEnd, compEnd)) / 2;
        seamMarks.push({
          fraction: compSpan <= 0 ? 0.5 : (mid - compStart) / compSpan,
          label: seam.label,
        });
      }
      if (compSpan > 0 && sessionStart > 0) {
        for (const fraction of [0.25, 0.5, 0.75]) {
          const wall = compressedToWall(axis, compStart + fraction * compSpan);
          timeTicks.push({
            fraction,
            label: `+${formatElapsed(wall - sessionStart)}`,
          });
        }
      }
    } else {
      const count = 16;
      for (let i = 0; i < count; i++) {
        const t = (i / (count - 1)) * 2 - 1;
        const wave = Math.sin(i * 0.8) * 0.5 + 0.5;
        const user = currentStats?.user_prompts ?? 0;
        const think = currentStats?.thinking_blocks ?? 0;
        const reply = currentStats?.assistant_replies ?? 0;
        const tool = currentStats?.tool_calls ?? 0;
        if (user + think + reply + tool <= 0) break;
        dataPoints.push({
          tNorm: t,
          user: user * (0.3 + 0.7 * wave),
          think: think * (0.4 + 0.6 * (1 - wave)),
          reply: reply * (0.3 + 0.5 * wave),
          tool: tool * (0.2 + 0.8 * wave),
        });
      }
    }

    let maxMetric = 1;
    for (const pt of dataPoints) {
      maxMetric = Math.max(maxMetric, pt.user, pt.think, pt.reply, pt.tool);
    }
    const maxAltitude = Math.min(8.5, Math.max(4.0, 3.2 + Math.log10(Math.max(1, maxMetric)) * 1.5));
    const maxGaussianHeight = Math.max(1.0, maxAltitude - (currentShape === "globe" ? 1.7 : 0.35));
    const heightScale = (maxGaussianHeight * 0.96) / (Math.log1p(Math.max(1, maxMetric)) * 1.1);

    // Precompute Gaussian peak heights and positions across all 4 channels
    const prePeaks: Array<{
      x: number;
      h0: number;
      h1: number;
      h2: number;
      h3: number;
    }> = [];
    for (const pt of dataPoints) {
      const ptX = pt.tNorm * (TIME_SPAN / 2 - 1.5);
      prePeaks.push({
        x: ptX,
        h0: Math.log1p(pt.user) * 1.1 * heightScale,
        h1: Math.log1p(pt.think) * 0.95 * heightScale,
        h2: Math.log1p(pt.reply) * 1.05 * heightScale,
        h3: Math.log1p(pt.tool) * 0.85 * heightScale,
      });
    }

    // Fast height function with vectorized channel math
    const getAlt = (x: number, z: number): number => {
      const distNorm = getBaseDistNorm(x, z, currentShape);
      if (distNorm >= 1.0) return 0;

      let val = 0.12;
      if (currentShape === "globe") {
        val += Math.sqrt(Math.max(0, 1.0 - distNorm * distNorm)) * 1.6;
        val += 0.08 * Math.sin(x * 0.6) * Math.cos(z * 0.7);
      } else {
        val += 0.14 * Math.sin(x * 0.7 + 0.4) * Math.cos(z * 0.8);
        val += 0.07 * Math.sin(x * 1.8 - z * 1.2);
      }

      const zw0 = Math.exp(-((z - zLanes[0]) * (z - zLanes[0])) / 4.84);
      const zw1 = Math.exp(-((z - zLanes[1]) * (z - zLanes[1])) / 4.84);
      const zw2 = Math.exp(-((z - zLanes[2]) * (z - zLanes[2])) / 4.84);
      const zw3 = Math.exp(-((z - zLanes[3]) * (z - zLanes[3])) / 4.84);

      let ridges = 0;
      for (let p = 0; p < prePeaks.length; p++) {
        const peak = prePeaks[p];
        const dx = x - peak.x;
        const dx2 = dx * dx;
        if (dx2 > 25.0) continue;
        const xw = Math.exp(-dx2 / 2.56);
        ridges += xw * (peak.h0 * zw0 + peak.h1 * zw1 + peak.h2 * zw2 + peak.h3 * zw3);
      }
      let seamDamp = 1;
      for (let s = 0; s < seamBands.length; s++) {
        const band = seamBands[s];
        if (x < band.x0 || x > band.x1) continue;
        const half = Math.max(0.001, (band.x1 - band.x0) / 2);
        const along = Math.abs(x - (band.x0 + band.x1) / 2) / half;
        seamDamp = Math.min(seamDamp, along * along);
      }
      val += ridges * seamDamp;

      const edgeFalloff = smoothstep(1.0, 0.82, distNorm);
      return Math.max(0, val * edgeFalloff);
    };

    // 1. Grid Elevation Map
    const gridExtentX = currentShape === "globe" ? GLOBE_RADIUS : RECT_HX;
    const gridExtentZ = currentShape === "globe" ? GLOBE_RADIUS : RECT_HZ;
    const GRID_X = currentShape === "globe" ? 190 : 180;
    const GRID_Z = currentShape === "globe" ? 190 : 120;
    const stepX = (gridExtentX * 2) / (GRID_X - 1);
    const stepZ = (gridExtentZ * 2) / (GRID_Z - 1);
    const invStepX = 1 / stepX;
    const invStepZ = 1 / stepZ;
    const minX = -gridExtentX;
    const minZ = -gridExtentZ;

    const elevMap = new Float32Array(GRID_X * GRID_Z);
    for (let gz = 0; gz < GRID_Z; gz++) {
      const cz = -gridExtentZ + gz * stepZ;
      for (let gx = 0; gx < GRID_X; gx++) {
        const cx = -gridExtentX + gx * stepX;
        elevMap[gz * GRID_X + gx] = getAlt(cx, cz);
      }
    }

    // 2. High-Speed Particle Evaluation from elevMap
    const baseParticles = baseParticlesRef.current;
    const pCount = baseParticles.length;
    const posData = new Float32Array(pCount * 4);
    const colData = new Float32Array(pCount * 3);
    const summitThreshold = maxAltitude * 0.65;
    const summitRangeInv = 1 / Math.max(0.01, maxAltitude * 0.35);

    for (let i = 0; i < pCount; i++) {
      const p = baseParticles[i];
      const fx = (p.rx - minX) * invStepX;
      const fz = (p.rz - minZ) * invStepZ;
      const gx0 = clamp(Math.floor(fx), 0, GRID_X - 2);
      const gz0 = clamp(Math.floor(fz), 0, GRID_Z - 2);
      const tx = fx - gx0;
      const tz = fz - gz0;

      const i00 = gz0 * GRID_X + gx0;
      const i10 = i00 + 1;
      const i01 = i00 + GRID_X;
      const i11 = i01 + 1;

      const h00 = elevMap[i00];
      const h10 = elevMap[i10];
      const h01 = elevMap[i01];
      const h11 = elevMap[i11];

      const alt = (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
      const dx = (h00 - h10) * (1 - tz) + (h01 - h11) * tz;
      const dz = (h00 - h01) * (1 - tx) + (h10 - h11) * tx;
      const dy = stepX * 2;
      const len = Math.hypot(dx, dy, dz) || 1;
      const slopeShade = 0.32 + 0.68 * Math.max(0, (dx * LIGHT_DIR[0] + dy * LIGHT_DIR[1] + dz * LIGHT_DIR[2]) / len);

      let pr = p.r, pg = p.g, pb = p.b;
      if (alt > summitThreshold) {
        const summitMix = clamp((alt - summitThreshold) * summitRangeInv, 0, 1);
        const boost = 1.0 + 0.55 * summitMix;
        pr = Math.min(1.0, pr * boost);
        pg = Math.min(1.0, pg * boost);
        pb = Math.min(1.0, pb * boost);
      }

      const p4 = i * 4;
      posData[p4] = p.rx;
      posData[p4 + 1] = alt + p.jitterY;
      posData[p4 + 2] = p.rz;
      posData[p4 + 3] = p.shadeRand * slopeShade;

      const p3 = i * 3;
      colData[p3] = pr * slopeShade;
      colData[p3 + 1] = pg * slopeShade;
      colData[p3 + 2] = pb * slopeShade;
    }

    // 3. Fast Marching Squares with Range-Bounded Tier Scanning
    const contourVerts: number[] = [];
    const contourStep = maxAltitude / 96;
    const invContourStep = 1 / contourStep;
    const maxLvl = maxAltitude + 1.0;
    const cLevelsCount = Math.floor((maxLvl - 0.08) * invContourStep) + 1;

    for (let gz = 0; gz < GRID_Z - 1; gz++) {
      const z0 = -gridExtentZ + gz * stepZ;
      for (let gx = 0; gx < GRID_X - 1; gx++) {
        const x0 = -gridExtentX + gx * stepX;
        const idx = gz * GRID_X + gx;

        const c0 = elevMap[idx];
        const c1 = elevMap[idx + 1];
        const c2 = elevMap[idx + GRID_X + 1];
        const c3 = elevMap[idx + GRID_X];

        const minC = Math.min(c0, c1, c2, c3);
        const maxC = Math.max(c0, c1, c2, c3);
        if (maxC < 0.08 || minC > maxLvl) continue;

        const startLvlIdx = Math.max(0, Math.ceil((minC - 0.08) * invContourStep));
        const endLvlIdx = Math.min(cLevelsCount - 1, Math.floor((maxC - 0.08) * invContourStep));

        for (let lIdx = startLvlIdx; lIdx <= endLvlIdx; lIdx++) {
          const lvl = 0.08 + lIdx * contourStep;
          const yLvl = lvl + 0.015;
          const segs: Array<[number, number]> = [];

          if ((c0 > lvl) !== (c1 > lvl)) {
            const f = (lvl - c0) / (c1 - c0);
            segs.push([x0 + f * stepX, z0]);
          }
          if ((c1 > lvl) !== (c2 > lvl)) {
            const f = (lvl - c1) / (c2 - c1);
            segs.push([x0 + stepX, z0 + f * stepZ]);
          }
          if ((c3 > lvl) !== (c2 > lvl)) {
            const f = (lvl - c3) / (c2 - c3);
            segs.push([x0 + f * stepX, z0 + stepZ]);
          }
          if ((c0 > lvl) !== (c3 > lvl)) {
            const f = (lvl - c0) / (c3 - c0);
            segs.push([x0, z0 + f * stepZ]);
          }

          const isMajor = Math.abs((lvl / contourStep) % 5) < 0.5;
          const alpha = isMajor ? 0.48 : 0.22;

          for (let s = 0; s + 1 < segs.length; s += 2) {
            contourVerts.push(
              segs[s][0], yLvl, segs[s][1], alpha,
              segs[s + 1][0], yLvl, segs[s + 1][1], alpha
            );
          }
        }
      }
    }

    // 4. Milestone Waypoints and Catmull-Rom Spline Trail
    const keyMilestones: MilestoneInfo[] = [];

    dataPoints.forEach((pt, i) => {
      let timeStr = `T+${i + 1}`;
      if (pt.timestamp != null && sessionStart > 0) {
        timeStr = `+${formatElapsed(pt.timestamp - sessionStart)}`;
      } else if (!hasTimeline && currentStats?.total_events) {
        timeStr = `+${Math.floor(i * 1.5)}m`;
      }

      // Collect all active channels in this time slice (User -> Think -> Tool -> Reply)
      const activeChannels: Array<{ catIdx: number; count: number; kindStr: string; detailStr: string }> = [];
      if (pt.user > 0) {
        activeChannels.push({ catIdx: 0, count: pt.user, kindStr: "USER PROMPT", detailStr: `${Math.round(pt.user)} prompts` });
      }
      if (pt.think > 0) {
        activeChannels.push({ catIdx: 1, count: pt.think, kindStr: "REASONING", detailStr: `${Math.round(pt.think)} blocks` });
      }
      if (pt.tool > 0) {
        const toolLabel = (pt.topKind === "tool" ? pt.topLabel : "") || "RUNTIME";
        activeChannels.push({ catIdx: 3, count: pt.tool, kindStr: `TOOL: ${toolLabel}`, detailStr: `${Math.round(pt.tool)} calls` });
      }
      if (pt.reply > 0) {
        const replyLabel = (pt.topKind === "reply" ? pt.topLabel : "") || "ASSISTANT";
        activeChannels.push({ catIdx: 2, count: pt.reply, kindStr: `REPLY: ${replyLabel}`, detailStr: `${Math.round(pt.reply)} replies` });
      }

      // Synthetic history still gets a resting dot. A real quiet minute stays flat.
      if (activeChannels.length === 0) {
        if (pt.timestamp != null) return;
        const catIdx = pt.topKind === "tool" ? 3 : pt.topKind === "reply" ? 2 : pt.topKind === "think" ? 1 : 0;
        const tx = pt.tNorm * (TIME_SPAN / 2 - 1.5);
        const tz = zLanes[catIdx];
        const ty = getAlt(tx, tz) + 0.08;
        keyMilestones.push({
          x: tx,
          z: tz,
          y: ty,
          label: timeStr,
          cat: CHANNELS[catIdx].label,
          hex: CHANNELS[catIdx].hex,
          tNorm: pt.tNorm,
          timeStr,
          kindStr: CHANNELS[catIdx].label,
          detailStr: "Idle",
        });
      } else {
        const nChannels = activeChannels.length;
        const bucketSpanX = (TIME_SPAN / Math.max(1, dataPoints.length)) * 0.72;
        const baseTx = pt.tNorm * (TIME_SPAN / 2 - 1.5);

        activeChannels.forEach((ch, chIdx) => {
          const xOffset = nChannels > 1 ? ((chIdx / (nChannels - 1)) - 0.5) * bucketSpanX : 0;
          const tx = baseTx + xOffset;
          const tz = zLanes[ch.catIdx];
          const ty = getAlt(tx, tz) + 0.08;

          keyMilestones.push({
            x: tx,
            z: tz,
            y: ty,
            label: timeStr,
            cat: CHANNELS[ch.catIdx].label,
            hex: CHANNELS[ch.catIdx].hex,
            tNorm: pt.tNorm,
            timeStr,
            kindStr: ch.kindStr,
            detailStr: ch.detailStr,
          });
        });
      }
    });

    const curvedSlopeTrail: Array<[number, number, number]> = [];
    if (keyMilestones.length === 1) {
      const p = keyMilestones[0];
      curvedSlopeTrail.push([p.x, p.y, p.z]);
    } else if (keyMilestones.length > 1) {
      const n = keyMilestones.length;
      for (let i = 0; i < n - 1; i++) {
        const p0 = keyMilestones[Math.max(0, i - 1)];
        const p1 = keyMilestones[i];
        const p2 = keyMilestones[i + 1];
        const p3 = keyMilestones[Math.min(n - 1, i + 2)];

        const dist = Math.hypot(p2.x - p1.x, p2.z - p1.z);
        const steps = Math.max(16, Math.ceil(dist * 8));

        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          const t2 = t * t;
          const t3 = t2 * t;

          const cx = 0.5 * (
            (2 * p1.x) +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
          );
          const cz = 0.5 * (
            (2 * p1.z) +
            (-p0.z + p2.z) * t +
            (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
            (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3
          );

          const cy = getAlt(cx, cz) + 0.08;
          curvedSlopeTrail.push([cx, cy, cz]);
        }
      }
      const last = keyMilestones[n - 1];
      curvedSlopeTrail.push([last.x, last.y, last.z]);
    }

    const channelWaypoints = CHANNELS.map((ch, idx) => {
      const zPos = zLanes[idx];
      let bestX = 0, bestY = 0;
      for (let x = -12; x <= 12; x += 0.5) {
        const y = getAlt(x, zPos);
        if (y > bestY) {
          bestY = y;
          bestX = x;
        }
      }
      return {
        code: ch.key.toUpperCase(),
        name: ch.label,
        color: ch.color,
        pos: [bestX, bestY, zPos] as [number, number, number],
        val: idx === 0 ? `${currentStats?.user_prompts ?? 0} PROMPTS`
           : idx === 1 ? `${currentStats?.thinking_blocks ?? 0} TURNS`
           : idx === 2 ? `${currentStats?.assistant_replies ?? 0} REPLIES`
           : `${currentStats?.tool_calls ?? 0} CALLS`,
      };
    });

    // Upload newly calculated data to existing WebGL buffers
    if (bufTerrainPosRef.current) {
      gl.bindBuffer(gl.ARRAY_BUFFER, bufTerrainPosRef.current);
      gl.bufferData(gl.ARRAY_BUFFER, posData, gl.DYNAMIC_DRAW);
    }
    if (bufTerrainColRef.current) {
      gl.bindBuffer(gl.ARRAY_BUFFER, bufTerrainColRef.current);
      gl.bufferData(gl.ARRAY_BUFFER, colData, gl.DYNAMIC_DRAW);
    }
    if (bufContoursRef.current) {
      const f32Contours = new Float32Array(contourVerts);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufContoursRef.current);
      gl.bufferData(gl.ARRAY_BUFFER, f32Contours, gl.DYNAMIC_DRAW);
      contoursCountRef.current = contourVerts.length / 4;
    }

    terrainMetaRef.current = {
      maxAltitude,
      maxMetric,
      keyMilestones,
      curvedSlopeTrail,
      channelWaypoints,
      startTime: winStart,
      endTime: winEnd,
      sessionStart,
      live: liveRef.current,
      dataPointCount: dataPoints.length,
      timeTicks,
      seamMarks,
    };
  };

  // Coalesce and throttle geometry recalculation so streaming events don't stutter
  const pendingUpdateRef = useRef<number | null>(null);
  const lastUpdateTimeRef = useRef<number>(0);

  const scheduleGeometryUpdate = () => {
    const now = performance.now();
    const elapsed = now - lastUpdateTimeRef.current;
    if (elapsed > 120) {
      if (pendingUpdateRef.current !== null) {
        window.clearTimeout(pendingUpdateRef.current);
        pendingUpdateRef.current = null;
      }
      lastUpdateTimeRef.current = now;
      updateGeometry();
    } else if (pendingUpdateRef.current === null) {
      pendingUpdateRef.current = window.setTimeout(() => {
        pendingUpdateRef.current = null;
        lastUpdateTimeRef.current = performance.now();
        updateGeometry();
      }, 120 - elapsed);
    }
  };

  // Rebuild when the visible window moves, not only when the column count changes.
  const dataSignature = `${mapKey}:${timeline?.length ?? 0}:${stats?.total_events ?? 0}:${stats?.user_prompts ?? 0}:${stats?.thinking_blocks ?? 0}:${stats?.assistant_replies ?? 0}:${stats?.tool_calls ?? 0}:${stats?.timeline_start ?? 0}:${stats?.timeline_end ?? 0}:${Math.round(view.compStart ?? view.start)}:${Math.round(view.compEnd ?? view.end)}:${Math.round(axis.spanMs)}:${axis.seams.length}:${baseShape}`;
  useEffect(() => {
    scheduleGeometryUpdate();
  }, [dataSignature]);

  // Main WebGL & Render Loop Lifecycle (mounts once and stays continuous)
  useEffect(() => {
    const glCanvas = glCanvasRef.current;
    const hudCanvas = hudCanvasRef.current;
    if (!glCanvas || !hudCanvas) return;

    const gl = glCanvas.getContext("webgl2", { antialias: true, alpha: false });
    const hud = hudCanvas.getContext("2d");
    if (!gl || !hud) return;
    glRef.current = gl;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(s));
      }
      return s;
    };

    const link = (vs: string, fs: string) => {
      const p = gl.createProgram()!;
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      return p;
    };

    const progTerrain = link(VS_TERRAIN, FS_TERRAIN);
    const progContour = link(VS_CONTOUR, FS_CONTOUR);
    progTerrainRef.current = progTerrain;
    progContourRef.current = progContour;

    const uT = {
      uVP: gl.getUniformLocation(progTerrain, "uVP"),
      uTime: gl.getUniformLocation(progTerrain, "uTime"),
      uFocus: gl.getUniformLocation(progTerrain, "uFocus"),
      uAperture: gl.getUniformLocation(progTerrain, "uAperture"),
      uDpr: gl.getUniformLocation(progTerrain, "uDpr"),
      uGain: gl.getUniformLocation(progTerrain, "uGain"),
      uScanX: gl.getUniformLocation(progTerrain, "uScanX"),
      uMaxX: gl.getUniformLocation(progTerrain, "uMaxX"),
      uReal: gl.getUniformLocation(progTerrain, "uReal"),
    };
    uTRef.current = uT;

    const uC = {
      uVP: gl.getUniformLocation(progContour, "uVP"),
      uCam: gl.getUniformLocation(progContour, "uCam"),
      uScanX: gl.getUniformLocation(progContour, "uScanX"),
      uScanAmount: gl.getUniformLocation(progContour, "uScanAmount"),
      uMaxX: gl.getUniformLocation(progContour, "uMaxX"),
      uColor: gl.getUniformLocation(progContour, "uColor"),
    };
    uCRef.current = uC;

    // Initialize Terrain VAO & Buffers
    const vaoTerrain = gl.createVertexArray()!;
    gl.bindVertexArray(vaoTerrain);
    vaoTerrainRef.current = vaoTerrain;

    const bPos = gl.createBuffer()!;
    bufTerrainPosRef.current = bPos;
    gl.bindBuffer(gl.ARRAY_BUFFER, bPos);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);

    const bCol = gl.createBuffer()!;
    bufTerrainColRef.current = bCol;
    gl.bindBuffer(gl.ARRAY_BUFFER, bCol);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    const bSeed = gl.createBuffer()!;
    bufTerrainSeedRef.current = bSeed;
    gl.bindBuffer(gl.ARRAY_BUFFER, bSeed);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);

    const seedData = new Float32Array(baseParticlesRef.current.map((p) => p.seed));
    gl.bufferData(gl.ARRAY_BUFFER, seedData, gl.STATIC_DRAW);

    gl.bindVertexArray(null);

    // Initialize Contours VAO & Buffer
    const vaoContours = gl.createVertexArray()!;
    const bufContours = gl.createBuffer()!;
    vaoContoursRef.current = vaoContours;
    bufContoursRef.current = bufContours;
    gl.bindVertexArray(vaoContours);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufContours);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
    gl.bindVertexArray(null);

    // Initialize Base Grid VAO & Buffer
    const vaoBaseGrid = gl.createVertexArray()!;
    const bufBaseGrid = gl.createBuffer()!;
    vaoBaseGridRef.current = vaoBaseGrid;
    bufBaseGridRef.current = bufBaseGrid;
    gl.bindVertexArray(vaoBaseGrid);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufBaseGrid);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
    const initialGrid = generateBaseGridVerts(baseShapeRef.current);
    gl.bufferData(gl.ARRAY_BUFFER, initialGrid, gl.STATIC_DRAW);
    baseGridCountRef.current = initialGrid.length / 4;
    gl.bindVertexArray(null);

    // Generate initial geometry
    updateGeometry();

    // Continuous 60 FPS Render Loop
    let animId: number;
    let fps = 60;
    let lastFpsTime = performance.now();
    let frameCount = 0;

    const render = () => {
      animId = requestAnimationFrame(render);

      const now = performance.now();
      const interval = 1000 / 60;
      const delta = now - clockRef.current.lastRenderTime;

      if (delta < interval - 2.0) {
        return;
      }
      clockRef.current.lastRenderTime = now - (delta % interval);

      const dt = delta / 1000;
      const elapsed = (now - clockRef.current.startTime) / 1000;
      const cam = persistentCam;

      frameCount++;
      if (now - lastFpsTime >= 500) {
        fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
        frameCount = 0;
        lastFpsTime = now;
      }

      if (autoRotateRef.current && !isDraggingRef.current) {
        cam.azimuth += 0.08 * Math.min(dt, 0.1);
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = glCanvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));

      if (glCanvas.width !== w || glCanvas.height !== h) {
        glCanvas.width = w;
        glCanvas.height = h;
        hudCanvas.width = w;
        hudCanvas.height = h;
      }

      gl.viewport(0, 0, w, h);
      gl.clearColor(0.012, 0.012, 0.014, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      // The dock shares this camera. A 40/46 scale fills the short mini-map without
      // moving the fullscreen orbit.
      const orbitRadius = dockedRef.current ? cam.radius * (40 / 46) : cam.radius;
      const eyeX = cam.target[0] + orbitRadius * Math.cos(cam.elevation) * Math.sin(cam.azimuth);
      const eyeY = cam.target[1] + orbitRadius * Math.sin(cam.elevation);
      const eyeZ = cam.target[2] + orbitRadius * Math.cos(cam.elevation) * Math.cos(cam.azimuth);

      const matProj = perspective(38 * (Math.PI / 180), w / h, 0.5, 260.0);
      const matView = lookAt([eyeX, eyeY, eyeZ], cam.target);
      const matVP = multiply(matProj, matView);

      const speedSetting = scanSpeedRef.current;
      const speedMultiplier = speedSetting === "paused" ? 0 : speedSetting === "0.25x" ? 0.25 : speedSetting === "0.5x" ? 0.5 : speedSetting === "2x" ? 2.0 : 1.0;

      // Handle playback mode if active
      if (isPlayingRef.current) {
        let nextScrub = scrubProgressRef.current + (dt * speedMultiplier) / 14.0;
        if (nextScrub >= 1.0) {
          nextScrub = 1.0;
          setIsPlaying(false);
          isPlayingRef.current = false;
        }
        scrubProgressRef.current = nextScrub;
        setScrubProgress(nextScrub);
      }

      const meta = terrainMetaRef.current;
      const maxAltitude = meta.maxAltitude;

      // X-axis sweep: past (-extentX) to present (+extentX)
      const currentShape = baseShapeRef.current;
      const extentX = currentShape === "globe" ? GLOBE_RADIUS : RECT_HX;
      // When at or near 100%, expand curMaxX beyond geometry so no edge particles or contour lines are clipped
      const curMaxX = scrubProgressRef.current >= 0.98
        ? extentX + 2.0
        : (scrubProgressRef.current * 2 - 1) * extentX;

      if (speedMultiplier > 0 && !isPlayingRef.current) {
        clockRef.current.scanProgress = (clockRef.current.scanProgress + (dt * speedMultiplier) / 7.0) % 1.0;
      }
      const scanPhase = clockRef.current.scanProgress;
      const scanXPos = -extentX + scanPhase * (curMaxX - (-extentX));
      const scanFade = speedMultiplier === 0 ? 0.8 : smoothstep(1.0, 0.92, scanPhase) * smoothstep(0.0, 0.04, scanPhase);

      const isMono = realismRef.current === "mono";

      // Draw Grid Lines (Base perimeter and grid lines are always fully visible and never sliced by time scrubber)
      gl.useProgram(progContour);
      gl.uniformMatrix4fv(uC.uVP, false, matVP);
      gl.uniform3f(uC.uCam, eyeX, eyeY, eyeZ);
      gl.uniform1f(uC.uScanX, scanXPos);
      gl.uniform1f(uC.uScanAmount, 0);
      gl.uniform1f(uC.uMaxX, 999.0);
      gl.uniform3f(uC.uColor, 1.0, 1.0, 1.0);
      gl.bindVertexArray(vaoBaseGrid);
      gl.drawArrays(gl.LINES, 0, baseGridCountRef.current);

      // Draw Marching Squares Contours
      if (contoursCountRef.current > 0) {
        gl.uniform1f(uC.uScanAmount, 3.0 * scanFade);
        gl.uniform1f(uC.uMaxX, curMaxX);
        gl.uniform3f(uC.uColor, isMono ? 1.0 : 0.78, isMono ? 1.0 : 1.0, isMono ? 1.0 : 0.94);
        gl.bindVertexArray(vaoContours);
        gl.drawArrays(gl.LINES, 0, contoursCountRef.current);
      }

      // Draw 50k Particles
      gl.useProgram(progTerrain);
      gl.uniformMatrix4fv(uT.uVP, false, matVP);
      gl.uniform1f(uT.uTime, elapsed);
      gl.uniform1f(uT.uFocus, orbitRadius * 0.9);
      gl.uniform1f(uT.uAperture, 0.5 * (h / 700));
      gl.uniform1f(uT.uDpr, dpr);
      gl.uniform1f(uT.uGain, 0.44);
      gl.uniform1f(uT.uScanX, scanXPos);
      gl.uniform1f(uT.uMaxX, curMaxX);
      gl.uniform1f(uT.uReal, isMono ? 0.0 : 1.0);

      gl.bindVertexArray(vaoTerrain);
      gl.drawArrays(gl.POINTS, 0, POINT_COUNT);
      gl.bindVertexArray(null);

      // 2D HUD Canvas Overlay
      hud.setTransform(dpr, 0, 0, dpr, 0, 0);
      hud.clearRect(0, 0, rect.width, rect.height);

      const project = (p: [number, number, number]) => projectPoint(matVP, p, rect.width, rect.height);

      // (A) Glowing Chronological Agent Journey Trail (Clipped to scrubProgress)
      if (showTraceRef.current) {
        hud.lineJoin = "round";
        hud.lineCap = "round";

        // Outer golden aura (subtle, thin glow)
        hud.strokeStyle = "rgba(255, 175, 45, 0.22)";
        hud.lineWidth = 2.0;
        hud.beginPath();
        let first = true;
        for (const pos of meta.curvedSlopeTrail) {
          if (pos[0] > curMaxX + 0.1) break;
          const sc = project(pos);
          if (!sc) { first = true; continue; }
          if (first) { hud.moveTo(sc[0], sc[1]); first = false; }
          else { hud.lineTo(sc[0], sc[1]); }
        }
        hud.stroke();

        // Sharp bright core (refined, delicate tracing line)
        hud.strokeStyle = "rgba(255, 205, 65, 0.95)";
        hud.lineWidth = 0.75;
        hud.beginPath();
        first = true;
        for (const pos of meta.curvedSlopeTrail) {
          if (pos[0] > curMaxX + 0.1) break;
          const sc = project(pos);
          if (!sc) { first = true; continue; }
          if (first) { hud.moveTo(sc[0], sc[1]); first = false; }
          else { hud.lineTo(sc[0], sc[1]); }
        }
        hud.stroke();

        // Render visible milestones with glowing beacons (clean, uncluttered nodes; hover reveals time card)
        for (const m of meta.keyMilestones) {
          if (m.x > curMaxX + 0.2) continue;
          const sc = project([m.x, m.y, m.z]);
          if (!sc) continue;

          hud.fillStyle = m.hex;
          hud.beginPath();
          hud.arc(sc[0], sc[1], 1.8, 0, Math.PI * 2);
          hud.fill();

          hud.strokeStyle = "rgba(255, 255, 255, 0.85)";
          hud.lineWidth = 0.75;
          hud.beginPath();
          hud.arc(sc[0], sc[1], 3.2, 0, Math.PI * 2);
          hud.stroke();
        }
      }

      // (A.1) Chronological Time Sweep Laser / Playhead line across the terrain
      const pScanTop = project([scanXPos, maxAltitude * 1.05, 0]);
      const pScanBottom = project([scanXPos, 0, 0]);
      if (pScanTop && pScanBottom) {
        hud.strokeStyle = `rgba(255, 220, 100, ${0.40 * scanFade})`;
        hud.lineWidth = 0.75;
        hud.beginPath();
        hud.moveTo(pScanTop[0], pScanTop[1]);
        hud.lineTo(pScanBottom[0], pScanBottom[1]);
        hud.stroke();
      }

      // (B) 3D Axis Labels: TIME (X), LABEL (Z), VALUE (Y)
      hud.save();
      const mini = dockedRef.current;
      hud.font = mini
        ? "8px ui-monospace, SFMono-Regular, Menlo, monospace"
        : "8.5px ui-monospace, SFMono-Regular, Menlo, monospace";

      const extentZ = currentShape === "globe" ? GLOBE_RADIUS : RECT_HZ;
      const tStartX = extentX * 0.92;
      const tStartZ = -(extentZ + 1.6);
      const tStart = project([-tStartX, 0, tStartZ]);
      const tEnd = project([tStartX, 0, tStartZ]);
      // Compact bounds only when the mini canvas is tall enough to read them.
      const showTimeBounds = !mini || rect.height >= 110;
      if (showTimeBounds && tStart && tEnd) {
        const timed = meta.sessionStart > 0 && meta.endTime > meta.startTime;
        hud.fillStyle = "rgba(255, 255, 255, 0.75)";
        if (mini) {
          hud.textAlign = "left";
          hud.fillText(
            timed ? `+${formatElapsed(meta.startTime - meta.sessionStart)}` : "+0:00",
            tStart[0],
            tStart[1],
          );
          hud.textAlign = "right";
          hud.fillText("NOW", tEnd[0], tEnd[1]);
        } else {
          hud.textAlign = "left";
          hud.fillText(
            timed ? `◄ +${formatElapsed(meta.startTime - meta.sessionStart)}` : "◄ CHRONO TIME: 00:00 (START)",
            tStart[0],
            tStart[1],
          );
          hud.textAlign = "right";
          hud.fillText(
            timed
              ? `+${formatElapsed(meta.endTime - meta.sessionStart)}${meta.live ? " NOW" : ""} ►`
              : "LATEST EVENT (NOW) ►",
            tEnd[0],
            tEnd[1],
          );
        }
      }

      if (!mini) {
        // Clock ticks follow the compressed axis, so a seam does not stretch them.
        for (const tick of meta.timeTicks) {
          const xTick = -tStartX + tick.fraction * (tStartX * 2);
          const ptTick = project([xTick, 0, tStartZ]);
          if (!ptTick) continue;
          hud.fillStyle = "rgba(255, 255, 255, 0.4)";
          hud.textAlign = "center";
          hud.fillText(tick.label, ptTick[0], ptTick[1]);
        }

        for (const seam of meta.seamMarks) {
          const xSeam = -tStartX + seam.fraction * (tStartX * 2);
          const ptSeam = project([xSeam, 0, tStartZ]);
          if (!ptSeam) continue;
          hud.strokeStyle = "rgba(255, 196, 96, 0.9)";
          hud.lineWidth = 1;
          hud.beginPath();
          hud.moveTo(ptSeam[0], ptSeam[1]);
          hud.lineTo(ptSeam[0], ptSeam[1] - 10);
          hud.stroke();
          hud.fillStyle = "#ff9a3c";
          hud.textAlign = "center";
          hud.fillText(seam.label, ptSeam[0], ptSeam[1] - 14);
        }
      }

      const chLabelX = -(extentX + 0.8);
      CHANNELS.forEach((ch, idx) => {
        const sc = project([chLabelX, 0, zLanes[idx]]);
        if (sc) {
          hud.fillStyle = ch.hex;
          hud.textAlign = "right";
          hud.fillText(mini ? CHANNEL_TAGS[idx] : `[${ch.key.toUpperCase()}] ${ch.label}`, sc[0] - 6, sc[1]);
        }
      });
      hud.restore();

      // Waypoint pins and the altitude ruler cover a short docked canvas.
      if (!dockedRef.current) {
      // (C) Waypoint Target Pins with Leader Lines
      for (const node of meta.channelWaypoints) {
        const groundPt = project(node.pos);
        const pinPt = project([node.pos[0], node.pos[1] + 2.6, node.pos[2]]);
        if (!groundPt || !pinPt) continue;

        const rgbStr = `rgb(${Math.round(node.color[0] * 255)}, ${Math.round(node.color[1] * 255)}, ${Math.round(node.color[2] * 255)})`;

        hud.strokeStyle = rgbStr;
        hud.globalAlpha = 0.50;
        hud.lineWidth = 1;
        hud.beginPath();
        const rRad = 0.40;
        for (let st = 0; st <= 20; st++) {
          const th = (st / 20) * Math.PI * 2;
          const rP = project([node.pos[0] + Math.cos(th) * rRad, node.pos[1], node.pos[2] + Math.sin(th) * rRad]);
          if (rP) {
            st === 0 ? hud.moveTo(rP[0], rP[1]) : hud.lineTo(rP[0], rP[1]);
          }
        }
        hud.stroke();

        hud.globalAlpha = 0.95;
        hud.beginPath();
        hud.moveTo(groundPt[0], groundPt[1]);
        hud.lineTo(pinPt[0], pinPt[1] + 6);
        hud.stroke();

        hud.beginPath();
        hud.arc(pinPt[0], pinPt[1], 6, 0, Math.PI * 2);
        hud.stroke();

        hud.fillStyle = rgbStr;
        hud.beginPath();
        hud.arc(pinPt[0], pinPt[1], 1.8, 0, Math.PI * 2);
        hud.fill();

        hud.font = '8.5px ui-monospace, SFMono-Regular, Menlo, monospace';
        hud.textAlign = 'left';
        hud.textBaseline = 'alphabetic';
        const titleText = `[${node.code}] ${node.name}`;
        const valText = `${node.val}`;
        const textWidth = Math.max(hud.measureText(titleText).width, hud.measureText(valText).width);
        const badgeW = textWidth + 12;
        const badgeH = 26;
        const badgeX = pinPt[0] + 8 + badgeW > rect.width - 10 ? pinPt[0] - badgeW - 8 : pinPt[0] + 8;
        const badgeY = pinPt[1] - 14;

        hud.fillStyle = "rgba(8, 10, 14, 0.88)";
        hud.fillRect(badgeX, badgeY, badgeW, badgeH);
        hud.strokeStyle = "rgba(255, 255, 255, 0.18)";
        hud.lineWidth = 1;
        hud.strokeRect(badgeX, badgeY, badgeW, badgeH);

        hud.fillStyle = rgbStr;
        hud.fillText(titleText, badgeX + 6, badgeY + 10);

        hud.fillStyle = "rgba(255, 255, 255, 0.85)";
        hud.fillText(valText, badgeX + 6, badgeY + 21);
      }

      // (D) Left Y-Axis Altitude Ruler (VALUE AXIS)
      const rulerTop = 70;
      const rulerBottom = rect.height - 50;
      const rY = (val: number) => rulerBottom - (val / maxAltitude) * (rulerBottom - rulerTop);

      hud.strokeStyle = "rgba(255, 255, 255, 0.3)";
      hud.fillStyle = "rgba(255, 255, 255, 0.35)";
      hud.lineWidth = 1;
      hud.beginPath();
      hud.moveTo(14, rulerTop);
      hud.lineTo(14, rulerBottom);

      const rStep = maxAltitude <= 5.0 ? 1.0 : 2.0;
      for (let v = 0; v <= maxAltitude + 0.1; v += rStep / 2) {
        const y = rY(v);
        hud.moveTo(14, y);
        hud.lineTo(Math.abs(v % rStep) < 0.1 ? 24 : 18, y);
      }
      hud.stroke();

      hud.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
      hud.textAlign = 'left';
      hud.fillText("VALUE ▲", 14, rulerTop - 8);

      const topMetricVal = Math.round(meta.maxMetric);
      for (let v = 0; v <= maxAltitude + 0.1; v += rStep) {
        const metricEquivalent = Math.round((v / maxAltitude) * topMetricVal);
        hud.fillText(`${metricEquivalent}`, 28, rY(v));
      }

      const cursorY = rY(clamp(scanPhase * maxAltitude, 0, maxAltitude));
      hud.fillStyle = `rgba(255, 255, 255, ${0.40 + 0.60 * scanFade})`;
      hud.beginPath();
      hud.moveTo(14, cursorY);
      hud.lineTo(8, cursorY - 4);
      hud.lineTo(8, cursorY + 4);
      hud.closePath();
      hud.fill();
      }

      // (F) Bottom Right Telemetry Readout
      if (!dockedRef.current && rect.width >= 550) {
        hud.textAlign = 'right';
        hud.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
        hud.fillStyle = 'rgba(255, 255, 255, 0.40)';
        hud.fillText(`SWEEP X ${scanXPos.toFixed(1)}   EVENTS ${statsRef.current?.total_events ?? timelineRef.current?.length ?? 0}   ${fps} FPS`, rect.width - 16, rect.height - 12);
      }
    };

    animId = requestAnimationFrame(render);

    const handleDown = (e: PointerEvent) => {
      isDraggingRef.current = true;
      lastXRef.current = e.clientX;
      lastYRef.current = e.clientY;
      glCanvas.setPointerCapture(e.pointerId);
    };

    const handleMove = (e: PointerEvent) => {
      if (isDraggingRef.current) {
        const dx = e.clientX - lastXRef.current;
        const dy = e.clientY - lastYRef.current;
        lastXRef.current = e.clientX;
        lastYRef.current = e.clientY;

        persistentCam.azimuth -= dx * 0.005;
        persistentCam.elevation = clamp(persistentCam.elevation + dy * 0.004, 0.06, 1.35);
        if (hoveredMilestone) setHoveredMilestone(null);
        return;
      }

      // Check hover proximity to milestones
      const rect = glCanvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const cam = persistentCam;
      const orbitRadius = dockedRef.current ? cam.radius * (40 / 46) : cam.radius;
      const eyeX = cam.target[0] + orbitRadius * Math.cos(cam.elevation) * Math.sin(cam.azimuth);
      const eyeY = cam.target[1] + orbitRadius * Math.sin(cam.elevation);
      const eyeZ = cam.target[2] + orbitRadius * Math.cos(cam.elevation) * Math.cos(cam.azimuth);
      const matProj = perspective(38 * (Math.PI / 180), rect.width / rect.height, 0.5, 260.0);
      const matView = lookAt([eyeX, eyeY, eyeZ], cam.target);
      const matVP = multiply(matProj, matView);

      let found: { info: MilestoneInfo; screenX: number; screenY: number } | null = null;
      if (showTraceRef.current) {
        const extentX = baseShapeRef.current === "globe" ? GLOBE_RADIUS : RECT_HX;
        const curMaxX = scrubProgressRef.current >= 0.98
          ? extentX + 2.0
          : (scrubProgressRef.current * 2 - 1) * extentX;

        for (const m of terrainMetaRef.current.keyMilestones) {
          if (m.x > curMaxX + 0.2) continue;
          const pt = projectPoint(matVP, [m.x, m.y, m.z], rect.width, rect.height);
          if (pt) {
            const dist = Math.hypot(pt[0] - mouseX, pt[1] - mouseY);
            if (dist < 18) {
              found = { info: m, screenX: pt[0], screenY: pt[1] };
              break;
            }
          }
        }
      }
      setHoveredMilestone(found);
    };

    const handleUp = (e: PointerEvent) => {
      isDraggingRef.current = false;
      try {
        glCanvas.releasePointerCapture(e.pointerId);
      } catch {}
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      persistentCam.radius = clamp(persistentCam.radius * Math.exp(e.deltaY * 0.001), 14, 90);
    };

    const handleDblClick = () => {
      persistentCam.azimuth = 0.38;
      persistentCam.elevation = 0.48;
      persistentCam.radius = baseShapeRef.current === "globe" ? 54 : 46;
    };

    glCanvas.addEventListener("pointerdown", handleDown);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    glCanvas.addEventListener("wheel", handleWheel, { passive: false });
    glCanvas.addEventListener("dblclick", handleDblClick);

    return () => {
      cancelAnimationFrame(animId);
      if (pendingUpdateRef.current !== null) {
        window.clearTimeout(pendingUpdateRef.current);
        pendingUpdateRef.current = null;
      }
      glCanvas.removeEventListener("pointerdown", handleDown);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      glCanvas.removeEventListener("wheel", handleWheel);
      glCanvas.removeEventListener("dblclick", handleDblClick);

      gl.deleteProgram(progTerrain);
      gl.deleteProgram(progContour);
      gl.deleteVertexArray(vaoTerrain);
      gl.deleteVertexArray(vaoContours);
      gl.deleteVertexArray(vaoBaseGrid);
      gl.deleteBuffer(bPos);
      gl.deleteBuffer(bCol);
      gl.deleteBuffer(bSeed);
      gl.deleteBuffer(bufContours);
      gl.deleteBuffer(bufBaseGrid);

      glRef.current = null;
      vaoTerrainRef.current = null;
      bufTerrainPosRef.current = null;
      bufTerrainColRef.current = null;
      bufTerrainSeedRef.current = null;
      vaoContoursRef.current = null;
      bufContoursRef.current = null;
      vaoBaseGridRef.current = null;
      bufBaseGridRef.current = null;
    };
  }, []);

  if (docked) {
    return (
      <section className="scifi-panel viewport docked" aria-label="Auto-rotating area map">
        <canvas ref={glCanvasRef} id="terrain" className="scifi-terrain-canvas" />
        <canvas ref={hudCanvasRef} id="terrain-hud" className="scifi-hud-canvas" />
        <div className="docked-terrain-badge">
          ◈ AREA MAP
        </div>
        {!hideDockedControls && (
        <div className="docked-terrain-controls">
          {onExpand && (
            <button
              type="button"
              className="docked-terrain-btn"
              onClick={onExpand}
              title="Expand to Fullscreen Telemetry HUD"
              aria-label="Expand to Fullscreen Telemetry HUD"
            >
              ⤢
            </button>
          )}
          {onPopOut && (
            <button
              type="button"
              className="docked-terrain-btn"
              onClick={onPopOut}
              title="Open Stats in a separate desktop window"
              aria-label="Open Stats in a separate window"
            >
              ⧉
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className="docked-terrain-btn"
              onClick={onClose}
              title="Close Docked Area Map"
              aria-label="Close Docked Area Map"
            >
              ✕
            </button>
          )}
        </div>
        )}
      </section>
    );
  }

  return (
    <section className="scifi-panel viewport">
      <canvas ref={glCanvasRef} id="terrain" className="scifi-terrain-canvas" />
      <canvas ref={hudCanvasRef} id="terrain-hud" className="scifi-hud-canvas" />
      <header>
        <span className="tag">01</span>
        <span>TOPOGRAPHICAL TELEMETRY SPECTRUM</span>
        <small>{activeModel || (sessionName ? `${sessionName} // ${tabName ?? "OUTPUT"}` : "QUANTUM RELIEF")}</small>
      </header>

      <div className="scifi-viewport-hint">
        DRAG · ORBIT &nbsp;&nbsp; WHEEL · ZOOM &nbsp;&nbsp; DBL-CLICK · RESET
      </div>

      <div className="scifi-viewport-toolbar">
        <div className="scifi-viewport-mode">
          <button
            type="button"
            className={realism === "mono" ? "on" : ""}
            onClick={() => setRealism("mono")}
          >
            MONO
          </button>
          <button
            type="button"
            className={realism === "color" ? "on" : ""}
            onClick={() => setRealism("color")}
          >
            SPECTRAL
          </button>
        </div>

        <div className="scifi-viewport-mode" title="Area Map Base Platform Shape">
          <button
            type="button"
            className={baseShape === "rect" ? "on" : ""}
            onClick={() => setBaseShape("rect")}
            title="Rectangular Cartesian matrix base"
          >
            RECT
          </button>
          <button
            type="button"
            className={baseShape === "globe" ? "on" : ""}
            onClick={() => setBaseShape("globe")}
            title="Circular planetary dome base"
          >
            GLOBE
          </button>
        </div>

        <select
          className="scifi-select"
          value={scanSpeed}
          onChange={(e) => setScanSpeed(e.target.value as ScanSpeed)}
          title="Timeline Chrono Sweep Speed"
          aria-label="Timeline Chrono Sweep Speed"
        >
          <option value="0.25x">SWEEP: 0.25x</option>
          <option value="0.5x">SWEEP: 0.5x</option>
          <option value="1x">SWEEP: 1x (NORM)</option>
          <option value="2x">SWEEP: 2x (FAST)</option>
          <option value="paused">SWEEP: PAUSED</option>
        </select>

        <button
          type="button"
          className={`scifi-btn-toggle ${autoRotate ? "on" : ""}`}
          onClick={() => {
            const next = !autoRotate;
            setAutoRotate(next);
            autoRotateRef.current = next;
          }}
          title={autoRotate ? "Click to pause auto-rotation" : "Click to enable auto-rotation"}
        >
          {autoRotate ? "AUTO-ROTATE: ON" : "AUTO-ROTATE: OFF"}
        </button>

        <button
          type="button"
          className={`scifi-btn-toggle ${showTrace ? "on" : ""}`}
          onClick={() => setShowTrace(!showTrace)}
          title={showTrace ? "Click to hide chronological journey trace line & nodes" : "Click to show chronological journey trace line & nodes"}
        >
          {showTrace ? "TRACE: ON" : "TRACE: OFF"}
        </button>
      </div>

      {/* Chronological Timeline Playback Scrubber */}
      <div className="scifi-viewport-bottombar">
        {view.slidable && (
          <div className="scifi-window-row">
            <span className="scifi-scrubber-time">+{formatElapsed(view.start - view.spanStart)}</span>
            <div
              ref={windowTrackRef}
              className="scifi-window-track"
              role="slider"
              aria-label="Area map time window"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, (view.compSpanEnd ?? 0) - (view.compSpanStart ?? 0))}
              aria-valuenow={Math.max(0, (view.compStart ?? 0) - (view.compSpanStart ?? 0))}
              aria-valuetext={`+${formatElapsed(view.start - view.spanStart)} to +${formatElapsed(view.end - view.spanStart)}${(view.seams ?? []).length > 0 ? `, quiet ${(view.seams ?? []).map((seam) => seam.label).join(" ")}` : ""}`}
              tabIndex={0}
              title="Drag across activity. Quiet stretches longer than 5 minutes shrink to a labeled seam. Arrow keys move one minute."
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const step = (event.shiftKey ? 5 : 1) * 60_000;
                const delta = event.key === "ArrowLeft" ? -step : step;
                const origin = view.compStart ?? 0;
                const width = (view.compEnd ?? 0) - origin;
                const spanEnd = view.compSpanEnd ?? 0;
                const next = origin + delta;
                const maxStart = Math.max(0, spanEnd - width);
                setFollowLive(next >= maxStart - 1500);
                setWindowStart(next);
              }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const fraction = (event.clientX - rect.left) / Math.max(1, rect.width);
                const spanMs = (view.compSpanEnd ?? 0) - (view.compSpanStart ?? 0);
                const width = (view.compEnd ?? 0) - (view.compStart ?? 0);
                const next = fraction * spanMs - width / 2;
                const maxStart = Math.max(0, spanMs - width);
                setFollowLive(next >= maxStart - 1500);
                setWindowStart(next);
              }}
            >
              {axis.seams.map((seam) => {
                const spanMs = Math.max(1, axis.spanMs);
                const at = ((seam.compStart + seam.compEnd) / 2 / spanMs) * 100;
                return (
                  <span
                    key={`${seam.wallStart}-${seam.wallEnd}`}
                    className="scifi-window-seam"
                    style={{ left: `${at}%` }}
                    title={`Quiet ${seam.label}`}
                  />
                );
              })}
              <div
                className="scifi-window-thumb"
                style={{ left: `${windowTrack(view).leftPct}%`, width: `${windowTrack(view).widthPct}%` }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const track = windowTrackRef.current;
                  if (!track) return;
                  const rect = track.getBoundingClientRect();
                  const originX = event.clientX;
                  const originStart = view.compStart ?? 0;
                  const spanMs = Math.max(1, (view.compSpanEnd ?? 0) - (view.compSpanStart ?? 0));
                  const maxStart = Math.max(0, spanMs - ((view.compEnd ?? 0) - originStart));
                  let pending = originStart;
                  let raf = 0;
                  setWindowStart(originStart);
                  setFollowLive(false);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const onMove = (ev: PointerEvent) => {
                    pending = originStart + ((ev.clientX - originX) / rect.width) * spanMs;
                    if (raf) return;
                    raf = window.requestAnimationFrame(() => {
                      raf = 0;
                      setWindowStart(pending);
                    });
                  };
                  const onUp = () => {
                    if (raf) window.cancelAnimationFrame(raf);
                    setWindowStart(pending);
                    setFollowLive(pending >= maxStart - 1500);
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                  };
                  window.addEventListener("pointermove", onMove);
                  window.addEventListener("pointerup", onUp);
                }}
              />
            </div>
            <span className="scifi-scrubber-time">+{formatElapsed(view.end - view.spanStart)}</span>
            <button
              type="button"
              className={`scifi-scrubber-play-btn ${followLive ? "on" : ""}`}
              onClick={() => {
                setFollowLive(true);
                setWindowStart(liveStart);
              }}
              title={followLive ? "Window is following the latest activity" : "Jump the window back to the latest activity"}
            >
              {followLive ? "LIVE" : "JUMP LIVE"}
            </button>
          </div>
        )}
        <div className="scifi-scrubber-row">
        <button
          type="button"
          className="scifi-scrubber-play-btn"
          onClick={() => {
            if (isPlaying) {
              setIsPlaying(false);
            } else {
              if (scrubProgress >= 0.98) {
                setScrubProgress(0.05);
                scrubProgressRef.current = 0.05;
              }
              setIsPlaying(true);
            }
          }}
          title={isPlaying ? "Pause timeline replay" : "Replay session growth from start"}
        >
          {isPlaying ? "⏸ PAUSE" : scrubProgress >= 0.98 ? "▶ REPLAY" : "▶ PLAY"}
        </button>

        <div className="scifi-scrubber-track">
          <span className="scifi-scrubber-time">
            00:00
          </span>
          <input
            type="range"
            className="scifi-scrubber-slider"
            min={0.05}
            max={1.0}
            step={0.01}
            value={scrubProgress}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              setScrubProgress(val);
              scrubProgressRef.current = val;
              if (isPlaying) setIsPlaying(false);
            }}
            title="Drag to scrub session timeline and reveal mountain growth"
          />
          <span className="scifi-scrubber-time" style={{ color: "#ff9a3c" }}>
            {scrubProgress >= 0.98 ? "NOW (LATEST)" : `${Math.round(scrubProgress * 100)}%`}
          </span>
        </div>
        </div>
      </div>

      {/* Hover Inspection Tooltip */}
      {hoveredMilestone && (
        <div
          className="scifi-milestone-tooltip"
          style={{
            left: `${hoveredMilestone.screenX}px`,
            top: `${hoveredMilestone.screenY}px`,
          }}
        >
          <div style={{ color: hoveredMilestone.info.hex, fontWeight: "bold", marginBottom: 2 }}>
            [{hoveredMilestone.info.cat}] {hoveredMilestone.info.timeStr}
          </div>
          <div style={{ color: "rgba(255, 255, 255, 0.9)" }}>
            {hoveredMilestone.info.kindStr}
          </div>
          <div style={{ color: "rgba(255, 255, 255, 0.6)", fontSize: "8px", marginTop: 2 }}>
            ACTIVITY: {hoveredMilestone.info.detailStr}
          </div>
        </div>
      )}
    </section>
  );
}
