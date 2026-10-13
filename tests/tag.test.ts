// Tag Duels (2v2 Speed Duel): the rules, the turn rotation, and CPU-only tag duels with
// every Millennium Road deck checked for lost or duplicated cards after every action.
// Run: npx tsx tests/tag.test.ts [duels]
import { DB as KIT, aiAction, everyCard } from './speedkit';
import { DB } from '../src/eds/db';
import { Engine } from '../src/eds/engine';
import type { Action, Card, Pid } from '../src/eds/types';
import { CHAPTERS } from '../src/eds/speedCampaign/roster';
import { deckOf } from '../src/eds/speedCampaign/campaign';
import { TAG_LP, activeMember, benchHand, sideName } from '../src/eds/tag';
import { phoneMoves, sideOfPhone, memberOfPhone, tagStart, whoMoves, type TagDuelist } from '../src/eds/tagDuel';
import { TAG_CHAPTERS, findTagNode, foeOf, nextTagNode, pairName, partnersFor, settleTagRoad, tagChapterOpen, tagNodeOpen, tagProgress } from '../src/eds/speedCampaign/tagRoad';
import { newSoloSave } from '../src/eds/speedCampaign/save';
import { STARTERS, deckFromStarter, newSpeedSave, speedDeckProblems } from '../src/eds/speedSave';
import type { DuelOutcome } from '../src/eds/speedCampaign/types';

for (const [k, v] of KIT) DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) console.log(`FAIL: ${msg}`);
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
  if (!c) fails++;
};

const ROAD = CHAPTERS.flatMap((ch) => ch.nodes.map((n) => ({ name: n.duelist.name, ...deckOf(n.duelist) })));
const D = (i: number) => ROAD[i % ROAD.length];

function startTag(a: number[], first: Pid = 0, seed = 11) {
  const e = new Engine(KIT);
  e.apply({
    type: 'START', first, seed, mode: 'speed',
    names: [D(a[0]).name, D(a[1]).name], decks: [D(a[0]).main, D(a[1]).main], fusions: [D(a[0]).extra, D(a[1]).extra], skills: [D(a[0]).skill, D(a[1]).skill],
    tag: { names: [D(a[2]).name, D(a[3]).name], decks: [D(a[2]).main, D(a[3]).main], fusions: [D(a[2]).extra, D(a[3]).extra], skills: [D(a[2]).skill, D(a[3]).skill] },
  });
  return e;
}
/** Cards in a Tag Duel: both sides plus the benched duelists' Decks, hands and Extra Decks. */
function allCards(e: Engine): Card[] {
  const out = everyCard(e);
  for (const t of e.state.tag?.teams ?? []) out.push(...t.bench.deck, ...t.bench.hand, ...t.bench.fusion);
  return out;
}
/** Plays until the prompt is gone and it is someone's open turn, by computer moves. */
function step(e: Engine): boolean {
  const p = e.state.prompt ? e.state.prompt.player : e.state.turnPlayer;
  const a = aiAction(e, p);
  if (!a) return false;
  e.apply(a);
  return true;
}

// ---------- the opening ----------
{
  const e = startTag([0, 1, 2, 3]);
  ok(e.player(0).lp === TAG_LP && e.player(1).lp === TAG_LP, `each team starts with ${TAG_LP} shared LP`);
  ok(e.player(0).hand.length === 4 && e.player(1).hand.length === 4, 'the first duelists hold 4 cards each');
  ok(benchHand(e.state, 0, 1)?.length === 4 && benchHand(e.state, 1, 1)?.length === 4, 'their partners hold 4 cards of their own');
  ok(benchHand(e.state, 0, 0) === null, 'no bench hand for the duelist who is in');
  ok(e.player(0).name === D(0).name && e.player(1).name === D(1).name, 'the first duelists start in');
  ok(sideName(e.state, 0) === `${D(0).name} & ${D(2).name}`, 'side names read "A & B"');
  const total = allCards(e).length;
  const expect = [0, 1, 2, 3].reduce((n, i) => n + D(i).main.length + D(i).extra.length, 0);
  ok(total === expect, `every card of all four decks is in the duel (${total}/${expect})`);
}

