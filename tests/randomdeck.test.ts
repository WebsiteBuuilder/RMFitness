// The random deck maker: every deck it makes is legal (deck rules, Limited List, copies
// owned), it respects themes and kept cards, copes with thin collections, and its decks
// play real duels against the Starter Decks (run: npx tsx tests/randomdeck.test.ts [games]).
import { DB as APP_DB } from '../src/eds/db';
import { STARTERS, deckFromStarter, newSpeedSave, speedDeckProblems, withCards, type SpeedDeck } from '../src/eds/speedSave';
import { collectionProblems } from '../src/collection/economy';
import { randomSpeedDeck, speedThemes } from '../src/eds/speedRandom';
import { deckSplit, type RandomDeck, type RandomResult } from '../src/eds/randomDeck';
import { aiAction } from '../src/eds/ai';
import { DB, playDuel } from './speedkit';
import type { Pid } from '../src/eds/types';
import { addToTrunk, deckProblems, newSave } from '../src/eds/save';
import { buildStarterDeck, type StarterColor } from '../src/eds/starter';
import { randomEdsDeck, withEdsDeck } from '../src/eds/edsRandom';

for (const [k, v] of DB) APP_DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const isDeck = (r: RandomResult): r is RandomDeck => !('error' in r);
const asDeck = (r: RandomDeck, open = false): SpeedDeck => ({ id: 'r', name: 'Random', main: r.main, extra: r.extra, skill: r.skill, open });

// ---------- every card (Anything goes) ----------
{
  let bad = 0;
  let firstBad = '';
  const sizes = new Set<number>();
  let fusionsOk = true;
  let withSkill = 0;
  for (let i = 0; i < 300; i++) {
    seed = 1000 + i;
    const size = [20, 25, 30][i % 3];
    const r = randomSpeedDeck(undefined, { size, style: (['balanced', 'beatdown', 'control'] as const)[i % 3], theme: { kind: 'surprise' }, rand });
    if (!isDeck(r)) {
      bad++;
      firstBad ||= r.error;
      continue;
    }
    const pr = speedDeckProblems(asDeck(r, true));
    if (pr.length) (bad++, (firstBad ||= pr.join('; ')));
    sizes.add(r.main.length);
    if (r.skill) withSkill++;
    if (r.extra.some((n) => APP_DB.get(n)?.sub === 'Fusion') && !r.main.some((n) => /Fusion Summon/.test(APP_DB.get(n)?.desc ?? ''))) fusionsOk = false;
    const s = deckSplit(r.main);
    if (s.monsters < Math.round(size * 0.4)) (bad++, (firstBad ||= `only ${s.monsters} monsters in ${size}`));
  }
  ok(bad === 0, `300 Anything goes decks are all legal with enough monsters${firstBad ? ` (first problem: ${firstBad})` : ''}`);
  ok(sizes.has(20) && sizes.has(25) && sizes.has(30), 'the size asked for is the size made (20, 25, 30)');
  ok(fusionsOk, 'a deck with Fusion Monsters always has a way to Fusion Summon');
  ok(withSkill > 250, `decks come with a Skill (${withSkill}/300)`);
}

// ---------- themes ----------
{
  const t = speedThemes(undefined, 20);
  ok(t.attributes.includes('DARK') && t.races.includes('Warrior'), `themes are offered (${t.attributes.length} Attributes, ${t.races.length} Types)`);
  for (const [theme, f] of [
    [{ kind: 'attribute', value: 'DARK' }, (n: string) => APP_DB.get(n)?.attribute === 'DARK'],
    [{ kind: 'race', value: 'Dragon' }, (n: string) => APP_DB.get(n)?.race === 'Dragon'],
  ] as const) {
    let share = 0;
    for (let i = 0; i < 20; i++) {
      seed = 77 + i;
      const r = randomSpeedDeck(undefined, { size: 20, theme, rand });
      if (!isDeck(r)) continue;
      const mons = r.main.filter((n) => APP_DB.get(n)?.kind === 'monster');
      share += mons.filter(f).length / mons.length;
    }
    ok(share / 20 > 0.8, `${theme.value} decks are mostly ${theme.value} monsters (${Math.round((share / 20) * 100)}%)`);
  }
}

