// Playmats: the roster and its pictures, the economy (free, Duel Chips, earned), the duel's mat per
// side, the mat riding a room's JOIN to the other phone, and staying cheap on a phone.
import assert from 'node:assert/strict';
import { buyPlaymat, cantBuyPlaymat, chosenPlaymat, DEFAULT_PLAYMAT, duelPlaymatOf, hasPlaymat, isPlaymat, pickPlaymat, playmatClass, playmatForName, playmatFromWire, showDuelPlaymats, PLAYMATS, playmatProgress } from '../src/playmats/playmats';
import { PLAYMAT_SVG, PLAYMAT_TRIM, fxTile, fxUrl, matUrl, trimUrl } from '../src/playmats/art';
import { DuelSession } from '../src/eds/session';
import { MemoryAdapter } from '../src/sync/memory';
import { newSpeedSave, type SpeedSave } from '../src/eds/speedSave';
import { newSoloSave, type SoloSave } from '../src/eds/speedCampaign/save';
import { newRanked, RANKED_TIERS, tierFloor } from '../src/eds/speedCampaign/ranked';
import { LESSONS } from '../src/eds/tutorial';
import { BOND_LEVELS } from '../src/ace/ace';
import { readFileSync } from 'node:fs';
import { DB } from './speedkit';
import { DB as APP_DB } from '../src/eds/db';
import { stampCards } from '../src/collection/stamps';
import { setSets, type SpeedSet } from '../src/collection/sets';
for (const [k, v] of DB) APP_DB.set(k, v);
setSets(JSON.parse(readFileSync('public/cards/speedSets.json', 'utf8')) as SpeedSet[]);

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`ok ${name}`);
};
const withChips = (s: SpeedSave, chips: number) => ({ ...s, chips }) as SpeedSave;
const soloAt = (tierId: string, history = false): SoloSave => {
  const r = newRanked('2026-11');
  const step = tierFloor(RANKED_TIERS.findIndex((x) => x.id === tierId));
  return { ...newSoloSave(), ranked: history ? { ...r, history: [{ season: '2026-10', peak: step, w: 1, l: 0 }] } : { ...r, step, peak: step } };
};

t('at least 18 mats, unique ids, each with a scene, a trim and its colours', () => {
  assert.ok(PLAYMATS.length >= 18, `${PLAYMATS.length} mats`);
  assert.equal(new Set(PLAYMATS.map((m) => m.id)).size, PLAYMATS.length);
  for (const m of PLAYMATS) {
    assert.ok(isPlaymat(m.id), m.id);
    for (const svg of [PLAYMAT_SVG[m.id], PLAYMAT_TRIM[m.id]]) {
      assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), m.id);
      // (small enough to decode at once on a phone)
      assert.ok(svg.length < 14000, `${m.id} is ${svg.length} chars`);
      assert.ok(!svg.includes('NaN') && !svg.includes('undefined'), `${m.id} has a broken number`);
      // every tag opened is closed (a broken picture draws nothing at all)
      const open = (svg.match(/<(?!\/)[a-zA-Z]+[^>]*[^/]>/g) ?? []).length;
      const close = (svg.match(/<\/[a-zA-Z]+>/g) ?? []).length;
      assert.equal(open, close, `${m.id}: ${open} opened, ${close} closed`);
    }
    for (const c of [m.glow, m.line, m.fxColor]) assert.match(c, /^#[0-9a-f]{6}$/i, m.id);
    for (const u of [matUrl(m.id), trimUrl(m.id)]) {
      assert.ok(u.startsWith('url("data:image/svg+xml,'));
      assert.ok(!u.slice(5, -2).includes('"'), 'no double quote inside the url()');
    }
    const tile = fxTile(m.fx, m.fxColor);
    if (tile) assert.ok(tile.startsWith('<svg') && tile.length < 4000, `${m.id} fx tile`);
    assert.ok(fxUrl(m.fx, m.fxColor) === 'none' || fxUrl(m.fx, m.fxColor).startsWith('url("data:'));
  }
  for (const id of Object.keys(PLAYMAT_SVG)) assert.ok(isPlaymat(id), `${id} has a roster entry`);
});

