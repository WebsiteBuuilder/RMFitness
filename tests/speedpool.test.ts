// The Speed Duel card pool is exactly the cards printed in Speed Duel products (run: npx tsx tests/speedpool.test.ts).
// - public/cards/speed.json holds every card of Konami's product lists (scripts/speed-products.json) and nothing else
//   (plus YGOPRODeck's Speed Duel promo/demo printings and the Malus Token The Golden Apples makes);
// - every place the game hands out or plays cards (packs, Starter Decks, the Millennium Road, Card Legends,
//   the Tag Road, Boss Raid, the Labyrinth, the random deck maker, the Limited List) uses only those cards;
// - the retired cards (never printed for Speed Duel) are gone and pay back when a save still has them.
import { readFileSync } from 'node:fs';
import { DB as APP_DB } from '../src/eds/db';
import { DB } from './speedkit';
import { STARTERS, newSpeedSave, withCards } from '../src/eds/speedSave';
import { CHAPTERS, JADEN_STORY, JOEY_STORY, YUGI_STORY } from '../src/eds/speedCampaign/roster';
import { LEGENDS } from '../src/eds/speedCampaign/legends';
import { TAG_CHAPTERS } from '../src/eds/speedCampaign/tagRoad';
import { RAIDS } from '../src/eds/raid';
import { boosterSets, openPack, setSets } from '../src/collection/sets';
import { RETIRED, RETIRED_PRICE, dropRetiredPending } from '../src/collection/retired';
import { tierIndex } from '../src/level/leveling';
import { readDeckCode } from '../src/eds/speedCampaign/deckCode';
import { migrate, retireCards, shardsOf, chipsOf } from '../src/collection/economy';

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};

const raw = JSON.parse(readFileSync('public/cards/speed.json', 'utf8')) as { name: string; type: string; sets?: string[] }[];
const products = JSON.parse(readFileSync('scripts/speed-products.json', 'utf8')).products as { name: string; code: string; cards: string[] }[];
const ALIASES: Record<string, string> = { Falchionβ: 'Falchion Beta' };
// Konami and YGOPRODeck differ only in capitals here and there ("Gamma The Magnet Warrior").
const low = (n: string) => n.toLowerCase();
const konami = new Set(products.flatMap((p) => p.cards.map((n) => low(ALIASES[n] ?? n))));
const cards = raw.filter((c) => c.type !== 'Skill Card');
const skills = raw.filter((c) => c.type === 'Skill Card');
const POOL = new Set(raw.map((c) => c.name));
const POOL_LOW = new Set(raw.map((c) => low(c.name)));

// ---------- the list itself ----------
{
  const extra = cards.filter((c) => !konami.has(low(c.name)) && c.name !== 'Malus Token');
  ok(extra.length === 0, `every card in the game is in a Speed Duel product (${cards.length} entries; not printed: ${extra.map((c) => c.name).join(', ') || 'none'})`);
  const missing = [...konami].filter((n) => !POOL_LOW.has(n));
  ok(missing.length === 0, `every card of the ${products.length} Speed Duel products is in the game (${konami.size} names; missing: ${missing.join(', ') || 'none'})`);
  ok(cards.every((c) => c.sets?.length || c.name === 'Malus Token'), 'every card lists the Speed Duel products it was printed in');
  ok(skills.every((c) => c.sets?.length), `every Skill lists its Speed Duel product (${skills.length} Skills)`);
  ok(skills.length === 156, `156 Skill Cards (${skills.length})`);
  const back = [...RETIRED].filter((n) => POOL.has(n));
  ok(back.length === 0, `no retired card is back in the list (${back.join(', ') || 'none'})`);
  ok(RETIRED.size === 280, `280 retired cards (${RETIRED.size})`);
}

