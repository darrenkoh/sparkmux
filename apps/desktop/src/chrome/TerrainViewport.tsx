import { useEffect, useRef, useState } from "react";
import type { ActivityPoint } from "../api";

interface TerrainViewportProps {
  timeline: ActivityPoint[];
  activeModel?: string;
}

// Projection & Math Utilities
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
  const zx = z0 / lenZ;
  const zy = z1 / lenZ;
  const zz = z2 / lenZ;

  const x0 = up[1] * zz - up[2] * zy;
  const x1 = up[2] * zx - up[0] * zz;
  const x2 = up[0] * zy - up[1] * zx;
  const lenX = Math.hypot(x0, x1, x2) || 1;
  const xx = x0 / lenX;
  const xy = x1 / lenX;
  const xz = x2 / lenX;

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

function projectPoint(vp: Float32Array, p: [number, number, number], width: number, height: number): [number, number] | null {
  const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
  const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
  const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  if (w <= 0.01) return null;
  return [(x / w * 0.5 + 0.5) * width, (0.5 - y / w * 0.5) * height];
}

const VS_TERRAIN = `#version 300 es
uniform mat4 uVP;
uniform float uTime, uFocus, uAperture, uDpr, uScan, uGain;
in vec4 aPos;      // xyz + brightness
in vec3 aCol;      // rgb
in float aSeed;
out float vA;
out float vRing;
out vec3 vCol;
void main() {
  vec4 c = uVP * vec4(aPos.xyz, 1.0);
  gl_Position = c;
  float coc = min(abs(c.w - uFocus) * uAperture, 24.0);
  float base = 1.0 + aSeed * 1.5;
  float size = base + coc;
  gl_PointSize = size * uDpr;
  float energy = (base * base) / (size * size);
  float twinkle = 0.85 + 0.15 * sin(uTime * 2.5 + aSeed * 45.0);
  float scan = 1.0 + 2.4 * exp(-pow((aPos.y - uScan) * 4.0, 2.0));
  float fog = exp(-max(c.w - 35.0, 0.0) * 0.04);
  vA = aPos.w * energy * twinkle * scan * fog * uGain;
  vRing = smoothstep(4.0, 14.0, coc);
  vCol = aCol;
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
  float disc = 1.0 - smoothstep(0.6, 1.0, r);
  float ring = smoothstep(0.5, 0.85, r) * (1.0 - smoothstep(0.85, 1.0, r));
  float a = mix(disc, disc * 0.25 + ring * 1.4, vRing);
  o = vec4(vCol * (a * vA), 1.0);
}
`;

