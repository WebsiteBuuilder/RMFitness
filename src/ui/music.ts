// The duel soundtrack: original music the game composes as it plays (Web Audio, no audio
// files, no paid service). It starts calm, brings in drums when either duelist falls to
// 2000 LP or less, drives harder at 1000 or less, and swells when an ace hits the field
// (heroic for your ace, ominous for your opponent's). The win or loss gets its own cadence.
// Silent until the first tap (phones) and while Music is Off.
import { useEffect, useRef, useState } from 'preact/hooks';
import { musicEnabled, rawAudioContext, useMusicEnabled } from './sound';
import { artBusy } from '../art/cues';
import { aceFor } from '../ace/ace';
import { duelJingleOf, jingleDef } from '../jingles/jingles';
import { playJingle, stopAllJingles } from '../jingles/play';
import { clearJingleToasts, showJingleToast } from '../jingles/toast';
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
// drum grooves for the drums level: [kicks, snares] as 16th steps
const GROOVES: [number[], number[]][] = [
  [[0, 6, 8, 11], [4, 12]],
  [[0, 3, 8, 10], [4, 12]],
  [[0, 7, 10], [4, 12, 15]],
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

// ------------------------------------------------------------ themes

export type ThemeId = 'classic' | 'kingdom' | 'shadow' | 'battle';
export interface Theme {
  id: ThemeId;
  name: string;
  blurb: string;
  /** semitones from D minor */
  key: number;
  /** tempo multiplier */
  tempo: number;
  /** which chord loops it leans on: indexes into CALM and DRIVE */
  calm: number[];
  drive: number[];
  arpWaves: OscillatorType[];
  lead: OscillatorType;
  /** the pad's filter when calm / driving */
  padCut: [number, number];
  /** chance of a bell note where one may ring */
  bells: number;
  /** a soft pulse (hats and a kick) even while it's calm */
  calmBeat?: boolean;
  /** a low held drone under every bar */
  drone?: boolean;
}
export const THEMES: Theme[] = [
  { id: 'classic', name: 'Duelist', blurb: 'The original: a calm start that builds.', key: 0, tempo: 1, calm: [0, 1, 2, 3, 4], drive: [0, 1, 2, 3, 4], arpWaves: ['triangle', 'triangle', 'sine', 'square'], lead: 'sawtooth', padCut: [900, 1500], bells: 0.45 },
  { id: 'kingdom', name: 'Kingdom', blurb: 'Bright and heroic, a tournament on an island.', key: 3, tempo: 1.06, calm: [1, 3, 4], drive: [3, 4, 1], arpWaves: ['square', 'triangle'], lead: 'square', padCut: [1300, 2000], bells: 0.3 },
  { id: 'shadow', name: 'Shadow Game', blurb: 'Slow, dark and a little haunted.', key: -2, tempo: 0.9, calm: [0, 2], drive: [0, 2], arpWaves: ['sine'], lead: 'triangle', padCut: [650, 1100], bells: 0.65, drone: true },
  { id: 'battle', name: 'Battle City', blurb: 'Fast streets: a beat from the first turn.', key: 4, tempo: 1.1, calm: [0, 4, 2], drive: [1, 0, 3], arpWaves: ['square', 'sawtooth'], lead: 'sawtooth', padCut: [1300, 1900], bells: 0.2, calmBeat: true },
];
export const themeDef = (id: string | null | undefined): Theme => THEMES.find((t) => t.id === id) ?? THEMES[0];

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
  private wet: GainNode; // the groove's reverb send (ducks with it)
  private wetLead: GainNode; // the swells' and cadence's reverb send
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
  private groove = GROOVES[0];
  private arpWave: OscillatorType = 'triangle';
  private motif: { rhythm: [number, number][]; tones: number[] } = { rhythm: RHYTHMS[0], tones: [] };
  /** semitones up from D minor (the final stretch climbs a step) */
  private key = 0;
  private fill = false;
  private ended = false;
  private stopped = false;
  private ducked = false;
  private swellUntil = 0;
  readonly volume = 0.5;

  readonly theme: Theme;

  constructor(ctx: AudioContext, seed = Date.now(), theme: Theme = THEMES[0]) {
    this.ctx = ctx;
    this.theme = theme;
    this.key = theme.key;
    this.bpm = BPM[0] * theme.tempo;
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
    this.wet.connect(verb).connect(this.loop); // the groove's hall ducks and steps back with it
    const verb2 = ctx.createConvolver();
    verb2.buffer = ir;
    this.wetLead = ctx.createGain();
    this.wetLead.gain.value = 0.32;
    this.wetLead.connect(verb2).connect(this.master);
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
  /** semitones above D minor right now */
  get keyShift(): number {
    return this.key;
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
    const pool = (this.level === 0 ? this.theme.calm : this.theme.drive).filter((i) => i < set.length);
    this.prog = set[pool.length ? pool[Math.floor(this.rand() * pool.length)] : Math.floor(this.rand() * set.length)];
    this.arp = ARPS[Math.floor(this.rand() * ARPS.length)];
    this.groove = GROOVES[Math.floor(this.rand() * GROOVES.length)];
    const waves = this.theme.arpWaves;
    this.arpWave = waves[Math.floor(this.rand() * waves.length)];
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
    this.bpm = BPM[this.level] * this.theme.tempo;
    this.key = this.theme.key + (this.level === 2 ? 2 : 0);
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
    if (step === 0 && !swelling) this.pad(voiced(chord, 57), t, beat * 4, this.theme.padCut[lv === 0 ? 0 : 1]);
    if (step === 0 && this.theme.drone) this.bass(38 + this.key, t, beat * 4.2, 'sine', 0.14);
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
    // a sparse bell melody when it's calm (and answering the lead in the drums level's quiet bar)
    if (((lv === 0 && (step === 0 || step === 8)) || (lv === 1 && inPhrase === 3 && step % 4 === 0)) && this.rand() < this.theme.bells) {
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
    if (lv === 0 && this.theme.calmBeat && !swelling) {
      if (step === 0 || step === 8) this.kick(t, 0.6);
      if (step % 4 === 2) this.hat(t, 0.035);
    }
    if (lv === 0) {
      if (this.fill && step >= 12) this.snare(t, 0.05 + (step - 12) * 0.03);
      if (step === 15) this.fill = false;
      return;
    }
    // drums
    // every 16th bar of the drums level breaks down to half time before building again
    const half = lv === 1 && this.bar % 16 === 0;
    const kick = lv === 2 ? step % 4 === 0 : half ? step === 0 : this.groove[0].includes(step);
    if (kick) this.kick(t);
    if (half ? step === 8 : this.groove[1].includes(step)) this.snare(t, step === 15 ? 0.1 : 0.22);
    const hat = lv === 2 ? true : half ? step % 4 === 0 : step % 2 === 0;
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
      g.connect(s).connect(dest === this.dry ? this.wet : this.wetLead);
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
    this.osc(this.arpWave, mtof(n), t, dur, f);
    this.osc('square', mtof(n), t, dur * 0.5, this.env(t, gain * 0.15, 0.004, dur * 0.5, 0.3));
  }

  private lead(n: number, t: number, dur: number) {
    const g = this.env(t, 0.045, 0.02, dur + 0.12, 0.5);
    const f = this.lp(2400, t, 1200, dur);
    f.connect(g);
    this.osc(this.theme.lead, mtof(n), t, dur + 0.12, f, -5);
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

// ------------------------------------------------------------ which theme plays

/** The Theme setting: one theme always, a different one each duel, or picked by the moment. */
export type ThemePref = 'moment' | 'rotate' | ThemeId;
export const THEME_PREFS: { id: ThemePref; name: string; note: string }[] = [
  { id: 'moment', name: 'By the moment', note: 'Battle City online, in Ranked and against rivals; Kingdom in Boss Raids and against heroes; Shadow Game against villains and late at night' },
  { id: 'rotate', name: 'Take turns', note: 'a different theme every duel' },
  ...THEMES.map((t) => ({ id: t.id as ThemePref, name: t.name, note: t.blurb })),
];
const THEME_KEY = 'eds.musicTheme';
const THEME_EVT = 'eds-music-theme';
const ROT_KEY = 'eds.musicRot';
const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage blocked */
    }
  },
};
export function musicThemePref(): ThemePref {
  const v = store.get(THEME_KEY);
  return THEME_PREFS.some((p) => p.id === v) ? (v as ThemePref) : 'moment';
}
export function setMusicThemePref(v: ThemePref) {
  store.set(THEME_KEY, v);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(THEME_EVT));
}
export function useMusicThemePref(): ThemePref {
  const [v, setV] = useState(musicThemePref);
  useEffect(() => {
    const fn = () => setV(musicThemePref());
    window.addEventListener(THEME_EVT, fn);
    return () => window.removeEventListener(THEME_EVT, fn);
  }, []);
  return v;
}

