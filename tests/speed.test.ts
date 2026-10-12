// Speed Duel rules (run: npx tsx tests/speed.test.ts)
import { Engine } from '../src/eds/engine';
import type { Pid } from '../src/eds/types';
import { DB, SPEED } from './speedkit';

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};
const vanilla = SPEED.filter((c) => c.sub === 'Normal' && c.kind === 'monster' && (c.level ?? 0) <= 4).map((c) => c.name);
const deck = (n = 20) => Array.from({ length: n }, (_, i) => vanilla[i % vanilla.length]);
const start = (first: Pid = 0) => {
  const e = new Engine(DB);
  e.apply({ type: 'START', first, seed: 1, names: ['A', 'B'], decks: [deck(), deck()], fusions: [[], []], mode: 'speed', skills: [null, null] });
  return e;
};

const e = start(0);
ok(e.player(0).lp === 4000 && e.player(1).lp === 4000, 'both players start at 4000 LP');
ok(e.player(0).hand.length === 4 && e.player(1).hand.length === 4, 'opening hand is 4 and the first player does not draw');
ok(e.player(0).mz.length === 3 && e.player(0).sz.length === 3, '3 Monster Zones and 3 Spell/Trap Zones');
ok(e.state.phase === 'M1', 'turn 1 reaches Main Phase 1');
e.apply({ type: 'NEXT_PHASE', player: 0 });
ok(e.state.phase === 'EP' || e.state.turnPlayer === 1, 'no Battle Phase on the first turn');
ok(e.state.turnPlayer === 1 && e.player(1).hand.length === 5, 'second player draws on their turn');
// Summon 3, a 4th has no zone.
const f = start(0);
for (let i = 0; i < 3; i++) {
  const c = f.player(0).hand[0];
  f.player(0).normalSummoned = false;
  f.apply({ type: 'SUMMON', player: 0, uid: c.uid, zone: i, pos: 'atk', faceUp: true });
}
ok(f.monsters(0).length === 3, 'three monsters fill the field');
f.player(0).normalSummoned = false;
ok(!f.canNormalSummon(0, f.player(0).hand[0]), 'a fourth monster has no zone');
// No Main Phase 2: BP -> EP.
f.apply({ type: 'END_TURN', player: 0 });
f.apply({ type: 'NEXT_PHASE', player: 1 });
ok(f.state.phase === 'BP', 'turn 2 goes to the Battle Phase');
f.apply({ type: 'NEXT_PHASE', player: 1 });
ok(f.state.phase !== 'M2', 'Battle Phase skips Main Phase 2');
ok(!f.phases().includes('M2'), 'phase list has no Main Phase 2');
// EDS duels are untouched.
const g = new Engine(DB);
g.apply({ type: 'START', first: 0, seed: 1, names: ['A', 'B'], decks: [deck(40), deck(40)], fusions: [[], []] });
ok(g.player(0).lp === 8000 && g.player(0).mz.length === 5 && g.player(0).hand.length === 6, 'EDS duels keep 8000 LP, 5 zones and the first-turn draw');
console.log(fails ? `${fails} FAILURES` : 'ALL OK');
process.exit(fails ? 1 : 0);
