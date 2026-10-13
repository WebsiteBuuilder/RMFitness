// How every card of the Speed Duel pool is animated (run: npx tsx scripts/art-fx-coverage.ts):
// monster figures, Spells/Traps by own preset / effect family / generic, monster effects and
// Skills by family, and the summon methods and cue kinds the director draws. Target: 0 generic.
import { readFileSync } from 'node:fs';
import { PLAYABLE, SKILLS } from '../tests/speedkit';
import { classify, FX_FAMILIES, type FxFamily } from '../src/art/families';
import { CUE_KINDS_DRAWN, FAMILY_FX_IDS, SPELL_PRESET_CARDS, SUMMON_METHODS_DRAWN } from '../src/art/runtime';

const figs = new Set(Object.keys(JSON.parse(readFileSync('public/cards/fig/index.json', 'utf8'))).map(Number));
const presets = new Set(SPELL_PRESET_CARDS);
const drawn = new Set<FxFamily>(FAMILY_FX_IDS);
const label = (f: FxFamily) => FX_FAMILIES.find((x) => x.id === f)?.label ?? f;
const tally = (cards: typeof PLAYABLE) => {
  const by: Record<string, number> = {};
  let generic = 0;
  for (const c of cards) {
    const f = classify(c).family;
    if (!drawn.has(f)) generic++;
    by[f] = (by[f] ?? 0) + 1;
  }
  return { by, generic };
};

const mons = PLAYABLE.filter((c) => c.kind === 'monster');
const noFig = mons.filter((c) => !figs.has(c.id));
const st = PLAYABLE.filter((c) => c.kind !== 'monster');
const own = st.filter((c) => presets.has(c.name));
const stFam = tally(st.filter((c) => !presets.has(c.name)));
const effects = mons.filter((c) => !c.vanilla);
const monFam = tally(effects);
const skillFam = tally(SKILLS);
const extra = mons.filter((c) => /Xyz|Synchro|Link/.test(c.sub));

console.log('Monsters:', mons.length, '· with a figure:', mons.length - noFig.length, noFig.length ? `(missing: ${noFig.map((c) => `${c.name} ${c.id}`).join('; ')})` : '');
console.log('  Xyz/Synchro/Link with a figure:', extra.filter((c) => figs.has(c.id)).length, '/', extra.length);
console.log('Spells/Traps:', st.length, '· own preset:', own.length, '· effect family:', st.length - own.length - stFam.generic, '· generic:', stFam.generic);
console.log('Monster effects:', effects.length, '(no effect:', mons.length - effects.length, ') · generic:', monFam.generic);
console.log('Skills:', SKILLS.length, '· generic:', skillFam.generic);
console.log('\nFamily                 S/T  Mon  Skill');
for (const f of FX_FAMILIES) console.log(`${label(f.id).padEnd(22)} ${String(stFam.by[f.id] ?? 0).padStart(4)} ${String(monFam.by[f.id] ?? 0).padStart(4)} ${String(skillFam.by[f.id] ?? 0).padStart(5)}`);
console.log('\nSummon methods with their own shot:', SUMMON_METHODS_DRAWN.join(', '), '(normal: the plain summon)');
console.log('Cue kinds drawn:', CUE_KINDS_DRAWN.join(', '));
const generic = stFam.generic + monFam.generic + skillFam.generic;
console.log(`\nGeneric (no fitting animation): ${generic}`);
if (generic || noFig.length) process.exitCode = 1;
