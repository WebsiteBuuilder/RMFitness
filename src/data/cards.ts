import type { DeckList } from '../game/types';

/** One card from the generated database (public/cards/cards.json). */
export interface CardData {
  id: number;
  name: string;
  type: string;
  frame: string;
  desc: string;
  atk?: number;
  def?: number;
  level?: number;
  race?: string;
  attribute?: string;
  /** Skill Cards: the character the Skill belongs to */
  character?: string;
  /** true when the image for this card is included in the build */
  img?: boolean;
}

let byId = new Map<number, CardData>();
let byName = new Map<string, CardData>();
let loaded = false;

const BASE = import.meta.env.BASE_URL;

export function cardImageUrl(id: number | null): string | null {
  if (id === null) return null;
  const c = byId.get(id);
  if (c && c.img === false) return null;
  return `${BASE}cards/img/${id}.webp`;
}

function norm(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Loads the card database once. Missing database (first build) is tolerated: cards show as text. */
export async function loadCards(): Promise<boolean> {
  if (loaded) return true;
  try {
    const res = await fetch(`${BASE}cards/cards.json`, { cache: 'force-cache' });
    if (!res.ok) return false;
    const list: CardData[] = await res.json();
    byId = new Map(list.map((c) => [c.id, c]));
    byName = new Map(list.map((c) => [norm(c.name), c]));
    loaded = true;
    return true;
  } catch {
    return false;
  }
}

export function cardsLoaded(): boolean {
  return loaded;
}

export function cardById(id: number | null): CardData | undefined {
  return id === null ? undefined : byId.get(id);
}

export function cardByName(name: string): CardData | undefined {
  return byName.get(norm(name));
}

export function allCards(): CardData[] {
  return Array.from(byId.values());
}

/** Fills in passcodes for a deck list by name. Names that are not found stay text-only. */
export function resolveDeck(deck: DeckList): DeckList {
  const fix = (r: { name: string; id: number | null }) => ({ name: r.name, id: cardByName(r.name)?.id ?? r.id });
  return { ...deck, main: deck.main.map(fix), extra: deck.extra.map(fix), skills: deck.skills.map(fix) };
}