/** What kind of duel is on (set by the app as a duel runs). */
export interface MusicScene {
  ranked?: boolean;
  online?: boolean;
  raid?: boolean;
}
let scene: MusicScene = {};
export function setMusicScene(s: MusicScene | null) {
  scene = s ?? {};
}

const VILLAINS = /\b(marik|malik|bakura|dartz|paradox|shadi|noa|gozaburo)\b/i;
const HEROES = /\b(yugi|atem|pharaoh|joey|wheeler|tea|téa)\b/i;
const RIVALS = /\b(kaiba|mokuba|rex|weevil|bandit|keith)\b/i;

/** The theme for a new duel. `turn` counts duels for "Take turns"; `hour` is the local hour. */
export function pickTheme(pref: ThemePref, sc: MusicScene, oppName: string, hour: number, turn: number): ThemeId {
  if (pref !== 'moment' && pref !== 'rotate') return themeDef(pref).id;
  const rotating = THEMES[((turn % THEMES.length) + THEMES.length) % THEMES.length].id;
  if (pref === 'rotate') return rotating;
  if (sc.raid) return 'kingdom';
  if (VILLAINS.test(oppName)) return 'shadow';
  if (sc.ranked || sc.online || RIVALS.test(oppName)) return 'battle';
  if (HEROES.test(oppName)) return 'kingdom';
  if (hour >= 22 || hour < 5) return 'shadow';
  return rotating;
}
function nextTurn(): number {
  const n = (Number(store.get(ROT_KEY)) || 0) + 1;
  store.set(ROT_KEY, String(n));
  return n;
}

