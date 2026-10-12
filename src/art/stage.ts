// The 3D stage: one WebGL canvas over the duel, drawing only while a cinematic
// plays (so it costs nothing between them). Primitives: Figure (a card's art
// pushed out into 3D by its depth map, able to reveal, glow and shatter),
// CardPanel (a flat card: backs, spells, traps), Particles (one pooled GPU
// sprite system), Ribbon (beams, bolts, slashes, tendrils) and Ring (summoning
// circles, shockwaves, the Shadow Realm eye).
//
// Performance notes (mid-range Android first, iPhone Safari too):
// - Every material comes from a module-level pool: one never-disposed base
//   ShaderMaterial per kind, compiled once per renderer by prewarm(); instances
//   are base.clone(), so three.js reuses the base's linked program and disposing
//   an instance never releases (and later relinks) it.
// - Shader error checking only in dev; no MSAA; DPR capped at 1.5 (1.25 on small
//   devices); a frame-time governor steps quality down and back up (stage.tier).
// - On the top tiers a cheap post pass (half-res bloom + vignette, plus pulse()
//   flashes) is composited over the transparent canvas without painting black.
import {
  AddEquation,
  BufferAttribute,
  CustomBlending,
  BufferGeometry,
  CanvasTexture,
  DataTexture,
  DoubleSide,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  NoBlending,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  RedFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
  type Camera,
  type IUniform,
} from 'three';
import { DEPTH_SIZE, type ArtData, cardBack } from './depth';

export type Quality = 'full' | 'fast';

/** Highest device pixel ratio worth drawing at: 1.5, or 1.25 on small devices. */
export function dprCap(): number {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const small = (nav.hardwareConcurrency || 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;
  return Math.min(window.devicePixelRatio || 1, small ? 1.25 : 1.5);
}

/** A WebGL renderer set up the same way everywhere (so compiled programs match). */
export function makeRenderer(canvas: HTMLCanvasElement, powerPreference: WebGLPowerPreference): WebGLRenderer {
  const r = new WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true, powerPreference });
  // Linking stalls the main thread for every program; checking each for errors costs more again.
  r.debug.checkShaderErrors = !!import.meta.env?.DEV;
  // None of our shaders convert color spaces; a fixed output space also keeps the program
  // cache key the same whether a pass draws into a render target or onto the canvas.
  r.outputColorSpace = LinearSRGBColorSpace;
  r.setClearColor(0x000000, 0);
  return r;
}

/**
 * Glow blending for a premultiplied-alpha canvas: colors add up, and alpha grows
 * only as much as the glow is bright, so glows light the duel underneath instead
 * of painting black boxes over it.
 */
const GLOW = { blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor, blendSrcAlpha: OneFactor, blendDstAlpha: OneMinusSrcAlphaFactor } as const;
const GLOW_OUT = 'vec3 o = min(vec3(1.0), OUT); gl_FragColor = vec4(o, max(o.r, max(o.g, o.b)));';

