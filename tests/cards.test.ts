// Focused checks for cards that need a special setup (run: npx tsx tests/cards.test.ts)
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
function fresh(deck0: string[], deck1: string[] = [], fusions: string[] = []) {
  const e = new Engine(DB);
  e.shuffle = <T,>(x: T[]) => x.slice();
  e.apply({ type: 'START', first: 0, seed: 7, names: ['A', 'B'], decks: [[...deck0, ...filler(40 - deck0.length)], [...deck1, ...filler(40 - deck1.length)]], fusions: [fusions, []] });
  return e;
}
const hand = (e: Engine, p: Pid, name: string) => e.state.players[p].hand.find((c) => c.name === name)!;
const onField = (e: Engine, p: Pid, name: string) => e.monsters(p).find((m) => m.name === name);
/** Ends the turn, discarding for the hand limit and passing any responses. */
const endTurn = (e: Engine) => {
  e.apply({ type: 'END_TURN', player: e.state.turnPlayer });
  for (let i = 0; i < 20 && e.state.prompt; i++) {
    const p = e.state.prompt;
    if (p.kind === 'select') e.apply({ type: 'CHOOSE', player: p.player, picks: [0] });
    else if (p.kind === 'response') e.apply({ type: 'PASS', player: p.player });
    else e.apply({ type: 'NO', player: p.player });
  }
};
/** Puts a card from the hand straight onto the field, face-up (test setup only). */
function put(e: Engine, p: Pid, name: string) {
  const c = hand(e, p, name);
  (e as any).run((e as any).specialSummon(c.uid, p, 'atk'));
  return onField(e, p, name)!;
}
/** Answers a pending selection with the named options (or the first ones). */
const answer = (e: Engine, ...labels: string[]) => {
  const p = e.state.prompt;
  if (!p || p.kind !== 'select') return;
  const picks: number[] = [];
  if (labels.length) for (const l of labels) picks.push(p.options.findIndex((o, i) => o.label === l && !picks.includes(i)));
  else picks.push(...p.options.map((_, i) => i).slice(0, Math.max(1, p.min)));
  e.apply({ type: 'CHOOSE', player: p.player, picks });
};
const respond = (e: Engine, label: string) => {
  const p = e.state.prompt;
  if (p?.kind !== 'response') return false;
  const i = p.options.findIndex((o) => o.label === label);
  if (i < 0) return false;
  e.apply({ type: 'CHOOSE', player: p.player, picks: [i] });
  return true;
};
const passAll = (e: Engine) => {
  for (let i = 0; i < 10 && e.state.prompt?.kind === 'response'; i++) e.apply({ type: 'PASS', player: e.state.prompt.player });
};

// Gate Guardian: Tribute Sanga, Kazejin and Suijin.
{
  const e = fresh(['Sanga of the Thunder', 'Kazejin', 'Suijin', 'Gate Guardian']);
  for (const n of ['Sanga of the Thunder', 'Kazejin', 'Suijin']) put(e, 0, n);
  const gg = hand(e, 0, 'Gate Guardian');
  check(!e.canNormalSummon(0, gg), 'Gate Guardian cannot be Normal Summoned');
  check(e.canSpecialProc(0, gg), 'Gate Guardian can be Special Summoned with the three');
  e.apply({ type: 'SPECIAL', player: 0, uid: gg.uid });
  check(onField(e, 0, 'Gate Guardian') && e.monsters(0).length === 1 && e.state.players[0].gy.length === 3, 'Gate Guardian is on the field and the three are in the Graveyard');
}

// Valkyrion: from the hand, then splits back into the three Magnet Warriors.
{
  const e = fresh(['Alpha The Magnet Warrior', 'Beta The Magnet Warrior', 'Gamma the Magnet Warrior', 'Valkyrion the Magna Warrior']);
  const v = hand(e, 0, 'Valkyrion the Magna Warrior');
  check(e.canSpecialProc(0, v), 'Valkyrion can be summoned with the Magnet Warriors in hand');
  e.apply({ type: 'SPECIAL', player: 0, uid: v.uid });
  const vf = onField(e, 0, 'Valkyrion the Magna Warrior')!;
  check(vf && e.state.players[0].gy.length === 3, 'Valkyrion summoned, Magnet Warriors in the Graveyard');
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: vf.uid });
  check(e.monsters(0).length === 3 && !onField(e, 0, 'Valkyrion the Magna Warrior'), 'Valkyrion splits back into Alpha, Beta and Gamma');
}

