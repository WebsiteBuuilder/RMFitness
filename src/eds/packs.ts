// Booster packs: 23 packs of the original, 5 cards each (4 commons + 1 rare slot).
import packData from './data/packs.json';
import { rng } from './rng';
import { STARTER_POOL_NAMES } from './starter';

export interface PackCard {
  name: string;
  rarity: string;
}
export interface Pack {
  name: string;
  unlock: string;
  cards: PackCard[];
}

export const PACKS: Pack[] = packData as Pack[];
export const STARTING_PACKS = ['Dark Magician', 'Mystical Elf', 'Red-Eyes B. Dragon'];

export function packByName(name: string): Pack | undefined {
  return PACKS.find((p) => p.name === name);
}

/** Rare-slot odds out of 180, as documented for EDS. */
const RARE_SLOT: [string, number][] = [
  ['Common', 116],
  ['Rare', 36],
  ['Super Rare', 12],
  ['Ultra Rare', 6],
  ['Secret Rare', 4],
  ['Normal Rare', 6],
];
// Rarest last, so a pack without the rolled rarity steps down, never up (Normal Rare sits just above Common).
const ORDER = ['Common', 'Normal Rare', 'Rare', 'Super Rare', 'Ultra Rare', 'Secret Rare'];

function pick<T>(list: T[], next: () => number): T {
  return list[Math.floor(next() * list.length)];
}

/** Opens a pack: 5 card names. If the pack's list is unknown, falls back to starter-pool cards. */
export function openPack(pack: Pack | undefined, seed: number): PackCard[] {
  const next = rng(seed);
  const cards = pack && pack.cards.length ? pack.cards : STARTER_POOL_NAMES.map((name) => ({ name, rarity: 'Common' }));
  const byRarity = (r: string) => cards.filter((c) => c.rarity === r);
  const commons = byRarity('Common').length ? byRarity('Common') : cards;
  const out: PackCard[] = [];
  for (let i = 0; i < 4; i++) out.push(pick(commons, next));
  // rare slot
  let roll = Math.floor(next() * 180);
  let rarity = 'Common';
  for (const [r, n] of RARE_SLOT) {
    if (roll < n) {
      rarity = r;
      break;
    }
    roll -= n;
  }
  // If that pool is empty in this pack, step down to the next most common non-empty pool.
  let idx = ORDER.indexOf(rarity);
  let pool = byRarity(ORDER[idx]);
  while (pool.length === 0 && idx > 0) pool = byRarity(ORDER[--idx]);
  if (pool.length === 0) pool = commons;
  out.push(pick(pool, next));
  return out;
}

export const RARITY_SHORT: Record<string, string> = { Common: 'C', Rare: 'R', 'Super Rare': 'SR', 'Ultra Rare': 'UR', 'Secret Rare': 'ScR', 'Normal Rare': 'NR' };
