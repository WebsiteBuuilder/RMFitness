// Living Field: a face-up Field Spell's landscape stays behind the duel as the arena
// for as long as the card is on the field. Each of the ten terrains (the same ones its
// cinematic picks) has its own place you can name at a glance: Umi rolls waves in from
// your edge, Yami fills the board with fog and blinking eyes, a volcano glows and
// throws embers, and so on. Each duelist's Field Spell takes their half of the screen
// (the opponent's mirrored, its ground at their edge); with only one up, it takes the
// whole arena. When the card lands, the landscape sweeps out across the board from its
// Field Zone with a bright front (right after the card's cinematic); when it leaves, it
// draws back into the zone.
//
// The same canvas carries the Danger state's ground: at low Life Points the duelist's
// half glows with red cracks that flare with the heartbeat.
//
// Kept cheap for phones: plain WebGL (no scene graph), one full-screen triangle drawn
// at half the screen's CSS resolution (a soft backdrop needs no more) and 30 fps, 20 if
// frames keep arriving late; nothing at all while no field and no danger is up, while a
// cinematic plays (it covers the duel), or while the tab is hidden. Time wraps every
// half hour so phones' 16-bit floats never make the motion step.
import { TERRAINS, type Terrain } from './families';
import { isLean, isLite, onArtSettings } from './settings';

