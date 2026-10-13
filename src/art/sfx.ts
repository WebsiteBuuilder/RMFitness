// Synthesized sounds for the 3D cinematics (no audio files): whooshes, booms,
// zaps, chimes and the Shadow Realm drone. Silent until the player has tapped once.
import { audioContext } from '../ui/sound';

let noiseBuf: AudioBuffer | null = null;
function noise(ctx: AudioContext) {
  if (noiseBuf) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

function env(ctx: AudioContext, gain: number, attack: number, dur: number, when: number) {
  const g = ctx.createGain();
  const t = ctx.currentTime + when;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(ctx.destination);
  return g;
}

/** Filtered noise sweeping from f0 to f1 (wind, whoosh, explosion crackle). */
export function whoosh(dur = 0.4, f0 = 300, f1 = 2400, gain = 0.25, when = 0) {
  const ctx = audioContext();
  if (!ctx) return;
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 1.2;
  const t = ctx.currentTime + when;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  src.connect(f).connect(env(ctx, gain, dur * 0.3, dur, when));
  src.start(t);
  src.stop(t + dur + 0.05);
}

function osc(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, when = 0) {
  const ctx = audioContext();
  if (!ctx) return;
  const o = ctx.createOscillator();
  o.type = type;
  const t = ctx.currentTime + when;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  o.connect(env(ctx, gain, 0.01, dur, when));
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** Deep impact. `size` 0..1. */
export function boom(size = 0.5, when = 0) {
  osc('sine', 120 + size * 40, 28, 0.5 + size * 0.6, 0.35 + size * 0.35, when);
  whoosh(0.25 + size * 0.3, 1800, 200, 0.12 + size * 0.15, when);
}

/** Electric zap (beams, lightning). */
export function zap(dur = 0.35, when = 0) {
  osc('sawtooth', 900, 90, dur, 0.12, when);
  osc('square', 1400, 300, dur * 0.6, 0.05, when);
}

/** Bright chime (summons, spells). `pitch` picks the chord root. */
export function chime(pitch = 0.5, when = 0) {
  const root = 440 * 2 ** ((Math.round(pitch * 7) - 3) / 12);
  [1, 1.26, 1.5, 2].forEach((m, i) => osc('triangle', root * m, root * m * 0.99, 0.6, 0.07, when + i * 0.05));
}

/** Rising swell before a big summon. */
export function swell(dur = 0.8, when = 0) {
  osc('sawtooth', 60, 240, dur, 0.08, when);
  whoosh(dur, 200, 3000, 0.12, when);
}

/** The Shadow Realm: a low, wavering drone. */
export function drone(dur = 5) {
  const ctx = audioContext();
  if (!ctx) return;
  const t = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(0.22, t + 0.8);
  out.gain.setValueAtTime(0.22, t + dur - 1);
  out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  out.connect(ctx.destination);
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.7;
  lfoGain.gain.value = 6;
  lfo.connect(lfoGain);
  for (const f of [55, 58.3, 82.4]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    lfoGain.connect(o.frequency);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    o.connect(lp).connect(out);
    o.start(t);
    o.stop(t + dur);
  }
  lfo.start(t);
  lfo.stop(t + dur);
  whoosh(dur * 0.8, 120, 900, 0.1, 0.4);
}
