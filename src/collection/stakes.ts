// Stakes between two players in a Speed Duel Link Battle (online or on one phone):
// - Ante: each player may bet one card they can spare and some Duel Chips. Both press
//   Accept before the duel starts. The winner takes both bets.
// - Shadow Realm rescue: if the other player sealed one of your cards in the Shadow Realm,
//   beating them frees it and takes a copy of their strongest monster from that duel.
// Each phone settles its own profile from what both seats declared when they joined,
// so both phones agree on who won what.
import { card } from '../eds/db';
import { other } from '../eds/engine';
import { CHIP_CAP, owned, withCards, withChips, type SpeedSave } from '../eds/speedSave';
import type { DuelState, Pid } from '../eds/types';
import { sealPick, sealedCards } from '../art/shadow';
import { chipsOf, spareCopies } from './economy';

export interface Ante {
  card: string | null;
  chips: number;
}

/** What a seat brings to the table besides its deck. */
export interface Stakes {
  /** a real profile (a guest with a random Starter Deck can't bet or earn) */
  profile: boolean;
  /** playing an "Anything goes" deck */
  open: boolean;
  ante: Ante | null;
  /** this player's cards in the Shadow Realm and who sealed them */
  sealed: { name: string; by: string }[];
}

export interface StakeSeat {
  name: string;
  stakes?: Stakes;
  accepted?: boolean;
}

export const noAnte = (a: Ante | null | undefined) => !a || (!a.card && !a.chips);

export function stakesFor(s: SpeedSave, open: boolean, ante: Ante | null = null): Stakes {
  return { profile: true, open, ante, sealed: sealedCards(s).map((x) => ({ name: x.name, by: x.by })) };
}

/** Both seats are profiles with collection decks: bets and rescues are on. */
export const staked = (a?: Stakes, b?: Stakes) => !!a?.profile && !!b?.profile && !a.open && !b.open;

/** Why this bet can't be made, or null. */
export function anteProblem(s: SpeedSave, a: Ante): string | null {
  if (a.card && spareCopies(s, a.card) < 1) return owned(s, a.card) ? `your decks use every ${a.card} you own` : `you don't own ${a.card}`;
  if (a.chips < 0 || a.chips > chipsOf(s)) return `you have ${chipsOf(s)} Duel Chips`;
  return null;
}

/** Cards this profile could bet: spare copies only, strongest first. */
export function betCards(s: SpeedSave): string[] {
  return Object.keys(s.collection ?? {})
    .filter((n) => spareCopies(s, n) > 0 && card(n)?.sub !== 'Skill')
    .sort((a, b) => (card(b)?.atk ?? -1) - (card(a)?.atk ?? -1) || a.localeCompare(b));
}

/** The card a rescue would win: the loser's strongest monster from this duel. */
export function rescuePrize(state: DuelState, loser: Pid): string | null {
  return sealPick(state, loser);
}

/** If `seat` wins against the other seat, which of its sealed cards it rescues. */
export function rescueTarget(seats: [StakeSeat, StakeSeat], seat: Pid): string | null {
  const them = seats[other(seat)].name;
  return seats[seat].stakes?.sealed.find((x) => x.by === them)?.name ?? null;
}

function take(s: SpeedSave, name: string): SpeedSave {
  if (owned(s, name) < 1) return s;
  const collection = { ...(s.collection ?? {}) };
  collection[name]--;
  if (!collection[name]) delete collection[name];
  return { ...s, collection };
}

function unseal(s: SpeedSave, name: string, by: string): SpeedSave {
  const list = sealedCards(s);
  const i = list.findIndex((x) => x.name === name && x.by === by);
  if (i < 0) return s;
  return { ...s, sealed: list.filter((_, j) => j !== i) } as SpeedSave;
}

/**
 * Writes the stakes of a finished Link Battle into the save of the profile in `seat`.
 * Lines say what happened, for the result screen. `w` overrides the winner when a player
 * left mid-duel (their surrender may not have come back from the other phone yet).
 */
export function settleStakes(s: SpeedSave, seat: Pid, state: DuelState, seats: [StakeSeat, StakeSeat], w: Pid | 'draw' | null = state.winner): { save: SpeedSave; lines: string[] } {
  const lines: string[] = [];
  if (w === null || w === 'draw' || !staked(seats[0].stakes, seats[1].stakes)) return { save: s, lines };
  const loser = other(w);
  const won = w === seat;
  const theirs = seats[other(seat)];
  let next = s;
  // The bets: the winner takes both.
  const lostBet = seats[loser].stakes?.ante;
  if (!noAnte(lostBet)) {
    if (lostBet!.card) {
      next = won ? withCards(next, [lostBet!.card]) : take(next, lostBet!.card);
      lines.push(won ? `You won ${lostBet!.card} from ${theirs.name}` : `${theirs.name} won your ${lostBet!.card}`);
    }
    if (lostBet!.chips) {
      const room = CHIP_CAP - chipsOf(next);
      next = withChips(next, won ? lostBet!.chips : -lostBet!.chips);
      lines.push(won ? `You won ${lostBet!.chips} Duel Chip${lostBet!.chips > 1 ? 's' : ''}${room < lostBet!.chips ? ` (you can hold ${CHIP_CAP}, so ${lostBet!.chips - room} were lost)` : ''}` : `You lost ${lostBet!.chips} Duel Chip${lostBet!.chips > 1 ? 's' : ''}`);
    }
  }
  // The rescue: the winner frees the card the loser sealed and takes the loser's strongest monster.
  const rescued = rescueTarget(seats, w);
  if (rescued) {
    const prize = rescuePrize(state, loser);
    if (won) {
      next = unseal(next, rescued, theirs.name);
      lines.push(`Rescued ${rescued} from the Shadow Realm`);
      if (prize) {
        next = withCards(next, [prize]);
        lines.push(`and took ${theirs.name}'s ${prize}`);
      }
    } else if (prize) {
      next = take(next, prize);
      lines.push(`${theirs.name} rescued ${rescued} and took your ${prize}`);
    }
  }
  return { save: next, lines };
}
