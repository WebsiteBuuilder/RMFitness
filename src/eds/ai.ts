// The computer duelist. It plays by the same rules through the same actions a
// human would send, with simple but sensible priorities like the GBA opponents.
// Optional plays with a price (Skills, effects with costs, Extra Deck Summons) are first
// tried on a throwaway copy of the duel (aiEval.ts) so it never pays more than it gets.
import type { Engine } from './engine';
import { other } from './engine';
import { getEffect } from './effects';
import type { Action, FieldCard, Pid, Prompt } from './types';
import { getSkill } from './skills';
import { DEFAULT_TACTICS, type Tactics } from './tactics';
import { attackPlan, attackers, coin, lethalPlan, lookahead, lookaheadAnswer, lookaheadCombo, rolloutTurn, wall } from './aiEval';
import { skillDrawOk, skillVerdict } from './aiSkills';

/** Moves the computer already tried this turn (so a cancelled or declined effect is not retried forever). */
const TRIED = new Set<string>();
/** How much better (in board value) Hard's planned Summon must be than its usual pick. */
const PLAN_MARGIN = 150;

const GOOD_ANYTIME = new Set(['Pot of Greed', 'Graceful Charity', 'Dian Keto the Cure Master', 'Red Medicine', "Goblin's Secret Remedy", 'Sparks', 'Hinotama', 'Final Flame', 'Ookazi', 'Tremendous Fire', 'Swords of Revealing Light', 'Just Desserts', 'Mooyan Curry', 'Blue Medicine', 'Soul of the Pure', 'Raimei', 'Fusion Sage', 'Elegant Egotist', 'Polymerization', 'Painful Choice', 'Delinquent Duo', 'Confiscation', 'Dark-Piercing Light', 'Messenger of Peace']);
/** Draw spells: not with the Deck nearly empty (drawing out loses the Duel). */
const DRAWS: Record<string, number> = { 'Pot of Greed': 2, 'Graceful Charity': 3 };
/** Cards that destroy a class of monsters: worth it when they hit more of theirs than ours. */
const WIPES: Record<string, (e: Engine, m: FieldCard) => boolean> = {
  'Warrior Elimination': (e, m) => e.info(m.name).race === 'Warrior',
  'Eradicating Aerosol': (e, m) => e.info(m.name).race === 'Insect',
  'Acid Rain': (e, m) => m.faceUp && e.info(m.name).race === 'Machine',
  'Breath of Light': (e, m) => m.faceUp && e.info(m.name).race === 'Rock',
  'Eternal Rest': (_e, m) => m.equips.length > 0,
};
/** A selection the computer would rather cancel than make (a buff for the opponent, a debuff for itself). */
const BAD = -1e6;

