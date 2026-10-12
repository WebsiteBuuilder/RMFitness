// The 3D stage: one WebGL canvas over the duel, drawing only while a cinematic
// plays (so it costs nothing between them). Primitives: Figure (a card's art
// pushed out into 3D by its depth map, able to reveal, glow and shatter),
// CardPanel (a flat card: backs, spells, traps), Particles (one pooled GPU
// sprite system), Ribbon (beams, bolts, slashes, tendrils) and Ring (summoning
// circles, shockwaves, the Shadow Realm eye).
import { AddEquation, BufferAttribute, CustomBlending, BufferGeometry, CanvasTexture, DataTexture, DoubleSide, LinearFilter, Mesh, NormalBlending, OneFactor, OneMinusSrcAlphaFactor, PerspectiveCamera, PlaneGeometry, Points, RedFormat, Scene, ShaderMaterial, Vector3, WebGLRenderer } from 'three';
import { DEPTH_SIZE, type ArtData, cardBack } from './depth';

export type Quality = 'full' | 'fast';

/**
 * Glow blending for a premultiplied-alpha canvas: colors add up, and alpha grows
 * only as much as the glow is bright, so glows light the duel underneath instead
 * of painting black boxes over it.
 */
const GLOW = { blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor, blendSrcAlpha: OneFactor, blendDstAlpha: OneMinusSrcAlphaFactor } as const;
const GLOW_OUT = 'vec3 o = min(vec3(1.0), OUT); gl_FragColor = vec4(o, max(o.r, max(o.g, o.b)));';

export const rgb = (hex: number) => new Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
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
    this.mat = new ShaderMaterial({
      vertexShader: FIG_VERT,
      fragmentShader: FIG_FRAG,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      side: DoubleSide,
      uniforms: {
        uArt: { value: this.tex },
        uDepth: { value: this.depthTex },
        uDepthAmt: { value: depthAmt },
        uShatter: { value: 0 },
        uTime: { value: 0 },
        uWave: { value: 1 },
        uReveal: { value: 1 },
        uOpacity: { value: 1 },
        uTint: { value: 0 },
        uCut: { value: 1 },
        uDark: { value: 0 },
        uGlow: { value: rgb(glow) },
      },
    });
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
    this.mat = new ShaderMaterial({
      vertexShader: BASIC_VERT,
      fragmentShader: PANEL_FRAG,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      side: DoubleSide,
      uniforms: { uMap: { value: this.tex }, uOpacity: { value: 1 }, uTint: { value: 0 }, uGlow: { value: rgb(glow) }, uSheen: { value: -1 } },
    });
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
    this.mat = new ShaderMaterial({ vertexShader: P_VERT, fragmentShader: P_FRAG, transparent: true, premultipliedAlpha: true, depthWrite: false, ...GLOW, uniforms: { uPx: { value: 300 } } });
    this.points = new Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
  }

  emit(o: Emit, count = 1) {
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
      this.pull.set(p ? [p.x, p.y, p.strength, p.swirl] : [0, 0, 0, 0], i * 4);
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
    for (const name of ['position', 'aColor', 'aSize', 'aAlpha']) this.geo.getAttribute(name).needsUpdate = true;
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
    this.mat = new ShaderMaterial({
      vertexShader: RIB_VERT,
      fragmentShader: RIB_FRAG,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      ...GLOW,
      side: DoubleSide,
      uniforms: { uColor: { value: rgb(color) }, uOpacity: { value: 1 }, uHead: { value: 1.05 }, uTail: { value: -0.1 }, uTime: { value: 0 }, uFlow: { value: flow } },
    });
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
    this.mat = new ShaderMaterial({
      vertexShader: BASIC_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      ...GLOW,
      side: DoubleSide,
      uniforms: {
        uColor: { value: rgb(color) },
        uOpacity: { value: 1 },
        uInner: { value: opts.inner ?? 0.72 },
        uOuter: { value: opts.outer ?? 0.92 },
        uGlyph: { value: (glyph % 9973) + 0.5 },
        uSpin: { value: 0 },
        uStar: { value: opts.star ?? 0 },
        uEye: { value: opts.eye ? 0.001 : 0 },
        uTime: { value: 0 },
      },
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
    this.mat = new ShaderMaterial({
      vertexShader: BASIC_VERT,
      fragmentShader: BG_FRAG,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: false,
      blending: NormalBlending,
      uniforms: { uColor: { value: rgb(0x0a1030) }, uOpacity: { value: 0 }, uTime: { value: 0 }, uVortex: { value: 0 } },
    });
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

// ---------------------------------------------------------------- Stage
export class Stage {
  renderer: WebGLRenderer;
  scene = new Scene();
  camera = new PerspectiveCamera(38, 1, 0.1, 100);
  particles: Particles;
  backdrop = new Backdrop();
  private fx = new Set<Fx>();
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
  quality: Quality;
  onFrame: ((dt: number) => void) | null = null;
  running = false;

  constructor(
    public canvas: HTMLCanvasElement,
    quality: Quality,
  ) {
    this.quality = quality;
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: quality === 'full', powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.particles = new Particles(quality === 'full' ? 2600 : 1400);
    this.scene.add(this.backdrop.mesh, this.particles.points);
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality === 'full' ? 2 : 1.25);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
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

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000) * this.speed;
      this.last = now;
      this.step(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.renderer.clear();
  }

  step(dt: number) {
    this.onFrame?.(dt);
    for (const f of [...this.fx]) if (!f.update(dt)) this.remove(f);
    this.particles.update(dt);
    this.backdrop.update(dt);
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 2.2);
    const s = this.shakeAmt * this.shakeAmt * 0.35;
    this.camera.position.set(this.camBase.x + (Math.random() - 0.5) * s, this.camBase.y + (Math.random() - 0.5) * s, this.camBase.z);
    this.camera.lookAt(this.camLook);
    this.renderer.render(this.scene, this.camera);
  }

  /** Everything still on stage. */
  get busy() {
    return this.fx.size > 0 || this.particles.active > 0;
  }

  clear() {
    for (const f of [...this.fx]) this.remove(f);
    this.particles.clear();
  }

  dispose() {
    this.stop();
    this.clear();
    this.particles.dispose();
    this.backdrop.dispose();
    this.renderer.dispose();
  }
}
