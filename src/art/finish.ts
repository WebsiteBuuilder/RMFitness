// Card finishes (Speed Duel card leveling) in the 3D scenes: a card's finish follows it
// from the hand into its summon cinematic and onto the field. Plain cards and the lower
// finishes keep the engine's own colors; Ultra Rare and up get gold, Glossy a rolling
// pink-violet-cyan sheen, Royal a pulsing gold, Overframe the full turning rainbow, and
// Millennium deep gold with a shadow-violet pulse (and its own summon and attack scenes).
import type { Pid } from '../eds/types';
import { rarityFor } from '../level/duelRarity';

/** TIERS indexes (src/level/leveling.ts) */
export const FIN = { UR: 3, GL: 4, RO: 5, OF: 6, MI: 7 } as const;

/** The finish a card shows in a duel (its owner's), or 0 for a hidden or plain card. */
export function finishOf(c: { name: string; faceUp?: boolean; owner?: Pid; controller: Pid } | null | undefined): number {
  if (!c || !c.name || c.faceUp === false) return 0;
  return rarityFor(c.name, c.owner ?? c.controller);
}

/** CSS id of a finish for the name banner (`fin-GL`...), or '' below Ultra Rare. */
export function finishId(fin: number): '' | 'UR' | 'GL' | 'RO' | 'OF' | 'MI' {
  return fin >= FIN.MI ? 'MI' : fin === FIN.OF ? 'OF' : fin === FIN.RO ? 'RO' : fin === FIN.GL ? 'GL' : fin === FIN.UR ? 'UR' : '';
}

/** The finish tag on a summoned card's name plate. */
export const FINISH_TAG: Record<string, string> = { UR: 'ULTRA RARE', GL: 'GLOSSY ✦ ULTRA RARE', RO: 'ROYAL ♛ ULTRA RARE', OF: '✦ OVERFRAME ✦', MI: '◈ MILLENNIUM ◈' };

/** The Overframe rainbow, and Glossy's sheen colors (for particles: pick by index). */
export const RAINBOW = [0xff4fd0, 0xffb84f, 0xfff6c8, 0x7cff9e, 0x4fe0ff, 0xa24fff];
export const GLOSSY = [0xff7ae6, 0xffffff, 0xb58cff, 0x6ce3ff];
export const ROYAL = [0xffd56a, 0xfff6d8, 0xffc94a];
export const UR_GOLD = [0xffd56a, 0xfff3c2];
/** Millennium: gold, white-gold and a shadow violet. */
export const MILLENNIUM = [0xffd56a, 0xfff6d8, 0xffc93a, 0x9b4dff];

/** The particle colors of a finish (null: the card's own colors). */
export function finishPalette(fin: number): number[] | null {
  return fin >= FIN.MI ? MILLENNIUM : fin === FIN.OF ? RAINBOW : fin === FIN.RO ? ROYAL : fin === FIN.GL ? GLOSSY : fin === FIN.UR ? UR_GOLD : null;
}

function hsv(h: number, s: number, v: number): number {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6];
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

/**
 * The glow color of a finish at time `t` (seconds), or -1 to keep the card's own:
 * Overframe turns through the rainbow, Glossy rolls pink → violet → cyan, Royal and
 * Ultra Rare are gold (Royal breathes toward white).
 */
export function finishGlow(fin: number, t: number): number {
  if (fin >= FIN.MI) {
    // gold that dips toward violet once every few seconds, like the Eye blinking
    const k = Math.pow(0.5 + 0.5 * Math.sin(t * 1.3), 12);
    return hsv(0.12 - 0.36 * k, 0.7 + 0.1 * k, 1);
  }
  if (fin === FIN.OF) return hsv(t * 0.35, 0.72, 1);
  if (fin === FIN.GL) return hsv(0.75 + 0.27 * Math.sin(t * 1.6), 0.55, 1);
  if (fin === FIN.RO) return hsv(0.12, 0.6 - 0.25 * (0.5 + 0.5 * Math.sin(t * 2.2)), 1);
  if (fin === FIN.UR) return 0xffd56a;
  return -1;
}
