// The duel engine: enforces the 2002 rules the way The Eternal Duelist Soul did.
// Everything that needs a decision from a player is written as a generator that
// yields a Prompt; the engine parks the generator until the answer arrives.

import type { Action, Card, CardInfo, ChainLink, DuelState, FieldCard, Loc, Phase, Pid, PlayerState, Pos, Prompt, Rules, SeatSetup, SelectOption } from './types';
import { EDS_RULES, MONSTER_ZONES, PHASES, PHASE_NAME, STARTING_LP, ST_ZONES, rulesFor } from './types';
import { getEffect, setNameResolver, type Trigger } from './effects';
import { getSkill } from './skills';

export type Choice = { picks: number[] } | 'cancel' | 'pass' | true | false;
export type Step = Generator<Prompt, void, Choice>;

export class RulesError extends Error {}

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
    if (how === 'battle' && own?.battleProof?.(this, m)) return true;
    if (how === 'effect' && own?.effectProof?.(this, m)) return true;
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
    return false;
  }

  /** A card's script, or nothing while its effects are negated (Speed Duel scripts can negate monsters). */
  effectOn(c: Card) {
    if ('faceUp' in c && this.isNegated(c as FieldCard)) return undefined;
    return getEffect(c.name);
  }

  isNegated(m: FieldCard): boolean {
    return !!m.faceUp && (m.tags?.negated === 1 || m.tags?.negatedTurn === this.state.turn);
  }

  /** "Once per turn" by card name: true if `key` was not used yet this turn by `p`. */
  oncePerTurn(key: string, p: Pid): boolean {
    const used = (this.state.fx.opt ?? {}) as Record<string, number>;
    return used[`${p}|${key}`] !== this.state.turn;
  }

  useOnce(key: string, p: Pid) {
    ((this.state.fx.opt ??= {}) as Record<string, number>)[`${p}|${key}`] = this.state.turn;
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

  event(kind: string, extra: { uid?: number; player?: Pid; amount?: number } = {}) {
    this.state.lastEvent = { kind, ...extra, seq: ++this.seq };
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
    if (wall && this.fieldCard(wall)?.active) v = Math.floor(v / 2);
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
      if (fx.dnaRace && fx.dnaSource && this.fieldCard(fx.dnaSource)?.active && m.faceUp) return fx.dnaRace;
      const ctl = this.controller(m.uid);
      if (ctl !== null && this.monsters(ctl).some((x) => x.faceUp && x.name === 'Parasite Paracide' && x.owner !== ctl)) return 'Insect';
    }
    return this.info(m.name).race ?? '';
  }

  /** Is any face-up, active copy of this card on the field? */
  anyActive(name: string, p?: Pid): FieldCard | null {
    for (const q of p === undefined ? ([0, 1] as Pid[]) : [p]) {
      for (const c of this.activeSpells(q)) if (c.name === name) return c;
      for (const m of this.monsters(q)) if (m.faceUp && m.name === name) return m;
    }
    return null;
  }

  /** Imperial Order: Spell effects on the field are negated. */
  spellsNegated(): boolean {
    return !!this.anyActive('Imperial Order');
  }

  /** Royal Decree: other Trap effects are negated. */
  trapsNegated(except?: string): boolean {
    return !!this.anyActive('Royal Decree') && except !== 'Royal Decree';
  }

  /** Is this card name forbidden by Prohibition? */
  prohibited(name: string): boolean {
    const list = (this.state.fx.prohibit ?? []) as { name: string; src: number }[];
    return list.some((x) => x.name === name && this.fieldCard(x.src)?.active);
  }

  /** Lord of D.: Dragons cannot be targeted by card effects. */
  untargetable(m: FieldCard): boolean {
    if (m.faceUp && this.effectOn(m)?.cannotBeTargeted?.(this, m, this.actor)) return true;
    if (m.faceUp && this.speed && this.shielded(m, 'target')) return true;
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
        if (this.info(src.name).kind === 'spell' && this.spellsNegated()) continue;
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
    const m = desc.match(/^"([^"]+)"\s*\+\s*"([^"]+)"(?:\s*\+\s*"([^"]+)")?/);
    if (!m) return null;
    return [m[1], m[2], m[3]].filter((x): x is string => !!x).map((x) => this.info(x).id);
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
      case 'mz':
        ps.mz[f.loc.index] = null;
        break;
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
    const ps = this.player(controller);
    const zone = ps.mz.findIndex((z) => z === null);
    if (zone < 0) return null;
    const card: Card = { uid: this.state.uidCounter++, name, owner: controller, token: true };
    const fc = this.toField(card, pos, faceUp);
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
  *sendToGrave(uid: number, reason: 'destroyed' | 'discard' | 'tribute' | 'used' | 'mill' | 'cost' = 'destroyed'): Step {
    const f = this.find(uid);
    if (!f) return;
    const byBattle = this.battleKill;
    this.battleKill = false;
    const wasField = f.loc.zone === 'mz' || f.loc.zone === 'sz' || f.loc.zone === 'field';
    const fc = wasField ? (f.card as FieldCard) : null;
    if (f.loc.zone === 'mz') (this.state.fx.lostMonster ??= [-1, -1])[f.loc.player] = this.state.turn;
    const controller = f.loc.player;
    const card = this.detach(uid)!;
    if (card.token || card.name.startsWith('__token')) {
      if (fc) {
        for (const eqUid of fc.equips.slice()) yield* this.sendToGrave(eqUid, 'used');
        const eff = getEffect(card.name);
        if (eff?.onLeaveField) yield* eff.onLeaveField(this, fc, controller, reason);
      }
      return;
    }
    const banisher = [...this.monsters(0), ...this.monsters(1)].some((m) => m.faceUp && m.name === 'Banisher of the Light');
    if (banisher) {
      this.player(card.owner).removed.push(card);
      this.log(card.owner, `${card.name} is removed from play by Banisher of the Light`);
    } else this.player(card.owner).gy.push(card);
    this.event('to-gy', { uid, player: card.owner });
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
      const eff = getEffect(card.name);
      if (eff?.onLeaveField) yield* eff.onLeaveField(this, fc, controller, reason);
      if (f.loc.zone === 'mz' && eff?.onToGraveFromField) yield* eff.onToGraveFromField(this, card, controller);
    }
    // Speed Duel card scripts: "if this card is sent to the GY" and "if this card is destroyed".
    const eff = getEffect(card.name);
    if (this.state.winner === null && (eff?.onSentToGrave || eff?.onDestroyed) && this.find(uid)?.loc.zone === 'gy') {
      if (eff.onDestroyed && wasField && reason === 'destroyed') yield* this.as(controller, eff.onDestroyed(this, card, controller, byBattle));
      if (eff.onSentToGrave && this.find(uid)?.loc.zone === 'gy') yield* this.as(card.owner, eff.onSentToGrave(this, card, card.owner, f.loc.zone, reason));
    }
  }

  /** Cards that cannot be destroyed right now (by battle, or by card effects) are skipped. */
  *destroy(uids: number[], reason: 'destroyed' = 'destroyed', byBattle = false): Step {
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
    for (const q of [0, 1] as Pid[]) {
      for (const s of this.activeSpells(q)) {
        const h = getEffect(s.name)?.onAnyDiscard;
        if (h && !(this.info(s.name).kind === 'trap' && this.trapsNegated(s.name))) yield* h(this, s, q, player);
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
        const zone = ps.mz.findIndex((z) => z === null);
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

  damage(player: Pid, amount: number) {
    if (amount > 0) (this.state.fx.lpLost ??= [0, 0])[player] += amount;
    if (amount > 0) (this.state.fx.hurt ??= [0, 0])[player] += amount;
    if (amount <= 0) return;
    const ps = this.player(player);
    ps.lp = Math.max(0, ps.lp - amount);
    this.event('damage', { player, amount });
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
  *specialSummon(uid: number, controller: Pid, pos: Pos, faceUp = true): Step {
    const ps = this.player(controller);
    const zone = ps.mz.findIndex((z) => z === null);
    if (zone < 0) return;
    const card = this.detach(uid);
    if (!card) return;
    const fc = this.toField(card, pos, faceUp);
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
      // Speed Duel: active Spells/Traps that watch Summons too.
      if (!this.speed) continue;
      for (const w of this.activeSpells(p)) {
        if (!this.fieldCard(m.uid) || !this.fieldCard(w.uid)) continue;
        const kindOf = this.info(w.name).kind;
        if ((kindOf === 'spell' && this.spellsNegated()) || (kindOf === 'trap' && this.trapsNegated(w.name))) continue;
        const h = getEffect(w.name)?.onAnySummon;
        if (h) yield* h(this, w, p, m, controller, kind);
      }
    }
  }

  /** Moves a monster to the other side of the field (Change of Heart, Snatch Steal). */
  takeControl(uid: number, to: Pid): boolean {
    const f = this.find(uid);
    if (!f || f.loc.zone !== 'mz') return false;
    const ps = this.player(to);
    const zone = ps.mz.findIndex((z) => z === null);
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
    const card = this.detach(uid);
    if (!card) return;
    this.player(p).hand.push(card);
    this.event('to-hand', { uid, player: p });
  }

  /** Shows cards to one player only. */
  *reveal(player: Pid, title: string, cards: Card[]): Step {
    if (!cards.length) return;
    yield { kind: 'select', player, title, options: cards.map((c) => ({ label: c.name, uid: c.uid })), min: 0, max: 0, cancel: false };
  }

  toHand(uid: number) {
    const f = this.find(uid);
    if (f && f.loc.zone === 'mz' && this.actor !== null && this.actor !== f.loc.player) (this.state.fx.bounced ??= [-1, -1])[f.loc.player] = this.state.turn;
    const card = this.detach(uid);
    if (!card) return;
    this.player(card.owner).hand.push(card);
    this.event('to-hand', { uid, player: card.owner });
  }

  /** Removes a card from play (D.D. Warrior, Gravedigger Ghoul). */
  banish(uid: number) {
    const f = this.find(uid);
    if (!f) return;
    const fc = f.loc.zone === 'mz' || f.loc.zone === 'sz' || f.loc.zone === 'field' ? (f.card as FieldCard) : null;
    const card = this.detach(uid)!;
    if (fc) {
      for (const eqUid of fc.equips.slice()) this.detachEquip(eqUid);
      if (fc.equippedTo !== undefined) {
        const host = this.fieldCard(fc.equippedTo);
        if (host) host.equips = host.equips.filter((u) => u !== uid);
      }
    }
    this.player(card.owner).removed.push(card);
    this.event('to-gy', { uid, player: card.owner });
    this.log(card.owner, `${card.name} was removed from play`);
  }

  private detachEquip(uid: number) {
    const card = this.detach(uid);
    if (card) {
      this.player(card.owner).gy.push(card);
      this.event('to-gy', { uid, player: card.owner });
    }
  }

  /** Puts a card on top of its owner's Deck (Cockroach Knight). */
  toDeckTop(uid: number) {
    const card = this.detach(uid);
    if (!card) return;
    this.player(card.owner).deck.unshift(card);
    this.event('to-hand', { uid, player: card.owner });
  }

  /** Jinzo: traps cannot be activated while it is face-up. */
  trapsSealed(): boolean {
    return [...this.monsters(0), ...this.monsters(1)].some((m) => m.faceUp && this.effectOn(m)?.sealsTraps);
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
    }
  }

  private run(gen: Step) {
    if (this.gen) return;
    this.gen = gen;
    this.resume(undefined as unknown as Choice);
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

  // ---------- phases ----------
  private *leaveBattle(): Step {
    const fx = this.state.fx;
    const doomed = ((fx.endOfBattle ?? []) as number[]).filter((u) => this.fieldCard(u));
    fx.endOfBattle = [];
    if (doomed.length) yield* this.destroy(doomed);
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
        // Lightforce Sword: banished hand cards come back.
        const lf = (fx.lightforce ?? []) as { uid: number; back: number }[];
        for (const x of lf.filter((x) => x.back <= this.state.turn)) {
          const card = this.find(x.uid);
          if (card && card.loc.zone === 'removed') this.toHand(x.uid);
        }
        fx.lightforce = lf.filter((x) => x.back > this.state.turn);
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
      for (const c of this.spells(p)) {
        const eff = getEffect(c.name);
        if (c.faceUp && c.active && eff?.onEndPhase) yield* eff.onEndPhase(this, c, p);
      }
      for (const m of this.monsters(p)) {
        const eff = this.effectOn(m);
        if (m.faceUp && eff?.onEndPhase && this.fieldCard(m.uid)) yield* eff.onEndPhase(this, m, p);
      }
    }
    // Delayed destruction (Zone Eater, Steel Scorpion, Swordsman from a Distant Land).
    const doomed = [...this.monsters(0), ...this.monsters(1)].filter((m) => m.doomAt !== undefined && m.doomAt <= this.state.turn);
    if (doomed.length) {
      for (const m of doomed) this.log(null, `${m.name} crumbles away`);
      yield* this.destroy(doomed.map((m) => m.uid));
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
      for (const uid of uids) {
        const name = this.find(uid)?.card.name;
        yield* this.sendToGrave(uid, 'discard');
        this.log(tp, `${ps.name} discarded ${name}`);
      }
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

  canNormalSummon(player: Pid, card: Card): boolean {
    if (!this.inMainPhase() || this.state.turnPlayer !== player || this.player(player).normalSummoned) return false;
    const info = this.info(card.name);
    if (info.kind !== 'monster' || info.sub === 'Fusion' || info.sub === 'Ritual') return false;
    if (getEffect(card.name)?.cannotNormalSummon || this.prohibited(card.name)) return false;
    if (this.anyActive('Chain Energy') && this.player(player).lp <= 500) return false;
    const need = this.tributesNeeded(info.level ?? 1);
    const ps = this.player(player);
    const empty = ps.mz.filter((z) => z === null).length;
    const owned = this.monsters(player).length;
    if (need === 0) return empty > 0;
    return owned >= need; // tributing frees a zone
  }

  private *summon(player: Pid, uid: number, zone: number, pos: Pos, faceUp: boolean): Step {
    const f = this.find(uid);
    if (!f || f.loc.zone !== 'hand' || f.loc.player !== player) return;
    if (!this.canNormalSummon(player, f.card)) return;
    const ps = this.player(player);
    const info = this.info(f.card.name);
    const need = this.tributesNeeded(info.level ?? 1);
    if (!faceUp && this.anyActive('Light of Intervention')) {
      faceUp = true;
      pos = 'def';
      this.log(player, 'Light of Intervention: the monster must be Summoned face-up');
    }
    if (need > 0) {
      const picks = yield* this.select(player, `Choose ${need} monster${need > 1 ? 's' : ''} to Tribute`, this.optionsFor(this.monsters(player), true), need, need, true);
      if (!picks) return;
      const tributes = picks.map((i) => this.monsters(player)[i].uid);
      for (const t of tributes) {
        const name = this.find(t)?.card.name;
        yield* this.sendToGrave(t, 'tribute');
        this.log(player, `${ps.name} Tributed ${name}`);
      }
      if (ps.mz[zone] !== null) zone = ps.mz.findIndex((z) => z === null);
    }
    if (zone < 0 || zone >= ps.mz.length || ps.mz[zone] !== null) return;
    const card = this.detach(uid)!;
    const fc = this.toField(card, faceUp ? pos : 'def', faceUp);
    ps.mz[zone] = fc;
    ps.normalSummoned = true;
    yield* this.chainEnergy(player);
    this.event(faceUp ? 'summon' : 'set', { uid, player });
    if (faceUp) {
      this.log(player, `${ps.name} ${need ? 'Tribute ' : ''}Summoned ${card.name}${pos === 'def' ? ' in Defense Position' : ''}`);
      yield* this.responseWindow('summon', { uid, summonKind: 'normal' });
      const eff = getEffect(card.name);
      if (eff?.onSummon && this.fieldCard(uid)) yield* this.as(player, eff.onSummon(this, fc, player, 'normal'));
      if (this.fieldCard(uid)) yield* this.anySummon(fc, player, 'normal');
    } else {
      this.log(player, `${ps.name} Set a monster`);
    }
  }

  private *flipSummon(player: Pid, uid: number): Step {
    const m = this.fieldCard(uid);
    const f = this.find(uid);
    if (!m || !f || f.loc.zone !== 'mz' || f.loc.player !== player) return;
    if (!this.inMainPhase() || m.faceUp || m.placedTurn === this.state.turn || m.posChanged || m.attacked) return;
    m.faceUp = true;
    m.pos = 'atk';
    m.posChanged = true;
    this.event('flip', { uid, player });
    this.log(player, `${this.player(player).name} Flip Summoned ${m.name}`);
    yield* this.responseWindow('summon', { uid, summonKind: 'flip' });
    if (this.fieldCard(uid) && (this.info(m.name).level ?? 1) <= 2 && this.anyActive('Goblin Fan') && !this.trapsNegated()) {
      this.log(null, `Goblin Fan destroys ${m.name} before its effect can activate`);
      yield* this.destroy([uid]);
      return;
    }
    if (this.fieldCard(uid)) yield* this.flipEffect(uid, player);
    const eff = this.effectOn(m);
    if (eff?.onSummon && this.fieldCard(uid)) yield* this.as(player, eff.onSummon(this, m, player, 'flip'));
    if (this.fieldCard(uid)) yield* this.anySummon(m, player, 'flip');
  }

  /** Chain Energy: 500 LP for each card played from the hand. */
  *chainEnergy(player: Pid): Step {
    if (this.anyActive('Chain Energy') && !this.spellsNegated()) {
      this.log(player, 'Chain Energy: 500 LP');
      this.payLp(player, 500);
    }
  }

  /** Special Summon procedures from the hand (Gate Guardian, Toons, Valkyrion...). */
  canSpecialProc(player: Pid, card: Card): boolean {
    if (!this.inMainPhase() || this.state.turnPlayer !== player || this.state.prompt) return false;
    const f = this.find(card.uid);
    if (!f || f.loc.player !== player || f.loc.zone !== 'hand' || this.prohibited(card.name)) return false;
    const proc = getEffect(card.name)?.summonProc;
    return !!proc && proc.can(this, card, player);
  }

  private *specialProc(player: Pid, uid: number): Step {
    const f = this.find(uid);
    if (!f || !this.canSpecialProc(player, f.card)) return;
    yield* this.as(player, getEffect(f.card.name)!.summonProc!.run(this, f.card, player));
  }

  /** Ignition effects of face-up monsters (Cannon Soldier, Time Wizard...). */
  canUseMonsterEffect(player: Pid, m: Card): boolean {
    if (!this.inMainPhase() || this.state.turnPlayer !== player || this.state.prompt) return false;
    const f = this.find(m.uid);
    if (!f || f.loc.player !== player || this.prohibited(m.name)) return false;
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
    if (this.raceOf(m) === 'Dragon' && this.anyActive('Dragon Capture Jar')) return false;
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
  }

  canSet(player: Pid, card: Card): boolean {
    if (!this.inMainPhase() || this.state.turnPlayer !== player) return false;
    const info = this.info(card.name);
    if (info.kind === 'monster' || info.sub === 'Ticket' || this.prohibited(card.name)) return false;
    if (this.anyActive('Chain Energy') && this.player(player).lp <= 500) return false;
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
    if (!eff?.resolve || this.prohibited(f.card.name)) return false;
    if (eff.activateCost && !eff.activateCost.can(this, f.card, player)) return false;
    if (this.anyActive('Chain Energy') && f.loc.zone === 'hand' && this.player(player).lp <= 500) return false;
    if (info.kind === 'spell') {
      if (this.anyActive('Anti-Spell Fragrance')) {
        if (f.loc.zone === 'hand') return false;
        if ((f.card as FieldCard).placedTurn === this.state.turn) return false;
      }
      if (f.loc.zone === 'hand' && !this.player(player).sz.some((z) => z === null) && info.sub !== 'Field') return false;
      if (f.loc.zone === 'hand' && info.sub === 'Field' && this.player(player).field) return false;
      if (f.loc.zone === 'sz' || f.loc.zone === 'field') {
        const fc = f.card as FieldCard;
        if (fc.faceUp) return false;
      } else if (f.loc.zone !== 'hand') return false;
      return eff.canActivate ? eff.canActivate(this, f.card, player, 'main', {}) : true;
    }
    if (info.kind === 'trap') {
      if (f.loc.zone !== 'sz' || this.trapsSealed()) return false;
      const fc = f.card as FieldCard;
      if (fc.faceUp || fc.placedTurn === this.state.turn) return false;
      if (info.sub === 'Counter') return false;
      return eff.canActivate ? eff.canActivate(this, f.card, player, 'main', {}) : true;
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
      const ok = yield* eff.activate(this, link, player, ctx);
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
    try {
      while (this.state.chain.length > 0 && this.state.winner === null) {
        const link = this.state.chain.pop()!;
        const eff = getEffect(link.card.name);
        const effectLink = (link.payload as { effect?: string } | undefined)?.effect;
        if (effectLink) {
          // A monster's (or card's) activated effect, not the activation of a Spell/Trap card.
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
    }
    this.state.chain = [];
    yield* this.damageWindow(false);
    yield* this.flushSummonWindows();
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
          const ok = eff.activate ? yield* eff.activate(this, link, responder, ctx) : true;
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
  private quickOptions(player: Pid, trigger: Trigger, ctx: ChainCtx): SelectOption[] {
    const out: SelectOption[] = [];
    const ps = this.player(player);
    const consider = (c: Card, from: 'field' | 'hand' | 'gy') => {
      const q = (from === 'field' ? this.effectOn(c) : getEffect(c.name))?.quick;
      if (!q || (q.from ?? 'field') !== from || this.prohibited(c.name)) return;
      if (from === 'field') {
        const fc = c as FieldCard;
        if (!fc.faceUp) return;
        const kind = this.info(c.name).kind;
        if (kind !== 'monster' && !fc.active) return;
        if ((kind === 'spell' && this.spellsNegated()) || (kind === 'trap' && this.trapsNegated(c.name))) return;
      }
      if (!q.repeat && !this.oncePerTurn(`quick:${c.name}:${from === 'field' ? c.uid : 0}`, player)) return;
      if (!q.can(this, c, player, trigger, ctx)) return;
      out.push({ label: q.label ? `${c.name}: ${q.label}` : `${c.name}'s effect`, uid: c.uid, loc: this.find(c.uid)!.loc, value: 'quick' });
    };
    for (const m of this.monsters(player)) consider(m, 'field');
    for (const c of this.activeSpells(player)) consider(c, 'field');
    for (const c of ps.hand) consider(c, 'hand');
    for (const c of ps.gy) consider(c, 'gy');
    return out;
  }

  /** Pays the cost of a Quick Effect and puts it on the chain. */
  private *activateQuick(player: Pid, uid: number, trigger: Trigger, ctx: ChainCtx): Generator<Prompt, ChainLink | null, Choice> {
    const f = this.find(uid);
    if (!f) return null;
    const q = getEffect(f.card.name)?.quick;
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
    for (const fc of this.spells(player)) {
      if (fc.faceUp) continue;
      const info = this.info(fc.name);
      const eff = getEffect(fc.name);
      if (!eff?.resolve || !eff.canActivate || this.prohibited(fc.name)) continue;
      if (info.kind === 'trap' && (fc.placedTurn === this.state.turn || this.trapsSealed())) continue;
      if (info.kind === 'spell' && info.sub !== 'Quick-Play') continue;
      if (info.kind === 'spell' && fc.placedTurn === this.state.turn) continue;
      if (eff.canActivate(this, fc, player, trigger, ctx)) out.push({ label: fc.name, uid: fc.uid, loc: this.find(fc.uid)!.loc });
    }
    return out;
  }

  // ---------- battle ----------
  canAttackWith(player: Pid, m: FieldCard): boolean {
    const s = this.state;
    if (s.phase !== 'BP' || s.turnPlayer !== player || s.firstTurn) return false;
    const eff = this.effectOn(m);
    if (!m.faceUp || m.cannotAttack) return false;
    if (m.attacked && (m.tags?.attacksMade ?? 1) >= (eff?.attacks?.(this, m) ?? 1)) return false;
    if (m.pos !== 'atk' && !eff?.attackInDefense) return false;
    if (eff?.cannotAttack?.(this, m, player)) return false;
    if ((m.tags?.noAttackTurn ?? -1) === s.turn) return false;
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
    return list;
  }

  private *attack(player: Pid, uid: number, targetUid: number | null): Step {
    const m = this.fieldCard(uid);
    const f = this.find(uid);
    if (!m || !f || f.loc.zone !== 'mz' || f.loc.player !== player || !this.canAttackWith(player, m)) return;
    const opp = other(player);
    const oppMonsters = this.monsters(opp);
    if (targetUid === null && oppMonsters.length > 0 && !this.canAttackDirectly(m)) return;
    if (targetUid !== null && !this.legalTargets(player, m).some((t) => t.uid === targetUid)) return;
    const eff0 = getEffect(m.name);
    const cost = eff0?.attackCost;
    if (cost) yield* this.as(player, cost.pay(this, m, player));
    for (const p of [0, 1] as Pid[]) {
      for (const c of this.activeSpells(p)) {
        const tax = getEffect(c.name)?.attackTax;
        if (tax) yield* this.as(p, tax.pay(this, c, m, player));
      }
    }
    if (this.state.winner !== null || !this.fieldCard(uid)) return;
    if (eff0?.attacks) {
      const t = (m.tags ??= {});
      t.attacksMade = m.attacked ? (t.attacksMade ?? 1) + 1 : 1;
    }
    m.attacked = true;
    this.state.attackedThisTurn.push(uid);
    this.state.fx.battleNo = (this.state.fx.battleNo ?? 0) + 1;
    this.state.battle = { attacker: uid, target: targetUid };
    this.event('attack', { uid, player });
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
  private battleDamage(p: Pid, amount: number, a: FieldCard, t: FieldCard | null) {
    if (amount <= 0) return;
    for (const m of [a, t]) {
      if (m && this.controller(m.uid) === p && this.effectOn(m)?.noBattleDamage?.(this, m)) {
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
    this.damage(p, amount);
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
        if (pierce && (typeof pierce !== 'function' || pierce(this, attacker))) {
          this.log(player, `${attacker.name} pierces the defense`);
          this.battleDamage(opp, atk - tDef, attacker, target);
          if (this.state.winner === null && aEff?.onBattleDamage) yield* this.as(player, aEff.onBattleDamage(this, attacker, player));
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
    yield* this.destroy(destroyed, 'destroyed', true);
    // FLIP effects resolve after damage calculation, even if the monster is destroyed.
    if (wasFaceDown && tEff?.flip) {
      this.log(opp, `${target.name}'s FLIP effect activates`);
      yield* this.as(opp, tEff.flip(this, target, opp, !this.fieldCard(targetUid)));
    }
    if (this.state.winner !== null) return;
    if (tEff?.onAttacked) yield* this.as(opp, tEff.onAttacked(this, target, attacker, opp, targetDestroyed));
    if (targetDestroyed && tEff?.onDestroyedByBattle) yield* this.as(opp, tEff.onDestroyedByBattle(this, target, opp));
    if (attackerDestroyed && aEff?.onDestroyedByBattle) yield* this.as(player, aEff.onDestroyedByBattle(this, attacker, player));
    if (aEff?.afterBattle && this.fieldCard(attacker.uid)) yield* this.as(player, aEff.afterBattle(this, attacker, target, player, targetDestroyed));
    for (const uid of attacker.equips.slice()) {
      const eq = this.fieldCard(uid);
      const h = eq ? getEffect(eq.name)?.hostAfterBattle : undefined;
      if (eq && h) yield* this.as(player, h(this, eq, attacker, target));
    }
    // Time Machine and other "destroyed by battle" responses.
    for (const b of before) {
      const g = this.find(b.uid);
      if (g && g.loc.zone === 'gy' && b.ctl !== null && this.state.winner === null) yield* this.responseWindow('destroyed', { uid: b.uid, prevController: b.ctl, prevPos: b.pos });
    }
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
    for (const c of this.activeSpells(player)) {
      const eff = getEffect(c.name);
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
