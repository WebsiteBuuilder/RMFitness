// The duel engine: enforces the 2002 rules the way The Eternal Duelist Soul did.
// Everything that needs a decision from a player is written as a generator that
// yields a Prompt; the engine parks the generator until the answer arrives.

import type { Action, Card, CardInfo, ChainLink, DuelState, FieldCard, Loc, Phase, Pid, PlayerState, Pos, Prompt, SelectOption } from './types';
import { HAND_LIMIT, MONSTER_ZONES, PHASES, PHASE_NAME, STARTING_LP, ST_ZONES } from './types';
import { getEffect, type Trigger } from './effects';

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
  };
}

export const other = (p: Pid): Pid => (p === 0 ? 1 : 0);

export class Engine {
  state: DuelState = emptyState();
  private gen: Step | null = null;
  private seq = 0;

  constructor(public readonly db: Map<string, CardInfo>) {}

  info(name: string): CardInfo {
    const c = this.db.get(name);
    if (c) return c;
    return { id: 0, name, kind: 'monster', sub: 'Normal', atk: 0, def: 0, level: 1, desc: '' };
  }

  // ---------- randomness ----------
  private rand(): number {
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
  atkOf(m: FieldCard): number {
    const base = this.info(m.name).atk ?? 0;
    let bonus = m.atkMod;
    for (const uid of m.equips) {
      const eq = this.fieldCard(uid);
      if (!eq) continue;
      bonus += getEffect(eq.name)?.equipBonus?.(this, eq, m).atk ?? 0;
    }
    return Math.max(0, base + bonus);
  }

  defOf(m: FieldCard): number {
    const base = this.info(m.name).def ?? 0;
    let bonus = m.defMod;
    for (const uid of m.equips) {
      const eq = this.fieldCard(uid);
      if (!eq) continue;
      bonus += getEffect(eq.name)?.equipBonus?.(this, eq, m).def ?? 0;
    }
    return Math.max(0, base + bonus);
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
    return { uid: f.card.uid, name: f.card.name, owner: f.card.owner };
  }

  /** Sends a card to its owner's Graveyard, handling equips and "sent to GY" effects. */
  *sendToGrave(uid: number, reason: 'destroyed' | 'discard' | 'tribute' | 'used' | 'mill' | 'cost' = 'destroyed'): Step {
    const f = this.find(uid);
    if (!f) return;
    const wasField = f.loc.zone === 'mz' || f.loc.zone === 'sz' || f.loc.zone === 'field';
    const fc = wasField ? (f.card as FieldCard) : null;
    const controller = f.loc.player;
    const card = this.detach(uid)!;
    if (card.name.startsWith('__token')) return;
    this.player(card.owner).gy.push(card);
    this.event('to-gy', { uid, player: card.owner });
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
  }

  *destroy(uids: number[], reason: 'destroyed' = 'destroyed'): Step {
    for (const uid of uids) yield* this.sendToGrave(uid, reason);
  }

  *discard(player: Pid, uid: number): Step {
    yield* this.sendToGrave(uid, 'discard');
    this.log(player, `${this.player(player).name} discarded ${this.find(uid)?.card.name ?? ''}`.trim());
  }

  draw(player: Pid, n: number): boolean {
    const ps = this.player(player);
    for (let i = 0; i < n; i++) {
      const c = ps.deck.shift();
      if (!c) {
        this.endDuel(other(player), `${ps.name} has no cards left to draw`);
        return false;
      }
      ps.hand.push(c);
      this.event('draw', { uid: c.uid, player });
    }
    this.log(player, `${ps.name} drew ${n === 1 ? 'a card' : `${n} cards`}`);
    this.checkExodia(player);
    return true;
  }

  checkExodia(player: Pid) {
    const names = new Set(this.player(player).hand.map((c) => c.name));
    const pieces = ['Exodia the Forbidden One', 'Right Arm of the Forbidden One', 'Left Arm of the Forbidden One', 'Right Leg of the Forbidden One', 'Left Leg of the Forbidden One'];
    if (pieces.every((p) => names.has(p))) this.endDuel(player, `${this.player(player).name} assembled Exodia!`);
  }

  damage(player: Pid, amount: number) {
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
    this.log(controller, `${ps.name} Special Summoned ${card.name} in ${pos === 'atk' ? 'Attack' : 'Defense'} Position`);
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
    return true;
  }

  toHand(uid: number) {
    const card = this.detach(uid);
    if (!card) return;
    this.player(card.owner).hand.push(card);
    this.event('to-hand', { uid, player: card.owner });
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
        return this.changePosition(action.player, action.uid);
      case 'ATTACK':
        return this.run(this.attack(action.player, action.uid, action.target));
      case 'NEXT_PHASE':
        return this.run(this.nextPhase());
      case 'END_TURN':
        return this.run(this.goToPhase('EP'));
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
    this.state = s;
    for (const p of [0, 1] as Pid[]) {
      const ps = s.players[p];
      ps.name = a.names[p];
      ps.deck = this.shuffle(a.decks[p].map((n) => this.newCard(n, p)));
      ps.fusion = a.fusions[p].map((n) => this.newCard(n, p));
      ps.ready = true;
    }
    s.started = true;
    s.turn = 1;
    s.turnPlayer = a.first;
    s.phase = 'DP';
    this.log(null, `Duel start! ${s.players[a.first].name} goes first.`);
    for (const p of [0, 1] as Pid[]) this.draw(p, 5);
    this.draw(a.first, 1);
    this.run(this.enterPhase('SP'));
  }

  // ---------- phases ----------
  private *nextPhase(): Step {
    const i = PHASES.indexOf(this.state.phase);
    let next: Phase = PHASES[Math.min(i + 1, PHASES.length - 1)];
    if (this.state.phase === 'M1' && this.state.firstTurn) next = 'EP'; // no Battle Phase on the very first turn
    if (this.state.phase === 'EP') return yield* this.endTurn();
    yield* this.enterPhase(next);
  }

  private *goToPhase(phase: Phase): Step {
    if (phase === 'EP' && this.state.phase === 'EP') return yield* this.endTurn();
    yield* this.enterPhase(phase);
  }

  private *enterPhase(phase: Phase): Step {
    this.state.phase = phase;
    this.state.battle = null;
    this.event('phase');
    const tp = this.state.turnPlayer;
    if (phase === 'SP') {
      // Standby Phase effects (Snatch Steal's 1000 LP, etc.)
      for (const p of [0, 1] as Pid[]) {
        for (const c of [...this.spells(p), ...(this.player(p).field ? [this.player(p).field!] : [])]) {
          const eff = getEffect(c.name);
          if (c.faceUp && c.active && eff?.onStandby) yield* eff.onStandby(this, c, p);
        }
      }
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
    // End-phase countdowns (Swords of Revealing Light).
    for (const p of [0, 1] as Pid[]) {
      for (const c of this.spells(p)) {
        const eff = getEffect(c.name);
        if (c.faceUp && c.active && eff?.onEndPhase) yield* eff.onEndPhase(this, c, p);
      }
    }
    // Hand limit.
    const ps = this.player(tp);
    while (ps.hand.length > HAND_LIMIT && this.state.winner === null) {
      const n = ps.hand.length - HAND_LIMIT;
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
    }
    this.player(prev).normalSummoned = false;
    s.attackedThisTurn = [];
    s.firstTurn = false;
    s.turn += 1;
    s.turnPlayer = other(prev);
    s.phase = 'DP';
    this.log(s.turnPlayer, `Turn ${s.turn}: ${this.player(s.turnPlayer).name}`);
    this.event('turn', { player: s.turnPlayer });
    if (!this.draw(s.turnPlayer, 1)) return;
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
    if (zone < 0 || zone >= MONSTER_ZONES || ps.mz[zone] !== null) return;
    const card = this.detach(uid)!;
    const fc = this.toField(card, faceUp ? pos : 'def', faceUp);
    ps.mz[zone] = fc;
    ps.normalSummoned = true;
    this.event(faceUp ? 'summon' : 'set', { uid, player });
    if (faceUp) {
      this.log(player, `${ps.name} ${need ? 'Tribute ' : ''}Summoned ${card.name}${pos === 'def' ? ' in Defense Position' : ''}`);
      yield* this.responseWindow('summon', { uid });
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
    yield* this.responseWindow('summon', { uid });
    if (this.fieldCard(uid)) yield* this.flipEffect(uid, player);
  }

  *flipEffect(uid: number, controller: Pid): Step {
    const m = this.fieldCard(uid);
    if (!m) return;
    const eff = getEffect(m.name);
    if (eff?.flip) {
      this.log(controller, `${m.name}'s FLIP effect activates`);
      yield* eff.flip(this, m, controller);
    }
  }

  private changePosition(player: Pid, uid: number) {
    const m = this.fieldCard(uid);
    const f = this.find(uid);
    if (!m || !f || f.loc.zone !== 'mz' || f.loc.player !== player) return;
    if (!this.inMainPhase() || !m.faceUp || m.placedTurn === this.state.turn || m.posChanged || m.attacked) return;
    m.pos = m.pos === 'atk' ? 'def' : 'atk';
    m.posChanged = true;
    this.event('position', { uid, player });
    this.log(player, `${m.name} changed to ${m.pos === 'atk' ? 'Attack' : 'Defense'} Position`);
  }

  canSet(player: Pid, card: Card): boolean {
    if (!this.inMainPhase() || this.state.turnPlayer !== player) return false;
    const info = this.info(card.name);
    if (info.kind === 'monster') return false;
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
      if (zone < 0 || zone >= ST_ZONES || ps.sz[zone] !== null) zone = ps.sz.findIndex((z) => z === null);
      if (zone < 0) return;
      const card = this.detach(uid)!;
      ps.sz[zone] = this.toField(card, 'atk', false);
    }
    this.event('set', { uid, player });
    this.log(player, `${ps.name} Set a card`);
  }

  /** Whether a spell/trap can be activated by its controller right now, at spell speed 1 (Main Phase). */
  canActivateMain(player: Pid, uid: number): boolean {
    if (!this.inMainPhase() || this.state.turnPlayer !== player || this.state.prompt) return false;
    const f = this.find(uid);
    if (!f || f.loc.player !== player) return false;
    const info = this.info(f.card.name);
    const eff = getEffect(f.card.name);
    if (!eff?.resolve) return false;
    if (info.kind === 'spell') {
      if (f.loc.zone === 'hand' && !this.player(player).sz.some((z) => z === null) && info.sub !== 'Field') return false;
      if (f.loc.zone === 'hand' && info.sub === 'Field' && this.player(player).field) return false;
      if (f.loc.zone === 'sz' || f.loc.zone === 'field') {
        const fc = f.card as FieldCard;
        if (fc.faceUp) return false;
      } else if (f.loc.zone !== 'hand') return false;
      return eff.canActivate ? eff.canActivate(this, f.card, player, 'main', {}) : true;
    }
    if (info.kind === 'trap') {
      if (f.loc.zone !== 'sz') return false;
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
    if (f.loc.zone === 'hand') {
      const card = this.detach(uid)!;
      if (info.sub === 'Field') {
        fc = this.toField(card, 'atk', true);
        ps.field = fc;
      } else {
        let z = zone ?? -1;
        if (z < 0 || z >= ST_ZONES || ps.sz[z] !== null) z = ps.sz.findIndex((s) => s === null);
        fc = this.toField(card, 'atk', true);
        ps.sz[z] = fc;
      }
    } else {
      fc = f.card as FieldCard;
      fc.faceUp = true;
    }
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
    while (this.state.chain.length > 0 && this.state.winner === null) {
      const link = this.state.chain.pop()!;
      const eff = getEffect(link.card.name);
      const stillThere = this.fieldCard(link.card.uid);
      if (link.negated) {
        this.log(link.player, `${link.card.name}'s effect was negated`);
      } else if (eff?.resolve && stillThere) {
        yield* eff.resolve(this, link, link.player);
      }
      yield* this.afterResolve(link);
    }
    this.state.chain = [];
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
    if (!ctx.link && this.state.chain.length > 0) yield* this.resolveChain();
  }

  private responseTitle(trigger: Trigger, ctx: ChainCtx): string {
    switch (trigger) {
      case 'summon':
        return `${this.find(ctx.uid!)?.card.name ?? 'A monster'} was Summoned. Respond?`;
      case 'attack':
        return `${this.find(ctx.uid!)?.card.name ?? 'A monster'} attacks. Respond?`;
      case 'spell':
      case 'trap':
        return `${ctx.link?.card.name ?? 'A card'} was activated. Respond?`;
      default:
        return 'Respond?';
    }
  }

  /** Set spells/traps the player could activate right now against the trigger. */
  responsesFor(player: Pid, trigger: Trigger, ctx: ChainCtx): SelectOption[] {
    const out: SelectOption[] = [];
    for (const fc of this.spells(player)) {
      if (fc.faceUp) continue;
      const info = this.info(fc.name);
      const eff = getEffect(fc.name);
      if (!eff?.resolve || !eff.canActivate) continue;
      if (info.kind === 'trap' && fc.placedTurn === this.state.turn) continue;
      if (info.kind === 'spell' && info.sub !== 'Quick-Play') continue;
      if (info.kind === 'spell' && fc.placedTurn === this.state.turn) continue;
      if (eff.canActivate(this, fc, player, trigger, ctx)) out.push({ label: fc.name, uid: fc.uid, loc: this.find(fc.uid)!.loc });
    }
    return out;
  }

  // ---------- battle ----------
  canAttackWith(player: Pid, m: FieldCard): boolean {
    if (this.state.phase !== 'BP' || this.state.turnPlayer !== player || this.state.firstTurn) return false;
    if (!m.faceUp || m.pos !== 'atk' || m.attacked) return false;
    // Swords of Revealing Light on the opponent's side stops attacks.
    for (const c of this.spells(other(player))) if (c.faceUp && c.active && getEffect(c.name)?.blocksAttacks) return false;
    return true;
  }

  private *attack(player: Pid, uid: number, targetUid: number | null): Step {
    const m = this.fieldCard(uid);
    const f = this.find(uid);
    if (!m || !f || f.loc.zone !== 'mz' || f.loc.player !== player || !this.canAttackWith(player, m)) return;
    const opp = other(player);
    const oppMonsters = this.monsters(opp);
    if (targetUid === null && oppMonsters.length > 0) return;
    if (targetUid !== null) {
      const t = this.find(targetUid);
      if (!t || t.loc.zone !== 'mz' || t.loc.player !== opp) return;
    }
    m.attacked = true;
    this.state.attackedThisTurn.push(uid);
    this.state.battle = { attacker: uid, target: targetUid };
    this.event('attack', { uid, player });
    const targetName = targetUid !== null ? (this.fieldCard(targetUid)!.faceUp ? this.fieldCard(targetUid)!.name : 'a face-down monster') : 'directly';
    this.log(player, `${m.name} attacks ${targetName}`);
    yield* this.responseWindow('attack', { uid, targetUid: targetUid ?? undefined });
    if (this.state.winner !== null) return;
    if (!this.state.battle) return; // Waboku and friends end the battle
    const attacker = this.fieldCard(uid);
    if (!attacker || this.controller(uid) !== player) {
      this.state.battle = null;
      return; // attacker was destroyed or taken
    }
    const target = targetUid !== null ? this.fieldCard(targetUid) : null;
    if (targetUid !== null && !target) {
      // Target gone (destroyed in response): replay as a direct attack if the field is empty, else stop.
      if (this.monsters(opp).length === 0) {
        this.damage(opp, this.atkOf(attacker));
      }
      this.state.battle = null;
      return;
    }
    yield* this.damageStep(player, attacker, target);
    this.state.battle = null;
  }

  private *damageStep(player: Pid, attacker: FieldCard, target: FieldCard | null): Step {
    const opp = other(player);
    const atk = this.atkOf(attacker);
    if (!target) {
      this.event('hit', { uid: attacker.uid, player: opp });
      this.damage(opp, atk);
      return;
    }
    let flipped = false;
    if (!target.faceUp) {
      target.faceUp = true;
      flipped = true;
      this.event('flip', { uid: target.uid, player: opp });
      this.log(opp, `${target.name} was flipped face-up`);
    }
    const destroyed: number[] = [];
    if (target.pos === 'atk') {
      const tAtk = this.atkOf(target);
      this.event('hit', { uid: target.uid, player: opp });
      if (atk > tAtk) {
        destroyed.push(target.uid);
        this.damage(opp, atk - tAtk);
        this.log(player, `${attacker.name} destroys ${target.name}`);
      } else if (atk < tAtk) {
        destroyed.push(attacker.uid);
        this.damage(player, tAtk - atk);
        this.log(opp, `${target.name} destroys ${attacker.name}`);
      } else {
        destroyed.push(target.uid, attacker.uid);
        this.log(null, `${attacker.name} and ${target.name} destroy each other`);
      }
    } else {
      const tDef = this.defOf(target);
      this.event('hit', { uid: target.uid, player: opp });
      if (atk > tDef) {
        destroyed.push(target.uid);
        this.log(player, `${attacker.name} destroys ${target.name}`);
      } else if (atk < tDef) {
        this.damage(player, tDef - atk);
        this.log(opp, `${target.name} holds; ${attacker.name}'s controller takes damage`);
      } else {
        this.log(null, `${attacker.name} bounces off ${target.name}`);
      }
    }
    if (this.state.winner !== null) return;
    // FLIP effects resolve after damage calculation, even if the monster is destroyed.
    const targetUid = target.uid;
    yield* this.destroy(destroyed);
    if (flipped) {
      const eff = getEffect(target.name);
      if (eff?.flip) {
        this.log(opp, `${target.name}'s FLIP effect activates`);
        yield* eff.flip(this, target, opp, !this.fieldCard(targetUid));
      }
    }
  }
}

export interface ChainCtx {
  uid?: number;
  targetUid?: number;
  link?: ChainLink;
}

export { PHASE_NAME };
