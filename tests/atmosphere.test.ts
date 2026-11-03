// Living Field and the Danger state: which landscape a Field Spell keeps up behind the
// duel, when a duelist is in danger, and that the landscape shader stays portable.
import { dangerLevel, fieldTerrain } from '../src/ui/atmosphereRules';
import { FRAG } from '../src/art/livingField';
import { DB } from '../src/eds/db';
import { DB as KIT } from './speedkit';
import { TERRAINS } from '../src/art/families';
import type { DuelState } from '../src/eds/types';

// (the card list as the game builds it: EDS + every Speed Duel product)
for (const [k, v] of KIT) DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};

// --- danger: a quarter of the starting Life Points, then an eighth
ok(dangerLevel(4000, true) === 0 && dangerLevel(1001, true) === 0, 'Speed Duel: safe above 1000 LP');
ok(dangerLevel(1000, true) === 1 && dangerLevel(501, true) === 1, 'Speed Duel: danger at 1000 LP and under');
ok(dangerLevel(500, true) === 2 && dangerLevel(1, true) === 2, 'Speed Duel: deep danger at 500 LP and under');
ok(dangerLevel(0, true) === 0, 'at 0 LP the duel is over: no heartbeat');
ok(dangerLevel(2000, false) === 1 && dangerLevel(1000, false) === 2 && dangerLevel(2001, false) === 0, 'the 8000 LP game scales the same way');

// --- the landscape a Field Spell keeps up
const withField = (name: string | null, faceUp = true) =>
  ({ players: [{ field: name ? { name, faceUp } : null }, { field: null }] }) as unknown as DuelState;
ok(fieldTerrain(withField('Umi'), 0) === 'ocean', 'Umi keeps the waves going');
ok(fieldTerrain(withField('Yami'), 0) === 'shadow', 'Yami keeps the board dark');
ok(fieldTerrain(withField('Umi', false), 0) === null, 'a Set (face-down) Field Spell paints nothing');
ok(fieldTerrain(withField(null), 0) === null, 'no Field Spell: no landscape');
ok(fieldTerrain(withField('Umi'), 1) === null, "each duelist's own Field Zone decides their half");

const fields = [...new Set([...KIT.values()].filter((c) => c.kind === 'spell' && c.sub === 'Field').map((c) => c.name))];
ok(fields.length > 10, `the card list has its Field Spells (${fields.length})`);
const missing = fields.filter((n) => !TERRAINS.includes(fieldTerrain(withField(n), 0)!));
ok(missing.length === 0, `every Field Spell has a landscape${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);

// --- the shader: smoothstep with edge0 > edge1 is undefined in GLSL ES (some phones draw black)
ok(!/\bsmoothstep\s*\(/.test(FRAG), 'the landscape shader uses its own defined sstep, never smoothstep');
ok(!FRAG.includes('`'), 'no stray backticks in the shader source');

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
console.log('\nall atmosphere checks passed');
