// Card leveling: the tally the engine keeps during a Speed Duel, scoring, and the
// rarity meter in each profile's save (run: npx tsx tests/leveling.test.ts).
import { Engine } from '../src/eds/engine';
import { DB as APP_DB } from '../src/eds/db';
import type { Pid } from '../src/eds/types';
import { newSpeedSave } from '../src/eds/speedSave';
import { MI_TIER, OF_TIER, TIERS, XP, addXp, cardLevels, meterOf, rarityMap, scoreDeeds, tierIndex, tierOf, withLevels, type Deeds } from '../src/level/leveling';
import { DB, PLAYABLE, SPEED, aiAction, pick, playDuel, setSeed, shuffle } from './speedkit';

for (const [k, v] of DB) APP_DB.set(k, v);

let fails = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? 'ok  ' : 'FAIL'}: ${msg}`);
  if (!c) fails++;
};
const deedsOf = (e: Engine, p: Pid, name: string): Deeds | undefined => e.state.fx.lvl?.s[p][name];

// ---------- rarities ----------
ok(TIERS.map((t) => t.id).join() === 'N,R,SR,UR,GL,RO,OF,MI', 'rarities climb N → R → SR → UR → Glossy → Royal → Overframe → Millennium');
ok(TIERS[OF_TIER].id === 'OF' && TIERS[MI_TIER].id === 'MI' && MI_TIER === TIERS.length - 1, 'Millennium is the top, Overframe just under it');
ok(tierOf(0).id === 'N' && tierOf(59).id === 'N' && tierOf(60).id === 'R' && tierOf(3999).id === 'RO' && tierOf(7999).id === 'OF' && tierOf(99999).id === 'MI', 'the meter maps to the right rarity');
ok(meterOf(130) === 0.5 && meterOf(99999) === 1, 'the meter shows progress to the next rarity');
ok(addXp(70, 0, 50) === 60, 'drains stop at the start of the rarity already reached');
ok(addXp(40, 0, 50) === 0, 'and never go below zero');
ok(addXp(55, 10, 3) === 62, 'a duel that ranks a card up keeps the new rarity after its drain');

// ---------- a scripted duel ----------
const normals = SPEED.filter((c) => c.kind === 'monster' && c.sub === 'Normal' && (c.level ?? 0) <= 4).sort((a, b) => (b.atk ?? 0) - (a.atk ?? 0));
const big = normals[0];
const small = normals[normals.length - 1];
const deckOf = (n: string, k = 20) => Array<string>(k).fill(n);

function setup(): Engine {
  const e = new Engine(DB);
  e.apply({ type: 'START', first: 0, seed: 7, names: ['Jammy', 'Brother'], decks: [deckOf(big.name), deckOf(small.name)], fusions: [[], []], mode: 'speed', skills: [null, null] });
  e.apply({ type: 'SUMMON', player: 0, uid: e.player(0).hand[0].uid, zone: 0, pos: 'atk', faceUp: true });
  e.apply({ type: 'END_TURN', player: 0 });
  e.apply({ type: 'SUMMON', player: 1, uid: e.player(1).hand[0].uid, zone: 0, pos: 'atk', faceUp: true });
  e.apply({ type: 'END_TURN', player: 1 });
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  if (e.state.phase !== 'BP') e.apply({ type: 'NEXT_PHASE', player: 0 });
  return e;
}
{
  const e = setup();
  ok(deedsOf(e, 0, big.name)?.p === 1 && deedsOf(e, 1, small.name)?.p === 1, 'summoning counts as playing the card, for its owner');
  const lp = e.player(1).lp;
  e.apply({ type: 'ATTACK', player: 0, uid: e.monsters(0)[0].uid, target: e.monsters(1)[0].uid });
  const d = deedsOf(e, 0, big.name)!;
  const dealt = lp - e.player(1).lp;
  ok(d.k === 1, 'destroying a monster in battle counts as a kill for the attacker');
  ok(d.b === 1 && d.bd === dealt && dealt > 0, `battle damage is credited to the attacker (${d.bd})`);
  ok(deedsOf(e, 1, small.name)!.x === 1, 'the destroyed monster died once');
  ok(!deedsOf(e, 1, small.name)!.k, 'the loser of the battle gets no kill');

  // next turn: a direct attack that wins
  e.apply({ type: 'END_TURN', player: 0 });
  e.apply({ type: 'END_TURN', player: 1 });
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  if (e.state.phase !== 'BP') e.apply({ type: 'NEXT_PHASE', player: 0 });
  e.player(1).lp = 100;
  e.apply({ type: 'ATTACK', player: 0, uid: e.monsters(0)[0].uid, target: null });
  ok(d.d === 1 && d.dd === 100 && d.f === 1 && e.state.winner === 0, `a direct attack and the finishing blow are credited (${d.d} hit, ${d.dd} dmg)`);

  const { save, report } = withLevels(newSpeedSave(), e.state, 0, 1);
  const row = report.rows.find((r) => r.name === big.name)!;
  const want = scoreDeeds(d, true).gained;
  ok(row.after === want && cardLevels(save)[big.name] === want, `the attacker's meter fills (${row.after}: ${row.why})`);
  ok(want >= XP.kill + XP.battle + XP.direct + XP.finish, 'kills and damage are worth far more than playing');
  ok(tierIndex(want) >= 1, `one great duel ranks a card up (${tierOf(want).name})`);
  const lost = withLevels(newSpeedSave(), e.state, 1, 1).report.rows.find((r) => r.name === small.name)!;
  ok(lost.lost === -XP.died && lost.gained === XP.inDeck + XP.play, `the destroyed card drains a little (${lost.gained} − ${lost.lost})`);
  ok(rarityMap(save, [big.name, small.name])[big.name] === tierIndex(want) && !(small.name in rarityMap(save, [small.name])), 'the rarity map lists ranked cards only');

  // Millennium: only a duel that counts (your own deck against the computer, or stakes) climbs past Overframe
  const near = { ...newSpeedSave(), levels: { [big.name]: TIERS[MI_TIER].at - 20 } } as ReturnType<typeof newSpeedSave>;
  const casual = cardLevels(withLevels(near, e.state, 0, 1).save)[big.name];
  ok(casual === TIERS[MI_TIER].at - 1, `a duel that doesn't count stops just short of Millennium (${casual})`);
  const counts = cardLevels(withLevels(near, e.state, 0, 1, true).save)[big.name];
  ok(tierIndex(counts) === MI_TIER, `a duel that counts takes it to Millennium (${counts})`);
  const already = { ...newSpeedSave(), levels: { [big.name]: TIERS[MI_TIER].at + 500 } } as ReturnType<typeof newSpeedSave>;
  ok(cardLevels(withLevels(already, e.state, 0, 1).save)[big.name] === TIERS[MI_TIER].at + 500, 'a casual duel never takes points off a card that is already Millennium');
}

