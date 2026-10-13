// Cinematic flow: which moments get a cinematic, skipping, and the duel board
// kept in step with the cinematics (run: npx tsx tests/flow.test.ts).
import { Engine } from '../src/eds/engine';
import { DB as APP_DB } from '../src/eds/db';
import type { DuelState, Prompt } from '../src/eds/types';
import { artBusy, artFocus, bannerOnce, clearArtFocus, coalesce, cueUids, focusArt, onArtChange, setArtBusy, toCues, type Cue, type CardRef } from '../src/art/cues';
import { attachArtSink, Flow, LP_TICK_MS, pickCues, START_GRACE_MS, WATCHDOG_SLACK_MS, WIN_AFTER_LP_MS } from '../src/art/flow';
import { SKIP_W, skipSpot } from '../src/art/skipspot';
import { cueOwner, flowRate, OPP_BACKLOG_RATE, Timeline } from '../src/art/runtime';
import { DB, SPEED } from './speedkit';

for (const [k, v] of DB) APP_DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};

// ---------- Timeline: skipping lands the end state without the fireworks ----------
{
  const fired: string[] = [];
  const stage = { add: (f: unknown) => f, remove: () => {} } as never;
  const tl = new Timeline(2, stage);
  tl.at(0.2, () => fired.push('banner'));
  tl.at(0.3, () => fired.push('drop actor'), false);
  tl.span(0.1, 1.5, (k) => k === 1 && fired.push('span end'));
  tl.commit(0.4);
  tl.onCommit = () => fired.push('commit');
  tl.rate = 2;
  tl.update(0.12); // 0.24 s of cinematic at 2×
  ok(fired.join() === 'banner', `time-scale: 0.12 s at 2× reaches the 0.2 s banner (${fired.join()})`);
  tl.finish();
  ok(fired.join() === 'banner,drop actor,span end,commit', `finish() runs state steps and the commit, not cosmetic ones (${fired.join()})`);
  const t2 = new Timeline(1, stage);
  const f2: string[] = [];
  t2.at(0.5, () => f2.push('boom'));
  t2.finish();
  ok(f2.length === 0, 'a skipped cinematic fires no leftover boom/shake/flash');
}

// ---------- which moments get a cinematic ----------
const ref = (name: string, controller: 0 | 1, uid = 1): CardRef => ({ uid, name, faceUp: true, controller, rect: null, def: false });
const lowMon = SPEED.find((c) => c.kind === 'monster' && (c.level ?? 0) <= 4 && c.sub === 'Normal')!;
const bigMon = SPEED.find((c) => c.kind === 'monster' && (c.level ?? 0) >= 7)!;
const spell = SPEED.find((c) => c.kind === 'spell')!;
const sample: Cue[] = [
  { kind: 'summon', card: ref(lowMon.name, 1), special: false },
  { kind: 'summon', card: ref(bigMon.name, 1), special: false },
  { kind: 'set', card: ref('', 1), monster: false },
  { kind: 'activate', card: ref(spell.name, 1), what: 'spell' },
  { kind: 'attack', attacker: ref(lowMon.name, 1), target: null, defender: 0 },
  { kind: 'damage', player: 0, amount: 500 },
  { kind: 'damage', player: 0, amount: 1500 },
  { kind: 'destroy', card: ref(lowMon.name, 0) },
];
const kinds = (c: Cue[]) => c.map((x) => (x.kind === 'summon' ? `summon:${x.card.name === bigMon.name ? 'big' : 'small'}` : x.kind === 'damage' ? `damage:${x.amount}` : x.kind)).join();
ok(kinds(pickCues(sample, 'big', 0)) === 'summon:big,attack,damage:1500,destroy', `Big moments: level 7+ summons, attacks, big damage, destruction (${kinds(pickCues(sample, 'big', 0))})`);
ok(pickCues(sample, 'all', 0).length === sample.length, 'All: everything');
ok(pickCues(sample, 'off', 0).length === 0, 'Off: nothing');
ok(pickCues(sample, 'mine', 0).length === 0, "My actions only: the opponent's moves play none");
ok(kinds(pickCues(sample, 'mine', 1)) === 'summon:small,summon:big,set,activate,attack,damage:500,damage:1500,destroy', 'My actions only: my moves and what follows from them');
{
  // an opponent's long chain keeps moving
  const act: Cue = { kind: 'activate', card: ref(spell.name, 1), what: 'spell' };
  ok(cueOwner(act) === 1 && cueOwner({ kind: 'damage', player: 0, amount: 100 }) === null, 'a cue belongs to the controller of its card (damage to no one)');
  ok(flowRate(act, undefined, 1) === 1 && flowRate(act, undefined, 1, true) >= OPP_BACKLOG_RATE, `an opponent cue with more queued behind plays at least ${OPP_BACKLOG_RATE}×`);
  const atk: Cue = { kind: 'attack', attacker: ref(lowMon.name, 1), target: null, defender: 0 };
  ok(flowRate(atk, { cue: { kind: 'hit', attacker: null, target: null, defender: 0 }, batch: 1, scale: 1 }, 1, true) === 1.6, 'a faster chain rate is kept');
}
const merged = coalesce([{ kind: 'hit', attacker: null, target: null, defender: 0 }, { kind: 'damage', player: 0, amount: 1200 }]);
ok(merged.length === 1 && merged[0].kind === 'hit' && merged[0].dmg?.amount === 1200, 'battle damage plays with the blow (one moment)');

