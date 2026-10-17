// Boss Raid: two duelists on the same team, each on their own full Speed Duel board, against the
// same enemy. Every board is an ordinary 1v1 duel (the duelist is player 0, the enemy player 1),
// but the enemy's Life Points are one shared pool: damage on either board comes off it, and
// both boards always show what is left. A raid is two waves of the boss's henchmen and then the
// boss, who rages at half Life Points. Damage fills Team Power, which buys help for the
// teammate (a card from your hand, a heal) or a direct strike on the pool. Between fights each
// duelist picks a boon. One log carries everything, so both phones replay the same raid.
import { Engine } from './engine';
import { DB } from './db';
import { rng } from './rng';
import { CHAPTERS } from './speedCampaign/roster';
import { deckOf } from './speedCampaign/campaign';
import type { CpuDuelist, Reward } from './speedCampaign/types';
import type { Difficulty } from './difficulty';
import type { Action, Pid, SeatSetup } from './types';

// ---------- the raids ----------

export interface RaidStage {
  /** "Wave 1", "Boss" */
  label: string;
  /** the enemy on duelist 1's board and on duelist 2's board (Campaign duelist ids) */
  foes: [string, string];
  /** the enemy's shared Life Points */
  pool: number;
  boss?: boolean;
  /** how the enemy starts on every board (on top of the shared Life Points) */
  foeSetup?: SeatSetup;
  /** what the duelists read before the fight */
  note?: string;
}

export interface RaidDef {
  id: string;
  n: number;
  title: string;
  blurb: string;
  /** the boss (a Campaign duelist id) */
  boss: string;
  stages: RaidStage[];
  /** at half Life Points the boss rages: a monster appears on every board and a card joins the boss's hand */
  rage: { text: string; monster: string; card: string };
}

export const RAIDS: RaidDef[] = [
  {
    id: 'kingdom',
    n: 1,
    title: 'Duelist Kingdom',
    blurb: "Pegasus's island. His Toons are waiting.",
    boss: 'pegasus',
    stages: [
      { label: 'Wave 1', foes: ['weevil', 'rex'], pool: 4000, note: 'Weevil and Rex guard the docks.' },
      { label: 'Wave 2', foes: ['mako', 'paradox'], pool: 5000, note: 'Mako and Para & Dox block the castle.' },
      { label: 'Boss', foes: ['pegasus', 'pegasus'], pool: 8000, boss: true, foeSetup: { spells: ['Toon World'] }, note: 'Pegasus starts with Toon World on both boards.' },
    ],
    rage: { text: 'Pegasus rages! Toon Summoned Skull leaps onto both boards.', monster: 'Toon Summoned Skull', card: 'Toon Table of Contents' },
  },
  {
    id: 'battle-city',
    n: 2,
    title: 'Battle City',
    blurb: 'The Rare Hunters close in. Yami Marik waits on the blimp.',
    boss: 'yami-marik',
    stages: [
      { label: 'Wave 1', foes: ['espa', 'bonz'], pool: 4000, note: 'Espa Roba and Bonz work the streets.' },
      { label: 'Wave 2', foes: ['arkana', 'odion'], pool: 5000, note: 'Arkana and Odion hold the tower.' },
      { label: 'Boss', foes: ['yami-marik', 'yami-marik'], pool: 8500, boss: true, foeSetup: { openingHand: 1 }, note: 'Yami Marik starts with an extra card on both boards.' },
    ],
    rage: { text: 'Yami Marik rages! Masked Beast Des Gardius rises on both boards.', monster: 'Masked Beast Des Gardius', card: 'Mask of Brutality' },
  },
  {
    id: 'shadow-riders',
    n: 3,
    title: 'Shadow Riders',
    blurb: 'Duel Academy at night. Kagemaru wants the Sacred Beasts.',
    boss: 'kagemaru',
    stages: [
      { label: 'Wave 1', foes: ['titan', 'viper'], pool: 4500, note: 'Titan and Viper stalk the dorms.' },
      { label: 'Wave 2', foes: ['amnael', 'zane'], pool: 5500, note: 'Amnael and a darkened Zane bar the way.' },
      { label: 'Boss', foes: ['kagemaru', 'kagemaru'], pool: 9500, boss: true, note: 'Kagemaru feeds on both of you at once.' },
    ],
    rage: { text: 'Kagemaru rages! Uria, Lord of Searing Flames burns onto both boards.', monster: 'Uria, Lord of Searing Flames', card: 'Fallen Paradise' },
  },
  {
    id: 'thief-king',
    n: 4,
    title: 'Thief King',
    blurb: 'Ghouls in the Shadow Realm. Yami Bakura holds the Ring.',
    boss: 'yami-bakura',
    stages: [
      { label: 'Wave 1', foes: ['ghoul-cutpurse', 'ghoul-gravedigger'], pool: 4500, note: 'The ghouls come for your cards.' },
      { label: 'Wave 2', foes: ['ghoul-lantern', 'abidos'], pool: 5500, note: 'A lantern ghoul and a ghost pharaoh.' },
      { label: 'Boss', foes: ['yami-bakura', 'yami-bakura'], pool: 9000, boss: true, foeSetup: { field: 'Yami' }, note: 'Yami Bakura starts with Yami on both boards.' },
    ],
    rage: { text: 'Yami Bakura rages! Ryu Kokki crawls onto both boards.', monster: 'Ryu Kokki', card: "Dark Spirit's Mastery" },
  },
  {
    id: 'kings',
    n: 5,
    title: 'King of Games',
    blurb: 'The best there is, then the King himself.',
    boss: 'yami-yugi',
    stages: [
      { label: 'Wave 1', foes: ['mai', 'joey'], pool: 5000, note: 'Mai and Joey test you first.' },
      { label: 'Wave 2', foes: ['kaiba', 'masked-dealer'], pool: 6000, note: 'Kaiba and the Masked Dealer.' },
      { label: 'Boss', foes: ['yami-yugi', 'yami-yugi'], pool: 9500, boss: true, note: 'The King of Games, on both boards.' },
    ],
    rage: { text: 'The King rages! Dark Magician appears on both boards.', monster: 'Dark Magician', card: 'Dark Magic Attack' },
  },
];

