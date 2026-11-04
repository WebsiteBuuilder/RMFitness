// Battle scars on the mat: every landed attack leaves its Attribute's mark for the rest of the duel
// (run: npx tsx tests/matscars.test.ts).
import { Engine } from '../src/eds/engine';
import { DB as APP_DB } from '../src/eds/db';
import type { FieldCard, Pid } from '../src/eds/types';
import { ATTRS, SCAR_CAP, attrCode, attrOfCode, scarsOf, type Scar, type ScarAttr } from '../src/eds/scars';
import { LAYERS, scarAge, scarMark, type ScarGeo } from '../src/ui/matScarsRules';
import { DB } from './speedkit';

for (const [k, v] of DB) APP_DB.set(k, v);

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};
const FILL = 'Celtic Guardian'; // EARTH
const SKULL = 'Summoned Skull'; // DARK

function settle(e: Engine) {
  for (let i = 0; i < 400 && e.state.prompt && e.state.winner === null; i++) {
    const pr = e.state.prompt;
    if (pr.kind === 'yesno') e.apply({ type: 'NO', player: pr.player });
    else if (pr.kind === 'response') e.apply({ type: 'PASS', player: pr.player });
    else e.apply({ type: 'CHOOSE', player: pr.player, picks: pr.options.map((_, j) => j).slice(0, Math.max(1, pr.min)) });
  }
}
function duel(mode: 'speed' | 'eds' = 'speed'): Engine {
  const e = new Engine(DB);
  e.shuffle = <T,>(a: T[]) => a.slice();
  const deck = [...Array(6).fill(SKULL), ...Array(34).fill(FILL)];
  e.apply({ type: 'START', first: 0, seed: 1, names: ['A', 'B'], decks: [deck, deck], fusions: [[], []], mode, skills: [null, null] } as any);
  settle(e);
  e.state.firstTurn = false;
  return e;
}
function put(e: Engine, p: Pid, name: string, z: number, pos: 'atk' | 'def' = 'atk'): FieldCard {
  const ps = e.player(p);
  const i = ps.deck.findIndex((c) => c.name === name);
  const [c] = ps.deck.splice(i, 1);
  const fc: FieldCard = { ...c, pos, faceUp: true, placedTurn: -1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
  ps.mz[z] = fc;
  return fc;
}
function attack(e: Engine, p: Pid, uid: number, target: number | null) {
  e.state.phase = 'BP';
  e.state.turnPlayer = p;
  e.apply({ type: 'ATTACK', player: p, uid, target });
  settle(e);
}

// --- the engine records where attacks land
{
  const e = duel();
  check(scarsOf(e.state.fx).length === 0, 'a new duel starts with a clean mat');
  const a = put(e, 0, SKULL, 1);
  const b = put(e, 1, FILL, 2);
  attack(e, 0, a.uid, b.uid);
  let s = scarsOf(e.state.fx);
  check(s.length === 1, 'an attack on a monster leaves one scar');
  check(s[0].by === 0 && s[0].from === 1 && s[0].to === 2 && s[0].attr === 'DARK' && s[0].n === 1, "it records the attacker's side, zone, the target's zone and the attacker's Attribute");

  const c = put(e, 1, SKULL, 0);
  e.player(0).mz[1] = null; // (a direct attack needs an empty field)
  attack(e, 1, c.uid, null);
  s = scarsOf(e.state.fx);
  check(s.length === 2 && s[1].by === 1 && s[1].from === 0 && s[1].to === -1 && s[1].n === 2, 'a direct attack leaves a scar with no target zone');

  // a Defense Position monster that survives still takes the blow
  const d = put(e, 1, FILL, 1, 'def');
  const w = put(e, 0, FILL, 0);
  attack(e, 0, w.uid, d.uid);
  s = scarsOf(e.state.fx);
  check(s.length === 3 && s[2].to === 1 && s[2].attr === 'EARTH', 'an attack into a Defense Position monster scars too, in the attacker’s Attribute');

  // state round trip (online, rejoin, replay)
  const copy = JSON.parse(JSON.stringify(e.state));
  check(JSON.stringify(scarsOf(copy.fx)) === JSON.stringify(s), 'scars survive a JSON round trip unchanged');
}

// --- nothing is recorded when the attack never lands
{
  const e = duel();
  const a = put(e, 0, SKULL, 0);
  e.state.phase = 'MP1';
  e.apply({ type: 'ATTACK', player: 0, uid: a.uid, target: null });
  settle(e);
  check(scarsOf(e.state.fx).length === 0, 'no attack outside the Battle Phase: no scar');
}

// --- the mat keeps the last SCAR_CAP; numbers keep counting
{
  const e = duel();
  const list: number[][] = [];
  for (let k = 1; k <= SCAR_CAP + 5; k++) list.push([0, 0, -1, 2, k]);
  e.state.fx.scars = list.slice(0, SCAR_CAP);
  e.state.fx.scarN = SCAR_CAP;
  const a = put(e, 0, SKULL, 0);
  attack(e, 0, a.uid, null);
  const s = scarsOf(e.state.fx);
  check(s.length === SCAR_CAP, `the mat keeps at most ${SCAR_CAP} scars`);
  check(s[s.length - 1].n === SCAR_CAP + 1 && s[0].n === 2, 'the oldest drops off; the newest keeps counting');
}

// --- Classic EDS duels are untouched
{
  const e = duel('eds');
  const a = put(e, 0, SKULL, 0);
  attack(e, 0, a.uid, null);
  check(scarsOf(e.state.fx).length === 0, 'EDS (non-Speed) duels record no scars');
}

// --- codes
check(ATTRS.every((a) => attrOfCode(attrCode(a)) === a), 'every Attribute round-trips through its code');
check(attrOfCode(attrCode(undefined)) === 'NONE' && attrOfCode(attrCode('LAUGH')) === 'NONE', 'no Attribute: NONE');
check(scarsOf({ scars: [[1, 2, null, 99, 3], 'junk', [0]] }).length === 1 && scarsOf({ scars: [[1, 2, null, 99, 3]] })[0].to === -1, 'damaged scar data is read safely');

// --- the marks
{
  const geo: ScarGeo = { a: { x: 120, y: 300 }, i: { x: 200, y: 160 }, zw: 66, direct: false };
  const all: (ScarAttr)[] = [...ATTRS, 'NONE'];
  for (const attr of all) {
    const sc: Scar = { by: 0, from: 1, to: 2, attr, n: 7 };
    const m1 = scarMark(sc, geo, 42);
    const m2 = scarMark(sc, geo, 42);
    check(JSON.stringify(m1) === JSON.stringify(m2), `${attr}: the same scar draws the same mark on both phones`);
    check(m1.trail.length > 0 && m1.hit.length > 0 && [...m1.trail, ...m1.hit].every(([c, d]) => (LAYERS as readonly string[]).includes(c) && d.length > 8 && !/NaN|Infinity/.test(d)), `${attr}: a trail and a blow, all on known layers, no bad numbers`);
    // everything stays near the blow and the trail (never flung across the board)
    const nums = [...m1.trail, ...m1.hit].flatMap(([, d]) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number));
    const coords = [...m1.trail, ...m1.hit].flatMap(([, d]) => [...d.matchAll(/[ML]\s*(-?[\d.]+) (-?[\d.]+)/g)].map((x) => [+x[1], +x[2]]));
    check(nums.length > 0 && coords.every(([x, y]) => x > 120 - 90 && x < 200 + 90 && y > 160 - 90 && y < 300 + 30), `${attr}: the mark stays round its own lane and zone`);
    const other = scarMark({ ...sc, n: 8 }, geo, 42);
    check(JSON.stringify(other.hit) !== JSON.stringify(m1.hit), `${attr}: two blows of the same kind are not identical`);
  }
  const d = scarMark({ by: 0, from: 1, to: -1, attr: 'FIRE', n: 1 }, { ...geo, direct: true }, 1);
  const n = scarMark({ by: 0, from: 1, to: 2, attr: 'FIRE', n: 1 }, geo, 1);
  check(d.halo.rx > n.halo.rx, 'a direct attack leaves a bigger mark');
  check(scarAge(23, 24) === 1 && scarAge(18, 24) === 1 && scarAge(0, 24) < scarAge(12, 24) && scarAge(0, 24) >= 0.5, 'old scars weather but never vanish');
}

if (fails) {
  console.log(`${fails} battle scar check(s) failed`);
  process.exit(1);
}
console.log('all battle scar checks passed');
