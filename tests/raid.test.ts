// Boss Raid: the shared enemy pool, Team Power and assists, rage, boons, fights won and lost,
// and whole raids played by the computer on both boards, replayed on a second "phone".
// Run: npx tsx tests/raid.test.ts [raids]
import { DB as KIT, aiAction } from './speedkit';
import { DB } from '../src/eds/db';
import { CHAPTERS } from '../src/eds/speedCampaign/roster';
import { deckOf } from '../src/eds/speedCampaign/campaign';
import { BOONS, POWER_MAX, RAIDS, Raid, REVIVE_LP, STRIKE, duelistById, raidPool, type RaidHero, type RaidMsg, type RaidPlan } from '../src/eds/raid';
import { DEFAULT_TACTICS } from '../src/eds/tactics';
import type { Pid } from '../src/eds/types';

for (const [k, v] of KIT) DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  if (!c) console.log(`FAIL: ${msg}`);
  else if (process.argv.includes('-v')) console.log(`ok  : ${msg}`);
  if (!c) fails++;
};

const ROAD = CHAPTERS.flatMap((ch) => ch.nodes.map((n) => n.duelist));
const hero = (i: number, ctl: Pid | 'cpu'): RaidHero => {
  const d = ROAD[i % ROAD.length];
  return { name: `${d.name} (hero)`, ...deckOf(d), ctl };
};
const planOf = (raid: string, seed: number, a = 2, b = 7): RaidPlan => ({ raid, seed, level: 'normal', heroes: [hero(a, 0), hero(b, 1)] });

// ---------- the raids are well formed ----------
for (const r of RAIDS) {
  ok(r.stages.length === 3 && !!r.stages[2].boss, `${r.title}: two waves and a boss`);
  for (const s of r.stages) for (const id of s.foes) ok(!!duelistById(id), `${r.title}: ${id} is a Campaign duelist`);
  ok(KIT.has(r.rage.monster) && KIT.get(r.rage.monster)!.kind === 'monster', `${r.title}: rage monster ${r.rage.monster} is a monster`);
  ok(KIT.has(r.rage.card), `${r.title}: rage card ${r.rage.card} exists`);
  for (const s of r.stages) for (const n of [...(s.foeSetup?.spells ?? []), ...(s.foeSetup?.field ? [s.foeSetup.field] : [])]) ok(KIT.has(n), `${r.title}: setup card ${n} exists`);
  ok(raidPool(r).length > 20, `${r.title}: a pack pool`);
}