export const rgb = (hex: number) => new Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
/** rgb() into an existing vector (no allocation, for per-frame use). */
export const setRgb = (v: Vector3, hex: number) => v.set(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const easeOut = (k: number) => 1 - (1 - clamp01(k)) ** 3;
export const easeIn = (k: number) => clamp01(k) ** 3;
export const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
export const backOut = (k: number) => {
  const c = 1.9;
  const x = clamp01(k) - 1;
  return 1 + (c + 1) * x ** 3 + c * x ** 2;
};

/** Anything the stage updates every frame; returns false when finished. */
export interface Fx {
  update(dt: number): boolean;
  dispose(): void;
}

const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
`;

// ---------------------------------------------------------------- Figure
const FIG_VERT = /* glsl */ `
attribute vec3 aCenter;
attribute vec3 rnd;
uniform sampler2D uDepth;
uniform float uDepthAmt;
uniform float uShatter;
uniform float uTime;
uniform float uWave;
varying vec2 vUv;
varying float vD;
void main(){
  vUv = uv;
  float d = texture2D(uDepth, uv).r;
  vD = d;
  vec3 p = position;
  p.z += d * uDepthAmt;
  // living art: the subject breathes and sways a little
  p.z += sin(uTime * 2.0 + p.y * 3.0) * 0.015 * d;
  p.x += sin(uTime * 1.3 + p.y * 2.0) * 0.01 * d * uWave;
  if (uShatter > 0.0) {
    vec3 c = aCenter;
    c.z += texture2D(uDepth, c.xy + 0.5).r * uDepthAmt;
    vec3 local = p - c;
    float s = uShatter;
    vec3 dir = normalize(vec3(c.xy * 2.2 + (rnd.xy - 0.5) * 1.6, 0.5 + rnd.z));
    local *= max(0.0, 1.0 - s * 0.85);
    float a = s * (rnd.x - 0.5) * 14.0;
    local.xy = mat2(cos(a), -sin(a), sin(a), cos(a)) * local.xy;
    c += dir * s * (0.8 + rnd.y * 2.2);
    c.y -= s * s * 1.6;
    p = c + local;
  }
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FIG_FRAG = /* glsl */ `
uniform sampler2D uArt;
uniform float uReveal;
uniform float uOpacity;
uniform float uTint;
uniform float uCut;
uniform float uShatter;
uniform float uTime;
uniform float uDark;
uniform vec3 uGlow;
varying vec2 vUv;
varying float vD;
${NOISE_GLSL}
void main(){
  vec4 col = texture2D(uArt, vUv);
  float edge = smoothstep(0.0, 0.07, vUv.x) * smoothstep(0.0, 0.07, 1.0 - vUv.x) * smoothstep(0.0, 0.07, vUv.y) * smoothstep(0.0, 0.07, 1.0 - vUv.y);
  float subj = smoothstep(0.22, 0.5, vD);
  float a = edge * mix(1.0, subj, uCut);
  float n = vnoise(vUv * 9.0 + uTime * 0.3) * 0.28;
  float r = uReveal * 1.35 - (vUv.y * 0.95 + n);
  float vis = smoothstep(0.0, 0.03, r);
  float rim = (1.0 - smoothstep(0.0, 0.1, abs(r))) * step(0.001, uReveal) * step(uReveal, 0.999);
  vec3 c = col.rgb;
  float subjEdge = (1.0 - abs(subj * 2.0 - 1.0)) * uCut;
  float scan = 0.5 + 0.5 * sin(vUv.y * 160.0 - uTime * 6.0);
  c += uGlow * subjEdge * (0.55 + 0.25 * scan);
  c = mix(c, vec3(1.0), uTint);
  c = mix(c, c * vec3(0.35, 0.15, 0.55), uDark);
  c += uGlow * rim * 2.2;
  float alpha = (a * vis + rim * a) * uOpacity;
  alpha *= 1.0 - smoothstep(0.55, 1.0, uShatter);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(c * alpha, alpha);
}`;

export class Figure implements Fx {
  mesh: Mesh;
  mat: ShaderMaterial;
  private tex: CanvasTexture;
  private depthTex: DataTexture;
  alive = true;
  time = Math.random() * 10;

  constructor(
    art: ArtData,
    size: number,
    segs: number,
    glow: number,
    depthAmt: number,
  ) {
    const geo = new PlaneGeometry(1, 1, segs, segs).toNonIndexed();
    const pos = geo.getAttribute('position');
    const n = pos.count;
    const centroid = new Float32Array(n * 3);
    const rnd = new Float32Array(n * 3);
    for (let t = 0; t < n; t += 3) {
      const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
      const cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
      const r = [Math.random(), Math.random(), Math.random()];
      for (let k = 0; k < 3; k++) {
        centroid.set([cx, cy, 0], (t + k) * 3);
        rnd.set(r, (t + k) * 3);
      }
    }
    geo.setAttribute('aCenter', new BufferAttribute(centroid, 3));
    geo.setAttribute('rnd', new BufferAttribute(rnd, 3));
    this.tex = new CanvasTexture(art.art);
    this.tex.minFilter = LinearFilter;
    this.tex.generateMipmaps = false;
    this.depthTex = new DataTexture(art.depth, DEPTH_SIZE, DEPTH_SIZE, RedFormat);
    this.depthTex.flipY = true;
    this.depthTex.magFilter = LinearFilter;
    this.depthTex.minFilter = LinearFilter;
    this.depthTex.needsUpdate = true;
    this.mat = material('figure', { uArt: this.tex, uDepth: this.depthTex, uDepthAmt: depthAmt, uGlow: rgb(glow) });
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.scale.setScalar(size);
  }

  get u() {
    return this.mat.uniforms as Record<string, { value: any }>;
  }

  update(dt: number) {
    this.time += dt;
    this.u.uTime.value = this.time;
    return this.alive;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.tex.dispose();
    this.depthTex.dispose();
  }
}

// ---------------------------------------------------------------- CardPanel
const PANEL_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
uniform float uTint;
uniform vec3 uGlow;
uniform float uSheen;
varying vec2 vUv;
void main(){
  vec4 c = texture2D(uMap, vUv);
  float s = smoothstep(0.08, 0.0, abs(vUv.x + vUv.y * 0.6 - uSheen));
  vec3 col = mix(c.rgb, vec3(1.0), uTint) + uGlow * s * 0.9;
  float e = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
  col += uGlow * (1.0 - smoothstep(0.0, 0.035, e)) * 0.8;
  gl_FragColor = vec4(col * uOpacity, uOpacity);
}`;
const BASIC_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export class CardPanel implements Fx {
  mesh: Mesh;
  mat: ShaderMaterial;
  private tex: CanvasTexture;
  alive = true;
  constructor(source: HTMLCanvasElement | null, height: number, glow: number) {
    this.tex = new CanvasTexture(source ?? cardBack());
    this.tex.minFilter = LinearFilter;
    this.tex.generateMipmaps = false;
    this.mat = material('panel', { uMap: this.tex, uGlow: rgb(glow) });
    this.mesh = new Mesh(new PlaneGeometry(height * 0.686, height), this.mat);
  }
  get u() {
    return this.mat.uniforms as Record<string, { value: any }>;
  }
  update() {
    return this.alive;
  }
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}

// ---------------------------------------------------------------- Particles
const P_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uPx;
varying float vAlpha;
varying vec3 vColor;
void main(){
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPx / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const P_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  ${GLOW_OUT.replace('OUT', 'vColor * (1.0 + a * 0.6) * a * vAlpha')}
}`;

export interface Emit {
  x: number;
  y: number;
  z?: number;
  /** random spread of the start position */
  r?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  /** random speed added in every direction */
  burst?: number;
  life?: number;
  size?: number;
  /** size at the end of life (default 0) */
  size1?: number;
  color: number;
  gravity?: number;
  drag?: number;
  /** pull toward (px,py) with a swirl around it (Shadow Realm vortex) */
  pull?: { x: number; y: number; strength: number; swirl: number };
}

const P_ATTRS = ['position', 'aColor', 'aSize', 'aAlpha'] as const;

export class Particles implements Fx {
  readonly max: number;
  points: Points;
  private geo: BufferGeometry;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private v: Float32Array; // vx vy vz
  private life: Float32Array; // age, max
  private s01: Float32Array; // size0 size1
  private phys: Float32Array; // gravity drag
  private pull: Float32Array; // px py strength swirl
  private next = 0;
  active = 0;
  /** quality governor: fraction of requested particles actually emitted */
  emitScale = 1;
  mat: ShaderMaterial;

  constructor(max: number) {
    this.max = max;
    this.geo = new BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.v = new Float32Array(max * 3);
    this.life = new Float32Array(max * 2);
    this.s01 = new Float32Array(max * 2);
    this.phys = new Float32Array(max * 2);
    this.pull = new Float32Array(max * 4);
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aColor', new BufferAttribute(this.col, 3));
    this.geo.setAttribute('aSize', new BufferAttribute(this.size, 1));
    this.geo.setAttribute('aAlpha', new BufferAttribute(this.alpha, 1));
    this.mat = material('particles', {});
    this.points = new Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
  }

  emit(o: Emit, count = 1) {
    // Under load emit fewer (stochastic rounding keeps single-particle trickles alive).
    if (this.emitScale < 1) count = Math.floor(count * this.emitScale + Math.random());
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      const r = o.r ?? 0;
      const b = o.burst ?? 0;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(Math.random() * 2 - 1);
      const sp = b * (0.3 + Math.random() * 0.7);
      this.pos[i * 3] = o.x + (Math.random() - 0.5) * 2 * r;
      this.pos[i * 3 + 1] = o.y + (Math.random() - 0.5) * 2 * r;
      this.pos[i * 3 + 2] = (o.z ?? 0) + (Math.random() - 0.5) * r;
      this.v[i * 3] = (o.vx ?? 0) + Math.sin(ph) * Math.cos(th) * sp;
      this.v[i * 3 + 1] = (o.vy ?? 0) + Math.sin(ph) * Math.sin(th) * sp;
      this.v[i * 3 + 2] = (o.vz ?? 0) + Math.cos(ph) * sp * 0.5;
      const life = (o.life ?? 0.8) * (0.7 + Math.random() * 0.6);
      this.life[i * 2] = 0;
      this.life[i * 2 + 1] = life;
      const s = (o.size ?? 0.08) * (0.6 + Math.random() * 0.8);
      this.s01[i * 2] = s;
      this.s01[i * 2 + 1] = o.size1 ?? 0;
      this.phys[i * 2] = o.gravity ?? 0;
      this.phys[i * 2 + 1] = o.drag ?? 1.5;
      const p = o.pull;
      this.pull[i * 4] = p ? p.x : 0;
      this.pull[i * 4 + 1] = p ? p.y : 0;
      this.pull[i * 4 + 2] = p ? p.strength : 0;
      this.pull[i * 4 + 3] = p ? p.swirl : 0;
      const c = o.color;
      // a little color jitter keeps bursts from looking flat
      const j = 0.85 + Math.random() * 0.3;
      this.col[i * 3] = Math.min(1, (((c >> 16) & 255) / 255) * j);
      this.col[i * 3 + 1] = Math.min(1, (((c >> 8) & 255) / 255) * j);
      this.col[i * 3 + 2] = Math.min(1, ((c & 255) / 255) * j);
    }
  }

  update(dt: number) {
    let active = 0;
    for (let i = 0; i < this.max; i++) {
      const mx = this.life[i * 2 + 1];
      if (mx <= 0) continue;
      const age = (this.life[i * 2] += dt);
      if (age >= mx) {
        this.life[i * 2 + 1] = 0;
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      active++;
      const k = age / mx;
      const drag = Math.exp(-this.phys[i * 2 + 1] * dt);
      let vx = this.v[i * 3] * drag;
      let vy = this.v[i * 3 + 1] * drag - this.phys[i * 2] * dt;
      const vz = this.v[i * 3 + 2] * drag;
      const st = this.pull[i * 4 + 2];
      if (st) {
        const dx = this.pull[i * 4] - this.pos[i * 3];
        const dy = this.pull[i * 4 + 1] - this.pos[i * 3 + 1];
        const d = Math.max(0.05, Math.hypot(dx, dy));
        vx += (dx / d) * st * dt + (-dy / d) * this.pull[i * 4 + 3] * dt;
        vy += (dy / d) * st * dt + (dx / d) * this.pull[i * 4 + 3] * dt;
      }
      this.v[i * 3] = vx;
      this.v[i * 3 + 1] = vy;
      this.v[i * 3 + 2] = vz;
      this.pos[i * 3] += vx * dt;
      this.pos[i * 3 + 1] += vy * dt;
      this.pos[i * 3 + 2] += vz * dt;
      this.size[i] = lerp(this.s01[i * 2], this.s01[i * 2 + 1], k);
      this.alpha[i] = k < 0.12 ? k / 0.12 : 1 - (k - 0.12) / 0.88;
    }
    this.active = active;
    for (const name of P_ATTRS) this.geo.getAttribute(name).needsUpdate = true;
    return true;
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
    this.size.fill(0);
    this.active = 0;
  }

  dispose() {
    this.points.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------- Ribbon
const RIB_VERT = /* glsl */ `
attribute float aT;
varying vec2 vUv;
varying float vT;
void main(){ vUv = uv; vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RIB_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uHead;
uniform float uTail;
uniform float uTime;
uniform float uFlow;
varying vec2 vUv;
varying float vT;
${NOISE_GLSL}
void main(){
  float k = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float along = smoothstep(uTail, uTail + 0.08, vT) * (1.0 - smoothstep(uHead - 0.02, uHead, vT));
  float flow = mix(1.0, 0.65 + 0.7 * vnoise(vec2(vT * 18.0 - uTime * 14.0, vUv.y * 3.0)), uFlow);
  vec3 c = mix(uColor, vec3(1.0), pow(k, 5.0)) * pow(k, 1.4) * 1.6 * flow;
  ${GLOW_OUT.replace('OUT', 'c * along * uOpacity')}
}`;

/** A glowing strip through a list of points (in the XY plane, facing the camera). */
export class Ribbon implements Fx {
  mesh: Mesh;
  mat: ShaderMaterial;
  private geo: BufferGeometry;
  private n: number;
  alive = true;
  constructor(n: number, color: number, flow = 0) {
    this.n = n;
    this.geo = new BufferGeometry();
    const pos = new Float32Array(n * 2 * 3);
    const uv = new Float32Array(n * 2 * 2);
    const t = new Float32Array(n * 2);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1);
      uv.set([k, 0, k, 1], i * 4);
      t.set([k, k], i * 2);
      if (i < n - 1) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.geo.setAttribute('position', new BufferAttribute(pos, 3));
    this.geo.setAttribute('uv', new BufferAttribute(uv, 2));
    this.geo.setAttribute('aT', new BufferAttribute(t, 1));
    this.geo.setIndex(idx);
    this.mat = material('ribbon', { uColor: rgb(color), uFlow: flow });
    this.mesh = new Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
  }
  get u() {
    return this.mat.uniforms as Record<string, { value: any }>;
  }
  /** Lays the ribbon along `pts` (at least 2), `width` thick, optionally tapering. */
  set(pts: { x: number; y: number; z?: number }[], width: number | ((k: number) => number)) {
    const pos = this.geo.getAttribute('position') as BufferAttribute;
    const arr = pos.array as Float32Array;
    const sample = (k: number) => {
      const f = k * (pts.length - 1);
      const i = Math.min(pts.length - 2, Math.floor(f));
      const t = f - i;
      const a = pts[i];
      const b = pts[i + 1];
      return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z ?? 0, b.z ?? 0, t) };
    };
    for (let i = 0; i < this.n; i++) {
      const k = i / (this.n - 1);
      const p = sample(k);
      const q = sample(Math.min(1, k + 0.01));
      const o = sample(Math.max(0, k - 0.01));
      let dx = q.x - o.x;
      let dy = q.y - o.y;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d;
      dy /= d;
      const w = (typeof width === 'function' ? width(k) : width) / 2;
      arr.set([p.x - dy * w, p.y + dx * w, p.z, p.x + dy * w, p.y - dx * w, p.z], i * 6);
    }
    pos.needsUpdate = true;
  }
  update(dt: number) {
    this.u.uTime.value += dt;
    return this.alive;
  }
  dispose() {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------- Ring
const RING_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uInner;
uniform float uOuter;
uniform float uGlyph;
uniform float uSpin;
uniform float uStar;
uniform float uEye;
uniform float uTime;
varying vec2 vUv;
${NOISE_GLSL}
#define PI 3.14159265
float line(vec2 p, vec2 a, vec2 b, float w){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return 1.0 - smoothstep(0.0, w, length(pa - ba * h)); }
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float ang = atan(p.y, p.x) + uSpin;
  float band = smoothstep(uInner - 0.03, uInner, r) * (1.0 - smoothstep(uOuter, uOuter + 0.03, r));
  float outerLine = 1.0 - smoothstep(0.0, 0.025, abs(r - uOuter));
  float innerLine = 1.0 - smoothstep(0.0, 0.02, abs(r - uInner));
  // runes: a seeded on/off pattern of blocks around the band
  float segs = 24.0 + floor(hash12(vec2(uGlyph, 1.0)) * 24.0);
  float seg = floor((ang / (2.0 * PI) + 0.5) * segs);
  float on = step(0.45, hash12(vec2(seg, uGlyph)));
  float rr = (r - uInner) / max(0.001, uOuter - uInner);
  float glyph = on * step(0.3, rr) * step(rr, 0.7) * step(0.15, fract((ang / (2.0 * PI) + 0.5) * segs)) * band;
  float g = outerLine + innerLine * 0.8 + glyph * 0.9 + band * 0.08;
  // star polygon (fusion and ritual circles)
  if (uStar > 2.5) {
    float s = 0.0;
    for (int i = 0; i < 9; i++) {
      if (float(i) >= uStar) break;
      float a0 = float(i) * 2.0 * PI / uStar - uSpin;
      float a1 = float(i + 2) * 2.0 * PI / uStar - uSpin;
      s = max(s, line(p, vec2(cos(a0), sin(a0)) * uInner, vec2(cos(a1), sin(a1)) * uInner, 0.02));
    }
    g += s;
  }
  // the eye (Shadow Realm)
  if (uEye > 0.0) {
    float open = uEye;
    vec2 q = p / vec2(0.85, 0.42 * open + 0.001);
    float lid = 1.0 - smoothstep(0.96, 1.0, length(q));
    float lidLine = 1.0 - smoothstep(0.0, 0.06, abs(length(q) - 1.0));
    float iris = 1.0 - smoothstep(0.28, 0.31, length(p / vec2(1.0, 1.0)));
    float pupil = 1.0 - smoothstep(0.08, 0.11, length(p / vec2(0.45, 1.0)));
    float swirl = vnoise(vec2(ang * 3.0, r * 6.0 - uTime * 2.0));
    g += lidLine * 1.4 + lid * (iris * (0.8 + swirl * 0.6) - pupil * 1.5) + lid * 0.1;
  }
  ${GLOW_OUT.replace('OUT', 'uColor * g * uOpacity')}
}`;

export class Ring implements Fx {
  mesh: Mesh;
  mat: ShaderMaterial;
  alive = true;
  spinSpeed = 0;
  constructor(size: number, color: number, glyph: number, opts: { inner?: number; outer?: number; star?: number; eye?: boolean } = {}) {
    this.mat = material('ring', {
      uColor: rgb(color),
      uInner: opts.inner ?? 0.72,
      uOuter: opts.outer ?? 0.92,
      uGlyph: (glyph % 9973) + 0.5,
      uStar: opts.star ?? 0,
      uEye: opts.eye ? 0.001 : 0,
    });
    this.mesh = new Mesh(new PlaneGeometry(size, size), this.mat);
    this.mesh.renderOrder = 5;
  }
  get u() {
    return this.mat.uniforms as Record<string, { value: any }>;
  }
  update(dt: number) {
    this.u.uTime.value += dt;
    this.u.uSpin.value += this.spinSpeed * dt;
    return this.alive;
  }
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------- Backdrop
const BG_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
uniform float uVortex;
varying vec2 vUv;
${NOISE_GLSL}
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float a = atan(p.y, p.x);
  float v = vnoise(vec2(a * 2.0 + r * 4.0 * uVortex - uTime * 1.5 * uVortex, r * 3.0 - uTime * 0.5));
  vec3 c = uColor * (0.25 + 0.75 * v * uVortex) * (1.0 - r * 0.6);
  float al = uOpacity * mix(0.72, 0.95, uVortex);
  gl_FragColor = vec4(c * al, al);
}`;

/** The dimmed, slowly moving sky behind every cinematic. */
export class Backdrop implements Fx {
  mesh: Mesh;
  mat: ShaderMaterial;
  constructor() {
    this.mat = material('backdrop', {});
    this.mesh = new Mesh(new PlaneGeometry(60, 60), this.mat);
    this.mesh.position.z = -6;
    this.mesh.renderOrder = -10;
  }
  get u() {
    return this.mat.uniforms as Record<string, { value: any }>;
  }
  update(dt: number) {
    this.u.uTime.value += dt;
    return true;
  }
  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------- post passes
const FS_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** Half-res bright pass: a 4-tap box downsample keeping only what glows. Premultiplied in and out. */
const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tMap;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
void main(){
  vec2 o = uTexel * 0.5;
  vec4 c = (texture2D(tMap, vUv + vec2(-o.x, -o.y)) + texture2D(tMap, vUv + vec2(o.x, -o.y)) + texture2D(tMap, vUv + vec2(-o.x, o.y)) + texture2D(tMap, vUv + o)) * 0.25;
  float l = max(c.r, max(c.g, c.b));
  vec3 g = c.rgb * smoothstep(uThreshold, uThreshold + 0.3, l);
  gl_FragColor = vec4(g, max(g.r, max(g.g, g.b)));
}`;

/** One Kawase blur iteration (4 bilinear taps on the diagonals). */
const KAWASE_FRAG = /* glsl */ `
uniform sampler2D tMap;
uniform vec2 uTexel;
uniform float uOff;
varying vec2 vUv;
void main(){
  vec2 o = uTexel * (uOff + 0.5);
  gl_FragColor = (texture2D(tMap, vUv + vec2(-o.x, -o.y)) + texture2D(tMap, vUv + vec2(o.x, -o.y)) + texture2D(tMap, vUv + vec2(-o.x, o.y)) + texture2D(tMap, vUv + o)) * 0.25;
}`;

/**
 * Scene + bloom + vignette (+ pulses) in one pass onto the transparent canvas.
 * Premultiplied throughout: bloom adds light and grows alpha only as much as it is
 * bright (like the glow blending), the vignette only darkens what the cinematic
 * itself drew (alpha is untouched, so empty pixels stay empty), and the flash is
 * white laid "over" the result.
 */
const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uVig;
uniform float uChroma;
uniform float uFlash;
varying vec2 vUv;
void main(){
  vec4 c = texture2D(tScene, vUv);
  if (uChroma > 0.0) {
    vec2 d = (vUv - 0.5) * uChroma;
    vec4 r = texture2D(tScene, vUv + d);
    vec4 b = texture2D(tScene, vUv - d);
    c = vec4(r.r, c.g, b.b, max(c.a, max(r.a, b.a)));
  }
  vec2 q = vUv - 0.5;
  float v = 1.0 - uVig * smoothstep(0.3, 0.8, length(q));
  vec3 col = min(vec3(1.0), c.rgb * v + texture2D(tBloom, vUv).rgb * uBloom);
  float a = max(c.a, max(col.r, max(col.g, col.b)));
  col = vec3(uFlash) + col * (1.0 - uFlash);
  a = uFlash + a * (1.0 - uFlash);
  gl_FragColor = vec4(col, a);
}`;

// ---------------------------------------------------------------- material pool
/**
 * One base material per kind, created once and never disposed. Instances are
 * clones, so their program cache key matches the base's; because the base keeps
 * holding the program in every renderer that compiled it (prewarm), disposing an
 * instance never deletes the program and the next cinematic links nothing.
 */
export type MaterialKind = 'figure' | 'panel' | 'particles' | 'ribbon' | 'ring' | 'backdrop' | 'bright' | 'kawase' | 'composite';
export const MATERIAL_KINDS: readonly MaterialKind[] = ['figure', 'panel', 'particles', 'ribbon', 'ring', 'backdrop', 'bright', 'kawase', 'composite'];

const uniforms = (o: Record<string, unknown>) => {
  const r: Record<string, IUniform> = {};
  for (const k in o) r[k] = { value: o[k] };
  return r;
};
// forceSinglePass: a transparent DoubleSide mesh is otherwise drawn twice (back faces, then front).
const FX = { transparent: true, premultipliedAlpha: true, depthWrite: false, forceSinglePass: true } as const;
const PASS = { blending: NoBlending, transparent: false, premultipliedAlpha: true, depthTest: false, depthWrite: false } as const;

const SPECS: Record<MaterialKind, () => ShaderMaterial> = {
  figure: () =>
    new ShaderMaterial({
      vertexShader: FIG_VERT,
      fragmentShader: FIG_FRAG,
      ...FX,
      side: DoubleSide,
      uniforms: uniforms({ uArt: null, uDepth: null, uDepthAmt: 0.3, uShatter: 0, uTime: 0, uWave: 1, uReveal: 1, uOpacity: 1, uTint: 0, uCut: 1, uDark: 0, uGlow: new Vector3(1, 1, 1) }),
    }),
  panel: () => new ShaderMaterial({ vertexShader: BASIC_VERT, fragmentShader: PANEL_FRAG, ...FX, side: DoubleSide, uniforms: uniforms({ uMap: null, uOpacity: 1, uTint: 0, uGlow: new Vector3(1, 1, 1), uSheen: -1 }) }),
  particles: () => new ShaderMaterial({ vertexShader: P_VERT, fragmentShader: P_FRAG, ...FX, ...GLOW, uniforms: uniforms({ uPx: 300 }) }),
  ribbon: () =>
    new ShaderMaterial({
      vertexShader: RIB_VERT,
      fragmentShader: RIB_FRAG,
      ...FX,
      ...GLOW,
      side: DoubleSide,
      uniforms: uniforms({ uColor: new Vector3(1, 1, 1), uOpacity: 1, uHead: 1.05, uTail: -0.1, uTime: 0, uFlow: 0 }),
    }),
  ring: () =>
    new ShaderMaterial({
      vertexShader: BASIC_VERT,
      fragmentShader: RING_FRAG,
      ...FX,
      ...GLOW,
      side: DoubleSide,
      uniforms: uniforms({ uColor: new Vector3(1, 1, 1), uOpacity: 1, uInner: 0.72, uOuter: 0.92, uGlyph: 0.5, uSpin: 0, uStar: 0, uEye: 0, uTime: 0 }),
    }),
  backdrop: () =>
    new ShaderMaterial({
      vertexShader: BASIC_VERT,
      fragmentShader: BG_FRAG,
      ...FX,
      depthTest: false,
      blending: NormalBlending,
      uniforms: uniforms({ uColor: rgb(0x0a1030), uOpacity: 0, uTime: 0, uVortex: 0 }),
    }),
  bright: () => new ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: BRIGHT_FRAG, ...PASS, uniforms: uniforms({ tMap: null, uTexel: new Vector2(), uThreshold: 0.6 }) }),
  kawase: () => new ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: KAWASE_FRAG, ...PASS, uniforms: uniforms({ tMap: null, uTexel: new Vector2(), uOff: 0 }) }),
  composite: () =>
    new ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: COMPOSITE_FRAG, ...PASS, uniforms: uniforms({ tScene: null, tBloom: null, uBloom: 0.7, uVig: 0.3, uChroma: 0, uFlash: 0 }) }),
};

