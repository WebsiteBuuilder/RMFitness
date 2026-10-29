// Duel School (the beginner tutorial): every lesson's duel plays to the end through its steps,
// taking each choice both ways, with only the moves a step allows; the coach's script answers;
// the prizes pay once. Run: npx tsx tests/tutorial.test.ts
import { DB as KIT } from './speedkit';
import { DB } from '../src/eds/db';
import { Engine } from '../src/eds/engine';
import type { Action, DuelState } from '../src/eds/types';
import { LESSONS, allowed, coachMayMove, finishLesson, lessonOpen, nextLesson, nextStep, offerSchool, skipSchool, textOf, type TutStep } from '../src/eds/tutorial';

for (const [k, v] of KIT) DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) console.log(`FAIL: ${msg}`);
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
  if (!c) fails++;
};

/** every move the player could try right now (the tutorial's guard decides which go through) */
function candidates(st: DuelState): Action[] {
  const out: Action[] = [];
  const me = st.players[0];
  if (st.prompt?.player === 0) {
    const p = st.prompt;
    if (p.kind === 'yesno') out.push({ type: 'YES', player: 0 }, { type: 'NO', player: 0 });
    else p.options.forEach((_, i) => out.push({ type: 'CHOOSE', player: 0, picks: [i] }));
    // (the screen offers "Don't chain" on a response, Cancel on a question that may be backed out of)
    if (p.kind === 'response') out.push({ type: 'PASS', player: 0 });
    if (p.kind === 'select' && p.cancel) out.push({ type: 'CANCEL', player: 0 });
    return out;
  }
  const zone = me.mz.findIndex((z) => z === null);
  const sz = me.sz.findIndex((z) => z === null);
  for (const c of me.hand) {
    out.push({ type: 'SUMMON', player: 0, uid: c.uid, zone: zone < 0 ? 0 : zone, pos: 'atk', faceUp: true }, { type: 'SUMMON', player: 0, uid: c.uid, zone: zone < 0 ? 0 : zone, pos: 'def', faceUp: false });
    out.push({ type: 'ACTIVATE', player: 0, uid: c.uid, zone: sz }, { type: 'SET_ST', player: 0, uid: c.uid, zone: sz });
  }
  for (const m of me.mz) {
    if (!m) continue;
    out.push({ type: 'ATTACK', player: 0, uid: m.uid, target: null });
    for (const t of st.players[1].mz) if (t) out.push({ type: 'ATTACK', player: 0, uid: m.uid, target: t.uid });
  }
  out.push({ type: 'NEXT_PHASE', player: 0 }, { type: 'END_TURN', player: 0 });
  return out;
}

const sig = (st: DuelState) => JSON.stringify([st.turn, st.phase, st.prompt, st.players.map((p) => [p.lp, p.hand.length, p.mz.map((m) => m && [m.uid, m.faceUp, m.attacked]), p.sz.map((c) => c?.uid), p.gy.length])]);

/** Plays a lesson's duel: `pick` chooses among the allowed moves (0 = the first, -1 = the last). */
function play(lessonId: string, pick: number): { won: boolean; steps: string[]; e: Engine; blocked: number } {
  const lesson = LESSONS.find((l) => l.id === lessonId)!;
  const d = lesson.duel!;
  const e = new Engine(DB);
  e.apply(d.start('You', 'Yugi'));
  const steps: TutStep[] = d.steps;
  let i = nextStep(steps, 0, e.state);
  const seen: string[] = [];
  let blocked = 0;
  for (let guard = 0; guard < 400 && e.state.winner === null && i < steps.length; guard++) {
    const st = e.state;
    const s = steps[i];
    if (!seen.includes(s.id)) seen.push(s.id);
    ok(textOf(s, st).length > 10, `${lessonId}/${s.id}: says something`);
    if (s.kind === 'info') {
      i = nextStep(steps, i + 1, e.state);
      continue;
    }
    if (coachMayMove(steps, i, st)) {
      const a = d.coach(e);
      if (a) {
        e.apply(a);
        i = nextStep(steps, i, e.state);
        continue;
      }
    }
    if (s.kind === 'watch') {
      ok(false, `${lessonId}/${s.id}: the coach is stuck (${JSON.stringify(st.prompt)} T${st.turn} ${st.phase} tp${st.turnPlayer})`);
      break;
    }
    const all = candidates(st);
    const good = all.filter((a) => allowed(steps, i, a, st));
    blocked += all.length - good.length;
    // a move that changes something (the rules ignore some allowed ones, like CANCEL with nothing open)
    const before = sig(st);
    const order = pick === -1 ? [...good].reverse() : good;
    let moved = false;
    for (const a of order) {
      if (a.type === 'CANCEL' || (a.type === 'NO' && pick !== -1)) continue;
      const snap = JSON.stringify(e.state);
      e.apply(a);
      if (sig(e.state) !== before) {
        moved = true;
        break;
      }
      e.state = JSON.parse(snap);
    }
    if (!moved) {
      ok(false, `${lessonId}/${s.id}: no allowed move does anything (${good.map((a) => a.type).join(',')}) prompt=${JSON.stringify(st.prompt)} T${st.turn} ${st.phase} chain=${st.chain.length} gy=${st.players.map((p) => p.gy.map((c) => c.name).join('+')).join(' | ')} mz=${st.players.map((p) => p.mz.map((m) => m?.name).join('+')).join(' | ')}`);
      break;
    }
    i = nextStep(steps, i, e.state);
  }
  return { won: e.state.winner === 0, steps: seen, e, blocked };
}