// ---------- owned cards only ----------
const starterSave = (k: number) => {
  let s = newSpeedSave();
  for (let j = 0; j < k; j++) {
    const d = deckFromStarter(STARTERS[j]);
    s = withCards(s, [...d.main, ...d.extra, ...(d.skill ? [d.skill] : [])]);
  }
  return s;
};
{
  for (const k of [1, 2, 4]) {
    const s = starterSave(k);
    let bad = 0;
    let first = '';
    for (let i = 0; i < 60; i++) {
      seed = 300 + i;
      const r = randomSpeedDeck(s.collection, { size: 20, theme: { kind: 'surprise' }, rand });
      if (!isDeck(r)) (bad++, (first ||= r.error));
      else {
        const pr = [...speedDeckProblems(asDeck(r)), ...collectionProblems(s, asDeck(r))];
        if (pr.length) (bad++, (first ||= pr.join('; ')));
      }
    }
    ok(bad === 0, `a collection of ${k} Starter Deck${k > 1 ? 's' : ''}: 60 random decks, all legal and all owned${first ? ` (${first})` : ''}`);
  }
  const thin = withCards(newSpeedSave(), deckFromStarter(STARTERS[0]).main.slice(0, 12));
  const r = randomSpeedDeck(thin.collection, { size: 20, rand });
  ok(!isDeck(r) && /needs 20/.test(r.error), `a collection too small for a deck says so: "${!isDeck(r) ? r.error : ''}"`);
}

// ---------- keeping cards ----------
{
  const st = deckFromStarter(STARTERS[1]);
  const keep = { main: st.main.slice(0, 8), extra: [], skill: st.skill };
  seed = 5;
  const r = randomSpeedDeck(undefined, { size: 20, keep, rand });
  const counts = (l: string[]) => l.reduce<Record<string, number>>((m, n) => ((m[n] = (m[n] ?? 0) + 1), m), {});
  const have = isDeck(r) ? counts(r.main) : {};
  ok(isDeck(r) && Object.entries(counts(keep.main)).every(([n, c]) => (have[n] ?? 0) >= c) && r.skill === st.skill && r.main.length === 20, 'kept cards and the kept Skill stay, the rest is filled to 20');
}

// ---------- the Limited List ----------
{
  const lim = (n: string) => n.replace(/ \(Skill Card\)$/, '');
  let over = 0;
  for (let i = 0; i < 200; i++) {
    seed = 9000 + i;
    const r = randomSpeedDeck(undefined, { size: 30, style: 'control', rand });
    if (isDeck(r) && speedDeckProblems(asDeck(r, true)).some((p) => /Limited|Forbidden/.test(p))) over++;
  }
  ok(over === 0 && !!lim, 'no random deck breaks the Limited List');
}

// ---------- Eternal Duelist Soul ----------
{
  const base = newSave('Tester');
  const start = { ...base, main: buildStarterDeck('Red' as StarterColor, 7), fusion: [] as string[] };
  // a few packs' worth more in the Trunk
  const extraCards = [...APP_DB.values()].filter((c) => !c.speed && c.n && c.n < 400).slice(0, 90).map((c) => c.name);
  const s = { ...start, trunk: { ...start.trunk } };
  addToTrunk(s, [...extraCards, ...extraCards]);
  const owned = (sv: typeof s, n: string) => (sv.trunk[n] ?? 0) + [...sv.main, ...sv.side, ...sv.fusion].filter((x) => x === n).length;
  let bad = 0;
  let first = '';
  for (let i = 0; i < 40; i++) {
    seed = 600 + i;
    const r = randomEdsDeck(s, { size: 40, theme: { kind: 'surprise' }, rand });
    if (!isDeck(r)) {
      bad++;
      first ||= r.error;
      continue;
    }
    const next = withEdsDeck(s, r.main, r.extra);
    const pr = deckProblems(next);
    const lost = [...new Set([...Object.keys(s.trunk), ...s.main])].filter((n) => owned(next, n) !== owned(s, n));
    if (pr.length || lost.length || Object.values(next.trunk).some((k) => k < 0)) (bad++, (first ||= [...pr, ...lost.map((n) => `${n} count changed`)].join('; ')));
  }
  ok(bad === 0, `40 random EDS decks: exactly 40 cards, nothing gained or lost from the Trunk${first ? ` (${first})` : ''}`);
}

// ---------- real duels ----------
{
  const games = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 24);
  let wins = 0;
  let done = 0;
  let firstFail = '';
  for (let g = 0; g < games; g++) {
    seed = 4242 + g;
    const r = randomSpeedDeck(g % 2 ? starterSave(3).collection : undefined, { size: 20, theme: { kind: 'surprise' }, rand });
    if (!isDeck(r)) continue;
    const st = deckFromStarter(STARTERS[g % STARTERS.length]);
    const res = playDuel([r.main, st.main], [r.extra, st.extra], [r.skill, st.skill], g, [aiAction, aiAction]);
    if (res.fail) {
      firstFail ||= res.fail;
      continue;
    }
    done++;
    if (res.engine.state.winner === (0 as Pid)) wins++;
  }
  ok(!firstFail, `random decks play ${games} computer duels to the end${firstFail ? ` (${firstFail.slice(0, 300)})` : ''}`);
  ok(wins >= Math.ceil(done * 0.25), `random decks hold their own against Starter Decks (${wins}/${done} won)`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall random deck checks passed');
process.exit(fails ? 1 : 0);
