// 3D art engine: per-card designs, the event feed, cues and the Shadow Realm
// (run: npx tsx tests/art.test.ts). Rendering itself is checked in a browser.
import { Engine } from '../src/eds/engine';
import { card, DB as APP_DB } from '../src/eds/db';
import type { DuelState, Pid } from '../src/eds/types';
import { profileFor } from '../src/art/profile';
import { memoField, toCues, type CueTrack } from '../src/art/cues';
import { OVERKILL_MARGIN, sealPick, sealedCards, cpuSealedCards, shadowRealmOf, unsealedCpuMain, unsealedDeck, withShadow } from '../src/art/shadow';
import { newSpeedSave } from '../src/eds/speedSave';
import { DB, SPEED } from './speedkit';

// The app's card lookup reads its own map: fill it from the test kit.
for (const [k, v] of DB) APP_DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};

// ---------- every card gets its own design ----------
const monsters = SPEED.filter((c) => c.kind === 'monster');
const a1 = profileFor(card('Blue-Eyes White Dragon'), 'Blue-Eyes White Dragon');
const a2 = profileFor(card('Blue-Eyes White Dragon'), 'Blue-Eyes White Dragon');
ok(JSON.stringify(a1) === JSON.stringify(a2), 'the same card always gets the same design (both phones agree)');
ok(a1.attackName === 'Burst Stream of Destruction' && a1.style === 'beam', 'Blue-Eyes keeps its signature attack');
const keys = new Set(monsters.map((c) => {
  const p = profileFor(c, c.name);
  return [p.attackName, p.style, p.style2, p.entrance, p.count, p.speed.toFixed(2), p.arc.toFixed(2), p.colors.join()].join('|');
}));
ok(keys.size === monsters.length, `all ${monsters.length} Speed Duel monsters have distinct designs (${keys.size} unique)`);
const names = new Set(monsters.map((c) => profileFor(c, c.name).attackName));
ok(names.size > monsters.length * 0.4, `attack names vary widely (${names.size} different names)`);
const fire = monsters.filter((c) => c.attribute === 'FIRE').map((c) => profileFor(c, c.name));
ok(fire.every((p) => p.element === 'FIRE'), 'FIRE monsters use the fire element');

// ---------- the engine's event feed ----------
const strongest = SPEED.filter((c) => c.kind === 'monster' && c.sub === 'Normal' && (c.level ?? 0) <= 4).sort((a, b) => (b.atk ?? 0) - (a.atk ?? 0));
const big = strongest[0];
const small = strongest[strongest.length - 1];
const deckOf = (n: string, k = 20) => Array<string>(k).fill(n);
function duel(): Engine {
  const e = new Engine(DB);
  e.apply({ type: 'START', first: 0, seed: 7, names: ['Jammy', 'Brother'], decks: [deckOf(big.name), [...deckOf(small.name, 19), big.name]], fusions: [[], []], mode: 'speed', skills: [null, null] });
  const c = e.player(0).hand[0];
  e.apply({ type: 'SUMMON', player: 0, uid: c.uid, zone: 0, pos: 'atk', faceUp: true });
  e.apply({ type: 'END_TURN', player: 0 });
  e.apply({ type: 'END_TURN', player: 1 });
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  if (e.state.phase !== 'BP') e.apply({ type: 'NEXT_PHASE', player: 0 });
  return e;
}
{
  const e = duel();
  const before = e.state.events!.at(-1)!.seq;
  const m = e.monsters(0)[0];
  e.apply({ type: 'ATTACK', player: 0, uid: m.uid, target: null });
  const evs = e.state.events!.filter((x) => x.seq > before);
  ok(evs.some((x) => x.kind === 'attack' && x.target === null), 'attack events say who was attacked (direct here)');
  const dmg = evs.find((x) => x.kind === 'damage');
  ok(!!dmg && dmg.from === 4000 && dmg.amount === big.atk, 'damage events carry the LP before the hit');
  ok(e.state.events!.length <= 40, 'the event feed stays short');
  const track: CueTrack = { battle: null };
  const cues = toCues(evs, e.state, 0, null, new Map(), track);
  ok(cues.map((c) => c.kind).join() === 'attack,hit,damage', `a direct attack becomes attack → hit → damage cues (${cues.map((c) => c.kind).join()})`);
  const hit = cues.find((c) => c.kind === 'hit');
  ok(hit?.kind === 'hit' && hit.attacker?.uid === m.uid && hit.target === null, 'the hit knows its attacker');
}