for (const l of LESSONS) {
  ok(l.slides.length > 0 && l.quiz.length >= 3, `${l.id}: has pages and a quiz`);
  for (const q of l.quiz) ok(q.right >= 0 && q.right < q.options.length && q.why.length > 0, `${l.id}: quiz "${q.q}" has a right answer`);
  if (!l.duel) continue;
  for (const pick of [0, -1]) {
    const r = play(l.id, pick);
    ok(r.won, `${l.id} (choice ${pick}): the duel ends in your win (LP ${r.e.state.players.map((p) => p.lp).join('/')}, at ${r.steps[r.steps.length - 1]})`);
    ok(r.blocked > 0, `${l.id} (choice ${pick}): wrong moves are held back`);
  }
}

// the choices really branch
{
  const a = play('basics', 0).e.state.players[0].mz.map((m) => m?.name).filter(Boolean).sort().join();
  const b = play('basics', -1).e.state.players[0].mz.map((m) => m?.name).filter(Boolean).sort().join();
  ok(a !== b, `basics: Monster Reborn's choice brings back a different monster (${a} | ${b})`);
  const x = play('battles', 0).e.state.players[0].lp;
  const y = play('battles', -1).e.state.players[0].lp;
  ok(x !== y, `battles: attacking the wall or the face-down card goes differently (${x} | ${y})`);
  const f0 = play('fusion', 0).e.state.players[0].mz.find((m) => m)?.name;
  const f1 = play('fusion', -1).e.state.players[0].mz.find((m) => m)?.name;
  ok(f0 !== f1, `fusion: either Fusion Monster can be made (${f0} | ${f1})`);
  const c0 = play('chains', 0);
  ok(c0.steps.includes('chain') && c0.e.state.players[1].gy.some((c) => c.name === 'Trap Jammer'), 'chains: the coach answers your Trap with Trap Jammer');
  const c1 = play('chains', -1);
  ok(c0.steps.includes('kuri-use') || c1.steps.includes('kuri-use'), 'chains: Kuriboh gets its moment in one of the branches');
}

// ---------- the save ----------
{
  const s0 = { wins: 0, losses: 0, draws: 0 };
  ok(offerSchool(s0), 'a brand-new duelist is offered Duel School');
  ok(!offerSchool({ ...s0, wins: 3 }), 'someone who has dueled is not');
  ok(!offerSchool(skipSchool(s0)), '"I know how to play" stops the offer');
  ok(lessonOpen(s0, 'basics') && !lessonOpen(s0, 'battles'), 'lessons open one after another');
  const r1 = finishLesson(s0, 'basics');
  ok(r1.packs === 1 && (r1.save as { packs?: number }).packs === 1, 'the first lesson pays one pack');
  const r2 = finishLesson(r1.save, 'basics');
  ok(r2.packs === 0 && (r2.save as { packs?: number }).packs === 1, 'finishing it again pays nothing');
  ok(lessonOpen(r1.save, 'battles') && nextLesson(r1.save)?.id === 'battles', 'the next lesson opens');
  ok(!offerSchool(r1.save), 'a started school is not offered again');
  ok(finishLesson(s0, 'nope').packs === 0, 'an unknown lesson pays nothing');
  let s: object = s0;
  let total = 0;
  for (const l of LESSONS) {
    const r = finishLesson(s, l.id);
    s = r.save;
    total += r.packs;
  }
  ok(total === LESSONS.length && nextLesson(s) === null, `all ${LESSONS.length} lessons pay ${LESSONS.length} packs in all, once`);
}

if (fails) {
  console.log(`${fails} failure(s)`);
  process.exit(1);
}
console.log('tutorial: all ok');
