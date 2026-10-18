// Speed Duel Skills from the 2024 products (part a): scripts added to the shared Skill table.
// Speed Duel: Battle City Finals. installSkills runs at the end of skills.ts, so the helpers imported from it are
// defined by then (they are only used inside Skill hooks, never at module top level).
import type { SkillDef } from '../skills';
import type { Choice, Engine, Step } from '../engine';
import type { Card, FieldCard, Pid, Prompt } from '../types';
import type { EffectDef } from '../effects';
import { affectable, changePos, chooseOption, discardOne, fusionPlans, fusionSummon, handField, pick, pickOne, reorder, ssOne, toHandFrom } from './skills';

// ---------- local basics (copies of the skills.ts ones) ----------
const other = (p: Pid): Pid => (p === 0 ? 1 : 0);
const info = (e: Engine, c: Card | string) => e.info(typeof c === 'string' ? c : c.name);
const mon = (e: Engine, c: Card) => info(e, c).kind === 'monster';
const isSpell = (e: Engine, c: Card) => info(e, c).kind === 'spell';
const levelOf = (e: Engine, c: Card) => info(e, c).level ?? 0;
const attrOf = (e: Engine, c: Card) => info(e, c).attribute ?? '';
const race = (e: Engine, c: Card) => ('faceUp' in c ? e.raceOf(c) : info(e, c).race ?? '');
const origAtk = (e: Engine, c: Card) => Math.max(0, info(e, c).atk ?? 0);
const origDef = (e: Engine, c: Card) => Math.max(0, info(e, c).def ?? 0);
const tag = (m: FieldCard) => (m.tags ??= {});
function boostPerm(m: FieldCard, atk: number, def = 0) {
  const t = tag(m);
  t.permAtk = (t.permAtk ?? 0) + atk;
  t.permDef = (t.permDef ?? 0) + def;
}
const S = (e: Engine) => (e.state.fx.skillData ??= {}) as Record<string, number>;
const getN = (e: Engine, p: Pid, k: string) => S(e)[`${p}|${k}`] ?? 0;
const setN = (e: Engine, p: Pid, k: string, v: number) => (S(e)[`${p}|${k}`] = v);
const isTurn = (e: Engine, p: Pid, k: string) => getN(e, p, k) === e.state.turn && e.state.turn > 0;
const opd = (e: Engine, p: Pid, k: string) => e.oncePerDuel(`skill:${k}`, p);
const useOpd = (e: Engine, p: Pid, k: string) => e.useOncePerDuel(`skill:${k}`, p);
const reveal = (e: Engine, p: Pid) => void (e.player(p).skillRevealed = true);
const ctlOf = (e: Engine, m: Card) => e.controller(m.uid);
const freeMZ = (e: Engine, p: Pid) => e.freeMonsterZone(p) >= 0;
const faceUp = (e: Engine, p: Pid, test: (m: FieldCard) => boolean = () => true) => e.monsters(p).filter((m) => m.faceUp && test(m));
const inHand = (e: Engine, p: Pid, test: (c: Card) => boolean) => e.player(p).hand.filter(test);
const inDeck = (e: Engine, p: Pid, test: (c: Card) => boolean) => e.player(p).deck.filter(test);
const inGY = (e: Engine, p: Pid, test: (c: Card) => boolean) => e.player(p).gy.filter(test);
const stOf = (e: Engine, p: Pid) => [...e.spells(p), ...(e.player(p).field ? [e.player(p).field!] : [])];
/** Cards a player controls (Monster, Spell & Trap and Field Zones). */
const cardsOn = (e: Engine, p: Pid) => e.monsters(p).length + stOf(e, p).length;
/** "Original name": the printed name (and the names its text always gives it), not a name an effect gave it. */
const origNamed = (e: Engine, c: Card, n: string) => e.isNamed(c.name, n);
/** A card's text mentions this card name ("... "Dark Magician" ..."). */
const mentions = (e: Engine, c: Card, n: string) => info(e, c).desc.includes(`"${n}"`);
type EffectDefLite = NonNullable<SkillDef['eff']>;
/** The monsters of a battle in progress. */
const battling = (e: Engine) => {
  const b = e.state.battle;
  return b ? { a: e.fieldCard(b.attacker), t: b.target !== null ? e.fieldCard(b.target) : null } : null;
};
/** "Spirit" monsters, by their text (they return to the hand in the End Phase of the turn they are Normal Summoned or flipped face-up). */
const isSpirit = (e: Engine, c: Card) => mon(e, c) && /Normal Summoned or flipped face-up/.test(info(e, c).desc) && /hand/.test(info(e, c).desc);
/** Cards whose effect rolls a die. */
const isDiceCard = (e: Engine, c: Card) => /six-sided die|\broll(s)? (a|the) d(ie|ice)\b/i.test(info(e, c).desc);

/** Puts a card from the hand (or GY) on the bottom of its owner's Deck. */
function toBottom(e: Engine, c: Card) {
  e.toDeckTop(c.uid);
  const d = e.player(c.owner).deck;
  if (d[0]?.uid === c.uid) d.push(d.shift()!);
}
/** Puts several cards on the bottom of the Deck in the order the player picks. */
function* toBottomInOrder(e: Engine, p: Pid, cards: Card[]): Step {
  for (const c of cards) e.toDeckTop(c.uid);
  const placed = cards.filter((c) => e.player(c.owner).deck.some((d) => d.uid === c.uid));
  if (placed.length) yield* reorder(e, p, placed[0].owner, placed, 'bottom');
}
/** "... then place 1 card from your hand on the bottom of the Deck." */
function* handToBottom(e: Engine, p: Pid, label: string): Step {
  const c = yield* pickOne(e, p, `${label}: place which card from your hand on the bottom of the Deck?`, e.player(p).hand);
  if (c) {
    toBottom(e, c);
    e.log(p, `${e.player(p).name} places a card from the hand on the bottom of the Deck`);
  }
}

/**
 * The "Battle City Finals" shape: "Once per turn, during your Main Phase, you can activate 1 of these Skills:
 * ● Reveal [cards] in your hand, place them on the bottom of the Deck, then draw [as many] cards.
 * ● Once per Duel, discard 1 card, then add 1 [card] from your Deck to your hand."
 */
