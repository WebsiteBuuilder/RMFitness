// The Duel Pass: its road, XP and the daily cap, what counts, claiming, the Chips lane, seasons,
// the clock rules, wearing titles/plates/frames, and the badge riding a room's JOIN.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  claimAll,
  DAY_CAP,
  earnPass,
  FRAMES,
  giveReward,
  knownTitle,
  MAX_XP,
  openPrem,
  ownsReward,
  passOwns,
  PLATES,
  PREM_PRICE,
  rewardName,
  ROAD,
  rollSeason,
  TIER_XP,
  TIERS,
  tierAt,
  titleName,
  toClaim,
  trackOf,
  unclaimed,
  wear,
  worn,
  XP_FIRST_WIN,
  XP_LOSS,
  XP_REQUEST,
  XP_WIN,
  type PassReward,
} from '../src/pass/pass';
import { duelBadge, showDuelBadges } from '../src/pass/duel';
import { hasSleeve, isSleeve, sleeveDef, sleeveForName, SLEEVES } from '../src/sleeves/sleeves';
import { SLEEVE_SVG } from '../src/sleeves/art';
import { hasPlaymat, isPlaymat, playmatDef, playmatForName, PLAYMATS } from '../src/playmats/playmats';
import { PLAYMAT_SVG } from '../src/playmats/art';
import { hasMate, isMate } from '../src/mates/roster';
import { newSpeedSave, type SpeedSave } from '../src/eds/speedSave';
import { DuelSession } from '../src/eds/session';
import { MemoryAdapter } from '../src/sync/memory';
import { DB } from './speedkit';
import { DB as APP_DB } from '../src/eds/db';
import { setSets, type SpeedSet } from '../src/collection/sets';
for (const [k, v] of DB) APP_DB.set(k, v);
setSets(JSON.parse(readFileSync('public/cards/speedSets.json', 'utf8')) as SpeedSet[]);

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`ok ${name}`);
};
const NOV = new Date(2026, 10, 10, 12).getTime();
const day = (d: number, base = NOV) => base + d * 86400000;
const win = { counts: true, result: 'w' as const, quick: false, requests: 0 };
const loss = { counts: true, result: 'l' as const, quick: false, requests: 0 };
const chips = (s: SpeedSave, n: number) => ({ ...s, chips: n }) as SpeedSave;
/** a save with this much Pass XP this season */
const at = (xp: number, s = newSpeedSave(), now = NOV) => {
  let save = s;
  let d = 0;
  while ((trackOf(save, day(d, now))?.xp ?? 0) < xp) {
    save = earnPass(save, { ...win, requests: 3 }, day(d, now)).save;
    if ((trackOf(save, day(d, now))?.dayXp ?? 0) >= DAY_CAP) d++;
  }
  return { save, now: day(d, now) };
};

t('the road: 50 tiers, free lane on even tiers, a Chips reward on every tier, all real cosmetics', () => {
  assert.equal(ROAD.length, TIERS);
  assert.equal(TIERS, 50);
  const all: PassReward[] = [];
  for (const d of ROAD) {
    assert.ok(d.prem, `tier ${d.n} has a Chips lane reward`);
    if (d.n % 2 === 0) assert.ok(d.free, `tier ${d.n} has a free reward`);
    else assert.equal(d.free, null);
    all.push(d.prem, ...(d.free ? [d.free] : []));
  }
  const key = (r: PassReward) => `${r.k}:${r.id}`;
  assert.equal(new Set(all.map(key)).size, all.length, 'no reward twice on the road');
  for (const r of all) {
    if (r.k === 'sleeve') assert.ok(isSleeve(r.id), r.id);
    if (r.k === 'mat') assert.ok(isPlaymat(r.id), r.id);
    if (r.k === 'mate') assert.ok(isMate(r.id), r.id);
    if (r.k === 'frame') assert.ok(FRAMES.some((f) => f.id === r.id), r.id);
    if (r.k === 'plate') assert.ok(PLATES.some((p) => p.id === r.id), r.id);
    if (r.k === 'title') assert.ok(titleName(r.id), r.id);
    assert.ok(rewardName(r, '2026-11').name.length > 1);
  }
  // free things never sit on the road; Duel Chip ones may, the pass-only ones only here
  for (const r of all) {
    if (r.k === 'sleeve') assert.ok(!('free' in sleeveDef(r.id)!.cost), r.id);
    if (r.k === 'mat') assert.ok(!('free' in playmatDef(r.id)!.cost), r.id);
  }
  for (const sl of SLEEVES.filter((x) => 'pass' in x.cost)) assert.ok(all.some((r) => r.k === 'sleeve' && r.id === sl.id), `${sl.id} is on the road`);
  for (const m of PLAYMATS.filter((x) => 'pass' in x.cost)) assert.ok(all.some((r) => r.k === 'mat' && r.id === m.id), `${m.id} is on the road`);
  assert.equal(ROAD[49].prem.k, 'mat', 'the top tier pays the top mat');
});