/** `t` is a pep talk read into tactics (Practice: the computer vs itself) plus the difficulty; without one it plays its usual way. */
export function aiAction(e: Engine, me: Pid, t: Tactics = DEFAULT_TACTICS): Action | null {
  const s = e.state;
  if (s.winner !== null) return null;
  const opp = other(me);
  const my = e.player(me);
  const their = e.player(opp);
  const prompt = s.prompt;
  const level = t.level ?? 'normal';
  const easy = level === 'easy';
  const hard = level === 'hard';

  if (prompt) {
    if (prompt.player !== me) return null;
    if (prompt.kind === 'yesno') return { type: yesNo(e, me, prompt.title) ? 'YES' : 'NO', player: me };
    if (prompt.kind === 'response') {
      // Don't spring defensive traps (Waboku, Negate Attack...) on your own attacks.
      if (s.turnPlayer === me && / attacks( .+)?\. Respond\?$/.test(prompt.title)) return { type: 'PASS', player: me };
      // Told to save traps: only answer a big attacker or a hit that would finish us.
      const atk = prompt.title.match(/^(.*?) attacks(?: .+)?\. Respond\?$/);
      if (t.traps === 'hold' && atk) {
        const a = e.monsters(opp).find((m) => m.name === atk[1]);
        const power = a ? e.atkOf(a) : (e.info(atk[1]).atk ?? 0);
        const target = s.battle?.target != null ? e.fieldCard(s.battle.target) : null;
        // A hit on a monster it would destroy is worth a trap too.
        const kills = target && target.faceUp && power > wall(e, target) && wall(e, target) >= 1500;
        if (power < 1800 && power < my.lp && !kills) return { type: 'PASS', player: me };
      }
      // Otherwise try each set card on a copy of the duel and spring the one that helps most, if any
      // helps more than letting it go (no Wild Tornado on its own Toon World, no Dicephoon gamble for nothing).
      // (Quick-Play Spells offered straight from the hand stay there: the computer plays those in its Main Phase.)
      const ks = prompt.options.map((o, i) => (o.value !== 'hand' ? i : -1)).filter((i) => i >= 0);
      if (!ks.length) return { type: 'PASS', player: me };
      const policy = (x: Engine, p: Pid) => aiAction(x, p, t);
      const pass = easy ? null : lookaheadAnswer(e, me, { type: 'PASS', player: me }, policy);
      if (pass === null) return { type: 'CHOOSE', player: me, picks: [ks[0]] };
      let best = -1;
      let bestVal = pass + 150;
      for (const k of ks) {
        const v = lookaheadAnswer(e, me, { type: 'CHOOSE', player: me, picks: [k] }, policy);
        if (v !== null && v > bestVal) (best = k), (bestVal = v);
      }
      return best >= 0 ? { type: 'CHOOSE', player: me, picks: [best] } : { type: 'PASS', player: me };
    }
    // Selection: rank options by context.
    const { order: ranked, val } = rankOptions(e, me, prompt.title, prompt.options);
    const need = prompt.title.match(/^Ritual: .*Level (\d+)/);
    if (need) {
      const target = Number(need[1]);
      const picks: number[] = [];
      let total = 0;
      for (const i of ranked) {
        if (total >= target) break;
        picks.push(i);
        total += e.info(prompt.options[i].label).level ?? 1;
      }
      return total >= target ? { type: 'CHOOSE', player: me, picks } : { type: 'CANCEL', player: me };
    }
    const picks = ranked.slice(0, Math.max(prompt.min, Math.min(prompt.max, prompt.min || 1)));
    if (picks.length < prompt.min && prompt.cancel) return { type: 'CANCEL', player: me };
    // Never equip the opponent's monster with a boost (or our own with a curse) when we can back out.
    if (prompt.cancel && picks.some((i) => val[i] < BAD / 2)) return { type: 'CANCEL', player: me };
    return { type: 'CHOOSE', player: me, picks };
  }

  if (s.turnPlayer !== me) return null;
  const tryOnce = (key: string) => {
    const k = `${s.seed}:${s.turn}:${me}:${key}`;
    if (TRIED.has(k)) return false;
    TRIED.add(k);
    if (TRIED.size > 500) TRIED.clear();
    return true;
  };
  // A play turned down is looked at again once the board, hands or LP change.
  const sig = () => `${e.monsters(me).length}.${my.hand.length}.${e.monsters(opp).length}.${my.lp}.${their.lp}.${my.gy.length}`;
  const tried = (key: string) => TRIED.has(`${s.seed}:${s.turn}:${me}:${key}`) || TRIED.has(`${s.seed}:${s.turn}:${me}:no:${key}:${sig()}`);
  const decline = (key: string) => tryOnce(`no:${key}:${sig()}`);
  /** A play with a price: only when a lookahead says it's worth at least `min` (a won Duel is worth everything). */
  const worth = (a: Action, min = -100) => {
    const d = lookahead(e, me, a, (x, p) => aiAction(x, p, t));
    return d === null || d >= min;
  };
  // Running out of Deck: whoever has fewer cards left has to force the issue; the other plays safe.
  const decking = my.deck.length <= 5 && my.deck.length <= their.deck.length;
  const outlast = their.deck.length <= 3 && my.deck.length > their.deck.length + 1;
  const late = s.turn >= 12;
  // Low on Life Points and told to guard them: play it safe from here.
  const guarding = (t.guardLp && my.lp <= 1500) || outlast;
  const bold = (easy ? 1 : 0) + (decking || late ? 1 : 0);
  const attack = guarding ? Math.min(t.attack, -1) : Math.min(2, t.attack + bold);
  const wallUp = t.wall || guarding;
  const myMonsters = e.monsters(me);
  const theirMonsters = e.monsters(opp);
  const theirBest = Math.max(0, ...theirMonsters.map((m) => (m.faceUp ? (m.pos === 'atk' ? e.atkOf(m) : e.defOf(m)) : 1200)));

  // A card the computer backed out of this turn (no fitting target or Ritual materials) stays where it is.
  const canAct = (uid: number) => e.canActivateMain(me, uid) && !e.takenBackThisTurn(uid) && !(e.find(uid)?.card.name === 'Mind Crush' && e.player(opp).hand.length === 0);
  if (e.inMainPhase()) {
    // 1. Draw / heal / burn spells.
    for (const c of my.hand) {
      if (GOOD_ANYTIME.has(c.name) && canAct(c.uid)) {
        if (c.name === 'Swords of Revealing Light' && theirMonsters.length === 0) continue;
        if (DRAWS[c.name] && my.deck.length <= DRAWS[c.name] + 1) continue;
        return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
      }
    }
    // 2. Board wipes when behind on the board.
    for (const c of my.hand) {
      if ((c.name === 'Raigeki' || c.name === 'Dark Hole' || c.name === "Harpie's Feather Duster" || c.name === 'Heavy Storm') && canAct(c.uid)) {
        const myBest = Math.max(0, ...myMonsters.map((m) => e.atkOf(m)));
        if (c.name === 'Raigeki' && theirMonsters.length >= 1 && theirBest >= myBest) return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
        if (c.name === 'Dark Hole' && theirMonsters.length > myMonsters.length && theirBest >= myBest) return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
        if ((c.name === "Harpie's Feather Duster" || c.name === 'Heavy Storm') && e.spells(opp).length >= 2 && e.spells(me).length === 0) return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
      }
    }
    // 3. Revive the best monster in a graveyard.
    for (const c of my.hand) {
      if ((c.name === 'Monster Reborn' || c.name === 'Premature Burial' || c.name === 'Change of Heart' || c.name === 'Snatch Steal') && canAct(c.uid)) {
        if (c.name === 'Change of Heart' || c.name === 'Snatch Steal') {
          if (theirMonsters.some((m) => m.faceUp && e.atkOf(m) >= 1500)) return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
          continue;
        }
        const pool = c.name === 'Monster Reborn' ? [...my.gy, ...their.gy] : my.gy;
        if (pool.some((g) => (e.info(g.name).atk ?? 0) >= 1800)) return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
      }
    }
    // 3b. Ritual Summons, type wipes, Field Spells and monster effects.
    for (const c of my.hand) {
      const info = e.info(c.name);
      if (!canAct(c.uid)) continue;
      if (info.sub === 'Ritual' && info.kind === 'spell') return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
      const wipe = WIPES[c.name];
      if (wipe && theirMonsters.filter((m) => wipe(e, m)).length > myMonsters.filter((m) => wipe(e, m)).length) return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
      if (info.sub === 'Field' && !my.field) {
        const aura = getEffect(c.name)?.aura;
        const fake = { ...c, pos: 'atk', faceUp: true, active: true, placedTurn: 0, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0 } as FieldCard;
        const gain = (list: FieldCard[]) => list.reduce((a, m) => a + (aura?.(e, fake, m, me)?.atk ?? 0), 0);
        if (aura && gain(myMonsters) > gain(theirMonsters)) return { type: 'ACTIVATE', player: me, uid: c.uid };
      }
      if ((c.name === 'Giant Trunade' || c.name === 'Tribute to the Doomed') && e.spells(opp).length >= 2 && e.spells(me).length === 0) return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
    }
    for (const m of myMonsters) {
      if (!e.canUseMonsterEffect(me, m)) continue;
      const myBest = Math.max(0, ...myMonsters.map((x) => e.atkOf(x)));
      if (m.name === 'Cannon Soldier' && (their.lp <= 500 * myMonsters.length || myMonsters.some((x) => x.uid !== m.uid && e.atkOf(x) < 1000 && e.atkOf(x) < theirBest))) return { type: 'MONSTER_EFFECT', player: me, uid: m.uid };
      if (m.name === 'Time Wizard' && theirMonsters.length >= 2 && theirBest > myBest) return { type: 'MONSTER_EFFECT', player: me, uid: m.uid };
      if (m.name === 'Barrel Dragon' && theirMonsters.some((x) => x.faceUp)) return { type: 'MONSTER_EFFECT', player: me, uid: m.uid };
    }
    // Special Summon procedures (Gate Guardian, Toons, the moth line...) and hand effects.
    for (const c of my.hand) {
      if (e.canSpecialProc(me, c)) {
        const atk = e.info(c.name).atk ?? 0;
        const myBest = Math.max(0, ...myMonsters.map((x) => e.atkOf(x)));
        if (atk >= 1500 && atk > myBest) return { type: 'SPECIAL', player: me, uid: c.uid };
      }
      if ((c.name === 'Thunder Dragon' || c.name === 'Cocoon of Evolution') && e.canUseMonsterEffect(me, c)) return { type: 'MONSTER_EFFECT', player: me, uid: c.uid };
    }
    // Monster effects that are simply good to use.
    for (const m of myMonsters) {
      if (!e.canUseMonsterEffect(me, m)) continue;
      if (m.name === 'Relinquished' && theirMonsters.some((t) => e.atkOf(t) >= 1500)) return { type: 'MONSTER_EFFECT', player: me, uid: m.uid };
      if (m.name === 'Monster Eye' && my.lp > 3000 && !my.hand.some((c) => c.name === 'Polymerization')) return { type: 'MONSTER_EFFECT', player: me, uid: m.uid };
      if (m.name === 'Catapult Turtle' && their.lp <= Math.max(...myMonsters.filter((x) => x.uid !== m.uid).map((x) => Math.floor(e.atkOf(x) / 2)), 0)) return { type: 'MONSTER_EFFECT', player: me, uid: m.uid };
    }
    // Speed Duel: the computer plays the modern cards generically (each move tried once per turn),
    // but only the ones that don't cost more than they give.
    if (e.speed) {
      const sk = my.skill ? getSkill(my.skill) : undefined;
      const skillOk = t.skill === 'normal' || (t.skill === 'save' && (my.lp < their.lp || s.turn >= 7));
      if (skillOk && e.canUseSkill(me) && sk?.ai !== false && (typeof sk?.ai !== 'function' || sk.ai(e, me)) && !tried('skill')) {
        const v = skillVerdict(e, me, my.skill!);
        const act: Action = { type: 'SKILL', player: me };
        if (v === true || ((v === 'sim' || typeof v === 'object') && worth(act, typeof v === 'object' ? v.sim : 0))) {
          tryOnce('skill');
          return act;
        }
        decline('skill');
      }
      const cands: { key: string; act: Action; min: number }[] = [];
      // How much a play may cost right now: the card it uses up (a spell from the hand, a monster discarding itself) is its normal price.
      for (const c of my.hand) if (e.canSpecialProc(me, c)) cands.push({ key: `sp${c.uid}`, act: { type: 'SPECIAL', player: me, uid: c.uid }, min: -100 });
      // Xyz, Synchro and Link Summons: the strongest one that beats what the materials could do on their own.
      const myBest = Math.max(0, ...myMonsters.map((x) => e.atkOf(x)));
      const extras = my.fusion.filter((c) => e.canSpecialProc(me, c)).sort((a, b) => (e.info(b.name).atk ?? 0) - (e.info(a.name).atk ?? 0));
      for (const c of extras) {
        const atk = e.info(c.name).atk ?? 0;
        // An Easy duelist sometimes forgets its Extra Deck.
        if (easy && coin(e, `x${c.uid}`, 0.4)) continue;
        if (atk >= myBest + 300 || atk >= 2400 || theirBest >= myBest) cands.push({ key: `xsp${c.uid}`, act: { type: 'SPECIAL', player: me, uid: c.uid }, min: -200 });
      }
      for (const c of my.hand) {
        const info = e.info(c.name);
        if (info.kind === 'spell' && info.sub !== 'Equip' && !(info.sub === 'Field' && my.field) && canAct(c.uid)) cands.push({ key: `act${c.uid}`, act: { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) }, min: -350 });
      }
      for (const m of myMonsters) if (e.canUseMonsterEffect(me, m)) cands.push({ key: `eff${m.uid}`, act: { type: 'MONSTER_EFFECT', player: me, uid: m.uid }, min: -100 });
      for (const c of my.hand) if (e.canUseMonsterEffect(me, c)) cands.push({ key: `heff${c.uid}`, act: { type: 'MONSTER_EFFECT', player: me, uid: c.uid }, min: -350 });
      for (const c of my.gy) if (e.canUseGraveEffect(me, c.uid)) cands.push({ key: `gy${c.uid}`, act: { type: 'GRAVE_EFFECT', player: me, uid: c.uid }, min: -150 });
      for (const c of [...my.sz, my.field]) if (c && c.faceUp && e.canUseMonsterEffect(me, c)) cands.push({ key: `st${c.uid}`, act: { type: 'MONSTER_EFFECT', player: me, uid: c.uid }, min: -100 });
      const fresh = cands.filter((x) => !tried(x.key));
      if (hard && fresh.length > 1) {
        // Hard: weigh every option and play the best one.
        let best: { c: (typeof fresh)[number]; d: number } | null = null;
        for (const c of fresh) {
          let d = lookahead(e, me, c.act, (x, p) => aiAction(x, p, t)) ?? 0;
          // not worth it alone: maybe it opens a Summon (Toon World, then a Toon)
          if (d < c.min && c.act.type !== 'SPECIAL') d = lookaheadCombo(e, me, c.act, (x, p) => aiAction(x, p, t)) ?? d;
          if (d < c.min) decline(c.key); // not worth it now
          else if (!best || d > best.d) best = { c, d };
        }
        if (best && tryOnce(best.c.key)) return best.c.act;
      } else {
        for (const c of fresh) {
          if (worth(c.act, c.min) || (!easy && c.act.type !== 'SPECIAL' && (lookaheadCombo(e, me, c.act, (x, p) => aiAction(x, p, t)) ?? -Infinity) >= c.min + 400)) {
            tryOnce(c.key);
            return c.act;
          }
          decline(c.key);
        }
      }
    }
    // Our attackers can clear their side this turn: anything else we put out face-up hits them directly.
    const clearing = !s.firstTurn && !wallUp && (theirMonsters.length === 0 || attackPlan(e, me).steps.filter((x) => x.target !== null).length >= theirMonsters.length);
    // 4. Hard: try each Summon (Attack or Set) on a copy and play out the turn it leads to; the one
    // leaving the best board, after what their monsters could do back, wins (when clearly better
    // than the usual pick).
    if (hard && !my.normalSummoned && s.phase === 'M1' && !tried(`plan:${sig()}`)) {
      tryOnce(`plan:${sig()}`);
      const pick = planSummon(e, me, t);
      if (pick) return pick;
    }
    // 4. Normal Summon the strongest monster possible (tribute only for an upgrade).
    if (!my.normalSummoned) {
      const candidates = my.hand.filter((c) => e.canNormalSummon(me, c)).map((c) => ({ c, info: e.info(c.name) }));
      // (an Easy duelist just takes them in hand order)
      if (!easy) candidates.sort((a, b) => (b.info.atk ?? 0) - (a.info.atk ?? 0));
      const myBest = Math.max(0, ...myMonsters.map((m) => e.atkOf(m)));
      for (const { c, info } of candidates) {
        const need = e.tributesNeeded(info.level ?? 1);
        if (need > 0 && t.tribute < 0) continue; // told never to tribute
        if (need > 0 && (info.atk ?? 0) < myBest + (t.tribute > 0 ? 1 : 600)) continue; // not worth the tribute
        if (need > myMonsters.length) continue;
        const zone = e.freeMonsterZone(me);
        if (zone < 0 && need === 0) break;
        const atk = info.atk ?? 0;
        const def = info.def ?? 0;
        const flip = !!getEffect(c.name)?.flip;
        if (clearing && !flip && atk >= 800 && e.canNormalSummon(me, c, true)) return { type: 'SUMMON', player: me, uid: c.uid, zone, pos: 'atk', faceUp: true };
        // Set weak or flip monsters; summon anything that can fight (Set it when it cannot be Summoned face-up right now).
        if (flip || (atk < theirBest && def >= atk) || !e.canNormalSummon(me, c, true)) return { type: 'SUMMON', player: me, uid: c.uid, zone, pos: 'def', faceUp: false };
        // A defensive talk sets anything that doesn't clearly win; an attacking one shows more monsters face-up.
        if (wallUp && !(atk > theirBest + 300 && theirMonsters.length > 0)) return { type: 'SUMMON', player: me, uid: c.uid, zone, pos: 'def', faceUp: false };
        if (atk >= theirBest - (attack > 0 ? 300 * attack : 0) || theirMonsters.length === 0) return { type: 'SUMMON', player: me, uid: c.uid, zone, pos: 'atk', faceUp: true };
        return { type: 'SUMMON', player: me, uid: c.uid, zone, pos: 'def', faceUp: def > atk };
      }
    }
    // 5. Flip Summon strong face-down monsters; switch positions sensibly.
    for (const m of myMonsters) {
      const fresh = m.placedTurn !== s.turn && !m.posChanged && !m.attacked;
      if (!fresh) continue;
      if (!m.faceUp && !e.summonBlocked(me, m, 'flip', 'mz') && (e.atkOf(m) >= theirBest || getEffect(m.name)?.flip || (clearing && e.atkOf(m) >= 800))) return { type: 'FLIP_SUMMON', player: me, uid: m.uid };
      if (m.cannotChangePos || (m.faceUp && !e.canChangePosition(me, m))) continue;
      if (m.faceUp && m.name === 'Dream Clown' && m.pos === 'atk' && theirMonsters.length > 0) return { type: 'CHANGE_POS', player: me, uid: m.uid };
      if (m.faceUp && m.name === 'Crass Clown' && m.pos === 'def' && theirMonsters.length > 0) return { type: 'CHANGE_POS', player: me, uid: m.uid };
      if (m.faceUp && m.pos === 'def' && (e.atkOf(m) > theirBest || (clearing && e.atkOf(m) >= 800)) && s.phase === 'M1') return { type: 'CHANGE_POS', player: me, uid: m.uid };
      if (m.faceUp && m.pos === 'atk' && e.atkOf(m) < theirBest && e.defOf(m) > e.atkOf(m) && s.phase === 'M2') return { type: 'CHANGE_POS', player: me, uid: m.uid };
    }
    // 6. Equip cards: boosts go on our own monsters, curses on theirs (and only when there is one to take them).
    for (const c of my.hand) {
      const info = e.info(c.name);
      if (info.kind === 'spell' && info.sub === 'Equip' && canAct(c.uid) && equipTarget(e, me, c.name) && tryOnce(`eq${c.uid}`)) return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
    }
    // 7. Set traps and quick-plays face-down.
    for (const c of my.hand) {
      const info = e.info(c.name);
      if ((info.kind === 'trap' || (info.kind === 'spell' && info.sub === 'Quick-Play')) && getEffect(c.name) && e.canSet(me, c)) return { type: 'SET_ST', player: me, uid: c.uid, zone: freeZone(my.sz) };
    }
    // 8. Move on.
    if (s.phase === 'M1' && !s.firstTurn && myMonsters.some((m) => e.canAttackWith(me, { ...m }) || (m.faceUp && m.pos === 'atk' && !m.attacked))) return { type: 'NEXT_PHASE', player: me };
    return { type: 'END_TURN', player: me };
  }

  if (s.phase === 'BP') {
    // Lethal on board: take it (Easy duelists don't count it out).
    if (!easy) {
      const plan = lethalPlan(e, me);
      const step = plan?.steps.find((x) => {
        const m = e.fieldCard(x.uid);
        return m && e.canAttackWith(me, m) && (x.target === null ? theirMonsters.length === 0 || e.canAttackDirectly(m) : e.legalTargets(me, m).some((y) => y.uid === x.target));
      });
      if (step) return { type: 'ATTACK', player: me, uid: step.uid, target: step.target };
    }
    // Set cards on their side: lead with the weaker monsters so a trap hits the less valuable one.
    const setBackrow = e.spells(opp).filter((c) => !c.faceUp).length;
    const order = attackers(e, me).sort((a, b) => (setBackrow && !easy ? e.atkOf(a) - e.atkOf(b) : e.atkOf(b) - e.atkOf(a)));
    for (const m of [...order, ...myMonsters.filter((x) => !order.includes(x))]) {
      if (!e.canAttackWith(me, m)) continue;
      const atk = e.atkOf(m);
      if (theirMonsters.length === 0 || e.canAttackDirectly(m)) return { type: 'ATTACK', player: me, uid: m.uid, target: null };
      if (m.name === 'Dark Elf' && my.lp <= 2000) continue;
      // Best target: a monster we beat, preferring the biggest attack-position one; face-downs when we are strong.
      const legal = e.legalTargets(me, m);
      // How sure an attack must be: all-out takes even trades and swings into face-downs; careful wants a clear margin.
      const margin = attack >= 2 ? -1 : attack <= -1 ? 300 : 0;
      const blind = attack >= 2 ? 1200 : attack >= 1 ? 1400 : attack <= -1 ? 2000 : 1600;
      const beatable = legal.filter((x) => (x.faceUp ? (x.pos === 'atk' ? atk > e.atkOf(x) + margin : atk > e.defOf(x) + Math.max(0, margin)) : atk >= blind));
      if (beatable.length) {
        if (t.target === 'weakest') beatable.sort((a, b) => score(e, a) - score(e, b));
        else if (t.target === 'biggest') beatable.sort((a, b) => (b.faceUp ? e.atkOf(b) : 0) - (a.faceUp ? e.atkOf(a) : 0));
        else beatable.sort((a, b) => score(e, b) - score(e, a));
        return { type: 'ATTACK', player: me, uid: m.uid, target: beatable[0].uid };
      }
    }
    return { type: 'NEXT_PHASE', player: me };
  }
  return { type: 'NEXT_PHASE', player: me };
}

