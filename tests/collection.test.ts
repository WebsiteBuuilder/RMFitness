// The Speed Duel collection economy: owning cards, packs from the real sets, Duel Chips,
// crafting, and the stakes between two players (run: npx tsx tests/collection.test.ts).
import { Engine } from '../src/eds/engine';
import { DB as APP_DB } from '../src/eds/db';
import { CHIP_CAP, newSpeedSave, owned, withCards, withChips, type SpeedDeck, type SpeedSave } from '../src/eds/speedSave';
import {
  CRAFT_COST,
  PITY,
  RIVAL_PACKS_PER_DAY,
  WELCOME_PACKS,
  breakCopy,
  breakExtras,
  cantCraft,
  chipsOf,
  collectionProblems,
  cpuWinPrize,
  craft,
  crownHolder,
  lookUp,
  migrate,
  openOwnedPack,
  ownedOnly,
  packsOf,
  rivalResult,
  shardsOf,
  spareCopies,
  withPacks,
} from '../src/collection/economy';
import { PACK_SIZE, boosterSets, openPack, rarityIn, rarityOf, setSets, unlockedSets, type SpeedSet } from '../src/collection/sets';
import { anteProblem, rescueFirst, settleStakes, settleTicket, staked, stakesFor, withTicket, type StakeSeat } from '../src/collection/stakes';
import { sealedCards, withShadow } from '../src/art/shadow';
import { cardLevels, tierIndex } from '../src/level/leveling';
import { DB, PLAYABLE } from './speedkit';

for (const [k, v] of DB) APP_DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};

const vanilla = PLAYABLE.filter((c) => c.kind === 'monster' && c.sub === 'Normal').sort((a, b) => (b.atk ?? 0) - (a.atk ?? 0));
const [A, B, C] = [vanilla[0].name, vanilla[1].name, vanilla[2].name];
const deck = (main: string[], extra: string[] = [], open = false): SpeedDeck => ({ id: 'd', name: 'D', main, extra, skill: null, open });

// ---------- moving old profiles over ----------
{
  const old: SpeedSave = { ...newSpeedSave(), decks: [deck([A, A, A, A, B])] };
  const m = migrate(old);
  ok(owned(m, A) === 3 && owned(m, B) === 1, 'an old profile owns the copies its decks use (at most 3)');
  ok(packsOf(m) === WELCOME_PACKS, 'and gets the welcome packs');
  ok(migrate(m) === m, 'moving over happens once');
}

// ---------- decks need owned cards ----------
{
  const s = withCards(newSpeedSave(), [A, A, B]);
  ok(collectionProblems(s, deck([A, A, B])).length === 0, 'a deck of owned copies is fine');
  ok(collectionProblems(s, deck([A, A, A])).length === 1, 'a third copy you do not own is a problem');
  ok(collectionProblems(s, deck([C])).some((p) => p.includes("don't own")), 'a card you do not own is a problem');
  ok(collectionProblems(s, deck([C, C, C], [], true)).length === 0, 'an Anything goes deck can use any card');
  const trimmed = ownedOnly(s, deck([A, A, A, B, C]));
  ok(trimmed.main.join() === [A, A, B].join(), 'a deck from a Starter keeps only the copies you own');
  const used = { ...s, decks: [deck([A, A])] };
  ok(spareCopies(used, A) === 0 && spareCopies(used, B) === 1, 'spare copies are the ones no deck uses');
}

