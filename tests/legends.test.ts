// Card Legends: every legend's decks are legal and duel to the end, unlocks go in order, and
// Duel Chips come only from firsts and one rematch a day (nothing to farm).
// Run: npx tsx tests/legends.test.ts
import { DB as KIT, aiAction, playDuel } from './speedkit';
import { DB } from '../src/eds/db';
import { newSpeedSave, speedDeckProblems, withCards } from '../src/eds/speedSave';
import { getSkill } from '../src/eds/skills';
import { newSoloSave, type SoloSave } from '../src/eds/speedCampaign/save';
import { settleSolo } from '../src/eds/speedCampaign/settle';
import { todayString } from '../src/eds/speedCampaign/labyrinth';
import { LEGENDS, LEGEND_CHIPS_TOTAL, findLegendDuel, legendBorrowed, legendDuelOpen, legendFinished, legendFoe, legendOpen, nextLegendDuel, rematchOf, rematchPays, settleLegend } from '../src/eds/speedCampaign/legends';
import type { DuelOutcome } from '../src/eds/speedCampaign/types';
import { expand } from '../src/eds/speedCampaign/campaign';

for (const [k, v] of KIT) DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) console.log(`FAIL: ${msg}`);
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
  if (!c) fails++;
};

const WIN: DuelOutcome = { result: 'w', myLp: 3000, myStartLp: 4000, oppLp: 0, turns: 7, usedSkill: false, myMonsters: 2 };
const LOSS: DuelOutcome = { ...WIN, result: 'l', myLp: 0, oppLp: 2000 };

// ---------- content ----------
ok(LEGENDS.length === 8, `8 legends (${LEGENDS.length})`);
const ids = new Set<string>();
for (const l of LEGENDS) {
  ok(KIT.has(l.card), `${l.id}: legend card ${l.card} exists`);
  ok(l.duels.length === 4, `${l.id}: 4 duels`);
  ok(l.duels.some((d) => d.as), `${l.id}: has a duel with the legend's own deck`);
  for (const d of l.duels) {
    ok(!ids.has(d.id), `${d.id} unique`);
    ids.add(d.id);
    ok(d.scene.length > 0 && d.after.length > 0, `${d.id}: has story before and after`);
    const foe = legendFoe(d);
    const fd = { id: d.id, name: foe.name, main: expand(foe.main), extra: expand(foe.extra), skill: foe.skill };
    const fp = speedDeckProblems(fd);
    ok(fp.length === 0, `${d.id}: ${foe.name}'s deck is legal${fp.length ? `: ${fp.slice(0, 3).join('; ')}` : ''}`);
    ok(KIT.has(foe.portrait), `${d.id}: portrait ${foe.portrait} exists`);
    if (foe.skill) ok(!!getSkill(foe.skill), `${d.id}: Skill ${foe.skill} exists`);
    const b = legendBorrowed(d);
    if (b) {
      const bp = speedDeckProblems({ id: 'b', ...b });
      ok(bp.length === 0, `${d.id}: borrowed deck (${b.name}) is legal${bp.length ? `: ${bp.slice(0, 3).join('; ')}` : ''}`);
    }
    for (const c of [...(d.condition?.cpu?.spells ?? []), ...(d.condition?.cpu?.monsters ?? [])]) ok(KIT.has(c), `${d.id}: condition card ${c} exists`);
  }
}

// Every duel with a borrowed deck, and every finale, plays to the end (computer vs computer).
let duels = 0;
for (const l of LEGENDS)
  l.duels.forEach((d, i) => {
    const b = legendBorrowed(d);
    if (!b && i !== l.duels.length - 1) return;
    const foe = legendFoe(d);
    const mine = b ?? legendBorrowed(l.duels.find((x) => x.as)!)!;
    const r = playDuel([mine.main, expand(foe.main)], [mine.extra, expand(foe.extra)], [mine.skill, foe.skill], duels++, [aiAction, aiAction]);
    ok(!r.fail, `${d.id}: duel plays to the end${r.fail ? `: ${r.fail}` : ''}`);
  });

// ---------- unlocks ----------
let speed = withCards(newSpeedSave(), []);
let solo: SoloSave = newSoloSave();
ok(legendOpen(solo, LEGENDS[0]) && !legendOpen(solo, LEGENDS[1]), 'only the first legend is open at the start');
ok(legendDuelOpen(solo, LEGENDS[0], 0) && !legendDuelOpen(solo, LEGENDS[0], 1), 'duels open one at a time');
ok(nextLegendDuel(solo)?.duel.id === LEGENDS[0].duels[0].id, 'next duel is the first one');
ok(rematchOf(solo) === null, 'no rematch before any win');

