// Duel sounds in the style of the TV show, synthesized with the Web Audio API
// (original sounds, no audio files): the Life Point counter draining, attacks and
// clashes, cards shattering, a sting per Summon method, Spells, Traps, Skills.
// Silent until the player's first tap (phones) and while Sound is Off.
import { audioContext } from './sound';
import { rumble } from './pad/rumble';

let noiseBuf: AudioBuffer | null = null;
function noise(ctx: AudioContext) {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/** An envelope into the speakers: up in `attack` s, gone at `dur` s. */
function env(ctx: AudioContext, gain: number, attack: number, dur: number, when: number) {
  const g = ctx.createGain();
  const t = ctx.currentTime + when;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + Math.max(0.002, attack));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(ctx.destination);
  return g;
}

interface ToneOpts {
  type?: OscillatorType;
  to?: number;
  attack?: number;
  /** lowpass cutoff (Hz) for brassy saws */
  lp?: number;
  detune?: number;
}

function tone(f: number, dur: number, gain: number, when = 0, o: ToneOpts = {}) {
  const ctx = audioContext();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'square';
  const t = ctx.currentTime + when;
  osc.frequency.setValueAtTime(f, t);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t + dur);
  if (o.detune) osc.detune.value = o.detune;
  const out = env(ctx, gain, o.attack ?? 0.005, dur, when);
  if (o.lp) {
    const f2 = ctx.createBiquadFilter();
    f2.type = 'lowpass';
    f2.frequency.value = o.lp;
    osc.connect(f2).connect(out);
  } else osc.connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

/** Filtered noise: `type` bandpass/highpass/lowpass sweeping f0 → f1. */
function hiss(dur: number, f0: number, f1: number, gain: number, when = 0, type: BiquadFilterType = 'bandpass', attack = 0.01) {
  const ctx = audioContext();
  if (!ctx) return;
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = type === 'bandpass' ? 1.4 : 0.7;
  const t = ctx.currentTime + when;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  src.connect(f).connect(env(ctx, gain, attack, dur, when));
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.05);
}

const thud = (size = 0.5, when = 0) => tone(95 + size * 30, 0.3 + size * 0.3, 0.45 + size * 0.3, when, { type: 'sine', to: 35 });

// ------------------------------------------------------------ Life Points

/**
 * The Life Point counter: rapid electronic ticks that thin out as the number
 * settles (they follow the on-screen count, `ms` long, easing out), over a
 * falling whir, then a two-note stop. Gains tick upward and brighter.
 * `delta` is the change (negative for damage), `left` the Life Points after it.
 */
export function lpCount(delta: number, left: number, ms = 600) {
  // (a controller feels the hit: harder for more damage)
  if (delta < 0) rumble(Math.min(1, 0.25 + -delta / 3000), 0.5, Math.min(ms, 500));
  const ctx = audioContext();
  if (!ctx || delta === 0) return;
  const amt = Math.abs(delta);
  const dmg = delta < 0;
  const s = ms / 1000;
  const n = Math.round(Math.min(36, Math.max(10, 8 + amt / 120)));
  for (let i = 0; i < n; i++) {
    const p = i / n;
    // the counter shows from + Δ·(1-(1-k)^3): the tick for value-share p lands at k = 1-(1-p)^(1/3)
    const at = s * (1 - Math.cbrt(1 - p));
    const f = dmg ? 1900 - 800 * p : 1000 + 900 * p;
    tone(f, 0.022, dmg ? 0.05 : 0.04, at, { type: dmg ? 'square' : 'triangle' });
  }
  if (dmg) {
    // the drain's whir, deeper for a bigger hit
    tone(320, s + 0.15, 0.05 + Math.min(0.06, amt / 40000), 0, { type: 'sawtooth', to: amt >= 2000 ? 60 : 110, lp: 900 });
    if (left <= 0) return lpZero(s);
    tone(660, 0.09, 0.07, s + 0.02, { type: 'square' });
    tone(440, 0.16, 0.07, s + 0.11, { type: 'square' });
  } else {
    tone(1568, 0.1, 0.06, s + 0.02, { type: 'sine' });
    tone(2093, 0.22, 0.05, s + 0.09, { type: 'sine' });
  }
}

