// Speed Duel Skills from the 2024 products (part b): scripts added to the shared Skill table.
// Speed Duel GX: Midterm Destruction (SGX4). installSkills runs at the end of skills.ts, so the
// helpers imported from './skills' are only used inside hooks, never at module top level.
import type { SkillDef } from '../skills';
import type { Choice, Engine, Step } from '../engine';
import type { Card, FieldCard, Pid, Prompt } from '../types';
import { chooseOption, fusionPlans, fusionSummon, handField, pickOne, ss, ssOne, toHandFrom } from './skills';

type Gen<T> = Generator<Prompt, T, Choice>;
const other = (p: Pid): Pid => (p === 0 ? 1 : 0);
const info = (e: Engine, c: Card | string) => e.info(typeof c === 'string' ? c : c.name);
const mon = (e: Engine, c: Card) => info(e, c).kind === 'monster';
const isFusion = (e: Engine, c: Card) => info(e, c).sub === 'Fusion';
const levelOf = (e: Engine, c: Card) => info(e, c).level ?? 0;
const race = (e: Engine, c: Card) => ('faceUp' in c && (c as FieldCard).faceUp ? e.raceOf(c) : info(e, c).race ?? '');
const origAtk = (e: Engine, c: Card) => Math.max(0, info(e, c).atk ?? 0);
const freeMZ = (e: Engine, p: Pid) => e.freeMonsterZone(p) >= 0;
const freeST = (e: Engine, p: Pid) => e.player(p).sz.findIndex((z) => z === null);
const tag = (m: FieldCard) => (m.tags ??= {});
const S = (e: Engine) => (e.state.fx.skillData ??= {}) as Record<string, number>;
const getN = (e: Engine, p: Pid, k: string) => S(e)[`${p}|${k}`] ?? 0;
const setN = (e: Engine, p: Pid, k: string, v: number) => (S(e)[`${p}|${k}`] = v);
const isTurn = (e: Engine, p: Pid, k: string) => e.state.turn > 0 && getN(e, p, k) === e.state.turn;
const opd = (e: Engine, p: Pid, k: string) => e.oncePerDuel(`skill:${k}`, p);
const useOpd = (e: Engine, p: Pid, k: string) => e.useOncePerDuel(`skill:${k}`, p);
const opt = (e: Engine, p: Pid, k: string) => e.oncePerTurn(`skill:${k}`, p);
const useOpt = (e: Engine, p: Pid, k: string) => e.useOnce(`skill:${k}`, p);
const faceUp = (e: Engine, p: Pid, test: (m: FieldCard) => boolean = () => true) => e.monsters(p).filter((m) => m.faceUp && test(m));
/** Monsters an effect may Special Summon from the hand/Deck/GY (no Extra Deck/Ritual monsters, no "cannot be Normal Summoned" ones). */
const summonable = (e: Engine, c: Card) => mon(e, c) && !['Fusion', 'Ritual'].includes(info(e, c).sub) && !e.effectOn(c)?.cannotNormalSummon;
/** An Effect Monster (Fusion Monsters with an effect included). */
const isEffectMonster = (e: Engine, c: Card) => {
  const i = info(e, c);
  return i.kind === 'monster' && (i.sub === 'Effect' || (i.sub !== 'Normal' && !i.vanilla));
};
/** "Lose LP" (not a payment, not damage). */
function loseLp(e: Engine, p: Pid, n: number) {
  if (n <= 0) return;
  const ps = e.player(p);
  (e.state.fx.lpLost ??= [0, 0])[p] += n;
  ps.lp = Math.max(0, ps.lp - n);
  e.event('damage', { player: p, amount: n });
  e.log(p, `${ps.name} loses ${n} LP (${ps.lp} LP)`);
  if (ps.lp <= 0) e.endDuel(other(p), `${ps.name}'s Life Points hit 0`);
}
/** Puts a card face-up in its controller's Spell & Trap Zone (Skills that "place" a card). */
function placeFaceUp(e: Engine, c: Card, p: Pid): FieldCard | null {
  const z = freeST(e, p);
  const f = e.find(c.uid);
  if (z < 0 || !f || !['deck', 'gy', 'hand', 'removed'].includes(f.loc.zone)) return null;
  const from = e.player(f.loc.player);
  (from[f.loc.zone as 'deck' | 'gy' | 'hand' | 'removed'] as Card[]).splice(f.loc.index, 1);
  if (f.loc.zone === 'deck') from.deck = e.shuffle(from.deck);
  const fc: FieldCard = { uid: c.uid, name: c.name, owner: c.owner, pos: 'atk', faceUp: true, placedTurn: e.state.turn, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, active: true };
  e.player(p).sz[z] = fc;
  e.event('activate', { uid: c.uid, player: p });
  e.log(p, `${e.player(p).name} places ${c.name} face-up in the Spell & Trap Zone`);
  return fc;
}
/**
 * A Normal Summon made by a Skill right now, which uses the turn's Normal Summon (Food Chain, Cyberdark Scheme).
 * The engine's extra-summon path is used for the timing, then the Normal Summon is marked as used.
 */