const BASE = new Map<MaterialKind, ShaderMaterial>();
function baseMaterial(kind: MaterialKind) {
  let m = BASE.get(kind);
  if (!m) BASE.set(kind, (m = SPECS[kind]()));
  return m;
}

/** A material instance of `kind` (shares the base's compiled program), with these uniform values. */
export function material(kind: MaterialKind, values: Record<string, unknown>): ShaderMaterial {
  const m = baseMaterial(kind).clone();
  for (const k in values) m.uniforms[k].value = values[k];
  return m;
}

/**
 * Compiles the base material of every kind on `renderer` (one hidden warm-up scene),
 * off the main thread where KHR_parallel_shader_compile exists. The bases then keep
 * their programs for the renderer's lifetime.
 */
export function prewarmRenderer(renderer: WebGLRenderer, camera: Camera, kinds: readonly MaterialKind[] = MATERIAL_KINDS): Promise<void> {
  const scene = new Scene();
  const plane = new PlaneGeometry(1, 1);
  const dot = new BufferGeometry();
  dot.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
  for (const k of kinds) {
    const o = k === 'particles' ? new Points(dot, baseMaterial(k)) : new Mesh(plane, baseMaterial(k));
    o.frustumCulled = false;
    scene.add(o);
  }
  const done = () => {
    plane.dispose();
    dot.dispose();
  };
  try {
    const compiled: Promise<unknown> = typeof renderer.compileAsync === 'function' ? renderer.compileAsync(scene, camera) : Promise.resolve(renderer.compile(scene, camera));
    // Never wait forever (a context lost mid-compile never reports ready).
    const timeout = new Promise((ok) => setTimeout(ok, 5000));
    return Promise.race([compiled, timeout]).then(done, (err) => {
      done();
      console.warn('art engine: prewarm failed', err);
    });
  } catch (err) {
    done();
    console.warn('art engine: prewarm failed', err);
    return Promise.resolve();
  }
}

