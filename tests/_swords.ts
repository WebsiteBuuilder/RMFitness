import { DB } from './speedkit';
import { Engine } from '../src/eds/engine';
const mode = (process.env.M ?? 'speed') as any;
const e = new Engine(DB);
e.apply({ type: 'START', first: 1, seed: 1, names: ['A', 'B'], decks: [Array(40).fill('Swords of Revealing Light'), Array(40).fill('Gemini Elf')], fusions: [[], []], mode, skills: [null, null] } as any);
const pass = () => { for (let i = 0; i < 20 && e.state.prompt; i++) { const pr: any = e.state.prompt; e.apply((pr.kind === 'yesno' ? { type: 'NO', player: pr.player } : pr.kind === 'response' ? { type: 'PASS', player: pr.player } : { type: 'CHOOSE', player: pr.player, picks: Array.from({ length: Math.max(1, pr.min) }, (_, i) => i) }) as any); } };
const B = e.player(1), A = e.player(0);
e.apply({ type: 'SUMMON', player: 1, uid: B.hand[0].uid, zone: 0, pos: 'def', faceUp: false } as any); pass();
e.apply({ type: 'END_TURN', player: 1 } as any); pass();
e.apply({ type: 'ACTIVATE', player: 0, uid: A.hand[0].uid, zone: 0 } as any); pass();
console.log('B monster faceUp:', B.mz[0]?.faceUp, '| swords on field:', !!A.sz.find(Boolean));
for (let t = 1; t <= 4; t++) {
  for (let g = 0; g < 12 && (e.state.turnPlayer === 0); g++) { e.apply({ type: 'NEXT_PHASE', player: 0 } as any); pass(); }
  for (let g = 0; g < 12 && (e.state.phase !== 'M1'); g++) { e.apply({ type: 'NEXT_PHASE', player: 1 } as any); pass(); }
  // B's turn: summon an attacker and try to go to battle
  const c = B.hand.find((x) => e.canNormalSummon(1, x));
  if (c) { e.apply({ type: 'SUMMON', player: 1, uid: c.uid, zone: B.mz.findIndex((z) => !z), pos: 'atk', faceUp: true } as any); pass(); }
  for (let g = 0; g < 12 && (e.state.phase !== 'BP' && e.state.turnPlayer === 1); g++) { e.apply({ type: 'NEXT_PHASE', player: 1 } as any); pass(); }
  const canAtk = e.state.phase === 'BP' && e.monsters(1).some((m) => e.canAttackWith(1, m));
  for (let g = 0; g < 12 && (e.state.turnPlayer === 1); g++) { e.apply({ type: 'NEXT_PHASE', player: 1 } as any); pass(); }
  console.log(`B turn ${t} (${e.state.phase} T${e.state.turn} tp=${e.state.turnPlayer} prompt=${e.state.prompt?.title}): can attack=${canAtk}; swords still on field=${!!A.sz.find((z) => z?.name.startsWith('Swords'))}`);
}
