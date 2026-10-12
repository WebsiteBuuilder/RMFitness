import {
  CardInst,
  GameEvent,
  GameState,
  Loc,
  LoggedEvent,
  PlayerId,
  PlayerState,
  Rules,
  SPEED_DUEL_RULES,
  PHASE_LABEL,
  PHASES,
} from './types';
import { shuffled } from './rng';

function emptyPlayer(rules: Rules): PlayerState {
  return {
    name: '',
    lp: rules.startingLp,
    deck: [],
    hand: [],
    extra: [],
    gy: [],
    banished: [],
    field: null,
    skill: null,
    monsters: Array(rules.monsterZones).fill(null),
    spells: Array(rules.spellZones).fill(null),
    ready: false,
  };
}

export function initialState(rules: Rules = SPEED_DUEL_RULES): GameState {
  return {
    rules,
    players: [emptyPlayer(rules), emptyPlayer(rules)],
    started: false,
    turn: 0,
    turnPlayer: 0,
    phase: 'DP',
    waitFlag: null,
    winner: null,
    lastSummon: null,
    log: [],
  };
}

/** Replays the whole log. Undone events are skipped, which is how undo works. */
export function replay(events: LoggedEvent[], rules: Rules = SPEED_DUEL_RULES): GameState {
  const undone = new Set<number>();
  for (const e of events) if (e.type === 'UNDO') undone.add(e.target);
  let state = initialState(rules);
  for (const e of events) {
    if (undone.has(e.seq)) continue;
    state = apply(state, e);
  }
  return state;
}

function clonePlayer(p: PlayerState): PlayerState {
  return {
    ...p,
    deck: p.deck.slice(),
    hand: p.hand.slice(),
    extra: p.extra.slice(),
    gy: p.gy.slice(),
    banished: p.banished.slice(),
    monsters: p.monsters.slice(),
    spells: p.spells.slice(),
  };
}

function clone(s: GameState): GameState {
  return {
    ...s,
    players: [clonePlayer(s.players[0]), clonePlayer(s.players[1])],
    log: s.log.slice(),
  };
}

function other(p: PlayerId): PlayerId {
  return p === 0 ? 1 : 0;
}

/** Finds and removes a card from wherever it sits. Returns null if it is not on the table. */
function take(s: GameState, iid: string): { card: CardInst; from: Loc } | null {
  for (const pid of [0, 1] as PlayerId[]) {
    const p = s.players[pid];
    for (const zone of ['deck', 'hand', 'extra', 'gy', 'banished'] as const) {
      const i = p[zone].findIndex((c) => c.iid === iid);
      if (i >= 0) {
        const [card] = p[zone].splice(i, 1);
        return { card, from: { player: pid, zone } };
      }
    }
    for (const zone of ['monsters', 'spells'] as const) {
      const i = p[zone].findIndex((c) => c?.iid === iid);
      if (i >= 0) {
        const card = p[zone][i]!;
        p[zone][i] = null;
        return { card, from: { player: pid, zone: zone === 'monsters' ? 'm' : 's', index: i } };
      }
    }
    if (p.field?.iid === iid) {
      const card = p.field;
      p.field = null;
      return { card, from: { player: pid, zone: 'field' } };
    }
    if (p.skill?.iid === iid) {
      const card = p.skill;
      p.skill = null;
      return { card, from: { player: pid, zone: 'skill' } };
    }
  }
  return null;
}

export function findCard(s: GameState, iid: string): { card: CardInst; loc: Loc } | null {
  for (const pid of [0, 1] as PlayerId[]) {
    const p = s.players[pid];
    for (const zone of ['deck', 'hand', 'extra', 'gy', 'banished'] as const) {
      const card = p[zone].find((c) => c.iid === iid);
      if (card) return { card, loc: { player: pid, zone } };
    }
    for (const zone of ['monsters', 'spells'] as const) {
      const i = p[zone].findIndex((c) => c?.iid === iid);
      if (i >= 0) return { card: p[zone][i]!, loc: { player: pid, zone: zone === 'monsters' ? 'm' : 's', index: i } };
    }
    if (p.field?.iid === iid) return { card: p.field, loc: { player: pid, zone: 'field' } };
    if (p.skill?.iid === iid) return { card: p.skill, loc: { player: pid, zone: 'skill' } };
  }
  return null;
}

