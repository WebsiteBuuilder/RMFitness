// How much of the Speed Duel pool the 3D art engine covers (run: npx tsx scripts/art-coverage.ts).
import { readFileSync } from 'node:fs';
import { DB, PLAYABLE, SKILLS } from '../tests/speedkit';
import { SPELL_PRESET_CARDS } from '../src/art/runtime';

const figs = new Set(Object.keys(JSON.parse(readFileSync('public/cards/fig/index.json', 'utf8'))).map(Number));
const presets = new Set(SPELL_PRESET_CARDS);
const mons = PLAYABLE.filter((c) => c.kind === 'monster');
const noFig = mons.filter((c) => !figs.has(c.id));
const st = PLAYABLE.filter((c) => c.kind !== 'monster');
const withPreset = st.filter((c) => presets.has(c.name));
const extra = mons.filter((c) => /Xyz|Synchro|Link|Fusion/.test(c.type ?? ''));
console.log(JSON.stringify({ pool: PLAYABLE.length, db: DB.size, monsters: mons.length, monstersWithFigure: mons.length - noFig.length, spellsTraps: st.length, spellsTrapsWithOwnPreset: withPreset.length, extraDeck: extra.length, skills: SKILLS.length }, null, 1));
console.log('no figure:', noFig.map((c) => `${c.name} (${c.id})`).join('; '));
