// Engine checks with a small hand-made card database (run: npx tsx tests/engine.test.ts)
import { Engine } from '../src/eds/engine';
import type { CardInfo, Pid } from '../src/eds/types';

const M = (name: string, atk: number, def: number, level: number, sub = 'Normal'): CardInfo => ({ id: 0, name, kind: 'monster', sub, atk, def, level, desc: '' });
const S = (name: string, sub = 'Normal'): CardInfo => ({ id: 0, name, kind: 'spell', sub, desc: '' });
const T = (name: string, sub = 'Normal'): CardInfo => ({ id: 0, name, kind: 'trap', sub, desc: '' });
const DB = new Map<string, CardInfo>(
  [
    M('Summoned Skull', 2500, 1200, 6),
    M('Mystical Elf', 800, 2000, 4),
    M('Celtic Guardian', 1400, 1200, 4),
    M('Battle Ox', 1700, 1000, 4),
    M('Rogue Doll', 1600, 1000, 4),
    M('Aqua Madoor', 1200, 2000, 4),
    M('Man-Eater Bug', 450, 600, 2, 'Effect'),
    M('Curse of Dragon', 2000, 1500, 5),
    S('Dark Hole'),
    S('Pot of Greed'),
    S('Monster Reborn'),
    S('Change of Heart'),
    S('Swords of Revealing Light'),
    S('Black Pendant', 'Equip'),
    T('Trap Hole'),
    T('Mirror Force'),
    T('Magic Jammer', 'Counter'),
  ].map((c) => [c.name, c]),
);

let failures = 0;
function check(cond: unknown, msg: string) {
  if (!cond) {
    failures++;
    console.log('FAIL:', msg);
  } else console.log('ok  :', msg);
}

function fresh(deck0: string[], deck1: string[]) {
  const e = new Engine(DB);
  e.shuffle = <T,>(x: T[]) => x.slice(); // keep deck order for the test
  e.apply({ type: 'START', first: 0, seed: 1, names: ['A', 'B'], decks: [deck0, deck1], fusions: [[], []] });
  return e;
}
const hand = (e: Engine, p: Pid, name: string) => e.state.players[p].hand.find((c) => c.name === name)!;
const mz = (e: Engine, p: Pid, i: number) => e.state.players[p].mz[i]!;
const filler = (n: number) => Array(n).fill('Celtic Guardian');