const VERT = `attribute vec2 aPos; varying vec2 vUv; void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

/** Time wraps here (s): a single jump in the motion every half hour keeps 16-bit floats smooth. */
const T_WRAP = 1800;

export const FRAG = /* glsl */ `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
uniform vec2 uAspect;
uniform float uT;
uniform float uA; uniform float uB;
uniform float uAmtA; uniform float uAmtB;
uniform float uOnA; uniform float uOnB;
uniform vec2 uOA; uniform vec2 uOB;
uniform float uDanger; uniform float uDangerOpp; uniform float uBeat;
// (smoothstep with edge0 > edge1 is undefined in GLSL ES and some phones return 0: this one is defined both ways)
float sstep(float a, float b, float x){ float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float s = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
float vedge(vec2 x){ vec2 n = floor(x); vec2 f = fract(x); float d1 = 8.0; float d2 = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 g = vec2(float(i), float(j)); vec2 r = g + hash22(n + g) - f; float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
  return sqrt(d2) - sqrt(d1); }
// round soft specks: one per lit cell of v, a share dens of the cells lit
float dots(vec2 v, float dens, float r){ vec2 c = floor(v); vec2 o = hash22(c) * 0.6 + 0.2;
  return step(1.0 - dens, hash12(c + 17.0)) * sstep(r, 0.0, length(fract(v) - o)); }

// g: x across (half the screen's width is about 1), y up from the duelist's own edge of the board
// (just past their hand; below 0 is under the hand).
vec3 land(vec2 g, float t, float ter){
  float y = g.y;
  if (ter < 1.5) {
    // VOLCANO: a black-red sky, a lava glow along your edge, glowing cracks in the rock, embers rising
    vec3 c = mix(vec3(0.10, 0.025, 0.02), vec3(0.03, 0.01, 0.01), sstep(0.3, 3.8, y));
    float rim = sstep(1.5, 0.1, y + 0.35 * fbm(vec2(g.x * 1.4, t * 0.12)));
    // pools of lava glowing through the black rock, slowly churning (no branching lines: those are the danger cracks)
    // (hard bright rims on black rock: molten, not a sunset)
    float n = fbm(g * vec2(1.3, 2.2) + vec2(t * 0.04, -t * 0.03)) + 0.06 * sin(t * 1.4 + g.x * 5.0 + g.y * 3.0);
    float fade = sstep(2.8, 0.4, y);
    float pool = sstep(0.57, 0.6, n) * fade;
    float core = sstep(0.6, 0.7, n) * fade;
    float churn = 0.7 + 0.3 * sin(t * 1.6 + fbm(g * 3.0 + t * 0.2) * 6.0);
    c += vec3(1.0, 0.30, 0.04) * rim * (0.75 + 0.25 * sin(t * 1.3 + g.x * 2.0));
    // dark seams in the rock between the pools, a hot bright rim round each pool
    float seam = 1.0 - sstep(0.0, 0.05, vedge(g * 2.4 + 3.0));
    c *= 1.0 - seam * 0.6 * (1.0 - pool);
    c = mix(c, vec3(1.0, 0.29, 0.0) * (0.8 + 0.2 * churn), pool);
    c = mix(c, vec3(1.0, 0.83, 0.42) * (0.85 + 0.15 * churn), core * 0.85);
    c += vec3(1.0, 0.85, 0.5) * (pool - sstep(0.6, 0.615, n) * fade) * 0.9;
    float emb = dots(vec2(g.x * 5.0 + sin(y * 2.0 + t) * 0.3, y * 4.5 - t * 2.2), 0.12, 0.2) * sstep(4.4, 0.2, y);
    return c + vec3(1.0, 0.75, 0.35) * emb * 1.5;
  } else if (ter < 2.5) {
    // OCEAN: a deep sea with rows of waves rolling in toward you, foam on every crest, glints
    vec3 c = mix(vec3(0.04, 0.31, 0.42), vec3(0.03, 0.17, 0.27), sstep(0.0, 4.2, y));
    for (int i = 5; i >= 0; i--) {
      float fi = float(i);
      // (rows closer together and flatter toward the far side: the sea in perspective; each row rolls in)
      float base = 0.2 + fi * 0.62 - fi * fi * 0.045;
      float amp = 0.07 - fi * 0.009;
      float wy = base + amp * sin(g.x * (1.3 + fi * 0.5) + fi * 1.7 - t * 0.6) + amp * 0.35 * sin(g.x * (4.0 + fi) - t * 1.9 + fi * 2.3) - 0.08 * (0.5 + 0.5 * sin(t * 0.8 + fi * 0.9)) * (1.0 - fi * 0.12);
      float k = 1.0 - fi * 0.11;
      // (choppy crests, a dark trough under each wave)
      wy += 0.025 * (vnoise(vec2(g.x * 9.0 - t * 1.5, fi * 5.0)) - 0.5);
      vec3 water = mix(vec3(0.015, 0.12, 0.2), vec3(0.08, 0.50, 0.62), sstep(wy - 0.4, wy - 0.02, y));
      c = mix(c, water * k, sstep(wy + 0.02, wy - 0.04, y));
      float foam = exp(-pow((y - wy) * (11.0 + fi * 4.0), 2.0)) * (0.55 + 0.45 * vnoise(vec2(g.x * 5.0 - t * 0.8, fi * 3.0)));
      c += vec3(0.95, 1.0, 1.0) * foam * 0.8 * k;
    }
    float glint = dots(g * vec2(9.0, 12.0) + vec2(t * 0.4, 0.0), 0.05, 0.12) * (0.5 + 0.5 * sin(t * 4.0 + g.x * 20.0));
    return c + vec3(0.8, 0.95, 1.0) * glint * sstep(3.6, 0.3, y);
  } else if (ter < 3.5) {
    // FOREST: rows of treetops against a green dusk, light through the leaves, fireflies
    vec3 c = mix(vec3(0.10, 0.22, 0.10), vec3(0.02, 0.07, 0.03), sstep(0.0, 4.5, y));
    float rays = pow(max(0.0, sin(g.x * 1.6 + y * 0.7 + t * 0.06)), 14.0) * sstep(0.5, 3.5, y);
    c += vec3(0.75, 0.95, 0.45) * rays * 0.28;
    for (int i = 3; i >= 0; i--) {
      float fi = float(i);
      float xs = g.x * (2.4 - fi * 0.35) + fi * 4.7;
      float top = 0.55 + fi * 0.7 + 0.45 * fbm(vec2(xs * 1.6, fi)) + 0.22 * abs(sin(xs * 4.0));
      float k = 0.35 + fi * 0.16;
      c = mix(c, vec3(0.03, 0.12, 0.04) * (1.0 + k), sstep(top + 0.03, top - 0.03, y));
    }
    float fly = dots(g * 6.0 + vec2(sin(t * 0.5 + g.y) * 0.4, t * 0.2), 0.05, 0.14) * (0.5 + 0.5 * sin(t * 3.0 + g.x * 9.0));
    return c + vec3(0.8, 1.0, 0.4) * fly;
  } else if (ter < 4.5) {
    // SKY (mountains and peaks): a blue sky, snowy peaks along your edge, clouds streaming past
    vec3 c = mix(vec3(0.20, 0.38, 0.66), vec3(0.08, 0.17, 0.40), sstep(0.0, 4.5, y));
    float cl = fbm(vec2(g.x * 0.9 - t * 0.18, y * 1.6));
    c = mix(c, vec3(0.86, 0.91, 1.0) * 0.8, sstep(0.52, 0.78, cl) * 0.9);
    float peak = 0.85 + 0.75 * (1.0 - abs(fract(g.x * 0.55 + 0.3) - 0.5) * 2.0) + 0.18 * fbm(vec2(g.x * 4.0, 1.0));
    float mtn = sstep(peak + 0.02, peak - 0.02, y);
    vec3 rock = mix(vec3(0.16, 0.20, 0.32), vec3(0.85, 0.9, 1.0), sstep(peak - 0.35, peak - 0.1, y));
    return mix(c, rock * 0.8, mtn);
  } else if (ter < 5.5) {
    // HOLY: golden light pouring from beyond the far side, slow rays, motes drifting up
    vec2 o = vec2(0.0, 5.0);
    float a = atan(g.x - o.x, o.y - y);
    float rays = pow(0.5 + 0.5 * sin(a * 16.0 + t * 0.21), 7.0);
    float glow = exp(-length(g - o) * 0.42);
    vec3 c = mix(vec3(0.20, 0.15, 0.06), vec3(0.10, 0.08, 0.04), sstep(0.0, 2.0, y));
    c += vec3(1.0, 0.86, 0.52) * (rays * 0.32 + glow * 0.75);
    float mote = dots(vec2(g.x * 6.0, y * 5.0 - t * 0.7), 0.06, 0.15);
    return c + vec3(1.0, 0.97, 0.85) * mote * 0.8;
  } else if (ter < 6.5) {
    // SHADOW (Yami and the dark fields): grey-violet fog rolling over the board, eyes blinking in it
    float fog = fbm(g * 1.3 + vec2(t * 0.12, -t * 0.05)) * fbm(g * 0.7 - vec2(t * 0.07, 0.0));
    vec3 c = vec3(0.07, 0.04, 0.12) + vec3(0.42, 0.26, 0.62) * fog * 1.6 + vec3(0.16, 0.08, 0.26) * sstep(0.35, 0.7, fbm(g * 0.6 + vec2(-t * 0.05, t * 0.03)));
    vec2 ec = g * vec2(1.4, 1.6) + vec2(0.0, t * 0.02);
    vec2 cell = floor(ec);
    vec2 f = fract(ec) - vec2(0.5);
    float h = hash12(cell + 3.0);
    float open = sstep(-0.2, 0.25, sin(t * (0.7 + h * 0.6) + h * 40.0));
    float sq = 2.2 - open * 1.2;
    // almond eyes (pointed corners) with a dark slit pupil
    vec2 e1 = f - vec2(0.13, 0.0);
    vec2 e2 = f + vec2(0.13, 0.0);
    float al1 = sstep(0.085, 0.06, abs(e1.x) + abs(e1.y) * sq * 1.6 + e1.x * e1.x * 2.0);
    float al2 = sstep(0.085, 0.06, abs(e2.x) + abs(e2.y) * sq * 1.6 + e2.x * e2.x * 2.0);
    float slit = sstep(0.018, 0.008, abs(e1.x)) * al1 + sstep(0.018, 0.008, abs(e2.x)) * al2;
    float eye = (al1 + al2 - slit * 0.9) * step(0.55, h) * open;
    // (they watch from the sides and the far end, faintest over the middle of the board)
    eye *= sstep(0.55, 0.85, abs(g.x));
    float hl = sstep(0.55, 0.85, abs(g.x));
    float halo = sstep(0.3, 0.0, length(f * vec2(0.7, 1.4))) * step(0.55, h) * open * 0.25 * hl;
    return c + vec3(1.0, 0.25, 0.55) * (eye * 1.3 + halo);
  } else if (ter < 7.5) {
    // ARCANE: magenta magic circles turning, runes running around their bands, sparks
    vec2 o = vec2(0.0, 2.1);
    vec2 d = g - o;
    float r = length(d);
    float an = atan(d.y, d.x) / 6.2831853 + 0.5;
    vec3 c = vec3(0.10, 0.02, 0.10) + vec3(0.30, 0.05, 0.28) * exp(-r * 0.8);
    float rings = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float R = 0.8 + fi * 0.62;
      float dir = mod(fi, 2.0) * 2.0 - 1.0;
      rings += exp(-pow((r - R) * 38.0, 2.0)) + exp(-pow((r - R - 0.2) * 50.0, 2.0)) * 0.6;
      float band = sstep(R + 0.03, R + 0.06, r) * sstep(R + 0.18, R + 0.15, r);
      float n = 24.0 + fi * 12.0;
      float pos = an * n + t * dir * 0.6;
      float runes = step(0.45, hash12(vec2(mod(floor(pos), n), fi))) * step(0.2, fract(pos));
      rings += band * runes * 0.55;
    }
    float sp = dots(g * 7.0 + vec2(0.0, -t * 0.3), 0.04, 0.12);
    return c + vec3(1.0, 0.35, 0.95) * (rings * 0.75 + sp * 0.8);
  } else if (ter < 8.5) {
    // TECH (cities, factories, cyber): circuit traces on a black board, light pulses racing along them
    vec2 cg = g * 3.2;
    vec2 cell = floor(cg);
    vec2 f = fract(cg);
    float h = hash12(cell);
    float horiz = step(0.5, h);
    float line = mix(sstep(0.06, 0.03, abs(f.x - 0.5)), sstep(0.06, 0.03, abs(f.y - 0.5)), horiz);
    line *= step(0.25, hash12(cell + 9.0));
    float pad = sstep(0.12, 0.08, length(f - 0.5)) * step(0.7, h);
    float along = mix(cg.y, cg.x, horiz);
    float pulse = sstep(0.82, 1.0, fract(along * 0.25 - t * (0.4 + h * 0.4) + h * 7.0));
    vec3 c = vec3(0.01, 0.04, 0.05) + vec3(0.0, 0.10, 0.12) * sstep(4.0, 0.0, y);
    return c + vec3(0.1, 0.85, 0.8) * (line * (0.30 + pulse * 1.1) + pad * 0.6);
  } else if (ter < 9.5) {
    // WASTELAND (desert, ruins, graves): sand dunes in rows, dust blowing across, a pale dusty sky
    vec3 c = mix(vec3(0.42, 0.30, 0.16), vec3(0.16, 0.11, 0.06), sstep(0.0, 4.5, y));
    for (int i = 3; i >= 0; i--) {
      float fi = float(i);
      float top = 0.45 + fi * 0.75 + 0.22 * sin(g.x * (1.1 + fi * 0.25) + fi * 2.1) + 0.08 * sin(g.x * 3.3 + fi);
      float k = 0.55 + fi * 0.13;
      vec3 sand = mix(vec3(0.62, 0.44, 0.22), vec3(0.34, 0.23, 0.12), sstep(top - 0.5, top, y)) * k;
      c = mix(c, sand, sstep(top + 0.02, top - 0.02, y));
    }
    float dust = fbm(vec2(g.x * 0.9 - t * 0.55, y * 5.0));
    return c + vec3(0.85, 0.70, 0.48) * sstep(0.55, 0.85, dust) * 0.35;
  }
  // COSMOS: near-black space, twinkling stars, a planet rising over the far side, faint nebula
  vec3 c = vec3(0.01, 0.01, 0.03) + vec3(0.12, 0.06, 0.22) * fbm(g * 0.8 + t * 0.01) * 0.6;
  float st = dots(g * 9.0, 0.10, 0.07) * (0.55 + 0.45 * sin(t * 2.0 + g.x * 31.0 + g.y * 17.0));
  st += dots(g * 4.0 + 50.0, 0.06, 0.09) * 1.2;
  c += vec3(1.0) * st;
  vec2 pc = vec2(1.1, 4.2);
  float pr = 1.5;
  float d = length(g - pc);
  float disc = sstep(pr + 0.01, pr - 0.01, d);
  float lit = clamp(dot(normalize(g - pc + vec2(0.0001)), normalize(vec2(-0.6, -0.8))), 0.0, 1.0);
  vec3 planet = mix(vec3(0.05, 0.07, 0.18), vec3(0.35, 0.45, 0.9), lit * sstep(pr, pr * 0.3, d) + lit * 0.4);
  c = mix(c, planet, disc);
  return c + vec3(0.4, 0.55, 1.0) * exp(-abs(d - pr) * 14.0) * 0.5;
}