// ---------- rewards ----------
// A loss pays nothing and counts.
let s = settleLegend(speed, solo, 're1', LOSS);
ok((s.speed.chips ?? 0) === 0 && s.solo.legends?.losses === 1, 'a loss pays nothing');
// A forfeit pays nothing and isn't counted.
s = settleLegend(speed, solo, 're1', { ...LOSS, forfeit: true });
ok(s.solo === solo, 'leaving halfway changes nothing');
// First win: 1 chip.
s = settleLegend(speed, solo, 're1', WIN);
ok(s.speed.chips === 1 && s.firstWin, `first win pays 1 chip (${s.speed.chips})`);
speed = s.speed;
solo = s.solo;
// Replaying it pays nothing (unless it is the rematch).
s = settleSolo({ kind: 'legend', duelId: 're1' }, WIN, speed, solo);
ok(s.speed.chips === 1, 'replaying a won duel pays nothing');
// Finish the legend.
for (const id of ['re2', 're3']) ({ speed, solo } = settleLegend(speed, solo, id, WIN));
ok(speed.chips === 3, `three first wins, three chips (${speed.chips})`);
ok(!legendOpen(solo, LEGENDS[1]), 'next legend still locked before the finale');
s = settleLegend(speed, solo, 're4', WIN);
ok(s.finished?.id === 'redeyes', 'the finale finishes the legend');
ok(s.speed.chips === 3 + 1 + 3, `finale pays 1 + 3 chips (${s.speed.chips})`);
ok((s.speed.collection?.['Red-Eyes Black Dragon'] ?? 0) >= 1, 'finale gives the legend card');
ok(s.solo.campaign.titles.includes('Red-Eyes Legend'), 'finale gives the title');
ok(s.cards.length > 1, 'finale opens a pack');
speed = s.speed;
solo = s.solo;
ok(legendFinished(solo, LEGENDS[0]) && legendOpen(solo, LEGENDS[1]), 'finishing opens the next legend');

// Daily rematch: once a day, only today's pick.
const today = todayString();
const pick = rematchOf(solo, today)!;
ok(!!pick && findLegendDuel(pick.id)!.legend.id === 'redeyes', 'rematch picks a duel you have won');
ok(rematchOf(solo, today)!.id === pick.id, 'rematch is the same all day');
const before = speed.chips ?? 0;
const r1 = settleLegend(speed, solo, pick.id, WIN, true);
ok((r1.speed.chips ?? 0) === before + 1 && r1.rematchPaid, 'rematch win pays 1 chip');
ok(!rematchPays(r1.solo, today), 'rematch is spent for today');
const r2 = settleLegend(r1.speed, r1.solo, pick.id, WIN, true);
ok(r2.speed.chips === r1.speed.chips && !r2.rematchPaid, 'second rematch win the same day pays nothing');
const other = ['re1', 're2', 're3', 're4'].find((x) => x !== pick.id)!;
const r3 = settleLegend(speed, solo, other, WIN, true);
ok(r3.speed.chips === speed.chips, "a rematch flag on another duel than today's pays nothing");
const lost = settleLegend(speed, solo, pick.id, LOSS, true);
ok(rematchPays(lost.solo, today), 'losing the rematch keeps it open');

// The 30 cap still holds.
const full = { ...speed, chips: 30 };
const capped = settleLegend(full, LEGENDS.reduce((x) => x, solo), 'hp1', WIN);
ok(capped.speed.chips === 30 && capped.capped, 'chips stop at 30 and say so');

// Totals: what the whole mode pays before rematches.
ok(LEGEND_CHIPS_TOTAL === 8 * (4 + 3), `whole mode pays ${LEGEND_CHIPS_TOTAL} chips`);
let all = { speed: { ...newSpeedSave(), chips: 0 }, solo: newSoloSave() };
let paid = 0;
for (const l of LEGENDS)
  for (const d of l.duels) {
    const x = settleLegend({ ...all.speed, chips: 0 }, all.solo, d.id, WIN);
    paid += x.speed.chips ?? 0;
    all = { speed: x.speed, solo: x.solo };
  }
ok(paid === LEGEND_CHIPS_TOTAL, `playing it all through pays ${paid}`);
ok(LEGENDS.every((l) => legendFinished(all.solo, l)) && nextLegendDuel(all.solo) === null, 'all legends finished');

console.log(fails ? `${fails} failures` : `legends: all checks passed (${duels} duels)`);
process.exit(fails ? 1 : 0);
