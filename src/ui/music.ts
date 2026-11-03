// The duel soundtrack: original music the game composes as it plays (Web Audio, no audio
// files, no paid service). It starts calm, brings in drums when either duelist falls to
// 2000 LP or less, drives harder at 1000 or less, and swells when an ace hits the field
// (heroic for your ace, ominous for your opponent's). The win or loss gets its own cadence.
// Silent until the first tap (phones) and while Music is Off.
import { useEffect, useRef } from 'preact/hooks';
import { rawAudioContext, useMusicEnabled } from './sound';
import { artBusy } from '../art/cues';
import type { CardInfo, DuelState, EngineEvent, Pid } from '../eds/types';

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** 0 calm, 1 drums (someone at 2000 LP or less), 2 final stretch (1000 LP or less). */
export type Level = 0 | 1 | 2;
export const BPM: Record<Level, number> = { 0: 84, 1: 104, 2: 118 };

type Chord = [root: number, minor: boolean];
// Chord loops in D minor, four bars each (roots are bass notes, octave 2).
const CALM: Chord[][] = [
  [[38, true], [46, false], [41, false], [48, false]], // Dm Bb F C
  [[46, false], [48, false], [38, true], [38, true]], // Bb C Dm Dm
  [[38, true], [41, false], [43, true], [45, false]], // Dm F Gm A
  [[38, true], [45, true], [46, false], [41, false]], // Dm Am Bb F
  [[43, true], [46, false], [41, false], [45, false]], // Gm Bb F A
];
const DRIVE: Chord[][] = [
  [[38, true], [43, true], [46, false], [45, false]], // Dm Gm Bb A
  [[38, true], [48, false], [46, false], [45, false]], // Dm C Bb A
  [[38, true], [46, false], [43, true], [45, false]], // Dm Bb Gm A
  [[38, true], [38, true], [46, false], [48, false]], // Dm Dm Bb C
  [[46, false], [48, false], [45, false], [38, true]], // Bb C A Dm
];
// arpeggio shapes (chord-tone indexes), one picked per loop
const ARPS = [
  [0, 1, 2, 1, 2, 0, 1, 2],
  [0, 2, 1, 2, 0, 2, 1, 3],
  [2, 1, 0, 1, 2, 3, 2, 1],
  [0, 1, 2, 3, 2, 1, 0, 1],
];
// lead rhythms for the driving levels: [16th step, length in 16ths]
const RHYTHMS: [number, number][][] = [
  [[0, 3], [3, 3], [6, 2], [8, 6], [14, 2]],
  [[0, 2], [2, 2], [4, 4], [8, 2], [10, 2], [12, 4]],
  [[0, 6], [6, 2], [8, 3], [11, 5]],
];

const tones = ([root, minor]: Chord) => [root, root + (minor ? 3 : 4), root + 7];
/** chord tone i (3 and up climb an octave) */
const toneAt = (notes: number[], i: number) => notes[i % 3] + 12 * Math.floor(i / 3);
/** the chord's notes placed between lo and lo+12 */
const voiced = (c: Chord, lo: number) => tones(c).map((n) => lo + ((((n - lo) % 12) + 12) % 12)).sort((a, b) => a - b);

/** A tiny seeded random so each duel has its own run of loops and arpeggios. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export interface Mood {
  level: Level;
  /** it's the listener's turn (the arpeggio sits higher and brighter) */
  myTurn: boolean;
}

export class DuelMusic {
  private ctx: AudioContext;
  private comp: DynamicsCompressorNode;
  private master: GainNode; // fades in and out
  private bed: GainNode; // the groove, lowered under cinematics
  private loop: GainNode; // the groove, stepping back under a swell
  private dry: GainNode;
  private wet: GainNode;
  private noiseBuf: AudioBuffer;
  private rand: () => number;
  private mood: Mood = { level: 0, myTurn: true };
  private level: Level = 0; // the level actually playing (changes on a bar line)
  private bpm = BPM[0];
  private next = 0; // time of the next 16th step
  private step = 0; // 0..15 within the bar
  private bar = 0;
  private prog: Chord[] = CALM[0];
  private arp = ARPS[0];
  private motif: { rhythm: [number, number][]; tones: number[] } = { rhythm: RHYTHMS[0], tones: [] };
  /** semitones up from D minor (the final stretch climbs a step) */
  private key = 0;
  private fill = false;
  private ended = false;
  private stopped = false;
  private ducked = false;
  private swellUntil = 0;
  readonly volume = 0.5;

