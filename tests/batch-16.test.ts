// Speed Duel card scripts of batch 16 (run: npx tsx tests/batch-16.test.ts)
// One or more targeted checks per scripted card: its main effect really happens in a duel.
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';
import { levelOf } from '../src/eds/speed/helpers';

let fails = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};
const FILL = 'Celtic Guardian';

// ---------- duel kit ----------
type Ans = 'yes' | 'no' | 'pass' | { pick: string[] } | { respond: string };
/** Answers every pending prompt: planned answers first (in order), then pass / no / the first options. Returns how many planned answers were not used. */
function settle(e: Engine, ...ans: Ans[]): number {
  const q = [...ans];
  for (let i = 0; i < 400 && e.state.prompt && e.state.winner === null; i++) {
    const pr = e.state.prompt;
    const h = q[0];
    if (pr.kind === 'yesno') {
      if (h === 'yes' || h === 'no') {
        q.shift();
        e.apply({ type: h === 'yes' ? 'YES' : 'NO', player: pr.player });
      } else e.apply({ type: 'NO', player: pr.player });
    } else if (pr.kind === 'response') {
      if (h && typeof h === 'object' && 'respond' in h) {
        const k = pr.options.findIndex((o) => o.label.startsWith(h.respond));
        if (k >= 0) {
          q.shift();
          e.apply({ type: 'CHOOSE', player: pr.player, picks: [k] });
          continue;
        }
      }
      if (h === 'pass') q.shift();
      e.apply({ type: 'PASS', player: pr.player });
    } else if (h && typeof h === 'object' && 'pick' in h) {
      q.shift();
      const picks: number[] = [];
      for (const l of h.pick) {
        const k = pr.options.findIndex((o, j) => o.label === l && !picks.includes(j));
        if (k >= 0) picks.push(k);
      }
      e.apply({ type: 'CHOOSE', player: pr.player, picks });
    } else e.apply({ type: 'CHOOSE', player: pr.player, picks: pr.options.map((_, j) => j).slice(0, Math.max(1, pr.min)) });
  }
  return q.length;
}
function duel(d0: string[], d1: string[] = [], x0: string[] = [], x1: string[] = [], first: Pid = 0): Engine {
  const e = new Engine(DB);
  e.shuffle = <T,>(a: T[]) => a.slice();
  const pad = (d: string[]) => [...Array(4).fill(FILL), ...d, ...Array(Math.max(0, 30 - d.length)).fill(FILL)];
  e.apply({ type: 'START', first, seed: 1, names: ['A', 'B'], decks: [pad(d0), pad(d1)], fusions: [x0, x1], mode: 'speed', skills: [null, null] });
  settle(e);
  return e;
}
const run = (e: Engine, step: Generator<any, any, any>, ...ans: Ans[]) => {
  (e as any).run(step);
  return settle(e, ...ans);
};
const zone = (e: Engine, c: Card | null | undefined) => (c ? e.find(c.uid)?.loc.zone : undefined);
/** Moves a card of `p` (deck, GY, banished or hand) into the hand. */
function grab(e: Engine, p: Pid, name: string): Card {
  const ps = e.player(p);
  const c = [...ps.hand, ...ps.deck, ...ps.gy, ...ps.removed].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  if (zone(e, c) !== 'hand') e.toHandOf(c.uid, p);
  return c;
}
/** Special Summons a card of `p` from wherever it is (Extra Deck included). Null when it did not arrive. */
function place(e: Engine, p: Pid, name: string, pos: Pos = 'atk', faceUp = true, ...ans: Ans[]): FieldCard | null {
  const ps = e.player(p);
  const c = [...ps.deck, ...ps.gy, ...ps.fusion, ...ps.hand].find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} for player ${p}`);
  run(e, e.specialSummon(c.uid, p, pos, faceUp), ...ans);
  const f = e.fieldCard(c.uid);
  if (f && !faceUp) f.placedTurn = -1;
  return f;
}
/** Puts a card face-down in a Spell/Trap Zone (ready to be activated this turn). */
function putST(e: Engine, p: Pid, name: string): FieldCard {
  const c = grab(e, p, name);
  const ps = e.player(p);
  ps.hand.splice(ps.hand.findIndex((x) => x.uid === c.uid), 1);
  const z = ps.sz.findIndex((x) => x === null);
  const fc: FieldCard = { ...c, pos: 'atk', faceUp: false, placedTurn: -1, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 };
  ps.sz[z] = fc;
  return fc;
}
const act = (e: Engine, p: Pid, uid: number, ...ans: Ans[]) => {
  e.apply({ type: 'ACTIVATE', player: p, uid, zone: e.player(p).sz.findIndex((z) => z === null) });
  return settle(e, ...ans);
};
/** Activates a Spell from the hand (it is fetched there first). */
function playSpell(e: Engine, p: Pid, name: string, ...ans: Ans[]): FieldCard | null {
  const c = grab(e, p, name);
  act(e, p, c.uid, ...ans);
  return e.fieldCard(c.uid);
}
/** Sets a Trap and activates it in the Main Phase. */
function playTrap(e: Engine, p: Pid, name: string, ...ans: Ans[]): FieldCard | null {
  const fc = putST(e, p, name);
  act(e, p, fc.uid, ...ans);
  return e.fieldCard(fc.uid);
}
function summon(e: Engine, p: Pid, name: string, faceUp = true, ...ans: Ans[]): FieldCard | null {
  const c = grab(e, p, name);
  e.player(p).normalSummoned = false;
  e.apply({ type: 'SUMMON', player: p, uid: c.uid, zone: e.player(p).mz.findIndex((z) => z === null), pos: faceUp ? 'atk' : 'def', faceUp });
  settle(e, ...ans);
  return e.fieldCard(c.uid);
}
const kill = (e: Engine, cards: (Card | null | undefined)[], by?: Pid, ...ans: Ans[]) => {
  const uids = cards.filter((c): c is Card => !!c).map((c) => c.uid);
  return run(e, by === undefined ? e.destroy(uids) : e.as(by, e.destroy(uids)), ...ans);
};
const endTurn = (e: Engine, ...ans: Ans[]) => {
  e.apply({ type: 'END_TURN', player: e.state.turnPlayer });
  return settle(e, ...ans);
};
const toBattle = (e: Engine) => {
  for (let i = 0; i < 3 && e.state.phase !== 'BP'; i++) {
    e.apply({ type: 'NEXT_PHASE', player: e.state.turnPlayer });
    settle(e);
  }
};
const attack = (e: Engine, a: FieldCard | null, t: FieldCard | null, ...ans: Ans[]) => {
  e.apply({ type: 'ATTACK', player: e.state.turnPlayer, uid: a!.uid, target: t ? t.uid : null });
  return settle(e, ...ans);
};
const effect = (e: Engine, p: Pid, c: Card | null, ...ans: Ans[]) => {
  e.apply({ type: 'MONSTER_EFFECT', player: p, uid: c!.uid });
  return settle(e, ...ans);
};
const active = (e: Engine, c: FieldCard | null) => !!c && zone(e, c) === 'sz' && c.faceUp && !!c.active;
const logHas = (e: Engine, text: string, since = 0) => e.state.log.slice(since).some((l) => l.text.includes(text));
const section = (s: string) => console.log(`\n--- ${s}`);

const toTurn3 = (e: Engine) => {
  endTurn(e);
  endTurn(e);
};
const hasPrompt = (e: Engine, p: Pid, name: string) => e.state.prompt?.kind === 'response' && e.state.prompt.player === p && e.state.prompt.options.some((o) => o.label.startsWith(name));
const lp = (e: Engine, p: Pid) => e.player(p).lp;

// ======================= Effect Monsters =======================
section('Amazoness Tiger');
{
  const e = duel(['Amazoness Tiger', 'Amazoness Fighter', 'Amazoness Tiger'], [FILL]);
  const tiger = place(e, 0, 'Amazoness Tiger')!;
  const fighter = place(e, 0, 'Amazoness Fighter')!;
  check(e.atkOf(tiger) === 1100 + 800, 'gains 400 ATK for each "Amazoness" monster you control (itself included)');
  const foe = place(e, 1, FILL)!;
  const targets = e.legalTargets(1, foe).map((m) => m.uid);
  check(targets.includes(tiger.uid) && !targets.includes(fighter.uid), 'the opponent can attack only the Tiger among face-up "Amazoness" monsters');
  check(e.summonBlocked(0, grab(e, 0, 'Amazoness Tiger'), 'special', 'hand'), 'you can only control 1 "Amazoness Tiger"');
}

section('Ancient Gear Golem');
{
  const e = duel(['Ancient Gear Golem', 'Ancient Gear Golem'], [FILL, 'Mirror Force']);
  const second = e.player(0).deck.find((c) => c.name === 'Ancient Gear Golem')!;
  check(e.summonBlocked(0, second, 'special', 'deck'), 'cannot be Special Summoned');
  place(e, 0, FILL);
  place(e, 0, FILL);
  const golem = summon(e, 0, 'Ancient Gear Golem');
  check(golem && golem.faceUp, 'is Tribute Summoned with 2 Tributes');
  const mf = putST(e, 1, 'Mirror Force');
  const def = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  toBattle(e);
  e.apply({ type: 'ATTACK', player: 0, uid: golem!.uid, target: def.uid });
  check(!hasPrompt(e, 1, 'Mirror Force'), 'when it attacks, the opponent cannot activate Spell/Trap Cards');
  settle(e);
  check(zone(e, mf) === 'sz' && zone(e, def) === 'gy' && lp(e, 1) === 4000 - (3000 - 1200), 'it destroys the Defense Position monster and inflicts piercing damage');
}

section('Arcana Force VI - The Lovers');
{
  const e = duel(['Arcana Force VI - The Lovers', 'Arcana Force XXI - The World']);
  e.roll = () => 1;
  const lovers = place(e, 0, 'Arcana Force VI - The Lovers')!;
  check(lovers.tags?.coin === 1, 'tosses a coin when Summoned (Heads)');
  const world = grab(e, 0, 'Arcana Force XXI - The World');
  check(e.canNormalSummon(0, world), 'Heads: it alone can Tribute Summon a Level 8 "Arcana Force"');
  e.apply({ type: 'SUMMON', player: 0, uid: world.uid, zone: 1, pos: 'atk', faceUp: true });
  settle(e, 'yes');
  check(zone(e, world) === 'mz' && zone(e, lovers) === 'gy', 'treated as 2 Tributes');
}
{
  const e = duel(['Arcana Force VI - The Lovers', 'Arcana Force XXI - The World']);
  e.roll = () => 2;
  place(e, 0, 'Arcana Force VI - The Lovers');
  place(e, 0, FILL);
  const world = grab(e, 0, 'Arcana Force XXI - The World');
  check(!e.canNormalSummon(0, world, true), 'Tails: you cannot Tribute Summon "Arcana Force" monsters');
}

section('Battle Survivor');
{
  const e = duel(['Battle Survivor'], ['Gemini Elf']);
  place(e, 0, 'Battle Survivor');
  const celtic = place(e, 0, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  toTurn3(e);
  toBattle(e);
  attack(e, celtic, elf);
  check(zone(e, celtic) === 'gy', 'a monster is destroyed during the Battle Phase');
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  settle(e, 'yes');
  check(zone(e, celtic) === 'hand', 'at the end of the Battle Phase it adds that card from the GY to the hand');
}

section('Buster Blader, the Destruction Swordmaster');
{
  const e = duel(['Buster Blader, the Destruction Swordmaster'], ['Gemini Elf', 'Mystical Elf', FILL]);
  const bb = place(e, 0, 'Buster Blader, the Destruction Swordmaster')!;
  const elf = place(e, 1, 'Gemini Elf')!;
  kill(e, [elf], 0, 'yes');
  check(zone(e, elf) === 'sz' && e.controller(elf.uid) === 0 && bb.equips.includes(elf.uid), "an opponent's destroyed monster is equipped to it");
  const mys = place(e, 1, 'Mystical Elf')!;
  const war = place(e, 1, FILL)!;
  effect(e, 0, bb);
  check(zone(e, elf) === 'gy' && zone(e, mys) === 'gy' && zone(e, war) === 'mz', 'sending the equipped Spellcaster destroys every Spellcaster the opponent controls');
}

section('Chronomaly Sol Monolith');
{
  const e = duel(['Chronomaly Sol Monolith', 'Chronomaly Moai', 'Chronomaly Mud Golem']);
  const sol = place(e, 0, 'Chronomaly Sol Monolith')!;
  const moai = place(e, 0, 'Chronomaly Moai')!;
  effect(e, 0, sol, { pick: ['Chronomaly Moai'] });
  check(levelOf(e, moai) === 6, 'the targeted "Chronomaly" monster becomes Level 6');
  check(e.summonBlocked(0, grab(e, 0, FILL), 'special', 'hand') && !e.summonBlocked(0, grab(e, 0, 'Chronomaly Mud Golem'), 'special', 'hand'), 'only "Chronomaly" monsters can be Special Summoned this turn');
}

section('D Cubed');
{
  const e = duel(['D Cubed', 'D Cubed', 'D Cubed', 'Destiny HERO - Dasher', 'Destiny HERO - Dasher']);
  const d = place(e, 0, 'D Cubed')!;
  const hand = e.player(0).hand.length;
  effect(e, 0, d, { pick: ['2 cards'] });
  check(e.monsters(0).filter((m) => m.name === 'D Cubed').length === 3 && e.player(0).hand.length === hand - 2, 'discard 2: Special Summon 2 "D Cubed"');
  check(e.summonBlocked(0, grab(e, 0, FILL), 'normal', 'hand') && !e.summonBlocked(0, grab(e, 0, 'Destiny HERO - Dasher'), 'normal', 'hand'), 'then only "Destiny HERO" monsters can be Summoned this turn');
  kill(e, [d], 1, 'yes');
  check(e.player(0).gy.some((c) => c.name === 'Destiny HERO - Dasher'), 'destroyed: sends a "Destiny HERO" from the Deck to the GY');
}

section('Dark Red Enchanter');
{
  const e = duel(['Dark Red Enchanter', 'Pot of Greed'], [FILL]);
  place(e, 0, FILL);
  const dre = summon(e, 0, 'Dark Red Enchanter')!;
  check(dre.counters === 2 && e.atkOf(dre) === 1700 + 600, 'Normal Summoned: 2 Spell Counters, +300 ATK each');
  playSpell(e, 0, 'Pot of Greed', { respond: 'Dark Red Enchanter' });
  check(dre.counters === 3, 'a Spell activation places a Spell Counter');
  const opp = e.player(1).hand.length;
  effect(e, 0, dre);
  check(dre.counters === 1 && e.player(1).hand.length === opp - 1, "remove 2: discard 1 random card from the opponent's hand");
}

section('Destiny HERO - Dark Angel');
{
  const e = duel(['Destiny HERO - Dark Angel', 'Destiny HERO - Diamond Dude', 'Destiny HERO - Diamond Dude', 'Destiny HERO - Diamond Dude', FILL, 'Pot of Greed'], [FILL, 'Pot of Greed']);
  for (let i = 0; i < 3; i++) run(e, e.sendToGrave(e.player(0).deck.find((c) => c.name === 'Destiny HERO - Diamond Dude')!.uid, 'cost'));
  const angel = grab(e, 0, 'Destiny HERO - Dark Angel');
  effect(e, 0, angel);
  check(zone(e, angel) === 'gy' && e.monsters(1).some((m) => m.name === 'Destiny HERO - Diamond Dude' && m.pos === 'def'), 'discard it: a "Destiny HERO" from the GY is Special Summoned to the opponent\'s field in Defense Position');
  endTurn(e);
  endTurn(e, 'yes');
  check(zone(e, angel) === 'removed' && e.player(0).deck[0].name === 'Pot of Greed' && e.player(1).deck[0].name === 'Pot of Greed', 'Standby Phase: banish it; each player puts a Normal Spell on top of their Deck');
}

section('Elemental HERO Neos Alius');
{
  const e = duel(['Elemental HERO Neos Alius']);
  const m = place(e, 0, 'Elemental HERO Neos Alius')!;
  effect(e, 0, m);
  check(m.tags?.gemini === 1 && e.player(0).normalSummoned, 'Normal Summoning it again makes it an Effect Monster');
}

section('Evolsaur Darwino');
{
  const e = duel(['Evolsaur Darwino']);
  const c = place(e, 0, FILL)!;
  const dar = e.player(0).deck.find((x) => x.name === 'Evolsaur Darwino')!;
  e.state.fx.evoltileSS = dar.uid;
  place(e, 0, 'Evolsaur Darwino', 'atk', true, 'yes', { pick: [FILL] }, { pick: ['2'] });
  check(levelOf(e, c) === 6, 'Special Summoned by an "Evoltile": a monster gains up to 2 Levels');
}

section('Flyfang');
{
  const e = duel(['Flyfang']);
  const fly = place(e, 0, 'Flyfang')!;
  toTurn3(e);
  toBattle(e);
  attack(e, fly, null);
  check(lp(e, 1) === 4000 - 1600, 'it inflicts battle damage');
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  settle(e);
  check(zone(e, fly) === 'removed' && e.state.turnPlayer === 1, 'at the end of the Battle Phase it is banished');
  check(zone(e, fly) === 'removed', "still banished during the opponent's turn");
  endTurn(e);
  check(zone(e, fly) === 'mz' && e.controller(fly.uid) === 0, 'it returns during your next Standby Phase');
}

section('Gearfried the Iron Knight');
{
  const e = duel(['Gearfried the Iron Knight', 'Axe of Despair']);
  place(e, 0, 'Gearfried the Iron Knight');
  const axe = grab(e, 0, 'Axe of Despair');
  act(e, 0, axe.uid);
  check(zone(e, axe) === 'gy' && logHas(e, 'Gearfried the Iron Knight destroys the Equip Card'), 'an Equip Card equipped to it is destroyed');
}

section('Harpie Lady 2');
{
  const e = duel(['Harpie Lady 2'], ['Man-Eater Bug']);
  const h = place(e, 0, 'Harpie Lady 2')!;
  const bug = place(e, 1, 'Man-Eater Bug', 'def', false)!;
  toTurn3(e);
  toBattle(e);
  attack(e, h, bug);
  check(zone(e, bug) === 'gy' && zone(e, h) === 'mz' && logHas(e, "negates Man-Eater Bug's FLIP effect"), 'the FLIP effect of a monster it destroys by battle is negated');
}

section('Infernity Beast');
{
  const e = duel(['Infernity Beast']);
  const b = place(e, 0, 'Infernity Beast')!;
  e.state.battle = { attacker: b.uid, target: null };
  const withHand = e.attackSealed(1);
  for (const c of e.player(0).hand.slice()) run(e, e.sendToGrave(c.uid, 'cost'));
  const noHand = e.attackSealed(1);
  e.state.battle = null;
  check(!withHand && noHand, 'it stops Spell/Trap activations only while you have no cards in your hand');
}

section('Lancer Archfiend');
{
  const e = duel(['Lancer Archfiend'], [FILL]);
  place(e, 0, 'Lancer Archfiend');
  const c = place(e, 0, FILL)!;
  const def = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, c, def, { respond: 'Lancer Archfiend' });
  check(zone(e, def) === 'gy' && lp(e, 1) === 4000 - 200, 'your attack on a Defense Position monster inflicts piercing damage');
}

section('Maiden of the Aqua / The Legendary Fisherman');
{
  const e = duel(['Maiden of the Aqua', 'The Legendary Fisherman'], [FILL, 'Yami']);
  place(e, 0, 'Maiden of the Aqua');
  check(!!e.anyActive('Umi'), 'Maiden of the Aqua: the field is treated as "Umi"');
  const fish = place(e, 0, 'The Legendary Fisherman')!;
  const foe = place(e, 1, FILL)!;
  check(!e.legalTargets(1, foe).some((m) => m.uid === fish.uid), 'The Legendary Fisherman cannot be attacked while "Umi" is on the field');
  endTurn(e);
  playSpell(e, 1, 'Yami');
  check(!e.anyActive('Umi') && e.legalTargets(1, foe).some((m) => m.uid === fish.uid), "with an active Field Spell, Maiden's effect does not apply");
}
{
  const e = duel(['The Legendary Fisherman', 'Umi'], ['Raigeki']);
  playSpell(e, 0, 'Umi');
  const fish = place(e, 0, 'The Legendary Fisherman')!;
  const c = place(e, 0, FILL)!;
  endTurn(e);
  playSpell(e, 1, 'Raigeki');
  check(zone(e, fish) === 'mz' && zone(e, c) === 'gy', 'The Legendary Fisherman is unaffected by Spell effects while "Umi" is on the field');
}

section('Maxx "C"');
{
  const e = duel(['Maxx "C"'], [FILL, FILL]);
  grab(e, 0, 'Maxx "C"');
  endTurn(e);
  const hand = e.player(0).hand.length;
  summon(e, 1, FILL, true, { respond: 'Maxx "C"' });
  check(e.player(0).gy.some((c) => c.name === 'Maxx "C"') && e.player(0).hand.length === hand - 1, "sent from the hand to the GY during the opponent's turn");
  place(e, 1, FILL);
  check(e.player(0).hand.length === hand, 'the opponent Special Summons: draw 1 card');
}

section('Parasite Paranoid');
{
  const e = duel(['Parasite Paranoid', 'Insect Soldiers of the Sky', 'Insect Queen'], [FILL]);
  const bug = place(e, 0, 'Insect Soldiers of the Sky')!;
  const foe = place(e, 1, FILL)!;
  const par = grab(e, 0, 'Parasite Paranoid');
  grab(e, 0, 'Insect Queen');
  e.apply({ type: 'QUICK_EFFECT', player: 0, uid: par.uid });
  settle(e, { pick: [FILL] });
  check(zone(e, par) === 'sz' && foe.equips.includes(par.uid) && e.raceOf(foe) === 'Insect', 'equipped from the hand: the monster becomes an Insect');
  check(!e.legalTargets(1, foe).some((m) => m.uid === bug.uid), 'the equipped monster cannot attack Insect monsters');
  kill(e, [par], 1, 'yes');
  check(e.monsters(0).some((m) => m.name === 'Insect Queen') && e.raceOf(foe) === 'Warrior', 'sent to the GY: Special Summon a Level 7+ Insect from the hand');
}

section('Phantom Beast Thunder-Pegasus');
{
  const e = duel(['Phantom Beast Thunder-Pegasus', 'Phantom Beast Wild-Horn'], ['Summoned Skull']);
  run(e, e.sendToGrave(e.player(0).deck.find((c) => c.name === 'Phantom Beast Thunder-Pegasus')!.uid, 'cost'));
  const horn = place(e, 0, 'Phantom Beast Wild-Horn')!;
  endTurn(e);
  const skull = place(e, 1, 'Summoned Skull')!;
  toBattle(e);
  attack(e, skull, horn, { respond: 'Phantom Beast Thunder-Pegasus' });
  check(zone(e, horn) === 'mz' && lp(e, 0) === 4000 && e.player(0).removed.some((c) => c.name === 'Phantom Beast Thunder-Pegasus'), 'banished from the GY: the Phantom Beast takes no battle damage and is not destroyed');
}

section('Red Gardna');
{
  const e = duel(['Red Gardna'], ['Raigeki']);
  const rda = e.createToken('Red Dragon Archfiend', 0, 'atk', true, { atk: 3000, def: 2000, level: 8, attribute: 'DARK', race: 'Dragon' })!;
  const c = place(e, 0, FILL)!;
  grab(e, 0, 'Red Gardna');
  endTurn(e);
  playSpell(e, 1, 'Raigeki', { respond: 'Red Gardna' });
  check(zone(e, c) === 'mz' && e.fieldCard(rda.uid) && e.player(0).gy.some((x) => x.name === 'Red Gardna'), "your monsters cannot be destroyed by the opponent's card effects this turn");
}

section('Spell Canceller');
{
  const e = duel(['Spell Canceller', 'Pot of Greed']);
  const pot = grab(e, 0, 'Pot of Greed');
  check(e.canActivateMain(0, pot.uid), 'a Spell can be activated before');
  const sc = place(e, 0, 'Spell Canceller')!;
  check(!e.canActivateMain(0, pot.uid) && e.spellsNegated(), 'Spell Cards cannot be activated and Spell effects are negated');
  kill(e, [sc]);
  check(e.canActivateMain(0, pot.uid), 'once it leaves, Spells work again');
}

section('Unshaven Angler');
{
  const e = duel(['Unshaven Angler', 'Levia-Dragon - Daedalus', 'Arcana Force XXI - The World']);
  const ang = place(e, 0, 'Unshaven Angler')!;
  check(!e.canNormalSummon(0, grab(e, 0, 'Arcana Force XXI - The World')), 'not for a non-WATER monster');
  const levia = grab(e, 0, 'Levia-Dragon - Daedalus');
  check(e.canNormalSummon(0, levia), 'it alone can Tribute Summon a Level 7 WATER monster');
  e.apply({ type: 'SUMMON', player: 0, uid: levia.uid, zone: 1, pos: 'atk', faceUp: true });
  settle(e, 'yes');
  check(zone(e, levia) === 'mz' && zone(e, ang) === 'gy', 'treated as 2 Tributes');
}

section('White Magician Pikeru');
{
  const e = duel(['White Magician Pikeru']);
  place(e, 0, 'White Magician Pikeru');
  place(e, 0, FILL);
  place(e, 0, FILL);
  toTurn3(e);
  check(lp(e, 0) === 4000 + 1200, 'your Standby Phase: gain 400 LP for each monster you control');
}

// ======================= Fusion Monsters =======================
section('Elemental HERO Glow Neos');
{
  const e = duel([], ['Messenger of Peace'], ['Elemental HERO Glow Neos'], [], 1);
  const mp = playSpell(e, 1, 'Messenger of Peace');
  endTurn(e);
  const neos = place(e, 0, 'Elemental HERO Glow Neos')!;
  effect(e, 0, neos);
  check(zone(e, mp) === 'gy' && e.canAttackDirectly(neos), 'destroys a face-up Spell: it can attack directly this turn');
  endTurn(e);
  check(zone(e, neos) === 'fusion', 'End Phase: shuffled into the Extra Deck');
}

section('Evil HERO Wild Cyclone');
{
  const e = duel([], ['Mirror Force', 'Ookazi'], ['Evil HERO Wild Cyclone']);
  const wc = place(e, 0, 'Evil HERO Wild Cyclone')!;
  const a = putST(e, 1, 'Mirror Force');
  const b = putST(e, 1, 'Ookazi');
  toTurn3(e);
  toBattle(e);
  attack(e, wc, null);
  check(lp(e, 1) === 4000 - 1900 && zone(e, a) === 'gy' && zone(e, b) === 'gy', 'inflicts battle damage: every face-down Spell/Trap the opponent controls is destroyed');
}

section('Super Vehicroid - Stealth Union');
{
  const e = duel([], [FILL, FILL, FILL], ['Super Vehicroid - Stealth Union']);
  check(e.fusionMaterials('Super Vehicroid - Stealth Union')?.length === 4, 'its 4 Fusion Materials are read');
  const su = place(e, 0, 'Super Vehicroid - Stealth Union')!;
  const a = place(e, 1, FILL)!;
  const b = place(e, 1, FILL)!;
  const c = place(e, 1, FILL)!;
  effect(e, 0, su);
  check(su.equips.length === 1 && zone(e, a) === 'sz', 'equips a non-Machine monster to itself');
  toTurn3(e);
  toBattle(e);
  attack(e, su, b);
  attack(e, e.fieldCard(su.uid), c);
  check(zone(e, b) === 'gy' && zone(e, c) === 'gy' && lp(e, 1) === 4000 - 2 * (1800 - 1400), 'attacks every opponent monster once, with its original ATK halved');
}

// ======================= Ritual Monster =======================
section('Confiras de Nouvelles');
{
  const e = duel(['Confiras de Nouvelles'], ['Mirror Force']);
  const mf = putST(e, 1, 'Mirror Force');
  place(e, 0, 'Confiras de Nouvelles', 'atk', true, 'yes');
  check(zone(e, mf) === 'gy', 'Special Summoned: destroys a Spell/Trap on the field');
}

// ======================= Spells =======================
section('Reverse Breaker');
{
  const e = duel(['Reverse Breaker'], ['Mirror Force']);
  const u = e.createToken('Number 39: Utopia', 0, 'atk', true, { atk: 2500, def: 2000, level: 4, attribute: 'LIGHT', race: 'Warrior' })!;
  const rb = playSpell(e, 0, 'Reverse Breaker');
  check(zone(e, rb) === 'sz' && u.equips.includes(rb!.uid), 'equips to a "Utopia" monster');
  const mf = putST(e, 1, 'Mirror Force');
  toTurn3(e);
  toBattle(e);
  attack(e, e.fieldCard(u.uid), null, { respond: 'Reverse Breaker' });
  check(zone(e, mf) === 'gy', 'the equipped monster attacks: destroys a Spell/Trap the opponent controls');
}

section('Geartown');
{
  const e = duel(['Geartown', 'Ancient Gear Golem', 'Ancient Gear'], ['Mystical Space Typhoon']);
  const gt = playSpell(e, 0, 'Geartown')!;
  const golem = grab(e, 0, 'Ancient Gear Golem');
  check(e.tributeNeed(0, golem) === 1 && e.tributeNeed(1, golem) === 1 && e.tributeNeed(0, grab(e, 0, FILL)) === 0, '"Ancient Gear" monsters need 1 less Tribute (both players)');
  kill(e, [gt], 1, 'yes');
  check(zone(e, gt) === 'gy' && e.monsters(0).some((m) => m.name === 'Ancient Gear'), 'destroyed: Special Summon an "Ancient Gear" monster');
}

section('Abyss Script - Fantasy Magic');
{
  const e = duel(['Abyss Actor - Extras', 'Abyss Script - Fantasy Magic'], ['Giant Soldier of Stone']);
  const ex = place(e, 0, 'Abyss Actor - Extras')!;
  const gs = place(e, 1, 'Giant Soldier of Stone', 'def')!;
  toTurn3(e);
  playSpell(e, 0, 'Abyss Script - Fantasy Magic');
  toBattle(e);
  attack(e, ex, gs);
  check(zone(e, gs) === 'hand', 'a monster that battles it and is not destroyed returns to the hand');
}

section('Card Advance');
{
  const e = duel(['Card Advance', 'Summoned Skull', 'Pot of Greed']);
  summon(e, 0, FILL);
  const skull = grab(e, 0, 'Summoned Skull');
  e.player(0).normalSummoned = true;
  check(!e.canNormalSummon(0, skull), 'no second Normal Summon before');
  grab(e, 0, 'Card Advance');
  const top = e.player(0).deck.slice(0, 5).map((c) => c.uid);
  playSpell(e, 0, 'Card Advance');
  check(e.player(0).deck.slice(0, 5).every((c) => top.includes(c.uid)), 'the top 5 cards go back on top');
  check(e.canNormalSummon(0, skull), 'you can Tribute Summon 1 more monster this turn');
  e.apply({ type: 'SUMMON', player: 0, uid: skull.uid, zone: 1, pos: 'atk', faceUp: true });
  settle(e);
  check(zone(e, skull) === 'mz' && !e.canNormalSummon(0, grab(e, 0, FILL)), 'the extra Tribute Summon is used up');
}

section('Flower Gathering');
{
  const e = duel(['Flower Gathering', 'Flower Cardian Pine', 'Flower Cardian Willow', 'Flower Cardian Maple with Deer', 'Flower Cardian Cherry Blossom with Curtain']);
  const fg = grab(e, 0, 'Flower Gathering');
  check(!e.canActivateMain(0, fg.uid), 'it needs 4 free Monster Zones, so it cannot be activated in a Speed Duel');
}

section('Worm Bait');
{
  const e = duel(['Worm Bait', 'Petit Moth']);
  const wb = grab(e, 0, 'Worm Bait');
  check(!e.canActivateMain(0, wb.uid), 'needs an Insect monster');
  place(e, 0, 'Petit Moth');
  playSpell(e, 0, 'Worm Bait');
  check(e.monsters(0).filter((m) => m.name === 'Worm Token').length === 2, 'Special Summons 2 Worm Tokens');
  check(e.summonBlocked(0, grab(e, 0, FILL), 'normal', 'hand'), 'Level 3 or 4 monsters cannot be Summoned this turn');
}

section('Fullmetalfoes Fusion');
{
  const fake = { ...DB.get('Elemental HERO Glow Neos')!, id: 990001, name: 'Metalfoes Test Fusion', desc: '"Celtic Guardian" + "Celtic Guardian"' };
  DB.set(fake.name, fake);
  const e = duel(['Fullmetalfoes Fusion'], [], ['Metalfoes Test Fusion', 'Elemental HERO Glow Neos']);
  place(e, 0, FILL);
  playSpell(e, 0, 'Fullmetalfoes Fusion');
  check(e.monsters(0).some((m) => m.name === 'Metalfoes Test Fusion') && e.player(0).gy.filter((c) => c.name === FILL).length === 2, 'Fusion Summons a "Metalfoes" Fusion Monster with materials from the hand or field');
  DB.delete(fake.name);
}

// ======================= Traps =======================
section('Mass Hypnosis');
{
  const e = duel(['Mass Hypnosis'], [FILL]);
  e.createToken('Alien Warrior', 0, 'atk', true, { atk: 1800, def: 1000, level: 4, attribute: 'EARTH', race: 'Reptile' });
  const foe = place(e, 1, FILL)!;
  (foe.tags ??= {}).aCounter = 1;
  const mh = playTrap(e, 0, 'Mass Hypnosis');
  check(e.controller(foe.uid) === 0, 'takes control of a monster with an A-Counter');
  endTurn(e);
  check(zone(e, mh) === 'gy' && e.controller(foe.uid) === 1, 'destroyed during the End Phase; the monster goes back');
}

section('A Feint Plan');
{
  const e = duel(['A Feint Plan'], [FILL]);
  const me = place(e, 0, FILL)!;
  const fd = place(e, 1, FILL, 'def', false)!;
  check(e.legalTargets(0, me).some((m) => m.uid === fd.uid), 'face-down monsters can be attacked before');
  playTrap(e, 0, 'A Feint Plan');
  check(!e.legalTargets(0, me).some((m) => m.uid === fd.uid), 'face-down monsters cannot be attacked this turn');
  endTurn(e);
  check(e.legalTargets(0, me).some((m) => m.uid === fd.uid), 'only for that turn');
}

section('Blast with Chain');
{
  const e = duel(['Blast with Chain'], ['Gemini Elf']);
  const c = place(e, 0, FILL)!;
  const elf = place(e, 1, 'Gemini Elf')!;
  const bwc = playTrap(e, 0, 'Blast with Chain', { pick: [FILL] });
  check(zone(e, bwc) === 'sz' && e.atkOf(c) === 1900, 'equips itself: +500 ATK');
  kill(e, [bwc], 1, { pick: ['Gemini Elf'] });
  check(zone(e, elf) === 'gy', 'destroyed by a card effect while equipped: destroys 1 card on the field');
}

section('Formation Union');
{
  const e = duel(['Formation Union', 'Formation Union', 'Y-Dragon Head', 'X-Head Cannon']);
  const c = place(e, 0, 'X-Head Cannon')!;
  const y = place(e, 0, 'Y-Dragon Head')!;
  playTrap(e, 0, 'Formation Union', { pick: ['Equip a Union monster'] });
  check(zone(e, y) === 'sz' && c.equips.includes(y.uid), 'equips a Union monster to a monster you control');
  playTrap(e, 0, 'Formation Union', { pick: ['Unequip a Union monster and Special Summon it'] });
  check(zone(e, y) === 'mz' && !c.equips.includes(y.uid), 'unequips it and Special Summons it');
}

section("Joker's Wild");
{
  const e = duel(["Joker's Wild", "Queen's Knight"]);
  const jw = putST(e, 0, "Joker's Wild");
  check(!e.canActivateMain(0, jw.uid), 'no Spell lists all 3 Knights here, so its first effect cannot be activated');
  run(e, e.sendToGrave(jw.uid, 'cost'));
  run(e, e.sendToGrave(e.player(0).deck.find((c) => c.name === "Queen's Knight")!.uid, 'cost'));
  endTurn(e, 'yes');
  check(zone(e, jw) === 'hand' && e.player(0).deck.some((c) => c.name === "Queen's Knight"), 'End Phase in the GY: shuffle a LIGHT Warrior into the Deck and add this card to the hand');
}

section("Pharaoh's Treasure");
{
  const e = duel(["Pharaoh's Treasure", 'Pot of Greed']);
  run(e, e.sendToGrave(e.player(0).deck.find((c) => c.name === 'Pot of Greed')!.uid, 'cost'));
  const pt = putST(e, 0, "Pharaoh's Treasure");
  act(e, 0, pt.uid);
  check(zone(e, pt) === 'deck', 'shuffled face-up into the Deck');
  const d = e.player(0).deck;
  const [card] = d.splice(d.findIndex((c) => c.uid === pt.uid), 1);
  d.unshift(card);
  endTurn(e);
  endTurn(e);
  check(zone(e, pt) === 'gy' && e.player(0).hand.some((c) => c.name === 'Pot of Greed'), 'drawn: sent to the GY, then a card from the GY is added to the hand');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
if (fails) process.exit(1);
