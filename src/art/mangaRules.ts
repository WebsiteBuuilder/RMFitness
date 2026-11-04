// Manga attack panels: when a big hit lands, the duel freezes for about a second on an
// inked manga panel of the attacker (screentone, focus lines, a sound word). Cosmetic only.
// This file has no DOM: which hits get a panel, the sound word, its ink. mangaPanel.ts draws it.

export type MangaMode = 'big' | 'all' | 'off';

/** How long the panel holds the frozen frame, real seconds at Animation speed 1×. */
export const MANGA_HOLD_S = 0.95;
/** ...and the brisker beat ("Every hit", or a panel soon after the last one). */
export const MANGA_BRISK_S = 0.65;
/** Under "Big hits", panels this close together skip the second one (unless it is huge). */
export const MANGA_COOLDOWN_S = 7;
/** Damage this big always gets a panel (cooldown or not), and the bigger "mega" look. */
export const MANGA_MEGA_DMG = 2500;

export interface MangaHit {
  /** battle damage dealt by the blow (0 when none) */
  dmg: number;
  /** a direct attack */
  direct: boolean;
  /** the defending monster is destroyed by it */
  destroys: boolean;
  /** the attacker's grandeur, 0 small … 3 boss (profile tier) */
  tier: number;
  /** the blow wins the duel (the ending cutscene and finisher replay own that moment) */
  lethal: boolean;
  /** the finishing blow's replay */
  replay: boolean;
  /** the attacker loses its own attack (bounces off, or is destroyed) */
  attackerLoses: boolean;
  /** real seconds since the last panel this duel (Infinity when none yet) */
  sinceLast: number;
}

/** Does this blow get a manga panel? */
export function mangaWorthy(h: MangaHit, mode: MangaMode): boolean {
  if (mode === 'off' || h.replay || h.lethal || h.attackerLoses) return false;
  if (mode === 'all') return h.dmg > 0 || h.destroys;
  const big = (h.direct && h.dmg >= 1000) || h.dmg >= 1500 || (h.destroys && (h.tier >= 2 || h.dmg >= 1000));
  if (!big) return false;
  return h.dmg >= MANGA_MEGA_DMG || h.sinceLast >= MANGA_COOLDOWN_S;
}

export const isMega = (h: Pick<MangaHit, 'dmg'>) => h.dmg >= MANGA_MEGA_DMG;

/** A sound word, in big Latin letters, with the katakana a manga would letter beside it. */
export interface SoundWord {
  word: string;
  kana: string;
}

