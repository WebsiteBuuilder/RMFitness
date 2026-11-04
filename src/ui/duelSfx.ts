// Duel sounds in the style of the TV show, synthesized with the Web Audio API
// (original sounds, no audio files): the Life Point counter draining, attacks and
// clashes, cards shattering, a sting per Summon method, Spells, Traps, Skills.
// Silent until the player's first tap (phones) and while Sound is Off.
import { audioContext, soundEnabled } from './sound';
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

/** The counter sound now playing (a new count cuts it off: counts never stack). */
let counting: { ctx: BaseAudioContext; osc: OscillatorNode[]; gate: GainNode; at: number; amt: number } | null = null;


// Sound turned Off mid-count: the rattle stops at once
if (typeof window !== 'undefined')
  window.addEventListener('eds-sound', () => {
    if (!counting || soundEnabled()) return;
    const t = counting.ctx.currentTime;
    counting.gate.gain.cancelScheduledValues(t);
    counting.gate.gain.setTargetAtTime(0, t, 0.004);
  });

/** Tick spacing of the counter (s): about 30 a second, the rolling-digits rattle of the show's counter. */
export const LP_TICK_S = 0.034;

/**
 * The Life Point counter, as on the show: a fast, even rattle of digital beeps for as long
 * as the digits roll (`ms`), stopping the instant the number lands with one longer beep.
 * Damage ticks high and slides down as the points drain; gains tick upward. A bigger change
 * rolls longer and ticks louder. One pair of oscillators through a gate (a few nodes, however
 * long the count), and a new count cuts off the last one rather than stacking on it.
 * `delta` is the change (negative for damage), `left` the Life Points after it.
 */
export function lpCount(delta: number, left: number, ms = 600) {
  // (a controller feels the hit: harder for more damage)
  if (delta < 0) rumble(Math.min(1, 0.25 + -delta / 3000), 0.5, Math.min(ms, 600));
  const ctx = audioContext();
  if (!ctx || delta === 0) return;
  lpCountInto(ctx, ctx.destination, delta, left, ms);
  if (delta < 0 && left <= 0) lpZero(ms / 1000);
}

