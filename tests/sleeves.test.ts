// Card sleeves: the roster and its economy (free, Duel Chips, earned), the duel's sleeves per
// side, and the sleeve riding a room's JOIN to the other phone.
import assert from 'node:assert/strict';
import { buySleeve, cantBuySleeve, chosenSleeve, DEFAULT_SLEEVE, duelSleeveOf, hasSleeve, isSleeve, pickSleeve, showDuelSleeves, sleeveForName, sleeveFromWire, sleeveClass, sleeveShineClass, SLEEVES, bestRankedTier } from '../src/sleeves/sleeves';
import { SLEEVE_SVG, sleeveUrl } from '../src/sleeves/art';
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

t('at least 12 sleeves, unique ids, each with a picture and a glow', () => {
  assert.ok(SLEEVES.length >= 12);
  assert.equal(new Set(SLEEVES.map((s) => s.id)).size, SLEEVES.length);
  for (const s of SLEEVES) {
    assert.ok(isSleeve(s.id), s.id);
    assert.ok(SLEEVE_SVG[s.id].startsWith('<svg') && SLEEVE_SVG[s.id].endsWith('</svg>'), s.id);
    assert.match(s.glow, /^#[0-9a-f]{6}$/i);
    // (small enough to decode instantly on a phone)
    assert.ok(SLEEVE_SVG[s.id].length < 9000, `${s.id} is ${SLEEVE_SVG[s.id].length} chars`);
    assert.ok(sleeveUrl(s.id).startsWith('url("data:image/svg+xml,'));
    assert.ok(!sleeveUrl(s.id).slice(5, -2).includes('"'), 'no double quote inside the url()');
  }
  for (const id of Object.keys(SLEEVE_SVG)) assert.ok(isSleeve(id), `${id} has a roster entry`);
});

t('the mix: a handful free, some for Duel Chips, the rest earned', () => {
  const free = SLEEVES.filter((s) => 'free' in s.cost).length;
  const chips = SLEEVES.filter((s) => 'chips' in s.cost).length;
  assert.ok(free >= 3 && free <= 5);
  assert.ok(chips >= 5);
  assert.ok(SLEEVES.length - free - chips >= 5);
  assert.equal(SLEEVES.find((s) => s.id === DEFAULT_SLEEVE)!.cost.hasOwnProperty('free'), true);
});

t('a new duelist has the free ones only and wears the Classic Vortex', () => {
  const s = newSpeedSave();
  for (const d of SLEEVES) assert.equal(hasSleeve(s, d.id, null), 'free' in d.cost, d.id);
  assert.equal(chosenSleeve(s, null), DEFAULT_SLEEVE);
  assert.equal(chosenSleeve(null), DEFAULT_SLEEVE);
});

t('buying: costs exactly its chips, once; earned ones cannot be bought', () => {
  const gold = SLEEVES.find((s) => s.id === 'gold')!;
  const price = (gold.cost as { chips: number }).chips;
  assert.ok(cantBuySleeve(withChips(newSpeedSave(), price - 1), 'gold'));
  const s = withChips(newSpeedSave(), price + 2);
  const after = buySleeve(s, 'gold')!;
  assert.equal(after.chips, 2);
  assert.ok(hasSleeve(after, 'gold'));
  assert.equal(buySleeve(withChips(after, 99), 'gold'), null, 'never twice');
  assert.equal(buySleeve(withChips(newSpeedSave(), 200), 'pharaoh'), null);
  assert.equal(buySleeve(withChips(newSpeedSave(), 200), 'vortex'), null);
});

t('picking: only a sleeve you have; a lost one falls back to the classic', () => {
  const s = newSpeedSave();
  assert.equal(pickSleeve(s, 'gold'), null);
  const p = pickSleeve(s, 'crimson')!;
  assert.equal(chosenSleeve(p), 'crimson');
  // (a save that says Pharaoh without the Ranked to back it)
  assert.equal(chosenSleeve({ ...s, sleeve: 'pharaoh' } as SpeedSave, null), DEFAULT_SLEEVE);
  assert.equal(chosenSleeve({ ...s, sleeve: 'nonsense' } as SpeedSave, null), DEFAULT_SLEEVE);
});

t('Ranked sleeves: the best tier ever reached, this season or a past one', () => {
  const s = newSpeedSave();
  assert.equal(bestRankedTier(null), -1);
  assert.ok(!hasSleeve(s, 'wdjat', soloAt('silver')));
  assert.ok(hasSleeve(s, 'wdjat', soloAt('gold')));
  assert.ok(hasSleeve(s, 'shadowrealm', soloAt('legend')), 'a tier above Duel King counts');
  assert.ok(hasSleeve(s, 'shadowrealm', soloAt('king')));
  assert.ok(!hasSleeve(s, 'pharaoh', soloAt('legend')));
  assert.ok(hasSleeve(s, 'pharaoh', soloAt('pharaoh', true)), 'a past season counts');
  assert.equal(chosenSleeve(pickSleeve(s, 'pharaoh', soloAt('pharaoh'))!, soloAt('pharaoh')), 'pharaoh');
});

t('Set Stamps, Ace bond and Duel School sleeves', () => {
  const s = newSpeedSave();
  assert.ok(!hasSleeve(s, 'starlight'));
  // (stamps claimed per set code; the count is over every booster set)
  const codes = stampCards(s).map((c) => c.set.code);
  assert.ok(codes.length >= 5, `${codes.length} booster sets`);
  const stamps = { ...s, stamps: { [codes[0]]: 3, [codes[1]]: 3 } } as unknown as SpeedSave;
  assert.ok(hasSleeve(stamps, 'starlight'), 'six claimed');
  assert.ok(!hasSleeve(stamps, 'holo'));
  assert.ok(!hasSleeve({ ...s, aceWins: { 'Dark Magician': BOND_LEVELS[BOND_LEVELS.length - 2].wins } } as SpeedSave, 'soul'));
  assert.ok(hasSleeve({ ...s, aceWins: { 'Dark Magician': BOND_LEVELS[BOND_LEVELS.length - 1].wins } } as SpeedSave, 'soul'));
  assert.ok(!hasSleeve(s, 'academy'));
  assert.ok(hasSleeve({ ...s, school: LESSONS.map((l) => l.id) } as unknown as SpeedSave, 'academy'));
});

t('computer duelists: the same sleeve every time for the same name', () => {
  assert.equal(sleeveForName('Yami Yugi'), sleeveForName('Yami Yugi'));
  assert.ok(isSleeve(sleeveForName('')));
  assert.ok(new Set(['Kaiba', 'Joey', 'Mai', 'Bandit Keith', 'Pegasus', 'Weevil', 'Rex', 'Mako'].map(sleeveForName)).size >= 4);
});

t('the duel on screen: each side its own sleeve, the classic needs no style', () => {
  showDuelSleeves(['gold', 'water']);
  assert.equal(duelSleeveOf(0), 'gold');
  assert.equal(duelSleeveOf(1), 'water');
  assert.equal(duelSleeveOf(undefined), null);
  assert.equal(sleeveClass('vortex'), '');
  assert.equal(sleeveClass(null), '');
  assert.equal(sleeveClass('gold'), ' slv-id-gold');
  assert.equal(sleeveClass('nonsense' as never), '');
  assert.equal(sleeveShineClass('duelist'), '');
  assert.match(sleeveShineClass('holo'), /slv-shine slv-holo/);
  showDuelSleeves(null);
  assert.equal(duelSleeveOf(0), null);
});

t('a sleeve rides the room JOIN to the other phone; junk is dropped', () => {
  const ses = new DuelSession(new MemoryAdapter());
  ses.send({ type: 'JOIN', player: 0, name: 'A', deck: [], fusion: [], mode: 'speed', sleeve: 'holo' });
  ses.send({ type: 'JOIN', player: 1, name: 'B', deck: [], fusion: [], mode: 'speed', sleeve: 'x'.repeat(500) });
  const v = ses.view();
  assert.equal(sleeveFromWire(v.seats[0].sleeve), 'holo');
  assert.equal(v.seats[1].sleeve, undefined);
  assert.equal(sleeveFromWire('<script>'), null);
  assert.equal(sleeveFromWire(42), null);
});

t('cheap on phones: motion only on deck piles and the picker, transform/opacity only', () => {
  const css = readFileSync('src/sleeves/sleeves.css', 'utf8');
  for (const m of css.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)) {
    const props = [...m[1].matchAll(/^\s*([a-z-]+):/gm)].map((x) => x[1]);
    for (const p of props) assert.ok(p === 'transform' || p === 'opacity', `keyframes animate ${p}`);
  }
  assert.match(css, /prefers-reduced-motion/);
  const touch = readFileSync('src/ui/TouchDuel.tsx', 'utf8');
  assert.equal((touch.match(/back owner=\{p\} shine/g) ?? []).length, 1, 'only the deck pile shines in a Touch duel');
});

console.log(`\n${n} sleeve tests passed`);