// ---------- effect kills and banishes ----------
{
  const e = new Engine(DB);
  e.apply({ type: 'START', first: 0, seed: 3, names: ['Jammy', 'Brother'], decks: [[...deckOf('Fissure', 10), ...deckOf(big.name, 10)], deckOf(small.name)], fusions: [[], []], mode: 'speed', skills: [null, null] });
  e.apply({ type: 'END_TURN', player: 0 });
  e.apply({ type: 'SUMMON', player: 1, uid: e.player(1).hand[0].uid, zone: 0, pos: 'atk', faceUp: true });
  e.apply({ type: 'END_TURN', player: 1 });
  let fissure = e.player(0).hand.find((c) => c.name === 'Fissure');
  for (let i = 0; i < 6 && !fissure; i++) {
    e.apply({ type: 'END_TURN', player: 0 });
    e.apply({ type: 'END_TURN', player: 1 });
    fissure = e.player(0).hand.find((c) => c.name === 'Fissure');
  }
  if (fissure && e.monsters(1).length) {
    e.apply({ type: 'ACTIVATE', player: 0, uid: fissure.uid, zone: 0 });
    for (let i = 0; i < 6 && e.state.prompt; i++) {
      const p = e.state.prompt;
      e.apply(p.kind === 'response' ? { type: 'PASS', player: p.player } : p.kind === 'yesno' ? { type: 'YES', player: p.player } : { type: 'CHOOSE', player: p.player, picks: [0] });
    }
    ok(deedsOf(e, 0, 'Fissure')?.k === 1, 'a Spell that destroys a monster gets the kill');
    ok(deedsOf(e, 0, 'Fissure')?.x === 0, 'a Spell going to the GY after use is not a death');
  } else ok(false, 'Fissure test could not be set up');
}

// ---------- random duels: the tally stays sane ----------
{
  setSeed(99);
  let duels = 0;
  let kills = 0;
  let effect = 0;
  let banished = 0;
  let bad = '';
  const pool = PLAYABLE.filter((c) => c.sub !== 'Fusion' && c.sub !== 'Ritual');
  for (let g = 0; g < 40; g++) {
    const decks = [0, 1].map(() => shuffle(Array.from({ length: 20 }, () => pick(pool).name))) as [string[], string[]];
    const r = playDuel(decks, [[], []], [null, null], g, [aiAction, aiAction]);
    if (r.fail) continue;
    duels++;
    const t = r.engine.state.fx.lvl;
    for (const p of [0, 1] as Pid[]) {
      for (const [name, d] of Object.entries(t?.s[p] ?? {}) as [string, Deeds][]) {
        kills += d.k;
        effect += d.e;
        banished += d.r;
        if (Object.values(d).some((v) => !Number.isFinite(v) || v < 0)) bad = `${name}: ${JSON.stringify(d)}`;
        if (!decks[p].includes(name)) bad = `${name} credited to player ${p} who never had it`;
      }
      const { save, report } = withLevels(newSpeedSave(), r.engine.state, p);
      for (const row of report.rows) if (!Number.isFinite(row.after) || row.after < 0) bad = `meter ${row.name} = ${row.after}`;
      if (Object.keys(cardLevels(save)).length !== new Set(decks[p]).size) bad = `player ${p}'s levels cover ${Object.keys(cardLevels(save)).length} of ${new Set(decks[p]).size} cards`;
    }
  }
  ok(duels >= 30, `${duels} random computer duels finished`);
  ok(!bad, `every tally is sane ${bad}`);
  ok(kills > 0, `kills were counted (${kills}, effect damage hits ${effect}, banished ${banished})`);
}

// ---------- not in Eternal Duelist Soul ----------
{
  const e = new Engine(DB);
  e.apply({ type: 'START', first: 0, seed: 7, names: ['A', 'B'], decks: [deckOf(big.name, 40), deckOf(small.name, 40)], fusions: [[], []] });
  e.apply({ type: 'SUMMON', player: 0, uid: e.player(0).hand[0].uid, zone: 0, pos: 'atk', faceUp: true });
  ok(!e.state.fx.lvl, 'Eternal Duelist Soul duels keep no tally');
  ok(withLevels(newSpeedSave(), e.state, 0).report.rows.length === 0, 'and level nothing');
}

console.log(fails ? `${fails} FAILED` : 'ALL OK');
if (fails) process.exit(1);
