// Speed Duel card scripts, batch 22: cards from the 2024 products (Speed Duel GX: Midterm Destruction,
// Speed Duel Tournament Pack 7, Speed Duel: Battle City Finals) that were missing from the game.
import type { EffectDef } from '../effects';
import type { SpeedHelpers } from './helpers';
import {
  type Card,
  type Engine,
  type FieldCard,
  type Pid,
  type Step,
  allMonsters,
  allST,
  anyTime,
  boardCardsOn,
  chooseOption,
  discardCost,
  info,
  isMain,
  isMonster,
  isSpiritMessage,
  missingMessages,
  opponentAttack,
  other,
  pick,
  pickOne,
  placeSpiritMessage,
  stOf,
  tag,
  targetable,
} from './helpers';

type Fx = Record<string, unknown>;
const fxMap = <T>(e: Engine, key: string): Record<number, T> => ((e.state.fx as Fx)[key] ??= {}) as Record<number, T>;
const zoneOf = (e: Engine, uid: number) => e.find(uid)?.loc.zone;

/** Turns a face-up monster face-down in Defense Position (as Book of Moon does: its Equip Cards and the changes made to it end). */
function* turnFaceDown(e: Engine, m: FieldCard, p: Pid): Step {
  if (!m.faceUp || m.token) return;
  for (const u of m.equips.slice()) if (e.fieldCard(u)) yield* e.sendToGrave(u, 'destroyed');
  m.faceUp = false;
  m.pos = 'def';
  m.atkMod = 0;
  m.defMod = 0;
  const keep = ['ss', 'ssAt', 'ssFrom', 'ssExtra', 'fusS', 'noFlip', 'boundBy', 'shadowBy'];
  m.tags = Object.fromEntries(Object.entries(m.tags ?? {}).filter(([k]) => keep.includes(k)));
  e.event('position', { uid: m.uid });
  e.log(p, `${m.name} is turned face-down`);
}
/** Turns a face-down monster face-up in Defense Position; its FLIP effect activates. */
function* turnFaceUpDef(e: Engine, m: FieldCard): Step {
  if (m.faceUp) return;
  m.faceUp = true;
  m.pos = 'def';
  e.event('position', { uid: m.uid });
  e.log(null, `${m.name} is changed to face-up Defense Position`);
  const c = e.controller(m.uid);
  if (c !== null) yield* e.flipEffect(m.uid, c);
  if (c !== null && e.fieldCard(m.uid)) yield* e.positionWatch(m, c);
}

