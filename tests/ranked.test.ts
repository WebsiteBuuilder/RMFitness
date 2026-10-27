// Ranked Duel: the ladder climbs and falls by the rules, tier prizes pay once a season, a new
// month resets two tiers down (and can't be replayed by turning the clock back), leaving
// counts as a loss, and every opponent's deck is legal and duels to the end.
// Run: npx tsx tests/ranked.test.ts
import { DB as KIT, aiAction, playDuel } from './speedkit';
import { DB } from '../src/eds/db';
import { newSpeedSave, speedDeckProblems } from '../src/eds/speedSave';
import { newSoloSave, type SoloSave } from '../src/eds/speedCampaign/save';
import { settleSolo } from '../src/eds/speedCampaign/settle';
import { cancelRanked, ladderClock, rankedFirst, starsAt, DAILY_GOAL, KING_MILESTONE, RANKED_TIERS, STEPS, TOP, openRanked, rankedFoe, rankedProgress, seasonOf, seasonStart, settleRanked, startRanked, stepName, tierFloor, tierIndexOf, newRanked, type RankedProgress } from '../src/eds/speedCampaign/ranked';
import type { DuelOutcome } from '../src/eds/speedCampaign/types';

for (const [k, v] of KIT) DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) console.log(`FAIL: ${msg}`);
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
  if (!c) fails++;
};

const WIN: DuelOutcome = { result: 'w', myLp: 3000, myStartLp: 4000, oppLp: 0, turns: 7, usedSkill: false, myMonsters: 2 };
const LOSS: DuelOutcome = { ...WIN, result: 'l', myLp: 0, oppLp: 2000 };
const LEFT: DuelOutcome = { ...LOSS, forfeit: true };

const day = (d: number, h = 12) => new Date(2026, 9, d, h); // October 2026
const at = (solo: SoloSave, p: Partial<RankedProgress>): SoloSave => ({ ...solo, ranked: { ...rankedProgress(solo, day(1)), ...p } });

// ---------- the ladder ----------
ok(STEPS.length === 19, `19 steps (${STEPS.length})`);
ok(stepName(0) === 'Rookie' && stepName(1) === 'Bronze II' && stepName(2) === 'Bronze I' && stepName(3) === 'Silver III' && stepName(TOP) === 'Duel King', `step names (${STEPS.map((_, i) => stepName(i)).join(', ')})`);
ok(tierFloor(tierIndexOf(8)) === 6, 'Gold I floor is Gold III');
ok(starsAt(5) === 3 && starsAt(6) === 4, 'Gold ranks take 4 stars');

// ---------- climbing ----------
let speed = newSpeedSave();
let solo: SoloSave = newSoloSave();
// First win of the day: +2 (one bonus). Second win same day: +1. Third in a row: +2 (streak).
let r = settleRanked(speed, solo, WIN, day(2));
ok(r.gained === 2 && r.bonus && r.after.step === 0 && r.after.stars === 2, `first win of the day gives 2 stars (${r.gained}, ${stepName(r.after.step)} ${r.after.stars})`);
r = settleRanked(r.speed, r.solo, WIN, day(2, 13));
ok(r.gained === 1 && !r.bonus && r.after.step === 1 && r.after.stars === 0, `second win ranks up to Bronze II (${stepName(r.after.step)} ${r.after.stars})`);
ok(r.newTier?.id === 'bronze' && r.cards.length === 0 && r.lines.length === 1, `reaching Bronze pays its pack once (${r.lines.join(' / ')})`);
r = settleRanked(r.speed, r.solo, WIN, day(2, 14));
ok(r.gained === 2 && r.streakBonus && r.streak === 3, `third win in a row: streak star (${r.gained})`);
// Bronze keeps stars on a loss.
r = settleRanked(r.speed, r.solo, LOSS, day(2, 15));
ok(r.gained === 0 && r.after.stars === r.before.stars && r.streak === 0, 'Bronze: a loss costs nothing and ends the streak');

