// Pack drop odds and the online win pack: every card in a pack rolls the rarity it comes
// out at (Normal up to Overframe) with fixed odds, and every online win over another
// player pays a pack (run: npx tsx tests/packodds.test.ts).
import { DB as APP_DB } from '../src/eds/db';
import { rng } from '../src/eds/rng';
import { newSpeedSave, type SpeedSave } from '../src/eds/speedSave';
import { RIVAL_MIN_TURNS, RIVAL_PACKS_PER_DAY, chipsOf, openOwnedPack, packsOf, rivalResult, withPacks } from '../src/collection/economy';
import { FINISH_ODDS, PRINTED_FLOOR, oddsTable, rollFinish, rollFinishes, withFinishes } from '../src/collection/finish';
import { rarityIn, setSets, type SpeedSet } from '../src/collection/sets';
import { TIERS, cardLevels, tierIndex } from '../src/level/leveling';
import { DB, PLAYABLE } from './speedkit';

for (const [k, v] of DB) APP_DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};

const names = PLAYABLE.slice(0, 40).map((c) => c.name);
const BOX = 'Speed Duel: Odds Box';
const fake: SpeedSet[] = [
  {
    name: BOX,
    code: 'ODD',
    date: '2019-01-01',
    cards: [...names.slice(0, 20).map((n) => [n, 'Common'] as [string, 'Common']), [names[20], 'Super Rare'], [names[21], 'Ultra Rare'], [names[22], 'Secret Rare']],
  },
];
setSets(fake);

// ---------- the odds table ----------
{
  ok(FINISH_ODDS.length === TIERS.length, 'every rarity on the ladder has odds');
  ok(FINISH_ODDS.reduce((a, b) => a + b, 0) === 10000, 'the odds add up to 100%');
  ok(FINISH_ODDS.every((w, i) => i === 0 || w < FINISH_ODDS[i - 1]), 'each rarer tier is less likely than the one below');
  ok(TIERS[TIERS.length - 1].id === 'OF' && FINISH_ODDS[TIERS.length - 1] <= 25, 'Overframe is the top and stays at 0.25% or less a card');
  const t = oddsTable();
  const of = t[t.length - 1];
  ok(of.oneIn >= 60 && of.oneIn <= 100, `about 1 pack in ${of.oneIn} has an Overframe`);
  ok(t.every((r, i) => i === 0 || r.oneIn >= t[i - 1].oneIn), 'the rarer the finish, the more packs it takes');
}

// ---------- rolling finishes ----------
{
  const N = 400_000;
  const next = rng(12345);
  const seen = new Array(TIERS.length).fill(0);
  for (let i = 0; i < N; i++) seen[rollFinish(next)]++;
  const close = seen.every((c, i) => Math.abs(c / N - FINISH_ODDS[i] / 10000) < 0.004);
  ok(close, `rolled finishes match the odds (${seen.map((c) => ((c / N) * 100).toFixed(2)).join(' / ')} %)`);
  ok(seen[TIERS.length - 1] > 0, 'Overframe does drop');
  const floored = Array.from({ length: 2000 }, () => rollFinish(next, PRINTED_FLOOR['Ultra Rare']));
  ok(floored.every((t) => t >= 3), 'a printed Ultra Rare never comes out below Ultra Rare');
  const cards = [names[0], names[1], names[20], names[21], names[22]];
  const a = rollFinishes(BOX, cards, 777);
  const b = rollFinishes(BOX, cards, 777);
  ok(a.join() === b.join(), 'the same pack seed always gives the same finishes');
  ok(a[2] >= 2 && a[3] >= 3 && a[4] >= 3, 'printed Super, Ultra and Secret Rares come out at their rarity or better');
  let differ = false;
  for (let seed = 1; seed < 50 && !differ; seed++) differ = rollFinishes(BOX, cards, seed).join() !== a.join();
  ok(differ, 'different packs roll differently');
}