export const raidById = (id: string) => RAIDS.find((r) => r.id === id);

export function duelistById(id: string): CpuDuelist | undefined {
  for (const c of CHAPTERS) for (const n of c.nodes) if (n.duelist.id === id) return n.duelist;
  return undefined;
}

/** What a first clear pays each duelist: one pack and one Duel Chip. Replays pay nothing. */
export const CLEAR_REWARDS: Reward[] = [{ kind: 'pack' }, { kind: 'chips', n: 1 }];

/** Every card in a raid's decks: the fallback pool its pack draws from. */
export function raidPool(def: RaidDef): string[] {
  const out = new Set<string>();
  for (const s of def.stages) for (const id of s.foes) for (const c of deckOf(duelistById(id)!).main) out.add(c);
  return [...out];
}

// ---------- Team Power, assists and boons ----------

/** Team Power is one pool the two duelists share: either one fills it, either one spends it */
export const POWER_MAX = 4;
/** damage dealt to the enemy that fills one Team Power */
export const POWER_STEP = 1000;
export const HEAL = 1000;
/** Heal only tops a teammate up to this */
export const HEAL_BELOW = 4000;
export const STRIKE = 500;
export const REVIVE_LP = 2000;
/** A hit landing soon after your teammate's (within this many board moves) is a combo: 30% extra. */
export const COMBO_WINDOW = 40;
export const COMBO_PCT = 0.3;

export type AssistKind = 'gift' | 'heal' | 'strike' | 'revive';
export const ASSISTS: Record<AssistKind, { title: string; text: string; cost: number }> = {
  gift: { title: 'Pass a card', text: "A card from your hand goes to your teammate's hand.", cost: 1 },
  heal: { title: 'Heal', text: `Your teammate gains ${HEAL} LP (while under ${HEAL_BELOW}).`, cost: 1 },
  strike: { title: 'Strike', text: `Hit the enemy for ${STRIKE}, even after you fall.`, cost: 1 },
  revive: { title: 'Revive', text: `Your fallen teammate gets back up with ${REVIVE_LP} LP and fights on.`, cost: 2 },
};

