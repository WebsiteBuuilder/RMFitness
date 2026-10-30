// Mates: the roster and its economy, the reactions to duel events, and the MATE moves in a
// room's log (screened by the host, never a duel move, never in a replay).
import assert from 'node:assert/strict';
import { buyMate, cantBuy, chosenMate, DEFAULT_MATE, hasMate, isMate, isReact, MATES, mateForName, pickMate, EMOTES } from '../src/mates/roster';
import { canSend, cuesFor, endCues, REACT_SPEC, SEND_GAP_MS, tapReact } from '../src/mates/react';
import { DuelSession, screenProposal } from '../src/eds/session';
import { MemoryAdapter } from '../src/sync/memory';
import { newSpeedSave, type SpeedSave } from '../src/eds/speedSave';
import type { EngineEvent } from '../src/eds/types';

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`ok ${name}`);
};

// ---------- roster ----------
t('every mate has a unique id, a voice and tap reactions that exist', () => {
  assert.equal(new Set(MATES.map((m) => m.id)).size, MATES.length);
  assert.ok(MATES.length >= 12);
  for (const m of MATES) {
    assert.ok(m.voice > 100 && m.taps.length >= 2, m.id);
    for (const r of m.taps) assert.ok(isReact(r), `${m.id} ${r}`);
    assert.ok(/^[a-z]{2,12}$/.test(m.id), 'ids ride the room log as short words');
  }
  for (const e of EMOTES) assert.ok(REACT_SPEC[e.react]);
});

const save = (over: Partial<SpeedSave> = {}): SpeedSave => ({ ...newSpeedSave(), ...over });

t('free mates are had from the start; bought ones cost Duel Chips once', () => {
  const s = save({ chips: 5 });
  assert.ok(hasMate(s, 'pip') && hasMate(s, 'ember') && hasMate(s, 'bolt'));
  assert.ok(!hasMate(s, 'wisp'));
  assert.equal(chosenMate(s), DEFAULT_MATE);
  const b = buyMate(s, 'wisp')!;
  assert.equal(b.chips, 1);
  assert.ok(hasMate(b, 'wisp'));
  assert.equal(buyMate(b, 'wisp'), null, 'not twice');
  assert.match(cantBuy(b, 'mimic')!, /Needs 6/);
  assert.equal(buyMate(b, 'mimic'), null, 'not on credit');
  assert.equal(buyMate(save({ chips: 30 }), 'gloop'), null, 'earned mates are never sold');
});

t('earned mates unlock by wins and stay picked only while had', () => {
  const s = save({ wins: 4 });
  assert.ok(!hasMate(s, 'gloop'));
  assert.equal(pickMate(s, 'gloop'), null);
  const w = { ...s, wins: 5 };
  assert.ok(hasMate(w, 'gloop'));
  const picked = pickMate(w, 'gloop')!;
  assert.equal(chosenMate(picked), 'gloop');
  // a save carrying a mate it doesn't have (edited, or an old version) brings Pip
  assert.equal(chosenMate(save({ mate: 'drake' })), 'pip');
  assert.equal(chosenMate(save({ mate: 'nope' })), 'pip');
  assert.equal(chosenMate(null), 'pip');
});

t("a computer duelist's mate is the same every time", () => {
  assert.equal(mateForName('Seto Kaiba'), mateForName('Seto Kaiba'));
  assert.ok(isMate(mateForName('Mai Valentine')));
  assert.ok(new Set(['Yami Yugi', 'Seto Kaiba', 'Joey Wheeler', 'Mai Valentine', 'Bandit Keith', 'Pegasus'].map(mateForName)).size > 2);
});

// ---------- reactions ----------
const ev = (e: Partial<EngineEvent> & { kind: string }, seq = 1): EngineEvent => ({ seq, ...e }) as EngineEvent;
const never = () => false;

t('a summon: its side hops, a big one is a cheer and the other side gasps', () => {
  assert.deepEqual(cuesFor([ev({ kind: 'summon', player: 0, uid: 5 })], never), [{ player: 0, react: 'hop' }]);
  assert.deepEqual(cuesFor([ev({ kind: 'summon', player: 1, uid: 5, how: 'fusion' })], (e) => e.how === 'fusion'), [
    { player: 0, react: 'wow' },
    { player: 1, react: 'cheer' },
  ]);
});

t('damage: the hit side winces (a big hit is sad), the other laughs', () => {
  assert.deepEqual(cuesFor([ev({ kind: 'damage', player: 1, amount: 500 })], never), [
    { player: 0, react: 'hop' },
    { player: 1, react: 'hurt' },
  ]);
  assert.deepEqual(cuesFor([ev({ kind: 'damage', player: 0, amount: 2500 })], never), [
    { player: 0, react: 'sad' },
    { player: 1, react: 'laugh' },
  ]);
  assert.deepEqual(cuesFor([ev({ kind: 'damage', player: 0, amount: 0 })], never), []);
});

