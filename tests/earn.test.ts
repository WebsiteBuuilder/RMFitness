// Duelist Requests and Set Stamps, the two extra ways to earn cards
// (run: npx tsx tests/earn.test.ts).
import { readFileSync } from 'node:fs';
import { DB as APP_DB, card } from '../src/eds/db';
import { STARTERS, deckFromStarter, newSpeedSave, owned, withCards, type SpeedSave } from '../src/eds/speedSave';
import { packsOf, chipsOf } from '../src/collection/economy';
import { PER_DAY, TEMPLATES, allGivers, boardOf, giverByName, noteRequests, rewardPool, summaryOf, swapRequest, type DuelSummary } from '../src/collection/requests';
import { claimStamp, setCardNames, stampCard, stampOffer, stampsToClaim, topCard } from '../src/collection/stamps';
import { RARITIES, boosterSets, rarityOf, setSets, type SpeedSet } from '../src/collection/sets';
import { TIERS, cardLevels, tierIndex } from '../src/level/leveling';
import type { Deeds } from '../src/level/leveling';
import { DB, playDuel, randomAction, aiAction, setSeed } from './speedkit';

for (const [k, v] of DB) APP_DB.set(k, v);
setSets(JSON.parse(readFileSync('public/cards/speedSets.json', 'utf8')) as SpeedSet[]);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};

const DAY = new Date(2026, 9, 13, 12).getTime();
const NEXT = DAY + 24 * 3600 * 1000;
const blank = (): Deeds => ({ p: 0, k: 0, b: 0, bd: 0, d: 0, dd: 0, e: 0, ed: 0, f: 0, x: 0, r: 0 });

// ---------- Duelist Requests ----------
{
  const gs = allGivers();
  ok(gs.length >= 30, `${gs.length} duelists hand out requests (the Road and the Starter Decks)`);
  const pools = gs.filter((g) => rewardPool(g).length > 0);
  ok(pools.length >= 25, `${pools.length} duelists have cards to give`);
  ok(pools.every((g) => rewardPool(g).every((n) => RARITIES.indexOf(rarityOf(n)) <= RARITIES.indexOf('Super Rare') && card(n)?.speed && card(n)?.sub !== 'Skill')), 'requests pay Speed Duel cards up to Super Rare, never Skills');

  const s0 = newSpeedSave();
  const b = boardOf(s0, DAY)!;
  ok(b.list.length === PER_DAY, `${PER_DAY} requests a day`);
  ok(new Set(b.list.map((r) => r.giver)).size === PER_DAY && new Set(b.list.map((r) => r.kind)).size === PER_DAY, 'three different duelists with three different asks');
  ok(JSON.stringify(boardOf(withCards(s0, ['Dark Magician']), DAY)!.list) === JSON.stringify(b.list), 'everyone gets the same requests on the same day');
  const b2 = boardOf(s0, NEXT)!;
  ok(JSON.stringify(b2.list) !== JSON.stringify(b.list), 'a new day deals new requests');
  // Over 60 days every kind of request shows up.
  const kinds = new Set<string>();
  for (let d = 0; d < 60; d++) for (const r of boardOf(s0, DAY + d * 86400000)!.list) kinds.add(r.kind);
  ok(kinds.size === TEMPLATES.length, `all ${TEMPLATES.length} kinds of request come up over two months (${kinds.size})`);

  // A duel that does everything at once.
  const mega = (s: SpeedSave): DuelSummary => {
    const deeds: Record<string, Deeds> = {};
    for (const r of boardOf(s, DAY)!.list) {
      const g = giverByName(r.giver)!;
      const mon = g.deck.find((n) => card(n)?.kind === 'monster' && (!r.arg || card(n)?.race === r.arg || card(n)?.attribute === r.arg))!;
      deeds[mon] = { ...blank(), p: 10, k: 10, b: 10, d: 10, dd: 9000, f: 1 };
    }
    deeds['Pot of Greed'] = { ...blank(), p: 10 };
    return { won: true, turns: 5, lpLeft: 4000, deeds };
  };
  const no = noteRequests(s0, mega(s0), false, DAY);
  ok(no.save === s0 && !no.lines.length, "Practice and Anything goes duels don't move requests");
  // "Win 2 duels" needs two duels: run twice, then everything is done.
  let s = s0;
  const got: string[] = [];
  for (let i = 0; i < 2; i++) {
    const r = noteRequests(s, mega(s), true, DAY + i);
    s = r.save;
    got.push(...r.cards);
  }
  const done = boardOf(s, DAY)!;
  ok(done.list.every((r) => r.done) && done.bonus, 'a big duel (and a second for "Win 2 duels") finishes all three');
  ok(packsOf(s) === 1 + done.list.filter((r) => !r.reward).length, 'all three done pays one bonus pack');
  ok(got.length === done.list.filter((r) => r.reward).length && got.every((n) => owned(s, n) >= 1 && owned(s0, n) === 0), `each request paid a card the profile didn't own (${got.join(', ')})`);
  ok(done.list.every((r) => !r.reward || giverByName(r.giver)!.deck.includes(r.reward)), "each card comes from that duelist's deck");
  const again = noteRequests(s, mega(s), true, DAY + 5);
  ok(!again.lines.length && again.save.collection === s.collection && packsOf(again.save) === packsOf(s), 'a finished board pays nothing more today');

  // Losing still counts for "today" totals but not for win requests.
  const loss: DuelSummary = { won: false, turns: 20, lpLeft: 0, deeds: { 'Dark Magician': { ...blank(), k: 2, dd: 1200, b: 1, d: 1 } } };
  const l = noteRequests(s0, loss, true, DAY).save;
  const lb = boardOf(l, DAY)!;
  ok(lb.list.every((r) => !r.done), 'a lost duel with little in it finishes nothing');
  ok(lb.list.every((r) => !['wins', 'lp', 'fast', 'finishRace', 'kills'].includes(r.kind) || r.have === 0), 'a lost duel never moves a win request');

  // Swaps: once a day, only a request nobody started.
  const sw = swapRequest(s0, 0, DAY)!;
  ok(!!sw && boardOf(sw, DAY)!.list[0].giver !== b.list[0].giver, 'Ask someone else swaps a request for a new duelist');
  ok(new Set(boardOf(sw, DAY)!.list.map((r) => r.kind)).size === PER_DAY, 'the new request is a different ask from the other two');
  ok(swapRequest(sw, 1, DAY) === null, 'only one swap a day');
  ok(swapRequest(s, 0, DAY) === null, "a finished request can't be swapped");

  // The clock: setting it back pays nothing.
  const back = noteRequests(s, mega(s), true, DAY - 86400000);
  ok(boardOf(s, DAY - 86400000) === null && back.save === s, 'with the clock set back, requests wait for the real date');

  // A real duel's tally feeds the summary.
  setSeed(7);
  const y = deckFromStarter(STARTERS[0]);
  const k = deckFromStarter(STARTERS[3]);
  const res = playDuel([y.main, k.main], [y.extra, k.extra], [null, null], 3, [(e, p) => aiAction(e, p) ?? randomAction(e, p), (e, p) => aiAction(e, p) ?? randomAction(e, p)]);
  ok(!res.fail, `a computer duel plays out${res.fail ? `: ${res.fail}` : ''}`);
  const st = res.engine.state;
  const w = st.winner === 1 ? 1 : 0;
  const sum = summaryOf(st, w);
  ok(sum.won && sum.turns === st.turn && Object.keys(sum.deeds).length > 0, `a real duel gives a summary (${Object.keys(sum.deeds).length} cards did something, ${sum.turns} turns)`);
}

