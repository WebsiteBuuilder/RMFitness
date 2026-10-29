// Ranked Duel: the ladder climbs and falls by the rules, tier prizes pay once a season, a new
// month resets two tiers down (and can't be replayed by turning the clock back), leaving
// counts as a loss, and every opponent's deck is legal and duels to the end.
// Run: npx tsx tests/ranked.test.ts
import { DB as KIT, aiAction, playDuel } from './speedkit';
import { DB } from '../src/eds/db';
import { DuelSession } from '../src/eds/session';
import { MemoryAdapter } from '../src/sync/memory';
import type { Pid } from '../src/eds/types';
import { newSpeedSave, speedDeckProblems } from '../src/eds/speedSave';
import { newSoloSave, type SoloSave } from '../src/eds/speedCampaign/save';
import { settleSolo } from '../src/eds/speedCampaign/settle';
import { settleLinkRanked, LINK_STARS_PER_DAY, cancelRanked, ladderClock, rankedFirst, starsAt, DAILY_GOAL, TOP_MILESTONE, TOP_MILESTONES, KING, migrateRanked, RANKED_TIERS, STEPS, TOP, openRanked, rankedFoe, rankedProgress, seasonOf, seasonStart, settleRanked, startRanked, stepName, tierFloor, tierIndexOf, newRanked, type RankedProgress } from '../src/eds/speedCampaign/ranked';
import { cleanStats } from '../src/collection/rankings';
import { weekMissions, weekOf } from '../src/eds/speedCampaign/rankedWeekly';
import { boardFrom, ladderScore, postOf } from '../src/online/rankedBoard';
import { mergeLadder } from '../src/online/rankedBoard';
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
ok(STEPS.length === 25, `25 steps (${STEPS.length})`);
ok(stepName(0) === 'Rookie' && stepName(1) === 'Bronze II' && stepName(2) === 'Bronze I' && stepName(3) === 'Silver III' && stepName(18) === 'Duel King III' && stepName(23) === 'Legend I' && stepName(TOP) === 'Pharaoh', `step names (${STEPS.map((_, i) => stepName(i)).join(', ')})`);
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

// Pharaoh: points, never a drop.
solo = at(newSoloSave(), { step: TOP, kp: 1, peak: TOP, paid: RANKED_TIERS.map((_, i) => i) });
r = settleRanked(speed, solo, LOSS, day(5));
r = settleRanked(r.speed, r.solo, LOSS, day(5, 13));
ok(r.after.step === TOP && r.after.kp === 0, `Pharaoh loses points, not rank (${r.after.kp})`);

// Chips: reaching Platinum pays its chip; prizes add up to a fixed total a season.
speed = { ...newSpeedSave(), chips: 0 };
solo = at(newSoloSave(), { step: 8, stars: 3, peak: 8, paid: [0, 1, 2, 3], bonusDay: '2026-10-06' });
r = settleRanked(speed, solo, WIN, day(6));
ok(r.newTier?.id === 'platinum' && r.speed.chips === 1, `Platinum pays 1 chip (${r.speed.chips})`);
const chipsSeason = RANKED_TIERS.reduce((a, t) => a + t.prize.reduce((b, p) => b + (p.kind === 'chips' ? p.n : 0), 0), 0);
ok(chipsSeason === 14, `a whole season of tiers pays 14 chips at most (${chipsSeason})`);

