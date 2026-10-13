// Speed Duel card scripts of batch 17 (Xyz Monsters) (run: npx tsx tests/batch-17.test.ts)
// One or more targeted checks per scripted card: its main effect really happens in a duel.
import { Engine } from '../src/eds/engine';
import type { Card, FieldCard, Pid, Pos } from '../src/eds/types';
import { DB } from './speedkit';

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
const proc = (e: Engine, p: Pid, name: string, ...ans: Ans[]) => {
  const c = e.player(p).fusion.find((x) => x.name === name)!;
  const can = e.canSpecialProc(p, c);
  if (can) {
    e.apply({ type: 'SPECIAL', player: p, uid: c.uid });
    settle(e, ...ans);
  }
  return { can, fc: e.fieldCard(c.uid) };
};
const toMain = (e: Engine) => {
  while (e.state.phase !== 'M1') (e.apply({ type: 'NEXT_PHASE', player: e.state.turnPlayer }), settle(e));
};
/** Special Summons an Xyz Monster from the Extra Deck and attaches `n` cards from the bottom of the Deck as its materials. */
function xyz(e: Engine, p: Pid, name: string, n: number): FieldCard {
  const fc = place(e, p, name)!;
  for (let i = 0; i < n; i++) e.attachMat(fc, e.player(p).deck[e.player(p).deck.length - 1].uid);
  return fc;
}
const mats = (e: Engine, m: FieldCard) => e.matsOf(m).length;
/** A made-up card for checks the Speed Duel pool cannot set up (it has no "Spellbook" Spells and no Rank 3 WATER Xyz Monsters). */
function fake(name: string, from: string, patch: Record<string, unknown>) {
  const info = { ...DB.get(from)!, name, ...patch };
  DB.set(name, info as any);
  DB.set(name.toLowerCase(), info as any);
}
fake('Spellbook of Testing', 'Axe of Despair', { sub: 'Normal', desc: 'test' });
fake('Test Rank 3 WATER Xyz', 'Number 103: Ragnazero', { rank: 3, attribute: 'WATER', desc: '2 Level 3 monsters' });

section('Alsei, the Sylvan High Protector');
{
  const e = duel(['Gagagigo'], [], ['Alsei, the Sylvan High Protector']);
  toMain(e);
  const al = xyz(e, 0, 'Alsei, the Sylvan High Protector', 2);
  const top = e.player(0).deck[0];
  effect(e, 0, al, { pick: [top.name] });
  check(zone(e, top) === 'hand', 'declares the top card: it is added to the hand');
}
{
  const e = duel(['Gagagigo', 'Gagagigo'], [], ['Alsei, the Sylvan High Protector']);
  toMain(e);
  const al = xyz(e, 0, 'Alsei, the Sylvan High Protector', 2);
  const foe = place(e, 1, FILL)!;
  const top = e.player(0).deck[0];
  const wrong = top.name === FILL ? 'Gagagigo' : FILL;
  effect(e, 0, al, { pick: [wrong] }, 'yes', { pick: [FILL] }, { pick: [FILL] }, { pick: ['Bottom of the Deck'] });
  check(zone(e, top) === 'gy', 'a wrong declaration sends the excavated card to the GY');
  const deck1 = e.player(1).deck;
  check(deck1[deck1.length - 1]?.uid === foe.uid && mats(e, al) === 1, 'a card sent from the Deck lets it detach 1 and put a card on the bottom of the Deck');
}

section('Bujintei Tsukuyomi');
{
  const e = duel([], [], ['Bujintei Tsukuyomi', 'Bujintei Tsukuyomi']);
  toMain(e);
  const bt = xyz(e, 0, 'Bujintei Tsukuyomi', 1);
  const hand = e.player(0).hand.slice();
  check(hand.length > 0, 'has a hand to send');
  effect(e, 0, bt);
  check(hand.every((c) => zone(e, c) === 'gy') && e.player(0).hand.length === 2 && mats(e, bt) === 0, 'detaches 1, sends the hand to the GY and draws 2');
  check(e.summonBlocked(0, e.player(0).fusion[0], 'special', 'fusion'), 'you can only control 1 "Bujintei Tsukuyomi"');
}

section('Downerd Magician');
{
  const e = duel([], [], ['Downerd Magician']);
  toMain(e);
  const dm = xyz(e, 0, 'Downerd Magician', 2);
  check(e.atkOf(dm) === 2100 + 400, 'gains 200 ATK for each material');
  const def = place(e, 1, FILL, 'def')!;
  toTurn3(e);
  toBattle(e);
  attack(e, dm, def);
  check(zone(e, def) === 'gy' && lp(e, 1) === 4000 - (2500 - 1200), 'inflicts piercing battle damage');
  check(mats(e, dm) === 1, 'detaches 1 material after damage calculation');
}

