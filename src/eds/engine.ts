// The duel engine: enforces the 2002 rules the way The Eternal Duelist Soul did.
// Everything that needs a decision from a player is written as a generator that
// yields a Prompt; the engine parks the generator until the answer arrives.

import type { Action, Card, CardInfo, ChainLink, DuelState, EngineEvent, FieldCard, Loc, Phase, Pid, PlayerState, Pos, Prompt, Rules, SeatSetup, SelectOption } from './types';
import { EDS_RULES, MONSTER_ZONES, PHASES, PHASE_NAME, STARTING_LP, ST_ZONES, rulesFor } from './types';
import { extraProcFor, getEffect, setNameResolver, type EffectDef, type GraveEvent, type SummonHow, type Trigger } from './effects';
import { getSkill } from './skills';
import { noteLevelEvent } from '../level/leveling';

export type Choice = { picks: number[] } | 'cancel' | 'pass' | true | false;
export type Step = Generator<Prompt, void, Choice>;

export class RulesError extends Error {}

/** Speed Duel: "you cannot Normal (and/or) Special Summon monsters this turn, except ..." (kept in state.fx.summonLocks). */
export interface SummonLock {
  p: Pid;
  turn: number;
  normal: boolean;
  special: boolean;
  /** only monsters whose name contains one of these can be Summoned */
  only?: string[];
  /** monsters of these Levels cannot be Summoned */
  levels?: number[];
  /** this card is exempt */
  except?: number;
}

function makePlayer(name: string): PlayerState {
  return {
    name,
    lp: STARTING_LP,
    deck: [],
    hand: [],
    mz: Array(MONSTER_ZONES).fill(null),
    sz: Array(ST_ZONES).fill(null),
    field: null,
    gy: [],
    removed: [],
    fusion: [],
    normalSummoned: false,
    ready: false,
  };
}

export function emptyState(): DuelState {
  return {
    seed: 0,
    rngState: 0,
    players: [makePlayer('Player 1'), makePlayer('Player 2')],
    started: false,
    turn: 0,
    turnPlayer: 0,
    phase: 'DP',
    prompt: null,
    chain: [],
    battle: null,
    winner: null,
    winReason: '',
    log: [],
    lastEvent: null,
    events: [],
    attackedThisTurn: [],
    firstTurn: true,
    skipDraw: false,
    uidCounter: 1,
    fx: {},
  };
}

export const other = (p: Pid): Pid => (p === 0 ? 1 : 0);

export class Engine {
  state: DuelState = emptyState();
  private gen: Step | null = null;
  private seq = 0;
  /** the player whose card effect is resolving right now (null for game actions) */
  actor: Pid | null = null;
  /** chain links being resolved right now (Speed Duel queues Special Summon responses until they finish) */
  private resolving = 0;
  /** set while battle destruction is applied, so "destroyed by battle" effects can tell */
  private battleKill = false;
  /** Speed Duel: cards sent to the GY together (one destroy() call) are reported to watchers as one event */
  private graveHold = 0;
  private graveQueue: GraveEvent[] = [];
  /** the card whose chain link is resolving (card leveling credits it) */
  private levelSource: number | null = null;
  /** set while battle damage is dealt (Speed Duel damage modifiers tell battle damage from effect damage) */
  private battleHit = false;

  /** The rule set of this duel (EDS for duels recorded before Speed Duel existed). */
  get rules(): Rules {
    return this.state.rules ?? EDS_RULES;
  }

  get speed(): boolean {
    return this.rules.mode === 'speed';
  }

  /** The phases of a turn under this duel's rules (Speed Duel has no Main Phase 2). */
  phases(): Phase[] {
    return this.rules.mainPhase2 ? PHASES : PHASES.filter((p) => p !== 'M2');
  }

  /**
   * Speed Duel protection: the card's own battleProof/effectProof, or any face-up card
   * (monster, active Spell/Trap, Field Spell, equip) whose `shields` covers it.
   */
  shielded(m: FieldCard, how: 'battle' | 'effect' | 'target'): boolean {
    const own = this.effectOn(m);
    // "Unaffected by your opponent's monster effects" this turn (Magnet Force): tags.unaffTurn / tags.unaffBy.
    if (how !== 'battle' && this.speed && m.tags?.unaffTurn === this.state.turn && this.actor === m.tags.unaffBy && this.resolvingKind() === 'monster') return true;
    // "Unaffected by Trap effects" (a monster Ritual Summoned with Djinn Disserere of Rituals).
    if (how !== 'battle' && this.speed && m.tags?.trapImmune && this.resolvingKind() === 'trap') return true;
    if (how === 'battle' && own?.battleProof?.(this, m)) return true;
    // "cannot be destroyed by battle this turn" (Half Shut).
    if (how === 'battle' && m.tags?.battleSafeTurn === this.state.turn) return true;
    if (how === 'effect' && own?.effectProof?.(this, m)) return true;
    // "This turn, cannot be destroyed by card effects" that outlasts its source (Amazoness Scouts).
    if (how === 'effect' && (m.tags?.effProofTurn ?? -1) === this.state.turn) return true;
    for (const p of [0, 1] as Pid[]) {
      const sources = [...this.monsters(p).filter((x) => x.faceUp), ...this.activeSpells(p)];
      for (const src of sources) {
        const sh = this.effectOn(src)?.shields;
        if (!sh) continue;
        const kind = this.info(src.name).kind;
        if ((kind === 'spell' && this.spellsNegated()) || (kind === 'trap' && this.trapsNegated(src.name))) continue;
        if (sh(this, src, m, how, p)) return true;
      }
    }
    for (const l of this.lingering()) if (l.eff.lingering?.shields?.(this, l.p, m, how)) return true;
    return false;
  }

  // b20: blocked Monster Zones (Ojama Knight). fx.blockedMZ lists zones of the source's opponent that cannot be used
  // while the source stays face-up in a Monster Zone. Every free-zone search for monsters goes through these helpers.
  /** b20: is Monster Zone `i` of player `p` blocked by an effect right now? */
  mzBlocked(p: Pid, i: number): boolean {
    const list = (this.state.fx.blockedMZ ?? []) as { src: number; zones: number[] }[];
    return list.some((b) => {
      const s = this.fieldCard(b.src);
      return !!s && s.faceUp && this.find(s.uid)?.loc.zone === 'mz' && this.controller(s.uid) === other(p) && b.zones.includes(i);
    });
  }
  /** b20: Monster Zone `i` of `p` is empty and not blocked. */
  monsterZoneOpen(p: Pid, i: number): boolean {
    const mz = this.player(p).mz;
    return i >= 0 && i < mz.length && mz[i] === null && !this.mzBlocked(p, i);
  }
  /** b20: the first Monster Zone a monster can be placed in for `p`, or -1. */
  freeMonsterZone(p: Pid): number {
    return this.player(p).mz.findIndex((_, i) => this.monsterZoneOpen(p, i));
  }
  /** b20: how many Monster Zones `p` can still place a monster in. */
  openMonsterZones(p: Pid): number {
    return this.player(p).mz.filter((_, i) => this.monsterZoneOpen(p, i)).length;
  }

  /** Speed Duel: registers a "this turn, ..." effect of a card (its script's `lingering` hooks) for the rest of the turn. */
  linger(name: string, p: Pid) {
    const list = ((this.state.fx.lingering ??= []) as { name: string; p: Pid; turn: number }[]).filter((x) => x.turn === this.state.turn);
    list.push({ name, p, turn: this.state.turn });
    this.state.fx.lingering = list;
  }

  /** The "this turn, ..." effects in force right now. */
  lingering(): { name: string; p: Pid; eff: EffectDef }[] {
    const list = (this.state.fx.lingering ?? []) as { name: string; p: Pid; turn: number }[];
    const out: { name: string; p: Pid; eff: EffectDef }[] = [];
    for (const x of list) {
      if (x.turn !== this.state.turn) continue;
      const eff = getEffect(x.name);
      if (eff?.lingering) out.push({ name: x.name, p: x.p, eff });
    }
    return out;
  }

  /** The card whose chain link is resolving right now (null outside a chain). */
  resolvingCard(): Card | null {
    return this.resolving === 0 || this.levelSource === null ? null : this.find(this.levelSource)?.card ?? null;
  }

  /** A card's script, or nothing while its effects are negated (Speed Duel scripts can negate monsters). */
  effectOn(c: Card) {
    if ('faceUp' in c && this.isNegated(c as FieldCard)) return undefined;
    return this.copiedEffect(c) ?? getEffect(c.name);
  }

  /**
   * b20: a face-up monster whose effect "becomes" another card's effect this turn (Arcana Call): fx.effectAs[uid] = { name, turn }.
   * Its script is looked up under that name while the monster stays face-up in a Monster Zone.
   */
  copiedEffect(c: Card): EffectDef | undefined {
    const x = (this.state.fx.effectAs as Record<number, { name: string; turn: number }> | undefined)?.[c.uid];
    if (!x || x.turn !== this.state.turn || !('faceUp' in c) || !(c as FieldCard).faceUp || this.find(c.uid)?.loc.zone !== 'mz') return undefined;
    return getEffect(x.name);
  }

  isNegated(m: FieldCard): boolean {
    return !!m.faceUp && (m.tags?.negated === 1 || m.tags?.negatedTurn === this.state.turn);
  }

  /** Speed Duel: face-up, active Spells/Traps whose effects apply right now (not negated), with their controller and script. */
  liveST(): { c: FieldCard; p: Pid; eff: EffectDef }[] {
    const out: { c: FieldCard; p: Pid; eff: EffectDef }[] = [];
    if (!this.speed) return out;
    for (const p of [0, 1] as Pid[]) {
      for (const c of this.activeSpells(p)) {
        const kind = this.info(c.name).kind;
        if ((kind === 'spell' && this.spellsNegated()) || (kind === 'trap' && this.trapsNegated(c.name))) continue;
        const eff = getEffect(c.name);
        if (eff) out.push({ c, p, eff });
      }
    }
    return out;
  }

  /** Speed Duel: liveST() plus face-up monsters whose effects are not negated (continuous effects of monsters: Fossil Dyna Pachycephalo, Mirage Dragon...). */
  liveCards(): { c: FieldCard; p: Pid; eff: EffectDef }[] {
    const out = this.liveST();
    if (!this.speed) return out;
    for (const p of [0, 1] as Pid[])
      for (const m of this.monsters(p)) {
        const eff = m.faceUp ? this.effectOn(m) : undefined;
        if (eff) out.push({ c: m, p, eff });
      }
    return out;
  }

  /** The kind of card ('monster', 'spell', 'trap') whose chain link is resolving right now, if any. */
  resolvingKind(): string | null {
    const f = this.levelSource !== null ? this.find(this.levelSource) : null;
    return f ? this.info(f.card.name).kind : null;
  }

  /** Speed Duel: a continuous effect stops `p` from Summoning this card this way (Jam Breeding Machine, Hidden Temples...). */
  summonBlocked(p: Pid, card: Card | string, how: SummonHow, from: string | null = null): boolean {
    if (!this.speed) return false;
    const c: Card = typeof card === 'string' ? { uid: -1, name: card, owner: p } : card;
    const fx = this.state.fx;
    // The card's own Summoning condition ("Cannot be Special Summoned", "Must be Fusion Summoned"), unless an effect ignores it.
    const rule = getEffect(c.name)?.summonRule;
    if (rule && fx.ignoreCond !== c.uid && !rule(this, c, p, how, from)) return true;
    if (how !== 'set' && fx.summonLock?.[p] === this.state.turn && fx.summonLockExcept !== c.uid) return true;
    if (how === 'special' && getEffect(c.name)?.cannotSpecial?.(this, c, p, from)) return true;
    if (how === 'special' && from === 'fusion' && this.liveST().some((x) => x.c.name === 'Summon Gate') && (fx.extraSummons?.[p]?.turn === this.state.turn ? fx.extraSummons[p].n : 0) >= 3) return true;
    if (how === 'special' && from !== null && getEffect(c.name)?.cannotSpecialSummon && fx.ignoreCond !== c.uid) return true;
    // "You cannot Normal or Special Summon ... this turn, except ..." (summonLocks: see SummonLock).
    for (const l of (fx.summonLocks ?? []) as SummonLock[]) {
      if (l.p !== p || l.turn !== this.state.turn || c.uid === l.except) continue;
      if (!(how === 'special' ? l.special : how === 'normal' && l.normal)) continue;
      if (l.only && !l.only.some((n) => c.name.includes(n))) return true;
      if (l.levels && l.levels.includes(this.info(c.name).level ?? 0)) return true;
    }
    if (getEffect(c.name)?.selfSummonBlock?.(this, c, p, how, from)) return true;
    return this.liveCards().some((x) => x.eff.forbidsSummon?.(this, x.c, x.p, c, p, how, from) === true);
  }

  /**
   * Speed Duel: `player` cannot activate this card (or its effect) right now: a "cannot be activated this turn" mark on a Set card
   * (Chow Len the Prophet), "your opponent cannot activate Trap Cards this turn" (Triangle Ecstasy Spark), or
   * "until the end of the Damage Step" while the locking player's monster attacks (Ancient Gear Gadget).
   */
  activationBlocked(player: Pid, card: Card): boolean {
    if (!this.speed) return false;
    const fx = this.state.fx;
    if (((card as FieldCard).tags?.noActTurn ?? -1) === this.state.turn && this.find(card.uid)?.loc.zone === 'sz') return true;
    const kind = this.info(card.name).kind;
    if (kind === 'trap' && (fx.noTrapTurn as number[] | undefined)?.[player] === this.state.turn) return true;
    const lock = fx.battleLock as { player: Pid; turn: number; kind: string } | undefined;
    if (lock && lock.player === player && lock.turn === this.state.turn && this.state.battle && this.controller(this.state.battle.attacker) === other(player) && lock.kind === kind) return true;
    return false;
  }

  /** Speed Duel: extra attacks a monster was granted (Evil HERO Infernal Gainer, Diffusion Wave-Motion). */
  extraAttacks(m: FieldCard): number {
    return (m.tags?.extraAttacks ?? 0) + (m.tags?.extraAttacksTurn === this.state.turn ? m.tags?.extraAttacksN ?? 0 : 0);
  }

  /** Speed Duel: this monster cannot attack directly (Berserk Scales, Massivemorph). */
  noDirectAttack(m: FieldCard): boolean {
    return !!m.tags?.noDirect || m.tags?.noDirectTurn === this.state.turn;
  }

  /** Talisman of Spell/Trap Sealing: active while its controller has a face-up "Sealmaster Meisei". */
  private talisman(name: string, cancelledBy: string): boolean {
    if (!this.speed) return false;
    for (const p of [0, 1] as Pid[]) {
      const t = this.activeSpells(p).find((c) => c.name === name);
      if (t && !this.anyActive(cancelledBy) && this.monsters(p).some((m) => m.faceUp && m.name === 'Sealmaster Meisei')) return true;
    }
    return false;
  }

  /** Talisman of Spell Sealing: Spell Cards cannot be activated. */
  spellsSealed(): boolean {
    if (this.speed && [...this.monsters(0), ...this.monsters(1)].some((m) => m.faceUp && this.effectOn(m)?.sealsSpells)) return true;
    return this.talisman('Talisman of Spell Sealing', 'Talisman of Trap Sealing');
  }

  /** "Once per turn" by card name: true if `key` was not used yet this turn by `p`. */
  oncePerTurn(key: string, p: Pid): boolean {
    const used = (this.state.fx.opt ?? {}) as Record<string, number>;
    return used[`${p}|${key}`] !== this.state.turn;
  }

  useOnce(key: string, p: Pid) {
    ((this.state.fx.opt ??= {}) as Record<string, number>)[`${p}|${key}`] = this.state.turn;
  }

  /** Speed Duel: card effects stop `p` from activating Spell (or Trap) Cards right now (Mechanical Hound, Anti-Magic Arrows...). */
  activationLocked(p: Pid, kind: 'spell' | 'trap'): boolean {
    if (!this.speed) return false;
    if (this.state.fx.stLockTurn === this.state.turn) return true;
    for (const q of [0, 1] as Pid[]) for (const m of this.monsters(q)) if (m.faceUp && this.effectOn(m)?.locksActivation?.(this, m, q, p, kind)) return true;
    return false;
  }

  /** Speed Duel: a banished card comes back to the field during a later Standby ('SP') or End Phase ('EP') (Strike Ninja, Destiny HERO - Doom Lord). */
  returnLater(uid: number, controller: Pid, pos: Pos, turn: number, phase: 'SP' | 'EP') {
    ((this.state.fx.returns ??= []) as { uid: number; controller: Pid; pos: Pos; turn: number; phase: string }[]).push({ uid, controller, pos, turn, phase });
  }

  private *dueReturns(phase: 'SP' | 'EP'): Step {
    const list = (this.state.fx.returns ?? []) as { uid: number; controller: Pid; pos: Pos; turn: number; phase: string }[];
    const due = list.filter((x) => x.phase === phase && x.turn <= this.state.turn);
    if (!due.length) return;
    this.state.fx.returns = list.filter((x) => !due.includes(x));
    for (const x of due) {
      const f = this.find(x.uid);
      if (!f || f.loc.zone !== 'removed' || this.state.winner !== null) continue;
      const ps = this.player(x.controller);
      const zone = this.freeMonsterZone(x.controller); // b20
      if (zone < 0) {
        this.log(x.controller, `${f.card.name} has no zone to return to and is sent to the Graveyard`);
        yield* this.sendToGrave(x.uid, 'used');
        continue;
      }
      const fc = this.toField(this.detach(x.uid)!, x.pos, true);
      ps.mz[zone] = fc;
      this.event('summon', { uid: x.uid, player: x.controller });
      this.log(x.controller, `${fc.name} returns to the field`);
    }
  }

  /** "Once per Duel" by card name. */
  oncePerDuel(key: string, p: Pid): boolean {
    return !((this.state.fx.opd ?? {}) as Record<string, boolean>)[`${p}|${key}`];
  }

  useOncePerDuel(key: string, p: Pid) {
    ((this.state.fx.opd ??= {}) as Record<string, boolean>)[`${p}|${key}`] = true;
  }

  constructor(public readonly db: Map<string, CardInfo>) {
    setNameResolver((n) => {
      const i = this.db.get(n) ?? this.db.get(n.toLowerCase());
      return i ? [i.name, ...(i.alias ? [i.alias] : [])] : [];
    });
  }

