// Speed Duel card scripts of Xyz, Synchro and Link Summons (run: npx tsx tests/extra.test.ts)
// One or more targeted checks per scripted card: its main effect really happens in a duel.
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};
const FILL = 'Celtic Guardian';

// ---------- duel kit ----------
type Ans = 'yes' | 'no' | 'pass' | { pick: string[] } | { respond: string };
/** Answers every pending prompt: planned answers first (in order), then pass / no / the first options. Returns how many planned answers were not used. */
function settle(e: Engine, ...ans: Ans[]): number {
  const q = [...ans];
  for (let i = 0; i < 400 && e.state.prompt && e.state.winner === null; i++) {
    const pr = e.state.prompt;
    const h = q[0];
    if (pr.kind === 'yesno') {
      if (h === 'yes' || h === 'no') {
        q.shift();
        e.apply({ type: h === 'yes' ? 'YES' : 'NO', player: pr.player });
      } else e.apply({ type: 'NO', player: pr.player });
    } else if (pr.kind === 'response') {
      if (h && typeof h === 'object' && 'respond' in h) {
        const k = pr.options.findIndex((o) => o.label.startsWith(h.respond));
        if (k >= 0) {
          q.shift();
          e.apply({ type: 'CHOOSE', player: pr.player, picks: [k] });
          continue;
        }
      }
      if (h === 'pass') q.shift();
      e.apply({ type: 'PASS', player: pr.player });
    } else if (h && typeof h === 'object' && 'pick' in h) {
      q.shift();
      const picks: number[] = [];
      for (const l of h.pick) {
        const k = pr.options.findIndex((o, j) => o.label === l && !picks.includes(j));
        if (k >= 0) picks.push(k);
      }
      e.apply({ type: 'CHOOSE', player: pr.player, picks });
    } else e.apply({ type: 'CHOOSE', player: pr.player, picks: pr.options.map((_, j) => j).slice(0, Math.max(1, pr.min)) });
  }
  return q.length;
}
function duel(d0: string[], d1: string[] = [], x0: string[] = [], x1: string[] = [], first: Pid = 0): Engine {
  const e = new Engine(DB);
  e.shuffle = <T,>(a: T[]) => a.slice();
  const pad = (d: string[]) => [...Array(4).fill(FILL), ...d, ...Array(Math.max(0, 30 - d.length)).fill(FILL)];
  e.apply({ type: 'START', first, seed: 1, names: ['A', 'B'], decks: [pad(d0), pad(d1)], fusions: [x0, x1], mode: 'speed', skills: [null, null] });
  settle(e);
  return e;
}
const run = (e: Engine, step: Generator<any, any, any>, ...ans: Ans[]) => {
  (e as any).run(step);
  return settle(e, ...ans);
};
const zone = (e: Engine, c: Card | null | undefined) => (c ? e.find(c.uid)?.loc.zone : undefined);
/** Moves a card of `p` (deck, GY, banished or hand) into the hand. */
function grab(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.hand, ...ps.deck, ...ps.gy, ...ps.removed].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  if (zone(e, c) !== 'hand') e.toHandOf(c.uid, p);
  return c;
}
/** Special Summons a card of `p` from wherever it is (Extra Deck included). Null when it did not arrive. */
function place(e: Engine, p: Pid, name: string, pos: Pos = 'atk', faceUp = true, ...ans: Ans[]): FieldCard | null {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.gy, ...ps.fusion, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.specialSummon(c.uid, p, pos, faceUp), ...ans);
  const f = e.fieldCard(c.uid);
  if (f && !faceUp) f.placedTurn = -1;
  return f;
}

const proc = (e: Engine, p: Pid, name: string, ...ans: Ans[]) => {
  const c = e.player(p).fusion.find((x) => x.name === name)!;
  const can = e.canSpecialProc(p, c);
  if (can) {
    e.apply({ type: 'SPECIAL', player: p, uid: c.uid });
    settle(e, ...ans);
  }
  return { can, fc: e.fieldCard(c.uid) };
};
const toMain = (e: Engine) => {
  while (e.state.phase !== 'M1') (e.apply({ type: 'NEXT_PHASE', player: e.state.turnPlayer }), settle(e));
};