section('Fairy Knight Ingunar');
{
  const e = duel([], ['Mirror Force'], ['Fairy Knight Ingunar']);
  toMain(e);
  const fk = xyz(e, 0, 'Fairy Knight Ingunar', 3);
  const own = place(e, 0, FILL)!;
  const foe = place(e, 1, FILL)!;
  const st = putST(e, 1, 'Mirror Force');
  effect(e, 0, fk);
  check(zone(e, own) === 'hand' && zone(e, foe) === 'hand' && zone(e, st) === 'hand' && zone(e, fk) === 'mz' && mats(e, fk) === 1, 'detaches 2 and returns all other cards on the field to the hand');
}

section('Full Armored Black Ray Lancer');
{
  const e = duel([], ['Mirror Force'], ['Full Armored Black Ray Lancer', 'Test Rank 3 WATER Xyz']);
  toMain(e);
  const r3 = place(e, 0, 'Test Rank 3 WATER Xyz')!;
  const { can, fc } = proc(e, 0, 'Full Armored Black Ray Lancer');
  check(can && !!fc && fc.tags?.xyzS === 1 && fc.mats?.[0]?.uid === r3.uid, 'can be Xyz Summoned using a Rank 3 WATER Xyz Monster with no materials');
  const bl = fc!;
  e.attachMat(bl, e.player(0).deck[0].uid);
  check(e.atkOf(bl) === 2100 + 400, 'gains 200 ATK for each material');
  kill(e, [bl], 1);
  check(zone(e, bl) === 'mz' && mats(e, bl) === 0, 'detaches all of its materials instead of being destroyed');
  const foe = place(e, 1, FILL)!;
  const st = putST(e, 1, 'Mirror Force');
  toTurn3(e);
  toBattle(e);
  attack(e, bl, foe, 'yes');
  check(zone(e, foe) === 'gy' && zone(e, st) === 'gy', 'destroying a monster by battle destroys 1 Spell/Trap of the opponent');
}

section('Full Armored Crystalzero Lancer');
{
  const e = duel([], ['Gale Lizard'], ['Full Armored Crystalzero Lancer']);
  toMain(e);
  const cz = xyz(e, 0, 'Full Armored Crystalzero Lancer', 2);
  check(e.atkOf(cz) === 2200 + 1000, 'gains 500 ATK for each material');
  const foe = place(e, 1, 'Gale Lizard')!;
  effect(e, 0, cz);
  check(e.isNegated(foe) && mats(e, cz) === 1, "detaches 1 and negates the opponent's face-up monsters");
  kill(e, [cz], 1);
  check(zone(e, cz) === 'mz' && mats(e, cz) === 0, 'detaches 1 material instead of being destroyed');
}

section('Galaxy-Eyes Cipher Dragon');
{
  const e = duel([], ['Gale Lizard'], ['Galaxy-Eyes Cipher Dragon']);
  toMain(e);
  const gc = xyz(e, 0, 'Galaxy-Eyes Cipher Dragon', 1);
  const foe = place(e, 1, 'Gale Lizard')!;
  effect(e, 0, gc);
  check(e.controller(foe.uid) === 0 && e.atkOf(foe) === 3000 && e.isNegated(foe) && mats(e, gc) === 0, 'takes control of the monster: effects negated, ATK 3000');
  endTurn(e);
  check(e.controller(foe.uid) === 1, 'it returns in the End Phase');
}

section('Galaxy-Eyes Full Armor Photon Dragon');
{
  const e = duel(['Axe of Despair'], [FILL], ['Galaxy-Eyes Full Armor Photon Dragon', 'Galaxy-Eyes Cipher Dragon']);
  toMain(e);
  const gc = xyz(e, 0, 'Galaxy-Eyes Cipher Dragon', 1);
  const { can, fc } = proc(e, 0, 'Galaxy-Eyes Full Armor Photon Dragon');
  check(can && !!fc && mats(e, fc!) === 2 && fc!.mats!.some((c) => c.uid === gc.uid), 'Xyz Summoned using a "Galaxy-Eyes" Xyz Monster (its materials go along)');
  const ga = fc!;
  const foe = place(e, 1, FILL)!;
  effect(e, 0, ga);
  check(zone(e, foe) === 'gy' && mats(e, ga) === 1, 'detaches 1 and destroys a face-up card the opponent controls');
  const axe = playSpell(e, 0, 'Axe of Despair', { pick: ['Galaxy-Eyes Full Armor Photon Dragon'] });
  check(axe?.equippedTo === ga.uid, 'is equipped');
  effect(e, 0, ga);
  check(ga.mats!.some((c) => c.uid === axe!.uid) && zone(e, axe) === undefined, 'attaches an Equip Card equipped to it as material');
}

section('Heroic Champion - Excalibur');
{
  const e = duel([], [], ['Heroic Champion - Excalibur']);
  toMain(e);
  const ex = xyz(e, 0, 'Heroic Champion - Excalibur', 2);
  effect(e, 0, ex);
  check(e.atkOf(ex) === 4000 && mats(e, ex) === 0, 'detaches 2: its ATK becomes double its original ATK');
  endTurn(e);
  check(e.atkOf(ex) === 4000, "it lasts through the opponent's turn");
  endTurn(e);
  check(e.atkOf(ex) === 2000, "it ends after the opponent's End Phase");
}