export function install(E: Record<string, EffectDef>, h: SpeedHelpers) {
  // ---------- Sakuretsu Armor ----------
  E['Sakuretsu Armor'] = {
    canActivate: (e, _c, p, t, ctx) => {
      const a = opponentAttack(e, p, t, ctx);
      const m = a !== null ? e.fieldCard(a) : null;
      return !!m && !e.untargetable(m);
    },
    *activate(e, link, p, ctx) {
      const a = opponentAttack(e, p, 'attack', ctx);
      if (a === null) return false;
      link.targetUid = a;
    },
    *resolve(e, link) {
      if (link.targetUid !== undefined && e.fieldCard(link.targetUid)) yield* e.destroy([link.targetUid]);
    },
  };

  // ---------- Sentence of Doom ----------
  // Both effects are ignition effects of the face-up Continuous Trap; "only 1 effect per turn, and only once that turn".
  const fiendsBack = (e: Engine, p: Pid) => [...e.player(p).gy, ...e.player(p).removed].filter((c) => isMonster(e, c) && info(e, c).race === 'Fiend');
  const doomCount = (e: Engine, p: Pid) => boardCardsOn(e, p).length;
  const doomMessages = (e: Engine, p: Pid) => {
    const missing = missingMessages(e, p);
    return [...e.player(p).hand, ...e.player(p).deck, ...e.player(p).gy].filter((c) => isSpiritMessage(e, c) && e.namesOf(c).some((n) => missing.includes(n)));
  };
  E['Sentence of Doom'] = {
    canActivate: (_e, _c, _p, t) => anyTime(t),
    *resolve() {},
    ignition: {
      repeat: true,
      chain: false,
      can: (e, m, p) => zoneOf(e, m.uid) === 'sz' && e.oncePerTurn('Sentence of Doom', p) && ((doomCount(e, p) > 0 && fiendsBack(e, p).length > 0) || doomMessages(e, p).length > 0),
      *run(e, m, p) {
        const canAdd = doomCount(e, p) > 0 && fiendsBack(e, p).length > 0;
        const canPlace = doomMessages(e, p).length > 0;
        const labels = [...(canAdd ? ['Add Fiend monsters from your GY / banishment to the hand'] : []), ...(canPlace ? ['Send it to the GY: place a "Spirit Message" card'] : [])];
        const i = yield* chooseOption(e, p, 'Sentence of Doom: use which effect?', labels, true);
        if (i === null) return;
        if (labels[i].startsWith('Add')) {
          const n = Math.min(doomCount(e, p), fiendsBack(e, p).length);
          const chosen = yield* pick(e, p, `Sentence of Doom: add up to ${n} Fiend monster${n > 1 ? 's' : ''} to the hand`, fiendsBack(e, p), 1, n, true);
          if (!chosen || !chosen.length) return;
          e.useOnce('Sentence of Doom', p);
          for (const c of chosen) {
            const z = zoneOf(e, c.uid);
            if (z !== 'gy' && z !== 'removed') continue;
            e.toHandOf(c.uid, p);
            e.log(p, `${e.player(p).name} adds ${c.name} to the hand`);
          }
          return;
        }
        // Cost: send this card from the Spell & Trap Zone to the GY. Then place 1 "Spirit Message" ("placed by Destiny Board").
        e.useOnce('Sentence of Doom', p);
        yield* e.sendToGrave(m.uid, 'cost');
        const c = yield* pickOne(e, p, 'Sentence of Doom: place which "Spirit Message" card?', doomMessages(e, p));
        if (c) yield* placeSpiritMessage(e, p, c.uid);
      },
    },
  };

  // ---------- Shadow Spell ----------
  // The bound monster is kept in this card's tags.shadowOn; when it leaves the field this card destroys itself (stateCheck).
  const shadowTargets = (e: Engine, p: Pid) => targetable(e, e.monsters(other(p)).filter((m) => m.faceUp));
  const shadowHost = (e: Engine, fc: FieldCard) => (fc.tags?.shadowOn !== undefined ? e.fieldCard(fc.tags.shadowOn) : null);
  E['Shadow Spell'] = {
    canActivate: (e, _c, p, t) => anyTime(t) && shadowTargets(e, p).length > 0,
    *activate(e, link, p) {
      const m = yield* pickOne(e, p, 'Shadow Spell: target which monster?', shadowTargets(e, p), true);
      if (!m) return false;
      link.targetUid = m.uid;
    },
    *resolve(e, link, p) {
      const fc = e.fieldCard(link.card.uid);
      const m = link.targetUid !== undefined ? e.fieldCard(link.targetUid) : null;
      if (!fc) return;
      if (!m || !m.faceUp || e.controller(m.uid) !== other(p)) {
        // No monster to keep under the spell: the card has nothing left to do.
        yield* e.sendToGrave(fc.uid, 'used');
        return;
      }
      tag(fc).shadowOn = m.uid;
      m.cannotChangePos = true;
      Object.assign(tag(m), { noFlip: 1, shadowBy: fc.uid });
      e.log(p, `${m.name} loses 700 ATK and cannot attack or change its battle position`);
    },
    aura: (e, src, target) => (src.tags?.shadowOn === target.uid && zoneOf(e, src.uid) === 'sz' ? { atk: -700, def: 0 } : undefined),
    blocksAttack: (_e, card, m) => card.tags?.shadowOn === m.uid,
    *stateCheck(e, fc) {
      if (fc.tags?.shadowOn === undefined || shadowHost(e, fc)) return;
      e.log(null, 'Shadow Spell is destroyed: its monster left the field');
      yield* e.destroy([fc.uid]);
    },
    *onLeaveField(e, fc) {
      const m = shadowHost(e, fc);
      if (!m || m.tags?.shadowBy !== fc.uid) return;
      delete m.tags.shadowBy;
      if (!m.tags.boundBy) {
        m.cannotChangePos = false;
        delete m.tags.noFlip;
      }
    },
  };

  // ---------- Shinato's Ark / Shinato, King of a Higher Plane ----------
  // The Ritual Spell (effects.ts ritualSpell) reads the monster and Level 8 from its text. Shinato is only Ritual Summoned
  // by Shinato's Ark the same way every Ritual Monster in the game is (it cannot be Normal Summoned; revivers skip Ritual Monsters).
  E["Shinato's Ark"] = h.ritualSpell();
  E['Shinato, King of a Higher Plane'] = {
    *afterBattle(e, _a, t, p, destroyed) {
      if (!destroyed || !t || t.pos !== 'def' || zoneOf(e, t.uid) !== 'gy') return;
      const atk = Math.max(0, info(e, t).atk ?? 0);
      if (!atk) return;
      e.log(p, `Shinato inflicts ${atk} damage (the destroyed monster's original ATK)`);
      e.damage(other(p), atk);
    },
  };

  // ---------- Snipe Hunter ----------
  // Discard 1 card (cost) and target 1 card on the field when it is activated; the die is rolled as it resolves.
  const snipeTargets = (e: Engine) => [...targetable(e, allMonsters(e)), ...allST(e)];
  E['Snipe Hunter'] = {
    ignition: {
      repeat: true,
      can: (e, _m, p) => e.player(p).hand.length > 0 && snipeTargets(e).length > 0,
      *cost(e, m, p, link) {
        if (!(yield* discardCost(e, p, 1))) return false;
        const t = yield* pickOne(e, p, 'Snipe Hunter: target which card?', snipeTargets(e));
        if (!t) return false;
        link.targetUid = t.uid;
        fxMap<number>(e, 'snipe')[m.uid] = t.uid;
      },
      *run(e, m, p) {
        const map = fxMap<number>(e, 'snipe');
        const t = map[m.uid];
        delete map[m.uid];
        if (t === undefined) return;
        const r = e.roll(6);
        e.log(p, `Snipe Hunter rolls a ${r}`);
        if (r === 1 || r === 6) return;
        if (e.fieldCard(t)) yield* e.destroy([t]);
      },
    },
  };

  // ---------- Sol and Luna ----------
  const solTargets = (e: Engine, p: Pid) => targetable(e, e.monsters(p)).filter((m) => !(m.token && m.faceUp));
  E['Sol and Luna'] = {
    canActivate: (e, _c, p, t) => (isMain(t) || anyTime(t)) && e.oncePerTurn('Sol and Luna', p) && solTargets(e, p).length > 0 && solTargets(e, other(p)).length > 0,
    *activate(e, link, p) {
      const mine = yield* pickOne(e, p, 'Sol and Luna: target 1 monster you control', solTargets(e, p), true);
      if (!mine) return false;
      const theirs = yield* pickOne(e, p, 'Sol and Luna: target 1 monster your opponent controls', solTargets(e, other(p)), true);
      if (!theirs) return false;
      e.useOnce('Sol and Luna', p);
      link.payload = { targets: [mine.uid, theirs.uid] };
    },
    *resolve(e, link, p) {
      const uids = (link.payload as { targets?: number[] } | undefined)?.targets ?? [];
      const ms = uids.map((u) => e.fieldCard(u)).filter((m): m is FieldCard => !!m && zoneOf(e, m.uid) === 'mz');
      const down = ms.filter((m) => m.faceUp);
      const up = ms.filter((m) => !m.faceUp);
      for (const m of down) yield* turnFaceDown(e, m, p);
      for (const m of up) if (e.fieldCard(m.uid)) yield* turnFaceUpDef(e, m);
    },
  };

  // ---------- Spirit Message "I" / "N" / "A" / "L" ----------
  // Scripted with Destiny Board (cards-04.ts): they leave together, they cannot be activated or Set (engine canSet),
  // and they only reach the field through placeSpiritMessage (helpers.ts).

  // ---------- Spirit Reaper ----------
  // "After resolving a card effect that targets this face-up card": the engine notes every resolved chain link whose
  // target (link.targetUid) is a face-up monster in fx.targetResolved; the state checks right after the action destroy it.
  E['Spirit Reaper'] = {
    battleProof: () => true,
    *stateCheck(e, m, p) {
      const tr = e.state.fx.targetResolved as Record<number, number> | undefined;
      if (!tr?.[m.uid] || !m.faceUp) return;
      delete tr[m.uid];
      e.log(p, 'Spirit Reaper is destroyed: a card effect targeted it');
      yield* e.destroy([m.uid]);
    },
    *onBattleDamage(e, _a, p) {
      if (e.state.battle?.target !== null) return;
      const hand = e.player(other(p)).hand;
      if (!hand.length) return;
      const c = hand[Math.floor(e.rand() * hand.length)];
      e.log(p, `Spirit Reaper: ${e.player(other(p)).name} discards a random card`);
      yield* e.discard(other(p), c.uid);
    },
  };

  // ---------- Spiritualism ----------
  // Not a target: the Spell/Trap is chosen as it resolves. payload.cannotNegate keeps the activation and effect from being negated (engine).
  E['Spiritualism'] = {
    canActivate: (e, _c, p, t) => isMain(t) && stOf(e, other(p)).length > 0,
    *activate(e, link) {
      link.payload = { cannotNegate: true };
    },
    *resolve(e, _l, p) {
      const c = yield* pickOne(e, p, 'Spiritualism: return which Spell/Trap to the hand?', stOf(e, other(p)) as Card[]);
      if (!c || !e.fieldCard(c.uid)) return;
      e.toHand(c.uid);
      e.log(p, `${c.name} returns to the hand`);
    },
  };
}
