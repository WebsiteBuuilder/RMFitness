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
  InstancedBufferAttribute,
  InstancedMesh,
  Object3D,
  RedFormat,
  Scene,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
  type Camera,
  type IUniform,
} from 'three';
import { DEPTH_SIZE, type ArtData, cardBack } from './depth';
import { DEFAULT_FADE, tuneFor } from './overrides';

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
/** Value noise periodic in x with period `per` (an integer): wraps around a circle with no seam. */
const PNOISE_GLSL = /* glsl */ `
float pnoise(vec2 p, float per){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  float i0 = mod(i.x, per); float i1 = mod(i.x + 1.0, per);
  return mix(mix(hash12(vec2(i0, i.y)), hash12(vec2(i1, i.y)), u.x), mix(hash12(vec2(i0, i.y + 1.0)), hash12(vec2(i1, i.y + 1.0)), u.x), u.y); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
/** distance to the nearest Voronoi cell edge (F2 - F1): crack lines */
float vedge(vec2 x){ vec2 n = floor(x); vec2 f = fract(x); float d1 = 8.0; float d2 = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 g = vec2(float(i), float(j)); vec2 r = g + hash22(n + g) - f; float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
  return sqrt(d2) - sqrt(d1); }
`;

// ---------------------------------------------------------------- Figure
// A figure is the card art on a subdivided plane pushed out by its relief map.
// It is lit like a solid: normals come from the relief (central differences), a
// warm key light from the upper left front, a palette-tinted fresnel rim, a hemi
// ambient and a cheap relief AO. A second draw of the same mesh and program
// (uWall = 1), pushed back and darkened with the matte dilated, is the slab's
// side wall when the camera swings round; a ContactShadow sits under the feet.
// Both are children of figure.mesh, so they come and go with it.
//
// Silhouettes: the relief falls to 0 across the matte's edge band (and toward the
// art's border), so the outline sits flat on the plane instead of ballooning out
// or smearing the art across a stretched skirt; the art's border fades out along
// a broken line instead of a hard straight cut.
// Lighting discipline: white / chrome / low-saturation subjects (measured once per
// art, plus per-pixel brightness) get less specular, rim and key light, so they
// keep their painted texture; lighting adds form without washing out the colors.
// Per-card tunes (src/art/overrides.ts) scale the subject about its feet (uZoom),
// set its relief, caps and border fade.

/** Shared by the figure and the cracks on it: art uv from mesh uv and the displaced height. */
const FIG_DISP_GLSL = /* glsl */ `
vec2 artUv(vec2 m){ return uFoot + (m - uFoot) * uZoom; }
float borderIn(vec2 a){ return min(min(a.x, 1.0 - a.x), min(a.y, 1.0 - a.y)); }
float figHeight(vec2 a){
  vec4 t = texture2D(uDepth, a);
  float d = t.r;
  if (uMatte > 0.5) {
    // a blurred matte (9 taps over ~3 grid cells): 0 outside, 1 well inside
    float g = uGrid * 1.5;
    float s = t.a * 0.36;
    s += 0.08 * (texture2D(uDepth, a + vec2(g, 0.0)).a + texture2D(uDepth, a - vec2(g, 0.0)).a + texture2D(uDepth, a + vec2(0.0, g)).a + texture2D(uDepth, a - vec2(0.0, g)).a);
    g *= 2.0;
    s += 0.08 * (texture2D(uDepth, a + vec2(g, g)).a + texture2D(uDepth, a - vec2(g, g)).a + texture2D(uDepth, a + vec2(g, -g)).a + texture2D(uDepth, a - vec2(g, -g)).a);
    d *= smoothstep(0.42, 0.95, s);
  }
  // flat toward the art's border (and outside it, when zoomed out)
  return d * smoothstep(0.0, uFade * 1.3 + 0.02, borderIn(a));
}
`;

const FIG_VERT = /* glsl */ `
attribute vec3 aCenter;
attribute vec3 rnd;
uniform sampler2D uDepth;
uniform float uDepthAmt;
uniform float uShatter;
uniform float uTime;
uniform float uWave;
uniform float uMatte;
uniform float uWall;
uniform float uThick;
uniform float uGrid;
uniform float uZoom;
uniform float uFade;
uniform vec2 uFoot;
varying vec2 vUv;
varying vec2 vMesh;
varying float vD;
varying vec3 vViewPos;
varying vec3 vNx;
varying vec3 vNy;
varying vec3 vNz;
${FIG_DISP_GLSL}
void main(){
  vMesh = uv;
  vec2 a = artUv(uv);
  vUv = a;
  vD = texture2D(uDepth, a).r;
  float d = figHeight(a);
  vec3 p = position;
  // the back of the slab: flatter, a little behind
  p.z += uWall > 0.5 ? d * uDepthAmt * 0.35 - uThick : d * uDepthAmt;
  // living art: the subject breathes and sways a little
  p.z += sin(uTime * 2.0 + p.y * 3.0) * 0.015 * d;
  p.x += sin(uTime * 1.3 + p.y * 2.0) * 0.01 * d * uWave;
  if (uShatter > 0.0) {
    vec3 c = aCenter;
    c.z += figHeight(artUv(c.xy + 0.5)) * uDepthAmt;
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
  vNx = normalMatrix * vec3(1.0, 0.0, 0.0);
  vNy = normalMatrix * vec3(0.0, 1.0, 0.0);
  vNz = normalMatrix * vec3(0.0, 0.0, 1.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const FIG_FRAG = /* glsl */ `