// ---------- the board waits for the cinematic ----------
const strongest = SPEED.filter((c) => c.kind === 'monster' && c.sub === 'Normal' && (c.level ?? 0) <= 4).sort((a, b) => (b.atk ?? 0) - (a.atk ?? 0));
const deckOf = (n: string, k = 20) => Array<string>(k).fill(n);
function duel(): Engine {
  const e = new Engine(DB);
  e.apply({ type: 'START', first: 0, seed: 7, names: ['Jammy', 'Brother'], decks: [deckOf(strongest[0].name), deckOf(strongest[1].name)], fusions: [[], []], mode: 'speed', skills: [null, null] });
  const c = e.player(0).hand[0];
  e.apply({ type: 'SUMMON', player: 0, uid: c.uid, zone: 0, pos: 'atk', faceUp: true });
  e.apply({ type: 'END_TURN', player: 0 });
  e.apply({ type: 'END_TURN', player: 1 });
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  if (e.state.phase !== 'BP') e.apply({ type: 'NEXT_PHASE', player: 0 });
  return e;
}
const played: { cues: Cue[]; batch: number; scales: number[] }[] = [];
let skips = 0;
attachArtSink({ ready: () => true, busy: () => false, play: (cues, batch, scales) => played.push({ cues, batch, scales }), skip: () => skips++ });