// ---------- the opening: one pool on both boards ----------
{
  const r = new Raid();
  r.apply({ type: 'RAID_START', plan: planOf('kingdom', 5) });
  ok(r.phase === 'duel' && r.stage === 0, 'the raid opens on wave 1');
  ok(r.pool === 4000 && r.boards.every((b) => b!.engine.state.players[1].lp === 4000), 'both enemies show the 4000 shared LP');
  ok(r.boards.every((b) => b!.engine.state.players[0].lp === 4000), 'each duelist has their own 4000 LP');
  ok(r.boards[0]!.foe.id === 'weevil' && r.boards[1]!.foe.id === 'rex', 'each board has its own henchman');
  ok(r.boards.every((b) => b!.engine.state.players[0].mz.length === 3), 'each duelist has a full board of 3 Monster Zones');

  // damage on one board comes off the pool and shows on the other
  const e0 = r.boards[0]!.engine;
  e0.damage(1, 1200);
  r.apply({ type: 'RAID_MOVE', b: 0, a: { type: 'PASS', player: 0 } }); // settles even when the move does nothing
  ok(r.pool === 2800, `a 1200 hit on board 1 leaves 2800 in the pool (got ${r.pool})`);
  ok(r.boards[1]!.engine.state.players[1].lp === 2800, 'board 2 shows the pool');
  ok(r.power === 1 && r.charge[0] === 200, 'the hit filled one shared Team Power');

  // a heal for the teammate
  ok(!r.canAssist(0, 'heal') && !!r.assistBlock(0, 'heal'), 'no heal for a teammate at full 4000 LP');
  r.boards[1]!.engine.state.players[0].lp = 3000;
  r.apply({ type: 'RAID_ASSIST', hero: 0, kind: 'heal' });
  ok(r.power === 0 && r.boards[1]!.engine.state.players[0].lp === 4000, 'Heal: the teammate gains 1000');
  r.boards[1]!.engine.state.players[0].lp = 3000;
  r.apply({ type: 'RAID_ASSIST', hero: 0, kind: 'heal' });
  ok(r.boards[1]!.engine.state.players[0].lp === 3000, 'no Team Power, no heal');
  ok(r.used[0] === 1 && r.best[0] === 1200, 'the raid counts assists used and the biggest hit');

  // a strike
  r.power = 1;
  r.apply({ type: 'RAID_ASSIST', hero: 1, kind: 'strike' });
  ok(r.pool === 2800 - STRIKE && r.boards[0]!.engine.state.players[1].lp === 2800 - STRIKE, 'Strike comes off the pool on both boards');

  // a gift, only between moves
  const idleBoard = ([0, 1] as Pid[]).find((b) => r.idle(b));
  if (idleBoard !== undefined) {
    const giver = idleBoard;
    const mate = (giver === 0 ? 1 : 0) as Pid;
    r.power = 1;
    const card = r.boards[giver]!.engine.state.players[0].hand[0];
    const before = r.boards[mate]!.engine.state.players[0].hand.length;
    r.apply({ type: 'RAID_ASSIST', hero: giver, kind: 'gift', uid: card.uid });
    ok(!r.boards[giver]!.engine.state.players[0].hand.some((c) => c.uid === card.uid), 'Pass a card: it leaves your hand');
    const got = r.boards[mate]!.engine.state.players[0].hand;
    ok(got.length === before + 1 && got[got.length - 1].name === card.name, "Pass a card: it lands in your teammate's hand");
  } else ok(false, 'a board is idle at the start');

  // the fight ends when the pool is empty, on both boards
  r.power = POWER_MAX;
  r.boards[0]!.engine.damage(1, 99999);
  r.apply({ type: 'RAID_MOVE', b: 0, a: { type: 'PASS', player: 0 } });
  ok(r.pool === 0 && r.boards.every((b) => b!.engine.state.winner === 0), 'an empty pool beats the enemy on both boards');
  ok(r.phase === 'boons' && r.offers.every((o) => o.length === 3 && new Set(o).size === 3), 'wave cleared: each duelist is offered 3 boons');
  r.apply({ type: 'RAID_BOON', hero: 0, boon: r.offers[0][0] });
  ok(r.phase === 'boons' && r.stage === 0, 'the next fight waits for both picks');
  r.apply({ type: 'RAID_BOON', hero: 1, boon: r.offers[1][0] });
  ok(r.phase === 'duel' && r.stage === 1 && r.pool > 0, 'both picked: wave 2 starts');
  ok(r.boards[0]!.foe.id === 'mako' && r.boards[1]!.foe.id === 'paradox', 'wave 2 brings new henchmen');
}

// ---------- boons do what they say ----------
for (const id of Object.keys(BOONS) as (keyof typeof BOONS)[]) {
  const r = new Raid();
  r.apply({ type: 'RAID_START', plan: planOf('kingdom', 9) });
  r.boards[0]!.engine.damage(1, 99999);
  r.apply({ type: 'RAID_MOVE', b: 0, a: { type: 'PASS', player: 0 } });
  r.offers[0] = [id, 'power', 'draw'].filter((x, i, a) => a.indexOf(x) === i) as typeof r.offers[0];
  const p0 = r.power;
  r.apply({ type: 'RAID_BOON', hero: 0, boon: id });
  r.apply({ type: 'RAID_BOON', hero: 1, boon: r.offers[1][0] === id ? r.offers[1][1] : r.offers[1][0] });
  const e = r.boards[0]!.engine.state;
  const twinOther = r.offers[1].includes('twin') && r.picks[1] === 'twin';
  if (id === 'lp') ok(e.players[0].lp === 5000, 'Iron Will: 5000 LP');
  if (id === 'draw') ok(e.players[0].hand.length + e.players[0].mz.filter(Boolean).length + e.players[0].sz.filter(Boolean).length >= 5 - (e.turnPlayer === 0 ? 0 : 0), 'Quick Draw: 5 cards to open');
  if (id === 'first') ok(e.turnPlayer === 0 || e.turn > 1, 'Initiative: you go first');
  if (id === 'power') ok(r.power === Math.min(POWER_MAX, p0 + 1 + (r.picks[1] === 'power' ? 1 : 0)), 'Team Spirit: +1 Team Power');
  if (id === 'ambush') ok(e.players[1].hand.length <= 3 + (e.turnPlayer === 1 ? 1 : 0) + (e.turn > 1 ? 9 : 0), 'Ambush: the enemy opens with a card fewer');
  if (id === 'twin') ok(r.pool === r.poolMax - 1000 * (twinOther ? 2 : 1), 'Opening Blow: 1000 less in the pool');
}

