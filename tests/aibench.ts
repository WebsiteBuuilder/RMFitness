// Computer-vs-computer Speed Duel benchmark: campaign duelists against the starter decks.
// Counts how long duels run, how often they end by deck-out, and self-harming plays.
// Run: npx tsx tests/aibench.ts [duelsPerPair] [level|all]
import { DB as KIT } from './speedkit';
import { DB } from '../src/eds/db';
import { Engine, other } from '../src/eds/engine';
import { aiAction } from '../src/eds/ai';
import { DEFAULT_TACTICS, type Tactics } from '../src/eds/tactics';
import type { Action, Pid } from '../src/eds/types';
import { STARTERS, deckFromStarter } from '../src/eds/speedSave';
import { CHAPTERS } from '../src/eds/speedCampaign/roster';
import { deckOf } from '../src/eds/speedCampaign/campaign';
import { campaignDifficulty } from '../src/eds/difficulty';

for (const [k, v] of KIT) DB.set(k, v);

export interface BenchStats {
  duels: number;
  turns: number;
  deckOuts: number;
  unfinished: number;
  long: number;
  wins: number;
  skillSelfHarm: number;
  equipOnFoe: number;
  costForBurn: number;
  suicideAttacks: number;
  attacks: number;
}

export const newStats = (): BenchStats => ({ duels: 0, turns: 0, deckOuts: 0, unfinished: 0, long: 0, wins: 0, skillSelfHarm: 0, equipOnFoe: 0, costForBurn: 0, suicideAttacks: 0, attacks: 0 });

type Seat = { main: string[]; extra: string[]; skill: string | null; t: Tactics };

/** Plays one duel; seat 1 is the duelist being measured. Self-harm counters are counted for seat 1 only. */
export function benchDuel(a: Seat, b: Seat, seed: number, st: BenchStats) {
  const e = new Engine(DB);
  e.apply({ type: 'START', first: (seed % 2) as Pid, seed, names: ['A', 'B'], decks: [a.main, b.main], fusions: [a.extra, b.extra], mode: 'speed', skills: [a.skill, b.skill] });
  const tact = [a.t, b.t];
  const me = 1 as Pid;
  const atkSum = () => e.monsters(me).reduce((x, m) => x + (m.faceUp ? e.atkOf(m) : 0), 0);
  type Snap = { kind: string; lp: number[]; myAtk: number; myCount: number; theirCount: number; theirAtk: Map<number, number>; uid: number };
  let pending: Snap | null = null;
  /** Judges a move of the measured duelist once it has fully resolved (its prompts answered). */
  const judge = (p: Snap) => {
    if (e.state.winner !== null) return;
    if (p.kind === 'SKILL' && p.lp[1] - e.player(1).lp >= 1000 && e.player(1).lp < e.player(0).lp) st.skillSelfHarm++;
    if (p.kind === 'MONSTER_EFFECT') {
      const burned = p.lp[0] - e.player(0).lp;
      if (burned > 0 && e.monsters(me).length < p.myCount && p.myAtk - atkSum() >= 1500 && e.monsters(0).length >= p.theirCount) st.costForBurn++;
    }
    if (p.kind === 'ACTIVATE') {
      const eq = e.fieldCard(p.uid);
      const host = eq?.equippedTo !== undefined ? e.fieldCard(eq.equippedTo) : null;
      if (host && e.controller(host.uid) === 0 && e.atkOf(host) > (p.theirAtk.get(host.uid) ?? 0)) {
        st.equipOnFoe++;
        if (process.env.TRACE_EQUIP) console.log("EQUIP ON FOE", eq?.name, "->", host.name, e.state.log.slice(-8).map((l) => l.text).join(" | "));
      }
    }
  };
  let n = 0;
  let lastTurn = 0;
  const dump = typeof process !== 'undefined' && process.env.TRACE_TURNS;
  while (e.state.winner === null && n < 4000) {
    if (dump && e.state.turn !== lastTurn) {
      lastTurn = e.state.turn;
      for (const q of [0, 1] as Pid[]) console.log(`  T${lastTurn} p${q} lp ${e.player(q).lp} deck ${e.player(q).deck.length} hand [${e.player(q).hand.map((c) => c.name).join(', ')}] field [${e.monsters(q).map((m) => `${m.name}${m.faceUp ? '' : '(fd)'}/${m.pos}/${e.atkOf(m)}`).join(', ')}] st [${e.spells(q).map((m) => m.name + (m.faceUp ? '' : '(set)')).join(', ')}]`);
    }
    const p = (e.state.prompt ? e.state.prompt.player : e.state.turnPlayer) as Pid;
    const act: Action | null = aiAction(e, p, tact[p]);
    if (!act) break;
    if (pending && !e.state.prompt) (judge(pending), (pending = null));
    const attacker = act.type === 'ATTACK' ? e.fieldCard(act.uid) : null;
    const target = act.type === 'ATTACK' && act.target !== null ? e.fieldCard(act.target) : null;
    if (act.player === me && !e.state.prompt && (act.type === 'SKILL' || act.type === 'MONSTER_EFFECT' || act.type === 'ACTIVATE'))
      pending = { kind: act.type, uid: act.uid ?? -1, lp: [e.player(0).lp, e.player(1).lp], myAtk: atkSum(), myCount: e.monsters(me).length, theirCount: e.monsters(0).length, theirAtk: new Map(e.monsters(0).map((m) => [m.uid, e.atkOf(m)])) } as Snap;
    try {
      e.apply(act);
    } catch {
      break;
    }
    n++;
    if (act.player === me && act.type === 'ATTACK') {
      st.attacks++;
      if (attacker && target && target.faceUp && !e.fieldCard(attacker.uid) && e.fieldCard(target.uid)) st.suicideAttacks++;
    }
  }
  st.duels++;
  st.turns += e.state.turn;
  if (e.state.winner === null) st.unfinished++;
  if (e.state.turn >= 20) st.long++;
  if (/no cards left/.test(e.state.winReason)) st.deckOuts++;
  if (e.state.winner === 1) st.wins++;
  return e;
}

