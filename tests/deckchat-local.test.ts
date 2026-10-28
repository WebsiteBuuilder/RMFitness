// Deck chat's built-in helper (no key): it reads loose requests, builds legal decks from
// the duelist's cards, makes the edits asked for, and answers card, Skill and rule questions,
// all through the same loop and tools Claude uses (run: npx tsx tests/deckchat-local.test.ts).
import { DB as APP_DB, card } from '../src/eds/db';
import { STARTERS, deckFromStarter, isExtraCard, newSpeedSave, speedDeckProblems, whyCantAdd, type SpeedDeck } from '../src/eds/speedSave';
import { withStarter } from '../src/collection/economy';
import { runTurn } from '../src/deckchat/agent';
import { clean, findCard, findCards, localModel, planFor, type Memory } from '../src/deckchat/local';
import type { ChatWorld } from '../src/deckchat/tools';
import { DB, PLAYABLE, SKILLS } from './speedkit';

for (const [k, v] of DB) APP_DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};
const empty = (open = false): SpeedDeck => ({ id: 't', name: 'Test', main: [], extra: [], skill: null, ...(open ? { open: true } : {}) });

/** one message through the real loop with the helper as the model */
async function ask(w: ChatWorld, text: string) {
  let said = '';
  const tools: string[] = [];
  const r = await runTurn(localModel(() => w), [], text, w, { onText: (d) => (said += d), onTool: (n) => tools.push(n) });
  return { ...r, said, tools, world: { ...w, deck: r.deck } };
}
const diffList = (a: string[], b: string[]) => {
  const left = [...b];
  return a.filter((n) => {
    const i = left.indexOf(n);
    return i < 0 ? true : (left.splice(i, 1), false);
  });
};
const kinds = (d: SpeedDeck, k: string) => d.main.filter((n) => card(n)?.kind === k).length;
/** every card in the deck could be there by the editor's rules (owned copies, 3 each, Limited List) */
function legal(d: SpeedDeck, collection?: Record<string, number>): boolean {
  const all = [...d.main, ...d.extra];
  for (let i = 0; i < all.length; i++) {
    const rest = { ...d, main: [...d.main], extra: [...d.extra] };
    const list = isExtraCard(all[i]) ? rest.extra : rest.main;
    list.splice(list.indexOf(all[i]), 1);
    if (whyCantAdd(rest, all[i], collection)) return false;
  }
  return true;
}

// a big collection: 3 of every playable card, but still a collection (owned rules apply)
const big: Record<string, number> = {};
for (const c of [...PLAYABLE, ...SKILLS]) big[c.name] = 1 + Number(c.sub !== 'Skill') * 2;
const starter = deckFromStarter(STARTERS[0]);
const small = withStarter(newSpeedSave(), starter).collection!;

// ---------- reading names ----------
ok(findCard('what does dark magician do?') === 'Dark Magician', 'finds "dark magician" in a sentence');
ok(findCard('add 2 blue eyes white dragon') === 'Blue-Eyes White Dragon', 'finds Blue-Eyes with no hyphen');
ok(findCard('tell me about the skill', 'skills') === null, 'no Skill named, none found');

// ---------- builds ----------
for (const [what, check] of [
  ['build me a dragon deck', (d: SpeedDeck) => d.main.filter((n) => card(n)?.race === 'Dragon').length >= 6],
  ['make an aggressive DARK deck', (d: SpeedDeck) => d.main.filter((n) => card(n)?.attribute === 'DARK').length >= 6],
  ['build around harpie', (d: SpeedDeck) => d.main.filter((n) => /harpie/i.test(n) || /harpie/i.test(card(n)?.desc ?? '')).length >= 5],
  ['build my strongest deck', () => true],
  ['make a 30 card control deck', (d: SpeedDeck) => d.main.length === 30],
] as const) {
  const r = await ask({ deck: empty(), collection: big }, what);
  ok(r.deck.main.length >= 20 && speedDeckProblems(r.deck).length === 0 && legal(r.deck, big), `"${what}" builds a legal deck ready to duel (${r.deck.main.length} cards, ${r.deck.name})`);
  ok(check(r.deck), `"${what}" fits the ask`);
  ok(/^Built a /.test(r.text) && r.said === r.text, `"${what}" answers and streams its words`);
}
{
  const r = await ask({ deck: empty(), collection: small }, 'build me a deck');
  ok(speedDeckProblems(r.deck).length === 0 && legal(r.deck, small), 'builds from a starter collection with owned copies only');
  const o = await ask({ deck: empty(true) }, 'build me a spellcaster deck');
  ok(o.deck.main.length >= 20 && o.deck.main.filter((n) => card(n)?.race === 'Spellcaster').length >= 6, 'Anything goes decks build from every card');
}

