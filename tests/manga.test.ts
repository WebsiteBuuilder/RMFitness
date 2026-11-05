// Manga attack panels (src/art/mangaRules.ts): which blows freeze on an inked panel, and every
// Type in the Speed Duel pool has its own sound word. Run: npx tsx tests/manga.test.ts
import { readFileSync } from 'node:fs';
import { ATTRIBUTE_INK, inkFor, insetText, isMega, MANGA_COOLDOWN_S, MANGA_HOLD_S, mangaWorthy, RACE_WORDS, soundWordFor, type MangaHit } from '../src/art/mangaRules';

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) (fails++, console.log(`FAIL: ${msg}`));
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
};

const base: MangaHit = { dmg: 0, direct: false, destroys: false, tier: 1, lethal: false, replay: false, attackerLoses: false, sinceLast: Infinity };
const hit = (o: Partial<MangaHit>): MangaHit => ({ ...base, ...o });

// what counts as a big hit
ok(mangaWorthy(hit({ direct: true, dmg: 1200 }), 'big'), 'a 1200 direct attack gets a panel');
ok(!mangaWorthy(hit({ direct: true, dmg: 600 }), 'big'), 'a 600 direct attack does not');
ok(mangaWorthy(hit({ dmg: 1600, destroys: true }), 'big'), '1600 battle damage gets a panel');
ok(mangaWorthy(hit({ destroys: true, tier: 2 }), 'big'), 'a boss destroying a monster gets a panel');
ok(!mangaWorthy(hit({ destroys: true, tier: 1, dmg: 300 }), 'big'), 'a small monster beating a small one does not');
ok(!mangaWorthy(hit({ dmg: 900 }), 'big'), 'a clash for 900 does not');
// never over the moments other layers own
ok(!mangaWorthy(hit({ direct: true, dmg: 4000, lethal: true }), 'big'), 'the winning blow belongs to the ending cutscene and finisher');
ok(!mangaWorthy(hit({ direct: true, dmg: 4000, replay: true }), 'all'), 'never on the replay');
ok(!mangaWorthy(hit({ dmg: 2000, attackerLoses: true }), 'all'), 'never when the attacker loses its own attack');
ok(!mangaWorthy(hit({ direct: true, dmg: 4000 }), 'off'), 'Off is off');
// cooldown keeps a turn of attacks moving
ok(!mangaWorthy(hit({ direct: true, dmg: 1500, sinceLast: 2 }), 'big'), 'two panels in a row wait out the cooldown');
ok(mangaWorthy(hit({ direct: true, dmg: 1500, sinceLast: MANGA_COOLDOWN_S }), 'big'), 'after the cooldown the next big hit gets one');
ok(mangaWorthy(hit({ direct: true, dmg: 3000, sinceLast: 1 }), 'big'), 'a huge hit always gets one');
ok(mangaWorthy(hit({ dmg: 100, sinceLast: 0 }), 'all'), '"Every hit" gets every hit that deals damage');
ok(!mangaWorthy(hit({ dmg: 0, destroys: false }), 'all'), '...but not a blow that does nothing');
ok(isMega({ dmg: 2500 }) && !isMega({ dmg: 2400 }), 'mega from 2500');
ok(MANGA_HOLD_S >= 0.8 && MANGA_HOLD_S <= 1.1, 'about a second');

// sound words
const pool = JSON.parse(readFileSync(new URL('../public/cards/speed.json', import.meta.url), 'utf8')) as { race?: string; attribute?: string }[];
const races = new Set(pool.filter((c) => c.race && c.attribute).map((c) => c.race!));
ok(races.size > 15, 'the pool has its Types');
for (const r of races) ok(!!RACE_WORDS[r]?.length, `${r} has sound words`);
for (const [r, list] of Object.entries(RACE_WORDS)) for (const w of list) ok(w.word.length > 2 && w.word.length <= 12 && w.kana.length > 0, `${r}: "${w.word}" fits and has its kana`);
ok(soundWordFor('Warrior', 0).word === 'SLASH!' && soundWordFor('Warrior', 3).word === 'SLASH!', 'the seed picks among a Type\'s words, steadily');
ok(soundWordFor('Warrior', 1).word !== soundWordFor('Warrior', 0).word, 'different seeds vary the word');
ok(!!soundWordFor(undefined, 5).word && !!soundWordFor('Nonsense', -3).word, 'an unknown Type still gets a word');
const attrs = new Set(pool.filter((c) => c.attribute).map((c) => c.attribute!));
for (const a of attrs) ok(!!ATTRIBUTE_INK[a], `${a} has its own ink`);
ok(inkFor(undefined)[0] === '#ffffff', 'no Attribute: white ink');
ok(insetText({ dmg: 2400, direct: true, destroys: false }) === '-2400', 'the inset shows the damage');
ok(insetText({ dmg: 0, direct: false, destroys: true }) === 'DESTROYED', '...or the monster destroyed');
ok(insetText({ dmg: 0, direct: false, destroys: false }) === null, '...or nothing');

if (fails) (console.log(`${fails} manga test(s) failed`), process.exit(1));
console.log('manga panels: all ok');