// ---------- the turn rotation: A1, B1, A2, B2, A1 ----------
{
  const e = startTag([4, 5, 6, 7], 0, 3);
  const seen: string[] = [];
  let turn = 0;
  for (let i = 0; i < 4000 && e.state.winner === null && seen.length < 6; i++) {
    if (e.state.turn !== turn) {
      turn = e.state.turn;
      seen.push(`${e.state.turnPlayer}:${activeMember(e.state, e.state.turnPlayer)}:${e.player(e.state.turnPlayer).name}`);
    }
    if (!step(e)) break;
  }
  const want = ['0:0', '1:0', '0:1', '1:1', '0:0', '1:0'];
  ok(seen.length >= 4 && seen.every((x, i) => x.startsWith(want[i])), `turns rotate A1, B1, A2, B2, A1... (${seen.join(' | ')})`);
  ok(!seen[2] || seen[2].endsWith(D(6).name), 'the second duelist plays the team\'s second turn with their own name');
}

// ---------- the first turn ----------
{
  const e = startTag([8, 9, 10, 11], 1, 5);
  ok(e.state.turnPlayer === 1 && e.player(1).hand.length === 4, 'the team going first does not draw on turn 1');
}

// ---------- team setups and who moves ----------
{
  const st = deckFromStarter(STARTERS[0]);
  const me = (name: string, ctl: TagDuelist['ctl']): TagDuelist => ({ name, main: st.main, extra: st.extra, skill: st.skill, ctl });
  // Same team: both phones on side 0, two computers on side 1.
  const e = new Engine(KIT);
  e.apply(tagStart([[me('Jammy', 0), me('Brother', 1)], [me('CPU 1', 'cpu'), me('CPU 2', 'cpu')]], 0, 21));
  ok(sideOfPhone(e.state, 0) === 0 && sideOfPhone(e.state, 1) === 0, 'same team: both phones play side 0');
  ok(memberOfPhone(e.state, 0) === 0 && memberOfPhone(e.state, 1) === 1, 'same team: phone 0 is first, phone 1 second');
  ok(e.state.tag?.ctx === 'free', 'the duel carries what it is for');
  const order: string[] = [];
  let turn = 0;
  for (let i = 0; i < 3000 && e.state.winner === null && order.length < 5; i++) {
    if (e.state.turn !== turn && !e.state.prompt) {
      turn = e.state.turn;
      order.push(String(whoMoves(e.state).ctl));
    }
    const w = whoMoves(e.state);
    ok(phoneMoves(e.state, 0) === (w.ctl === 0), 'phoneMoves agrees with whoMoves');
    if (!step(e)) break;
  }
  ok(order.slice(0, 4).join(',') === '0,cpu,1,cpu', `same team turns: Jammy, CPU, Brother, CPU (${order.join(',')})`);
  // Split: one phone and one computer on each side.
  const s2 = new Engine(KIT);
  s2.apply(tagStart([[me('Jammy', 0), me('Joey', 'cpu')], [me('Brother', 1), me('Kaiba', 'cpu')]], 1, 22));
  ok(sideOfPhone(s2.state, 0) === 0 && sideOfPhone(s2.state, 1) === 1, 'split: each phone plays its own side');
  ok(s2.player(1).name === 'Brother' && s2.state.turnPlayer === 1, 'split: the brother opens for side 1');
}

