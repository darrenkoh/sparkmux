import { useEffect, useRef, useState } from "react";
import type { ActivityPoint, TabAnalyticsStats } from "../api";

interface TerrainViewportProps {
  timeline: ActivityPoint[];
  activeModel?: string;
  sessionName?: string;
  tabName?: string;
  stats?: TabAnalyticsStats | null;
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
  return [(x / w * 0.5 + 0.5) * width, (0.5 - y / w * 0.5) * height, w];
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
uniform float uTime, uFocus, uAperture, uDpr, uGain, uScan, uReal;
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
  float scan = 1.0 + 2.4 * exp(-pow((aPos.y - uScan) * 4.5, 2.0)) * step(0.04, aPos.y);
  float fog = exp(-max(c.w - 38.0, 0.0) * 0.035);
  vA = aPos.w * energy * twinkle * scan * fog * uGain;
  vRing = smoothstep(5.0, 15.0, coc);
  vCol = mix(vec3(1.0), aCol, uReal);
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
uniform float uScan, uScanAmount;
in vec3 aPos;
in float aA;
out float vA;
void main() {
  gl_Position = uVP * vec4(aPos, 1.0);
  float d = length(aPos - uCam);
  float fog = exp(-max(d - 30.0, 0.0) * 0.035);
  float scan = 1.0 + uScanAmount * exp(-pow((aPos.y - uScan) * 2.5, 2.0));
  vA = aA * fog * scan;
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

export default function TerrainViewport({
  timeline,
  activeModel,
  sessionName,
  tabName,
  stats,
}: TerrainViewportProps) {
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const hudCanvasRef = useRef<HTMLCanvasElement>(null);
  const [realism, setRealism] = useState<"mono" | "color">("color");
  const [autoRotate, setAutoRotate] = useState<boolean>(true);
  const autoRotateRef = useRef<boolean>(true);

  useEffect(() => {
    autoRotateRef.current = autoRotate;
  }, [autoRotate]);

  const camRef = useRef({
    azimuth: 0.38,
    elevation: 0.48,
    radius: 46,
    target: [0, 1.2, 0] as [number, number, number],
    isDragging: false,
    lastX: 0,
    lastY: 0,
    idleSince: performance.now() / 1000,
  });

  useEffect(() => {
    const glCanvas = glCanvasRef.current;
    const hudCanvas = hudCanvasRef.current;
    if (!glCanvas || !hudCanvas) return;

    const gl = glCanvas.getContext("webgl2", { antialias: true, alpha: false });
    const hud = hudCanvas.getContext("2d");
    if (!gl || !hud) return;

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

    const uT = {
      uVP: gl.getUniformLocation(progTerrain, "uVP"),
      uTime: gl.getUniformLocation(progTerrain, "uTime"),
      uFocus: gl.getUniformLocation(progTerrain, "uFocus"),
      uAperture: gl.getUniformLocation(progTerrain, "uAperture"),
      uDpr: gl.getUniformLocation(progTerrain, "uDpr"),
      uGain: gl.getUniformLocation(progTerrain, "uGain"),
      uScan: gl.getUniformLocation(progTerrain, "uScan"),
      uReal: gl.getUniformLocation(progTerrain, "uReal"),
    };

    const uC = {
      uVP: gl.getUniformLocation(progContour, "uVP"),
      uCam: gl.getUniformLocation(progContour, "uCam"),
      uScan: gl.getUniformLocation(progContour, "uScan"),
      uScanAmount: gl.getUniformLocation(progContour, "uScanAmount"),
      uColor: gl.getUniformLocation(progContour, "uColor"),
    };

    // -------------------------------------------------------------------------
    // 3D True Axes Construction:
    // X-Axis = Time (Session start -> end)
    // Z-Axis = Category Label (USER -> THINK -> REPLY -> TOOL)
    // Y-Axis = Value (Event frequency, volume, token weight)
    // -------------------------------------------------------------------------
    const TIME_SPAN = 28;  // X extent: -14 to +14
    const LABEL_SPAN = 18; // Z extent: -9 to +9
    const rng = makeRng(2077);

    // Normalize timeline points or generate structured history
    const dataPoints: Array<{ tNorm: number; user: number; think: number; reply: number; tool: number }> = [];
    if (timeline && timeline.length > 0) {
      timeline.forEach((pt, i) => {
        dataPoints.push({
          tNorm: (i / Math.max(1, timeline.length - 1)) * 2 - 1, // -1 to +1
          user: pt.user_count,
          think: pt.think_count,
          reply: pt.reply_count,
          tool: pt.tool_count,
        });
      });
    } else {
      // Seed default dynamic distribution based on stats totals
      const count = 16;
      for (let i = 0; i < count; i++) {
        const t = (i / (count - 1)) * 2 - 1;
        const wave = Math.sin(i * 0.8) * 0.5 + 0.5;
        dataPoints.push({
          tNorm: t,
          user: (stats?.user_prompts ?? 1) * (0.3 + 0.7 * wave),
          think: (stats?.thinking_blocks ?? 2) * (0.4 + 0.6 * (1 - wave)),
          reply: (stats?.assistant_replies ?? 1) * (0.3 + 0.5 * wave),
          tool: (stats?.tool_calls ?? 3) * (0.2 + 0.8 * wave),
        });
      }
    }

    // Channel lane positions along Z
    const zLanes = [-6.75, -2.25, 2.25, 6.75]; // USER, THINK, REPLY, TOOL

    // Calculate height Y at any 3D coordinate (x = Time, z = Label)
    const getAlt = (x: number, z: number): number => {
      // Base gentle shelf
      let val = 0.08;

      // Geological ripples and ridges across time and category for rich texture
      val += 0.12 * Math.sin(x * 0.7 + 0.4) * Math.cos(z * 0.8);
      val += 0.06 * Math.sin(x * 1.8 - z * 1.2);

      // Accumulate Gaussian mountain ridges per channel along the Time axis
      for (let c = 0; c < 4; c++) {
        const laneZ = zLanes[c];
        const distZ = Math.abs(z - laneZ);
        const zWeight = Math.exp(-Math.pow(distZ / 2.2, 2));

        for (const pt of dataPoints) {
          const ptX = pt.tNorm * (TIME_SPAN / 2 - 1.5);
          const distX = Math.abs(x - ptX);
          if (distX > 5.0) continue;

          let rawH = 0;
          if (c === 0) rawH = Math.log1p(pt.user) * 1.1;
          else if (c === 1) rawH = Math.log1p(pt.think) * 0.95;
          else if (c === 2) rawH = Math.log1p(pt.reply) * 1.05;
          else if (c === 3) rawH = Math.log1p(pt.tool) * 0.85;

          const hContrib = rawH * Math.exp(-Math.pow(distX / 1.6, 2)) * zWeight;
          val += hContrib;
        }
      }

      // Edge falloff at boundary margins
      const marginFalloff = smoothstep(TIME_SPAN / 2, TIME_SPAN / 2 - 2, Math.abs(x)) *
                            smoothstep(LABEL_SPAN / 2, LABEL_SPAN / 2 - 1.5, Math.abs(z));

      return Math.max(0, val * marginFalloff);
    };

    // Reference directional light vector [-0.45, 0.8, 0.4]
    const lightDir = [-0.45, 0.8, 0.4];

    // -------------------------------------------------------------------------
    // 1. High-Density 50,000 Particle Field with Channel Shading
    // -------------------------------------------------------------------------
    const pointCount = 50000;
    const posData = new Float32Array(pointCount * 4);
    const colData = new Float32Array(pointCount * 3);
    const seedData = new Float32Array(pointCount);

    let pIdx = 0;
    for (let i = 0; i < pointCount; i++) {
      const rx = (rng() * 2 - 1) * (TIME_SPAN / 2);
      const rz = (rng() * 2 - 1) * (LABEL_SPAN / 2);
      const alt = getAlt(rx, rz);

      // Light normal calculation
      const delta = 0.08;
      const dx = getAlt(rx - delta, rz) - getAlt(rx + delta, rz);
      const dz = getAlt(rx, rz - delta) - getAlt(rx, rz + delta);
      const dy = 2 * delta;
      const len = Math.hypot(dx, dy, dz) || 1;
      const nx = dx / len, ny = dy / len, nz = dz / len;
      const slopeShade = 0.32 + 0.68 * Math.max(0, nx * lightDir[0] + ny * lightDir[1] + nz * lightDir[2]);

      // Category color interpolation along Z
      let r = 0.2, g = 0.8, b = 0.7;
      if (rz < -4.5) {
        // USER lane: Amber / Gold
        r = 1.0; g = 0.62; b = 0.24;
      } else if (rz < 0.0) {
        // THINK lane: Purple / Magenta
        r = 0.75; g = 0.52; b = 0.98;
      } else if (rz < 4.5) {
        // REPLY lane: Cobalt Blue
        r = 0.36; g = 0.58; b = 0.95;
      } else {
        // TOOL lane: Teal / Mint
        r = 0.18; g = 0.84; b = 0.75;
      }

      // Summit amber elevation boost
      if (alt > 2.8) {
        r = 1.0; g = 0.85; b = 0.4;
      }

      posData[pIdx * 4] = rx;
      posData[pIdx * 4 + 1] = alt + (rng() - 0.5) * 0.03;
      posData[pIdx * 4 + 2] = rz;
      posData[pIdx * 4 + 3] = (0.5 + 0.5 * rng()) * slopeShade;

      colData[pIdx * 3] = r * slopeShade;
      colData[pIdx * 3 + 1] = g * slopeShade;
      colData[pIdx * 3 + 2] = b * slopeShade;

      seedData[pIdx] = rng();
      pIdx++;
    }

    const vaoTerrain = gl.createVertexArray()!;
    gl.bindVertexArray(vaoTerrain);

    const bPos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bPos);
    gl.bufferData(gl.ARRAY_BUFFER, posData.subarray(0, pIdx * 4), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);

    const bCol = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bCol);
    gl.bufferData(gl.ARRAY_BUFFER, colData.subarray(0, pIdx * 3), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    const bSeed = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bSeed);
    gl.bufferData(gl.ARRAY_BUFFER, seedData.subarray(0, pIdx), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    // -------------------------------------------------------------------------
    // 2. High-Density Marching Squares Contours across the 3D Grid
    // -------------------------------------------------------------------------
    const contourVerts: number[] = [];
    const baseGridVerts: number[] = [];

    const GRID_X = 120;
    const GRID_Z = 80;
    const stepX = TIME_SPAN / (GRID_X - 1);
    const stepZ = LABEL_SPAN / (GRID_Z - 1);
    const elevMap = new Float32Array(GRID_X * GRID_Z);

    for (let gz = 0; gz < GRID_Z; gz++) {
      const cz = -LABEL_SPAN / 2 + gz * stepZ;
      for (let gx = 0; gx < GRID_X; gx++) {
        const cx = -TIME_SPAN / 2 + gx * stepX;
        elevMap[gz * GRID_X + gx] = getAlt(cx, cz);
      }
    }

    // Contour thresholds every 0.18 vertical units
    const cLevels: number[] = [];
    for (let l = 0.2; l <= 3.6; l += 0.18) {
      cLevels.push(l);
    }

    for (let gz = 0; gz < GRID_Z - 1; gz++) {
      const z0 = -LABEL_SPAN / 2 + gz * stepZ;
      for (let gx = 0; gx < GRID_X - 1; gx++) {
        const x0 = -TIME_SPAN / 2 + gx * stepX;
        const idx = gz * GRID_X + gx;

        const c0 = elevMap[idx];
        const c1 = elevMap[idx + 1];
        const c2 = elevMap[idx + GRID_X + 1];
        const c3 = elevMap[idx + GRID_X];

        const minC = Math.min(c0, c1, c2, c3);
        const maxC = Math.max(c0, c1, c2, c3);
        if (maxC < 0.2 || minC > 3.6) continue;

        for (const lvl of cLevels) {
          if (lvl < minC || lvl >= maxC) continue;
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

          const isMajor = Math.abs(lvl % 0.72) < 0.09;
          const alpha = isMajor ? 0.44 : 0.16;

          for (let s = 0; s + 1 < segs.length; s += 2) {
            contourVerts.push(
              segs[s][0], yLvl, segs[s][1], alpha,
              segs[s + 1][0], yLvl, segs[s + 1][1], alpha
            );
          }
        }
      }
    }

    // Coordinate Grid along Base Plane
    for (let gx = -14; gx <= 14; gx += 2) {
      const a = gx === 0 ? 0.35 : gx % 4 === 0 ? 0.18 : 0.07;
      baseGridVerts.push(gx, 0, -9, a, gx, 0, 9, a);
    }
    for (let gz = -9; gz <= 9; gz += 2) {
      const a = gz === 0 ? 0.35 : gz % 4 === 0 ? 0.18 : 0.07;
      baseGridVerts.push(-14, 0, gz, a, 14, 0, gz, a);
    }

    const createLineVAO = (verts: number[]) => {
      const f32 = new Float32Array(verts);
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, f32, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
      gl.bindVertexArray(null);
      return { vao, count: verts.length / 4 };
    };

    const vaoContours = createLineVAO(contourVerts);
    const vaoBaseGrid = createLineVAO(baseGridVerts);

    // -------------------------------------------------------------------------
    // 3. Trajectory Trail Across Peaks (Connecting Active Milestones)
    // -------------------------------------------------------------------------
    const trailLine: Array<{ pos: [number, number, number]; label: string; cat: string; hex: string }> = [];
    dataPoints.forEach((pt, i) => {
      const tx = pt.tNorm * (TIME_SPAN / 2 - 1.5);
      // Determine dominant category for this turn
      const maxVal = Math.max(pt.user, pt.think, pt.reply, pt.tool, 0.1);
      let catIdx = 0;
      if (pt.tool === maxVal) catIdx = 3;
      else if (pt.reply === maxVal) catIdx = 2;
      else if (pt.think === maxVal) catIdx = 1;

      const tz = zLanes[catIdx];
      const ty = getAlt(tx, tz) + 0.05;
      trailLine.push({
        pos: [tx, ty, tz],
        label: `T+${i + 1}`,
        cat: CHANNELS[catIdx].label,
        hex: CHANNELS[catIdx].hex,
      });
    });

    // Landmark waypoint pins for each Channel Lane
    const channelWaypoints = CHANNELS.map((ch, idx) => {
      const zPos = zLanes[idx];
      // Find peak along this lane
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
        color: ch.hex,
        pos: [bestX, bestY, zPos] as [number, number, number],
        val: idx === 0 ? `${stats?.user_prompts ?? 1} PROMPTS`
           : idx === 1 ? `${stats?.thinking_blocks ?? 2} TURNS`
           : idx === 2 ? `${stats?.assistant_replies ?? 1} REPLIES`
           : `${stats?.tool_calls ?? 3} CALLS`,
      };
    });

    // -------------------------------------------------------------------------
    // 4. Render Loop with 3D Axis HUD and Pin Lines
    // -------------------------------------------------------------------------
    let animId: number;
    let fps = 60;
    let lastFpsTime = performance.now();
    let frameCount = 0;
    const startTime = performance.now();
    let lastRenderTime = performance.now();

    const render = () => {
      animId = requestAnimationFrame(render);

      const now = performance.now();
      const interval = 1000 / 60; // 60 FPS cap
      const delta = now - lastRenderTime;

      // Allow slight timing tolerance (2.0ms) for 60Hz display alignment
      if (delta < interval - 2.0) {
        return;
      }
      lastRenderTime = now - (delta % interval);

      const dt = delta / 1000;
      const elapsed = (now - startTime) / 1000;
      const cam = camRef.current;

      frameCount++;
      if (now - lastFpsTime >= 500) {
        fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
        frameCount = 0;
        lastFpsTime = now;
      }

      // Auto-rotate only when enabled and not actively dragging
      if (autoRotateRef.current && !cam.isDragging) {
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

      // Camera view projection
      const eyeX = cam.target[0] + cam.radius * Math.cos(cam.elevation) * Math.sin(cam.azimuth);
      const eyeY = cam.target[1] + cam.radius * Math.sin(cam.elevation);
      const eyeZ = cam.target[2] + cam.radius * Math.cos(cam.elevation) * Math.cos(cam.azimuth);

      const matProj = perspective(38 * (Math.PI / 180), w / h, 0.5, 260.0);
      const matView = lookAt([eyeX, eyeY, eyeZ], cam.target);
      const matVP = multiply(matProj, matView);

      // Upward radar sweep starting strictly at Y=0, sweeping up to 3.6, looping smoothly
      // Half-speed scan: ~9.0 seconds per cycle
      const cycleDuration = 9.0;
      const scanPhase = (elapsed / cycleDuration) % 1.0; // 0.0 -> 1.0
      const scanAltY = scanPhase * 3.6; // starts strictly at 0.0, climbs to 3.6
      // Smooth fade out at the top 10% and fade in at bottom
      const scanFade = smoothstep(1.0, 0.90, scanPhase) * smoothstep(0.0, 0.05, scanPhase);

      // Draw Grid Lines
      gl.useProgram(progContour);
      gl.uniformMatrix4fv(uC.uVP, false, matVP);
      gl.uniform3f(uC.uCam, eyeX, eyeY, eyeZ);
      gl.uniform1f(uC.uScan, scanAltY);
      gl.uniform1f(uC.uScanAmount, 0);
      gl.uniform3f(uC.uColor, 1.0, 1.0, 1.0);
      gl.bindVertexArray(vaoBaseGrid.vao);
      gl.drawArrays(gl.LINES, 0, vaoBaseGrid.count);

      // Draw Marching Squares Contours
      gl.uniform1f(uC.uScanAmount, 3.0 * scanFade);
      gl.uniform3f(uC.uColor, realism === "mono" ? 1.0 : 0.78, realism === "mono" ? 1.0 : 1.0, realism === "mono" ? 1.0 : 0.94);
      gl.bindVertexArray(vaoContours.vao);
      gl.drawArrays(gl.LINES, 0, vaoContours.count);

      // Draw 50k Particles
      gl.useProgram(progTerrain);
      gl.uniformMatrix4fv(uT.uVP, false, matVP);
      gl.uniform1f(uT.uTime, elapsed);
      gl.uniform1f(uT.uFocus, cam.radius * 0.9);
      gl.uniform1f(uT.uAperture, 0.5 * (h / 700));
      gl.uniform1f(uT.uDpr, dpr);
      gl.uniform1f(uT.uGain, 0.44);
      gl.uniform1f(uT.uScan, scanAltY);
      gl.uniform1f(uT.uReal, realism === "mono" ? 0.0 : 1.0);

      gl.bindVertexArray(vaoTerrain);
      gl.drawArrays(gl.POINTS, 0, pIdx);
      gl.bindVertexArray(null);

      // -----------------------------------------------------------------------
      // 5. 2D HUD Canvas Overlay matching reference
      // -----------------------------------------------------------------------
      hud.setTransform(dpr, 0, 0, dpr, 0, 0);
      hud.clearRect(0, 0, rect.width, rect.height);

      const project = (p: [number, number, number]) => projectPoint(matVP, p, rect.width, rect.height);

      // (A) Glowing Neon Trail connecting Timeline turns
      hud.lineJoin = "round";
      hud.lineCap = "round";

      // Soft glow
      hud.strokeStyle = "rgba(255, 154, 60, 0.20)";
      hud.lineWidth = 6;
      hud.beginPath();
      let first = true;
      for (const pt of trailLine) {
        const sc = project(pt.pos);
        if (!sc) { first = true; continue; }
        if (first) { hud.moveTo(sc[0], sc[1]); first = false; }
        else { hud.lineTo(sc[0], sc[1]); }
      }
      hud.stroke();

      // Sharp neon core
      hud.strokeStyle = "rgba(255, 154, 60, 0.95)";
      hud.lineWidth = 1.6;
      hud.beginPath();
      first = true;
      for (const pt of trailLine) {
        const sc = project(pt.pos);
        if (!sc) { first = true; continue; }
        if (first) { hud.moveTo(sc[0], sc[1]); first = false; }
        else { hud.lineTo(sc[0], sc[1]); }
      }
      hud.stroke();

      // (B) 3D Axis Labels: TIME (X), LABEL (Z), VALUE (Y)
      hud.save();
      hud.font = '8.5px ui-monospace, SFMono-Regular, Menlo, monospace';

      // X-Axis: TIME
      const tStart = project([-13, 0, -10.5]);
      const tEnd = project([13, 0, -10.5]);
      if (tStart && tEnd) {
        hud.fillStyle = "rgba(255, 255, 255, 0.65)";
        hud.textAlign = "left";
        hud.fillText("◄ TIME AXIS (SESSION START)", tStart[0], tStart[1]);
        hud.textAlign = "right";
        hud.fillText("SESSION LATEST ►", tEnd[0], tEnd[1]);
      }

      // Z-Axis: Channel Category Names along the front margin
      CHANNELS.forEach((ch, idx) => {
        const sc = project([-14.5, 0, zLanes[idx]]);
        if (sc) {
          hud.fillStyle = ch.hex;
          hud.textAlign = "right";
          hud.fillText(`[${ch.key.toUpperCase()}] ${ch.label}`, sc[0] - 6, sc[1]);
        }
      });
      hud.restore();

      // (C) Waypoint Target Pins with Leader Lines rising to labels
      for (const node of channelWaypoints) {
        const groundPt = project(node.pos);
        const pinPt = project([node.pos[0], node.pos[1] + 1.8, node.pos[2]]);
        if (!groundPt || !pinPt) continue;

        // Ground 3D target ring
        hud.strokeStyle = node.color;
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

        // Vertical pin leader line
        hud.globalAlpha = 0.95;
        hud.beginPath();
        hud.moveTo(groundPt[0], groundPt[1]);
        hud.lineTo(pinPt[0], pinPt[1] + 6);
        hud.stroke();

        // Concentric pin head
        hud.beginPath();
        hud.arc(pinPt[0], pinPt[1], 6, 0, Math.PI * 2);
        hud.stroke();

        hud.fillStyle = node.color;
        hud.beginPath();
        hud.arc(pinPt[0], pinPt[1], 1.8, 0, Math.PI * 2);
        hud.fill();

        // Callout text label box
        hud.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
        hud.fillStyle = node.color;
        hud.fillText(`[${node.code}] ${node.name}`, pinPt[0] + 10, pinPt[1] - 4);

        hud.globalAlpha = 0.60;
        hud.fillText(`${node.val}`, pinPt[0] + 10, pinPt[1] + 6);
        hud.globalAlpha = 1.0;
      }

      // (D) Left Y-Axis Altitude Ruler (VALUE AXIS)
      const rulerTop = 70;
      const rulerBottom = rect.height - 50;
      const rY = (val: number) => rulerBottom - (val / 3.6) * (rulerBottom - rulerTop);

      hud.strokeStyle = "rgba(255, 255, 255, 0.3)";
      hud.fillStyle = "rgba(255, 255, 255, 0.35)";
      hud.lineWidth = 1;
      hud.beginPath();
      hud.moveTo(14, rulerTop);
      hud.lineTo(14, rulerBottom);
      for (let v = 0; v <= 3.6; v += 0.4) {
        const y = rY(v);
        hud.moveTo(14, y);
        hud.lineTo(v % 1.2 === 0 ? 24 : 18, y);
      }
      hud.stroke();

      hud.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
      hud.textAlign = 'left';
      hud.fillText("VALUE ▲", 14, rulerTop - 8);
      for (let v = 0; v <= 3.6; v += 0.8) {
        hud.fillText(`${Math.round(v * 10)}`, 28, rY(v));
      }

      // Active scan cursor on ruler (starts strictly at 0 at bottom)
      const cursorY = rY(clamp(scanAltY, 0, 3.6));
      hud.fillStyle = `rgba(255, 255, 255, ${0.40 + 0.60 * scanFade})`;
      hud.beginPath();
      hud.moveTo(14, cursorY);
      hud.lineTo(8, cursorY - 4);
      hud.lineTo(8, cursorY + 4);
      hud.closePath();
      hud.fill();

      // (E) Right Matrix of Recent Events
      if (rect.width >= 700) {
        hud.textAlign = 'right';
        hud.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
        const recentEvs = stats?.recent_events ?? [];
        if (recentEvs.length > 0) {
          const sliceEvs = recentEvs.slice(0, 25);
          sliceEvs.forEach((ev, i) => {
            const lineY = rect.height / 2 + (i - Math.floor(sliceEvs.length / 2)) * 15;
            const isLatest = i === 0;
            const tagCol = ev.k === "user" ? "#ff9a3c" : ev.k === "think" ? "#c084fc" : ev.k === "reply" ? "#5b8def" : "#2dd4bf";
            hud.fillStyle = isLatest ? tagCol : `rgba(255, 255, 255, ${0.32 - i * 0.01})`;
            const preview = ev.n || ev.a || ev.b || `${ev.k.toUpperCase()}`;
            hud.fillText(
              `${new Date(ev.t).toLocaleTimeString()}  [${ev.k.toUpperCase()}]  ${preview.slice(0, 18)}  ${ev.ms ? `${ev.ms}ms` : ""}`,
              rect.width - 16,
              lineY
            );
          });
        }
      }

      // (F) Bottom Right Telemetry Readout (left instructions handled cleanly by DOM hint)
      if (rect.width >= 550) {
        hud.textAlign = 'right';
        hud.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
        hud.fillStyle = 'rgba(255, 255, 255, 0.40)';
        hud.fillText(`SCAN ${scanAltY.toFixed(2)} Y   EVENTS ${stats?.total_events ?? timeline.length}   ${fps} FPS`, rect.width - 16, rect.height - 12);
      }

    };

    animId = requestAnimationFrame(render);

    const handleDown = (e: PointerEvent) => {
      camRef.current.isDragging = true;
      camRef.current.lastX = e.clientX;
      camRef.current.lastY = e.clientY;
      camRef.current.idleSince = performance.now() / 1000;
      glCanvas.setPointerCapture(e.pointerId);

      // Stop auto-rotation immediately upon user interaction
      if (autoRotateRef.current) {
        autoRotateRef.current = false;
        setAutoRotate(false);
      }
    };

    const handleMove = (e: PointerEvent) => {
      const cam = camRef.current;
      if (!cam.isDragging) return;
      const dx = e.clientX - cam.lastX;
      const dy = e.clientY - cam.lastY;
      cam.lastX = e.clientX;
      cam.lastY = e.clientY;

      cam.azimuth -= dx * 0.005;
      cam.elevation = clamp(cam.elevation + dy * 0.004, 0.06, 1.35);
      cam.idleSince = performance.now() / 1000;
    };

    const handleUp = (e: PointerEvent) => {
      camRef.current.isDragging = false;
      try {
        glCanvas.releasePointerCapture(e.pointerId);
      } catch {}
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      camRef.current.radius = clamp(camRef.current.radius * Math.exp(e.deltaY * 0.001), 14, 90);
      camRef.current.idleSince = performance.now() / 1000;

      // Stop auto-rotation immediately upon user interaction
      if (autoRotateRef.current) {
        autoRotateRef.current = false;
        setAutoRotate(false);
      }
    };

    const handleDblClick = () => {
      camRef.current.azimuth = 0.38;
      camRef.current.elevation = 0.48;
      camRef.current.radius = 46;
      camRef.current.idleSince = performance.now() / 1000;
    };

    glCanvas.addEventListener("pointerdown", handleDown);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    glCanvas.addEventListener("wheel", handleWheel, { passive: false });
    glCanvas.addEventListener("dblclick", handleDblClick);

    return () => {
      cancelAnimationFrame(animId);
      glCanvas.removeEventListener("pointerdown", handleDown);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      glCanvas.removeEventListener("wheel", handleWheel);
      glCanvas.removeEventListener("dblclick", handleDblClick);
    };
  }, [timeline, realism, activeModel, sessionName, tabName, stats]);

  return (
    <section className="scifi-panel viewport">
      <canvas ref={glCanvasRef} id="terrain" className="scifi-terrain-canvas" />
      <canvas ref={hudCanvasRef} id="terrain-hud" className="scifi-hud-canvas" />
      <header>
        <span className="tag">01</span>
        <span>TOPOGRAPHICAL TELEMETRY SPECTRUM</span>
        <small>{activeModel || "QUANTUM RELIEF"}</small>
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
      </div>
    </section>
  );
}