// The engine changes its state in place: the flow is fed the live object, as in the app.
const lp = (s: DuelState, p: 0 | 1) => s.players[p].lp;
{
  const e = duel();
  const f = new Flow();
  ok(f.update(e.state, 0) === e.state, 'first look: the board shows the duel as it is');
  e.apply({ type: 'ATTACK', player: 0, uid: e.monsters(0)[0].uid, target: null });
  ok(lp(e.state, 1) < 4000, 'the attack took Life Points in the engine');
  const held = f.update(e.state, 0);
  ok(held !== e.state && lp(held, 1) === 4000, 'while the attack plays, the board still shows the Life Points from before');
  ok(f.holding, 'the board is held (the stage takes taps meanwhile)');
  f.drawn();
  const p = played[played.length - 1];
  ok(p.cues.map((c) => c.kind).join() === 'attack,hit', `the chain is attack → hit (damage rides on the hit) (${p.cues.map((c) => c.kind).join()})`);
  // a quiet update right behind it (a phase change) waits its turn
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  const phase = e.state.phase;
  ok(lp(f.update(e.state, 0), 1) === 4000, 'an update with nothing to watch waits behind the chain');
  f.commit(p.batch, false);
  const now = f.update(e.state, 0);
  ok(now === e.state && now.phase === phase && !f.holding, 'at the impact the board catches up, quiet updates included');
  f.commit(p.batch, true);
  ok(f.update(e.state, 0) === e.state, 'the chain ending later changes nothing');
}
{
  // a choice for the player shows only once its chain is over, and then nothing is left on stage
  const e = duel();
  const f = new Flow();
  f.update(e.state, 1);
  e.apply({ type: 'ATTACK', player: 0, uid: e.monsters(0)[0].uid, target: null });
  e.state.prompt = { kind: 'yesno', player: 1, title: 'Activate a trap?' } as unknown as Prompt;
  const held = f.update(e.state, 1);
  ok(lp(held, 1) === 4000 && !held.prompt, "the opponent's attack holds the board for the defending player");
  f.drawn();
  const p = played[played.length - 1];
  let redraws = 0;
  f.rerender = () => redraws++;
  f.commit(p.batch, false);
  const mid = f.update(e.state, 1);
  ok(!mid.prompt, 'a chain that ends in a choice for the player does not show it mid-way');
  ok(lp(mid, 1) === lp(e.state, 1) && lp(mid, 1) < 4000 && redraws === 1, `but its damage lands at the impact (LP ${lp(mid, 1)}, redrawn ${redraws}×), so the count ticks at the hit`);
  ok(f.promptWaiting, 'the stage hears a choice is waiting (its tail fades out fast)');
  f.commit(p.batch, true);
  ok(f.update(e.state, 1).prompt?.player === 1, 'it shows when the chain is over');
  const before = skips;
  f.afterRender();
  ok(skips === before + 1, 'and whatever is still on stage is skipped so the choice can be tapped');
}
{
  // hold to skip all during the opponent's turn
  const e = duel();
  const f = new Flow();
  e.apply({ type: 'END_TURN', player: 0 });
  f.update(e.state, 0);
  f.skipAll();
  const n = played.length;
  while (e.state.phase !== 'M1') e.apply({ type: 'NEXT_PHASE', player: 1 });
  e.apply({ type: 'SUMMON', player: 1, uid: e.player(1).hand[0].uid, zone: 0, pos: 'atk', faceUp: true });
  e.apply({ type: 'NEXT_PHASE', player: 1 });
  e.apply({ type: 'ATTACK', player: 1, uid: e.monsters(1)[0].uid, target: e.monsters(0)[0]?.uid ?? null });
  ok(f.update(e.state, 0) === e.state && played.length === n, 'after hold-to-skip-all, the rest of the opponent turn plays no cinematics');
  e.apply({ type: 'END_TURN', player: 1 });
  f.update(e.state, 0);
  if (!e.monsters(0).length) e.apply({ type: 'SUMMON', player: 0, uid: e.player(0).hand[0].uid, zone: 0, pos: 'atk', faceUp: true });
  while (e.state.phase !== 'BP' && e.state.turnPlayer === 0) e.apply({ type: 'NEXT_PHASE', player: 0 });
  const m = e.monsters(0)[0];
  ok(!!m && e.state.turnPlayer === 0 && e.state.phase === 'BP', `back on my turn in the Battle Phase with a monster (${e.state.turnPlayer} ${e.state.phase} ${e.monsters(0).length})`);
  if (m) {
    e.apply({ type: 'ATTACK', player: 0, uid: m.uid, target: e.monsters(1)[0]?.uid ?? null });
    f.update(e.state, 0);
    f.drawn();
    ok(played.length === n + 1, 'on my next turn the cinematics are back');
  }
  f.dispose();
}
{
  // a small summon under Big moments plays nothing and the board shows it at once
  const e = duel();
  const f = new Flow();
  e.apply({ type: 'END_TURN', player: 0 });
  f.update(e.state, 0);
  const n = played.length;
  while (e.state.phase !== 'M1') e.apply({ type: 'NEXT_PHASE', player: 1 });
  e.apply({ type: 'SUMMON', player: 1, uid: e.player(1).hand[0].uid, zone: 0, pos: 'atk', faceUp: true });
  ok(f.update(e.state, 0) === e.state && played.length === n && !f.holding, 'a small summon is just shown on the board (no cinematic)');
}
{
  // the watchdog: a chain that never reports back still lets the board catch up
  const e = duel();
  const f = new Flow();
  f.update(e.state, 0);
  e.apply({ type: 'ATTACK', player: 0, uid: e.monsters(0)[0].uid, target: null });
  f.update(e.state, 0);
  f.drawn();
  await new Promise((r) => setTimeout(r, START_GRACE_MS + 100));
  ok(f.update(e.state, 0) === e.state, 'a chain whose cinematic never starts lets the board catch up after the start grace');
  f.dispose();
}
{
  // the watchdog runs from the moment the cinematic starts, for its own length + slack
  const e = duel();
  const f = new Flow();
  f.update(e.state, 0);
  e.apply({ type: 'ATTACK', player: 0, uid: e.monsters(0)[0].uid, target: null });
  f.update(e.state, 0);
  f.drawn();
  const p = played[played.length - 1];
  await new Promise((r) => setTimeout(r, 300));
  f.started(p.batch + 1000, 0.1); // another chain: ignored
  f.started(p.batch, 0.4);
  await new Promise((r) => setTimeout(r, 0.4 * 1000 + WATCHDOG_SLACK_MS - 300));
  ok(f.holding, 'the board still waits while the started cinematic (plus slack) is not over');
  await new Promise((r) => setTimeout(r, 450));
  ok(!f.holding && f.update(e.state, 0) === e.state, `then it catches up (${0.4 * 1000 + WATCHDOG_SLACK_MS} ms after the start, not ${START_GRACE_MS} ms after the queueing)`);
  f.dispose();
}
{
  // a long cinematic is not cut short by the watchdog
  const e = duel();
  const f = new Flow();
  f.update(e.state, 0);
  e.apply({ type: 'ATTACK', player: 0, uid: e.monsters(0)[0].uid, target: null });
  f.update(e.state, 0);
  f.drawn();
  const p = played[played.length - 1];
  f.started(p.batch, (START_GRACE_MS + 1000) / 1000);
  await new Promise((r) => setTimeout(r, START_GRACE_MS + 300));
  ok(f.holding, 'a cinematic longer than the start grace keeps the board until it is over');
  f.commit(p.batch, true);
  ok(!f.holding, 'and lets it go when it ends');
  f.dispose();
}

