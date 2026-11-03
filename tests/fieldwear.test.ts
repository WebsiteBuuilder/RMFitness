// Field wear: Monster Zones scorch where monsters were destroyed, worse with each one, for the
// rest of the duel (run: npx tsx tests/fieldwear.test.ts).
import { Engine } from '../src/eds/engine';
import { DB as APP_DB } from '../src/eds/db';
import type { FieldCard, Pid } from '../src/eds/types';
import { landed, landingAt, MAX_LOOK, newLanding, W, H, wearHit, wearHits, wearOf, wearStyle } from '../src/ui/fieldWearRules';
import { DB } from './speedkit';

for (const [k, v] of DB) APP_DB.set(k, v);

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};
const FILL = 'Celtic Guardian';

function settle(e: Engine) {
  for (let i = 0; i < 400 && e.state.prompt && e.state.winner === null; i++) {
    const pr = e.state.prompt;
    if (pr.kind === 'yesno') e.apply({ type: 'NO', player: pr.player });
    else if (pr.kind === 'response') e.apply({ type: 'PASS', player: pr.player });
    else e.apply({ type: 'CHOOSE', player: pr.player, picks: pr.options.map((_, j) => j).slice(0, Math.max(1, pr.min)) });
  }
}
function duel(mode: 'speed' | 'eds' = 'speed'): Engine {
  const e = new Engine(DB);
  e.shuffle = <T,>(a: T[]) => a.slice();
  const deck = [...Array(6).fill('Summoned Skull'), ...Array(34).fill(FILL)];
  e.apply({ type: 'START', first: 0, seed: 1, names: ['A', 'B'], decks: [deck, deck], fusions: [[], []], mode, skills: [null, null] } as any);
  settle(e);
  e.state.firstTurn = false;
  return e;
}
const run = (e: Engine, step: Generator<any, any, any>) => {
  (e as any).run(step);
  settle(e);
};
/** Puts a monster of `p` from the deck face-up into Monster Zone `z`. */
function put(e: Engine, p: Pid, name: string, z: number): FieldCard {
  const ps = e.player(p);
  const i = ps.deck.findIndex((c) => c.name === name);
  const [c] = ps.deck.splice(i, 1);
  const fc: FieldCard = { ...c, pos: 'atk', faceUp: true, placedTurn: -1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
  ps.mz[z] = fc;
  return fc;
}

// --- the engine counts destructions per zone
{
  const e = duel();
  check(wearOf(e.state, 0, 0) === 0 && wearOf(e.state, 1, 2) === 0, 'a new duel starts with clean zones');
  const a = put(e, 0, 'Summoned Skull', 1);
  const b = put(e, 1, FILL, 2);
  e.state.phase = 'BP';
  e.apply({ type: 'ATTACK', player: 0, uid: a.uid, target: b.uid });
  settle(e);
  check(!e.fieldCard(b.uid), 'the attack destroyed the defender');
  check(wearOf(e.state, 1, 2) === 1, 'destroyed by battle: its zone is worn once');
  check(wearOf(e.state, 0, 1) === 0, "the winner's zone is untouched");
  const c = put(e, 1, FILL, 2);
  run(e, e.destroy([c.uid]));
  check(wearOf(e.state, 1, 2) === 2, 'destroyed by a card effect in the same zone: worn twice (worse)');
  const d = put(e, 1, FILL, 2);
  run(e, e.sendToGrave(d.uid, 'tribute'));
  check(wearOf(e.state, 1, 2) === 2, 'a Tribute is not a destruction: no new mark');
  const f = put(e, 0, FILL, 4);
  run(e, e.destroy([f.uid]));
  check(wearOf(e.state, 0, 4) === 1 && wearOf(e.state, 0, 1) === 0, "each duelist's own zones keep their own count");
  // online and rejoin: the count travels with the state (JSON turns sparse slots into null)
  const copy = JSON.parse(JSON.stringify(e.state));
  check(wearOf(copy, 1, 2) === 2 && wearOf(copy, 1, 0) === 0 && wearOf(copy, 0, 4) === 1, 'the wear survives the trip to the other phone (JSON)');
  const next = duel();
  check(wearOf(next.state, 1, 2) === 0, 'the next duel starts clean again');
}
{
  const e = duel('eds');
  const c = put(e, 1, FILL, 0);
  run(e, e.destroy([c.uid]));
  check(wearOf(e.state, 1, 0) === 0, 'the classic 8000 LP game keeps its plain board (Speed Duels only)');
}

// --- the marks: the same every time, and worse with each destruction
const inBox = (d: string) => [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].every(([, x, y]) => +x >= 0 && +x <= W && +y >= 0 && +y <= H);
{
  const one = wearHits(0, 2, 1);
  const two = wearHits(0, 2, 2);
  const three = wearHits(0, 2, 3);
  check(JSON.stringify(wearHits(0, 2, 2)) === JSON.stringify(two), 'the same zone draws the same marks every render');
  check(JSON.stringify(wearHits(1, 2, 1)) !== JSON.stringify(one), "the opponent's matching zone scars differently");
  check(one.length === 1 && two.length === 2 && three.length === 3 && wearHits(0, 2, 7).length === MAX_LOOK, 'one mark per destruction, up to the worst look');
  check(JSON.stringify(two[0]) === JSON.stringify(one[0]), 'a second destruction adds to the first marks (they stay)');
  check(two[1].cracks.length > one[0].cracks.length && two[1].r > one[0].r, 'the second hit is bigger, with more cracks');
  check(three[2].chips.length >= 4 && one[0].chips.length === 0 && two[1].chips.length === 0, 'the third hit shatters the slab (chipped pieces)');
  const all = three.flatMap((h) => [...h.cracks.map((c) => c.d), ...h.chips.flatMap((c) => [c.face, c.shadow])]);
  check(all.every(inBox), 'cracks and chips stay inside the zone');
  const grid = wearHit(5, 2, true);
  const straight = grid.cracks.every((c) => {
    const pts = [...c.d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) => [+x, +y]);
    return pts.slice(1).every(([x, y], i) => {
      const [px, py] = pts[i];
      if (Math.hypot(x - px, y - py) < 0.6) return true; // (pinned at the zone's edge)
      const a = Math.atan2(y - py, x - px) / (Math.PI / 4);
      return Math.abs(a - Math.round(a)) < 0.12 || x <= 1.05 || x >= W - 1.05 || y <= 1.05 || y >= H - 1.05;
    });
  });
  check(straight, 'a machine floor (Tech) cracks along straight seams');
  check(wearStyle(null) === 'plain' && wearStyle('volcano') === 'volcano', "the marks follow the duelist's own landscape");
}

// --- a mark lands (flash and cooling) only when it appears in front of you
{
  const l = newLanding();
  check(landingAt(l, 2, false) === 0, 'marks already there when the board appears (rejoin, hand-over) do not land again');
  check(landingAt(l, 2, false) === 0, 'a re-render does not replay anything');
  check(landingAt(l, 3, false) === 3, 'a new destruction lands');
  check(landingAt(l, 3, false) === 3, '...and keeps landing through re-renders until it is done');
  landed(l, 3);
  check(landingAt(l, 3, false) === 0, 'once it has cooled, nothing is left running');
  check(landingAt(l, 4, false) === 4, 'a 4th destruction re-lights the worst mark');
  check(landingAt(l, 1, false) === 0 && landingAt(l, 2, false) === 2, 'a replay stepping back clears it; stepping on lands again');
  const q = newLanding();
  landingAt(q, 0, true);
  check(landingAt(q, 1, true) === 0, 'reduced motion: marks just appear');
}

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
console.log('\nall field wear checks passed');