// Thunder Dragon: discard it to add two more from the deck.
{
  const e = fresh(['Thunder Dragon', 'Pot of Greed', 'Pot of Greed', 'Pot of Greed', 'Pot of Greed', 'Pot of Greed', 'Thunder Dragon', 'Thunder Dragon']);
  const td = hand(e, 0, 'Thunder Dragon');
  check(e.canUseMonsterEffect(0, td), 'Thunder Dragon effect is usable from the hand');
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: td.uid });
  answer(e, 'Thunder Dragon', 'Thunder Dragon');
  const ps = e.state.players[0];
  check(ps.hand.filter((c) => c.name === 'Thunder Dragon').length === 2 && ps.gy.some((c) => c.name === 'Thunder Dragon'), 'two Thunder Dragons added, one discarded');
}

// Petit Moth + Cocoon of Evolution, then Larvae Moth after two of its turns.
{
  const e = fresh(['Petit Moth', 'Cocoon of Evolution', 'Larvae Moth', 'Pot of Greed', 'Pot of Greed', 'Pot of Greed']);
  const moth = put(e, 0, 'Petit Moth');
  const coc = hand(e, 0, 'Cocoon of Evolution');
  check(e.canUseMonsterEffect(0, coc), 'Cocoon of Evolution can be equipped to Petit Moth');
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: coc.uid });
  answer(e, 'Petit Moth');
  check(moth.equips.length === 1 && e.atkOf(moth) === 0 && e.defOf(moth) === 2000, 'Petit Moth takes the Cocoon ATK/DEF (0/2000)');
  const larvae = hand(e, 0, 'Larvae Moth');
  check(!e.canSpecialProc(0, larvae), 'Larvae Moth is not ready on the first turn');
  for (let i = 0; i < 4; i++) endTurn(e);
  check(e.state.turnPlayer === 0 && e.canSpecialProc(0, larvae), 'Larvae Moth ready after two of A\'s turns');
  e.apply({ type: 'SPECIAL', player: 0, uid: larvae.uid });
  check(onField(e, 0, 'Larvae Moth') && !onField(e, 0, 'Petit Moth'), 'Larvae Moth summoned by tributing Petit Moth');
}

// Monster Eye: pay 1000 LP to return Polymerization.
{
  const e = fresh(['Monster Eye', 'Polymerization']);
  const eye = put(e, 0, 'Monster Eye');
  const ps = e.state.players[0];
  const poly = hand(e, 0, 'Polymerization');
  ps.hand = ps.hand.filter((c) => c !== poly);
  ps.gy.push(poly);
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: eye.uid });
  check(ps.lp === 7000 && ps.hand.some((c) => c.name === 'Polymerization'), 'Monster Eye paid 1000 and took back Polymerization');
}

// Call of the Grave negates Monster Reborn.
{
  const e = fresh(['Monster Reborn', 'Pot of Greed'], ['Call of the Grave']);
  const s = e.state;
  endTurn(e);
  e.apply({ type: 'SET_ST', player: 1, uid: hand(e, 1, 'Call of the Grave').uid, zone: 0 });
  endTurn(e);
  const ps = s.players[0];
  const elf = ps.hand.find((c) => c.name === 'Celtic Guardian')!;
  ps.hand = ps.hand.filter((c) => c !== elf);
  ps.gy.push(elf);
  e.apply({ type: 'ACTIVATE', player: 0, uid: hand(e, 0, 'Monster Reborn').uid, zone: 0 });
  answer(e);
  check(respond(e, 'Call of the Grave'), 'B can answer Monster Reborn with Call of the Grave');
  passAll(e);
  answer(e);
  check(e.monsters(0).length === 0 && ps.gy.some((c) => c.name === 'Monster Reborn'), 'Monster Reborn is negated');
}

// The Flute of Summoning Dragon with Lord of D.
{
  const e = fresh(['Lord of D.', 'The Flute of Summoning Dragon', 'Blue-Eyes White Dragon', 'Blue-Eyes White Dragon']);
  put(e, 0, 'Lord of D.');
  const flute = hand(e, 0, 'The Flute of Summoning Dragon');
  check(e.canActivateMain(0, flute.uid), 'Flute can be activated with Lord of D. face-up');
  e.apply({ type: 'ACTIVATE', player: 0, uid: flute.uid, zone: 0 });
  passAll(e);
  answer(e, 'Blue-Eyes White Dragon', 'Blue-Eyes White Dragon');
  check(e.monsters(0).filter((m) => m.name === 'Blue-Eyes White Dragon').length === 2, 'two Blue-Eyes are Special Summoned');
}

