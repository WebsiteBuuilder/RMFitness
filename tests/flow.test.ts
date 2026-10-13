// Cinematic flow: which moments get a cinematic, skipping, and the duel board
// kept in step with the cinematics (run: npx tsx tests/flow.test.ts).
import { Engine } from '../src/eds/engine';
import { DB as APP_DB } from '../src/eds/db';
import type { DuelState, Prompt } from '../src/eds/types';
import { coalesce, toCues, type Cue, type CardRef } from '../src/art/cues';
import { attachArtSink, Flow, pickCues } from '../src/art/flow';
import { Timeline } from '../src/art/runtime';
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
  f.commit(p.batch, false);
  ok(!f.update(e.state, 1).prompt, 'a chain that ends in a choice for the player does not show it mid-way');
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
  await new Promise((r) => setTimeout(r, 4100));
  ok(f.update(e.state, 0) === e.state, 'after 4 s the board catches up even if the cinematic never reports');
  f.dispose();
}

if (fails) {
  console.log(`${fails} FAILED`);
  process.exit(1);
}
console.log('ALL OK');