/** Quick calls to your teammate's phone. */
export type PingId = 'help' | 'now' | 'nice' | 'wait';
export const PINGS: Record<PingId, string> = { help: 'Help me!', now: 'Hit it now!', nice: 'Nice one!', wait: 'Hold on…' };

export type BoonId = 'lp' | 'draw' | 'first' | 'power' | 'ambush' | 'twin';
export const BOONS: Record<BoonId, { title: string; text: string }> = {
  lp: { title: 'Iron Will', text: 'Start the next fight with 5000 LP.' },
  draw: { title: 'Quick Draw', text: 'One more card in your next opening hand.' },
  first: { title: 'Initiative', text: 'You go first in the next fight.' },
  power: { title: 'Team Spirit', text: '+1 Team Power right now.' },
  ambush: { title: 'Ambush', text: 'Your enemy starts the next fight with one card fewer.' },
  twin: { title: 'Opening Blow', text: 'The next enemy starts with 1000 less shared LP.' },
};
const BOON_IDS = Object.keys(BOONS) as BoonId[];

// ---------- the log ----------

export interface RaidHero {
  name: string;
  main: string[];
  extra: string[];
  skill: string | null;
  /** the phone that plays this duelist, or the computer (run by phone 0) */
  ctl: Pid | 'cpu';
}

export interface RaidPlan {
  raid: string;
  seed: number;
  level: Difficulty;
  heroes: [RaidHero, RaidHero];
}

export type RaidMsg =
  | { type: 'RAID_START'; plan: RaidPlan }
  /** an engine action on duelist `b`'s board */
  | { type: 'RAID_MOVE'; b: Pid; a: Action; at?: number }
  /** after a lost raid: fight the same stage again */
  | { type: 'RAID_RETRY' }
  | { type: 'RAID_ASSIST'; hero: Pid; kind: AssistKind; uid?: number }
  | { type: 'RAID_BOON'; hero: Pid; boon: BoonId }
  | { type: 'RAID_LEAVE'; hero: Pid }
  | { type: 'RAID_PING'; hero: Pid; ping: PingId }
  /** a duelist's phone dropped (the computer plays their board) or came back */
  | { type: 'RAID_AWAY'; hero: Pid; away: boolean };

export const isRaidMsg = (a: { type: string }): a is RaidMsg => a.type.startsWith('RAID_');

// ---------- the raid ----------

export interface RaidBoard {
  b: Pid;
  engine: Engine;
  foe: CpuDuelist;
  /** the enemy's Life Points on this board when the pool was last settled */
  lastFoeLp: number;
  /** the damage the enemy had taken (not paid as a cost) when the pool was last settled */
  lastHurt: number;
  /** moves applied to this board (a move names the count it was made at; stale ones are dropped) */
  moves: number;
  /** things waiting to appear on the enemy's side when the board is between moves */
  pending: { name: string; to: 'mz' | 'hand' }[];
}

export type FeedKind = 'stage' | 'hit' | 'power' | 'gift' | 'heal' | 'strike' | 'rage' | 'fall' | 'clear' | 'boon' | 'revive' | 'ping' | 'combo';
export interface FeedItem {
  n: number;
  kind: FeedKind;
  /** the duelist it is about */
  hero: Pid | null;
  text: string;
  amount?: number;
}

export type RaidPhase = 'duel' | 'boons' | 'won' | 'lost';

/** Seeds for each board's duel, both phones alike. */
const mix = (seed: number, stage: number, b: number) => ((seed ^ Math.imul(stage + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca6b)) >>> 0);