function revealOrSearch(o: {
  key: string;
  label: string;
  /** One test per card to reveal (all of them together). */
  revealTests: ((e: Engine, c: Card) => boolean)[];
  revealWhat: string;
  search: (e: Engine, c: Card) => boolean;
  searchWhat: string;
  /** After the search resolved (Battle City Slugger's extra Tribute Summon). */
  after?: (e: Engine, p: Pid) => void;
}): NonNullable<SkillDef['use']> {
  const n = o.revealTests.length;
  /** Cards that can fill each reveal slot (distinct cards). */
  const revealSets = (e: Engine, p: Pid): Card[][] | null => {
    const hand = e.player(p).hand;
    const slots = o.revealTests.map((t) => hand.filter((c) => t(e, c)));
    if (slots.some((s) => !s.length)) return null;
    if (n === 2 && !slots[0].some((a) => slots[1].some((b) => b.uid !== a.uid))) return null;
    return slots;
  };
  const canA = (e: Engine, p: Pid) => !!revealSets(e, p) && e.player(p).deck.length >= n;
  const canB = (e: Engine, p: Pid) => opd(e, p, o.key) && e.player(p).hand.length > 0 && inDeck(e, p, (c) => o.search(e, c)).length > 0;
  return {
    phase: 'main',
    oncePerDuel: false,
    can: (e, p) => canA(e, p) || canB(e, p),
    *run(e, p) {
      const a = canA(e, p);
      const b = canB(e, p);
      const k = a && b ? yield* chooseOption(e, p, `${o.label}: which Skill?`, [`Reveal ${o.revealWhat}, place on the bottom of the Deck, draw ${n}`, `Discard 1 card, add ${o.searchWhat} from your Deck`]) : a ? 0 : 1;
      if (k === 0) {
        const slots = revealSets(e, p)!;
        const chosen: Card[] = [];
        for (const s of slots) {
          const c = yield* pickOne(e, p, `${o.label}: reveal which card?`, s.filter((x) => !chosen.includes(x)));
          if (!c) return;
          chosen.push(c);
        }
        yield* e.reveal(other(p), 'Your opponent reveals', chosen);
        if (chosen.length === 1) toBottom(e, chosen[0]);
        else yield* toBottomInOrder(e, p, chosen);
        e.log(p, `${e.player(p).name} places ${chosen.map((c) => c.name).join(' and ')} on the bottom of the Deck`);
        e.draw(p, n);
      } else if (k === 1) {
        useOpd(e, p, o.key);
        if (!(yield* discardOne(e, p, `${o.label}: discard 1 card`, e.player(p).hand))) return;
        const got = yield* toHandFrom(e, p, `${o.label}: add ${o.searchWhat} from your Deck to your hand`, inDeck(e, p, (c) => o.search(e, c)), true);
        if (got) o.after?.(e, p);
      }
    },
  };
}
const named = (n: string) => (e: Engine, c: Card) => e.isNamed(c, n);

/** Divine-Beast-style "attack every monster your opponent controls, once each" bookkeeping (like Here Goes Something!). */
function attackAll(test: (e: Engine, m: FieldCard) => boolean): Pick<SkillDef, 'onAttack' | 'extraAttacks'> & { eff: Partial<EffectDefLite> } {
  const hits = (e: Engine, m: FieldCard): number[] => {
    const all = (e.state.fx.attackAllHits ??= {}) as Record<number, { turn: number; list: number[] }>;
    if (all[m.uid]?.turn !== e.state.turn) all[m.uid] = { turn: e.state.turn, list: [] };
    return all[m.uid].list;
  };
  return {
    eff: { attackGuard: (e, _src, ctl, attacker, target) => ctlOf(e, attacker) === ctl && test(e, attacker) && hits(e, attacker).includes(target.uid) },
    *onAttack(e, p, attacker, target) {
      if (target && ctlOf(e, attacker) === p && test(e, attacker)) hits(e, attacker).push(target.uid);
    },
    extraAttacks(e, p, m) {
      if (!test(e, m) || ctlOf(e, m) !== p) return 0;
      const left = e.monsters(other(p)).filter((t) => !hits(e, m).includes(t.uid)).length;
      const made = m.attacked ? m.tags?.attacksMade ?? 1 : 0;
      return Math.max(0, made + left - 1);
    },
  };
}