// ---------- packs ----------
const names = PLAYABLE.slice(0, 60).map((c) => c.name);
const fake: SpeedSet[] = [
  { name: 'Speed Duel: Older Box', code: 'OLD', date: '2019-01-01', cards: [...names.slice(0, 20).map((n) => [n, 'Common'] as [string, 'Common']), [names[20], 'Super Rare'], [names[21], 'Secret Rare']] },
  { name: 'Speed Duel: Newer Box', code: 'NEW', date: '2020-01-01', cards: names.slice(22, 40).map((n, i) => [n, i < 14 ? 'Common' : 'Ultra Rare'] as [string, 'Common' | 'Ultra Rare']) },
  { name: 'Speed Duel Starter Deck: Someone', code: 'SS01', date: '2018-01-01', cards: names.slice(40, 60).map((n) => [n, 'Common'] as [string, 'Common']) },
];
setSets(fake);
ok(boosterSets().map((s) => s.code).join() === 'OLD,NEW', 'Starter Decks are not sold as packs');
ok(unlockedSets(0).length === 1 && unlockedSets(4).length === 2, 'a new set unlocks every 4 wins');
{
  let good = 0;
  const spots = new Set<number>();
  for (let seed = 1; seed <= 200; seed++) {
    const p = openPack('Speed Duel: Older Box', [], seed);
    const commons = p.filter((n) => rarityIn('Speed Duel: Older Box', n) === 'Common');
    if (p.length === PACK_SIZE && commons.length === 4 && new Set(commons).size === 4) good++;
    spots.add(p.findIndex((n) => rarityIn('Speed Duel: Older Box', n) !== 'Common'));
  }
  ok(good === 200, 'a pack is 4 different Commons and one Super Rare or better');
  ok(spots.size === PACK_SIZE, 'the hit can land in any of the 5 spots');
  ok(rarityOf(names[21]) === 'Secret Rare' && rarityOf(names[0]) === 'Common', "a card's rarity comes from its printing");
  const p = openPack(undefined, [], 5);
  ok(p.length === PACK_SIZE, 'a pack with no set named picks one');
}
{
  let s = withPacks(newSpeedSave(), 2);
  ok(openOwnedPack(s, 'Speed Duel: Newer Box') === null, 'a locked set cannot be opened');
  const o = openOwnedPack(s, 'Speed Duel: Older Box', 9)!;
  ok(!!o && packsOf(o.save) === 1 && o.cards.every((n) => owned(o.save, n) >= 1), 'opening a pack uses it and adds its cards');
  let dry = withPacks(newSpeedSave(), 10) as SpeedSave & { dry?: number };
  dry.dry = PITY - 1;
  const pity = openOwnedPack(dry, 'Speed Duel: Older Box', 4)!;
  ok(pity.cards.some((n) => rarityIn('Speed Duel: Older Box', n) === 'Secret Rare'), `the ${PITY}th pack without an Ultra Rare or better has one`);
  ok((pity.save as { dry?: number }).dry === 0, 'and the count starts over');
  s = { ...newSpeedSave(), collection: { [A]: 5 } };
  const b = breakExtras(s);
  ok(owned(b.save, A) === 3 && b.shards === 2 * CRAFT_COST.Common, 'copies past 3 break into shards');
}

// ---------- Duel Chips ----------
{
  let s = withChips(newSpeedSave(), 99);
  ok(chipsOf(s) === CHIP_CAP, `chips stop at ${CHIP_CAP}`);
  s = withChips(newSpeedSave(), 1);
  ok(craft(s, names[21]) === null && !!cantCraft(s, names[21]), 'a Secret Rare costs more than 1 chip');
  const c = craft(s, names[0])!;
  ok(owned(c, names[0]) === 1 && chipsOf(c) === 0, 'crafting a Common costs 1 chip');
  s = { ...withChips(newSpeedSave(), 3), collection: { [A]: 1 } };
  const up = lookUp(s, A)!;
  ok(tierIndex(cardLevels(up)[A]) === 1 && chipsOf(up) === 0, "3 chips lift a card's look one rarity");
  let sh = { ...newSpeedSave(), collection: { [names[21]]: 3 } } as SpeedSave;
  sh = breakCopy(sh, names[21])!;
  sh = breakCopy(sh, names[21])!;
  ok(chipsOf(sh) === 1 && shardsOf(sh) === 6, '16 shards from two Secret Rares make 1 chip with 6 left');
  ok(breakCopy(sh, names[21]) === null, 'the last copy of a card never breaks');
}

// ---------- prizes ----------
{
  const day = new Date(2026, 9, 12, 12).getTime();
  let s = newSpeedSave();
  s = cpuWinPrize(s, 'Kaiba', null, day).save;
  ok(packsOf(s) === 1, 'the first win over a computer duelist today pays a pack');
  ok(packsOf(cpuWinPrize(s, 'Kaiba', null, day).save) === 1, 'beating them again today pays nothing');
  ok(packsOf(cpuWinPrize(s, 'Kaiba', null, day + 86_400_000).save) === 2, 'tomorrow pays again');
  ok(packsOf(cpuWinPrize(newSpeedSave(), 'Joey', deck([], [], true), day).save) === 0, 'an Anything goes deck earns nothing');
  let r = newSpeedSave();
  for (let i = 0; i < 5; i++) r = rivalResult(r, { result: 'w', opp: 'Bro', turns: 5, counts: true }, day).save;
  ok(packsOf(r) === RIVAL_PACKS_PER_DAY && chipsOf(r) === 1, `beating your brother pays up to ${RIVAL_PACKS_PER_DAY} packs and 1 chip a day`);
  ok(chipsOf(rivalResult(newSpeedSave(), { result: 'w', opp: 'Bro', turns: 2, counts: true }, day).save) === 0, 'a 2-turn win pays no chip');
  ok(crownHolder(r, 'Bro') === 'me', 'the player ahead wears the crown');
  r = rivalResult(r, { result: 'l', opp: 'Bro', turns: 9, counts: true }, day).save;
  ok((r as { rivals: Record<string, { streak: number }> }).rivals.Bro.streak === -1, 'a loss resets the win streak');
}

