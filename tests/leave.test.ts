// Cards leaving the field without going to the GY (returned to the hand, banished):
// their equips go to the GY and their "when this card leaves the field" effects still run.
// Run: npx tsx tests/leave.test.ts
import { DB } from './speedkit';
import { Engine } from '../src/eds/engine';
import type { Action, FieldCard, Pid, Step } from '../src/eds/types';

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) failures++;
};

function duel(mine: string[]) {
  const e = new Engine(DB);
  const deck = Array.from({ length: 40 }, (_, i) => mine[i % mine.length]);
  e.apply({ type: 'START', first: 0, seed: 5, names: ['A', 'B'], decks: [deck, Array(40).fill('Gemini Elf')], fusions: [[], []], mode: 'speed', skills: [null, null] });
  const settle = () => {
    for (let i = 0; i < 30 && e.state.prompt; i++) {
      const pr = e.state.prompt;
      const a: Action = pr.kind === 'yesno' ? { type: 'YES', player: pr.player } : pr.kind === 'response' ? { type: 'PASS', player: pr.player } : { type: 'CHOOSE', player: pr.player, picks: Array.from({ length: Math.max(1, pr.min) }, (_, k) => k) };
      e.apply(a);
    }
  };
  const step = (a: Action) => (e.apply(a), settle());
  /** Runs an engine move the way a card effect would (inside an action). */
  const effect = (fn: () => void) => {
    (e as unknown as { run(g: Step): void }).run((function* (): Step {
      fn();
    })());
    settle();
  };
  return { e, step, effect };
}

const A = 0 as Pid;
for (const how of ['hand', 'banish'] as const) {
  const { e, step, effect } = duel(['Celtic Guardian', 'Axe of Despair']);
  const ps = e.player(A);
  const take = (name: string) => {
    const i = ps.deck.findIndex((c) => c.name === name);
    if (i >= 0 && !ps.hand.some((c) => c.name === name)) ps.hand.push(ps.deck.splice(i, 1)[0]);
    return ps.hand.find((c) => c.name === name)!;
  };
  step({ type: 'SUMMON', player: A, uid: take('Celtic Guardian').uid, zone: 0, pos: 'atk', faceUp: true });
  step({ type: 'ACTIVATE', player: A, uid: take('Axe of Despair').uid, zone: 0 });
  const m = ps.mz[0] as FieldCard;
  const axe = ps.sz.find((z) => z?.name === 'Axe of Despair');
  check(!!axe && m.equips.includes(axe.uid), `${how}: Axe of Despair is equipped`);
  effect(() => (how === 'hand' ? e.toHand(m.uid) : e.banish(m.uid)));
  check(!ps.sz.some((z) => z?.name === 'Axe of Despair') && ps.gy.some((c) => c.name === 'Axe of Despair'), `${how}: the equip goes to the GY when its monster ${how === 'hand' ? 'returns to the hand' : 'is banished'}`);
}
{
  const { e, step, effect } = duel(['Aegis of Gaia']);
  const ps = e.player(A);
  step({ type: 'SET_ST', player: A, uid: ps.hand.find((c) => c.name === 'Aegis of Gaia')!.uid, zone: 0 });
  const fc = ps.sz[0] as FieldCard;
  fc.faceUp = true;
  fc.active = true;
  const lp = ps.lp;
  effect(() => e.banish(fc.uid));
  check(ps.lp === lp - 3000, `Aegis of Gaia banished: its controller takes 3000 damage (${lp} -> ${ps.lp})`);
}
console.log(failures ? `${failures} FAILURES` : 'ALL OK');
if (failures) process.exit(1);
