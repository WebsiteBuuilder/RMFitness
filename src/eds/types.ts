// Eternal Duelist Soul remake: core types for the enforced duel engine.
// The engine is deterministic: both players replay the same action log with
// the same seed and arrive at the same state.

export type Pid = 0 | 1;
export type Pos = 'atk' | 'def';
export type Phase = 'DP' | 'SP' | 'M1' | 'BP' | 'M2' | 'EP';
export const PHASES: Phase[] = ['DP', 'SP', 'M1', 'BP', 'M2', 'EP'];
export const PHASE_NAME: Record<Phase, string> = { DP: 'Draw Phase', SP: 'Standby Phase', M1: 'Main Phase 1', BP: 'Battle Phase', M2: 'Main Phase 2', EP: 'End Phase' };

export type ZoneName = 'deck' | 'hand' | 'mz' | 'sz' | 'field' | 'gy' | 'removed' | 'fusion';
export interface Loc {
  player: Pid;
  zone: ZoneName;
  index: number;
}

/** Static card information from the database (one entry per card name). */
export interface CardInfo {
  id: number; // YGOPRODeck passcode used for the image file
  name: string;
  /** 'monster' | 'spell' | 'trap' */
  kind: 'monster' | 'spell' | 'trap';
  /** monster: Normal | Effect | Fusion | Ritual ; spell: Normal | Quick-Play | Continuous | Equip | Field | Ritual ; trap: Normal | Continuous | Counter */
  sub: string;
  atk?: number;
  def?: number;
  level?: number;
  attribute?: string;
  race?: string;
  desc: string;
  /** EDS card number (001-819) and password when known */
  n?: number;
  password?: string | null;
  /** the name the card had in EDS when it differs from today's */
  alias?: string;
  /** part of the Speed Duel card pool */
  speed?: boolean;
  /** Skill Cards: the character the Skill belongs to */
  character?: string;
  /** a monster with no effect (needs no script) */
  vanilla?: boolean;
}

export interface Card {
  uid: number;
  name: string;
  owner: Pid;
  /** a Token: it vanishes instead of going anywhere when it leaves the field */
  token?: boolean;
}

export interface FieldCard extends Card {
  faceUp: boolean;
  pos: Pos;
  /** turn number this card was placed on the field (summoned or set) */
  placedTurn: number;
  attacked: boolean;
  posChanged: boolean;
  atkMod: number;
  defMod: number;
  /** uids of equip cards attached to this monster */
  equips: number[];
  /** for an equip card: the uid of the monster it is attached to */
  equippedTo?: number;
  /** a continuous spell/trap or equip that is "active" after resolving */
  active?: boolean;
  counters: number;
  /** small per-card numbers card scripts keep (turn marks, chosen stats...) */
  tags?: Record<string, number>;
  /** destroyed during the End Phase of this turn number (Zone Eater, Steel Scorpion...) */
  doomAt?: number;
  /** cards stolen by Change of Heart go back at the End Phase */
  returnAtEnd?: Pid;
  /** Swords of Revealing Light: turns remaining */
  turns?: number;
  /** ignition effect already used this turn */
  effectUsed?: boolean;
  /** temporary flags set by effects (e.g. Spellbinding Circle) */
  cannotAttack?: boolean;
  cannotChangePos?: boolean;
}

export interface PlayerState {
  name: string;
  lp: number;
  deck: Card[];
  hand: Card[];
  mz: (FieldCard | null)[];
  sz: (FieldCard | null)[];
  field: FieldCard | null;
  gy: Card[];
  removed: Card[];
  fusion: Card[];
  normalSummoned: boolean;
  /** cannot attack while the opponent's Swords of Revealing Light is active, etc. */
  ready: boolean;
  /** Speed Duel: the Skill this player brought, face-down until first used */
  skill?: string | null;
  skillRevealed?: boolean;
  /** times the Skill was used this duel */
  skillUses?: number;
  /** turn number the Skill was last used */
  skillTurn?: number;
}

/** A question the engine is asking one player. */
export type Prompt =
  | {
      kind: 'select';
      player: Pid;
      title: string;
      options: SelectOption[];
      min: number;
      max: number;
      cancel?: boolean;
    }
  | {
      kind: 'response';
      player: Pid;
      title: string;
      /** cards this player may activate right now */
      options: SelectOption[];
    }
  | { kind: 'yesno'; player: Pid; title: string };

export interface SelectOption {
  label: string;
  loc?: Loc;
  uid?: number;
  value?: string | number;
}

export interface ChainLink {
  card: Card;
  loc: Loc;
  player: Pid;
  label: string;
  /** negated by a Counter Trap */
  negated: boolean;
  /** a target chosen when the card was activated */
  target?: Loc;
  targetUid?: number;
  payload?: unknown;
}

