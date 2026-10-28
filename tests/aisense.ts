// How sensibly the computer plays its effects: computer-vs-computer Speed Duels (campaign decks and
// random decks) where every effect the measured duelist starts is judged once it has resolved.
// - selfHit: it lost more of its own field cards than the opponent did and ended worse off
// - waste: it ended clearly worse off and the opponent lost nothing (no cards, no LP)
// Run: npx tsx tests/aisense.ts [duels] [level] [verbose]
import { DB as KIT } from './speedkit';
import { DB } from '../src/eds/db';
import { Engine } from '../src/eds/engine';
import { aiAction } from '../src/eds/ai';
import { evaluate } from '../src/eds/aiEval';
import { DEFAULT_TACTICS, type Tactics } from '../src/eds/tactics';
import type { Action, Pid } from '../src/eds/types';
import { STARTERS, deckFromStarter } from '../src/eds/speedSave';
import { CHAPTERS } from '../src/eds/speedCampaign/roster';
import { deckOf } from '../src/eds/speedCampaign/campaign';
import { randomSpeedDeck } from '../src/eds/speedRandom';

for (const [k, v] of KIT) DB.set(k, v);

export interface SenseStats {
  duels: number;
  wins: number;
  moves: number;
  selfHit: number;
  waste: number;
  turns: number;
  cards: Map<string, { selfHit: number; waste: number; uses: number }>;
  samples: string[];
}
export const newSense = (): SenseStats => ({ duels: 0, wins: 0, moves: 0, selfHit: 0, waste: 0, turns: 0, cards: new Map(), samples: [] });

type Seat = { main: string[]; extra: string[]; skill: string | null; t: Tactics };

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fieldUids = (e: Engine, p: Pid) => new Set([...e.monsters(p), ...e.spells(p), ...(e.player(p).field ? [e.player(p).field!] : [])].map((c) => c.uid));

/** One duel; seat 1 is measured. */
export function senseDuel(a: Seat, b: Seat, seed: number, st: SenseStats, verbose = false) {
  const e = new Engine(DB);
  e.apply({ type: 'START', first: (seed % 2) as Pid, seed, names: ['A', 'B'], decks: [a.main, b.main], fusions: [a.extra, b.extra], mode: 'speed', skills: [a.skill, b.skill] });
  const tact = [a.t, b.t];
  const me = 1 as Pid;
  type Snap = { battle: boolean; name: string; uid: number; v: number; mine: Set<number>; theirs: Set<number>; lp: [number, number]; hand: number; turn: number; log: number };
  let pending: Snap | null = null;
  const judge = (p: Snap) => {
    if (e.state.winner !== null || e.state.turn !== p.turn) return;
    const d = evaluate(e, me) - p.v;
    const nowMine = fieldUids(e, me);
    const nowTheirs = fieldUids(e, 0);
    const ownLost = [...p.mine].filter((u) => u !== p.uid && !nowMine.has(u)).length;
    const oppLost = [...p.theirs].filter((u) => !nowTheirs.has(u)).length;
    const hurt = p.lp[0] - e.player(0).lp;
    const rec = st.cards.get(p.name) ?? { selfHit: 0, waste: 0, uses: 0 };
    rec.uses++;
    st.moves++;
    let flag = '';
    if (ownLost > 0 && ownLost > oppLost && d < 0) (rec.selfHit++, st.selfHit++, (flag = 'SELF'));
    else if (!p.battle && d <= -250 && oppLost === 0 && hurt <= 0 && e.player(me).hand.length <= p.hand && e.player(me).lp <= p.lp[1]) (rec.waste++, st.waste++, (flag = 'WASTE'));
    st.cards.set(p.name, rec);
    if (flag && st.samples.length < 400) st.samples.push(`${flag} ${p.name} d=${Math.round(d)} own-${ownLost} opp-${oppLost} :: ${e.state.log.slice(p.log).map((l) => l.text).join(' | ').slice(0, 400)}`);
  };
  let n = 0;
  while (e.state.winner === null && n < 4000) {
    const pr = e.state.prompt;
    const p = (pr ? pr.player : e.state.turnPlayer) as Pid;
    const act: Action | null = aiAction(e, p, tact[p]);
    if (!act) break;
    if (pending && !pr && !e.state.chain.length) (judge(pending), (pending = null));
    if (act.player === me && !pending) {
      let uid = -1;
      let name = '';
      if (!pr && (act.type === 'ACTIVATE' || act.type === 'MONSTER_EFFECT' || act.type === 'GRAVE_EFFECT')) (uid = act.uid), (name = e.find(act.uid)?.card.name ?? '?');
      else if (!pr && act.type === 'SKILL') (uid = -2), (name = `Skill ${e.player(me).skill}`);
      else if (pr?.kind === 'response' && act.type === 'CHOOSE') {
        const o = pr.options[act.picks[0]];
        (uid = o.uid ?? -1), (name = o.uid !== undefined ? (e.find(o.uid)?.card.name ?? o.label) : o.label);
      }
      if (name) pending = { battle: !!pr && / attacks/.test(pr.title), name, uid, v: evaluate(e, me), mine: fieldUids(e, me), theirs: fieldUids(e, 0), lp: [e.player(0).lp, e.player(1).lp], hand: e.player(me).hand.length, turn: e.state.turn, log: e.state.log.length };
    }
    try {
      e.apply(act);
    } catch (err) {
      if (verbose) console.log('engine threw', act, err);
      break;
    }
    n++;
  }
  st.duels++;
  st.turns += e.state.turn;
  if (e.state.winner === me) st.wins++;
}

