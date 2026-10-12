// The computer duelist. It plays by the same rules through the same actions a
// human would send, with simple but sensible priorities like the GBA opponents.
import type { Engine } from './engine';
import { other } from './engine';
import { getEffect } from './effects';
import type { Action, FieldCard, Pid } from './types';
import { getSkill } from './skills';

/** Speed Duel moves the computer already tried this turn (so a cancelled effect is not retried forever). */
const TRIED = new Set<string>();

const GOOD_ANYTIME = new Set(['Pot of Greed', 'Graceful Charity', 'Dian Keto the Cure Master', 'Red Medicine', "Goblin's Secret Remedy", 'Sparks', 'Hinotama', 'Final Flame', 'Ookazi', 'Tremendous Fire', 'Swords of Revealing Light', 'Just Desserts', 'Mooyan Curry', 'Blue Medicine', 'Soul of the Pure', 'Raimei', 'Fusion Sage', 'Elegant Egotist', 'Polymerization', 'Painful Choice', 'Delinquent Duo', 'Confiscation', 'Dark-Piercing Light', 'Messenger of Peace']);
/** Cards that destroy a class of monsters: worth it when they hit more of theirs than ours. */
const WIPES: Record<string, (e: Engine, m: FieldCard) => boolean> = {
  'Warrior Elimination': (e, m) => e.info(m.name).race === 'Warrior',
  'Eradicating Aerosol': (e, m) => e.info(m.name).race === 'Insect',
  'Acid Rain': (e, m) => m.faceUp && e.info(m.name).race === 'Machine',
  'Breath of Light': (e, m) => m.faceUp && e.info(m.name).race === 'Rock',
  'Eternal Rest': (_e, m) => m.equips.length > 0,
};