  /** Ceremonial Bell, Respect Play and The Eye of Truth show hands. */
  handRevealed(p: Pid): boolean {
    if ([...this.monsters(0), ...this.monsters(1)].some((m) => m.faceUp && m.name === 'Ceremonial Bell')) return true;
    if (this.anyActive('Respect Play') && this.state.turnPlayer === p && !this.trapsNegated()) return true;
    if (this.anyActive('The Eye of Truth', other(p)) && !this.trapsNegated()) return true;
    return false;
  }

  info(name: string): CardInfo {
    const c = this.db.get(name) ?? this.db.get(name.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim());
    if (c) return c;
    const tok = (this.state.fx.tokens as Record<string, Partial<CardInfo>> | undefined)?.[name];
    if (tok) return { id: 0, name, kind: 'monster', sub: 'Normal', atk: 0, def: 0, level: 1, desc: 'Token', ...tok };
    return { id: 0, name, kind: 'monster', sub: 'Normal', atk: 0, def: 0, level: 1, desc: '' };
  }

  // ---------- randomness ----------
  rand(): number {
    let a = (this.state.rngState + 0x6d2b79f5) >>> 0;
    this.state.rngState = a;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  shuffle<T>(items: T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // ---------- logging ----------
  log(player: Pid | null, text: string) {
    this.state.log.push({ turn: this.state.turn, player, text });
  }

  event(kind: string, extra: Omit<EngineEvent, 'kind' | 'seq'> = {}) {
    const ev = { kind, ...extra, seq: ++this.seq };
    this.state.lastEvent = ev;
    const list = (this.state.events ??= []);
    list.push(ev);
    if (list.length > 40) list.splice(0, list.length - 40);
    if (this.state.rules?.mode === 'speed') noteLevelEvent(this.state, ev, { source: this.levelSource, inChain: this.resolving > 0, find: (u) => this.find(u) });
  }

  // ---------- lookups ----------
  player(p: Pid): PlayerState {
    return this.state.players[p];
  }

  /** Finds a card anywhere by uid. */
  find(uid: number): { card: Card; loc: Loc } | null {
    for (const p of [0, 1] as Pid[]) {
      const ps = this.player(p);
      const zones: [string, (Card | null)[]][] = [
        ['hand', ps.hand],
        ['mz', ps.mz],
        ['sz', ps.sz],
        ['gy', ps.gy],
        ['deck', ps.deck],
        ['removed', ps.removed],
        ['fusion', ps.fusion],
      ];
      for (const [zone, arr] of zones) {
        const i = arr.findIndex((c) => c?.uid === uid);
        if (i >= 0) return { card: arr[i]!, loc: { player: p, zone: zone as Loc['zone'], index: i } };
      }
      if (ps.field?.uid === uid) return { card: ps.field, loc: { player: p, zone: 'field', index: 0 } };
    }
    return null;
  }

  fieldCard(uid: number): FieldCard | null {
    const f = this.find(uid);
    if (!f) return null;
    if (f.loc.zone === 'mz' || f.loc.zone === 'sz' || f.loc.zone === 'field') return f.card as FieldCard;
    return null;
  }

  controller(uid: number): Pid | null {
    const f = this.find(uid);
    return f ? f.loc.player : null;
  }

  monsters(p: Pid): FieldCard[] {
    return this.player(p).mz.filter((c): c is FieldCard => !!c);
  }

  spells(p: Pid): FieldCard[] {
    return this.player(p).sz.filter((c): c is FieldCard => !!c);
  }

  // ---------- stats ----------
  /** Original ATK/DEF, after effects that set them (Relinquished, Shield & Sword...). */
  baseStats(m: FieldCard): { atk: number; def: number } {
    const info = this.info(m.name);
    let b = { atk: info.atk ?? 0, def: info.def ?? 0 };
    const set = this.effectOn(m)?.baseStats?.(this, m);
    if (set) b = set;
    if (this.state.fx.swapTurn === this.state.turn) b = { atk: b.def, def: b.atk };
    return b;
  }

  atkOf(m: FieldCard): number {
    let delta = m.atkMod + this.bonus(m).atk;
    if (this.state.fx.reverseTurn === this.state.turn) delta = -delta;
    let v = this.baseStats(m).atk + delta;
    const wall = m.tags?.mirrorWall;
    if (wall && this.fieldCard(wall)?.active && !this.trapsNegated('Mirror Wall')) v = Math.floor(v / 2);
    return Math.max(0, v);
  }

  defOf(m: FieldCard): number {
    let delta = m.defMod + this.bonus(m).def;
    if (this.state.fx.reverseTurn === this.state.turn) delta = -delta;
    return Math.max(0, this.baseStats(m).def + delta);
  }

  /** Monster Type as currently applied (DNA Surgery, Parasite Paracide). */
  raceOf(m: FieldCard | Card): string {
    if ('faceUp' in m) {
      const fx = this.state.fx;
      if (fx.dnaRace && fx.dnaSource && this.fieldCard(fx.dnaSource)?.active && m.faceUp && !this.trapsNegated('DNA Surgery')) return fx.dnaRace;
      if (fx.declRace?.[m.uid] && this.find(m.uid)?.loc.zone === 'mz') return fx.declRace[m.uid];
      const ctl = this.controller(m.uid);
      if (ctl !== null && this.monsters(ctl).some((x) => x.faceUp && x.name === 'Parasite Paracide' && x.owner !== ctl)) return 'Insect';
      // A Trap Card Special Summoned as a monster (Quantum Cat, Zoma the Spirit) has the Type its script gave it.
      const trap = (this.state.fx.trapMonster as Record<number, { race?: string }> | undefined)?.[m.uid];
      if (trap?.race && this.find(m.uid)?.loc.zone === 'mz') return trap.race;
    }
    return this.info(m.name).race ?? '';
  }

  /** Is any face-up, active copy of this card on the field? */
  anyActive(name: string, p?: Pid): FieldCard | null {
    for (const q of p === undefined ? ([0, 1] as Pid[]) : [p]) {
      for (const c of this.activeSpells(q)) if (c.name === name) return c;
      for (const m of this.monsters(q)) if (m.faceUp && m.name === name) return m;
      if (this.speed) for (const m of this.monsters(q)) if (m.faceUp && this.effectOn(m)?.countsAs?.(this, m) === name) return m;
    }
    return null;
  }

  /** Imperial Order: Spell effects on the field are negated (unless Royal Decree negates Imperial Order). */
  spellsNegated(): boolean {
    return (!!this.anyActive('Imperial Order') && !this.trapsNegated('Imperial Order')) || this.spellsSealed();
  }

  /** A face-up Continuous Trap of this name whose effect is not negated by Royal Decree. */
  trapActive(name: string, p?: Pid): FieldCard | null {
    const c = this.anyActive(name, p);
    return c && !this.trapsNegated(name) ? c : null;
  }

  /** A face-up Continuous Spell of this name whose effect is not negated by Imperial Order. */
  spellActive(name: string, p?: Pid): FieldCard | null {
    const c = this.anyActive(name, p);
    return c && !this.spellsNegated() ? c : null;
  }

  /** Royal Decree: other Trap effects are negated. */
  trapsNegated(except?: string): boolean {
    return (!!this.anyActive('Royal Decree') && except !== 'Royal Decree') || this.talisman('Talisman of Trap Sealing', 'Talisman of Spell Sealing');
  }

  /**
   * Is this card name forbidden by Prohibition? Pass the card's uid when it is on the field:
   * cards that were already on the field when Prohibition resolved are not affected.
   */
  prohibited(name: string, uid?: number): boolean {
    const list = (this.state.fx.prohibit ?? []) as { name: string; src: number; exempt?: number[] }[];
    return list.some((x) => x.name === name && this.fieldCard(x.src)?.active && !(uid !== undefined && x.exempt?.includes(uid) && this.fieldCard(uid)));
  }

  /** Lord of D.: Dragons cannot be targeted by card effects. */
  untargetable(m: FieldCard): boolean {
    if (m.faceUp && this.effectOn(m)?.cannotBeTargeted?.(this, m, this.actor)) return true;
    if (m.faceUp && this.speed && this.shielded(m, 'target')) return true;
    // Speed Duel: "your opponent cannot target it until the end of their turn" that outlasts its source (Abyss Prop - Wild Wagon).
    if (m.faceUp && this.speed && (m.tags?.oppNoTargetUntil ?? -1) >= this.state.turn && this.actor !== this.controller(m.uid)) return true;
    return m.faceUp && this.raceOf(m) === 'Dragon' && [...this.monsters(0), ...this.monsters(1)].some((x) => x.faceUp && x.name === 'Lord of D.');
  }

  /** Equip bonuses plus auras from face-up effect monsters and Field Spells. */
  private bonus(m: FieldCard): { atk: number; def: number } {
    let atk = 0;
    let def = 0;
    for (const uid of m.equips) {
      const eq = this.fieldCard(uid);
      if (!eq) continue;
      const kind = this.info(eq.name).kind;
      if ((kind === 'spell' && this.spellsNegated()) || (kind === 'trap' && this.trapsNegated())) continue;
      if (this.state.fx.equipsOff === this.state.turn) continue;
      const b = getEffect(eq.name)?.equipBonus?.(this, eq, m);
      if (b) (atk += b.atk), (def += b.def);
    }
    // Revealed Speed Duel Skills that work like a Field Spell (Power of Dark, Peak Performance...).
    if (m.faceUp) {
      for (const p of [0, 1] as Pid[]) {
        const ps = this.player(p);
        const sk = ps.skill && ps.skillRevealed ? getSkill(ps.skill) : undefined;
        const b = sk?.aura?.(this, p, m);
        if (b) (atk += b.atk), (def += b.def);
      }
    }
    // Speed Duel: cards whose effect applies from the GY (Phantom Beast Cross-Wing).
    if (m.faceUp && this.speed) {
      for (const p of [0, 1] as Pid[]) {
        for (const c of this.player(p).gy) {
          const b = getEffect(c.name)?.graveAura?.(this, c, m, p);
          if (b) (atk += b.atk), (def += b.def);
        }
      }
    }
    // Lasting changes card effects made ("gains 500 ATK" with no end).
    if (m.tags?.permAtk) atk += m.tags.permAtk;
    if (m.tags?.permDef) def += m.tags.permDef;
    const self = this.effectOn(m)?.selfBonus;
    if (self && m.faceUp) {
      const b = self(this, m);
      (atk += b.atk), (def += b.def);
    }
    for (const p of [0, 1] as Pid[]) {
      const sources = [...this.monsters(p), ...this.spells(p).filter((c) => c.active), ...(this.player(p).field ? [this.player(p).field!] : [])];
      for (const src of sources) {
        if (!src.faceUp) continue;
        const srcKind = this.info(src.name).kind;
        if (srcKind === 'spell' && this.spellsNegated()) continue;
        if (srcKind === 'trap' && this.trapsNegated(src.name)) continue;
        if (this.state.fx.fieldOff === this.state.turn && src === this.player(p).field) continue;
        const aura = this.effectOn(src)?.aura;
        if (!aura) continue;
        const b = aura(this, src, m, p);
        if (b) (atk += b.atk), (def += b.def);
      }
    }
    return { atk, def };
  }

  /** Public die roll / coin toss from the shared seed. */
  roll(sides: number): number {
    return 1 + Math.floor(this.rand() * sides);
  }

  /** Fusion materials named on a Fusion Monster's text, as card ids. */
  fusionMaterials(name: string): number[] | null {
    const desc = this.info(name).desc;
    const m = desc.match(/^"[^"]+"(?:\s*\+\s*"[^"]+")+/);
    if (!m) return null;
    return [...m[0].matchAll(/"([^"]+)"/g)].map((x) => this.info(x[1]).id);
  }

  /** The named Ritual Monster and the total Level a Ritual Spell needs. */
  ritualOf(name: string): { monster: string; level: number } | null {
    const desc = this.info(name).desc;
    const m = desc.match(/Ritual Summon "([^"]+)"/);
    if (!m) return null;
    const lv = desc.match(/(?:equal|Level is) (\d+)/);
    return { monster: m[1], level: lv ? Number(lv[1]) : this.info(m[1]).level ?? 1 };
  }

  // ---------- card movement ----------
  private newCard(name: string, owner: Pid): Card {
    return { uid: this.state.uidCounter++, name, owner };
  }

