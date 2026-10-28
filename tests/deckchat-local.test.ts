// Deck chat's built-in helper (no key): it reads loose requests, builds legal decks from
// the duelist's cards, makes the edits asked for, and answers card, Skill and rule questions,
// all through the same loop and tools Claude uses (run: npx tsx tests/deckchat-local.test.ts).
import { DB as APP_DB, card } from '../src/eds/db';
import { STARTERS, deckFromStarter, isExtraCard, newSpeedSave, speedDeckProblems, whyCantAdd, type SpeedDeck } from '../src/eds/speedSave';
import { withStarter } from '../src/collection/economy';
import { runTurn } from '../src/deckchat/agent';
import { findCard, localModel, planFor } from '../src/deckchat/local';
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
  ok(unknown.deck.main.join() === base.deck.main.join() && /couldn't tell which card/.test(unknown.text), 'an add with no card name asks for the name and changes nothing');
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
  ok(kinds(agg.deck, 'monster') > kinds(base.deck, 'monster') && agg.deck.main.length === base.deck.main.length, '"make it more aggressive" swaps in attackers and keeps the deck');
  ok(agg.deck.main.filter((n) => !base.deck.main.includes(n)).every((n) => (card(n)?.level ?? 0) <= 4), 'the new attackers need no Tribute');
  const sug = await ask(base, 'what should i add?');
  ok(/best fits for this deck are/.test(sug.text) && sug.deck === base.deck, 'suggestions name cards and change nothing');
  const weak = await ask(base, 'take out the weakest card');
  ok(weak.deck.main.length === base.deck.main.length - 1, '"take out the weakest card" takes out one');
  const top = await ask(base, "what's the strongest monster in my deck");
  ok(/^Your strongest monster here is /.test(top.text), 'names the strongest monster');
  const fus = await ask(base, 'how do i summon a fusion monster');
  ok(/Polymerization/.test(fus.text), 'explains Fusion Summons');
  const copies = await ask(base, 'can i use 4 copies?');
  ok(/up to 3 copies/.test(copies.text), 'explains the 3-copy rule');
}

console.log(fails ? `\n${fails} FAILED` : '\nall deck chat helper checks passed');
process.exit(fails ? 1 : 0);