/** Yes/no questions: Draw Phase Skills by their policy; never pay LP we can't spare. */
function yesNo(e: Engine, me: Pid, title: string): boolean {
  const sk = title.match(/^Use your Skill (.*) instead of drawing\?$/);
  if (sk) return skillDrawOk(e, me, sk[1]);
  const pay = title.match(/pay (\d+) (?:LP|Life Points)/i);
  if (pay && e.player(me).lp <= Number(pay[1]) + 500) return false;
  const half = /pay half (?:your|of your) (?:LP|Life Points)/i.test(title);
  if (half && e.player(me).lp <= 1000) return false;
  return true;
}

function score(e: Engine, t: FieldCard): number {
  if (!t.faceUp) return 500;
  return t.pos === 'atk' ? e.atkOf(t) + 1000 : e.defOf(t);
}

function freeZone(zones: (FieldCard | null)[]): number {
  return zones.findIndex((z) => z === null);
}

/** How an Equip Card treats the monster it goes on: > 0 helps it, < 0 hurts it (taking control counts as hurting its owner). */
export function equipSign(e: Engine, eqName: string, host: FieldCard): number {
  const eff = getEffect(eqName);
  if (eff?.equipBonus) {
    try {
      const fake = { uid: -1, name: eqName, owner: host.owner, pos: 'atk', faceUp: true, placedTurn: 0, attacked: false, posChanged: false, atkMod: 0, defMod: 0, equips: [], counters: 0, equippedTo: host.uid } as FieldCard;
      const b = eff.equipBonus(e, fake, host);
      const v = b.atk + b.def / 2;
      if (v !== 0) return v;
    } catch {
      /* fall back to the text */
    }
  }
  const d = e.info(eqName).desc ?? '';
  const gains = /gains? \d+ ATK|increase|ATK becomes double|cannot be destroyed/i.test(d);
  const hurts = /take control|loses? \d+ ATK|decrease|halve|cannot (?:attack|declare an attack|change its battle position)|destroy the equipped|negate the effects of the equipped/i.test(d);
  return hurts && !gains ? -1 : 1;
}

