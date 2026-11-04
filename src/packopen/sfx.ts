// Pack opening sounds, made on the spot with Web Audio like the rest of the game's sound
// (no files to download). Each one is a handful of short-lived nodes; they all go quiet
// with the Sound setting, since audioContext() is null while sound is off.
import { audioContext } from '../ui/sound';

let noise: AudioBuffer | null = null;
/** Half a second of white noise, made once and shared by the tear, the swish and the burst. */
function noiseOf(ctx: AudioContext): AudioBuffer {
  if (noise && noise.sampleRate === ctx.sampleRate) return noise;
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return (noise = b);
}

function hiss(ctx: AudioContext, at: number, dur: number, type: BiquadFilterType, from: number, to: number, gain: number) {
  const src = ctx.createBufferSource();
  src.buffer = noiseOf(ctx);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = 1.2;
  f.frequency.setValueAtTime(from, at);
  f.frequency.exponentialRampToValueAtTime(to, at + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(at);
  src.stop(at + dur + 0.02);
}

function note(ctx: AudioContext, at: number, freq: number, dur: number, type: OscillatorType, gain: number, slideTo?: number) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(ctx.destination);
  o.start(at);
  o.stop(at + dur + 0.02);
}

/** The foil ripping: a rising band of noise and a little crackle. */
export function sfxTear() {
  const ctx = audioContext();
  if (!ctx) return;
  const t = ctx.currentTime;
  hiss(ctx, t, 0.32, 'bandpass', 900, 5200, 0.5);
  hiss(ctx, t + 0.05, 0.12, 'highpass', 3000, 7000, 0.2);
  note(ctx, t + 0.02, 90, 0.18, 'sine', 0.25, 55);
}

/** A card sliding out of the pack (each one a touch higher). */
export function sfxDeal(i = 0) {
  const ctx = audioContext();
  if (!ctx) return;
  const t = ctx.currentTime;
  hiss(ctx, t, 0.09, 'highpass', 2400 + i * 300, 6000, 0.12);
}

// Pentatonic sparkles, one more note per grade.
const SPARK = [1046, 1318, 1568, 2093, 2637, 3136];

/** A card turning face up, sounding its grade: a tick for a Common up to a full chord for an Overframe. */
export function sfxFlip(grade: number) {
  const ctx = audioContext();
  if (!ctx) return;
  const t = ctx.currentTime;
  hiss(ctx, t, 0.07, 'bandpass', 1800, 3200, 0.1);
  if (grade <= 0) return note(ctx, t, 740, 0.06, 'triangle', 0.08);
  const n = Math.min(SPARK.length, grade + 1);
  for (let i = 0; i < n; i++) note(ctx, t + i * 0.055, SPARK[i] * (grade >= 4 ? 0.5 : 1), 0.22 + i * 0.03, grade >= 3 ? 'square' : 'sine', grade >= 3 ? 0.05 : 0.08);
  if (grade >= 3) {
    // a chord under the sparkle, and a drop of bass for the big ones
    [262, 330, 392].forEach((f) => note(ctx, t + 0.05, f * (grade >= 5 ? 2 : 1), 0.6, 'triangle', 0.06));
    note(ctx, t, 110, 0.4, 'sine', 0.35, 50);
  }
}

/** The rarest pull charging up under your thumb: a rising tone that stops when it lets go or bursts. */
export function sfxCharge(ms: number): () => void {
  const ctx = audioContext();
  if (!ctx) return () => {};
  const t = ctx.currentTime;
  const end = t + ms / 1000;
  const o = ctx.createOscillator();
  const lp = ctx.createBiquadFilter();
  const g = ctx.createGain();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(110, t);
  o.frequency.exponentialRampToValueAtTime(880, end);
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(400, t);
  lp.frequency.exponentialRampToValueAtTime(5000, end);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.09, end);
  o.connect(lp).connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(end + 0.05);
  return () => {
    try {
      const now = ctx.currentTime;
      // hold the level where it is (Safari misreports .value mid-ramp, which pops)
      const p = g.gain as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now);
      else {
        p.cancelScheduledValues(now);
        p.setValueAtTime(Math.max(0.0001, p.value), now);
      }
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      o.stop(now + 0.08);
    } catch {
      /* already stopped */
    }
  };
}

/** The rarest pull bursting into the light: a boom, a crash and a bright chord. */
export function sfxBurst(grade: number) {
  const ctx = audioContext();
  if (!ctx) return;
  const t = ctx.currentTime;
  note(ctx, t, 140, 0.7, 'sine', 0.6, 40);
  hiss(ctx, t, 0.45, 'lowpass', 6000, 400, 0.35);
  const chord = grade >= 6 ? [523, 659, 784, 1046, 1318] : [523, 659, 784, 1046];
  chord.forEach((f, i) => note(ctx, t + 0.04 + i * 0.03, f, 0.9, 'square', 0.045));
  sfxFlip(Math.min(grade, 5));
}