// Xyz: 2 Level 4 monsters -> Number 103: Ragnazero, with both as Xyz Materials.
{
  const e = duel([], [], ['Number 103: Ragnazero']);
  toMain(e);
  const x = e.player(0).fusion[0];
  check(!e.canSpecialProc(0, x), 'Xyz: not summonable without materials');
  check(e.info('Number 103: Ragnazero').rank === 4 && e.info('Number 103: Ragnazero').level === undefined, 'Xyz: has Rank 4 and no Level');
  place(e, 0, FILL);
  place(e, 0, FILL);
  const { can, fc } = proc(e, 0, 'Number 103: Ragnazero');
  check(can && !!fc, 'Xyz: summoned with 2 Level 4 monsters');
  check(fc?.mats?.length === 2 && e.monsters(0).length === 1, 'Xyz: both monsters became Xyz Materials');
  check(fc?.tags?.xyzS === 1 && fc?.tags?.ssExtra === 1, 'Xyz: marked as Xyz Summoned from the Extra Deck');
  const gy0 = e.player(0).gy.length;
  const ok = (() => {
    let r = false;
    const g = (function* () {
      r = yield* e.detachMats(fc!, 1, 0);
    })();
    run(e, g);
    return r;
  })();
  check(ok && fc!.mats!.length === 1 && e.player(0).gy.length === gy0 + 1, 'Xyz: detaching 1 material sends it to the GY');
  run(e, e.destroy([fc!.uid]));
  check(e.player(0).gy.length === gy0 + 3, 'Xyz: destroyed, it and its last material go to the GY');
  e.toHand(e.player(0).gy.find((c) => c.name === 'Number 103: Ragnazero')!.uid);
  check(e.player(0).fusion.some((c) => c.name === 'Number 103: Ragnazero'), 'Xyz: returned to the hand goes to the Extra Deck instead');
}
// Xyz material filter: "2 Level 4 Warrior-Type monsters" (Heroic Champion - Excalibur); Celtic Guardian is a Warrior.
{
  const e = duel(['Gagagigo'], [], ['Heroic Champion - Excalibur']);
  toMain(e);
  place(e, 0, FILL);
  place(e, 0, 'Gagagigo');
  check(!proc(e, 0, 'Heroic Champion - Excalibur').can, 'Xyz: a Reptile does not count as a Warrior-Type material');
}
// Synchro: Lady of the Lake (Tuner, Level 1) + a Level 3 non-Tuner -> Hi-Speedroid Puzzle (Level 4).
{
  const e = duel(['Lady of the Lake', 'Evoltile Lagosucho'], [], ['Hi-Speedroid Puzzle']);
  toMain(e);
  place(e, 0, 'Lady of the Lake');
  place(e, 0, FILL);
  check(!proc(e, 0, 'Hi-Speedroid Puzzle').can, 'Synchro: Levels must add up exactly (1 + 4 is not 4)');
  place(e, 0, 'Evoltile Lagosucho');
  const { can, fc } = proc(e, 0, 'Hi-Speedroid Puzzle');
  check(can && !!fc && fc.tags?.synS === 1, 'Synchro: summoned with Tuner + Level 3');
  check(e.player(0).gy.some((c) => c.name === 'Lady of the Lake') && e.player(0).gy.some((c) => c.name === 'Evoltile Lagosucho') && e.monsters(0).length === 2, 'Synchro: materials went to the GY, the other monster stayed');
}
// Link: 2+ Reptile monsters -> Cosmic Slicer Zer'oll.
{
  const e = duel(['Gagagigo', 'Gale Lizard'], [], ["Cosmic Slicer Zer'oll"]);
  toMain(e);
  place(e, 0, 'Gagagigo');
  check(!proc(e, 0, "Cosmic Slicer Zer'oll").can, 'Link: 1 Reptile is not enough');
  place(e, 0, 'Gale Lizard');
  const { can, fc } = proc(e, 0, "Cosmic Slicer Zer'oll");
  check(can && !!fc && fc.tags?.linkS === 1 && e.monsters(0).length === 1, 'Link: summoned with 2 Reptiles');
}
// The opponent's turn: no Extra Deck summons.
{
  const e = duel([], [], [], ['Number 103: Ragnazero'], 0);
  toMain(e);
  place(e, 1, FILL);
  place(e, 1, FILL);
  check(!e.canSpecialProc(1, e.player(1).fusion[0]), "Xyz: not during the opponent's turn");
}

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
