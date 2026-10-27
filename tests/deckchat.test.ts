// Deck chat: the tools follow the deck editor's rules (copies owned, 3 per name, the
// Limited List, Main/Extra sizes, Extra monsters routed to the Extra Deck), names are
// forgiving, and the conversation loop runs a scripted model's tool calls, changes the
// deck and returns its answer (run: npx tsx tests/deckchat.test.ts).
import { DB as APP_DB } from '../src/eds/db';
import { STARTERS, deckFromStarter, limitStatus, newSpeedSave, speedDeckProblems, isExtraCard, type SpeedDeck } from '../src/eds/speedSave';
import { withStarter } from '../src/collection/economy';
import { TOOLS, diffDecks, resolveName, runTool, type ChatWorld } from '../src/deckchat/tools';
import { runTurn, type Model, type ModelReply } from '../src/deckchat/agent';
import { DB, PLAYABLE, SKILLS } from './speedkit';
import { getSkill } from '../src/eds/skills';

for (const [k, v] of DB) APP_DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};
const empty = (open = false): SpeedDeck => ({ id: 't', name: 'Test', main: [], extra: [], skill: null, ...(open ? { open: true } : {}) });

// ---------- a starter collection ----------
const starter = deckFromStarter(STARTERS[0]);
const save = withStarter(newSpeedSave(), starter);
const owned: ChatWorld = { deck: empty(), collection: save.collection };