/** Bloom + vignette + pulses: scene → full-res target → half-res bright → 2 Kawase → composite. */
class Post {
  private scene = new Scene();
  private cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: Mesh;
  private bright = material('bright', {});
  private kawase = material('kawase', {});
  comp = material('composite', {});
  private full = new WebGLRenderTarget(1, 1, { depthBuffer: false });
  private a = new WebGLRenderTarget(1, 1, { depthBuffer: false });
  private b = new WebGLRenderTarget(1, 1, { depthBuffer: false });
  private size = new Vector2();

  constructor() {
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.bright);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  setSize(renderer: WebGLRenderer) {
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    this.full.setSize(w, h);
    this.a.setSize(hw, hh);
    this.b.setSize(hw, hh);
    (this.bright.uniforms.uTexel.value as Vector2).set(1 / w, 1 / h);
    (this.kawase.uniforms.uTexel.value as Vector2).set(1 / hw, 1 / hh);
  }

  private pass(renderer: WebGLRenderer, mat: ShaderMaterial, target: WebGLRenderTarget | null) {
    this.quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.cam);
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: Camera) {
    renderer.setRenderTarget(this.full);
    renderer.render(scene, camera);
    this.bright.uniforms.tMap.value = this.full.texture;
    this.pass(renderer, this.bright, this.a);
    this.kawase.uniforms.tMap.value = this.a.texture;
    this.kawase.uniforms.uOff.value = 0;
    this.pass(renderer, this.kawase, this.b);
    this.kawase.uniforms.tMap.value = this.b.texture;
    this.kawase.uniforms.uOff.value = 1;
    this.pass(renderer, this.kawase, this.a);
    this.comp.uniforms.tScene.value = this.full.texture;
    this.comp.uniforms.tBloom.value = this.a.texture;
    this.pass(renderer, this.comp, null);
  }

  dispose() {
    this.quad.geometry.dispose();
    this.bright.dispose();
    this.kawase.dispose();
    this.comp.dispose();
    this.full.dispose();
    this.a.dispose();
    this.b.dispose();
  }
}