{
  // the result waits for the Life Points to count down to 0
  const e = duel();
  const f = new Flow();
  let redraws = 0;
  f.rerender = () => redraws++;
  f.update(e.state, 0);
  e.state.players[1].lp = 0;
  e.state.winner = 0;
  const s1 = f.update(e.state, 0);
  ok(lp(s1, 1) === 0 && s1.winner === null && f.winPending, 'a won duel shows its last Life Points first, without the result');
  await new Promise((r) => setTimeout(r, LP_TICK_MS - 150));
  ok(f.update(e.state, 0).winner === null, 'still no result while the count is running');
  f.flushAll();
  ok(f.update(e.state, 0).winner === null, 'a tap before the count reads 0 does not jump to the result');
  await new Promise((r) => setTimeout(r, 150 + WIN_AFTER_LP_MS + 60));
  ok(f.update(e.state, 0).winner === 0 && !f.winPending && redraws === 1, `then the result shows (${LP_TICK_MS + WIN_AFTER_LP_MS} ms after the LP change)`);
  f.dispose();
}
{
  // a tap once the count has reached 0 goes straight to the result
  const e = duel();
  const f = new Flow();
  f.update(e.state, 0);
  e.state.players[1].lp = 0;
  e.state.winner = 0;
  f.update(e.state, 0);
  await new Promise((r) => setTimeout(r, LP_TICK_MS + 20));
  f.flushAll();
  ok(f.update(e.state, 0).winner === 0, 'a tap after the LP read 0 shows the result at once');
  f.dispose();
}
{
  // a win with no Life Points change (deck out, surrender) shows at once
  const e = duel();
  const f = new Flow();
  f.update(e.state, 0);
  e.state.winner = 1;
  ok(f.update(e.state, 0).winner === 1 && !f.winPending, 'a win without a Life Points change shows its result at once');
  f.dispose();
}