// ---------- leaving ----------
solo = at(newSoloSave(), { step: 4, stars: 1, peak: 4, paid: [0, 1, 2] });
const viaSettle = settleSolo({ kind: 'ranked', season: '2026-10' }, LEFT, speed, solo);
ok(viaSettle.report.kind === 'ranked' && rankedProgress(viaSettle.solo).stars === 0 && rankedProgress(viaSettle.solo).l === 1, 'leaving a Ranked Duel is a loss');
const bronzeLeft = settleRanked(speed, at(newSoloSave(), { step: 2, stars: 1, peak: 2, paid: [0, 1] }), LEFT, day(7));
ok(bronzeLeft.after.stars === 0 && bronzeLeft.gained === -1, 'leaving costs a star even in Bronze');
// Closing the game mid-duel (or a reload) is never a loss: with its moves kept the duel waits
// to be resumed; without them it's dropped with no result and the same opponent comes back.
let started = startRanked(solo, day(7));
ok(!!rankedProgress(started).pending && rankedProgress(started).played === 1, 'starting a duel marks it pending and deals the next foe');
let opened = openRanked(speed, started, day(7, 14), undefined, true);
ok(opened.resume && !opened.dropped && !!rankedProgress(opened.solo).pending && rankedProgress(opened.solo).l === 0 && rankedProgress(opened.solo).stars === 1, 'a cut-off Ranked Duel with kept moves waits to be resumed, nothing lost');
opened = openRanked(speed, started, day(7, 14));
ok(opened.dropped && !opened.resume && rankedProgress(opened.solo).l === 0 && rankedProgress(opened.solo).stars === 1 && !rankedProgress(opened.solo).pending, 'without kept moves it is dropped with no result: no loss, no star lost');
ok(rankedProgress(opened.solo).played === 0 && rankedFoe(rankedProgress(opened.solo)).duelist.name === rankedFoe(rankedProgress(solo)).duelist.name, 'and the same opponent comes back');
opened = openRanked(opened.speed, opened.solo, day(7, 15));
ok(!opened.dropped && rankedProgress(opened.solo).l === 0, 'and only once');
{
  const carried = openRanked(speed, started, new Date(2026, 10, 2), undefined, true);
  ok(carried.resume && !!rankedProgress(carried.solo).pending && rankedProgress(carried.solo).season === '2026-11', 'a kept duel waits into the new month (no dodging it by waiting)');
  const filed = settleRanked(carried.speed, carried.solo, LEFT, new Date(2026, 10, 2, 13));
  ok(rankedProgress(filed.solo).l === 1 && !rankedProgress(filed.solo).pending, 'and its result goes to the new season');
}
{
  const link = settleLinkRanked(speed, started, 'w', 'Rival', day(7, 14));
  ok(!!rankedProgress(link.solo).pending && rankedProgress(link.solo).l === 0, 'a link battle leaves a cut-off Ranked Duel waiting to be resumed');
}
{
  const resumed = settleRanked(speed, openRanked(speed, started, day(7, 14), undefined, true).solo, LEFT, day(7, 15));
  ok(rankedProgress(resumed.solo).l === 1 && !rankedProgress(resumed.solo).pending, 'pressing Leave in the resumed duel is still a loss');
}
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
ok(seasonStart(TOP) === tierFloor(KING - 1) && seasonStart(tierFloor(KING)) === tierFloor(KING - 2) && seasonStart(6) === tierFloor(1) && seasonStart(2) === 0, 'new season starts two tiers down');
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
// Pharaoh: a pack every 5 points (a chip every 10), 6 a season.
speed = { ...newSpeedSave(), chips: 0 };
solo = at(newSoloSave(), { step: TOP, kp: TOP_MILESTONE - 1, peak: TOP, paid: RANKED_TIERS.map((_, i) => i), bonusDay: '2026-10-10' });
r = settleRanked(speed, solo, WIN, day(10));
ok(r.topPaid && rankedProgress(r.solo).topPaid === 1 && r.speed.chips === 0, 'Pharaoh: 5 points pay a pack');
r = settleRanked(r.speed, at(r.solo, { kp: TOP_MILESTONE * 2 - 1 }), WIN, day(10, 12));
ok(r.topPaid && r.speed.chips === 1, `Pharaoh: 10 points pay a pack and a chip (${r.speed.chips})`);
r = settleRanked(r.speed, at(r.solo, { kp: 100 }), WIN, day(10, 13));
ok(rankedProgress(r.solo).topPaid === TOP_MILESTONES && r.speed.chips === TOP_MILESTONES / 2, `milestones stop at ${TOP_MILESTONES} a season (${rankedProgress(r.solo).topPaid}, ${r.speed.chips} chips)`);
r = settleRanked(r.speed, r.solo, WIN, day(10, 14));
ok(!r.topPaid, `no more milestone prizes after ${TOP_MILESTONES}`);
speed = newSpeedSave();
// From Duel King up, streaks stop adding stars; ranks take 5.
solo = at(newSoloSave(), { step: tierFloor(KING), stars: 0, peak: tierFloor(KING), paid: RANKED_TIERS.map((_, i) => i).slice(0, KING + 1), streak: 5, bonusDay: '2026-10-10' });
r = settleRanked(speed, solo, WIN, day(10, 15));
ok(r.gained === 1 && !r.streakBonus && starsAt(tierFloor(KING)) === 5, `Duel King: no streak star, 5-star ranks (${r.gained})`);
// Legend pays its prize and a title once.
solo = at(newSoloSave(), { step: 20, stars: 4, peak: 20, paid: [0, 1, 2, 3, 4, 5, 6, 7], bonusDay: '2026-10-10' });
r = settleRanked(speed, solo, WIN, day(10, 16));
ok(r.newTier?.id === 'legend' && r.lines.some((l) => /Legend · October 2026/.test(l)), `Legend reached: prize + title (${r.lines.join(' / ')})`);
// Old saves: Duel King was the top (step 18) with King points; those climb as stars now.
const old = migrateRanked({ ...newRanked('2026-10'), v: undefined, step: 18, stars: 0, kp: 7, peak: 18 });
ok(old.v === 2 && old.step === 19 && old.stars === 2 && old.kp === 0 && old.peak === 19, `old Duel King with 7 points moves to Duel King II with 2 stars (${stepName(old.step)} ${old.stars})`);
const oldBig = migrateRanked({ ...newRanked('2026-10'), v: undefined, step: 18, kp: 40, peak: 18 });
ok(oldBig.step === TOP && oldBig.kp === 10, `40 old King points reach Pharaoh with 10 left over (${stepName(oldBig.step)} ${oldBig.kp})`);
ok(migrateRanked(old) === old, 'migration runs once');
const viaOpen = openRanked(speed, { ...newSoloSave(), ranked: { ...newRanked('2026-10'), v: undefined, step: 18, kp: 3, peak: 18, w: 30 } }, day(10, 17));
ok(rankedProgress(viaOpen.solo).step === 18 && rankedProgress(viaOpen.solo).stars === 3 && rankedProgress(viaOpen.solo).v === 2, 'opening the ladder moves an old save');
// Who goes first is fixed with the opponent.
const pf = rankedProgress(newSoloSave(), day(1));
ok(rankedFirst(pf) === rankedFirst(pf) && new Set(Array.from({ length: 20 }, (_, i) => rankedFirst({ ...pf, played: i }))).size === 2, 'turn order is fixed per duel and varies between duels');