const VS_CONTOUR = `#version 300 es
uniform mat4 uVP;
uniform vec3 uCam;
uniform float uScan;
in vec3 aPos;
in float aA;
out float vA;
void main() {
  gl_Position = uVP * vec4(aPos, 1.0);
  float d = length(aPos - uCam);
  float fog = exp(-max(d - 30.0, 0.0) * 0.04);
  float scan = 1.0 + 3.0 * exp(-pow((aPos.y - uScan) * 2.5, 2.0));
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

export default function TerrainViewport({ timeline, activeModel }: TerrainViewportProps) {
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const hudCanvasRef = useRef<HTMLCanvasElement>(null);
  const [realism, setRealism] = useState<"mono" | "color">("color");

  // Camera Orbit & Pan State
  const camRef = useRef({
    azimuth: 0.45,
    elevation: 0.58,
    radius: 42,
    target: [0, 1.0, 0] as [number, number, number],
    isDragging: false,
    lastX: 0,
    lastY: 0,
    lastActive: performance.now(),
  });

  useEffect(() => {
    const glCanvas = glCanvasRef.current;
    const hudCanvas = hudCanvasRef.current;
    if (!glCanvas || !hudCanvas) return;

    const gl = glCanvas.getContext("webgl2", { antialias: true, alpha: false });
    const hud = hudCanvas.getContext("2d");
    if (!gl || !hud) return;

    // Helper to compile shaders
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

    // Uniform locations
    const uT_VP = gl.getUniformLocation(progTerrain, "uVP");
    const uT_Time = gl.getUniformLocation(progTerrain, "uTime");
    const uT_Focus = gl.getUniformLocation(progTerrain, "uFocus");
    const uT_Aperture = gl.getUniformLocation(progTerrain, "uAperture");
    const uT_Dpr = gl.getUniformLocation(progTerrain, "uDpr");
    const uT_Scan = gl.getUniformLocation(progTerrain, "uScan");
    const uT_Gain = gl.getUniformLocation(progTerrain, "uGain");

    const uC_VP = gl.getUniformLocation(progContour, "uVP");
    const uC_Cam = gl.getUniformLocation(progContour, "uCam");
    const uC_Scan = gl.getUniformLocation(progContour, "uScan");
    const uC_Color = gl.getUniformLocation(progContour, "uColor");

    // Generate Dynamic 3D Hill Surface from Real Timeline Data
    // We create a heightfield terrain grid based on activity bursts
    const SPAN = 24; // spatial extent (-12 to +12)

    // Build elevation function based on activity spectrum with normalized scaling
    const rawPeaks: Array<{ x: number; z: number; h: number; type: "user" | "think" | "reply" | "tool" }> = [];
    if (timeline && timeline.length > 0) {
      timeline.forEach((pt, i) => {
        const angle = (i / timeline.length) * Math.PI * 2;
        const rad = 2.0 + ((i % 5) * 1.4);
        const x = Math.cos(angle) * rad;
        const z = Math.sin(angle) * rad;

        // Scale heights with soft saturation (Math.log1p) so high counts don't shoot out of the camera frustum
        if (pt.user_count > 0) rawPeaks.push({ x: x - 0.4, z: z - 0.4, h: Math.log1p(pt.user_count) * 0.75, type: "user" });
        if (pt.think_count > 0) rawPeaks.push({ x: x + 0.6, z: z - 0.3, h: Math.log1p(pt.think_count) * 0.65, type: "think" });
        if (pt.reply_count > 0) rawPeaks.push({ x: x - 0.5, z: z + 0.5, h: Math.log1p(pt.reply_count) * 0.8, type: "reply" });
        if (pt.tool_count > 0) rawPeaks.push({ x: x + 0.4, z: z + 0.4, h: Math.log1p(pt.tool_count) * 0.6, type: "tool" });
      });
    }

    // Baseline terrain height function
    const getAlt = (x: number, z: number): number => {
      const d = Math.hypot(x, z);
      let h = Math.max(0, 2.4 * Math.exp(-Math.pow(d / 8.5, 2))); // central dome
      h += 0.3 * Math.sin(x * 0.6) * Math.cos(z * 0.6); // ripples

      // Inject activity spikes
      for (const pk of rawPeaks) {
        const dist = Math.hypot(x - pk.x, z - pk.z);
        h += pk.h * Math.exp(-Math.pow(dist / 1.6, 2));
      }
      return h;
    };

    // Calculate actual 3D ground height at peak coordinates so waypoints sit exactly on the surface
    const peaks = rawPeaks
      .map((pk) => ({
        ...pk,
        surfaceY: getAlt(pk.x, pk.z),
      }))
      .sort((a, b) => b.h - a.h);

    // 1. Points Buffer
    const pointCount = 14000;
    const posData = new Float32Array(pointCount * 4); // xyz + brightness
    const colData = new Float32Array(pointCount * 3); // rgb
    const seedData = new Float32Array(pointCount);

    let pIdx = 0;
    for (let i = 0; i < pointCount; i++) {
      const rx = (Math.random() * 2 - 1) * (SPAN / 2);
      const rz = (Math.random() * 2 - 1) * (SPAN / 2);
      const alt = getAlt(rx, rz);

      // Density falloff outside dome
      const d = Math.hypot(rx, rz);
      if (Math.random() > Math.exp(-Math.pow(d / 11, 2)) * 0.9 + 0.1) {
        continue;
      }

      posData[pIdx * 4] = rx;
      posData[pIdx * 4 + 1] = alt + (Math.random() - 0.5) * 0.05;
      posData[pIdx * 4 + 2] = rz;
      posData[pIdx * 4 + 3] = 0.45 + 0.55 * Math.random();

      // Color coding: amber peak tops, cyan thinking ridges, blue slopes, dark base
      let r = 0.9, g = 0.95, b = 1.0;
      if (alt > 3.0) {
        r = 1.0; g = 0.65; b = 0.25; // Amber summit
      } else if (alt > 1.8) {
        r = 0.75; g = 0.52; b = 0.98; // Purple/thinking ridge
      } else if (alt > 0.8) {
        r = 0.35; g = 0.58; b = 0.95; // Blue slope
      } else {
        r = 0.2; g = 0.85; b = 0.75; // Teal base
      }

      colData[pIdx * 3] = r;
      colData[pIdx * 3 + 1] = g;
      colData[pIdx * 3 + 2] = b;

      seedData[pIdx] = Math.random();
      pIdx++;
    }

    const vaoTerrain = gl.createVertexArray()!;
    gl.bindVertexArray(vaoTerrain);

    const bufPos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufPos);
    gl.bufferData(gl.ARRAY_BUFFER, posData.subarray(0, pIdx * 4), gl.STATIC_DRAW);
    const locPos = gl.getAttribLocation(progTerrain, "aPos");
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 4, gl.FLOAT, false, 0, 0);

    const bufCol = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufCol);
    gl.bufferData(gl.ARRAY_BUFFER, colData.subarray(0, pIdx * 3), gl.STATIC_DRAW);
    const locCol = gl.getAttribLocation(progTerrain, "aCol");
    gl.enableVertexAttribArray(locCol);
    gl.vertexAttribPointer(locCol, 3, gl.FLOAT, false, 0, 0);

    const bufSeed = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufSeed);
    gl.bufferData(gl.ARRAY_BUFFER, seedData.subarray(0, pIdx), gl.STATIC_DRAW);
    const locSeed = gl.getAttribLocation(progTerrain, "aSeed");
    gl.enableVertexAttribArray(locSeed);
    gl.vertexAttribPointer(locSeed, 1, gl.FLOAT, false, 0, 0);

    // 2. Contour Lines & Circular Grid Lines Buffer
    const lineVerts: number[] = [];

    // Concentric elevation rings
    const ringAlts = [0.2, 0.6, 1.2, 2.0, 3.0, 4.2];
    for (const rAlt of ringAlts) {
      const segs = 90;
      for (let s = 0; s < segs; s++) {
        const th1 = (s / segs) * Math.PI * 2;
        const th2 = ((s + 1) / segs) * Math.PI * 2;
        const r1 = Math.sqrt(Math.max(0, -Math.log(Math.max(0.01, rAlt / 4.5)) * 64));
        const r2 = r1;
        const x1 = Math.cos(th1) * r1;
        const z1 = Math.sin(th1) * r1;
        const x2 = Math.cos(th2) * r2;
        const z2 = Math.sin(th2) * r2;
        const y1 = getAlt(x1, z1);
        const y2 = getAlt(x2, z2);

        lineVerts.push(x1, y1, z1, 0.35);
        lineVerts.push(x2, y2, z2, 0.35);
      }
    }

    // Base boundary grid
    for (let g = -10; g <= 10; g += 2) {
      const alpha = g % 4 === 0 ? 0.2 : 0.08;
      lineVerts.push(g, 0, -10, alpha, g, 0, 10, alpha);
      lineVerts.push(-10, 0, g, alpha, 10, 0, g, alpha);
    }

    const lineData = new Float32Array(lineVerts);
    const vaoContour = gl.createVertexArray()!;
    gl.bindVertexArray(vaoContour);

    const bufLines = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufLines);
    gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.STATIC_DRAW);

    const locLPos = gl.getAttribLocation(progContour, "aPos");
    gl.enableVertexAttribArray(locLPos);
    gl.vertexAttribPointer(locLPos, 3, gl.FLOAT, false, 16, 0);

    const locLA = gl.getAttribLocation(progContour, "aA");
    gl.enableVertexAttribArray(locLA);
    gl.vertexAttribPointer(locLA, 1, gl.FLOAT, false, 16, 12);

    gl.bindVertexArray(null);

    // Render Loop
    let animId: number;
    const startTime = performance.now();

    const render = () => {
      const now = performance.now();
      const elapsed = (now - startTime) / 1000;
      const cam = camRef.current;

      // Auto-orbit slowly if idle for > 3.5s
      if (!cam.isDragging && now - cam.lastActive > 3500) {
        cam.azimuth += 0.003;
      }

      // Resize handling
      const dpr = window.devicePixelRatio || 1;
      const rect = glCanvas.getBoundingClientRect();
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);

      if (glCanvas.width !== w || glCanvas.height !== h) {
        glCanvas.width = w;
        glCanvas.height = h;
        hudCanvas.width = w;
        hudCanvas.height = h;
      }

      gl.viewport(0, 0, w, h);
      gl.clearColor(0.012, 0.014, 0.018, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      // Camera view matrix
      const eyeX = cam.target[0] + cam.radius * Math.cos(cam.elevation) * Math.sin(cam.azimuth);
      const eyeY = cam.target[1] + cam.radius * Math.sin(cam.elevation);
      const eyeZ = cam.target[2] + cam.radius * Math.cos(cam.elevation) * Math.cos(cam.azimuth);

      const matProj = perspective(38 * (Math.PI / 180), w / h, 0.5, 200.0);
      const matView = lookAt([eyeX, eyeY, eyeZ], cam.target);
      const matVP = multiply(matProj, matView);

      // Scanning wave height
      const scanAlt = (Math.sin(elapsed * 1.5) * 0.5 + 0.5) * 4.2;

      // 1. Draw Contours
      gl.useProgram(progContour);
      gl.uniformMatrix4fv(uC_VP, false, matVP);
      gl.uniform3f(uC_Cam, eyeX, eyeY, eyeZ);
      gl.uniform1f(uC_Scan, scanAlt);
      gl.uniform3f(uC_Color, 1.0, 0.65, 0.25); // Amber
      gl.bindVertexArray(vaoContour);
      gl.drawArrays(gl.LINES, 0, lineVerts.length / 4);

      // 2. Draw Point Cloud Particles
      gl.useProgram(progTerrain);
      gl.uniformMatrix4fv(uT_VP, false, matVP);
      gl.uniform1f(uT_Time, elapsed);
      gl.uniform1f(uT_Focus, cam.radius * 0.95);
      gl.uniform1f(uT_Aperture, 0.5);
      gl.uniform1f(uT_Dpr, dpr);
      gl.uniform1f(uT_Scan, scanAlt);
      gl.uniform1f(uT_Gain, realism === "mono" ? 0.38 : 0.62);

      gl.bindVertexArray(vaoTerrain);
      gl.drawArrays(gl.POINTS, 0, pIdx);
      gl.bindVertexArray(null);

      // 3. Draw 2D HUD Overlays (Labels, Bearing, Coordinates)
      hud.setTransform(dpr, 0, 0, dpr, 0, 0);
      hud.clearRect(0, 0, rect.width, rect.height);

      hud.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
      hud.fillStyle = 'rgba(255, 255, 255, 0.6)';
      hud.textBaseline = 'middle';

      // Compass Bearing readout
      const bearing = Math.round((((cam.azimuth * 180) / Math.PI) % 360 + 360) % 360);
      hud.fillText(`BEARING ${bearing.toString().padStart(3, '0')}° // ELEV ${Math.round((cam.elevation * 180) / Math.PI)}°`, 14, 18);
      hud.fillText(`RANGE ${(cam.radius).toFixed(1)}k`, 14, 30);

      // Draw Peak Waypoint Markers aligned exactly to 3D surface
      for (const pk of peaks.slice(0, 5)) {
        // Project ground surface point and elevated label point
        const groundPt = projectPoint(matVP, [pk.x, pk.surfaceY, pk.z], rect.width, rect.height);
        const pinPt = projectPoint(matVP, [pk.x, pk.surfaceY + 0.6, pk.z], rect.width, rect.height);
        if (groundPt && pinPt) {
          const color = pk.type === "user" ? "#ff9a3c" : pk.type === "think" ? "#c084fc" : pk.type === "reply" ? "#5b8def" : "#2dd4bf";
          hud.strokeStyle = color;
          hud.fillStyle = color;

          // Vertical leader line from terrain surface to pin head
          hud.lineWidth = 1;
          hud.beginPath();
          hud.moveTo(groundPt[0], groundPt[1]);
          hud.lineTo(pinPt[0], pinPt[1]);
          hud.stroke();

          // Anchor base dot on the hill surface
          hud.beginPath();
          hud.arc(groundPt[0], groundPt[1], 1.5, 0, Math.PI * 2);
          hud.fill();

          // Pin marker head
          hud.beginPath();
          hud.arc(pinPt[0], pinPt[1], 2.5, 0, Math.PI * 2);
          hud.stroke();

          // Label text box
          hud.font = '7.5px ui-monospace, SFMono-Regular, Menlo, monospace';
          hud.fillText(`[${pk.type.toUpperCase()}]`, pinPt[0] + 5, pinPt[1]);
        }
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);

    // Pointer Interactivity Listeners
    const handleDown = (e: PointerEvent) => {
      camRef.current.isDragging = true;
      camRef.current.lastX = e.clientX;
      camRef.current.lastY = e.clientY;
      camRef.current.lastActive = performance.now();
      glCanvas.setPointerCapture(e.pointerId);
    };

    const handleMove = (e: PointerEvent) => {
      const cam = camRef.current;
      if (!cam.isDragging) return;
      const dx = e.clientX - cam.lastX;
      const dy = e.clientY - cam.lastY;
      cam.lastX = e.clientX;
      cam.lastY = e.clientY;

      cam.azimuth -= dx * 0.006;
      cam.elevation = Math.max(0.08, Math.min(1.4, cam.elevation + dy * 0.005));
      cam.lastActive = performance.now();
    };

    const handleUp = (e: PointerEvent) => {
      camRef.current.isDragging = false;
      try {
        glCanvas.releasePointerCapture(e.pointerId);
      } catch {}
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      camRef.current.radius = Math.max(12, Math.min(75, camRef.current.radius * Math.exp(e.deltaY * 0.0012)));
      camRef.current.lastActive = performance.now();
    };

    const handleDblClick = () => {
      camRef.current.azimuth = 0.45;
      camRef.current.elevation = 0.58;
      camRef.current.radius = 42;
      camRef.current.lastActive = performance.now();
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
  }, [timeline, realism]);

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
    </section>
  );
}
