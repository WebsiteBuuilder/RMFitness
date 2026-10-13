// Speed Duel card scripts, batch 18: Xyz Monsters (run: npx tsx tests/batch-18.test.ts)
// One targeted check per card: its main effect really happens in a duel.
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
// ---------- batch-18 helpers ----------
/** Steps to the next turn's Main Phase 1, answering prompts on the way (Standby Phase effects). */
function nextTurn(e: Engine, ...ans: Ans[]) {
  const q = [...ans];
  const use = (left: number) => q.splice(0, q.length - left);
  e.apply({ type: 'END_TURN', player: e.state.turnPlayer });
  use(settle(e, ...q));
  while (e.state.phase !== 'M1' && e.state.winner === null) {
    e.apply({ type: 'NEXT_PHASE', player: e.state.turnPlayer });
    use(settle(e, ...q));
  }
}
const toBattle = (e: Engine) => {
  for (let i = 0; i < 3 && e.state.phase !== 'BP'; i++) (e.apply({ type: 'NEXT_PHASE', player: e.state.turnPlayer }), settle(e));
};
const attack = (e: Engine, a: FieldCard, t: FieldCard | null, ...ans: Ans[]) => {
  e.apply({ type: 'ATTACK', player: e.state.turnPlayer, uid: a.uid, target: t ? t.uid : null });
  return settle(e, ...ans);
};
/** Places an Xyz Monster with these cards (from the Deck) attached as materials; a name not in the Deck becomes a stand-in card. */
function xyz(e: Engine, p: Pid, name: string, mats: string[], ...ans: Ans[]): FieldCard {
  const m = place(e, p, name, 'atk', true, ...ans)!;
  for (const n of mats) {
    const c = e.player(p).deck.find((x) => x.name === n);
    if (c) e.attachMat(m, c.uid);
    else (m.mats ??= []).push({ uid: e.state.uidCounter++, name: n, owner: p });
  }
  return m;
}
const quick = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  const ok = e.canUseQuickNow(p, c.uid);
  if (ok) {
    e.apply({ type: 'QUICK_EFFECT', player: p, uid: c.uid });
    settle(e, ...ans);
  }
  return ok;
};
const effect = (e: Engine, p: Pid, c: Card, ...ans: Ans[]) => {
  const ok = e.canUseMonsterEffect(p, c);
  if (ok) {
    e.apply({ type: 'MONSTER_EFFECT', player: p, uid: c.uid });
    settle(e, ...ans);
  }
  return ok;
};

