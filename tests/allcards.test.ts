// Every card in real duels: random decks built from the whole card list, played out
// by a random player against the computer duelist. Checks that nothing throws, no duel
// gets stuck, cards are never lost or duplicated, and reports cards that never did anything.
// Run: npx tsx tests/allcards.test.ts [games]
import { readFileSync } from 'node:fs';
import { Engine, other } from '../src/eds/engine';
import { aiAction } from '../src/eds/ai';
import { getEffect, EFFECT_TABLE } from '../src/eds/effects';

// Count every call into each card's script, so we know its code really ran.
const calls = new Map<object, Map<string, number>>();
const wrapped = new WeakSet<object>();
function wrap(obj: any, root: object, path: string, depth: number) {
  if (!obj || typeof obj !== 'object' || wrapped.has(obj) || depth > 2) return;
  wrapped.add(obj);
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'function') {
      obj[k] = function (this: unknown, ...args: unknown[]) {
        let m = calls.get(root);
        if (!m) calls.set(root, (m = new Map()));
        m.set(path + k, (m.get(path + k) ?? 0) + 1);
        return v.apply(this, args);
      };
    } else if (v && typeof v === 'object' && !Array.isArray(v)) wrap(v, root, path + k + '.', depth + 1);
  }
}
for (const d of Object.values(EFFECT_TABLE)) wrap(d, d, '', 0);
import type { Action, Card, CardInfo, FieldCard, Pid } from '../src/eds/types';

const raw = JSON.parse(readFileSync('public/cards/cards.json', 'utf8')) as any[];
const DB = new Map<string, CardInfo>();
const ALL: CardInfo[] = [];
for (const r of raw) {
  const t: string = r.type;
  let kind: CardInfo['kind'] = 'monster';
  let sub = 'Normal';
  if (t === 'Spell Card') (kind = 'spell'), (sub = r.race ?? 'Normal');
  else if (t === 'Trap Card') (kind = 'trap'), (sub = r.race ?? 'Normal');
  else if (t === 'Ticket Card') (kind = 'spell'), (sub = 'Ticket');
  else if (/Fusion/.test(t)) sub = 'Fusion';
  else if (/Ritual/.test(t)) sub = 'Ritual';
  else if (/Effect|Flip|Spirit|Toon|Union/.test(t)) sub = 'Effect';
  const info: CardInfo = { id: r.id, name: r.name, kind, sub, atk: r.atk, def: r.def, level: r.level, attribute: r.attribute, race: kind === 'monster' ? r.race : undefined, desc: r.desc, n: r.n, password: r.password, alias: r.alias };
  DB.set(info.name, info);
  DB.set(info.name.toLowerCase(), info);
  if (r.alias) (DB.set(r.alias, info), DB.set(r.alias.toLowerCase(), info));
  ALL.push(info);
}

const GAMES = Number(process.argv[2] ?? 120);
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const shuffle = <T>(a: T[]): T[] => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

const playable = ALL.filter((c) => c.sub !== 'Ticket' && !/Token/.test(c.name));
const mainPool = playable.filter((c) => c.sub !== 'Fusion').map((c) => c.name);
const fusionPool = playable.filter((c) => c.sub === 'Fusion').map((c) => c.name);

// Decks rotate through the whole pool so every card is played many times.
let mainQueue: string[] = [];
let fusionQueue: string[] = [];
function deck(): string[] {
  const out: string[] = [];
  while (out.length < 40) {
    if (!mainQueue.length) mainQueue = shuffle(mainPool);
    out.push(mainQueue.pop()!);
  }
  // A few plain beaters so duels actually reach their effects.
  return out;
}
function fusionDeck(): string[] {
  const out: string[] = [];
  while (out.length < 20) {
    if (!fusionQueue.length) fusionQueue = shuffle(fusionPool);
    out.push(fusionQueue.pop()!);
  }
  return out;
}

const freeZone = (z: (FieldCard | null)[]) => z.findIndex((x) => x === null);