  constructor(ctx: AudioContext, seed = Date.now()) {
    this.ctx = ctx;
    this.rand = rng(seed);
    const comp = (this.comp = ctx.createDynamicsCompressor());
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0.0001;
    this.master.connect(comp);
    this.bed = ctx.createGain();
    this.bed.gain.value = 1;
    this.bed.connect(this.master);
    this.loop = ctx.createGain();
    this.loop.gain.value = 1;
    this.dry = ctx.createGain();
    this.dry.connect(this.loop).connect(this.bed);
    // a generated hall: decaying stereo noise as the impulse
    const verb = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 2.4);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    verb.buffer = ir;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.32;
    this.wet.connect(verb).connect(this.master);
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const n = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;
    this.newLoop();
    const t = ctx.currentTime;
    this.master.gain.setValueAtTime(0.0001, t);
    this.master.gain.exponentialRampToValueAtTime(this.volume, t + 3);
    this.next = t + 0.15;
  }

  get playingLevel(): Level {
    return this.level;
  }
  get isEnded(): boolean {
    return this.ended;
  }
  get isStopped(): boolean {
    return this.stopped;
  }
  /** where the next 16th lands: [bar, step] (for tests) */
  get position(): [bar: number, step: number, next: number] {
    return [this.bar, this.step, this.next];
  }

  setMood(m: Mood) {
    if (m.level !== this.mood.level && this.step < 12) this.fill = true; // a drum fill into the new bar, up or down
    this.mood = m;
  }

  /** Lower the groove under a cinematic (they bring their own big sounds); swells stay full. */
  duck(on: boolean) {
    if (on === this.ducked || this.stopped || this.ended) return;
    this.ducked = on;
    const t = this.ctx.currentTime;
    this.bed.gain.cancelScheduledValues(t);
    this.bed.gain.setValueAtTime(Math.max(0.0001, this.bed.gain.value), t);
    this.bed.gain.linearRampToValueAtTime(on ? 0.4 : 1, t + 0.4);
  }

  /** Schedule everything up to `until` (seconds of audio time). */
  pump(until = this.ctx.currentTime + (this.ducked ? 1.2 : 0.8)) {
    if (this.ended || this.stopped) return;
    // timers were asleep (phone locked, a long frame): skip the missed 16ths silently, so the
    // beat stays on its grid instead of bursting to catch up or landing off the bar
    const behind = this.ctx.currentTime - 0.02 - this.next;
    if (behind > 0) {
      // jump whole bars at once, then walk the last few 16ths (each bar line still picks its loop)
      const bar = (60 / this.bpm) * 4;
      if (behind > bar * 2) {
        const bars = Math.floor(behind / bar) - 1;
        this.next += bars * bar;
        this.bar += bars;
      }
      for (let k = 0; this.next < this.ctx.currentTime - 0.02 && k < 64; k++) this.advance();
      if (this.next < this.ctx.currentTime) this.next = this.ctx.currentTime + 0.02;
    }
    while (this.next < until) {
      if (this.step === 0) this.barStart();
      this.play(this.step, this.next);
      this.next += 60 / this.bpm / 4;
      this.step = (this.step + 1) % 16;
    }
  }

  private advance() {
    if (this.step === 0) this.barStart();
    this.next += 60 / this.bpm / 4;
    this.step = (this.step + 1) % 16;
  }

  private newLoop() {
    const set = this.level === 0 ? CALM : DRIVE;
    this.prog = set[Math.floor(this.rand() * set.length)];
    this.arp = ARPS[Math.floor(this.rand() * ARPS.length)];
    // a lead motif in chord tones; bars 1 and 3 repeat it, bar 2 answers, bar 4 breathes
    const rhythm = RHYTHMS[Math.floor(this.rand() * RHYTHMS.length)];
    let at = 2 + Math.floor(this.rand() * 2);
    const tones = rhythm.map(() => (at = Math.max(1, Math.min(5, at + Math.floor(this.rand() * 5) - 2))));
    this.motif = { rhythm, tones };
  }

  private barStart() {
    this.bar++;
    if (this.mood.level !== this.level) {
      this.level = this.mood.level;
      this.bar = 1; // a fresh loop for the new mood
    }
    this.bpm = BPM[this.level];
    this.key = this.level === 2 ? 2 : 0;
    if (this.bar % 4 === 1) this.newLoop();
  }

  private play(step: number, t: number) {
    const [root, minor] = this.prog[(this.bar - 1) % 4];
    const chord: Chord = [root + this.key, minor];
    const inPhrase = (this.bar - 1) % 4;
    const beat = 60 / this.bpm;
    const lv = this.level;
    const swelling = t < this.swellUntil;
    // pad: a held chord each bar (darker until someone is in danger)
    if (step === 0 && !swelling) this.pad(voiced(chord, 57), t, beat * 4, lv === 0 ? 900 : 1500);
    // bass
    if (lv === 0 && step === 0) this.bass(chord[0], t, beat * 3.6, 'sine', 0.32);
    if (lv > 0 && step % 2 === 0) this.bass(chord[0] + (step % 8 === 4 ? 12 : 0), t, beat * 0.45, 'sawtooth', 0.2);
    // arpeggio: 8ths when calm, 16ths in the final stretch; an octave down on the opponent's turn
    const arpEvery = lv === 2 ? 1 : 2;
    if (step % arpEvery === 0 && !swelling) {
      const notes = voiced(chord, this.mood.myTurn ? 69 : 57);
      let n = toneAt(notes, this.arp[(step / arpEvery) % this.arp.length]);
      if (step % 8 === 6 && this.rand() < 0.3) n += 12;
      this.pluck(n, t, beat * (lv === 2 ? 0.3 : 0.6), lv === 0 ? 0.07 : 0.06, this.mood.myTurn ? 2400 : 1300);
    }
    // a sparse bell melody when it's calm
    if (lv === 0 && (step === 0 || step === 8) && this.rand() < 0.45) {
      const ns = voiced(chord, 74);
      this.bell(ns[Math.floor(this.rand() * 3)], t);
    }
    // the lead line once the drums are in
    if (lv > 0 && inPhrase !== 3 && !swelling) {
      const i = this.motif.rhythm.findIndex(([s0]) => s0 === step);
      if (i >= 0) {
        const notes = voiced(chord, 62);
        const tone = this.motif.tones[i] + (inPhrase === 1 && i === this.motif.rhythm.length - 1 ? 1 : 0);
        this.lead(toneAt(notes, tone), t, (60 / this.bpm / 4) * this.motif.rhythm[i][1]);
      }
    }
    if (lv === 0) {
      if (this.fill && step >= 12) this.snare(t, 0.05 + (step - 12) * 0.03);
      if (step === 15) this.fill = false;
      return;
    }
    // drums
    const kick = lv === 2 ? step % 4 === 0 : step === 0 || step === 6 || step === 8 || step === 11;
    if (kick) this.kick(t);
    if (step === 4 || step === 12) this.snare(t, 0.22);
    const hat = lv === 2 ? true : step % 2 === 0;
    if (hat) this.hat(t, step % 4 === 2 ? 0.07 : 0.04);
    if (this.fill && step >= 12) this.snare(t, 0.06 + (step - 12) * 0.035);
    if (step === 15) this.fill = false;
    // a tom run every fourth bar of the final stretch
    if (lv === 2 && this.bar % 4 === 0 && step >= 12) this.tom(t, 200 - (step - 12) * 25);
    if (step === 0 && this.bar % 8 === 1) this.crash(t, 0.12);
  }

  // ------------------------------------------------------------ the swells

  /** An ace hit the field: `mine` is the listener's own ace. */
  ace(mine: boolean, at = this.ctx.currentTime) {
    if (this.ended || this.stopped) return;
    if (at < this.swellUntil - 1) return; // one swell at a time
    const t = at + 0.05;
    const rise = 2.2;
    this.swellUntil = t + rise + 1.6;
    // the groove steps back while the swell rises
    this.loop.gain.cancelScheduledValues(t);
    this.loop.gain.setValueAtTime(1, t);
    this.loop.gain.linearRampToValueAtTime(0.35, t + 0.4);
    this.loop.gain.setValueAtTime(0.35, t + rise);
    this.loop.gain.linearRampToValueAtTime(1, t + rise + 1.6);
    // rising brass, a timpani roll and a cymbal swell, landing on a crash
    const k = this.key;
    const from: number[] = (mine ? [58, 62, 65, 70] : [50, 51, 57, 62]).map((n) => n + k); // Bb major / D minor with a dark Eb
    const land: number[] = (mine ? [50, 57, 62, 66, 69] : [38, 50, 56, 62]).map((n) => n + k); // D major / a tritone stab
    this.brass(from, t, rise, 0.05, 260, mine ? 2600 : 1200, true);
    for (let i = 0; i < 14; i++) {
      const k = i / 14;
      this.timp((mine ? 45 : 38) + k, t + rise * (1 - Math.pow(1 - k, 1.6)) * 0.98, 0.05 + k * 0.12);
    }
    this.noise(t, rise, 'highpass', 3000, 9000, 0.0005, 0.14, true);
    const hit = t + rise;
    this.crash(hit, 0.3, this.master);
    this.kick(hit, 1.3, this.master);
    this.timp((mine ? 50 : 38) + k, hit, 0.4);
    this.brass(land, hit, 1.8, mine ? 0.075 : 0.07, mine ? 3200 : 1400, mine ? 1800 : 600, false);
  }

  /** The duel is over: a closing cadence, then quiet. */
  end(result: 'win' | 'lose' | 'draw') {
    if (this.ended || this.stopped) return;
    this.ended = true;
    // on the next beat, in the key the groove is playing
    const s16 = 60 / this.bpm / 4;
    let t = this.next + ((4 - (this.step % 4)) % 4) * s16;
    if (t < this.ctx.currentTime + 0.05) t = this.ctx.currentTime + 0.05;
    const k = this.key;
    const up = (c: number[]) => c.map((n) => n + k);
    this.loop.gain.setValueAtTime(1, t);
    if (result === 'win') {
      const seq: number[][] = [[58, 62, 65], [60, 64, 67], [62, 66, 69, 74]];
      seq.forEach((c, i) => this.brass(up(c), t + i * 0.42, i === 2 ? 2.6 : 0.4, 0.07, 2400, 2400, false));
      this.timp(46 + k, t, 0.3);
      this.timp(48 + k, t + 0.42, 0.3);
      this.timp(50 + k, t + 0.84, 0.45);
      this.crash(t + 0.84, 0.28, this.master);
    } else if (result === 'lose') {
      const seq: number[][] = [[57, 60, 65], [55, 58, 62], [53, 57, 62]];
      seq.forEach((c, i) => this.pad(up(c), t + i * 0.9, i === 2 ? 3.2 : 1, 700, this.master));
      this.bass(38 + k, t + 1.8, 3, 'sine', 0.3, this.master);
    } else this.pad(up([50, 57, 62]), t, 2.5, 900, this.master);
    this.bed.gain.cancelScheduledValues(t);
    this.bed.gain.setValueAtTime(1, t);
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.volume, t);
    this.master.gain.setValueAtTime(this.volume, t + 3);
    this.master.gain.linearRampToValueAtTime(0.0001, t + 5.5);
  }

  /** Fade out and let go of the audio graph. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(Math.max(0.0001, this.master.gain.value), t);
    this.master.gain.linearRampToValueAtTime(0.0001, t + 0.6);
    setTimeout(() => {
      try {
        this.master.disconnect();
        this.comp.disconnect();
      } catch {
        /* already gone */
      }
    }, 6000);
  }

  // ------------------------------------------------------------ instruments

  private env(t: number, peak: number, attack: number, dur: number, wet = 0.3, dest: AudioNode = this.dry) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + Math.max(0.003, attack));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(dest);
    if (wet > 0) {
      const s = this.ctx.createGain();
      s.gain.value = wet;
      g.connect(s).connect(this.wet);
    }
    return g;
  }

  private osc(type: OscillatorType, f: number, t: number, dur: number, into: AudioNode, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (detune) o.detune.value = detune;
    o.connect(into);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  private lp(f: number, t: number, to?: number, dur = 0) {
    const b = this.ctx.createBiquadFilter();
    b.type = 'lowpass';
    b.frequency.setValueAtTime(f, t);
    if (to) b.frequency.exponentialRampToValueAtTime(to, t + dur);
    return b;
  }

  private pad(notes: number[], t: number, dur: number, cutoff: number, dest: AudioNode = this.dry) {
    const g = this.env(t, 0.05, dur * 0.35, dur + 0.4, 0.6, dest);
    const f = this.lp(cutoff, t);
    f.connect(g);
    for (const n of notes) {
      this.osc('sawtooth', mtof(n), t, dur + 0.4, f, -7);
      this.osc('sawtooth', mtof(n), t, dur + 0.4, f, 7);
    }
  }

  private bass(n: number, t: number, dur: number, type: OscillatorType, gain: number, dest: AudioNode = this.dry) {
    const f = this.lp(type === 'sine' ? 2000 : 500, t);
    f.connect(this.env(t, gain, 0.01, dur, 0, dest));
    this.osc(type, mtof(n), t, dur, f);
  }

  private pluck(n: number, t: number, dur: number, gain: number, bright: number) {
    const f = this.lp(bright, t, 400, dur);
    f.connect(this.env(t, gain, 0.004, dur, 0.4));
    this.osc('triangle', mtof(n), t, dur, f);
    this.osc('square', mtof(n), t, dur * 0.5, this.env(t, gain * 0.15, 0.004, dur * 0.5, 0.3));
  }

  private lead(n: number, t: number, dur: number) {
    const g = this.env(t, 0.045, 0.02, dur + 0.12, 0.5);
    const f = this.lp(2400, t, 1200, dur);
    f.connect(g);
    this.osc('sawtooth', mtof(n), t, dur + 0.12, f, -5);
    this.osc('square', mtof(n), t, dur + 0.12, f, 5);
  }

  private bell(n: number, t: number) {
    this.osc('sine', mtof(n), t, 2.2, this.env(t, 0.06, 0.005, 2.2, 0.7));
    this.osc('sine', mtof(n) * 2.76, t, 0.8, this.env(t, 0.015, 0.005, 0.8, 0.7));
  }

  private brass(notes: number[], t: number, dur: number, gain: number, f0: number, f1: number, rising: boolean) {
    const g = this.env(t, gain, rising ? dur * 0.95 : 0.03, dur + (rising ? 0.15 : 0.8), 0.45, this.master);
    const f = this.lp(f0, t, f1, rising ? dur : 0.25);
    f.Q.value = 2;
    f.connect(g);
    for (const n of notes) for (const d of [-9, 0, 9]) this.osc('sawtooth', mtof(n), t, dur + 0.9, f, d);
  }

  private noise(t: number, dur: number, type: BiquadFilterType, f0: number, f1: number, a: number, peak: number, swell = false, dest: AudioNode = this.dry) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.env(t, peak, swell ? dur * 0.97 : a, dur + (swell ? 0.1 : 0), 0.2, swell ? this.master : dest);
    src.connect(f).connect(g);
    src.start(t, this.rand() * 0.5);
    src.stop(t + dur + 0.15);
  }

  private kick(t: number, size = 1, dest: AudioNode = this.dry) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.22);
    o.connect(this.env(t, 0.55 * size, 0.003, 0.32 * size, 0, dest));
    o.start(t);
    o.stop(t + 0.4 * size);
  }

  private snare(t: number, gain: number) {
    this.noise(t, 0.16, 'bandpass', 1900, 1500, 0.002, gain);
    this.osc('triangle', 190, t, 0.09, this.env(t, gain * 0.6, 0.002, 0.09, 0.1));
  }

  private hat(t: number, gain: number) {
    this.noise(t, 0.045, 'highpass', 7500, 7500, 0.001, gain);
  }

  private tom(t: number, f: number) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.25);
    o.connect(this.env(t, 0.3, 0.003, 0.28, 0.2));
    o.start(t);
    o.stop(t + 0.32);
  }

  private timp(n: number, t: number, gain: number) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(mtof(n) * 1.04, t);
    o.frequency.exponentialRampToValueAtTime(mtof(n), t + 0.08);
    o.connect(this.env(t, gain, 0.004, 0.7, 0.4, this.master));
    o.start(t);
    o.stop(t + 0.75);
  }

  private crash(t: number, gain: number, dest: AudioNode = this.dry) {
    this.noise(t, 1.8, 'highpass', 5000, 3500, 0.003, gain, false, dest);
  }
}

