import type { DeckList } from '../game/types';
import raw from './starterDecks.json';

// The six 2019 Speed Duel Starter Decks (Destiny Masters SS01, Duelists of
// Tomorrow SS02), typed from the official set lists. Passcodes are filled in
// at load time from the card database by name (see cards.ts resolveDeck).
type Row = [string, number];
interface RawDeck {
  title: string;
  character: string;
  main: Row[];
  extra: Row[];
  skills: string[];
}

function refs(rows: Row[]) {
  return rows.flatMap(([name, n]) => Array.from({ length: n }, () => ({ name, id: null as number | null })));
}

export const STARTER_DECKS: DeckList[] = (raw as RawDeck[]).map((d) => ({
  title: d.title,
  character: d.character,
  main: refs(d.main),
  extra: refs(d.extra),
  skills: d.skills.map((name) => ({ name, id: null })),
}));