/** Puts a card into a location. Returns false (and leaves the card out) if the slot is taken. */
function put(s: GameState, card: CardInst, to: Loc): boolean {
  const p = s.players[to.player];
  switch (to.zone) {
    case 'm':
    case 's': {
      const arr = to.zone === 'm' ? p.monsters : p.spells;
      const i = to.index ?? arr.findIndex((c) => c === null);
      if (i < 0 || i >= arr.length || arr[i]) return false;
      arr[i] = card;
      return true;
    }
    case 'field':
      if (p.field) return false;
      p.field = card;
      return true;
    case 'skill':
      if (p.skill) return false;
      p.skill = card;
      return true;
    case 'deck':
      if (to.place === 'bottom') p.deck.push(card);
      else p.deck.unshift(card);
      return true;
    default:
      p[to.zone].push(card);
      return true;
  }
}

export function zoneLabel(loc: Loc): string {
  switch (loc.zone) {
    case 'm':
      return `Monster Zone ${(loc.index ?? 0) + 1}`;
    case 's':
      return `Spell/Trap Zone ${(loc.index ?? 0) + 1}`;
    case 'field':
      return 'Field Zone';
    case 'skill':
      return 'Skill';
    case 'deck':
      return loc.place === 'bottom' ? 'bottom of Deck' : 'top of Deck';
    case 'hand':
      return 'hand';
    case 'extra':
      return 'Extra Deck';
    case 'gy':
      return 'Graveyard';
    case 'banished':
      return 'Banished';
  }
}

/** Public zones show the card name in the log; hidden ones do not. */
function isPublic(loc: Loc, card: CardInst): boolean {
  if (loc.zone === 'hand' || loc.zone === 'deck' || loc.zone === 'extra') return false;
  if (loc.zone === 'skill') return !card.faceDown;
  if ((loc.zone === 'm' || loc.zone === 's') && card.faceDown) return false;
  return true;
}

function log(s: GameState, e: LoggedEvent, text: string) {
  s.log.push({ seq: e.seq, player: 'player' in e ? e.player : null, text });
}

function pName(s: GameState, p: PlayerId): string {
  return s.players[p].name || `Player ${p + 1}`;
}

function makeInst(owner: PlayerId, prefix: string, i: number, name: string, id: number | null): CardInst {
  return { iid: `${prefix}${i}`, cardId: id, name, owner, faceDown: false, defense: false, counters: 0 };
}

function draw(s: GameState, e: LoggedEvent, player: PlayerId, n: number) {
  const p = s.players[player];
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const c = p.deck.shift();
    if (!c) break;
    p.hand.push(c);
    drawn++;
  }
  if (drawn > 0) log(s, e, `${pName(s, player)} drew ${drawn} card${drawn === 1 ? '' : 's'}`);
  if (drawn < n) log(s, e, `${pName(s, player)} could not draw: Deck is empty`);
}