// Skipping a month (or jumping the clock two months ahead) starts fresh at Rookie with no starting prizes.
opened = openRanked(speed, at(newSoloSave(), { season: '2026-10', step: 13, peak: 13, w: 20, l: 0, paid: [0, 1, 2, 3, 4, 5] }), new Date(2026, 11, 2));
ok(rankedProgress(opened.solo, new Date(2026, 11, 2)).step === 0 && opened.speed === speed, 'a skipped month restarts at Rookie with no starting prizes');
// Leaving with nothing to take costs today's bonus star.
const rookieLeft = settleRanked(speed, at(newSoloSave(), { step: 0, stars: 0 }), LEFT, day(11));
ok(rookieLeft.gained === 0 && rankedProgress(rookieLeft.solo).bonusDay === '2026-10-11', 'leaving with no stars to lose uses up the daily bonus star');
// A thin season (under 10 wins) restarts at Rookie and pays no starting prizes.
opened = openRanked(speed, at(newSoloSave(), { season: '2026-10', step: 13, peak: 13, w: 3, l: 0, paid: [0, 1, 2, 3, 4, 5] }), new Date(2026, 10, 2));
ok(rankedProgress(opened.solo, new Date(2026, 10, 2)).step === 0 && opened.speed === speed, 'a season under 10 wins restarts at Rookie with no starting prizes');

// Friends share their Ranked rank on the leaderboard: kept when sane, dropped when not.
ok(cleanStats({ w: 1, l: 0, d: 0, streak: 0, rk: { s: '2026-10', step: 7, kp: 0 } })?.rk?.step === 7, 'a shared Ranked rank survives cleaning');
ok(!cleanStats({ w: 1, l: 0, d: 0, streak: 0, rk: { s: 'evil', step: 7, kp: 0 } })?.rk, 'a malformed shared rank is dropped');
ok(cleanStats({ w: 1, l: 0, d: 0, streak: 0, rk: { s: '2026-10', step: 999, kp: -4 } })?.rk?.step === 30, 'a shared rank is clamped');

