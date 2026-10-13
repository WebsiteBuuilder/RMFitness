// Tag Duels (2v2 Speed Duel), the Tag Force way scaled for Speed Duel: each team is one
// engine side (Pid) with one shared field, Graveyard, banished pile and Life Points; each
// teammate brings their own Deck, Extra Deck, Skill and hand. Turns go team A's first
// duelist, team B's first, team A's second, team B's second, and around again. The duelist
// whose turn it is (or, on the other team's turn, who played that team's last turn) is the
// one "in": their Deck, hand, Extra Deck and Skill sit in the side's PlayerState, the
// partner's wait on the bench in state.tag until the team's next turn swaps them in.
import type { Card, DuelState, Pid, PlayerState } from './types';

/** What one teammate keeps to themselves. */
export interface TagHand {
  name: string;
  deck: Card[];
  hand: Card[];
  fusion: Card[];
  skill?: string | null;
  skillRevealed?: boolean;
  skillUses?: number;
  skillTurn?: number;
}

export interface TagTeam {
  /** the team's two duelists, in turn order */
  names: [string, string];
  /** which of the two is in right now */
  active: 0 | 1;
  /** the team has had a turn (its first turn keeps duelist 1 in) */
  played: boolean;
  /** the teammate who is out */
  bench: TagHand;
}

export interface TagState {
  teams: [TagTeam, TagTeam];
}

/** The second duelist of each team, as START carries them (the first duelist is the usual seat). */
export interface TagStart {
  names: [string, string];
  decks: [string[], string[]];
  fusions: [string[], string[]];
  skills?: [string | null, string | null];
  /** the team's shared Life Points (default TAG_LP) */
  lp?: number;
}

/** Two decks feed one field: the shared Life Points are doubled from Speed Duel's 4000. */
export const TAG_LP = 8000;

export const isTag = (s: DuelState): boolean => !!s.tag;

/** Trade the duelist who is in with the one on the bench. */
export function swapIn(ps: PlayerState, team: TagTeam) {
  const out: TagHand = { name: ps.name, deck: ps.deck, hand: ps.hand, fusion: ps.fusion, skill: ps.skill, skillRevealed: ps.skillRevealed, skillUses: ps.skillUses, skillTurn: ps.skillTurn };
  const b = team.bench;
  ps.name = b.name;
  ps.deck = b.deck;
  ps.hand = b.hand;
  ps.fusion = b.fusion;
  ps.skill = b.skill;
  ps.skillRevealed = b.skillRevealed;
  ps.skillUses = b.skillUses;
  ps.skillTurn = b.skillTurn;
  if (!b.skill) {
    delete ps.skill;
    delete ps.skillRevealed;
    delete ps.skillUses;
    delete ps.skillTurn;
  }
  team.bench = out;
  team.active = team.active === 0 ? 1 : 0;
}

/** Who is in for a side right now: 0 or 1 (always 0 outside Tag Duels). */
export function activeMember(s: DuelState, p: Pid): 0 | 1 {
  return s.tag ? s.tag.teams[p].active : 0;
}

/** The hand a benched teammate is holding (null if `member` is the one in, or not a Tag Duel). */
export function benchHand(s: DuelState, p: Pid, member: 0 | 1): Card[] | null {
  const t = s.tag?.teams[p];
  if (!t || t.active === member) return null;
  return t.bench.hand;
}

/** A side's display name: "Weevil & Rex" in a Tag Duel, the duelist's name otherwise. */
export function sideName(s: DuelState, p: Pid): string {
  const t = s.tag?.teams[p];
  return t ? `${t.names[0]} & ${t.names[1]}` : s.players[p].name;
}

/** One duelist in a Tag Duel: their side (team) and whether they are its first or second duelist. */
export interface TagSeatRef {
  team: Pid;
  member: 0 | 1;
}

/** The four seats in turn order when team `first` starts. */
export function turnOrder(first: Pid): TagSeatRef[] {
  const second: Pid = first === 0 ? 1 : 0;
  return [
    { team: first, member: 0 },
    { team: second, member: 0 },
    { team: first, member: 1 },
    { team: second, member: 1 },
  ];
}