export function apply(prev: GameState, e: LoggedEvent): GameState {
  const s = clone(prev);
  switch (e.type) {
    case 'JOIN': {
      const p = s.players[e.player];
      p.name = e.name;
      p.deck = e.deck.main.map((c, i) => makeInst(e.player, `p${e.player}m`, i, c.name, c.id));
      p.extra = e.deck.extra.map((c, i) => makeInst(e.player, `p${e.player}x`, i, c.name, c.id));
      p.skill = e.skill ? { ...makeInst(e.player, `p${e.player}k`, 0, e.skill.name, e.skill.id), faceDown: true } : null;
      p.ready = true;
      log(s, e, `${e.name} joined with ${e.deck.title}${e.skill ? ` and the Skill "${e.skill.name}"` : ' and no Skill'}`);
      return s;
    }
    case 'START': {
      if (s.started) return s;
      s.started = true;
      s.turn = 1;
      s.turnPlayer = e.first;
      s.phase = 'DP';
      for (const pid of [0, 1] as PlayerId[]) {
        const p = s.players[pid];
        p.deck = shuffled(p.deck, e.seed + pid);
        p.lp = s.rules.startingLp;
      }
      log(s, e, `Coin flip: ${pName(s, e.first)} goes first. Both Decks shuffled.`);
      draw(s, e, 0, s.rules.startingHand);
      draw(s, e, 1, s.rules.startingHand);
      if (s.rules.firstPlayerDraws) draw(s, e, e.first, 1);
      log(s, e, `Turn 1: ${pName(s, e.first)}`);
      return s;
    }
    case 'MOVE': {
      const got = take(s, e.iid);
      if (!got) return prev;
      const card = { ...got.card };
      if (e.faceDown !== undefined) card.faceDown = e.faceDown;
      if (e.defense !== undefined) card.defense = e.defense;
      if (e.to.zone !== 'm') card.defense = false;
      if (e.to.zone === 'hand' || e.to.zone === 'deck' || e.to.zone === 'extra' || e.to.zone === 'gy' || e.to.zone === 'banished') {
        card.faceDown = false;
        card.counters = 0;
      }
      // Tokens leave the table when they leave the field.
      if (card.token && e.to.zone !== 'm') {
        log(s, e, `${pName(s, e.player)} removed a token`);
        return s;
      }
      if (!put(s, card, e.to)) return prev;
      const shown = isPublic(got.from, got.card) || isPublic(e.to, card);
      const what = shown ? `"${card.name}"` : 'a card';
      const side = e.to.player !== card.owner ? ` (${pName(s, e.to.player)}'s side)` : '';
      let verb = 'moved';
      if (got.from.zone === 'hand' && e.to.zone === 'm') verb = card.faceDown ? 'Set' : 'Summoned';
      if (got.from.zone === 'hand' && e.to.zone === 's') verb = card.faceDown ? 'Set' : 'activated';
      if (e.to.zone === 'gy') verb = 'sent to the Graveyard';
      if (e.to.zone === 'banished') verb = 'banished';
      const dest = e.to.zone === 'gy' || e.to.zone === 'banished' ? '' : ` to ${zoneLabel(e.to)}${side}`;
      log(s, e, `${pName(s, e.player)} ${verb} ${what}${dest}`);
      if (e.to.zone === 'm' && !card.faceDown && got.from.zone !== 'm') s.lastSummon = { iid: card.iid, seq: e.seq };
      return s;
    }
    case 'FLIP': {
      const f = findCard(s, e.iid);
      if (!f) return prev;
      f.card.faceDown = !f.card.faceDown;
      replaceCard(s, f.card);
      log(s, e, `${pName(s, e.player)} flipped ${f.card.faceDown ? 'a card face-down' : `"${f.card.name}" face-up`} in ${zoneLabel(f.loc)}`);
      if (!f.card.faceDown && f.loc.zone === 'm') s.lastSummon = { iid: f.card.iid, seq: e.seq };
      return s;
    }
    case 'POSITION': {
      const f = findCard(s, e.iid);
      if (!f || f.loc.zone !== 'm') return prev;
      f.card.defense = !f.card.defense;
      replaceCard(s, f.card);
      const what = f.card.faceDown ? 'a face-down monster' : `"${f.card.name}"`;
      log(s, e, `${pName(s, e.player)} changed ${what} to ${f.card.defense ? 'Defense' : 'Attack'} Position`);
      return s;
    }
    case 'COUNTER': {
      const f = findCard(s, e.iid);
      if (!f) return prev;
      f.card.counters = Math.max(0, f.card.counters + e.delta);
      replaceCard(s, f.card);
      log(s, e, `${pName(s, e.player)} ${e.delta > 0 ? 'added' : 'removed'} a counter (${f.card.counters} on "${f.card.name}")`);
      return s;
    }
    case 'TOKEN': {
      const token: CardInst = {
        iid: `tok${e.seq}`,
        cardId: null,
        name: e.name || 'Token',
        owner: e.player,
        faceDown: false,
        defense: false,
        counters: 0,
        token: true,
      };
      if (!put(s, token, { player: e.player, zone: 'm', index: e.index })) return prev;
      log(s, e, `${pName(s, e.player)} placed a token in Monster Zone ${e.index + 1}`);
      return s;
    }
    case 'DRAW':
      draw(s, e, e.player, e.n);
      return s;
    case 'SHUFFLE': {
      const p = s.players[e.player];
      p.deck = shuffled(p.deck, e.seed);
      log(s, e, `${pName(s, e.player)} shuffled their Deck`);
      return s;
    }
    case 'LP': {
      const p = s.players[e.target];
      const before = p.lp;
      if (e.set !== undefined) p.lp = Math.max(0, e.set);
      else p.lp = Math.max(0, p.lp + (e.delta ?? 0));
      const diff = p.lp - before;
      log(s, e, `${pName(s, e.target)}: ${before} → ${p.lp} LP (${diff >= 0 ? '+' : ''}${diff})`);
      if (p.lp === 0 && s.winner === null) {
        s.winner = other(e.target);
        log(s, e, `${pName(s, s.winner)} wins the Duel!`);
      }
      return s;
    }
    case 'PHASE': {
      s.phase = e.phase;
      log(s, e, `${pName(s, s.turnPlayer)}: ${PHASE_LABEL[e.phase]} Phase`);
      return s;
    }
    case 'END_TURN': {
      s.turn += 1;
      s.turnPlayer = other(s.turnPlayer);
      s.phase = PHASES[0];
      s.waitFlag = null;
      log(s, e, `Turn ${s.turn}: ${pName(s, s.turnPlayer)}`);
      draw(s, e, s.turnPlayer, 1);
      return s;
    }
    case 'DICE':
      log(s, e, `${pName(s, e.player)} rolled a die: ${e.value}`);
      return s;
    case 'COIN':
      log(s, e, `${pName(s, e.player)} tossed a coin: ${e.heads ? 'Heads' : 'Tails'}`);
      return s;
    case 'REVEAL': {
      const f = findCard(s, e.iid);
      if (!f) return prev;
      log(s, e, `${pName(s, e.player)} revealed "${f.card.name}" from their ${zoneLabel(f.loc)}`);
      return s;
    }
    case 'BATTLE': {
      const atk = findCard(s, e.attacker);
      if (!atk) return prev;
      const tgt = e.target ? findCard(s, e.target) : null;
      const who = pName(s, e.player);
      if (!e.result) {
        log(s, e, `${who}: "${atk.card.name}" attacks ${tgt ? (tgt.card.faceDown ? 'a face-down monster' : `"${tgt.card.name}"`) : 'directly'}`);
        return s;
      }
      const r = e.result;
      if (tgt && r.flipTarget && tgt.card.faceDown) {
        tgt.card.faceDown = false;
        replaceCard(s, tgt.card);
      }
      const parts: string[] = [`${who}: "${atk.card.name}" attacks ${tgt ? `"${tgt.card.name}"` : 'directly'}`];
      if (r.damageTo !== null && r.damage > 0) {
        const p = s.players[r.damageTo];
        const before = p.lp;
        p.lp = Math.max(0, p.lp - r.damage);
        parts.push(`${pName(s, r.damageTo)} takes ${r.damage} (${before} → ${p.lp} LP)`);
        if (p.lp === 0 && s.winner === null) s.winner = other(r.damageTo);
      }
      if (tgt && r.destroyTarget) {
        const got = take(s, tgt.card.iid);
        if (got && !got.card.token) put(s, { ...got.card, faceDown: false, defense: false, counters: 0 }, { player: got.card.owner, zone: 'gy' });
        parts.push(`"${tgt.card.name}" destroyed`);
      }
      if (r.destroyAttacker) {
        const got = take(s, atk.card.iid);
        if (got && !got.card.token) put(s, { ...got.card, faceDown: false, defense: false, counters: 0 }, { player: got.card.owner, zone: 'gy' });
        parts.push(`"${atk.card.name}" destroyed`);
      }
      log(s, e, parts.join('; '));
      if (s.winner !== null && !s.log.some((l) => l.text.endsWith('wins the Duel!'))) log(s, e, `${pName(s, s.winner)} wins the Duel!`);
      return s;
    }
    case 'WAIT':
      s.waitFlag = e.player;
      log(s, e, `${pName(s, e.player)}: WAIT, I respond!`);
      return s;
    case 'WAIT_CLEAR':
      s.waitFlag = null;
      return s;
    case 'UNDO':
      // Handled by replay(): the target event is skipped. Only the note is added here.
      log(s, e, `${pName(s, e.player)} undid their last action`);
      return s;
    case 'RENAME':
      s.players[e.player].name = e.name;
      return s;
  }
}

