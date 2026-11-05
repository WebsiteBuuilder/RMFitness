// The Duelist Room (src/ui/room): trophies on the shelf, Requests on the board, the Ace that
// stands in the room and the room/plain-menu setting. Cosmetic: it reads the saves, never writes.
import { readFileSync } from 'node:fs';
import { DB as APP_DB } from '../src/eds/db';
import { newSpeedSave, withCards, type SpeedSave } from '../src/eds/speedSave';
import { setSets, type SpeedSet } from '../src/collection/sets';
import { newSoloSave } from '../src/eds/speedCampaign/save';
import { newRanked, TOP } from '../src/eds/speedCampaign/ranked';
import { LESSONS } from '../src/eds/tutorial';
import { withAce } from '../src/ace/ace';
import { boardNotes, homeLook, onHomeLook, roomAce, setHomeLook, trophiesOf } from '../src/ui/room/roomData';
import { DB } from './speedkit';
for (const [k, v] of DB) APP_DB.set(k, v);
setSets(JSON.parse(readFileSync('public/cards/speedSets.json', 'utf8')) as SpeedSet[]);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};
const DAY = new Date(2026, 10, 4, 12).getTime();

// ---------- trophies ----------
{
  const s0 = newSpeedSave();
  ok(trophiesOf(s0, newSoloSave()).length === 0, 'a new duelist has an empty shelf');
  const cup = (w: number) => trophiesOf({ ...s0, wins: w }, null).find((t) => t.kind === 'cup');
  ok(cup(1)?.kind === 'cup' && cup(1)!.metal === 'bronze', 'one win: a bronze cup');
  ok(cup(25)?.kind === 'cup' && cup(25)!.metal === 'silver', '25 wins: silver');
  ok(cup(100)?.kind === 'cup' && cup(100)!.metal === 'gold', '100 wins: gold');
  const crowned = { ...s0, wins: 3, rivals: { 'Joey Wheeler': { w: 3, l: 1, d: 0, streak: 2 } } } as SpeedSave;
  const tc = trophiesOf(crowned, null);
  ok(tc.some((t) => t.kind === 'crown' && t.rival === 'Joey Wheeler'), 'King of Games over a rival puts a crown on the shelf');
  const solo = newSoloSave();
  solo.ranked = { ...newRanked('2026-11'), step: TOP, peak: TOP, w: 4, l: 1, kp: 0 };
  const tr = trophiesOf(s0, solo);
  ok(tr[0]?.kind === 'rank' && tr[0].step === TOP, 'this season\'s Ranked shield leads the shelf');
  const old = newSoloSave();
  old.ranked = { ...newRanked('2026-11'), history: [{ season: '2026-10', peak: 7, w: 9, l: 3 }] };
  const to = trophiesOf(s0, old);
  ok(to[0]?.kind === 'rank' && to[0].step === 7, 'not played this season: the best rank ever reached');
  const grad = { ...s0, school: LESSONS.map((l) => l.id) } as SpeedSave;
  ok(trophiesOf(grad, null).some((t) => t.kind === 'school'), 'all of Duel School done: a diploma');
  const ace = withAce({ ...withCards(s0, ['Dark Magician']), aceWins: { 'Dark Magician': 12 } } as SpeedSave, 'Dark Magician');
  ok(trophiesOf(ace, null).some((t) => t.kind === 'bond' && t.lv === 3), 'an Ace at bond 3 earns a medal');
  ok(!trophiesOf(withAce(withCards(s0, ['Dark Magician']), 'Dark Magician'), null).some((t) => t.kind === 'bond'), 'a brand new Ace (bond 1) has no medal yet');
  const all = { ...grad, wins: 120, rivals: crowned.rivals, ace: 'Dark Magician', collection: { 'Dark Magician': 1 }, aceWins: { 'Dark Magician': 60 } } as SpeedSave;
  ok(trophiesOf(all, solo).length === 5 && trophiesOf(all, solo, 3).length === 3, 'the shelf holds at most what fits');
  const before = JSON.stringify(all);
  trophiesOf(all, solo);
  boardNotes(all, DAY);
  ok(JSON.stringify(all) === before, 'the room never changes the save');
}

// ---------- the board ----------
{
  const s0 = newSpeedSave();
  const b = boardNotes(s0, DAY);
  ok(b.notes.length === 3 && b.done === 0, "today's three Duelist Requests are pinned to the board");
  ok(b.notes.every((n) => n.who && n.text && n.need > 0 && n.have <= n.need), 'each note names who asked and how far along it is');
}

// ---------- the Ace ----------
{
  const s0 = withCards(newSpeedSave(), ['Dark Magician', 'Blue-Eyes White Dragon']);
  ok(roomAce(s0, 'Blue-Eyes White Dragon')?.name === 'Blue-Eyes White Dragon' && roomAce(s0, 'Blue-Eyes White Dragon')?.ace === null, 'no Ace picked: the deck\'s strongest monster stands in the room');
  ok(roomAce(withAce(s0, 'Dark Magician'), 'Blue-Eyes White Dragon')?.name === 'Dark Magician', 'a chosen Ace stands there instead');
  ok(roomAce(newSpeedSave(), null) === null, 'no deck and no Ace: nobody stands there');
}

// ---------- the setting ----------
{
  let heard = 0;
  const off = onHomeLook(() => heard++);
  ok(homeLook() === 'room', 'the room is on by default');
  setHomeLook('plain');
  ok(homeLook() === 'plain' && heard === 1, 'switching to the plain menu sticks and tells the home screen');
  setHomeLook('room');
  off();
  ok(homeLook() === 'room', 'and back');
}

// ---------- every room spot is a screen the menu already reaches ----------
{
  const src = readFileSync('src/ui/room/DuelistRoom.tsx', 'utf8');
  const home = readFileSync('src/ui/SpeedHome.tsx', 'utf8');
  const spots = [...src.matchAll(/go\('(\w+)'\)/g)].map((m) => m[1]);
  ok(spots.length >= 5 && spots.every((g) => home.includes(`go('${g}')`)), `room shortcuts (${[...new Set(spots)].join(', ')}) all lead to screens the tiles reach too`);
  ok(home.includes("setHomeLook(room ? 'plain' : 'room')"), 'Settings has the plain-menu switch');
}

console.log(fails ? `${fails} FAILED` : 'room: all ok');
if (fails) process.exit(1);