// ------------------------------------------------------------ duel hook-up

/** The level the duel's Life Points call for. */
export function levelFor(lps: number[]): Level {
  const low = Math.min(...lps);
  return low <= 1000 ? 2 : low <= 2000 ? 1 : 0;
}

/** Is this summoned monster an ace? Level 7+, 2500+ ATK, or anything from the Extra Deck or a Ritual. */
export function isAceSummon(c: Pick<CardInfo, 'kind' | 'level' | 'atk'> | undefined, how: string | undefined): boolean {
  if (how && /fusion|ritual|synchro|xyz|link/.test(how)) return true;
  if (!c || c.kind !== 'monster') return false;
  return (c.level ?? 0) >= 7 || (c.atk ?? 0) >= 2500;
}

// One track per duel. A replay jump remounts the board, so letting go waits a moment and a
// remount of the same duel (same seed) picks the same track back up instead of restarting it.
let current: { m: DuelMusic; seed: number; bye: ReturnType<typeof setTimeout> | null } | null = null;

/** For other features (an ace of your choosing...) to call the swell themselves. */
export function musicAce(mine: boolean) {
  current?.m.ace(mine);
}

function take(ctx: AudioContext, seed: number, over: boolean): DuelMusic | null {
  if (current && current.seed === seed && !current.m.isStopped && current.m.isEnded === over) {
    if (current.bye) clearTimeout(current.bye);
    current.bye = null;
    return current.m;
  }
  if (over) return null; // the duel already ended: no music
  if (current) {
    if (current.bye) clearTimeout(current.bye);
    current.m.stop();
  }
  current = { m: new DuelMusic(ctx, seed), seed, bye: null };
  return current.m;
}