// ---------- the boss rages at half Life Points ----------
{
  const r = new Raid();
  r.apply({ type: 'RAID_START', plan: planOf('battle-city', 21) });
  for (let i = 0; i < 2; i++) {
    r.boards[0]!.engine.damage(1, 99999);
    r.apply({ type: 'RAID_MOVE', b: 0, a: { type: 'PASS', player: 0 } });
    r.apply({ type: 'RAID_BOON', hero: 0, boon: r.offers[0][0] });
    r.apply({ type: 'RAID_BOON', hero: 1, boon: r.offers[1][0] });
  }
  ok(r.stage === 2 && r.stageDef()!.boss === true, 'third fight is the boss');
  ok(r.boards.every((b) => b!.foe.id === 'yami-marik'), 'the same boss on both boards');
  ok(r.pool >= 7000 && r.pool <= 9000, 'the boss has the big pool');
  const monsters = () => r.boards.map((b) => b!.engine.state.players[1].mz.filter((m) => m?.name === 'Masked Beast Des Gardius').length);
  const before = monsters();
  r.boards[1]!.engine.damage(1, Math.ceil(r.pool / 2) + 10);
  r.apply({ type: 'RAID_MOVE', b: 1, a: { type: 'PASS', player: 1 } });
  ok(r.rage, 'the boss rages at half LP');
  // pending rage lands on boards between moves
  const after = monsters();
  ok(after.some((n, i) => n > before[i]) || r.boards.some((b) => b!.pending.length > 0), 'the rage monster appears (or waits for the board to be between moves)');
}

// ---------- a duelist falls, the other fights on; both fall, the raid is lost ----------
{
  const r = new Raid();
  r.apply({ type: 'RAID_START', plan: planOf('kingdom', 33) });
  r.boards[0]!.engine.damage(0, 99999);
  r.apply({ type: 'RAID_MOVE', b: 0, a: { type: 'PASS', player: 0 } });
  ok(r.fallen[0] && r.phase === 'duel' && r.running(1), 'one falls, the other fights on');
  ok(r.power === 1, 'avenge: +1 Team Power');
  ok(!r.canAssist(1, 'revive') && r.assistBlock(1, 'revive') === 'Needs 2 Team Power.', 'Revive costs 2');
  r.power = 2;
  ok(r.cpuAssist(1) === 'revive', 'a computer teammate revives a fallen teammate first');
  r.apply({ type: 'RAID_ASSIST', hero: 1, kind: 'revive' });
  ok(!r.fallen[0] && r.running(0) && r.boards[0]!.engine.state.players[0].lp === REVIVE_LP && r.power === 0, 'Revive: back up with 2000 LP');
  const turn = r.boards[0]!.engine.state.turn;
  for (let i = 0; i < 6 && r.boards[0]!.engine.state.turn === turn; i++) {
    const st = r.boards[0]!.engine.state;
    r.apply({ type: 'RAID_MOVE', b: 0, a: { type: 'END_TURN', player: (st.prompt?.player ?? st.turnPlayer) as Pid } });
    if (st.prompt) r.apply({ type: 'RAID_MOVE', b: 0, a: { type: 'PASS', player: st.prompt.player as Pid } });
  }
  ok(r.boards[0]!.engine.state.turn > turn || r.boards[0]!.engine.state.prompt !== null, 'a revived board takes moves again');
  r.boards[0]!.engine.damage(0, 99999);
  r.apply({ type: 'RAID_MOVE', b: 0, a: { type: 'PASS', player: 0 } });
  ok(r.fallen[0] && r.phase === 'duel', 'fallen again');
  r.power = 1;
  const pool = r.pool;
  r.apply({ type: 'RAID_ASSIST', hero: 0, kind: 'strike' });
  ok(r.pool === pool - STRIKE, 'a fallen duelist can still Strike');
  r.boards[1]!.engine.damage(0, 99999);
  r.apply({ type: 'RAID_MOVE', b: 1, a: { type: 'PASS', player: 1 } });
  ok(r.phase === 'lost', 'both fall: the raid is lost');
}
{
  // leaving: your board is given up, the teammate carries on, boons skip you
  const r = new Raid();
  r.apply({ type: 'RAID_START', plan: planOf('kingdom', 44) });
  r.apply({ type: 'RAID_LEAVE', hero: 1 });
  ok(r.left[1] && r.boards[1]!.engine.state.winner === 1 && r.running(0), 'leaving gives up your board only');
  r.boards[0]!.engine.damage(1, 99999);
  r.apply({ type: 'RAID_MOVE', b: 0, a: { type: 'PASS', player: 0 } });
  r.apply({ type: 'RAID_BOON', hero: 0, boon: r.offers[0][0] });
  ok(r.phase === 'duel' && r.stage === 1 && r.boards[1] === null, 'the next fight goes on without the one who left');
}