// Link battles with a rival: one plain star a win (no bonus or streak), capped per day; losses cost where Ranked losses do.
solo = at(newSoloSave(), { step: 3, stars: 0, peak: 3, paid: [0, 1, 2], streak: 2 });
let lk = settleLinkRanked(speed, solo, 'w', 'Brother', day(12, 10));
ok(rankedProgress(lk.solo).stars === 1 && rankedProgress(lk.solo).streak === 2 && rankedProgress(lk.solo).bonusDay !== '2026-10-12' && !!lk.line, `a link win is one star, no bonus, streak untouched (${lk.line})`);
for (let i = 0; i < 5; i++) lk = settleLinkRanked(lk.speed, lk.solo, 'w', 'Brother', day(12, 11 + i));
const linkStars = rankedProgress(lk.solo).step * 10 + rankedProgress(lk.solo).stars;
ok(linkStars === 3 * 10 + LINK_STARS_PER_DAY || rankedProgress(lk.solo).step > 3, `link wins stop at ${LINK_STARS_PER_DAY} a day (${stepName(rankedProgress(lk.solo).step)} ${rankedProgress(lk.solo).stars})`);
ok(rankedProgress(lk.solo).linkDay?.[1] === LINK_STARS_PER_DAY, 'the link cap is recorded');
lk = settleLinkRanked(lk.speed, at(lk.solo, { step: 4, stars: 1 }), 'l', 'Brother', day(12, 20));
ok(rankedProgress(lk.solo).stars === 0 && /−1 star/.test(lk.line ?? ''), 'a link loss in Silver costs a star');
lk = settleLinkRanked(speed, at(newSoloSave(), { step: 1, stars: 1 }), 'l', 'Brother', day(12, 21));
ok(rankedProgress(lk.solo).stars === 1 && lk.line === null, 'a link loss in Bronze costs nothing');
lk = settleLinkRanked(speed, at(newSoloSave(), { step: 5, stars: 2, peak: 5, paid: [0, 1, 2] }), 'w', 'Brother', day(13));
ok(rankedProgress(lk.solo).step === 6 && rankedProgress(lk.solo).paid.includes(3) && lk.lines.length > 0, 'a link win into Gold pays the Gold prize once');

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