/** Life Points hit 0: a long falling wail and a flat buzz. */
export function lpZero(when = 0) {
  rumble(1, 1, 900, when * 1000);
  tone(520, 1.3, 0.12, when, { type: 'sawtooth', to: 45, lp: 1400 });
  tone(523, 1.1, 0.06, when + 0.05, { type: 'square', to: 60, detune: 18 });
  hiss(1.2, 1600, 120, 0.08, when, 'lowpass');
  tone(110, 0.9, 0.06, when + 1.15, { type: 'square', lp: 600 });
}

// ------------------------------------------------------------ battle

/** An attack is declared: a rising charge and a rush of air. */
export function attack(direct = false) {
  tone(90, 0.4, 0.09, 0, { type: 'sawtooth', to: direct ? 520 : 360, lp: 1200 });
  hiss(0.45, 300, 3200, 0.2, 0.05);
  if (direct) tone(880, 0.25, 0.04, 0.3, { type: 'square', to: 1320 });
}

/** Two monsters collide (no Life Points lost): a metal crash. */
export function clash() {
  rumble(0.55, 0.45, 160);
  thud(0.6);
  hiss(0.35, 3800, 900, 0.22, 0, 'bandpass', 0.002);
  tone(310, 0.5, 0.05, 0, { type: 'square', to: 290 });
  tone(437, 0.5, 0.04, 0, { type: 'square', to: 410 });
}

/** A blow lands on a player: a heavy impact (the counter follows). */
export function impact() {
  rumble(0.9, 0.7, 240);
  thud(0.9);
  hiss(0.3, 2400, 300, 0.2, 0, 'bandpass', 0.002);
}

/** A card is destroyed: it shatters like glass. */
export function shatter(when = 0) {
  rumble(0.3, 0.6, 140, when * 1000);
  thud(0.35, when);
  hiss(0.45, 6000, 2500, 0.18, when, 'highpass', 0.002);
  for (let i = 0; i < 6; i++) tone(2400 + Math.random() * 2600, 0.12 + Math.random() * 0.15, 0.025, when + 0.02 + i * 0.035, { type: 'triangle' });
}

// ------------------------------------------------------------ cards

/** A Summon, with a sting per method. */
export function summon(how?: string) {
  switch ((how ?? 'normal').toLowerCase()) {
    case 'tribute':
      hiss(0.6, 150, 2000, 0.14, 0, 'bandpass', 0.3);
      thud(1, 0.5);
      tone(196, 0.6, 0.06, 0.5, { type: 'sawtooth', lp: 1500 });
      tone(294, 0.6, 0.05, 0.5, { type: 'sawtooth', lp: 1500 });
      return;
    case 'fusion':
      // two energies swirl together
      tone(220, 0.9, 0.07, 0, { type: 'sawtooth', to: 660, lp: 1800 });
      tone(330, 0.9, 0.07, 0, { type: 'sawtooth', to: 440, lp: 1800, detune: 25 });
      hiss(0.9, 400, 2400, 0.1, 0, 'bandpass', 0.4);
      thud(0.8, 0.85);
      [523, 659, 784].forEach((f) => tone(f, 0.7, 0.04, 0.85, { type: 'triangle' }));
      return;
    case 'ritual':
      // a solemn minor chord and a bell
      [220, 262, 330].forEach((f) => tone(f, 1.2, 0.05, 0, { type: 'sawtooth', lp: 700, attack: 0.35 }));
      tone(880, 1.1, 0.06, 0.6, { type: 'sine' });
      tone(1320, 0.9, 0.025, 0.6, { type: 'sine' });
      thud(0.8, 0.6);
      return;
    case 'synchro':
      // tuning rings climbing, then the burst
      [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.18, 0.05, i * 0.08, { type: 'sine' }));
      hiss(0.5, 800, 5000, 0.12, 0.1);
      thud(0.7, 0.45);
      return;
    case 'xyz':
      // materials orbit into the overlay
      tone(700, 0.6, 0.05, 0, { type: 'triangle', to: 300 });
      tone(1050, 0.6, 0.05, 0.05, { type: 'triangle', to: 450 });
      hiss(0.6, 3000, 300, 0.12, 0);
      thud(0.8, 0.55);
      tone(185, 0.5, 0.06, 0.55, { type: 'sawtooth', lp: 1100 });
      return;
    case 'link':
      // a circuit lighting up arrow by arrow
      [988, 1319, 988, 1760].forEach((f, i) => tone(f, 0.05, 0.05, i * 0.07, { type: 'square' }));
      hiss(0.3, 600, 4000, 0.1, 0.25);
      thud(0.7, 0.35);
      return;
    case 'special':
      hiss(0.35, 500, 3000, 0.15);
      thud(0.6, 0.25);
      tone(659, 0.3, 0.04, 0.25, { type: 'triangle' });
      return;
    default:
      thud(0.5);
      tone(392, 0.2, 0.04, 0.02, { type: 'triangle' });
  }
}