/** A player that tries anything legal, at random. */
function randomAction(e: Engine, me: Pid): Action | null {
  const s = e.state;
  const pr = s.prompt;
  if (pr) {
    if (pr.player !== me) return null;
    if (pr.kind === 'yesno') return { type: rnd() < 0.6 ? 'YES' : 'NO', player: me };
    if (pr.kind === 'response') return pr.options.length && rnd() < 0.7 ? { type: 'CHOOSE', player: me, picks: [Math.floor(rnd() * pr.options.length)] } : { type: 'PASS', player: me };
    if (pr.cancel && rnd() < 0.08) return { type: 'CANCEL', player: me };
    const n = pr.min + Math.floor(rnd() * (pr.max - pr.min + 1));
    const picks = shuffle(pr.options.map((_, i) => i)).slice(0, Math.max(n, pr.min));
    return { type: 'CHOOSE', player: me, picks };
  }
  if (s.turnPlayer !== me) return null;
  const ps = e.player(me);
  const acts: Action[] = [];
  if (e.inMainPhase()) {
    for (const c of ps.hand) {
      if (e.canNormalSummon(me, c)) {
        const z = Math.max(0, freeZone(ps.mz));
        acts.push({ type: 'SUMMON', player: me, uid: c.uid, zone: z, pos: 'atk', faceUp: true });
        acts.push({ type: 'SUMMON', player: me, uid: c.uid, zone: z, pos: 'def', faceUp: false });
      }
      if (e.canSpecialProc(me, c)) acts.push({ type: 'SPECIAL', player: me, uid: c.uid }, { type: 'SPECIAL', player: me, uid: c.uid });
      if (e.canUseMonsterEffect(me, c)) acts.push({ type: 'MONSTER_EFFECT', player: me, uid: c.uid });
      if (e.canActivateMain(me, c.uid)) acts.push({ type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(ps.sz) }, { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(ps.sz) });
      if (e.canSet(me, c)) acts.push({ type: 'SET_ST', player: me, uid: c.uid, zone: freeZone(ps.sz) });
    }
    for (const m of e.monsters(me)) {
      if (!m.faceUp && !m.posChanged && m.placedTurn !== s.turn) acts.push({ type: 'FLIP_SUMMON', player: me, uid: m.uid });
      if (e.canChangePosition(me, m)) acts.push({ type: 'CHANGE_POS', player: me, uid: m.uid });
      if (e.canUseMonsterEffect(me, m)) acts.push({ type: 'MONSTER_EFFECT', player: me, uid: m.uid }, { type: 'MONSTER_EFFECT', player: me, uid: m.uid });
    }
    for (const c of [...ps.sz, ps.field]) {
      if (!c) continue;
      if (e.canActivateMain(me, c.uid)) acts.push({ type: 'ACTIVATE', player: me, uid: c.uid });
      if (e.canUseMonsterEffect(me, c)) acts.push({ type: 'MONSTER_EFFECT', player: me, uid: c.uid });
    }
    acts.push({ type: 'NEXT_PHASE', player: me });
    if (rnd() < 0.3) acts.push({ type: 'END_TURN', player: me });
  } else if (s.phase === 'BP') {
    for (const m of e.monsters(me)) {
      if (!e.canAttackWith(me, m)) continue;
      const targets = e.legalTargets(me, m);
      for (const t of targets) acts.push({ type: 'ATTACK', player: me, uid: m.uid, target: t.uid });
      if (e.monsters(other(me)).length === 0 || e.canAttackDirectly(m)) acts.push({ type: 'ATTACK', player: me, uid: m.uid, target: null }, { type: 'ATTACK', player: me, uid: m.uid, target: null });
    }
    acts.push({ type: 'NEXT_PHASE', player: me });
  } else acts.push({ type: 'NEXT_PHASE', player: me });
  return pick(acts);
}

function allCards(e: Engine): Card[] {
  const out: Card[] = [];
  for (const p of [0, 1] as Pid[]) {
    const ps = e.player(p);
    out.push(...ps.deck, ...ps.hand, ...ps.gy, ...ps.removed, ...ps.fusion);
    for (const z of [...ps.mz, ...ps.sz, ps.field]) if (z) out.push(z);
  }
  return out;
}

const used = new Map<string, number>(); // card name -> times it showed up in the duel log
const seen = new Set<string>();
let failures = 0;
let total = 0;
const outcomes: Record<string, number> = {};
const t0 = Date.now();

