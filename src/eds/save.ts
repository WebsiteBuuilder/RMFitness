// The player's save file: trunk, decks, record, calendar and unlocked packs.
// Stored in localStorage on this device, one save per profile.

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
  /** how this player works the duel screen; missing means the original Classic controls */
  controls?: ControlStyle;
}

/** Classic: the original game's menu window. Touch: tap and drag, like Master Duel. */
export type ControlStyle = 'classic' | 'touch';
export const CONTROL_NAMES: Record<ControlStyle, string> = { classic: 'Classic', touch: 'Touch' };

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

// ---------- profiles ----------
// Several people can share one phone: each profile has its own SaveFile.
// `eds.profiles` holds the list; each save lives under `eds.save.<id>`.

export interface Profile {
  id: string;
  /** the person's real name (small print on the picker) */
  name: string;
  /** what shows in duels, records and the menu header */
  alias: string;
  color: string;
  created: number;
}

export const MAX_PROFILES = 6;
export const PROFILE_COLORS = ['#d8453b', '#2f7fe0', '#e0a21b', '#2fae5a', '#9b51e0', '#e0559b'];
export const NAME_MAX = 12;
export const ALIAS_MAX = 10;

const PROFILES_KEY = 'eds.profiles';
/** The single save used before profiles existed. */
const LEGACY_KEY = 'eds.save';
const saveKey = (id: string) => `eds.save.${id}`;

// In-memory copies, so the game still works for the session when storage is blocked.
let memProfiles: Profile[] | null = null;
const memSaves = new Map<string, SaveFile>();

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, v: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}

function removeKey(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function validSave(s: unknown): s is SaveFile {
  return !!s && typeof s === 'object' && (s as SaveFile).version === 1;
}

function nextColor(list: Profile[]): string {
  return PROFILE_COLORS.find((c) => !list.some((p) => p.color === c)) ?? PROFILE_COLORS[list.length % PROFILE_COLORS.length];
}

/** The profiles on this device. The first time, an old single save becomes a profile. */
export function loadProfiles(): Profile[] {
  const stored = readJson<Profile[]>(PROFILES_KEY);
  let list = Array.isArray(stored) ? stored.filter((p) => p && typeof p.id === 'string') : (memProfiles ?? []);
  if (list.length === 0) {
    const legacy = readJson<SaveFile>(LEGACY_KEY);
    if (validSave(legacy)) {
      const label = (legacy.name || 'Duelist').slice(0, ALIAS_MAX);
      const p: Profile = { id: newId(), name: label, alias: label, color: PROFILE_COLORS[0], created: legacy.created || Date.now() };
      list = [p];
      memSaves.set(p.id, legacy);
      // Drop the old key only once both the save and the profile list are safely written.
      if (writeJson(saveKey(p.id), legacy) && writeJson(PROFILES_KEY, list)) removeKey(LEGACY_KEY);
    }
  }
  memProfiles = list;
  return list;
}

export function writeProfiles(list: Profile[]) {
  memProfiles = list;
  writeJson(PROFILES_KEY, list);
}

export function createProfile(name: string, alias: string): Profile | null {
  const list = loadProfiles();
  if (list.length >= MAX_PROFILES) return null;
  const a = alias.trim().slice(0, ALIAS_MAX) || 'Duelist';
  const p: Profile = { id: newId(), name: name.trim().slice(0, NAME_MAX) || a, alias: a, color: nextColor(list), created: Date.now() };
  writeProfiles([...list, p]);
  return p;
}

/** Rename a profile. The save's duel name follows the alias. */
export function updateProfile(id: string, name: string, alias: string): Profile | null {
  const list = loadProfiles();
  const old = list.find((p) => p.id === id);
  if (!old) return null;
  const a = alias.trim().slice(0, ALIAS_MAX) || old.alias;
  const p: Profile = { ...old, name: name.trim().slice(0, NAME_MAX) || a, alias: a };
  writeProfiles(list.map((x) => (x.id === id ? p : x)));
  const s = loadSave(id);
  if (s && s.name !== a) writeSave(id, { ...s, name: a });
  return p;
}

export function deleteProfile(id: string) {
  writeProfiles(loadProfiles().filter((p) => p.id !== id));
  eraseSave(id);
}

export function loadSave(id: string): SaveFile | null {
  const s = readJson<SaveFile>(saveKey(id)) ?? memSaves.get(id) ?? null;
  return validSave(s) ? s : null;
}

export function writeSave(id: string, s: SaveFile) {
  memSaves.set(id, s);
  writeJson(saveKey(id), s);
}

export function eraseSave(id: string) {
  memSaves.delete(id);
  removeKey(saveKey(id));
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