t('one reaction per side per moment: the strongest wins', () => {
  // a monster lost in battle and damage on the same side: sad over hurt
  const cues = cuesFor([ev({ kind: 'damage', player: 1, amount: 300 }, 1), ev({ kind: 'activate', player: 1 }, 2)], never, [0, 1]);
  assert.deepEqual(cues, [
    { player: 0, react: 'hop' },
    { player: 1, react: 'sad' },
  ]);
  assert.deepEqual(cuesFor([ev({ kind: 'draw', player: 0 })], never), [], 'a draw is no moment');
});

t('the end: winner celebrates, loser slumps, both loop', () => {
  assert.deepEqual(endCues(1), [
    { player: 1, react: 'win' },
    { player: 0, react: 'lose' },
  ]);
  assert.ok(REACT_SPEC.win.loop && REACT_SPEC.lose.loop);
  assert.equal(endCues('draw').length, 2);
});

t('taps: never the same reaction twice in a row; sends spaced out', () => {
  for (let i = 0; i < 20; i++) assert.notEqual(tapReact(['hop', 'spin', 'wave'], 'hop', i / 20), 'hop');
  assert.equal(tapReact(['hop'], 'hop', 0.5), 'hop');
  assert.ok(!canSend(1000, 1000 + SEND_GAP_MS - 1));
  assert.ok(canSend(1000, 1000 + SEND_GAP_MS));
});

// ---------- the room's log ----------
t('the host screens a guest MATE: own seat, short words, a flood dropped', () => {
  const recent: number[] = [];
  assert.equal(screenProposal({ type: 'MATE', player: 0, mate: 'pip', react: 'hop' } as never, 1, recent), null, 'not in the host seat');
  assert.equal(screenProposal({ type: 'MATE', player: 1, mate: 'x'.repeat(40) } as never, 1, recent), null);
  assert.equal(screenProposal({ type: 'MATE', player: 1, mate: 'pip', react: '<b>' } as never, 1, recent), null);
  const ok = screenProposal({ type: 'MATE', player: 1, mate: 'pip', react: 'hop', extra: 'junk' } as never, 1, recent, 1000);
  assert.deepEqual(ok, { type: 'MATE', player: 1, mate: 'pip', react: 'hop' }, 'only its own fields are stored');
  let kept = 1;
  for (let i = 0; i < 10; i++) if (screenProposal({ type: 'MATE', player: 1, mate: 'pip', react: 'hop' } as never, 1, recent, 1100 + i)) kept++;
  assert.equal(kept, 6, 'six reactions per six seconds');
  assert.ok(screenProposal({ type: 'MATE', player: 1, mate: 'pip' } as never, 1, recent, 1200), 'naming the mate is never capped');
  assert.ok(screenProposal({ type: 'MATE', player: 1, mate: 'pip', react: 'hop' } as never, 1, recent, 8000), 'the window moves on');
  assert.deepEqual(recent, [], "mate reactions don't use up the chat's lines");
});

t('MATE rides the log: it sets the seat mate, counts reactions, is never a move', async () => {
  const a = new MemoryAdapter();
  const s = new DuelSession(a);
  s.send({ type: 'MATE', player: 0, mate: 'ember' });
  let v = s.view();
  assert.deepEqual(v.mates[0] && { id: v.mates[0].id, n: v.mates[0].n }, { id: 'ember', n: 0 });
  assert.equal(v.mates[1], null);
  assert.equal(v.moves, 0, 'not a move');
  s.send({ type: 'MATE', player: 0, mate: 'ember', react: 'cheer' });
  s.send({ type: 'MATE', player: 0, mate: 'ember', react: 'cheer' });
  v = s.view();
  assert.equal(v.mates[0]!.n, 2, 'the same reaction twice plays twice');
  assert.equal(v.mates[0]!.react, 'cheer');
  assert.equal(v.moves, 0);
  // junk in the log changes nothing
  s.send({ type: 'MATE', player: 1, mate: 42 } as never);
  assert.equal(s.view().mates[1], null);
  s.close();
});

t('a mate on this phone only (against the computer) never enters the log', () => {
  const s = new DuelSession(new MemoryAdapter());
  s.localMate(1, 'drake');
  s.localMate(1, 'drake', 'angry');
  const v = s.view();
  assert.equal(v.mates[1]!.id, 'drake');
  assert.equal(v.mates[1]!.n, 1);
  assert.equal(v.mates[1]!.old, false);
  assert.equal(v.log.length, 0);
  s.close();
});

console.log(`mates: ${n} passed`);