// ---------- pings and a dropped phone ----------
{
  const r = new Raid();
  const plan = planOf('kingdom', 55);
  plan.heroes[1].ctl = 1;
  r.apply({ type: 'RAID_START', plan });
  r.apply({ type: 'RAID_PING', hero: 1, ping: 'help' });
  ok(r.feed[r.feed.length - 1].kind === 'ping' && r.feed[r.feed.length - 1].text.endsWith('Help me!'), 'a ping shows on the feed');
  ok(r.driver(1) === 1 && !r.heroIsCpu(1), 'a linked teammate drives their own board');
  r.apply({ type: 'RAID_AWAY', hero: 1, away: true });
  ok(r.driver(1) === 0 && r.heroIsCpu(1), "a dropped phone: the other phone's computer plays its board");
  r.apply({ type: 'RAID_AWAY', hero: 1, away: false });
  ok(r.driver(1) === 1 && !r.heroIsCpu(1), 'back again: the board is theirs');
}

// ---------- whole raids, played by the computer on both boards ----------
const N = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 10);
let won = 0;
let lost = 0;
let stuck = 0;
const stageReached = [0, 0, 0];
const perRaid: Record<string, [number, number]> = {};
for (let g = 0; g < N; g++) {
  const raid = RAIDS[g % RAIDS.length];
  const plan = planOf(raid.id, 1000 + g * 77, (g * 5) % ROAD.length, (g * 11 + 3) % ROAD.length);
  const r = new Raid();
  const log: RaidMsg[] = [];
  const send = (m: RaidMsg) => (log.push(m), r.apply(m));
  send({ type: 'RAID_START', plan });
  let steps = 0;
  const streak = [0, 0];
  while ((r.phase === 'duel' || r.phase === 'boons') && steps < 9000) {
    steps++;
    if (r.phase === 'boons') {
      for (const h of [0, 1] as Pid[]) if (r.picks[h] === null && !r.left[h]) send({ type: 'RAID_BOON', hero: h, boon: r.offers[h][g % 3] });
      continue;
    }
    // spend Team Power the way the computer teammate does
    for (const h of [0, 1] as Pid[]) {
      const kind = r.cpuAssist(h);
      if (kind) send({ type: 'RAID_ASSIST', hero: h, kind });
    }
    let moved = false;
    for (const b of [0, 1] as Pid[]) {
      const x = r.boards[b];
      if (!x || x.engine.state.winner !== null) continue;
      const st = x.engine.state;
      const p = (st.prompt?.player ?? st.turnPlayer) as Pid;
      const a = aiAction(x.engine, p, { ...DEFAULT_TACTICS, level: p === 1 ? r.foeLevel() : 'normal' });
      if (!a) continue;
      streak[b]++;
      send({ type: 'RAID_MOVE', b, a: streak[b] > 120 ? { type: 'END_TURN', player: p } : a });
      if (streak[b] > 120) streak[b] = 0;
      moved = true;
      // invariants after every move: one pool, shown on every running board
      for (const o of [0, 1] as Pid[]) if (r.running(o)) ok(r.boards[o]!.engine.state.players[1].lp === r.pool, `raid ${g}: board ${o} shows the pool`);
    }
    if (!moved && r.phase === 'duel') break;
  }
  stageReached[r.stage]++;
  (perRaid[raid.id] ??= [0, 0])[r.phase === 'won' ? 0 : 1]++;
  if (r.phase === 'won') won++;
  else if (r.phase === 'lost') lost++;
  else stuck++;
  ok(r.phase === 'won' || r.phase === 'lost', `raid ${g} (${raid.title}) finished (phase ${r.phase}, stage ${r.stage}, ${steps} steps)`);
  // the second phone replays the log and lands on the same raid
  const twin = new Raid();
  for (const m of log) twin.apply(m);
  const sig = (x: Raid) => JSON.stringify([x.phase, x.stage, x.pool, x.power, x.total, x.boards.map((b) => b && [b.engine.state.players, b.engine.state.winner, b.engine.state.turn])]);
  ok(sig(twin) === sig(r), `raid ${g}: the second phone replays the same raid`);
}
console.log(Object.entries(perRaid).map(([k, v]) => `${k} ${v[0]}/${v[0] + v[1]}`).join(', '));
console.log(`raids: ${won} won, ${lost} lost, ${stuck} unfinished; reached stage ${stageReached.join('/')}`);
console.log(fails ? `${fails} FAILED` : 'raid: all ok');
if (fails) process.exit(1);