// Silver: losses take stars and can drop a rank, but never out of Silver.
solo = at(newSoloSave(), { step: 4, stars: 0, peak: 4, paid: [0, 1, 2], bonusDay: '2026-10-03' });
r = settleRanked(speed, solo, LOSS, day(3));
ok(r.after.step === 3 && r.after.stars === 2 && r.gained === -1, `Silver I at 0 stars drops to Silver II with 2 stars (${stepName(r.after.step)} ${r.after.stars})`);
r = settleRanked(r.speed, r.solo, LOSS, day(3, 13));
r = settleRanked(r.speed, r.solo, LOSS, day(3, 14));
r = settleRanked(r.speed, r.solo, LOSS, day(3, 15));
ok(r.after.step === 3 && r.after.stars === 0, `Silver II at 0 stars stays in Silver (${stepName(r.after.step)} ${r.after.stars})`);
r = settleRanked(r.speed, r.solo, LOSS, day(3, 16));
ok(r.gained === 0 && r.after.step === 3, 'a loss at the floor with no stars takes nothing and says so');
ok(rankedProgress(r.solo).peak === 4, 'peak keeps the best rank');
// Climbing back to Silver I pays nothing again; Gold pays its prize once.
const paidBefore = rankedProgress(r.solo).paid.length;
solo = at(r.solo, { step: 5, stars: 2 });
r = settleRanked(r.speed, solo, WIN, day(4));
ok(r.newTier?.id === 'gold' && rankedProgress(r.solo).paid.length === paidBefore + 1, `Gold reached: prize paid (${r.lines.join(' / ')})`);
solo = at(r.solo, { step: 5, stars: 2, bonusDay: '2026-10-04' });
r = settleRanked(r.speed, solo, WIN, day(4, 13));
ok(!r.newTier && r.lines.length === 0, 'Gold reached a second time in the season pays nothing');

// Duel King: points, never a drop.
solo = at(newSoloSave(), { step: TOP, kp: 1, peak: TOP, paid: RANKED_TIERS.map((_, i) => i) });
r = settleRanked(speed, solo, LOSS, day(5));
r = settleRanked(r.speed, r.solo, LOSS, day(5, 13));
ok(r.after.step === TOP && r.after.kp === 0, `Duel King loses points, not rank (${r.after.kp})`);

// Chips: reaching Platinum pays its chip; prizes add up to a fixed total a season.
speed = { ...newSpeedSave(), chips: 0 };
solo = at(newSoloSave(), { step: 8, stars: 3, peak: 8, paid: [0, 1, 2, 3], bonusDay: '2026-10-06' });
r = settleRanked(speed, solo, WIN, day(6));
ok(r.newTier?.id === 'platinum' && r.speed.chips === 1, `Platinum pays 1 chip (${r.speed.chips})`);
const chipsSeason = RANKED_TIERS.reduce((a, t) => a + t.prize.reduce((b, p) => b + (p.kind === 'chips' ? p.n : 0), 0), 0);
ok(chipsSeason === 7, `a whole season pays 7 chips at most (${chipsSeason})`);