/** A card is Set face-down: a slap on the table. */
export function setCard() {
  hiss(0.08, 1800, 400, 0.22, 0, 'lowpass', 0.002);
  tone(160, 0.08, 0.15, 0, { type: 'sine', to: 70 });
}

/** A face-down card flips up. */
export function flip() {
  hiss(0.15, 800, 3500, 0.15);
  tone(784, 0.12, 0.04, 0.1, { type: 'triangle' });
}

/** A Spell activates: a bright magic shimmer. */
export function spell() {
  [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.35, 0.035, i * 0.05, { type: 'sine' }));
  hiss(0.4, 1200, 6000, 0.07, 0, 'highpass');
}

/** A Trap springs: the show's sharp, ominous stab, and its echo. */
export function trap() {
  thud(0.6);
  tone(233, 0.32, 0.08, 0, { type: 'sawtooth', lp: 2200 });
  tone(330, 0.32, 0.07, 0, { type: 'sawtooth', lp: 2200 });
  tone(466, 0.32, 0.05, 0, { type: 'square', lp: 2600 });
  tone(233, 0.4, 0.03, 0.34, { type: 'sawtooth', lp: 1400 });
  tone(330, 0.4, 0.025, 0.34, { type: 'sawtooth', lp: 1400 });
}

/** A monster's effect: a surge of energy. */
export function monsterEffect() {
  tone(140, 0.35, 0.08, 0, { type: 'sawtooth', to: 700, lp: 1600 });
  tone(1047, 0.2, 0.035, 0.25, { type: 'triangle' });
}

/** A Speed Duel Skill: a three-note brass rise and a flash. */
export function skill() {
  [392, 523, 784].forEach((f, i) => tone(f, i === 2 ? 0.5 : 0.14, 0.07, i * 0.11, { type: 'sawtooth', lp: 1800 }));
  hiss(0.4, 1500, 7000, 0.08, 0.22, 'highpass');
}

/** A card is banished, bounced or shuffled away. */
export function leave() {
  hiss(0.35, 3000, 300, 0.14);
  tone(880, 0.3, 0.03, 0, { type: 'sine', to: 300 });
}

/** Cards drawn by an effect. */
export function draw(count = 1) {
  for (let i = 0; i < Math.min(5, count); i++) hiss(0.1, 900, 3000, 0.1, i * 0.09);
}

/** A chat line from the other player: a soft two-note blip, quieter than any duel sound. */
export function chatPing() {
  tone(988, 0.09, 0.05, 0, { type: 'triangle' });
  tone(1319, 0.14, 0.045, 0.07, { type: 'triangle' });
}