t('pass-only sleeves and mats draw, and computers never wear them', () => {
  for (const id of ['seasoncrest', 'pyramid', 'dragonflare', 'champion'] as const) {
    const svg = SLEEVE_SVG[id];
    assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>') && svg.length < 9000 && !svg.includes('NaN') && !svg.includes('undefined'), id);
    assert.ok(!hasSleeve(newSpeedSave(), id), `${id} is locked at first`);
  }
  for (const id of ['summit', 'champion'] as const) {
    const svg = PLAYMAT_SVG[id];
    assert.ok(svg.startsWith('<svg') && svg.length < 14000 && !svg.includes('NaN'), id);
    assert.ok(!hasPlaymat(newSpeedSave(), id));
  }
  for (let i = 0; i < 400; i++) {
    const name = `Duelist ${i}`;
    assert.ok(!('pass' in sleeveDef(sleeveForName(name))!.cost), name);
    assert.ok(!('pass' in playmatDef(playmatForName(name))!.cost), name);
  }
});

t('XP: a win, a loss, the first win of the day and Requests; every 400 XP a tier', () => {
  const s = newSpeedSave();
  const a = earnPass(s, win, NOV);
  assert.equal(a.gain!.to, XP_WIN + XP_FIRST_WIN);
  const b = earnPass(a.save, win, NOV);
  assert.equal(b.gain!.to - b.gain!.from, XP_WIN, 'the first-win bonus once a day');
  const c = earnPass(b.save, { ...loss, requests: 2 }, NOV);
  assert.equal(c.gain!.to - c.gain!.from, XP_LOSS + 2 * XP_REQUEST);
  assert.equal(tierAt(TIER_XP - 1), 0);
  assert.equal(tierAt(TIER_XP), 1);
  assert.equal(tierAt(MAX_XP + 5000), TIERS);
  // the next day the first win pays again
  const d = earnPass(c.save, win, day(1));
  assert.equal(d.gain!.to - d.gain!.from, XP_WIN + XP_FIRST_WIN);
});

t('nothing for duels that do not count, or that were given up straight away', () => {
  const s = newSpeedSave();
  assert.equal(earnPass(s, { ...win, counts: false }, NOV).gain, null);
  assert.equal(earnPass(s, { ...win, counts: false, requests: 3 }, NOV).save, s);
  const q = earnPass(s, { ...win, quick: true }, NOV);
  assert.equal(q.gain, null, 'a quick surrender pays nothing (no first-win bonus either)');
});

t('the daily cap: never more than 1000 XP a day, about 20 days to the top', () => {
  let s = newSpeedSave();
  for (let i = 0; i < 40; i++) s = earnPass(s, { ...win, requests: 3 }, NOV).save;
  assert.equal(trackOf(s, NOV)!.xp, DAY_CAP);
  const capped = earnPass(s, win, NOV);
  assert.equal(capped.gain!.to, capped.gain!.from);
  assert.ok(capped.gain!.capped);
  const days = Math.ceil(MAX_XP / DAY_CAP);
  assert.ok(days >= 18 && days <= 26, `${days} days of the cap to reach tier 50`);
  // a steady player (3 duels a day, 2 wins) gets most of the way in a month, not all of it in a week
  let p = newSpeedSave();
  for (let d = 0; d < 30; d++) for (const r of [win, win, loss]) p = earnPass(p, r, day(d, new Date(2026, 10, 1, 9).getTime())).save;
  const tier = tierAt(trackOf(p, new Date(2026, 10, 30, 22).getTime())!.xp);
  assert.ok(tier >= 30 && tier < 50, `a steady month reaches tier ${tier}`);
});