export class Raid {
  plan: RaidPlan | null = null;
  def: RaidDef | null = null;
  stage = 0;
  boards: [RaidBoard | null, RaidBoard | null] = [null, null];
  pool = 0;
  poolMax = 0;
  /** the team's shared Team Power */
  power = 0;
  /** damage toward the next Team Power */
  charge: [number, number] = [0, 0];
  /** damage dealt to enemies over the whole raid */
  total: [number, number] = [0, 0];
  /** biggest single hit each duelist landed */
  best: [number, number] = [0, 0];
  /** assists each duelist used */
  used: [number, number] = [0, 0];
  /** times the team tried a lost fight again */
  retries = 0;
  /** tag-team combos landed */
  combos = 0;
  /** board moves so far, and the move each duelist last hit on (combos) */
  private moves = 0;
  private lastHit: [number, number] = [-1e9, -1e9];
  phase: RaidPhase = 'duel';
  rage = false;
  offers: [BoonId[], BoonId[]] = [[], []];
  picks: [BoonId | null, BoonId | null] = [null, null];
  /** boons picked for the next fight */
  carry: [BoonId | null, BoonId | null] = [null, null];
  /** duelists who left the raid */
  left: [boolean, boolean] = [false, false];
  /** duelists who fell in this fight */
  fallen: [boolean, boolean] = [false, false];
  /** duelists whose phone dropped: the other phone's computer plays for them until they're back */
  away: [boolean, boolean] = [false, false];
  feed: FeedItem[] = [];
  /** bumps on every change (the screens redraw on it) */
  version = 0;
  private n = 0;

  constructor(private readonly db = DB) {}

  get last(): boolean {
    return !!this.def && this.stage === this.def.stages.length - 1;
  }

  stageDef(): RaidStage | null {
    return this.def?.stages[this.stage] ?? null;
  }

  /** The phone that sends moves for board `b` (both seats): its duelist's phone, or phone 0 for a computer teammate. */
  driver(b: Pid): Pid {
    const c = this.plan?.heroes[b].ctl;
    if (c === 'cpu' || c === undefined) return 0;
    return this.away[b] ? ((c === 0 ? 1 : 0) as Pid) : c;
  }

  /** How sharp the enemy plays: the chosen level for the boss, a step easier for the henchmen. */
  foeLevel(): Difficulty {
    const lv = this.plan?.level ?? 'normal';
    if (this.stageDef()?.boss) return lv;
    return lv === 'hard' ? 'normal' : 'easy';
  }

  heroIsCpu(b: Pid): boolean {
    return this.plan?.heroes[b].ctl === 'cpu' || this.away[b];
  }

  /** The duelist a phone plays (null: none, it only watches). */
  heroOf(phone: Pid): Pid | null {
    const h = this.plan?.heroes;
    if (!h) return null;
    return h[0].ctl === phone ? 0 : h[1].ctl === phone ? 1 : null;
  }

  running(b: Pid): boolean {
    const x = this.boards[b];
    return !!x && x.engine.state.winner === null;
  }

  /** A board between moves: nothing asked, nothing resolving. */
  idle(b: Pid): boolean {
    const x = this.boards[b];
    return !!x && x.engine.state.winner === null && !x.engine.state.prompt && x.engine.state.chain.length === 0;
  }

  /** Whether a duelist may use an assist right now (and with which card, for a gift). */
  canAssist(hero: Pid, kind: AssistKind, uid?: number): boolean {
    if (this.phase !== 'duel' || this.power < ASSISTS[kind].cost || this.left[hero] || this.pool <= 0) return false;
    const mate = (hero === 0 ? 1 : 0) as Pid;
    if (kind === 'strike') return true;
    if (kind === 'revive') {
      const w = this.boards[mate]?.engine.state.winner;
      const deck = this.boards[mate]?.engine.state.players[0].deck.length ?? 0;
      return !this.left[mate] && this.fallen[mate] && w !== null && w !== 0 && deck > 0;
    }
    if (!this.running(mate)) return false;
    if (kind === 'heal') return this.boards[mate]!.engine.state.players[0].lp < HEAL_BELOW;
    if (!this.idle(hero)) return false;
    const hand = this.boards[hero]!.engine.state.players[0].hand;
    return uid === undefined ? hand.length > 0 : hand.some((c) => c.uid === uid);
  }

