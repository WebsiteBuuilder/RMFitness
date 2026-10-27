// Any deck in every solo mode: an Anything goes deck can play the Millennium Road, Card Legends,
// the Duel Labyrinth and the Tag Road. Its wins move you forward but pay nothing, and the
// prizes wait for a later win with a deck built from cards you own.
// Run: npx tsx tests/anydeck.test.ts
import { DB as KIT } from './speedkit';
import { DB } from '../src/eds/db';
import { newSpeedSave } from '../src/eds/speedSave';
import { newSoloSave, type SoloSave } from '../src/eds/speedCampaign/save';
import { endRun, endRunPaid, settleSolo } from '../src/eds/speedCampaign/settle';
import { CHAPTERS } from '../src/eds/speedCampaign/roster';
import { chapterOpen, nodeOpen, nodePassed, soloDeckProblems, startRoad } from '../src/eds/speedCampaign/campaign';
import { LEGENDS, legendDuelOpen, legendDuelPassed, legendDuelWon, legendOpen, nextLegendDuel } from '../src/eds/speedCampaign/legends';
import { fragmentsFor, newRun, summaryOf } from '../src/eds/speedCampaign/labyrinth';
import { TAG_CHAPTERS, nextTagNode, settleTagRoad, tagNodeOpen } from '../src/eds/speedCampaign/tagRoad';
import { openPack } from '../src/collection/sets';
import { registerPackOpener } from '../src/eds/speedCampaign/rewards';
import type { DuelOutcome } from '../src/eds/speedCampaign/types';

for (const [k, v] of KIT) DB.set(k, v);
registerPackOpener(openPack);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) console.log(`FAIL: ${msg}`);
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
  if (!c) fails++;
};
const WIN: DuelOutcome = { result: 'w', myLp: 3000, myStartLp: 4000, oppLp: 0, turns: 5, usedSkill: false, myMonsters: 3 };

// ---------- Millennium Road ----------
let speed = newSpeedSave();
let solo: SoloSave = newSoloSave();
({ speed, solo } = startRoad(speed, solo, 'Yugi Muto'));
const ch1 = CHAPTERS[0];
const first = ch1.nodes[0];
const chips0 = speed.chips ?? 0;
const cards0 = Object.values(speed.collection ?? {}).reduce((a, b) => a + b, 0);
let r = settleSolo({ kind: 'campaign', nodeId: first.id, open: true }, WIN, speed, solo);
ok(r.report.kind === 'campaign' && !!r.report.settled.noEarn, 'road: an Anything goes win is marked as earning nothing');
ok(r.speed === speed, 'road: an Anything goes win changes nothing in the collection');
ok(nodePassed(r.solo, first.id) && nodeOpen(r.solo, ch1, 1), 'road: an Anything goes win opens the next duel');
ok(!(r.solo.campaign.wins[first.id] ?? 0) && !r.solo.campaign.stars[first.id], 'road: no win or stars recorded for prizes');
// Walk a whole chapter with Anything goes: the next chapter opens, no Item.
solo = r.solo;
for (const n of ch1.nodes) solo = settleSolo({ kind: 'campaign', nodeId: n.id, open: true }, WIN, speed, solo).solo;
ok(chapterOpen(solo, CHAPTERS[1]), 'road: clearing a chapter with Anything goes opens the next');
ok(!solo.campaign.items.length && !solo.campaign.cleared, 'road: no Millennium Item for an Anything goes clear');
// The prizes still wait: a win with your own deck pays the first-win rewards.
r = settleSolo({ kind: 'campaign', nodeId: first.id }, WIN, speed, solo);
const cards1 = Object.values(r.speed.collection ?? {}).reduce((a, b) => a + b, 0);
ok(r.report.kind === 'campaign' && r.report.settled.firstWin && cards1 > cards0, 'road: a later win with your own deck still pays the first-win prizes');
ok((r.speed.chips ?? 0) >= chips0, 'road: chips never drop');

// ---------- Card Legends ----------
speed = newSpeedSave();
solo = newSoloSave();
const l0 = LEGENDS[0];
const d0 = l0.duels[0];
let lr = settleSolo({ kind: 'legend', duelId: d0.id, open: true }, WIN, speed, solo);
ok(lr.speed === speed, 'legends: an Anything goes win pays no chips');
ok(lr.report.kind === 'legend' && !!lr.report.settled.noEarn && lr.report.settled.firstWin, 'legends: marked earn-nothing, and the story scene plays');
ok(legendDuelPassed(lr.solo, d0.id) && !legendDuelWon(lr.solo, d0.id) && legendDuelOpen(lr.solo, l0, 1), 'legends: the next duel opens');
solo = lr.solo;
for (const d of l0.duels) solo = settleSolo({ kind: 'legend', duelId: d.id, open: true }, WIN, speed, solo).solo;
ok(legendOpen(solo, LEGENDS[1]) && nextLegendDuel(solo)?.legend.id === LEGENDS[1].id, 'legends: finishing a legend with Anything goes opens the next legend');
ok(!solo.legends?.finished, 'legends: no legend-complete prize screen for an Anything goes finish');
lr = settleSolo({ kind: 'legend', duelId: d0.id }, WIN, speed, solo);
ok((lr.speed.chips ?? 0) > (speed.chips ?? 0), 'legends: a later win with your own deck still pays its chip');