export function runSense(duels: number, level: Tactics['level'], oppLevel: Tactics['level'] = 'normal', seed0 = 1): SenseStats {
  const st = newSense();
  const starters = STARTERS.map((s) => deckFromStarter(s));
  const roster = CHAPTERS.flatMap((c) => c.nodes.map((n) => deckOf(n.duelist)));
  for (let i = 0; i < duels; i++) {
    const rand = mulberry(seed0 * 7919 + i);
    // half the duels on campaign decks, half on random decks (every card in the pool can show up)
    const rnd = () => {
      const r = randomSpeedDeck(undefined, { size: 30, rand });
      if ('error' in r) throw new Error(r.error);
      return r;
    };
    const mine = i % 2 ? roster[(i * 5) % roster.length] : rnd();
    const theirs = i % 3 ? starters[i % starters.length] : rnd();
    senseDuel({ ...theirs, t: { ...DEFAULT_TACTICS, level: oppLevel } }, { ...mine, t: { ...DEFAULT_TACTICS, level } }, seed0 * 100003 + i * 31, st);
  }
  return st;
}

export function senseLine(name: string, s: SenseStats) {
  return `${name.padEnd(10)} duels ${s.duels} win ${Math.round((100 * s.wins) / Math.max(1, s.duels))}% avgT ${(s.turns / Math.max(1, s.duels)).toFixed(1)} moves ${s.moves} selfHit ${s.selfHit} waste ${s.waste} (${((100 * (s.selfHit + s.waste)) / Math.max(1, s.moves)).toFixed(1)}% bad)`;
}

if (process.argv[1]?.endsWith('aisense.ts')) {
  const duels = Number(process.argv[2] ?? 40);
  const level = (process.argv[3] ?? 'normal') as Tactics['level'];
  const t0 = Date.now();
  const st = runSense(duels, level);
  console.log(senseLine(level ?? 'normal', st), `(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  const worst = [...st.cards.entries()].filter(([, r]) => r.selfHit + r.waste > 0).sort((x, y) => y[1].selfHit + y[1].waste - (x[1].selfHit + x[1].waste));
  for (const [k, r] of worst.slice(0, 40)) console.log(`  ${k}: self ${r.selfHit} waste ${r.waste} / ${r.uses}`);
  if (process.argv[4]) for (const x of st.samples) console.log(x);
}