// ---------- Set Stamps ----------
{
  const set = boosterSets()[0];
  const names = setCardNames(set);
  let s = newSpeedSave();
  let c = stampCard(s, set);
  ok(c.total === names.length && c.reached === 0 && c.claimed === 0, `${set.name}: ${c.total} cards, nothing owned, no stamps`);
  ok(c.marks[0] === Math.ceil(names.length / 3) && c.marks[2] === names.length, 'stamps at a third, two thirds and the whole set');
  ok(claimStamp(s, set.code) === null, 'nothing to claim with no cards');

  s = withCards(s, names.slice(0, c.marks[0]));
  ok(stampsToClaim(s) >= 1, 'a third of the set: a stamp waits on the menu');
  const p0 = packsOf(s);
  const one = claimStamp(s, set.code)!;
  ok(!!one && packsOf(one.save) === p0 + 1, 'stamp 1 pays a booster pack');
  s = one.save;
  ok(claimStamp(s, set.code) === null, 'stamp 1 pays only once');

  s = withCards(s, names.slice(c.marks[0], c.marks[1]));
  const offer = stampOffer(s, set);
  ok(offer.length === 3 && offer.every((n) => owned(s, n) === 0 && names.includes(n)), `stamp 2 offers 3 cards from the set you don't own (${offer.join(', ')})`);
  ok(JSON.stringify(stampOffer(s, set)) === JSON.stringify(offer), 'the offer stays the same until the collection changes');
  ok(claimStamp(s, set.code) === null && claimStamp(s, set.code, 'Not On Offer') === null, 'stamp 2 needs one of the offered cards');
  const two = claimStamp(s, set.code, offer[1])!;
  ok(!!two && owned(two.save, offer[1]) === 1, 'stamp 2 gives the picked card');
  s = two.save;
  ok(claimStamp(s, set.code, offer[0]) === null, 'stamp 2 pays only once');

  s = withCards(
    s,
    names.filter((n) => owned(s, n) === 0),
  );
  c = stampCard(s, set);
  ok(c.reached === 3 && c.claimed === 2, 'the whole set: the last stamp is due');
  const top = topCard(set)!;
  const chips = chipsOf(s);
  const three = claimStamp(s, set.code)!;
  ok(!!three && tierIndex(cardLevels(three.save)[top] ?? 0) === TIERS.length - 1, `stamp 3 puts ${top} at Overframe`);
  ok(chipsOf(three.save) === Math.min(30, chips + 2), 'stamp 3 pays 2 Duel Chips');
  ok(claimStamp(three.save, set.code) === null && stampCard(three.save, set).claimed === 3, 'a full stamp card pays nothing more');
  ok(boosterSets().every((x) => setCardNames(x).length > 0 && topCard(x)), `every one of the ${boosterSets().length} booster sets has a stamp card and a top card`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall earn tests passed');
if (fails) process.exit(1);
