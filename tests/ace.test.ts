// Attack callouts and Ace bond: which monsters shout, how a shout is laid out, the Ace's bond
// levels, which wins count (never Practice or Anything goes), and the Ace riding a room's JOIN.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CALLOUTS, calloutFor, mateEcho, shoutLines, shoutSize, voicePitch, NEXT_CALLOUT } from '../src/art/callouts';
import { aceFor, aceFromWire, aceOf, aceToWire, aceWinsFor, BOND_LEVELS, bondLevel, bondTitle, nextBond, showDuelAces, withAce, withAceWin } from '../src/ace/ace';
import { newSpeedSave, type SpeedSave } from '../src/eds/speedSave';
import { DuelSession } from '../src/eds/session';
import { MemoryAdapter } from '../src/sync/memory';

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`ok ${name}`);
};

const pool = new Set((JSON.parse(readFileSync('public/cards/speed.json', 'utf8')) as { name: string; type: string }[]).map((c) => c.name));

// ---------- callouts ----------
t('every callout is a Speed Duel monster and ends in a shout', () => {
  assert.ok(Object.keys(CALLOUTS).length >= 50);
  for (const [name, text] of Object.entries(CALLOUTS)) {
    assert.ok(pool.has(name), `${name} is in the Speed Duel pool`);
    assert.ok(/!$/.test(text) && text.length <= 28, `${name}: ${text}`);
  }
  assert.equal(CALLOUTS['Blue-Eyes White Dragon'], 'White Lightning!');
  assert.equal(CALLOUTS['Dark Magician'], 'Dark Magic Attack!');
});

t('only signature monsters shout, unless the monster is an Ace', () => {
  assert.equal(calloutFor('Blue-Eyes White Dragon', 'Burst Stream of Destruction')?.text, 'White Lightning!');
  assert.equal(calloutFor('Mystic Clown', 'Shadow Grasp'), null);
  assert.deepEqual(calloutFor('Mystic Clown', 'Shadow Grasp', true), { text: 'Shadow Grasp!', card: 'Mystic Clown', ace: true });
  assert.equal(calloutFor('Mystic Clown', 'Shadow Grasp!!', true)?.text, 'Shadow Grasp!');
  assert.equal(calloutFor('', 'x', true), null, 'a face-down monster says nothing');
});

t('a long shout splits in two balanced lines and every line fits the screen', () => {
  assert.deepEqual(shoutLines('White Lightning!'), [['White', 'Lightning!']]);
  const two = shoutLines('X-Y-Z Hyper Destruction!');
  assert.equal(two.length, 2);
  for (const text of Object.values(CALLOUTS)) {
    const fs = shoutSize(text);
    const longest = Math.max(...shoutLines(text).map((l) => l.join(' ').length));
    // ~0.72 em per heavy italic capital: the line stays inside ~92% of the width
    assert.ok(longest * 0.72 * fs <= 92, `${text} at ${fs}vw`);
    assert.ok(fs >= 5 && fs <= 13);
  }
});

t('the Mate echoes the shout louder; voices go low for big monsters', () => {
  assert.equal(mateEcho('White Lightning!'), '…LIGHTNING!!');
  assert.equal(mateEcho('Dark Magic Attack!'), '…MAGIC ATTACK!!');
  assert.equal(mateEcho('Burstfire!'), 'BURSTFIRE!!');
  assert.ok(voicePitch(8, 'Blue-Eyes White Dragon') < voicePitch(1, 'Kuriboh'));
  assert.equal(NEXT_CALLOUT.voice, 'text');
  assert.equal(NEXT_CALLOUT.off, 'voice');
});

// ---------- Ace bond ----------
const owning = (names: string[]): SpeedSave => ({ ...newSpeedSave(), collection: Object.fromEntries(names.map((x) => [x, 1])) });

t('bond levels climb with wins', () => {
  assert.equal(bondLevel(0), 1);
  assert.equal(bondLevel(2), 1);
  assert.equal(bondLevel(3), 2);
  assert.equal(bondLevel(10), 3);
  assert.equal(bondLevel(25), 4);
  assert.equal(bondLevel(50), 5);
  assert.equal(bondLevel(999), 5);
  assert.deepEqual(nextBond(4), { lv: 3, need: 6, at: 10 });
  assert.equal(nextBond(50), null);
  assert.equal(bondTitle(5), 'Legendary Ace');
  assert.equal(BOND_LEVELS.length, 5);
});