// ---------- leaving ----------
solo = at(newSoloSave(), { step: 4, stars: 1, peak: 4, paid: [0, 1, 2] });
const viaSettle = settleSolo({ kind: 'ranked', season: '2026-10' }, LEFT, speed, solo);
ok(viaSettle.report.kind === 'ranked' && rankedProgress(viaSettle.solo).stars === 0 && rankedProgress(viaSettle.solo).l === 1, 'leaving a Ranked Duel is a loss');
const bronzeLeft = settleRanked(speed, at(newSoloSave(), { step: 2, stars: 1, peak: 2, paid: [0, 1] }), LEFT, day(7));
ok(bronzeLeft.after.stars === 0 && bronzeLeft.gained === -1, 'leaving costs a star even in Bronze');
// Closing the game mid-duel: the next visit files it as a loss.
let started = startRanked(solo, day(7));
ok(!!rankedProgress(started).pending && rankedProgress(started).played === 1, 'starting a duel marks it pending and deals the next foe');
let opened = openRanked(speed, started, day(7, 14));
ok(opened.forfeited && rankedProgress(opened.solo).l === 1 && !rankedProgress(opened.solo).pending, 'an unfinished Ranked Duel counts as a loss on the next visit');
opened = openRanked(opened.speed, opened.solo, day(7, 15));
ok(!opened.forfeited && rankedProgress(opened.solo).l === 1, 'and only once');
// A finished duel clears pending without an extra loss.
started = startRanked(solo, day(7));
r = settleRanked(speed, started, WIN, day(7, 16));
ok(rankedProgress(r.solo).l === 0 && rankedProgress(r.solo).w === 1 && !rankedProgress(r.solo).pending, 'a finished duel is filed once');

// Backing out at the toss: no result, same opponent.
started = startRanked(solo, day(7));
const back0 = cancelRanked(started);
ok(!rankedProgress(back0).pending && rankedProgress(back0).played === rankedProgress(solo).played && rankedFoe(rankedProgress(back0)).duelist.name === rankedFoe(rankedProgress(solo)).duelist.name, 'backing out before the duel starts costs nothing and keeps the opponent');

// ---------- seasons ----------
ok(seasonOf(day(1)) === '2026-10', 'season is the month');
ok(seasonStart(TOP) === tierFloor(RANKED_TIERS.length - 3) && seasonStart(6) === tierFloor(1) && seasonStart(2) === 0, 'new season starts two tiers down');
speed = { ...newSpeedSave(), chips: 0 };
solo = at(newSoloSave(), { season: '2026-10', step: 12, stars: 1, peak: 13, w: 20, l: 9, paid: [0, 1, 2, 3, 4, 5] });
opened = openRanked(speed, solo, new Date(2026, 10, 2));
const np = rankedProgress(opened.solo, new Date(2026, 10, 2));
ok(np.season === '2026-11' && np.step === tierFloor(3) && np.stars === 0 && np.w === 0, `November starts at ${stepName(np.step)} (Gold III)`);
ok(np.history[0]?.season === '2026-10' && np.history[0].peak === 13, 'last season goes into history');
ok(np.paid.join() === '0,1,2,3' && !!np.news && np.news.lines.length > 0, `new season pays the tiers it starts in (${np.news?.lines.join(' / ')})`);
// Turning the clock back to October changes nothing.
const back = openRanked(opened.speed, opened.solo, new Date(2026, 9, 30));
ok(rankedProgress(back.solo).season === '2026-11' && back.speed === opened.speed, 'turning the clock back does not replay a season');
// A season with no duels doesn't go into history and restarts at Rookie.
opened = openRanked(speed, { ...newSoloSave(), ranked: newRanked('2026-09') }, day(1));
ok(rankedProgress(opened.solo).history.length === 0 && rankedProgress(opened.solo).step === 0, 'an empty season leaves no history');