/** An Equip Card has a monster it should go on (ours for a boost, theirs for a curse). */
function equipTarget(e: Engine, me: Pid, eqName: string): boolean {
  for (const p of [0, 1] as Pid[]) for (const m of e.monsters(p)) if (m.faceUp && (equipSign(e, eqName, m) > 0) === (p === me)) return true;
  return false;
}

/** Orders prompt options from best to worst for the computer, by what the prompt is for. */
function rankOptions(e: Engine, me: Pid, title: string, options: Extract<Prompt, { kind: 'select' }>['options']): { order: number[]; val: number[] } {
  const idx = options.map((_, i) => i);
  const eq = title.match(/^Equip (.+) to which monster\?$/);
  const val = idx.map((i) => {
    const o = options[i];
    const name = o.label;
    const info = e.info(name);
    const atk = info.atk ?? 0;
    const theirs = o.loc?.player !== undefined && o.loc.player !== me;
    const fc = o.uid !== undefined ? e.fieldCard(o.uid) : null;
    const owner = fc ? e.controller(fc.uid) : o.loc?.player;
    const mine = owner === me;
    const power = fc ? Math.max(e.atkOf(fc), e.defOf(fc)) : atk;
    // Mind Crush: name a card from their deck list, not the alphabet's first.
    if (/^Mind Crush: declare/.test(title)) {
      const opp = other(me);
      return [...e.player(opp).deck, ...e.player(opp).hand].filter((c) => c.name === name).length * 1000 - [...e.player(me).hand].filter((c) => c.name === name).length;
    }
    // Battle replay: attack directly if it can, else the target it beats with the least risk; never into a loss.
    if (/^Replay: /.test(title)) {
      const a = e.state.battle ? e.fieldCard(e.state.battle.attacker) : null;
      if (o.value === 'direct') return 1e6;
      if (!a || !fc) return BAD;
      const w = fc.faceUp ? (fc.pos === 'atk' ? e.atkOf(fc) : e.defOf(fc)) : 1500;
      return e.atkOf(a) > w ? 10000 + w : BAD + w;
    }
    if (/^Ritual:/.test(title)) return (info.level ?? 1) * 1000 - power; // high Level, low value
    if (/Fusion Summon which/i.test(title)) return power;
    // Equip Cards: boosts on our monsters, curses on theirs.
    if (eq && fc) return (equipSign(e, eq[1], fc) > 0) === mine ? 10000 + power : BAD + power;
    if (/Tribute|discard|Discard|Hand limit/i.test(title)) return -power; // give up the weakest
    if (/destroy|Destroy|Take control|Snatch|Trap Hole/i.test(title)) return theirs ? power : -power - 5000;
    if (/Special Summon|Return which|add a monster/i.test(title)) return power;
    if (/Equip/i.test(title)) return fc ? (mine ? 10000 + power : power) : power;
    if (/return up to/i.test(title)) return theirs ? power : -power - 5000;
    // Boosts and weakenings on the field: ours gain, theirs lose.
    if (fc && /\bgains?\b|\bincrease/i.test(title) && !/\blos[es]/i.test(title)) return mine ? 10000 + power : BAD + power;
    if (fc && /\blos(?:e|es)\b|\bdecrease|\bhalve|cannot attack/i.test(title)) return mine ? BAD + power : 10000 + power;
    if (fc && /change .*position/i.test(title)) return mine ? -power : power;
    // Giving up our own cards (shuffling them away, banishing them, sending them): the least useful first.
    if (!theirs && !fc && /shuffle|banish|send .* to the GY|bottom of/i.test(title) && !/Special Summon|add/i.test(title)) return -power;
    return power;
  });
  idx.sort((a, b) => val[b] - val[a]);
  return { order: idx, val };
}