t('an Ace must be owned; switching keeps each card its own bond', () => {
  let s = owning(['Dark Magician', 'Blue-Eyes White Dragon']);
  assert.equal(aceOf(s), null);
  s = withAce(s, 'Dark Magician');
  assert.deepEqual(aceOf(s), { name: 'Dark Magician', lv: 1, wins: 0 });
  assert.equal(aceOf(withAce(owning([]), 'Dark Magician')), null, 'not owned: no Ace');
  s = { ...s, aceWins: { 'Dark Magician': 4, 'Blue-Eyes White Dragon': 11 } };
  assert.equal(aceOf(s)!.lv, 2);
  s = withAce(s, 'Blue-Eyes White Dragon');
  assert.equal(aceOf(s)!.lv, 3);
  assert.equal(aceWinsFor(s, 'Dark Magician'), 4);
  assert.equal(aceOf(withAce(s, null)), null);
});

t('only a counted win with the Ace in the deck grows the bond, and it pays nothing else', () => {
  const s = withAce(owning(['Dark Magician', 'Kuriboh']), 'Dark Magician');
  const deck = ['Dark Magician', 'Kuriboh'];
  assert.equal(withAceWin(s, { won: false, counts: true, deck }).save, s, 'a loss');
  assert.equal(withAceWin(s, { won: true, counts: false, deck }).save, s, 'Practice or Anything goes');
  assert.equal(withAceWin(s, { won: true, counts: true, deck: ['Kuriboh'] }).save, s, 'Ace left out of the deck');
  let cur = s;
  const lines: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = withAceWin(cur, { won: true, counts: true, deck });
    cur = r.save;
    if (r.line) lines.push(r.line);
  }
  assert.equal(aceWinsFor(cur, 'Dark Magician'), 3);
  assert.equal(lines.length, 1, 'one line, at the level up');
  assert.match(lines[0], /Trusted Ace/);
  // nothing else in the save moves: no chips, cards, packs or record
  const { aceWins: _a, ...rest } = cur;
  const { aceWins: _b, ...was } = s;
  assert.deepEqual(rest, was);
});

t('the duel registry: an Ace is its owner’s card only', () => {
  showDuelAces([{ name: 'Dark Magician', lv: 3, wins: 10 }, null]);
  assert.equal(aceFor(0, 'Dark Magician')?.lv, 3);
  assert.equal(aceFor(1, 'Dark Magician'), null, "the opponent's copy is not your Ace");
  assert.equal(aceFor(0, 'Kuriboh'), null);
  showDuelAces(null);
  assert.equal(aceFor(0, 'Dark Magician'), null);
});

t('the Ace rides the JOIN to the other phone, checked on the way in', () => {
  assert.deepEqual(aceToWire({ name: 'Dark Magician', lv: 4, wins: 30 }), { name: 'Dark Magician', lv: 4 });
  assert.equal(aceToWire(null), undefined);
  assert.equal(aceFromWire({ name: 'Dark Magician', lv: 99 })?.lv, 5);
  assert.equal(aceFromWire({ name: 'Dark Magician', lv: -3 })?.lv, 1);
  assert.equal(aceFromWire({ name: 'x'.repeat(200), lv: 1 }), null);
  assert.equal(aceFromWire('Dark Magician'), null);
  assert.equal(aceFromWire(null), null);
  const ses = new DuelSession(new MemoryAdapter());
  ses.send({ type: 'JOIN', player: 0, name: 'A', deck: [], fusion: [], mode: 'speed', ace: { name: 'Dark Magician', lv: 2 } });
  ses.send({ type: 'JOIN', player: 1, name: 'B', deck: [], fusion: [], mode: 'speed' });
  const v = ses.view();
  assert.deepEqual(v.seats[0].ace, { name: 'Dark Magician', lv: 2 });
  assert.equal(v.seats[1].ace, undefined);
});

console.log(`ace: ${n} tests passed`);