export function installSkills(K: Record<string, SkillDef>) {
  // ----- Sky God Revelation -----
  K['Sky God Revelation'] = {
    *startOfDuel() {},
    eff: {
      // "When a Level 10 monster with ? ATK is Normal Summoned to your field, each player can draw until they have 6 cards in their hand."
      *onAnySummon(e, _c, ctl, m, mctl, kind) {
        if (kind !== 'normal' || mctl !== ctl || levelOf(e, m) !== 10 || (info(e, m).atk ?? 0) >= 0) return;
        for (const q of [ctl, other(ctl)]) {
          const n = 6 - e.player(q).hand.length;
          if (n > 0 && e.state.winner === null && (yield* e.yesno(q, `Sky God Revelation: draw until you have 6 cards in your hand (${n})?`))) e.draw(q, n);
        }
      },
    },
    use: revealOrSearch({ key: 'skyGod', label: 'Sky God Revelation', revealTests: [named('Slifer the Sky Dragon')], revealWhat: '"Slifer the Sky Dragon"', search: named('Slifer the Sky Dragon'), searchWhat: '"Slifer the Sky Dragon"' }),
  };

  // ----- Executive Privilege -----
  {
    const obelisk = (e: Engine, m: FieldCard) => e.isNamed(m, 'Obelisk the Tormentor');
    const aa = attackAll(obelisk);
    K['Executive Privilege'] = {
      *startOfDuel() {},
      eff: aa.eff,
      onAttack: aa.onAttack,
      extraAttacks: aa.extraAttacks,
      use: revealOrSearch({ key: 'execPriv', label: 'Executive Privilege', revealTests: [named('Obelisk the Tormentor'), named('Blue-Eyes White Dragon')], revealWhat: '"Obelisk the Tormentor" and "Blue-Eyes White Dragon"', search: named('Obelisk the Tormentor'), searchWhat: '"Obelisk the Tormentor"' }),
    };
  }

  // ----- Battle City Slugger -----
  {
    const warrior = (e: Engine, c: Card) => mon(e, c) && race(e, c) === 'Warrior';
    K['Battle City Slugger'] = {
      *startOfDuel() {},
      aura(e, p, m) {
        if (ctlOf(e, m) !== p || e.raceOf(m) !== 'Warrior') return undefined;
        return { atk: 100 * faceUp(e, p, (x) => e.raceOf(x) === 'Warrior').length, def: 0 };
      },
      // "... then you can Tribute Summon 1 Warrior monster, in addition to your Normal Summon/Set" (that turn).
      extraTributeFor: (e, p, card) => isTurn(e, p, 'slugger') && warrior(e, card),
      use: revealOrSearch({
        key: 'slugger',
        label: 'Battle City Slugger',
        revealTests: [(e, c) => ['Gilford the Lightning', 'Insect Queen', 'Jinzo', 'The Legendary Fisherman'].some((n) => e.isNamed(c, n))],
        revealWhat: '"Gilford the Lightning", "Insect Queen", "Jinzo" or "The Legendary Fisherman"',
        search: named('Gilford the Lightning'),
        searchWhat: '"Gilford the Lightning"',
        after: (e, p) => {
          setN(e, p, 'slugger', e.state.turn);
          e.log(p, 'You can Tribute Summon 1 Warrior monster in addition to your Normal Summon/Set this turn');
        },
      }),
    };
  }

  // ----- Advent of Ra -----
  // The Tributes' original ATK/DEF are summed while they go to the GY for Ra's Tribute Summon (fx.tributingFor), and become Ra's
  // original ATK/DEF (tags.origSet, read by engine.baseStats).
  {
    const RA = 'The Winged Dragon of Ra';
    K['Advent of Ra'] = {
      *startOfDuel() {},
      eff: {
        *onAnyToGrave(e, _c, ctl, events) {
          const forName = e.state.fx.tributingFor as string | undefined;
          if (!forName || !e.isNamed(forName, RA) || e.state.turnPlayer !== ctl) return;
          const trib = events.filter((x) => x.reason === 'tribute' && x.controller === ctl && x.from === 'mz');
          if (!trib.length) return;
          if (getN(e, ctl, 'raTurn') !== e.state.turn || getN(e, ctl, 'raSeq') !== (e.state.lastEvent?.seq ?? 0)) {
            setN(e, ctl, 'raAtk', 0);
            setN(e, ctl, 'raDef', 0);
          }
          setN(e, ctl, 'raTurn', e.state.turn);
          setN(e, ctl, 'raAtk', getN(e, ctl, 'raAtk') + trib.reduce((s, x) => s + origAtk(e, x.card), 0));
          setN(e, ctl, 'raDef', getN(e, ctl, 'raDef') + trib.reduce((s, x) => s + origDef(e, x.card), 0));
          setN(e, ctl, 'raSeq', e.state.lastEvent?.seq ?? 0);
          setN(e, ctl, 'raPending', 1);
        },
        *onAnySummon(e, _c, ctl, m, mctl, kind) {
          if (kind !== 'normal' || mctl !== ctl || !e.isNamed(m, RA) || !m.tags?.tribS) return;
          let atk = 0;
          let def = 0;
          const list = ((e.state.fx.tributedFor ?? {}) as Record<number, unknown>)[m.uid];
          if (Array.isArray(list)) {
            // A Tribute Summon by the card's own procedure (engine.tributeSummonWith): the Tributes are listed.
            for (const x of list as { name: string }[]) (atk += origAtk(e, x.name as unknown as Card)), (def += origDef(e, x.name as unknown as Card));
          } else if (getN(e, ctl, 'raPending') && getN(e, ctl, 'raTurn') === e.state.turn) {
            atk = getN(e, ctl, 'raAtk');
            def = getN(e, ctl, 'raDef');
          } else return;
          setN(e, ctl, 'raPending', 0);
          Object.assign(tag(m), { origSet: 1, origAtk: atk, origDef: def });
          reveal(e, ctl);
          e.log(ctl, `Advent of Ra: ${m.name}'s original ATK/DEF become ${atk}/${def}`);
        },
      },
      use: revealOrSearch({ key: 'adventRa', label: 'Advent of Ra', revealTests: [(e, c) => mon(e, c) && e.nameHas(c, RA)], revealWhat: 'a "The Winged Dragon of Ra" monster', search: (e, c) => mon(e, c) && e.nameHas(c, RA), searchWhat: 'a "The Winged Dragon of Ra" monster' }),
    };
  }

  // ----- Fear of the Dark -----
  K['Fear of the Dark'] = fearOfTheDark();

  // ----- As I Predicted...! -----
  K['As I Predicted...!'] = {
    *startOfDuel(e) {
      patchExchange(e);
    },
    drawPhase: {
      can: (e, p) => e.player(p).deck.length >= 2,
      *run(e, p) {
        const top = e.player(p).deck.slice(0, 2);
        const c = yield* pickOne(e, p, 'As I Predicted...!: add which card to your hand? (the other goes to the GY)', top);
        const keep = c ?? top[0];
        e.toHandOf(keep.uid, p);
        e.log(p, `${e.player(p).name} adds a card to the hand`);
        for (const x of top) if (x !== keep && e.find(x.uid)?.loc.zone === 'deck') yield* e.sendToGrave(x.uid, 'cost');
        // "If you do, skip your next Battle Phase" (no Battle Phase on the Duel's first turn: then the one after).
        const t = e.state.firstTurn ? e.state.turn + 2 : e.state.turn;
        ((e.state.fx.noDeclare ??= [-1, -1]) as number[])[p] = t;
        e.log(p, `${e.player(p).name} skips their next Battle Phase`);
      },
    },
    // "If you have 15 or more cards in your GY, you can banish 1 "Exchange of the Spirit" from your GY to activate its effect."
    use: {
      oncePerDuel: false,
      can: (e, p) => e.player(p).gy.length >= 15 && e.oncePerDuel('Exchange of the Spirit', p) && inGY(e, p, (c) => e.isNamed(c, 'Exchange of the Spirit')).length > 0,
      *run(e, p) {
        const c = inGY(e, p, (x) => e.isNamed(x, 'Exchange of the Spirit'))[0];
        e.banish(c.uid);
        e.useOncePerDuel('Exchange of the Spirit', p);
        e.log(p, `${e.player(p).name} banishes Exchange of the Spirit from the GY to activate its effect`);
        exchangeEffect(e);
      },
    },
  };

  // ----- Royal Temple of the Kings -----
  // The Skill sits in the Field Zone. "Mystical Beast of Serket cannot be destroyed by its own effect": its only self-destruction
  // is "destroy it if you do not control Temple of the Kings", so the Skill counts as "Temple of the Kings" for that (namesAs).
  K['Royal Temple of the Kings'] = {
    *startOfDuel(e, p) {
      const fc = e.placeSkillCard('Royal Temple of the Kings', p, 'field');
      if (fc) tag(fc).skillCard = 1;
    },
    namesAs: (e, p) => (faceUp(e, p, (m) => e.isNamed(m, 'Mystical Beast of Serket')).length ? 'Temple of the Kings' : undefined),
    eff: {
      shields: (e, _src, target, how, ctl) => how !== 'battle' && !!target.tags?.skillCard && ctlOf(e, target) === ctl && e.actor === other(ctl),
      // "This turn, you can activate a Continuous Trap Card with an effect that Special Summons itself as a monster, the turn it was Set."
      *stateCheck(e, _c, p) {
        if (!isTurn(e, p, 'temple')) return;
        for (const c of e.spells(p))
          if (!c.faceUp && c.placedTurn === e.state.turn && info(e, c).kind === 'trap' && info(e, c).sub === 'Continuous' && /Special Summon this card/i.test(info(e, c).desc)) c.placedTurn = e.state.turn - 1;
      },
    },
    use: {
      oncePerDuel: false,
      can: (e, p) => e.player(p).lp > 500,
      *run(e, p) {
        e.payLp(p, 500);
        setN(e, p, 'temple', e.state.turn);
        e.log(p, 'This turn, Continuous Traps that Special Summon themselves can be activated the turn they are Set');
      },
    },
    ai: false,
  };

  // ----- Tribal Unity -----
  {
    const harpie = (e: Engine, c: Card) => e.nameHas(c, 'Harpie');
    const amaz = (e: Engine, c: Card) => e.nameHas(c, 'Amazoness');
    const both = (e: Engine, m: FieldCard) => harpie(e, m) || amaz(e, m);
    K['Tribal Unity'] = {
      *startOfDuel(e) {
        e.state.fx.gyNames = 1; // engine.namesOf: addsNames for cards in the GY too
      },
      eff: {
        // A name holding the archetype word (the card keeps its own names; "monsters with the same name" are not affected).
        addsNames(e, _src, _ctl, target) {
          const f = e.find(target.uid);
          if (!f || !['mz', 'gy'].includes(f.loc.zone) || !mon(e, target)) return undefined;
          const names = e.namesOf(target);
          const out: string[] = [];
          if (names.some((n) => n.includes('Harpie')) && !names.some((n) => n.includes('Amazoness'))) out.push(`${names[0]} [Amazoness]`);
          if (names.some((n) => n.includes('Amazoness')) && !names.some((n) => n.includes('Harpie'))) out.push(`${names[0]} [Harpie]`);
          return out.length ? [...names, ...out] : undefined;
        },
      },
      use: {
        phase: undefined,
        can: (e, p) => inHand(e, p, (c) => mon(e, c)).length > 0 && faceUp(e, p, (m) => both(e, m)).length > 0,
        *run(e, p) {
          const d = yield* discardOne(e, p, 'Tribal Unity: discard 1 monster', inHand(e, p, (c) => mon(e, c)));
          if (!d) return;
          const m = yield* pickOne(e, p, `Tribal Unity: which "Harpie" or "Amazoness" monster gains ${levelOf(e, d) * 200} ATK?`, faceUp(e, p, (x) => both(e, x)));
          if (m) boostPerm(m, levelOf(e, d) * 200);
        },
      },
    };
  }

  // ----- Ever Faithful Companions -----
  {
    const dmOrDmg = (e: Engine, c: Card) => e.isNamed(c, 'Dark Magician') || e.isNamed(c, 'Dark Magician Girl');
    const canA = (e: Engine, p: Pid) => e.oncePerTurn('skill:efcA', p) && e.monsters(p).length === 0 && e.monsters(other(p)).length > 0 && freeMZ(e, p) && inHand(e, p, (c) => mon(e, c) && dmOrDmg(e, c)).length > 0;
    const search = (e: Engine, p: Pid) => inDeck(e, p, (c) => e.isNamed(c, 'Dark Magician') || mentions(e, c, 'Dark Magician'));
    const canB = (e: Engine, p: Pid) => opd(e, p, 'efcB') && faceUp(e, p, (m) => origNamed(e, m, 'Dark Magician') || origNamed(e, m, 'Dark Magician Girl')).length > 0 && search(e, p).length > 0;
    K['Ever Faithful Companions'] = {
      *startOfDuel() {},
      use: {
        oncePerDuel: false,
        repeat: true,
        can: (e, p) => canA(e, p) || canB(e, p),
        *run(e, p) {
          const a = canA(e, p);
          const b = canB(e, p);
          const k = a && b ? yield* chooseOption(e, p, 'Ever Faithful Companions: which Skill?', ['Special Summon "Dark Magician" or "Dark Magician Girl" from your hand', 'Add "Dark Magician" or a card that mentions it from your Deck']) : a ? 0 : 1;
          if (k === 0) {
            e.useOnce('skill:efcA', p);
            yield* ssOne(e, p, 'Special Summon which monster from your hand?', inHand(e, p, (c) => mon(e, c) && dmOrDmg(e, c)));
          } else if (k === 1) {
            useOpd(e, p, 'efcB');
            yield* toHandFrom(e, p, 'Add "Dark Magician" or a card that mentions it', search(e, p), true);
          }
        },
      },
    };
  }

  // ----- Symbol of Pride / Red-Eye Inferno -----
  {
    const BEWD = 'Blue-Eyes White Dragon';
    const spells = (e: Engine, p: Pid) => inHand(e, p, (c) => isSpell(e, c));
    const plans = (e: Engine, p: Pid) => fusionPlans(e, p, (f) => e.isNamed(f, 'Blue-Eyes Ultimate Dragon'), () => handField(e, p));
    const canA = (e: Engine, p: Pid) => opd(e, p, 'sopA') && faceUp(e, p, (m) => e.isNamed(m, BEWD)).length > 0 && affectable(e, p, e.monsters(other(p))).length > 0;
    const canB = (e: Engine, p: Pid) => opd(e, p, 'sopB') && plans(e, p).length > 0;
    K['Symbol of Pride'] = {
      *startOfDuel() {},
      eff: {
        // "Tribute Summon 1 "Blue-Eyes White Dragon" by Tributing 1 Tribute Summoned monster, in addition to your Normal Summon/Set."
        tributeOffer: (e, _src, ctl, monster) => (e.isNamed(monster, BEWD) && mon(e, monster) && e.inMainPhase() && e.state.turnPlayer === ctl ? { need: 1, only: (m: FieldCard) => m.faceUp && !!m.tags?.tribS } : undefined),
        shields: (e, _src, target, how, ctl) => how !== 'battle' && target.tags?.sopUnaff === e.state.turn && ctlOf(e, target) === ctl && e.actor === other(ctl),
      },
      extraTributeFor: (e, p, card) => e.isNamed(card, BEWD) && mon(e, card) && e.monsters(p).some((m) => m.faceUp && !!m.tags?.tribS),
      mayAttack: (e, p, m) => !(isTurn(e, p, 'sopA') && e.isNamed(m, BEWD)),
      use: {
        phase: 'main',
        oncePerDuel: false,
        can: (e, p) => spells(e, p).length > 0 && (canA(e, p) || canB(e, p)),
        *run(e, p) {
          const a = canA(e, p);
          const b = canB(e, p);
          const k = a && b ? yield* chooseOption(e, p, 'Symbol of Pride: which Skill?', ["Destroy all monsters your opponent controls", 'Fusion Summon "Blue-Eyes Ultimate Dragon"']) : a ? 0 : 1;
          if (!(yield* discardOne(e, p, 'Symbol of Pride: discard 1 Spell', spells(e, p)))) return;
          if (k === 0) {
            useOpd(e, p, 'sopA');
            setN(e, p, 'sopA', e.state.turn);
            yield* e.destroy(affectable(e, p, e.monsters(other(p))).map((m) => m.uid));
          } else if (k === 1) {
            useOpd(e, p, 'sopB');
            const m = yield* fusionSummon(e, p, 'Symbol of Pride', plans(e, p));
            if (m) tag(m).sopUnaff = e.state.turn;
          }
        },
      },
    };
  }
  {
    const REBD = 'Red-Eyes Black Dragon';
    const spells = (e: Engine, p: Pid) => inHand(e, p, (c) => isSpell(e, c));
    const plans = (e: Engine, p: Pid) => fusionPlans(e, p, (f) => (e.fusionMaterials(f.name) ?? []).includes(e.info(REBD).id), () => handField(e, p));
    const canA = (e: Engine, p: Pid) => opd(e, p, 'reiA') && faceUp(e, p, (m) => e.isNamed(m, REBD)).length > 0;
    const canB = (e: Engine, p: Pid) => opd(e, p, 'reiB') && plans(e, p).length > 0;
    K['Red-Eye Inferno'] = {
      *startOfDuel() {},
      eff: {
        tributeDiscount: (e, _src, ctl, monster, summoner) => (summoner === ctl && mon(e, monster) && e.isNamed(monster, REBD) ? e.monsters(other(ctl)).length : 0),
        shields: (e, _src, target, how, ctl) => how === 'effect' && target.tags?.reiSafe === e.state.turn && ctlOf(e, target) === ctl && e.actor === other(ctl),
      },
      mayAttack: (e, p, m) => !(isTurn(e, p, 'reiA') && e.isNamed(m, REBD)),
      use: {
        phase: 'main',
        oncePerDuel: false,
        can: (e, p) => spells(e, p).length > 0 && (canA(e, p) || canB(e, p)),
        *run(e, p) {
          const a = canA(e, p);
          const b = canB(e, p);
          const k = a && b ? yield* chooseOption(e, p, 'Red-Eye Inferno: which Skill?', ['Inflict 800 damage to your opponent', 'Fusion Summon a Fusion Monster that mentions "Red-Eyes Black Dragon"']) : a ? 0 : 1;
          if (!(yield* discardOne(e, p, 'Red-Eye Inferno: discard 1 Spell', spells(e, p)))) return;
          if (k === 0) {
            useOpd(e, p, 'reiA');
            setN(e, p, 'reiA', e.state.turn);
            e.damage(other(p), 800);
          } else if (k === 1) {
            useOpd(e, p, 'reiB');
            const m = yield* fusionSummon(e, p, 'Red-Eye Inferno', plans(e, p));
            if (m) tag(m).reiSafe = e.state.turn;
          }
        },
      },
    };
  }

  // ----- Pulling the Strings -----
  K['Pulling the Strings'] = {
    *startOfDuel() {},
    use: {
      oncePerDuel: false,
      can: (e, p) => faceUp(e, p).length > 0 && freeMZ(e, other(p)),
      *run(e, p) {
        const m = yield* pickOne(e, p, 'Pulling the Strings: give control of which monster to your opponent?', faceUp(e, p));
        if (!m || !e.takeControl(m.uid, other(p))) return;
        m.returnAtEnd = undefined;
        tag(m).skillNoTribute = 1;
        e.log(p, `${e.player(other(p)).name} now controls ${m.name}; it cannot be Tributed`);
      },
    },
    *onEndPhase(e, p) {
      const mine = () => e.monsters(other(p)).filter((m) => m.owner === p);
      if (e.state.turnPlayer !== other(p) || !opd(e, p, 'strings') || !mine().length) return;
      if (!(yield* e.yesno(p, 'Pulling the Strings: destroy a monster your opponent controls that you own?'))) return;
      const m = yield* pickOne(e, p, 'Destroy which monster?', mine());
      if (!m) return;
      useOpd(e, p, 'strings');
      reveal(e, p);
      yield* e.destroy([m.uid]);
      if (e.fieldCard(m.uid)) return;
      e.damage(other(p), 500);
      setN(e, p, 'stringsSafe', 1);
      e.log(p, `${e.player(p).name} takes no damage from cards they own for the rest of the Duel`);
    },
    eff: {
      damageMod(e, _c, ctl, damaged, _amount, byEffect) {
        if (damaged !== ctl || !getN(e, ctl, 'stringsSafe')) return undefined;
        if (byEffect) return e.resolvingCard()?.owner === ctl ? 0 : undefined;
        const b = battling(e);
        const src = b ? [b.a, b.t].find((m) => m && ctlOf(e, m) === other(ctl)) : null;
        return src && src.owner === ctl ? 0 : undefined;
      },
    },
    ai: false,
  };

  // ----- Malevolence of the Millennium Ring -----
  {
    const fiend = (e: Engine, c: Card) => mon(e, c) && race(e, c) === 'Fiend';
    const cost = (e: Engine, c: Card) => levelOf(e, c) * 200;
    const canA = (e: Engine, p: Pid) => opd(e, p, 'ringA') && inDeck(e, p, (c) => fiend(e, c)).length > 0;
    const canB = (e: Engine, p: Pid) => opd(e, p, 'ringB') && inHand(e, p, (c) => fiend(e, c)).length > 0 && e.player(p).deck.length > 0;
    K['Malevolence of the Millennium Ring'] = {
      *startOfDuel() {},
      use: {
        oncePerDuel: false,
        can: (e, p) => faceUp(e, p, (m) => e.raceOf(m) === 'Fiend').length > 0 && (canA(e, p) || canB(e, p)),
        *run(e, p) {
          const a = canA(e, p);
          const b = canB(e, p);
          const k = a && b ? yield* chooseOption(e, p, 'Malevolence of the Millennium Ring: which Skill?', ['Send 1 Fiend from your Deck to the GY', 'Discard 1 Fiend, then draw 1 card']) : a ? 0 : 1;
          if (k === 0) {
            useOpd(e, p, 'ringA');
            const c = yield* pickOne(e, p, 'Send which Fiend monster from your Deck to the GY?', inDeck(e, p, (x) => fiend(e, x)));
            if (!c) return;
            yield* e.sendToGrave(c.uid, 'cost');
            e.player(p).deck = e.shuffle(e.player(p).deck);
            if (cost(e, c) > 0) e.payLp(p, cost(e, c));
          } else if (k === 1) {
            useOpd(e, p, 'ringB');
            const c = yield* discardOne(e, p, 'Discard which Fiend monster?', inHand(e, p, (x) => fiend(e, x)));
            if (!c) return;
            if (cost(e, c) > 0) e.payLp(p, cost(e, c));
            if (e.state.winner === null) e.draw(p, 1);
          }
        },
      },
    };
  }

  // ----- Keeper of the Valley -----
  {
    const valleyST = (e: Engine, c: Card) => !mon(e, c) && mentions(e, c, 'Necrovalley');
    // Cards that lock the GY as "Necrovalley" (the card, and Gravekeeper's Priestess treating the field as it).
    const valleyLock = (e: Engine, c: FieldCard) => e.isNamed(c, 'Necrovalley') || e.isNamed(c, "Gravekeeper's Priestess");
    K['Keeper of the Valley'] = {
      *startOfDuel() {},
      eff: {
        freesGrave: (e, _src, ctl, card) => e.find(card.uid)?.loc.player === ctl && !e.liveCards().some((x) => x.c.uid >= 0 && !valleyLock(e, x.c) && x.eff.locksGrave?.(e, x.c, x.p, card) === true),
      },
      use: {
        can: (e, p) => e.player(p).hand.length > 0 && inGY(e, p, (c) => valleyST(e, c)).length > 0,
        *run(e, p) {
          if (!(yield* discardOne(e, p, 'Keeper of the Valley: discard 1 card', e.player(p).hand))) return;
          yield* toHandFrom(e, p, 'Add which Spell/Trap that mentions "Necrovalley" from your GY?', inGY(e, p, (c) => valleyST(e, c)), true);
        },
      },
    };
  }

  // ----- Deserts Peril -----
  K['Deserts Peril'] = {
    *startOfDuel() {},
    use: {
      oncePerDuel: true,
      timesPerDuel: 2,
      can: (e, p) => e.monsters(p).length > 0,
      *run(e, p) {
        const ps = e.player(p);
        const mons = e.monsters(p);
        for (const m of mons) {
          for (const eq of m.equips.slice()) yield* e.sendToGrave(eq, 'used');
          if (!e.fieldCard(m.uid)) continue;
          m.faceUp = false;
          m.pos = 'def';
          m.atkMod = 0;
          m.defMod = 0;
          if (m.tags) delete m.tags.permAtk, delete m.tags.permDef;
        }
        // Shuffle them among the Monster Zones they occupy.
        const zones = ps.mz.map((z, i) => (z ? i : -1)).filter((i) => i >= 0);
        const cards = zones.map((i) => ps.mz[i]!);
        for (let i = cards.length - 1; i > 0; i--) {
          const j = Math.floor(e.rand() * (i + 1));
          [cards[i], cards[j]] = [cards[j], cards[i]];
        }
        zones.forEach((z, i) => (ps.mz[z] = cards[i]));
        e.event('position', { player: p });
        e.log(p, `${ps.name} flips their monsters face-down and shuffles them`);
        if (e.monsters(p).length && (yield* e.yesno(p, 'Deserts Peril: change the battle position of 1 monster you control?'))) {
          const m = yield* pickOne(e, p, 'Change the battle position of which monster?', e.monsters(p));
          if (m) {
            yield* changePos(e, m);
            m.posChanged = true;
          }
        }
      },
    },
    ai: false,
  };

  // ----- Harpie's Kaleidoscope -----
  {
    const sisters = (e: Engine, m: FieldCard) => e.nameHas(m, 'Harpie Lady Sisters');
    const windBeasts = (e: Engine, p: Pid) => inGY(e, p, (c) => mon(e, c) && attrOf(e, c) === 'WIND' && race(e, c) === 'Winged Beast');
    const ready = (e: Engine, p: Pid) => faceUp(e, p, (m) => sisters(e, m) && !e.isNegated(m) && e.oncePerTurn(`skill:kaleido:${m.uid}`, p));
    const targets = (e: Engine, p: Pid) => affectable(e, p, e.monsters(other(p))).filter((m) => !m.faceUp || !e.shielded(m, 'target'));
    K["Harpie's Kaleidoscope"] = {
      *startOfDuel() {},
      eff: {
        shields: (e, _src, target, how, ctl) => how === 'effect' && sisters(e, target) && ctlOf(e, target) === ctl && e.actor === other(ctl) && ['monster', 'trap'].includes(e.resolvingKind() ?? ''),
      },
      // The effect the "Harpie Lady Sisters" gain is used through the Skill (once per turn for each of them).
      use: {
        phase: 'main',
        oncePerDuel: false,
        repeat: true,
        can: (e, p) => ready(e, p).length > 0 && windBeasts(e, p).length >= 2 && targets(e, p).length > 0,
        *run(e, p) {
          const m = ready(e, p).length > 1 ? yield* pickOne(e, p, 'Which "Harpie Lady Sisters" uses its effect?', ready(e, p)) : ready(e, p)[0];
          if (!m) return;
          const two = yield* pick(e, p, 'Place 2 WIND Winged Beast monsters from your GY on the bottom of the Deck', windBeasts(e, p), 2, 2);
          if (!two || two.length < 2) return;
          e.useOnce(`skill:kaleido:${m.uid}`, p);
          yield* toBottomInOrder(e, p, two);
          const t = yield* pickOne(e, p, `${m.name}: return which monster to the hand?`, targets(e, p));
          if (t && e.fieldCard(t.uid)) {
            e.log(p, `${m.name} returns ${t.faceUp ? t.name : 'a monster'} to the hand`);
            e.bounce([t.uid]);
          }
        },
      },
    };
  }

  // ----- See Me Rolling -----
  // The re-roll is the player's choice: engine.rollDie asks "See Me Rolling: re-roll the N?" once per turn after a die roll
  // for a card or effect (die rolls inside a non-generator hook, Desrook Archfiend's negation check, cannot ask and are not offered).
  K['See Me Rolling'] = {
    use: {
      phase: 'main',
      can: (e, p) => inDeck(e, p, (c) => isDiceCard(e, c)).length > 0,
      *run(e, p) {
        if (yield* toHandFrom(e, p, 'See Me Rolling: add a card with a die roll from your Deck', inDeck(e, p, (c) => isDiceCard(e, c)), true)) yield* handToBottom(e, p, 'See Me Rolling');
      },
    },
    reroll: {
      can: (e: Engine, p: Pid) => e.oncePerTurn('skill:rolling', p),
      use(e: Engine, p: Pid, v: number) {
        e.useOnce('skill:rolling', p);
        e.log(p, `See Me Rolling: ${e.player(p).name} re-rolls the ${v}`);
      },
    },
  } as SkillDef & { reroll: { can(e: Engine, p: Pid): boolean; use(e: Engine, p: Pid, v: number): void } };

  // ----- Battle City Bestie -----
  K['Battle City Bestie'] = {
    *startOfDuel() {},
    eff: {
      damageMod: (e, _c, ctl, damaged, _amount, byEffect) => (!byEffect && damaged === ctl && e.state.turnPlayer === ctl ? 0 : undefined),
      *onChainLink(e, _c, p, link) {
        if (link.player === other(p)) setN(e, p, 'bestie', e.state.turn);
      },
    },
    *onEndPhase(e, p) {
      if (e.state.turnPlayer !== p || !isTurn(e, p, 'bestie') || !e.oncePerTurn('skill:bestie', p)) return;
      e.useOnce('skill:bestie', p);
      e.log(p, 'Battle City Bestie: your opponent activated a card or effect this turn');
      e.draw(p, 1);
    },
  };

  // ----- Even the Odds -----
  K['Even the Odds'] = {
    use: {
      phase: 'main',
      can: (e, p) => cardsOn(e, other(p)) === 3 && cardsOn(e, p) === 0 && e.player(p).deck.length > 0,
      *run(e, p) {
        if (yield* toHandFrom(e, p, 'Even the Odds: add 1 card from your Deck to your hand', e.player(p).deck)) yield* handToBottom(e, p, 'Even the Odds');
      },
    },
  };

  // ----- Noah's Arc -----
  // The additional Normal Summon of the Spirit monster is made through the Skill.
  {
    const shinatoCards = (e: Engine, p: Pid) => inDeck(e, p, (c) => e.isNamed(c, 'Shinato, King of a Higher Plane') || e.isNamed(c, "Shinato's Ark"));
    const canA = (e: Engine, p: Pid) => opd(e, p, 'noahA') && shinatoCards(e, p).length > 0;
    const canB = (e: Engine, p: Pid) => e.oncePerTurn('skill:noahB', p) && faceUp(e, p, (m) => (isSpirit(e, m) && levelOf(e, m) >= 5) || e.isNamed(m, 'Shinato, King of a Higher Plane')).length > 0 && inGY(e, p, (c) => isSpirit(e, c)).length > 0;
    const prevNames = (e: Engine, p: Pid) => (((e.state.fx.noahSummons ?? {}) as Record<string, string[]>)[`${p}|${e.state.turn - 2}`] ?? []);
    const extras = (e: Engine, p: Pid) => inHand(e, p, (c) => isSpirit(e, c) && prevNames(e, p).some((n) => e.sameName(c.name, n)) && e.canNormalSummon(p, c, true, true));
    const canC = (e: Engine, p: Pid) => e.inMainPhase() && e.oncePerTurn('skill:noahC', p) && extras(e, p).length > 0;
    K["Noah's Arc"] = {
      *startOfDuel() {},
      eff: {
        *onAnySummon(e, _c, ctl, m, mctl, kind) {
          if (kind !== 'normal' || mctl !== ctl || e.state.turnPlayer !== ctl) return;
          const all = (e.state.fx.noahSummons ??= {}) as Record<string, string[]>;
          (all[`${ctl}|${e.state.turn}`] ??= []).push(m.name);
        },
      },
      use: {
        oncePerDuel: false,
        repeat: true,
        can: (e, p) => canA(e, p) || canB(e, p) || canC(e, p),
        *run(e, p) {
          const opts: [string, number][] = [];
          if (canA(e, p)) opts.push(['Add "Shinato, King of a Higher Plane" or "Shinato\'s Ark" from your Deck', 0]);
          if (canB(e, p)) opts.push(['Add 1 Spirit monster from your GY to your hand', 1]);
          if (canC(e, p)) opts.push(['Normal Summon 1 Spirit monster in addition to your Normal Summon', 2]);
          const i = opts.length === 1 ? 0 : yield* chooseOption(e, p, "Noah's Arc: which Skill?", opts.map((x) => x[0]));
          const k = i === null ? null : opts[i][1];
          if (k === 0) {
            useOpd(e, p, 'noahA');
            if (yield* toHandFrom(e, p, 'Add which card from your Deck?', shinatoCards(e, p), true)) yield* handToBottom(e, p, "Noah's Arc");
          } else if (k === 1) {
            e.useOnce('skill:noahB', p);
            yield* toHandFrom(e, p, 'Add which Spirit monster from your GY?', inGY(e, p, (c) => isSpirit(e, c)), true);
          } else if (k === 2) {
            const c = yield* pickOne(e, p, 'Normal Summon which Spirit monster?', extras(e, p));
            if (!c) return;
            e.useOnce('skill:noahC', p);
            yield* e.extraNormalSummon(p, c.uid, 'atk', true);
          }
        },
      },
    };
  }
}