  /** What a computer teammate spends Team Power on right now, if anything. */
  cpuAssist(hero: Pid): { kind: AssistKind; uid?: number } | null {
    const mate = (hero === 0 ? 1 : 0) as Pid;
    if (this.canAssist(hero, 'revive')) return { kind: 'revive' };
    const ms = this.boards[mate]?.engine.state;
    const lp = ms?.players[0].lp ?? 99999;
    if (lp <= 2000 && this.canAssist(hero, 'heal')) return { kind: 'heal' };
    // A teammate with an empty hand gets a card (keeping 1 Power back), best monster first.
    if (ms && ms.players[0].hand.length === 0 && this.power >= 2 && this.canAssist(hero, 'gift')) {
      const hand = this.boards[hero]!.engine.state.players[0].hand;
      if (hand.length >= 2) {
        const pick = [...hand].sort((a, b) => (this.db.get(b.name)?.atk ?? -1) - (this.db.get(a.name)?.atk ?? -1))[0];
        return { kind: 'gift', uid: pick.uid };
      }
    }
    if (this.power >= POWER_MAX && this.canAssist(hero, 'strike')) return { kind: 'strike' };
    if (this.pool > 0 && this.pool <= STRIKE && this.canAssist(hero, 'strike')) return { kind: 'strike' };
    return null;
  }

  /** Why an assist can't be used right now (null: it can). */
  assistBlock(hero: Pid, kind: AssistKind): string | null {
    if (this.canAssist(hero, kind)) return null;
    const mate = (hero === 0 ? 1 : 0) as Pid;
    if (this.phase !== 'duel' || this.pool <= 0) return 'Not between fights.';
    if (this.power < ASSISTS[kind].cost) return `Needs ${ASSISTS[kind].cost} Team Power.`;
    if (kind === 'revive') return this.left[mate] ? `${this.name(mate)} left the raid.` : !this.fallen[mate] ? `Only when ${this.name(mate)} has fallen.` : `${this.name(mate)} has no cards left to draw.`;
    if (kind === 'gift' && !this.running(hero)) return "You're out of this fight.";
    if (!this.running(mate)) return `${this.name(mate)} isn't dueling.`;
    if (kind === 'heal') return `${this.name(mate)} has ${HEAL_BELOW} LP or more.`;
    if (kind === 'gift') return this.running(hero) && this.idle(hero) ? 'No cards in your hand.' : 'Only between your moves.';
    return null;
  }

  apply(m: RaidMsg) {
    switch (m.type) {
      case 'RAID_START':
        if (this.plan) return;
        this.def = raidById(m.plan.raid) ?? null;
        if (!this.def) return;
        this.plan = m.plan;
        this.startStage(0);
        break;
      case 'RAID_MOVE': {
        const x = this.boards[m.b];
        if (!x || this.phase !== 'duel') return;
        // A move made against an older state of the board (queued while offline, a double tap) is dropped.
        if (m.at !== undefined && m.at !== x.moves) return;
        x.moves++;
        this.moves++;
        try {
          if (x.engine.state.winner === null) x.engine.apply(m.a);
        } catch (err) {
          console.error('raid engine error', err, m.a);
        }
        this.settle(m.b);
        break;
      }
      case 'RAID_ASSIST':
        this.assist(m.hero, m.kind, m.uid);
        break;
      case 'RAID_BOON':
        if (this.phase !== 'boons' || this.picks[m.hero] !== null || !this.offers[m.hero].includes(m.boon)) return;
        this.picks[m.hero] = m.boon;
        if (m.boon === 'power') this.power = Math.min(POWER_MAX, this.power + 1);
        this.push('boon', m.hero, `${this.name(m.hero)} took ${BOONS[m.boon].title}`);
        this.maybeNext();
        break;
      case 'RAID_PING':
        if (!this.plan || this.left[m.hero] || !PINGS[m.ping]) return;
        this.push('ping', m.hero, `${this.name(m.hero)}: ${PINGS[m.ping]}`);
        break;
      case 'RAID_RETRY':
        if (this.phase !== 'lost' || !this.plan || this.left.every(Boolean)) return;
        this.retries++;
        this.rage = false;
        this.startStage(this.stage);
        break;
      case 'RAID_AWAY':
        if (!this.plan || this.left[m.hero] || this.away[m.hero] === m.away || this.plan.heroes[m.hero].ctl === 'cpu') return;
        this.away[m.hero] = m.away;
        this.push('ping', m.hero, m.away ? `${this.name(m.hero)} lost connection: the computer plays for them` : `${this.name(m.hero)} is back`);
        break;
      case 'RAID_LEAVE':
        if (this.left[m.hero] || !this.plan) return;
        this.left[m.hero] = true;
        this.push('fall', m.hero, `${this.name(m.hero)} left the raid`);
        if (this.running(m.hero)) {
          this.boards[m.hero]!.engine.apply({ type: 'SURRENDER', player: 0 });
          this.settle(m.hero);
        }
        if (this.phase === 'boons') this.maybeNext();
        break;
    }
    this.version++;
  }