// ---------- edits ----------
{
  const base = (await ask({ deck: empty(), collection: big }, 'build me a warrior deck')).world;
  const kuri = await ask(base, 'add 2 kuriboh');
  ok(kuri.deck.main.filter((n) => n === 'Kuriboh').length - base.deck.main.filter((n) => n === 'Kuriboh').length === 2 || /3 copies|full/i.test(kuri.text), `"add 2 kuriboh" adds two (${kuri.text})`);
  const gone = await ask(kuri.world, 'take out all the kuriboh');
  ok(!gone.deck.main.includes('Kuriboh'), '"take out all the kuriboh" removes every copy');
  const traps = await ask(base, 'more traps');
  ok(kinds(traps.deck, 'trap') > kinds(base.deck, 'trap') && traps.deck.main.length === base.deck.main.length, '"more traps" swaps cards for traps and keeps the size');
  const noTraps = await ask(base, 'remove the traps');
  ok(kinds(noTraps.deck, 'trap') === 0, '"remove the traps" takes them all out');
  const fill = await ask(noTraps.world, 'fill it up');
  ok(fill.deck.main.length >= 20 && legal(fill.deck, big), '"fill it up" tops the deck back up to 20');
  const fewer = await ask(base, 'fewer monsters');
  ok(kinds(fewer.deck, 'monster') < kinds(base.deck, 'monster') && fewer.deck.main.length === base.deck.main.length, '"fewer monsters" swaps monsters out and keeps the size');
  const named = await ask(base, 'call it Big Swords');
  ok(named.deck.name === 'Big Swords' && named.deck.main.join() === base.deck.main.join(), 'rename changes only the name');
  const clear = await ask(base, 'clear the deck');
  ok(clear.deck.main.length === 0, 'clear empties it');
  const unknown = await ask(base, 'add 2 of that one card');
  ok(unknown.deck.main.join() === base.deck.main.join() && /couldn't tell which card|Which card/.test(unknown.text), 'an add with no card name asks for the name and changes nothing');
}

// ---------- stronger, swaps, rating ----------
{
  // a weak deck: the lowest-ATK playable Normal Monsters
  const weak = PLAYABLE.filter((c) => c.kind === 'monster' && c.vanilla && !isExtraCard(c.name) && (c.level ?? 0) <= 4).sort((a, b) => (a.atk ?? 0) - (b.atk ?? 0)).slice(0, 7);
  const d: SpeedDeck = { ...empty(), main: weak.flatMap((c) => [c.name, c.name, c.name]).slice(0, 20) };
  const w: ChatWorld = { deck: d, collection: big };
  const rate = await ask(w, 'is this deck good?');
  ok(/^I'd give it \d+\/10/.test(rate.text) && rate.deck === d, `rating answers with a score and changes nothing (${rate.text.slice(0, 40)})`);
  const s = await ask(w, 'make it stronger');
  const atk = (x: SpeedDeck) => x.main.reduce((a, n) => a + (card(n)?.atk ?? 0), 0);
  ok(atk(s.deck) > atk(d) && s.deck.main.length === d.main.length && !!s.deck.skill, '"make it stronger" swaps in stronger monsters and adds a Skill');
  const sw = planFor('swap weak monsters', w);
  ok(sw.calls.some((c) => c.name === 'edit_deck'), '"swap weak monsters" (an idea chip) makes swaps');
}

// ---------- Skills ----------
{
  const base = (await ask({ deck: empty(), collection: big }, 'build me a dragon deck')).world;
  const off = await ask(base, 'remove the skill');
  ok(off.deck.skill === null, 'Skill taken off');
  const pickIt = await ask(off.world, 'pick a skill');
  ok(!!pickIt.deck.skill, `"pick a skill" picks one (${pickIt.deck.skill})`);
  const what = await ask(pickIt.world, 'what does my skill do?');
  ok(what.text.includes("'s Skill") && what.deck.skill === pickIt.deck.skill, 'explains the deck\'s Skill');
}

// ---------- questions ----------
{
  const w: ChatWorld = { deck: empty(), collection: small };
  const dm = await ask(w, 'what does dark magician do');
  ok(/^Dark Magician: Level 7 DARK Spellcaster/.test(dm.text) && /You own \d/.test(dm.text), 'card question gives stats, text and copies owned');
  for (const [q, re] of [
    ['how many life points do you start with?', /4000/],
    ['how many cards in the opening hand?', /4 cards/],
    ['is there a main phase 2?', /no Main Phase 2/],
    ['how many cards can a deck have?', /20 to 30/],
  ] as const) {
    const r = await ask(w, q);
    ok(re.test(r.text) && r.tools.length === 0, `rule question: "${q}"`);
  }
  const help = await ask(w, 'hi');
  ok(/I can build/.test(help.text), 'hello gets the help');
  const themes = await ask({ deck: empty(), collection: big }, 'what can I build?');
  ok(/build full /.test(themes.text), 'lists themes the collection can build');
  const nope = await ask(w, 'qwzx plorb');
  ok(/not sure what you mean/.test(nope.text) && nope.deck === w.deck, 'nonsense gets the help and changes nothing');
}

// ---------- the rest of what people ask ----------
{
  const base = (await ask({ deck: empty(), collection: big }, 'can you build a deck with blue eyes')).world;
  ok(base.deck.main.includes('Blue-Eyes White Dragon'), 'a deck "with blue eyes" has Blue-Eyes White Dragon in it');
  const pot = await ask(base, 'put three pot of greed in');
  ok(/isn't a Speed Duel card/.test(pot.text) && pot.deck === base.deck, 'a card outside Speed Duel is explained, not added');
  const agg = await ask(base, 'make it more aggressive');
  ok((kinds(agg.deck, 'monster') >= kinds(base.deck, 'monster') && /^For more attackers/.test(agg.text)) || (/already runs your best attackers/.test(agg.text) && agg.deck === base.deck), `"make it more aggressive" swaps in attackers and keeps the deck (${agg.text.slice(0, 60)})`);
  ok(agg.deck.main.filter((n) => !base.deck.main.includes(n)).every((n) => (card(n)?.level ?? 0) <= 4), 'the new attackers need no Tribute');
  const sug = await ask(base, 'what should i add?');
  ok(/best fits for this deck are/.test(sug.text) && sug.deck === base.deck, 'suggestions name cards and change nothing');
  const weak = await ask(base, 'take out the weakest card');
  ok(weak.deck.main.length >= 20 && diffList(base.deck.main, weak.deck.main).length === 1, '"take out the weakest card" swaps one out and keeps the deck at 20');
  const top = await ask(base, "what's the strongest monster in my deck");
  ok(/^Your strongest monster here is /.test(top.text), 'names the strongest monster');
  const fus = await ask(base, 'how do i summon a fusion monster');
  ok(/Polymerization/.test(fus.text), 'explains Fusion Summons');
  const copies = await ask(base, 'can i use 4 copies?');
  ok(/up to 3 copies/.test(copies.text), 'explains the 3-copy rule');
}

// ---------- loose phrasing, follow-ups, and never wiping a deck by mistake ----------
{
  ok(clean('hey can u at 3 kuriboh pls') === 'add 3 kuriboh', 'greetings and voice slips are cleaned ("at 3" -> "add 3")');
  ok(findCard('blue eys white dragn') === 'Blue-Eyes White Dragon', 'misspelled names still match');
  const many = findCards('add monster reborn, 2 kuriboh and a sangan');
  ok(many.map((f) => `${f.count ?? 1} ${f.name}`).join('|') === '1 Monster Reborn|2 Kuriboh|1 Sangan', 'several cards with their counts in one message');
  // a memory shared across messages, as the chat keeps it
  const mem: Memory = { added: [], removed: [] };
  let w: ChatWorld = { deck: empty(), collection: big };
  const say = async (q: string) => {
    const r = await runTurn(localModel(() => w, mem), [], q, w);
    w = { ...w, deck: r.deck };
    return r;
  };
  const built = await say('hey can u build a dark magician deck pls');
  ok(built.deck.main.includes('Dark Magician') && /Dark Magician/.test(built.deck.name), 'a greeting in front still builds');
  const before = w.deck;
  for (const q of ['explain my deck', 'is it good', 'whats the strongest monster in my deck', 'what should i add', 'my deck has too many traps i think, is it good?']) {
    await say(q);
    ok(w.deck === before || w.deck.main.join() === before.main.join(), `"${q}" leaves the deck alone`);
  }
  await say('add 2 kuriboh and a sangan');
  ok(w.deck.main.filter((n) => n === 'Kuriboh').length === 2 && w.deck.main.includes('Sangan'), 'adds every card asked for');
  const why = await say('why did you put that in');
  ok(/Kuriboh:/.test(why.text) && /Sangan:/.test(why.text), '"why" explains the cards just added');
  await say('actually take that out');
  ok(!w.deck.main.includes('Kuriboh') && !w.deck.main.includes('Sangan'), '"take that out" removes the cards just added');
  const n = w.deck.main.length;
  await say('make it 30 cards');
  ok(w.deck.main.length === 30 && legal(w.deck, big), `"make it 30 cards" grows the deck (was ${n})`);
  await say('make it 20 cards');
  ok(w.deck.main.length === 20, '"make it 20 cards" trims it');
  const traps = kinds(w.deck, 'trap');
  await say('swap the traps for spells');
  ok(kinds(w.deck, 'trap') === 0 && w.deck.main.length === 20, `"swap the traps for spells" keeps 20 cards and no traps (${kinds(w.deck, 'trap')} traps, ${w.deck.main.length} cards)`);
  await say('add a trap');
  ok(kinds(w.deck, 'trap') === 1, '"add a trap" adds one');
  const named = await say('build a dragon deck and call it Fire Storm');
  ok(w.deck.name === 'Fire Storm' && w.deck.main.filter((x) => card(x)?.race === 'Dragon').length >= 6, `build plus a name does both (${named.text.slice(0, 30)})`);
  await say('build a deck with no traps');
  ok(kinds(w.deck, 'trap') === 0 && w.deck.main.length >= 20 && speedDeckProblems(w.deck).length === 0, '"a deck with no traps" builds a full legal deck without them');
  const sk = w.deck.skill;
  await say('use a different skill');
  ok(!!w.deck.skill && w.deck.skill !== sk, 'a different Skill really is different');
  const list = await say('what skills do i have');
  ok(/^You have \d+ Skills/.test(list.text), 'lists owned Skills');
  const cmp = await say('whats the difference between dark magician and dark magician girl');
  ok(/Dark Magician:/.test(cmp.text) && /Dark Magician Girl:/.test(cmp.text), 'compares two cards');
  const gf = await say('how does gearfried work');
  ok(/^Gearfried the Iron Knight/.test(gf.text), 'a partial name picks the base card');
  const first = await say('can i attack on my first turn');
  ok(/can't attack on their first turn/.test(first.text), 'first-turn attack rule');
  const harpie = await say('harpy lady deck');
  ok(/Harpie/.test(w.deck.name) && w.deck.main.filter((x) => /Harpie/.test(x)).length >= 4, `"harpy lady deck" builds Harpies (${harpie.text.slice(0, 30)})`);
  const thin = await runTurn(localModel(() => ({ deck: empty(), collection: small })), [], 'build me a dragon deck', { deck: empty(), collection: small });
  ok((/mixed deck for now/.test(thin.text) && thin.deck.name === 'Mixed deck') || (/don't own any/.test(thin.text) && thin.deck.main.length === 0), `a theme the collection can't carry is said plainly, not faked (${thin.text.slice(0, 50)})`);
  // a name the card list doesn't know (an old save) never breaks an edit
  const odd: ChatWorld = { deck: { ...w.deck, main: [...w.deck.main.slice(0, 19), 'Old Removed Card'] }, collection: big };
  let threw = false;
  for (const q of ['take out the weakest card', 'more spells', 'make it stronger', 'is it good']) await runTurn(localModel(() => odd), [], q, odd).catch(() => (threw = true));
  ok(!threw, 'an unknown card in the deck never crashes the helper');
  // Stop: an aborted turn changes nothing
  const ac = new AbortController();
  ac.abort();
  const stopped = await runTurn(localModel(() => w), [], 'clear the deck', w, { signal: ac.signal }).then(() => false, (e) => e.name === 'AbortError');
  ok(stopped, 'Stop before the change stops the turn');
}

// ---------- second review round ----------
{
  const mem: Memory = { added: [], removed: [] };
  let w: ChatWorld = { deck: empty(), collection: big };
  const say = async (q: string) => {
    const r = await runTurn(localModel(() => w, mem), [], q, w);
    w = { ...w, deck: r.deck };
    return r;
  };
  await say('build me a warrior deck');
  const built = w.deck;
  await say('take that out');
  ok(w.deck.main.length === built.main.length, '"take that out" right after a build never empties the deck');
  await say('put in 2 dark magician girl and remove the elegant egotist');
  ok(w.deck.main.filter((n) => n === 'Dark Magician Girl').length === 2, 'add and remove in one message: the add');
  await say('remove two dark magician girl and add 2 celtic guardian');
  ok(!w.deck.main.includes('Dark Magician Girl') && w.deck.main.filter((n) => n === 'Celtic Guardian').length === 2, 'remove then add in one message both happen');
  const sa = w.deck.main.filter((n) => n === 'Sakuretsu Armor').length;
  const rep = await say('replace celtic guardian with 2 sakuretsu armor');
  ok((!w.deck.main.includes('Celtic Guardian') && (w.deck.main.filter((n) => n === 'Sakuretsu Armor').length === Math.min(3, sa + 2) || /Limited/.test(rep.text))) || (/Limited/.test(rep.text) && /Nothing changed/.test(rep.text)), `"replace X with 2 Y" swaps exactly those (had ${sa}, now ${w.deck.main.filter((n) => n === 'Sakuretsu Armor').length}, celtic ${w.deck.main.filter((n) => n === 'Celtic Guardian').length}: ${rep.text})`);
  const sp = kinds(w.deck, 'spell');
  await say('no more spells');
  ok(kinds(w.deck, 'spell') <= sp, '"no more spells" never adds spells');
  await say('remove kuriboh');
  await say('add too kuriboh');
  ok(w.deck.main.filter((n) => n === 'Kuriboh').length === 2, '"add too kuriboh" (voice for two) adds 2');
  await say('take one of those out');
  ok(w.deck.main.filter((n) => n === 'Kuriboh').length === 1, '"take one of those out" takes out one');
  await say('put that back in');
  ok(w.deck.main.filter((n) => n === 'Kuriboh').length === 2, '"put that back in" returns the card just cut');
  await say('take the skill off');
  ok(w.deck.skill === null, '"take the skill off" takes it off');
  await say('use symbol of pride');
  ok(w.deck.skill === 'Symbol of Pride', '"use <Skill>" works without the word Skill');
  await say('take out the traps');
  ok(kinds(w.deck, 'trap') === 0 && w.deck.main.length >= 20, 'cutting a kind refills to 20 without that kind');
  await say('make it a zombie deck');
  ok(w.deck.main.filter((n) => card(n)?.race === 'Zombie').length >= 6, '"make it a zombie deck" restyles the deck');
  const z = w.deck.main.filter((n) => card(n)?.race === 'Dragon').length;
  await say('i want more dragons');
  ok(w.deck.main.filter((n) => card(n)?.race === 'Dragon').length > z, '"more dragons" brings Dragons in');
  await say('make it bigger');
  ok(w.deck.main.length === 25, '"make it bigger" adds 5');
  await say('make it smaller');
  ok(w.deck.main.length === 20, '"make it smaller" cuts 5');
  const big40 = await say('make it 40 cards');
  ok(/20 to 30/.test(big40.text), 'an out-of-range size says the range');
  const before = w.deck;
  await say('remove everything except the monsters');
  ok(w.deck.main.length > 0 && w.deck.main.every((n) => card(n)?.kind === 'monster'), '"remove everything except the monsters" keeps the monsters');
  w = { ...w, deck: before };
  const fd = await say('add harpies feather duster');
  ok(/isn't a Speed Duel card/.test(fd.text) && w.deck === before, 'a non-Speed card with a near Speed name is not swapped for it');
  const thanks = await say('thank you');
  ok(!/not sure/.test(thanks.text) && w.deck === before, 'thanks gets a friendly reply');
  const legalQ = await runTurn(localModel(() => ({ deck: empty(), collection: big })), [], 'is my deck legal?', { deck: empty(), collection: big });
  ok(legalQ.deck.main.length === 0, 'a question about an empty deck doesn\'t build one');
  for (const q of ['tell me something interesting', 'what should I do next', 'a deck for my little sister', 'i think my deck needs work', 'it keeps losing']) ok(!findCards(clean(q)).length, `"${q}" names no card`);
  const bm = await say('make me a blue eyes deck');
  ok(w.deck.main.filter((n) => n === 'Blue-Eyes White Dragon').length === 3, `a Blue-Eyes deck runs 3 Blue-Eyes White Dragon (${bm.deck.name})`);
  const odd: ChatWorld = { deck: { ...w.deck, main: ['Bogus Card', ...w.deck.main.slice(1)] }, collection: big };
  const t0 = Date.now();
  await runTurn(localModel(() => odd), [], 'make it stronger', odd);
  ok(Date.now() - t0 < 3000, 'an unknown card never slows the helper down');
}

// ---------- round 4: not / but / except, restyles, swaps, questions that must not edit ----------
{
  const mem: Memory = { added: [], removed: [] };
  let w: ChatWorld = { deck: empty(), collection: big };
  const say = async (q: string) => {
    const r = await runTurn(localModel(() => w, mem), [], q, w);
    w = { ...w, deck: r.deck };
    return r;
  };
  await say('build a spellcaster deck without dark magician');
  ok(!w.deck.main.includes('Dark Magician') && w.deck.main.length === 20, '"without dark magician" leaves it out of the build');
  await say('add 2 kuriboh and a sangan');
  await say('take kuriboh out but leave sangan');
  ok(w.deck.main.includes('Sangan') && w.deck.main.filter((n) => n === 'Kuriboh').length === 0, '"take kuriboh out but leave sangan" keeps Sangan');
  let before = w.deck;
  const yugi = await say('what skill does yugi use');
  ok(w.deck === before && /Yugi/.test(yugi.text), 'a question about a duelist\'s Skills changes nothing');
  before = w.deck;
  const not = await say('can you not add any more traps');
  ok(w.deck === before && /leave the deck/.test(not.text), '"can you not add any more traps" changes nothing');
  await say('stop adding traps');
  ok(w.deck === before, '"stop adding traps" changes nothing');
  await say('make it zombies but keep sangan');
  ok(w.deck.main.includes('Sangan') && w.deck.main.filter((n) => card(n)?.race === 'Zombie').length >= 6, '"make it zombies but keep sangan" rebuilds as Zombies and keeps Sangan');
  await say('make the deck dragons instead');
  ok(w.deck.main.filter((n) => card(n)?.race === 'Dragon').length >= 6, '"make the deck dragons instead" restyles the deck');
  await say('no more than 2 traps');
  ok(kinds(w.deck, 'trap') <= 2 && w.deck.main.length === 20, '"no more than 2 traps" cuts to 2 and keeps 20 cards');
  const n0 = w.deck.main.length;
  await say('put kuriboh in instead of the weakest card');
  ok(w.deck.main.includes('Kuriboh') && w.deck.main.length === n0, '"instead of the weakest card" swaps one for one');
  const one = w.deck.main.find((n) => w.deck.main.filter((x) => x === n).length >= 2 && card(n)?.kind === 'monster' && n !== 'Kuriboh')!;
  const had = w.deck.main.filter((n) => n === one).length;
  await say(`swap ${one} for 1 sangan`);
  ok(w.deck.main.filter((n) => n === one).length === had - 1 && w.deck.main.length === n0, 'a swap with one count on the right swaps one for one');
  const legal = await say('is the deck legal');
  ok(/legal|Not yet/.test(legal.text), '"is the deck legal" answers about legality');
  const ex = await say('show me the extra deck');
  ok(/Extra Deck/.test(ex.text), '"show me the extra deck" lists it');
  const ss = await say('difference between normal and special summon');
  ok(/Special Summon/.test(ss.text), 'normal vs special summon gets a rules answer');
  const cards = await say('how do i get more cards');
  ok(/Card Shop/.test(cards.text), '"how do i get more cards" points to packs');
  before = w.deck;
  const ask2 = await say('what does dark magician do? add it');
  ok(/Dark Magician/.test(ask2.text) && w.deck.main.includes('Dark Magician'), '"what does X do? add it" adds the card asked about');
  const multi = await say('add 1 kuriboh, remove 1 sangan');
  ok(/Kuriboh/.test(multi.text) && /Sangan/.test(multi.text), 'a comma splits two edits');
  const miss = await say('add 2 sages stone and magicians rod');
  ok(/couldn't find/.test(miss.text), 'a name that matches nothing is reported, not dropped');
  const wonder = await say('i wonder if dark magician would fit');
  ok(/^Dark Magician:/.test(wonder.text), 'a whole card name beats a word-only partial match');
  const mm: Memory = { added: [], removed: [] };
  let v: ChatWorld = { deck: empty(), collection: big };
  for (const q of ['build me a warrior deck', 'add 2 kuriboh', 'make it 30 cards', 'make it 20 cards']) v = { ...v, deck: (await runTurn(localModel(() => v, mm), [], q, v)).deck };
  ok(v.deck.main.filter((n) => n === 'Kuriboh').length === 2, 'trimming back to 20 keeps the cards asked for by name');
  const tr = await runTurn(localModel(() => v, mm), [], 'not enough traps', v);
  ok(kinds(tr.deck, 'trap') > kinds(v.deck, 'trap'), '"not enough traps" adds traps');
  const rb = await runTurn(localModel(() => v, mm), [], 'build a red eyes deck', v);
  ok(rb.deck.main.filter((n) => (card(n)?.level ?? 0) >= 7 && card(n)?.kind === 'monster' && card(n)?.sub !== 'Ritual').length <= 4, 'a built deck runs few monsters that need 2 Tributes');
}

// ---------- round 5: combined builds, hedges, whole swaps, repairs, follow-ups ----------
{
  const run = async (w: ChatWorld, mem: Memory, q: string) => {
    const r = await runTurn(localModel(() => w, mem), [], q, w);
    return { r, w: { ...w, deck: r.deck } };
  };
  let mem: Memory = { added: [], removed: [] };
  let { r, w } = await run({ deck: empty(), collection: big }, mem, 'build me a spellcaster deck and make it 30 cards and use the skill magicians act');
  ok(w.deck.main.length === 30 && w.deck.skill === "Magician's Act", `a build with a size and a Skill does all three (${w.deck.main.length}, ${w.deck.skill})`);
  ({ r, w } = await run({ deck: empty(), collection: big }, mem, 'Build me a deck with dark magician girl. Then add more traps. Then tell me if it\'s good.'));
  ok(w.deck.main.length === 20 && /\/10/.test(r.text), 'build, then more traps, then a rating, in one message');
  ({ r, w } = await run({ deck: empty(), collection: big }, mem, 'build me a dragon deck with no warriors'));
  ok(/Dragon/.test(r.text) && !w.deck.main.some((n) => card(n)?.race === 'Warrior'), '"a dragon deck with no warriors" is Dragons with no Warriors');
  const before = w.deck;
  for (const q of ['not sure if i should cut the spells', 'i used to run 3 sangan', 'maybe remove those traps?', 'no more monsters please']) {
    ({ r, w } = await run(w, mem, q));
    ok(w.deck === before || JSON.stringify(w.deck) === JSON.stringify(before), `"${q}" changes nothing`);
  }
  ({ r, w } = await run(w, mem, 'make it 25'));
  ok(w.deck.main.filter((n) => card(n)?.kind === 'monster').every((n) => card(n)?.race === 'Dragon' || before.main.includes(n)), 'filling a Dragon deck adds Dragons');
  ({ r, w } = await run(w, mem, 'what does summoned skull do'));
  ({ r, w } = await run(w, mem, 'add it'));
  ok(w.deck.main.includes('Summoned Skull'), '"add it" after a card question adds that card');
  ({ r, w } = await run(w, mem, 'add another one'));
  ok(w.deck.main.filter((n) => n === 'Summoned Skull').length === 2, '"add another one" adds one more');
  ({ r, w } = await run(w, mem, 'take out the dragons'));
  ok(w.deck.main.length >= 20, 'taking out a whole Type refills to 20');
  mem = { added: [], removed: [] };
  const bad: ChatWorld = { deck: { id: 'b', name: 'Bad', main: ['Totally Fake Card', 'Dark Magician', 'Dark Magician', 'Dark Magician', 'Dark Magician', ...PLAYABLE.filter((c) => c.kind === 'monster' && !isExtraCard(c.name)).slice(0, 18).map((c) => c.name)], extra: [], skill: 'Fake Skill' }, collection: big };
  ({ r, w } = await run(bad, mem, 'fix my deck'));
  ok(!w.deck.main.includes('Totally Fake Card') && w.deck.main.filter((n) => n === 'Dark Magician').length <= 3 && !speedDeckProblems(w.deck).length, `"fix my deck" makes a broken deck legal (${speedDeckProblems(w.deck).join('; ')})`);
  ({ r, w } = await run(w, mem, 'clear the deck'));
  ok(!w.deck.main.length && !w.deck.skill, 'clearing takes the Skill off too');
  ({ r, w } = await run(w, mem, 'i want something with dragons but no warriors'));
  ok(w.deck.main.length === 20, '"i want something with dragons" on an empty deck builds one');
  const why = await run(w, mem, 'why is lord of d in here');
  ok(/isn't in this deck|can't find/.test(why.r.text), 'asking why a card that isn\'t there is in the deck says so');
}

// ---------- round 6: Skills kept, remarks never edit, spelling, follow-up counts ----------
{
  const mem: Memory = { added: [], removed: [] };
  let w: ChatWorld = { deck: empty(), collection: big };
  const say = async (q: string) => {
    const r = await runTurn(localModel(() => w, mem), [], q, w);
    w = { ...w, deck: r.deck };
    return r;
  };
  await say('mak me a spelcaster dek');
  ok(w.deck.main.length === 20 && w.deck.main.filter((n) => card(n)?.race === 'Spellcaster').length >= 6, 'misspelled "mak me a spelcaster dek" builds Spellcasters');
  const sk = w.deck.skill;
  await say('make it stronger');
  await say('fix my deck');
  ok(!!w.deck.skill && (!sk || w.deck.skill === sk), `"make it stronger" and "fix my deck" keep a working Skill (${sk} -> ${w.deck.skill})`);
  let before = JSON.stringify(w.deck);
  for (const q of ['can i use 3 of the same card', 'my friend made his deck stronger by adding traps', 'I should probably cut the traps', 'would it be better with 25 cards?', 'he said add kuriboh']) {
    await say(q);
    ok(JSON.stringify(w.deck) === before, `"${q}" changes nothing`);
  }
  await say('add 2 sangan and kuriboh but not witch of the black forest');
  ok(w.deck.main.includes('Sangan') && !w.deck.main.includes('Witch of the Black Forest'), '"but not X" leaves X out of an add');
  await say('add kuriboh');
  await say('actually make that 3');
  ok(w.deck.main.filter((n) => n === 'Kuriboh').length === 3, '"make that 3" sets the copies of the card just added');
  const hm = await say('how many do i have now');
  ok(/3 Kuriboh/.test(hm.text), '"how many do i have now" counts the card just added');
  await say('make it thirty cards');
  ok(w.deck.main.length === 30, '"make it thirty cards" reads the number word');
  const bs = await say('whats the best skill for blue eyes');
  ok(!/Executive Privilege/.test(bs.text), 'the Skill suggested for Blue-Eyes is not one made for Obelisk');
  before = JSON.stringify(w.deck);
  const wk = await say('whats my weakest card');
  ok(!/^Your weakest card here is (Kuriboh|Sangan)\b/.test(wk.text), 'the weakest card is never one the player just asked for');
}

// ---------- round 7: character decks, follow-ups, kind swaps, Fusions, odd wording ----------
{
  const mem: Memory = { added: [], removed: [] };
  let w: ChatWorld = { deck: empty(), collection: big };
  const say = async (q: string) => {
    const r = await runTurn(localModel(() => w, mem), [], q, w);
    w = { ...w, deck: r.deck };
    return r;
  };
  await say('make me a deck like yugi');
  ok(w.deck.main.includes('Dark Magician'), '"a deck like yugi" builds around Dark Magician');
  const ys = await say('give me a yugi skill');
  ok(/Yugi/.test(ys.text) && !!w.deck.skill, '"give me a yugi skill" picks one of his Skills');
  const fire = await say('this deck is fire');
  ok(!fire.calls?.length && /like it|Nice|Thanks/.test(fire.text), '"this deck is fire" is a compliment, not a FIRE build');
  await say('add sangan');
  const n0 = w.deck.main.filter((n) => n === 'Sangan').length;
  await say('add two more');
  ok(w.deck.main.filter((n) => n === 'Sangan').length === Math.min(3, n0 + 2), '"add two more" adds copies of the card just added');
  const ls = await say('list the deck');
  ok(/^\d+ cards\. Monsters: /.test(ls.text), '"list the deck" lists it');
  const len = w.deck.main.length;
  const tr = kinds(w.deck, 'trap');
  await say('remove 1 trap');
  ok(kinds(w.deck, 'trap') === tr - 1 && w.deck.main.length === Math.max(20, len - 1), '"remove 1 trap" takes it out without swapping something in');
  const which = await say('which one did you remove');
  ok(/^I took out /.test(which.text), '"which one did you remove" names it');
  await say('no sangan');
  ok(!w.deck.main.includes('Sangan'), '"no sangan" takes Sangan out');
  const wk = await say('whats weak about it');
  ok(/\/10/.test(wk.text), '"whats weak about it" gives the check-up');
  const cut = await say('which card should i take out');
  ok(/^Your weakest card here is /.test(cut.text), '"which card should i take out" names the weakest');
  const before = JSON.stringify(w.deck);
  const gib = await say('swap the traps for zzqqxx');
  ok(JSON.stringify(w.deck) === before && /couldn't find/.test(gib.text), 'a swap to a card nobody can find changes nothing');
  await say('replace the spells with machines');
  ok(kinds(w.deck, 'spell') < kinds(JSON.parse(before), 'spell') && w.deck.main.filter((n) => card(n)?.race === 'Machine').length >= 1, '"replace the spells with machines" swaps spells for Machines');
  const fz = await say('how do i fusion summon dark paladin');
  ok(/Polymerization/.test(fz.text) && /Buster Blader/.test(fz.text) && !/Tributes/.test(fz.text), 'how to Fusion Summon a card names its materials, no Tribute talk');
  const best = await runTurn(localModel(() => ({ deck: empty(), collection: big })), [], 'build the best deck i can with my cards', { deck: empty(), collection: big });
  ok(best.deck.main.length === 20 && !/isn't a Speed Duel card/.test(best.text), '"the best deck i can with my cards" builds');
  const mons = best.deck.main.map((n) => card(n)).filter((c) => c?.kind === 'monster').map((c) => c!.race);
  ok(Math.max(...mons.map((r) => mons.filter((x) => x === r).length)) >= 6, 'the best deck sticks to a Type');
  const bt = await runTurn(localModel(() => ({ deck: empty(), collection: big })), [], 'make me a deck that beats blue eyes', { deck: empty(), collection: big });
  ok(bt.deck.main.length === 20 && /how do I beat blue eyes/.test(bt.text), '"a deck that beats blue eyes" builds and points to the counters');
  // Polymerization is dead without a Fusion the deck can make
  const poly: ChatWorld = { deck: { ...empty(), main: [...Array(17).fill(0).map((_, i) => ['Sangan', 'Kuriboh', 'Gemini Elf', 'Vorse Raider', 'Battle Ox', 'Giant Soldier of Stone'][i % 6]), 'Polymerization', 'Polymerization', 'Polymerization'].slice(0, 20) }, collection: big };
  const wk2 = await runTurn(localModel(() => poly), [], 'whats my weakest card', poly);
  ok(/Polymerization/.test(wk2.text), 'Polymerization with no Fusion to make is the weakest card');
}

// ---------- round 9: polite and sloppy wording, dead cards, Type edits, deck questions ----------
{
  const mem: Memory = { added: [], removed: [] };
  let w: ChatWorld = { deck: empty(), collection: big };
  const say = async (q: string) => {
    const r = await runTurn(localModel(() => w, mem), [], q, w);
    w = { ...w, deck: r.deck };
    return r;
  };
  await say('build me a harpie deck');
  const hq = w.deck.main.filter((n) => n === 'Harpie Queen').length;
  await say('can you put kuriboh in my deck please and also could you take out one harpie queen if thats ok');
  ok(w.deck.main.includes('Kuriboh') && w.deck.main.filter((n) => n === 'Harpie Queen').length === Math.max(0, hq - 1), 'a polite two-part ask adds Kuriboh and takes out one Harpie Queen');
  await say('add 2 dark magican gril');
  ok(w.deck.main.filter((n) => n === 'Dark Magician Girl').length === 2 && !w.deck.main.includes('Dark Magician'), '"dark magican gril" is Dark Magician Girl');
  await say('+2 sangan');
  ok(w.deck.main.filter((n) => n === 'Sangan').length === 2, '"+2 sangan" adds 2');
  await say('kuriboh out');
  ok(!w.deck.main.includes('Kuriboh'), '"kuriboh out" takes it out');
  await say('add 2 kuriboh no wait 1');
  ok(w.deck.main.filter((n) => n === 'Kuriboh').length === 1, '"add 2 kuriboh no wait 1" adds 1');
  const ex = await say('add exodia');
  ok(/aren't in Speed Duel/.test(ex.text), '"add exodia" says Exodia is not in Speed Duel');
  const hl = await say('add harpie lady');
  ok(/Harpie Lady 1/.test(hl.text), '"add harpie lady" adds Harpie Lady 1');
  const rl = await say('can i activate a trap the turn i set it');
  ok(/^No: a Trap has to be Set/.test(rl.text), 'trap timing rule');
  const nw = await say('hi im new how does speed duel work');
  ok(/^Speed Duel is a faster/.test(nw.text), 'a new player gets the overview');
  const sz = await say('how many cards in a deck');
  ok(/20 to 30/.test(sz.text), '"how many cards in a deck" is the rule');
  const hs = await say('how do i summon blue eyes white dragon');
  ok(/Tributing 2/.test(hs.text), '"how do i summon" a Level 8 says 2 Tributes');
  const own = await say('how many blue eyes do i own');
  ok(/^You own \d+/.test(own.text), '"how many X do i own" counts the collection');
  const before = JSON.stringify(w.deck);
  await say('leave the spells alone and add traps');
  ok(kinds(w.deck, 'spell') === kinds(JSON.parse(before), 'spell') && kinds(w.deck, 'trap') > kinds(JSON.parse(before), 'trap'), '"leave the spells alone and add traps" keeps the spells');
  await say('only dragons');
  ok(w.deck.main.filter((n) => card(n)?.kind === 'monster' && card(n)?.race !== 'Dragon' && !(mem.wanted ?? []).includes(n)).length === 0, '"only dragons" swaps the other monsters for Dragons (keeping ones asked for by name)');
  await say('delete the deck');
  ok(w.deck.main.length === 0, '"delete the deck" empties it');
  // built decks: no dead cards
  for (const q of ['build me a dragon deck', 'build me a warrior deck', 'build me a light deck', 'make me a yugi deck']) {
    const r = await runTurn(localModel(() => ({ deck: empty(), collection: big })), [], q, { deck: empty(), collection: big });
    const mons = r.deck.main.map((n) => card(n)).filter((c) => c?.kind === 'monster');
    const dark = mons.filter((c) => c!.attribute === 'DARK').length;
    ok(!(r.deck.main.includes('Allure of Darkness') && dark < 3), `"${q}" has no Allure of Darkness without DARK monsters`);
    ok(!r.deck.main.includes('Toon World') || r.deck.main.some((n) => /^Toon /.test(n) && n !== 'Toon World'), `"${q}" has no Toon World without Toons`);
    ok(r.deck.extra.every((n) => card(n)?.sub !== 'Fusion' || (card(n)!.desc.split(/\n|\. /)[0].match(/"([^"]+)"/g) ?? []).every((m) => r.deck.main.some((x) => x.startsWith(m.slice(1, -1))))), `"${q}" only brings Fusions it has the materials for`);
  }
  const dr = await runTurn(localModel(() => ({ deck: empty(), collection: big })), [], 'build me a dragon deck', { deck: empty(), collection: big });
  ok(dr.deck.main.some((n) => (card(n)?.level ?? 0) >= 7), 'a Dragon deck has a boss monster');
  // the Pegasus starter can build again after "start over"
  const peg = withStarter(newSpeedSave(), deckFromStarter(STARTERS[2])).collection!;
  const pb = await runTurn(localModel(() => ({ deck: empty(), collection: peg })), [], 'build me a deck', { deck: empty(), collection: peg });
  ok(pb.deck.main.length >= 20, 'the Pegasus starter collection still builds a deck');
  // fewer Tribute monsters never adds one
  let bw: ChatWorld = { deck: empty(), collection: big };
  bw = { ...bw, deck: (await runTurn(localModel(() => bw), [], 'build a blue eyes deck', bw)).deck };
  const bigs = (d: SpeedDeck) => d.main.filter((n) => card(n)?.kind === 'monster' && (card(n)!.level ?? 0) >= 5 && card(n)?.sub !== 'Ritual').length;
  const lt = await runTurn(localModel(() => bw), [], 'i want less tribute monsters', bw);
  ok(bigs(lt.deck) <= bigs(bw.deck) && lt.deck.main.length === bw.deck.main.length, '"less tribute monsters" never adds one or grows the deck');
}

// ---------- round 10: follow-ups to suggestions, ruled-out kinds, ATK lines, starter Skills ----------
{
  const mem: Memory = { added: [], removed: [] };
  let w: ChatWorld = { deck: empty(), collection: big };
  const say = async (q: string) => {
    const r = await runTurn(localModel(() => w, mem), [], q, w);
    w = { ...w, deck: r.deck };
    return r;
  };
  await say('build a red eyes deck');
  await say('what skill should i use');
  let crashed = false;
  try {
    await say('add that');
  } catch {
    crashed = true;
  }
  ok(!crashed, '"add that" after a Skill tip does not crash');
  await say('what should i add');
  const n0 = w.deck.main.length;
  const y = await say('yes');
  ok(/^Added /.test(y.text) && w.deck.main.length === n0, '"yes" after suggestions adds them in place of the weakest');
  await say('i dont want any traps');
  await say('no spells either');
  ok(kinds(w.deck, 'trap') === 0 && kinds(w.deck, 'spell') === 0 && w.deck.main.length >= 20, '"no traps" then "no spells either" keeps both out of the refills');
  await say('replace all monsters under 1500 atk');
  ok(w.deck.main.every((n) => card(n)?.kind !== 'monster' || (card(n)!.atk ?? 0) >= 1500 || (mem.wanted ?? []).includes(n) || card(n)!.desc.includes('"') || w.deck.main.some((x) => (card(x)?.desc ?? '').includes(`"${n}"`))), '"replace all monsters under 1500 atk" leaves only bigger ones (bar combo pieces)');
  const tq = await say('how many tributes does blue eyes white dragon need');
  ok(/^2\./.test(tq.text), '"how many tributes does blue eyes need" answers 2');
  const ft = await say('can i summon on my first turn');
  ok(/^Yes/.test(ft.text), '"can i summon on my first turn" says yes');
  for (const i of [0, 3]) {
    const col = withStarter(newSpeedSave(), deckFromStarter(STARTERS[i])).collection!;
    const r = await runTurn(localModel(() => ({ deck: empty(), collection: col })), [], 'build me the best deck i can make', { deck: empty(), collection: col });
    ok(!!r.deck.skill, `starter ${i}: the best deck keeps a Skill (${r.deck.skill})`);
  }
}

// ---------- round 11: Skill fit, Skill follow-ups, outside cards, put back ----------
{
  const mem: Memory = { added: [], removed: [] };
  let w: ChatWorld = { deck: empty(), collection: big };
  const say = async (q: string) => {
    const r = await runTurn(localModel(() => w, mem), [], q, w);
    w = { ...w, deck: r.deck };
    return r;
  };
  await say('build me a beast deck');
  ok(w.deck.skill !== 'Crystal Transcendence', `a Beast deck does not get Crystal Transcendence (${w.deck.skill})`);
  await say('what skill should i use');
  const before = w.deck.skill;
  const sk = await say('put that skill on');
  ok(/Now using|already this deck|^Picked /.test(sk.text) && !!w.deck.skill, `"put that skill on" equips the tip (${sk.text.slice(0, 80)}; was ${before})`);
  const n0 = w.deck.main.length;
  const mw = await say('add maiden with eyes of blue');
  ok(/isn't a Speed Duel card|couldn't find/.test(mw.text) && w.deck.main.length === n0, `"add maiden with eyes of blue" is refused (${mw.text.slice(0, 80)})`);
  const red = w.deck.main.find((n) => card(n)?.kind === 'monster')!;
  await say(`take out ${red}`);
  const pb = await say('put him back');
  ok(w.deck.main.includes(red) && !/couldn't find/i.test(pb.text), `"put him back" re-adds ${red} quietly (${pb.text.slice(0, 80)})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall deck chat helper checks passed');
process.exit(fails ? 1 : 0);