// ---------- the skip pill keeps clear of the bar's contents ----------
{
  // 412 wide: avatar, a short name, Skill, LP, menu
  const bar: [number, number][] = [
    [4, 48],
    [44, 110],
    [250, 304],
    [300, 360],
    [356, 408],
  ];
  const s = skipSpot(bar, 0, 412, 412);
  const clear = (l: number) => bar.every(([a, b]) => l + SKIP_W <= a || l >= b);
  ok(!s.below && clear(s.left) && s.left === 134, `in the gap between the name and Skill, as central as it fits (left ${s.left})`);
  // 390 wide: the name runs up to Skill, so no gap is wide enough
  const full: [number, number][] = [
    [4, 48],
    [44, 120],
    [196, 250],
    [262, 340],
    [336, 386],
  ];
  const f = skipSpot(full, 0, 390, 390);
  ok(f.below, `no gap between the name and Skill (390 wide): below the bar (left ${f.left})`);
  const tight: [number, number][] = [
    [4, 48],
    [44, 150],
    [160, 214],
    [220, 320],
    [316, 371],
  ];
  const t = skipSpot(tight, 0, 375, 375);
  ok(t.below && Math.abs(t.left + SKIP_W / 2 - 187.5) < 1, 'no gap wide enough (375 wide): below the bar, centred');
  const open = skipSpot([[300, 380]], 0, 390, 390);
  ok(!open.below && Math.abs(open.left + SKIP_W / 2 - 195) < 1, 'an empty middle: centred');
}

// ---------- the busy flag, the focus (field figures step aside) and its listeners ----------
{
  let calls = 0;
  const off = onArtChange(() => calls++);
  setArtBusy(false);
  clearArtFocus();
  const c0 = calls;
  setArtBusy(true);
  setArtBusy(true);
  ok(artBusy() && calls === c0 + 1, 'listeners hear the busy flag change (once per change, no polling)');
  const a = ref('A', 0, 11);
  const t = ref('B', 1, 12);
  ok(cueUids({ kind: 'attack', attacker: a, target: t, defender: 1 }).join() === '11,12', 'an attack is about its attacker and its target');
  ok(cueUids({ kind: 'hit', attacker: null, target: null, defender: 1 }).length === 0 && cueUids({ kind: 'damage', player: 0, amount: 100 }).length === 0, 'damage and an unknown hit put no monster on stage');
  focusArt([11, 12]);
  ok(artFocus().has(11) && artFocus().has(12) && !artFocus().has(13) && calls === c0 + 2, 'only the monsters in the cinematic step aside; bystanders keep standing');
  setArtBusy(false);
  ok(artFocus().size === 2 && artFocus().has(11), 'the computer going on does not bring them back while the stage still shows them');
  clearArtFocus();
  ok(artFocus().size === 0 && calls === c0 + 4, 'they come back when the stage is done');
  off();
  setArtBusy(true);
  ok(calls === c0 + 4, 'an unsubscribed listener hears nothing');
  setArtBusy(false);
}
{
  const once = bannerOnce();
  ok(once('Burst Stream!') && !once('Burst Stream!') && once('Dark Magic!'), 'the same banner twice at once shows once');
}

if (fails) {
  console.log(`${fails} FAILED`);
  process.exit(1);
}
console.log('ALL OK');