// ---------------------------------------------------------------- Stage
/** One step of the quality ladder (stage.tier indexes these, 0 = cheapest). */
interface Level {
  dpr: number;
  emit: number;
  post: boolean;
}

/** Post-processing (bloom, vignette, pulses) on the 'full' setting's upper tiers. */
export const POST_ENABLED = true;

const SLOW_MS = 22;
const FAST_MS = 14;
const WINDOW = 60;

export class Stage {
  renderer: WebGLRenderer;
  scene = new Scene();
  camera = new PerspectiveCamera(38, 1, 0.1, 100);
  particles: Particles;
  backdrop = new Backdrop();
  private fx = new Set<Fx>();
  private fxList: Fx[] = [];
  private raf = 0;
  private last = 0;
  private shakeAmt = 0;
  camBase = new Vector3(0, 0, 10);
  camLook = new Vector3(0, 0, 0);
  /** visible half-width and half-height at z = 0 */
  halfW = 1;
  halfH = 1;
  /** time scale: Fast mode plays everything quicker */
  speed = 1;
  private q: Quality;
  onFrame: ((dt: number) => void) | null = null;
  running = false;
  /** the WebGL context is gone (until the browser restores it): draw nothing */
  lost = false;
  onLost: (() => void) | null = null;
  onRestore: (() => void) | null = null;
  private warm: Promise<void> | null = null;
  private post: Post | null = null;
  private chroma = 0;
  private flash = 0;
  private disposed = false;