t('claiming: free lane only until the Chips lane opens, then every tier back to 1', () => {
  const { save, now } = at(TIER_XP * 6 + 10);
  assert.equal(tierAt(trackOf(save, now)!.xp), 6);
  assert.equal(toClaim(save, now), 3, 'tiers 2, 4 and 6 on the free lane');
  const c = claimAll(save, now)!;
  assert.equal(c.got.length, 3);
  assert.ok(c.got.every((g) => g.lane === 'free'));
  assert.ok(ownsReward(c.save, ROAD[3].free!, '2026-11'), 'tier 4 Winged Kuriboh');
  assert.ok(hasMate(c.save, 'wkuriboh'));
  assert.equal(claimAll(c.save, now), null, 'nothing twice');
  // the Chips lane: costs chips once, pays tiers 1-6 at once
  assert.equal(openPrem(c.save, now), null, 'not without the chips');
  const rich = chips(c.save, PREM_PRICE + 5);
  const open = openPrem(rich, now)!;
  assert.equal(open.chips, 5);
  assert.equal(openPrem(chips(open, 100), now), null, 'once a season');
  assert.equal(toClaim(open, now), 6);
  const p = claimAll(open, now)!;
  assert.equal(p.got.length, 6);
  assert.ok(hasSleeve(p.save, 'fire'), 'tier 1: FIRE sleeve, on the bought list');
  assert.ok(hasMate(p.save, 'penguin'), 'tier 4: Penguin Soldier');
  assert.ok(!hasPlaymat(p.save, 'fire'), 'tier 7 is not reached yet');
});

t('rewards land where each system reads them, and owning one already is no harm', () => {
  const s = newSpeedSave();
  const a = giveReward(s, { k: 'sleeve', id: 'champion' }, '2026-11');
  assert.ok(passOwns(a, 'sleeve:champion') && hasSleeve(a, 'champion'));
  const b = giveReward(s, { k: 'sleeve', id: 'gold' }, '2026-11');
  assert.ok(hasSleeve(b, 'gold') && (b as { sleeves?: string[] }).sleeves?.includes('gold'));
  const c = giveReward(s, { k: 'mat', id: 'summit' }, '2026-11');
  assert.ok(hasPlaymat(c, 'summit'));
  assert.equal(giveReward(b, { k: 'sleeve', id: 'gold' }, '2026-11'), b, 'a second copy changes nothing');
  const st = giveReward(s, { k: 'stitle', id: 'champion' }, '2026-11');
  assert.equal(titleName('champion@2026-11'), 'Pass Champion · November 2026');
  assert.ok(ownsReward(st, { k: 'stitle', id: 'champion' }, '2026-11'));
  assert.ok(!ownsReward(st, { k: 'stitle', id: 'champion' }, '2026-12'), 'each season has its own');
});

t('wearing: only what you have; the badge rides JOIN and the face-off shows only real ones', () => {
  let s = newSpeedSave();
  assert.equal(wear(s, 'title', 'rookie'), null);
  s = giveReward(s, { k: 'title', id: 'rookie' }, '2026-11');
  s = giveReward(s, { k: 'plate', id: 'gold' }, '2026-11');
  s = giveReward(s, { k: 'frame', id: 'holo' }, '2026-11');
  s = wear(wear(wear(s, 'title', 'rookie')!, 'plate', 'gold')!, 'frame', 'holo')!;
  assert.deepEqual(worn(s), { title: 'rookie', plate: 'gold', frame: 'holo' });
  assert.deepEqual(worn(wear(s, 'title', null)!).title, null);
  // a hand-edited save that wears something it doesn't own wears nothing
  assert.equal(worn({ ...s, wear: { title: 'mind' } } as SpeedSave).title, null);
  const ses = new DuelSession(new MemoryAdapter());
  ses.send({ type: 'JOIN', player: 0, name: 'A', deck: [], fusion: [], mode: 'speed', badge: { t: 'rookie', p: 'gold' } });
  ses.send({ type: 'JOIN', player: 1, name: 'B', deck: [], fusion: [], mode: 'speed', badge: { t: 'x'.repeat(300), p: 'nope' } as { t: string; p: string } });
  assert.deepEqual(ses.seats[0].badge, { t: 'rookie', p: 'gold' });
  showDuelBadges([ses.seats[0].badge ?? null, ses.seats[1].badge ?? null]);
  assert.deepEqual(duelBadge(0), { title: 'rookie', plate: 'gold' });
  assert.equal(duelBadge(1), null, 'a made-up title or plate from the other phone shows nothing');
  showDuelBadges(null);
  assert.equal(duelBadge(0), null);
  assert.ok(knownTitle('legend@2027-01') && !knownTitle('legend@x') && !knownTitle('nope'));
});