/** The counter's beeps into `out` (the speakers, or an offline render in a test). */
export function lpCountInto(ctx: BaseAudioContext, out: AudioNode, delta: number, left: number, ms: number) {
  const now = ctx.currentTime;
  const amt = Math.abs(delta);
  // both duelists' counters starting together (a battle, a Skill hitting both): one rattle, the bigger change's
  if (counting && counting.ctx === ctx && now - counting.at < 0.05 && counting.amt >= amt) return;
  if (counting && counting.ctx === ctx) {
    counting.gate.gain.cancelScheduledValues(now);
    counting.gate.gain.setTargetAtTime(0, now, 0.004);
    for (const o of counting.osc) {
      try {
        o.stop(now + 0.03);
      } catch {
        // (already stopped)
      }
    }
  }
  counting = null;
  const dmg = delta < 0;
  const s = ms / 1000;
  // (bigger hits tick a little louder, but mostly longer: never harsher than the other duel sounds)
  const vol = (dmg ? 0.042 : 0.035) + Math.min(1, amt / 2000) * 0.022;
  const f0 = dmg ? 1976 : 1568;
  const f1 = dmg ? 1568 : 2093;
  // a bright square for the beep, an octave-down square under it for body, softened a touch
  const hi = ctx.createOscillator();
  const lo = ctx.createOscillator();
  hi.type = 'square';
  lo.type = 'square';
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 5200;
  const mix = ctx.createGain();
  mix.gain.value = 0.35;
  const gate = ctx.createGain();
  gate.gain.setValueAtTime(0, now);
  hi.connect(gate);
  lo.connect(mix).connect(gate);
  gate.connect(lp).connect(out);
  hi.frequency.setValueAtTime(f0, now);
  hi.frequency.linearRampToValueAtTime(f1, now + s);
  lo.frequency.setValueAtTime(f0 / 2, now);
  lo.frequency.linearRampToValueAtTime(f1 / 2, now + s);
  // the rattle: evenly spaced beeps for as long as the digits roll
  const n = Math.max(3, Math.floor(s / LP_TICK_S));
  const on = LP_TICK_S * 0.5;
  for (let i = 0; i < n; i++) {
    const t = now + i * LP_TICK_S;
    // (each beep's edges ramp over ~1 ms: crisp, no clicks)
    gate.gain.setTargetAtTime(vol, t, 0.0006);
    gate.gain.setTargetAtTime(0, t + on, 0.0006);
  }
  const end = now + s;
  const stopAt = left <= 0 ? end : end + 0.16;
  if (left > 0) {
    // the number lands: one longer beep, a step down for damage, up for a gain
    hi.frequency.setValueAtTime(dmg ? f1 * 0.75 : f1 * 1.19, end);
    lo.frequency.setValueAtTime(dmg ? (f1 * 0.75) / 2 : (f1 * 1.19) / 2, end);
    gate.gain.setTargetAtTime(vol * 1.1, end + 0.012, 0.0006);
    gate.gain.setTargetAtTime(0, end + 0.07, 0.015);
  }
  hi.start(now);
  lo.start(now);
  hi.stop(stopAt);
  lo.stop(stopAt);
  const me = { ctx, osc: [hi, lo], gate, at: now, amt };
  counting = me;
  hi.onended = () => {
    if (counting === me) counting = null;
  };
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

// ------------------------------------------------------------ danger

/**
 * One heartbeat at low Life Points: a deep lub-dub, felt more than heard (low sines
 * under a lowpass, quiet so it never covers the duel's own sounds). `hard` (very low
 * LP) is a little louder and closer.
 */
export function heartbeat(hard = false) {
  const g = hard ? 0.34 : 0.24;
  tone(62, 0.16, g, 0, { type: 'sine', to: 38, attack: 0.008 });
  tone(124, 0.07, g * 0.25, 0, { type: 'triangle', to: 70, lp: 300 });
  tone(55, 0.2, g * 0.75, 0.2, { type: 'sine', to: 34, attack: 0.01 });
  if (hard) rumble(0.25, 0.1, 90);
}

/** The ground cracks under a duelist at low Life Points: a stony split and a deep groan. */
export function groundCrack() {
  rumble(0.6, 0.4, 220);
  hiss(0.28, 1800, 260, 0.2, 0, 'bandpass', 0.002);
  hiss(0.6, 500, 90, 0.12, 0.05, 'lowpass', 0.01);
  tone(70, 0.6, 0.18, 0.02, { type: 'sine', to: 32 });
  for (let i = 0; i < 4; i++) tone(900 + Math.random() * 700, 0.05, 0.03, 0.03 + i * 0.05, { type: 'triangle', to: 500 });
}

// ------------------------------------------------------------ Heart of the Cards draw, face-off intro

/** Your deck is ready to draw from: a soft shimmer. `destiny`: a low swell under it, the room going quiet. */
export function deckReady(destiny = false) {
  tone(1318, 0.5, 0.025, 0, { type: 'sine', attack: 0.12 });
  tone(1760, 0.5, 0.02, 0.08, { type: 'sine', attack: 0.12 });
  if (!destiny) return;
  tone(55, 2.2, 0.12, 0, { type: 'sawtooth', attack: 0.8, lp: 260, to: 62 });
  tone(110, 2.0, 0.05, 0.1, { type: 'sine', attack: 0.9 });
  hiss(2.2, 200, 900, 0.035, 0, 'lowpass', 0.9);
}

/** The normal draw, by your own swipe: a quick slide and a crisp snap. */
export function drawSwipe() {
  rumble(0.25, 0.1, 70);
  hiss(0.14, 1400, 5200, 0.12);
  tone(2400, 0.035, 0.06, 0.1, { type: 'square', lp: 4000 });
}

/** A destiny draw: the card lifts off the deck in a rising wind... */
export function destinyRise() {
  rumble(0.4, 0.2, 260);
  hiss(0.9, 300, 3200, 0.09, 0, 'bandpass', 0.2);
  tone(220, 1.0, 0.05, 0, { type: 'sawtooth', to: 880, lp: 1800, attack: 0.3 });
  tone(330, 1.0, 0.035, 0.05, { type: 'triangle', to: 1320, attack: 0.3 });
}

/** ...and turns over: a bright burst and a held major chord. */
export function destinyReveal() {
  rumble(0.8, 0.6, 320);
  hiss(0.5, 6000, 1200, 0.12, 0, 'highpass');
  thud(0.6);
  [523, 659, 784, 1047].forEach((f, i) => tone(f, 1.4, 0.05, 0.02 + i * 0.03, { type: 'sawtooth', lp: 2400, attack: 0.02 }));
  tone(2093, 0.9, 0.03, 0.12, { type: 'sine' });
}

/** The face-off: both duelists sweep in... */
export function faceoffSweep() {
  hiss(0.45, 500, 4000, 0.11, 0, 'bandpass', 0.05);
  hiss(0.45, 600, 3600, 0.09, 0.08, 'bandpass', 0.05);
}

/** ...and meet in the middle with a crack of lightning. */
export function faceoffClash() {
  rumble(0.6, 0.4, 200);
  hiss(0.35, 7000, 900, 0.14, 0, 'highpass', 0.002);
  thud(0.5);
  tone(1760, 0.18, 0.04, 0, { type: 'square', to: 220 });
}

/** "DUEL!": a heavy slam and a brass hit. */
export function duelSlam() {
  rumble(1, 0.8, 420);
  thud(1);
  thud(0.6, 0.05);
  hiss(0.6, 3000, 200, 0.12, 0, 'lowpass', 0.003);
  [196, 247, 294, 392].forEach((f) => tone(f, 0.9, 0.06, 0.01, { type: 'sawtooth', lp: 1500, attack: 0.01 }));
}

// ------------------------------------------------------------ damage counter pop

/** The LP bar cracks: a glassy snap with a few tinkles, heavier (and lower) the bigger the hit. `crit`: a deep crunch under it. */
export function lpCrack(sev: number, crit = false) {
  const s = Math.max(0, Math.min(1, sev));
  hiss(0.08 + s * 0.12, 5200, 1400, 0.08 + s * 0.1, 0, 'highpass', 0.001);
  tone(1800 - s * 600, 0.04, 0.05 + s * 0.04, 0, { type: 'square', to: 600, lp: 5000 });
  const n = 2 + Math.round(s * 4);
  for (let i = 0; i < n; i++) tone(2200 + Math.random() * 1800, 0.04, 0.02 + s * 0.015, 0.03 + i * 0.035, { type: 'triangle', to: 1400 });
  if (crit || s > 0.6) {
    tone(80, 0.35, 0.16, 0.01, { type: 'sine', to: 38 });
    hiss(0.3, 600, 120, 0.08, 0.02, 'lowpass', 0.005);
  }
}

/** The LP gauge breaks under 1000: an electric crackle, a short fizz and a falling zap. */
export function lpSpark() {
  for (let i = 0; i < 6; i++) hiss(0.03, 7000, 3000, 0.06, 0.02 + i * 0.045 + Math.random() * 0.02, 'highpass', 0.001);
  tone(2600, 0.25, 0.04, 0.02, { type: 'sawtooth', to: 300, lp: 4000 });
  tone(120, 0.18, 0.05, 0.03, { type: 'square', lp: 500 });
}

// ------------------------------------------------------------ chain spotlight

/** A chain link's number lands as the chain lifts: a bright note, a step higher per link (the newest one rings). */
export function chainLift(n: number, fresh = false) {
  const f = 523 * 2 ** (Math.min(n - 1, 7) * (2 / 12));
  tone(f, 0.22, fresh ? 0.05 : 0.03, 0, { type: 'triangle' });
  tone(f * 1.5, 0.18, fresh ? 0.025 : 0.012, 0.03, { type: 'sine' });
  if (fresh) hiss(0.25, 2000, 7000, 0.05, 0, 'highpass');
}

/** A chain link resolves: a rush up into its flash, coloured by its kind. */
export function chainResolve(what: 'spell' | 'trap' | 'monster', n = 1) {
  hiss(0.3, 600, 5000, 0.07, 0, 'bandpass', 0.04);
  const base = what === 'trap' ? 311 : what === 'monster' ? 262 : 392;
  const f = base * 2 ** (Math.min(n - 1, 6) / 12);
  tone(f, 0.38, 0.05, 0.05, { type: what === 'trap' ? 'sawtooth' : 'triangle', lp: 2400 });
  tone(f * 2, 0.3, 0.025, 0.08, { type: 'sine' });
}

/** A negated link: a dull buzz down. */
export function chainNegate() {
  thud(0.4);
  tone(220, 0.35, 0.06, 0, { type: 'square', to: 90, lp: 1200 });
}
