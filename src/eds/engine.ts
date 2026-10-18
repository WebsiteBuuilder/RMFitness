// The duel engine: enforces the 2002 rules the way The Eternal Duelist Soul did.
// Everything that needs a decision from a player is written as a generator that
// yields a Prompt; the engine parks the generator until the answer arrives.

import type { Action, Card, CardInfo, ChainLink, DuelState, EngineEvent, FieldCard, Loc, LogLine, Phase, Pid, PlayerState, Pos, Prompt, Rules, SeatSetup, SelectOption } from './types';
import { EDS_RULES, MONSTER_ZONES, PHASES, PHASE_NAME, STARTING_LP, ST_ZONES, rulesFor } from './types';
import { extraProcFor, getEffect, setNameResolver, type EffectDef, type GraveEvent, type SummonHow, type Trigger } from './effects';
import { getSkill } from './skills';
import { nameRule, setNameEngine } from './names';
import { noteLevelEvent } from '../level/leveling';
import { TAG_LP, swapIn, type TagTeam } from './tag';

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
  /** only monsters of these card types (CardInfo.sub: 'Fusion', 'Synchro'...) can be Summoned */ // audit-04
  subs?: string[];
  /** this card is exempt */
  except?: number;
  /** audit-02: monsters with these names cannot be Summoned (Chaos Grepher) */
  names?: string[];
  /** audit-02: only monsters of these kinds (Fusion, Xyz...) can be Summoned from the Extra Deck (Contact Gate) */
  extraOnly?: string[];
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
  /** >0 while an activation that can no longer be taken back picks its targets: its prompts offer no Cancel. */
  private noCancel = 0;
  /** Where a card activated from the hand sat in it, so a take-back puts it back in the same spot. */
  private handSpot = new Map<number, number>();
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
  /** cards whose effects are running (innermost last), so the log can say what moved a card */
  private causes: string[] = [];
  /** the last line logLeave wrote (a script's own line right after it replaces it) */
  private autoLine: { line: LogLine; name: string; verb: RegExp; by: string | null } | null = null;

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
    if (how === 'effect' && this.speed && m.tags?.effProof) return true; // audit-10: "it cannot be destroyed by card effects" for good (Vehicroid Connection Zone)
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
    for (const x of this.skillFx()) if (x.eff.shields?.(this, x.c, m, how, x.p)) return true; // audit-skills
    return false;
  }

  // b20: blocked Monster Zones (Ojama Knight). fx.blockedMZ lists zones of the source's opponent that cannot be used
  // while the source stays face-up in a Monster Zone. Every free-zone search for monsters goes through these helpers.
  /** b20: is Monster Zone `i` of player `p` blocked by an effect right now? */
  mzBlocked(p: Pid, i: number): boolean {
    const locks = this.state.fx.zoneLocks as { p: Pid; kind: string; i: number; src: number }[] | undefined;
    if (locks?.some((x) => x.p === p && x.kind === 'mz' && x.i === i && !!this.fieldCard(x.src)?.faceUp)) return true; // b18: Tri-Head Dust Dragon
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
    return this.scriptOf(c);
  }

  // b18: a face-up monster that copied another monster's effect (Number 8: Heraldic King Genom-Heritage, One-Eyed Skill Gainer,
  // Number C69). tags.copyFx = 1 + index into fx.copyNames; tags.copyTurn limits it to that turn; tags.copyGain keeps its own effects too.
  private copyCache = new Map<string, EffectDef>();
  /** b18: a zone that cannot be used while the card that locked it stays face-up (Number 57: Tri-Head Dust Dragon; fx.zoneLocks). */
  zoneLocked(ps: PlayerState, kind: 'mz' | 'sz', i: number): boolean {
    const p = this.state.players.indexOf(ps) as Pid;
    if (kind === 'mz' && this.mzBlocked(p, i)) return true; // b20: Ojama Knight
    const list = this.state.fx.zoneLocks as { p: Pid; kind: string; i: number; src: number }[] | undefined;
    if (!list?.length) return false;
    return list.some((x) => x.p === p && x.kind === kind && x.i === i && !!this.fieldCard(x.src)?.faceUp);
  }

  /** b18: the first empty zone that is not locked, or -1. */
  freeZone(ps: PlayerState, kind: 'mz' | 'sz'): number {
    return ps[kind].findIndex((z, i) => z === null && !this.zoneLocked(ps, kind, i));
  }

  /** b18: the script a card runs with: its own, or the effect it copied while it is on the field (ignores negation). */
  scriptOf(c: Card): EffectDef | undefined {
    const asOther = this.copiedEffect(c); // b20: Arcana Call
    if (asOther) return asOther;
    const own = getEffect(c.name);
    const t = (c as FieldCard).tags;
    if (!t?.copyFx || !this.speed || (t.copyTurn !== undefined && t.copyTurn !== this.state.turn) || this.find(c.uid)?.loc.zone !== 'mz') return own;
    const name = ((this.state.fx.copyNames ?? []) as string[])[t.copyFx - 1];
    const copied = name ? getEffect(name) : undefined;
    if (!copied) return t.copyGain ? own : undefined;
    const key = `${c.name}|${name}|${t.copyGain ? 1 : 0}`;
    let def = this.copyCache.get(key);
    if (!def) this.copyCache.set(key, (def = t.copyGain ? { ...copied, ...(own ?? {}) } : { ...copied }));
    return def;
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
    if (m.tags?.unnegatable) return false; // audit-10: "its effects cannot be negated" (Vehicroid Connection Zone)
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
        if (this.isNegated(c)) continue; // b17: a Spell/Trap whose effects a card negated (Number 45: Crumble Logos)
        const eff = getEffect(c.name);
        if (eff) out.push({ c, p, eff });
      }
    }
    out.push(...this.skillFx()); // audit-skills
    return out;
  }

  // audit-skills: a Skill's continuous hooks (SkillDef.eff) run like an active Spell/Trap of its owner, through this stand-in
  // card (uid < 0: it is not in any zone, so it cannot be moved, targeted or destroyed).
  skillCard(p: Pid): FieldCard | null {
    const ps = this.player(p);
    if (!ps.skill) return null;
    const list = (this.state.fx.skillCards ??= [null, null]) as (FieldCard | null)[];
    if (!list[p] || list[p]!.name !== ps.skill) list[p] = { uid: -1 - p, name: ps.skill, owner: p, pos: 'atk', faceUp: true, placedTurn: 0, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true };
    return list[p];
  }

  /** audit-skills: the Skills with continuous hooks, as liveST() entries. */
  skillFx(): { c: FieldCard; p: Pid; eff: EffectDef }[] {
    const out: { c: FieldCard; p: Pid; eff: EffectDef }[] = [];
    if (!this.speed) return out;
    for (const p of [0, 1] as Pid[]) {
      const ps = this.player(p);
      const eff = ps.skill ? getSkill(ps.skill)?.eff : undefined;
      const c = eff ? this.skillCard(p) : null;
      if (eff && c) out.push({ c, p, eff });
    }
    return out;
  }

  /** audit-skills: the Skills in play, with their owners. */
  skillDefs(): { p: Pid; sk: import('./skills').SkillDef }[] {
    const out: { p: Pid; sk: import('./skills').SkillDef }[] = [];
    if (!this.speed) return out;
    for (const p of [0, 1] as Pid[]) {
      const ps = this.player(p);
      const sk = ps.skill ? getSkill(ps.skill) : undefined;
      if (sk) out.push({ p, sk });
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
    if (how === 'flip' && (c as FieldCard).tags?.noFlip) return true; // audit-05: "cannot change its battle position" also stops a Flip Summon (Floodgate Trap Hole)
    if (how !== 'set' && fx.summonLock?.[p] === this.state.turn && fx.summonLockExcept !== c.uid) return true;
    if (how === 'special' && fx.ignoreCond !== c.uid && getEffect(c.name)?.cannotSpecial?.(this, c, p, from)) return true; // a Summoning condition: effects that ignore it skip it too
    if (how === 'special' && from === 'fusion' && this.liveST().some((x) => this.isNamed(x.c, 'Summon Gate')) && (fx.extraSummons?.[p]?.turn === this.state.turn ? fx.extraSummons[p].n : 0) >= 3) return true;
    if (how === 'special' && from !== null && getEffect(c.name)?.cannotSpecialSummon && fx.ignoreCond !== c.uid) return true;
    // "You cannot Normal or Special Summon ... this turn, except ..." (summonLocks: see SummonLock).
    for (const l of (fx.summonLocks ?? []) as SummonLock[]) {
      if (l.p !== p || l.turn !== this.state.turn || c.uid === l.except) continue;
      if (!(how === 'special' ? l.special : how === 'normal' && l.normal)) continue;
      if (l.only && !l.only.some((n) => this.nameHas(c, n))) return true;
      if (l.levels && l.levels.includes(this.info(c.name).level ?? 0)) return true;
      if (l.subs && !l.subs.includes(this.info(c.name).sub)) return true; // audit-04: "except Fusion Monsters" (Elemental HERO Blazeman)
      if (l.names && this.namesOf(c).some((n) => l.names!.includes(n))) return true; // audit-02
      if (l.extraOnly && from === 'fusion' && !l.extraOnly.includes(this.info(c.name).sub)) return true; // audit-02
    }
    if (getEffect(c.name)?.selfSummonBlock?.(this, c, p, how, from)) return true;
    // audit-03: "you cannot Special Summon monsters from the Extra Deck this turn, except ..." (fx.extraLocks: allowed race/attributes/kinds).
    if (how === 'special' && from === 'fusion') {
      const ci = this.info(c.name);
      for (const l of (fx.extraLocks ?? []) as { p: Pid; turn: number; race?: string; attrs?: string[]; subs?: string[] }[])
        if (l.p === p && l.turn === this.state.turn && ((l.race && ci.race !== l.race) || (l.attrs && !l.attrs.includes(ci.attribute ?? '')) || (l.subs && !l.subs.includes(ci.sub)))) return true;
    }
    // audit-08: "while you control any of those monsters face-up, you cannot Special Summon from the Extra Deck, except Fusion Monsters" (NEXT).
    if (how === 'special' && from === 'fusion' && this.info(c.name).sub !== 'Fusion' && ((fx.extraLockBy ?? []) as { p: Pid; uids: number[] }[]).some((l) => l.p === p && l.uids.some((u) => this.controller(u) === p && !!this.fieldCard(u)?.faceUp))) return true;
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
    if (this.nameLocked(card)) return true;
    // audit-06: "for the rest of this turn, you cannot activate cards, or the effects of cards, with that name" (Generation Next): fx.turnNameLocks.
    if (((fx.turnNameLocks ?? []) as { p: Pid; name: string; turn: number }[]).some((x) => x.p === player && x.name === card.name && x.turn === this.state.turn)) return true;
    if (((card as FieldCard).tags?.noActTurn ?? -1) === this.state.turn && this.find(card.uid)?.loc.zone === 'sz') return true;
    const kind = this.info(card.name).kind;
    if (kind === 'trap' && (fx.noTrapTurn as number[] | undefined)?.[player] === this.state.turn) return true;
    const lock = fx.battleLock as { player: Pid; turn: number; kind: string } | undefined;
    if (lock && lock.player === player && lock.turn === this.state.turn && this.state.battle && this.controller(this.state.battle.attacker) === other(player) && lock.kind === kind) return true;
    if (kind === 'monster' && this.monsterEffectsLocked(player, card)) return true;
    // audit-03: "cannot activate cards with that name for the rest of this Duel" (Cursed Seal of the Forbidden Spell): fx.duelNameLocks.
    if (((fx.duelNameLocks ?? []) as { p: Pid; name: string }[]).some((x) => x.p === player && x.name === card.name)) return true;
    return false;
  }

  /** b18: a face-up monster stops `player` from activating this monster's effects (Number C65: King Overfiend). */
  monsterEffectsLocked(player: Pid, card: Card): boolean {
    if (!this.speed) return false;
    for (const q of [0, 1] as Pid[]) for (const m of this.monsters(q)) if (m.faceUp && m.uid !== card.uid && this.effectOn(m)?.locksMonsterEffects?.(this, m, q, player, card)) return true;
    return false;
  }

  /** b17: "cards with that name, and their effects, cannot be activated" while a given card stays on the field (Number 45: Crumble Logos). fx.nameLocks: { name, src }. */
  nameLocked(c: { name: string; uid?: number } | string): boolean {
    const list = (this.state.fx.nameLocks ?? []) as { name: string; src: number }[];
    if (!list.length) return false;
    const names = this.namesOf(c);
    return list.some((x) => names.includes(x.name) && !!this.fieldCard(x.src));
  }

  /** Speed Duel: extra attacks a monster was granted (Evil HERO Infernal Gainer, Diffusion Wave-Motion). */
  extraAttacks(m: FieldCard): number {
    const ctl = this.controller(m.uid); // audit-skills: Skills granting extra attacks
    const bySkill = this.skillDefs().reduce((n, x) => n + (x.p === ctl ? x.sk.extraAttacks?.(this, x.p, m) ?? 0 : 0), 0);
    return (m.tags?.extraAttacks ?? 0) + (m.tags?.extraAttacksTurn === this.state.turn ? m.tags?.extraAttacksN ?? 0 : 0) + bySkill;
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
      if (t && !this.anyActive(cancelledBy) && this.monsters(p).some((m) => m.faceUp && this.isNamed(m, 'Sealmaster Meisei'))) return true;
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
      this.event('summon', { uid: x.uid, player: x.controller, how: 'special' });
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

  /** `sandbox`: a throwaway copy (the computer's lookahead) that must not reset the shared effect cache. */
  constructor(public readonly db: Map<string, CardInfo>, private readonly sandbox = false) {
    if (sandbox) return;
    setNameEngine(this);
    setNameResolver((n) => {
      const i = this.db.get(n) ?? this.db.get(n.toLowerCase());
      return i ? [i.name, ...(i.alias ? [i.alias] : [])] : [];
    });
  }

  /** Ceremonial Bell, Respect Play and The Eye of Truth show hands. */
  handRevealed(p: Pid): boolean {
    if ([...this.monsters(0), ...this.monsters(1)].some((m) => m.faceUp && this.isNamed(m, 'Ceremonial Bell'))) return true;
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
    // A card script describing the same move right after the engine's own line replaces that line.
    const auto = this.autoLine;
    this.autoLine = null;
    const log = this.state.log;
    if (auto && log[log.length - 1] === auto.line && text.includes(auto.name) && auto.verb.test(text)) {
      log.pop();
      if (auto.by && !text.includes(auto.by)) text = `${text} (${auto.by})`;
    }
    log.push({ turn: this.state.turn, player, text });
  }

  event(kind: string, extra: Omit<EngineEvent, 'kind' | 'seq'> = {}) {
    const ev = { kind, ...extra, seq: ++this.seq };
    this.state.lastEvent = ev;
    const list = (this.state.events ??= []);
    list.push(ev);
    // audit-09: the last face-up monster turned face-down (scripts report it with a 'position' event): Subterror Behemoth Stalagmo.
    if (kind === 'position' && extra.uid !== undefined && this.speed) {
      const f = this.find(extra.uid);
      if (f?.loc.zone === 'mz' && !(f.card as FieldCard).faceUp) this.state.fx.flippedDown = { uid: extra.uid, p: f.loc.player, turn: this.state.turn, seq: ev.seq };
    }
    if (list.length > 40) list.splice(0, list.length - 40);
    if (this.state.rules?.mode === 'speed') noteLevelEvent(this.state, ev, { source: this.levelSource, inChain: this.resolving > 0, find: (u) => this.find(u) });
  }

  /** The card a chain link targets, for the cinematics (a targeting beam from the card to it). */
  private targetEvent(link: ChainLink) {
    if (link.targetUid !== undefined) this.event('target', { uid: link.card.uid, player: link.player, target: link.targetUid });
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
    if (this.speed && m.tags?.origSet) b = { atk: m.tags.origAtk ?? 0, def: m.tags.origDef ?? 0 }; // skills-2024a: original ATK/DEF set by a Skill (Advent of Ra)
    if (this.state.fx.swapTurn === this.state.turn || (m.tags?.swapTurn !== undefined && m.tags.swapTurn === this.state.turn)) b = { atk: b.def, def: b.atk }; // audit-eds: Shield & Sword (only monsters on the field then)
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
      if (ctl !== null && this.monsters(ctl).some((x) => x.faceUp && this.isNamed(x, 'Parasite Paracide') && x.owner !== ctl)) return 'Insect';
      // A Trap Card Special Summoned as a monster (Quantum Cat, Zoma the Spirit) has the Type its script gave it.
      const trap = (this.state.fx.trapMonster as Record<number, { race?: string }> | undefined)?.[m.uid];
      if (trap?.race && this.find(m.uid)?.loc.zone === 'mz') return trap.race;
    }
    return this.info(m.name).race ?? '';
  }

  /** skills-2024a: a card of this uid is in either player's GY (no array built: used on the hot namesOf path). */
  private inSomeGy(uid: number | undefined): boolean {
    if (uid === undefined || uid < 0) return false;
    const has = (gy: Card[]) => {
      for (let i = 0; i < gy.length; i++) if (gy[i].uid === uid) return true;
      return false;
    };
    return has(this.state.players[0].gy) || has(this.state.players[1].gy);
  }

  // ---------- card names ----------
  /**
   * The names a card has right now. A card keeps its printed name unless an effect changes it: its own text
   * ("name becomes "Harpie Lady" while on the field or in the GY", "always treated as "Umi"", names.ts), its script
   * (fieldName: Proto-Cyber Dragon, Elemental HERO Prisma, Copy Knight), a copied name (Number 8, Neo-Spacian Dark Panther),
   * a rename stored by an effect (renameUntilEnd) or a face-up card that adds a name (addsNames: Frightfur Sanctuary).
   * The first name is the one shown on screen.
   */
  namesOf(c: { name: string; uid?: number } | string): string[] {
    const given = typeof c === 'string' ? { name: c } : c;
    const base = given.name;
    if (!this.speed || !base) return [base];
    const rule = nameRule(this.info(base));
    // skills-2024a: fx.gyNames (Tribal Unity) only matters for a card that is in a GY right now (a cheap scan of the two GYs, no allocation).
    if (!('faceUp' in given) && !rule.also.length && !rule.becomes?.gy && !(this.state.fx.gyNames && this.inSomeGy(given.uid))) return [base];
    // Where the card is now (a FieldCard kept from before it left the field is the same card, now elsewhere).
    const f = given.uid !== undefined && given.uid >= 0 ? this.find(given.uid) : null;
    const card = f?.card.name === base ? f.card : given;
    const zone = f && card === f.card ? f.loc.zone : null;
    const out: string[] = [];
    if (zone === 'mz' || zone === 'sz' || zone === 'field') {
      const fc = card as FieldCard;
      if (fc.faceUp) {
        // Reading a script can ask for names again (negation checks look for cards by name): those inner reads see printed names.
        const outer = !this.naming;
        this.naming++;
        try {
          const renamed = outer ? this.renamedTo(fc) : undefined;
          if (renamed) out.push(renamed);
          else if (rule.becomes && (!rule.becomes.gemini || fc.tags?.gemini === 1)) out.push(rule.becomes.name);
          if (outer) {
            for (const n of this.effectOn(fc)?.extraNames?.(this, fc) ?? []) out.push(n);
            if (zone === 'mz') for (const x of this.liveST()) for (const n of x.eff.addsNames?.(this, x.c, x.p, fc) ?? []) out.push(n);
          }
        } finally {
          this.naming--;
        }
      }
    } else if (zone === 'gy') {
      if (rule.becomes?.gy) out.push(rule.becomes.name);
      // skills-2024a: a Skill adding names to cards in the GY too (Tribal Unity: "Harpie" monsters are also "Amazoness" monsters).
      if (this.state.fx.gyNames && !this.naming) {
        this.naming++;
        try {
          for (const x of this.skillFx()) for (const n of x.eff.addsNames?.(this, x.c, x.p, card as FieldCard) ?? []) out.push(n);
        } finally {
          this.naming--;
        }
      }
    }
    if (!out.length || !out.some((n) => n !== base && !rule.also.includes(n))) out.unshift(base);
    for (const n of rule.also) if (!out.includes(n)) out.push(n);
    return [...new Set(out)];
  }

  private naming = 0;

  /** The name a card shows and is called by right now (see namesOf). */
  nameOf(c: { name: string; uid?: number } | string): string {
    return this.namesOf(c)[0];
  }

  /** Does this card have this exact name right now ("Harpie Lady", "Umi", "Cyber Dragon")? */
  isNamed(c: { name: string; uid?: number } | string, name: string): boolean {
    return this.namesOf(c).includes(name);
  }

  /** Does one of this card's names contain this text ("Harpie", "Archfiend", "Cyberdark")? */
  nameHas(c: { name: string; uid?: number } | string, part: string): boolean {
    return this.namesOf(c).some((n) => n.includes(part));
  }

  /** Do the two cards share a name right now ("monsters with the same name")? */
  sameName(a: { name: string; uid?: number } | string, b: { name: string; uid?: number } | string): boolean {
    const nb = this.namesOf(b);
    return this.namesOf(a).some((n) => nb.includes(n));
  }

  /** A face-up card's name until the End Phase (or for as long as it stays face-up), set by an effect. */
  renameUntilEnd(uid: number, name: string, thisTurnOnly = true) {
    ((this.state.fx.renamed ??= {}) as Record<number, { name: string; turn?: number }>)[uid] = { name, turn: thisTurnOnly ? this.state.turn : undefined };
  }

  /** The name an effect gave this face-up card, if any. */
  private renamedTo(fc: FieldCard): string | undefined {
    const r = (this.state.fx.renamed as Record<number, { name: string; turn?: number }> | undefined)?.[fc.uid];
    if (r && (r.turn === undefined || r.turn === this.state.turn)) return r.name;
    const t = fc.tags;
    if (t?.copyFx && (t.copyTurn === undefined || t.copyTurn === this.state.turn) && this.find(fc.uid)?.loc.zone === 'mz') {
      const n = ((this.state.fx.copyNames ?? []) as string[])[t.copyFx - 1];
      if (n) return n;
    }
    const eff = this.effectOn(fc);
    return eff?.fieldName?.(this, fc);
  }

  /** Is any face-up, active copy of this card on the field? */
  anyActive(name: string, p?: Pid): FieldCard | null {
    for (const q of p === undefined ? ([0, 1] as Pid[]) : [p]) {
      for (const c of this.activeSpells(q)) if (this.isNamed(c, name)) return c;
      for (const m of this.monsters(q)) if (m.faceUp && this.isNamed(m, name)) return m;
      if (this.speed && this.skillDefs().some((x) => x.p === q && x.sk.namesAs?.(this, q) === name)) return this.skillCard(q); // audit-skills
      if (this.speed) for (const m of this.monsters(q)) if (m.faceUp && this.effectOn(m)?.countsAs?.(this, m) === name) return m;
      if (this.speed) for (const c of this.activeSpells(q)) if (getEffect(c.name)?.countsAs?.(this, c) === name) return c; // audit-00: A Legendary Ocean is "Umi"
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
    if (this.speed && [...this.monsters(0), ...this.monsters(1)].some((m) => m.faceUp && this.effectOn(m)?.negatesTraps)) return true; // audit-06: Jinzo - Lord
    return (!!this.anyActive('Royal Decree') && except !== 'Royal Decree') || this.talisman('Talisman of Trap Sealing', 'Talisman of Spell Sealing') || this.jinzoNegates(); // audit-eds
  }

  /** audit-eds: Speed Duel: a face-up Jinzo negates all Trap effects on the field (unless an Amplifier frees it). */
  private jinzoNegates(): boolean {
    if (!this.speed) return false;
    return [...this.monsters(0), ...this.monsters(1)].some((m) => m.faceUp && this.effectOn(m)?.sealsTraps && !m.equips.some((u) => !!getEffect(this.fieldCard(u)?.name ?? '')?.freesOwnTraps));
  }

  /**
   * Is this card name forbidden by Prohibition? Pass the card's uid when it is on the field:
   * cards that were already on the field when Prohibition resolved are not affected.
   */
  prohibited(c: { name: string; uid?: number } | string, uid?: number): boolean {
    const list = (this.state.fx.prohibit ?? []) as { name: string; src: number; exempt?: number[] }[];
    if (!list.length) return false;
    const names = this.namesOf(c);
    return list.some((x) => names.includes(x.name) && this.fieldCard(x.src)?.active && !(uid !== undefined && x.exempt?.includes(uid) && this.fieldCard(uid)));
  }

  /** Lord of D.: Dragons cannot be targeted by card effects. */
  untargetable(m: FieldCard): boolean {
    if (m.faceUp && this.effectOn(m)?.cannotBeTargeted?.(this, m, this.actor)) return true;
    if (m.faceUp && this.speed && this.shielded(m, 'target')) return true;
    // Speed Duel: "your opponent cannot target it until the end of their turn" that outlasts its source (Abyss Prop - Wild Wagon).
    if (m.faceUp && this.speed && (m.tags?.oppNoTargetUntil ?? -1) >= this.state.turn && this.actor !== this.controller(m.uid)) return true;
    return m.faceUp && this.raceOf(m) === 'Dragon' && [...this.monsters(0), ...this.monsters(1)].some((x) => x.faceUp && this.isNamed(x, 'Lord of D.'));
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
    // audit-skills: a die (6) or coin (2) result a player decided in advance for their own next roll (It's My Lucky Day!).
    const fixed = this.state.fx.fixedRoll as { p: Pid; die?: number; coin?: number } | undefined;
    if (fixed && this.actor === fixed.p && ((sides === 6 && fixed.die) || (sides === 2 && fixed.coin))) {
      const v = sides === 6 ? fixed.die! : fixed.coin!;
      this.state.fx.fixedRoll = undefined;
      this.log(fixed.p, `${this.player(fixed.p).name} decides the result: ${sides === 6 ? v : v === 1 ? 'heads' : 'tails'}`);
      this.event('roll', { player: fixed.p, amount: v, to: sides === 6 ? 'die' : 'coin' });
      return v;
    }
    let v = 1 + Math.floor(this.rand() * sides);
    // Shown on screen (dice and coins are public), so nobody has to dig the result out of the log.
    if (sides === 6 || sides === 2) this.event('roll', { player: this.actor ?? this.state.turnPlayer, amount: v, to: sides === 6 ? 'die' : 'coin' });
    return v;
  }

  /**
   * A die rolled by player `p` for a card or effect, inside a generator so a Skill can offer that player a re-roll
   * (See Me Rolling: "you may re-roll the result once"). `good` says which results the roller wants: only the computer
   * reads it (as fx.rerollBad, when it answers the question). Players without such a Skill see no question and the roll
   * is exactly roll(sides). A result decided in advance (It's My Lucky Day!) is not offered for a re-roll.
   */
  *rollDie(p: Pid, good: (v: number) => boolean, sides = 6): Generator<Prompt, number, Choice> {
    const fixedBefore = this.state.fx.fixedRoll;
    let v = this.roll(sides);
    if (!this.speed || sides !== 6 || (fixedBefore && !this.state.fx.fixedRoll) || this.state.winner !== null) return v;
    for (const x of this.skillDefs()) {
      const rr = (x.sk as { reroll?: { can(e: Engine, p: Pid): boolean; use(e: Engine, p: Pid, v: number): void } }).reroll;
      if (x.p !== p || !rr || !rr.can(this, p)) continue;
      this.state.fx.rerollBad = good(v) ? 0 : 1;
      let yes: boolean;
      try {
        yes = yield* this.yesno(p, `${this.player(p).skill}: re-roll the ${v}?`);
      } finally {
        this.state.fx.rerollBad = undefined;
      }
      if (!yes) break;
      rr.use(this, p, v);
      v = 1 + Math.floor(this.rand() * sides);
      this.log(p, `${this.player(p).name} re-rolls the die: ${v}`);
      this.event('roll', { player: p, amount: v, to: 'die' });
      break;
    }
    return v;
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
    // A name an effect gave a card on the field ends when it leaves the field.
    if ((f.loc.zone === 'mz' || f.loc.zone === 'sz' || f.loc.zone === 'field') && this.state.fx.renamed) delete (this.state.fx.renamed as Record<number, unknown>)[uid];
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
        // b17: remember how many Xyz Materials it had and whose card effect moved it (null: a game action) for "leaves the field" effects.
        if (this.speed && !f.card.token) Object.assign(((f.card as FieldCard).tags ??= {}), { lastMats: mats?.length ?? 0, leftBy: this.actor ?? -1 });
        if (mats?.length) {
          for (const m of mats) this.player(m.owner).gy.push(m);
          (f.card as FieldCard).mats = [];
        }
        break;
      }
      case 'sz':
        ps.sz[f.loc.index] = null;
        if (this.speed && !f.card.token) ((f.card as FieldCard).tags ??= {}).leftBy = this.actor ?? -1; // audit-10: whose card effect moved it (Waking the Dragon)
        break;
      case 'field':
        ps.field = null;
        if (this.speed && !f.card.token) ((f.card as FieldCard).tags ??= {}).leftBy = this.actor ?? -1; // audit-10
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
    this.event('summon', { uid: card.uid, player: controller, how: 'special' });
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
      const zone = ps.sz[mid] === null && !this.zoneLocked(ps, 'sz', mid) ? mid : this.freeZone(ps, 'sz');
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

  /**
   * Runs a card's triggered or continuous hook (onSummon, onStandby, onLeaveField...). The first
   * time it does something (logs, emits an event, or asks anything but a yes/no question), an
   * 'effect' event for the card (`uid` undefined: the player's Skill) is put before what it did,
   * so the cinematics show the card at work. Hooks that check and do nothing stay silent.
   */
  *trig(uid: number | undefined, p: Pid, step: Step, kind = 'effect'): Step {
    let told = false;
    let done = false;
    try {
      let input: Choice | undefined;
      for (;;) {
        const log0 = this.state.log.length;
        const seq0 = this.seq;
        const r = step.next(input as Choice);
        if (!told && (this.state.log.length !== log0 || this.seq !== seq0 || (!r.done && r.value.kind !== 'yesno'))) {
          told = true;
          this.announce(kind, uid !== undefined && uid < 0 ? undefined : uid, p, seq0); // uid < 0: a Skill
        }
        if (r.done) return (done = true), r.value;
        input = yield r.value;
      }
    } finally {
      if (!done) step.return();
    }
  }

  /** Emits an event as if it came right after event number `after` (before what has happened since). */
  private announce(kind: string, uid: number | undefined, player: Pid, after: number) {
    this.event(kind, uid === undefined ? { player } : { uid, player });
    const list = this.state.events!;
    const ev = list[list.length - 1];
    const i = list.findIndex((x) => x !== ev && x.seq > after);
    if (i < 0) return;
    list.pop();
    ev.seq = after + 0.5;
    list.splice(i, 0, ev);
  }

  /** Runs a card effect on behalf of a player (so "your opponent's effect" checks work). `source`: the card whose effect it is (named in the log). */
  *as(p: Pid, step: Step, source?: Card): Step {
    const prev = this.actor;
    this.actor = p;
    if (source) this.causes.push(source.name);
    try {
      yield* step;
    } finally {
      this.actor = prev;
      if (source) this.causes.pop();
    }
  }

  /** The card whose effect is moving cards right now (for the log), if known. */
  private cause(): string | null {
    return this.causes[this.causes.length - 1] ?? this.resolvingCard()?.name ?? null;
  }

  /** b22: a log line for a card leaving the field by a card effect, unless the effect already said it. */
  private logLeave(controller: Pid, name: string, what: string, verb: RegExp) {
    const turn = this.state.turn;
    const recent = this.state.log.slice(-3).filter((l) => l.turn === turn);
    if (recent.some((l) => l.text.includes(name) && verb.test(l.text))) return;
    const by = this.cause();
    this.log(controller, `${name} ${what}${by ? (by === name ? ' by its own effect' : ` by ${by}`) : ''}`);
    this.autoLine = { line: this.state.log[this.state.log.length - 1], name, verb, by: by && by !== name ? by : null };
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
    // audit-09: cards in the GY that got there by being destroyed by battle (Skyscraper 2 - Hero City).
    if (this.speed) {
      const bd = (this.state.fx.battleDead ??= {}) as Record<number, number>;
      if (byBattle && f.loc.zone === 'mz') bd[uid] = 1;
      else delete bd[uid];
    }
    const ev: GraveEvent | null = this.speed ? { card: { uid, name: f.card.name, owner: f.card.owner }, from: f.loc.zone, controller, reason, byBattle, faceUp: !!fc?.faceUp, pos: fc?.pos, race: fc ? this.raceOf(fc) : this.info(f.card.name).race ?? '', toGy: false, token: !!f.card.token, by: this.actor } : null;
    const card = this.detach(uid)!;
    if (byBattle && fc?.tags) fc.tags.leftBy = -1; // b17: destroyed by battle, not by a card effect
    if (card.token || this.namesOf(card).some((nm) => nm.startsWith('__token'))) {
      if (fc && reason === 'destroyed' && !byBattle && !this.namesOf(card).some((nm) => nm.startsWith('__token'))) this.logLeave(controller, card.name, 'was destroyed', /destroy/i);
      if (fc) {
        for (const eqUid of fc.equips.slice()) yield* this.sendToGrave(eqUid, 'used');
        const eff = muted ? undefined : getEffect(card.name);
        if (eff?.onLeaveField) yield* this.trig(fc.uid, controller, eff.onLeaveField(this, fc, controller, reason));
      }
      if (ev) yield* this.graveWatch(ev);
      return;
    }
    const banisher = [...this.monsters(0), ...this.monsters(1)].some((m) => m.faceUp && (this.isNamed(m, 'Banisher of the Light') || this.effectOn(m)?.banishInstead?.(this, m, this.controller(m.uid) ?? m.owner, card) === true)) || this.liveST().some((x) => x.eff.banishInstead?.(this, x.c, x.p, card) === true);
    // Speed Duel: a face-up monster sends battle-destroyed monsters to the Deck instead (Grave Protector).
    const toDeck = !banisher && this.speed && byBattle && f.loc.zone === 'mz' && [...this.monsters(0), ...this.monsters(1)].some((m) => m.faceUp && this.effectOn(m)?.deckInstead?.(this, m, card) === true);
    if (ev) ev.toGy = !banisher && !toDeck;
    if (banisher) {
      if (this.speed) ((this.state.fx.banishedAt ??= {}) as Record<number, number>)[uid] = this.state.turn;
      this.player(card.owner).removed.push(card);
      this.log(card.owner, `${card.name} is removed from play instead`);
      this.queueBanished(card); // audit-09
    } else if (toDeck) {
      const ps = this.player(card.owner);
      if (this.isExtraCard(card.name)) ps.fusion.push(card);
      else (ps.deck.push(card), (ps.deck = this.shuffle(ps.deck)));
      this.log(card.owner, `${card.name} is shuffled into the Deck instead`);
    } else this.player(card.owner).gy.push(card);
    if (wasField && reason === 'destroyed' && !byBattle) this.logLeave(controller, card.name, 'was destroyed', /destroy/i);
    this.event('to-gy', { uid, player: card.owner });
    if (reason === 'discard' && f.loc.zone === 'hand') yield* this.discardWatchers(controller);
    if (reason === 'mill' && f.loc.zone === 'deck' && this.actor !== null && this.actor !== card.owner) {
      const eff = getEffect(card.name);
      if (eff?.onMilledByOpponent) yield* this.trig(card.uid, card.owner, eff.onMilledByOpponent(this, card, card.owner));
    }
    if (fc) {
      // Equip cards attached to a monster leaving the field go to the GY too.
      for (const eqUid of fc.equips.slice()) yield* this.sendToGrave(eqUid, 'used');
      if (fc.equippedTo !== undefined) {
        const host = this.fieldCard(fc.equippedTo);
        if (host) host.equips = host.equips.filter((u) => u !== uid);
      }
      const eff = muted ? undefined : getEffect(card.name);
      if (eff?.onLeaveField) yield* this.trig(fc.uid, controller, eff.onLeaveField(this, fc, controller, reason));
      if (f.loc.zone === 'mz' && eff?.onToGraveFromField) yield* this.trig(card.uid, controller, eff.onToGraveFromField(this, card, controller));
    }
    // Speed Duel card scripts: "if this card is sent to the GY" and "if this card is destroyed".
    const eff = muted ? undefined : getEffect(card.name);
    if (this.state.winner === null && (eff?.onSentToGrave || eff?.onDestroyed) && this.find(uid)?.loc.zone === 'gy') {
      if (eff.onDestroyed && wasField && reason === 'destroyed') yield* this.trig(card.uid, controller, this.as(controller, eff.onDestroyed(this, card, controller, byBattle), card));
      if (eff.onSentToGrave && this.find(uid)?.loc.zone === 'gy') yield* this.trig(card.uid, card.owner, this.as(card.owner, eff.onSentToGrave(this, card, card.owner, f.loc.zone, reason), card));
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
      if (x.eff.onAnyToGrave && (x.c.uid < 0 || this.fieldCard(x.c.uid)?.active) && this.state.winner === null) yield* this.trig(x.c.uid, x.p, this.as(x.p, x.eff.onAnyToGrave(this, x.c, x.p, events))); // audit-skills: Skills (uid < 0) too
    }
    // Face-up monsters that watch the GY too (Marina, Princess of Sunflowers).
    for (const p of [0, 1] as Pid[]) {
      for (const m of this.monsters(p)) {
        const h = m.faceUp ? this.effectOn(m)?.onAnyToGrave : undefined;
        if (h && this.state.winner === null && this.fieldCard(m.uid)) yield* this.trig(m.uid, p, this.as(p, h(this, m, p, events)));
      }
    }
    for (const p of [0, 1] as Pid[])
      for (const m of this.monsters(p)) {
        const h = m.faceUp ? this.effectOn(m)?.onGraveEvents : undefined;
        if (h && this.fieldCard(m.uid)?.faceUp && this.state.winner === null) yield* this.trig(m.uid, p, this.as(p, h(this, m, p, events)));
      }
    for (const p of [0, 1] as Pid[])
      for (const c of [...this.player(p).hand, ...this.player(p).gy]) {
        const h = getEffect(c.name)?.watchGrave;
        const z = this.find(c.uid)?.loc;
        if (h && this.state.winner === null && z && z.player === p && (z.zone === 'hand' || z.zone === 'gy') && !(z.zone === 'gy' && this.graveSTLocked(c))) yield* this.trig(c.uid, p, this.as(p, h(this, c, p, z.zone, events))); // audit-02: graveSTLocked
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
        // The battle line was written before protection was known: "X destroys Y" becomes "X wins the battle against Y".
        if (byBattle) {
          const e = this.state.log.slice().reverse().find((l) => l.turn === this.state.turn && l.text.endsWith(` destroys ${m.name}`));
          if (e) e.text = e.text.replace(/ destroys ([^]*)$/, ' wins the battle against $1');
        }
        this.log(null, `${m.name} is not destroyed ${byBattle ? 'by battle' : 'by the card effect'}`);
        continue;
      }
      // b18: "if this face-up card would be destroyed, you can ... instead" (Number 49: Fortune Tune).
      const repl = m && m.faceUp && this.speed && this.find(uid)?.loc.zone === 'mz' ? this.effectOn(m)?.destroyReplace : undefined;
      if (repl && m) {
        const prev = this.actor;
        this.actor = this.controller(uid) ?? m.owner;
        let kept = false;
        try {
          kept = yield* repl(this, m, byBattle);
        } finally {
          this.actor = prev;
        }
        if (kept) continue;
      }
      // b23: another face-up monster of its controller replaces the destruction (Tiki Soul).
      if (m && m.faceUp && this.speed && this.find(uid)?.loc.zone === 'mz') {
        const ctl = this.controller(uid) ?? m.owner;
        const by = byBattle ? other(ctl) : this.actor;
        let kept = false;
        for (const s of this.monsters(ctl)) {
          const h = s.uid !== uid && s.faceUp ? this.effectOn(s)?.allyDestroyReplace : undefined;
          if (!h || kept || !this.fieldCard(uid)) continue;
          const prev = this.actor;
          this.actor = ctl;
          try {
            kept = yield* h(this, s, ctl, m, byBattle, by);
          } finally {
            this.actor = prev;
          }
        }
        if (kept) continue;
      }
      // audit-07: a card in a GY can be banished instead of this monster being destroyed (Machine Angel Ritual).
      if (m && m.faceUp && this.speed && this.find(uid)?.loc.zone === 'mz') {
        const ctl = this.controller(uid) ?? m.owner;
        const sub = this.player(ctl).gy.find((c) => getEffect(c.name)?.graveReplace?.(this, c, ctl, m, byBattle));
        if (sub) {
          this.banish(sub.uid);
          if (this.find(sub.uid)?.loc.zone === 'removed') {
            this.log(ctl, `${sub.name} is banished instead of ${m.name} being destroyed`);
            continue;
          }
        }
      }
      // audit-02: a card in the hand discarded instead (Chronomaly Acambaro Figures).
      const ownerNow = m && m.faceUp && this.speed && this.find(uid)?.loc.zone === 'mz' ? this.controller(uid) : null;
      if (m && ownerNow !== null) {
        let kept = false;
        for (const c of this.player(ownerNow).hand.slice()) {
          const h = getEffect(c.name)?.handReplace;
          if (!h || kept || this.find(c.uid)?.loc.zone !== 'hand') continue;
          const prev = this.actor;
          this.actor = ownerNow;
          try {
            kept = yield* h(this, c, m, byBattle, byBattle ? null : prev);
          } finally {
            this.actor = prev;
          }
        }
        if (kept) continue;
      }
      // audit-skills: a Skill replacing the destruction (Rainbow Crystal Collection, Heavy Metal Raiders).
      if (m && m.faceUp && this.speed && this.find(uid)?.loc.zone === 'mz') {
        let kept = false;
        for (const x of this.skillDefs()) {
          if (kept || !x.sk.destroyReplace || !this.fieldCard(uid)) continue;
          const prev = this.actor;
          this.actor = x.p;
          try {
            kept = yield* x.sk.destroyReplace(this, x.p, m, byBattle);
          } finally {
            this.actor = prev;
          }
        }
        if (kept) continue;
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
    if (c && eff?.onDiscarded) yield* this.trig(c.card.uid, player, eff.onDiscarded(this, c.card, player, byOpp));
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
        yield* this.trig(s.uid, q, h(this, s, q, player));
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
      this.event('draw', normal ? { uid: c.uid, player } : { uid: c.uid, player, effect: true });
      const paracide = (this.state.fx.paracide ?? []) as number[];
      if (paracide.includes(c.uid)) {
        this.state.fx.paracide = paracide.filter((u) => u !== c.uid);
        const zone = this.freeMonsterZone(player); // b20
        if (zone >= 0) {
          const card = this.detach(c.uid)!;
          ps.mz[zone] = this.toField(card, 'def', true);
          this.event('summon', { uid: card.uid, player, how: 'special' });
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
    // "you take no damage this turn" from your opponent's attacks and effects (Hallowed Life Barrier): your own costs still hurt
    if (amount > 0 && (this.state.fx.noOppDamage as number[] | undefined)?.[player] === this.state.turn && (this.battleHit || (this.actor !== null && this.actor !== player))) {
      this.log(player, `${this.player(player).name} takes no damage from the opponent this turn`);
      return;
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
    // every bit of damage ever taken (fx.hurt is emptied by the damage window and each Draw Phase): Boss Raid counts hits by it
    if (amount > 0) (this.state.fx.hurtTotal ??= [0, 0])[player] += amount;
    if (amount > 0 && (this.battleHit || (this.actor !== null && this.actor !== player))) (this.state.fx.dmgByOpp ??= [-1, -1])[player] = this.state.turn; // audit-07: took battle/opponent's effect damage this turn (Magikuriboh)
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

  /**
   * Boss Raid: a card arrives from outside the duel (a teammate's gift, a raging boss), either
   * face-up in Attack Position in the first open Monster Zone or into the hand. Null if there is no room.
   */
  conjure(p: Pid, name: string, to: 'mz' | 'hand'): Card | null {
    const ps = this.player(p);
    if (to === 'hand') {
      const c = this.newCard(name, p);
      ps.hand.push(c);
      this.event('draw', { uid: c.uid, player: p, effect: true });
      return c;
    }
    const z = this.freeMonsterZone(p);
    if (z < 0 || this.info(name).kind !== 'monster') return null;
    const fc = this.toField(this.newCard(name, p), 'atk', true);
    ps.mz[z] = fc;
    this.event('summon', { uid: fc.uid, player: p, how: 'special' });
    return fc;
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
    this.event('summon', { uid, player: controller, how: this.summonHow(fc, from?.loc.zone) });
    this.log(controller, `${ps.name} Special Summoned ${faceUp ? card.name : 'a monster'} in ${pos === 'atk' ? 'Attack' : 'Defense'} Position`);
    if (faceUp) yield* this.anySummon(fc, controller, 'special');
    if (faceUp && this.fieldCard(uid)) {
      const h = getEffect(card.name)?.onSpecialSummon;
      if (h) yield* this.trig(fc.uid, controller, this.as(controller, h(this, fc, controller), fc));
    }
    if (faceUp && this.speed && this.fieldCard(uid)) yield* this.specialSummonWindow(uid);
  }

  /** How a Special Summon is shown (the cinematics): the Extra Deck method its tags record, a Ritual Monster from the hand/GY. */
  private summonHow(fc: FieldCard, from: string | undefined): string {
    const t = fc.tags ?? {};
    if (t.xyzS) return 'xyz';
    if (t.synS) return 'synchro';
    if (t.linkS) return 'link';
    const sub = this.info(fc.name).sub;
    if (t.fusS || (from === 'fusion' && sub === 'Fusion')) return 'fusion';
    if (sub === 'Ritual' && (from === 'hand' || from === 'gy')) return 'ritual';
    return 'special';
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
    (m.tags ??= {}).summonedTurn = this.state.turn; // the turn this monster was last Summoned (Normal/Tribute, Flip or Special): Mokey Mokey Madness
    for (const p of [0, 1] as Pid[]) {
      for (const w of this.monsters(p)) {
        if (!w.faceUp || !this.fieldCard(m.uid)) continue;
        const h = this.effectOn(w)?.onAnySummon;
        if (h) yield* this.trig(w.uid, p, h(this, w, p, m, controller, kind));
      }
      // Active Spells/Traps that watch Summons too (Dragon Capture Jar; Speed Duel scripts).
      for (const w of this.activeSpells(p)) {
        if (!this.fieldCard(m.uid) || !this.fieldCard(w.uid)) continue;
        const kindOf = this.info(w.name).kind;
        if ((kindOf === 'spell' && this.spellsNegated()) || (kindOf === 'trap' && this.trapsNegated(w.name))) continue;
        const h = getEffect(w.name)?.onAnySummon;
        if (h) yield* this.trig(w.uid, p, h(this, w, p, m, controller, kind));
      }
    }
    for (const x of this.skillFx()) if (x.eff.onAnySummon && this.fieldCard(m.uid) && this.state.winner === null) yield* this.as(x.p, x.eff.onAnySummon(this, x.c, x.p, m, controller, kind)); // audit-skills
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
    const from = this.find(uid);
    const card = this.detach(uid);
    if (!card) return;
    if (from && (from.loc.zone === 'mz' || from.loc.zone === 'sz' || from.loc.zone === 'field') && !card.token) this.logLeave(from.loc.player, card.name, 'was returned to the hand', /return|hand/i);
    if (this.isExtraCard(card.name)) this.player(card.owner).fusion.push(card);
    else this.player(p).hand.push(card);
    this.event('to-hand', { uid, player: p, ...this.whence(from, this.isExtraCard(card.name) ? 'extra' : 'hand') });
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
    if (f && (f.loc.zone === 'mz' || f.loc.zone === 'sz' || f.loc.zone === 'field')) {
      this.leftField(f.card as FieldCard, f.loc.player, 'bounced');
      if (!card.token) this.logLeave(f.loc.player, card.name, this.isExtraCard(card.name) ? 'was returned to the Extra Deck' : 'was returned to the hand', /return|hand|bounce/i);
    }
    (this.isExtraCard(card.name) ? this.player(card.owner).fusion : this.player(card.owner).hand).push(card);
    this.event('to-hand', { uid, player: card.owner, ...this.whence(f, this.isExtraCard(card.name) ? 'extra' : 'hand') });
  }

  /** Where a card that moves (not to the GY) came from and goes, for the cinematics: event detail `zone`, `to`, `down` (it was face-down on the field). */
  private whence(f: { card: Card; loc: { zone: string } } | null | undefined, to: string): { zone?: string; to: string; down?: boolean } {
    if (!f) return { to };
    const onField = f.loc.zone === 'mz' || f.loc.zone === 'sz' || f.loc.zone === 'field';
    return onField && !(f.card as FieldCard).faceUp ? { zone: f.loc.zone, to, down: true } : { zone: f.loc.zone, to };
  }

  /** Removes a card from play (D.D. Warrior, Gravedigger Ghoul). */
  banish(uid: number, faceDown = false) {
    const f = this.find(uid);
    if (!f) return;
    this.state.fx.banishing = uid; // audit-07: locksGrave can tell a banish from other moves (Kycoo the Ghost Destroyer)
    const locked = this.graveLocked(uid);
    this.state.fx.banishing = undefined;
    if (locked) return;
    if (this.speed) ((this.state.fx.banishedAt ??= {}) as Record<number, number>)[uid] = this.state.turn;
    const fc = f.loc.zone === 'mz' || f.loc.zone === 'sz' || f.loc.zone === 'field' ? (f.card as FieldCard) : null;
    const card = this.detach(uid)!;
    if (fc) this.leftField(fc, f.loc.player, 'banished');
    if (card.token || this.namesOf(card).some((nm) => nm.startsWith('__token'))) {
      // A banished Token ceases to exist (it can never come back to the field).
      this.event('to-gy', { uid, player: card.owner });
      this.log(card.owner, `${card.name} was removed from play`);
      return;
    }
    this.player(card.owner).removed.push(card);
    this.event('to-gy', { uid, player: card.owner, ...this.whence(f, 'banish'), ...(faceDown ? { down: true } : {}) });
    if (faceDown) {
      // face-down (Lightforce Sword): its owner knows it, the opponent doesn't; the Out pile shows its back to them
      ((this.state.fx.banishedDown ??= []) as number[]).push(uid);
      this.log(card.owner, `A card from ${this.player(card.owner).name}'s hand was banished face-down`);
    } else if (fc) this.logLeave(f.loc.player, card.name, 'was removed from play', /remov|banish/i);
    else this.log(card.owner, `${card.name} was removed from play`);
    this.queueBanished(card); // audit-09
  }

  /** audit-09: a banished card whose script has onBanished runs it once the current action or chain has finished (see flushLeaves). */
  private queueBanished(card: Card) {
    if (this.speed && !card.token && getEffect(card.name)?.onBanished) ((this.state.fx.pendingBanished ??= []) as { uid: number; owner: Pid }[]).push({ uid: card.uid, owner: card.owner });
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
      if (eff?.onLeaveField) yield* this.trig(fc.uid, controller, this.as(controller, eff.onLeaveField(this, fc, controller, reason), fc));
      // audit-02: cards in a GY that watch cards leaving the field (Contact Gate).
      if (this.speed)
        for (const q of [0, 1] as Pid[])
          for (const c of this.player(q).gy.slice()) {
            const h = getEffect(c.name)?.watchLeave;
            if (h && this.state.winner === null && this.find(c.uid)?.loc.zone === 'gy' && !this.graveSTLocked(c)) yield* this.trig(c.uid, q, this.as(q, h(this, c, q, fc, controller, reason)));
          }
    }
    // audit-09: "If this card is banished" (Resonance Insect).
    const gone = (this.state.fx.pendingBanished ?? []) as { uid: number; owner: Pid }[];
    while (gone.length && this.state.winner === null) {
      const { uid, owner } = gone.shift()!;
      const f = this.find(uid);
      const h = f?.loc.zone === 'removed' ? getEffect(f.card.name)?.onBanished : undefined;
      if (f && h) yield* this.trig(uid, owner, this.as(owner, h(this, f.card, owner)));
    }
  }

  /** Puts a card on top of its owner's Deck (Cockroach Knight). */
  toDeckTop(uid: number) {
    if (this.graveLocked(uid)) return;
    const f = this.find(uid);
    const card = this.detach(uid);
    if (!card) return;
    if (f && (f.loc.zone === 'mz' || f.loc.zone === 'sz' || f.loc.zone === 'field')) {
      this.leftField(f.card as FieldCard, f.loc.player, 'to-deck');
      if (!card.token) this.logLeave(f.loc.player, card.name, this.isExtraCard(card.name) ? 'was returned to the Extra Deck' : 'was returned to the Deck', /deck|shuffle|return/i);
    }
    const extra = this.isExtraCard(card.name);
    if (extra) this.player(card.owner).fusion.push(card);
    else this.player(card.owner).deck.unshift(card);
    this.event('to-hand', { uid, player: card.owner, ...this.whence(f, extra ? 'extra' : 'deck') });
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
    // audit-06: an effect unaffected by Necrovalley is resolving (fx.graveFree: Gravekeeper's Stele, Ambusher), or a face-up card frees this GY (Gravekeeper's Chief).
    if (this.state.fx.graveFree || this.liveCards().some((x) => x.eff.freesGrave?.(this, x.c, x.p, f.card) === true)) return false;
    if (this.state.fx.ignoreGraveLock === uid) return false; // audit-09: an effect unaffected by Necrovalley (Rite of Spirit)
    const lock = this.liveCards().find((x) => x.eff.locksGrave?.(this, x.c, x.p, f.card) === true);
    if (lock) this.log(null, `${lock.c.name}: ${f.card.name} cannot leave the Graveyard`);
    return !!lock;
  }

  /** audit-02: a face-up card stops the effects of this Spell/Trap Card in the GY from being activated (Chow Sai the Ghost Stopper). */
  graveSTLocked(card: Card): boolean {
    if (!this.speed || this.info(card.name).kind === 'monster') return false;
    return this.liveCards().some((x) => x.eff.locksGraveST?.(this, x.c, x.p, card) === true);
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
    if (this.noCancel > 0 && min > 0) cancel = false;
    if (options.length <= min && !cancel) return options.map((_, i) => i);
    const choice = yield { kind: 'select', player, title, options, min: Math.min(min, options.length), max: Math.min(max, options.length), cancel };
    if (choice === 'cancel') return null;
    if (typeof choice === 'object' && 'picks' in choice) {
      const picks = [...new Set(choice.picks.filter((i) => Number.isInteger(i) && i >= 0 && i < options.length))].slice(0, max);
      // too few picks (a cost or a required choice): fill up with the first options left
      const need = Math.min(min, options.length);
      for (let i = 0; picks.length < need && i < options.length; i++) if (!picks.includes(i)) picks.push(i);
      return picks;
    }
    return null;
  }

  *yesno(player: Pid, title: string): Generator<Prompt, boolean, Choice> {
    const choice = yield { kind: 'yesno', player, title };
    return choice === true;
  }

  // ---------- action entry ----------
  apply(action: Action) {
    if (!this.sandbox) setNameEngine(this); // the duel being played answers name checks (names.ts)
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
    // Xyz Materials only stay under a monster in a Monster Zone (a monster equipped as a card loses them).
    for (const p of [0, 1] as Pid[]) {
      const ps = this.player(p);
      for (const c of [...ps.sz, ps.field]) if (c?.mats?.length) for (const m of c.mats.splice(0)) this.player(m.owner).gy.push(m);
    }
    for (let i = 0; i < 4 && this.state.winner === null; i++) {
      let acted = false;
      for (const x of this.liveST().filter((y) => y.eff.stateCheck)) {
        if ((x.c.uid >= 0 && !this.fieldCard(x.c.uid)?.active) || this.state.winner !== null) continue; // audit-skills: Skills (uid < 0) too
        const before = this.state.log.length;
        yield* this.trig(x.c.uid, x.p, this.as(x.p, x.eff.stateCheck!(this, x.c, x.p)));
        if (this.state.log.length !== before) acted = true;
      }
      for (const p of [0, 1] as Pid[]) {
        for (const m of this.monsters(p)) {
          const h = m.faceUp ? this.effectOn(m)?.stateCheck : undefined;
          if (!h || this.state.winner !== null || !this.fieldCard(m.uid)?.faceUp) continue;
          const before = this.state.log.length;
          yield* this.trig(m.uid, p, this.as(p, h(this, m, p)));
          if (this.state.log.length !== before) acted = true;
        }
        for (const c of this.player(p).hand.slice()) {
          const h = getEffect(c.name)?.inHand;
          if (!h || this.state.winner !== null || this.find(c.uid)?.loc.zone !== 'hand') continue;
          const before = this.state.log.length;
          yield* this.trig(c.uid, p, this.as(p, h(this, c, p)));
          if (this.state.log.length !== before) acted = true;
        }
      }
      if (!acted) break;
    }
    this.state.fx.targetResolved = undefined; // b22: only the state checks right after the action read it (Spirit Reaper)
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
    if (a.tag) this.startTag(a.tag);
    s.started = true;
    s.turn = 1;
    s.turnPlayer = a.first;
    s.phase = 'DP';
    this.log(null, `Duel start! ${s.players[a.first].name} goes first.`);
    for (const p of [0, 1] as Pid[]) this.draw(p, Math.max(0, rules.openingHand + (a.setup?.[p]?.openingHand ?? 0)), true);
    if (s.tag) {
      // Tag Duel: the second duelists draw their own opening hands from their own Decks.
      s.tag.teams[a.first].played = true;
      for (const p of [0, 1] as Pid[]) {
        swapIn(this.player(p), s.tag.teams[p]);
        this.draw(p, rules.openingHand, true);
        swapIn(this.player(p), s.tag.teams[p]);
      }
    }
    if (rules.firstPlayerDraws) this.draw(a.first, 1, true);
    for (const p of [0, 1] as Pid[]) if (a.setup?.[p]) this.applySetup(p, a.setup[p]!);
    this.run(this.duelOpening());
  }

  /** Tag Duel: the second duelist of each team waits on the bench with their own Deck, Extra Deck and Skill. */
  private startTag(t: NonNullable<Extract<Action, { type: 'START' }>['tag']>) {
    const teams = ([0, 1] as Pid[]).map((p): TagTeam => {
      const ps = this.player(p);
      ps.lp = t.lp ?? TAG_LP;
      const skill = t.skills?.[p] ?? null;
      const ok = !!(skill && getSkill(skill));
      return {
        names: [ps.name, t.names[p]],
        active: 0,
        played: false,
        bench: { name: t.names[p], deck: this.shuffle(t.decks[p].map((n) => this.newCard(n, p))), hand: [], fusion: t.fusions[p].map((n) => this.newCard(n, p)), skill: ok ? skill : null, ...(ok ? { skillRevealed: false, skillUses: 0 } : {}) },
      };
    });
    this.state.tag = { teams: [teams[0], teams[1]], ...(t.ctl ? { ctl: t.ctl } : {}), ...(t.ctx ? { ctx: t.ctx } : {}) };
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
        this.event('activate', { player: p });
        this.log(p, `${ps.name}'s Skill: ${ps.skill}`);
        yield* this.as(p, sk.startOfDuel(this, p));
      }
    }
    // Tag Duel: the benched duelists' start-of-Duel Skills, each with their own Deck and hand swapped in.
    const tag = this.state.tag;
    if (tag) {
      for (const p of [this.state.turnPlayer, other(this.state.turnPlayer)]) {
        const sk = tag.teams[p].bench.skill ? getSkill(tag.teams[p].bench.skill!) : undefined;
        if (!sk?.startOfDuel || this.state.winner !== null) continue;
        swapIn(this.player(p), tag.teams[p]);
        const ps = this.player(p);
        ps.skillRevealed = true;
        this.log(p, `${ps.name}'s Skill: ${ps.skill}`);
        yield* this.as(p, sk.startOfDuel(this, p));
        swapIn(this.player(p), tag.teams[p]);
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
    if (sk.use.phase === 'battle' && !(this.state.phase === 'BP' && this.state.attackedThisTurn.length === 0)) return false; // audit-skills
    if (ps.skillTurn === this.state.turn && !sk.use.repeat) return false; // audit-skills: repeat
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
    if (!f || f.loc.zone !== 'gy' || f.loc.player !== player || this.prohibited(f.card)) return false;
    if (this.graveSTLocked(f.card)) return false; // audit-02
    const g = getEffect(f.card.name)?.graveIgnition;
    return !!g && g.can(this, f.card, player);
  }

  private *graveEffect(player: Pid, uid: number): Step {
    if (!this.canUseGraveEffect(player, uid)) return;
    const card = this.find(uid)!.card;
    this.event('activate', { uid, player });
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
    // audit-eds: control taken "until the end of the Battle Phase" goes back (Magical Arm Shield).
    for (const x of ((fx.returnAfterBattle ?? []) as { uid: number; to: Pid }[]).splice(0)) {
      const m = this.fieldCard(x.uid);
      if (m && this.controller(x.uid) !== x.to && this.takeControl(x.uid, x.to)) (m.returnAtEnd = undefined), this.log(null, `${m.name} returns to ${this.player(x.to).name}`);
    }
    if (this.speed)
      for (const p of [this.state.turnPlayer, other(this.state.turnPlayer)])
        for (const m of this.monsters(p)) {
          const h = m.faceUp ? this.effectOn(m)?.onBattlePhaseEnd : undefined;
          if (h && this.fieldCard(m.uid)?.faceUp && this.state.winner === null) yield* this.trig(m.uid, p, this.as(p, h(this, m, p)));
        }
    for (const x of this.skillDefs()) if (x.sk.onBattlePhaseEnd && this.state.winner === null) yield* this.as(x.p, x.sk.onBattlePhaseEnd(this, x.p)); // audit-skills
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
            if ((kind === 'spell' && this.spellsNegated() && !this.isNamed(c, 'Imperial Order')) || (kind === 'trap' && this.trapsNegated(c.name))) continue;
            yield* this.trig(c.uid, p, this.as(p, eff.onStandby(this, c, p), c));
          }
          for (const m of this.monsters(p)) {
            const eff = this.effectOn(m);
            if (m.faceUp && eff?.onStandby && this.fieldCard(m.uid)) yield* this.trig(m.uid, p, this.as(p, eff.onStandby(this, m, p), m));
          }
        }
        for (const c of this.player(tp).gy.slice()) {
          const eff = getEffect(c.name);
          if (eff?.onStandbyInGrave && this.find(c.uid)?.loc.zone === 'gy') yield* this.trig(c.uid, tp, this.as(tp, eff.onStandbyInGrave(this, c, tp), c));
        }
        // audit-10: "during the Standby Phase of the next turn" from the GY, on either player's turn (Vampire's Curse).
        if (this.speed)
          for (const p of [tp, other(tp)])
            for (const c of this.player(p).gy.slice()) {
              const h = getEffect(c.name)?.onStandbyInGraveAny;
              if (h && this.state.winner === null && this.find(c.uid)?.loc.zone === 'gy') yield* this.as(p, h(this, c, p));
            }
        if (this.speed)
          for (const c of this.player(tp).removed.slice()) {
            const h = getEffect(c.name)?.onStandbyBanished;
            if (h && this.state.winner === null && this.find(c.uid)?.loc.zone === 'removed') yield* this.trig(c.uid, tp, this.as(tp, h(this, c, tp)));
          }
          for (const p of [tp, other(tp)])
            for (const c of this.player(p).removed.slice()) {
              const h = getEffect(c.name)?.onStandbyBanishedAny;
              if (h && this.state.winner === null && this.find(c.uid)?.loc.zone === 'removed') yield* this.trig(c.uid, p, this.as(p, h(this, c, p)));
            }
        // Lightforce Sword: banished hand cards come back.
        const lf = (fx.lightforce ?? []) as { uid: number; back: number }[];
        for (const x of lf.filter((x) => x.back <= this.state.turn)) {
          const card = this.find(x.uid);
          if (card && card.loc.zone === 'removed') this.toHand(x.uid);
        }
        fx.lightforce = lf.filter((x) => x.back > this.state.turn);
        if (fx.banishedDown) fx.banishedDown = (fx.banishedDown as number[]).filter((u) => this.find(u)?.loc.zone === 'removed');
        // Speed Duel: monsters banished "until your next Standby Phase" come back (Flyfang).
        const away = (fx.returnAtStandby ?? []) as { uid: number; p: Pid; pos: Pos; after: number }[];
        for (const x of away.filter((y) => y.p === tp && y.after < this.state.turn)) {
          if (this.find(x.uid)?.loc.zone !== 'removed' || this.freeMonsterZone(tp) < 0) continue; // b20
          const card = this.detach(x.uid)!;
          const z = this.freeMonsterZone(tp);
          this.player(tp).mz[z] = this.toField(card, x.pos, true);
          this.event('summon', { uid: x.uid, player: tp, how: 'special' });
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
        if (c.faceUp && c.active && eff?.onEndPhase && this.fieldCard(c.uid)) yield* this.trig(c.uid, p, eff.onEndPhase(this, c, p));
      }
      for (const m of this.monsters(p)) {
        const eff = this.effectOn(m);
        if (this.speed && m.faceUp && this.liveST().some((x) => x.eff.skipsEndPhase?.(this, x.c, x.p, m))) continue; // audit-08: Neo Space
        if (m.faceUp && eff?.onEndPhase && this.fieldCard(m.uid)) yield* this.trig(m.uid, p, eff.onEndPhase(this, m, p));
      }
    }
    // Speed Duel: "During the End Phase, if this card is in the GY" (Hysteric Sign).
    if (this.speed)
      for (const p of [tp, other(tp)])
        for (const c of this.player(p).gy.slice()) {
          const h = getEffect(c.name)?.onEndPhaseInGrave;
          if (h && this.state.winner === null && this.find(c.uid)?.loc.zone === 'gy' && !this.graveSTLocked(c)) yield* this.trig(c.uid, p, this.as(p, h(this, c, p))); // audit-02: graveSTLocked
        }
    // Speed Duel: "During the End Phase, if this card is banished" (D.D. Survivor, D.D. Scout Plane).
    if (this.speed)
      for (const p of [tp, other(tp)])
        for (const c of this.player(p).removed.slice()) {
          const h = getEffect(c.name)?.onEndPhaseBanished;
          if (h && this.state.winner === null && this.find(c.uid)?.loc.zone === 'removed') yield* this.trig(c.uid, p, this.as(p, h(this, c, p)));
        }
    // b21: Set Traps activated "During your End Phase" (Volcanic Eruption) are offered to the turn player here.
    if (this.speed)
      for (const fc of this.spells(tp).slice()) {
        const eff = getEffect(fc.name);
        if (!eff?.endPhaseTrap || !eff.resolve || fc.faceUp || fc.placedTurn === this.state.turn || this.state.winner !== null || !this.fieldCard(fc.uid)) continue;
        if (this.trapsSealed(tp) || this.activationLocked(tp, 'trap') || this.cardActivationLocked(tp, fc) || this.activationBlocked(tp, fc) || this.prohibited(fc, fc.uid)) continue;
        if (eff.canActivate && !this.withActor(tp, () => eff.canActivate!(this, fc, tp, 'main', {}))) continue;
        if (!(yield* this.yesno(tp, `Activate ${fc.name}?`))) continue;
        if (!this.fieldCard(fc.uid) || fc.faceUp) continue;
        fc.faceUp = true;
        yield* this.startChain(tp, fc, 'main', {});
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
      const sk = ps.skill ? getSkill(ps.skill) : undefined; // audit-skills: face-down Skills too (each Skill checks its own conditions)
      if (sk?.onEndPhase && this.state.winner === null) yield* this.trig(undefined, p, this.as(p, sk.onEndPhase(this, p)), 'activate');
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
    // Tag Duel: the team's other duelist steps in for this turn (a team's first turn keeps its first duelist).
    if (s.tag) {
      const team = s.tag.teams[s.turnPlayer];
      if (team.played) swapIn(this.player(s.turnPlayer), team);
      team.played = true;
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
          this.event('activate', { player: s.turnPlayer });
          this.log(s.turnPlayer, `${ps.name} uses the Skill ${ps.skill}`);
          yield* this.as(s.turnPlayer, sk.drawPhase.run(this, s.turnPlayer));
          if (this.state.winner !== null) return;
        }
      }
      if (!replaced && !this.draw(s.turnPlayer, 1, true)) return;
      const drawn = this.player(s.turnPlayer).hand[this.player(s.turnPlayer).hand.length - 1];
      if (!replaced && drawn && this.speed) s.fx.normalDraw = { player: s.turnPlayer, uid: drawn.uid, turn: s.turn };
      if (!replaced && drawn) for (const x of this.liveST()) if (x.eff.onDrawPhase && x.p === s.turnPlayer && this.state.winner === null) yield* this.trig(x.c.uid, x.p, this.as(x.p, x.eff.onDrawPhase(this, x.c, x.p, [drawn])));
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
    let lvMod = 0; // audit-00: Levels changed in the hand by an active card (A Legendary Ocean)
    if (this.speed) for (const x of this.liveST()) lvMod += x.eff.levelMod?.(this, x.c, x.p, card) ?? 0;
    const level = Math.max(1, (info.level ?? 1) - (down?.turn === this.state.turn ? down.n : 0) + lvMod);
    let less = 0;
    if (this.speed) for (const x of this.liveST()) less += x.eff.tributeDiscount?.(this, x.c, x.p, card, player) ?? 0;
    const fixed = getEffect(card.name)?.tributeCount?.(this, card, player); // audit-eds: Divine-Beasts need 3
    let plan: { need: number; only?: (m: FieldCard) => boolean } = { need: Math.max(0, (fixed ?? this.tributesNeeded(level)) - less) };
    if (!this.speed || faceUp === false || plan.need === 0) return plan;
    const offers = [getEffect(card.name)?.tributeOffer?.(this, null, player, card, plan.need), ...this.liveST().filter((x) => x.p === player).map((x) => x.eff.tributeOffer?.(this, x.c, x.p, card, plan.need))];
    for (const l of this.lingering()) if (l.p === player) offers.push(l.eff.lingering?.tributeOffer?.(this, l.p, card, plan.need)); // audit-10 (Vampire Sorcerer)
    for (const o of offers) if (o && o.need < plan.need && (!o.only || this.monsters(player).filter(o.only).length >= o.need)) plan = o;
    return plan;
  }

  /** `faceUp`: true = a face-up Normal Summon, false = a Set, undefined = either. `extra`: an additional Normal Summon granted by a card (Ultimate Offering), outside the usual timing and limit. */
  canNormalSummon(player: Pid, card: Card, faceUp?: boolean, extra = false): boolean {
    if (!extra && (!this.inMainPhase() || this.state.turnPlayer !== player)) return false;
    if (!extra && this.player(player).normalSummoned && !(faceUp !== false && (this.extraTributeSummon(player) || this.skillExtraTribute(player, card)) && this.tributeNeed(player, card) > 0)) return false; // audit-skills: skillExtraTribute
    if (extra && this.find(card.uid)?.loc.zone !== 'hand') return false;
    if (faceUp === true && this.summonBlocked(player, card, 'normal', 'hand')) return false;
    if (faceUp !== true && this.skillFx().some((x) => x.eff.forbidsSummon?.(this, x.c, x.p, card, player, 'set', 'hand') === true)) return false; // audit-skills: "cannot Summon/Set" Skills
    const info = this.info(card.name);
    if (info.kind !== 'monster' || info.sub === 'Fusion' || info.sub === 'Ritual') return false;
    if (getEffect(card.name)?.cannotNormalSummon || this.prohibited(card)) return false;
    if (faceUp === false && getEffect(card.name)?.cannotNormalSet) return false; // audit-eds
    if (this.chainEnergyBlocks(player)) return false;
    if (faceUp === false && this.speed && (this.state.fx.noSetTurn as number[] | undefined)?.[player] === this.state.turn) return false; // audit-00: Absorbing Jar
    const plan = this.tributePlan(player, card, faceUp);
    const need = plan.need;
    const empty = this.openMonsterZones(player); // b20
    const owned = this.monsters(player).filter((m) => !this.untributable(m) && !this.tribLocked(m, card) && (!plan.only || plan.only(m))).length;
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

  /** audit-skills: a Skill lets `player` Tribute Summon this monster in addition to the Normal Summon (once per turn). */
  skillExtraTribute(player: Pid, card: Card): boolean {
    return this.speed && this.oncePerTurn('skill:extraTribute', player) && this.skillDefs().some((x) => x.p === player && x.sk.extraTributeFor?.(this, player, card) === true);
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
    if (m.faceUp && m.tags?.cannotTribute) return true; // audit-00: "It cannot be Tributed" (Archfiend's Roar)
    if (m.tags?.skillNoTribute) return true; // audit-skills: "cannot be Tributed" a Skill gave it (Forbidden Cyber Style Technique)
    if (m.faceUp && this.effectOn(m)?.cannotBeTributed?.(this, m)) return true;
    return m.equips.some((u) => {
      const eq = this.fieldCard(u);
      return !!eq && !(this.info(eq.name).kind === 'spell' && this.spellsNegated()) && !!getEffect(eq.name)?.cannotBeTributed?.(this, m);
    });
  }

  /** audit-07: a monster that can only be Tributed for the Tribute Summon of a monster whose name includes fx.tribFor[uid] (Jurrac Tokens). */
  tribLocked(m: FieldCard, card: Card): boolean {
    const t = (this.state.fx.tribFor as Record<number, string> | undefined)?.[m.uid];
    return this.speed && typeof t === 'string' && !this.nameHas(card, t);
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
      this.state.fx.tributingFor = f.card.name; // audit-05: the monster these Tributes are for (Evil HERO Infernal Prodigy)
      if (standIn) {
        if (standIn.uid < 0) standIn.counters = 0; // audit-skills: a Skill Tributed instead (Middle Age Mechs) loses its counters
        yield* this.sendToGrave(standIn.uid, 'tribute');
        this.log(player, `${ps.name} Tributed ${standIn.name}`);
      } else if (double) {
        yield* this.sendToGrave(double.uid, 'tribute');
        this.log(player, `${ps.name} Tributed ${double.name} as 2 Tributes`);
      } else {
        const pool = fodder.filter((m) => !this.untributable(m) && !this.tribLocked(m, f.card));
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
      this.state.fx.tributingFor = undefined; // audit-05
      if (!this.monsterZoneOpen(player, zone)) zone = this.freeMonsterZone(player); // b20
      if (this.speed) ((this.state.fx.tributedFor ??= {}) as Record<number, number>)[uid] = need; // audit-00: how many Tributes it took (Behemoth the King of All Animals)
    }
    // b20: a blocked zone (Ojama Knight) cannot take the monster: use another open one.
    if (zone >= 0 && zone < ps.mz.length && ps.mz[zone] === null && this.mzBlocked(player, zone)) zone = this.freeMonsterZone(player);
    if (zone < 0 || zone >= ps.mz.length || ps.mz[zone] !== null) return;
    const card = this.detach(uid)!;
    const fc = this.toField(card, faceUp ? pos : 'def', faceUp);
    ps.mz[zone] = fc;
    ps.normalSummoned = true;
    if (this.speed && faceUp && need > 0) (fc.tags ??= {}).tribS = need; // audit-06: it was Tribute Summoned (Granmarg, Gravekeeper's Chief, Infestation Wave)
    if (usesExtra && !this.extraTributeSummon(player)) this.useOnce('skill:extraTribute', player); // audit-skills: the Skill's extra Tribute Summon
    else if (usesExtra) (this.state.fx.extraTribute as number[])[player] = -1;
    yield* this.chainEnergy(player);
    this.event(faceUp ? 'summon' : 'set', faceUp ? { uid, player, how: need ? 'tribute' : 'normal' } : { uid, player });
    if (faceUp) {
      this.log(player, `${ps.name} ${need ? 'Tribute ' : ''}Summoned ${card.name}${pos === 'def' ? ' in Defense Position' : ''}`);
      if (!(this.speed && getEffect(card.name)?.noSummonResponse)) yield* this.responseWindow('summon', { uid, summonKind: 'normal' }); // audit-eds
      const eff = this.effectOn(fc);
      if (eff?.onSummon && this.fieldCard(uid)) yield* this.trig(fc.uid, player, this.as(player, eff.onSummon(this, fc, player, 'normal'), fc));
      if (this.fieldCard(uid)) yield* this.anySummon(fc, player, 'normal');
    } else {
      this.log(player, `${ps.name} Set a monster`);
      // "this turn, ..." effects that count a Normal Set (Double Summon's second Normal Summon or Set)
      if (this.speed) for (const l of this.lingering()) if (l.eff.lingering?.onAnySet) yield* l.eff.lingering.onAnySet(this, l.p, fc, player);
      for (const x of this.liveST()) if (x.eff.onAnySet && this.fieldCard(uid)) yield* this.trig(x.c.uid, x.p, this.as(x.p, x.eff.onAnySet(this, x.c, x.p, fc, player)));
      // audit-00: face-up monsters watch Sets too (Arcana Force III - The Empress).
      if (this.speed)
        for (const q of [0, 1] as Pid[])
          for (const w of this.monsters(q)) {
            const h = w.faceUp ? this.effectOn(w)?.onAnySet : undefined;
            if (h && this.fieldCard(uid) && this.state.winner === null) yield* this.trig(w.uid, q, this.as(q, h(this, w, q, fc, player)));
          }
    }
  }

  /**
   * audit-06: a Tribute Summon with Tributes a card's own procedure chose ("You can Tribute 3 monsters to Tribute Summon (but not Set)
   * this card": Gilford the Lightning, Gravekeeper's Oracle). Uses the Normal Summon; the Tributed monsters (name, Level) are kept
   * in fx.tributedFor[uid] and the monster gets tags.tribS. Returns false when it could not be Summoned.
   */
  *tributeSummonWith(player: Pid, uid: number, tributes: number[], pos: Pos = 'atk', side: Pid = player): Generator<Prompt, boolean, Choice> {
    const f = this.find(uid);
    if (!f || f.loc.zone !== 'hand' || this.summonBlocked(player, f.card, 'normal', 'hand')) return false;
    const ps = this.player(player);
    const used = tributes.map((t) => this.fieldCard(t)).filter((m): m is FieldCard => !!m);
    ((this.state.fx.tributedFor ??= {}) as Record<number, { name: string; level: number }[]>)[uid] = used.map((m) => ({ name: m.name, level: this.info(m.name).level ?? 0 }));
    const self = this;
    yield* this.together((function* (): Step {
      for (const m of used) {
        yield* self.sendToGrave(m.uid, 'tribute');
        self.log(player, `${ps.name} Tributed ${m.name}`);
      }
    })());
    // b23: `side` = the field it is Summoned to (The Winged Dragon of Ra - Sphere Mode: to the opponent's side).
    const zone = this.freeMonsterZone(side);
    if (zone < 0 || this.find(uid)?.loc.zone !== 'hand') return false;
    const fc = this.toField(this.detach(uid)!, pos, true);
    fc.tags = { tribS: used.length };
    this.player(side).mz[zone] = fc;
    ps.normalSummoned = true;
    this.event('summon', { uid, player: side });
    this.log(player, `${ps.name} Tribute Summoned ${fc.name}${side !== player ? ` to ${this.player(side).name}'s field` : ''}`);
    yield* this.responseWindow('summon', { uid, summonKind: 'normal' });
    const eff = this.effectOn(fc);
    if (eff?.onSummon && this.fieldCard(uid)) yield* this.as(side, eff.onSummon(this, fc, side, 'normal'));
    if (this.fieldCard(uid)) yield* this.anySummon(fc, side, 'normal');
    return true;
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
    if (eff?.onSummon && this.fieldCard(uid)) yield* this.trig(m.uid, player, this.as(player, eff.onSummon(this, m, player, 'flip'), m));
    if (this.fieldCard(uid)) yield* this.anySummon(m, player, 'flip');
    if (this.fieldCard(uid)) yield* this.positionWatch(m, player);
  }

  /** Speed Duel: active Spells/Traps that watch battle position changes (Attack the Moon!). */
  *positionWatch(m: FieldCard, controller: Pid): Step {
    for (const x of this.liveST()) if (x.eff.onAnyPositionChange && this.fieldCard(m.uid)) yield* this.trig(x.c.uid, x.p, this.as(x.p, x.eff.onAnyPositionChange(this, x.c, x.p, m, controller)));
    // Face-up monsters that watch position changes too (Morpho Butterspy).
    if (this.speed)
      for (const p of [0, 1] as Pid[])
        for (const w of this.monsters(p)) {
          const h = w.faceUp ? this.effectOn(w)?.onAnyPositionChange : undefined;
          if (h && this.fieldCard(m.uid) && this.fieldCard(w.uid)) yield* this.trig(w.uid, p, this.as(p, h(this, w, p, m, controller)));
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
    if (!f || f.loc.player !== player || (f.loc.zone !== 'hand' && f.loc.zone !== 'fusion') || this.prohibited(card)) return false;
    const proc = this.procFor(card, f.loc.zone);
    if (this.chainEnergyBlocks(player)) return false;
    // audit-05/07/10: a summonRule can allow the card's own procedure ("cannot be Special Summoned by other ways"); batches read fx.procSummon, fx.procCheck or fx.procSS.
    const prevProc = this.state.fx.procSS;
    const procPrev = this.state.fx.procSummon;
    this.state.fx.procSS = card.uid;
    this.state.fx.procCheck = card.uid;
    this.state.fx.procSummon = card.uid;
    try {
      if (proc && this.summonBlocked(player, card, 'special', f.loc.zone)) return false;
      return !!proc && proc.can(this, card, player);
    } finally {
      this.state.fx.procSS = prevProc;
      this.state.fx.procCheck = undefined;
      this.state.fx.procSummon = procPrev;
    }
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

  /** Empties a Monster Zone a script moves a monster out of by hand (equipping it as a card...): its Xyz Materials go to the GY. */
  vacateMZ(ps: PlayerState, i: number) {
    const fc = ps.mz[i];
    ps.mz[i] = null;
    if (fc?.mats?.length) for (const m of fc.mats.splice(0)) this.player(m.owner).gy.push(m);
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
      this.log(player, `${ps.name} Xyz Summons ${f.card.name} using ${under.map((c) => c.name).join(', ')}`);
      // The materials are placed under the monster before anything else can happen (their equips leaving, responses).
      const placed = () => {
        // The Summon did not happen (no open zone, a Summon lock): the materials still left the field, so they go to the GY.
        if (this.find(uid)?.loc.zone === 'fusion') for (const c of under) if (!this.find(c.uid)) this.player(c.owner).gy.push(c);
      };
      const summon = this.specialSummon(uid, player, 'atk', true, (fc) => ((fc.mats = under), ((fc.tags ??= {}).xyzS = 1)));
      let step = summon.next();
      placed();
      while (!step.done) step = summon.next(yield step.value);
      // Then the materials' equips and "leaves the field" effects.
      yield* this.flushLeaves();
      return;
    }
    const names = materials.map((m) => this.find(m)?.card.name ?? '?');
    // b19: remember which monsters were used (Assault Blackwing - Onimaru, Chaos Angel, Cosmic Quasar Dragon read fx.extraMats[uid]).
    ((this.state.fx.extraMats ??= {}) as Record<number, string[]>)[uid] = names;
    for (const m of materials) if (this.fieldCard(m)) yield* this.sendToGrave(m, 'material');
    this.log(player, `${ps.name} ${kind} Summons ${f.card.name} using ${names.join(', ')}`);
    yield* this.specialSummon(uid, player, 'atk', true, (fc) => ((fc.tags ??= {})[kind === 'Synchro' ? 'synS' : 'linkS'] = 1));
  }

  private *specialProc(player: Pid, uid: number): Step {
    const f = this.find(uid);
    if (!f || !this.canSpecialProc(player, f.card)) return;
    const fromHand = f.loc.zone === 'hand';
    this.state.fx.procSS = uid; // audit-10
    this.state.fx.procSummon = uid; // audit-05
    try {
      yield* this.as(player, this.procFor(f.card, f.loc.zone)!.run(this, f.card, player));
    } finally {
      this.state.fx.procSS = undefined; // audit-10
      this.state.fx.procSummon = undefined; // audit-05
    }
    // Chain Energy charges for a card Special Summoned from the hand.
    if (fromHand && this.find(uid)?.loc.zone === 'mz') yield* this.chainEnergy(player);
  }

  /** Ignition effects of face-up monsters (Cannon Soldier, Time Wizard...). */
  canUseMonsterEffect(player: Pid, m: Card): boolean {
    if (!this.inMainPhase() || this.state.turnPlayer !== player || this.state.prompt) return false;
    const f = this.find(m.uid);
    if (!f || f.loc.player !== player || this.prohibited(m, m.uid) || this.nameLocked(m)) return false;
    const eff = this.effectOn(m);
    if (this.info(m.name).kind === 'monster' && this.monsterEffectsLocked(player, m)) return false; // b18
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
    const eff = this.scriptOf(f.card)!; // b18: copied effects
    this.log(player, `${f.card.name}'s effect activates`);
    if (f.loc.zone === 'hand') this.event('activate', { uid, player });
    if (f.loc.zone === 'hand') return yield* this.as(player, eff.handIgnition!.run(this, f.card, player));
    const m = f.card as FieldCard;
    const onChain = this.speed && f.loc.zone === 'mz' && eff.ignition!.chain !== false;
    const link: ChainLink = { card: m, loc: f.loc, player, label: m.name, negated: false, payload: { effect: 'ignition' } };
    // b17: a cost paid as the effect is activated (detach Xyz Materials), before the opponent can respond.
    if (eff.ignition!.cost) {
      const prev = this.actor;
      this.actor = player;
      let ok: boolean | void;
      try {
        ok = yield* eff.ignition!.cost(this, m, player, link);
      } finally {
        this.actor = prev;
      }
      if (ok === false) return;
    }
    if (!eff.ignition!.repeat) m.effectUsed = true;
    if (onChain) {
      // Speed Duel: the effect goes on a chain the opponent can respond to (targets and costs happen as it resolves).
      this.state.chain.push(link);
      this.event('activate', { uid, player });
      yield* this.responseWindow('effect', { uid, link });
      yield* this.resolveChain();
      return;
    }
    this.event('activate', { uid, player });
    yield* this.as(player, eff.ignition!.run(this, m, player), m);
  }

  *flipEffect(uid: number, controller: Pid): Step {
    const m = this.fieldCard(uid);
    if (!m) return;
    const eff = getEffect(m.name);
    if (eff?.flip) {
      this.event('activate', { uid, player: controller });
      this.log(controller, `${m.name}'s FLIP effect activates`);
      yield* this.as(controller, eff.flip(this, m, controller), m);
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
    if (eff?.onPositionChange) yield* this.trig(m.uid, player, this.as(player, eff.onPositionChange(this, m, player), m));
    if (this.fieldCard(uid)) yield* this.positionWatch(m, player);
  }

  canSet(player: Pid, card: Card): boolean {
    if (!this.inMainPhase() || this.state.turnPlayer !== player) return false;
    const info = this.info(card.name);
    if (info.kind === 'monster' || info.sub === 'Ticket' || this.prohibited(card)) return false;
    // b22: "This card can only be placed on the field by the effect of Destiny Board" (Spirit Message cards) cannot be Set.
    if (this.speed && /^This card can only be placed on the field by the effect of/.test(info.desc ?? '')) return false;
    if (this.chainEnergyBlocks(player)) return false;
    if (this.speed && (this.state.fx.noSetTurn as number[] | undefined)?.[player] === this.state.turn) return false; // audit-00: "You cannot Set any cards this turn" (Absorbing Jar)
    // Speed Duel: a Set Field Spell replaces the one already there too
    if (info.sub === 'Field') return !this.player(player).field || this.speed;
    return this.freeZone(this.player(player), 'sz') >= 0;
  }

  private setSpellTrap(player: Pid, uid: number, zone: number) {
    const f = this.find(uid);
    if (!f || f.loc.zone !== 'hand' || f.loc.player !== player || !this.canSet(player, f.card)) return;
    const ps = this.player(player);
    const info = this.info(f.card.name);
    if (info.sub === 'Field') {
      if (ps.field && this.speed) {
        const prev = ps.field;
        this.log(player, `${prev.faceUp ? prev.name : 'The Set Field Spell'} is replaced and sent to the GY`);
        this.run(this.sendToGrave(prev.uid, 'used'));
      }
      if (ps.field) return;
      const card = this.detach(uid)!;
      ps.field = this.toField(card, 'atk', false);
    } else {
      if (zone < 0 || zone >= ps.sz.length || ps.sz[zone] !== null || this.zoneLocked(ps, 'sz', zone)) zone = this.freeZone(ps, 'sz');
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
    if (!eff?.resolve || this.prohibited(f.card, f.card.uid) || this.activationBlocked(player, f.card)) return false;
    if (eff.activateCost && !eff.activateCost.can(this, f.card, player)) return false;
    if (f.loc.zone === 'hand' && this.chainEnergyBlocks(player)) return false;
    if (info.kind === 'spell') {
      if (this.spellsSealed() || this.activationLocked(player, 'spell') || this.cardActivationLocked(player, f.card)) return false;
      if (this.trapActive('Anti-Spell Fragrance')) {
        if (f.loc.zone === 'hand') return false;
        if ((f.card as FieldCard).placedTurn === this.state.turn) return false;
      }
      if (f.loc.zone === 'hand' && this.freeZone(this.player(player), 'sz') < 0 && info.sub !== 'Field') return false;
      // a new Field Spell replaces the one already there (that one goes to the GY)
      const curField = this.player(player).field;
      if (f.loc.zone === 'hand' && info.sub === 'Field' && curField && (!this.speed || (curField.faceUp && curField.name === f.card.name))) return false;
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
    // something is paid on the way in (Graverobber's 2000, Chain Energy's 500, the old Field Spell): no taking it back then
    let paidOnWay = false;
    if (((this.state.fx.borrowed ?? []) as number[]).includes(uid)) {
      paidOnWay = true;
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
    if (f.loc.zone === 'hand' && info.sub === 'Field' && ps.field) {
      paidOnWay = true;
      const prev = ps.field;
      this.log(player, `${prev.faceUp ? prev.name : 'The Set Field Spell'} is replaced and sent to the GY`);
      yield* this.sendToGrave(prev.uid, 'used');
      if (ps.field) return;
    }
    if (f.loc.zone === 'hand') {
      this.handSpot.set(uid, ps.hand.findIndex((c) => c.uid === uid));
      const card = this.detach(uid)!;
      if (info.sub === 'Field') {
        fc = this.toField(card, 'atk', true);
        ps.field = fc;
      } else {
        let z = zone ?? -1;
        if (z < 0 || z >= ps.sz.length || ps.sz[z] !== null || this.zoneLocked(ps, 'sz', z)) z = this.freeZone(ps, 'sz');
        fc = this.toField(card, 'atk', true);
        ps.sz[z] = fc;
      }
    } else {
      fc = f.card as FieldCard;
      fc.faceUp = true;
    }
    if (fromHand && this.spellActive('Chain Energy')) paidOnWay = true;
    if (fromHand) yield* this.chainEnergy(player);
    // backing out of its target pick (nothing paid yet) puts it back where it was, as in Master Duel
    yield* this.startChain(player, fc, 'main', {}, cost || paidOnWay ? undefined : fromHand ? 'hand' : 'set');
  }

  /** Its activation was backed out of this turn (the computer then leaves it alone for the rest of the turn). */
  takenBackThisTurn(uid: number): boolean {
    return ((this.state.fx.takenBack ?? {}) as Record<number, number>)[uid] === this.state.turn;
  }

  /** A Spell/Trap whose activation was backed out of (its target pick cancelled): back to the hand, or face-down again. */
  private undoActivation(fc: FieldCard, back: 'hand' | 'set', player: Pid) {
    const tb = ((this.state.fx.takenBack ??= {}) as Record<number, number>);
    tb[fc.uid] = this.state.turn;
    if (back === 'set') {
      fc.faceUp = false;
      fc.active = false;
    } else {
      const card = this.detach(fc.uid);
      const hand = this.player(player).hand;
      const at = this.handSpot.get(fc.uid) ?? -1;
      if (card) hand.splice(at >= 0 && at <= hand.length ? at : hand.length, 0, card);
    }
    this.handSpot.delete(fc.uid);
    if (back === 'set') this.event('set', { uid: fc.uid, player });
    // nothing was activated, so nothing is revealed (as in Master Duel)
    this.log(player, `${this.player(player).name} takes a card back`);
  }

  // ---------- chains ----------
  /** Activates a card as a new chain link, lets the opponent respond, then resolves. */
  *startChain(player: Pid, fc: FieldCard, trigger: Trigger, ctx: ChainCtx, back?: 'hand' | 'set'): Step {
    const eff = getEffect(fc.name)!;
    const link: ChainLink = { card: fc, loc: this.find(fc.uid)!.loc, player, label: fc.name, negated: false };
    // announced once its targets are picked, so backing out reveals nothing
    const announce = () => this.log(player, `${this.player(player).name} activates ${fc.name}`);
    if (!eff.activate) announce();
    if (eff.activate) {
      const prev = this.actor;
      this.actor = player;
      // already paid for on the way (a cost, Chain Energy): its picks can't be backed out of
      if (!back && trigger === 'main') this.noCancel++;
      let ok: boolean | void;
      try {
        ok = yield* eff.activate(this, link, player, ctx);
      } finally {
        if (!back && trigger === 'main') this.noCancel--;
      }
      this.actor = prev;
      if (ok === false && back && this.fieldCard(fc.uid)) return this.undoActivation(fc, back, player);
      announce();
      if (ok === false) {
        // No legal target after all: the card fizzles and goes to the GY.
        this.event('activate', { uid: fc.uid, player });
        yield* this.afterResolve(link);
        return;
      }
    }
    // announced once its targets are chosen: its cinematic plays aimed at them (and never for a card taken back)
    this.event('activate', { uid: fc.uid, player });
    this.targetEvent(link);
    this.state.chain.push(link);
    yield* this.responseWindow(this.info(fc.name).kind === 'spell' ? 'spell' : 'trap', { uid: fc.uid, link });
    yield* this.resolveChain();
  }

  private *resolveChain(): Step {
    this.resolving++;
    const prevSource = this.levelSource;
    try {
      while (this.state.chain.length > 0 && this.state.winner === null) {
        this.restoreKeptPositions(); // skills-2024b
        const link = this.state.chain.pop()!;
        this.levelSource = link.card.uid;
        if (this.speed && !link.negated) yield* this.chainLinkWatch(link);
        const effectLink = (link.payload as { effect?: string } | undefined)?.effect;
        const eff = effectLink ? this.scriptOf(link.card) : getEffect(link.card.name); // b18: copied effects
        // Speed Duel: face-up monsters that negate effects as they resolve (The End of Anubis).
        if (!link.negated && this.speed && ([0, 1] as Pid[]).some((q) => this.monsters(q).some((m) => m.faceUp && this.effectOn(m)?.negatesEffect?.(this, m, q, link) === true))) link.negated = true;
        if (effectLink) {
          // A monster's (or card's) activated effect, not the activation of a Spell/Trap card.
          if (!link.negated && this.liveST().some((x) => x.eff.negatesEffect?.(this, x.c, x.p, link) === true)) link.negated = true;
          if (link.negated) this.log(link.player, `${link.card.name}'s effect was negated`);
          else if (effectLink === 'quick' && eff?.quick) yield* this.as(link.player, eff.quick.run(this, link.card, link.player, link));
          else if (effectLink === 'ignition' && eff?.ignition && this.fieldCard(link.card.uid)) yield* this.as(link.player, eff.ignition.run(this, link.card as FieldCard, link.player));
          this.noteTargetResolved(link);
          continue;
        }
        // b22: "This card's activation and effect cannot be negated" (Spiritualism): the card's activate sets payload.cannotNegate.
        if (this.speed && link.negated && (link.payload as { cannotNegate?: boolean } | undefined)?.cannotNegate) link.negated = false;
        const stillThere = this.fieldCard(link.card.uid);
        const kind = this.info(link.card.name).kind;
        const cannotNegate = this.speed && !!(link.payload as { cannotNegate?: boolean } | undefined)?.cannotNegate;
        if (!link.negated && !cannotNegate && kind === 'spell' && this.spellsNegated()) link.negated = true;
        if (!link.negated && !cannotNegate && kind === 'trap' && this.trapsNegated(link.card.name)) link.negated = true;
        if (link.negated) {
          this.log(link.player, `${link.card.name}'s effect was negated`);
        } else if (eff?.resolve && (stillThere || cannotNegate || this.resolvesFromGrave(link))) {
          yield* this.as(link.player, eff.resolve(this, link, link.player));
        }
        if (!link.negated) this.noteTargetResolved(link);
        yield* this.afterResolve(link);
      }
    } finally {
      this.restoreKeptPositions(); // skills-2024b
      this.resolving--;
      this.levelSource = prevSource;
    }
    this.state.chain = [];
    yield* this.flushLeaves();
    yield* this.damageWindow(false);
    yield* this.flushSummonWindows();
  }

  /**
   * Speed Duel: a Normal or Quick-Play Spell, a Ritual Spell, or a Normal or Counter Trap destroyed in the
   * chain still resolves (Master Duel and the real rules); Continuous, Equip and Field cards need to stay.
   */
  /**
   * skills-2024b: a chain link that may not change some monsters' battle positions (Dino Brain Immunity: Trap effects and
   * Dinosaurs). Right before it resolves, the watcher marks them with tags.keepPos (4 + 1 if Defense + 2 if face-down);
   * once it has resolved, a monster still on the field gets that position back.
   */
  private restoreKeptPositions() {
    for (const p of [0, 1] as Pid[])
      for (const m of this.monsters(p)) {
        const k = m.tags?.keepPos;
        if (!k) continue;
        delete m.tags!.keepPos;
        const pos: Pos = k & 1 ? 'def' : 'atk';
        const faceUp = !(k & 2);
        if (m.pos === pos && m.faceUp === faceUp) continue;
        m.pos = pos;
        m.faceUp = faceUp;
        this.log(p, `${faceUp ? m.name : 'The monster'}'s battle position cannot be changed`);
      }
  }

  private resolvesFromGrave(link: ChainLink): boolean {
    if (!this.speed || (link.payload as { effect?: string } | undefined)?.effect) return false;
    const info = this.info(link.card.name);
    if (info.kind !== 'spell' && info.kind !== 'trap') return false;
    if (!['Normal', 'Quick-Play', 'Ritual', 'Counter'].includes(info.sub)) return false;
    return this.find(link.card.uid)?.loc.zone === 'gy';
  }

  /** Speed Duel: face-up monsters see each chain link right before it resolves (Freed the Matchless General, Angel O7). */
  private *chainLinkWatch(link: ChainLink): Step {
    for (const p of [0, 1] as Pid[]) {
      for (const m of this.monsters(p)) {
        if (link.negated || this.state.winner !== null || !m.faceUp || !this.fieldCard(m.uid)) continue;
        const h = this.effectOn(m)?.onChainLink;
        if (h) yield* this.trig(m.uid, p, this.as(p, h(this, m, p, link)));
      }
    }
    for (const x of this.skillFx()) if (x.eff.onChainLink && !link.negated && this.state.winner === null) yield* this.as(x.p, x.eff.onChainLink(this, x.c, x.p, link)); // audit-skills
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

  /**
   * b22: a resolved chain link that targeted a face-up monster (link.targetUid): fx.targetResolved[uid] = 1 until the
   * state checks after the action (Spirit Reaper: "After resolving a card effect that targets this face-up card, destroy this card").
   */
  private noteTargetResolved(link: ChainLink) {
    if (!this.speed || link.negated || link.targetUid === undefined) return;
    const m = this.fieldCard(link.targetUid);
    if (m?.faceUp && this.find(m.uid)?.loc.zone === 'mz') ((this.state.fx.targetResolved ??= {}) as Record<number, number>)[m.uid] = 1;
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
    // audit-skills: a negated card Set again instead of going to the GY (I'm Just Gonna Attack!).
    if (link.negated && this.state.fx.setInstead === fc.uid && this.find(fc.uid)?.loc.zone === 'sz') {
      this.state.fx.setInstead = undefined;
      Object.assign(fc, { faceUp: false, active: false, placedTurn: this.state.turn, equips: [], counters: 0 });
      this.log(this.controller(fc.uid), `${fc.name} is Set again instead of going to the GY`);
      return;
    }
    yield* this.sendToGrave(fc.uid, 'used');
  }

  /** Gives each player (opponent first) a chance to respond with a set card. Up to 3 responses, like EDS. */
  *responseWindow(trigger: Trigger, ctx: ChainCtx): Step {
    const rootHasLink = !!ctx.link;
    // audit-09: "neither player can activate cards or effects in response to this card's activation" (Super Polymerization).
    if (this.speed && (ctx.link?.payload as { noResponse?: boolean } | undefined)?.noResponse) return;
    let responder: Pid = other(this.state.turnPlayer);
    if (ctx.link) responder = other(ctx.link.player);
    let passes = 0;
    let depth = 0;
    const cancels = new Map<number, number>(); // take-backs per card in this window
    const dropped = new Set<number>(); // cards taken back twice in this window
    while (passes < 2 && depth < 10 && this.state.winner === null) {
      const options = this.responsesFor(responder, trigger, ctx).filter((o) => o.uid === undefined || !dropped.has(o.uid));
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
        let fc = opt ? this.fieldCard(opt.uid!) : null;
        const fromHand = !fc && !!opt && opt.value === 'hand';
        let handPaid = false;
        // a Quick-Play Spell from the hand: it is placed face-up in a Spell & Trap Zone first
        if (!fc && opt && opt.value === 'hand') {
          const ps = this.player(responder);
          const z = this.freeZone(ps, 'sz');
          const f = this.find(opt.uid!);
          if (z >= 0 && f && f.loc.zone === 'hand') {
            const cost = getEffect(f.card.name)?.activateCost;
            let paid = true;
            if (cost) {
              const prev = this.actor;
              this.actor = responder;
              paid = (yield* cost.pay(this, f.card, responder)) !== false;
              this.actor = prev;
            }
            if (paid && this.find(opt.uid!)?.loc.zone === 'hand' && ps.sz[z] === null) {
              // the same bookkeeping as an activation in the Main Phase (Graverobber's borrowed card, Chain Energy)
              handPaid = !!this.spellActive('Chain Energy');
              if (((this.state.fx.borrowed ?? []) as number[]).includes(opt.uid!)) {
                handPaid = true;
                this.log(responder, `Graverobber: ${ps.name} takes 2000 damage for using ${f.card.name}`);
                this.damage(responder, 2000);
                this.state.fx.borrowed = (this.state.fx.borrowed as number[]).filter((u) => u !== opt.uid);
              }
              this.handSpot.set(opt.uid!, ps.hand.findIndex((c) => c.uid === opt.uid));
              const card = this.detach(opt.uid!)!;
              fc = ps.sz[z] = this.toField(card, 'atk', true);
              fc.placedTurn = this.state.turn;
              if (this.state.winner === null) yield* this.chainEnergy(responder);
              if (this.state.winner !== null || !this.fieldCard(fc.uid)) fc = null;
            }
          }
        }
        if (fc) {
          fc.faceUp = true;
          const eff = getEffect(fc.name)!;
          const link: ChainLink = { card: fc, loc: this.find(fc.uid)!.loc, player: responder, label: fc.name, negated: false };
          const prev = this.actor;
          this.actor = responder;
          const locked = fromHand && (handPaid || !!getEffect(fc.name)?.activateCost);
          if (locked) this.noCancel++;
          let ok: boolean | void = true;
          try {
            if (eff.activate) ok = yield* eff.activate(this, link, responder, ctx);
          } finally {
            if (locked) this.noCancel--;
          }
          this.actor = prev;
          const takeBack = ok === false && !!this.fieldCard(fc.uid) && !(fromHand && (handPaid || getEffect(fc.name)?.activateCost));
          if (!takeBack) this.log(responder, `${this.player(responder).name} activates ${fc.name}`);
          if (takeBack) {
            // backed out of its target pick: back to the hand / face-down, and the same window is offered
            // again (a card backed out of twice here drops out of it, so nothing can loop)
            this.undoActivation(fc, fromHand ? 'hand' : 'set', responder);
            const n = (cancels.get(fc.uid) ?? 0) + 1;
            cancels.set(fc.uid, n);
            if (n >= 2) dropped.add(fc.uid);
            continue;
          } else if (ok === false) {
            this.event('activate', { uid: fc.uid, player: responder });
            yield* this.afterResolve(link);
          } else {
            this.event('activate', { uid: fc.uid, player: responder });
            this.targetEvent(link);
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
      case 'attack': {
        // name the target too, so a Trap can be judged without looking for it
        const t = this.state.battle?.target != null ? this.fieldCard(this.state.battle.target) : null;
        const at = !t ? ' directly' : t.faceUp ? ` ${t.name}` : ' a face-down monster';
        return `${this.find(ctx.uid!)?.card.name ?? 'A monster'} attacks${at}. Respond?`;
      }
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
      if (!q || (q.from ?? 'field') !== from || this.prohibited(c, from === 'field' ? c.uid : undefined)) return;
      if (from === 'field') {
        const fc = c as FieldCard;
        if (!fc.faceUp && !(q.faceDown && this.find(c.uid)?.loc.zone === 'mz')) return; // audit-eds: Big Shield Gardna
        const kind = this.info(c.name).kind;
        if (kind !== 'monster' && !fc.active) return;
        if ((kind === 'spell' && this.spellsNegated()) || (kind === 'trap' && this.trapsNegated(c.name))) return;
      }
      if (!q.repeat && !this.oncePerTurn(`quick:${c.name}:${from === 'field' ? c.uid : 0}`, player)) return;
      if (from === 'gy' && this.graveSTLocked(c)) return; // audit-02
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
    const q = (f.loc.zone === 'mz' ? this.scriptOf(f.card) : getEffect(f.card.name))?.quick; // b18: copied effects
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
    this.targetEvent(link);
    this.state.chain.push(link);
    return link;
  }

  /** Set spells/traps the player could activate right now against the trigger. */
  responsesFor(player: Pid, trigger: Trigger, ctx: ChainCtx): SelectOption[] {
    // audit-00: "your opponent cannot activate cards or effects in response to this card's activation" (Abyss Script - Rise of the Abyss King).
    if (this.speed && ctx.link && ctx.link.player !== player && this.state.fx.unchainable === ctx.link.card.uid && this.state.chain.includes(ctx.link)) return [];
    const out: SelectOption[] = this.speed ? this.quickOptions(player, trigger, ctx) : [];
    const sealed = this.attackSealed(player);
    for (const fc of this.spells(player)) {
      if (fc.faceUp || sealed) continue;
      const info = this.info(fc.name);
      const eff = getEffect(fc.name);
      if (!eff?.resolve || !eff.canActivate || this.prohibited(fc, fc.uid) || this.activationBlocked(player, fc)) continue;
      if ((info.kind === 'spell' || info.kind === 'trap') && (this.activationLocked(player, info.kind) || this.cardActivationLocked(player, fc))) continue;
      if (info.kind === 'trap' && (fc.placedTurn === this.state.turn || this.trapsSealed(player))) continue;
      if (info.kind === 'spell' && (info.sub !== 'Quick-Play' || this.spellsSealed())) continue;
      if (info.kind === 'spell' && fc.placedTurn === this.state.turn) continue;
      if (this.withActor(player, () => eff.canActivate!(this, fc, player, trigger, ctx))) out.push({ label: fc.name, uid: fc.uid, loc: this.find(fc.uid)!.loc });
    }
    // Speed Duel: on your own turn a Quick-Play Spell can be activated straight from the hand in response to
    // your opponent's card or effect (not offered after your own moves, so it never nags).
    // Also when your own monster attacks, for the cards that change a battle (Shrink, Rising Energy...).
    const myAttack = trigger === 'attack' && !ctx.link && !!this.state.battle && this.controller(this.state.battle.attacker) === player;
    if (this.speed && player === this.state.turnPlayer && ((ctx.link && ctx.link.player !== player) || myAttack) && !sealed && !this.spellsSealed() && !this.activationLocked(player, 'spell') && this.freeZone(this.player(player), 'sz') >= 0 && !this.trapActive('Anti-Spell Fragrance') && !this.chainEnergyBlocks(player)) {
      for (const c of this.player(player).hand) {
        const info = this.info(c.name);
        const eff = getEffect(c.name);
        if (info.kind !== 'spell' || info.sub !== 'Quick-Play' || out.some((o) => o.uid === c.uid)) continue;
        if (myAttack && !(ctx.link && ctx.link.player !== player) && !/\bATK\b|\bDEF\b|battle/i.test(info.desc ?? '')) continue;
        if (!eff?.resolve || !eff.canActivate || this.prohibited(c, c.uid) || this.activationBlocked(player, c) || this.cardActivationLocked(player, c)) continue;
        if (eff.activateCost && !eff.activateCost.can(this, c, player)) continue;
        if (this.withActor(player, () => eff.canActivate!(this, c, player, trigger, ctx))) out.push({ label: c.name, uid: c.uid, loc: this.find(c.uid)!.loc, value: 'hand' });
      }
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
    if (m.pos !== 'atk' && !eff?.attackInDefense && !this.skillDefs().some((x) => x.p === player && x.sk.attackInDefense?.(this, player, m))) return false; // audit-skills
    if (this.skillDefs().some((x) => x.p === player && x.sk.mayAttack?.(this, player, m) === false)) return false; // audit-skills
    if (eff?.cannotAttack?.(this, m, player)) return false;
    if ((m.tags?.noAttackTurn ?? -1) === s.turn) return false;
    if (this.speed && (m.tags?.noAttackTurn2 ?? -1) === s.turn) return false; // audit-06: a second turn it cannot attack (Harpie Lady 3)
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
    // b19: a face-up monster's blocksAttack stops other monsters attacking (Beelzeus of the Diabolic Dragons, Cloudcastle).
    if (this.speed) for (const p of [0, 1] as Pid[]) for (const src of this.monsters(p)) if (src.faceUp && src.uid !== m.uid && this.effectOn(src)?.blocksAttack?.(this, src, m, player)) return false;
    if (this.speed && this.skillFx().some((x) => x.eff.blocksAttack?.(this, x.c, m, player))) return false; // skills-2024b: Skills stopping either player's attacks (Mokey Mokey Madness)
    if (eff?.attackCost && !eff.attackCost.can(this, m, player)) return false;
    return true;
  }

  canAttackDirectly(m: FieldCard): boolean {
    if (this.speed && m.tags?.directTurn === this.state.turn) return true;
    // skills-2024a: monsters that "cannot be targeted for attacks, but do not prevent your opponent from attacking you directly" (Fear of the Dark).
    const atkCtl = this.speed ? this.controller(m.uid) : null;
    if (atkCtl !== null && this.monsters(other(atkCtl)).length > 0 && this.monsters(other(atkCtl)).every((t) => t.tags?.noAttackTarget)) return true;
    const owner = this.controller(m.uid); // audit-skills: Skills letting monsters attack directly
    if (owner !== null && this.skillDefs().some((x) => x.p === owner && x.sk.canAttackDirectly?.(this, owner, m))) return true;
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
    // audit-08: mandatory "when an attack is declared" effects of face-up cards and of cards in the GY.
    if (this.speed) {
      const tgt = targetUid !== null ? this.fieldCard(targetUid) : null;
      for (const x of this.liveCards()) if (x.eff.onAttackDeclared && this.state.battle && this.state.winner === null && this.fieldCard(x.c.uid) && this.fieldCard(uid)) yield* this.as(x.p, x.eff.onAttackDeclared(this, x.c, x.p, m, tgt));
      for (const q of [0, 1] as Pid[]) for (const c of this.player(q).gy.slice()) { const h = getEffect(c.name)?.onAttackDeclaredInGrave; if (h && this.state.battle && this.state.winner === null && this.find(c.uid)?.loc.zone === 'gy' && this.fieldCard(uid)) yield* this.as(q, h(this, c, q, m, tgt)); }
      if (this.state.winner !== null || !this.state.battle) return;
    }
    // audit-skills: Skills that react to an attack declaration (Behold, Gate Guardian!, Small Roid Big City).
    for (const x of this.skillDefs()) {
      const a = this.fieldCard(uid);
      const t = targetUid !== null ? this.fieldCard(targetUid) : null;
      if (x.sk.onAttack && a && this.state.battle && this.state.winner === null && (targetUid === null || t)) yield* this.as(x.p, x.sk.onAttack(this, x.p, a, t));
    }
    if (!this.state.battle) return;
    const defendersBefore = new Set(this.monsters(other(player)).map((x) => x.uid));
    const declared = targetUid;
    yield* this.responseWindow('attack', { uid, targetUid: targetUid ?? undefined });
    if (this.state.winner !== null) return;
    if (!this.state.battle) return; // Waboku and friends end the battle
    const redirected = this.state.battle.target !== declared;
    targetUid = this.state.battle.target; // Magical Arm Shield can redirect it
    const attacker = this.fieldCard(uid);
    if (!attacker || this.controller(uid) !== player || (attacker.pos !== 'atk' && !getEffect(attacker.name)?.attackInDefense && !this.skillDefs().some((x) => x.p === player && x.sk.attackInDefense?.(this, player, attacker)))) { // audit-skills
      this.state.battle = null;
      return; // attacker was destroyed, taken, or forced into Defense
    }
    // Speed Duel replay: the defender's monsters changed in response (Call of the Haunted, Trap Hole on a
    // monster Summoned in response...), so the attacker picks a new target, attacks directly, or stops.
    const nowDefenders = this.monsters(other(player));
    if (this.speed && !redirected && (nowDefenders.length !== defendersBefore.size || nowDefenders.some((x) => !defendersBefore.has(x.uid)))) {
      const opts: SelectOption[] = this.legalTargets(player, attacker).map((t) => ({ label: t.faceUp ? t.name : 'Face-down monster', uid: t.uid, loc: this.find(t.uid)!.loc }));
      if (nowDefenders.length === 0 || this.canAttackDirectly(attacker)) opts.push({ label: 'Attack directly', value: 'direct' });
      const picks = opts.length ? yield* this.select(player, `Replay: ${attacker.name} attacks which?`, opts, 1, 1, true) : null;
      if (this.state.winner !== null || !this.state.battle || !this.fieldCard(uid)) return;
      if (!picks) {
        this.log(player, `${attacker.name} stops its attack`);
        this.state.battle = null;
        return;
      }
      const o = opts[picks[0]];
      targetUid = o.uid ?? null;
      this.state.battle.target = targetUid;
      this.log(player, `Replay: ${attacker.name} attacks ${o.uid !== undefined ? o.label : 'directly'}`);
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
    const k = this.player(p).hand.find((c) => this.isNamed(c, 'Kuriboh'));
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
    // audit-06: battle damage a monster inflicts is treated as effect damage (Gravekeeper's Vassal): battle-damage protection does not apply.
    if (this.speed && [a, t].some((m) => m && m.faceUp && this.controller(m.uid) === other(p) && this.effectOn(m)?.battleAsEffect)) return this.damage(p, amount);
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
    const reflect = [a, t].some((m) => m && this.isNamed(m, 'Relinquished') && this.controller(m.uid) === p && m.tags?.absorbed);
    if (reflect && this.state.winner === null) {
      this.log(p, 'Relinquished passes the damage on');
      this.damage(other(p), amount);
    }
  }

  private *damageStep(player: Pid, attacker: FieldCard, target: FieldCard | null): Step {
    const opp = other(player);
    const aEff = this.effectOn(attacker);
    // audit-00: "at the start of the Damage Step" effects of the face-up battling monsters (Ally of Justice Core Destroyer, Armed Dragon LV10 White).
    if (this.speed) {
      for (const [m, foe, ctl] of [[attacker, target, player], [target, attacker, opp]] as [FieldCard | null, FieldCard | null, Pid][]) {
        const h = m && m.faceUp && this.fieldCard(m.uid) ? this.effectOn(m)?.damageStepStart : undefined;
        if (h && m && this.state.winner === null) yield* this.as(ctl, h(this, m, foe && this.fieldCard(foe.uid) ? foe : null, ctl));
      }
      if (this.state.winner !== null || !this.fieldCard(attacker.uid) || (target && !this.fieldCard(target.uid))) return;
    }
    if (!target) {
      let dmg = this.atkOf(attacker) + this.attackBonus(attacker, null);
      dmg = yield* this.kuriboh(opp, dmg);
      this.event('hit', { uid: attacker.uid, player: opp });
      this.battleDamage(opp, dmg, attacker, null);
      if (dmg > 0 && this.state.winner === null) {
        if (aEff?.onBattleDamage) yield* this.trig(attacker.uid, player, this.as(player, aEff.onBattleDamage(this, attacker, player)));
        yield* this.battleDamageDealt(player, attacker);
      }
      yield* this.damageWindow(true);
      return;
    }
    // audit-09: the attacker acts at the start of the Damage Step, before a face-down target is flipped (Sasuke Samurai).
    if (this.speed && aEff?.startDamageStep) {
      yield* this.as(player, aEff.startDamageStep(this, attacker, target, player));
      if (this.state.winner !== null || !this.fieldCard(target.uid) || !this.fieldCard(attacker.uid)) return;
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
    if (tEff?.onBeingAttacked) yield* this.trig(target.uid, opp, this.as(opp, tEff.onBeingAttacked(this, target, attacker, opp)));
    // audit-04: the attacker's own "before damage calculation" effect (Drillroid, Eater of Millions).
    if (this.speed && aEff?.beforeDamageCalc && this.fieldCard(target.uid) && this.fieldCard(attacker.uid)) yield* this.trig(attacker.uid, player, this.as(player, aEff.beforeDamageCalc(this, attacker, target, player)));
    // skills-2024b: Skills acting before damage calculation, for either player's monster (Wise Man Neos); `controller` is the Skill's owner.
    if (this.speed) for (const x of this.skillFx()) if (x.eff.beforeDamageCalc && this.fieldCard(target.uid) && this.fieldCard(attacker.uid) && this.state.winner === null) yield* this.trig(undefined, x.p, this.as(x.p, x.eff.beforeDamageCalc(this, attacker, target, x.p)));
    if (this.speed && aEff?.attackerDamageStep && this.fieldCard(target.uid) && this.fieldCard(attacker.uid)) yield* this.trig(attacker.uid, player, this.as(player, aEff.attackerDamageStep(this, attacker, target, player))); // audit-10
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
          if (aEff?.onBattleDamage) yield* this.trig(attacker.uid, player, this.as(player, aEff.onBattleDamage(this, attacker, player)));
          yield* this.battleDamageDealt(player, attacker);
        }
      } else if (atk < tAtk) {
        destroyed.push(attacker.uid);
        const lp0 = this.player(player).lp; // audit-10
        this.battleDamage(player, tAtk - atk, attacker, target);
        this.log(opp, `${target.name} destroys ${attacker.name}`);
        if (this.speed && this.player(player).lp < lp0 && this.state.winner === null && tEff?.onTargetBattleDamage) yield* this.as(opp, tEff.onTargetBattleDamage(this, target, attacker, opp)); // audit-10
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
        const turnPierce = this.speed && attacker.tags?.pierceTurn === this.state.turn; // audit-06: piercing until the end of the turn (H - Heated Heart)
        if ((pierce && (typeof pierce !== 'function' || pierce(this, attacker))) || granted || tagged || turnPierce) {
          this.log(player, `${attacker.name} pierces the defense`);
          const lp = this.player(opp).lp;
          this.battleDamage(opp, atk - tDef, attacker, target);
          if (this.state.winner === null && aEff?.onBattleDamage) yield* this.trig(attacker.uid, player, this.as(player, aEff.onBattleDamage(this, attacker, player)));
          if (this.player(opp).lp < lp) yield* this.battleDamageDealt(player, attacker);
        }
      } else if (atk < tDef) {
        const lp0 = this.player(player).lp; // audit-10
        this.battleDamage(player, tDef - atk, attacker, target);
        this.log(opp, `${target.name} holds; ${attacker.name}'s controller takes damage`);
        if (this.speed && this.player(player).lp < lp0 && this.state.winner === null && tEff?.onTargetBattleDamage) yield* this.as(opp, tEff.onTargetBattleDamage(this, target, attacker, opp)); // audit-10
      } else {
        this.log(null, `${attacker.name} bounces off ${target.name}`);
      }
    }
    if (this.state.winner !== null) return;
    yield* this.damageWindow(false);
    if (this.state.winner !== null) return;
    // audit-03: "after damage calculation" effects of either battling monster, before battle destruction (D.D. Warrior Lady).
    if (this.speed) {
      let hit = false;
      for (const [m, ctl, foe] of [[attacker, player, target], [target, opp, attacker]] as [FieldCard, Pid, FieldCard][]) {
        const h = this.fieldCard(m.uid)?.faceUp ? this.effectOn(m)?.afterDamageCalc : undefined;
        if (!h || this.state.winner !== null || !this.fieldCard(foe.uid)) continue;
        hit = true;
        yield* this.as(ctl, h(this, m, ctl, foe));
      }
      // b23: face-up monsters reacting after damage calculation of any battle (Tiki Curse).
      for (const q of [0, 1] as Pid[])
        for (const s of this.monsters(q)) {
          const h = s.faceUp ? this.effectOn(s)?.anyAfterDamageCalc : undefined;
          if (!h || this.state.winner !== null || !this.fieldCard(attacker.uid) || !this.fieldCard(target.uid)) continue;
          hit = true;
          yield* this.as(q, h(this, s, q, attacker, target));
        }
      // Monsters that already left the field (banished) are no longer destroyed by this battle.
      if (hit) for (let i = destroyed.length - 1; i >= 0; i--) if (!this.fieldCard(destroyed[i])) destroyed.splice(i, 1);
    }
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
    // audit-08: remember which monsters destroyed a monster by battle this turn (Nordic Relic Laevateinn).
    if (this.speed) for (const [k, w] of [[target, attacker], [attacker, target]] as const) if (destroyed.includes(k.uid) && !this.fieldCard(k.uid) && this.fieldCard(w.uid)) (w.tags ??= {}).killTurn = this.state.turn;
    this.state.fx.battleMuted = [];
    // FLIP effects resolve after damage calculation, even if the monster is destroyed.
    if (wasFaceDown && tEff?.flip && this.speed && ((targetDestroyed && aEff?.negatesVictimFlip) || (!this.fieldCard(targetUid) && aEff?.negatesBattleFlip?.(this, attacker, target)))) {
      this.log(player, `${attacker.name} negates ${target.name}'s FLIP effect`);
    } else if (wasFaceDown && tEff?.flip && !muted.includes(targetUid)) {
      this.event('activate', { uid: targetUid, player: opp });
      this.log(opp, `${target.name}'s FLIP effect activates`);
      yield* this.as(opp, tEff.flip(this, target, opp, !this.fieldCard(targetUid)), target);
    }
    if (this.state.winner !== null) return;
    for (const x of this.liveST()) if (x.eff.onBattleEnd && this.state.winner === null) yield* this.trig(x.c.uid, x.p, this.as(x.p, x.eff.onBattleEnd(this, x.c, x.p, attacker, target, atk, tAtkCalc)));
    if (tEff?.onAttacked && !muted.includes(targetUid)) yield* this.trig(target.uid, opp, this.as(opp, tEff.onAttacked(this, target, attacker, opp, targetDestroyed)));
    if (targetDestroyed && tEff?.onDestroyedByBattle && !muted.includes(targetUid)) yield* this.trig(target.uid, opp, this.as(opp, tEff.onDestroyedByBattle(this, target, opp)));
    if (attackerDestroyed && aEff?.onDestroyedByBattle && !muted.includes(attacker.uid)) yield* this.trig(attacker.uid, player, this.as(player, aEff.onDestroyedByBattle(this, attacker, player)));
    if (aEff?.afterBattle && this.fieldCard(attacker.uid)) yield* this.trig(attacker.uid, player, this.as(player, aEff.afterBattle(this, attacker, target, player, targetDestroyed)));
    for (const uid of attacker.equips.slice()) {
      const eq = this.fieldCard(uid);
      const h = eq ? getEffect(eq.name)?.hostAfterBattle : undefined;
      if (eq && h) yield* this.trig(eq.uid, player, this.as(player, h(this, eq, attacker, target)));
    }
    // Speed Duel: face-up Spells/Traps that react after every battle (Amazoness Onslaught, Battleguard Rage).
    for (const p of [player, opp]) {
      for (const c of this.activeSpells(p)) {
        const h = getEffect(c.name)?.afterAnyBattle;
        const kind = this.info(c.name).kind;
        if (!h || this.state.winner !== null || !this.fieldCard(c.uid) || (kind === 'spell' && this.spellsNegated()) || (kind === 'trap' && this.trapsNegated(c.name))) continue;
        yield* this.trig(c.uid, p, this.as(p, h(this, c, p, attacker, target)));
      }
    }
    for (const x of this.skillFx()) if (x.eff.afterAnyBattle && this.state.winner === null) yield* this.as(x.p, x.eff.afterAnyBattle(this, x.c, x.p, attacker, target)); // audit-skills
    for (const l of this.lingering()) {
      const h = l.eff.lingering?.afterAnyBattle;
      if (h && this.state.winner === null) yield* this.as(l.p, h(this, l.p, attacker, target));
    }
    // b23: cards in a hand at the end of the Damage Step (Thunder Ball).
    if (this.speed)
      for (const q of [player, opp])
        for (const c of this.player(q).hand.slice()) {
          const h = getEffect(c.name)?.battleEndInHand;
          if (h && this.state.winner === null && this.find(c.uid)?.loc.zone === 'hand') yield* this.trig(c.uid, q, this.as(q, h(this, c, q, attacker, target)));
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
    if (killer.equips.some((u) => { const eq = this.fieldCard(u); return !!eq && eq.faceUp && !(this.info(eq.name).kind === 'spell' && this.spellsNegated()) && getEffect(eq.name)?.negatesBattleVictims?.(this, eq, killer, killerCtl) === true; })) return true; // audit-10: an Equip Spell on the killer (Wicked-Breaking Flamberge - Baou)
    if (this.skillFx().some((x) => x.p === killerCtl && x.eff.negatesBattleVictims?.(this, x.c, killer, killerCtl) === true)) return true; // audit-skills
    return this.monsters(killerCtl).some((s) => s.faceUp && this.effectOn(s)?.negatesBattleVictims?.(this, s, killer, killerCtl) === true);
  }

  /** ATK added only while attacking (Metalmorph, Insect Soldiers of the Sky). */
  private attackBonus(attacker: FieldCard, target: FieldCard | null): number {
    let bonus = this.effectOn(attacker)?.attackBonus?.(this, attacker, target) ?? 0;
    const ctl = this.controller(attacker.uid); // audit-skills: Skills adding ATK in damage calculation
    for (const x of this.skillDefs()) if (x.p === ctl) bonus += x.sk.attackBonus?.(this, x.p, attacker, target) ?? 0;
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
        if (h && this.state.winner === null) yield* this.trig(c.uid, player, this.as(player, h(this, c, player, attacker)));
      }
    for (const c of this.activeSpells(player)) {
      const eff = getEffect(c.name);
      const kind = this.info(c.name).kind;
      if ((kind === 'spell' && this.spellsNegated()) || (kind === 'trap' && this.trapsNegated(c.name))) continue;
      if (eff?.onBattleDamageDealt) yield* this.trig(c.uid, player, eff.onBattleDamageDealt(this, c, attacker, player));
    }
    for (const x of this.skillFx()) if (x.p === player && x.eff.onBattleDamageDealt && this.state.winner === null) yield* this.as(x.p, x.eff.onBattleDamageDealt(this, x.c, attacker, player)); // audit-skills
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
