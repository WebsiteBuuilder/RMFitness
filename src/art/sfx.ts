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

/** Time slows ("Not so fast!", the finishing blow's replay): a falling tape-stop sweep over two slow heartbeats. */
export function slowdown(dur = 1.2, when = 0) {
  osc('sawtooth', 420, 55, dur, 0.05, when);
  whoosh(dur, 2600, 140, 0.13, when);
  osc('sine', 72, 46, 0.2, 0.42, when + 0.12);
  osc('sine', 72, 46, 0.2, 0.3, when + 0.12 + dur * 0.45);
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

/**
 * The Duel Disk's projector (holographic summon): a click, then a low electric hum with a
 * whine climbing over it while the hologram forms. `power` 0..1 (Normal .. Fusion/Ritual/Ace).
 */
export function holoHum(dur = 0.8, power = 0.5, when = 0): () => void {
  const ctx = audioContext();
  if (!ctx) return () => {};
  const t = ctx.currentTime + when;
  const out = ctx.createGain();
  const peak = 0.07 + power * 0.06;
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(peak, t + 0.07);
  out.gain.setValueAtTime(peak, t + dur * 0.75);
  out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  // the hum flutters like a projector's lamp
  const trem = ctx.createGain();
  trem.gain.value = 0.75;
  const lfo = ctx.createOscillator();
  const lfoG = ctx.createGain();
  lfo.frequency.value = 11;
  lfoG.gain.value = 0.25;
  lfo.connect(lfoG).connect(trem.gain);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(380, t);
  lp.frequency.exponentialRampToValueAtTime(900 + power * 700, t + dur);
  trem.connect(lp).connect(out).connect(ctx.destination);
  for (const [f, type] of [[98, 'sawtooth'], [98.7, 'sawtooth'], [196, 'square']] as [number, OscillatorType][]) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * (1.06 + power * 0.08), t + dur);
    o.connect(trem);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  lfo.start(t);
  lfo.stop(t + dur + 0.05);
  // the click of the projector switching on, and the whine of it powering up
  osc('square', 2300, 1800, 0.03, 0.05, when);
  // (through the hum's own output, so a skip silences it too)
  const wh = ctx.createOscillator();
  const whG = ctx.createGain();
  wh.type = 'sine';
  wh.frequency.setValueAtTime(520, t + 0.05);
  wh.frequency.exponentialRampToValueAtTime(1300 + power * 900, t + dur * 0.9);
  whG.gain.value = (0.025 + power * 0.02) / peak;
  wh.connect(whG).connect(out);
  wh.start(t + 0.05);
  wh.stop(t + dur + 0.05);
  // skipped (tap): the hum dies away at once instead of running on
  return () => {
    try {
      const n = ctx.currentTime;
      out.gain.cancelScheduledValues(n);
      out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), n);
      out.gain.exponentialRampToValueAtTime(0.0001, n + 0.06);
    } catch {
      /* already stopped */
    }
  };
}

/** The hologram locks solid: a bright shimmer and a soft thump. */
export function holoLock(power = 0.5, when = 0) {
  osc('triangle', 1320, 1980, 0.22, 0.05 + power * 0.03, when);
  osc('triangle', 1980, 2640, 0.28, 0.03 + power * 0.02, when + 0.04);
  osc('sine', 110 + power * 30, 46, 0.3 + power * 0.2, 0.18 + power * 0.14, when);
  whoosh(0.18, 5200, 1400, 0.05, when);
}