t('the mix: a handful free, some for Duel Chips, the rest earned the sleeves’ ways', () => {
  const free = PLAYMATS.filter((m) => 'free' in m.cost).length;
  const chips = PLAYMATS.filter((m) => 'chips' in m.cost).length;
  assert.ok(free >= 3 && free <= 5);
  assert.ok(chips >= 6);
  const earned = PLAYMATS.filter((m) => !('free' in m.cost) && !('chips' in m.cost));
  assert.ok(earned.length >= 5);
  for (const k of ['ranked', 'stamps', 'bond', 'school']) assert.ok(earned.some((m) => k in m.cost), `one earned by ${k}`);
  assert.ok('free' in PLAYMATS.find((m) => m.id === DEFAULT_PLAYMAT)!.cost);
});

t('a new duelist has the free ones only and lies on Tournament Blue', () => {
  const s = newSpeedSave();
  for (const d of PLAYMATS) assert.equal(hasPlaymat(s, d.id, null), 'free' in d.cost, d.id);
  assert.equal(chosenPlaymat(s, null), DEFAULT_PLAYMAT);
  assert.equal(chosenPlaymat(null), DEFAULT_PLAYMAT);
});

t('buying: costs exactly its chips, once; earned and free ones cannot be bought', () => {
  const dome = PLAYMATS.find((m) => m.id === 'dome')!;
  const price = (dome.cost as { chips: number }).chips;
  assert.ok(cantBuyPlaymat(withChips(newSpeedSave(), price - 1), 'dome'));
  const s = withChips(newSpeedSave(), price + 3);
  const after = buyPlaymat(s, 'dome')!;
  assert.equal(after.chips, 3);
  assert.ok(hasPlaymat(after, 'dome'));
  assert.equal(buyPlaymat(withChips(after, 99), 'dome'), null, 'never twice');
  assert.equal(buyPlaymat(withChips(newSpeedSave(), 200), 'tomb'), null);
  assert.equal(buyPlaymat(withChips(newSpeedSave(), 200), 'blue'), null);
  // (a mat and a sleeve with the same name are bought apart)
  assert.ok(!hasPlaymat({ ...newSpeedSave(), sleeves: ['shadowrealm'] } as unknown as SpeedSave, 'shadowrealm'));
});

t('picking: only a mat you have; a lost one falls back to Tournament Blue', () => {
  const s = newSpeedSave();
  assert.equal(pickPlaymat(s, 'dome'), null);
  const p = pickPlaymat(s, 'kingdom')!;
  assert.equal(chosenPlaymat(p), 'kingdom');
  assert.equal(chosenPlaymat({ ...s, playmat: 'tomb' } as unknown as SpeedSave, null), DEFAULT_PLAYMAT);
  assert.equal(chosenPlaymat({ ...s, playmat: 'nonsense' } as unknown as SpeedSave, null), DEFAULT_PLAYMAT);
});

t('Ranked mats: the best tier ever reached, this season or a past one', () => {
  const s = newSpeedSave();
  assert.ok(!hasPlaymat(s, 'millennium', soloAt('silver')));
  assert.ok(hasPlaymat(s, 'millennium', soloAt('gold')));
  assert.ok(hasPlaymat(s, 'shadowrealm', soloAt('legend')));
  assert.ok(!hasPlaymat(s, 'tomb', soloAt('legend')));
  assert.ok(hasPlaymat(s, 'tomb', soloAt('pharaoh', true)), 'a past season counts');
  assert.deepEqual(playmatProgress(s, PLAYMATS.find((m) => m.id === 'millennium')!, soloAt('silver')), [2, 3]);
});

t('Set Stamps, Ace bond and Duel School mats', () => {
  const s = newSpeedSave();
  const codes = stampCards(s).map((c) => c.set.code);
  assert.ok(codes.length >= 4);
  const four = { ...s, stamps: { [codes[0]]: 3, [codes[1]]: 1 } } as unknown as SpeedSave;
  assert.ok(!hasPlaymat({ ...s, stamps: { [codes[0]]: 3 } } as unknown as SpeedSave, 'starfall'));
  assert.ok(hasPlaymat(four, 'starfall'));
  assert.ok(!hasPlaymat(four, 'holo'));
  assert.ok(!hasPlaymat({ ...s, aceWins: { 'Dark Magician': BOND_LEVELS[BOND_LEVELS.length - 2].wins } } as SpeedSave, 'heart'));
  assert.ok(hasPlaymat({ ...s, aceWins: { 'Dark Magician': BOND_LEVELS[BOND_LEVELS.length - 1].wins } } as SpeedSave, 'heart'));
  assert.ok(!hasPlaymat(s, 'academy'));
  assert.ok(hasPlaymat({ ...s, school: LESSONS.map((l) => l.id) } as unknown as SpeedSave, 'academy'));
});