  // quality governor
  private levels: Level[] = [];
  private level = 0;
  /** set false to pin the current tier (tests, benchmarks) */
  governor = true;
  private ft = new Float32Array(WINDOW);
  private work = new Float32Array(WINDOW);
  private ftSum = 0;
  private workSum = 0;
  private ftI = 0;
  private ftN = 0;
  private goodFor = 0;
  private upWait = 3;
  private lastUp = -1e9;

  constructor(
    public canvas: HTMLCanvasElement,
    quality: Quality,
  ) {
    this.q = quality;
    this.renderer = makeRenderer(canvas, 'high-performance');
    this.particles = new Particles(quality === 'full' ? 2600 : 1400);
    this.scene.add(this.backdrop.mesh, this.particles.points);
    this.buildLevels();
    this.pinFromStorage();
    canvas.addEventListener('webglcontextlost', this.handleLost, false);
    canvas.addEventListener('webglcontextrestored', this.handleRestore, false);
    document.addEventListener('visibilitychange', this.handleVisibility);
    void this.prewarm();
  }

  get quality() {
    return this.q;
  }
  set quality(q: Quality) {
    if (q === this.q) return;
    this.q = q;
    this.buildLevels();
    this.pinFromStorage();
  }

  /** Current quality tier, 0 (cheapest) .. tiers (best). */
  get tier() {
    return this.level;
  }
  set tier(t: number) {
    const n = Math.max(0, Math.min(this.levels.length - 1, Math.round(t)));
    if (n === this.level) return;
    this.level = n;
    this.applyLevel();
  }
  /** The best tier's number. */
  get tiers() {
    return this.levels.length - 1;
  }

