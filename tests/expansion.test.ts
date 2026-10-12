// Checks for Fusion, Ritual, monster effects and auras with the real card database (run: npx tsx tests/expansion.test.ts)
import { readFileSync } from 'node:fs';
import { Engine } from '../src/eds/engine';
import type { CardInfo, Pid } from '../src/eds/types';

const raw = JSON.parse(readFileSync('public/cards/cards.json', 'utf8')) as any[];
const DB = new Map<string, CardInfo>();
for (const r of raw) {
  const t: string = r.type;
  let kind: CardInfo['kind'] = 'monster';
  let sub = 'Normal';
  if (t === 'Spell Card') (kind = 'spell'), (sub = r.race ?? 'Normal');
  else if (t === 'Trap Card') (kind = 'trap'), (sub = r.race ?? 'Normal');
  else if (t === 'Ticket Card') (kind = 'spell'), (sub = 'Ticket');
  else if (/Fusion/.test(t)) sub = 'Fusion';
  else if (/Ritual/.test(t)) sub = 'Ritual';
  else if (/Effect|Flip|Spirit|Toon|Union/.test(t)) sub = 'Effect';
  const info: CardInfo = { id: r.id, name: r.name, kind, sub, atk: r.atk, def: r.def, level: r.level, attribute: r.attribute, race: kind === 'monster' ? r.race : undefined, desc: r.desc, n: r.n, password: r.password, alias: r.alias };
  DB.set(info.name, info);
  DB.set(info.name.toLowerCase(), info);
  if (r.alias) (DB.set(r.alias, info), DB.set(r.alias.toLowerCase(), info));
}

let failures = 0;
function check(cond: unknown, msg: string) {
  if (!cond) {
    failures++;
    console.log('FAIL:', msg);
  } else console.log('ok  :', msg);
}
const filler = (n: number) => Array(n).fill('Celtic Guardian');
function fresh(deck0: string[], deck1: string[], fusions: string[] = []) {
  const e = new Engine(DB);
  e.shuffle = <T,>(x: T[]) => x.slice();
  e.apply({ type: 'START', first: 0, seed: 7, names: ['A', 'B'], decks: [[...deck0, ...filler(30)], [...deck1, ...filler(30)]], fusions: [fusions, []] });
  return e;
}
const hand = (e: Engine, p: Pid, name: string) => e.state.players[p].hand.find((c) => c.name === name)!;
const skipTurn = (e: Engine) => {
  e.apply({ type: 'END_TURN', player: e.state.turnPlayer });
};
/** Answers a pending selection with the first options (or the named ones). */
const answer = (e: Engine, ...labels: string[]) => {
  const p = e.state.prompt;
  if (!p || p.kind !== 'select') return;
  const picks = labels.length ? labels.map((l) => p.options.findIndex((o) => o.label === l)) : p.options.map((_, i) => i).slice(0, Math.max(1, p.min));
  e.apply({ type: 'CHOOSE', player: p.player, picks });
};

// 1. Polymerization: Gaia + Curse of Dragon from hand and field.
{
  const e = fresh(['Gaia The Fierce Knight', 'Curse of Dragon', 'Polymerization', 'Mystical Elf', 'Pot of Greed', 'Pot of Greed'], ['Mystical Elf'], ['Gaia the Dragon Champion']);
  const s = e.state;
  check(!e.canActivateMain(0, hand(e, 0, 'Polymerization').uid) === false, 'Polymerization can be activated with both materials in hand');
  e.apply({ type: 'ACTIVATE', player: 0, uid: hand(e, 0, 'Polymerization').uid, zone: 0 });
  answer(e, 'Gaia the Dragon Champion');
  check(e.monsters(0).some((m) => m.name === 'Gaia the Dragon Champion'), 'Gaia the Dragon Champion is Fusion Summoned');
  check(s.players[0].gy.filter((c) => c.name === 'Gaia The Fierce Knight' || c.name === 'Curse of Dragon').length === 2, 'both materials went to the Graveyard');
  check(s.players[0].fusion.length === 0, 'Fusion Deck is now empty');
}

// 2. Ritual: Black Luster Ritual tributing Level 4 + Level 4 is 8.
{
  const e = fresh(['Black Luster Ritual', 'Black Luster Soldier', 'Celtic Guardian', 'Mystical Elf', 'Pot of Greed', 'Pot of Greed'], ['Mystical Elf']);
  const s = e.state;
  const rit = hand(e, 0, 'Black Luster Ritual');
  check(e.canActivateMain(0, rit.uid), 'Black Luster Ritual can be activated (two Level 4s in hand)');
  e.apply({ type: 'ACTIVATE', player: 0, uid: rit.uid, zone: 0 });
  check(s.prompt?.kind === 'select' && /Ritual/.test(s.prompt.title), 'tribute prompt appears');
  if (s.prompt?.kind === 'select') {
    const opts = s.prompt.options;
    const picks = [opts.findIndex((o) => o.label === 'Celtic Guardian'), opts.findIndex((o) => o.label === 'Mystical Elf')];
    e.apply({ type: 'CHOOSE', player: 0, picks });
  }
  check(e.monsters(0).some((m) => m.name === 'Black Luster Soldier'), 'Black Luster Soldier is Ritual Summoned');
  check(s.players[0].gy.some((c) => c.name === 'Black Luster Ritual'), 'Ritual Spell goes to the Graveyard');
}

