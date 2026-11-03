// Living Field: a face-up Field Spell's landscape stays behind the duel as the arena
// for as long as the card is on the field (the same ten landscapes its cinematic
// paints: Umi keeps its waves rolling, Yami keeps the board in fog). Each duelist's
// Field Spell takes their half of the screen (the opponent's mirrored, its ground
// at their edge); with only one up, it takes the whole arena. It cross-fades in when
// the card lands and out when it leaves.
//
// The same canvas carries the Danger state's ground: at low Life Points the
// duelist's half glows with red cracks that throb with the heartbeat.
//
// Kept cheap for phones: plain WebGL (no scene graph), one full-screen triangle drawn
// at half the screen's CSS resolution (a soft backdrop needs no more) and 30 fps, 20
// if frames run slow; nothing at all while no field and no danger is up, while a
// cinematic plays (it covers the duel), or while the tab is hidden. No WebGL: the
// duel keeps its painted background (Atmosphere.tsx adds a CSS tint per terrain).
import { TERRAIN_COLORS, TERRAINS, type Terrain } from './families';

const VERT = `attribute vec2 aPos; varying vec2 vUv; void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// (the noise helpers and landscapes follow stage.ts's backdrop shader, taking the terrain
// and its colors as arguments so two can share the screen, and tuned to sit behind cards)
export const FRAG = /* glsl */ `
precision mediump float;
varying vec2 vUv;
uniform vec2 uAspect;
uniform float uT;
uniform float uA; uniform float uB;
uniform float uAmtA; uniform float uAmtB;
uniform vec3 uA1; uniform vec3 uA2; uniform vec3 uB1; uniform vec3 uB2;
uniform float uDanger; uniform float uDangerOpp; uniform float uBeat;
// (smoothstep with edge0 > edge1 is undefined in GLSL ES; some phones return 0: this one is defined both ways)
float sstep(float a, float b, float x){ float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vedge(vec2 x){ vec2 n = floor(x); vec2 f = fract(x); float d1 = 8.0; float d2 = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 g = vec2(float(i), float(j)); vec2 r = g + hash22(n + g) - f; float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
  return sqrt(d2) - sqrt(d1); }
// round soft specks (embers, ghost lights, stars): one per lit cell of v, a share dens of the cells lit
float dots(vec2 v, float dens, float r){ vec2 c = floor(v); vec2 o = hash22(c) * 0.6 + 0.2;
  return step(1.0 - dens, hash12(c + 17.0)) * sstep(r, 0.0, length(fract(v) - o)); }
vec3 terrain(vec2 p, float t, float ter, vec3 c1, vec3 c2){
  vec2 q = p * 6.0;
  float y = q.y;
  if (ter < 1.5) {
    float lava = sstep(-1.0, -4.5, y + vnoise(vec2(q.x * 0.7, t * 0.3)) * 1.5);
    float cracks = 1.0 - sstep(0.0, 0.08, vedge(q * 0.8 + vec2(0.0, -t * 0.2)));
    float emb = dots(vec2(q.x * 3.0, q.y * 3.0 - t * 4.0), 0.12, 0.16) * sstep(3.0, -3.0, y);
    return c1 * (lava * 1.2 + cracks * lava * 0.8 + emb * 0.9) + c2 * 0.15 + vec3(0.08, 0.02, 0.02);
  } else if (ter < 2.5) {
    float w = sin(y * 3.0 + vnoise(vec2(q.x * 0.8 + t * 0.6, y)) * 4.0 - t * 1.5);
    float caus = 1.0 - sstep(0.0, 0.07, vedge(q * 2.2 + vec2(t * 0.5, t * 0.3)));
    return c1 * (0.42 + 0.38 * w) * sstep(5.0, -2.0, y) + c2 * caus * 0.32 * (0.5 + 0.5 * w) + vec3(0.0, 0.05, 0.14);
  } else if (ter < 3.5) {
    float trunk = sstep(0.75, 0.95, vnoise(vec2(q.x * 1.6, 0.0)));
    float canopy = vnoise(q * 1.3 + vec2(0.0, t * 0.1)) * sstep(-1.0, 4.0, y);
    float rays = pow(max(0.0, sin(q.x * 0.6 + q.y * 0.35 + t * 0.2)), 12.0) * 0.6;
    return c1 * (canopy * 0.9 + trunk * 0.25 + 0.12) + c2 * rays;
  } else if (ter < 4.5) {
    float cl = vnoise(vec2(q.x * 0.5 - t * 1.2, q.y * 1.4)) * 0.6 + vnoise(vec2(q.x * 1.3 - t * 2.0, q.y * 3.0)) * 0.4;
    return mix(c1 * 0.4, c2, sstep(0.45, 0.85, cl)) * (0.6 + 0.4 * sstep(-6.0, 6.0, y));
  } else if (ter < 5.5) {
    float a = atan(p.x, 1.2 - p.y);
    float rays = pow(0.5 + 0.5 * sin(a * 18.0 + t * 0.4), 6.0) * sstep(-1.0, 1.2, p.y);
    return c1 * (rays * 0.9 + 0.12) + c2 * exp(-pow(p.y - 1.0, 2.0) * 2.0) * 0.6;
  } else if (ter < 6.5) {
    float fog = vnoise(q * 0.7 + vec2(t * 0.25, -t * 0.1)) * vnoise(q * 1.7 - vec2(t * 0.4, 0.0));
    float lights = dots(q * 2.0 + vec2(0.0, t * 0.3), 0.05, 0.2) * (0.5 + 0.5 * sin(t * 3.0 + q.x));
    return c1 * fog * 1.4 + c2 * lights;
  } else if (ter < 7.5) {
    float rr = length(p) * 6.0;
    float ring = exp(-pow((fract(rr) - 0.5) * 10.0, 2.0));
    float a = atan(p.y, p.x) / 6.2831853 + 0.5;
    float runes = step(0.55, vnoise(vec2(a * 40.0 + floor(rr) * 3.0 + t * 0.5 * (mod(floor(rr), 2.0) * 2.0 - 1.0), floor(rr))));
    return c1 * ring * (0.4 + runes * 0.8) + c2 * 0.12;
  } else if (ter < 8.5) {
    float gy = 1.0 / max(0.05, 1.2 - p.y);
    vec2 g = vec2(p.x * gy * 4.0, gy * 2.0 + t * 1.5);
    float lines = max(1.0 - sstep(0.0, 0.06, abs(fract(g.x) - 0.5) * 2.0 - 0.9), 1.0 - sstep(0.0, 0.06, abs(fract(g.y) - 0.5) * 2.0 - 0.9));
    float scan = exp(-pow((p.y - (fract(t * 0.35) * 2.4 - 1.2)) * 9.0, 2.0));
    return c1 * lines * 0.8 * sstep(1.0, -0.4, p.y) + c2 * scan * 0.5 + vec3(0.0, 0.03, 0.05);
  } else if (ter < 9.5) {
    float dunes = sin(q.x * 0.5 + sin(y * 0.4) * 2.0) * 0.5 + 0.5;
    float layer = sstep(-0.2, 0.2, sin(y * 1.6 + dunes * 2.0));
    float dust = vnoise(vec2(q.x * 2.0 - t * 3.0, y * 2.0));
    return c1 * (0.35 + 0.45 * layer) * sstep(4.0, -4.0, y) + c2 * dust * 0.25;
  }
  float neb = vnoise(q * 0.5 + t * 0.05) * vnoise(q * 1.1 - t * 0.07);
  float st = dots(q * 5.0, 0.08, 0.12) * (0.6 + 0.4 * sin(t * 5.0 + q.x * 9.0));
  return c1 * neb * 1.5 + c2 * st * 1.5;
}
void main(){
  vec2 s = vUv * 2.0 - 1.0;          // the screen, -1..1, y up
  vec2 p = s * uAspect;               // ...in square units (the short side is 1)
  // whose ground each pixel is: the opponent's half on top, yours below, a soft seam
  float top = sstep(-0.14, 0.14, s.y);
  float wA = uAmtA * mix(1.0, top, uAmtB);
  float wB = uAmtB * mix(1.0, 1.0 - top, uAmtA);
  // the field's own night: deep navy, a little lighter toward the middle
  vec3 c = mix(vec3(0.03, 0.04, 0.10), vec3(0.08, 0.11, 0.26), exp(-dot(s, s) * 1.2));
  vec3 land = vec3(0.0);
  float wl = 0.0;
  if (wA > 0.002) { land += terrain(vec2(p.x, -p.y) * 0.27 + vec2(0.0, 0.2), uT, uA, uA1, uA2) * wA; wl += wA; }
  if (wB > 0.002) { land += terrain(p * 0.27 + vec2(0.0, 0.2), uT, uB, uB1, uB2) * wB; wl += wB; }
  // (dimmed and soft at the edges: the cards on top must always read first)
  c = mix(c, land / max(wl, 0.001) * 1.15, min(1.0, wl));
  // Danger: red cracks over a duelist's ground, throbbing with the heartbeat
  if (uDanger + uDangerOpp > 0.002) {
    float mine = uDanger * (1.0 - top);
    float theirs = uDangerOpp * top * 0.7;
    float d = mine + theirs;
    if (d > 0.002) {
      vec2 cq = p * 3.2 + vec2(0.0, s.y > 0.0 ? 7.0 : 0.0);
      float e = vedge(cq);
      float crack = 1.0 - sstep(0.0, 0.05 + 0.03 * d, e);
      float heat = 1.0 - sstep(0.0, 0.35, e);
      // the cracks reach out from the duelist's own edge, further the lower they are
      float reach = sstep(0.85 - d * 0.9, 1.0, abs(s.y) + 0.1 * vnoise(p * 4.0));
      float pulse = 0.55 + 0.45 * (s.y < 0.0 ? uBeat : 0.3);
      vec3 red = vec3(1.0, 0.16, 0.08);
      c = mix(c, c * vec3(0.7, 0.4, 0.4), d * 0.5);
      c += red * (crack * 1.1 + heat * 0.18) * reach * d * pulse;
    }
  }
  // a vignette keeps the board's frame dark
  c *= 1.0 - 0.35 * pow(length(s * vec2(0.8, 0.62)), 2.2);
  gl_FragColor = vec4(c, 1.0);
}`;

type Uni = 'uAspect' | 'uT' | 'uA' | 'uB' | 'uAmtA' | 'uAmtB' | 'uA1' | 'uA2' | 'uB1' | 'uB2' | 'uDanger' | 'uDangerOpp' | 'uBeat';
const UNIS: Uni[] = ['uAspect', 'uT', 'uA', 'uB', 'uAmtA', 'uAmtB', 'uA1', 'uA2', 'uB1', 'uB2', 'uDanger', 'uDangerOpp', 'uBeat'];

const rgb = (hex: number): [number, number, number] => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
/** How far a value moves toward its target per second (fades take about 0.6 s). */
const FADE = 1.8;

interface Side {
  ter: Terrain | null;
  /** the terrain being drawn (kept while it fades out) */
  shown: Terrain | null;
  amt: number;
}

export class LivingField {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private u = {} as Record<Uni, WebGLUniformLocation | null>;
  private sides: [Side, Side] = [
    { ter: null, shown: null, amt: 0 },
    { ter: null, shown: null, amt: 0 },
  ];
  private danger = [0, 0];
  private dangerAmt = [0, 0];
  private beatAt = -10;
  private raf = 0;
  private last = 0;
  private drawnAt = 0;
  private t = Math.random() * 50;
  private slow = 0;
  private fpsMs = 1000 / 30;
  private reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  private disposed = false;
  private onLost = (ev: Event) => (ev.preventDefault(), (this.gl = null), this.stop());
  private onRestored = () => (this.init(), this.kick());
  private onVis = () => this.kick();
  private onResize = () => this.size();

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'living-field';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.addEventListener('webglcontextlost', this.onLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onRestored, false);
    document.body.appendChild(this.canvas);
    document.addEventListener('visibilitychange', this.onVis);
    window.addEventListener('resize', this.onResize);
    this.init();
    this.size();
  }

  /** false when the phone has no WebGL: the CSS tint stands in. */
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
    const k = 0.5;
    this.canvas.width = Math.max(64, Math.round(w * k));
    this.canvas.height = Math.max(64, Math.round(h * k));
    const gl = this.gl;
    if (!gl) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const m = Math.min(w, h);
    gl.uniform2f(this.u.uAspect, w / m, h / m);
    this.drawnAt = 0;
    this.kick();
  }

  /** The Field Spells up now: the opponent's (top half) and yours (bottom half). */
  setFields(opp: Terrain | null, mine: Terrain | null) {
    const set = (s: Side, ter: Terrain | null) => {
      if (s.ter === ter) return;
      s.ter = ter;
      // a new landscape over an old one: fade the old one out first (its amount runs to 0, then swaps)
      if (ter && (!s.shown || s.amt < 0.02)) s.shown = ter;
    };
    set(this.sides[0], opp);
    set(this.sides[1], mine);
    this.kick();
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
    this.canvas.classList.toggle('on', this.active && this.ok);
    document.body.classList.toggle('lf-on', this.active && this.ok);
    if (!this.raf && this.gl && this.active && !document.hidden) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (this.disposed || !this.gl || document.hidden) return;
    // a cinematic covers the duel: hold the last frame until it is over (checked again in 250 ms)
    const busy = document.body.classList.contains('art-on');
    const due = now - this.drawnAt >= (busy ? 250 : this.fpsMs);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    // the fades run on real time even between drawn frames
    let moving = false;
    for (const s of this.sides) {
      const want = s.ter && s.ter === s.shown ? 1 : 0;
      const step = FADE * dt;
      s.amt = want > s.amt ? Math.min(want, s.amt + step) : Math.max(want, s.amt - step);
      if (s.amt === 0 && s.ter !== s.shown) s.shown = s.ter;
      if (s.amt !== want || s.ter !== s.shown) moving = true;
    }
    for (let i = 0; i < 2; i++) {
      const want = Math.min(1, this.danger[i] * 0.6);
      const a = this.dangerAmt[i];
      this.dangerAmt[i] = want > a ? Math.min(want, a + dt * 1.2) : Math.max(want, a - dt * 1.2);
      if (this.dangerAmt[i] !== want) moving = true;
    }
    this.t += dt * (this.reduced ? 0.25 : 0.6);
    if (due && !busy) {
      const t0 = performance.now();
      this.draw(now);
      this.drawnAt = now;
      // slow phone: drop to 20 fps after a run of slow draws
      if (performance.now() - t0 > 8) this.slow++;
      else this.slow = Math.max(0, this.slow - 1);
      if (this.slow > 20) this.fpsMs = 1000 / 20;
    }
    if (!this.active) {
      this.canvas.classList.remove('on');
      document.body.classList.remove('lf-on');
      return;
    }
    void moving;
    this.raf = requestAnimationFrame(this.frame);
  };

  private draw(now: number) {
    const gl = this.gl!;
    const u = this.u;
    gl.uniform1f(u.uT, this.t);
    const [a, b] = this.sides;
    const idx = (t: Terrain | null) => (t ? TERRAINS.indexOf(t) + 1 : 0);
    gl.uniform1f(u.uA, idx(a.shown));
    gl.uniform1f(u.uB, idx(b.shown));
    gl.uniform1f(u.uAmtA, a.shown ? a.amt : 0);
    gl.uniform1f(u.uAmtB, b.shown ? b.amt : 0);
    const col = (t: Terrain | null): [number, number] => (t ? TERRAIN_COLORS[t] : [0, 0]);
    const [a1, a2] = col(a.shown);
    const [b1, b2] = col(b.shown);
    gl.uniform3fv(u.uA1, rgb(a1));
    gl.uniform3fv(u.uA2, rgb(a2));
    gl.uniform3fv(u.uB1, rgb(b1));
    gl.uniform3fv(u.uB2, rgb(b2));
    gl.uniform1f(u.uDanger, this.dangerAmt[0]);
    gl.uniform1f(u.uDangerOpp, this.dangerAmt[1]);
    // the beat: a quick flare that settles over 0.6 s
    const since = (now - this.beatAt) / 1000;
    gl.uniform1f(u.uBeat, since < 0 || since > 0.7 ? 0 : Math.exp(-since * 6) * (1 - Math.exp(-since * 60)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    this.disposed = true;
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