  private toField(card: Card, pos: Pos, faceUp: boolean): FieldCard {
    return { ...card, pos, faceUp, placedTurn: this.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
  }

  /** Removes a card from wherever it is and returns a plain Card. */
  private detach(uid: number): Card | null {
    const f = this.find(uid);
    if (!f) return null;
    const ps = this.player(f.loc.player);
    switch (f.loc.zone) {
      case 'hand':
        ps.hand.splice(f.loc.index, 1);
        break;
      case 'gy':
        ps.gy.splice(f.loc.index, 1);
        break;
      case 'deck':
        ps.deck.splice(f.loc.index, 1);
        break;
      case 'removed':
        ps.removed.splice(f.loc.index, 1);
        break;
      case 'fusion':
        ps.fusion.splice(f.loc.index, 1);
        break;
      case 'mz': {
        ps.mz[f.loc.index] = null;
        // Xyz Materials go to the GY when the Xyz Monster leaves the field.
        const mats = (f.card as FieldCard).mats;
        if (mats?.length) {
          for (const m of mats) this.player(m.owner).gy.push(m);
          (f.card as FieldCard).mats = [];
        }
        break;
      }
      case 'sz':
        ps.sz[f.loc.index] = null;
        break;
      case 'field':
        ps.field = null;
        break;
    }
    return f.card.token ? { uid: f.card.uid, name: f.card.name, owner: f.card.owner, token: true } : { uid: f.card.uid, name: f.card.name, owner: f.card.owner };
  }

  /** Puts a Token onto the field. */
  createToken(name: string, controller: Pid, pos: Pos, faceUp = true, stats?: { atk: number; def: number; level: number; attribute?: string; race?: string }): FieldCard | null {
    if (stats) ((this.state.fx.tokens ??= {}) as Record<string, unknown>)[name] = stats;
    if (this.summonBlocked(controller, name, 'special', null)) return null;
    const ps = this.player(controller);
    const zone = this.freeMonsterZone(controller); // b20
    if (zone < 0) return null;
    const card: Card = { uid: this.state.uidCounter++, name, owner: controller, token: true };
    const fc = this.toField(card, pos, faceUp);
    if (this.speed) fc.tags = { ss: 9, ssAt: this.state.turn };
    ps.mz[zone] = fc;
    this.event('summon', { uid: card.uid, player: controller });
    this.log(controller, `${ps.name} Special Summoned a ${name}`);
    return fc;
  }

  /**
   * Puts a face-up, active Spell/Trap "treated as" a real card onto the field for a Skill
   * (It's a Toon World!: treated as Toon World). It is a token: it vanishes if it leaves the field.
   */
  placeSkillCard(name: string, controller: Pid, where: 'field' | 'sz'): FieldCard | null {
    const ps = this.player(controller);
    const card: Card = { uid: this.state.uidCounter++, name, owner: controller, token: true };
    const fc = this.toField(card, 'atk', true);
    fc.active = true;
    if (where === 'field') {
      if (ps.field) return null;
      ps.field = fc;
    } else {
      const mid = Math.floor(ps.sz.length / 2);
      const zone = ps.sz[mid] === null ? mid : ps.sz.findIndex((z) => z === null);
      if (zone < 0) return null;
      ps.sz[zone] = fc;
    }
    this.event('activate', { uid: card.uid, player: controller });
    this.log(controller, `${ps.name} places ${name} on the field`);
    return fc;
  }

  /** Runs a check on behalf of a player (so "cannot be targeted by your opponent's effects" knows who is targeting). */
  private withActor<T>(p: Pid, fn: () => T): T {
    const prev = this.actor;
    this.actor = p;
    try {
      return fn();
    } finally {
      this.actor = prev;
    }
  }

  /** Runs a card effect on behalf of a player (so "your opponent's effect" checks work). */
  *as(p: Pid, step: Step): Step {
    const prev = this.actor;
    this.actor = p;
    try {
      yield* step;
    } finally {
      this.actor = prev;
    }
  }

  /** Sends a card to its owner's Graveyard, handling equips and "sent to GY" effects. */
  *sendToGrave(uid: number, reason: 'destroyed' | 'discard' | 'tribute' | 'used' | 'mill' | 'cost' | 'material' = 'destroyed'): Step {
    const f = this.find(uid);
    if (!f) return;
    const byBattle = this.battleKill;
    this.battleKill = false;
    const wasField = f.loc.zone === 'mz' || f.loc.zone === 'sz' || f.loc.zone === 'field';
    const fc = wasField ? (f.card as FieldCard) : null;
    if (f.loc.zone === 'mz') (this.state.fx.lostMonster ??= [-1, -1])[f.loc.player] = this.state.turn;
    const controller = f.loc.player;
    // Speed Duel: monsters destroyed on the field this turn (Blackwing - Brisote the Tailwind, Rise of the Snake Deity).
    if (this.speed && fc && f.loc.zone === 'mz' && reason === 'destroyed') {
      const turn = this.state.turn;
      const log = ((this.state.fx.destroyedLog ?? []) as { name: string; controller: Pid; faceUp: boolean; byBattle: boolean; turn: number }[]).filter((x) => x.turn === turn);
      log.push({ name: f.card.name, controller, faceUp: fc.faceUp, byBattle, turn });
      this.state.fx.destroyedLog = log;
    }
    // Dark Ruler Ha Des: the effects of a monster destroyed by battle with its controller's Fiends are negated.
    const muted = byBattle && ((this.state.fx.battleMuted ?? []) as number[]).includes(uid);
    const ev: GraveEvent | null = this.speed ? { card: { uid, name: f.card.name, owner: f.card.owner }, from: f.loc.zone, controller, reason, byBattle, faceUp: !!fc?.faceUp, pos: fc?.pos, race: fc ? this.raceOf(fc) : this.info(f.card.name).race ?? '', toGy: false, token: !!f.card.token, by: this.actor } : null;
    const card = this.detach(uid)!;
    if (card.token || card.name.startsWith('__token')) {
      if (fc) {
        for (const eqUid of fc.equips.slice()) yield* this.sendToGrave(eqUid, 'used');
        const eff = muted ? undefined : getEffect(card.name);
        if (eff?.onLeaveField) yield* eff.onLeaveField(this, fc, controller, reason);
      }
      if (ev) yield* this.graveWatch(ev);
      return;
    }
    const banisher = [...this.monsters(0), ...this.monsters(1)].some((m) => m.faceUp && (m.name === 'Banisher of the Light' || this.effectOn(m)?.banishInstead?.(this, m, this.controller(m.uid) ?? m.owner, card) === true)) || this.liveST().some((x) => x.eff.banishInstead?.(this, x.c, x.p, card) === true);
    // Speed Duel: a face-up monster sends battle-destroyed monsters to the Deck instead (Grave Protector).
    const toDeck = !banisher && this.speed && byBattle && f.loc.zone === 'mz' && [...this.monsters(0), ...this.monsters(1)].some((m) => m.faceUp && this.effectOn(m)?.deckInstead?.(this, m, card) === true);
    if (ev) ev.toGy = !banisher && !toDeck;
    if (banisher) {
      if (this.speed) ((this.state.fx.banishedAt ??= {}) as Record<number, number>)[uid] = this.state.turn;
      this.player(card.owner).removed.push(card);
      this.log(card.owner, `${card.name} is removed from play instead`);
    } else if (toDeck) {
      const ps = this.player(card.owner);
      if (this.isExtraCard(card.name)) ps.fusion.push(card);
      else (ps.deck.push(card), (ps.deck = this.shuffle(ps.deck)));
      this.log(card.owner, `${card.name} is shuffled into the Deck instead`);
    } else this.player(card.owner).gy.push(card);
    this.event('to-gy', { uid, player: card.owner });
    if (reason === 'discard' && f.loc.zone === 'hand') yield* this.discardWatchers(controller);
    if (reason === 'mill' && f.loc.zone === 'deck' && this.actor !== null && this.actor !== card.owner) {
      const eff = getEffect(card.name);
      if (eff?.onMilledByOpponent) yield* eff.onMilledByOpponent(this, card, card.owner);
    }
    if (fc) {
      // Equip cards attached to a monster leaving the field go to the GY too.
      for (const eqUid of fc.equips.slice()) yield* this.sendToGrave(eqUid, 'used');
      if (fc.equippedTo !== undefined) {
        const host = this.fieldCard(fc.equippedTo);
        if (host) host.equips = host.equips.filter((u) => u !== uid);
      }
      const eff = muted ? undefined : getEffect(card.name);
      if (eff?.onLeaveField) yield* eff.onLeaveField(this, fc, controller, reason);
      if (f.loc.zone === 'mz' && eff?.onToGraveFromField) yield* eff.onToGraveFromField(this, card, controller);
    }
    // Speed Duel card scripts: "if this card is sent to the GY" and "if this card is destroyed".
    const eff = muted ? undefined : getEffect(card.name);
    if (this.state.winner === null && (eff?.onSentToGrave || eff?.onDestroyed) && this.find(uid)?.loc.zone === 'gy') {
      if (eff.onDestroyed && wasField && reason === 'destroyed') yield* this.as(controller, eff.onDestroyed(this, card, controller, byBattle));
      if (eff.onSentToGrave && this.find(uid)?.loc.zone === 'gy') yield* this.as(card.owner, eff.onSentToGrave(this, card, card.owner, f.loc.zone, reason));
    }
    if (ev) yield* this.graveWatch(ev);
  }

  /** Speed Duel: reports cards sent to the GY (or destroyed) to active Spells/Traps that watch it, one event per destroy() call. */
  private *graveWatch(ev: GraveEvent): Step {
    this.graveQueue.push(ev);
    if (this.graveHold === 0) yield* this.flushGrave();
  }

  private *flushGrave(): Step {
    const events = this.graveQueue;
    this.graveQueue = [];
    if (!events.length || this.state.winner !== null) return;
    for (const x of this.liveST()) {
      if (x.eff.onAnyToGrave && this.fieldCard(x.c.uid)?.active && this.state.winner === null) yield* this.as(x.p, x.eff.onAnyToGrave(this, x.c, x.p, events));
    }
    // Face-up monsters that watch the GY too (Marina, Princess of Sunflowers).
    for (const p of [0, 1] as Pid[]) {
      for (const m of this.monsters(p)) {
        const h = m.faceUp ? this.effectOn(m)?.onAnyToGrave : undefined;
        if (h && this.state.winner === null && this.fieldCard(m.uid)) yield* this.as(p, h(this, m, p, events));
      }
    }
    for (const p of [0, 1] as Pid[])
      for (const m of this.monsters(p)) {
        const h = m.faceUp ? this.effectOn(m)?.onGraveEvents : undefined;
        if (h && this.fieldCard(m.uid)?.faceUp && this.state.winner === null) yield* this.as(p, h(this, m, p, events));
      }
    for (const p of [0, 1] as Pid[])
      for (const c of [...this.player(p).hand, ...this.player(p).gy]) {
        const h = getEffect(c.name)?.watchGrave;
        const z = this.find(c.uid)?.loc;
        if (h && this.state.winner === null && z && z.player === p && (z.zone === 'hand' || z.zone === 'gy')) yield* this.as(p, h(this, c, p, z.zone, events));
      }
  }

  /** Runs a step whose cards sent to the GY count as one event for watchers (Coffin Seller, Supply Squad...). */
  *together(step: Step): Step {
    this.graveHold++;
    try {
      yield* step;
    } finally {
      this.graveHold--;
    }
    if (this.graveHold === 0) yield* this.flushGrave();
  }

  /** Cards that cannot be destroyed right now (by battle, or by card effects) are skipped. */
  *destroy(uids: number[], reason: 'destroyed' = 'destroyed', byBattle = false): Step {
    if (this.speed && uids.length > 1 && this.graveHold === 0) return yield* this.together(this.destroy(uids, reason, byBattle));
    for (const uid of uids) {
      const m = this.fieldCard(uid);
      if (m && m.faceUp && this.shielded(m, byBattle ? 'battle' : 'effect')) {
        this.log(null, `${m.name} is not destroyed ${byBattle ? 'by battle' : 'by the card effect'}`);
        continue;
      }
      this.battleKill = byBattle;
      yield* this.sendToGrave(uid, reason);
      this.battleKill = false;
    }
  }

  *discard(player: Pid, uid: number): Step {
    const name = this.find(uid)?.card.name ?? '';
    const byOpp = this.actor !== null && this.actor !== player;
    yield* this.sendToGrave(uid, 'discard');
    this.log(player, `${this.player(player).name} discarded ${name}`.trim());
    const c = this.find(uid);
    const eff = getEffect(name);
    if (c && eff?.onDiscarded) yield* eff.onDiscarded(this, c.card, player, byOpp);
  }

  /**
   * A card was discarded from `player`'s hand (by any effect, or for the hand limit):
   * Magical Thorn and Forced Requisition react to it.
   */
  private *discardWatchers(player: Pid): Step {
    ((this.state.fx.discardedTurn ??= [-1, -1]) as number[])[player] = this.state.turn;
    for (const q of [0, 1] as Pid[]) {
      for (const s of this.activeSpells(q)) {
        const h = getEffect(s.name)?.onAnyDiscard;
        if (!h || this.state.winner !== null || !this.fieldCard(s.uid)) continue;
        const kind = this.info(s.name).kind;
        if ((kind === 'spell' && this.spellsNegated()) || (kind === 'trap' && this.trapsNegated(s.name))) continue;
        yield* h(this, s, q, player);
      }
    }
  }

  draw(player: Pid, n: number, normal = false): boolean {
    const ps = this.player(player);
    for (let i = 0; i < n; i++) {
      const c = ps.deck.shift();
      if (!c) {
        this.endDuel(other(player), `${ps.name} has no cards left to draw`);
        return false;
      }
      ps.hand.push(c);
      this.event('draw', { uid: c.uid, player });
      const paracide = (this.state.fx.paracide ?? []) as number[];
      if (paracide.includes(c.uid)) {
        this.state.fx.paracide = paracide.filter((u) => u !== c.uid);
        const zone = this.freeMonsterZone(player); // b20
        if (zone >= 0) {
          const card = this.detach(c.uid)!;
          ps.mz[zone] = this.toField(card, 'def', true);
          this.log(player, `${ps.name} drew Parasite Paracide! It latches on for 1000 damage`);
          this.damage(player, 1000);
        }
      }
    }
    this.log(player, `${ps.name} drew ${n === 1 ? 'a card' : `${n} cards`}`);
    this.checkExodia(player);
    if (!normal) ((this.state.fx.offDrawTurn ??= [-1, -1]) as number[])[player] = this.state.turn;
    if (!normal && this.state.winner === null && !this.state.fx.drawing) {
      this.state.fx.drawing = true;
      for (const q of [0, 1] as Pid[]) {
        for (const s of this.activeSpells(q)) {
          if (this.info(s.name).kind === 'trap' && this.trapsNegated(s.name)) continue;
          getEffect(s.name)?.onDraw?.(this, s, q, player, n);
        }
      }
      this.state.fx.drawing = false;
    }
    return true;
  }

  checkExodia(player: Pid) {
    const names = new Set(this.player(player).hand.map((c) => c.name));
    const pieces = ['Exodia the Forbidden One', 'Right Arm of the Forbidden One', 'Left Arm of the Forbidden One', 'Right Leg of the Forbidden One', 'Left Leg of the Forbidden One'];
    if (pieces.every((p) => names.has(p))) this.endDuel(player, `${this.player(player).name} assembled Exodia!`);
  }

  damage(player: Pid, amount: number): void {
    if (amount > 0 && !this.battleHit && (this.state.fx.noEffectDamage as number[] | undefined)?.[player] === this.state.turn) {
      this.log(player, `${this.player(player).name} takes no damage from card effects this turn`);
      return;
    }
    // Speed Duel: Barrel Behind the Door sends one effect's damage back, and face-up cards change damage (Des Wombat, Prime Material Dragon).
    if (amount > 0 && this.speed) {
      const byEffect = !this.battleHit;
      const barrel = this.state.fx.reflectEffectDamage as { p: Pid; src: number; turn: number } | undefined;
      if (byEffect && barrel && barrel.p === player && barrel.turn === this.state.turn && barrel.src === this.levelSource) {
        this.log(player, `${this.player(player).name}'s damage goes to ${this.player(other(player)).name} instead`);
        return this.damage(other(player), amount);
      }
      for (const q of [0, 1] as Pid[]) {
        const srcs: [FieldCard, EffectDef | undefined][] = [
          ...this.monsters(q).filter((m) => m.faceUp).map((m): [FieldCard, EffectDef | undefined] => [m, this.effectOn(m)]),
          ...this.liveST().filter((x) => x.p === q).map((x): [FieldCard, EffectDef | undefined] => [x.c, x.eff]),
        ];
        for (const [src, eff] of srcs) {
          const r = amount > 0 ? eff?.damageMod?.(this, src, q, player, amount, byEffect) : undefined;
          if (r !== undefined && r !== amount) {
            this.log(player, `${src.name} changes the damage to ${this.player(player).name}`);
            amount = r;
          }
        }
      }
      if (amount < 0) return this.gainLp(player, -amount);
      if (amount === 0) return;
    }
    if (amount > 0 && this.state.fx.noDamage?.[player] === this.state.turn) {
      this.log(player, `${this.player(player).name} takes no damage this turn`);
      return;
    }
    // Speed Duel: "whenever you would take damage this turn, gain that much LP instead" (Rainbow Life).
    if (amount > 0 && (this.state.fx.healDamage as number[] | undefined)?.[player] === this.state.turn) {
      this.log(player, `${this.player(player).name} gains LP instead of taking damage`);
      this.gainLp(player, amount);
      return;
    }
    // Speed Duel: "any damage you take this turn is halved" (Crystal Brilliance).
    if (amount > 0 && (this.state.fx.halfDamage as number[] | undefined)?.[player] === this.state.turn) amount = Math.floor(amount / 2);
    if (amount > 0) (this.state.fx.lpLost ??= [0, 0])[player] += amount;
    if (amount > 0) (this.state.fx.hurt ??= [0, 0])[player] += amount;
    if (amount <= 0) return;
    const ps = this.player(player);
    const from = ps.lp;
    ps.lp = Math.max(0, ps.lp - amount);
    // The finishing blow and how far past 0 it went (the Shadow Realm reads this).
    if (ps.lp <= 0 && this.state.winner === null) this.state.fx.finalBlow = { player, amount, from, turn: this.state.turn };
    this.event('damage', { player, amount, from });
    this.log(player, `${ps.name} takes ${amount} damage (${ps.lp} LP)`);
    if (ps.lp <= 0) this.endDuel(other(player), `${ps.name}'s Life Points hit 0`);
  }

  gainLp(player: Pid, amount: number) {
    const ps = this.player(player);
    ps.lp += amount;
    this.event('heal', { player, amount });
    this.log(player, `${ps.name} gains ${amount} LP (${ps.lp} LP)`);
  }

  payLp(player: Pid, amount: number) {
    if (amount > 0) (this.state.fx.lpLost ??= [0, 0])[player] += amount;
    const ps = this.player(player);
    ps.lp = Math.max(0, ps.lp - amount);
    this.event('damage', { player, amount });
    this.log(player, `${ps.name} pays ${amount} LP (${ps.lp} LP)`);
    if (ps.lp <= 0) this.endDuel(other(player), `${ps.name}'s Life Points hit 0`);
  }

  endDuel(winner: Pid | 'draw', reason: string) {
    if (this.state.winner !== null) return;
    this.state.winner = winner;
    this.state.winReason = reason;
    this.state.prompt = null;
    this.gen = null;
    this.log(null, winner === 'draw' ? `Draw: ${reason}` : `${this.player(winner).name} wins! ${reason}`);
    this.event('win');
  }

  /** Special Summons a card from anywhere onto the controller's field. Returns false if no zone. */
  *specialSummon(uid: number, controller: Pid, pos: Pos, faceUp = true, prep?: (fc: FieldCard) => void): Step {
    const ps = this.player(controller);
    const zone = this.freeMonsterZone(controller); // b20
    if (zone < 0) return;
    const from = this.find(uid);
    if (this.graveLocked(uid)) return;
    if (from && this.summonBlocked(controller, from.card, 'special', from.loc.zone)) {
      this.log(controller, `${from.card.name} cannot be Special Summoned right now`);
      return;
    }
    if (this.speed && from?.loc.zone === 'fusion') {
      const x = (this.state.fx.extraSummons ??= [null, null]) as ({ turn: number; n: number } | null)[];
      x[controller] = { turn: this.state.turn, n: x[controller]?.turn === this.state.turn ? x[controller]!.n + 1 : 1 };
    }
    const card = this.detach(uid);
    if (!card) return;
    const fc = this.toField(card, pos, faceUp);
    // Speed Duel: remember it was Special Summoned, when, and from where (ss/ssFrom: 1 hand, 2 Deck, 3 GY, 4 banished, 5 Extra Deck, 9 elsewhere).
    if (this.speed) {
      const ss = ({ hand: 1, deck: 2, gy: 3, removed: 4, fusion: 5 } as Record<string, number>)[from?.loc.zone ?? ''] ?? 9;
      fc.tags = { ss, ssAt: this.state.turn, ssFrom: ss === 9 ? 0 : ss, ...(from?.loc.zone === 'fusion' ? { ssExtra: 1 } : {}) };
    }
    prep?.(fc);
    ps.mz[zone] = fc;
    this.event('summon', { uid, player: controller });
    this.log(controller, `${ps.name} Special Summoned ${faceUp ? card.name : 'a monster'} in ${pos === 'atk' ? 'Attack' : 'Defense'} Position`);
    if (faceUp) yield* this.anySummon(fc, controller, 'special');
    if (faceUp && this.fieldCard(uid)) {
      const h = getEffect(card.name)?.onSpecialSummon;
      if (h) yield* this.as(controller, h(this, fc, controller));
    }
    if (faceUp && this.speed && this.fieldCard(uid)) yield* this.specialSummonWindow(uid);
  }

  /** Speed Duel: the opponent may respond to a Special Summon (after any chain that caused it). */
  private *specialSummonWindow(uid: number): Step {
    if (this.resolving > 0 || this.state.chain.length > 0 || this.state.fx.inSummonWindow) {
      ((this.state.fx.pendingSummons ??= []) as number[]).push(uid);
      return;
    }
    this.state.fx.inSummonWindow = true;
    try {
      yield* this.responseWindow('special', { uid, summonKind: 'special' });
    } finally {
      this.state.fx.inSummonWindow = false;
    }
  }

  private *flushSummonWindows(): Step {
    while (this.speed && this.state.winner === null && this.resolving === 0 && this.state.chain.length === 0 && !this.state.fx.inSummonWindow) {
      const list = (this.state.fx.pendingSummons ?? []) as number[];
      const uid = list.shift();
      if (uid === undefined) return;
      if (this.fieldCard(uid)?.faceUp) yield* this.specialSummonWindow(uid);
    }
  }

  /** Effects that watch every Summon (Mysterious Puppeteer, Kotodama). */
  *anySummon(m: FieldCard, controller: Pid, kind: 'normal' | 'flip' | 'special'): Step {
    for (const p of [0, 1] as Pid[]) {
      for (const w of this.monsters(p)) {
        if (!w.faceUp || !this.fieldCard(m.uid)) continue;
        const h = this.effectOn(w)?.onAnySummon;
        if (h) yield* h(this, w, p, m, controller, kind);
      }
      // Active Spells/Traps that watch Summons too (Dragon Capture Jar; Speed Duel scripts).
      for (const w of this.activeSpells(p)) {
        if (!this.fieldCard(m.uid) || !this.fieldCard(w.uid)) continue;
        const kindOf = this.info(w.name).kind;
        if ((kindOf === 'spell' && this.spellsNegated()) || (kindOf === 'trap' && this.trapsNegated(w.name))) continue;
        const h = getEffect(w.name)?.onAnySummon;
        if (h) yield* h(this, w, p, m, controller, kind);
      }
    }
    for (const l of this.lingering()) {
      const h = l.eff.lingering?.onAnySummon;
      if (h && this.fieldCard(m.uid) && this.state.winner === null) yield* this.as(l.p, h(this, l.p, m, controller, kind));
    }
  }

  /** Moves a monster to the other side of the field (Change of Heart, Snatch Steal). */
  takeControl(uid: number, to: Pid): boolean {
    const f = this.find(uid);
    if (!f || f.loc.zone !== 'mz') return false;
    const ps = this.player(to);
    const zone = this.freeMonsterZone(to); // b20
    if (zone < 0) return false;
    const fc = f.card as FieldCard;
    this.player(f.loc.player).mz[f.loc.index] = null;
    ps.mz[zone] = fc;
    fc.posChanged = true;
    this.event('summon', { uid, player: to });
    if (fc.faceUp && f.loc.player !== to) getEffect(fc.name)?.onControlChange?.(this, fc, f.loc.player, to);
    return true;
  }

  /** Adds a card to a given player's hand (Graverobber, Exchange). */
  toHandOf(uid: number, p: Pid) {
    if (this.graveLocked(uid)) return;
    if (this.find(uid)?.loc.zone === 'gy') (this.state.fx.gyToHand ??= {})[uid] = this.state.turn;
    const card = this.detach(uid);
    if (!card) return;
    if (this.isExtraCard(card.name)) this.player(card.owner).fusion.push(card);
    else this.player(p).hand.push(card);
    this.event('to-hand', { uid, player: p });
  }

  /** Shows cards to one player only. */
  *reveal(player: Pid, title: string, cards: Card[]): Step {
    if (!cards.length) return;
    yield { kind: 'select', player, title, options: cards.map((c) => ({ label: c.name, uid: c.uid })), min: 0, max: 0, cancel: false };
  }

  toHand(uid: number) {
    if (this.graveLocked(uid)) return;
    const f = this.find(uid);
    if (f && f.loc.zone === 'mz' && this.actor !== null && this.actor !== f.loc.player) (this.state.fx.bounced ??= [-1, -1])[f.loc.player] = this.state.turn;
    if (f?.loc.zone === 'gy') (this.state.fx.gyToHand ??= {})[uid] = this.state.turn;
    const card = this.detach(uid);
    if (!card) return;
    if (f && (f.loc.zone === 'mz' || f.loc.zone === 'sz' || f.loc.zone === 'field')) this.leftField(f.card as FieldCard, f.loc.player, 'bounced');
    (this.isExtraCard(card.name) ? this.player(card.owner).fusion : this.player(card.owner).hand).push(card);
    this.event('to-hand', { uid, player: card.owner });
  }

  /** Removes a card from play (D.D. Warrior, Gravedigger Ghoul). */
  banish(uid: number) {
    const f = this.find(uid);
    if (!f || this.graveLocked(uid)) return;
    if (this.speed) ((this.state.fx.banishedAt ??= {}) as Record<number, number>)[uid] = this.state.turn;
    const fc = f.loc.zone === 'mz' || f.loc.zone === 'sz' || f.loc.zone === 'field' ? (f.card as FieldCard) : null;
    const card = this.detach(uid)!;
    if (fc) this.leftField(fc, f.loc.player, 'banished');
    this.player(card.owner).removed.push(card);
    this.event('to-gy', { uid, player: card.owner });
    this.log(card.owner, `${card.name} was removed from play`);
  }

  /**
   * A card left the field without going to the GY (returned to the hand or Deck, banished).
   * Its equips and attached cards go to the GY, and its "when this card leaves the field"
   * effect runs, as soon as the current effect or action has finished (see flushLeaves).
   */
  private leftField(fc: FieldCard, controller: Pid, reason: string) {
    if (fc.equippedTo !== undefined) {
      const host = this.fieldCard(fc.equippedTo);
      if (host) host.equips = host.equips.filter((u) => u !== fc.uid);
    }
    ((this.state.fx.pendingLeave ??= []) as { fc: FieldCard; controller: Pid; reason: string }[]).push({ fc: { ...fc, equips: fc.equips.slice() }, controller, reason });
  }

  *flushLeaves(): Step {
    const list = (this.state.fx.pendingLeave ?? []) as { fc: FieldCard; controller: Pid; reason: string }[];
    while (list.length && this.state.winner === null) {
      const { fc, controller, reason } = list.shift()!;
      for (const eqUid of fc.equips) if (this.fieldCard(eqUid)) yield* this.sendToGrave(eqUid, 'used');
      const eff = fc.token ? undefined : getEffect(fc.name);
      if (eff?.onLeaveField) yield* this.as(controller, eff.onLeaveField(this, fc, controller, reason));
    }
  }

  /** Puts a card on top of its owner's Deck (Cockroach Knight). */
  toDeckTop(uid: number) {
    if (this.graveLocked(uid)) return;
    const f = this.find(uid);
    const card = this.detach(uid);
    if (!card) return;
    if (f && (f.loc.zone === 'mz' || f.loc.zone === 'sz' || f.loc.zone === 'field')) this.leftField(f.card as FieldCard, f.loc.player, 'to-deck');
    if (this.isExtraCard(card.name)) this.player(card.owner).fusion.push(card);
    else this.player(card.owner).deck.unshift(card);
    this.event('to-hand', { uid, player: card.owner });
  }

  /** Jinzo: traps cannot be activated while it is face-up (`player`: whose Trap; an Amplifier on Jinzo frees its controller's Traps). */
  trapsSealed(player?: Pid): boolean {
    const freed = (m: FieldCard) => player !== undefined && this.controller(m.uid) === player && m.equips.some((u) => { const eq = this.fieldCard(u); return !!eq?.active && !!getEffect(eq.name)?.freesOwnTraps && !this.spellsNegated(); });
    return [...this.monsters(0), ...this.monsters(1)].some((m) => m.faceUp && this.effectOn(m)?.sealsTraps && !freed(m)) || this.talisman('Talisman of Trap Sealing', 'Talisman of Spell Sealing');
  }

  /** Speed Duel: this card is in a GY and may not leave it by a card effect right now (Necrovalley). */
  graveLocked(uid: number): boolean {
    if (!this.speed) return false;
    const f = this.find(uid);
    if (!f || f.loc.zone !== 'gy') return false;
    const lock = this.liveCards().find((x) => x.eff.locksGrave?.(this, x.c, x.p, f.card) === true);
    if (lock) this.log(null, `${lock.c.name}: ${f.card.name} cannot leave the Graveyard`);
    return !!lock;
  }

  /** Speed Duel: a face-up card stops `player` from activating this Spell/Trap Card right now (Ancient Gear Soldier, Invader of Darkness, Mirage Dragon). */
  cardActivationLocked(player: Pid, card: Card): boolean {
    if (!this.speed) return false;
    return this.liveCards().some((x) => x.eff.locksCardActivation?.(this, x.c, x.p, player, card) === true);
  }

  /** Face-up Spells/Traps/Field cards of a player that are in effect. */
  activeSpells(p: Pid): FieldCard[] {
    const ps = this.player(p);
    return [...this.spells(p), ...(ps.field ? [ps.field] : [])].filter((c) => c.faceUp && c.active);
  }

  // ---------- prompts ----------
  optionsFor(cards: (Card | FieldCard)[], hideFaceDown = false): SelectOption[] {
    return cards.map((c) => {
      const f = this.find(c.uid)!;
      const fc = c as FieldCard;
      const hidden = hideFaceDown && 'faceUp' in c && !fc.faceUp;
      return { label: hidden ? 'Face-down card' : c.name, loc: f.loc, uid: c.uid };
    });
  }

  *select(player: Pid, title: string, options: SelectOption[], min = 1, max = 1, cancel = false): Generator<Prompt, number[] | null, Choice> {
    if (options.length === 0) return min === 0 ? [] : null;
    if (options.length <= min && !cancel) return options.map((_, i) => i);
    const choice = yield { kind: 'select', player, title, options, min: Math.min(min, options.length), max: Math.min(max, options.length), cancel };
    if (choice === 'cancel') return null;
    if (typeof choice === 'object' && 'picks' in choice) return choice.picks.filter((i) => i >= 0 && i < options.length).slice(0, max);
    return null;
  }

  *yesno(player: Pid, title: string): Generator<Prompt, boolean, Choice> {
    const choice = yield { kind: 'yesno', player, title };
    return choice === true;
  }

  // ---------- action entry ----------
  apply(action: Action) {
    if (this.state.winner !== null) return;
    if (action.type === 'START') return this.start(action);
    if (!this.state.started) return;
    if (action.type === 'SURRENDER') return this.endDuel(other(action.player), `${this.player(action.player).name} surrendered`);
    if (this.state.prompt) {
      if (this.state.prompt.player !== action.player) return;
      switch (action.type) {
        case 'CHOOSE':
          return this.resume({ picks: action.picks });
        case 'CANCEL':
          return this.resume('cancel');
        case 'PASS':
          return this.resume('pass');
        case 'YES':
          return this.resume(true);
        case 'NO':
          return this.resume(false);
        default:
          return; // busy
      }
    }
    if (action.player !== this.state.turnPlayer) return;
    switch (action.type) {
      case 'SUMMON':
        return this.run(this.summon(action.player, action.uid, action.zone, action.pos, action.faceUp));
      case 'SET_ST':
        return this.setSpellTrap(action.player, action.uid, action.zone);
      case 'ACTIVATE':
        return this.run(this.activateFromMain(action.player, action.uid, action.zone));
      case 'FLIP_SUMMON':
        return this.run(this.flipSummon(action.player, action.uid));
      case 'CHANGE_POS':
        return this.run(this.changePosition(action.player, action.uid));
      case 'ATTACK':
        return this.run(this.attack(action.player, action.uid, action.target));
      case 'MONSTER_EFFECT':
        return this.run(this.monsterEffect(action.player, action.uid));
      case 'SPECIAL':
        return this.run(this.specialProc(action.player, action.uid));
      case 'NEXT_PHASE':
        return this.run(this.nextPhase());
      case 'END_TURN':
        return this.run(this.goToPhase('EP'));
      case 'SKILL':
        return this.run(this.useSkill(action.player));
      case 'GRAVE_EFFECT':
        return this.run(this.graveEffect(action.player, action.uid));
      case 'QUICK_EFFECT':
        return this.run(this.quickNow(action.player, action.uid));
    }
  }

  private run(gen: Step) {
    if (this.gen) return;
    const self = this;
    const inner = (function* (): Step {
      yield* gen;
      yield* self.flushLeaves();
    })();
    this.gen = this.speed ? this.withStateChecks(inner) : inner;
    this.resume(undefined as unknown as Choice);
  }

  /** Speed Duel: after every action, active Spells/Traps check their "destroy this card if..." conditions. */
  private *withStateChecks(gen: Step): Step {
    yield* gen;
    for (let i = 0; i < 4 && this.state.winner === null; i++) {
      let acted = false;
      for (const x of this.liveST().filter((y) => y.eff.stateCheck)) {
        if (!this.fieldCard(x.c.uid)?.active || this.state.winner !== null) continue;
        const before = this.state.log.length;
        yield* this.as(x.p, x.eff.stateCheck!(this, x.c, x.p));
        if (this.state.log.length !== before) acted = true;
      }
      for (const p of [0, 1] as Pid[]) {
        for (const m of this.monsters(p)) {
          const h = m.faceUp ? this.effectOn(m)?.stateCheck : undefined;
          if (!h || this.state.winner !== null || !this.fieldCard(m.uid)?.faceUp) continue;
          const before = this.state.log.length;
          yield* this.as(p, h(this, m, p));
          if (this.state.log.length !== before) acted = true;
        }
        for (const c of this.player(p).hand.slice()) {
          const h = getEffect(c.name)?.inHand;
          if (!h || this.state.winner !== null || this.find(c.uid)?.loc.zone !== 'hand') continue;
          const before = this.state.log.length;
          yield* this.as(p, h(this, c, p));
          if (this.state.log.length !== before) acted = true;
        }
      }
      if (!acted) break;
    }
  }

  private resume(input: Choice) {
    const g = this.gen;
    if (!g) return;
    const r = g.next(input);
    if (this.state.winner !== null) {
      this.gen = null;
      this.state.prompt = null;
      return;
    }
    if (r.done) {
      this.gen = null;
      this.state.prompt = null;
    } else {
      this.state.prompt = r.value;
    }
  }

  // ---------- duel start ----------
  private start(a: Extract<Action, { type: 'START' }>) {
    const s = emptyState();
    s.seed = a.seed;
    s.rngState = a.seed >>> 0;
    const rules = rulesFor(a.mode);
    if (a.mode) s.rules = rules;
    this.state = s;
    for (const p of [0, 1] as Pid[]) {
      const ps = s.players[p];
      ps.name = a.names[p];
      ps.lp = rules.lp;
      ps.mz = Array(rules.monsterZones).fill(null);
      ps.sz = Array(rules.stZones).fill(null);
      ps.deck = this.shuffle(a.decks[p].map((n) => this.newCard(n, p)));
      ps.fusion = a.fusions[p].map((n) => this.newCard(n, p));
      ps.ready = true;
      const skill = a.skills?.[p] ?? null;
      if (skill && getSkill(skill)) {
        ps.skill = skill;
        ps.skillRevealed = false;
        ps.skillUses = 0;
      }
    }
    s.started = true;
    s.turn = 1;
    s.turnPlayer = a.first;
    s.phase = 'DP';
    this.log(null, `Duel start! ${s.players[a.first].name} goes first.`);
    for (const p of [0, 1] as Pid[]) this.draw(p, Math.max(0, rules.openingHand + (a.setup?.[p]?.openingHand ?? 0)), true);
    if (rules.firstPlayerDraws) this.draw(a.first, 1, true);
    for (const p of [0, 1] as Pid[]) if (a.setup?.[p]) this.applySetup(p, a.setup[p]!);
    this.run(this.duelOpening());
  }

  /** A Duel Condition: different LP, cards already in play, extra cards in hand. */
  private applySetup(p: Pid, su: SeatSetup) {
    const ps = this.player(p);
    if (su.lp && su.lp > 0) ps.lp = su.lp;
    for (const n of su.monsters ?? []) {
      const z = ps.mz.findIndex((x) => x === null);
      if (z < 0 || this.info(n).kind !== 'monster') continue;
      ps.mz[z] = this.toField(this.newCard(n, p), 'atk', true);
    }
    if (su.field && !ps.field && this.info(su.field).sub === 'Field') {
      ps.field = this.toField(this.newCard(su.field, p), 'atk', true);
      ps.field.active = true;
    }
    for (const n of su.spells ?? []) {
      const z = ps.sz.findIndex((x) => x === null);
      if (z < 0 || this.info(n).kind === 'monster') continue;
      const fc = this.toField(this.newCard(n, p), 'atk', true);
      fc.active = true;
      ps.sz[z] = fc;
    }
    for (const n of su.hand ?? []) ps.hand.push(this.newCard(n, p));
    if (su.lp || su.monsters?.length || su.field || su.spells?.length || su.hand?.length) this.log(p, `${ps.name} starts under a Duel Condition`);
  }

  /** Skills that act at the start of the Duel, then the first Standby Phase. */
  private *duelOpening(): Step {
    for (const p of [this.state.turnPlayer, other(this.state.turnPlayer)]) {
      const ps = this.player(p);
      const sk = ps.skill ? getSkill(ps.skill) : undefined;
      if (sk?.startOfDuel && this.state.winner === null) {
        ps.skillRevealed = true;
        this.log(p, `${ps.name}'s Skill: ${ps.skill}`);
        yield* this.as(p, sk.startOfDuel(this, p));
      }
    }
    if (this.state.winner === null) yield* this.enterPhase('SP');
  }

  // ---------- Skills (Speed Duel) ----------
  canUseSkill(player: Pid): boolean {
    const ps = this.player(player);
    if (!ps.skill || this.state.prompt || this.state.winner !== null || this.state.turnPlayer !== player) return false;
    const sk = getSkill(ps.skill);
    if (!sk?.use) return false;
    if (sk.use.phase === 'main' && !this.inMainPhase()) return false;
    if (sk.use.phase === 'start' && !(this.state.phase === 'M1' || this.state.phase === 'SP') ) return false;
    if (sk.use.oncePerDuel !== false && (ps.skillUses ?? 0) >= (sk.use.timesPerDuel ?? 1)) return false;
    if (ps.skillTurn === this.state.turn) return false;
    return sk.use.can(this, player);
  }

  private *useSkill(player: Pid): Step {
    if (!this.canUseSkill(player)) return;
    const ps = this.player(player);
    const sk = getSkill(ps.skill!)!;
    ps.skillRevealed = true;
    ps.skillUses = (ps.skillUses ?? 0) + 1;
    ps.skillTurn = this.state.turn;
    this.event('activate', { player });
    this.log(player, `${ps.name} uses the Skill ${ps.skill}`);
    yield* this.as(player, sk.use!.run(this, player));
  }

  // ---------- Graveyard effects (Speed Duel) ----------
  canUseGraveEffect(player: Pid, uid: number): boolean {
    if (!this.inMainPhase() || this.state.turnPlayer !== player || this.state.prompt) return false;
    const f = this.find(uid);
    if (!f || f.loc.zone !== 'gy' || f.loc.player !== player || this.prohibited(f.card.name)) return false;
    const g = getEffect(f.card.name)?.graveIgnition;
    return !!g && g.can(this, f.card, player);
  }

  private *graveEffect(player: Pid, uid: number): Step {
    if (!this.canUseGraveEffect(player, uid)) return;
    const card = this.find(uid)!.card;
    this.log(player, `${card.name}'s effect activates from the Graveyard`);
    yield* this.as(player, getEffect(card.name)!.graveIgnition!.run(this, card, player));
  }

  // ---------- Quick Effects used on your own turn (Speed Duel) ----------
  /** Can this card's Quick Effect be used right now, with nothing else happening in your Main Phase? */
  canUseQuickNow(player: Pid, uid: number): boolean {
    const s = this.state;
    if (!this.speed || s.turnPlayer !== player || s.prompt || s.winner !== null || s.chain.length) return false;
    if (!this.inMainPhase()) return false;
    return this.quickOptions(player, 'main', {}).some((o) => o.uid === uid);
  }

  private *quickNow(player: Pid, uid: number): Step {
    if (!this.canUseQuickNow(player, uid)) return;
    const link = yield* this.activateQuick(player, uid, 'main', {});
    if (!link) return;
    yield* this.responseWindow('effect', { uid, link });
    yield* this.resolveChain();
  }

  // ---------- phases ----------
  private *leaveBattle(): Step {
    const fx = this.state.fx;
    const doomed = ((fx.endOfBattle ?? []) as number[]).filter((u) => this.fieldCard(u));
    fx.endOfBattle = [];
    if (doomed.length) yield* this.destroy(doomed);
    if (this.speed)
      for (const p of [this.state.turnPlayer, other(this.state.turnPlayer)])
        for (const m of this.monsters(p)) {
          const h = m.faceUp ? this.effectOn(m)?.onBattlePhaseEnd : undefined;
          if (h && this.fieldCard(m.uid)?.faceUp && this.state.winner === null) yield* this.as(p, h(this, m, p));
        }
  }

  private *nextPhase(): Step {
    if (this.state.phase === 'BP') yield* this.leaveBattle();
    const i = PHASES.indexOf(this.state.phase);
    let next: Phase = PHASES[Math.min(i + 1, PHASES.length - 1)];
    if (this.state.phase === 'M1' && this.state.firstTurn) next = 'EP'; // no Battle Phase on the very first turn
    if (next === 'M2' && !this.rules.mainPhase2) next = 'EP';
    if (this.state.phase === 'EP') return yield* this.endTurn();
    yield* this.enterPhase(next);
  }

  private *goToPhase(phase: Phase): Step {
    if (this.state.phase === 'BP') yield* this.leaveBattle();
    if (phase === 'EP' && this.state.phase === 'EP') return yield* this.endTurn();
    yield* this.enterPhase(phase);
  }

  private *enterPhase(phase: Phase): Step {
    this.state.phase = phase;
    this.state.battle = null;
    this.event('phase');
    const tp = this.state.turnPlayer;
    if (phase === 'SP') {
      const fx = this.state.fx;
      if (this.speed) yield* this.dueReturns('SP');
      if (fx.skipStandby === tp) {
        fx.skipStandby = undefined;
        this.log(tp, `${this.player(tp).name}'s Standby Phase is skipped`);
      } else {
        // Standby Phase effects (Snatch Steal's 1000 LP, Stim-Pack, Mushroom Man #2...)
        for (const p of [0, 1] as Pid[]) {
          for (const c of [...this.spells(p), ...(this.player(p).field ? [this.player(p).field!] : [])]) {
            const eff = getEffect(c.name);
            if (!c.faceUp || !c.active || !eff?.onStandby || !this.fieldCard(c.uid)) continue;
            const kind = this.info(c.name).kind;
            if ((kind === 'spell' && this.spellsNegated() && c.name !== 'Imperial Order') || (kind === 'trap' && this.trapsNegated(c.name))) continue;
            yield* this.as(p, eff.onStandby(this, c, p));
          }
          for (const m of this.monsters(p)) {
            const eff = this.effectOn(m);
            if (m.faceUp && eff?.onStandby && this.fieldCard(m.uid)) yield* this.as(p, eff.onStandby(this, m, p));
          }
        }
        for (const c of this.player(tp).gy.slice()) {
          const eff = getEffect(c.name);
          if (eff?.onStandbyInGrave && this.find(c.uid)?.loc.zone === 'gy') yield* this.as(tp, eff.onStandbyInGrave(this, c, tp));
        }
        if (this.speed)
          for (const c of this.player(tp).removed.slice()) {
            const h = getEffect(c.name)?.onStandbyBanished;
            if (h && this.state.winner === null && this.find(c.uid)?.loc.zone === 'removed') yield* this.as(tp, h(this, c, tp));
          }
          for (const p of [tp, other(tp)])
            for (const c of this.player(p).removed.slice()) {
              const h = getEffect(c.name)?.onStandbyBanishedAny;
              if (h && this.state.winner === null && this.find(c.uid)?.loc.zone === 'removed') yield* this.as(p, h(this, c, p));
            }
        // Lightforce Sword: banished hand cards come back.
        const lf = (fx.lightforce ?? []) as { uid: number; back: number }[];
        for (const x of lf.filter((x) => x.back <= this.state.turn)) {
          const card = this.find(x.uid);
          if (card && card.loc.zone === 'removed') this.toHand(x.uid);
        }
        fx.lightforce = lf.filter((x) => x.back > this.state.turn);
        // Speed Duel: monsters banished "until your next Standby Phase" come back (Flyfang).
        const away = (fx.returnAtStandby ?? []) as { uid: number; p: Pid; pos: Pos; after: number }[];
        for (const x of away.filter((y) => y.p === tp && y.after < this.state.turn)) {
          if (this.find(x.uid)?.loc.zone !== 'removed' || this.freeMonsterZone(tp) < 0) continue; // b20
          const card = this.detach(x.uid)!;
          const z = this.freeMonsterZone(tp);
          this.player(tp).mz[z] = this.toField(card, x.pos, true);
          this.event('summon', { uid: x.uid, player: tp });
          this.log(tp, `${card.name} returns to the field`);
        }
        fx.returnAtStandby = away.filter((y) => !(y.p === tp && y.after < this.state.turn));
      }
      if (this.state.winner !== null) return;
      yield* this.enterPhase('M1');
      return;
    }
    if (phase === 'EP') {
      yield* this.endPhase(tp);
      return;
    }
  }

  private *endPhase(tp: Pid): Step {
    if (this.speed) yield* this.dueReturns('EP');
    // Return monsters taken by Change of Heart.
    for (const p of [0, 1] as Pid[]) {
      for (const m of this.monsters(p)) {
        if (m.returnAtEnd !== undefined && m.returnAtEnd !== p) {
          const back = m.returnAtEnd;
          m.returnAtEnd = undefined;
          if (this.takeControl(m.uid, back)) this.log(null, `${m.name} returns to ${this.player(back).name}`);
        }
      }
    }
    // End-phase countdowns (Swords of Revealing Light) and monster end-phase effects (Karate Man).
    for (const p of [0, 1] as Pid[]) {
      for (const c of [...this.spells(p), ...(this.speed && this.player(p).field ? [this.player(p).field!] : [])]) {
        const eff = getEffect(c.name);
        if (c.faceUp && c.active && eff?.onEndPhase && this.fieldCard(c.uid)) yield* eff.onEndPhase(this, c, p);
      }
      for (const m of this.monsters(p)) {
        const eff = this.effectOn(m);
        if (m.faceUp && eff?.onEndPhase && this.fieldCard(m.uid)) yield* eff.onEndPhase(this, m, p);
      }
    }
    // Speed Duel: "During the End Phase, if this card is in the GY" (Hysteric Sign).
    if (this.speed)
      for (const p of [tp, other(tp)])
        for (const c of this.player(p).gy.slice()) {
          const h = getEffect(c.name)?.onEndPhaseInGrave;
          if (h && this.state.winner === null && this.find(c.uid)?.loc.zone === 'gy') yield* this.as(p, h(this, c, p));
        }
    // Speed Duel: "During the End Phase, if this card is banished" (D.D. Survivor, D.D. Scout Plane).
    if (this.speed)
      for (const p of [tp, other(tp)])
        for (const c of this.player(p).removed.slice()) {
          const h = getEffect(c.name)?.onEndPhaseBanished;
          if (h && this.state.winner === null && this.find(c.uid)?.loc.zone === 'removed') yield* this.as(p, h(this, c, p));
        }
    // Delayed destruction (Zone Eater, Steel Scorpion, Swordsman from a Distant Land).
    const doomed = [...this.monsters(0), ...this.monsters(1)].filter((m) => m.doomAt !== undefined && m.doomAt <= this.state.turn);
    if (doomed.length) {
      for (const m of doomed) this.log(null, `${m.name} crumbles away`);
      yield* this.destroy(doomed.map((m) => m.uid));
    }
    // Speed Duel: monsters that must be sent to the GY during this End Phase (Millennium Revelation's Ra).
    for (const m of [...this.monsters(0), ...this.monsters(1)].filter((x) => x.tags?.sendAtEnd === this.state.turn)) {
      this.log(null, `${m.name} is sent to the Graveyard`);
      yield* this.sendToGrave(m.uid, 'used');
    }
    // Graverobber: borrowed Spells go back to their owner's Graveyard.
    const borrowed = (this.state.fx.borrowed ?? []) as number[];
    for (const uid of borrowed) {
      const f = this.find(uid);
      if (f && f.loc.zone === 'hand') {
        const card = this.detach(uid)!;
        this.player(card.owner).gy.push(card);
      }
    }
    this.state.fx.borrowed = [];
    // Revealed Skills with an End Phase effect.
    for (const p of [tp, other(tp)]) {
      const ps = this.player(p);
      const sk = ps.skill && ps.skillRevealed ? getSkill(ps.skill) : undefined;
      if (sk?.onEndPhase && this.state.winner === null) yield* this.as(p, sk.onEndPhase(this, p));
    }
    // Hand limit.
    const ps = this.player(tp);
    const limit = this.rules.handLimit;
    while (ps.hand.length > limit && this.state.winner === null) {
      const n = ps.hand.length - limit;
      const picks = yield* this.select(tp, `Hand limit: discard ${n} card${n > 1 ? 's' : ''}`, this.optionsFor(ps.hand), n, n);
      if (!picks) continue;
      const uids = picks.map((i) => ps.hand[i].uid);
      for (const uid of uids) yield* this.discard(tp, uid);
    }
    yield* this.endTurn();
  }

  private *endTurn(): Step {
    const s = this.state;
    const prev = s.turnPlayer;
    for (const m of [...this.monsters(prev), ...this.monsters(other(prev))]) {
      m.attacked = false;
      m.posChanged = false;
      m.atkMod = 0;
      m.defMod = 0;
      m.effectUsed = false;
    }
    // Speed Duel: Spell/Trap ignition effects are once per turn, not once per duel.
    if (this.speed) for (const q of [0, 1] as Pid[]) for (const c of [...this.player(q).sz, this.player(q).field]) if (c) c.effectUsed = false;
    this.player(prev).normalSummoned = false;
    s.attackedThisTurn = [];
    s.firstTurn = false;
    s.turn += 1;
    s.turnPlayer = other(prev);
    // Speed Duel: "skip your opponent's next turn" (Arcana Force XXI - The World).
    if (this.speed && s.fx.skipTurn === s.turnPlayer) {
      s.fx.skipTurn = undefined;
      this.log(s.turnPlayer, `${this.player(s.turnPlayer).name}'s turn is skipped`);
      s.turn += 1;
      s.turnPlayer = prev;
    }
    s.phase = 'DP';
    this.log(s.turnPlayer, `Turn ${s.turn}: ${this.player(s.turnPlayer).name}`);
    this.event('turn', { player: s.turnPlayer });
    if (s.fx.skipDraw === s.turnPlayer) {
      s.fx.skipDraw = undefined;
      this.log(s.turnPlayer, `${this.player(s.turnPlayer).name}'s Draw Phase is skipped`);
    } else {
      // Speed Duel Skills that replace the normal draw ("search your Deck instead of drawing").
      const ps = this.player(s.turnPlayer);
      const sk = ps.skill ? getSkill(ps.skill) : undefined;
      let replaced = false;
      if (sk?.drawPhase && sk.drawPhase.can(this, s.turnPlayer)) {
        if (yield* this.yesno(s.turnPlayer, `Use your Skill ${ps.skill} instead of drawing?`)) {
          replaced = true;
          ps.skillRevealed = true;
          ps.skillUses = (ps.skillUses ?? 0) + 1;
          this.log(s.turnPlayer, `${ps.name} uses the Skill ${ps.skill}`);
          yield* this.as(s.turnPlayer, sk.drawPhase.run(this, s.turnPlayer));
          if (this.state.winner !== null) return;
        }
      }
      if (!replaced && !this.draw(s.turnPlayer, 1, true)) return;
      const drawn = this.player(s.turnPlayer).hand[this.player(s.turnPlayer).hand.length - 1];
      if (!replaced && drawn && this.speed) s.fx.normalDraw = { player: s.turnPlayer, uid: drawn.uid, turn: s.turn };
      if (!replaced && drawn) for (const x of this.liveST()) if (x.eff.onDrawPhase && x.p === s.turnPlayer && this.state.winner === null) yield* this.as(x.p, x.eff.onDrawPhase(this, x.c, x.p, [drawn]));
      if (this.state.winner !== null) return;
    }
    s.fx.hurt = [0, 0];
    yield* this.enterPhase('SP');
  }

  // ---------- main phase actions ----------
  inMainPhase(): boolean {
    return this.state.phase === 'M1' || this.state.phase === 'M2';
  }

  tributesNeeded(level: number): number {
    return level >= 7 ? 2 : level >= 5 ? 1 : 0;
  }

  /**
   * Speed Duel: Tributes needed to Normal Summon `card` (its Level after Cost Down), lowered for a face-up Summon by its own
   * `tributeDiscount` or an active Spell/Trap's (Super-Ancient Dinobeast, Big Evolution Pill); `only` limits which monsters may be Tributed.
   */
  tributePlan(player: Pid, card: Card, faceUp?: boolean): { need: number; only?: (m: FieldCard) => boolean } {
    const info = this.info(card.name);
    const down = this.speed ? ((this.state.fx.lvDown ?? {}) as Record<number, { turn: number; n: number }>)[card.uid] : undefined;
    const level = Math.max(1, (info.level ?? 1) - (down?.turn === this.state.turn ? down.n : 0));
    let less = 0;
    if (this.speed) for (const x of this.liveST()) less += x.eff.tributeDiscount?.(this, x.c, x.p, card, player) ?? 0;
    let plan: { need: number; only?: (m: FieldCard) => boolean } = { need: Math.max(0, this.tributesNeeded(level) - less) };
    if (!this.speed || faceUp === false || plan.need === 0) return plan;
    const offers = [getEffect(card.name)?.tributeOffer?.(this, null, player, card, plan.need), ...this.liveST().filter((x) => x.p === player).map((x) => x.eff.tributeOffer?.(this, x.c, x.p, card, plan.need))];
    for (const o of offers) if (o && o.need < plan.need && (!o.only || this.monsters(player).filter(o.only).length >= o.need)) plan = o;
    return plan;
  }

  /** `faceUp`: true = a face-up Normal Summon, false = a Set, undefined = either. `extra`: an additional Normal Summon granted by a card (Ultimate Offering), outside the usual timing and limit. */
  canNormalSummon(player: Pid, card: Card, faceUp?: boolean, extra = false): boolean {
    if (!extra && (!this.inMainPhase() || this.state.turnPlayer !== player)) return false;
    if (!extra && this.player(player).normalSummoned && !(faceUp !== false && this.extraTributeSummon(player) && this.tributeNeed(player, card) > 0)) return false;
    if (extra && this.find(card.uid)?.loc.zone !== 'hand') return false;
    if (faceUp === true && this.summonBlocked(player, card, 'normal', 'hand')) return false;
    const info = this.info(card.name);
    if (info.kind !== 'monster' || info.sub === 'Fusion' || info.sub === 'Ritual') return false;
    if (getEffect(card.name)?.cannotNormalSummon || this.prohibited(card.name)) return false;
    if (this.chainEnergyBlocks(player)) return false;
    const plan = this.tributePlan(player, card, faceUp);
    const need = plan.need;
    const empty = this.openMonsterZones(player); // b20
    const owned = this.monsters(player).filter((m) => !this.untributable(m) && (!plan.only || plan.only(m))).length;
    if (need === 0) return empty > 0;
    if (owned < need && empty > 0 && faceUp !== false && this.tributeStandIns(player, card, need).length) return true;
    if (owned < need && faceUp !== false && this.doubleTributes(player, card).length) return true;
    return owned >= need; // tributing frees a zone
  }

  /** Tributes `player` needs to Normal Summon/Set this card (Speed Duel: less with Geartown). */
  tributeNeed(player: Pid, card: Card): number {
    return this.tributePlan(player, card).need;
  }

  /** Speed Duel: face-up monsters of `player` that can be treated as 2 Tributes for this monster (Unshaven Angler). */
  doubleTributes(player: Pid, card: Card): FieldCard[] {
    if (!this.speed) return [];
    return this.monsters(player).filter((m) => m.faceUp && this.effectOn(m)?.doubleTribute?.(this, m, card));
  }

  /** Speed Duel: `player` may Tribute Summon once more this turn (Card Advance). */
  extraTributeSummon(player: Pid): boolean {
    return this.speed && (this.state.fx.extraTribute as number[] | undefined)?.[player] === this.state.turn;
  }

  /** Ultimate Offering: Normal Summon/Set a monster right now, in addition to the usual Normal Summon. */
  *extraNormalSummon(player: Pid, uid: number, pos: Pos, faceUp: boolean): Step {
    const ps = this.player(player);
    const used = ps.normalSummoned;
    const zone = this.freeMonsterZone(player); // b20
    yield* this.summon(player, uid, zone < 0 ? 0 : zone, pos, faceUp, true);
    ps.normalSummoned = used;
  }

  /** Speed Duel: this monster cannot be Tributed (its own effect, or an equip on it: Blue Duston, Magicalized Duston Mop). */
  untributable(m: FieldCard): boolean {
    if (!this.speed) return false;
    if (m.faceUp && this.effectOn(m)?.cannotBeTributed?.(this, m)) return true;
    return m.equips.some((u) => {
      const eq = this.fieldCard(u);
      return !!eq && !(this.info(eq.name).kind === 'spell' && this.spellsNegated()) && !!getEffect(eq.name)?.cannotBeTributed?.(this, m);
    });
  }

  /** Speed Duel: active Spells/Traps that can be Tributed instead of all the monsters (Ancient Gear Castle). */
  tributeStandIns(player: Pid, card: Card, need: number): FieldCard[] {
    const st = this.liveST().filter((x) => x.p === player && x.eff.tributeFor?.(this, x.c, player, card, need)).map((x) => x.c);
    // Speed Duel: a monster that counts as several Tributes (The Trojan Horse, Double Coston).
    const mons = this.speed ? this.monsters(player).filter((m) => m.uid !== card.uid && !this.untributable(m) && this.effectOn(m)?.tributeFor?.(this, m, player, card, need)) : [];
    return [...st, ...mons];
  }

  private *summon(player: Pid, uid: number, zone: number, pos: Pos, faceUp: boolean, extra = false): Step {
    const f = this.find(uid);
    if (!f || f.loc.zone !== 'hand' || f.loc.player !== player) return;
    if (!this.canNormalSummon(player, f.card, faceUp, extra)) return;
    const ps = this.player(player);
    const usesExtra = !extra && ps.normalSummoned;
    if (!faceUp && this.trapActive('Light of Intervention')) {
      faceUp = true;
      pos = 'def';
      this.log(player, 'Light of Intervention: the monster must be Summoned face-up');
    }
    const plan = this.tributePlan(player, f.card, faceUp);
    const need = plan.need;
    const fodder = plan.only ? this.monsters(player).filter(plan.only) : this.monsters(player);
    if (faceUp && this.summonBlocked(player, f.card, 'normal', 'hand')) {
      this.log(player, `${f.card.name} cannot be Normal Summoned right now`);
      return;
    }
    if (need > 0) {
      const standIns = faceUp ? this.tributeStandIns(player, f.card, need) : [];
      let standIn: FieldCard | null = null;
      if (standIns.length && (this.monsters(player).filter((m) => !this.untributable(m)).length < need || (yield* this.yesno(player, `Tribute ${standIns[0].name} instead of ${need} monster${need > 1 ? 's' : ''}?`)))) standIn = standIns[0];
      const doubles = faceUp && need === 2 && !standIn ? this.doubleTributes(player, f.card) : [];
      let double: FieldCard | null = null;
      if (doubles.length && (this.monsters(player).length < need || (yield* this.yesno(player, `Tribute ${doubles[0].name} as 2 Tributes?`)))) {
        const k = doubles.length === 1 ? [0] : yield* this.select(player, 'Tribute which monster as 2 Tributes?', this.optionsFor(doubles), 1, 1);
        double = doubles[k?.[0] ?? 0] ?? null;
      }
      if (standIn) {
        yield* this.sendToGrave(standIn.uid, 'tribute');
        this.log(player, `${ps.name} Tributed ${standIn.name}`);
      } else if (double) {
        yield* this.sendToGrave(double.uid, 'tribute');
        this.log(player, `${ps.name} Tributed ${double.name} as 2 Tributes`);
      } else {
        const pool = fodder.filter((m) => !this.untributable(m));
        if (pool.length < need) return;
        const picks = yield* this.select(player, `Choose ${need} monster${need > 1 ? 's' : ''} to Tribute`, this.optionsFor(pool, true), need, need, true);
        if (!picks) return;
        const tributes = picks.map((i) => pool[i].uid);
        const self = this;
        yield* this.together((function* (): Step {
          for (const t of tributes) {
            const name = self.find(t)?.card.name;
            yield* self.sendToGrave(t, 'tribute');
            self.log(player, `${ps.name} Tributed ${name}`);
          }
        })());
      }
      if (!this.monsterZoneOpen(player, zone)) zone = this.freeMonsterZone(player); // b20
    }
    // b20: a blocked zone (Ojama Knight) cannot take the monster: use another open one.
    if (zone >= 0 && zone < ps.mz.length && ps.mz[zone] === null && this.mzBlocked(player, zone)) zone = this.freeMonsterZone(player);
    if (zone < 0 || zone >= ps.mz.length || ps.mz[zone] !== null) return;
    const card = this.detach(uid)!;
    const fc = this.toField(card, faceUp ? pos : 'def', faceUp);
    ps.mz[zone] = fc;
    ps.normalSummoned = true;
    if (usesExtra) (this.state.fx.extraTribute as number[])[player] = -1;
    yield* this.chainEnergy(player);
    this.event(faceUp ? 'summon' : 'set', { uid, player });
    if (faceUp) {
      this.log(player, `${ps.name} ${need ? 'Tribute ' : ''}Summoned ${card.name}${pos === 'def' ? ' in Defense Position' : ''}`);
      yield* this.responseWindow('summon', { uid, summonKind: 'normal' });
      const eff = this.effectOn(fc);
      if (eff?.onSummon && this.fieldCard(uid)) yield* this.as(player, eff.onSummon(this, fc, player, 'normal'));
      if (this.fieldCard(uid)) yield* this.anySummon(fc, player, 'normal');
    } else {
      this.log(player, `${ps.name} Set a monster`);
      for (const x of this.liveST()) if (x.eff.onAnySet && this.fieldCard(uid)) yield* this.as(x.p, x.eff.onAnySet(this, x.c, x.p, fc, player));
    }
  }

  private *flipSummon(player: Pid, uid: number): Step {
    const m = this.fieldCard(uid);
    const f = this.find(uid);
    if (!m || !f || f.loc.zone !== 'mz' || f.loc.player !== player) return;
    if (!this.inMainPhase() || m.faceUp || m.placedTurn === this.state.turn || m.posChanged || m.attacked) return;
    if (this.summonBlocked(player, m, 'flip', 'mz')) {
      this.log(player, `${m.name} cannot be Flip Summoned right now`);
      return;
    }
    m.faceUp = true;
    m.pos = 'atk';
    m.posChanged = true;
    this.event('flip', { uid, player });
    this.log(player, `${this.player(player).name} Flip Summoned ${m.name}`);
    yield* this.responseWindow('summon', { uid, summonKind: 'flip' });
    if (this.fieldCard(uid) && (this.info(m.name).level ?? 1) <= 2 && this.trapActive('Goblin Fan')) {
      this.log(null, `Goblin Fan destroys ${m.name} before its effect can activate`);
      yield* this.destroy([uid]);
      return;
    }
    if (this.fieldCard(uid)) yield* this.flipEffect(uid, player);
    const eff = this.effectOn(m);
    if (eff?.onSummon && this.fieldCard(uid)) yield* this.as(player, eff.onSummon(this, m, player, 'flip'));
    if (this.fieldCard(uid)) yield* this.anySummon(m, player, 'flip');
    if (this.fieldCard(uid)) yield* this.positionWatch(m, player);
  }

  /** Speed Duel: active Spells/Traps that watch battle position changes (Attack the Moon!). */
  *positionWatch(m: FieldCard, controller: Pid): Step {
    for (const x of this.liveST()) if (x.eff.onAnyPositionChange && this.fieldCard(m.uid)) yield* this.as(x.p, x.eff.onAnyPositionChange(this, x.c, x.p, m, controller));
    // Face-up monsters that watch position changes too (Morpho Butterspy).
    if (this.speed)
      for (const p of [0, 1] as Pid[])
        for (const w of this.monsters(p)) {
          const h = w.faceUp ? this.effectOn(w)?.onAnyPositionChange : undefined;
          if (h && this.fieldCard(m.uid) && this.fieldCard(w.uid)) yield* this.as(p, h(this, w, p, m, controller));
        }
  }

  /** Chain Energy: a player with 500 LP or less cannot play cards from the hand. */
  chainEnergyBlocks(player: Pid): boolean {
    return !!this.spellActive('Chain Energy') && this.player(player).lp <= 500;
  }

  /** Chain Energy: 500 LP for each card played from the hand. */
  *chainEnergy(player: Pid): Step {
    if (this.spellActive('Chain Energy')) {
      this.log(player, 'Chain Energy: 500 LP');
      this.payLp(player, 500);
    }
  }

  /** Special Summon procedures from the hand (Gate Guardian, Toons, Valkyrion...). */
  canSpecialProc(player: Pid, card: Card): boolean {
    if (!this.inMainPhase() || this.state.turnPlayer !== player || this.state.prompt) return false;
    const f = this.find(card.uid);
    if (!f || f.loc.player !== player || (f.loc.zone !== 'hand' && f.loc.zone !== 'fusion') || this.prohibited(card.name)) return false;
    const proc = this.procFor(card, f.loc.zone);
    if (this.chainEnergyBlocks(player)) return false;
    if (proc && this.summonBlocked(player, card, 'special', f.loc.zone)) return false;
    return !!proc && proc.can(this, card, player);
  }

  /** The summon procedure for a card in the hand (its script) or the Extra Deck (Xyz/Synchro/Link Summons, or its script). */
  private procFor(card: Card, zone: string) {
    const eff = getEffect(card.name);
    if (zone === 'hand') return eff?.summonProc;
    if (zone !== 'fusion' || !this.speed) return undefined;
    return eff?.extraProc ?? extraProcFor(this, card.name);
  }

  /** Fusion, Xyz, Synchro and Link Monsters live in the Extra Deck and go back there instead of the hand or Deck. */
  isExtraCard(name: string): boolean {
    return ['Fusion', 'Xyz', 'Synchro', 'Link'].includes(this.info(name).sub);
  }

  /** An Xyz Monster's Xyz Materials. */
  matsOf(m: Card): Card[] {
    return (m as FieldCard).mats ?? [];
  }

  /** Attaches a card (from anywhere) to an Xyz Monster as an Xyz Material. */
  attachMat(xyz: FieldCard, uid: number): boolean {
    if (!this.fieldCard(xyz.uid) || this.info(xyz.name).sub !== 'Xyz' || uid === xyz.uid) return false;
    const f = this.find(uid);
    if (!f) return false;
    const fc = ['mz', 'sz', 'field'].includes(f.loc.zone) ? (f.card as FieldCard) : null;
    const carried = fc?.mats?.splice(0) ?? [];
    const card = this.detach(uid);
    if (!card || card.token) return false;
    if (fc) this.leftField(fc, f.loc.player, 'material');
    (xyz.mats ??= []).push(card, ...carried);
    this.event('attach', { uid: xyz.uid, player: this.controller(xyz.uid) ?? xyz.owner });
    return true;
  }

  /** Detaches Xyz Materials to the GY (a cost or effect). The player picks which when there is a choice. Returns false if there are too few. */
  *detachMats(xyz: FieldCard, n: number, player?: Pid): Generator<Prompt, boolean, Choice> {
    const mats = xyz.mats ?? [];
    if (mats.length < n) return false;
    let chosen = mats.slice(0, n);
    if (mats.length > n && player !== undefined) {
      const picks = yield* this.select(player, `Detach ${n} Xyz Material${n > 1 ? 's' : ''} from ${xyz.name}`, mats.map((c) => ({ label: c.name, uid: c.uid })), n, n, false);
      if (picks?.length === n) chosen = picks.map((i) => mats[i]);
    }
    xyz.mats = mats.filter((c) => !chosen.includes(c));
    for (const c of chosen) this.player(c.owner).gy.push(c);
    this.log(this.controller(xyz.uid) ?? xyz.owner, `${xyz.name} detaches ${chosen.map((c) => c.name).join(', ')}`);
    const fx = (this.state.fx.detached ??= {}) as Record<number, number>;
    fx[xyz.uid] = this.state.turn;
    const by = this.controller(xyz.uid) ?? xyz.owner;
    for (const c of chosen) yield* this.graveWatch({ card: c, from: 'mz', controller: by, reason: 'detached', byBattle: false, faceUp: true, race: this.info(c.name).race ?? '', toGy: true, token: false, by });
    return true;
  }

  /**
   * An Xyz, Synchro or Link Summon: the materials leave the field (Xyz Materials go under the
   * new monster, the rest go to the GY), then the monster is Special Summoned from the Extra Deck.
   */
  *extraSummon(player: Pid, uid: number, materials: number[], kind: 'Xyz' | 'Synchro' | 'Link'): Step {
    const f = this.find(uid);
    if (!f || f.loc.zone !== 'fusion') return;
    const ps = this.player(player);
    if (kind === 'Xyz') {
      const under: Card[] = [];
      for (const m of materials) {
        const at = this.find(m);
        if (!at) continue;
        const fc = at.card as FieldCard;
        const carried = fc.mats?.splice(0) ?? [];
        const card = this.detach(m);
        if (!card) continue;
        this.leftField(fc, at.loc.player, 'material');
        if (!card.token) under.push(card);
        under.push(...carried);
      }
      yield* this.flushLeaves();
      this.log(player, `${ps.name} Xyz Summons ${f.card.name} using ${under.map((c) => c.name).join(', ')}`);
      yield* this.specialSummon(uid, player, 'atk', true, (fc) => ((fc.mats = under), ((fc.tags ??= {}).xyzS = 1)));
      return;
    }
    const names = materials.map((m) => this.find(m)?.card.name ?? '?');
    for (const m of materials) if (this.fieldCard(m)) yield* this.sendToGrave(m, 'material');
    this.log(player, `${ps.name} ${kind} Summons ${f.card.name} using ${names.join(', ')}`);
    yield* this.specialSummon(uid, player, 'atk', true, (fc) => ((fc.tags ??= {})[kind === 'Synchro' ? 'synS' : 'linkS'] = 1));
  }

  private *specialProc(player: Pid, uid: number): Step {
    const f = this.find(uid);
    if (!f || !this.canSpecialProc(player, f.card)) return;
    const fromHand = f.loc.zone === 'hand';
    yield* this.as(player, this.procFor(f.card, f.loc.zone)!.run(this, f.card, player));
    // Chain Energy charges for a card Special Summoned from the hand.
    if (fromHand && this.find(uid)?.loc.zone === 'mz') yield* this.chainEnergy(player);
  }

  /** Ignition effects of face-up monsters (Cannon Soldier, Time Wizard...). */
  canUseMonsterEffect(player: Pid, m: Card): boolean {
    if (!this.inMainPhase() || this.state.turnPlayer !== player || this.state.prompt) return false;
    const f = this.find(m.uid);
    if (!f || f.loc.player !== player || this.prohibited(m.name, m.uid)) return false;
    const eff = this.effectOn(m);
    if (f.loc.zone === 'hand') return !!eff?.handIgnition && eff.handIgnition.can(this, m, player);
    const fc = m as FieldCard;
    if (!eff?.ignition || !fc.faceUp || fc.effectUsed) return false;
    if (f.loc.zone !== 'mz') {
      if (!fc.active) return false;
      const kind = this.info(m.name).kind;
      if ((kind === 'spell' && this.spellsNegated()) || (kind === 'trap' && this.trapsNegated(m.name))) return false;
    }
    return eff.ignition.can(this, fc, player);
  }

  private *monsterEffect(player: Pid, uid: number): Step {
    const f = this.find(uid);
    if (!f || !this.canUseMonsterEffect(player, f.card)) return;
    const eff = getEffect(f.card.name)!;
    this.log(player, `${f.card.name}'s effect activates`);
    if (f.loc.zone === 'hand') return yield* this.as(player, eff.handIgnition!.run(this, f.card, player));
    const m = f.card as FieldCard;
    if (!eff.ignition!.repeat) m.effectUsed = true;
    if (this.speed && f.loc.zone === 'mz' && eff.ignition!.chain !== false) {
      // Speed Duel: the effect goes on a chain the opponent can respond to (targets and costs happen as it resolves).
      const link: ChainLink = { card: m, loc: f.loc, player, label: m.name, negated: false, payload: { effect: 'ignition' } };
      this.state.chain.push(link);
      this.event('activate', { uid, player });
      yield* this.responseWindow('effect', { uid, link });
      yield* this.resolveChain();
      return;
    }
    yield* this.as(player, eff.ignition!.run(this, m, player));
  }

  *flipEffect(uid: number, controller: Pid): Step {
    const m = this.fieldCard(uid);
    if (!m) return;
    const eff = getEffect(m.name);
    if (eff?.flip) {
      this.log(controller, `${m.name}'s FLIP effect activates`);
      yield* this.as(controller, eff.flip(this, m, controller));
    }
  }

  canChangePosition(player: Pid, m: FieldCard): boolean {
    if (!this.inMainPhase() || !m.faceUp || m.placedTurn === this.state.turn || m.posChanged || m.attacked || m.cannotChangePos) return false;
    if (this.state.fx.mesmeric === player + 10 * this.state.turn) return false;
    if ((m.tags?.lockPosTurn ?? -1) === this.state.turn) return false;
    if (this.raceOf(m) === 'Dragon' && this.trapActive('Dragon Capture Jar')) return false;
    return true;
  }

  private *changePosition(player: Pid, uid: number): Step {
    const m = this.fieldCard(uid);
    const f = this.find(uid);
    if (!m || !f || f.loc.zone !== 'mz' || f.loc.player !== player) return;
    if (!this.canChangePosition(player, m)) return;
    m.pos = m.pos === 'atk' ? 'def' : 'atk';
    m.posChanged = true;
    this.event('position', { uid, player });
    this.log(player, `${m.name} changed to ${m.pos === 'atk' ? 'Attack' : 'Defense'} Position`);
    const eff = this.effectOn(m);
    if (eff?.onPositionChange) yield* this.as(player, eff.onPositionChange(this, m, player));
    if (this.fieldCard(uid)) yield* this.positionWatch(m, player);
  }

  canSet(player: Pid, card: Card): boolean {
    if (!this.inMainPhase() || this.state.turnPlayer !== player) return false;
    const info = this.info(card.name);
    if (info.kind === 'monster' || info.sub === 'Ticket' || this.prohibited(card.name)) return false;
    if (this.chainEnergyBlocks(player)) return false;
    if (info.sub === 'Field') return !this.player(player).field;
    return this.player(player).sz.some((z) => z === null);
  }

  private setSpellTrap(player: Pid, uid: number, zone: number) {
    const f = this.find(uid);
    if (!f || f.loc.zone !== 'hand' || f.loc.player !== player || !this.canSet(player, f.card)) return;
    const ps = this.player(player);
    const info = this.info(f.card.name);
    if (info.sub === 'Field') {
      if (ps.field) return;
      const card = this.detach(uid)!;
      ps.field = this.toField(card, 'atk', false);
    } else {
      if (zone < 0 || zone >= ps.sz.length || ps.sz[zone] !== null) zone = ps.sz.findIndex((z) => z === null);
      if (zone < 0) return;
      const card = this.detach(uid)!;
      ps.sz[zone] = this.toField(card, 'atk', false);
    }
    this.event('set', { uid, player });
    this.log(player, `${ps.name} Set a card`);
    this.run(this.chainEnergy(player));
  }

  /** Whether a spell/trap can be activated by its controller right now, at spell speed 1 (Main Phase). */
  canActivateMain(player: Pid, uid: number): boolean {
    if (!this.inMainPhase() || this.state.turnPlayer !== player || this.state.prompt) return false;
    const f = this.find(uid);
    if (!f || f.loc.player !== player) return false;
    const info = this.info(f.card.name);
    const eff = getEffect(f.card.name);
    if (!eff?.resolve || this.prohibited(f.card.name, f.card.uid) || this.activationBlocked(player, f.card)) return false;
    if (eff.activateCost && !eff.activateCost.can(this, f.card, player)) return false;
    if (f.loc.zone === 'hand' && this.chainEnergyBlocks(player)) return false;
    if (info.kind === 'spell') {
      if (this.spellsSealed() || this.activationLocked(player, 'spell') || this.cardActivationLocked(player, f.card)) return false;
      if (this.trapActive('Anti-Spell Fragrance')) {
        if (f.loc.zone === 'hand') return false;
        if ((f.card as FieldCard).placedTurn === this.state.turn) return false;
      }
      if (f.loc.zone === 'hand' && !this.player(player).sz.some((z) => z === null) && info.sub !== 'Field') return false;
      if (f.loc.zone === 'hand' && info.sub === 'Field' && this.player(player).field) return false;
      if (f.loc.zone === 'sz' || f.loc.zone === 'field') {
        const fc = f.card as FieldCard;
        if (fc.faceUp) return false;
      } else if (f.loc.zone !== 'hand') return false;
      return eff.canActivate ? this.withActor(player, () => eff.canActivate!(this, f.card, player, 'main', {})) : true;
    }
    if (info.kind === 'trap') {
      if (f.loc.zone !== 'sz' || this.trapsSealed(player) || this.activationLocked(player, 'trap') || this.cardActivationLocked(player, f.card)) return false;
      const fc = f.card as FieldCard;
      if (fc.faceUp || fc.placedTurn === this.state.turn) return false;
      if (info.sub === 'Counter') return false;
      return eff.canActivate ? this.withActor(player, () => eff.canActivate!(this, f.card, player, 'main', {})) : true;
    }
    return false;
  }

  private *activateFromMain(player: Pid, uid: number, zone?: number): Step {
    if (!this.canActivateMain(player, uid)) return;
    const f = this.find(uid)!;
    const ps = this.player(player);
    const info = this.info(f.card.name);
    let fc: FieldCard;
    const fromHand = f.loc.zone === 'hand';
    if (((this.state.fx.borrowed ?? []) as number[]).includes(uid)) {
      this.log(player, `Graverobber: ${this.player(player).name} takes 2000 damage for using ${f.card.name}`);
      this.damage(player, 2000);
      this.state.fx.borrowed = (this.state.fx.borrowed as number[]).filter((u) => u !== uid);
      if (this.state.winner !== null) return;
    }
    const cost = getEffect(f.card.name)?.activateCost;
    if (cost) {
      const prev = this.actor;
      this.actor = player;
      const ok = yield* cost.pay(this, f.card, player);
      this.actor = prev;
      if (ok === false) return;
    }
    if (f.loc.zone === 'hand') {
      const card = this.detach(uid)!;
      if (info.sub === 'Field') {
        fc = this.toField(card, 'atk', true);
        ps.field = fc;
      } else {
        let z = zone ?? -1;
        if (z < 0 || z >= ps.sz.length || ps.sz[z] !== null) z = ps.sz.findIndex((s) => s === null);
        fc = this.toField(card, 'atk', true);
        ps.sz[z] = fc;
      }
    } else {
      fc = f.card as FieldCard;
      fc.faceUp = true;
    }
    if (fromHand) yield* this.chainEnergy(player);
    yield* this.startChain(player, fc, 'main', {});
  }

  // ---------- chains ----------
  /** Activates a card as a new chain link, lets the opponent respond, then resolves. */
  *startChain(player: Pid, fc: FieldCard, trigger: Trigger, ctx: ChainCtx): Step {
    const eff = getEffect(fc.name)!;
    const link: ChainLink = { card: fc, loc: this.find(fc.uid)!.loc, player, label: fc.name, negated: false };
    this.event('activate', { uid: fc.uid, player });
    this.log(player, `${this.player(player).name} activates ${fc.name}`);
    if (eff.activate) {
      const prev = this.actor;
      this.actor = player;
      const ok = yield* eff.activate(this, link, player, ctx);
      this.actor = prev;
      if (ok === false) {
        // No legal target after all: the card fizzles and goes to the GY.
        yield* this.afterResolve(link);
        return;
      }
    }
    this.state.chain.push(link);
    yield* this.responseWindow(this.info(fc.name).kind === 'spell' ? 'spell' : 'trap', { uid: fc.uid, link });
    yield* this.resolveChain();
  }

  private *resolveChain(): Step {
    this.resolving++;
    const prevSource = this.levelSource;
    try {
      while (this.state.chain.length > 0 && this.state.winner === null) {
        const link = this.state.chain.pop()!;
        this.levelSource = link.card.uid;
        if (this.speed && !link.negated) yield* this.chainLinkWatch(link);
        const effectLink = (link.payload as { effect?: string } | undefined)?.effect;
        const eff = (effectLink ? this.copiedEffect(link.card) : undefined) ?? getEffect(link.card.name); // b20: copied effects (Arcana Call)
        // Speed Duel: face-up monsters that negate effects as they resolve (The End of Anubis).
        if (!link.negated && this.speed && ([0, 1] as Pid[]).some((q) => this.monsters(q).some((m) => m.faceUp && this.effectOn(m)?.negatesEffect?.(this, m, q, link) === true))) link.negated = true;
        if (effectLink) {
          // A monster's (or card's) activated effect, not the activation of a Spell/Trap card.
          if (!link.negated && this.liveST().some((x) => x.eff.negatesEffect?.(this, x.c, x.p, link) === true)) link.negated = true;
          if (link.negated) this.log(link.player, `${link.card.name}'s effect was negated`);
          else if (effectLink === 'quick' && eff?.quick) yield* this.as(link.player, eff.quick.run(this, link.card, link.player, link));
          else if (effectLink === 'ignition' && eff?.ignition && this.fieldCard(link.card.uid)) yield* this.as(link.player, eff.ignition.run(this, link.card as FieldCard, link.player));
          continue;
        }
        const stillThere = this.fieldCard(link.card.uid);
        const kind = this.info(link.card.name).kind;
        if (!link.negated && kind === 'spell' && this.spellsNegated()) link.negated = true;
        if (!link.negated && kind === 'trap' && this.trapsNegated(link.card.name)) link.negated = true;
        if (link.negated) {
          this.log(link.player, `${link.card.name}'s effect was negated`);
        } else if (eff?.resolve && stillThere) {
          yield* this.as(link.player, eff.resolve(this, link, link.player));
        }
        yield* this.afterResolve(link);
      }
    } finally {
      this.resolving--;
      this.levelSource = prevSource;
    }
    this.state.chain = [];
    yield* this.flushLeaves();
    yield* this.damageWindow(false);
    yield* this.flushSummonWindows();
  }

  /** Speed Duel: face-up monsters see each chain link right before it resolves (Freed the Matchless General, Angel O7). */
  private *chainLinkWatch(link: ChainLink): Step {
    for (const p of [0, 1] as Pid[]) {
      for (const m of this.monsters(p)) {
        if (link.negated || this.state.winner !== null || !m.faceUp || !this.fieldCard(m.uid)) continue;
        const h = this.effectOn(m)?.onChainLink;
        if (h) yield* this.as(p, h(this, m, p, link));
      }
    }
  }

  /** After damage is dealt, Numinous Healer and Sebek's Blessing may respond. */
  *damageWindow(direct: boolean): Step {
    const hurt = (this.state.fx.hurt ?? [0, 0]) as number[];
    if (this.state.winner !== null || this.state.fx.inDamageWindow) return;
    for (const p of [0, 1] as Pid[]) {
      const amount = hurt[p];
      if (!amount) continue;
      hurt[p] = 0;
      this.state.fx.inDamageWindow = true;
      try {
        yield* this.responseWindow('damage', { damaged: p, amount, direct });
      } finally {
        this.state.fx.inDamageWindow = false;
      }
    }
  }

  private *afterResolve(link: ChainLink): Step {
    const fc = this.fieldCard(link.card.uid);
    if (!fc) return;
    const info = this.info(fc.name);
    const stays = info.sub === 'Continuous' || info.sub === 'Equip' || info.sub === 'Field';
    if (stays && !link.negated) {
      fc.active = true;
      if (info.sub === 'Equip' && fc.equippedTo === undefined) yield* this.sendToGrave(fc.uid, 'used');
      return;
    }
    // A Normal Spell/Trap whose effect keeps it on the field: a countdown (Swords of
    // Revealing Light) or a card that attached itself to a monster.
    if (!link.negated && fc.active && (fc.turns !== undefined || fc.equippedTo !== undefined)) return;
    yield* this.sendToGrave(fc.uid, 'used');
  }

  /** Gives each player (opponent first) a chance to respond with a set card. Up to 3 responses, like EDS. */
  *responseWindow(trigger: Trigger, ctx: ChainCtx): Step {
    const rootHasLink = !!ctx.link;
    let responder: Pid = other(this.state.turnPlayer);
    if (ctx.link) responder = other(ctx.link.player);
    let passes = 0;
    let depth = 0;
    while (passes < 2 && depth < 3 && this.state.winner === null) {
      const options = this.responsesFor(responder, trigger, ctx);
      if (options.length === 0) {
        passes++;
        responder = other(responder);
        continue;
      }
      const choice = yield { kind: 'response', player: responder, title: this.responseTitle(trigger, ctx), options };
      if (typeof choice === 'object' && 'picks' in choice && choice.picks.length > 0) {
        const opt = options[choice.picks[0]];
        if (opt && opt.value === 'quick') {
          const link = yield* this.activateQuick(responder, opt.uid!, trigger, ctx);
          if (link) {
            depth++;
            passes = 0;
            ctx = { ...ctx, link };
            trigger = 'effect';
            responder = other(responder);
            continue;
          }
          passes++;
          responder = other(responder);
          continue;
        }
        const fc = opt ? this.fieldCard(opt.uid!) : null;
        if (fc) {
          fc.faceUp = true;
          const eff = getEffect(fc.name)!;
          const link: ChainLink = { card: fc, loc: this.find(fc.uid)!.loc, player: responder, label: fc.name, negated: false };
          this.event('activate', { uid: fc.uid, player: responder });
          this.log(responder, `${this.player(responder).name} activates ${fc.name}`);
          const prev = this.actor;
          this.actor = responder;
          const ok = eff.activate ? yield* eff.activate(this, link, responder, ctx) : true;
          this.actor = prev;
          if (ok === false) {
            yield* this.afterResolve(link);
          } else {
            this.state.chain.push(link);
            depth++;
            passes = 0;
            ctx = { ...ctx, link };
            trigger = this.info(fc.name).kind === 'spell' ? 'spell' : 'trap';
            responder = other(responder);
            continue;
          }
        }
      }
      passes++;
      responder = other(responder);
    }
    if (!rootHasLink && this.state.chain.length > 0) yield* this.resolveChain();
  }

  private responseTitle(trigger: Trigger, ctx: ChainCtx): string {
    switch (trigger) {
      case 'summon':
      case 'special':
        return `${this.find(ctx.uid!)?.card.name ?? 'A monster'} was Summoned. Respond?`;
      case 'effect':
        return `${ctx.link?.card.name ?? 'A card'}'s effect was activated. Respond?`;
      case 'attack':
        return `${this.find(ctx.uid!)?.card.name ?? 'A monster'} attacks. Respond?`;
      case 'spell':
      case 'trap':
        return `${ctx.link?.card.name ?? 'A card'} was activated. Respond?`;
      case 'damage':
        return `${this.player(ctx.damaged ?? 0).name} took ${ctx.amount ?? 0} damage. Respond?`;
      case 'destroyed':
        return `${this.find(ctx.uid!)?.card.name ?? 'A monster'} was destroyed in battle. Respond?`;
      default:
        return 'Respond?';
    }
  }

  /** Cards with a Quick Effect this player could use right now (Speed Duel scripts). */
  private quickOptions(player: Pid, trigger: Trigger, ctx: ChainCtx, activeSpellsOnly = false): SelectOption[] {
    const out: SelectOption[] = [];
    const ps = this.player(player);
    const consider = (c: Card, from: 'field' | 'hand' | 'gy' | 'extra') => {
      const q = (from === 'field' ? this.effectOn(c) : getEffect(c.name))?.quick;
      if (!q || (q.from ?? 'field') !== from || this.prohibited(c.name, from === 'field' ? c.uid : undefined)) return;
      if (from === 'field') {
        const fc = c as FieldCard;
        if (!fc.faceUp) return;
        const kind = this.info(c.name).kind;
        if (kind !== 'monster' && !fc.active) return;
        if ((kind === 'spell' && this.spellsNegated()) || (kind === 'trap' && this.trapsNegated(c.name))) return;
      }
      if (!q.repeat && !this.oncePerTurn(`quick:${c.name}:${from === 'field' ? c.uid : 0}`, player)) return;
      if (this.activationBlocked(player, c)) return;
      if (!q.can(this, c, player, trigger, ctx)) return;
      out.push({ label: q.label ? `${c.name}: ${q.label}` : `${c.name}'s effect`, uid: c.uid, loc: this.find(c.uid)!.loc, value: 'quick' });
    };
    if (!activeSpellsOnly) for (const m of this.monsters(player)) consider(m, 'field');
    for (const c of this.activeSpells(player)) consider(c, 'field');
    if (activeSpellsOnly) return out;
    for (const c of ps.hand) consider(c, 'hand');
    for (const c of ps.gy) consider(c, 'gy');
    for (const c of ps.fusion) consider(c, 'extra');
    return out;
  }

  /** Pays the cost of a Quick Effect and puts it on the chain. */
  private *activateQuick(player: Pid, uid: number, trigger: Trigger, ctx: ChainCtx): Generator<Prompt, ChainLink | null, Choice> {
    const f = this.find(uid);
    if (!f) return null;
    const q = (this.copiedEffect(f.card) ?? getEffect(f.card.name))?.quick; // b20: copied effects (Arcana Call)
    if (!q) return null;
    const from = q.from ?? 'field';
    const link: ChainLink = { card: f.card, loc: f.loc, player, label: f.card.name, negated: false, payload: { effect: 'quick', trigger, ctx } };
    this.event('activate', { uid, player });
    this.log(player, `${this.player(player).name} activates ${f.card.name}'s effect`);
    if (q.cost) {
      const prev = this.actor;
      this.actor = player;
      const ok = yield* q.cost(this, f.card, player, link, ctx);
      this.actor = prev;
      if (ok === false) return null;
    }
    if (!q.repeat) this.useOnce(`quick:${f.card.name}:${from === 'field' ? uid : 0}`, player);
    this.state.chain.push(link);
    return link;
  }

  /** Set spells/traps the player could activate right now against the trigger. */
  responsesFor(player: Pid, trigger: Trigger, ctx: ChainCtx): SelectOption[] {
    const out: SelectOption[] = this.speed ? this.quickOptions(player, trigger, ctx) : [];
    const sealed = this.attackSealed(player);
    for (const fc of this.spells(player)) {
      if (fc.faceUp || sealed) continue;
      const info = this.info(fc.name);
      const eff = getEffect(fc.name);
      if (!eff?.resolve || !eff.canActivate || this.prohibited(fc.name, fc.uid) || this.activationBlocked(player, fc)) continue;
      if ((info.kind === 'spell' || info.kind === 'trap') && (this.activationLocked(player, info.kind) || this.cardActivationLocked(player, fc))) continue;
      if (info.kind === 'trap' && (fc.placedTurn === this.state.turn || this.trapsSealed(player))) continue;
      if (info.kind === 'spell' && (info.sub !== 'Quick-Play' || this.spellsSealed())) continue;
      if (info.kind === 'spell' && fc.placedTurn === this.state.turn) continue;
      if (this.withActor(player, () => eff.canActivate!(this, fc, player, trigger, ctx))) out.push({ label: fc.name, uid: fc.uid, loc: this.find(fc.uid)!.loc });
    }
    // EDS: effects of face-up Continuous Spells/Traps used in response (Ultimate Offering), after the set cards.
    if (!this.speed) out.push(...this.quickOptions(player, trigger, ctx, true));
    return out;
  }

  /** Speed Duel: the attacking monster stops `player` from activating Spell/Trap Cards until the end of the Damage Step (Ancient Gear Golem). */
  attackSealed(player: Pid): boolean {
    const b = this.state.battle;
    if (!this.speed || !b) return false;
    const a = this.fieldCard(b.attacker);
    if (!a || !a.faceUp || this.controller(a.uid) === player) return false;
    const h = this.effectOn(a)?.attackSealsST;
    return typeof h === 'function' ? h(this, a) : !!h;
  }

  // ---------- battle ----------
  canAttackWith(player: Pid, m: FieldCard): boolean {
    const s = this.state;
    if (s.phase !== 'BP' || s.turnPlayer !== player || s.firstTurn) return false;
    const eff = this.effectOn(m);
    if (!m.faceUp || m.cannotAttack) return false;
    if (m.attacked && (m.tags?.attacksMade ?? 1) >= (eff?.attacks?.(this, m) ?? 1) + this.extraAttacks(m)) return false;
    if (this.speed && this.noDirectAttack(m) && this.monsters(other(player)).length === 0) return false;
    if (m.pos !== 'atk' && !eff?.attackInDefense) return false;
    if (eff?.cannotAttack?.(this, m, player)) return false;
    if ((m.tags?.noAttackTurn ?? -1) === s.turn) return false;
    // Speed Duel: "you cannot declare an attack / conduct your Battle Phase this turn" (Soul Exchange, Destiny HERO - Doom Lord).
    if (this.speed && ((s.fx.noDeclare ?? []) as number[])[player] === s.turn) return false;
    const ill = m.tags?.illusionBy;
    if (ill && this.fieldCard(ill)?.faceUp) return false;
    // Swords of Revealing Light on the opponent's side stops attacks.
    if (!this.spellsNegated()) for (const c of this.spells(other(player))) if (c.faceUp && c.active && getEffect(c.name)?.blocksAttacks) return false;
    for (const p of [0, 1] as Pid[]) {
      for (const c of this.activeSpells(p)) {
        const ce = getEffect(c.name);
        if (!ce) continue;
        const kind = this.info(c.name).kind;
        if ((kind === 'spell' && this.spellsNegated()) || (kind === 'trap' && this.trapsNegated(c.name))) continue;
        if (ce.blocksAttack?.(this, c, m, player)) return false;
        if (ce.attackTax && !ce.attackTax.can(this, c, m, player)) return false;
      }
    }
    for (const uid of m.equips) {
      const eq = this.fieldCard(uid);
      if (eq && getEffect(eq.name)?.hostCannotAttack?.(this, eq, m)) return false;
    }
    if (eff?.attackCost && !eff.attackCost.can(this, m, player)) return false;
    return true;
  }

  canAttackDirectly(m: FieldCard): boolean {
    if (this.speed && m.tags?.directTurn === this.state.turn) return true;
    const d = this.effectOn(m)?.directAttack;
    if (typeof d === 'function') {
      const ctl = this.controller(m.uid);
      return ctl !== null && d(this, m, ctl);
    }
    return !!d;
  }

  /** Monsters this attacker may choose as its target (Ring of Magnetism, Toons). */
  legalTargets(player: Pid, m: FieldCard): FieldCard[] {
    let list = this.monsters(other(player));
    if (!this.spellsNegated()) {
      const ring = list.filter((t) => t.equips.some((u) => this.fieldCard(u)?.name === 'Ring of Magnetism'));
      if (ring.length) list = ring;
    }
    const f = this.effectOn(m)?.targetFilter;
    if (f) list = list.filter((t) => f(this, m, t));
    list = list.filter((t) => !(t.faceUp && this.effectOn(t)?.cannotBeAttacked?.(this, t, m)));
    // Speed Duel: another face-up card of the defender keeps it from being chosen (Magician's Valkyria, Corrosive Scales).
    if (this.speed) {
      const guards = [...this.monsters(other(player)).filter((g) => g.faceUp), ...this.activeSpells(other(player))];
      list = list.filter((t) => !guards.some((g) => g.uid !== t.uid && this.effectOn(g)?.guardsFromAttack?.(this, g, t, m) === true));
    }
    if (this.speed) {
      const guards: { src: FieldCard; p: Pid; eff: EffectDef }[] = [];
      for (const p of [0, 1] as Pid[]) {
        for (const src of this.monsters(p)) {
          const eff = src.faceUp ? this.effectOn(src) : undefined;
          if (eff?.attackGuard) guards.push({ src, p, eff });
        }
        for (const x of this.liveST()) if (x.p === p && x.eff.attackGuard) guards.push({ src: x.c, p, eff: x.eff });
      }
      const lingering = this.lingering().filter((l) => l.eff.lingering?.attackGuard);
      if (guards.length || lingering.length) list = list.filter((t) => !guards.some((g) => g.eff.attackGuard!(this, g.src, g.p, m, t)) && !lingering.some((l) => l.eff.lingering!.attackGuard!(this, l.p, m, t)));
    }
    // Speed Duel: a face-up monster guarding the others (Marauding Captain).
    if (this.speed) list = list.filter((t) => !this.monsters(other(player)).some((g) => g.faceUp && this.effectOn(g)?.guardsAttack?.(this, g, t, m)));
    // Speed Duel: other face-up cards keeping attacks off a monster (Prickle Fairy, Hero Ring).
    if (this.speed) {
      const guards = this.liveCards().filter((x) => x.eff.guardsTarget);
      if (guards.length) list = list.filter((t) => !guards.some((x) => x.eff.guardsTarget!(this, x.c, x.p, t, m)));
    }
    return list;
  }

  private *attack(player: Pid, uid: number, targetUid: number | null): Step {
    const m = this.fieldCard(uid);
    const f = this.find(uid);
    if (!m || !f || f.loc.zone !== 'mz' || f.loc.player !== player || !this.canAttackWith(player, m)) return;
    const opp = other(player);
    const oppMonsters = this.monsters(opp);
    if (targetUid === null && oppMonsters.length > 0 && !this.canAttackDirectly(m)) return;
    if (targetUid === null && this.speed && this.noDirectAttack(m)) return;
    if (targetUid !== null && !this.legalTargets(player, m).some((t) => t.uid === targetUid)) return;
    const eff0 = getEffect(m.name);
    const cost = eff0?.attackCost;
    if (cost) yield* this.as(player, cost.pay(this, m, player));
    for (const p of [0, 1] as Pid[]) {
      for (const c of this.activeSpells(p)) {
        const tax = getEffect(c.name)?.attackTax;
        const kind = this.info(c.name).kind;
        if ((kind === 'spell' && this.spellsNegated()) || (kind === 'trap' && this.trapsNegated(c.name))) continue;
        if (tax) yield* this.as(p, tax.pay(this, c, m, player));
      }
    }
    if (this.state.winner !== null || !this.fieldCard(uid)) return;
    if (eff0?.attacks || this.extraAttacks(m)) {
      const t = (m.tags ??= {});
      t.attacksMade = m.attacked ? (t.attacksMade ?? 1) + 1 : 1;
    }
    m.attacked = true;
    this.state.attackedThisTurn.push(uid);
    this.state.fx.battleNo = (this.state.fx.battleNo ?? 0) + 1;
    this.state.battle = { attacker: uid, target: targetUid };
    this.event('attack', { uid, player, target: targetUid });
    const targetName = targetUid !== null ? (this.fieldCard(targetUid)!.faceUp ? this.fieldCard(targetUid)!.name : 'a face-down monster') : 'directly';
    this.log(player, `${m.name} attacks ${targetName}`);
    yield* this.responseWindow('attack', { uid, targetUid: targetUid ?? undefined });
    if (this.state.winner !== null) return;
    if (!this.state.battle) return; // Waboku and friends end the battle
    targetUid = this.state.battle.target; // Magical Arm Shield can redirect it
    const attacker = this.fieldCard(uid);
    if (!attacker || this.controller(uid) !== player || (attacker.pos !== 'atk' && !getEffect(attacker.name)?.attackInDefense)) {
      this.state.battle = null;
      return; // attacker was destroyed, taken, or forced into Defense
    }
    const target = targetUid !== null ? this.fieldCard(targetUid) : null;
    if (targetUid !== null && (!target || this.controller(targetUid) === player)) {
      // Target gone (destroyed in response): the attack is stopped.
      this.state.battle = null;
      return;
    }
    yield* this.damageStep(player, attacker, target);
    this.state.battle = null;
  }

  /** Kuriboh: the defending player may discard it to take no battle damage. */
  private *kuriboh(p: Pid, amount: number): Generator<Prompt, number, Choice> {
    if (amount <= 0) return amount;
    const k = this.player(p).hand.find((c) => c.name === 'Kuriboh');
    if (!k || this.prohibited('Kuriboh')) return amount;
    const yes = yield* this.yesno(p, `Discard Kuriboh to take no damage from this attack (${amount})?`);
    if (!yes) return amount;
    yield* this.discard(p, k.uid);
    this.log(p, 'Kuriboh shields the blow');
    return 0;
  }

  /** Battle damage, with Relinquished passing it back to the opponent. */
  private battleDamage(p: Pid, amount: number, a: FieldCard, t: FieldCard | null): void {
    if (amount <= 0) return;
    for (const m of [a, t]) {
      if (!m || this.controller(m.uid) !== p) continue;
      // Speed Duel: the damage goes to the opponent instead (Magical Reflect Slime).
      if (this.speed && this.effectOn(m)?.reflectBattleDamage?.(this, m)) {
        this.log(p, `${m.name} sends the battle damage to ${this.player(other(p)).name}`);
        return this.battleDamage(other(p), amount, a, t);
      }
      // Speed Duel: an Equip Spell shielding its host's controller (Bashing Shield).
      const shieldEquip =
        this.speed &&
        m.equips.some((u) => {
          const eq = this.fieldCard(u);
          return !!eq && eq.faceUp && !(this.info(eq.name).kind === 'spell' && this.spellsNegated()) && !!getEffect(eq.name)?.hostNoBattleDamage?.(this, eq, m);
        });
      if (this.effectOn(m)?.noBattleDamage?.(this, m) || shieldEquip) {
        this.log(p, `${this.player(p).name} takes no battle damage thanks to ${m.name}`);
        return;
      }
    }
    if (this.state.fx.noBattleDamageIn?.[p] === this.state.fx.battleNo && this.state.fx.battleNo) {
      this.log(p, `${this.player(p).name} takes no battle damage from this battle`);
      return;
    }
    if (this.state.fx.noBattleDamage?.[p] === this.state.turn) {
      this.log(p, `${this.player(p).name} takes no battle damage this turn`);
      return;
    }
    this.battleHit = true;
    try {
      this.damage(p, amount);
    } finally {
      this.battleHit = false;
    }
    const reflect = [a, t].some((m) => m && m.name === 'Relinquished' && this.controller(m.uid) === p && m.tags?.absorbed);
    if (reflect && this.state.winner === null) {
      this.log(p, 'Relinquished passes the damage on');
      this.damage(other(p), amount);
    }
  }

  private *damageStep(player: Pid, attacker: FieldCard, target: FieldCard | null): Step {
    const opp = other(player);
    const aEff = this.effectOn(attacker);
    if (!target) {
      let dmg = this.atkOf(attacker) + this.attackBonus(attacker, null);
      dmg = yield* this.kuriboh(opp, dmg);
      this.event('hit', { uid: attacker.uid, player: opp });
      this.battleDamage(opp, dmg, attacker, null);
      if (dmg > 0 && this.state.winner === null) {
        if (aEff?.onBattleDamage) yield* this.as(player, aEff.onBattleDamage(this, attacker, player));
        yield* this.battleDamageDealt(player, attacker);
      }
      yield* this.damageWindow(true);
      return;
    }
    const tEff = this.effectOn(target);
    const wasFaceDown = !target.faceUp;
    if (wasFaceDown && target.pos === 'def' && tEff?.interceptAttack) {
      const prev = this.actor;
      this.actor = opp;
      const handled = yield* tEff.interceptAttack(this, target, attacker, opp);
      this.actor = prev;
      if (handled) return;
    }
    if (wasFaceDown) {
      target.faceUp = true;
      this.event('flip', { uid: target.uid, player: opp });
      this.log(opp, `${target.name} was flipped face-up`);
    }
    if (tEff?.onBeingAttacked) yield* this.as(opp, tEff.onBeingAttacked(this, target, attacker, opp));
    if (!this.fieldCard(target.uid) || !this.fieldCard(attacker.uid)) return;
    let atk = this.atkOf(attacker) + this.attackBonus(attacker, target);
    if (this.state.fx.zeroAttack === attacker.uid) {
      atk = 0;
      this.state.fx.zeroAttack = undefined;
    }
    const tAtkCalc = this.atkOf(target);
    const destroyed: number[] = [];
    if (target.pos === 'atk') {
      const tAtk = this.atkOf(target);
      this.event('hit', { uid: target.uid, player: opp });
      if (atk > tAtk) {
        destroyed.push(target.uid);
        const dmg = yield* this.kuriboh(opp, atk - tAtk);
        this.battleDamage(opp, dmg, attacker, target);
        this.log(player, `${attacker.name} destroys ${target.name}`);
        if (dmg > 0 && this.state.winner === null) {
          if (aEff?.onBattleDamage) yield* this.as(player, aEff.onBattleDamage(this, attacker, player));
          yield* this.battleDamageDealt(player, attacker);
        }
      } else if (atk < tAtk) {
        destroyed.push(attacker.uid);
        this.battleDamage(player, tAtk - atk, attacker, target);
        this.log(opp, `${target.name} destroys ${attacker.name}`);
      } else if (atk > 0) {
        destroyed.push(target.uid, attacker.uid);
        this.log(null, `${attacker.name} and ${target.name} destroy each other`);
      } else this.log(null, `${attacker.name} and ${target.name} both have 0 ATK`);
    } else {
      const mult = tEff?.defenseMult?.(this, target, attacker) ?? 1;
      const tDef = Math.floor(this.defOf(target) * mult);
      this.event('hit', { uid: target.uid, player: opp });
      if (atk > tDef) {
        destroyed.push(target.uid);
        this.log(player, `${attacker.name} destroys ${target.name}`);
        const pierce = aEff?.piercing;
        const granted = this.liveCards().some((x) => x.eff.grantsPiercing?.(this, x.c, x.p, attacker) === true);
        const tagged = this.speed && !!attacker.tags?.pierceBattle && attacker.tags.pierceBattle === this.state.fx.battleNo;
        if ((pierce && (typeof pierce !== 'function' || pierce(this, attacker))) || granted || tagged) {
          this.log(player, `${attacker.name} pierces the defense`);
          const lp = this.player(opp).lp;
          this.battleDamage(opp, atk - tDef, attacker, target);
          if (this.state.winner === null && aEff?.onBattleDamage) yield* this.as(player, aEff.onBattleDamage(this, attacker, player));
          if (this.player(opp).lp < lp) yield* this.battleDamageDealt(player, attacker);
        }
      } else if (atk < tDef) {
        this.battleDamage(player, tDef - atk, attacker, target);
        this.log(opp, `${target.name} holds; ${attacker.name}'s controller takes damage`);
      } else {
        this.log(null, `${attacker.name} bounces off ${target.name}`);
      }
    }
    if (this.state.winner !== null) return;
    yield* this.damageWindow(false);
    if (this.state.winner !== null) return;
    // Relinquished sacrifices the monster it absorbed instead.
    for (let i = 0; i < destroyed.length; i++) {
      const m = this.fieldCard(destroyed[i]);
      const sub = m ? getEffect(m.name)?.battleSubstitute?.(this, m) : undefined;
      if (sub !== undefined) destroyed[i] = sub;
    }
    const targetUid = target.uid;
    const targetDestroyed = destroyed.includes(target.uid);
    const attackerDestroyed = destroyed.includes(attacker.uid);
    const before = destroyed.map((u) => ({ uid: u, ctl: this.controller(u), pos: this.fieldCard(u)?.pos ?? 'atk' }));
    const muted = this.speed ? destroyed.filter((u) => this.battleMutes(u, u === attacker.uid ? target : attacker)) : [];
    this.state.fx.battleMuted = muted;
    yield* this.destroy(destroyed, 'destroyed', true);
    this.state.fx.battleMuted = [];
    // FLIP effects resolve after damage calculation, even if the monster is destroyed.
    if (wasFaceDown && tEff?.flip && this.speed && ((targetDestroyed && aEff?.negatesVictimFlip) || (!this.fieldCard(targetUid) && aEff?.negatesBattleFlip?.(this, attacker, target)))) {
      this.log(player, `${attacker.name} negates ${target.name}'s FLIP effect`);
    } else if (wasFaceDown && tEff?.flip && !muted.includes(targetUid)) {
      this.log(opp, `${target.name}'s FLIP effect activates`);
      yield* this.as(opp, tEff.flip(this, target, opp, !this.fieldCard(targetUid)));
    }
    if (this.state.winner !== null) return;
    for (const x of this.liveST()) if (x.eff.onBattleEnd && this.state.winner === null) yield* this.as(x.p, x.eff.onBattleEnd(this, x.c, x.p, attacker, target, atk, tAtkCalc));
    if (tEff?.onAttacked && !muted.includes(targetUid)) yield* this.as(opp, tEff.onAttacked(this, target, attacker, opp, targetDestroyed));
    if (targetDestroyed && tEff?.onDestroyedByBattle && !muted.includes(targetUid)) yield* this.as(opp, tEff.onDestroyedByBattle(this, target, opp));
    if (attackerDestroyed && aEff?.onDestroyedByBattle && !muted.includes(attacker.uid)) yield* this.as(player, aEff.onDestroyedByBattle(this, attacker, player));
    if (aEff?.afterBattle && this.fieldCard(attacker.uid)) yield* this.as(player, aEff.afterBattle(this, attacker, target, player, targetDestroyed));
    for (const uid of attacker.equips.slice()) {
      const eq = this.fieldCard(uid);
      const h = eq ? getEffect(eq.name)?.hostAfterBattle : undefined;
      if (eq && h) yield* this.as(player, h(this, eq, attacker, target));
    }
    // Speed Duel: face-up Spells/Traps that react after every battle (Amazoness Onslaught, Battleguard Rage).
    for (const p of [player, opp]) {
      for (const c of this.activeSpells(p)) {
        const h = getEffect(c.name)?.afterAnyBattle;
        const kind = this.info(c.name).kind;
        if (!h || this.state.winner !== null || !this.fieldCard(c.uid) || (kind === 'spell' && this.spellsNegated()) || (kind === 'trap' && this.trapsNegated(c.name))) continue;
        yield* this.as(p, h(this, c, p, attacker, target));
      }
    }
    for (const l of this.lingering()) {
      const h = l.eff.lingering?.afterAnyBattle;
      if (h && this.state.winner === null) yield* this.as(l.p, h(this, l.p, attacker, target));
    }
    // Time Machine and other "destroyed by battle" responses.
    for (const b of before) {
      const g = this.find(b.uid);
      if (g && g.loc.zone === 'gy' && b.ctl !== null && this.state.winner === null) yield* this.responseWindow('destroyed', { uid: b.uid, prevController: b.ctl, prevPos: b.pos });
    }
  }

  /** Dark Ruler Ha Des: is the monster `uid` (destroyed by battle with `killer`) negated? */
  private battleMutes(uid: number, killer: FieldCard): boolean {
    const victimCtl = this.controller(uid);
    const killerCtl = this.controller(killer.uid);
    if (victimCtl === null || killerCtl === null || victimCtl === killerCtl || !killer.faceUp) return false;
    return this.monsters(killerCtl).some((s) => s.faceUp && this.effectOn(s)?.negatesBattleVictims?.(this, s, killer, killerCtl) === true);
  }

  /** ATK added only while attacking (Metalmorph, Insect Soldiers of the Sky). */
  private attackBonus(attacker: FieldCard, target: FieldCard | null): number {
    let bonus = this.effectOn(attacker)?.attackBonus?.(this, attacker, target) ?? 0;
    for (const uid of attacker.equips) {
      const eq = this.fieldCard(uid);
      if (eq && !(this.info(eq.name).kind === 'trap' && this.trapsNegated())) bonus += getEffect(eq.name)?.hostAttackBonus?.(this, eq, attacker, target) ?? 0;
    }
    return bonus;
  }

  private *battleDamageDealt(player: Pid, attacker: FieldCard): Step {
    if (this.state.winner !== null) return;
    // Speed Duel: cards in the GY or banished that react to their owner's monster dealing battle damage (Djinn Prognosticator of Rituals).
    if (this.speed)
      for (const c of [...this.player(player).gy, ...this.player(player).removed]) {
        const h = getEffect(c.name)?.onAllyBattleDamageOffField;
        if (h && this.state.winner === null) yield* this.as(player, h(this, c, player, attacker));
      }
    for (const c of this.activeSpells(player)) {
      const eff = getEffect(c.name);
      const kind = this.info(c.name).kind;
      if ((kind === 'spell' && this.spellsNegated()) || (kind === 'trap' && this.trapsNegated(c.name))) continue;
      if (eff?.onBattleDamageDealt) yield* eff.onBattleDamageDealt(this, c, attacker, player);
    }
  }

  /** Special Summon straight from a list (Cyber Jar, Giant Rat...). */
  *summonFrom(uid: number, controller: Pid, pos: Pos): Step {
    yield* this.specialSummon(uid, controller, pos);
  }

  /** Negates and ends the current attack (Negate Attack). */
  endBattle() {
    this.state.battle = null;
  }

  /** Returns every card from a list to the owner's hand. */
  bounce(uids: number[]) {
    for (const uid of uids) this.toHand(uid);
  }
}

export interface ChainCtx {
  uid?: number;
  targetUid?: number;
  link?: ChainLink;
  summonKind?: 'normal' | 'flip' | 'special';
  /** 'damage' trigger: who took damage, how much, and whether from a direct attack */
  damaged?: Pid;
  amount?: number;
  direct?: boolean;
  /** 'destroyed' trigger: where the monster was */
  prevController?: Pid;
  prevPos?: Pos;
}

export { PHASE_NAME };
