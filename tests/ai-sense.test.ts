// The computer only plays effects that help: no Trap sprung for nothing, no removal on its own cards,
// answers judged on a rebuilt copy of the duel, and a benchmark of whole duels with few wasted plays.
// Run: npx tsx tests/ai-sense.test.ts
import { DB as KIT } from './speedkit';
import { DB } from '../src/eds/db';
import { Engine } from '../src/eds/engine';
import { aiAction } from '../src/eds/ai';
import { rebuild } from '../src/eds/aiEval';
import { DEFAULT_TACTICS, type Tactics } from '../src/eds/tactics';
import type { Action, Pid } from '../src/eds/types';
import { runSense, senseLine } from './aisense';

for (const [k, v] of KIT) DB.set(k, v);

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};
const FILL = 'Celtic Guardian';
const deck = (top: string[]) => [...top, ...Array(30 - top.length).fill(FILL)];

/** A duel played only through actions (so the computer can rebuild it), decks in the given order. */
function duel(d0: string[], d1: string[]): Engine {
  const e = new Engine(DB);
  e.shuffle = <T,>(a: T[]) => a.slice();
  e.apply({ type: 'START', first: 0, seed: 7, names: ['A', 'B'], decks: [deck(d0), deck(d1)], fusions: [[], []], mode: 'speed', skills: [null, null] });
  return e;
}

/** Player 0's move, then every question answered (the computer's by aiAction, player 0's by passing); the computer's moves are returned. */
function play(e: Engine, a: Action | null, t: Tactics): Action[] {
  const cpu: Action[] = [];
  if (a) e.apply(a);
  for (let i = 0; i < 200 && e.state.prompt && e.state.winner === null; i++) {
    const pr = e.state.prompt;
    let x: Action | null;
    if (pr.player === 1) (x = aiAction(e, 1, t)), x && cpu.push(x);
    else x = pr.kind === 'yesno' ? { type: 'NO', player: 0 } : pr.kind === 'response' ? { type: 'PASS', player: 0 } : { type: 'CHOOSE', player: 0, picks: [0] };
    if (!x) break;
    e.apply(x);
  }
  return cpu;
}

/** The computer's whole turn. */
function cpuTurn(e: Engine, t: Tactics): Action[] {
  const turn = e.state.turn;
  const acts: Action[] = [];
  for (let i = 0; i < 200 && e.state.winner === null && e.state.turn === turn; i++) {
    const pr = e.state.prompt;
    const p = (pr ? pr.player : e.state.turnPlayer) as Pid;
    const a: Action | null = p === 1 ? aiAction(e, 1, t) : pr?.kind === 'yesno' ? { type: 'NO', player: 0 } : pr?.kind === 'response' ? { type: 'PASS', player: 0 } : pr ? { type: 'CHOOSE', player: 0, picks: [0] } : null;
    if (!a) break;
    if (p === 1) acts.push(a);
    e.apply(a);
  }
  return acts;
}

const sprung = (e: Engine, acts: Action[], name: string) => acts.some((a) => a.type === 'CHOOSE' && e.state.log.some((l) => l.text === `B activates ${name}`));
const handUid = (e: Engine, p: Pid, name: string) => e.player(p).hand.find((c) => c.name === name)!.uid;