t('computer duelists: their own mats, the same one every time for the same name', () => {
  assert.equal(playmatForName('Seto Kaiba'), 'dome');
  assert.equal(playmatForName('Maximillion Pegasus'), 'castle');
  assert.equal(playmatForName('Joey Wheeler'), 'city');
  assert.equal(playmatForName('Some Rookie'), playmatForName('Some Rookie'));
  assert.ok(isPlaymat(playmatForName('')));
});

t('the duel on screen: each side its own mat and classes', () => {
  showDuelPlaymats(['fire', 'water']);
  assert.equal(duelPlaymatOf(0), 'fire');
  assert.equal(duelPlaymatOf(1), 'water');
  assert.equal(duelPlaymatOf(undefined), null);
  assert.equal(playmatClass(null), '');
  assert.equal(playmatClass('nonsense' as never), '');
  assert.equal(playmatClass('fire'), ' pm-id-fire pm-fx-embers');
  assert.equal(playmatClass('light'), ' pm-id-light pm-fx-sparkle pm-bright');
  showDuelPlaymats(null);
  assert.equal(duelPlaymatOf(0), null);
});

t('a mat rides the room JOIN to the other phone; junk is dropped', () => {
  const ses = new DuelSession(new MemoryAdapter());
  ses.send({ type: 'JOIN', player: 0, name: 'A', deck: [], fusion: [], mode: 'speed', playmat: 'castle' });
  ses.send({ type: 'JOIN', player: 1, name: 'B', deck: [], fusion: [], mode: 'speed', playmat: 'x'.repeat(500) });
  const v = ses.view();
  assert.equal(playmatFromWire(v.seats[0].playmat), 'castle');
  assert.equal(v.seats[1].playmat, undefined);
  assert.equal(playmatFromWire('<script>'), null);
  assert.equal(playmatFromWire(7), null);
});

t('wired in: the duel screen, the Duelist tab, the Shop list and every JOIN that sends a sleeve', () => {
  const app = readFileSync('src/ui/App.tsx', 'utf8');
  const sleeveJoins = (app.match(/sleeve: (mySleeveOf|sleeveForName|spec\.watch)/g) ?? []).length;
  const matJoins = (app.match(/playmat: (myMatOf|playmatForName|spec\.watch)/g) ?? []).length;
  assert.equal(matJoins, sleeveJoins, 'a playmat goes wherever a sleeve goes');
  assert.match(app, /showDuelPlaymats\(view\.state\.started && view\.state\.rules\?\.mode === 'speed'/);
  const home = readFileSync('src/ui/SpeedHome.tsx', 'utf8');
  assert.match(home, /<PlaymatsTile /);
  assert.match(home, /label="Playmats"/);
  assert.match(readFileSync('src/ui/Link.tsx', 'utf8'), /playmat: e\.playmat/);
  assert.match(readFileSync('src/ui/TouchDuel.tsx', 'utf8'), /<PlaymatHalves /);
});

t('cheap on phones: one moving layer a half, transform/opacity only, held for cinematics and reduced motion', () => {
  const css = readFileSync('src/playmats/playmats.css', 'utf8');
  for (const m of css.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)) {
    const props = [...m[1].matchAll(/^\s*([a-z-]+):/gm)].map((x) => x[1]);
    for (const p of props) assert.ok(p === 'transform' || p === 'opacity', `keyframes animate ${p}`);
  }
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /body\.art-on \.pm-fx/);
  assert.ok(!/mix-blend-mode|backdrop-filter|filter:\s*blur/.test(css.split('the Playmats page')[0]), 'no blend or blur on the duel screen');
  const halves = readFileSync('src/playmats/Halves.tsx', 'utf8');
  assert.equal((halves.match(/class="pm-fx"/g) ?? []).length, 1, 'one moving layer per half');
});

console.log(`\n${n} playmat tests passed`);