function* normalSummonNow(e: Engine, p: Pid, c: Card): Gen<FieldCard | null> {
  yield* e.extraNormalSummon(p, c.uid, 'atk', true);
  const fc = e.fieldCard(c.uid);
  if (fc && e.controller(c.uid) === p) e.player(p).normalSummoned = true;
  return fc;
}

export function installSkills(K: Record<string, SkillDef>) {
  // ----- Straight out of Neo Space! -----
  K['Straight out of Neo Space!'] = (() => {
    const neos = (e: Engine, c: Card) => e.isNamed(c, 'Elemental HERO Neos') && mon(e, c);
    const neosOk = (e: Engine, p: Pid, c: Card) => neos(e, c) && !e.summonBlocked(p, c, 'special', e.find(c.uid)?.loc.zone ?? null);
    /** A Fusion Monster of `p` went from the Monster Zone back to the Extra Deck during this End Phase. */
    const fusionReturned = (e: Engine, p: Pid) => {
      const evs = (e.state.events ?? []) as { kind: string; uid?: number; player?: Pid; zone?: string; to?: string }[];
      for (let i = evs.length - 1; i >= 0; i--) {
        const ev = evs[i];
        if (ev.kind === 'phase') return false;
        if (ev.kind === 'to-hand' && ev.to === 'extra' && ev.zone === 'mz' && ev.player === p && ev.uid !== undefined) {
          const c = e.find(ev.uid)?.card;
          if (c && isFusion(e, c)) return true;
        }
      }
      return false;
    };
    return {
      *startOfDuel() {},
      use: {
        oncePerDuel: false,
        repeat: true, // the text has no once-per-turn limit (it needs a Neos in the hand)
        can: (e, p) => e.monsters(p).length === 0 && e.monsters(other(p)).length > 0 && freeMZ(e, p) && e.player(p).hand.some((c) => neosOk(e, p, c)),
        *run(e, p) {
          setN(e, p, 'neoSpaceLock', e.state.turn);
          yield* ssOne(e, p, 'Straight out of Neo Space!: Special Summon "Elemental HERO Neos" from your hand', e.player(p).hand.filter((c) => neosOk(e, p, c)));
        },
      },
      eff: {
        forbidsSummon: (e, _c, ctl, monster, summoner, how) =>
          summoner === ctl && how === 'special' && isTurn(e, ctl, 'neoSpaceLock') && !e.nameHas(monster, 'Elemental HERO') && !e.nameHas(monster, 'Neo-Spacian'),
      },
      *onEndPhase(e, p) {
        if (e.state.turnPlayer !== p || !e.player(p).skillRevealed || !freeMZ(e, p) || !fusionReturned(e, p)) return;
        const list = e.player(p).deck.filter((c) => neosOk(e, p, c));
        if (!list.length || !(yield* e.yesno(p, 'Straight out of Neo Space!: Special Summon "Elemental HERO Neos" from your Deck?'))) return;
        yield* ss(e, p, list[0]);
      },
    } as SkillDef;
  })();

  // ----- Destructive Fate -----
  // The engine tosses coins without asking, so the result is declared ahead of the toss: during your turn you lose half your
  // LP and choose Heads or Tails for a Monster or a Spell (each once per turn); your next coin toss this turn shows it.
  K['Destructive Fate'] = (() => {
    const kinds = (e: Engine, p: Pid) => (['Monster', 'Spell'] as const).filter((k) => opt(e, p, `fate${k}`));
    const done = (e: Engine, p: Pid) => getN(e, p, 'fateTurns') >= 3;
    return {
      *startOfDuel() {},
      use: {
        oncePerDuel: false,
        repeat: true,
        can: (e, p) => !done(e, p) && e.player(p).lp >= 2 && kinds(e, p).length > 0 && !e.state.fx.fixedRoll,
        *run(e, p) {
          const ks = kinds(e, p);
          const k = ks.length === 1 ? 0 : yield* chooseOption(e, p, 'Destructive Fate: for the coin toss of which card type?', ks.map((x) => `a ${x}`));
          const kind = ks[k ?? 0];
          useOpt(e, p, `fate${kind}`);
          loseLp(e, p, Math.floor(e.player(p).lp / 2));
          if (e.state.winner !== null) return;
          const r = yield* chooseOption(e, p, 'Destructive Fate: declare the result', ['Heads', 'Tails']);
          e.state.fx.fixedRoll = { p, coin: (r ?? 0) + 1 };
          setN(e, p, 'fateSet', e.state.turn);
          e.log(p, `Destructive Fate: ${e.player(p).name}'s next coin toss for a ${kind} shows ${(r ?? 0) === 0 ? 'Heads' : 'Tails'}`);
        },
      },
      *onEndPhase(e, p) {
        // A declared result not used by the end of the turn is lost.
        const f = e.state.fx.fixedRoll as { p: Pid; coin?: number; die?: number } | undefined;
        if (f && f.p === p && f.coin && !f.die && isTurn(e, p, 'fateSet')) e.state.fx.fixedRoll = undefined;
        if (e.state.turnPlayer !== p || done(e, p)) return;
        setN(e, p, 'fateTurns', getN(e, p, 'fateTurns') + 1);
        if (done(e, p)) {
          e.player(p).skillRevealed = false;
          e.log(p, 'Destructive Fate is flipped face-down');
        }
      },
      ai: false,
    } as SkillDef;
  })();

  // ----- Food Chain -----
  K['Food Chain'] = (() => {
    const dino = (e: Engine, c: Card) => mon(e, c) && race(e, c) === 'Dinosaur';
    const dinoRep = (e: Engine, c: Card) => mon(e, c) && ['Dinosaur', 'Reptile'].includes(race(e, c));
    const next = (e: Engine, p: Pid, lv: number) => [...e.player(p).hand, ...e.player(p).deck].filter((c) => dino(e, c) && summonable(e, c) && levelOf(e, c) === lv + 1 && !e.summonBlocked(p, c, 'special', e.find(c.uid)?.loc.zone ?? null));
    const fodder = (e: Engine, p: Pid) => faceUp(e, p, (m) => dinoRep(e, m) && next(e, p, levelOf(e, m)).length > 0);
    const gyFood = (e: Engine, p: Pid) => e.player(p).gy.filter((c) => dinoRep(e, c));
    const tributeDinos = (e: Engine, p: Pid) =>
      e.player(p).normalSummoned || !e.inMainPhase() || gyFood(e, p).length < 2
        ? []
        : e.player(p).hand.filter((c) => dino(e, c) && e.tributeNeed(p, c) > 0 && e.openMonsterZones(p) > 0 && !e.summonBlocked(p, c, 'normal', 'hand') && !e.effectOn(c)?.cannotNormalSummon);
    return {
      use: {
        phase: 'main',
        oncePerDuel: false,
        can: (e, p) => fodder(e, p).length > 0 || tributeDinos(e, p).length > 0,
        *run(e, p) {
          const labels: string[] = [];
          const acts: (() => Step)[] = [];
          if (fodder(e, p).length)
            labels.push('Destroy a Dinosaur/Reptile, then Special Summon a Dinosaur 1 Level higher'),
              acts.push(function* () {
                const m = yield* pickOne(e, p, 'Food Chain: destroy which Dinosaur or Reptile monster?', fodder(e, p));
                if (!m) return;
                const lv = levelOf(e, m);
                yield* e.destroy([m.uid]);
                if (e.fieldCard(m.uid)) return;
                yield* ssOne(e, p, `Food Chain: Special Summon a Level ${lv + 1} Dinosaur from your hand or Deck`, next(e, p, lv));
              });
          if (tributeDinos(e, p).length)
            labels.push('Tribute Summon a Dinosaur by banishing 2 Dinosaur/Reptile monsters from your GY'),
              acts.push(function* () {
                const c = yield* pickOne(e, p, 'Food Chain: Tribute Summon which Dinosaur?', tributeDinos(e, p));
                if (!c) return;
                const two: Card[] = [];
                for (let i = 0; i < 2; i++) {
                  const g = yield* pickOne(e, p, `Food Chain: banish a Dinosaur or Reptile monster from your GY (${i + 1}/2)`, gyFood(e, p).filter((x) => !two.includes(x)));
                  if (!g) return;
                  two.push(g);
                }
                for (const g of two) e.banish(g.uid);
                e.log(p, `${e.player(p).name} banishes ${two.map((g) => g.name).join(' and ')} instead of Tributing`);
                setN(e, p, 'foodChainUid', c.uid + 1);
                try {
                  const fc = yield* normalSummonNow(e, p, c);
                  if (fc) tag(fc).tribS = Math.max(1, e.tributesNeeded(levelOf(e, c))); // it is still treated as a Tribute Summon
                } finally {
                  setN(e, p, 'foodChainUid', 0);
                }
              });
          const k = acts.length === 1 ? 0 : yield* chooseOption(e, p, 'Food Chain: apply which Skill?', labels);
          if (k !== null) yield* acts[k]();
        },
      },
      // During the Skill's Tribute Summon, the chosen Dinosaur needs no Tributes (the banished cards replaced them).
      eff: { tributeDiscount: (e, _c, ctl, monster, summoner) => (summoner === ctl && getN(e, ctl, 'foodChainUid') === monster.uid + 1 ? 3 : 0) },
    } as SkillDef;
  })();

  // ----- Major in Paleontology -----
  K['Major in Paleontology'] = (() => {
    type Slot = (c: Card) => boolean;
    /** The materials of a "Fossil" Fusion Monster as tests on GY cards ("1 Rock monster in your GY + 1 Level 4 or lower monster"). */
    const slots = (e: Engine, f: Card, p: Pid): Slot[] | null => {
      const first = (info(e, f).desc ?? '').split('\n')[0];
      const parts = first.split(' + ');
      if (parts.length < 2) return null;
      const out: Slot[] = [];
      for (const part of parts) {
        const m = part.trim().match(/^1 (.*?)monster(?: in (your opponent's|your) GY)?$/);
        if (!m) return null;
        const words = m[1].trim();
        const gy = m[2] === 'your' ? p : m[2] ? other(p) : null;
        const hi = words.match(/Level (\d+) or higher/);
        const lo = words.match(/Level (\d+) or lower/);
        const either = words.match(/Level (\d+) or (\d+)(?! or)/);
        const rc = words.replace(/Level \d+ or (higher|lower|\d+)/, '').trim();
        out.push((c) => {
          const at = e.find(c.uid);
          if (!at || at.loc.zone !== 'gy' || (gy !== null && at.loc.player !== gy) || !mon(e, c)) return false;
          const lv = levelOf(e, c);
          if (hi && lv < Number(hi[1])) return false;
          if (lo && lv > Number(lo[1])) return false;
          if (!hi && !lo && either && lv !== Number(either[1]) && lv !== Number(either[2])) return false;
          if (rc && info(e, c).race !== rc) return false;
          return true;
        });
      }
      return out;
    };
    const fossils = (e: Engine, p: Pid) => e.player(p).fusion.filter((f) => isFusion(e, f) && e.nameHas(f, 'Fossil'));
    /** Every pair of distinct GY cards filling the 2 slots. */
    const combos = (e: Engine, p: Pid, f: Card): Card[][] => {
      const sl = slots(e, f, p);
      if (!sl || sl.length !== 2) return [];
      const gys = [...e.player(p).gy, ...e.player(other(p)).gy];
      const out: Card[][] = [];
      for (const a of gys.filter(sl[0])) for (const b of gys.filter(sl[1])) if (a !== b) out.push([a, b]);
      return out;
    };
    /** Blocked from the Extra Deck by something else than its "Fossil Fusion" Summoning condition (which this Skill meets). */
    const blocked = (e: Engine, p: Pid, f: Card) => {
      const prev = e.state.fx.ignoreCond;
      e.state.fx.ignoreCond = f.uid;
      try {
        return e.summonBlocked(p, f, 'special', 'fusion');
      } finally {
        e.state.fx.ignoreCond = prev;
      }
    };
    const plans = (e: Engine, p: Pid) => (freeMZ(e, p) ? fossils(e, p).filter((f) => combos(e, p, f).length > 0 && !blocked(e, p, f)) : []);
    const canBanish = (e: Engine, p: Pid) => getN(e, p, 'dig') < 1 && e.player(p).hand.length > 0 && opt(e, p, 'mipBanish');
    const canFuse = (e: Engine, p: Pid) => getN(e, p, 'dig') >= 1 && e.inMainPhase() && opt(e, p, 'mipFuse') && plans(e, p).length > 0;
    const addCounter = (e: Engine, p: Pid) => {
      setN(e, p, 'dig', 1);
      e.log(p, 'Major in Paleontology: 1 Dig Counter is placed on the Skill');
    };
    return {
      *startOfDuel() {},
      use: {
        oncePerDuel: false,
        repeat: true, // each part keeps its own once-per-turn limit
        can: (e, p) => canBanish(e, p) || canFuse(e, p),
        *run(e, p) {
          const labels: string[] = [];
          const acts: (() => Step)[] = [];
          if (canBanish(e, p))
            labels.push('Banish 1 card from your hand face-down to place a Dig Counter'),
              acts.push(function* () {
                const c = yield* pickOne(e, p, 'Major in Paleontology: banish which card face-down?', e.player(p).hand);
                if (!c) return;
                useOpt(e, p, 'mipBanish');
                e.banish(c.uid, true);
                e.log(p, `${e.player(p).name} banishes 1 card from the hand face-down`);
                addCounter(e, p);
              });
          if (canFuse(e, p))
            labels.push('Remove the Dig Counter to Fusion Summon a "Fossil" Fusion Monster'),
              acts.push(function* () {
                const f = yield* pickOne(e, p, 'Major in Paleontology: Fusion Summon which "Fossil" Fusion Monster?', plans(e, p));
                if (!f) return;
                let list = combos(e, p, f);
                const chosen: Card[] = [];
                for (let i = 0; i < 2; i++) {
                  const opts = [...new Set(list.map((x) => x[i]))];
                  const c = opts.length === 1 ? opts[0] : yield* pickOne(e, p, `Banish which material (${i + 1}/2) from a GY?`, opts);
                  if (!c) return;
                  chosen.push(c);
                  list = list.filter((x) => x[i] === c);
                }
                useOpt(e, p, 'mipFuse');
                setN(e, p, 'dig', 0);
                e.log(p, 'Major in Paleontology: the Dig Counter is removed');
                for (const c of chosen) e.banish(c.uid);
                e.log(p, `${e.player(p).name} banishes ${chosen.map((c) => c.name).join(' and ')} as Fusion Material`);
                if (!freeMZ(e, p) || e.find(f.uid)?.loc.zone !== 'fusion') return;
                // Treated as a Fusion Summon with "Fossil Fusion": its "must first be Special Summoned with Fossil Fusion" is met.
                e.state.fx.ignoreCond = f.uid;
                try {
                  (e.state.fx.fusionMatList ??= {})[f.uid] = chosen.map((c) => c.uid);
                  yield* e.specialSummon(f.uid, p, 'atk', true, (fc) => void (tag(fc).fusS = 1));
                } finally {
                  e.state.fx.ignoreCond = undefined;
                }
                if (e.fieldCard(f.uid)) e.log(p, `${e.player(p).name} Fusion Summons ${f.name}!`);
              });
          const k = acts.length === 1 ? 0 : yield* chooseOption(e, p, 'Major in Paleontology: which Skill?', labels);
          if (k !== null) yield* acts[k]();
        },
      },
      eff: {
        *onAnyToGrave(e, _c, p, events) {
          if (getN(e, p, 'dig') >= 1) return;
          const hit = events.some((v) => v.reason === 'destroyed' && !v.byBattle && v.from === 'mz' && v.faceUp && v.controller === p && e.nameHas(v.card, 'Fossil') && isFusion(e, v.card));
          if (hit && (yield* e.yesno(p, 'Major in Paleontology: place 1 Dig Counter on the Skill?'))) addCounter(e, p);
        },
      },
    } as SkillDef;
  })();

  // ----- Wise Man Neos -----
  K['Wise Man Neos'] = (() => {
    const wise = (e: Engine, m: FieldCard) =>
      m.faceUp && (e.isNamed(m, 'Elemental HERO Neos') || (isFusion(e, m) && /"Elemental HERO Neos"/.test((info(e, m).desc ?? '').split('\n')[0])));
    return {
      *startOfDuel() {},
      eff: {
        *beforeDamageCalc(e, attacker, target, p) {
          const mine = e.controller(attacker.uid) === p ? attacker : e.controller(target.uid) === p ? target : null;
          const foe = mine === attacker ? target : attacker;
          if (!mine || !wise(e, mine) || e.controller(foe.uid) !== other(p)) return;
          const n = Math.floor(origAtk(e, foe) / 2);
          if (n <= 0 || !(yield* e.yesno(p, `Wise Man Neos: inflict ${n} damage to your opponent?`))) return;
          e.log(p, `Wise Man Neos: ${mine.name} inflicts ${n} damage`);
          e.damage(other(p), n);
        },
      },
    } as SkillDef;
  })();

  // ----- Magician's Scales -----
  K["Magician's Scales"] = (() => {
    const arcana = (e: Engine, c: Card) => e.nameHas(c, 'Arcana Force');
    const normalSpell = (e: Engine, c: Card) => info(e, c).kind === 'spell' && info(e, c).sub === 'Normal';
    const fodder = (e: Engine, p: Pid) => e.monsters(p).filter((m) => arcana(e, m) && !e.untributable(m));
    return {
      use: {
        can: (e, p) => fodder(e, p).length > 0 && e.player(p).deck.some((c) => normalSpell(e, c)),
        *run(e, p) {
          const m = yield* pickOne(e, p, "Magician's Scales: Tribute which \"Arcana Force\" monster?", fodder(e, p));
          if (!m) return;
          e.log(p, `${e.player(p).name} Tributes ${m.name}`);
          yield* e.sendToGrave(m.uid, 'tribute');
          setN(e, p, 'scales', 1);
          yield* toHandFrom(e, p, "Magician's Scales: add a Normal Spell from your Deck", e.player(p).deck.filter((c) => normalSpell(e, c)));
        },
      },
      eff: { forbidsSummon: (e, _c, ctl, monster, summoner, how) => summoner === ctl && how !== 'set' && getN(e, ctl, 'scales') === 1 && !arcana(e, monster) },
    } as SkillDef;
  })();

  // ----- Dino Brain Immunity -----
  // Position changes by Trap effects are undone when the Trap's chain link has resolved (the engine restores tags.keepPos).
  K['Dino Brain Immunity'] = (() => {
    const dino = (e: Engine, m: FieldCard) => (m.faceUp ? e.raceOf(m) : info(e, m).race) === 'Dinosaur';
    return {
      *startOfDuel() {},
      eff: {
        shields: (e, _c, m, how) => {
          if (how !== 'target' || !m.faceUp || e.raceOf(m) !== 'Dinosaur' || levelOf(e, m) < 7) return false;
          const c = e.resolvingCard();
          return !!c && info(e, c).kind === 'spell';
        },
        *onChainLink(e, _c, _p, link) {
          if (info(e, link.card).kind !== 'trap') return;
          for (const q of [0, 1] as Pid[]) for (const m of e.monsters(q)) if (dino(e, m)) tag(m).keepPos = 4 + (m.pos === 'def' ? 1 : 0) + (m.faceUp ? 0 : 2);
        },
      },
    } as SkillDef;
  })();

  // ----- Dig Site Inspection -----
  K['Dig Site Inspection'] = {
    *startOfDuel() {},
    drawPhase: {
      can: (e, p) => getN(e, p, 'digBottom') < 2 && e.player(p).deck.length > 0,
      *run(e, p) {
        const ps = e.player(p);
        const top = ps.deck[0];
        if (top) {
          e.log(p, `Dig Site Inspection: ${ps.name} excavates ${top.name}`);
          yield* e.reveal(other(p), 'Your opponent excavates the top card of their Deck', [top]);
          const k = yield* chooseOption(e, p, `Dig Site Inspection: put ${top.name} on the top or the bottom of your Deck?`, ['Top of the Deck', 'Bottom of the Deck']);
          if (k === 1 && ps.deck[0] === top) {
            ps.deck.push(ps.deck.shift()!);
            e.log(p, `${top.name} is placed on the bottom of the Deck`);
            setN(e, p, 'digBottom', getN(e, p, 'digBottom') + 1);
            if (getN(e, p, 'digBottom') >= 2) {
              ps.skillRevealed = false;
              e.log(p, 'Dig Site Inspection is flipped face-down');
            }
          } else e.log(p, `${top.name} stays on top of the Deck`);
        }
        // Then the normal draw of the Draw Phase.
        if (!e.draw(p, 1, true)) return;
        const drawn = ps.hand[ps.hand.length - 1];
        if (!drawn) return;
        e.state.fx.normalDraw = { player: p, uid: drawn.uid, turn: e.state.turn };
        for (const x of e.liveST()) if (x.eff.onDrawPhase && x.p === p && e.state.winner === null) yield* e.trig(x.c.uid, x.p, e.as(x.p, x.eff.onDrawPhase(e, x.c, x.p, [drawn])));
      },
    },
  };

  // ----- "Invitation" to the Society -----
  K['"Invitation" to the Society'] = (() => {
    type Taken = { uid: number; from: Pid; p: Pid };
    const veil = (e: Engine, c: Card) => e.isNamed(c, 'White Veil');
    const myVeilOn = (e: Engine, p: Pid, m: FieldCard) => m.equips.some((u) => {
      const eq = e.fieldCard(u);
      return !!eq && eq.faceUp && veil(e, eq) && e.controller(u) === p;
    });
    const list = (e: Engine) => (e.state.fx.inviteTaken ??= []) as Taken[];
    return {
      *startOfDuel() {},
      mayAttack: (e, p, m) => !isTurn(e, p, 'veilTurn') || m.equips.some((u) => {
        const eq = e.fieldCard(u);
        return !!eq && veil(e, eq);
      }),
      eff: {
        *onChainLink(e, _c, p, link) {
          if (link.player === p && veil(e, link.card) && !(link.payload as { effect?: string } | undefined)?.effect) setN(e, p, 'veilTurn', e.state.turn);
        },
        *stateCheck(e, _c, p) {
          // Control goes back once White Veil is no longer equipped to it.
          for (const x of list(e).slice()) {
            if (x.p !== p) continue;
            const m = e.fieldCard(x.uid);
            if (!m || e.controller(x.uid) !== p) {
              list(e).splice(list(e).indexOf(x), 1);
              continue;
            }
            if (myVeilOn(e, p, m)) continue;
            if (e.takeControl(x.uid, x.from)) {
              list(e).splice(list(e).indexOf(x), 1);
              e.log(x.from, `${m.name} returns to ${e.player(x.from).name}`);
            }
          }
          for (const m of e.monsters(other(p))) {
            if (!myVeilOn(e, p, m) || !freeMZ(e, p)) continue;
            if (e.takeControl(m.uid, p)) {
              list(e).push({ uid: m.uid, from: other(p), p });
              e.log(p, `"Invitation" to the Society: ${e.player(p).name} takes control of ${m.name}`);
            }
          }
        },
      },
    } as SkillDef;
  })();

  // ----- Mokey Mokey Madness -----
  K['Mokey Mokey Madness'] = (() => {
    const mokey = (e: Engine, c: Card) => e.nameHas(c, 'Mokey Mokey');
    const allMokey = (e: Engine, p: Pid) => e.monsters(p).length > 0 && e.monsters(p).every((m) => mokey(e, m) && mon(e, m));
    const contSpells = (e: Engine, p: Pid) => e.player(p).deck.filter((c) => mokey(e, c) && info(e, c).kind === 'spell' && info(e, c).sub === 'Continuous');
    const canPlace = (e: Engine, p: Pid) => opd(e, p, 'mokeyPlace') && faceUp(e, p, (m) => e.raceOf(m) === 'Fairy').length >= 2 && freeST(e, p) >= 0 && contSpells(e, p).length > 0;
    const kingPlans = (e: Engine, p: Pid, except = -1) => fusionPlans(e, p, (f) => e.isNamed(f, 'Mokey Mokey King') && !e.summonBlocked(p, f, 'special', 'fusion'), () => handField(e, p).filter((c) => c.uid !== except));
    const discards = (e: Engine, p: Pid) => e.player(p).hand.filter((c) => kingPlans(e, p, c.uid).length > 0);
    const canKing = (e: Engine, p: Pid) => opd(e, p, 'mokeyKing') && discards(e, p).length > 0;
    return {
      use: {
        oncePerDuel: false,
        repeat: true, // the two parts are each once per Duel
        can: (e, p) => !e.player(p).skillRevealed || canPlace(e, p) || canKing(e, p),
        *run(e, p) {
          const labels: string[] = [];
          const acts: (() => Step)[] = [];
          if (canPlace(e, p))
            labels.push('Place a "Mokey Mokey" Continuous Spell, then destroy 1 monster you control'),
              acts.push(function* () {
                const c = yield* pickOne(e, p, 'Mokey Mokey Madness: place which Continuous Spell?', contSpells(e, p));
                if (!c) return;
                useOpd(e, p, 'mokeyPlace');
                if (!placeFaceUp(e, c, p)) return;
                const m = yield* pickOne(e, p, 'Mokey Mokey Madness: destroy which monster you control?', e.monsters(p));
                if (m) yield* e.destroy([m.uid]);
              });
          if (canKing(e, p))
            labels.push('Discard 1 card to Fusion Summon "Mokey Mokey King"'),
              acts.push(function* () {
                const d = yield* pickOne(e, p, 'Mokey Mokey Madness: discard which card?', discards(e, p));
                if (!d) return;
                useOpd(e, p, 'mokeyKing');
                yield* e.discard(p, d.uid);
                yield* fusionSummon(e, p, 'Mokey Mokey Madness', kingPlans(e, p));
              });
          if (!acts.length) return; // flipping it over applies the continuous Skill
          if (e.player(p).skillUses === 1 && !(yield* e.yesno(p, 'Mokey Mokey Madness: also use one of its Once per Duel Skills now?'))) return;
          const k = acts.length === 1 ? 0 : yield* chooseOption(e, p, 'Mokey Mokey Madness: which Skill?', labels);
          if (k !== null) yield* acts[k]();
        },
      },
      eff: {
        // "If all monsters you control are Mokey Mokey monsters (min. 1), Effect Monsters cannot attack the turn they are Summoned."
        blocksAttack: (e, c, m) => !!e.player(c.owner).skillRevealed && allMokey(e, c.owner) && m.tags?.summonedTurn === e.state.turn && isEffectMonster(e, m), // engine.anySummon: any kind of Summon, incl. a Flip Summon of a monster Set earlier
      },
    } as SkillDef;
  })();

  // ----- Cyberdark Scheme -----
  K['Cyberdark Scheme'] = (() => {
    const cd = (e: Engine, c: Card) => e.nameHas(c, 'Cyberdark') && mon(e, c);
    const cdFusion = (e: Engine, m: FieldCard) => cd(e, m) && isFusion(e, m) && m.faceUp;
    /** Monster Cards in your Spell & Trap Zone equipped to a "Cyberdark" Fusion Monster you control. */
    const equips = (e: Engine, p: Pid) =>
      e.spells(p).filter((s) => {
        if (!mon(e, s) || s.equippedTo === undefined) return false;
        const host = e.fieldCard(s.equippedTo);
        return !!host && e.controller(host.uid) === p && cdFusion(e, host);
      });
    const canEquip = (e: Engine, p: Pid) => opd(e, p, 'cdsEquip') && equips(e, p).length > 0 && e.monsters(other(p)).length > 0;
    const bonus = (e: Engine, m: FieldCard) => {
      const u = m.tags?.cdsEq;
      const eq = u !== undefined && m.equips.includes(u) ? e.fieldCard(u) : null;
      return eq ? origAtk(e, eq) : 0;
    };
    return {
      use: {
        oncePerDuel: false,
        can: (e, p) => e.monsters(p).some((m) => cd(e, m)) || canEquip(e, p),
        *run(e, p) {
          const labels: string[] = [];
          const acts: (() => Step)[] = [];
          if (e.monsters(p).some((m) => cd(e, m)))
            labels.push('Return a "Cyberdark" monster to the hand, then you can Normal Summon a "Cyberdark" monster'),
              acts.push(function* () {
                const m = yield* pickOne(e, p, 'Cyberdark Scheme: return which "Cyberdark" monster to the hand?', e.monsters(p).filter((x) => cd(e, x)));
                if (!m) return;
                if (!m.faceUp) yield* e.reveal(other(p), 'Your opponent reveals', [m]);
                e.toHand(m.uid);
                e.log(p, `${m.name} is returned to the hand`);
                const nows = e.player(p).hand.filter((c) => cd(e, c) && e.canNormalSummon(p, c, true));
                if (!nows.length || !(yield* e.yesno(p, 'Cyberdark Scheme: Normal Summon a "Cyberdark" monster now?'))) return;
                const c = yield* pickOne(e, p, 'Normal Summon which "Cyberdark" monster?', nows);
                if (c) yield* normalSummonNow(e, p, c);
              });
          if (canEquip(e, p))
            labels.push('Send an equipped Monster Card to the GY, then equip 1 opponent\'s monster to that Fusion Monster'),
              acts.push(function* () {
                const s = yield* pickOne(e, p, 'Cyberdark Scheme: send which equipped Monster Card to the GY?', equips(e, p));
                if (!s || s.equippedTo === undefined) return;
                const hostUid = s.equippedTo;
                useOpd(e, p, 'cdsEquip');
                yield* e.sendToGrave(s.uid, 'cost');
                const host = e.fieldCard(hostUid);
                const t = yield* pickOne(e, p, `Cyberdark Scheme: equip which of your opponent's monsters to ${host?.name ?? 'it'}?`, e.monsters(other(p)));
                const f = t ? e.find(t.uid) : null;
                const z = freeST(e, p);
                if (!t || !f || f.loc.zone !== 'mz' || !host || !e.fieldCard(hostUid) || z < 0) return;
                for (const u of t.equips.slice()) if (e.fieldCard(u)) yield* e.sendToGrave(u, 'used');
                if (e.find(t.uid)?.loc.zone !== 'mz') return;
                const at = e.find(t.uid)!;
                e.vacateMZ(e.player(at.loc.player), at.loc.index);
                Object.assign(t, { faceUp: true, pos: 'atk', equippedTo: hostUid, active: false, atkMod: 0, defMod: 0, equips: [], counters: 0, tags: { cdsEquip: 1 }, returnAtEnd: undefined });
                e.player(p).sz[z] = t;
                host.equips.push(t.uid);
                tag(host).cdsEq = t.uid;
                e.event('to-gy', { uid: t.uid, player: p });
                e.log(p, `${t.name} is equipped to ${host.name}`);
              });
          const k = acts.length === 1 ? 0 : yield* chooseOption(e, p, 'Cyberdark Scheme: which Skill?', labels);
          if (k !== null) yield* acts[k]();
        },
      },
      aura: (e, p, m) => {
        if (e.controller(m.uid) !== p || !cdFusion(e, m)) return undefined;
        const b = bonus(e, m);
        return b ? { atk: b, def: 0 } : undefined;
      },
    } as SkillDef;
  })();

  // ----- Shouldering a Destiny -----
  K['Shouldering a Destiny'] = (() => {
    const plasma = (e: Engine, c: Card) => e.isNamed(c, 'Destiny HERO - Plasma') && mon(e, c);
    /** The Skill is face-up on the field as a Continuous Spell (a token card) and you control "Destiny HERO - Plasma". */
    const card = (e: Engine, p: Pid) => {
      const u = getN(e, p, 'destinyCard') - 1;
      const fc = u >= 0 ? e.fieldCard(u) : null;
      return fc && fc.faceUp && e.controller(fc.uid) === p && !e.spellsNegated() ? fc : null;
    };
    const on = (e: Engine, p: Pid) => !!card(e, p) && faceUp(e, p, (m) => plasma(e, m)).length > 0;
    const mine = (e: Engine, p: Pid, m: FieldCard) => m.faceUp && plasma(e, m) && e.controller(m.uid) === p;
    return {
      *startOfDuel(e, p) {
        // Draw 1 less card: the last card drawn goes back on top of the Deck.
        const hand = e.player(p).hand;
        if (hand.length) e.toDeckTop(hand[hand.length - 1].uid);
        e.player(p).skillRevealed = false;
      },
      use: {
        phase: 'main',
        can: (e, p) => freeST(e, p) >= 0,
        *run(e, p) {
          const fc = e.placeSkillCard('Shouldering a Destiny', p, 'sz');
          if (!fc) return;
          setN(e, p, 'destinyCard', fc.uid + 1);
          e.log(p, `${e.player(p).name} activates Shouldering a Destiny as a Continuous Spell`);
          const list = [...e.player(p).deck, ...e.player(p).gy].filter((c) => plasma(e, c));
          if (list.length && (yield* e.yesno(p, 'Shouldering a Destiny: add "Destiny HERO - Plasma" from your Deck or GY to your hand?'))) yield* toHandFrom(e, p, 'Add "Destiny HERO - Plasma"', list, true);
        },
      },
      aura: (e, p, m) => {
        if (!on(e, p) || !mine(e, p, m)) return undefined;
        const n = [...e.player(0).gy, ...e.player(1).gy].filter((c) => mon(e, c)).length;
        return n ? { atk: 100 * n, def: 0 } : undefined;
      },
      extraAttacks: (e, p, m) => (on(e, p) && mine(e, p, m) ? 1 : 0),
      eff: { shields: (e, _c, m, how, ctl) => how === 'effect' && on(e, ctl) && mine(e, ctl, m) && e.actor === other(ctl) },
      // "You cannot draw during the Draw Phase": checked at the end of the opponent's turn, right before your Draw Phase.
      *onEndPhase(e, p) {
        if (e.state.turnPlayer !== other(p) || !on(e, p)) return;
        e.state.fx.skipDraw = p;
      },
    } as SkillDef;
  })();
}

