// Shared test kit for Speed Duel: the merged card database (EDS + Speed Duel lists, the
// same way src/eds/db.ts builds it), a random player, and a duel runner that checks
// the engine's invariants. Used by tests/speed*.test.ts.
import { readFileSync } from 'node:fs';
import { Engine, other } from '../src/eds/engine';
import { aiAction } from '../src/eds/ai';
import { getEffect } from '../src/eds/effects';
import type { Action, Card, CardInfo, FieldCard, Pid } from '../src/eds/types';

/** A monster with no effect at all: Normal Monsters, Fusions that only list materials, plain Ritual Monsters. */
export function isVanilla(r: { type: string; desc: string }): boolean {
  if (r.type === 'Normal Monster' || r.type === 'Ritual Monster') return true;
  if (r.type !== 'Fusion Monster') return false;
  return r.desc.replace(/^("[^"]+")(\s*\+\s*"[^"]+")+/, '').trim() === '';
}

/** Tuners; Xyz Monsters have a Rank instead of a Level; Link Monsters have a Link Rating. */
function extraStats(r: { type: string; level?: number; linkval?: number; desc: string }, sub: string) {
  const out: { tuner?: boolean; rank?: number; level?: number; linkRating?: number } = {};
  if (/Tuner/.test(r.type)) out.tuner = true;
  if (sub === 'Xyz') (out.rank = r.level), (out.level = undefined);
  if (sub === 'Link') out.linkRating = r.linkval ?? Number(r.desc.match(/^(\d+)/)?.[1] ?? 1);
  return out;
}

function toInfo(r: any): CardInfo {
  const t: string = r.type;
  let kind: CardInfo['kind'] = 'monster';
  let sub = 'Normal';
  if (t === 'Spell Card') (kind = 'spell'), (sub = r.race ?? 'Normal');
  else if (t === 'Trap Card') (kind = 'trap'), (sub = r.race ?? 'Normal');
  else if (t === 'Ticket Card') (kind = 'spell'), (sub = 'Ticket');
  else if (t === 'Skill Card') (kind = 'spell'), (sub = 'Skill');
  else if (/XYZ|Synchro|Link/.test(t)) sub = t.includes('XYZ') ? 'Xyz' : t.includes('Synchro') ? 'Synchro' : 'Link';
  else if (/Fusion/.test(t)) sub = 'Fusion';
  else if (/Ritual/.test(t)) sub = 'Ritual';
  else if (/Effect|Flip|Tuner|Spirit|Toon|Union|Gemini/.test(t)) sub = 'Effect';
  return { id: r.id, name: r.name, kind, sub, atk: r.atk, def: r.def, level: r.level, attribute: r.attribute, race: kind === 'monster' ? r.race : undefined, desc: r.desc, n: r.n, password: r.password, alias: r.alias, character: r.character, vanilla: isVanilla(r), ...extraStats(r, sub) };
}

export const DB = new Map<string, CardInfo>();
const byId = new Map<number, CardInfo>();
for (const r of JSON.parse(readFileSync('public/cards/cards.json', 'utf8')) as any[]) {
  const info = toInfo(r);
  DB.set(info.name, info);
  DB.set(info.name.toLowerCase(), info);
  byId.set(info.id, info);
  if (r.alias) (DB.set(r.alias, info), DB.set(r.alias.toLowerCase(), info));
}
for (const r of JSON.parse(readFileSync('public/cards/speed.json', 'utf8')) as any[]) {
  const known = byId.get(r.id) ?? (r.type !== 'Skill Card' && DB.get(r.name)?.name === r.name ? DB.get(r.name) : undefined);
  if (known && r.type !== 'Skill Card') {
    known.speed = true;
    if (!DB.has(r.name)) (DB.set(r.name, known), DB.set(r.name.toLowerCase(), known));
    continue;
  }
  const info = { ...toInfo(r), speed: true };
  if (!DB.has(info.name)) DB.set(info.name, info);
  if (!DB.has(info.name.toLowerCase())) DB.set(info.name.toLowerCase(), info);
  byId.set(info.id, info);
}

