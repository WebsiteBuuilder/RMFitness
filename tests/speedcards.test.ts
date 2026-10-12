// Speed Duel cards in real duels: random 20-30 card decks from the Speed Duel pool,
// played out by a random player against another random player or the computer.
// Checks that nothing throws, no duel gets stuck, cards are never lost or duplicated,
// and reports scripts that never ran.
// Run: npx tsx tests/speedcards.test.ts [games] [--batch NN] [--cards "Name A|Name B"]
import { EFFECT_TABLE, getEffect } from '../src/eds/effects';
import { SPEED_BATCH } from '../src/eds/speed';
import type { Action, Pid } from '../src/eds/types';
import type { Engine } from '../src/eds/engine';
import { PLAYABLE, aiAction, pick, playDuel, randomAction, setSeed, shuffle } from './speedkit';

const args = process.argv.slice(2);
const GAMES = Number(args.find((a) => /^\d+$/.test(a)) ?? 200);
const batch = args.includes('--batch') ? args[args.indexOf('--batch') + 1] : null;
const only = args.includes('--cards') ? args[args.indexOf('--cards') + 1].split('|') : null;
setSeed(Number(process.env.SEED ?? 4242));

// Count every call into each card's script, so we know its code really ran.
const calls = new Map<object, Map<string, number>>();
const wrapped = new WeakSet<object>();
function wrap(obj: any, root: object, path: string, depth: number) {
  if (!obj || typeof obj !== 'object' || wrapped.has(obj) || depth > 2) return;
  wrapped.add(obj);
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'function') {
      obj[k] = function (this: unknown, ...a: unknown[]) {
        let m = calls.get(root);
        if (!m) calls.set(root, (m = new Map()));
        m.set(path + k, (m.get(path + k) ?? 0) + 1);
        return v.apply(this, a);
      };
    } else if (v && typeof v === 'object' && !Array.isArray(v)) wrap(v, root, path + k + '.', depth + 1);
  }
}
for (const d of Object.values(EFFECT_TABLE)) wrap(d, d, '', 0);

const supported = PLAYABLE.filter((c) => c.vanilla || !!getEffect(c.name));
const focus = supported.filter((c) => (batch ? SPEED_BATCH[c.name] === batch : only ? only.includes(c.name) : true));
if (!focus.length) {
  console.log('no cards to test');
  process.exit(1);
}
const isExtra = (c: { sub: string }) => c.sub === 'Fusion';
const focusMain = focus.filter((c) => !isExtra(c)).map((c) => c.name);
const focusExtra = focus.filter(isExtra).map((c) => c.name);
const fillMain = supported.filter((c) => !isExtra(c)).map((c) => c.name);
const fillExtra = supported.filter(isExtra).map((c) => c.name);
// Reliable beaters so duels reach the cards' effects.
const beaters = supported.filter((c) => c.kind === 'monster' && c.sub === 'Normal' && (c.level ?? 0) <= 4 && (c.atk ?? 0) >= 1400).map((c) => c.name);

let queue: string[] = [];
function deck(): string[] {
  const size = 20 + Math.floor(Math.random() * 11);
  const out: string[] = [];
  const nFocus = focus.length === supported.length ? size - 4 : Math.ceil(size * 0.6);
  while (out.length < nFocus && focusMain.length) {
    if (!queue.length) queue = shuffle(focusMain);
    out.push(queue.pop()!);
  }
  while (out.length < size - 4) out.push(pick(fillMain));
  while (out.length < size) out.push(pick(beaters));
  return out;
}
function extra(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 6; i++) out.push(focusExtra.length && i < 4 ? pick(focusExtra) : pick(fillExtra));
  return out;
}

let failures = 0;
let total = 0;
const t0 = Date.now();
const seen = new Set<string>();
for (let g = 0; g < GAMES; g++) {
  const decks: [string[], string[]] = [deck(), deck()];
  const extras: [string[], string[]] = [extra(), extra()];
  for (const d of [...decks, ...extras]) for (const n of d) seen.add(n);
  const brains: ((e: Engine, p: Pid) => Action | null)[] = g % 2 ? [randomAction, randomAction] : [randomAction, aiAction];
  const r = playDuel(decks, extras, [null, null], g, brains);
  total += r.actions;
  if (r.fail) {
    failures++;
    console.log(`FAIL game ${g} (T${r.engine.state.turn}): ${r.fail}`);
  }
}

console.log(`${GAMES} Speed Duels, ${seen.size} different cards dealt, avg ${Math.round(total / GAMES)} actions, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const QUESTION = /^(can|quick\.can|graveIgnition\.can|condition|canActivate|targetFilter|cannotAttack|blocksAttack|attackInDefense|directAttack|baseStats|aura|bonus|defenseMult|fusionSub|activateCost\.can|attackTax\.can|summonProc\.can|handIgnition\.can|ignition\.can|cannotBeTargeted|battleProof|effectProof|noBattleDamage|attacks|piercing|selfBonus|equipBonus|blocksAttacks)$/;
const neverRan: string[] = [];
const report: string[] = [];
for (const c of focus) {
  const d = getEffect(c.name);
  if (!d || !seen.has(c.name)) continue;
  const fnKeys: string[] = [];
  const collect = (o: any, path: string, depth: number) => {
    for (const k of Object.keys(o)) {
      if (typeof o[k] === 'function') fnKeys.push(path + k);
      else if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) && depth < 2) collect(o[k], path + k + '.', depth + 1);
    }
  };
  collect(d, '', 0);
  if (!fnKeys.length) continue;
  const got = calls.get(d) ?? new Map();
  const doing = fnKeys.filter((k) => !QUESTION.test(k));
  if (![...got.keys()].length) neverRan.push(c.name);
  else if (doing.length && !doing.some((k) => got.has(k))) report.push(`${c.name} [${doing.join(',')}]`);
}
console.log(`focus cards: ${focus.length}; scripts that never ran (${neverRan.length}):`, neverRan.join(', '));
console.log(`checks ran but the effect never resolved (${report.length}):`);
for (const r of report) console.log('  ' + r);
console.log(failures ? `${failures} FAILURES` : 'ALL OK');
process.exit(failures ? 1 : 0);
