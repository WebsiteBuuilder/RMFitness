// Performs an entrance jingle's score with Web Audio (no files): a tiny band of brass, leads,
// chiptune beeps, bells, pads and drums. Plays nothing unless the audio context is running, so a
// jingle held while the phone was asleep never bursts out later.
import { rawAudioContext } from '../ui/sound';
import { jingleDef, jingleLength, type Inst, type JingleId } from './roster';

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

let noiseBuf: AudioBuffer | null = null;
function noise(ctx: BaseAudioContext) {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/** One performance: its own output, so it can be faded out without touching anything else. */
class Band {
  readonly out: GainNode;
  readonly comp: DynamicsCompressorNode;
  constructor(private ctx: BaseAudioContext, dest: AudioNode, volume: number) {
    const comp = (this.comp = ctx.createDynamicsCompressor());
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(dest);
    this.out = ctx.createGain();
    this.out.gain.value = volume;
    this.out.connect(comp);
  }
  private env(t: number, peak: number, attack: number, dur: number) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + Math.max(0.003, attack));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this.out);
    return g;
  }
  private osc(type: OscillatorType, f: number, t: number, dur: number, into: AudioNode, detune = 0, to?: number) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    if (detune) o.detune.value = detune;
    o.connect(into);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  private lp(f: number, t: number, to?: number, dur = 0) {
    const b = this.ctx.createBiquadFilter();
    b.type = 'lowpass';
    b.frequency.setValueAtTime(f, t);
    if (to) b.frequency.exponentialRampToValueAtTime(to, t + dur);
    return b;
  }
  private hiss(t: number, dur: number, type: BiquadFilterType, f0: number, f1: number, peak: number, attack: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = noise(this.ctx);
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    src.connect(f).connect(this.env(t, peak, attack, dur));
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.1);
  }

  play(inst: Inst, notes: number[], t: number, dur: number, v: number) {
    switch (inst) {
      case 'brass':
      case 'swell': {
        const rise = inst === 'swell';
        const f = this.lp(rise ? 300 : 900, t, rise ? 2600 : 2400, rise ? dur : 0.12);
        f.Q.value = 2;
        f.connect(this.env(t, 0.07 * v, rise ? dur * 0.9 : 0.03, dur + (rise ? 0.2 : 0.35)));
        for (const n of notes) for (const d of [-8, 0, 8]) this.osc('sawtooth', mtof(n), t, dur + 0.4, f, d);
        return;
      }
      case 'lead': {
        const f = this.lp(2600, t, 1400, dur);
        f.connect(this.env(t, 0.08 * v, 0.02, dur + 0.2));
        for (const n of notes) {
          this.osc('sawtooth', mtof(n), t, dur + 0.2, f, -6);
          this.osc('square', mtof(n), t, dur + 0.2, f, 6);
        }
        return;
      }
      case 'chip':
        for (const n of notes) this.osc('square', mtof(n), t, dur, this.env(t, 0.06 * v, 0.003, dur));
        return;
      case 'pluck':
        for (const n of notes) {
          const f = this.lp(2400, t, 400, dur);
          f.connect(this.env(t, 0.1 * v, 0.004, dur));
          this.osc('triangle', mtof(n), t, dur, f);
        }
        return;
      case 'bell':
        for (const n of notes) {
          this.osc('sine', mtof(n), t, dur + 0.6, this.env(t, 0.09 * v, 0.004, dur + 0.6));
          this.osc('sine', mtof(n) * 2.76, t, 0.5, this.env(t, 0.02 * v, 0.004, 0.5));
        }
        return;
      case 'pad': {
        const f = this.lp(1100, t);
        f.connect(this.env(t, 0.06 * v, Math.min(0.5, dur * 0.3), dur + 0.4));
        for (const n of notes) {
          this.osc('sawtooth', mtof(n), t, dur + 0.4, f, -7);
          this.osc('sawtooth', mtof(n), t, dur + 0.4, f, 7);
        }
        return;
      }
      case 'slide': {
        const [a, b] = notes;
        this.osc('square', mtof(a), t, dur, this.env(t, 0.06 * v, 0.005, dur), 0, mtof(b ?? a));
        return;
      }
      case 'timp':
        for (const n of notes) this.osc('sine', mtof(n) * 1.04, t, Math.max(0.5, dur), this.env(t, 0.4 * v, 0.004, Math.max(0.5, dur)), 0, mtof(n));
        return;
      case 'boom':
        this.osc('sine', mtof(notes[0] ?? 38) * 2, t, dur, this.env(t, 0.6 * v, 0.004, dur), 0, mtof(notes[0] ?? 38) * 0.5);
        this.hiss(t, Math.min(0.6, dur), 'lowpass', 1600, 150, 0.12 * v, 0.004);
        return;
      case 'kick':
        this.osc('sine', 150, t, 0.3, this.env(t, 0.5 * v, 0.003, 0.3), 0, 42);
        return;
      case 'snare':
        this.hiss(t, 0.16, 'bandpass', 1900, 1500, 0.22 * v, 0.002);
        this.osc('triangle', 190, t, 0.09, this.env(t, 0.12 * v, 0.002, 0.09));
        return;
      case 'hat':
        this.hiss(t, 0.05, 'highpass', 7500, 7500, 0.06 * v, 0.001);
        return;
      case 'crash':
        this.hiss(t, Math.max(1.2, dur), 'highpass', 5000, 3500, 0.2 * v, 0.003);
        return;
      case 'riser':
        this.hiss(t, dur, 'bandpass', 300, 5000, 0.16 * v, dur * 0.9);
        return;
    }
  }
}

/** Plays a jingle `delay` seconds from now. Returns its length in seconds (0: nothing played). */
export function playJingle(id: JingleId | string | null | undefined, delay = 0, ctx: BaseAudioContext | null = rawAudioContext(), volume = 0.55, offline = false): number {
  const d = jingleDef(id ?? undefined);
  if (!d || !ctx || (!offline && ctx.state !== 'running')) return 0;
  const band = new Band(ctx, ctx.destination, volume);
  const t0 = ctx.currentTime + delay + 0.03;
  const beat = 60 / d.bpm;
  for (const [b, inst, notes, len, v] of d.score) band.play(inst, Array.isArray(notes) ? notes : [notes], t0 + b * beat, len * beat, v ?? 1);
  const length = jingleLength(d);
  // let go of the band once it has rung out
  if (typeof setTimeout !== 'undefined')
    setTimeout(() => {
      try {
        band.out.disconnect();
        band.comp.disconnect();
      } catch {
        /* gone */
      }
    }, (delay + length + 2) * 1000);
  return length;
}