t('a new season: unclaimed rewards are handed over, the track and the Chips lane start again', () => {
  const { save, now } = at(TIER_XP * 4 + 5);
  const open = openPrem(chips(save, 40), now)!;
  const dec = new Date(2026, 11, 2, 10).getTime();
  const r = rollSeason(open, dec);
  assert.ok(r.carried.length >= 4 + 2, `${r.carried.length} carried`);
  const t2 = trackOf(r.save, dec)!;
  assert.equal(t2.season, '2026-12');
  assert.equal(t2.xp, 0);
  assert.equal(t2.prem, false);
  assert.ok(hasSleeve(r.save, 'fire'), "last season's Chips lane tier 1 was handed over");
  // earning in the new season rolls it too and says what it carried
  const e = earnPass(open, win, dec);
  assert.ok(e.carried.length > 0 && trackOf(e.save, dec)!.season === '2026-12');
});

t('the clock: set back, the pass freezes (no XP, no claims) until the real date catches up', () => {
  const { save, now } = at(TIER_XP * 2 + 5);
  const back = now - 3 * 86400000;
  assert.equal(trackOf(save, back), null);
  assert.equal(earnPass(save, win, back).gain, null);
  assert.equal(claimAll(save, back), null);
  assert.equal(openPrem(chips(save, 99), back), null);
  // a season set back is frozen too
  const nextMonth = new Date(2026, 11, 3).getTime();
  const rolled = earnPass(save, win, nextMonth).save;
  assert.equal(earnPass(rolled, win, NOV).gain, null);
});

t('the top: XP stops at tier 50, and unclaimed counts every lane', () => {
  let s = newSpeedSave();
  for (let d = 0; d < 25; d++) for (let i = 0; i < 6; i++) s = earnPass(s, { ...win, requests: 3 }, day(d, new Date(2026, 10, 1, 8).getTime())).save;
  const end = new Date(2026, 10, 30, 23).getTime();
  const tr = trackOf(s, end)!;
  assert.equal(tr.xp, MAX_XP);
  assert.equal(unclaimed(tr).length, 25);
  assert.equal(earnPass(s, win, end).gain, null);
});

t('wiring: duels earn XP where Requests do, the result screen and menus show it', () => {
  const app = readFileSync('src/ui/App.tsx', 'utf8');
  assert.equal((app.match(/earnPass\(/g) ?? []).length, 2, 'solo duels and every other duel');
  assert.ok(/counts: !left && !!st && sd\.ctx\.kind !== 'practice' && !sd\.spec\.watch && !anyGoes/.test(app), 'solo: never Practice, watching or Anything goes');
  assert.ok(app.includes('badge: badgeOf('), 'the badge rides JOIN');
  const home = readFileSync('src/ui/SpeedHome.tsx', 'utf8');
  assert.ok(home.includes("go('pass')") && home.includes('<PassTile'), 'a Pass tile on the Shop tab');
  assert.ok(readFileSync('src/ui/Speed.tsx', 'utf8').includes("sub === 'pass'"));
  assert.ok(readFileSync('src/ui/SpeedResult.tsx', 'utf8').includes('<PassStrip'));
  assert.ok(readFileSync('src/ui/faceoff.tsx', 'utf8').includes('<FaceOffBadge'));
  // cheap: the pass's CSS animates transform and opacity only
  const css = readFileSync('src/pass/pass.css', 'utf8');
  for (const kf of css.match(/@keyframes [\w-]+ \{[\s\S]*?\n\}/g) ?? []) assert.ok(!/(width|height|left|top|box-shadow|filter|background)\s*:/.test(kf), `keyframes only move transform/opacity: ${kf.slice(0, 40)}`);
});

console.log(`\n${n} Duel Pass checks passed`);
