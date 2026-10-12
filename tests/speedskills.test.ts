// Speed Duel Skills in real duels: every scripted Skill is brought to random Speed Duels
// (random decks, random or computer players). Checks nothing throws or gets stuck and
// reports Skills that were never used. Run: npx tsx tests/speedskills.test.ts [games] [--skill "Name"]
import { SKILLS } from '../src/eds/skills';
import type { Action, Pid } from '../src/eds/types';
import type { Engine } from '../src/eds/engine';
import { PLAYABLE, aiAction, getEffect, pick, playDuel, randomAction, setSeed } from './speedkit';

const args = process.argv.slice(2);
const GAMES = Number(args.find((a) => /^\d+$/.test(a)) ?? 300);
const only = args.includes('--skill') ? args[args.indexOf('--skill') + 1] : null;
setSeed(Number(process.env.SEED ?? 77));
const names = Object.keys(SKILLS).filter((n) => !only || n === only);
if (!names.length) {
  console.log('no Skills scripted yet');
  process.exit(only ? 1 : 0);
}
const supported = PLAYABLE.filter((c) => c.vanilla || !!getEffect(c.name));
const main = supported.filter((c) => c.sub !== 'Fusion').map((c) => c.name);
const extra = supported.filter((c) => c.sub === 'Fusion').map((c) => c.name);
/** A deck for a Skill: cards that share words with the Skill text (archetypes), padded with anything. */
function deckFor(skill: string): string[] {
  const text = (SKILL_TEXT[skill] ?? '') + ' ' + skill;
  const quoted = [...text.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]);
  const related = main.filter((n) => quoted.some((q) => n.includes(q)));
  const out: string[] = [];
  for (let i = 0; i < 24; i++) out.push(related.length && i % 2 === 0 ? pick(related) : pick(main));
  return out;
}
import { readFileSync } from 'node:fs';
const SKILL_TEXT: Record<string, string> = Object.fromEntries((JSON.parse(readFileSync('public/cards/speed.json', 'utf8')) as any[]).filter((r) => r.type === 'Skill Card').map((r) => [r.name, r.desc]));

const usedSkills = new Set<string>();
let failures = 0;
for (let g = 0; g < GAMES; g++) {
  const s0 = names[g % names.length];
  const s1 = pick(names);
  const brains: ((e: Engine, p: Pid) => Action | null)[] = g % 2 ? [randomAction, randomAction] : [randomAction, aiAction];
  const r = playDuel([deckFor(s0), deckFor(s1)], [Array.from({ length: 6 }, () => pick(extra)), Array.from({ length: 6 }, () => pick(extra))], [s0, s1], g, brains);
  for (const p of [0, 1] as Pid[]) if ((r.engine.player(p).skillUses ?? 0) > 0 || r.engine.player(p).skillRevealed) usedSkills.add(r.engine.player(p).skill!);
  if (r.fail) {
    failures++;
    console.log(`FAIL game ${g} (${s0} vs ${s1}): ${r.fail}`);
  }
}
const unused = names.filter((n) => !usedSkills.has(n));
console.log(`${GAMES} duels, ${names.length} Skills; never used/revealed (${unused.length}): ${unused.join(', ')}`);
console.log(failures ? `${failures} FAILURES` : 'ALL OK');
process.exit(failures ? 1 : 0);