// ---------- Duel Labyrinth ----------
const anyDeck = { id: 'x', name: 'My Anything goes', main: Array<string>(20).fill('Dark Magician').map((n, i) => (i < 3 ? n : [...KIT.keys()][i])), extra: [], skill: null, open: true };
const run = newRun({ starter: 'Yugi Muto', seed: 7, curse: 0, upgrades: [], deck: anyDeck });
ok(run.starter === 'My Anything goes' && run.ownDeck === true && run.open === true, 'labyrinth: a run can start from your own deck');
ok(run.main.length === 20 && run.main[0] === 'Dark Magician', 'labyrinth: the run deck is your deck');
ok(fragmentsFor({ ...run, wins: 5, floor: 2 }) === 0 && summaryOf({ ...run, over: 'won' }).open === true, 'labyrinth: an Anything goes run pays no Soul Fragments');
const daily = newRun({ starter: 'Yugi Muto', seed: 7, curse: 0, upgrades: [], daily: '2026-10-16', deck: anyDeck });
ok(!daily.ownDeck && !daily.open, 'labyrinth: the Daily keeps everyone on the same Starter Deck');
const own = newRun({ starter: 'Yugi Muto', seed: 7, curse: 0, upgrades: [], deck: { ...anyDeck, open: false } });
ok(own.ownDeck === true && !own.open && fragmentsFor({ ...own, wins: 5, floor: 2 }) > 0, 'labyrinth: a deck from your own cards pays as usual');

{
  const s0 = newSoloSave();
  const ended = endRun(s0, { ...run, over: 'won', wins: 9 });
  ok(ended.solo.labyrinth.best === null && ended.solo.labyrinth.fragments === 0, 'labyrinth: an Anything goes run never sets the best run or pays fragments');
  ok(ended.solo.labyrinth.history[0]?.open === true, 'labyrinth: the run history marks it Anything goes');
}

// ---------- Packs for your own deck ----------
{
  const sp = newSpeedSave();
  const cards = (x: typeof sp) => Object.values(x.collection ?? {}).reduce((a, b) => a + b, 0);
  const won = { ...own, over: 'won' as const, wins: 9 };
  const a = endRunPaid(sp, newSoloSave(), won, '2026-10-27');
  ok(cards(a.speed) > cards(sp) && (a.summary.pack?.length ?? 0) > 0, 'labyrinth: a clear with your own deck pays a booster pack');
  const b = endRunPaid(a.speed, a.solo, won, '2026-10-27');
  ok(cards(b.speed) === cards(a.speed), 'labyrinth: a second clear at the same Curse on the same day pays no pack');
  const c = endRunPaid(a.speed, a.solo, won, '2026-10-28');
  ok(cards(c.speed) > cards(a.speed) && c.solo.labyrinth.packDay === '2026-10-28', 'labyrinth: the next day a clear pays the daily pack');
  const c2 = endRunPaid(c.speed, c.solo, won, '2026-10-28');
  ok(cards(c2.speed) === cards(c.speed), 'labyrinth: only one daily clear pack a day');
  const d = endRunPaid(a.speed, a.solo, { ...won, curse: 1 }, '2026-10-27');
  ok(cards(d.speed) > cards(a.speed), 'labyrinth: the first clear at a new Curse pays a pack');
  const e = endRunPaid(sp, newSoloSave(), { ...run, over: 'won', wins: 9 }, '2026-10-27');
  ok(e.speed === sp, 'labyrinth: an Anything goes clear pays no pack');
  const f = endRunPaid(sp, newSoloSave(), { ...own, over: 'lost', wins: 2 }, '2026-10-27');
  ok(f.speed === sp, 'labyrinth: a lost run pays no pack');
  const lg = settleSolo({ kind: 'legend', duelId: LEGENDS[0].duels[0].id }, WIN, sp, newSoloSave());
  ok(cards(lg.speed) > cards(sp), 'legends: a first win with your own deck pays a pack');
  const lg2 = settleSolo({ kind: 'legend', duelId: LEGENDS[0].duels[0].id }, WIN, lg.speed, lg.solo);
  ok(cards(lg2.speed) === cards(lg.speed), 'legends: a replay pays no pack');
  const lg3 = settleSolo({ kind: 'legend', duelId: LEGENDS[0].duels[1].id, open: true }, WIN, sp, newSoloSave());
  ok(lg3.speed === sp, 'legends: an Anything goes win pays no pack');
}

// ---------- Tag Road ----------
speed = newSpeedSave();
solo = newSoloSave();
const t0 = TAG_CHAPTERS[0].nodes[0];
const tr = settleTagRoad(speed, solo, t0.id, WIN, 1, true);
ok(tr.speed === speed && tr.cards.length === 0, 'tag road: an Anything goes win pays nothing');
ok(tagNodeOpen(tr.solo, TAG_CHAPTERS[0], 1) && nextTagNode(tr.solo).id !== t0.id, 'tag road: the next pair opens');
const tr2 = settleTagRoad(speed, tr.solo, t0.id, WIN, 1, false);
ok(tr2.firstWin && tr2.cards.length + tr2.lines.length > 0, 'tag road: a later win with your own deck still pays');

// ---------- deck checks ----------
ok(soloDeckProblems(newSpeedSave(), anyDeck).every((p) => !/own/i.test(p)), 'an Anything goes deck is never blocked for unowned cards');
ok(soloDeckProblems(newSpeedSave(), { ...anyDeck, open: false }).some((p) => /own/i.test(p)), 'a normal deck still has to use cards you own');

console.log(fails ? `\n${fails} failed` : 'anydeck: all passed');
if (fails) process.exit(1);
