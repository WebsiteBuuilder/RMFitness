// Weather and time of day: the hour follows the turns, the sky follows the soundtrack's
// Life Point levels, a Field Spell changes what falls, and the storm breaks when the duel ends.
import { precipFor, skyFor, timeOfDay, weatherFor } from '../src/ui/weatherRules';
import { DB } from '../src/eds/db';
import { DB as KIT } from './speedkit';
import type { DuelState } from '../src/eds/types';

for (const [k, v] of KIT) DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};

// --- the hour
ok(timeOfDay(1) === 'day' && timeOfDay(2) === 'day', 'the duel opens in the afternoon');
ok(timeOfDay(3) === 'golden' && timeOfDay(4) === 'golden', 'turns 3-4: golden light');
ok(timeOfDay(5) === 'dusk' && timeOfDay(6) === 'dusk', 'turns 5-6: dusk');
ok(timeOfDay(7) === 'night' && timeOfDay(30) === 'night', 'turn 7 on: night');

// --- the sky keeps the soundtrack's lines (music.ts levelFor: 2000 and 1000 LP)
ok(skyFor([4000, 2001]) === 'clear', 'clear while both duelists are above 2000 LP');
ok(skyFor([2000, 4000]) === 'rain' && skyFor([4000, 1001]) === 'rain', 'rain when either is at 2000 or less');
ok(skyFor([1000, 4000]) === 'storm' && skyFor([3000, 0]) === 'storm', 'a storm at 1000 or less');

// --- what falls
ok(precipFor([null, null]) === 'rain', 'rain with no Field Spell');
ok(precipFor(['volcano', 'ocean']) === 'ash', 'ash over a volcano');
ok(precipFor([null, 'wasteland']) === 'sand', 'blowing sand over a wasteland');
ok(precipFor(['wasteland', 'volcano']) === 'ash', 'a volcano wins over a wasteland');

// --- a whole duel state
const st = (lps: [number, number], turn: number, winner: number | null = null, field: string | null = null) =>
  ({ turn, winner, players: [{ lp: lps[0], field: field ? { name: field, faceUp: true } : null }, { lp: lps[1], field: null }] }) as unknown as DuelState;
const w1 = weatherFor(st([4000, 4000], 1));
ok(w1.tod === 'day' && w1.sky === 'clear' && w1.precip === 'rain', 'a fresh duel: a clear afternoon');
ok(weatherFor(st([900, 4000], 5)).sky === 'storm', 'a duelist at 900 LP brings the storm');
ok(weatherFor(st([900, 0], 6, 1)).sky === 'clear', 'the storm breaks when the duel is won');
ok(weatherFor(st([4000, 4000], 1, null, 'Molten Destruction')).precip === 'ash', 'Molten Destruction rains ash');

if (fails) {
  console.log(`${fails} weather check(s) failed`);
  process.exit(1);
}
console.log('weather: all checks passed');