{
  // A face-down defender that is flipped and destroyed by the attack is still face-down
  // (and unnamed) in the attack cue: the flip cinematic reveals it, not the attack.
  const e = new Engine(DB);
  e.apply({ type: 'START', first: 0, seed: 7, names: ['Jammy', 'Brother'], decks: [deckOf(big.name), deckOf(small.name)], fusions: [[], []], mode: 'speed', skills: [null, null] });
  e.apply({ type: 'SUMMON', player: 0, uid: e.player(0).hand[0].uid, zone: 0, pos: 'atk', faceUp: true });
  e.apply({ type: 'END_TURN', player: 0 });
  e.apply({ type: 'SUMMON', player: 1, uid: e.player(1).hand[0].uid, zone: 0, pos: 'def', faceUp: false });
  e.apply({ type: 'END_TURN', player: 1 });
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  if (e.state.phase !== 'BP') e.apply({ type: 'NEXT_PHASE', player: 0 });
  const def = e.monsters(1)[0];
  const memo = memoField(e.state, 0, null);
  const before = e.state.events!.at(-1)!.seq;
  e.apply({ type: 'ATTACK', player: 0, uid: e.monsters(0)[0].uid, target: def.uid });
  const gone = !e.monsters(1).some((m) => m.uid === def.uid);
  const cues = toCues(e.state.events!.filter((x) => x.seq > before), e.state, 0, null, memo, { battle: null });
  const atk = cues.find((c) => c.kind === 'attack');
  ok(gone, 'the face-down defender is destroyed by the attack');
  ok(atk?.kind === 'attack' && atk.target?.uid === def.uid && !atk.target.faceUp && atk.target.name === '', 'the attack cue keeps a destroyed face-down defender face-down and unnamed');
  ok(cues.some((c) => c.kind === 'destroy' && c.card.uid === def.uid), 'it still gets its destruction');
}

// ---------- the Shadow Realm ----------
function finish(lp: number): DuelState {
  const e = duel();
  e.player(1).lp = lp;
  e.apply({ type: 'ATTACK', player: 0, uid: e.monsters(0)[0].uid, target: null });
  return e.state;
}
{
  const atk = big.atk ?? 0;
  const over = finish(atk - OVERKILL_MARGIN);
  const sr = shadowRealmOf(over);
  ok(over.winner === 0 && !!sr, `${OVERKILL_MARGIN} past 0 sends the loser to the Shadow Realm`);
  ok(sr?.loser === 1 && sr.excess === OVERKILL_MARGIN && sr.loserName === 'Brother', 'it names the loser and the overkill');
  ok(sr?.sealed === big.name, `the loser's strongest monster is the one sealed (${sr?.sealed})`);
  ok(sealPick(over, 1) === big.name, 'sealPick looks at every card the loser brought, wherever it is');
  const near = finish(atk - OVERKILL_MARGIN + 1);
  ok(near.winner === 0 && shadowRealmOf(near) === null, 'one point short of the margin is a plain win');
  const cues = toCues(over.events!.slice(-3), over, 0, null, new Map());
  ok(cues.some((c) => c.kind === 'win' && !!c.shadow), 'the win cue carries the Shadow Realm result');

  // the stake
  let s = newSpeedSave();
  let ch = withShadow(s, 'l', sr, 1, 'Jammy', false, 1);
  ok(ch.lost === big.name && sealedCards(ch.save).length === 1, 'the loser loses their best monster');
  s = ch.save;
  const d = unsealedDeck(s, { main: [big.name, big.name, small.name] });
  ok(d.main.join() === small.name, 'sealed cards sit out of the deck as dealt');
  ch = withShadow(s, 'w', null, 1, 'Jammy', false, 2);
  ok(ch.freed === big.name && sealedCards(ch.save).length === 0, 'the next win frees it');
  s = newSpeedSave();
  for (let i = 0; i < 5; i++) s = withShadow(s, 'l', { ...sr!, sealed: `Card ${i}` }, 1, 'Jammy', false, i).save;
  ok(sealedCards(s).map((x) => x.name).join() === 'Card 2,Card 3,Card 4', 'at most 3 sealed at once, oldest returns first');
  ok(withShadow(newSpeedSave(), 'w', sr, 0, 'Brother', false).lost === null, 'the winner loses nothing');
  // against the computer
  let cs = withShadow(newSpeedSave(), 'w', sr, 0, 'Téa Gardner', true).save;
  ok(cpuSealedCards(cs, 'Tea Gardner')[0]?.name === big.name, "beating the computer by overkill seals the computer's card (accents ignored)");
  ok(unsealedCpuMain(cs, 'Téa Gardner', [big.name, small.name]).join() === small.name, "and it sits out of that computer's deck");
  cs = withShadow(cs, 'l', null, 0, 'Tea Gardner', true).save;
  ok(cpuSealedCards(cs, 'Tea Gardner').length === 0, 'the computer frees it by winning');
  ok(shadowRealmOf({ ...over, rules: { ...over.rules!, mode: 'eds' } }) === null, 'Eternal Duelist Soul duels never send anyone');
}

console.log(fails ? `${fails} FAILED` : 'ALL OK');
if (fails) process.exit(1);
void (0 as Pid);