// Elegant Egotist.
{
  const e = fresh(['Harpie Lady', 'Elegant Egotist', 'Harpie Lady Sisters']);
  put(e, 0, 'Harpie Lady');
  e.apply({ type: 'ACTIVATE', player: 0, uid: hand(e, 0, 'Elegant Egotist').uid, zone: 0 });
  passAll(e);
  answer(e, 'Harpie Lady Sisters');
  check(onField(e, 0, 'Harpie Lady Sisters'), 'Elegant Egotist summons Harpie Lady Sisters');
}

// Penguin Knight: milled by the opponent's Needle Worm.
{
  const e = fresh(['Needle Worm'], ['Pot of Greed', 'Pot of Greed', 'Pot of Greed', 'Pot of Greed', 'Pot of Greed', 'Celtic Guardian', 'Celtic Guardian', 'Penguin Knight']);
  e.apply({ type: 'SUMMON', player: 0, uid: hand(e, 0, 'Needle Worm').uid, zone: 0, pos: 'def', faceUp: false });
  endTurn(e);
  endTurn(e);
  const worm = e.monsters(0)[0];
  e.apply({ type: 'FLIP_SUMMON', player: 0, uid: worm.uid });
  passAll(e);
  check(e.state.log.some((l) => /Penguin Knight shuffles/.test(l.text)), 'Penguin Knight shuffles the Graveyard back when milled');
  check(e.state.players[1].gy.length < 5, 'B lost fewer than 5 cards to the Graveyard');
}

// Kuriboh stops a direct attack.
{
  const e = fresh(['Pot of Greed'], ['Kuriboh']);
  endTurn(e);
  endTurn(e);
  put(e, 0, 'Celtic Guardian');
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  e.apply({ type: 'ATTACK', player: 0, uid: e.monsters(0)[0].uid, target: null });
  passAll(e);
  check(e.state.prompt?.kind === 'yesno' && e.state.prompt.player === 1, 'B is asked about Kuriboh');
  e.apply({ type: 'YES', player: 1 });
  check(e.state.players[1].lp === 8000 && e.state.players[1].gy.some((c) => c.name === 'Kuriboh'), 'Kuriboh was discarded and no damage taken');
}

// Solemn Judgment negates a Summon.
{
  const e = fresh(['Pot of Greed'], ['Solemn Judgment']);
  endTurn(e);
  e.apply({ type: 'SET_ST', player: 1, uid: hand(e, 1, 'Solemn Judgment').uid, zone: 0 });
  endTurn(e);
  e.apply({ type: 'SUMMON', player: 0, uid: hand(e, 0, 'Celtic Guardian').uid, zone: 0, pos: 'atk', faceUp: true });
  check(respond(e, 'Solemn Judgment'), 'B answers the Summon with Solemn Judgment');
  passAll(e);
  check(e.monsters(0).length === 0 && e.state.players[1].lp === 4000, 'the monster is destroyed and B paid half their LP');
}

// Imperial Order stops Spell Cards.
{
  const e = fresh(['Pot of Greed'], ['Imperial Order']);
  endTurn(e);
  e.apply({ type: 'SET_ST', player: 1, uid: hand(e, 1, 'Imperial Order').uid, zone: 0 });
  endTurn(e);
  passAll(e);
  const before = e.state.players[0].hand.length;
  e.apply({ type: 'ACTIVATE', player: 0, uid: hand(e, 0, 'Pot of Greed').uid, zone: 0 });
  respond(e, 'Imperial Order');
  passAll(e);
  check(e.anyActive('Imperial Order'), 'Imperial Order is active');
  check(e.state.players[0].hand.length === before - 1, 'Pot of Greed drew nothing under Imperial Order');
}

// Toon World and Toon Mermaid.
{
  const e = fresh(['Toon World', 'Toon Mermaid'], ['Pot of Greed']);
  e.apply({ type: 'ACTIVATE', player: 0, uid: hand(e, 0, 'Toon World').uid, zone: 0 });
  passAll(e);
  check(e.state.players[0].lp === 7000, 'Toon World costs 1000 LP');
  const tm = hand(e, 0, 'Toon Mermaid');
  check(e.canSpecialProc(0, tm), 'Toon Mermaid can be summoned with Toon World out');
  e.apply({ type: 'SPECIAL', player: 0, uid: tm.uid });
  answer(e);
  check(onField(e, 0, 'Toon Mermaid'), 'Toon Mermaid is on the field');
}