// Strings in the game's data that name a card: they must name a Speed Duel card or Skill.
// Pictures and titles may show any card (art, portrait, title, text, who, name keys are skipped).
const SKIP = new Set(['art', 'portrait', 'title', 'text', 'who', 'name', 'blurb', 'itemText', 'id', 'lore', 'line', 'quote']);
const isCardName = (s: string) => DB.has(s) || RETIRED.has(s);
function strays(where: string, v: unknown, out: Set<string>, key = '') {
  if (typeof v === 'string') {
    if (SKIP.has(key)) return;
    const n = v.replace(/\*\d+$/, '');
    if (isCardName(n) && !POOL.has(n) && !POOL.has(n.replace(/ \(Skill Card\)$/, ''))) out.add(`${n} (${where})`);
  } else if (Array.isArray(v)) v.forEach((x) => strays(where, x, out, key));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (typeof x !== 'function') strays(where, x, out, k);
}
for (const [where, data] of [
  ['Starter Decks', STARTERS],
  ['Millennium Road', CHAPTERS],
  ['story decks', [JOEY_STORY, JADEN_STORY, YUGI_STORY]],
  ['Card Legends', LEGENDS],
  ['Tag Road', TAG_CHAPTERS],
  ['Boss Raid', RAIDS],
  ['Limited List', JSON.parse(readFileSync('src/eds/data/speedLimited.json', 'utf8'))],
] as [string, unknown][]) {
  const out = new Set<string>();
  strays(where, data, out);
  ok(out.size === 0, `${where}: only Speed Duel cards (${[...out].join(', ') || 'none outside'})`);
}

// ---------- packs ----------
for (const [k, v] of DB) if (!RETIRED.has(v.name)) APP_DB.set(k, v);
setSets(JSON.parse(readFileSync('public/cards/speedSets.json', 'utf8')));
{
  const sets = boosterSets();
  const inSets = sets.flatMap((s) => s.cards.map(([n]) => n)).filter((n) => !POOL.has(n) && !POOL.has(n.replace(/ \(Skill Card\)$/, '')));
  ok(inSets.length === 0, `the ${sets.length} booster sets list only Speed Duel cards (${inSets.join(', ') || 'none outside'})`);
  ok(sets.some((s) => s.name === 'Speed Duel: Battle City Finals') && sets.some((s) => s.name === 'Speed Duel GX: Midterm Destruction'), 'the 2024 boxes are sold as packs');
  const pulled = new Set<string>();
  for (const s of sets) for (let i = 0; i < 60; i++) for (const n of openPack(s.name, [], 1000 * i + 7)) pulled.add(n);
  const bad = [...pulled].filter((n) => !POOL.has(n));
  ok(bad.length === 0, `${sets.length * 60} opened packs hold only Speed Duel cards (${pulled.size} different cards pulled)`);
}

// ---------- saves that still hold retired cards ----------
{
  const gone = [...RETIRED].slice(0, 3);
  let s = withCards(newSpeedSave(), [gone[0], gone[0], gone[1], 'Blue-Eyes White Dragon']);
  s = { ...s, econ: 1, decks: [{ id: 'd', name: 'Old', main: [gone[0], 'Blue-Eyes White Dragon', gone[2]], extra: [], skill: null }], levels: { [gone[1]]: 50 } } as typeof s;
  const r = retireCards(s) as typeof s & { levels?: Record<string, number>; retiredRefund?: number };
  ok(!Object.keys(r.collection ?? {}).some((n) => RETIRED.has(n)) && r.collection?.['Blue-Eyes White Dragon'] === 1, 'retired cards leave the collection, others stay');
  const want = 2 * RETIRED_PRICE.get(gone[0])! + RETIRED_PRICE.get(gone[1])! + tierIndex(50) * 3;
  ok(chipsOf(r) * 10 + shardsOf(r) === want * 10, `3 retired copies and a lifted look pay back what they cost: ${want} Duel Chips' worth (${chipsOf(r)} chips, ${shardsOf(r)} shards)`);
  ok(r.decks[0].main.join() === 'Blue-Eyes White Dragon', 'retired cards leave saved decks');
  ok(!r.levels?.[gone[1]], "retired cards' looks are dropped");
  ok(r.retiredRefund === 3, 'the refund is counted for the notice');
  ok(retireCards(r) === r, 'a second pass pays nothing');
  ok(migrate(r) === r, 'loading the save again changes nothing');
}

// ---------- old deck codes and Labyrinth offers ----------
{
  // A code made before the update carries Gilford the Lightning's old picture id (36354007).
  const d = readDeckCode('SD1.Old..' + (36354007).toString(36) + '_2-' + (89631139).toString(36) + '.');
  ok(!!d && d.main.filter((n) => n === 'Gilford the Lightning').length === 2, `an old deck code keeps Gilford the Lightning (${d?.main.join(', ')})`);
  const gone = [...RETIRED][0];
  const draft = dropRetiredPending({ kind: 'draft', options: [gone, 'Blue-Eyes White Dragon'], dp: 0 } as { kind: 'draft'; options: string[]; dp: number });
  ok(draft?.options.join() === 'Blue-Eyes White Dragon', 'a Labyrinth draft offered before the update loses its retired cards');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