// 1. Summon, Trap Hole, battle, end turn draw.
{
  const e = fresh(['Battle Ox', 'Celtic Guardian', 'Pot of Greed', 'Summoned Skull', 'Mystical Elf', 'Rogue Doll', ...filler(20)], ['Trap Hole', 'Aqua Madoor', 'Mirror Force', 'Dark Hole', 'Rogue Doll', 'Celtic Guardian', ...filler(20)]);
  const s = e.state;
  check(s.started && s.turnPlayer === 0 && s.phase === 'M1', 'duel starts in Main Phase 1 for player 0');
  check(s.players[0].hand.length === 6 && s.players[1].hand.length === 5, 'first player draws 6, second 5');
  e.apply({ type: 'SUMMON', player: 0, uid: hand(e, 0, 'Battle Ox').uid, zone: 2, pos: 'atk', faceUp: true });
  check(mz(e, 0, 2)?.name === 'Battle Ox' && s.prompt === null, 'Battle Ox summoned to zone 2');
  e.apply({ type: 'SUMMON', player: 0, uid: hand(e, 0, 'Celtic Guardian').uid, zone: 0, pos: 'atk', faceUp: true });
  check(s.players[0].mz[0] === null, 'second Normal Summon refused');
  e.apply({ type: 'ACTIVATE', player: 0, uid: hand(e, 0, 'Pot of Greed').uid, zone: 0 });
  check(s.players[0].hand.length === 6 && s.players[0].gy.some((c) => c.name === 'Pot of Greed'), 'Pot of Greed draws 2 and goes to GY');
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  check(s.phase === 'EP' || s.turnPlayer === 1, 'no Battle Phase on the first turn');
  if (s.turnPlayer === 0) e.apply({ type: 'END_TURN', player: 0 });
  check(s.turnPlayer === 1 && s.turn === 2 && s.players[1].hand.length === 6, 'turn passes and B draws');
  // B sets Trap Hole and Mirror Force, summons Aqua Madoor
  e.apply({ type: 'SET_ST', player: 1, uid: hand(e, 1, 'Trap Hole').uid, zone: 0 });
  e.apply({ type: 'SET_ST', player: 1, uid: hand(e, 1, 'Mirror Force').uid, zone: 1 });
  check(s.players[1].sz[0]?.name === 'Trap Hole' && !s.players[1].sz[0]?.faceUp, 'Trap Hole set face-down');
  e.apply({ type: 'SUMMON', player: 1, uid: hand(e, 1, 'Aqua Madoor').uid, zone: 2, pos: 'def', faceUp: true });
  check(mz(e, 1, 2)?.name === 'Aqua Madoor' && mz(e, 1, 2).pos === 'def', 'Aqua Madoor summoned in defense');
  e.apply({ type: 'NEXT_PHASE', player: 1 }); // BP
  check(s.phase === 'BP', 'B enters Battle Phase on turn 2');
  e.apply({ type: 'END_TURN', player: 1 });
  check(s.turnPlayer === 0 && s.turn === 3, 'turn 3 for A');
  // A summons Summoned Skull by tributing Battle Ox -> Trap Hole response window for B
  e.apply({ type: 'SUMMON', player: 0, uid: hand(e, 0, 'Summoned Skull').uid, zone: 1, pos: 'atk', faceUp: true });
  check(s.prompt?.kind === 'select' && s.prompt.player === 0, 'tribute prompt for A');
  e.apply({ type: 'CHOOSE', player: 0, picks: [0] });
  check(s.players[0].gy.some((c) => c.name === 'Battle Ox') && s.prompt?.kind === 'response' && s.prompt.player === 1, 'Battle Ox tributed; B gets a response window');
  e.apply({ type: 'CHOOSE', player: 1, picks: [0] }); // Trap Hole
  check(e.monsters(0).length === 0 && s.players[0].gy.some((c) => c.name === 'Summoned Skull') && s.players[1].gy.some((c) => c.name === 'Trap Hole'), 'Trap Hole destroys Summoned Skull');
  check(s.prompt === null, 'no prompt left after chain');
  e.apply({ type: 'END_TURN', player: 0 });
  // B attacks with Aqua Madoor? it is in defense; change to attack then attack directly
  e.apply({ type: 'CHANGE_POS', player: 1, uid: mz(e, 1, 2).uid });
  check(mz(e, 1, 2).pos === 'atk', 'Aqua Madoor switched to attack');
  e.apply({ type: 'NEXT_PHASE', player: 1 });
  e.apply({ type: 'ATTACK', player: 1, uid: mz(e, 1, 2).uid, target: null });
  check(s.players[0].lp === 8000 - 1200, 'direct attack for 1200');
  e.apply({ type: 'ATTACK', player: 1, uid: mz(e, 1, 2).uid, target: null });
  check(s.players[0].lp === 6800, 'a monster cannot attack twice');
  e.apply({ type: 'END_TURN', player: 1 });
  // A: summon Mystical Elf (800 atk) -> Trap Hole no longer; then B's Mirror Force on attack next turn
  e.apply({ type: 'SUMMON', player: 0, uid: hand(e, 0, 'Mystical Elf').uid, zone: 0, pos: 'atk', faceUp: true });
  check(s.prompt === null && mz(e, 0, 0)?.name === 'Mystical Elf', 'Mystical Elf (800) summoned without Trap Hole window');
  e.apply({ type: 'END_TURN', player: 0 });
  e.apply({ type: 'END_TURN', player: 1 });
  e.apply({ type: 'NEXT_PHASE', player: 0 }); // BP
  e.apply({ type: 'ATTACK', player: 0, uid: mz(e, 0, 0).uid, target: mz(e, 1, 2).uid });
  check(s.prompt?.kind === 'response' && s.prompt.player === 1 && s.prompt.options[0].label === 'Mirror Force', 'Mirror Force offered on attack');
  e.apply({ type: 'CHOOSE', player: 1, picks: [0] });
  check(e.monsters(0).length === 0 && s.players[0].lp === 6800, 'Mirror Force destroys the attacker, no damage');
  check(s.battle === null && s.prompt === null, 'battle over');
}

