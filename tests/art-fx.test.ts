// 3D art engine: every Spell, Trap, monster effect and Skill of the Speed Duel pool has a
// fitting animation (its own preset or its effect family's), every monster has a figure,
// and every summon method and cue kind is drawn (run: npx tsx tests/art-fx.test.ts).
import { readFileSync } from 'node:fs';
import { DB as APP_DB } from '../src/eds/db';
import { classify, fxFamilyOf, FX_FAMILIES, TERRAINS } from '../src/art/families';
import { CUE_KINDS_DRAWN, FAMILY_FX_IDS, SPELL_PRESET_CARDS, SUMMON_METHODS_DRAWN } from '../src/art/runtime';
import { DB, PLAYABLE, SKILLS } from './speedkit';

for (const [k, v] of DB) APP_DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};

const drawn = new Set(FAMILY_FX_IDS);
ok(FX_FAMILIES.every((f) => drawn.has(f.id)), `every effect family (${FX_FAMILIES.length}) has its own cinematic`);

const st = PLAYABLE.filter((c) => c.kind !== 'monster');
const presets = new Set(SPELL_PRESET_CARDS);
const stFam = st.filter((c) => !presets.has(c.name)).map((c) => classify(c));
ok(stFam.every((f) => drawn.has(f.family)), `all ${st.length} Spells/Traps play their own preset (${st.filter((c) => presets.has(c.name)).length}) or a family cinematic (${stFam.length}): 0 generic`);

const effects = PLAYABLE.filter((c) => c.kind === 'monster' && !c.vanilla);
ok(effects.every((c) => drawn.has(classify(c).family)), `all ${effects.length} monster effects have a family`);
ok(SKILLS.length === 124 && SKILLS.every((c) => drawn.has(classify(c).family)), `all ${SKILLS.length} Skills have a family`);

// the families spread: no single family swallows the pool
const count = new Map<string, number>();
for (const c of [...st, ...effects]) count.set(classify(c).family, (count.get(classify(c).family) ?? 0) + 1);
ok(Math.max(...count.values()) < (st.length + effects.length) * 0.2, `families spread out (largest: ${Math.max(...count.values())} of ${st.length + effects.length})`);
ok(count.size === FX_FAMILIES.length, `every family is used (${count.size})`);

// spot checks: what a card does picks its look
const fam = (n: string) => fxFamilyOf(n)?.family;
ok(fam('Mystical Space Typhoon') === 'destroy', 'Mystical Space Typhoon destroys');
ok(fam('Umi') === 'terrain' && fxFamilyOf('Umi')?.terrain === 'ocean', 'Umi paints an ocean');
ok(fxFamilyOf('Yami')?.terrain === 'shadow', 'Yami paints shadows');
ok(fam('Dian Keto the Cure Master') === 'heal', 'Dian Keto heals');
ok(fam('Ookazi') === 'burn', 'Ookazi burns');
ok(fam('Graceful Dice') === 'chance', 'Graceful Dice rolls a die');
ok(fam('Change of Heart') === 'control', 'Change of Heart takes control');
ok(fam('Axe of Despair') === 'equip', 'Axe of Despair is an Equip');
ok(fam('Black Luster Ritual') === 'ritual', 'Black Luster Ritual is a Ritual');
ok(fam('Stray Lambs') === 'token', 'Stray Lambs makes Tokens');
ok(fam('Blue-Eyes White Dragon') === undefined, 'a Normal Monster has no effect to animate');
ok(classify(SKILLS.find((s) => s.name === 'Peak Performance')!).family === 'terrain', 'a field-placing Skill paints its terrain');
ok(TERRAINS.length === 10, 'ten terrains');

// the same card always plays the same way (both phones agree)
ok(JSON.stringify(st.map((c) => classify(c))) === JSON.stringify(st.map((c) => classify(c))), 'classification is deterministic');

// every monster stands up in 3D
const figs = new Set(Object.keys(JSON.parse(readFileSync('public/cards/fig/index.json', 'utf8'))).map(Number));
const mons = PLAYABLE.filter((c) => c.kind === 'monster');
const noFig = mons.filter((c) => !figs.has(c.id));
ok(noFig.length === 0, `all ${mons.length} monsters have a figure map${noFig.length ? ` (missing: ${noFig.map((c) => c.name).join(', ')})` : ''}`);
ok(figs.has(70821187), 'Regenerating Mummy keeps its figure map');

// summons and the new cues
for (const m of ['tribute', 'special', 'fusion', 'ritual', 'xyz', 'synchro', 'link'] as const) ok(SUMMON_METHODS_DRAWN.includes(m), `${m} summons have their own shot`);
for (const k of ['leave', 'heal', 'draw'] as const) ok(CUE_KINDS_DRAWN.includes(k), `the ${k} cue is drawn`);

console.log(fails ? `\n${fails} FAILED` : '\nall art-fx checks passed');
if (fails) process.exit(1);