/** Writes a mutated card copy back to the slot it occupies. */
function replaceCard(s: GameState, card: CardInst) {
  for (const p of s.players) {
    for (const zone of ['deck', 'hand', 'extra', 'gy', 'banished'] as const) {
      const i = p[zone].findIndex((c) => c.iid === card.iid);
      if (i >= 0) {
        p[zone][i] = card;
        return;
      }
    }
    for (const zone of ['monsters', 'spells'] as const) {
      const i = p[zone].findIndex((c) => c?.iid === card.iid);
      if (i >= 0) {
        p[zone][i] = card;
        return;
      }
    }
    if (p.field?.iid === card.iid) {
      p.field = card;
      return;
    }
    if (p.skill?.iid === card.iid) {
      p.skill = card;
      return;
    }
  }
}

/** Sequence of the newest event by `player` that can still be undone. */
export function lastUndoable(events: LoggedEvent[], player: PlayerId): number | null {
  const undone = new Set<number>();
  for (const e of events) if (e.type === 'UNDO') undone.add(e.target);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!('player' in e) || e.player !== player) continue;
    if (e.type === 'UNDO' || e.type === 'JOIN' || e.type === 'WAIT_CLEAR' || e.type === 'RENAME') continue;
    if (undone.has(e.seq)) continue;
    return e.seq;
  }
  return null;
}

export type { GameEvent };
