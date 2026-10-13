// Speed Duel card scripts, batch 17: Xyz Monsters (Alsei ... Number 45: Crumble Logos). The generic procedure in
// extra.ts Xyz Summons them from their material line; the Full Armored monsters add an alternative Summon
// (extraProc) that uses an Xyz Monster you control. "Detach N" costs are paid as the effect is activated
// (ignition.cost / quick.cost) and mark the chain link with payload.detach.
// Engine hooks used (b17): ignition.cost, fc.tags.lastMats / fc.tags.leftBy (set when a monster leaves the field),
// fx.nameLocks (Engine.nameLocked) and Spell/Trap negation through tags.negated in liveST.
import type { EffectDef } from '../effects';
import type { SpeedHelpers } from './helpers';
import { builtinExtraProc } from './extra';
import { allMonsters, attrOf, chooseOption, ctrl, freeMZ, info, isSpell, named, negateMonster, other, pick, pickOne, raceOf, stOf, tag, targetable, levelOf } from './helpers';
import type { Card, ChainLink, Engine, FieldCard, Gen, Pid, Step } from './helpers';

// ---------- local helpers ----------
const matCount = (e: Engine, m: Card) => e.matsOf(m).length;
/** Marks a chain link as an effect activated by detaching Xyz Materials (Heraldry Record looks for it). */
const markDetach = (link: ChainLink) => {
  link.payload = { ...((link.payload as object | undefined) ?? {}), detach: true };
};
/** "Detach N material(s) from this card" as an activation cost. */
const detachCost = (n: number) =>
  function* (e: Engine, m: FieldCard, p: Pid, link: ChainLink): Gen<boolean> {
    if (!(yield* e.detachMats(m, n, p))) return false;
    markDetach(link);
    return true;
  };
/** Detaches right away, with no prompt (replacement effects asked from destroy()). */
function detachNow(e: Engine, m: FieldCard, n: number): boolean {
  const mats = m.mats ?? [];
  if (!n || mats.length < n) return false;
  const gone = mats.slice(0, n);
  m.mats = mats.slice(n);
  for (const c of gone) e.player(c.owner).gy.push(c);
  ((e.state.fx.detached ??= {}) as Record<number, number>)[m.uid] = e.state.turn;
  e.log(ctrl(e, m), `${m.name} detaches ${gone.map((c) => c.name).join(', ')} instead of being destroyed`);
  return true;
}
/** Every card on the field (monsters, Spells/Traps, Field Spells). */
const fieldCards = (e: Engine): FieldCard[] => [...allMonsters(e), ...stOf(e, 0), ...stOf(e, 1)];
const isSkill = (e: Engine, c: Card) => info(e, c).sub === 'Skill';
/** Moves a card off the field to its owner's hand (Tokens vanish). */
function* bounceCard(e: Engine, c: FieldCard): Step {
  if (c.token) yield* e.sendToGrave(c.uid, 'used');
  else e.toHand(c.uid);
}
/** Sends a face-up monster face-down in Defense Position (its equips are destroyed, its changes reset; Xyz Materials stay). */
function* setFaceDown(e: Engine, m: FieldCard): Step {
  for (const u of m.equips.slice()) if (e.fieldCard(u)) yield* e.sendToGrave(u, 'destroyed');
  m.faceUp = false;
  m.pos = 'def';
  m.atkMod = 0;
  m.defMod = 0;
  m.tags = m.tags?.ssAt !== undefined ? { ssAt: m.tags.ssAt } : {};
  e.event('position', { uid: m.uid, player: e.controller(m.uid) ?? m.owner });
  e.log(null, `${m.name} is changed to face-down Defense Position`);
}
/** "You can also Xyz Summon this card by using <an Xyz Monster you control> as the Xyz Material" (its materials go along). */
function altXyz(test: (e: Engine, m: FieldCard, card: Card) => boolean): NonNullable<EffectDef['extraProc']> {
  const alts = (e: Engine, card: Card, p: Pid) => e.monsters(p).filter((m) => m.faceUp && info(e, m).sub === 'Xyz' && test(e, m, card));
  return {
    can: (e, card, p) => !!builtinExtraProc(e, card.name)?.can(e, card, p) || alts(e, card, p).length > 0,
    *run(e, card, p) {
      const normal = builtinExtraProc(e, card.name);
      const list = alts(e, card, p);
      let useAlt = list.length > 0;
      if (normal?.can(e, card, p) && list.length) {
        const i = yield* chooseOption(e, p, `Xyz Summon ${card.name} using:`, ['Its Xyz Materials', 'An Xyz Monster you control'], true);
        if (i === null) return;
        useAlt = i === 1;
      }
      if (!useAlt) {
        if (normal) yield* normal.run(e, card, p);
        return;
      }
      const old = yield* pickOne(e, p, `Xyz Summon ${card.name} using which Xyz Monster?`, list, true);
      if (!old) return;
      yield* e.extraSummon(p, card.uid, [old.uid], 'Xyz');
    },
  };
}
const rank = (e: Engine, m: Card) => info(e, m).rank ?? 0;

