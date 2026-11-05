// Pack opening ceremony: the grades that pace it (glow, the hold-to-reveal, the spotlight on a
// batch's top pulls), checked over real packs from every set, and a guard that the ceremony
// only reads opened packs (it never opens, pays or changes odds).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DB } from './speedkit';
import { DB as APP_DB } from '../src/eds/db';
import { boosterSets, rarityIn, setSets, type SpeedSet } from '../src/collection/sets';
import { openOwnedPack, withPacks } from '../src/collection/economy';
import { newSpeedSave, type SpeedSave } from '../src/eds/speedSave';
import { GRADES, STAR_FROM, TEASE_FROM, SPOTLIGHT_MAX, beatOf, flipOrder, foreshadow, gradeOf, nextToFlip, spotlight, starOf } from '../src/packopen/grade';
for (const [k, v] of DB) APP_DB.set(k, v);
setSets(JSON.parse(readFileSync('public/cards/speedSets.json', 'utf8')) as SpeedSet[]);

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`ok ${name}`);
};

t('grades: printed rarity is the floor, finishes outrank it', () => {
  assert.equal(gradeOf('Common', 0), 0);
  assert.equal(gradeOf('Rare', 0), 1);
  assert.equal(gradeOf('Common', 2), 2);
  assert.equal(gradeOf('Super Rare', 1), 2);
  assert.equal(gradeOf('Ultra Rare', 3), 3);
  assert.equal(gradeOf('Secret Rare', 3), 4);
  assert.equal(GRADES[gradeOf('Common', 4)], 'gl');
  assert.equal(GRADES[gradeOf('Secret Rare', 5)], 'ro');
  assert.equal(GRADES[gradeOf('Rare', 6)], 'of');
  assert.equal(gradeOf('Common', 99), GRADES.length - 1);
  assert.equal(gradeOf(undefined, undefined), 0);
});

t('the star: the best Ultra Rare or better, flipped last', () => {
  assert.equal(starOf([0, 1, 2, 0, 0]), -1, 'a Super Rare gets no hold');
  assert.equal(starOf([0, 3, 0, 0, 0]), 1);
  assert.equal(starOf([5, 0, 3, 0, 5]), 4, 'rightmost of equals');
  assert.deepEqual(flipOrder([0, 6, 0, 1, 0]), [0, 2, 3, 4, 1]);
  assert.deepEqual(flipOrder([0, 1, 2, 0, 0]), [0, 1, 2, 3, 4]);
  assert.equal(nextToFlip([0, 6, 0, 1, 0], [true, false, true, true, true]), 1);
  assert.equal(nextToFlip([0, 6, 0, 1, 0], [true, false, false, true, true]), 2, 'the star waits for the rest');
  assert.equal(nextToFlip([0, 0], [true, true]), -1);
  assert.equal(foreshadow([0, 2, 1]), 2);
});

t('a batch spotlights at most five top pulls, best last', () => {
  assert.deepEqual(spotlight([0, 1, 0]), []);
  assert.deepEqual(spotlight([0, 2, 2, 1]), [1], 'no Ultra Rare: the one best Super Rare');
  assert.deepEqual(spotlight([3, 0, 7, 4, 3]), [0, 4, 3, 2]);
  const many = [3, 3, 3, 3, 3, 3, 5, 3, 6, 4];
  const s = spotlight(many);
  assert.equal(s.length, SPOTLIGHT_MAX);
  assert.equal(s[s.length - 1], 8);
  assert.ok(s.includes(6) && s.includes(9));
  for (let i = 1; i < s.length; i++) assert.ok(many[s[i - 1]] <= many[s[i]]);
  assert.ok(beatOf(7) > beatOf(3) && beatOf(3) > beatOf(0));
});

t('real packs from every set: every pack has a hit, the star is its best pull', () => {
  let save: SpeedSave = withPacks({ ...newSpeedSave(), giftPacks: 2000 } as SpeedSave, 0);
  const sets = boosterSets();
  let stars = 0;
  let packs = 0;
  for (let k = 0; k < 600; k++) {
    const set = sets[k % sets.length].name;
    const o = openOwnedPack(save, set, 1700000000000 + k * 7919);
    assert.ok(o, set);
    save = o!.save;
    const g = o!.cards.map((c, i) => gradeOf(rarityIn(o!.set, c), o!.finishes[i]));
    packs++;
    assert.equal(g.length, 5);
    assert.ok(foreshadow(g) >= 1, `${set}: a pack always has a Rare or better`);
    const s = starOf(g);
    if (foreshadow(g) >= STAR_FROM) {
      stars++;
      assert.equal(g[s], foreshadow(g));
      assert.equal(flipOrder(g)[4], s);
    } else assert.equal(s, -1);
    assert.equal(new Set(flipOrder(g)).size, 5);
  }
  // the hold-to-reveal is a treat, not every pack
  assert.ok(stars > packs * 0.15 && stars < packs * 0.8, `${stars}/${packs} packs had a star`);
  console.log(`  ${stars}/${packs} packs had a hold-to-reveal pull`);
});

t('the ceremony is cosmetic: it reads opened packs and never opens, pays or saves', () => {
  for (const f of ['src/packopen/Ceremony.tsx', 'src/packopen/grade.ts', 'src/packopen/sfx.ts']) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/openOwnedPack|openPack\(|withPacks|withCards|grant\(|onSave|accounts|localStorage/.test(src), `${f} must not touch the economy or the save`);
  }
  const ceremony = readFileSync('src/packopen/Ceremony.tsx', 'utf8');
  assert.match(ceremony, /import type \{ Opened \} from '\.\.\/collection\/economy'/);
  const shop = readFileSync('src/collection/Shop.tsx', 'utf8');
  assert.match(shop, /<PackCeremony/);
  assert.match(shop, /<PackBatch/);
  // back skips a ceremony before it leaves the shop
  assert.match(readFileSync('src/ui/App.tsx', 'utf8'), /if \(packBack\(\)\) return true;/);
});

t('perf: no blur filters, and the stage cleans its timers', () => {
  const css = readFileSync('src/packopen/ceremony.css', 'utf8');
  assert.ok(!/filter:\s*blur|backdrop-filter|hue-rotate/.test(css), 'no blur or hue-rotate on the stage');
  assert.match(css, /prefers-reduced-motion/);
  const src = readFileSync('src/packopen/Ceremony.tsx', 'utf8');
  assert.match(src, /clearTimeout/);
});

console.log(`packopen: ${n} passed`);
