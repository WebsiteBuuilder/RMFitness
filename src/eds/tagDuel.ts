// Setting up a Tag Duel (2v2 Speed Duel) and reading who should move: the team setups
// (the two brothers together against two computers, a split with a computer partner on
// each side, or one player with a computer partner), the START action that carries the
// four decks, and which phone or computer answers the engine right now.
import type { Action, DuelState, Pid } from './types';
import { activeMember, type TagCtl } from './tag';

export interface TagDuelist {
  name: string;
  main: string[];
  extra: string[];
  skill: string | null;
  ctl: TagCtl;
}

/** The team setups the 2v2 menu offers. */
export type TagLayout = 'together' | 'split' | 'partner';

export const LAYOUTS: { id: TagLayout; title: string; text: string; online: boolean }[] = [
  { id: 'together', title: 'Same team', text: 'You and your brother against two computer duelists.', online: true },
  { id: 'split', title: 'Split teams', text: 'You and a computer partner against your brother and his computer partner.', online: true },
  { id: 'partner', title: 'With a computer partner', text: 'You and a computer partner against two computer duelists, on this phone.', online: false },
];

/** Side 0's and side 1's duelists, in turn order within each team. */
export type TagTeams = [[TagDuelist, TagDuelist], [TagDuelist, TagDuelist]];

export function tagStart(teams: TagTeams, first: Pid, seed: number, ctx = 'free'): Extract<Action, { type: 'START' }> {
  const [a, b] = teams;
  return {
    type: 'START',
    first,
    seed,
    mode: 'speed',
    names: [a[0].name, b[0].name],
    decks: [a[0].main, b[0].main],
    fusions: [a[0].extra, b[0].extra],
    skills: [a[0].skill, b[0].skill],
    tag: {
      names: [a[1].name, b[1].name],
      decks: [a[1].main, b[1].main],
      fusions: [a[1].extra, b[1].extra],
      skills: [a[1].skill, b[1].skill],
      ctl: [
        [a[0].ctl, a[1].ctl],
        [b[0].ctl, b[1].ctl],
      ],
      ctx,
    },
  };
}

/** Who plays a duelist (outside Tag Duels: side 0 is phone 0, side 1 phone 1). */
export function ctlOf(s: DuelState, side: Pid, member: 0 | 1): TagCtl {
  return s.tag?.ctl?.[side][member] ?? (side === 0 ? 0 : 'cpu');
}

/** Who has to move now: the duelist who is in for the side the engine is waiting on. */
export function whoMoves(s: DuelState): { side: Pid; member: 0 | 1; ctl: TagCtl } {
  const side = (s.prompt?.player ?? s.turnPlayer) as Pid;
  const member = activeMember(s, side);
  return { side, member, ctl: ctlOf(s, side, member) };
}

/** The side a phone plays on (a phone with no duelist watches side 0). */
export function sideOfPhone(s: DuelState, phone: Pid): Pid {
  const c = s.tag?.ctl;
  if (!c) return phone;
  if (c[0].includes(phone)) return 0;
  if (c[1].includes(phone)) return 1;
  return 0;
}

/** The member a phone plays on its side, or null if it plays none there. */
export function memberOfPhone(s: DuelState, phone: Pid): 0 | 1 | null {
  const side = sideOfPhone(s, phone);
  const i = s.tag?.ctl?.[side].indexOf(phone) ?? -1;
  return i === 0 || i === 1 ? i : null;
}

/** Whether a phone's player may touch the board right now. */
export function phoneMoves(s: DuelState, phone: Pid): boolean {
  return whoMoves(s).ctl === phone;
}

/** The computer moves are made by phone 0 only, so two phones never both send them. */
export const runsComputers = (phone: Pid): boolean => phone === 0;