const uniq = (list: CardInfo[]) => {
  const seen = new Set<number>();
  return list.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
};
/** Every Speed Duel card (no Skills). */
export const SPEED: CardInfo[] = uniq([...DB.values()].filter((c) => c.speed && c.sub !== 'Skill'));
export const SKILLS: CardInfo[] = uniq([...DB.values()].filter((c) => c.sub === 'Skill'));
/** Cards the engine can summon/use at all in Speed Duel (no Tokens). */
export const PLAYABLE = SPEED.filter((c) => !(c.kind === 'monster' && / Token$/.test(c.name)) && !(c.kind === 'monster' && c.desc.startsWith('This card cannot be used in a Duel')));

// ---------- randomness ----------
let seed = 4242;
export const setSeed = (s: number) => (seed = s >>> 0);
export const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
export const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
export const shuffle = <T>(a: T[]): T[] => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

const freeZone = (z: (FieldCard | null)[]) => z.findIndex((x) => x === null);

/** A player that tries anything legal, at random. */
export function randomAction(e: Engine, me: Pid): Action | null {
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
  if (e.canUseSkill(me)) acts.push({ type: 'SKILL', player: me }, { type: 'SKILL', player: me });
  if (e.inMainPhase()) {
    for (const c of ps.hand) {
      if (e.canNormalSummon(me, c)) {
        const z = Math.max(0, freeZone(ps.mz));
        if (e.canNormalSummon(me, c, true)) acts.push({ type: 'SUMMON', player: me, uid: c.uid, zone: z, pos: 'atk', faceUp: true });
        if (e.canNormalSummon(me, c, false)) acts.push({ type: 'SUMMON', player: me, uid: c.uid, zone: z, pos: 'def', faceUp: false });
      }
      if (e.canSpecialProc(me, c)) acts.push({ type: 'SPECIAL', player: me, uid: c.uid }, { type: 'SPECIAL', player: me, uid: c.uid });
      if (e.canUseMonsterEffect(me, c)) acts.push({ type: 'MONSTER_EFFECT', player: me, uid: c.uid }, { type: 'MONSTER_EFFECT', player: me, uid: c.uid });
      if (e.canActivateMain(me, c.uid)) acts.push({ type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(ps.sz) }, { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(ps.sz) });
      if (e.canSet(me, c)) acts.push({ type: 'SET_ST', player: me, uid: c.uid, zone: freeZone(ps.sz) });
    }
    for (const c of ps.fusion) if (e.canSpecialProc(me, c)) acts.push({ type: 'SPECIAL', player: me, uid: c.uid }, { type: 'SPECIAL', player: me, uid: c.uid });
    for (const c of [...ps.hand, ...ps.gy, ...e.monsters(me), ...ps.sz.filter((z): z is FieldCard => !!z)]) if (e.canUseQuickNow(me, c.uid)) acts.push({ type: 'QUICK_EFFECT', player: me, uid: c.uid });
    for (const c of ps.gy) if (e.canUseGraveEffect(me, c.uid)) acts.push({ type: 'GRAVE_EFFECT', player: me, uid: c.uid }, { type: 'GRAVE_EFFECT', player: me, uid: c.uid });
    for (const m of e.monsters(me)) {
      if (!m.faceUp && !m.posChanged && m.placedTurn !== s.turn && !e.summonBlocked(me, m, 'flip', 'mz')) acts.push({ type: 'FLIP_SUMMON', player: me, uid: m.uid });
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
      for (const t of e.legalTargets(me, m)) acts.push({ type: 'ATTACK', player: me, uid: m.uid, target: t.uid });
      if (e.monsters(other(me)).length === 0 || e.canAttackDirectly(m)) acts.push({ type: 'ATTACK', player: me, uid: m.uid, target: null }, { type: 'ATTACK', player: me, uid: m.uid, target: null });
    }
    acts.push({ type: 'NEXT_PHASE', player: me });
  } else acts.push({ type: 'NEXT_PHASE', player: me });
  return pick(acts);
}

