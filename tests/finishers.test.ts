// Signature finishers: the winning blow's replay is styled after the attacker's Type
// (run: npx tsx tests/finishers.test.ts).
import { readFileSync } from 'node:fs';
import { finaleFor, finisherFor, FINISHER_TITLE, ICONIC, RACE_FINISHER, type FinisherKind } from '../src/art/finishers';
import { finishingReplay } from '../src/art/flow';
import type { CardRef, Cue } from '../src/art/cues';
import { showDuelAces } from '../src/ace/ace';
import { FINISHER_CHARGE, FINISHER_KINDS, markShadowSeen, shadowSeen, SHADOW_REPEAT_RATE } from '../src/art/runtime';

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
check(shadowSeen() === false, 'starting one (or skipping it) does not count as having seen it');
markShadowSeen();
check(shadowSeen() === true, 'once watched through, later ones play faster');
check(SHADOW_REPEAT_RATE > 1.2 && SHADOW_REPEAT_RATE < 2, `a repeat is ${Math.round((1 - 1 / SHADOW_REPEAT_RATE) * 100)}% shorter`);

// ---------- ending cutscenes ----------
// every iconic monster is a real card in the Speed Duel pool
const names = new Set(pool.map((c) => c.name));
const notInPool = Object.keys(ICONIC).filter((n) => !names.has(n));
check(notInPool.length === 0, `every iconic cutscene monster is in the Speed Duel pool${notInPool.length ? ` (missing: ${notInPool.join(', ')})` : ''}`);
check(Object.values(ICONIC).every((i) => i.line.length > 0 && i.line.length <= 28), 'every title line is short enough for an iPhone SE');
check(finisherFor({ kind: 'monster', race: 'Fiend', attribute: 'DARK' }, 'Summoned Skull')?.kind === 'storm', 'an iconic card keeps its own move (Summoned Skull calls lightning)');
check(finisherFor({ kind: 'monster', race: 'Fiend', attribute: 'DARK' }, 'Summoned Skull')?.title === 'THUNDER JUDGMENT', "its own move goes by that move's name");
check(finisherFor({ kind: 'monster', race: 'Dragon', attribute: 'LIGHT' }, 'Blue-Eyes White Dragon')?.kind === 'breath', 'an iconic card without its own move uses its Type');
check(finaleFor('Dark Magician', null)?.lv === 2 && finaleFor('Dark Magician', null)?.ace === false, 'an iconic card gets the cutscene at its own grandeur');
check(finaleFor('Celtic Guardian', null)?.line === 'The elf swordsman', 'it carries its title line');
check(finaleFor('Mystical Elf', null) === null, 'an ordinary card gets no cutscene (its finisher plays alone)');
check(finaleFor('Mystical Elf', { lv: 3 })?.ace === true && finaleFor('Mystical Elf', { lv: 3 })?.lv === 3, 'any Ace gets the cutscene at its bond level');
check(finaleFor('Mystical Elf', { lv: 9 })?.lv === 5 && finaleFor('Mystical Elf', { lv: 0 })?.lv === 1, 'the bond level is kept between 1 and 5');
check(finaleFor('Dark Magician', { lv: 4 })?.line === 'The ultimate wizard', 'an iconic Ace keeps its own line');
check(finaleFor('', { lv: 4 }) === null, 'an unknown card gets no cutscene');

// in the replay: the cutscene plays first, then the finishing blow
const ref = (name: string, controller: 0 | 1): CardRef => ({ uid: name.length + controller * 100, name, faceUp: true, controller, owner: controller, rect: null, def: false });
const blow = (att: CardRef, loser: 0 | 1): Cue[] => [
  { kind: 'attack', attacker: att, target: null } as Cue,
  { kind: 'hit', attacker: att, target: null, defender: loser, dmg: { player: loser, amount: 2000 } },
  { kind: 'win', winner: loser === 1 ? 0 : 1 } as Cue,
];
showDuelAces(null);
let r = finishingReplay(blow(ref('Dark Magician', 0), 1));
check(r.length === 2 && r[0].kind === 'finale' && r[1].kind === 'hit' && r.every((c) => c.replay), 'an iconic finishing blow: its cutscene, then the blow');
r = finishingReplay(blow(ref('Mystical Elf', 0), 1));
check(r.length === 1 && r[0].kind === 'hit', 'an ordinary finishing blow plays its finisher alone');
showDuelAces([{ name: 'Mystical Elf', lv: 4, wins: 30 } as never, null]);
r = finishingReplay(blow(ref('Mystical Elf', 0), 1));
const f = r[0];
check(f?.kind === 'finale' && f.ace && f.lv === 4, "the duelist's Ace gets its cutscene at its bond level");
r = finishingReplay(blow(ref('Mystical Elf', 1), 0));
check(r[0]?.kind === 'hit', "the other duelist's copy of my Ace is not my Ace");
// a suicide attack (the attacker's own player takes the last damage) gets no cutscene
const sk = ref('Dark Magician', 0);
r = finishingReplay([{ kind: 'hit', attacker: sk, target: ref('Gate Guardian', 1), defender: 1, dmg: { player: 0, amount: 4000 } }, { kind: 'win', winner: 1 } as Cue]);
check(!r.some((c) => c.kind === 'finale'), 'a suicide attack gets no cutscene');
showDuelAces([{ name: 'Mystical Elf', lv: 5, wins: 60 } as never, null]);
const stolen = { ...ref('Mystical Elf', 1), owner: 0 as const };
r = finishingReplay(blow(stolen, 0));
check(!r.some((c) => c.kind === 'finale'), 'a taken Ace (Change of Heart) gives its taker no Ace cutscene');
r = finishingReplay(blow(ref('Summoned Skull', 1), 0));
check(r[0]?.kind === 'finale' && r[0].card.controller === 1, "the opponent's iconic monster gets its cutscene too");
showDuelAces(null);
const hidden = { ...ref('Dark Magician', 0), faceUp: false };
r = finishingReplay(blow(hidden, 1));
check(!r.some((c) => c.kind === 'finale'), 'a face-down attacker gets no cutscene');
showDuelAces(null);

console.log(fails ? `\n${fails} FAILED` : '\nall finisher checks passed');
if (fails) process.exit(1);