// ---------- weekly missions ----------
{
  const wk = weekMissions(weekOf(day(12)));
  ok(wk.length === 4 && new Set(wk.map((m) => m.id)).size === 4, `four missions a week (${wk.map((m) => m.id).join(', ')})`);
  ok(weekOf(day(26)) === '2026-10-26' && weekOf(day(28)) === '2026-10-26' && weekOf(new Date(2026, 10, 1)) === '2026-10-26' && weekOf(new Date(2026, 10, 2)) === '2026-11-02', 'weeks start on Monday');
  ok(weekMissions('2026-10-26').map((m) => m.id).join() === weekMissions('2026-10-26').map((m) => m.id).join(), 'the same missions for everyone in a week');
  const weeks = new Set(Array.from({ length: 12 }, (_, i) => weekMissions(weekOf(new Date(2026, 9, 5 + 7 * i))).map((m) => m.id).join()));
  ok(weeks.size > 3, `missions change week to week (${weeks.size} different sets in 12 weeks)`);
  // A win moves the right missions and pays a pack the moment one is done; all four pay the crown.
  let sp = newSpeedSave();
  let so: SoloSave = at(newSoloSave(), { step: 4, stars: 0, peak: 4, paid: [0, 1, 2] });
  const now0 = day(13, 9);
  let crowns = 0;
  let packsDone = 0;
  for (let i = 0; i < 14; i++) {
    const t = new Date(now0.getTime() + i * 3600000);
    const won = settleRanked(sp, so, { ...WIN, myLp: 3500, turns: 6, usedSkill: true }, t, t.getTime(), { wandering: true, second: true });
    sp = won.speed;
    so = won.solo;
    packsDone += won.missions.length;
    if (won.crown) crowns++;
    // a link-battle win for the link mission
    if (i === 0) {
      const lk = settleLinkRanked(sp, so, 'w', 'Brother', new Date(t.getTime() + 60000));
      sp = lk.speed;
      so = lk.solo;
      packsDone += rankedProgress(so).week!.paid.length - packsDone;
    }
  }
  const wp = rankedProgress(so).week!;
  ok(wp.paid.length === 4 && wp.crown === true && crowns === 1, `${weekMissions(wp.id).map((m) => m.id)}: a strong week finishes all four and pays the crown once (${wp.paid.length}, crowns ${crowns}, ${wp.prog.join('/')})`);
  // A streak mission counts wins in a row this week and starts over on a loss.
  const run = weekMissions('2026-10-26').findIndex((m) => m.run);
  if (run >= 0) {
    let s2: SoloSave = at(newSoloSave(), { step: 4, stars: 0, peak: 4, paid: [0, 1, 2] });
    for (const [o, h] of [[WIN, 9], [WIN, 10], [LOSS, 11], [WIN, 12]] as const) s2 = settleRanked(sp, s2, o, day(27, h)).solo;
    ok(rankedProgress(s2).week!.prog[run] === 1, `a loss restarts a streak mission (${rankedProgress(s2).week!.prog[run]})`);
  }
  // Leaving ends a streak mission's run too.
  if (run >= 0) {
    let s3: SoloSave = at(newSoloSave(), { step: 4, stars: 0, peak: 4, paid: [0, 1, 2] });
    for (const [o, h] of [[WIN, 9], [WIN, 10], [LEFT, 11]] as const) s3 = settleRanked(sp, s3, o, day(27, h)).solo;
    ok(rankedProgress(s3).week!.prog[run] === 0, 'leaving restarts a streak mission');
    s3 = settleRanked(sp, s3, WIN, day(27, 12)).solo;
    s3 = startRanked(s3, day(27, 13));
    const kept = rankedProgress(s3).week!.prog[run];
    s3 = openRanked(sp, s3, day(27, 14)).solo;
    ok(rankedProgress(s3).week!.prog[run] === kept, "a duel cut off by the game closing doesn't break it");
  }
  // Leaving never moves a mission forward.
  const before = rankedProgress(so).week!;
  const lf = settleRanked(sp, so, LEFT, day(14, 9));
  ok(JSON.stringify(rankedProgress(lf.solo).week!.prog) === JSON.stringify(before.prog) && lf.missions.length === 0, 'leaving a duel moves no mission');
  // A new week starts a fresh sheet.
  const nx = settleRanked(sp, so, WIN, day(20, 9));
  ok(rankedProgress(nx.solo).week!.id === '2026-10-19' && rankedProgress(nx.solo).week!.prog.every((n) => n <= 1), `Monday starts a fresh sheet (${JSON.stringify(rankedProgress(nx.solo).week)})`);
  // The week survives the month turning.
  const turned = openRanked(sp, at(so, { week: { id: weekOf(new Date(2026, 10, 1)), prog: [1, 0, 0, 0], paid: [] } }), new Date(2026, 10, 1, 12));
  ok(rankedProgress(turned.solo, new Date(2026, 10, 1)).week?.prog[0] === 1, 'a new season keeps the week\'s missions');
}