void main(){
  vec2 s = vUv * 2.0 - 1.0;          // the screen, -1..1, y up
  vec2 p = s * uAspect;               // ...in square units (the short side is 1)
  float H = uAspect.y;
  // whose ground each pixel is: the opponent's half on top, yours below, a soft seam
  float top = sstep(-0.2, 0.2, s.y);
  float splitA = mix(1.0, top, uOnB);
  float splitB = mix(1.0, 1.0 - top, uOnA);
  // the landscape sweeps out from its Field Zone as it lands (and draws back as it leaves)
  float dA = length((s - uOA) * uAspect);
  float dB = length((s - uOB) * uAspect);
  float RA = uAmtA * (H * 2.6 + 1.0);
  float RB = uAmtB * (H * 2.6 + 1.0);
  float mA = sstep(RA, RA - 0.45, dA) * splitA;
  float mB = sstep(RB, RB - 0.45, dB) * splitB;
  // the field's own night: deep navy, a little lighter toward the middle
  vec3 c = mix(vec3(0.03, 0.04, 0.10), vec3(0.08, 0.11, 0.26), exp(-dot(s, s) * 1.2));
  // (each landscape is only worked out where it shows: a hidden half costs nothing)
  float fA = exp(-pow((dA - RA + 0.2) * 5.0, 2.0)) * (1.0 - uAmtA) * splitA * step(0.0001, uAmtA);
  float fB = exp(-pow((dB - RB + 0.2) * 5.0, 2.0)) * (1.0 - uAmtB) * splitB * step(0.0001, uAmtB);
  if (mA > 0.003 || fA > 0.003) {
    vec3 l = land(vec2(-p.x, H - p.y - 0.55) * 0.95, uT, uA);
    // ...behind the sweep's bright front
    c = mix(c, l, mA) + (l * 1.4 + vec3(0.25)) * fA;
  }
  if (mB > 0.003 || fB > 0.003) {
    vec3 l = land(vec2(p.x, p.y + H - 0.95) * 0.95, uT, uB);
    c = mix(c, l, mB) + (l * 1.4 + vec3(0.25)) * fB;
  }
  // Danger: red cracks over a duelist's ground, flaring with the heartbeat
  if (uDanger + uDangerOpp > 0.002) {
    float mine = uDanger * (1.0 - top);
    float theirs = uDangerOpp * top * 0.25;
    float d = mine + theirs;
    // the cracks reach out from the duelist's own edge, further the lower they are
    float reach = d > 0.002 ? sstep(0.85 - d * 0.6, 1.0, abs(s.y) + 0.1 * vnoise(p * 4.0)) : 0.0;
    if (reach > 0.002) {
      vec2 cq = p * 2.6 + vec2(0.0, s.y > 0.0 ? 7.0 : 0.0);
      float e = vedge(cq);
      float crack = 1.0 - sstep(0.0, 0.035 + 0.02 * d, e);
      float heat = 1.0 - sstep(0.0, 0.3, e);
      float pulse = 0.6 + 0.4 * (s.y < 0.0 ? uBeat : 0.0);
      c = mix(c, c * vec3(0.85, 0.6, 0.6), d * 0.2);
      c += vec3(1.0, 0.2, 0.1) * (crack * 1.0 + heat * 0.08) * reach * d * pulse;
    }
  }
  // a light vignette keeps the board's frame dark
  c *= 1.0 - 0.3 * pow(length(s * vec2(0.8, 0.62)), 2.2);
  gl_FragColor = vec4(c, 1.0);
}`;

type Uni = 'uAspect' | 'uT' | 'uA' | 'uB' | 'uAmtA' | 'uAmtB' | 'uOnA' | 'uOnB' | 'uOA' | 'uOB' | 'uDanger' | 'uDangerOpp' | 'uBeat';
const UNIS: Uni[] = ['uAspect', 'uT', 'uA', 'uB', 'uAmtA', 'uAmtB', 'uOnA', 'uOnB', 'uOA', 'uOB', 'uDanger', 'uDangerOpp', 'uBeat'];

/** How far a fade moves per second (the sweep takes about 0.9 s). */
const FADE = 1.1;
const easeInOut = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

interface Side {
  ter: Terrain | null;
  /** the terrain being drawn (kept while it draws back) */
  shown: Terrain | null;
  amt: number;
  /** where its Field Zone is (screen -1..1, y up): the sweep starts there */
  origin: [number, number];
  /** how present it is in the split (0..1), so the halves ease apart and back */
  on: number;
}

export class LivingField {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private u = {} as Record<Uni, WebGLUniformLocation | null>;
  private sides: [Side, Side] = [
    { ter: null, shown: null, amt: 0, origin: [0.72, 0.5], on: 0 },
    { ter: null, shown: null, amt: 0, origin: [-0.76, -0.3], on: 0 },
  ];
  private danger = [0, 0];
  private dangerAmt = [0, 0];
  private beatAt = -10;
  private raf = 0;
  private last = 0;
  private drawnAt = 0;
  private t = Math.random() * 50;
  private late = 0;
  private fpsMs = 1000 / 30;
  /** the picture can't change until something calls kick() (see still()), and that frame is drawn */
  private stillDrawn = false;
  private reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  private disposed = false;
  private onLost = (ev: Event) => (ev.preventDefault(), (this.gl = null), this.stop());
  private onRestored = () => (this.init(), this.kick());
  private onVis = () => this.kick();
  private onResize = () => this.size();
  private unsubLevel: () => void;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'living-field';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.addEventListener('webglcontextlost', this.onLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onRestored, false);
    document.body.appendChild(this.canvas);
    document.addEventListener('visibilitychange', this.onVis);
    window.addEventListener('resize', this.onResize);
    // (a new quality level: Balanced holds the landscape still, Full animates it again)
    this.unsubLevel = onArtSettings(() => this.kick());
    this.init();
    this.size();
    // Draw one hidden frame while the duel is quiet: some GPU drivers (and software GL) build
    // the shader's machine code at its first draw, which would otherwise land on the frame
    // the first Field Spell or low-LP danger shows (a long freeze right as the LP drops).
    const warm = () => {
      if (this.disposed || !this.gl || this.active || document.hidden) return;
      this.draw(performance.now());
      this.gl.flush();
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 3000 });
    else setTimeout(warm, 1000);
  }

  /** false when the phone has no WebGL: the duel keeps its painted background. */
  get ok() {
    return !!this.gl;
  }

  private init() {
    const gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
    if (!gl) return;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('Living Field: shader failed', gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // one triangle covering the screen
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (const k of UNIS) this.u[k] = gl.getUniformLocation(prog, k);
    this.gl = gl;
    this.size();
  }

  private size() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    // half the CSS resolution: a soft landscape behind the cards needs no more
    this.canvas.width = Math.max(64, Math.round(w * 0.5));
    this.canvas.height = Math.max(64, Math.round(h * 0.5));
    const gl = this.gl;
    if (!gl) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const m = Math.min(w, h);
    gl.uniform2f(this.u.uAspect, w / m, h / m);
    this.drawnAt = 0;
    this.measure();
    this.kick();
  }

  /** The Field Spells up now: the opponent's (top half) and yours (bottom half). */
  setFields(opp: Terrain | null, mine: Terrain | null) {
    const set = (s: Side, ter: Terrain | null) => {
      if (s.ter === ter) return;
      s.ter = ter;
      // a new landscape over an old one: the old one draws back first, then the new one sweeps out
      if (ter && (!s.shown || s.amt < 0.02)) s.shown = ter;
    };
    set(this.sides[0], opp);
    set(this.sides[1], mine);
    this.measure();
    this.kick();
  }

  /** Where each Field Zone sits on screen, so each sweep starts from its card (measured on a new field and on resize). */
  private measure() {
    const zones = document.querySelectorAll('.duel.touch .tz.tz-f');
    if (zones.length < 2) return;
    const at = (r: DOMRect, side: Side) => {
      if (!r.width) return;
      side.origin = [((r.left + r.width / 2) / window.innerWidth) * 2 - 1, 1 - ((r.top + r.height / 2) / window.innerHeight) * 2];
    };
    at(zones[0].getBoundingClientRect(), this.sides[0]);
    at(zones[zones.length - 1].getBoundingClientRect(), this.sides[1]);
  }

  /** The board flipped (a hotseat hand-over): the two halves trade places as they are, with no new sweep. */
  swapSides() {
    const [a, b] = this.sides;
    this.sides = [b, a];
    this.danger.reverse();
    this.dangerAmt.reverse();
    this.measure();
  }

  /** Danger levels (0 none, 1 low LP, 2 very low) for you and the opponent. */
  setDanger(mine: number, opp: number) {
    this.danger = [mine, opp];
    this.kick();
  }

  /** One heartbeat: your cracks flare. */
  beat() {
    this.beatAt = performance.now();
    this.kick();
  }

  /** Something is on screen (or still fading). */
  get active() {
    return this.sides.some((s) => s.ter || s.amt > 0.002) || this.danger.some((d) => d > 0) || this.dangerAmt.some((d) => d > 0.002);
  }

  private kick() {
    if (this.disposed) return;
    this.stillDrawn = false;
    // Lite graphics leave the animated Field Spell landscape out
    const show = this.active && this.ok && !isLite();
    this.canvas.classList.toggle('on', show);
    document.body.classList.toggle('lf-on', show);
    if (!this.raf && this.gl && show && !document.hidden) {
      clearTimeout(this.timer);
      this.timer = 0;
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    this.raf = 0;
    this.timer = 0;
  }

  private timer = 0;
  private onTimer = () => {
    this.timer = 0;
    if (!this.raf && !this.disposed && !document.hidden) this.raf = requestAnimationFrame(this.frame);
  };

  private frame = (now: number) => {
    this.raf = 0;
    if (this.disposed || !this.gl || document.hidden) return;
    // a cinematic covers the duel: hold the last frame (and the sweep, so it plays the moment the cinematic ends)
    const busy = document.body.classList.contains('art-on');
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (!busy) {
      for (const s of this.sides) {
        const want = s.ter && s.ter === s.shown ? 1 : 0;
        const step = FADE * dt;
        s.amt = want > s.amt ? Math.min(want, s.amt + step) : Math.max(want, s.amt - step);
        if (s.amt === 0 && s.ter !== s.shown) s.shown = s.ter;
        const onWant = s.shown ? 1 : 0;
        s.on = onWant > s.on ? Math.min(1, s.on + dt * 2) : Math.max(0, s.on - dt * 2);
      }
      for (let i = 0; i < 2; i++) {
        const want = Math.min(1, this.danger[i] * 0.6);
        const a = this.dangerAmt[i];
        this.dangerAmt[i] = want > a ? Math.min(want, a + dt * 1.2) : Math.max(want, a - dt * 1.2);
      }
      this.t = (this.t + dt * (this.reduced ? 0.25 : 1)) % T_WRAP;
      const gap = now - this.drawnAt;
      if (gap >= this.fpsMs - 2) {
        // frames keep arriving late (a busy phone): settle at 20 fps
        if (this.drawnAt && gap > this.fpsMs * 1.6 && gap < 400) this.late++;
        else this.late = Math.max(0, this.late - 1);
        if (this.late > 30) this.fpsMs = 1000 / 20;
        const still = this.still(now);
        this.draw(now);
        this.drawnAt = now;
        this.stillDrawn = still;
      }
    }
    if (!this.active || isLite()) {
      this.canvas.classList.remove('on');
      document.body.classList.remove('lf-on');
      return;
    }
    // Danger with no landscape up holds still between heartbeats (nothing in it moves with
    // time): once that frame is drawn the loop sleeps, and the next beat, LP change or
    // Field Spell wakes it (kick). The canvas keeps showing the last frame meanwhile.
    if (this.stillDrawn && !busy) return;
    // (under a cinematic nothing is drawn: check back in a moment instead of every vsync;
    // between drawn frames, wait on a timer, not a frame callback per vsync)
    const wait = busy ? 200 : this.fpsMs - (now - this.drawnAt);
    if (wait > 17) this.timer = window.setTimeout(this.onTimer, wait - 8);
    else this.raf = requestAnimationFrame(this.frame);
  };

  /** Nothing on screen moves: no landscape up or fading, the danger glow at its level, no heartbeat flaring. */
  private still(now: number) {
    // Balanced: a landscape that has finished rising holds still (its fire, water and wind are
    // drawn once, not 30 times a second); only its fades and the danger beats move.
    const lean = isLean();
    for (const s of this.sides) {
      if (!lean && (s.ter || s.shown || s.amt > 0 || s.on > 0)) return false;
      if (lean && (s.amt !== (s.ter && s.ter === s.shown ? 1 : 0) || s.on !== (s.shown ? 1 : 0) || s.ter !== s.shown)) return false;
    }
    for (let i = 0; i < 2; i++) if (this.dangerAmt[i] !== Math.min(1, this.danger[i] * 0.6)) return false;
    const since = now - this.beatAt;
    return since < 0 || since > 700;
  }

  private draw(now: number) {
    const gl = this.gl!;
    const u = this.u;
    gl.uniform1f(u.uT, this.t);
    const [a, b] = this.sides;
    const idx = (t: Terrain | null) => (t ? TERRAINS.indexOf(t) + 1 : 0);
    gl.uniform1f(u.uA, idx(a.shown));
    gl.uniform1f(u.uB, idx(b.shown));
    gl.uniform1f(u.uAmtA, a.shown ? easeInOut(a.amt) : 0);
    gl.uniform1f(u.uAmtB, b.shown ? easeInOut(b.amt) : 0);
    gl.uniform1f(u.uOnA, a.on);
    gl.uniform1f(u.uOnB, b.on);
    gl.uniform2f(u.uOA, a.origin[0], a.origin[1]);
    gl.uniform2f(u.uOB, b.origin[0], b.origin[1]);
    gl.uniform1f(u.uDanger, this.dangerAmt[0]);
    gl.uniform1f(u.uDangerOpp, this.dangerAmt[1]);
    // the beat: a quick flare that settles over 0.6 s
    const since = (now - this.beatAt) / 1000;
    gl.uniform1f(u.uBeat, since < 0 || since > 0.7 ? 0 : Math.exp(-since * 6) * (1 - Math.exp(-since * 60)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    this.disposed = true;
    this.unsubLevel();
    this.stop();
    document.removeEventListener('visibilitychange', this.onVis);
    window.removeEventListener('resize', this.onResize);
    this.canvas.removeEventListener('webglcontextlost', this.onLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored, false);
    document.body.classList.remove('lf-on');
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }
}