// Number 49: Fortune Tune: detach instead of being destroyed; +500 LP in your Standby Phase; back to the Extra Deck with 2 Level 3s.
{
  const e = duel(['Baby Dragon', 'Armored Zombie'], [], ['Number 49: Fortune Tune']);
  toMain(e);
  const m = xyz(e, 0, 'Number 49: Fortune Tune', [FILL]);
  run(e, e.as(1, e.destroy([m.uid])), 'yes');
  check(!!e.fieldCard(m.uid) && e.matsOf(m).length === 0, 'Fortune Tune: detaches a material instead of being destroyed');
  nextTurn(e);
  nextTurn(e);
  check(e.player(0).lp === 4500 && e.player(1).lp === 4000, "Fortune Tune: gains 500 LP only in its controller's Standby Phase");
  for (const n of ['Baby Dragon', 'Armored Zombie']) run(e, e.sendToGrave(grab(e, 0, n).uid, 'cost'));
  run(e, e.as(1, e.destroy([m.uid])), 'yes');
  check(zone(e, m) === 'fusion' && e.player(0).gy.every((c) => c.name !== 'Baby Dragon' && c.name !== 'Armored Zombie'), 'Fortune Tune: shuffles 2 Level 3s into the Deck and returns to the Extra Deck');
}
// Number 57: Tri-Head Dust Dragon: gains the target's ATK; locks a zone while the opponent has more cards.
{
  const e = duel([], [], ['Number 57: Tri-Head Dust Dragon']);
  toMain(e);
  place(e, 1, FILL);
  place(e, 1, FILL);
  const m = xyz(e, 0, 'Number 57: Tri-Head Dust Dragon', [FILL], 'yes');
  check(e.atkOf(m) === 1500, 'Tri-Head Dust Dragon: gains the ATK of the targeted monster (100 + 1400)');
  quick(e, 0, m);
  const ps1 = e.player(1);
  check(e.matsOf(m).length === 0 && ps1.mz[2] === null && e.freeZone(ps1, 'mz') === -1, "Tri-Head Dust Dragon: the opponent's empty Monster Zone cannot be used");
  run(e, e.as(1, e.destroy([m.uid])));
  check(e.freeZone(ps1, 'mz') === 2, 'Tri-Head Dust Dragon: the zone is free again once it leaves the field');
}
// Number 58: Burner Visor: equips itself to an Xyz Monster, which then attacks directly and burns for 500.
{
  const e = duel([], [], ['Number 58: Burner Visor', 'Number 103: Ragnazero'], [], 1);
  toMain(e);
  nextTurn(e);
  place(e, 1, FILL);
  const host = place(e, 0, 'Number 103: Ragnazero')!;
  const v = xyz(e, 0, 'Number 58: Burner Visor', [FILL]);
  effect(e, 0, v);
  const eq = e.fieldCard(v.uid);
  check(zone(e, v) === 'sz' && eq?.equippedTo === host.uid && host.equips.includes(v.uid), 'Burner Visor: equipped to the Xyz Monster');
  toBattle(e);
  const hand = e.player(0).hand.length;
  attack(e, host, null, 'yes');
  check(e.player(1).lp === 4000 - 2400 - 500 && e.player(0).hand.length === hand - 1, 'Burner Visor: the equipped monster attacks directly, then discard 1 for 500 damage');
}
// Number 5: Doom Chimera Dragon: 1000 ATK per material, attacks every opponent's monster, attaches from the GY after the Battle Phase.
{
  const e = duel([], [], ['Number 5: Doom Chimera Dragon'], [], 1);
  toMain(e);
  place(e, 1, FILL);
  place(e, 1, FILL);
  nextTurn(e);
  const m = xyz(e, 0, 'Number 5: Doom Chimera Dragon', [FILL, FILL]);
  check(e.atkOf(m) === 2000, 'Doom Chimera Dragon: gains 1000 ATK for each material');
  toBattle(e);
  const [a, b] = e.monsters(1);
  attack(e, m, a);
  attack(e, m, b);
  check(e.monsters(1).length === 0, "Doom Chimera Dragon: attacks each of the opponent's monsters");
  run(e, e.sendToGrave(e.player(0).deck[0].uid, 'cost'));
  e.apply({ type: 'NEXT_PHASE', player: 0 });
  settle(e, { pick: ['Attach 1 monster from your GY to it as material'] });
  check(e.matsOf(m).length === 3 && e.atkOf(m) === 3000, 'Doom Chimera Dragon: attaches a monster from the GY at the end of the Battle Phase');
}
// Number 62: Galaxy-Eyes Prime Photon Dragon: + combined Ranks x 200 in battle, halved damage without Galaxy-Eyes Photon Dragon.
{
  const e = duel([], [], ['Number 62: Galaxy-Eyes Prime Photon Dragon'], [], 1);
  toMain(e);
  place(e, 1, FILL);
  nextTurn(e);
  const m = xyz(e, 0, 'Number 62: Galaxy-Eyes Prime Photon Dragon', [FILL]);
  toBattle(e);
  attack(e, m, e.monsters(1)[0], { respond: 'Number 62' });
  check(e.player(1).lp === 4000 - Math.floor((4000 + 1600 - 1400) / 2), 'Galaxy-Eyes Prime Photon Dragon: gains Rank 8 x 200 ATK, battle damage halved');
  check(e.atkOf(m) === 4000 && e.matsOf(m).length === 0, 'Galaxy-Eyes Prime Photon Dragon: the ATK gain ends with the battle');
}
// Number 62: destroyed by the opponent's effect with Galaxy-Eyes Photon Dragon as material: back on the 2nd Standby Phase with double ATK.
{
  const e = duel([], [], ['Number 62: Galaxy-Eyes Prime Photon Dragon']);
  toMain(e);
  // Xyz Summoned with Galaxy-Eyes Photon Dragon (a stand-in card) among its materials.
  const c = e.player(0).fusion[0];
  const mat = { uid: e.state.uidCounter++, name: 'Galaxy-Eyes Photon Dragon', owner: 0 as Pid };
  run(e, e.specialSummon(c.uid, 0, 'atk', true, (fc) => ((fc.mats = [mat]), ((fc.tags ??= {}).xyzS = 1))));
  const m = e.fieldCard(c.uid)!;
  run(e, e.as(1, e.destroy([m.uid])));
  nextTurn(e);
  nextTurn(e);
  const early = zone(e, m);
  nextTurn(e);
  nextTurn(e, 'yes');
  const back = e.fieldCard(m.uid);
  check(early === 'gy' && !!back && e.atkOf(back) === 8000, 'Galaxy-Eyes Prime Photon Dragon: Special Summoned in the 2nd Standby Phase with doubled ATK');
}
// Number 8: Heraldic King Genom-Heritage: takes an opponent's Xyz Monster's name, ATK and effect; that monster drops to 0 ATK.
{
  const e = duel([], [], ['Number 8: Heraldic King Genom-Heritage'], ['Number 5: Doom Chimera Dragon']);
  toMain(e);
  const foe = xyz(e, 1, 'Number 5: Doom Chimera Dragon', [FILL, FILL]);
  const m = xyz(e, 0, 'Number 8: Heraldic King Genom-Heritage', [FILL]);
  quick(e, 0, m);
  check(e.atkOf(m) === 3000 && e.atkOf(foe) === 0, 'Genom-Heritage: ATK becomes 2000 plus the copied Doom Chimera effect (+1000), the target drops to 0');
  nextTurn(e);
  check(e.atkOf(m) === 2400, 'Genom-Heritage: the copy ends with the turn');
}
// Number C43: High Manipulator of Chaos: with Number 43, makes a Manipulator Token (ATK = half the opponent's LP) that attacks twice.
{
  const e = duel([], [], ['Number C43: High Manipulator of Chaos']);
  toMain(e);
  const m = xyz(e, 0, 'Number C43: High Manipulator of Chaos', ['Number 43: Manipulator of Souls', FILL]);
  quick(e, 0, m);
  const tok = e.monsters(0).find((x) => x.token);
  check(!!tok && e.atkOf(tok) === 2000 && e.defOf(tok) === 2000 && e.extraAttacks(tok) === 1, "C43: Manipulator Token with half the opponent's LP that can attack twice");
}
// Number C65: King Overfiend: with Number 65, -1000 ATK/DEF; the opponent's Effect Monsters cannot activate their effects.
{
  const e = duel(['Cyber Jar'], [], ['Number C65: King Overfiend']);
  toMain(e);
  const t = place(e, 1, FILL)!;
  const m = xyz(e, 0, 'Number C65: King Overfiend', ['Number 65: Djinn Buster', FILL]);
  quick(e, 0, m);
  check(e.atkOf(t) === 400 && e.defOf(t) === 200, 'C65: the target loses 1000 ATK and DEF');
  const jar = e.player(0).deck.find((c) => c.name === 'Cyber Jar')!;
  run(e, e.specialSummon(jar.uid, 1, 'atk'));
  check(e.monsterEffectsLocked(1, e.fieldCard(jar.uid)!) && !e.monsterEffectsLocked(0, m), "C65: the opponent's Effect Monsters cannot activate effects");
}
// Number C69: Heraldry Crest of Horror: when an opponent's monster attacks, destroy all cards they control.
{
  const e = duel([], [], ['Number C69: Heraldry Crest of Horror']);
  toMain(e);
  const m = xyz(e, 0, 'Number C69: Heraldry Crest of Horror', [FILL]);
  nextTurn(e);
  const a = place(e, 1, FILL)!;
  place(e, 1, FILL);
  toBattle(e);
  attack(e, a, m, { respond: 'Number C69' });
  check(e.monsters(1).length === 0, 'C69: destroys all cards the opponent controls');
}
// Number C73: Abyss Supra Splash: your battling monster gains the opponent's monster's ATK; with Number 73 it cannot be destroyed by effects.
{
  const e = duel([], ['Archfiend Soldier'], ['Number C73: Abyss Supra Splash'], [], 1);
  toMain(e);
  const foe = place(e, 1, 'Archfiend Soldier')!;
  nextTurn(e);
  const m = xyz(e, 0, 'Number C73: Abyss Supra Splash', ['Number 73: Abyss Splash', FILL]);
  const mine = place(e, 0, FILL)!;
  run(e, e.as(1, e.destroy([m.uid])));
  check(!!e.fieldCard(m.uid), 'C73: cannot be destroyed by card effects with Number 73 as material');
  toBattle(e);
  attack(e, mine, foe, { respond: 'Number C73' });
  check(!e.fieldCard(foe.uid) && e.player(1).lp === 4000 - 1400 && e.atkOf(mine) === 1400, "C73: the battling monster gains the opponent's ATK for that battle");
}
// One-Eyed Skill Gainer: takes an opponent's Xyz Monster's name and effect.
{
  const e = duel([], [], ['One-Eyed Skill Gainer'], ['Number 5: Doom Chimera Dragon']);
  toMain(e);
  xyz(e, 1, 'Number 5: Doom Chimera Dragon', [FILL, FILL]);
  const m = xyz(e, 0, 'One-Eyed Skill Gainer', [FILL, FILL]);
  quick(e, 0, m);
  check(e.matsOf(m).length === 1 && e.atkOf(m) === 3500 && !e.canUseQuickNow(0, m.uid), "One-Eyed Skill Gainer: gains Doom Chimera Dragon's effect (+1000 per material)");
}
// Orea, the Sylvan High Arbiter: excavate; a Plant goes to the GY and a card on the field returns to the hand.
{
  const e = duel(['Lekunga'], [], ['Orea, the Sylvan High Arbiter']);
  toMain(e);
  const t = place(e, 1, FILL)!;
  const ps = e.player(0);
  const plant = ps.deck.find((c) => c.name === 'Lekunga')!;
  ps.deck = [plant, ...ps.deck.filter((c) => c !== plant)];
  const m = xyz(e, 0, 'Orea, the Sylvan High Arbiter', [FILL]);
  quick(e, 0, m, { pick: ['1'] }, { pick: [FILL] });
  check(zone(e, plant) === 'gy' && zone(e, t) === 'hand' && !!e.fieldCard(m.uid), 'Orea: the excavated Plant goes to the GY and a card returns to the hand');
}
// Outer Entity Nyarla: Rank up by discards when Xyz Summoned; swaps its materials for a monster in the GY and takes its Type/Attribute.
{
  const e = duel(['Blue-Eyes White Dragon'], [], ['Outer Entity Nyarla']);
  toMain(e);
  place(e, 0, FILL);
  place(e, 0, FILL);
  const hand = e.player(0).hand.slice(0, 2).map((c) => c.name);
  const { fc } = proc(e, 0, 'Outer Entity Nyarla', 'yes', { pick: hand });
  check(!!fc && fc.tags?.rankUp === 2, 'Nyarla: Rank goes up by the number of discarded cards');
  const bewd = grab(e, 0, 'Blue-Eyes White Dragon');
  run(e, e.sendToGrave(bewd.uid, 'cost'));
  quick(e, 0, fc!, { pick: ['Blue-Eyes White Dragon'] });
  check(e.matsOf(fc!).length === 1 && e.matsOf(fc!)[0].name === 'Blue-Eyes White Dragon' && e.raceOf(fc!) === 'Dragon', 'Nyarla: detaches all, attaches the GY monster and becomes a Dragon');
}
// Princess Cologne: cannot be attacked while you control another monster; a Normal Monster destroyed brings another from the Deck.
{
  const e = duel([], [], ['Princess Cologne']);
  toMain(e);
  const n = place(e, 0, FILL)!;
  const m = xyz(e, 0, 'Princess Cologne', [FILL]);
  const a = place(e, 1, FILL)!;
  check(!e.legalTargets(1, a).some((x) => x.uid === m.uid), 'Princess Cologne: cannot be attacked while you control another monster');
  run(e, e.as(1, e.destroy([n.uid])), 'yes');
  check(e.matsOf(m).length === 0 && e.monsters(0).some((x) => x.name === FILL && x.pos === 'def'), 'Princess Cologne: Special Summons a Normal Monster in Defense Position');
}

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