// ---------- Exchange of the Spirit (As I Predicted...!) ----------
const ANY_TIME = ['main', 'summon', 'special', 'attack', 'spell', 'trap', 'effect', 'damage'];
/**
 * "Only you need 15 or more cards in your GY to activate "Exchange of the Spirit"": the card's own activation check is widened,
 * once, for players whose Skill is As I Predicted...! (everyone else keeps the card's printed condition).
 */
function patchExchange(e: Engine) {
  const eff = e.scriptOf({ uid: -99, name: 'Exchange of the Spirit', owner: 0 } as Card) as (EffectDef & { aipPatched?: 1 }) | undefined;
  if (!eff || eff.aipPatched) return;
  eff.aipPatched = 1;
  const orig = eff.canActivate;
  eff.canActivate = (e2, c, p, t, ctx) =>
    !!orig?.(e2, c, p, t, ctx) || (e2.speed && e2.player(p).skill === 'As I Predicted...!' && ANY_TIME.includes(t) && e2.oncePerDuel(c.name, p) && e2.player(p).gy.length >= 15 && e2.player(p).lp > 1000);
}
/** Exchange of the Spirit's effect: each player swaps the cards in their GY with the cards in their Deck. */
function exchangeEffect(e: Engine) {
  for (const q of [0, 1] as Pid[]) {
    const ps = e.player(q);
    const gy = ps.gy;
    ps.gy = ps.deck;
    const fus = (c: Card) => info(e, c).sub === 'Fusion';
    ps.deck = e.shuffle(gy.filter((c) => !fus(c)));
    ps.fusion.push(...gy.filter(fus));
    e.log(q, `${ps.name}'s Graveyard and Deck are swapped`);
  }
}