export interface LogLine {
  turn: number;
  player: Pid | null;
  text: string;
}

export interface DuelState {
  seed: number;
  rngState: number;
  players: [PlayerState, PlayerState];
  started: boolean;
  turn: number;
  turnPlayer: Pid;
  phase: Phase;
  /** who the engine is waiting on */
  prompt: Prompt | null;
  chain: ChainLink[];
  /** a battle in progress */
  battle: { attacker: number; target: number | null } | null;
  winner: Pid | 'draw' | null;
  winReason: string;
  log: LogLine[];
  /** cards drawn/moved recently for the UI to animate */
  lastEvent: { kind: string; uid?: number; player?: Pid; amount?: number; seq: number } | null;
  /** attacks declared this turn (uids) */
  attackedThisTurn: number[];
  firstTurn: boolean;
  skipDraw: boolean;
  uidCounter: number;
  /** lasting duel-wide effects card scripts set (declared names/types, skipped phases...) */
  fx: Record<string, any>;
  /** the rule set (missing in duels recorded before Speed Duel existed: EDS) */
  rules?: Rules;
}

/**
 * How one side starts a duel when it doesn't start the usual way (campaign Duel Conditions,
 * roguelite relics). Every card named here is a new card, on top of the deck.
 */
export interface SeatSetup {
  /** starting Life Points instead of the rules' */
  lp?: number;
  /** cards already face-up in Attack Position */
  monsters?: string[];
  /** a Field Spell already face-up in the Field Zone */
  field?: string;
  /** Continuous Spells/Traps already face-up and active */
  spells?: string[];
  /** cards added to the opening hand */
  hand?: string[];
  /** draw this many more (or fewer, when negative) for the opening hand */
  openingHand?: number;
}

/** What a player may ask the engine to do. */
export type Action =
  | { type: 'START'; first: Pid; seed: number; names: [string, string]; decks: [string[], string[]]; fusions: [string[], string[]]; mode?: GameMode; skills?: [string | null, string | null]; setup?: [SeatSetup | null, SeatSetup | null] }
  | { type: 'SUMMON'; player: Pid; uid: number; zone: number; pos: Pos; faceUp: boolean }
  | { type: 'SET_ST'; player: Pid; uid: number; zone: number }
  | { type: 'ACTIVATE'; player: Pid; uid: number; zone?: number }
  | { type: 'FLIP_SUMMON'; player: Pid; uid: number }
  | { type: 'CHANGE_POS'; player: Pid; uid: number }
  | { type: 'ATTACK'; player: Pid; uid: number; target: number | null }
  | { type: 'MONSTER_EFFECT'; player: Pid; uid: number }
  | { type: 'SPECIAL'; player: Pid; uid: number }
  | { type: 'NEXT_PHASE'; player: Pid }
  | { type: 'END_TURN'; player: Pid }
  | { type: 'CHOOSE'; player: Pid; picks: number[] }
  | { type: 'CANCEL'; player: Pid }
  | { type: 'PASS'; player: Pid }
  | { type: 'YES'; player: Pid }
  | { type: 'NO'; player: Pid }
  | { type: 'SKILL'; player: Pid }
  | { type: 'GRAVE_EFFECT'; player: Pid; uid: number }
  | { type: 'SURRENDER'; player: Pid };

export type LoggedAction = Action & { seq: number; ts: number };

/** Which rule set a duel uses: the 2002 Eternal Duelist Soul rules or Speed Duel. */
export type GameMode = 'eds' | 'speed';
export interface Rules {
  mode: GameMode;
  lp: number;
  openingHand: number;
  handLimit: number;
  monsterZones: number;
  stZones: number;
  /** Speed Duel has no Main Phase 2 */
  mainPhase2: boolean;
  /** EDS: the first player draws on turn 1; Speed Duel: they do not */
  firstPlayerDraws: boolean;
}

export const STARTING_LP = 8000;
export const HAND_LIMIT = 6;
export const MONSTER_ZONES = 5;
export const ST_ZONES = 5;

export const EDS_RULES: Rules = { mode: 'eds', lp: STARTING_LP, openingHand: 5, handLimit: HAND_LIMIT, monsterZones: MONSTER_ZONES, stZones: ST_ZONES, mainPhase2: true, firstPlayerDraws: true };
export const SPEED_RULES: Rules = { mode: 'speed', lp: 4000, openingHand: 4, handLimit: 6, monsterZones: 3, stZones: 3, mainPhase2: false, firstPlayerDraws: false };
export const rulesFor = (mode: GameMode | undefined): Rules => (mode === 'speed' ? SPEED_RULES : EDS_RULES);