// ------------------------------------------------------------ entrances

/** Duels whose entrance jingles already played (by seed), and when their music may begin. */
const intros = new Map<number, number>();
/** The theme each duel got (by seed): a remount or Music Off and On keeps it, and "Take turns" counts each duel once. */
const themes = new Map<number, ThemeId>();
const INTRO_KEY = 'eds.introsDone';
/** Seeds whose entrances played, kept on the phone too: a reload and rejoin never plays them again. */
function introsDone(): number[] {
  try {
    const v = JSON.parse(store.get(INTRO_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : [];
  } catch {
    return [];
  }
}
function markIntro(seed: number) {
  const done = introsDone().filter((x) => x !== seed);
  store.set(INTRO_KEY, JSON.stringify([...done.slice(-29), seed]));
}
/** Will this duel open with the listener's entrance? (the face-off then lets the jingle be its music) */
export function entranceComing(seed: number, side: Pid, turn: number): boolean {
  const ctx = rawAudioContext();
  return turn <= 1 && !(typeof document !== 'undefined' && document.hidden) && musicEnabled() && !!ctx && ctx.state === 'running' && !!duelJingleOf(side) && !intros.has(seed) && !introsDone().includes(seed);
}
/** Cuts the entrances short (the duel was left, Music went Off, the phone locked). */
function cutEntrances() {
  stopAllJingles();
  clearJingleToasts();
}
let entranceBye: ReturnType<typeof setTimeout> | null = null;
// The phone locked (or the tab went away) mid-entrance: cut it now, before the audio is put to
// sleep, so it never finishes late on wake; the duel's music then starts straight away.
if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    const ctx = rawAudioContext();
    let cut = false;
    for (const [seed, until] of intros) if (until && (!ctx || ctx.currentTime < until)) (intros.set(seed, 0), (cut = true));
    if (cut) cutEntrances();
  });
let entranceSeed = 0;

/**
 * Plays each side's entrance jingle as a duel begins (the listener's first), with a name tag
 * on screen. Returns the audio time the soundtrack may start (0: no entrances).
 */
