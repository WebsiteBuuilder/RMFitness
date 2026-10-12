// Swords of Revealing Light and Lightforce Sword, step by step, in both games.
// Swords must stay on the field, flip the opponent's monsters and stop their attacks for
// exactly 3 of their turns. Lightforce Sword must banish a card from their hand and give it
// back at their 4th Standby Phase. Run: npx tsx tests/swords.test.ts
import { DB } from './speedkit';
import { Engine } from '../src/eds/engine';
import type { Action, GameMode, Pid } from '../src/eds/types';

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) failures++;
};

function duel(mode: GameMode, first: Pid, mine: string, theirs: string) {
  const e = new Engine(DB);
  e.apply({ type: 'START', first, seed: 3, names: ['A', 'B'], decks: [Array(40).fill(mine), Array(40).fill(theirs)], fusions: [[], []], mode, skills: [null, null] });
  /** Answers every prompt: no to yes/no, pass on responses, the first options on selects. */
  const settle = () => {
    for (let i = 0; i < 30 && e.state.prompt; i++) {
      const pr = e.state.prompt;
      const a: Action = pr.kind === 'yesno' ? { type: 'NO', player: pr.player } : pr.kind === 'response' ? { type: 'PASS', player: pr.player } : { type: 'CHOOSE', player: pr.player, picks: Array.from({ length: Math.max(1, pr.min) }, (_, k) => k) };
      e.apply(a);
    }
  };
  const step = (a: Action) => (e.apply(a), settle());
  /** Plays out the current player's turn. */
  const endTurn = () => {
    const p = e.state.turnPlayer;
    for (let g = 0; g < 12 && e.state.turnPlayer === p && e.state.winner === null; g++) step({ type: 'NEXT_PHASE', player: p });
  };
  return { e, step, endTurn, settle };
}

for (const mode of ['eds', 'speed'] as GameMode[]) {
  // ---------- Swords of Revealing Light ----------
  {
    const { e, step, endTurn } = duel(mode, 1, 'Swords of Revealing Light', 'Gemini Elf');
    const A = e.player(0);
    const B = e.player(1);
    step({ type: 'SUMMON', player: 1, uid: B.hand[0].uid, zone: 0, pos: 'def', faceUp: false });
    endTurn();
    step({ type: 'ACTIVATE', player: 0, uid: A.hand[0].uid, zone: 0 });
    const swords = () => [...A.sz].find((z) => z?.name === 'Swords of Revealing Light');
    check(!!swords(), `${mode}: Swords of Revealing Light stays on the field after it resolves`);
    check(!!B.mz[0]?.faceUp, `${mode}: Swords flips the opponent's face-down monster`);
    const blocked: boolean[] = [];
    for (let t = 1; t <= 4; t++) {
      endTurn();
      const c = B.hand.find((x) => e.canNormalSummon(1, x));
      if (c) step({ type: 'SUMMON', player: 1, uid: c.uid, zone: B.mz.findIndex((z) => !z), pos: 'atk', faceUp: true });
      for (let g = 0; g < 6 && e.state.phase !== 'BP' && e.state.turnPlayer === 1; g++) step({ type: 'NEXT_PHASE', player: 1 });
      blocked.push(!e.monsters(1).some((m) => e.canAttackWith(1, m)));
      endTurn();
      if (t === 3) check(!swords() && A.gy.some((c) => c.name === 'Swords of Revealing Light'), `${mode}: Swords goes to the GY after the opponent's 3rd turn`);
    }
    check(blocked[0] && blocked[1] && blocked[2], `${mode}: the opponent cannot attack for 3 of their turns`);
    check(!blocked[3], `${mode}: the opponent can attack again on their 4th turn`);
  }
  // ---------- Lightforce Sword ----------
  {
    const { e, step, endTurn, settle } = duel(mode, 0, 'Lightforce Sword', 'Gemini Elf');
    const A = e.player(0);
    const B = e.player(1);
    step({ type: 'SET_ST', player: 0, uid: A.hand[0].uid, zone: 0 });
    endTurn();
    const before = B.hand.length;
    e.apply({ type: 'SUMMON', player: 1, uid: B.hand[0].uid, zone: 0, pos: 'atk', faceUp: true });
    const pr = e.state.prompt;
    check(pr?.kind === 'response' && pr.player === 0 && pr.options.some((o) => o.label.includes('Lightforce Sword')), `${mode}: Lightforce Sword is offered on the opponent's turn`);
    if (pr?.kind === 'response') e.apply({ type: 'CHOOSE', player: 0, picks: [pr.options.findIndex((o) => o.label.includes('Lightforce Sword'))] });
    settle();
    check(B.removed.length === 1 && B.hand.length === before - 2, `${mode}: Lightforce Sword banishes a card from the opponent's hand`);
    const back: number[] = [];
    for (let k = 0; k < 4; k++) {
      endTurn();
      endTurn();
      back.push(B.removed.length);
    }
    check(back[0] === 1 && back[1] === 1 && back[2] === 1 && back[3] === 0, `${mode}: the banished card returns at the opponent's 4th Standby Phase`);
  }
}
console.log(failures ? `${failures} FAILURES` : 'ALL OK');
if (failures) process.exit(1);