  /** localStorage 'eds.artTier' = a tier number or 'top' pins the quality (testing, or a device the governor misjudges). */
  private pinFromStorage() {
    let v: string | null = null;
    try {
      v = localStorage.getItem('eds.artTier');
    } catch {
      /* storage blocked */
    }
    if (v === null || v === '') return;
    const n = v === 'top' ? this.tiers : Number(v);
    if (!Number.isFinite(n)) return;
    this.governor = false;
    this.tier = n;
  }

  private buildLevels() {
    const cap = this.q === 'full' ? dprCap() : Math.min(dprCap(), 1.25);
    const low = Math.min(1, cap);
    const post = POST_ENABLED && this.q === 'full';
    const top: Level[] = [];
    for (let d = cap; d > 1.001; d = Math.max(1, d - 0.25)) top.push({ dpr: d, emit: 1, post });
    top.push({ dpr: low, emit: 1, post });
    top.push({ dpr: low, emit: 0.6, post });
    if (post) top.push({ dpr: low, emit: 0.6, post: false });
    this.levels = top.reverse();
    this.level = this.levels.length - 1;
    this.applyLevel();
  }

  private applyLevel() {
    const l = this.levels[this.level];
    this.particles.emitScale = l.emit;
    if (l.post && !this.post) this.post = new Post();
    if (!l.post && this.post) {
      this.post.dispose();
      this.post = null;
    }
    this.resetGovernor();
    this.resize();
  }

  /** Compiles every material's program ahead of time (resolves when ready to draw without stalls). */
  prewarm(): Promise<void> {
    if (this.lost || this.disposed) return Promise.resolve();
    return (this.warm ??= prewarmRenderer(this.renderer, this.camera));
  }

  resize() {
    if (!this.levels.length) return;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = this.levels[this.level].dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.post?.setSize(this.renderer);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.halfH = Math.tan((this.camera.fov * Math.PI) / 360) * this.camBase.z;
    this.halfW = this.halfH * this.camera.aspect;
    this.particles.mat.uniforms.uPx.value = (h * dpr) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  }