section('Hierophant of Prophecy');
{
  const e = duel(['Spellbook of Testing'], ['Mirror Force', 'Mirror Force'], ['Hierophant of Prophecy']);
  toMain(e);
  const book = [...e.player(0).deck, ...e.player(0).hand].find((c) => c.name === 'Spellbook of Testing')!;
  run(e, e.sendToGrave(book.uid, 'cost'));
  const hp = xyz(e, 0, 'Hierophant of Prophecy', 2);
  const a = putST(e, 1, 'Mirror Force');
  const b = putST(e, 1, 'Mirror Force');
  effect(e, 0, hp);
  check([a, b].filter((c) => zone(e, c) === 'gy').length === 1 && mats(e, hp) === 1, 'destroys Spells/Traps up to the number of "Spellbook" Spells in the GY');
}

section('Number 103: Ragnazero');
{
  const e = duel([], [], ['Number 103: Ragnazero']);
  toMain(e);
  const rz = xyz(e, 0, 'Number 103: Ragnazero', 2);
  const foe = place(e, 1, FILL)!;
  const plain = place(e, 1, FILL)!;
  foe.atkMod = -300;
  const hand = e.player(0).hand.length;
  e.apply({ type: 'QUICK_EFFECT', player: 0, uid: rz.uid });
  settle(e);
  check(zone(e, foe) === 'gy' && zone(e, plain) === 'mz' && e.player(0).hand.length === hand + 1 && mats(e, rz) === 1, 'detaches 1, destroys a monster whose ATK changed and draws 1');
}

section('Number 24: Dragulas the Vampiric Dragon');
{
  const e = duel([], [], ['Number 24: Dragulas the Vampiric Dragon'], ['Number 103: Ragnazero']);
  toMain(e);
  const dr = xyz(e, 0, 'Number 24: Dragulas the Vampiric Dragon', 2);
  const foe = place(e, 1, 'Number 103: Ragnazero')!;
  e.apply({ type: 'QUICK_EFFECT', player: 0, uid: dr.uid });
  settle(e, { pick: ['Number 103: Ragnazero'] });
  check(!foe.faceUp && foe.pos === 'def' && mats(e, dr) === 1, 'detaches 1: a monster Special Summoned from the Extra Deck is changed to face-down Defense Position');
  kill(e, [dr], 1, 'yes');
  const back = e.fieldCard(dr.uid);
  check(!!back && !back.faceUp && back.pos === 'def', "destroyed by the opponent's effect, it is Special Summoned in face-down Defense Position");
  const own = place(e, 0, FILL)!;
  run(e, e.flipEffect(dr.uid, 0), { pick: [FILL] });
  check(zone(e, own) === 'gy', 'flipped face-up: sends 1 card on the field to the GY');
}

section('Number 40: Gimmick Puppet of Strings');
{
  const e = duel([], [FILL], ['Number 40: Gimmick Puppet of Strings']);
  toMain(e);
  const n40 = xyz(e, 0, 'Number 40: Gimmick Puppet of Strings', 1);
  const own = place(e, 0, FILL)!;
  const foe = place(e, 1, FILL)!;
  effect(e, 0, n40);
  check(own.tags?.b17String === 1 && foe.tags?.b17String === 1 && mats(e, n40) === 0, 'detaches 1: a String Counter on each other face-up monster');
  endTurn(e);
  check(zone(e, own) === 'mz', 'nothing happens in your own End Phase');
  endTurn(e);
  check(zone(e, own) === 'gy' && zone(e, foe) === 'gy' && zone(e, n40) === 'mz' && lp(e, 1) === 4000 - 1000, "in the opponent's End Phase the monsters with String Counters are destroyed: 500 damage each");
}

section('Number 45: Crumble Logos the Prophet of Demolition');
{
  const e = duel([], ['Gale Lizard', 'Gale Lizard'], ['Number 45: Crumble Logos the Prophet of Demolition']);
  toMain(e);
  const cl = xyz(e, 0, 'Number 45: Crumble Logos the Prophet of Demolition', 2);
  const foe = place(e, 1, 'Gale Lizard')!;
  effect(e, 0, cl);
  check(e.isNegated(foe) && e.nameLocked('Gale Lizard') && mats(e, cl) === 1, 'detaches 1: the target is negated and cards with its name cannot be activated');
  kill(e, [cl], 1);
  check(!e.isNegated(foe) && e.nameLocked('Gale Lizard'), 'the negation ends when it leaves the field; the lock stays while the target is on the field');
  kill(e, [foe], 0);
  check(!e.nameLocked('Gale Lizard'), 'the lock ends when the target leaves the field');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