// 3. Cannon Soldier ignition, Jinzo #7 direct attack, Dark Elf cost, Sogen aura.
{
  const e = fresh(['Cannon Soldier', 'Jinzo #7', 'Sogen', 'Dark Elf', 'Pot of Greed', 'Pot of Greed'], ['Mystical Elf', 'Pot of Greed', 'Pot of Greed', 'Pot of Greed', 'Pot of Greed']);
  const s = e.state;
  e.apply({ type: 'SUMMON', player: 0, uid: hand(e, 0, 'Cannon Soldier').uid, zone: 0, pos: 'atk', faceUp: true });
  check(e.canUseMonsterEffect(0, e.monsters(0)[0]), 'Cannon Soldier effect is available');
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: e.monsters(0)[0].uid });
  answer(e, 'Cannon Soldier');
  check(e.monsters(0).length === 0 && s.players[1].lp === 7500, 'Cannon Soldier tributes itself for 500 damage');
  skipTurn(e); // A's turn ends
  e.apply({ type: 'SUMMON', player: 1, uid: hand(e, 1, 'Mystical Elf').uid, zone: 0, pos: 'def', faceUp: true });
  skipTurn(e);
  e.apply({ type: 'SUMMON', player: 0, uid: hand(e, 0, 'Jinzo #7').uid, zone: 0, pos: 'atk', faceUp: true });
  e.apply({ type: 'ACTIVATE', player: 0, uid: hand(e, 0, 'Sogen').uid });
  check(s.players[0].field?.name === 'Sogen' && s.players[0].field.active, 'Sogen is active');
  e.apply({ type: 'NEXT_PHASE', player: 0 }); // BP
  check(s.phase === 'BP', 'Battle Phase reached');
  e.apply({ type: 'ATTACK', player: 0, uid: e.monsters(0)[0].uid, target: null });
  check(s.players[1].lp === 7000, 'Jinzo #7 attacked directly past Mystical Elf for 500');
  e.apply({ type: 'END_TURN', player: 0 });
  skipTurn(e);
  e.apply({ type: 'SUMMON', player: 0, uid: hand(e, 0, 'Dark Elf').uid, zone: 1, pos: 'atk', faceUp: true });
  const elf = e.monsters(0).find((m) => m.name === 'Dark Elf')!;
  check(e.atkOf(elf) === 2000, 'Dark Elf (Spellcaster) gets nothing from Sogen');
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  const target = e.monsters(1)[0];
  e.apply({ type: 'ATTACK', player: 0, uid: elf.uid, target: target.uid });
  check(s.players[0].lp === 7000 && e.monsters(1).length === 1, 'Dark Elf paid 1000 LP to attack; 2000 ATK into 2000 DEF destroys nothing');
}

// 4. Giant Rat recruits; Negate Attack ends the Battle Phase; Spellbinding Circle binds.
{
  const e = fresh(['Giant Rat', 'Pot of Greed', 'Pot of Greed', 'Pot of Greed', 'Pot of Greed', 'Pot of Greed', 'Pot of Greed', 'Mystical Elf'], ['Summoned Skull', 'Negate Attack', 'Spellbinding Circle', 'Pot of Greed', 'Pot of Greed']);
  const s = e.state;
  e.apply({ type: 'SUMMON', player: 0, uid: hand(e, 0, 'Giant Rat').uid, zone: 0, pos: 'atk', faceUp: true });
  skipTurn(e);
  e.apply({ type: 'SET_ST', player: 1, uid: hand(e, 1, 'Negate Attack').uid, zone: 0 });
  e.apply({ type: 'SET_ST', player: 1, uid: hand(e, 1, 'Spellbinding Circle').uid, zone: 1 });
  e.apply({ type: 'SUMMON', player: 1, uid: hand(e, 1, 'Summoned Skull').uid, zone: 0, pos: 'atk', faceUp: true });
  if (s.prompt?.kind === 'select') e.apply({ type: 'CHOOSE', player: 1, picks: [0] }); // no tribute needed? Skull is lv6 -> needs 1 tribute; B has none, so summon refused
  check(e.monsters(1).length === 0, 'Summoned Skull needs a tribute B does not have');
  e.apply({ type: 'NEXT_PHASE', player: 1 });
  e.apply({ type: 'END_TURN', player: 1 });
  e.apply({ type: 'NEXT_PHASE', player: 0 }); // BP
  const rat = e.monsters(0)[0];
  e.apply({ type: 'ATTACK', player: 0, uid: rat.uid, target: null });
  check(s.prompt?.kind === 'response' && s.prompt.player === 1, 'B may respond to the attack');
  const negate = s.prompt?.kind === 'response' ? s.prompt.options.findIndex((o) => o.label === 'Negate Attack') : -1;
  e.apply({ type: 'CHOOSE', player: 1, picks: [negate] });
  check(s.players[1].lp === 8000 && s.players[1].gy.some((c) => c.name === 'Negate Attack'), 'Negate Attack stopped the direct attack');
  e.apply({ type: 'END_TURN', player: 0 });
  // B's turn: activate Spellbinding Circle from the Main Phase on Giant Rat.
  e.apply({ type: 'ACTIVATE', player: 1, uid: s.players[1].sz[1]!.uid });
  answer(e);
  check(e.monsters(0)[0].cannotAttack === true && s.players[1].sz[1]?.active, 'Spellbinding Circle binds Giant Rat');
  e.apply({ type: 'END_TURN', player: 1 });
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  check(!e.canAttackWith(0, e.monsters(0)[0]), 'bound monster cannot attack');
}

console.log(failures ? `${failures} FAILURES` : 'ALL OK');
process.exit(failures ? 1 : 0);