for (const level of ['easy', 'normal', 'hard'] as const) {
  const t: Tactics = { ...DEFAULT_TACTICS, level };
  const e = duel(['Celtic Guardian', 'Gemini Elf', 'Axe Raider', 'Celtic Guardian', 'Gemini Elf'], ['Waboku', 'Mystical Space Typhoon', 'Celtic Guardian', 'Celtic Guardian']);
  // Turn 1: the player summons and passes.
  play(e, { type: 'SUMMON', player: 0, uid: handUid(e, 0, 'Celtic Guardian'), zone: 0, pos: 'atk', faceUp: true }, t);
  play(e, { type: 'END_TURN', player: 0 }, t);
  // Turn 2: the computer sets its Spell/Traps and plays its monster.
  cpuTurn(e, t);
  const set = e.spells(1).map((c) => c.name);
  check(set.includes('Waboku') && set.includes('Mystical Space Typhoon'), `${level}: the computer Sets Waboku and Mystical Space Typhoon (${set.join(', ')})`);
  // Turn 3: a Summon is no reason for Waboku, and Typhoon has nothing of the player's to hit.
  check(e.state.turnPlayer === 0, `${level}: back to the player's turn`);
  const onSummon = play(e, { type: 'SUMMON', player: 0, uid: handUid(e, 0, 'Gemini Elf'), zone: 1, pos: 'atk', faceUp: true }, t);
  check(!e.state.log.some((l) => /B activates (Waboku|Mystical Space Typhoon)/.test(l.text)), `${level}: nothing is sprung on a plain Summon (${onSummon.map((a) => a.type).join(',')})`);
  check(e.spells(1).length === 2, `${level}: both Set cards are still there`);
  // The player attacks its monster with a stronger one: now Waboku is worth it (Easy may miss it).
  const mine = e.monsters(1).find((m) => m.faceUp && m.pos === 'atk');
  const elf = e.monsters(0).find((m) => m.name === 'Gemini Elf')!;
  if (mine) {
    play(e, { type: 'NEXT_PHASE', player: 0 }, t);
    play(e, { type: 'ATTACK', player: 0, uid: elf.uid, target: mine.uid }, t);
    if (level !== 'easy') check(e.state.log.some((l) => l.text === 'B activates Waboku'), `${level}: Waboku is sprung against the attack that would destroy its monster`);
  }
  check(!e.state.log.some((l) => /Mystical Space Typhoon destroys/.test(l.text)), `${level}: Mystical Space Typhoon never destroys its own card`);
  check(!sprung(e, onSummon, 'Waboku'), `${level}: the Summon window was passed`);
}

// A duel stopped at a question is rebuilt by replaying it, landing on the same position.
{
  const e = duel(['Gemini Elf'], ['Trap Hole', 'Celtic Guardian']);
  play(e, { type: 'END_TURN', player: 0 }, DEFAULT_TACTICS);
  cpuTurn(e, DEFAULT_TACTICS);
  e.apply({ type: 'SUMMON', player: 0, uid: handUid(e, 0, 'Gemini Elf'), zone: 0, pos: 'atk', faceUp: true });
  const pr = e.state.prompt;
  check(pr?.kind === 'response' && pr.player === 1, 'the Summon opens a window for the computer');
  const copy = rebuild(e);
  check(copy && copy.state.prompt?.title === pr?.title && copy.player(1).hand.length === e.player(1).hand.length, 'the rebuilt copy waits at the same question');
  check(copy && copy.isCopy && copy.state.rngState !== e.state.rngState, 'the copy is a throwaway with its own dice');
  if (copy) {
    copy.apply({ type: 'CHOOSE', player: 1, picks: [0] });
    check(e.state.prompt?.title === pr?.title && e.monsters(0).length === 1, 'answering on the copy leaves the real duel alone');
  }
  const a = aiAction(e, 1);
  check(a?.type === 'CHOOSE', 'Trap Hole is sprung on a 1900 ATK Summon');
}

// Whole duels: hardly any play that leaves the computer worse off for nothing.
for (const [level, n, max] of [
  ['normal', 80, 4],
  ['hard', 60, 5],
  ['easy', 30, 5],
] as const) {
  const st = runSense(n, level, 'normal', 3);
  console.log('    ' + senseLine(level, st));
  const bad = (100 * (st.selfHit + st.waste)) / Math.max(1, st.moves);
  check(bad <= max, `${level}: ${bad.toFixed(1)}% of its effects hurt it or did nothing (at most ${max}%)`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall ok');
if (fails) process.exit(1);