// ---------- the Tag Road ----------
{
  const kitHas = (n: string) => KIT.has(n);
  let nodes = 0;
  for (const ch of TAG_CHAPTERS) {
    ok(ch.nodes[ch.nodes.length - 1].boss === true, `Tag Road ${ch.title} ends on a boss pair`);
    for (const n of ch.nodes) {
      nodes++;
      ok(!!findTagNode(n.id), `${n.id} is findable`);
      for (const f of n.pair) {
        const d = foeOf(f);
        ok(!!d, `${n.id}: ${f.node} exists`);
        const dk = deckOf(d);
        ok(speedDeckProblems({ id: n.id, name: d.name, ...dk }).length === 0, `${n.id}: ${d.name}'s deck is legal`);
        ok(d.signature.every(kitHas), `${n.id}: ${d.name}'s signature cards exist`);
      }
      ok(pairName(n).includes(' & '), `${n.id} reads as a pair: ${pairName(n)}`);
    }
  }
  ok(nodes >= 16, `the Tag Road has ${nodes} tag duels`);
  ok(pairName(findTagNode('t1-paradox')!.node) === 'Para & Dox', 'Para and Dox split their shared deck');

  let solo = newSoloSave();
  let speed = newSpeedSave();
  const [c1, c2] = TAG_CHAPTERS;
  ok(tagChapterOpen(solo, c1) && !tagChapterOpen(solo, c2), 'only the first chapter is open at the start');
  ok(tagNodeOpen(solo, c1, 0) && !tagNodeOpen(solo, c1, 1), 'pairs open one at a time');
  ok(nextTagNode(solo).id === c1.nodes[0].id, 'the next pair is the first one');
  ok(partnersFor(solo).length === 1 && partnersFor(solo)[0].name === 'Joey Wheeler', 'Joey is the partner everyone starts with');
  const win: DuelOutcome = { result: 'w', myLp: 5000, myStartLp: 8000, oppLp: 0, turns: 12, usedSkill: false, myMonsters: 2 };
  const loss: DuelOutcome = { ...win, result: 'l', myLp: 0, oppLp: 3000 };
  let r = settleTagRoad(speed, solo, c1.nodes[0].id, loss, 1);
  ok(r.cards.length === 0 && tagProgress(r.solo).losses === 1 && !tagNodeOpen(r.solo, c1, 1), 'a loss records a loss and gives nothing');
  r = settleTagRoad(speed, r.solo, c1.nodes[0].id, win, 2);
  ok(r.firstWin && r.cards.length >= 5, `a first win gives signature cards and a pack (${r.cards.length} cards)`);
  ok(tagNodeOpen(r.solo, c1, 1), 'beating a pair opens the next');
  const again = settleTagRoad(r.speed, r.solo, c1.nodes[0].id, win, 3);
  ok(!again.firstWin && again.cards.length === 0, 'a replay win gives nothing');
  solo = r.solo;
  speed = r.speed;
  for (const n of c1.nodes.slice(1)) ({ solo, speed } = settleTagRoad(speed, solo, n.id, win, 4));
  ok(tagChapterOpen(solo, c2), 'beating the boss pair opens the next chapter');
  solo = { ...solo, campaign: { ...solo.campaign, wins: { 'c1-weevil': 1, 'c2-marik': 2 } } };
  ok(partnersFor(solo).map((d) => d.name).join(',') === 'Joey Wheeler,Weevil Underwood,Yami Marik', 'beaten Millennium Road duelists can be partners');
}

// ---------- CPU tag duels ----------
const N = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 120);
let wins = [0, 0, 0];
let longest = 0;
for (let g = 0; g < N; g++) {
  const pick = [g * 7, g * 7 + 3, g * 7 + 11, g * 7 + 19];
  const e = startTag(pick, (g % 2) as Pid, 100 + g);
  const start = allCards(e).filter((c) => !c.token).length;
  let n = 0;
  let fail = '';
  while (e.state.winner === null && n < 8000) {
    const p = e.state.prompt ? e.state.prompt.player : e.state.turnPlayer;
    const act: Action | null = aiAction(e, p);
    if (!act) {
      fail = `no action for side ${p} in ${e.state.phase} prompt=${e.state.prompt?.title ?? ''}`;
      break;
    }
    try {
      e.apply(act);
    } catch (err) {
      fail = `engine threw on ${JSON.stringify(act)}: ${(err as Error).stack?.split('\n').slice(0, 4).join(' | ')}`;
      break;
    }
    n++;
    const cards = allCards(e).filter((c) => !c.token);
    if (new Set(cards.map((c) => c.uid)).size !== cards.length) fail = `duplicated card after ${JSON.stringify(act)}`;
    else if (cards.length !== start) fail = `card count ${start} -> ${cards.length} after ${JSON.stringify(act)}; ${e.state.log.slice(-4).map((l) => l.text).join(' / ')}`;
    if (fail) break;
  }
  if (!fail && e.state.winner === null) fail = `no result after ${n} actions (turn ${e.state.turn})`;
  ok(!fail, `tag duel ${g} (${pick.map((i) => D(i).name).join(', ')}): ${fail}`);
  if (fail) continue;
  wins[e.state.winner === 'draw' ? 2 : e.state.winner]++;
  longest = Math.max(longest, e.state.turn);
}
console.log(`tag duels: ${N}, side A ${wins[0]}, side B ${wins[1]}, draws ${wins[2]}, longest ${longest} turns`);

if (fails) {
  console.log(`${fails} tag test(s) failed`);
  process.exit(1);
}
console.log('tag: all tests passed');