// Chain Energy: 500 LP for each card played from the hand.
{
  const e = fresh(['Chain Energy']);
  e.apply({ type: 'ACTIVATE', player: 0, uid: hand(e, 0, 'Chain Energy').uid, zone: 0 });
  passAll(e);
  e.apply({ type: 'SUMMON', player: 0, uid: hand(e, 0, 'Celtic Guardian').uid, zone: 0, pos: 'atk', faceUp: true });
  passAll(e);
  check(e.state.players[0].lp === 7500, 'summoning under Chain Energy cost 500 LP');
}

// Time Seal skips the next draw.
{
  const e = fresh(['Pot of Greed'], ['Time Seal']);
  endTurn(e);
  e.apply({ type: 'SET_ST', player: 1, uid: hand(e, 1, 'Time Seal').uid, zone: 0 });
  endTurn(e);
  endTurn(e);
  // B's turn: activate Time Seal at A's End Phase is simplest -> do it during B's Main Phase instead.
  e.apply({ type: 'ACTIVATE', player: 1, uid: e.state.players[1].sz[0]!.uid });
  passAll(e);
  const before = e.state.players[0].hand.length;
  endTurn(e);
  passAll(e);
  check(e.state.turnPlayer === 0 && e.state.players[0].hand.length === before, 'A did not draw after Time Seal');
}

// Relinquished absorbs a monster and takes its ATK.
{
  const e = fresh(['Relinquished'], ['Summoned Skull']);
  endTurn(e);
  put(e, 1, 'Summoned Skull');
  endTurn(e);
  const r = put(e, 0, 'Relinquished');
  check(e.canUseMonsterEffect(0, r), 'Relinquished can absorb');
  e.apply({ type: 'MONSTER_EFFECT', player: 0, uid: r.uid });
  answer(e, 'Summoned Skull');
  check(e.monsters(1).length === 0 && e.atkOf(r) === 2500, 'Relinquished absorbed Summoned Skull and has 2500 ATK');
}

// Royal Decree stops Traps.
{
  const e = fresh(['Royal Decree', 'Pot of Greed'], ['Trap Hole']);
  e.apply({ type: 'SET_ST', player: 0, uid: hand(e, 0, 'Royal Decree').uid, zone: 0 });
  endTurn(e);
  e.apply({ type: 'SET_ST', player: 1, uid: hand(e, 1, 'Trap Hole').uid, zone: 0 });
  endTurn(e);
  e.apply({ type: 'ACTIVATE', player: 0, uid: e.state.players[0].sz[0]!.uid });
  passAll(e);
  check(e.anyActive('Royal Decree'), 'Royal Decree is active');
  e.apply({ type: 'SUMMON', player: 0, uid: hand(e, 0, 'Celtic Guardian').uid, zone: 0, pos: 'atk', faceUp: true });
  const p = e.state.prompt;
  const offered = p?.kind === 'response' && p.options.some((o) => o.label === 'Trap Hole');
  if (offered) respond(e, 'Trap Hole');
  passAll(e);
  check(e.monsters(0).length === 1, 'Trap Hole did nothing under Royal Decree');
}

// Banisher of the Light removes cards instead of sending them to the Graveyard.
{
  const e = fresh(['Banisher of the Light', 'Fissure'], ['Pot of Greed']);
  endTurn(e);
  put(e, 1, 'Celtic Guardian');
  endTurn(e);
  put(e, 0, 'Banisher of the Light');
  e.apply({ type: 'ACTIVATE', player: 0, uid: hand(e, 0, 'Fissure').uid, zone: 0 });
  passAll(e);
  answer(e);
  check(e.state.players[1].removed.some((c) => c.name === 'Celtic Guardian'), 'the destroyed monster was removed from play');
}

// Tickets and Gods cannot be played.
{
  const e = fresh(['The Monarchy', 'Obelisk the Tormentor', 'Celtic Guardian', 'Celtic Guardian', 'Celtic Guardian', 'Celtic Guardian', 'Celtic Guardian', 'Celtic Guardian']);
  // Give A two monsters to tribute.
  put(e, 0, 'Celtic Guardian');
  put(e, 0, 'Celtic Guardian');
  put(e, 0, 'Celtic Guardian');
  const t = hand(e, 0, 'The Monarchy');
  check(!e.canSet(0, t) && !e.canActivateMain(0, t.uid), 'a Ticket card cannot be Set or activated');
  check(!e.canNormalSummon(0, hand(e, 0, 'Obelisk the Tormentor')), 'Obelisk cannot be summoned');
}

console.log(failures ? `${failures} FAILURES` : 'ALL OK');
process.exit(failures ? 1 : 0);