// ---------- daily goal, King milestones, the clock ----------
// Bronze wins (losses free) never count toward the daily pack.
solo = at(newSoloSave(), { step: 1, stars: 0, peak: 1, paid: [0, 1] });
r = settleRanked(speed, solo, WIN, day(8, 10));
for (let i = 0; i < DAILY_GOAL; i++) r = settleRanked(r.speed, at(r.solo, { step: 1, stars: 0 }), WIN, day(8, 11 + i));
ok(!r.goalPaid && !rankedProgress(r.solo).goalDay, 'Bronze wins never pay the daily pack');
// Silver: the 3rd win of the day pays one pack, once.
solo = at(newSoloSave(), { step: 3, stars: 0, peak: 3, paid: [0, 1, 2] });
let goals = 0;
r = settleRanked(speed, solo, WIN, day(9, 10));
for (let i = 0; i < 5; i++) {
  if (r.goalPaid) goals++;
  r = settleRanked(r.speed, at(r.solo, { step: 3, stars: 0 }), WIN, day(9, 11 + i));
}
if (r.goalPaid) goals++;
ok(goals === 1, `Silver: the daily pack pays once a day (${goals})`);
// Setting the clock back a day afterwards doesn't bring back the bonus star or the pack.
r = settleRanked(r.speed, at(r.solo, { step: 3, stars: 0 }), WIN, day(8, 9));
ok(!r.bonus && !r.goalPaid, 'the clock set back earlier gives no new bonus');
ok(ladderClock(rankedProgress(r.solo), day(1)).getTime() >= day(9, 15).getTime(), 'the ladder clock never runs backwards');
// Duel King: a pack every 5 points, 3 a season.
solo = at(newSoloSave(), { step: TOP, kp: KING_MILESTONE - 1, peak: TOP, paid: RANKED_TIERS.map((_, i) => i), bonusDay: '2026-10-10' });
r = settleRanked(speed, solo, WIN, day(10));
ok(r.kingPaid && rankedProgress(r.solo).kingPaid === 1, 'Duel King: 5 points pay a pack');
r = settleRanked(r.speed, at(r.solo, { kp: 100 }), WIN, day(10, 13));
ok(rankedProgress(r.solo).kingPaid === 3, `milestones stop at 3 a season (${rankedProgress(r.solo).kingPaid})`);
r = settleRanked(r.speed, r.solo, WIN, day(10, 14));
ok(!r.kingPaid, 'no more milestone packs after 3');
// Who goes first is fixed with the opponent.
const pf = rankedProgress(newSoloSave(), day(1));
ok(rankedFirst(pf) === rankedFirst(pf) && new Set(Array.from({ length: 20 }, (_, i) => rankedFirst({ ...pf, played: i }))).size === 2, 'turn order is fixed per duel and varies between duels');

// A thin season (under 10 wins) restarts at Rookie and pays no starting prizes.
opened = openRanked(speed, at(newSoloSave(), { season: '2026-10', step: 13, peak: 13, w: 3, l: 0, paid: [0, 1, 2, 3, 4, 5] }), new Date(2026, 10, 2));
ok(rankedProgress(opened.solo, new Date(2026, 10, 2)).step === 0 && opened.speed === speed, 'a season under 10 wins restarts at Rookie with no starting prizes');

// ---------- opponents ----------
const p0 = rankedProgress(newSoloSave(), day(1));
ok(rankedFoe(p0).duelist.name === rankedFoe(p0).duelist.name, 'the next opponent stays the same until the duel starts');
const names = new Set<string>();
let wanderers = 0;
let duels = 0;
for (let step = 0; step <= TOP; step++)
  for (let played = 0; played < 8; played++) {
    const f = rankedFoe({ ...p0, step, played });
    names.add(f.duelist.name);
    if (f.wandering) wanderers++;
    const probs = speedDeckProblems({ id: 'x', name: f.duelist.name, main: f.main, extra: f.extra, skill: f.duelist.skill });
    ok(probs.length === 0, `${stepName(step)} #${played} ${f.duelist.name}: legal deck${probs.length ? `: ${probs[0]}` : ''}`);
    if (played < 2) {
      const res = playDuel([f.main, f.main], [f.extra, f.extra], [f.duelist.skill, f.duelist.skill], duels++, [aiAction, aiAction]);
      ok(!res.fail, `${f.duelist.name} duels to the end${res.fail ? `: ${res.fail}` : ''}`);
    }
  }
ok(names.size >= 20, `many different opponents across the ladder (${names.size})`);
ok(wanderers > 0, `Wandering Duelists appear from Gold up (${wanderers})`);
ok(!rankedFoe({ ...p0, step: 0, played: 3 }).wandering, 'no Wandering Duelists in Rookie');

if (fails) {
  console.log(`ranked: ${fails} failure(s)`);
  process.exit(1);
}
console.log('ranked: all passed');
