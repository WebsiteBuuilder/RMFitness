// Speed Duel battle scars: the shared shape of fx.scars (engine.ts writes it, src/ui/matScars.tsx draws it).

/** How many landed attacks the mat keeps; older scars drop off (a long duel never grows the state). */
export const SCAR_CAP = 24;

/** Attribute codes stored in a scar (compact, stable across versions: append only). */
export const ATTRS = ['LIGHT', 'DARK', 'FIRE', 'WATER', 'EARTH', 'WIND', 'DIVINE'] as const;
export type ScarAttr = (typeof ATTRS)[number] | 'NONE';

export const attrCode = (a: string | undefined): number => {
  const i = (ATTRS as readonly string[]).indexOf(a ?? '');
  return i < 0 ? 7 : i;
};
export const attrOfCode = (c: number): ScarAttr => ATTRS[c] ?? 'NONE';

/** One landed attack: the attacking side, its Monster Zone, the defender's Monster Zone (-1 = a direct attack), the Attribute. */
export interface Scar {
  by: 0 | 1;
  from: number;
  to: number;
  attr: ScarAttr;
  /** the duel's running count of scars: seeds the mark's shape, so it never changes as old ones drop off */
  n: number;
}

export function scarsOf(fx: Record<string, unknown> | undefined): Scar[] {
  const raw = fx?.scars;
  if (!Array.isArray(raw)) return [];
  const out: Scar[] = [];
  for (const r of raw) {
    if (!Array.isArray(r) || r.length < 4) continue;
    out.push({ by: r[0] === 1 ? 1 : 0, from: Number(r[1]) | 0, to: r[2] == null ? -1 : Number(r[2]) | 0, attr: attrOfCode(Number(r[3]) | 0), n: Number(r[4]) | 0 });
  }
  return out;
}
