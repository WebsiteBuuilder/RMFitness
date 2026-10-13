// Every card action in a Speed Duel reaches the screen as a cinematic cue: summons (with their
// method), Spell/Trap/monster activations, triggered effects, Skills, cards leaving, LP gains and
// effect draws. Plays random duels through toCues and fails on anything that resolved silently.
// Run: npx tsx tests/art-coverage.test.ts [games]   (the full report: npx tsx scripts/art-coverage.ts)
import { Engine } from '../src/eds/engine';
import type { EngineEvent, Pid } from '../src/eds/types';
import { memoField, toCues, weight, type Cue } from '../src/art/cues';
import { runCoverage, summary, type Tally } from './artcoverage';
import { DB } from './speedkit';

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};

// ---------- the mapping, event by event ----------
const e = new Engine(DB);
const deck = Array.from({ length: 20 }, () => 'Blue-Eyes White Dragon');
e.apply({ type: 'START', first: 0, seed: 5, names: ['A', 'B'], decks: [deck, deck], fusions: [['Blue-Eyes Ultimate Dragon'], []], mode: 'speed', skills: [null, null] });
const ps = e.player(0);
const fc = { ...ps.hand[0], pos: 'atk', faceUp: true, atkMod: 0, defMod: 0, equips: [], placedTurn: 1 } as any;
ps.hand.splice(0, 1);
ps.mz[0] = fc;
const memo = memoField(e.state, 0, null);
let seq = 1000;
const ev = (kind: string, x: Partial<EngineEvent> = {}): EngineEvent => ({ kind, ...x, seq: ++seq });
const cues = (evs: EngineEvent[]): Cue[] => toCues(evs, e.state, 0, null, memo);
const one = cues([ev('summon', { uid: fc.uid, player: 0, how: 'fusion' })])[0];
ok(one?.kind === 'summon' && one.how === 'fusion' && one.special, 'a Fusion Summon carries its method (and counts as special)');
const trib = cues([ev('summon', { uid: fc.uid, player: 0, how: 'tribute' })])[0];
ok(trib?.kind === 'summon' && trib.how === 'tribute' && !trib.special, 'a Tribute Summon is not special');
ok(cues([ev('heal', { player: 1, amount: 500 })])[0]?.kind === 'heal', 'LP gains become heal cues');
const draws = cues([ev('draw', { uid: ps.hand[0].uid, player: 0, effect: true }), ev('draw', { uid: ps.hand[1].uid, player: 0, effect: true })]);
ok(draws.length === 1 && draws[0].kind === 'draw' && draws[0].count === 2, 'effect draws in a row are one draw cue');
ok(cues([ev('draw', { uid: ps.hand[0].uid, player: 0 })]).length === 0, 'the normal draw makes no cue');
// the monster is banished: it is no longer on the field, but the memo remembers where it stood
ps.mz[0] = null;
ps.removed.push(fc);
const ban = cues([ev('to-gy', { uid: fc.uid, player: 0, zone: 'mz', to: 'banish' })]);
ok(ban.length === 1 && ban[0].kind === 'leave' && ban[0].to === 'banish', 'a banished field monster leaves (not destroyed)');
ok(cues([ev('to-hand', { uid: ps.deck[0].uid, player: 0, zone: 'deck', to: 'hand' })])[0]?.kind === 'leave', 'a search from the Deck is shown');
ok(cues([ev('to-hand', { uid: ps.hand[0].uid, player: 0, zone: 'hand', to: 'deck' })]).length === 0, 'a hand card shuffled into the Deck stays quiet');
const hidden = cues([ev('to-hand', { uid: ps.hand[0].uid, player: 1 as Pid, zone: 'sz', to: 'hand', down: true })])[0];
ok(hidden?.kind === 'leave', 'a Set card returned to the hand leaves');
ok(weight({ kind: 'heal', player: 0, amount: 1 }) < weight({ kind: 'leave', card: fc, to: 'hand' }) && weight({ kind: 'leave', card: fc, to: 'hand' }) < weight({ kind: 'summon', card: fc, special: false }), 'backlog weights: heal/draw light, leave medium');

// ---------- random duels: nothing resolves silently ----------
const GAMES = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 18);
const t0 = Date.now();
const cov = runCoverage(GAMES, 11);
ok(cov.fails.length === 0, `${GAMES} random Speed Duels play to the end${cov.fails.length ? ': ' + cov.fails[0] : ''}`);
const check = (label: string, m: Map<string, Tally>) => {
  const s = summary(m);
  ok(s.silent.length === 0, `${label}: ${s.seen} cards, every one with a cue every time${s.silent.length ? ` (silent: ${s.silent.join(', ')})` : ''}`);
};
for (const [how, m] of cov.summons) check(`summons (${how})`, m);
for (const [k, m] of cov.activations) check(`${k} activations`, m);
for (const [k, m] of cov.effects) check(`${k} effects at work`, m);
check('Skills', cov.skills);
const moves = [...cov.moves].filter(([, t]) => t.cued < t.seen);
ok(moves.length === 0, `cards leaving, LP gains and effect draws all have cues${moves.length ? ` (missing: ${moves.map(([k]) => k).join(', ')})` : ''}`);
ok(cov.silentActions.size === 0, `every summon, activation and Skill use made at least one cue${cov.silentActions.size ? ` (silent: ${[...cov.silentActions.keys()].join(', ')})` : ''}`);
ok(cov.lostEvents === 0, `no batch outgrew the engine's event list${cov.lostEvents ? ` (${cov.lostWhere[0]})` : ''}`);
ok(cov.activations.size >= 3 && cov.summons.size >= 3 && cov.skills.size > 5, 'the duels exercised spells, traps, monster effects, summons and Skills');
console.log(`(${Date.now() - t0} ms)`);

if (fails) {
  console.log(`\n${fails} failure(s)`);
  process.exit(1);
}
console.log('\nall art coverage tests passed');