uniform sampler2D uArt;
uniform sampler2D uDepth;
uniform float uMatte;
uniform float uReveal;
uniform float uOpacity;
uniform float uTint;
uniform float uCut;
uniform float uShatter;
uniform float uTime;
uniform float uDark;
uniform float uWall;
uniform float uHQ;
uniform float uEdge;
uniform float uLight;
uniform float uTame;
uniform float uSpec;
uniform float uRimAmt;
uniform float uFade;
uniform float uPulse;
uniform vec3 uFlash;
uniform vec2 uTexel;
uniform vec3 uGlow;
uniform vec3 uRim;
varying vec2 vUv;
varying vec2 vMesh;
varying float vD;
varying vec3 vViewPos;
varying vec3 vNx;
varying vec3 vNy;
varying vec3 vNz;
${NOISE_GLSL}
/** relief for the normals, flattened across the matte's edge like the mesh */
float hgt(vec2 uv){ vec4 t = texture2D(uDepth, uv); return t.r * mix(1.0, smoothstep(0.3, 0.9, t.a), uMatte); }
float bIn(vec2 a){ return min(min(a.x, 1.0 - a.x), min(a.y, 1.0 - a.y)); }
void main(){
  vec4 col = texture2D(uArt, vUv);
  vec4 dm = texture2D(uDepth, vUv);
  // the art's border fades out along a broken line (never a straight cut); the mesh's own edge too
  float bn = bIn(vUv) + (vnoise(vUv * 11.0 + 3.7) - 0.5) * uFade * 0.9;
  float edge = smoothstep(0.0, uFade, bn) * smoothstep(0.0, 0.02, bIn(vMesh));
  float ma = dm.a;
  float guess = vD;
  if (uWall > 0.5) {
    // the wall's matte is dilated ~1.5 px so it also rims the figure with a dark outline
    vec2 t = uTexel * 1.5;
    ma = max(ma, max(max(texture2D(uDepth, vUv + vec2(t.x, 0.0)).a, texture2D(uDepth, vUv - vec2(t.x, 0.0)).a), max(texture2D(uDepth, vUv + vec2(0.0, t.y)).a, texture2D(uDepth, vUv - vec2(0.0, t.y)).a)));
    guess += 0.06;
  }
  // prebuilt figure maps carry the cut-out subject in alpha; otherwise guess it from depth
  float subj = mix(smoothstep(0.22, 0.5, guess), smoothstep(0.35, 0.65, ma), uMatte);
  float a = edge * mix(1.0, subj, uCut);
  float n = vnoise(vMesh * 9.0 + uTime * 0.3) * 0.28;
  float r = uReveal * 1.35 - (vMesh.y * 0.95 + n);
  float vis = smoothstep(0.0, 0.03, r);
  float rim = (1.0 - smoothstep(0.0, 0.1, abs(r))) * step(0.001, uReveal) * step(uReveal, 0.999);
  vec3 c = col.rgb;
  if (uWall > 0.5) {
    c = c * 0.16 + uRim * 0.05;
    a *= 1.0 - smoothstep(0.0, 0.12, uShatter);
  } else {
    // normals from the relief (central differences, tamed so painted detail stays painted)
    vec2 t = uTexel * 1.5;
    float hl = hgt(vUv - vec2(t.x, 0.0));
    float hr = hgt(vUv + vec2(t.x, 0.0));
    float hd = hgt(vUv - vec2(0.0, t.y));
    float hu = hgt(vUv + vec2(0.0, t.y));
    vec3 on = normalize(vec3((hl - hr) * 0.16, (hd - hu) * 0.16, t.x * 2.0));
    vec3 N = normalize(on.x * vNx + on.y * vNy + on.z * vNz);
    if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(-vViewPos);
    vec3 L = vec3(-0.45, 0.64, 0.62);
    float dif = max(dot(N, L), 0.0);
    float hemi = 0.5 + 0.5 * N.y;
    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.2);
    float ao = 1.0;
    float spec = 0.0;
    // bright, colorless pixels (white scales, silver bone, chrome) are tamed as well as bright arts
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    float tame = clamp(uTame + smoothstep(0.55, 0.9, lum) * (1.0 - smoothstep(0.15, 0.4, sat)) * 0.6, 0.0, 1.0);
    if (uHQ > 0.5) {
      // cheap AO: darker where the relief sits below its wider neighbourhood
      vec2 w = uTexel * 6.0;
      float nb = (hgt(vUv + w) + hgt(vUv - w) + hgt(vUv + vec2(w.x, -w.y)) + hgt(vUv + vec2(-w.x, w.y))) * 0.25;
      ao = clamp(1.0 - max(0.0, nb - hgt(vUv)) * 3.0, 0.55, 1.0);
      spec = pow(max(dot(N, normalize(L + V)), 0.0), 28.0) * 0.2 * uSpec * (1.0 - 0.85 * tame);
    }
    // form, not wash-out: ambient + key stays near 1, and below 1 for tamed (bright) art
    vec3 shade = vec3(0.46, 0.47, 0.54) * ao * (0.78 + 0.4 * hemi) + vec3(1.0, 0.92, 0.8) * dif * 0.66 * mix(1.0, ao, 0.5);
    shade = min(shade, vec3(mix(1.28, 1.02, tame)));
    vec3 lit = c * shade;
    lit += vec3(1.0, 0.95, 0.85) * spec * ao;
    lit += uRim * fres * uRimAmt * (1.0 - 0.7 * tame) * (0.4 + 0.6 * subj);
    // a palette glow just inside the silhouette (big monsters)
    float inner = smoothstep(0.35, 0.6, ma) * (1.0 - smoothstep(0.6, 0.97, ma)) * uMatte;
    lit += uRim * inner * uEdge * 0.8 * (1.0 - 0.5 * tame);
    c = mix(c, lit, uLight);
    float subjEdge = (1.0 - abs(subj * 2.0 - 1.0)) * uCut;
    float scan = 0.5 + 0.5 * sin(vMesh.y * 160.0 - uTime * 6.0);
    c += uGlow * subjEdge * ((0.4 + 0.2 * scan) * (1.0 - 0.4 * tame) + uPulse * 1.6);
    // ready to attack: a soft palette pulse over the body and its rim
    c += uGlow * uPulse * (0.1 + fres * 0.5);
    // hit: a red flash
    c = mix(c, c * 0.5 + uFlash, clamp(max(uFlash.r, max(uFlash.g, uFlash.b)), 0.0, 1.0) * 0.6);
  }
  c = mix(c, vec3(1.0), uTint);
  c = mix(c, c * vec3(0.35, 0.15, 0.55), uDark);
  c += uGlow * rim * 2.2;
  float alpha = (a * vis + rim * a) * uOpacity;
  alpha *= 1.0 - smoothstep(0.55, 1.0, uShatter);
  // where the relief turns edge-on to the camera the art would stretch into streaks: let it go soft instead
  vec3 fn = cross(dFdx(vViewPos), dFdy(vViewPos));
  float facing = abs(dot(fn, normalize(vViewPos))) / max(length(fn), 1e-12);
  alpha *= mix(1.0, smoothstep(0.1, 0.32, facing), uMatte * (1.0 - step(0.001, uShatter)));
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(c * alpha, alpha);
}`;

/** Where a figure's subject stands in its art (uv: 0..1, v up), measured once per art. */
export interface Footprint {
  /** horizontal center of the feet */
  u: number;
  /** the lowest point of the subject */
  v: number;
  /** the subject's width at its feet */
  w: number;
  /** the subject's bounding box */
  top: number;
  left: number;
  right: number;
  /** relief 0..1 around the feet */
  relief: number;
  /** the per-card size multiplier already folded into this footprint (figureFoot); 1 for footprint() */
  scale?: number;
}

const FOOTPRINTS = new WeakMap<ArtData, Footprint>();
const FP_N = 64;

/** The subject's footprint (one small read of the relief or guessed depth, cached per art). */
export function footprint(art: ArtData): Footprint {
  const have = FOOTPRINTS.get(art);
  if (have) return have;
  let n = FP_N;
  let mask: Float32Array;
  let rel: Float32Array;
  try {
    if (art.relief) {
      const c = document.createElement('canvas');
      c.width = c.height = n;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(art.relief, 0, 0, n, n);
      const px = g.getImageData(0, 0, n, n).data;
      mask = new Float32Array(n * n);
      rel = new Float32Array(n * n);
      for (let i = 0; i < n * n; i++) {
        mask[i] = px[i * 4 + 3] / 255;
        rel[i] = px[i * 4] / 255;
      }
    } else {
      n = DEPTH_SIZE;
      mask = new Float32Array(n * n);
      rel = new Float32Array(n * n);
      for (let i = 0; i < n * n; i++) {
        rel[i] = art.depth[i] / 255;
        mask[i] = rel[i] > 0.4 ? 1 : 0;
      }
    }
  } catch {
    const fp = { u: 0.5, v: 0.08, w: 0.5, top: 0.92, left: 0.2, right: 0.8, relief: 0.5 };
    FOOTPRINTS.set(art, fp);
    return fp;
  }
  // rows top to bottom (image space); a row counts once it has a few subject pixels
  const minCount = Math.max(2, Math.round(n * 0.03));
  let top = -1;
  let bottom = -1;
  let left = n;
  let right = -1;
  for (let y = 0; y < n; y++) {
    let cnt = 0;
    for (let x = 0; x < n; x++)
      if (mask[y * n + x] > 0.5) {
        cnt++;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    if (cnt >= minCount) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  let fp: Footprint;
  if (bottom < 0) fp = { u: 0.5, v: 0.08, w: 0.5, top: 0.92, left: 0.2, right: 0.8, relief: 0.5 };
  else {
    const band = Math.max(1, Math.round((bottom - top) * 0.1));
    let sx = 0;
    let cnt = 0;
    let rs = 0;
    let fl = n;
    let fr = -1;
    for (let y = bottom - band; y <= bottom; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (mask[i] <= 0.5) continue;
        sx += x;
        rs += rel[i];
        cnt++;
        fl = Math.min(fl, x);
        fr = Math.max(fr, x);
      }
    fp = {
      u: cnt ? (sx / cnt + 0.5) / n : 0.5,
      v: 1 - (bottom + 1) / n,
      w: cnt ? Math.max(0.12, (fr - fl + 1) / n) : 0.4,
      top: 1 - top / n,
      left: left / n,
      right: (right + 1) / n,
      relief: cnt ? rs / cnt : 0.5,
    };
  }
  FOOTPRINTS.set(art, fp);
  return fp;
}

const FIGURE_FEET = new WeakMap<ArtData, Footprint>();

/**
 * The footprint as the Figure's mesh shows it: the per-card tune's foot point and
 * size (scaled about the feet, src/art/overrides.ts) folded in, in mesh uv.
 * Board and cinematics place figures with this.
 */
export function figureFoot(art: ArtData): Footprint {
  const have = FIGURE_FEET.get(art);
  if (have) return have;
  const f = footprint(art);
  const t = tuneFor(art.id);
  const k = t.scale ?? 1;
  const u = t.footU ?? f.u;
  const v = t.footV ?? f.v;
  const fp: Footprint = {
    u,
    v,
    w: f.w * k,
    top: Math.min(1, v + (f.top - v) * k),
    left: clamp01(u + (f.left - u) * k),
    right: clamp01(u + (f.right - u) * k),
    relief: f.relief,
    scale: k,
  };
  FIGURE_FEET.set(art, fp);
  return fp;
}

/** How bright and colorless a subject is: 0 = colorful mid-tones, 1 = white / silver / chrome. */
const LOOKS = new WeakMap<ArtData, number>();
export function artTame(art: ArtData): number {
  const have = LOOKS.get(art);
  if (have !== undefined) return have;
  let tame = 0;
  try {
    const n = 32;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(art.art, 0, 0, n, n);
    const px = g.getImageData(0, 0, n, n).data;
    let ma: Uint8ClampedArray | null = null;
    if (art.relief) {
      g.clearRect(0, 0, n, n);
      g.drawImage(art.relief, 0, 0, n, n);
      ma = g.getImageData(0, 0, n, n).data;
    }
    let w = 0;
    let lum = 0;
    let sat = 0;
    let chrome = 0;
    for (let i = 0; i < n * n; i++) {
      // the subject only (its matte), or the middle of the art
      const x = i % n;
      const y = (i / n) | 0;
      const k = ma ? ma[i * 4 + 3] / 255 : Math.max(0, 1 - Math.hypot(x / n - 0.5, y / n - 0.55) * 2.2);
      if (k < 0.05) continue;
      const r = px[i * 4] / 255;
      const gg = px[i * 4 + 1] / 255;
      const b = px[i * 4 + 2] / 255;
      const l = 0.299 * r + 0.587 * gg + 0.114 * b;
      const s = Math.max(r, gg, b) - Math.min(r, gg, b);
      w += k;
      lum += l * k;
      sat += s * k;
      if (l > 0.6 && s < 0.22) chrome += k;
    }
    if (w > 0) {
      lum /= w;
      sat /= w;
      chrome /= w;
      tame = clamp01(Math.max(clamp01((lum - 0.4) / 0.3) * clamp01((0.42 - sat) / 0.25), chrome * 1.6));
    }
  } catch {
    tame = 0;
  }
  tame = Math.max(tame, tuneFor(art.id).tame ?? 0);
  LOOKS.set(art, tame);
  return tame;
}

/**
 * Figure detail, set by the stage's quality governor: 0 = no side wall, no AO or
 * specular (fewest texture taps); 1 = side wall; 2 = everything.
 */
let figureDetail = 2;

/** A palette color made bright enough to light a rim (full value, a little toward white). */
export function rimColor(hex: number, out = new Vector3()): Vector3 {
  setRgb(out, hex);
  const m = Math.max(out.x, out.y, out.z);
  if (m > 0.001) out.multiplyScalar(1 / m);
  else out.set(1, 1, 1);
  return out.lerp(WHITE, 0.25);
}
const WHITE = new Vector3(1, 1, 1);
export function setFigureDetail(level: number) {
  figureDetail = level;
}

export interface FigureOptions {
  /** rim light color (0xRRGGBB); defaults to the glow color. Use the art's palette[0]. */
  rim?: number;
  /** 0..1 palette glow just inside the silhouette (monster tier >= 2) */
  edge?: number;
}

export class Figure implements Fx {
  mesh: Mesh;
  mat: ShaderMaterial;
  /** the slab's dark back (a child of mesh); hidden at low detail */
  wall: Mesh;
  private wallMat: ShaderMaterial;
  /** the soft shadow under its feet (a child of mesh) */
  shadow: ContactShadow;
  /** 0..1 how much shadow to show (set 0 while it flies or orbits off the ground) */
  shadowAmt = 1;
  /** where the subject stands in the art */
  foot: Footprint;
  /** fixed detail (0..2), or null to follow the stage's governor */
  detail: number | null = null;
  private appliedDetail = -1;
  private tex: CanvasTexture;
  private depthTex: DataTexture | Texture;
  alive = true;
  time = Math.random() * 10;

  constructor(art: ArtData, size: number, segs: number, glow: number, depthAmt: number, opts: FigureOptions = {}) {
    const geo = new PlaneGeometry(1, 1, segs, segs).toNonIndexed();
    const pos = geo.getAttribute('position');
    const n = pos.count;
    const centroid = new Float32Array(n * 3);
    const rnd = new Float32Array(n * 3);
    for (let t = 0; t < n; t += 3) {
      const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
      const cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
      const r0 = Math.random();
      const r1 = Math.random();
      const r2 = Math.random();
      for (let k = 0; k < 3; k++) {
        const i = (t + k) * 3;
        centroid[i] = cx;
        centroid[i + 1] = cy;
        rnd[i] = r0;
        rnd[i + 1] = r1;
        rnd[i + 2] = r2;
      }
    }
    geo.setAttribute('aCenter', new BufferAttribute(centroid, 3));
    geo.setAttribute('rnd', new BufferAttribute(rnd, 3));
    this.tex = new CanvasTexture(art.art);
    this.tex.minFilter = LinearFilter;
    this.tex.generateMipmaps = false;
    this.depthTex = art.relief ? new Texture(art.relief) : new DataTexture(art.depth, DEPTH_SIZE, DEPTH_SIZE, RedFormat);
    this.depthTex.flipY = true;
    this.depthTex.magFilter = LinearFilter;
    this.depthTex.minFilter = LinearFilter;
    this.depthTex.generateMipmaps = false;
    this.depthTex.needsUpdate = true;
    const texN = art.relief ? art.relief.naturalWidth || 256 : DEPTH_SIZE;
    const tune = tuneFor(art.id);
    this.foot = figureFoot(art);
    const f = this.foot;
    this.mat = material('figure', {
      uArt: this.tex,
      uDepth: this.depthTex,
      uDepthAmt: depthAmt * (tune.relief ?? 1),
      uZoom: 1 / (f.scale ?? 1),
      uFoot: new Vector2(f.u, f.v),
      uFade: tune.fade ?? DEFAULT_FADE,
      uTame: artTame(art),
      uSpec: tune.spec ?? 1,
      uRimAmt: tune.rim ?? 1,
      uFlash: new Vector3(0, 0, 0),
      uMatte: art.relief ? 1 : 0,
      uGlow: rgb(glow),
      uRim: rimColor(opts.rim ?? glow),
      uEdge: opts.edge ?? 0,
      uTexel: new Vector2(1 / texN, 1 / texN),
      uGrid: 1 / segs,
    });
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.scale.setScalar(size);
    // the wall: same geometry and program; it shares every uniform but its own uWall
    this.wallMat = material('figure', {});
    const shared: Record<string, IUniform> = { ...this.mat.uniforms, uWall: { value: 1 } };
    this.wallMat.uniforms = shared;
    this.wall = new Mesh(geo, this.wallMat);
    this.wall.renderOrder = -1;
    this.mesh.add(this.wall);
    // the contact shadow, flat on the ground under the feet
    this.shadow = new ContactShadow();
    const sw = Math.max(0.3, f.w * 1.35);
    const sm = this.shadow.mesh;
    sm.scale.set(sw, sw * 0.9, 1);
    sm.rotation.x = -1.2;
    sm.position.set(f.u - 0.5, f.v - 0.5 + 0.01, f.relief * this.u.uDepthAmt.value * 0.45);
    sm.renderOrder = -2;
    this.mesh.add(sm);
    this.applyDetail();
  }

  get u() {
    return this.mat.uniforms as Record<string, { value: any }>;
  }

  private applyDetail() {
    const d = this.detail ?? figureDetail;
    if (d === this.appliedDetail) return;
    this.appliedDetail = d;
    this.wall.visible = d >= 1;
    this.u.uHQ.value = d >= 2 ? 1 : 0;
  }

  update(dt: number) {
    this.time += dt;
    const u = this.u;
    u.uTime.value = this.time;
    this.applyDetail();
    const s = this.shadow.u;
    s.uOpacity.value = this.shadowAmt * u.uOpacity.value * clamp01(1 - u.uShatter.value * 4) * clamp01(u.uReveal.value * 3) * (1 - u.uTint.value * 0.6);
    s.uTime.value = this.time;
    return this.alive;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.wallMat.dispose();
    this.shadow.dispose();
    this.tex.dispose();
    this.depthTex.dispose();
  }
}

// ---------------------------------------------------------------- ContactShadow
const SHADOW_FRAG = /* glsl */ `
uniform float uOpacity;
uniform float uDark;
uniform vec3 uRing;
uniform float uRingAmt;
uniform float uTime;
varying vec2 vUv;
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  // soft dark core (strongest right under the feet) plus a wide penumbra
  float core = 1.0 - smoothstep(0.0, 0.55, r);
  float pen = 1.0 - smoothstep(0.25, 1.0, r);
  float sh = (core * core * 0.55 + pen * 0.35) * uDark;
  // optional glowing base disc (field figures): a bright ring and a faint fill
  float ring = exp(-pow((r - 0.78) / 0.06, 2.0)) * (0.8 + 0.2 * sin(uTime * 2.4));
  float fill = (1.0 - smoothstep(0.55, 0.8, r)) * 0.18;
  vec3 g = uRing * (ring + fill) * uRingAmt;
  float a = sh * uOpacity;
  gl_FragColor = vec4(g * uOpacity, a);
}`;

/**
 * A soft elliptical shadow on the ground (and, with uRingAmt, a glowing base disc).
 * Premultiplied: the dark part darkens what is under it, the ring adds light.
 * Every Figure has one as figure.shadow; it can also stand alone.
 */
export class ContactShadow implements Fx {
  mesh: Mesh;
  mat: ShaderMaterial;
  alive = true;
  constructor(ring = 0xffffff, ringAmt = 0) {
    this.mat = material('shadow', { uRing: rgb(ring), uRingAmt: ringAmt });
    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.mat);
  }
  get u() {
    return this.mat.uniforms as Record<string, { value: any }>;
  }
  update(dt: number) {
    this.u.uTime.value += dt;
    return this.alive;
  }
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
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
${PNOISE_GLSL}
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
  float seg = mod(floor((ang / (2.0 * PI) + 0.5) * segs), segs);
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
    float swirl = pnoise(vec2((ang / (2.0 * PI) + 0.5) * 18.0, r * 6.0 - uTime * 2.0), 18.0);
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
${PNOISE_GLSL}
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  // the angle wraps seamlessly: periodic noise around the circle (no atan seam)
  float a = atan(p.y, p.x) / 6.2831853 + 0.5;
  float v = pnoise(vec2(a * 12.0 + r * 4.0 * uVortex - uTime * 1.5 * uVortex, r * 3.0 - uTime * 0.5), 12.0);
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

// ---------------------------------------------------------------- cinematic effects
// Veil (screen-space dim, vignette, colored flash, speed lines, glass crack),
// Glow (light shafts, flares, barrier dome, shockwave, vortex, ankh, sword, star),
// Crack (glowing fractures over a figure, riding its own geometry), Shards (one
// instanced mesh of pieces cut from a figure's art + matte) and CutIn (the slanted
// Master Duel-style summon band). One pooled material kind each.
const SCREEN_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const VEIL_FRAG = /* glsl */ `
uniform float uDim;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uCrack;
uniform float uCrackOp;
uniform vec2 uCrackAt;
uniform float uRed;
uniform float uSpeed;
uniform vec2 uFocus;
uniform float uAspect;
uniform float uTime;
varying vec2 vUv;
${NOISE_GLSL}
${PNOISE_GLSL}
void main(){
  vec2 asp = vec2(uAspect, 1.0);
  vec2 p = (vUv - uFocus) * asp;
  float r = length(p);
  // dim: a pool of light around the subject, darker toward the edges
  float vig = smoothstep(0.1, 0.75, length((vUv - 0.5) * vec2(max(uAspect, 0.7), 1.0)) * 1.25 + r * 0.35);
  float a = uDim * mix(0.7, 0.96, vig);
  vec3 L = vec3(0.0);
  if (uSpeed > 0.0) {
    float ang = atan(p.y, p.x) / 6.2831853 + 0.5;
    float s = pnoise(vec2(ang * 120.0, r * 2.5 - uTime * 7.0), 120.0);
    float line = smoothstep(0.7, 0.95, s) * smoothstep(0.14, 0.55, r);
    L += vec3(1.0) * line * uSpeed * 0.6;
  }
  if (uRed > 0.0) {
    float e = smoothstep(0.35, 1.0, length((vUv - 0.5) * 2.0));
    L += vec3(1.0, 0.1, 0.06) * e * uRed * 0.85;
    a = max(a, e * uRed * 0.5);
  }
  if (uCrack > 0.0) {
    vec2 q = (vUv - uCrackAt) * asp;
    float d = length(q);
    float m = 1.0 - smoothstep(uCrack * 0.55, uCrack * 0.75, d);
    float ang = atan(q.y, q.x) / 6.2831853 + 0.5;
    float jit = (pnoise(vec2(ang * 13.0, d * 9.0), 13.0) - 0.5) * 0.7;
    float rl = abs(fract(ang * 13.0 + jit) - 0.5);
    float radial = 1.0 - smoothstep(0.0, 0.006 / max(d, 0.03) + 0.004, rl);
    float cells = 1.0 - smoothstep(0.0, 0.035, vedge(q * (5.0 / (0.25 + d * 1.5)) + 3.7));
    float line = max(radial, cells * (1.0 - smoothstep(0.05, 0.35, d)) * 0.9 + cells * 0.35);
    L += vec3(0.92, 0.96, 1.0) * line * m * uCrackOp;
    a = max(a, line * m * 0.4 * uCrackOp);
  }
  L += uFlashColor * uFlash * (1.0 - 0.35 * min(r, 1.0));
  L = min(L, vec3(1.0));
  gl_FragColor = vec4(L, clamp(max(a, max(L.r, max(L.g, L.b))), 0.0, 1.0));
}`;

/** A full-screen layer: behind (the dim) or in front (flash, crack, speed lines). Persistent, driven by the director. */
export class Veil implements Fx {
  mesh: Mesh;
  mat: ShaderMaterial;
  constructor(front: boolean) {
    this.mat = material('veil', {});
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = front ? 60 : -20;
  }
  get u() {
    return this.mat.uniforms as Record<string, { value: any }>;
  }
  /** true when it draws nothing (and can be hidden) */
  get idle() {
    const u = this.u;
    return u.uDim.value < 0.003 && u.uFlash.value < 0.003 && (u.uCrack.value < 0.003 || u.uCrackOp.value < 0.003) && u.uRed.value < 0.003 && u.uSpeed.value < 0.003;
  }
  update(dt: number) {
    this.u.uTime.value += dt;
    this.mesh.visible = !this.idle;
    return true;
  }
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uOpacity;
uniform float uTime;
uniform float uMode;
uniform float uK;
uniform float uSeed;
varying vec2 vUv;
${NOISE_GLSL}
${PNOISE_GLSL}
float box(vec2 p, vec2 b){ vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  vec3 c = vec3(0.0);
  if (uMode < 0.5) {
    // light shaft: soft vertical beam, brightest low, flickering upward
    float core = exp(-p.x * p.x * 7.0);
    float fy = smoothstep(-1.0, -0.6, p.y) * (1.0 - smoothstep(0.0, 1.0, p.y));
    float n = 0.55 + 0.7 * vnoise(vec2(p.x * 2.5 + uSeed, p.y * 1.5 - uTime * 1.2));
    c = mix(uColor, vec3(1.0), core * core * 0.35) * core * fy * n * 0.75;
  } else if (uMode < 1.5) {
    // flare: hot core, halo, rays and a horizontal streak
    float core = exp(-r * r * 38.0);
    float halo = exp(-r * r * 5.0) * 0.5;
    float rays = pow(0.5 + 0.5 * sin(atan(p.y, p.x) * 7.0 + uSeed + uTime * 0.7), 10.0) * exp(-r * 3.2) * 0.5;
    float streak = exp(-abs(p.y) * 34.0) * exp(-abs(p.x) * 1.6) * uK;
    c = vec3(1.0) * core * 1.2 + uColor * (halo + rays) + mix(uColor, vec3(1.0), 0.5) * streak;
  } else if (uMode < 2.5) {
    // barrier dome: bright rim, lattice, a ripple running out
    float inside = 1.0 - smoothstep(0.96, 1.0, r);
    float lat = 0.0;
    for (int i = 0; i < 3; i++) {
      float a = float(i) * 2.0943951 + 0.3;
      float g = abs(fract(dot(p, vec2(cos(a), sin(a))) * 6.0) - 0.5);
      lat = max(lat, 1.0 - smoothstep(0.0, 0.05, g));
    }
    float fres = pow(r, 3.0);
    float ripple = exp(-pow((r - uK) * 9.0, 2.0));
    c = (uColor * (fres * 0.9 + lat * 0.22 * (0.25 + fres) + 0.06) + mix(uColor, vec3(1.0), 0.6) * ripple * 0.9) * inside;
    c += vec3(1.0) * exp(-pow((r - 0.97) * 40.0, 2.0)) * 0.7;
  } else if (uMode < 3.5) {
    // shockwave: a soft ring at radius uK, breaking up as it spreads
    float w = 0.06 + 0.14 * uK;
    float ring = exp(-pow((r - uK * 0.9) / w, 2.0));
    float n = 0.65 + 0.6 * pnoise(vec2((atan(p.y, p.x) / 6.2831853 + 0.5) * 18.0, r * 4.0 - uTime * 3.0), 18.0);
    c = mix(uColor, vec3(1.0), ring * 0.45) * ring * n * (1.0 - uK * 0.7);
  } else if (uMode < 4.5) {
    // vortex (Dark Hole): spiral arms around a black eye
    float a01 = atan(p.y, p.x) / 6.2831853 + 0.5;
    float sw = pnoise(vec2(a01 * 7.0 + log(r + 0.04) * 2.6 - uTime * 0.9, r * 2.0 - uTime * 0.4), 7.0);
    float arms = smoothstep(0.4, 0.85, sw);
    float hole = smoothstep(0.1, 0.32, r);
    float edge = 1.0 - smoothstep(0.65, 1.0, r);
    c = (uColor * arms * 1.3 + uColor2 * 0.25) * edge * hole + uColor2 * exp(-pow((r - 0.2) * 16.0, 2.0)) * 1.4;
  } else if (uMode < 5.5) {
    // ankh (Monster Reborn)
    float d = min(box(p - vec2(0.0, -0.38), vec2(0.085, 0.56)), box(p - vec2(0.0, 0.17), vec2(0.5, 0.075)));
    d = min(d, (abs(length((p - vec2(0.0, 0.56)) / vec2(0.28, 0.36)) - 1.0) - 0.26) * 0.3);
    float fill = 1.0 - smoothstep(0.0, 0.02, d);
    c = mix(uColor, vec3(1.0), 0.65) * fill + uColor * exp(-max(d, 0.0) * 12.0) * 0.75;
  } else if (uMode < 6.5) {
    // sword of light, point down (Swords of Revealing Light)
    float taper = clamp((p.y + 0.95) / 0.35, 0.0, 1.0);
    float blade = max(abs(p.x) - 0.1 * taper, abs(p.y + 0.2) - 0.75);
    float d = min(blade, box(p - vec2(0.0, 0.6), vec2(0.36, 0.05)));
    d = min(d, box(p - vec2(0.0, 0.78), vec2(0.05, 0.14)));
    d = min(d, length(p - vec2(0.0, 0.95)) - 0.06);
    float fill = 1.0 - smoothstep(0.0, 0.02, d);
    c = mix(uColor, vec3(1.0), 0.7) * fill + uColor * exp(-max(d, 0.0) * 10.0) * 0.8;
  } else {
    // four-point star (sparkles, greed)
    float star = exp(-abs(p.x * p.y) * 90.0) * exp(-r * 2.2) + exp(-r * r * 28.0);
    c = mix(uColor, vec3(1.0), 0.5) * star;
  }
  ${GLOW_OUT.replace('OUT', 'c * uOpacity')}
}`;