// ---------- stakes between two players ----------
{
  const e = new Engine(DB);
  e.apply({ type: 'START', first: 0, seed: 3, names: ['Jammy', 'Bro'], decks: [Array(20).fill(A), Array(20).fill(B)], fusions: [[], []], mode: 'speed', skills: [null, null] });
  e.apply({ type: 'SURRENDER', player: 1 });
  const jam = withChips({ ...newSpeedSave(), collection: { [A]: 3, [C]: 1 }, decks: [deck([A, A, A])] } as SpeedSave, 5);
  const bro = withChips({ ...newSpeedSave(), collection: { [B]: 3, [C]: 2 }, decks: [deck([B, B, B])], sealed: [] } as SpeedSave, 4);
  ok(anteProblem(jam, { card: A, chips: 0 }) !== null, 'you cannot bet a card your decks use');
  ok(anteProblem(jam, { card: C, chips: 6 }) !== null, 'or more chips than you have');
  const seats: [StakeSeat, StakeSeat] = [
    { name: 'Jammy', stakes: stakesFor(jam, false, { card: C, chips: 2 }), accepted: true },
    { name: 'Bro', stakes: { ...stakesFor(bro, false, { card: C, chips: 3 }), sealed: [{ name: B, by: 'Jammy' }] }, accepted: true },
  ];
  ok(staked(seats[0].stakes, seats[1].stakes), 'two profiles with collection decks are playing for stakes');
  const w = settleStakes(jam, 0, e.state, seats);
  const l = settleStakes(bro, 1, e.state, seats);
  ok(owned(w.save, C) === 2 && chipsOf(w.save) === 8, "the winner takes the loser's bet card and chips");
  ok(owned(l.save, C) === 1 && chipsOf(l.save) === 1, 'the loser gives them up');
  ok(owned(w.save, C) + owned(l.save, C) === 3, 'no card is made or lost');
  // Bro lost, so his rescue never happens.
  ok(!l.lines.some((x) => x.includes('rescued')), 'a rescue only happens when the rescuer wins');
  const guest: [StakeSeat, StakeSeat] = [seats[0], { name: 'Guest' }];
  ok(settleStakes(jam, 0, e.state, guest).save === jam, 'no stakes against a guest');
}
{
  // Jammy's card was sealed by Bro; Jammy wins, rescues it and takes Bro's strongest monster.
  const e = new Engine(DB);
  e.apply({ type: 'START', first: 0, seed: 3, names: ['Jammy', 'Bro'], decks: [Array(20).fill(B), Array(20).fill(A)], fusions: [[], []], mode: 'speed', skills: [null, null] });
  e.apply({ type: 'SURRENDER', player: 1 });
  const jam = { ...newSpeedSave(), collection: { [B]: 3 }, sealed: [{ name: C, by: 'Kaiba', at: 0 }, { name: B, by: 'Bro', at: 1 }] } as SpeedSave;
  const bro = { ...newSpeedSave(), collection: { [A]: 3 }, decks: [deck([A, A])] } as SpeedSave;
  const seats: [StakeSeat, StakeSeat] = [
    { name: 'Jammy', stakes: stakesFor(jam, false) },
    { name: 'Bro', stakes: stakesFor(bro, false) },
  ];
  ok(seats[1].stakes!.prizes!.join() === A, "the prize is the loser's strongest spare monster");
  const freed = withShadow(rescueFirst(jam, 0, e.state, seats), 'w', null, 0, 'Bro', false).save;
  const w = settleStakes(freed, 0, e.state, seats);
  const l = settleStakes(bro, 1, e.state, seats);
  ok(sealedCards(w.save).map((x) => x.name).join() === C, 'the win frees the rescued card, not the one sealed longest');
  ok(owned(w.save, A) === 1 && owned(l.save, A) === 2, 'the rescuer takes a spare copy from the loser');
  ok(settleStakes({ ...bro, decks: [deck([A, A, A])] } as SpeedSave, 1, e.state, seats).save.collection![A] === 3, 'a copy a deck uses is never taken');
}
{
  // Closing the app mid-duel: the ticket settles as a loss next time.
  const bro = withChips({ ...newSpeedSave(), collection: { [C]: 1 } } as SpeedSave, 3);
  const seats: [StakeSeat, StakeSeat] = [
    { name: 'Jammy', stakes: stakesFor(newSpeedSave(), false) },
    { name: 'Bro', stakes: stakesFor(bro, false, { card: C, chips: 2 }) },
  ];
  const t = settleTicket(withTicket(bro, { seat: 1, seats, at: 1 }))!;
  ok(!!t && owned(t.save, C) === 0 && chipsOf(t.save) === 1, 'a duel walked out of costs the bet');
  ok(settleTicket(t.save) === null, 'and settles only once');
}

setSets(null);
console.log(fails ? `\n${fails} FAILED` : '\nall collection tests passed');
process.exit(fails ? 1 : 0);