{
  const t = runTool(owned, 'collection_overview', {}).text;
  ok(/Owns \d+ different playable cards/.test(t), 'collection_overview counts owned cards');
  const s = runTool(owned, 'search_cards', { kind: 'monster', limit: 200 }).text;
  const names = s.split('\n').slice(1).map((l) => l.split(' | ')[0]);
  ok(names.length > 0 && names.every((n) => (save.collection![n] ?? 0) > 0), 'search_cards only shows owned cards');
  const outside = PLAYABLE.find((c) => !save.collection![c.name] && c.kind === 'monster' && !isExtraCard(c.name))!;
  const r = runTool(owned, 'edit_deck', { add: [{ name: outside.name, count: 1 }] });
  ok(r.deck!.main.length === 0 && /don't own/.test(r.text), `edit_deck refuses an unowned card (${outside.name})`);
  // building the starter list back through edit_deck gives a legal deck
  const counts = new Map<string, number>();
  for (const n of [...starter.main, ...starter.extra]) counts.set(n, (counts.get(n) ?? 0) + 1);
  const b = runTool(owned, 'edit_deck', { clear: true, add: [...counts].map(([name, count]) => ({ name, count })), skill: starter.skill, name: 'Rebuilt' });
  ok(!!b.deck && b.deck.main.length === starter.main.length && b.deck.extra.length === starter.extra.length, 'edit_deck rebuilds the starter deck card for card');
  ok(speedDeckProblems(b.deck!).length === 0, 'the rebuilt deck is ready to duel');
  ok(b.deck!.skill === starter.skill && b.deck!.name === 'Rebuilt', 'Skill and name set');
  const v = runTool({ ...owned, deck: b.deck! }, 'view_deck', {}).text;
  ok(/Ready to duel/.test(v) && /Main \d+ \(/.test(v), 'view_deck reports the deck as ready');
  const rm = runTool({ ...owned, deck: b.deck! }, 'edit_deck', { remove: [{ name: starter.main[0], count: 3 }] });
  ok(rm.deck!.main.length < b.deck!.main.length && !rm.deck!.main.includes(starter.main[0]), 'edit_deck removes copies');
  const d = diffDecks(b.deck!, rm.deck!);
  ok((d.removed[starter.main[0]] ?? 0) > 0 && Object.keys(d.added).length === 0, 'diffDecks lists what came out');
}

// ---------- Anything goes: every card, rules still hold ----------
{
  const open: ChatWorld = { deck: empty(true) };
  const mon = PLAYABLE.find((c) => c.kind === 'monster' && !isExtraCard(c.name) && !limitStatus(c.name))!;
  const r = runTool(open, 'edit_deck', { add: [{ name: mon.name, count: 3 }, { name: mon.name, count: 1 }] });
  ok(r.deck!.main.filter((n) => n === mon.name).length === 3 && /3 copies at most/.test(r.text), 'a 4th copy is refused');
  const fusion = PLAYABLE.find((c) => isExtraCard(c.name) && !limitStatus(c.name))!;
  const f = runTool(open, 'edit_deck', { add: [{ name: fusion.name, count: 1 }] });
  ok(f.deck!.extra.includes(fusion.name) && !f.deck!.main.includes(fusion.name), 'Extra Deck monsters go to the Extra Deck');
  const forbidden = PLAYABLE.find((c) => limitStatus(c.name) === 'Forbidden');
  if (forbidden) ok(/Forbidden/.test(runTool(open, 'edit_deck', { add: [{ name: forbidden.name, count: 1 }] }).text), `Forbidden card refused (${forbidden.name})`);
  const l1 = PLAYABLE.filter((c) => limitStatus(c.name) === 'Limited 1');
  if (l1.length >= 2) {
    const g = runTool(open, 'edit_deck', { add: [{ name: l1[0].name, count: 1 }, { name: l1[1].name, count: 1 }] });
    ok(g.deck!.main.length + g.deck!.extra.length === 1 && /Limited 1/.test(g.text), 'Limited 1 group allows one card in total');
  }
  // the Main Deck stops at 30
  const fill = PLAYABLE.filter((c) => c.kind !== 'monster' || !isExtraCard(c.name)).filter((c) => !limitStatus(c.name)).slice(0, 12);
  const big = runTool(open, 'edit_deck', { add: fill.map((c) => ({ name: c.name, count: 3 })) });
  ok(big.deck!.main.length === 30 && /Main Deck is full/.test(big.text), 'the Main Deck stops at 30');
  const sk = SKILLS.find((s) => getSkill(s.name) && limitStatus(s.name) !== 'Forbidden')!;
  ok(runTool(open, 'edit_deck', { skill: sk.name.replace(/ \(Skill Card\)$/, '') }).deck!.skill === sk.name, 'a Skill is found without "(Skill Card)"');
  ok(/no Skill/.test(runTool({ deck: { ...empty(true), skill: sk.name } }, 'edit_deck', { skill: null }).text), 'skill null takes it off');
}

// ---------- forgiving names ----------
{
  const r = resolveName('dark magician');
  ok('name' in r && r.name === 'Dark Magician', 'case-insensitive name');
  const q = resolveName('"Dark Magician"');
  ok('name' in q && q.name === 'Dark Magician', 'quoted name');
  const bad = resolveName('Dark Magishun Girll');
  ok('error' in bad && /Did you mean/.test(bad.error), 'misspelling gets suggestions');
  ok(/rules text|Dark Magician/.test(runTool(owned, 'get_cards', { names: ['Dark Magician'] }).text), 'get_cards reads any card');
  ok(runTool(owned, 'nope', {}).error === true, 'unknown tool is an error');
  ok(TOOLS.every((t) => /^[a-z_]+$/.test(t.name) && t.description.length > 20), 'tool definitions are well formed');
}

// ---------- the conversation loop with a scripted model ----------
await (async () => {
  const counts = new Map<string, number>();
  for (const n of [...starter.main, ...starter.extra]) counts.set(n, (counts.get(n) ?? 0) + 1);
  const script: ModelReply[] = [
    { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me look.', citations: null }, { type: 'tool_use', id: 't1', name: 'collection_overview', input: {} }, { type: 'tool_use', id: 't2', name: 'search_cards', input: { kind: 'spell' } }] as never },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't3', name: 'edit_deck', input: { clear: true, add: [...counts].map(([name, count]) => ({ name, count })), skill: starter.skill } }] as never },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Built you a deck.', citations: null }] as never },
  ];
  const seen: string[] = [];
  let calls = 0;
  const model: Model = async (req) => {
    calls++;
    // every tool_use must be answered in the very next user message, all together
    const last = req.messages[req.messages.length - 1];
    if (calls === 2) ok(Array.isArray(last.content) && last.content.length === 2 && last.content.every((b) => (b as { type: string }).type === 'tool_result'), 'both tool results come back in one message');
    return script[calls - 1];
  };
  const decks: SpeedDeck[] = [];
  const r = await runTurn(model, [], 'build me a deck', owned, { onTool: (n) => seen.push(n), onDeck: (d) => decks.push(d) });
  ok(calls === 3 && seen.join() === 'collection_overview,search_cards,edit_deck', 'the loop runs each tool the model asks for');
  ok(decks.length === 1 && speedDeckProblems(r.deck).length === 0, 'the new deck comes back legal and onDeck fired once');
  ok(r.text === 'Let me look.\n\nBuilt you a deck.' && !r.stopped, 'the answer text is collected');
  ok(r.messages.length === 6 && r.messages[0].role === 'user', 'history: user, assistant, tools, assistant, tools, assistant');
  const first = r.messages[0].content as { text: string }[];
  ok(/<current_deck>/.test(first[0].text), 'the current deck goes with the message');

  const refuse: Model = async () => ({ stop_reason: 'refusal', content: [] });
  ok(!!(await runTurn(refuse, [], 'x', owned)).stopped, 'a refusal becomes a note');
  const loop: Model = async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: String(Math.random()), name: 'view_deck', input: {} }] as never });
  ok(/too many steps/.test((await runTurn(loop, [], 'x', owned)).stopped ?? ''), 'a model that never stops is cut off');
})();

console.log(fails ? `\n${fails} FAILED` : '\nall deck chat checks passed');
process.exit(fails ? 1 : 0);
