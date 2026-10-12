// The player's save file: trunk, decks, record, calendar and unlocked packs.
// Stored in localStorage on this device (one "cartridge" per browser).

export interface SaveFile {
  version: 1;
  name: string;
  /** card name -> copies owned (not counting those in decks) */
  trunk: Record<string, number>;
  main: string[];
  side: string[];
  fusion: string[];
  /** day counter since the start (the EDS calendar advances one day per duel) */
  day: number;
  record: Record<string, { w: number; l: number; d: number }>;
  wins: number;
  losses: number;
  draws: number;
  unlockedPacks: string[];
  usedPasswords: string[];
  /** packs owed to the player and not yet opened */
  pendingPacks: number;
  starter: string | null;
  created: number;
}

const KEY = 'eds.save';

export function newSave(name: string): SaveFile {
  return {
    version: 1,
    name,
    trunk: {},
    main: [],
    side: [],
    fusion: [],
    day: 0,
    record: {},
    wins: 0,
    losses: 0,
    draws: 0,
    unlockedPacks: ['Dark Magician', 'Mystical Elf', 'Red-Eyes B. Dragon'],
    usedPasswords: [],
    pendingPacks: 0,
    starter: null,
    created: Date.now(),
  };
}

export function loadSave(): SaveFile | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SaveFile;
    if (s.version !== 1) return null;
    return s;
  } catch {
    return null;
  }
}

export function writeSave(s: SaveFile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

export function eraseSave() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function addToTrunk(s: SaveFile, names: string[]) {
  for (const n of names) s.trunk[n] = (s.trunk[n] ?? 0) + 1;
}

/** Total copies owned of a card across trunk and decks. */
export function owned(s: SaveFile, name: string): number {
  return (s.trunk[name] ?? 0) + s.main.filter((n) => n === name).length + s.side.filter((n) => n === name).length + s.fusion.filter((n) => n === name).length;
}

export function totalCards(s: SaveFile): number {
  return Object.values(s.trunk).reduce((a, b) => a + b, 0) + s.main.length + s.side.length + s.fusion.length;
}

export const DECK_SIZE = 40;
export const SIDE_MAX = 15;
export const FUSION_MAX = 20;
export const COPIES_MAX = 3;

export function deckProblems(s: SaveFile): string[] {
  const out: string[] = [];
  if (s.main.length !== DECK_SIZE) out.push(`Main Deck must have exactly ${DECK_SIZE} cards (${s.main.length} now)`);
  if (s.side.length > SIDE_MAX) out.push(`Side Deck holds at most ${SIDE_MAX} cards`);
  if (s.fusion.length > FUSION_MAX) out.push(`Fusion Deck holds at most ${FUSION_MAX} cards`);
  const counts: Record<string, number> = {};
  for (const n of [...s.main, ...s.side, ...s.fusion]) counts[n] = (counts[n] ?? 0) + 1;
  for (const [n, c] of Object.entries(counts)) if (c > COPIES_MAX) out.push(`Only ${COPIES_MAX} copies of ${n} allowed`);
  return out;
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The EDS calendar: starts on Monday, January 1 of year 1, one day per duel. */
export function calendarDate(day: number): { month: number; date: number; weekday: number; year: number } {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let d = day;
  let month = 0;
  let year = 1;
  while (d >= lengths[month]) {
    d -= lengths[month];
    month = (month + 1) % 12;
    if (month === 0) year++;
  }
  return { month, date: d + 1, weekday: (1 + day) % 7, year };
}