function release(m: DuelMusic) {
  const c = current;
  if (!c || c.m !== m) return void m.stop();
  if (c.bye) clearTimeout(c.bye);
  c.bye = setTimeout(() => {
    m.stop();
    if (current === c) current = null;
  }, 400);
}

interface Engine {
  find(uid: number): { card: { name: string } } | null;
  info(name: string): CardInfo;
}

/**
 * Plays the soundtrack for a Speed Duel. `state` is the shown duel state (null: no music),
 * `seat` the listener's side; `table` (pass-the-phone) hears every ace as its own;
 * `watching` (a spectator) hears the victory cadence whoever wins.
 */
export function useDuelMusic(state: DuelState | null, engine: Engine, seat: Pid, table: boolean, watching = false) {
  const on = useMusicEnabled();
  const seen = useRef(-1);
  const live = useRef({ state, seat, table, watching, engine });
  live.current = { state, seat, table, watching, engine };
  const active = !!state && on;
  const seed = state?.seed ?? 0;

  useEffect(() => {
    if (!active) return;
    let m: DuelMusic | null = null;
    let endSeen = 0;
    const tick = () => {
      const { state: s, seat: me, table: tb, watching: w, engine: e } = live.current;
      if (!s) return;
      const art = (typeof document !== 'undefined' && document.body.classList.contains('art-on')) || artBusy();
      if (!m) {
        const ctx = rawAudioContext();
        if (!ctx || ctx.state !== 'running') return; // waits for the first tap
        m = take(ctx, s.seed, s.winner !== null);
        if (!m) return;
        seen.current = (s.events ?? []).reduce((x, ev) => Math.max(x, ev.seq), s.lastEvent?.seq ?? 0);
      }
      if (typeof document !== 'undefined' && document.hidden) return;
      m.duck(art);
      if (s.winner === null) m.setMood({ level: levelFor(s.players.map((p) => p.lp)), myTurn: tb || s.turnPlayer === me });
      const fresh: EngineEvent[] = (s.events ?? (s.lastEvent ? [s.lastEvent] : [])).filter((ev) => ev.seq > seen.current);
      for (const ev of fresh) {
        seen.current = Math.max(seen.current, ev.seq);
        if (ev.kind !== 'summon' || ev.uid === undefined) continue;
        const name = e.find(ev.uid)?.card.name;
        if (isAceSummon(name ? e.info(name) : undefined, ev.how)) m.ace(tb || ev.player === me);
      }
      if (s.winner !== null) {
        endSeen ||= Date.now();
        // the closing cadence waits for the finishing blow's cinematic (it can take a moment to
        // start, so the first second always waits; at most 8 s)
        const waited = Date.now() - endSeen;
        if ((waited > 1000 && !art) || waited > 8000) m.end(s.winner === 'draw' ? 'draw' : tb || w || s.winner === me ? 'win' : 'lose');
      }
      m.pump();
    };
    tick();
    const id = setInterval(tick, 60);
    return () => {
      clearInterval(id);
      if (m) release(m);
    };
  }, [active, seed]);
}
