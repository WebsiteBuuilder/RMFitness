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
import { sealedCards } from '../art/shadow';
import { SHARDS_PER_CHIP, chipsOf, craftCost, shardsOf, spareCopies } from './economy';

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
  /**
   * What a rescuer would take if this player loses a rescue duel: their two strongest
   * spare monsters (a spare is never in one of their decks), declared when they join so
   * both phones agree.
   */
  prizes?: string[];
}

export interface StakeSeat {
  name: string;
  stakes?: Stakes;
  accepted?: boolean;
}

export const noAnte = (a: Ante | null | undefined) => !a || (!a.card && !a.chips);

export function stakesFor(s: SpeedSave, open: boolean, ante: Ante | null = null): Stakes {
  const prizes = betCards(s)
    .filter((n) => card(n)?.kind === 'monster')
    .slice(0, 2);
  return { profile: true, open, ante, sealed: sealedCards(s).map((x) => ({ name: x.name, by: x.by })), prizes };
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

/** The card a rescue takes from the loser: their strongest spare monster that isn't already their bet. */
export function rescuePrize(loser: StakeSeat): string | null {
  const bet = loser.stakes?.ante?.card;
  return loser.stakes?.prizes?.find((n) => n !== bet) ?? null;
}

/** If `seat` wins against the other seat, which of its sealed cards it rescues. */
export function rescueTarget(seats: [StakeSeat, StakeSeat], seat: Pid): string | null {
  const them = seats[other(seat)].name;
  return seats[seat].stakes?.sealed.find((x) => x.by === them)?.name ?? null;
}

/**
 * Gives up one copy of a card. A copy a deck still uses is never taken: the card's
 * crafting cost in chips is paid instead, so losing never breaks a deck.
 */
function take(s: SpeedSave, name: string): SpeedSave {
  if (spareCopies(s, name) < 1) return withChips(s, -craftCost(name));
  const collection = { ...(s.collection ?? {}) };
  collection[name]--;
  if (!collection[name]) delete collection[name];
  return { ...s, collection };
}

/**
 * Puts the rescued card first in line, so the Shadow Realm's own "a win frees the card
 * sealed longest" frees this one. Run it before the Shadow Realm settles the duel.
 */
export function rescueFirst(s: SpeedSave, seat: Pid, state: DuelState, seats: [StakeSeat, StakeSeat], w: Pid | 'draw' | null = state.winner): SpeedSave {
  if (w !== seat || !staked(seats[0].stakes, seats[1].stakes)) return s;
  const name = rescueTarget(seats, seat);
  const by = seats[other(seat)].name;
  const list = sealedCards(s);
  const i = list.findIndex((x) => x.name === name && x.by === by);
  if (i <= 0) return s;
  return { ...s, sealed: [list[i], ...list.filter((_, j) => j !== i)] } as SpeedSave;
}

/**
 * Writes the stakes of a finished Link Battle into the save of the profile in `seat`.
 * Lines say what happened, for the result screen. `w` overrides the winner when a player
 * left mid-duel (their surrender may not have come back from the other phone yet).
 */
export function settleStakes(s: SpeedSave, seat: Pid, state: DuelState, seats: [StakeSeat, StakeSeat], w: Pid | 'draw' | null = state.winner): { save: SpeedSave; lines: string[]; won: string[]; lost: string[] } {
  const lines: string[] = [];
  const won: string[] = [];
  const lost: string[] = [];
  if (w === null || w === 'draw' || !staked(seats[0].stakes, seats[1].stakes)) return { save: s, lines, won, lost };
  const loser = other(w);
  const iWon = w === seat;
  const theirs = seats[other(seat)];
  let next = s;
  // The bets: the winner takes both.
  const lostBet = seats[loser].stakes?.ante;
  if (!noAnte(lostBet)) {
    if (lostBet!.card) {
      next = iWon ? withCards(next, [lostBet!.card]) : take(next, lostBet!.card);
      (iWon ? won : lost).push(lostBet!.card);
      lines.push(iWon ? `You won ${lostBet!.card} from ${theirs.name}` : `${theirs.name} won your ${lostBet!.card}`);
    }
    if (lostBet!.chips) {
      const n = lostBet!.chips;
      const over = iWon ? Math.max(0, chipsOf(next) + n - CHIP_CAP) : 0;
      next = withChips(next, iWon ? n : -n);
      // Chips past the cap aren't lost: they come back as shards.
      if (over) next = { ...next, shards: shardsOf(next) + over * SHARDS_PER_CHIP } as SpeedSave;
      lines.push(iWon ? `You won ${n} Duel Chip${n > 1 ? 's' : ''}${over ? ` (${over} over the ${CHIP_CAP} limit became shards)` : ''}` : `You lost ${n} Duel Chip${n > 1 ? 's' : ''}`);
    }
  }
  // The rescue: the winner's win frees the card the loser sealed (see rescueFirst) and
  // takes one of the loser's spare monsters.
  const rescued = rescueTarget(seats, w);
  if (rescued) {
    const prize = rescuePrize(seats[loser]);
    if (iWon) {
      lines.push(`Rescued ${rescued} from the Shadow Realm`);
      if (prize) {
        next = withCards(next, [prize]);
        won.push(prize);
        lines.push(`and took ${theirs.name}'s ${prize}`);
      }
    } else if (prize) {
      next = take(next, prize);
      lost.push(prize);
      lines.push(`${theirs.name} rescued ${rescued} and took your ${prize}`);
    }
  }
  return { save: next, lines, won, lost };
}

// ---------- leaving without saying goodbye ----------
/**
 * While a Link Battle with stakes is on, each phone keeps a ticket in its own save. A normal
 * finish tears it up. If the app is closed mid-duel, the ticket is still there the next time
 * the profile loads and the duel counts as a loss, so closing the app never dodges a bet.
 */
export interface DuelTicket {
  seat: Pid;
  seats: [StakeSeat, StakeSeat];
  at: number;
}

type TicketSave = SpeedSave & { ticket?: DuelTicket | null };

export const ticketOf = (s: SpeedSave): DuelTicket | null => (s as TicketSave).ticket ?? null;

export const withTicket = (s: SpeedSave, t: DuelTicket | null): SpeedSave => ({ ...s, ticket: t }) as TicketSave;

/** Settles an abandoned duel as a loss for this profile. */
export function settleTicket(s: SpeedSave): { save: SpeedSave; lines: string[]; opp: string } | null {
  const t = ticketOf(s);
  if (!t) return null;
  const opp = t.seats[other(t.seat)].name;
  const fake = { winner: other(t.seat) } as DuelState;
  const r = settleStakes(withTicket(s, null), t.seat, fake, t.seats);
  return { save: r.save, lines: [`You left the duel against ${opp}, so it counted as a loss.`, ...r.lines], opp };
}