/** Every Type printed on a Speed Duel monster has its own sound words (two or three to vary). */
export const RACE_WORDS: Record<string, SoundWord[]> = {
  Dragon: [{ word: 'ROAAAR!', kana: 'ゴオオッ' }, { word: 'GRAAAH!', kana: 'グオオ' }, { word: 'KRA-THOOM!', kana: 'ドゴォン' }],
  Spellcaster: [{ word: 'ZWAAAM!', kana: 'ズオオ' }, { word: 'VWOOSH!', kana: 'ヴォン' }, { word: 'KZZAAT!', kana: 'バチィ' }],
  Warrior: [{ word: 'SLASH!', kana: 'ズバッ' }, { word: 'SHING!', kana: 'シャキン' }, { word: 'KLANG!', kana: 'ガキン' }],
  'Beast-Warrior': [{ word: 'SLAM!', kana: 'ドカッ' }, { word: 'RRRIP!', kana: 'ザシュ' }],
  Beast: [{ word: 'RRRIP!', kana: 'ガブッ' }, { word: 'GRRAH!', kana: 'ガルル' }],
  'Winged Beast': [{ word: 'SHWAAK!', kana: 'バサッ' }, { word: 'SKREEE!', kana: 'キィィ' }],
  Fiend: [{ word: 'DOOM!', kana: 'ゴゴゴ' }, { word: 'KRAKA-DOOM!', kana: 'ドドド' }, { word: 'VWORM!', kana: 'ズズン' }],
  Zombie: [{ word: 'GRRAAH!', kana: 'グシャ' }, { word: 'SQUELCH!', kana: 'ベチャ' }],
  Machine: [{ word: 'KRAKOOM!', kana: 'ドガァン' }, { word: 'BRRRT!', kana: 'ガガガ' }, { word: 'KA-CHUNK!', kana: 'ガシャン' }],
  Fairy: [{ word: 'SHIIING!', kana: 'キラーン' }, { word: 'FWAAA!', kana: 'パアァ' }],
  Insect: [{ word: 'BZZZT!', kana: 'ブーン' }, { word: 'SKRITCH!', kana: 'ガサッ' }],
  Dinosaur: [{ word: 'STOMP!', kana: 'ズシン' }, { word: 'CHOMP!', kana: 'ガブリ' }],
  Rock: [{ word: 'KRUNCH!', kana: 'ゴシャ' }, { word: 'THOOM!', kana: 'ドスン' }],
  Aqua: [{ word: 'SPLASSH!', kana: 'ザバァ' }, { word: 'GLOOSH!', kana: 'ドプン' }],
  Fish: [{ word: 'SPLOOSH!', kana: 'バシャッ' }, { word: 'CHOMP!', kana: 'ガブッ' }],
  'Sea Serpent': [{ word: 'SPLASSH!', kana: 'ザッパーン' }, { word: 'HISSS!', kana: 'シャアア' }],
  Pyro: [{ word: 'FWOOSH!', kana: 'ボオォ' }, { word: 'KA-BLAM!', kana: 'ボカン' }],
  Thunder: [{ word: 'ZZAKK!', kana: 'バリバリ' }, { word: 'KRRZZT!', kana: 'ビシャァ' }],
  Plant: [{ word: 'THWACK!', kana: 'ビシッ' }, { word: 'SNAP!', kana: 'バキッ' }],
  Reptile: [{ word: 'HISSS!', kana: 'シャーッ' }, { word: 'SNAP!', kana: 'ガチン' }],
  Psychic: [{ word: 'VWOMM!', kana: 'キィン' }, { word: 'ZHAAM!', kana: 'ズン' }],
  'Divine-Beast': [{ word: 'GO GO GO GO', kana: 'ゴゴゴゴ' }, { word: 'KA-THOOOM!', kana: 'ドオォン' }],
};
const FALLBACK: SoundWord[] = [{ word: 'BOOM!', kana: 'ドン' }, { word: 'WHAM!', kana: 'バキッ' }];

/** The sound word for a hit by a monster of this Type; `seed` picks among its words. */
export function soundWordFor(race: string | undefined, seed: number): SoundWord {
  const list = (race && RACE_WORDS[race]) || FALLBACK;
  return list[Math.abs(Math.floor(seed)) % list.length];
}

/** The word's ink by Attribute: [fill, glow]. */
export const ATTRIBUTE_INK: Record<string, [string, string]> = {
  DARK: ['#c58cff', '#5a1a9a'],
  LIGHT: ['#ffe27a', '#b07a00'],
  FIRE: ['#ff7a4a', '#a01800'],
  WATER: ['#7ad0ff', '#0050a0'],
  WIND: ['#8cffb0', '#08804a'],
  EARTH: ['#ffc070', '#7a4a10'],
  DIVINE: ['#fff2b0', '#c08a00'],
};
export const inkFor = (attribute: string | undefined): [string, string] => (attribute && ATTRIBUTE_INK[attribute]) || ['#ffffff', '#c0102a'];

/** What the small inset panel says: the damage, or the defender broken. */
export function insetText(h: Pick<MangaHit, 'dmg' | 'direct' | 'destroys'>): string | null {
  if (h.dmg > 0) return `-${h.dmg}`;
  return h.destroys ? 'DESTROYED' : null;
}