// ---------- a pull lifts the card's rarity, never lowers it ----------
{
  const [X, Y] = [names[0], names[1]];
  let s: SpeedSave = { ...newSpeedSave(), levels: { [Y]: TIERS[5].at + 10 } } as SpeedSave;
  s = withFinishes(s, [X, Y], [6, 2]);
  ok(tierIndex(cardLevels(s)[X]) === 6, 'an Overframe pull makes that card Overframe');
  ok(cardLevels(s)[Y] === TIERS[5].at + 10, 'a lower pull leaves a card that sits higher alone');
  const plain = newSpeedSave();
  ok(withFinishes(plain, [X], [0]) === plain, 'a Normal pull changes nothing');
}

// ---------- opening a pack uses the odds ----------
{
  let s = withPacks(newSpeedSave(), 300);
  const counts = new Array(TIERS.length).fill(0);
  let liftOk = true;
  let overframes = 0;
  for (let i = 0; i < 300; i++) {
    const o = openOwnedPack(s, BOX, 1000 + i * 7919)!;
    if (!o || o.finishes.length !== o.cards.length) {
      liftOk = false;
      break;
    }
    o.cards.forEach((n, j) => {
      counts[o.finishes[j]]++;
      if (o.finishes[j] < PRINTED_FLOOR[rarityIn(BOX, n)]) liftOk = false;
      if (tierIndex(cardLevels(o.save)[n] ?? 0) < o.finishes[j]) liftOk = false;
      if (o.finishes[j] === 6) overframes++;
    });
    s = o.save;
  }
  ok(liftOk, 'every opened card carries a finish and the profile sees it at that rarity or better');
  ok(counts[0] > counts[1] && counts[1] > counts[3], `most cards come out Normal, fewer Rare, fewer still Ultra Rare (${counts.join('/')})`);
  ok(overframes <= 15, `Overframe stays special: ${overframes} in 300 packs`);
  const again = openOwnedPack(withPacks(newSpeedSave(), 1), BOX, 4242)!;
  const twice = openOwnedPack(withPacks(newSpeedSave(), 1), BOX, 4242)!;
  ok(again.cards.join() === twice.cards.join() && again.finishes.join() === twice.finishes.join(), 'a pack opened from the same seed comes out the same');
}

// ---------- a pack for every online win ----------
{
  const day = new Date(2026, 9, 13, 12).getTime();
  const win = { result: 'w' as const, opp: 'Bro', turns: 6, counts: true, online: true };
  let r = newSpeedSave();
  for (let i = 0; i < 8; i++) r = rivalResult(r, win, day).save;
  ok(packsOf(r) === 8, 'every online win over your brother pays a pack, with no daily cap');
  ok(chipsOf(r) === 1, 'the Duel Chip is still one a day');
  ok(rivalResult(newSpeedSave(), win, day).lines.some((l) => l.includes('online')), 'the result screen says the pack came from the online win');
  ok(packsOf(rivalResult(newSpeedSave(), { ...win, result: 'l' }, day).save) === 0, 'an online loss pays nothing');
  ok(packsOf(rivalResult(newSpeedSave(), { ...win, counts: false }, day).save) === 0, 'an Anything goes deck (or no profile) earns nothing online either');
  ok(packsOf(rivalResult(newSpeedSave(), { ...win, turns: RIVAL_MIN_TURNS - 1 }, day).save) === 0, `a quick surrender under ${RIVAL_MIN_TURNS} turns pays nothing`);
  let hs = newSpeedSave();
  for (let i = 0; i < 6; i++) hs = rivalResult(hs, { ...win, online: false }, day).save;
  ok(packsOf(hs) === RIVAL_PACKS_PER_DAY, `one-phone wins keep their ${RIVAL_PACKS_PER_DAY}-a-day cap`);
  const back = rivalResult(rivalResult(newSpeedSave(), win, day + 3 * 86_400_000).save, win, day);
  ok(packsOf(back.save) === 1, 'setting the phone clock back still pays nothing');
}

setSets(null);
console.log(fails ? `\n${fails} FAILED` : '\nall pack odds tests passed');
process.exit(fails ? 1 : 0);