// 2. Hand limit discard at End Phase, Dark Hole, Monster Reborn, Change of Heart, Man-Eater Bug flip.
{
  const e = fresh(['Dark Hole', 'Monster Reborn', 'Change of Heart', 'Man-Eater Bug', 'Celtic Guardian', 'Pot of Greed', 'Rogue Doll', 'Rogue Doll', ...filler(20)], ['Battle Ox', 'Rogue Doll', 'Magic Jammer', 'Celtic Guardian', 'Celtic Guardian', ...filler(20)]);
  const s = e.state;
  e.apply({ type: 'ACTIVATE', player: 0, uid: hand(e, 0, 'Pot of Greed').uid, zone: 0 });
  check(s.players[0].hand.length === 7, 'Pot of Greed: 7 in hand');
  e.apply({ type: 'END_TURN', player: 0 });
  check(s.prompt?.kind === 'select' && s.prompt.title.startsWith('Hand limit') && s.prompt.min === 1, 'A must discard to 6');
  e.apply({ type: 'CHOOSE', player: 0, picks: [4] });
  check(s.turnPlayer === 1 && s.players[0].hand.length === 6, 'discarded one, turn passed');
  e.apply({ type: 'SUMMON', player: 1, uid: hand(e, 1, 'Battle Ox').uid, zone: 0, pos: 'atk', faceUp: true });
  e.apply({ type: 'SET_ST', player: 1, uid: hand(e, 1, 'Magic Jammer').uid, zone: 0 });
  e.apply({ type: 'END_TURN', player: 1 });
  // A plays Dark Hole; B can Magic Jammer it (discard 1)
  e.apply({ type: 'ACTIVATE', player: 0, uid: hand(e, 0, 'Dark Hole').uid, zone: 0 });
  check(s.prompt?.kind === 'response' && s.prompt.player === 1 && s.prompt.options[0].label === 'Magic Jammer', 'Magic Jammer offered against Dark Hole');
  e.apply({ type: 'CHOOSE', player: 1, picks: [0] });
  check(s.prompt?.kind === 'select' && s.prompt.player === 1, 'Magic Jammer asks for a discard');
  e.apply({ type: 'CHOOSE', player: 1, picks: [0] });
  check(e.monsters(1).length === 1 && s.players[0].gy.some((c) => c.name === 'Dark Hole'), 'Dark Hole negated; Battle Ox survives');
  // Change of Heart on Battle Ox, then it returns at end phase
  e.apply({ type: 'ACTIVATE', player: 0, uid: hand(e, 0, 'Change of Heart').uid, zone: 0 });
  check(s.prompt?.kind === 'select' && s.prompt.player === 0, 'Change of Heart asks target');
  e.apply({ type: 'CHOOSE', player: 0, picks: [0] });
  check(e.monsters(0).some((m) => m.name === 'Battle Ox') && e.monsters(1).length === 0, 'A controls Battle Ox');
  e.apply({ type: 'SUMMON', player: 0, uid: hand(e, 0, 'Man-Eater Bug').uid, zone: 1, pos: 'def', faceUp: false });
  check(mz(e, 0, 1)?.name === 'Man-Eater Bug' && !mz(e, 0, 1).faceUp, 'Man-Eater Bug set');
  e.apply({ type: 'END_TURN', player: 0 });
  check(e.monsters(1).some((m) => m.name === 'Battle Ox') && e.monsters(0).length === 1, 'Battle Ox returned at End Phase');
  e.apply({ type: 'END_TURN', player: 1 });
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: mz(e, 0, 1).uid });
  check(mz(e, 0, 1).faceUp && mz(e, 0, 1).pos === 'atk', 'Flip Summon turns Man-Eater Bug face-up (single target auto-picked)');
  check(e.monsters(1).length === 0 && s.players[1].gy.some((c) => c.name === 'Battle Ox'), 'Man-Eater Bug destroyed Battle Ox');
  e.apply({ type: 'ACTIVATE', player: 0, uid: hand(e, 0, 'Monster Reborn').uid, zone: 1 });
  check(s.prompt?.kind === 'select', 'Monster Reborn target prompt');
  const idx = s.prompt!.kind === 'select' ? s.prompt!.options.findIndex((o) => o.label === 'Battle Ox') : -1;
  e.apply({ type: 'CHOOSE', player: 0, picks: [idx] });
  check(s.prompt?.kind === 'yesno', 'position question');
  e.apply({ type: 'YES', player: 0 });
  check(e.monsters(0).some((m) => m.name === 'Battle Ox' && m.pos === 'atk'), 'Battle Ox reborn for A');
}

// 3. LP to zero ends the duel; deck-out.
{
  const e = fresh(['Summoned Skull', ...filler(25)], [...filler(6)]);
  const s = e.state;
  s.players[1].lp = 1000;
  e.apply({ type: 'END_TURN', player: 0 });
  e.apply({ type: 'END_TURN', player: 1 });
  e.apply({ type: 'SUMMON', player: 0, uid: hand(e, 0, 'Celtic Guardian').uid, zone: 0, pos: 'atk', faceUp: true });
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  e.apply({ type: 'ATTACK', player: 0, uid: mz(e, 0, 0).uid, target: null });
  check(s.winner === 0 && /Life Points/.test(s.winReason), 'A wins when B hits 0 LP');
  const d = fresh([...filler(6)], [...filler(5)]);
  d.apply({ type: 'END_TURN', player: 0 });
  check(d.state.winner === 0 && /no cards/.test(d.state.winReason), 'deck-out loses');
}
console.log(failures ? `${failures} FAILURES` : 'ALL OK');
process.exit(failures ? 1 : 0);
