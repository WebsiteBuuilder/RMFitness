// How much of the Speed Duel pool the 3D art engine covers (run: npx tsx scripts/art-coverage.ts [games]).
// Part 1: figures and spell presets. Part 2, by count: random Speed Duels whose every batch of
// engine events goes through toCues; per category, the cards seen, the cards that had a cue
// every time, and the cards that ever resolved with no cue.
import { readFileSync } from 'node:fs';
import { DB, PLAYABLE, SKILLS } from '../tests/speedkit';
import { SPELL_PRESET_CARDS } from '../src/art/runtime';
import { SKILL_NAMES, runCoverage, summary, type Tally } from '../tests/artcoverage';

const figs = new Set(Object.keys(JSON.parse(readFileSync('public/cards/fig/index.json', 'utf8'))).map(Number));
const presets = new Set(SPELL_PRESET_CARDS);
const mons = PLAYABLE.filter((c) => c.kind === 'monster');
const noFig = mons.filter((c) => !figs.has(c.id));
const st = PLAYABLE.filter((c) => c.kind !== 'monster');
const withPreset = st.filter((c) => presets.has(c.name));
const extra = mons.filter((c) => /Xyz|Synchro|Link|Fusion/.test(c.sub ?? ''));
console.log(JSON.stringify({ pool: PLAYABLE.length, db: DB.size, monsters: mons.length, monstersWithFigure: mons.length - noFig.length, spellsTraps: st.length, spellsTrapsWithOwnPreset: withPreset.length, extraDeck: extra.length, skills: SKILLS.length, skillsScripted: SKILL_NAMES.length }, null, 1));
console.log('no figure:', noFig.map((c) => `${c.name} (${c.id})`).join('; '));

const games = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 300);
const t0 = Date.now();
const cov = runCoverage(games);
console.log(`\n=== cues by count: ${games} random Speed Duels (${((Date.now() - t0) / 1000).toFixed(0)} s) ===`);
if (cov.fails.length) console.log('duels that broke:', cov.fails.join('\n  '));
const rows: [string, Map<string, Tally>][] = [
  ...[...cov.summons].map(([how, m]): [string, Map<string, Tally>] => [`monsters summoned: ${how}`, m]),
  ...[...cov.activations].map(([k, m]): [string, Map<string, Tally>] => [k === 'monster' ? 'monster effects activated' : `${k}s activated`, m]),
  ...[...cov.effects].map(([k, m]): [string, Map<string, Tally>] => [`${k} effects at work (triggers, continuous)`, m]),
  ['Skills', cov.skills],
];
console.log(`${'category'.padEnd(44)} ${'seen'.padStart(5)} ${'cued'.padStart(5)} ${'silent'.padStart(6)}  times`);
for (const [label, m] of rows) {
  const s = summary(m);
  const times = [...m.values()].reduce((a, t) => a + t.seen, 0);
  console.log(`${label.padEnd(44)} ${String(s.seen).padStart(5)} ${String(s.always).padStart(5)} ${String(s.silent.length).padStart(6)}  ${times}`);
  if (s.silent.length) console.log('   silent:', s.silent.join('; '));
}
for (const [k, t] of [...cov.moves].sort()) console.log(`${k.padEnd(44)} ${String(t.seen).padStart(5)} ${String(t.cued).padStart(5)} ${String(t.seen - t.cued).padStart(6)}  (events)`);
console.log('event kinds with no cue by design:', [...cov.quiet].map(([k, n]) => `${k} ${n}`).join(', '));
console.log('player actions that made no cue at all:', cov.silentActions.size ? [...cov.silentActions].map(([k, n]) => `${k} x${n}`).join(', ') : 'none');
console.log('batches that outgrew the engine event list:', cov.lostEvents, cov.lostWhere.slice(0, 3).join(' | '));

const touched = new Set([...cov.summons.values(), ...cov.activations.values(), ...cov.effects.values()].flatMap((m) => [...m.keys()]));
const effectCards = PLAYABLE.filter((c) => !c.vanilla);
console.log(`\nnon-vanilla pool cards that showed up (summoned / activated / at work): ${effectCards.filter((c) => touched.has(c.name)).length} of ${effectCards.length}`);
const unused = SKILL_NAMES.filter((n) => !cov.skills.has(n));
console.log(`Skills brought ${cov.skillsBrought.size} of ${SKILL_NAMES.length} scripted; used: ${cov.skills.size}; never used in these duels (conditions not met): ${unused.join('; ') || 'none'}`);
const unscripted = SKILLS.map((s) => s.name).filter((n) => !SKILL_NAMES.includes(n));
console.log(`Skill Cards with no script (not playable, so nothing to animate): ${unscripted.length}`);