export function everyCard(e: Engine): Card[] {
  const out: Card[] = [];
  for (const p of [0, 1] as Pid[]) {
    const ps = e.player(p);
    out.push(...ps.deck, ...ps.hand, ...ps.gy, ...ps.removed, ...ps.fusion);
    // Xyz Materials sit under their Xyz Monster.
    for (const z of [...ps.mz, ...ps.sz, ps.field]) if (z) out.push(z, ...(z.mats ?? []));
  }
  return out;
}

export interface DuelResult {
  fail: string;
  actions: number;
  engine: Engine;
}

/** Plays one Speed Duel to the end with the given brains and checks invariants after every action. */
export function playDuel(decks: [string[], string[]], extras: [string[], string[]], skills: [string | null, string | null], g: number, brains: ((e: Engine, p: Pid) => Action | null)[]): DuelResult {
  const e = new Engine(DB);
  e.apply({ type: 'START', first: (g % 2) as Pid, seed: 9000 + g, names: ['Random', 'Computer'], decks, fusions: extras, mode: 'speed', skills });
  const startCount = everyCard(e).filter((c) => !c.token).length;
  let n = 0;
  let idle = 0;
  let fail = '';
  let lastSig = '';
  const tail = () => e.state.log.slice(-6).map((l) => l.text).join(' / ');
  while (e.state.winner === null && n < 5000) {
    const p = e.state.prompt ? e.state.prompt.player : e.state.turnPlayer;
    const act = brains[p](e, p);
    if (!act) {
      fail = `no action for player ${p} in ${e.state.phase} prompt=${e.state.prompt?.kind} ${e.state.prompt?.title ?? ''}`;
      break;
    }
    try {
      e.apply(act);
    } catch (err) {
      fail = `engine threw on ${JSON.stringify(act)}: ${(err as Error).stack?.split('\n').slice(0, 5).join(' | ')}\n   last log: ${tail()}`;
      break;
    }
    n++;
    const cards = everyCard(e).filter((c) => !c.token);
    const uids = new Set(cards.map((c) => c.uid));
    if (uids.size !== cards.length) fail = `duplicated card ${cards.filter((c, i) => cards.findIndex((d) => d.uid === c.uid) !== i).map((c) => `${c.name}@${e.find(c.uid)?.loc.zone}`).join(', ')} after ${JSON.stringify(act)}; log: ${tail()}`;
    else if (cards.length !== startCount) fail = `card count ${startCount} -> ${cards.length} after ${JSON.stringify(act)}; log: ${tail()}`;
    for (const q of [0, 1] as Pid[]) {
      if (!Number.isFinite(e.player(q).lp)) fail = `LP became ${e.player(q).lp}`;
      if (e.player(q).mz.length !== 3 || e.player(q).sz.length !== 3) fail = `zone count changed: ${e.player(q).mz.length}/${e.player(q).sz.length}`;
    }
    if (fail) break;
    const sig = `${e.state.log.length}|${e.state.phase}|${e.state.turn}|${e.state.prompt?.title ?? ''}`;
    if (sig === lastSig) {
      if (++idle > 60) {
        fail = `stuck: ${JSON.stringify(act)} ignored repeatedly in ${e.state.phase} T${e.state.turn} prompt=${e.state.prompt?.title ?? ''}; log: ${tail()}`;
        break;
      }
    } else idle = 0;
    lastSig = sig;
  }
  if (!fail && e.state.winner === null) fail = `no result after ${n} actions (turn ${e.state.turn})`;
  return { fail, actions: n, engine: e };
}

export { aiAction, getEffect };