export function aiAction(e: Engine, me: Pid): Action | null {
  const s = e.state;
  if (s.winner !== null) return null;
  const opp = other(me);
  const my = e.player(me);
  const their = e.player(opp);
  const prompt = s.prompt;

  if (prompt) {
    if (prompt.player !== me) return null;
    if (prompt.kind === 'yesno') return { type: 'YES', player: me };
    if (prompt.kind === 'response') {
      // Respond with the first legal set card: the engine already filtered to useful moments.
      return prompt.options.length ? { type: 'CHOOSE', player: me, picks: [0] } : { type: 'PASS', player: me };
    }
    // Selection: rank options by context.
    const ranked = rankOptions(e, me, prompt.title, prompt.options);
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
    return { type: 'CHOOSE', player: me, picks };
  }

  if (s.turnPlayer !== me) return null;
  const myMonsters = e.monsters(me);
  const theirMonsters = e.monsters(opp);
  const theirBest = Math.max(0, ...theirMonsters.map((m) => (m.faceUp ? (m.pos === 'atk' ? e.atkOf(m) : e.defOf(m)) : 1200)));

  if (e.inMainPhase()) {
    // 1. Draw / heal / burn spells.
    for (const c of my.hand) {
      if (GOOD_ANYTIME.has(c.name) && e.canActivateMain(me, c.uid)) {
        if (c.name === 'Swords of Revealing Light' && theirMonsters.length === 0) continue;
        return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
      }
    }
    // 2. Board wipes when behind on the board.
    for (const c of my.hand) {
      if ((c.name === 'Raigeki' || c.name === 'Dark Hole' || c.name === "Harpie's Feather Duster" || c.name === 'Heavy Storm') && e.canActivateMain(me, c.uid)) {
        const myBest = Math.max(0, ...myMonsters.map((m) => e.atkOf(m)));
        if (c.name === 'Raigeki' && theirMonsters.length >= 1 && theirBest >= myBest) return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
        if (c.name === 'Dark Hole' && theirMonsters.length > myMonsters.length && theirBest >= myBest) return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
        if ((c.name === "Harpie's Feather Duster" || c.name === 'Heavy Storm') && e.spells(opp).length >= 2 && e.spells(me).length === 0) return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
      }
    }
    // 3. Revive the best monster in a graveyard.
    for (const c of my.hand) {
      if ((c.name === 'Monster Reborn' || c.name === 'Premature Burial' || c.name === 'Change of Heart' || c.name === 'Snatch Steal') && e.canActivateMain(me, c.uid)) {
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
      if (!e.canActivateMain(me, c.uid)) continue;
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
    // Speed Duel: the computer plays the modern cards generically (each move tried once per turn).
    if (e.speed) {
      const tryOnce = (key: string) => {
        const k = `${s.seed}:${s.turn}:${key}`;
        if (TRIED.has(k)) return false;
        TRIED.add(k);
        if (TRIED.size > 500) TRIED.clear();
        return true;
      };
      const sk = my.skill ? getSkill(my.skill) : undefined;
      if (e.canUseSkill(me) && sk?.ai !== false && (typeof sk?.ai !== 'function' || sk.ai(e, me)) && tryOnce(`skill${me}`)) return { type: 'SKILL', player: me };
      for (const c of my.hand) if (e.canSpecialProc(me, c) && tryOnce(`sp${c.uid}`)) return { type: 'SPECIAL', player: me, uid: c.uid };
      for (const c of my.hand) {
        const info = e.info(c.name);
        if (info.kind === 'spell' && info.sub !== 'Equip' && e.canActivateMain(me, c.uid) && tryOnce(`act${c.uid}`)) return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
      }
      for (const m of myMonsters) if (e.canUseMonsterEffect(me, m) && tryOnce(`eff${m.uid}`)) return { type: 'MONSTER_EFFECT', player: me, uid: m.uid };
      for (const c of my.hand) if (e.canUseMonsterEffect(me, c) && tryOnce(`heff${c.uid}`)) return { type: 'MONSTER_EFFECT', player: me, uid: c.uid };
      for (const c of my.gy) if (e.canUseGraveEffect(me, c.uid) && tryOnce(`gy${c.uid}`)) return { type: 'GRAVE_EFFECT', player: me, uid: c.uid };
      for (const c of [...my.sz, my.field]) if (c && c.faceUp && e.canUseMonsterEffect(me, c) && tryOnce(`st${c.uid}`)) return { type: 'MONSTER_EFFECT', player: me, uid: c.uid };
    }
    // 4. Normal Summon the strongest monster possible (tribute only for an upgrade).
    if (!my.normalSummoned) {
      const candidates = my.hand.filter((c) => e.canNormalSummon(me, c)).map((c) => ({ c, info: e.info(c.name) }));
      candidates.sort((a, b) => (b.info.atk ?? 0) - (a.info.atk ?? 0));
      const myBest = Math.max(0, ...myMonsters.map((m) => e.atkOf(m)));
      for (const { c, info } of candidates) {
        const need = e.tributesNeeded(info.level ?? 1);
        if (need > 0 && (info.atk ?? 0) < myBest + 600) continue; // not worth the tribute
        if (need > myMonsters.length) continue;
        const zone = freeZone(my.mz);
        if (zone < 0 && need === 0) break;
        const atk = info.atk ?? 0;
        const def = info.def ?? 0;
        const flip = !!getEffect(c.name)?.flip;
        // Set weak or flip monsters; summon anything that can fight.
        if (flip || (atk < theirBest && def >= atk)) return { type: 'SUMMON', player: me, uid: c.uid, zone, pos: 'def', faceUp: false };
        if (atk >= theirBest || theirMonsters.length === 0) return { type: 'SUMMON', player: me, uid: c.uid, zone, pos: 'atk', faceUp: true };
        return { type: 'SUMMON', player: me, uid: c.uid, zone, pos: 'def', faceUp: def > atk };
      }
    }
    // 5. Flip Summon strong face-down monsters; switch positions sensibly.
    for (const m of myMonsters) {
      const fresh = m.placedTurn !== s.turn && !m.posChanged && !m.attacked;
      if (!fresh) continue;
      if (!m.faceUp && (e.atkOf(m) >= theirBest || getEffect(m.name)?.flip)) return { type: 'FLIP_SUMMON', player: me, uid: m.uid };
      if (m.cannotChangePos || (m.faceUp && !e.canChangePosition(me, m))) continue;
      if (m.faceUp && m.name === 'Dream Clown' && m.pos === 'atk' && theirMonsters.length > 0) return { type: 'CHANGE_POS', player: me, uid: m.uid };
      if (m.faceUp && m.name === 'Crass Clown' && m.pos === 'def' && theirMonsters.length > 0) return { type: 'CHANGE_POS', player: me, uid: m.uid };
      if (m.faceUp && m.pos === 'def' && e.atkOf(m) > theirBest && s.phase === 'M1') return { type: 'CHANGE_POS', player: me, uid: m.uid };
      if (m.faceUp && m.pos === 'atk' && e.atkOf(m) < theirBest && e.defOf(m) > e.atkOf(m) && s.phase === 'M2') return { type: 'CHANGE_POS', player: me, uid: m.uid };
    }
    // 6. Equip the strongest monster.
    for (const c of my.hand) {
      const info = e.info(c.name);
      if (info.kind === 'spell' && info.sub === 'Equip' && myMonsters.some((m) => m.faceUp) && e.canActivateMain(me, c.uid)) return { type: 'ACTIVATE', player: me, uid: c.uid, zone: freeZone(my.sz) };
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
    for (const m of myMonsters) {
      if (!e.canAttackWith(me, m)) continue;
      const atk = e.atkOf(m);
      if (theirMonsters.length === 0 || e.canAttackDirectly(m)) return { type: 'ATTACK', player: me, uid: m.uid, target: null };
      if (m.name === 'Dark Elf' && my.lp <= 2000) continue;
      // Best target: a monster we beat, preferring the biggest attack-position one; face-downs when we are strong.
      const legal = e.legalTargets(me, m);
      const beatable = legal.filter((t) => (t.faceUp ? (t.pos === 'atk' ? atk > e.atkOf(t) : atk > e.defOf(t)) : atk >= 1600));
      if (beatable.length) {
        beatable.sort((a, b) => score(e, b) - score(e, a));
        return { type: 'ATTACK', player: me, uid: m.uid, target: beatable[0].uid };
      }
    }
    return { type: 'NEXT_PHASE', player: me };
  }
  return { type: 'NEXT_PHASE', player: me };
}

function score(e: Engine, t: FieldCard): number {
  if (!t.faceUp) return 500;
  return t.pos === 'atk' ? e.atkOf(t) + 1000 : e.defOf(t);
}

function freeZone(zones: (FieldCard | null)[]): number {
  return zones.findIndex((z) => z === null);
}

/** Orders prompt options from best to worst for the computer, by what the prompt is for. */
function rankOptions(e: Engine, me: Pid, title: string, options: { label: string; uid?: number; loc?: { player: Pid; zone: string } }[]): number[] {
  const idx = options.map((_, i) => i);
  const val = (i: number) => {
    const o = options[i];
    const name = o.label;
    const info = e.info(name);
    const atk = info.atk ?? 0;
    const theirs = o.loc?.player !== undefined && o.loc.player !== me;
    const fc = o.uid !== undefined ? e.fieldCard(o.uid) : null;
    const power = fc ? Math.max(e.atkOf(fc), e.defOf(fc)) : atk;
    if (/^Ritual:/.test(title)) return (info.level ?? 1) * 1000 - power; // high Level, low value
    if (/Fusion Summon which/i.test(title)) return power;
    if (/Tribute|discard|Discard|Hand limit/i.test(title)) return -power; // give up the weakest
    if (/destroy|Destroy|Take control|Snatch|Trap Hole/i.test(title)) return theirs ? power : -power - 5000;
    if (/Special Summon|Return which|add a monster/i.test(title)) return power;
    if (/Equip/i.test(title)) return power;
    if (/return up to/i.test(title)) return theirs ? power : -power - 5000;
    return power;
  };
  idx.sort((a, b) => val(b) - val(a));
  return idx;
}

