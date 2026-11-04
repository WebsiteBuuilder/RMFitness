// Holographic summons (Duel Disk style, like the anime): the card lands on the summoning
// circle, a projector beam fires up out of it, the monster forms in it as blue-white light
// (scanlines, see-through, the signal tearing and flickering), then a line of light climbs
// its body from the feet up and it locks solid with a flash.
//
// Pure timing here (no three.js), so the summon (runtime.ts), the field figures (board.ts)
// and the tests share it. It never makes a summon longer: everything fits inside the
// summon's own reveal window, which is decided before the hologram is.
import type { SummonHow } from './cues';

/** When the monster first shows in a summon (s from its start): runtime.ts's reveal, shared with the tests. */
/** When a summon's monster starts to show (an Overframe card's frame bursts first). */
export const showAtFor = (over: boolean): number => (over ? 0.62 : 0.42);

export function holoReveal(entrance: string, over: boolean): number {
  const show = showAtFor(over);
  return entrance === 'fusion' || entrance === 'ritual' ? show + 0.2 : entrance === 'materialize' ? show + 0.1 : show;
}

/** How big the show is: 0 Normal, 1 Tribute / Special / Flip, 2 Fusion, Ritual, Xyz, Synchro, Link, Overframe, an Ace. */
export type HoloPower = 0 | 1 | 2;

export interface HoloPlan {
  power: HoloPower;
  /** the monster first shows */
  reveal: number;
  /** the beam fires (s from the summon's start) */
  beamAt: number;
  /** the solidify front starts climbing / reaches the top */
  solidAt: number;
  solidEnd: number;
  /** the beam is gone */
  beamEnd: number;
  /** signal-tearing bursts: [start, length] */
  glitches: [number, number][];
}

/** The hologram's light: blue-white, gold for a Millennium card. */
export const HOLO_COLOR = 0x8fe4ff;
export const HOLO_CORE = 0xe8fbff;
export const HOLO_GOLD = 0xffd56a;
/** The shader's hologram color (linear-ish, a little over 1 so it blooms). */
export const HOLO_RGB: [number, number, number] = [0.55, 0.9, 1.2];
export const HOLO_GOLD_RGB: [number, number, number] = [1.25, 0.95, 0.4];

export function holoPower(method: SummonHow | undefined, opts: { tribute?: boolean; over?: boolean; ace?: boolean; fusionish?: boolean }): HoloPower {
  if (opts.over || opts.ace || opts.fusionish) return 2;
  if (method === 'fusion' || method === 'ritual' || method === 'xyz' || method === 'synchro' || method === 'link') return 2;
  if (opts.tribute || method === 'tribute' || method === 'special') return 1;
  return 0;
}

/**
 * The hologram's beats inside a summon: `reveal` is when the monster first shows,
 * `end` (E) when it leaves for its card on the field. Solid well before the flight.
 */
export function holoPlan(power: HoloPower, reveal: number, end: number): HoloPlan {
  const beamAt = Math.max(0.28, reveal - 0.14);
  const hold = [0.3, 0.4, 0.52][power];
  const climb = [0.18, 0.22, 0.28][power];
  // it must be solid (and its flash over) before the monster flies to its card
  const latest = end - 0.3;
  const solidEnd = Math.min(latest, reveal + hold + climb);
  // (never after the end, however short the window)
  const solidAt = Math.min(solidEnd - 0.05, Math.max(reveal + 0.08, solidEnd - climb));
  const glitches: [number, number][] = [[reveal + 0.02, 0.1]];
  if (power >= 1) glitches.push([solidAt - 0.12, 0.08]);
  if (power >= 2) glitches.push([reveal + hold * 0.5, 0.07]);
  // (in a short summon the tears squeeze into the hologram's own time, or drop out)
  const fit = glitches.map(([a, d]): [number, number] => [Math.max(reveal, a), Math.min(a + d, solidEnd) - Math.max(reveal, a)]).filter(([, d]) => d >= 0.04);
  return { power, reveal, beamAt, solidAt, solidEnd, beamEnd: Math.min(end, solidEnd + 0.18), glitches: fit };
}

/** 0..1 signal tearing at time t (s) of a plan. */
export function glitchAt(p: HoloPlan, t: number): number {
  let g = 0;
  for (const [a, d] of p.glitches) if (t >= a && t < a + d) g = Math.max(g, Math.sin(((t - a) / d) * Math.PI));
  return g;
}

/**
 * A projector's flicker at time t (s): mostly steady, with short dropouts (0..0.45 extra
 * see-through). Deterministic, so a replay flickers the same way.
 */
export function flickerAt(t: number, seed = 0): number {
  const a = Math.sin(t * 53 + seed) * Math.sin(t * 31.7 + seed * 2.1);
  return a > 0.8 ? 0.45 : a > 0.6 ? 0.18 : 0;
}

/**
 * A field figure appearing without a cinematic (board.ts): its 0..1 arrival `show` →
 * hologram strength and the solidify front's height (in the figure's 0..1 mesh height).
 */
export interface BoardHolo {
  holo: number;
  line: number;
  reveal: number;
}
export function boardHolo(show: number, out: BoardHolo = { holo: 0, line: -1, reveal: 1 }): BoardHolo {
  if (show >= 1) {
    out.holo = 0;
    out.line = -1;
    out.reveal = 1;
    return out;
  }
  out.holo = 1;
  out.reveal = Math.min(1, show * 2.4);
  out.line = Math.min(1.07, show < 0.5 ? -0.05 : -0.05 + ((show - 0.5) / 0.45) * 1.12);
  return out;
}

/** Several monsters arriving at once share one projector hum (ms between hums). */
export const HUM_GAP_MS = 150;
