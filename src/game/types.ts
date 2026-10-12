export type PlayerId = 0 | 1;

/** A zone on one player's side of the table. Slot zones carry an index. */
export type SlotZone = 'm' | 's';
export type PileZone = 'deck' | 'hand' | 'extra' | 'gy' | 'banished';
export type SingleZone = 'field' | 'skill';
export type ZoneName = SlotZone | PileZone | SingleZone;

export interface Loc {
  player: PlayerId;
  zone: ZoneName;
  /** slot index for 'm' and 's'; position for piles: 'top' | 'bottom' */
  index?: number;
  place?: 'top' | 'bottom';
}

/** A card on the table. `cardId` is the Konami passcode used for art and text. */
export interface CardInst {
  iid: string;
  cardId: number | null;
  name: string;
  owner: PlayerId;
  faceDown: boolean;
  defense: boolean;
  counters: number;
  token?: boolean;
}

export interface PlayerState {
  name: string;
  lp: number;
  deck: CardInst[];
  hand: CardInst[];
  extra: CardInst[];
  gy: CardInst[];
  banished: CardInst[];
  field: CardInst | null;
  skill: CardInst | null;
  monsters: (CardInst | null)[];
  spells: (CardInst | null)[];
  ready: boolean;
}

export type Phase = 'DP' | 'SP' | 'M1' | 'BP' | 'EP';
export const PHASES: Phase[] = ['DP', 'SP', 'M1', 'BP', 'EP'];
export const PHASE_LABEL: Record<Phase, string> = {
  DP: 'Draw',
  SP: 'Standby',
  M1: 'Main 1',
  BP: 'Battle',
  EP: 'End',
};

export interface LogEntry {
  seq: number;
  player: PlayerId | null;
  text: string;
  /** true when the opponent should not see the detail (e.g. a card looked at privately) */
  undone?: boolean;
}

export interface Rules {
  startingLp: number;
  startingHand: number;
  firstPlayerDraws: boolean;
  monsterZones: number;
  spellZones: number;
}

export const SPEED_DUEL_RULES: Rules = {
  startingLp: 4000,
  startingHand: 4,
  firstPlayerDraws: false,
  monsterZones: 3,
  spellZones: 3,
};

export interface GameState {
  rules: Rules;
  players: [PlayerState, PlayerState];
  started: boolean;
  turn: number;
  turnPlayer: PlayerId;
  phase: Phase;
  waitFlag: PlayerId | null;
  winner: PlayerId | null;
  lastSummon: { iid: string; seq: number } | null;
  log: LogEntry[];
}

/** A card reference inside a deck list: by passcode when known, always by name. */
export interface CardRef {
  name: string;
  id: number | null;
}

export interface DeckList {
  title: string;
  character: string;
  main: CardRef[];
  extra: CardRef[];
  skills: CardRef[];
}

export type GameEvent =
  | { type: 'JOIN'; player: PlayerId; name: string; deck: DeckList; skill: CardRef | null }
  | { type: 'START'; first: PlayerId; seed: number }
  | { type: 'MOVE'; player: PlayerId; iid: string; to: Loc; faceDown?: boolean; defense?: boolean }
  | { type: 'FLIP'; player: PlayerId; iid: string }
  | { type: 'POSITION'; player: PlayerId; iid: string }
  | { type: 'COUNTER'; player: PlayerId; iid: string; delta: number }
  | { type: 'TOKEN'; player: PlayerId; index: number; name: string }
  | { type: 'DRAW'; player: PlayerId; n: number }
  | { type: 'SHUFFLE'; player: PlayerId; seed: number }
  | { type: 'LP'; player: PlayerId; target: PlayerId; delta?: number; set?: number }
  | { type: 'PHASE'; player: PlayerId; phase: Phase }
  | { type: 'END_TURN'; player: PlayerId }
  | { type: 'DICE'; player: PlayerId; value: number }
  | { type: 'COIN'; player: PlayerId; heads: boolean }
  | { type: 'REVEAL'; player: PlayerId; iid: string }
  | {
      type: 'BATTLE';
      player: PlayerId;
      attacker: string;
      /** null = direct attack */
      target: string | null;
      /** when set, the game applies the outcome; otherwise only the declaration is logged */
      result?: { destroyAttacker: boolean; destroyTarget: boolean; damageTo: PlayerId | null; damage: number; flipTarget: boolean };
    }
  | { type: 'WAIT'; player: PlayerId }
  | { type: 'WAIT_CLEAR'; player: PlayerId }
  | { type: 'UNDO'; player: PlayerId; target: number }
  | { type: 'RENAME'; player: PlayerId; name: string };

/** An event once it is in the shared log. */
export type LoggedEvent = GameEvent & { seq: number; ts: number };