function playEntrances(ctx: AudioContext, s: DuelState, order: Pid[], me: Pid): number {
  markIntro(s.seed);
  let t = 0.25;
  for (const p of order) {
    const id = duelJingleOf(p);
    const d = jingleDef(id);
    if (!d) continue;
    const at = t;
    const len = playJingle(id, at, ctx);
    if (!len) continue;
    showJingleToast(s.players[p]?.name ?? '', d.name, d.hue, at * 1000, Math.min(len, 3) * 1000, p === me);
    t += len + 0.25;
  }
  return t > 0.25 ? ctx.currentTime + t : 0;
}

// One track per duel. A replay jump remounts the board, so letting go waits a moment and a
// remount of the same duel (same seed) picks the same track back up instead of restarting it.
let current: { m: DuelMusic; seed: number; bye: ReturnType<typeof setTimeout> | null } | null = null;

/** For other features (an ace of your choosing...) to call the swell themselves. */
export function musicAce(mine: boolean) {
  current?.m.ace(mine);
}

function take(ctx: AudioContext, seed: number, over: boolean, theme: () => Theme): DuelMusic | null {
  if (current && current.seed === seed && !current.m.isStopped && !(current.m.isEnded && !over)) {
    if (current.bye) clearTimeout(current.bye);
    current.bye = null;
    return current.m;
  }
  if (over) return null; // the duel already ended: no music
  if (current) {
    if (current.bye) clearTimeout(current.bye);
    current.m.stop();
  }
  current = { m: new DuelMusic(ctx, seed, theme()), seed, bye: null };
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
  find(uid: number): { card: { name: string; owner: Pid } } | null;
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
    const mountedAt = Date.now();
    // the same duel came back within a moment (a replay jump remounts the board): its entrances go on
    if (entranceBye) {
      clearTimeout(entranceBye);
      entranceBye = null;
      if (entranceSeed !== seed) cutEntrances(); // (a different duel: the last one's go now)
    }
    entranceSeed = seed;
    const tick = () => {
      const { state: s, seat: me, table: tb, watching: w, engine: e } = live.current;
      if (!s) return;
      const art = (typeof document !== 'undefined' && document.body.classList.contains('art-on')) || artBusy();
      if (!m) {
        const ctx = rawAudioContext();
        if (!ctx || ctx.state !== 'running') return; // waits for the first tap
        // the entrances first: only at the very start of a duel (not a rejoin, a replay jump or a late tap)
        if (!intros.has(s.seed)) {
          const fresh = s.winner === null && s.turn <= 1 && Date.now() - mountedAt < 5000 && !(typeof document !== 'undefined' && document.hidden) && !introsDone().includes(s.seed);
          let until = 0;
          try {
            until = fresh ? playEntrances(ctx, s, tb ? [0, 1] : [me, me === 0 ? 1 : 0], me) : 0;
          } catch {
            cutEntrances(); // (out of audio nodes, say): straight to the music
          }
          intros.set(s.seed, until);
          if (intros.size > 40) intros.delete(intros.keys().next().value as number);
        }
        if (ctx.currentTime < (intros.get(s.seed) ?? 0)) {
          // the phone locked mid-entrance: cut it rather than let it finish late
          if (typeof document !== 'undefined' && document.hidden) {
            cutEntrances();
            intros.set(s.seed, 0);
          }
          return;
        }
        const opp = s.players[me === 0 ? 1 : 0]?.name ?? '';
        m = take(ctx, s.seed, s.winner !== null, () => {
          let id = themes.get(s.seed);
          if (!id) {
            id = pickTheme(musicThemePref(), scene, tb ? '' : opp, new Date().getHours(), nextTurn());
            themes.set(s.seed, id);
            if (themes.size > 40) themes.delete(themes.keys().next().value as number);
          }
          return themeDef(id);
        });
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
        const c = e.find(ev.uid)?.card;
        // a big monster, or the duelist's own chosen Ace whatever its size
        if (s.winner === null && c && (isAceSummon(e.info(c.name), ev.how) || aceFor(c.owner, c.name))) m.ace(tb || ev.player === me);
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
      // left the duel or turned Music Off: the entrances stop too (a quick remount keeps them)
      if (entranceBye) clearTimeout(entranceBye);
      entranceBye = setTimeout(() => ((entranceBye = null), cutEntrances()), 400);
    };
  }, [active, seed]);
}