// ---------- the shared leaderboard ----------
{
  const pr = { ...newRanked('2026-10'), step: 7, stars: 2, w: 9, l: 3 };
  const post = postOf('abc.def', 'Jammy', '#ff8800', pr, 5);
  ok(post.id === 'abc_def' && post.step === 7 && post.stars === 2, 'a post keeps the rank and a safe key');
  ok(ladderScore(TOP, 0, 3) === ladderScore(TOP, 0, 0) + 3 && ladderScore(4, 0, 0) === 3 + 3 + 3 + 3, 'ladder score counts stars up the ladder');
  const raw = {
    a: JSON.stringify({ name: 'Jammy', color: '#f80', step: 7, stars: 2, kp: 0, w: 9, l: 3, at: 5 }),
    b: JSON.stringify({ name: 'Brother', color: '#0af', step: TOP, stars: 0, kp: 12, w: 40, l: 10, at: 6 }),
    c: JSON.stringify({ name: 'Cheat', color: 'javascript:', step: 999, stars: 99, kp: -5, w: -3, l: 0, at: 7 }),
    d: 'not json',
    e: { name: 12 },
  };
  const rows = boardFrom(raw);
  ok(rows.length === 2 && !rows.some((r) => r.name === 'Cheat') && rows[0].name === 'Brother' && rows[0].kp === 12, `the board sorts best first and drops junk (${rows.map((r) => r.name).join(', ')})`);
  const odd = boardFrom({ x: { name: 'Odd', color: 'javascript:', step: TOP, kp: 500, w: 40, l: 0, at: 1 } });
  ok(odd.length === 1 && odd[0].kp === 40 && odd[0].color === '#888888', `Pharaoh Points can't pass wins and colors are checked (${odd[0]?.kp})`);
  ok(boardFrom({ y: { name: 'Fast', step: TOP, kp: 0, w: 2, l: 0 } }).length === 0, 'a rank no one could reach with that many wins is dropped');
  const merged = mergeLadder([{ name: 'Jammy', color: '#f80', step: 6, stars: 0, kp: 0, w: 1, l: 0, kind: 'me' }], rows);
  ok(merged.find((r) => r.name === 'Jammy')?.kind === 'me' && merged.find((r) => r.name === 'Jammy')?.step === 6 && merged.length === 2, 'your own line always comes from this phone');
  const twins = mergeLadder([], boardFrom({ a: { name: 'Sam', step: 3, w: 5 }, b: { name: 'Sam', step: 4, w: 5 } }));
  ok(twins.length === 2, 'two duelists with one name keep two lines');
  const ghost = mergeLadder([{ name: 'NewName', color: '#f80', step: 6, stars: 0, kp: 0, w: 1, l: 0, kind: 'me' }], boardFrom({ me1: { name: 'OldName', step: 7, w: 9 } }), 'me1');
  ok(ghost.length === 1 && ghost[0].name === 'NewName', 'your own old post (an old name) is left out');
}

// ---------- resuming a cut-off Ranked Duel ----------
// The kept room log rebuilds the very same board (the engine is deterministic from START's seed),
// and the duel goes on to the end from there.
{
  const f = rankedFoe({ ...p0, step: 6, played: 1 });
  const ses = new DuelSession(new MemoryAdapter());
  ses.send({ type: 'JOIN', player: 0, name: 'Me', deck: f.main, fusion: f.extra, mode: 'speed', skill: f.duelist.skill });
  ses.send({ type: 'JOIN', player: 1, name: f.duelist.name, deck: f.main, fusion: f.extra, mode: 'speed', skill: f.duelist.skill });
  ses.send({ type: 'START', first: 0, seed: 4242, names: ['Me', f.duelist.name], decks: [f.main, f.main], fusions: [f.extra, f.extra], mode: 'speed', skills: [f.duelist.skill, f.duelist.skill], setup: [null, null] });
  const step = (s: DuelSession) => {
    const st = s.engine.state;
    const pl = (st.prompt ? st.prompt.player : st.turnPlayer) as Pid;
    const act = aiAction(s.engine, pl);
    if (act) s.send(act);
    return !!act;
  };
  for (let i = 0; i < 80 && ses.engine.state.winner === null; i++) if (!step(ses)) break;
  const sig = (s: DuelSession) => JSON.stringify({ t: s.engine.state.turn, lp: s.engine.state.players.map((x) => x.lp), hand: s.engine.state.players.map((x) => x.hand.map((c) => c.name)), w: s.engine.state.winner, ph: s.engine.state.phase });
  const kept = JSON.parse(JSON.stringify(ses.log));
  const back = new DuelSession(new MemoryAdapter(kept));
  ok(ses.engine.state.turn >= 2 && sig(back) === sig(ses), `a resumed Ranked Duel rebuilds the same board (turn ${ses.engine.state.turn})`);
  for (let i = 0; i < 4000 && back.engine.state.winner === null; i++) if (!step(back)) break;
  ok(back.engine.state.winner !== null, 'and plays on to the end');
}
// Only the host takes a win on time: the other phone can't send its own surrender as a dropped connection.
{
  const ses = new DuelSession(new MemoryAdapter());
  const vet = (ses.adapter as unknown as { vet: (e: unknown) => boolean }).vet;
  ok(!vet({ type: 'SURRENDER', player: 1, timeout: true }) && vet({ type: 'SURRENDER', player: 1 }), 'a timeout surrender from the other phone is refused');
}

if (fails) {
  console.log(`ranked: ${fails} failure(s)`);
  process.exit(1);
}
console.log('ranked: all passed');