  name(h: Pid): string {
    return this.plan?.heroes[h].name ?? '';
  }

  private push(kind: FeedKind, hero: Pid | null, text: string, amount?: number) {
    this.feed.push({ n: ++this.n, kind, hero, text, amount });
    if (this.feed.length > 40) this.feed.splice(0, this.feed.length - 40);
  }

  private startStage(i: number) {
    const plan = this.plan!;
    const st = this.def!.stages[i];
    this.stage = i;
    this.phase = 'duel';
    this.rage = false;
    this.fallen = [false, false];
    this.picks = [null, null];
    const twin = this.carry.filter((c) => c === 'twin').length;
    this.poolMax = st.pool;
    this.pool = Math.max(1000, st.pool - twin * 1000);
    for (const b of [0, 1] as Pid[]) {
      if (this.left[b]) {
        this.boards[b] = null;
        continue;
      }
      const hero = plan.heroes[b];
      const foe = duelistById(st.foes[b])!;
      const fd = deckOf(foe);
      const boon = this.carry[b];
      const seed = mix(plan.seed + this.retries * 7919, i, b);
      const heroSetup: SeatSetup = boon === 'lp' ? { lp: 5000 } : boon === 'draw' ? { openingHand: 1 } : {};
      const foeSetup: SeatSetup = { ...st.foeSetup, lp: this.pool };
      if (boon === 'ambush') foeSetup.openingHand = (foeSetup.openingHand ?? 0) - 1;
      const first: Pid = boon === 'first' ? 0 : rng(seed ^ 0x51ed)() < 0.5 ? 0 : 1;
      const engine = new Engine(this.db);
      engine.apply({ type: 'START', first, seed, mode: 'speed', names: [hero.name, foe.name], decks: [hero.main, fd.main], fusions: [hero.extra, fd.extra], skills: [hero.skill, foe.skill], setup: [heroSetup, foeSetup] });
      this.boards[b] = { b, engine, foe, lastFoeLp: engine.state.players[1].lp, lastHurt: 0, moves: 0, pending: [] };
    }
    this.carry = [null, null];
    this.push('stage', null, st.boss ? `${duelistById(this.def!.boss)!.name} appears!` : `${st.label}: ${st.note ?? ''}`.trim());
    // a Skill at the start of the duel can move Life Points: both boards settle on one pool
    for (const b of [0, 1] as Pid[]) if (this.boards[b]) this.settle(b);
  }

  /** After something happened on board `b`: the pool takes the enemy's Life Point change, every board shows the pool. */
  private settle(b: Pid) {
    const x = this.boards[b];
    if (!x) return;
    // No Shadow Realm in a raid: an overkill finish seals nothing, so its cinematic stays off.
    if (x.engine.state.winner !== null) delete x.engine.state.fx.finalBlow;
    const foeLp = x.engine.state.players[1].lp;
    const delta = x.lastFoeLp - foeLp;
    x.lastFoeLp = foeLp;
    // Damage the enemy took fills Team Power; Life Points it paid as a cost only come off the pool.
    const hurt = ((x.engine.state.fx.hurtTotal as number[] | undefined)?.[1] ?? 0) - x.lastHurt;
    x.lastHurt += hurt;
    if (delta !== 0 && this.phase === 'duel') {
      this.pool = Math.max(0, this.pool - delta);
      const dealt = Math.min(Math.max(0, hurt), Math.max(0, delta));
      if (dealt > 0) {
        this.credit(b, dealt);
        this.push('hit', b, `${this.name(b)} hit ${x.foe.name} for ${dealt}`, dealt);
        this.combo(b, dealt);
      }
    }
    this.syncPool();
    this.check();
  }

  /** Your teammate hit just now: a hit from you lands a combo. */
  comboReady(hero: Pid): boolean {
    const mate = (hero === 0 ? 1 : 0) as Pid;
    return this.phase === 'duel' && this.running(hero) && this.moves - this.lastHit[mate] <= COMBO_WINDOW;
  }