/** Hard's Summon planner (see step 4): null to leave it to the usual pick. */
function planSummon(e: Engine, me: Pid, t: Tactics): Action | null {
  const my = e.player(me);
  const zone = e.freeMonsterZone(me);
  const opts: Action[] = [];
  for (const c of my.hand) {
    if (!e.canNormalSummon(me, c)) continue;
    const need = e.tributesNeeded(e.info(c.name).level ?? 1);
    if (need > e.monsters(me).length || (need === 0 && zone < 0)) continue;
    const z = zone < 0 ? 0 : zone;
    if (e.canNormalSummon(me, c, true)) opts.push({ type: 'SUMMON', player: me, uid: c.uid, zone: z, pos: 'atk', faceUp: true });
    opts.push({ type: 'SUMMON', player: me, uid: c.uid, zone: z, pos: 'def', faceUp: false });
  }
  if (opts.length < 2) return null;
  // the rest of the turn is played the usual way; the sims mustn't use up this turn's real "tried once" marks
  const normal: Tactics = { ...t, level: 'normal' };
  const saved = new Set(TRIED);
  const policy = (x: Engine, p: Pid) => aiAction(x, p, normal);
  try {
    const usual = aiAction(e, me, normal);
    restore(saved);
    const base = usual ? rolloutTurn(e, me, usual, policy) : null;
    restore(saved);
    let best: { a: Action; v: number } | null = null;
    for (const a of opts.slice(0, 10)) {
      const v = rolloutTurn(e, me, a, policy);
      restore(saved);
      if (v !== null && (!best || v > best.v)) best = { a, v };
    }
    if (!best) return null;
    if (base !== null && best.v < base + PLAN_MARGIN) return null;
    return best.a;
  } finally {
    restore(saved);
  }
}

function restore(saved: Set<string>) {
  TRIED.clear();
  for (const k of saved) TRIED.add(k);
}
