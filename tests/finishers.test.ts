// Signature finishers: the winning blow's replay is styled after the attacker's Type
// (run: npx tsx tests/finishers.test.ts).
import { readFileSync } from 'node:fs';
import { finisherFor, FINISHER_TITLE, RACE_FINISHER, type FinisherKind } from '../src/art/finishers';
import { FINISHER_CHARGE, FINISHER_KINDS, shadowSeen, SHADOW_REPEAT_RATE } from '../src/art/runtime';

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};

// every monster Type in the Speed Duel pool has its own finisher (no Type falls to the default)
const pool = JSON.parse(readFileSync(new URL('../public/cards/speed.json', import.meta.url), 'utf8')) as { type: string; race?: string; name: string }[];
const races = [...new Set(pool.filter((c) => /Monster/.test(c.type)).map((c) => c.race ?? ''))];
check(races.length >= 20, `the pool has its monster Types (${races.length})`);
const missing = races.filter((r) => !RACE_FINISHER[r]);
check(missing.length === 0, `every Type in the pool has a finisher${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);

// the classic matchups
const kind = (race: string, attribute = 'LIGHT') => finisherFor({ kind: 'monster', race, attribute })?.kind;
check(kind('Dragon') === 'breath', 'a Dragon breathes');
check(kind('Spellcaster', 'DARK') === 'arcane', 'a Spellcaster fires through spell circles');
check(kind('Warrior', 'EARTH') === 'blade', 'a Warrior cuts');
check(kind('Machine') === 'salvo', 'a Machine fires a salvo');
check(kind('Fiend', 'DARK') === 'curse' && kind('Zombie', 'DARK') === 'curse', 'Fiends and Zombies drag their target down');
check(kind('Pyro', 'FIRE') === 'meteor', 'a Pyro drops a meteor');
check(kind('Thunder') === 'storm', 'a Thunder monster calls a storm');
check(kind('Fairy') === 'holy', 'a Fairy brings down a pillar of light');

// a Type the table does not know: its Attribute decides; nothing at all: a cut
check(kind('Illusion', 'FIRE') === 'meteor' && kind('Illusion', 'WATER') === 'tide', 'an unknown Type falls back on its Attribute');
check(finisherFor({ kind: 'monster', race: '', attribute: '' })?.kind === 'blade' && !!finisherFor(undefined), 'no Type and no Attribute still gets a finisher');
check(finisherFor({ kind: 'spell', race: 'Normal', attribute: '' }) === null, 'a Spell has no finisher');

// names
check(finisherFor({ kind: 'monster', race: 'Dragon', attribute: 'LIGHT' })?.title === 'DRAGON BREATH', 'the Dragon finisher is called DRAGON BREATH');
check(finisherFor({ kind: 'monster', race: 'Plant', attribute: 'EARTH' })?.title === 'THORN STORM', 'Plants keep the swarm look under their own name');
check(Object.values(FINISHER_TITLE).every((t) => t.length > 0 && t.length <= 18 && t === t.toUpperCase()), 'every title is short and in capitals (it fits an iPhone SE banner)');

// every kind has a cinematic, and the wind-up stays short (the win must not drag)
const kinds = Object.keys(FINISHER_TITLE) as FinisherKind[];
check(kinds.every((k) => FINISHER_KINDS.includes(k)) && FINISHER_KINDS.length === kinds.length, 'every finisher kind has a cinematic');
check(FINISHER_CHARGE > 0.3 && FINISHER_CHARGE < 0.9, `the finisher's wind-up is short (${FINISHER_CHARGE}s)`);

// the Shadow Realm finish: full length the first time, faster after that
check(shadowSeen() === false, 'the first Shadow Realm finish plays at full length');
check(shadowSeen() === true && shadowSeen() === true, 'later ones play faster');
check(SHADOW_REPEAT_RATE > 1.2 && SHADOW_REPEAT_RATE < 2, `a repeat is ${Math.round((1 - 1 / SHADOW_REPEAT_RATE) * 100)}% shorter`);

console.log(fails ? `\n${fails} FAILED` : '\nall finisher checks passed');
if (fails) process.exit(1);