  /** Hits from both brothers close together: the second one lands 30% harder. */
  private combo(b: Pid, dealt: number) {
    const mate = (b === 0 ? 1 : 0) as Pid;
    const near = this.moves - this.lastHit[mate] <= COMBO_WINDOW;
    this.lastHit[b] = this.moves;
    if (!near || this.pool <= 0) return;
    this.lastHit[mate] = -1e9; // one combo per pair of hits
    const extra = Math.min(this.pool, Math.max(100, Math.round((dealt * COMBO_PCT) / 50) * 50));
    this.pool -= extra;
    this.total[b] += extra;
    this.combos++;
    this.push('combo', b, `Tag-team combo from ${this.name(b)}!`, extra);
  }

  /** Every running board's enemy has the pool's Life Points. */
  private syncPool() {
    for (const o of [0, 1] as Pid[]) {
      const y = this.boards[o];
      if (!y || y.engine.state.winner !== null) continue;
      y.engine.state.players[1].lp = this.pool;
      y.lastFoeLp = this.pool;
    }
  }

  private credit(b: Pid, dmg: number) {
    this.total[b] += dmg;
    this.best[b] = Math.max(this.best[b], dmg);
    this.charge[b] += dmg;
    while (this.charge[b] >= POWER_STEP) {
      this.charge[b] -= POWER_STEP;
      if (this.power < POWER_MAX) {
        this.power++;
        this.push('power', b, `+1 Team Power from ${this.name(b)}`);
      }
    }
  }

  private assist(hero: Pid, kind: AssistKind, uid?: number) {
    if (!this.canAssist(hero, kind, uid)) return;
    const mate = (hero === 0 ? 1 : 0) as Pid;
    this.power -= ASSISTS[kind].cost;
    this.used[hero]++;
    if (kind === 'revive') {
      const y = this.boards[mate]!;
      const st = y.engine.state;
      st.winner = null;
      st.winReason = '';
      st.prompt = null;
      st.battle = null;
      st.chain = [];
      delete st.fx.finalBlow;
      st.players[0].lp = REVIVE_LP;
      this.fallen[mate] = false;
      y.engine.event('heal', { player: 0, amount: REVIVE_LP });
      this.push('revive', hero, `${this.name(hero)} revived ${this.name(mate)}!`);
      this.syncPool();
      return;
    }
    if (kind === 'strike') {
      const st = this.boards[hero] ?? this.boards[mate];
      this.pool = Math.max(0, this.pool - STRIKE);
      this.push('strike', hero, `${this.name(hero)} strikes ${st?.foe.name ?? 'the enemy'} for ${STRIKE}!`, STRIKE);
      this.syncPool();
      this.check();
      return;
    }
    const to = this.boards[mate]!;
    if (kind === 'heal') {
      to.engine.gainLp(0, HEAL);
      this.push('heal', hero, `${this.name(hero)} healed ${this.name(mate)} for ${HEAL}`, HEAL);
      return;
    }
    const hand = this.boards[hero]!.engine.state.players[0].hand;
    const i = hand.findIndex((c) => c.uid === uid);
    const [c] = hand.splice(i, 1);
    to.engine.conjure(0, c.name, 'hand');
    this.push('gift', hero, `${this.name(hero)} passed ${c.name} to ${this.name(mate)}`);
  }

