// The one-time gift packs: claimed once per profile, open any booster set (locked ones too),
// spent before the packs won in duels, and enough of them to fill a Random deck
// (run: npx tsx tests/gift.test.ts).
import { readFileSync } from 'node:fs';
import { DB as APP_DB } from '../src/eds/db';
import { STARTERS, deckFromStarter, newSpeedSave, speedDeckProblems, type SpeedDeck, type SpeedSave } from '../src/eds/speedSave';
import { GIFT, GIFT_PROFILES, claimGift, collectionProblems, giftFor, giftPacksOf, migrate, openOwnedPack, packsFor, packsOf, withPacks, withStarter } from '../src/collection/economy';
import { boosterSets, setSets, unlockedSets, type SpeedSet } from '../src/collection/sets';
import { randomSpeedDeck } from '../src/eds/speedRandom';
import { DB } from './speedkit';

for (const [k, v] of DB) APP_DB.set(k, v);
setSets(JSON.parse(readFileSync('public/cards/speedSets.json', 'utf8')) as SpeedSet[]);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};
const before = GIFT.madeBefore - 86_400_000;

// ---------- claiming ----------
{
  const s = migrate(newSpeedSave());
  ok(GIFT.packs === 250, 'the gift is 250 packs');
  ok(!!giftFor(s, before), 'a profile made before the cutoff can claim it');
  const g = claimGift(s, before)!;
  ok(packsOf(g) === packsOf(s) + GIFT.packs && giftPacksOf(g) === GIFT.packs, 'claiming adds the packs, counted with the rest');
  ok(!giftFor(g, before) && claimGift(g, before) === null, 'a profile can claim it only once');
  const copied = JSON.parse(JSON.stringify(g)) as SpeedSave;
  ok(claimGift(copied, before) === null, 'the claim survives a save round trip (another phone logging in)');
  ok(claimGift(s, GIFT.madeBefore) === null && claimGift(s, Date.now() + 1e12) === null, 'a profile made after the cutoff gets nothing (no spare-profile farm)');
  ok(!!claimGift(s, 0), 'an old profile with no creation date still gets it');
  ok(giftFor(s, before, { ...GIFT, id: 'next' }) !== null && !!claimGift(g, before, { ...GIFT, id: 'next', packs: 5 }), 'a later gift with a new id can be given on top');
}

// ---------- one phone hands it to at most GIFT_PROFILES profiles, each once ----------
{
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const fresh = () => migrate(newSpeedSave());
  const a = claimGift(fresh(), before, GIFT, 'jammy');
  ok(!!a, 'the first profile on a phone gets the gift');
  ok(claimGift(fresh(), before, GIFT, 'jammy') === null, 'a lost or rolled-back save cannot claim it again on the same phone');
  ok(!!claimGift(fresh(), before, GIFT, 'bro'), 'a second profile on the phone gets it too');
  ok(giftFor(fresh(), before, GIFT, 'spare') === null && claimGift(fresh(), before, GIFT, 'spare') === null, `a ${GIFT_PROFILES + 1}rd profile on the same phone gets nothing`);
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

// ---------- opening ----------
{
  const sets = boosterSets();
  const locked = sets[sets.length - 1].name;
  const first = sets[0].name;
  const s0 = withPacks(migrate(newSpeedSave()), 2);
  ok(unlockedSets(s0.wins).length < sets.length && packsFor(s0, locked) === 0, 'without gift packs a locked set stays shut');
  const won = packsOf(s0);
  let s = claimGift(s0, before)!;
  ok(packsFor(s, locked) === GIFT.packs && packsFor(s, first) === GIFT.packs + won, 'gift packs open any set; won packs only unlocked ones');
  const o = openOwnedPack(s, locked, 7)!;
  ok(!!o && o.cards.length === 5 && giftPacksOf(o.save) === GIFT.packs - 1 && packsOf(o.save) === packsOf(s) - 1, 'a locked set opens with a gift pack');
  ok(openOwnedPack(s, 'Not a set', 7) === null, 'a set that does not exist never opens');
  const w = openOwnedPack(s, first, 8)!;
  ok(giftPacksOf(w.save) === GIFT.packs - 1 && packsFor(w.save, locked) === GIFT.packs - 1, 'gift packs go first, so won packs stay for the climb');
  // Open the whole gift, spread over every set like "Open 10 mixed" does.
  let n = 0;
  for (let i = 0; giftPacksOf(s) > 0; i++) {
    const r = openOwnedPack(s, sets[i % sets.length].name, 1000 + i * 7919);
    if (!r) break;
    s = r.save;
    n++;
  }
  ok(n === GIFT.packs && giftPacksOf(s) === 0 && packsOf(s) === won, `all ${GIFT.packs} gift packs open, the ${won} won packs are left`);
  ok(packsFor(s, locked) === 0 && openOwnedPack(s, locked, 3) === null, 'once the gift is gone, locked sets shut again');
  const distinct = Object.keys(s.collection ?? {}).length;
  ok(distinct >= 500, `the gift fills the binder (${distinct} different cards)`);

  // A Random deck from the collection is legal and draws on many sets.
  const start = deckFromStarter(STARTERS[0]);
  s = withStarter(s, start);
  let good = 0;
  for (let i = 0; i < 20; i++) {
    let seed = 50 + i;
    const r = randomSpeedDeck(s.collection ?? {}, { size: 20, style: 'balanced', theme: { kind: 'surprise' }, rand: () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) });
    if ('error' in r) continue;
    const d: SpeedDeck = { id: 'r', name: 'R', main: r.main, extra: r.extra, skill: r.skill, open: false };
    if (!speedDeckProblems(d).length && !collectionProblems(s, d).length) good++;
  }
  ok(good === 20, 'Random deck makes 20 legal decks out of the gifted cards');
}

console.log(fails ? `\n${fails} FAILED` : '\nall gift tests passed');
if (fails) process.exit(1);