// ---------- Fear of the Dark ----------
const MESSAGES = ['Spirit Message "I"', 'Spirit Message "N"', 'Spirit Message "A"', 'Spirit Message "L"'];
const isMessage = (e: Engine, c: Card) => e.namesOf(c).some((n) => MESSAGES.includes(n));
/**
 * helpers.placeSpiritMessage hook: "If a "Spirit Message" card would be placed on your field with "Destiny Board", you can Special
 * Summon it as a Normal Monster (Fiend/DARK/Level 1/ATK 0/DEF 0) instead." A no-op unless `p`'s Skill is Fear of the Dark.
 */
function* spiritAsMonster(e: Engine, p: Pid, card: Card): Generator<Prompt, boolean, Choice> {
  const ps = e.player(p);
  if (ps.skill !== 'Fear of the Dark' || !ps.skillRevealed || !freeMZ(e, p) || !stOf(e, p).some((c) => c.faceUp && e.isNamed(c, 'Destiny Board'))) return false;
  if (!(yield* e.yesno(p, `Fear of the Dark: Special Summon ${card.name} as a monster instead of placing it?`))) return false;
  ((e.state.fx.trapMonster ??= {}) as Record<number, unknown>)[card.uid] = { race: 'Fiend', attribute: 'DARK', level: 1 };
  e.state.fx.ignoreCond = card.uid;
  try {
    yield* e.specialSummon(card.uid, p, 'atk');
  } finally {
    e.state.fx.ignoreCond = undefined;
  }
  const m = e.fieldCard(card.uid);
  if (!m) return false;
  // "It cannot be targeted for attacks, but does not prevent your opponent from attacking you directly" (engine.canAttackDirectly).
  Object.assign(tag(m), { noAttackTarget: 1 });
  e.log(p, `${card.name} is Special Summoned as a Normal Monster`);
  return true;
}
function fearOfTheDark(): SkillDef & { spiritPlace: typeof spiritAsMonster } {
  const necrofear = (e: Engine, p: Pid) => faceUp(e, p, (m) => e.isNamed(m, 'Dark Necrofear')).length > 0;
  return {
    *startOfDuel() {},
    // Read by helpers.placeSpiritMessage (no runtime import of helpers here: it would make the module graph circular).
    spiritPlace: spiritAsMonster,
    eff: {
      shields: (e, _src, target, how, ctl) => how !== 'battle' && necrofear(e, ctl) && (e.isNamed(target, 'Destiny Board') || isMessage(e, target)) && ctlOf(e, target) === ctl && e.actor === other(ctl),
      guardsTarget: (e, _src, ctl, target) => !!target.tags?.noAttackTarget && ctlOf(e, target) === ctl,
    },
    use: {
      oncePerDuel: false,
      can: (e, p) => inHand(e, p, (c) => isMessage(e, c)).length > 0 && e.player(p).deck.length > 0,
      *run(e, p) {
        const c = yield* pickOne(e, p, 'Fear of the Dark: reveal which "Spirit Message" card?', inHand(e, p, (x) => isMessage(e, x)));
        if (!c) return;
        yield* e.reveal(other(p), 'Your opponent reveals', [c]);
        toBottom(e, c);
        e.draw(p, 1);
      },
    },
  };
}