  /** Rage, a beaten enemy, a fallen duelist, the end of a fight. */
  private check() {
    if (this.phase !== 'duel') return;
    const st = this.stageDef()!;
    if (st.boss && !this.rage && this.pool > 0 && this.pool <= this.poolMax / 2) {
      this.rage = true;
      for (const b of [0, 1] as Pid[]) this.boards[b]?.pending.push({ name: this.def!.rage.monster, to: 'mz' }, { name: this.def!.rage.card, to: 'hand' });
      this.push('rage', null, this.def!.rage.text);
    }
    for (const b of [0, 1] as Pid[]) this.flush(b);
    if (this.pool <= 0) {
      for (const b of [0, 1] as Pid[]) {
        const x = this.boards[b];
        if (x && x.engine.state.winner === null) x.engine.endDuel(0, `${x.foe.name}'s Life Points hit 0`);
      }
      return this.cleared();
    }
    // An enemy beaten some other way (out of cards, Exodia) breaks the whole gang.
    if (this.boards.some((x) => x?.engine.state.winner === 0)) {
      for (const b of [0, 1] as Pid[]) {
        const x = this.boards[b];
        if (x && x.engine.state.winner === null) x.engine.endDuel(0, `${x.foe.name}'s side is beaten`);
      }
      return this.cleared();
    }
    for (const b of [0, 1] as Pid[]) {
      const x = this.boards[b];
      if (!x || this.fallen[b]) continue;
      const w = x.engine.state.winner;
      if (w === null || w === 0) continue;
      this.fallen[b] = true;
      this.push('fall', b, `${this.name(b)} fell!`);
      const mate = (b === 0 ? 1 : 0) as Pid;
      if (this.running(mate) && this.power < POWER_MAX) {
        this.power++;
        this.push('power', mate, `+1 Team Power: avenge ${this.name(b)}!`);
      }
    }
    const boards = this.boards.filter((x): x is RaidBoard => !!x);
    if (boards.length && boards.every((x) => x.engine.state.winner !== null)) {
      if (boards.some((x) => x.engine.state.winner === 0)) return this.cleared();
      this.phase = 'lost';
      this.push('fall', null, 'The raid is over.');
    }
  }

  private flush(b: Pid) {
    const x = this.boards[b];
    if (!x || !x.pending.length || !this.idle(b)) return;
    for (const p of x.pending) x.engine.conjure(1, p.name, p.to);
    x.pending = [];
  }

  private cleared() {
    const st = this.stageDef()!;
    this.push('clear', null, st.boss ? `${duelistById(this.def!.boss)!.name} is beaten!` : `${st.label} cleared!`);
    if (this.last) {
      this.phase = 'won';
      return;
    }
    this.phase = 'boons';
    for (const h of [0, 1] as Pid[]) {
      const next = rng(mix(this.plan!.seed, this.stage + 40, h));
      const pool = BOON_IDS.slice();
      const out: BoonId[] = [];
      while (out.length < 3) out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]);
      this.offers[h] = out;
    }
    this.maybeNext();
  }

  private maybeNext() {
    if (this.phase !== 'boons') return;
    if (([0, 1] as Pid[]).some((h) => !this.left[h] && this.picks[h] === null)) return;
    if (this.left[0] && this.left[1]) {
      this.phase = 'lost';
      return;
    }
    this.carry = [this.picks[0], this.picks[1]];
    this.startStage(this.stage + 1);
  }
}

// ---------- progress (per profile, on this phone) ----------

export interface RaidProgress {
  /** raids this profile has beaten (the first clear pays) */
  cleared: string[];
  /** raids won, all told */
  wins: number;
  /** the most damage this profile dealt in one raid */
  best: number;
}

const KEY = (profileId: string) => `eds.speedraid.${profileId}`;

export function loadRaidProgress(profileId: string): RaidProgress {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY(profileId)) : null;
    const p = raw ? (JSON.parse(raw) as Partial<RaidProgress>) : {};
    return { cleared: Array.isArray(p.cleared) ? p.cleared : [], wins: p.wins ?? 0, best: p.best ?? 0 };
  } catch {
    return { cleared: [], wins: 0, best: 0 };
  }
}

export function writeRaidProgress(profileId: string, p: RaidProgress) {
  try {
    localStorage.setItem(KEY(profileId), JSON.stringify(p));
  } catch {
    /* storage full or blocked: progress just isn't kept */
  }
}

/** A raid is open once the one before it is beaten (the first is always open). */
export const raidOpen = (p: RaidProgress, def: RaidDef) => def.n === 1 || p.cleared.includes(RAIDS[def.n - 2].id);

/** A finished raid on this phone: progress, and whether it pays (first clear, a deck that can earn). */
export function settleRaid(p: RaidProgress, raidId: string, won: boolean, dealt: number): { progress: RaidProgress; firstClear: boolean } {
  const firstClear = won && !p.cleared.includes(raidId);
  return {
    progress: { cleared: firstClear ? [...p.cleared, raidId] : p.cleared, wins: p.wins + (won ? 1 : 0), best: Math.max(p.best, dealt) },
    firstClear,
  };
}