for (let g = 0; g < GAMES; g++) {
  const decks: [string[], string[]] = [deck(), deck()];
  const fusions: [string[], string[]] = [fusionDeck(), fusionDeck()];
  for (const d of [...decks, ...fusions]) for (const n of d) seen.add(n);
  const e = new Engine(DB);
  e.apply({ type: 'START', first: (g % 2) as Pid, seed: 7000 + g, names: ['Random', 'Computer'], decks, fusions });
  const startCount = allCards(e).length;
  // Odd games: both players random. Even games: random vs the computer duelist.
  const brains: ((e: Engine, p: Pid) => Action | null)[] = g % 2 ? [randomAction, randomAction] : [randomAction, aiAction];
  let n = 0;
  let idle = 0;
  let fail = '';
  let lastSig = '';
  while (e.state.winner === null && n < 4000) {
    const p = e.state.prompt ? e.state.prompt.player : e.state.turnPlayer;
    const act = brains[p](e, p);
    if (!act) {
      fail = `no action for player ${p} in ${e.state.phase} prompt=${e.state.prompt?.kind} ${e.state.prompt?.title ?? ''}`;
      break;
    }
    try {
      e.apply(act);
    } catch (err) {
      fail = `engine threw on ${JSON.stringify(act)}: ${(err as Error).stack?.split('\n').slice(0, 4).join(' | ')}\n   last log: ${e.state.log.slice(-4).map((l) => l.text).join(' / ')}`;
      break;
    }
    n++;
    // Invariants.
    const cards = allCards(e).filter((c) => !c.token);
    const uids = new Set(cards.map((c) => c.uid));
    if (uids.size !== cards.length) {
      fail = `duplicated card after ${JSON.stringify(act)}; log: ${e.state.log.slice(-4).map((l) => l.text).join(' / ')}`;
      break;
    }
    if (cards.length !== startCount) {
      fail = `card count ${startCount} -> ${cards.length} after ${JSON.stringify(act)}; log: ${e.state.log.slice(-5).map((l) => l.text).join(' / ')}`;
      break;
    }
    for (const p of [0, 1] as Pid[]) if (!Number.isFinite(e.player(p).lp)) fail = `LP became ${e.player(p).lp}`;
    if (fail) break;
    const sig = `${e.state.log.length}|${e.state.phase}|${e.state.turn}|${e.state.prompt?.title ?? ''}`;
    if (sig === lastSig) {
      if (++idle > 60) {
        fail = `stuck: ${JSON.stringify(act)} ignored repeatedly in ${e.state.phase} T${e.state.turn}`;
        break;
      }
    } else idle = 0;
    lastSig = sig;
  }
  if (!fail && e.state.winner === null) fail = `no result after ${n} actions (turn ${e.state.turn})`;
  total += n;
  for (const l of e.state.log) {
    for (const name of seen) if (l.text.includes(name)) used.set(name, (used.get(name) ?? 0) + 1);
  }
  const reason = (e.state.winReason ?? '').replace(/^.*?(Life Points|no cards|Exodia|surrender|draw).*$/i, '$1');
  outcomes[reason] = (outcomes[reason] ?? 0) + 1;
  if (fail) {
    failures++;
    console.log(`FAIL game ${g} (T${e.state.turn}): ${fail}`);
  }
}

const silent = [...seen].filter((n) => !used.has(n) && !!getEffect(n));
console.log(`${GAMES} duels, ${seen.size} different cards dealt, avg ${Math.round(total / GAMES)} actions, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('endings', outcomes);
console.log(`effect cards never seen in a duel log (${silent.length}):`, silent.slice(0, 80).join(', '));
// Hooks that only ask a question (can this happen?) do not prove the effect itself ran.
const QUESTION = /^(can|condition|canActivate|targetFilter|cannotAttack|blocksAttack|attackInDefense|directAttack|baseStats|aura|auraTarget|bonus|defenseMult|fusionSub|activateCost\.can|attackTax\.can|summonProc\.can|handIgnition\.can|ignition\.can)$/;
const report: string[] = [];
const neverRan: string[] = [];
for (const n of seen) {
  const d = getEffect(n);
  if (!d) continue;
  const fnKeys: string[] = [];
  const collect = (o: any, path: string, depth: number) => {
    for (const k of Object.keys(o)) {
      if (typeof o[k] === 'function') fnKeys.push(path + k);
      else if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) && depth < 2) collect(o[k], path + k + '.', depth + 1);
    }
  };
  collect(d, '', 0);
  if (!fnKeys.length) continue; // data only (fusion material, cannot be Normal Summoned...)
  const got = calls.get(d) ?? new Map();
  const doing = fnKeys.filter((k) => !QUESTION.test(k));
  if (![...got.keys()].length) neverRan.push(n);
  else if (doing.length && !doing.some((k) => got.has(k))) report.push(`${n} [${doing.join(',')}]`);
}
console.log(`cards whose script never ran (${neverRan.length}):`, neverRan.join(', '));
console.log(`cards whose checks ran but whose effect never resolved (${report.length}):`);
for (const r of report) console.log('  ' + r);
console.log(failures ? `${failures} FAILURES` : 'ALL OK');
process.exit(failures ? 1 : 0);