export const pct = (a: number, b: number) => `${b ? Math.round((100 * a) / b) : 0}%`;

export function line(name: string, s: BenchStats) {
  return `${name.padEnd(22)} duels ${String(s.duels).padStart(3)}  win ${pct(s.wins, s.duels).padStart(4)}  avgT ${(s.turns / Math.max(1, s.duels)).toFixed(1).padStart(5)}  deckout ${pct(s.deckOuts, s.duels).padStart(4)}  20+turns ${pct(s.long, s.duels).padStart(4)}  unfinished ${s.unfinished}  skillHarm ${s.skillSelfHarm}  equipFoe ${s.equipOnFoe}  costBurn ${s.costForBurn}  suicide ${s.suicideAttacks}/${s.attacks}`;
}

/** `level`: one difficulty for every duelist, or 'road' for the Millennium Road's own (by chapter, bosses one step up). */
export function runBench(perPair: number, level: Tactics['level'] | 'road' | undefined, chapters = CHAPTERS.length, log = true) {
  const starters = STARTERS.map((s) => deckFromStarter(s));
  const total = newStats();
  for (const ch of CHAPTERS.slice(0, chapters)) {
    const st = newStats();
    for (const node of ch.nodes) {
      const d = deckOf(node.duelist);
      for (let i = 0; i < perPair * starters.length; i++) {
        const s = starters[i % starters.length];
        benchDuel({ main: s.main, extra: s.extra, skill: s.skill, t: DEFAULT_TACTICS }, { ...d, t: { ...DEFAULT_TACTICS, level: level === 'road' ? campaignDifficulty(ch.n, node.boss) : level } }, 7000 + i * 31 + ch.n * 1000, st);
      }
    }
    if (log) console.log(line(`ch${ch.n} ${ch.title.slice(0, 16)}`, st));
    for (const k of Object.keys(total) as (keyof BenchStats)[]) total[k] += st[k];
  }
  if (log) console.log(line('TOTAL', total));
  return total;
}

if (process.argv[1]?.endsWith('aibench.ts')) {
  const per = Number(process.argv[2] ?? 2);
  const lv = process.argv[3];
  const levels = lv === 'all' ? (['easy', 'normal', 'hard'] as const) : [lv as Tactics['level'] | 'road'];
  for (const l of levels) {
    console.log(`--- level ${l ?? 'default'} ---`);
    const t0 = Date.now();
    runBench(per, l);
    console.log(`(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}