export function install(E: Record<string, EffectDef>, _h: SpeedHelpers) {
  // ---------- Alsei, the Sylvan High Protector ----------
  E['Alsei, the Sylvan High Protector'] = {
    ignition: {
      can: (e, _m, p) => e.player(p).deck.length > 0,
      *run(e, _m, p) {
        const ps = e.player(p);
        if (!ps.deck.length) return;
        const names = [...new Set(ps.deck.map((c) => c.name))].sort();
        const i = yield* chooseOption(e, p, 'Declare 1 card name', names);
        const name = names[i ?? 0];
        e.log(p, `${ps.name} declares ${name}`);
        const top = ps.deck[0];
        if (!top) return;
        e.log(p, `${ps.name} excavates ${top.name}`);
        if (top.name === name) {
          e.toHandOf(top.uid, p);
          e.log(p, `${top.name} is added to the hand`);
        } else yield* e.sendToGrave(top.uid, 'mill');
      },
    },
    // "If a card is sent from your Deck to the GY by a card effect: detach 1, then target 1 card on the field; place it on the top or bottom of the Deck."
    *onGraveEvents(e, m, p, events) {
      if (!events.some((ev) => ev.from === 'deck' && ev.card.owner === p && ev.by !== null)) return;
      const key = 'Alsei, the Sylvan High Protector:2';
      if (e.state.battle || !e.oncePerTurn(key, p) || matCount(e, m) < 1) return;
      const targets = fieldCards(e).filter((c) => !isSkill(e, c) && !(c.faceUp && info(e, c).kind === 'monster' && e.untargetable(c)));
      if (!targets.length || !(yield* e.yesno(p, 'Alsei: detach 1 material to return 1 card on the field to the Deck?'))) return;
      e.useOnce(key, p);
      if (!(yield* e.detachMats(m, 1, p))) return;
      const t = yield* pickOne(e, p, 'Place which card on the top or bottom of the Deck?', targets.filter((c) => e.fieldCard(c.uid)));
      if (!t || !e.fieldCard(t.uid)) return;
      const where = (yield* chooseOption(e, p, `Place ${t.faceUp ? t.name : 'the card'} on the`, ['Top of the Deck', 'Bottom of the Deck'])) ?? 0;
      if (t.token) return void (yield* e.sendToGrave(t.uid, 'used'));
      e.toDeckTop(t.uid);
      const deck = e.player(t.owner).deck;
      if (where === 1 && deck[0]?.uid === t.uid) deck.push(deck.shift()!);
      e.log(p, `${t.faceUp ? t.name : 'A card'} is placed on the ${where === 1 ? 'bottom' : 'top'} of the Deck`);
    },
  };

  // ---------- Bujintei Tsukuyomi ----------
  const bujinTargets = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => named(c, 'Bujin') && info(e, c).kind === 'monster' && levelOf(e, c) === 4 && raceOf(e, c) === 'Beast-Warrior');
  E['Bujintei Tsukuyomi'] = {
    ignition: {
      can: (e, m, p) => matCount(e, m) >= 1 && e.player(p).hand.length >= 1,
      cost: detachCost(1),
      *run(e, _m, p) {
        const hand = e.player(p).hand.slice();
        if (!hand.length) return;
        yield* e.together(
          (function* () {
            for (const c of hand) yield* e.sendToGrave(c.uid, 'used');
          })(),
        );
        e.log(p, `${e.player(p).name} sends the hand to the Graveyard`);
        if (hand.every((c) => e.find(c.uid)?.loc.zone !== 'hand')) e.draw(p, 2);
      },
    },
    *onLeaveField(e, fc, controller) {
      const n = fc.tags?.lastMats ?? 0;
      if (!fc.faceUp || fc.tags?.leftBy !== other(controller) || n < 1) return;
      const zones = e.player(controller).mz.filter((z) => z === null).length;
      const list = bujinTargets(e, controller);
      if (!list.length || !zones) return;
      yield* e.as(
        controller,
        (function* () {
          if (!(yield* e.yesno(controller, 'Bujintei Tsukuyomi: Special Summon "Bujin" monsters from your GY?'))) return;
          const picks = yield* pick(e, controller, `Special Summon up to ${Math.min(n, zones)} "Bujin" monsters`, list, 1, Math.min(n, zones, list.length));
          for (const c of picks ?? []) if (e.find(c.uid)?.loc.zone === 'gy') yield* e.specialSummon(c.uid, controller, 'atk');
        })(),
      );
    },
    // "You can only control 1 Bujintei Tsukuyomi."
    selfSummonBlock: (e, card, p) => e.monsters(p).some((m) => m.faceUp && m.name === card.name),
  };

  // ---------- Downerd Magician ----------
  // Its alternative Summon needs Main Phase 2, which Speed Duel does not have: only the normal Xyz Summon applies.
  const detachAfterBattle = function* (e: Engine, m: FieldCard, p: Pid): Step {
    if (e.fieldCard(m.uid) && matCount(e, m) > 0) yield* e.detachMats(m, 1, p);
  };
  E['Downerd Magician'] = {
    selfBonus: (e, m) => ({ atk: 200 * matCount(e, m), def: 0 }),
    piercing: true,
    afterBattle: (e, m, _t, p) => detachAfterBattle(e, m, p),
    *onAttacked(e, m, _a, p, destroyed) {
      if (!destroyed) yield* detachAfterBattle(e, m, p);
    },
  };

  // ---------- Fairy Knight Ingunar ----------
  E['Fairy Knight Ingunar'] = {
    ignition: {
      // "Your opponent cannot activate cards or effects in response to this effect's activation."
      chain: false,
      can: (e, m) => matCount(e, m) >= 2 && fieldCards(e).some((c) => c.uid !== m.uid && !isSkill(e, c)),
      cost: detachCost(2),
      *run(e, m, p) {
        const list = fieldCards(e).filter((c) => c.uid !== m.uid && !isSkill(e, c));
        e.log(p, 'Fairy Knight Ingunar returns all other cards on the field to the hand');
        for (const c of list) if (e.fieldCard(c.uid)) yield* bounceCard(e, c);
      },
    },
  };

  // ---------- Full Armored Black Ray Lancer ----------
  E['Full Armored Black Ray Lancer'] = {
    extraProc: altXyz((e, m) => rank(e, m) === 3 && attrOf(e, m) === 'WATER' && matCount(e, m) === 0),
    selfBonus: (e, m) => ({ atk: 200 * matCount(e, m), def: 0 }),
    // "If this face-up card would be destroyed, you can detach all of its Xyz Materials instead" (always used).
    battleProof: (e, m) => detachNow(e, m, matCount(e, m)),
    effectProof: (e, m) => detachNow(e, m, matCount(e, m)),
    // "If this card destroys an opponent's monster by battle: destroy 1 Spell/Trap your opponent controls."
    *afterBattle(e, _m, _target, p, destroyed) {
      if (!destroyed) return;
      const sts = stOf(e, other(p));
      if (!sts.length || !(yield* e.yesno(p, 'Full Armored Black Ray Lancer: destroy 1 Spell/Trap your opponent controls?'))) return;
      const t = yield* pickOne(e, p, 'Destroy which Spell/Trap?', sts);
      if (t && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
    },
  };

  // ---------- Full Armored Crystalzero Lancer ----------
  E['Full Armored Crystalzero Lancer'] = {
    extraProc: altXyz((e, m) => rank(e, m) === 5 && attrOf(e, m) === 'WATER'),
    selfBonus: (e, m) => ({ atk: 500 * matCount(e, m), def: 0 }),
    // "If this face-up card would be destroyed, you can detach 1 Xyz Material from this card instead" (always used).
    battleProof: (e, m) => detachNow(e, m, 1),
    effectProof: (e, m) => detachNow(e, m, 1),
    ignition: {
      can: (e, m, p) => matCount(e, m) >= 1 && e.monsters(other(p)).some((x) => x.faceUp),
      cost: detachCost(1),
      *run(e, _m, p) {
        for (const x of e.monsters(other(p))) if (x.faceUp) negateMonster(e, x);
      },
    },
  };

  // ---------- Galaxy-Eyes Cipher Dragon ----------
  const cipherTargets = (e: Engine, p: Pid) => targetable(e, e.monsters(other(p)).filter((x) => x.faceUp));
  E['Galaxy-Eyes Cipher Dragon'] = {
    ignition: {
      can: (e, m, p) => matCount(e, m) >= 1 && freeMZ(e, p) && cipherTargets(e, p).length > 0,
      cost: detachCost(1),
      *run(e, m, p) {
        for (const x of e.monsters(p)) if (x.uid !== m.uid) tag(x).noDirectTurn = e.state.turn;
        const t = yield* pickOne(e, p, 'Take control of which monster?', cipherTargets(e, p));
        if (!t || !e.fieldCard(t.uid) || !e.takeControl(t.uid, p)) return;
        t.returnAtEnd = other(p);
        tag(t).noDirectTurn = e.state.turn;
        tag(t).negatedTurn = e.state.turn;
        t.atkMod += 3000 - e.atkOf(t);
        e.log(p, `${e.player(p).name} takes control of ${t.name} until the End Phase (effects negated, ATK 3000)`);
      },
    },
  };

  // ---------- Galaxy-Eyes Full Armor Photon Dragon ----------
  const GEFA = 'Galaxy-Eyes Full Armor Photon Dragon';
  const gefaEquips = (e: Engine, m: FieldCard) => m.equips.map((u) => e.fieldCard(u)).filter((c): c is FieldCard => !!c);
  const gefaFoes = (e: Engine, p: Pid) => [...targetable(e, e.monsters(other(p)).filter((x) => x.faceUp)), ...stOf(e, other(p)).filter((c) => c.faceUp)];
  const gefaModes = (e: Engine, m: FieldCard, p: Pid) => {
    const out: number[] = [];
    if (e.oncePerTurn(`${GEFA}:${m.uid}:1`, p) && gefaEquips(e, m).length) out.push(0);
    if (e.oncePerTurn(`${GEFA}:${m.uid}:2`, p) && matCount(e, m) >= 1 && gefaFoes(e, p).length) out.push(1);
    return out;
  };
  E[GEFA] = {
    extraProc: altXyz((e, m) => named(m, 'Galaxy-Eyes') && m.name !== GEFA),
    ignition: {
      repeat: true,
      can: (e, m, p) => gefaModes(e, m, p).length > 0,
      *cost(e, m, p, link) {
        const modes = gefaModes(e, m, p);
        const labels = ['Attach Equip Cards equipped to it as material', 'Detach 1 material: destroy 1 face-up card'];
        const i = modes.length > 1 ? yield* chooseOption(e, p, `${GEFA}: which effect?`, modes.map((k) => labels[k]), true) : 0;
        if (i === null) return false;
        const mode = modes[i];
        if (mode === 1) {
          if (!(yield* e.detachMats(m, 1, p))) return false;
          markDetach(link);
        }
        e.useOnce(`${GEFA}:${m.uid}:${mode + 1}`, p);
        tag(m).b17Mode = mode;
      },
      *run(e, m, p) {
        if (tag(m).b17Mode === 0) {
          const eqs = gefaEquips(e, m);
          const picks = yield* pick(e, p, 'Attach which Equip Cards (up to 2)?', eqs, 1, Math.min(2, eqs.length));
          for (const c of picks ?? []) if (e.fieldCard(c.uid) && e.attachMat(m, c.uid)) e.log(p, `${c.name} is attached to ${m.name} as material`);
          return;
        }
        const t = yield* pickOne(e, p, 'Destroy which face-up card?', gefaFoes(e, p));
        if (t && e.fieldCard(t.uid)) yield* e.destroy([t.uid]);
      },
    },
  };

  // ---------- Heroic Champion - Excalibur ----------
  E['Heroic Champion - Excalibur'] = {
    ignition: {
      can: (e, m) => matCount(e, m) >= 2,
      cost: detachCost(2),
      *run(e, m, p) {
        // Until the opponent's next End Phase (it is always this player's turn: an ignition effect).
        tag(m).b17Excal = e.state.turnPlayer === p ? e.state.turn + 1 : e.state.turn;
        e.log(p, `${m.name}'s ATK becomes ${2 * (info(e, m).atk ?? 0)}`);
      },
    },
    selfBonus: (e, m) => ({ atk: (m.tags?.b17Excal ?? -1) >= e.state.turn ? e.baseStats(m).atk : 0, def: 0 }),
  };

  // ---------- Hierophant of Prophecy ----------
  const spellbooks = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => named(c, 'Spellbook') && isSpell(e, c)).length;
  E['Hierophant of Prophecy'] = {
    ignition: {
      can: (e, m, p) => matCount(e, m) >= 1 && spellbooks(e, p) > 0 && stOf(e, other(p)).length > 0,
      cost: detachCost(1),
      *run(e, _m, p) {
        const sts = stOf(e, other(p));
        const n = Math.min(spellbooks(e, p), sts.length);
        if (!n) return;
        const picks = yield* pick(e, p, `Destroy up to ${n} Spell/Trap Card(s)`, sts, 1, n);
        if (picks?.length) yield* e.destroy(picks.map((c) => c.uid));
      },
    },
  };

  // ---------- Number 103: Ragnazero ----------
  const ragnaTargets = (e: Engine, p: Pid) => targetable(e, e.monsters(other(p)).filter((x) => x.faceUp && x.pos === 'atk' && e.atkOf(x) !== e.baseStats(x).atk));
  E['Number 103: Ragnazero'] = {
    quick: {
      label: 'detach 1: destroy a monster whose ATK changed',
      can: (e, c, p) => matCount(e, c) >= 1 && ragnaTargets(e, p).length > 0,
      *cost(e, c, p, link) {
        const t = yield* pickOne(e, p, 'Destroy which monster (ATK changed)?', ragnaTargets(e, p), true);
        if (!t) return false;
        if (!(yield* e.detachMats(c as FieldCard, 1, p))) return false;
        markDetach(link);
        link.targetUid = t.uid;
      },
      *run(e, _c, p, link) {
        const t = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
        if (!t || e.controller(t.uid) !== other(p) || !t.faceUp || t.pos !== 'atk' || e.atkOf(t) === e.baseStats(t).atk) return;
        yield* e.destroy([t.uid]);
        if (!e.fieldCard(t.uid)) e.draw(p, 1);
      },
    },
  };

  // ---------- Number 24: Dragulas the Vampiric Dragon ----------
  const dragulasTargets = (e: Engine) => targetable(e, allMonsters(e).filter((x) => x.faceUp && x.tags?.ssExtra === 1));
  E['Number 24: Dragulas the Vampiric Dragon'] = {
    quick: {
      label: 'detach 1: change a monster from the Extra Deck to face-down',
      can: (e, c) => matCount(e, c) >= 1 && dragulasTargets(e).length > 0,
      *cost(e, c, p, link) {
        const t = yield* pickOne(e, p, 'Change which monster to face-down Defense Position?', dragulasTargets(e), true);
        if (!t) return false;
        if (!(yield* e.detachMats(c as FieldCard, 1, p))) return false;
        markDetach(link);
        link.targetUid = t.uid;
      },
      *run(e, _c, _p, link) {
        const t = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
        if (t && t.faceUp && !t.token) yield* setFaceDown(e, t);
      },
    },
    *onLeaveField(e, fc, controller) {
      if (!fc.faceUp || fc.owner !== controller || fc.tags?.leftBy !== other(controller)) return;
      const z = e.find(fc.uid)?.loc;
      if (!z || z.player !== controller || (z.zone !== 'gy' && z.zone !== 'removed') || !freeMZ(e, controller)) return;
      yield* e.as(
        controller,
        (function* () {
          if (!(yield* e.yesno(controller, 'Number 24: Special Summon it in face-down Defense Position?'))) return;
          yield* e.specialSummon(fc.uid, controller, 'def', false);
        })(),
      );
    },
    // "If this card is flipped face-up: Send 1 card on the field to the GY."
    *flip(e, _m, p) {
      const list = fieldCards(e).filter((c) => !isSkill(e, c));
      const t = yield* pickOne(e, p, 'Send which card on the field to the Graveyard?', list);
      if (t && e.fieldCard(t.uid)) yield* e.sendToGrave(t.uid, 'used');
    },
  };

  // ---------- Number 40: Gimmick Puppet of Strings ----------
  E['Number 40: Gimmick Puppet of Strings'] = {
    ignition: {
      can: (e, m) => matCount(e, m) >= 1 && allMonsters(e).some((x) => x.faceUp && x.uid !== m.uid),
      cost: detachCost(1),
      *run(e, m, p) {
        for (const x of allMonsters(e)) if (x.faceUp && x.uid !== m.uid) tag(x).b17String = 1;
        Object.assign(tag(m), { b17StringBy: p, b17StringTurn: e.state.turn });
        e.log(p, 'A String Counter is placed on each other face-up monster');
      },
    },
    *onEndPhase(e, m, p) {
      const t = m.tags;
      if (t?.b17StringBy !== p || e.state.turnPlayer !== other(p) || e.state.turn <= (t.b17StringTurn ?? 0)) return;
      t.b17StringBy = -1;
      const list = allMonsters(e).filter((x) => x.tags?.b17String === 1);
      if (!list.length) return;
      e.log(p, 'Number 40: the monsters with String Counters are destroyed');
      yield* e.destroy(list.map((x) => x.uid));
      const n = list.filter((x) => !e.fieldCard(x.uid)).length;
      if (n) e.damage(other(p), 500 * n);
    },
  };

  // ---------- Number 45: Crumble Logos the Prophet of Demolition ----------
  const LOGOS = 'Number 45: Crumble Logos the Prophet of Demolition';
  const logosTargets = (e: Engine, m: FieldCard) => fieldCards(e).filter((c) => c.uid !== m.uid && c.faceUp && !isSkill(e, c) && !(info(e, c).kind === 'monster' && e.untargetable(c)));
  E[LOGOS] = {
    ignition: {
      can: (e, m) => matCount(e, m) >= 1 && logosTargets(e, m).length > 0,
      cost: detachCost(1),
      *run(e, m, p) {
        const t = yield* pickOne(e, p, 'Negate which face-up card?', logosTargets(e, m));
        if (!t || !e.fieldCard(t.uid)) return;
        if (e.fieldCard(m.uid)?.faceUp) Object.assign(tag(t), { negated: 1, b17Logos: m.uid });
        ((e.state.fx.nameLocks ??= []) as { name: string; src: number }[]).push({ name: t.name, src: t.uid });
        e.log(p, `${t.name} has its effects negated; cards named ${t.name} cannot be activated while it is on the field`);
      },
    },
    // The negation lasts only while this monster is face-up on the field.
    *onLeaveField(e, fc) {
      for (const c of fieldCards(e)) if (c.tags?.b17Logos === fc.uid) (delete c.tags.negated, delete c.tags.b17Logos);
    },
  };
}