  /** A comfortable unit for sizing things: fits a phone in portrait and a wide screen. */
  get unit() {
    return Math.min(this.halfW * 0.9, this.halfH * 0.55);
  }

  /** Screen pixel (relative to the canvas) → point on the z = 0 plane. */
  toWorld(px: number, py: number) {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    return { x: (px / w) * 2 * this.halfW - this.halfW, y: this.halfH - (py / h) * 2 * this.halfH };
  }

  add<T extends Fx>(f: T & { mesh?: Mesh }): T {
    this.fx.add(f);
    if (f.mesh) this.scene.add(f.mesh);
    this.start();
    return f;
  }

  remove(f: Fx) {
    if (!this.fx.delete(f)) return;
    f.dispose();
  }

  shake(amount: number) {
    this.shakeAmt = Math.max(this.shakeAmt, amount);
  }

  /**
   * A one-beat screen effect for impacts: 'chroma' splits the colors outward,
   * 'flash' lays white over everything. `strength` 0..1. Drawn by the post pass,
   * so it shows only on the tiers that have it.
   */
  pulse(kind: 'chroma' | 'flash', strength: number) {
    const s = clamp01(strength);
    if (kind === 'chroma') this.chroma = Math.max(this.chroma, s);
    else this.flash = Math.max(this.flash, s);
  }

  start() {
    if (this.running || this.lost || this.disposed) return;
    this.running = true;
    this.resetGovernor();
    this.schedule();
  }

  private schedule() {
    if (this.raf || !this.running || document.hidden) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private loop = (now: number) => {
    this.raf = 0;
    if (!this.running) return;
    const ms = now - this.last;
    const dt = Math.min(0.05, ms / 1000) * this.speed;
    this.last = now;
    const t0 = performance.now();
    this.step(dt);
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.governor) this.govern(ms, performance.now() - t0);
  };

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.lost) return;
    this.renderer.setRenderTarget(null);
    this.renderer.clear();
  }

  step(dt: number) {
    this.onFrame?.(dt);
    // a reused list: no allocation per frame (and new effects start next frame)
    const list = this.fxList;
    list.length = 0;
    for (const f of this.fx) list.push(f);
    for (const f of list) if (!f.update(dt)) this.remove(f);
    list.length = 0;
    this.particles.update(dt);
    this.backdrop.update(dt);
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 2.2);
    const s = this.shakeAmt * this.shakeAmt * 0.35;
    this.camera.position.set(this.camBase.x + (Math.random() - 0.5) * s, this.camBase.y + (Math.random() - 0.5) * s, this.camBase.z);
    this.camera.lookAt(this.camLook);
    if (this.lost) return;
    if (this.post) {
      const u = this.post.comp.uniforms;
      u.uChroma.value = this.chroma * 0.035;
      u.uFlash.value = this.flash * 0.85;
      this.post.render(this.renderer, this.scene, this.camera);
    } else this.renderer.render(this.scene, this.camera);
    // pulses last a beat (a few frames), not a whole effect
    this.chroma = this.chroma > 0.05 ? this.chroma * 0.4 : 0;
    this.flash = this.flash > 0.05 ? this.flash * 0.4 : 0;
  }

  private resetGovernor() {
    this.ft.fill(0);
    this.work.fill(0);
    this.ftSum = this.workSum = 0;
    this.ftI = this.ftN = 0;
    this.goodFor = 0;
  }

  /**
   * Rolling 60-frame average of the frame interval: above 22 ms step down a tier;
   * comfortably fast for 3 s step back up. "Fast" is under 14 ms, or holding the
   * display's 60 Hz with little work per frame (a 60 Hz phone never gets under 14).
   * Stepping up and then straight back down doubles the wait before trying again.
   */
  private govern(ms: number, workMs: number) {
    const x = Math.min(ms, 50);
    const i = this.ftI;
    this.ftSum += x - this.ft[i];
    this.workSum += workMs - this.work[i];
    this.ft[i] = x;
    this.work[i] = workMs;
    this.ftI = (i + 1) % WINDOW;
    if (this.ftN < WINDOW) {
      this.ftN++;
      return;
    }
    const avg = this.ftSum / WINDOW;
    const work = this.workSum / WINDOW;
    const now = performance.now();
    if (avg > SLOW_MS && this.level > 0) {
      if (now - this.lastUp < 5000) this.upWait = Math.min(this.upWait * 2, 48);
      this.tier = this.level - 1;
      return;
    }
    const fast = avg < FAST_MS || (avg < 17.5 && work < 6);
    this.goodFor = fast ? this.goodFor + x / 1000 : 0;
    if (this.goodFor >= this.upWait && this.level < this.levels.length - 1) {
      this.lastUp = now;
      this.tier = this.level + 1;
    }
  }

  /** Everything still on stage. */
  get busy() {
    return this.fx.size > 0 || this.particles.active > 0;
  }

  clear() {
    for (const f of [...this.fx]) this.remove(f);
    this.particles.clear();
  }

  private handleVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else this.schedule();
  };

  private handleLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
    this.warm = null;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.onLost?.();
  };

  private handleRestore = () => {
    // three.js re-creates its GL state; textures and buffers re-upload on next use.
    // The base materials' programs went with the old context: compile them again.
    this.lost = false;
    this.resize();
    void this.prewarm();
    this.onRestore?.();
  };

  dispose() {
    this.stop();
    this.clear();
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.handleLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.handleRestore, false);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.particles.dispose();
    this.backdrop.dispose();
    this.post?.dispose();
    this.renderer.dispose();
    // Free the context now (phones cap live WebGL contexts) instead of waiting for GC.
    this.renderer.forceContextLoss();
  }
}