export type GlowMode = 'shaft' | 'flare' | 'dome' | 'shock' | 'vortex' | 'ankh' | 'sword' | 'star';
const GLOW_MODES: Record<GlowMode, number> = { shaft: 0, flare: 1, dome: 2, shock: 3, vortex: 4, ankh: 5, sword: 6, star: 7 };

/** An additive quad drawn by a procedural shape (see GlowMode). */
export class Glow implements Fx {
  mesh: Mesh;
  mat: ShaderMaterial;
  alive = true;
  constructor(w: number, h: number, mode: GlowMode, color: number, color2 = color) {
    this.mat = material('glow', { uColor: rgb(color), uColor2: rgb(color2), uMode: GLOW_MODES[mode], uSeed: Math.random() * 10, uOpacity: 0 });
    this.mesh = new Mesh(new PlaneGeometry(w, h), this.mat);
    this.mesh.renderOrder = mode === 'shaft' || mode === 'vortex' ? -5 : 7;
  }
  get u() {
    return this.mat.uniforms as Record<string, { value: any }>;
  }
  update(dt: number) {
    this.u.uTime.value += dt;
    return this.alive;
  }
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

const CRACK_VERT = /* glsl */ `
uniform sampler2D uDepth;
uniform float uDepthAmt;
uniform float uTime;
uniform float uMatte;
uniform float uGrid;
uniform float uZoom;
uniform float uFade;
uniform vec2 uFoot;
varying vec2 vUv;
varying float vD;
${FIG_DISP_GLSL}
void main(){
  // the same art uv and height as the figure's own vertex shader, so the cracks sit on its surface
  vUv = artUv(uv);
  vD = texture2D(uDepth, vUv).r;
  float d = figHeight(vUv);
  vec3 p = position;
  p.z += d * uDepthAmt + 0.004;
  p.z += sin(uTime * 2.0 + p.y * 3.0) * 0.015 * d;
  p.x += sin(uTime * 1.3 + p.y * 2.0) * 0.01 * d;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const CRACK_FRAG = /* glsl */ `
uniform sampler2D uDepth;
uniform float uMatte;
uniform float uCrack;
uniform float uOpacity;
uniform float uSeed;
uniform vec2 uOrigin;
uniform vec3 uColor;
varying vec2 vUv;
varying float vD;
${NOISE_GLSL}
${PNOISE_GLSL}
void main(){
  float subj = mix(smoothstep(0.22, 0.5, vD), smoothstep(0.3, 0.7, texture2D(uDepth, vUv).a), uMatte);
  float d = length(vUv - uOrigin);
  float m = 1.0 - smoothstep(uCrack * 1.25 - 0.12, uCrack * 1.25, d);
  float e = vedge(vUv * 6.0 + uSeed);
  float e2 = vedge(vUv * 14.0 + uSeed * 1.7);
  float line = (1.0 - smoothstep(0.0, 0.045, e)) + (1.0 - smoothstep(0.0, 0.03, e2)) * 0.6 * smoothstep(0.35, 1.0, uCrack);
  vec3 c = (mix(uColor, vec3(1.0), 0.55) * line * 1.3 + uColor * exp(-e * 9.0) * 0.4) * m * subj;
  c += uColor * subj * uCrack * 0.18;
  ${GLOW_OUT.replace('OUT', 'c * uOpacity')}
}`;

type FigureLike = { mesh: Mesh; u: Record<string, { value: any }> };

/** Glowing fractures spreading over a figure (a child of its mesh, sharing its geometry). */
export class Crack implements Fx {
  mesh: Mesh;
  mat: ShaderMaterial;
  alive = true;
  constructor(
    private fig: FigureLike,
    color: number,
    origin = { u: 0.5, v: 0.55 },
  ) {
    const f = fig.u;
    this.mat = material('crack', { uDepth: f.uDepth.value, uDepthAmt: f.uDepthAmt.value, uMatte: f.uMatte.value, uGrid: f.uGrid?.value ?? 0.02, uZoom: f.uZoom?.value ?? 1, uFade: f.uFade?.value ?? DEFAULT_FADE, uFoot: f.uFoot?.value ?? new Vector2(0.5, 0.08), uColor: rgb(color), uSeed: Math.random() * 50, uOrigin: new Vector2(origin.u, origin.v) });
    this.mesh = new Mesh(fig.mesh.geometry, this.mat);
    this.mesh.renderOrder = 9;
    this.mesh.frustumCulled = false;
    fig.mesh.add(this.mesh);
  }
  get u() {
    return this.mat.uniforms as Record<string, { value: any }>;
  }
  update() {
    this.u.uTime.value = this.fig.u.uTime.value;
    this.u.uDepthAmt.value = this.fig.u.uDepthAmt.value;
    return this.alive;
  }
  dispose() {
    // the geometry belongs to the figure
    this.mesh.removeFromParent();
    this.mat.dispose();
  }
}

const SHARD_VERT = /* glsl */ `
attribute vec4 aRect;
attribute vec4 aSeed;
uniform float uZoom;
uniform vec2 uFoot;
varying vec2 vUv;
varying vec2 vL;
varying vec4 vSeed;
void main(){
  vL = uv;
  vUv = uFoot + (aRect.xy + uv * aRect.zw - uFoot) * uZoom;
  vSeed = aSeed;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const SHARD_FRAG = /* glsl */ `
uniform sampler2D uArt;
uniform sampler2D uDepth;
uniform float uMatte;
uniform float uOpacity;
uniform float uHeat;
uniform vec3 uColor;
varying vec2 vUv;
varying vec2 vL;
varying vec4 vSeed;
void main(){
  // an irregular piece: three random cuts through the cell
  vec2 q = vL - 0.5;
  float m = 1.0;
  float edge = 0.5 - max(abs(q.x), abs(q.y));
  for (int i = 0; i < 3; i++) {
    float a = vSeed[i] * 6.2831853;
    float dd = 0.24 + 0.18 * fract(vSeed.w * float(i + 3) * 7.13);
    float s = dd - dot(q, vec2(cos(a), sin(a)));
    m *= step(0.0, s);
    edge = min(edge, s);
  }
  if (vUv.x < 0.0 || vUv.y < 0.0 || vUv.x > 1.0 || vUv.y > 1.0) discard;
  vec4 dm = texture2D(uDepth, vUv);
  float subj = uMatte > 0.5 ? smoothstep(0.3, 0.7, dm.a) : smoothstep(0.22, 0.5, dm.r);
  float a = m * subj * uOpacity;
  if (a < 0.01) discard;
  float rim = 1.0 - smoothstep(0.0, 0.06, edge);
  vec3 c = texture2D(uArt, vUv).rgb * (1.0 - uHeat * 0.3) + uColor * (rim * 1.3 + uHeat * 0.6);
  gl_FragColor = vec4(min(c, vec3(1.0)) * a, a);
}`;

/** A figure breaking apart: cols×rows instanced pieces of its own art, flying with gravity and spin. */
export class Shards implements Fx {
  mesh: InstancedMesh;
  mat: ShaderMaterial;
  alive = true;
  private n: number;
  private p: Float32Array; // x y z
  private v: Float32Array;
  private r: Float32Array; // rx ry rz
  private w: Float32Array;
  private s: Float32Array;
  private dummy = new Object3D();
  t = 0;
  gravity: number;
  life = 1.3;
  constructor(fig: FigureLike, color: number, cols = 5, rows = 6, gravity = 9) {
    const f = fig.u;
    this.n = cols * rows;
    this.gravity = gravity;
    this.mat = material('shards', { uArt: f.uArt.value, uDepth: f.uDepth.value, uMatte: f.uMatte.value, uColor: rgb(color), uZoom: f.uZoom?.value ?? 1, uFoot: f.uFoot?.value ?? new Vector2(0.5, 0.08) });
    const geo = new PlaneGeometry(1, 1);
    const rect = new Float32Array(this.n * 4);
    const seed = new Float32Array(this.n * 4);
    this.p = new Float32Array(this.n * 3);
    this.v = new Float32Array(this.n * 3);
    this.r = new Float32Array(this.n * 3);
    this.w = new Float32Array(this.n * 3);
    this.s = new Float32Array(this.n);
    const m = fig.mesh;
    const size = m.scale.x;
    const sizeY = m.scale.y;
    const pad = 1.3;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        const du = 1 / cols;
        const dv = 1 / rows;
        const u0 = i * du - (du * (pad - 1)) / 2;
        const v0 = j * dv - (dv * (pad - 1)) / 2;
        rect.set([u0, v0, du * pad, dv * pad], k * 4);
        seed.set([Math.random(), Math.random(), Math.random(), Math.random()], k * 4);
        const lx = ((i + 0.5) * du - 0.5) * size;
        const ly = ((j + 0.5) * dv - 0.5) * sizeY;
        this.p.set([m.position.x + lx, m.position.y + ly * Math.cos(m.rotation.x), m.position.z + ly * Math.sin(m.rotation.x) + 0.1], k * 3);
        this.r.set([m.rotation.x, 0, (Math.random() - 0.5) * 0.3], k * 3);
        this.s[k] = du * size * pad;
      }
    geo.setAttribute('aRect', new InstancedBufferAttribute(rect, 4));
    geo.setAttribute('aSeed', new InstancedBufferAttribute(seed, 4));
    this.mesh = new InstancedMesh(geo, this.mat, this.n);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.place();
  }
  get u() {
    return this.mat.uniforms as Record<string, { value: any }>;
  }
  /** Sends every piece flying out from (cx, cy), `power` world units per second. */
  burst(cx: number, cy: number, power: number, push = { x: 0, y: 0 }) {
    for (let k = 0; k < this.n; k++) {
      const dx = this.p[k * 3] - cx;
      const dy = this.p[k * 3 + 1] - cy;
      const d = Math.hypot(dx, dy) || 1;
      const sp = power * (0.5 + Math.random() * 0.8);
      this.v.set([(dx / d) * sp + push.x + (Math.random() - 0.5) * power * 0.4, (dy / d) * sp * 0.8 + push.y + power * (0.25 + Math.random() * 0.5), (0.4 + Math.random()) * power * 0.6], k * 3);
      this.w.set([(Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 10], k * 3);
    }
  }
  private place() {
    const d = this.dummy;
    const shrink = 1 - clamp01((this.t - this.life * 0.55) / (this.life * 0.45)) * 0.6;
    for (let k = 0; k < this.n; k++) {
      d.position.set(this.p[k * 3], this.p[k * 3 + 1], this.p[k * 3 + 2]);
      d.rotation.set(this.r[k * 3], this.r[k * 3 + 1], this.r[k * 3 + 2]);
      d.scale.setScalar(this.s[k] * shrink);
      d.updateMatrix();
      this.mesh.setMatrixAt(k, d.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  update(dt: number) {
    this.t += dt;
    const drag = Math.exp(-0.8 * dt);
    for (let k = 0; k < this.n; k++) {
      this.v[k * 3] *= drag;
      this.v[k * 3 + 1] = this.v[k * 3 + 1] * drag - this.gravity * dt;
      this.v[k * 3 + 2] *= drag;
      for (let a = 0; a < 3; a++) {
        this.p[k * 3 + a] += this.v[k * 3 + a] * dt;
        this.r[k * 3 + a] += this.w[k * 3 + a] * dt;
      }
    }
    this.place();
    this.u.uHeat.value = Math.max(0, 1 - this.t * 2.5);
    this.u.uOpacity.value = 1 - clamp01((this.t - this.life * 0.6) / (this.life * 0.4));
    return this.alive && this.t < this.life + 0.05;
  }
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.mat.dispose();
  }
}

const CUTIN_FRAG = /* glsl */ `
uniform sampler2D uArt;
uniform sampler2D uText;
uniform float uK;
uniform float uAspect;
uniform float uTime;
uniform float uOpacity;
uniform float uTextAspect;
uniform vec3 uColor;
uniform vec3 uColor2;
varying vec2 vUv;
${NOISE_GLSL}
void main(){
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float cs = 0.9781476;
  float sn = -0.2079117; // -12 degrees
  vec2 q = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y);
  q.y -= 0.03;
  float open = smoothstep(0.0, 0.12, uK) * (1.0 - smoothstep(0.88, 1.0, uK));
  float H = 0.16 * (0.25 + 0.75 * open);
  float W = uAspect * 0.5 / cs + 0.25;
  float xIn = q.x / (2.0 * W) + 0.5;
  float wipe = smoothstep(0.0, 0.2, uK) * 1.25;
  vec3 c = vec3(0.0);
  float a = 0.5 * open;
  // outside the band: dark, with fast diagonal streaks in the attribute color
  float st = smoothstep(0.78, 0.97, vnoise(vec2(q.y * 60.0, q.x * 0.7 + uTime * 12.0)));
  c += uColor * st * 0.6 * open;
  a = max(a, st * 0.6 * open);
  float inBand = step(abs(q.y), H) * step(xIn, wipe) * step(0.001, open);
  if (inBand > 0.5) {
    float slide = uK * 0.14 - 0.07;
    vec2 auv = vec2(0.5 + q.x * 1.5 + slide, 0.56 + q.y * 1.5);
    vec3 art = texture2D(uArt, clamp(auv, 0.0, 1.0)).rgb;
    float sp = smoothstep(0.62, 0.95, vnoise(vec2(q.y * 140.0, q.x * 1.1 - uTime * 26.0)));
    vec3 bc = art * 0.92 + vec3(1.0) * sp * 0.3;
    // shade toward the band's lower edge so the name reads
    bc *= mix(1.0, 0.45, smoothstep(0.0, -H, q.y) * 0.9);
    float edge = 1.0 - smoothstep(0.0, 0.012, H - abs(q.y));
    bc = mix(bc, mix(uColor2, vec3(1.0), 0.35), edge);
    float lead = exp(-pow((xIn - wipe) * 22.0, 2.0)) * (1.0 - smoothstep(0.12, 0.3, uK));
    bc += vec3(1.0) * lead;
    c = bc;
    a = 1.0;
  }
  // the name plate rides over the band, sliding in from the right
  float tk = smoothstep(0.08, 0.38, uK);
  float tx = (1.0 - tk) * (1.0 - tk) * 0.5 - uK * 0.03;
  float TW = min(uAspect * 0.94, 0.9);
  vec2 tuv = (q - vec2(tx, -0.07)) / vec2(TW, TW / uTextAspect) + 0.5;
  if (tuv.x > 0.0 && tuv.x < 1.0 && tuv.y > 0.0 && tuv.y < 1.0) {
    vec4 t = texture2D(uText, tuv);
    float ta = t.a * open * step(0.001, tk);
    c = mix(c, t.rgb, ta);
    a = max(a, ta);
  }
  gl_FragColor = vec4(c * a, a) * uOpacity;
}`;

/** The slanted cut-in for a big summon: the art races across a band, the name slams in. */
export class CutIn implements Fx {
  mesh: Mesh;
  mat: ShaderMaterial;
  alive = true;
  private art: CanvasTexture;
  private text: CanvasTexture;
  constructor(art: HTMLCanvasElement, title: string, sub: string, color: number, edge: number) {
    this.art = new CanvasTexture(art);
    this.art.minFilter = LinearFilter;
    this.art.generateMipmaps = false;
    const tc = cutInText(title, sub, color, edge);
    this.text = new CanvasTexture(tc);
    this.text.minFilter = LinearFilter;
    this.text.generateMipmaps = false;
    this.mat = material('cutin', { uArt: this.art, uText: this.text, uColor: rgb(color), uColor2: rgb(edge), uTextAspect: tc.width / tc.height });
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 55;
  }
  get u() {
    return this.mat.uniforms as Record<string, { value: any }>;
  }
  update(dt: number) {
    this.u.uTime.value += dt;
    return this.alive;
  }
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.art.dispose();
    this.text.dispose();
  }
}

const hexCss = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const DISPLAY_FONT = `"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif`;

/** The cut-in's name plate: big italic name with a gold/attribute edge, stats under it. */
function cutInText(title: string, sub: string, color: number, edge: number): HTMLCanvasElement {
  const W = 1024;
  const H = 256;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  if (!g) return cv;
  let fs = 92;
  const fontOf = (s: number) => `italic 900 ${s}px ${DISPLAY_FONT}`;
  g.font = fontOf(fs);
  const name = title.toUpperCase();
  while (fs > 34 && g.measureText(name).width > W - 70) g.font = fontOf((fs -= 4));
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const y = 40 + fs;
  g.lineJoin = 'round';
  g.shadowColor = hexCss(color);
  g.shadowBlur = 24;
  g.lineWidth = 12;
  g.strokeStyle = '#000';
  g.strokeText(name, W / 2, y);
  g.shadowBlur = 0;
  g.lineWidth = 4;
  g.strokeStyle = hexCss(edge);
  g.strokeText(name, W / 2, y);
  const grad = g.createLinearGradient(0, y - fs, 0, y);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.6, '#fff6dc');
  grad.addColorStop(1, hexCss(edge));
  g.fillStyle = grad;
  g.fillText(name, W / 2, y);
  if (sub) {
    g.font = `italic 800 40px ${DISPLAY_FONT}`;
    g.lineWidth = 8;
    g.strokeStyle = '#000';
    g.strokeText(sub, W / 2, y + 58);
    g.fillStyle = hexCss(edge);
    g.fillText(sub, W / 2, y + 58);
  }
  return cv;
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
export type MaterialKind = 'figure' | 'shadow' | 'panel' | 'particles' | 'ribbon' | 'ring' | 'backdrop' | 'veil' | 'glow' | 'crack' | 'shards' | 'cutin' | 'bright' | 'kawase' | 'composite';
export const MATERIAL_KINDS: readonly MaterialKind[] = ['figure', 'shadow', 'panel', 'particles', 'ribbon', 'ring', 'backdrop', 'veil', 'glow', 'crack', 'shards', 'cutin', 'bright', 'kawase', 'composite'];

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
      uniforms: uniforms({
        uArt: null,
        uDepth: null,
        uDepthAmt: 0.3,
        uMatte: 0,
        uShatter: 0,
        uTime: 0,
        uWave: 1,
        uReveal: 1,
        uOpacity: 1,
        uTint: 0,
        uCut: 1,
        uDark: 0,
        uGlow: new Vector3(1, 1, 1),
        uRim: new Vector3(1, 1, 1),
        uEdge: 0,
        uLight: 1,
        uHQ: 1,
        uWall: 0,
        uThick: 0.035,
        uGrid: 1 / 32,
        uTexel: new Vector2(1 / 256, 1 / 256),
        uZoom: 1,
        uFoot: new Vector2(0.5, 0.08),
        uFade: DEFAULT_FADE,
        uTame: 0,
        uSpec: 1,
        uRimAmt: 1,
        uPulse: 0,
        uFlash: new Vector3(0, 0, 0),
      }),
    }),
  shadow: () =>
    new ShaderMaterial({
      vertexShader: BASIC_VERT,
      fragmentShader: SHADOW_FRAG,
      ...FX,
      side: DoubleSide,
      uniforms: uniforms({ uOpacity: 1, uDark: 1, uRing: new Vector3(1, 1, 1), uRingAmt: 0, uTime: 0 }),
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
  veil: () =>
    new ShaderMaterial({
      vertexShader: SCREEN_VERT,
      fragmentShader: VEIL_FRAG,
      ...FX,
      depthTest: false,
      blending: NormalBlending,
      uniforms: uniforms({ uDim: 0, uFlash: 0, uFlashColor: new Vector3(1, 1, 1), uCrack: 0, uCrackOp: 1, uCrackAt: new Vector2(0.5, 0.5), uRed: 0, uSpeed: 0, uFocus: new Vector2(0.5, 0.5), uAspect: 0.5, uTime: 0 }),
    }),
  glow: () =>
    new ShaderMaterial({
      vertexShader: BASIC_VERT,
      fragmentShader: GLOW_FRAG,
      ...FX,
      ...GLOW,
      side: DoubleSide,
      uniforms: uniforms({ uColor: new Vector3(1, 1, 1), uColor2: new Vector3(1, 1, 1), uOpacity: 1, uTime: 0, uMode: 0, uK: 0, uSeed: 0 }),
    }),
  crack: () =>
    new ShaderMaterial({
      vertexShader: CRACK_VERT,
      fragmentShader: CRACK_FRAG,
      ...FX,
      ...GLOW,
      side: DoubleSide,
      uniforms: uniforms({ uDepth: null, uDepthAmt: 0.3, uTime: 0, uMatte: 0, uGrid: 0.02, uZoom: 1, uFade: DEFAULT_FADE, uFoot: new Vector2(0.5, 0.08), uCrack: 0, uOpacity: 1, uSeed: 0, uOrigin: new Vector2(0.5, 0.5), uColor: new Vector3(1, 1, 1) }),
    }),
  shards: () =>
    new ShaderMaterial({
      vertexShader: SHARD_VERT,
      fragmentShader: SHARD_FRAG,
      ...FX,
      side: DoubleSide,
      uniforms: uniforms({ uArt: null, uDepth: null, uMatte: 0, uOpacity: 1, uHeat: 1, uColor: new Vector3(1, 1, 1), uZoom: 1, uFoot: new Vector2(0.5, 0.08) }),
    }),
  cutin: () =>
    new ShaderMaterial({
      vertexShader: SCREEN_VERT,
      fragmentShader: CUTIN_FRAG,
      ...FX,
      depthTest: false,
      blending: NormalBlending,
      uniforms: uniforms({ uArt: null, uText: null, uK: 0, uAspect: 0.5, uTime: 0, uOpacity: 1, uTextAspect: 4, uColor: new Vector3(1, 1, 1), uColor2: new Vector3(1, 1, 1) }),
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
    // shards draw instanced: warm the instanced variant of their program
    const o = k === 'particles' ? new Points(dot, baseMaterial(k)) : k === 'shards' ? new InstancedMesh(plane, baseMaterial(k), 1) : new Mesh(plane, baseMaterial(k));
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

export const BASE_FOV = 38;

/** Smooth 1D value noise in -1..1 (camera shake: no per-frame random jitter). */
function noise1(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const h = (n: number) => {
    const x = Math.sin((n + seed * 57.13) * 127.1) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) + (h(i + 1) - h(i)) * u;
}

const SLOW_MS = 22;
const FAST_MS = 14;
const WINDOW = 60;

export class Stage {
  renderer: WebGLRenderer;
  scene = new Scene();
  camera = new PerspectiveCamera(BASE_FOV, 1, 0.1, 100);
  particles: Particles;
  backdrop = new Backdrop();
  private fx = new Set<Fx>();
  private fxList: Fx[] = [];
  private raf = 0;
  private last = 0;
  private shakeAmt = 0;
  private shakeT = 0;
  private shakeLook = new Vector3();
  private holdFor = 0;
  private holdScale = 1;
  private punchDeg = 0;
  private punchHold = 0;
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
    setFigureDetail(this.level === 0 ? 0 : this.level === 1 ? 1 : 2);
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
    // measured at the resting camera (z = 10, base fov) so a cinematic's camera moves never change the unit
    this.halfH = Math.tan((BASE_FOV * Math.PI) / 360) * 10;
    this.halfW = this.halfH * this.camera.aspect;
    this.particles.mat.uniforms.uPx.value = (h * dpr) / (2 * Math.tan((BASE_FOV * Math.PI) / 360));
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
   * Hit-stop: for `seconds` of real time everything runs at `scale` speed (a frozen
   * beat on impact). Measured in wall-clock time, so it never stretches at 0.05×.
   */
  hitStop(seconds: number, scale = 0.05) {
    this.holdFor = Math.max(this.holdFor, seconds);
    this.holdScale = scale;
  }

  /** Punch-in: narrows the field of view by `deg` for a beat, then eases back. */
  punch(deg: number, hold = 0.12) {
    this.punchDeg = Math.max(this.punchDeg, deg);
    this.punchHold = Math.max(this.punchHold, hold);
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
    let dt = Math.min(0.05, ms / 1000) * this.speed;
    if (this.holdFor > 0) {
      this.holdFor -= Math.min(0.05, ms / 1000);
      dt *= this.holdScale;
    }
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
    // the director may have stopped the stage this frame (idle): don't draw a last frame over the cleared canvas
    if (!this.running) return;
    // a reused list: no allocation per frame (and new effects start next frame)
    const list = this.fxList;
    list.length = 0;
    for (const f of this.fx) list.push(f);
    for (const f of list) if (!f.update(dt)) this.remove(f);
    list.length = 0;
    this.particles.update(dt);
    this.backdrop.update(dt);
    // shake: smooth value noise under a decaying envelope (no per-frame random jitter)
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 2.2);
    this.shakeT += dt * 22;
    const s = this.shakeAmt * this.shakeAmt * 0.32;
    const sx = noise1(this.shakeT, 1) * s;
    const sy = noise1(this.shakeT, 2) * s;
    this.camera.position.set(this.camBase.x + sx, this.camBase.y + sy, this.camBase.z);
    this.shakeLook.set(this.camLook.x + sx * 0.6, this.camLook.y + sy * 0.6, this.camLook.z);
    this.camera.lookAt(this.shakeLook);
    this.camera.rotateZ(noise1(this.shakeT * 0.7, 3) * s * 0.05);
    // punch-in zoom
    if (this.punchHold > 0) this.punchHold -= dt;
    else this.punchDeg *= Math.exp(-dt * 9);
    if (this.punchDeg < 0.02) this.punchDeg = 0;
    const fov = BASE_FOV - this.punchDeg;
    if (Math.abs(this.camera.fov - fov) > 1e-4) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
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
