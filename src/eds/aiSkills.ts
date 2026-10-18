// When the computer uses each Speed Duel Skill. The Skill scripts (speed/skills.ts) say what
// a Skill can do; this says when it is worth doing for the computer: LP thresholds, board
// conditions, and never a Skill that costs more than it gives. A Skill missing here is tried
// on a copy of the duel first and only used when that doesn't make things worse ('sim').
import type { Engine } from './engine';
import { other } from './engine';
import type { Card, FieldCard, Pid } from './types';
import { attackers, attackPlan, boostHelps, weakenHelps } from './aiEval';

/** true: use it now; false: not now; 'sim': use it if a lookahead says it helps (at least `min`). */
export type SkillVerdict = boolean | 'sim' | { sim: number };
export interface SkillPolicy {
  /** the activated Skill (the Skill button) */
  use?: (e: Engine, p: Pid) => SkillVerdict;
  /** "use your Skill instead of drawing?" */
  draw?: (e: Engine, p: Pid) => boolean;
}

const lp = (e: Engine, p: Pid) => e.player(p).lp;
const hand = (e: Engine, p: Pid) => e.player(p).hand;
const lv = (e: Engine, c: Card) => e.info(c.name).level ?? 0;
const faceUp = (e: Engine, p: Pid, test: (m: FieldCard) => boolean = () => true) => e.monsters(p).filter((m) => m.faceUp && test(m));
const bestAtk = (e: Engine, p: Pid) => Math.max(0, ...faceUp(e, p).map((m) => e.atkOf(m)));
/** Is there a Battle Phase still to come this turn with something to attack with? */
const canBattle = (e: Engine, p: Pid) => e.state.phase === 'M1' && attackers(e, p).length > 0;
/** Their side is clearly ahead on the field. */
const behind = (e: Engine, p: Pid) => bestAtk(e, other(p)) > bestAtk(e, p);
const always = () => true;
const never = () => false;
const sim = (): SkillVerdict => 'sim';

/** "+N ATK to one monster until the end of the turn": only when it wins a fight or the Duel. */
const boostOne = (n: number, test: (e: Engine, m: FieldCard) => boolean = () => true) => (e: Engine, p: Pid) =>
  canBattle(e, p) && boostHelps(e, p, (m) => (test(e, m) ? n : 0));

export const SKILL_AI: Record<string, SkillPolicy> = {
  // ---- never: it can lose the Duel, or pays a lot for a peek ----
  'Final Draw': { use: never, draw: never },
  'The Psychic Duelist': { use: never },

  // ---- information only: harmless (once is enough for the ones that stay on) ----
  'Aroma Strategy': { use: (e, p) => !e.player(p).skillRevealed },
  Prescience: { use: (e, p) => !e.player(p).skillRevealed },
  'Mind Scan (Skill Card)': { use: (e, p) => !e.player(p).skillRevealed },
  'Millennium Necklace (Skill Card)': { use: always },
  "It's Jinzo!": { use: always },

  // ---- boosts and weakenings: only when they win a fight this turn ----
  'Power Up!': { use: boostOne(500) },
  'Low Blow': { use: (e, p) => canBattle(e, p) && weakenHelps(e, p, 500) },
  'Room for Growth': { use: (e, p) => canBattle(e, p) && boostHelps(e, p, (m) => (lv(e, m) >= 1 && lv(e, m) <= 3 ? 300 * lv(e, m) : 0)) },
  'Beatdown!': {
    use: (e, p) => {
      if (!canBattle(e, p)) return false;
      const n = faceUp(e, p, (m) => lv(e, m) >= 5).length;
      return boostHelps(e, p, () => 300 * n) || (e.monsters(other(p)).length === 0 && attackPlan(e, p).damage > 0);
    },
  },
  "I've Got Dino DNA!": { use: boostOne(200, (e, m) => e.raceOf(m) === 'Dinosaur'), draw: always },
  'Ruthless Means': { use: (e, p) => hand(e, p).length >= 2 && faceUp(e, other(p), (m) => e.atkOf(m) >= 1500 && e.defOf(m) >= 800).length > 0 && behind(e, p) },
  'Cold-Blooded Tactician': {
    use: (e, p) => {
      const mine = bestAtk(e, p);
      // Flip their weak Defense monsters into Attack, or their big attackers with low DEF into Defense.
      return faceUp(e, other(p), (m) => (m.pos === 'def' && e.atkOf(m) < mine) || (m.pos === 'atk' && e.atkOf(m) >= mine && e.defOf(m) < mine)).length > 0;
    },
  },

  // ---- costs paid in LP: only with LP to spare, only for a real gain ----
  'Last Gamble': { use: (e, p) => lp(e, p) <= 1000 && hand(e, p).length >= 2 },
  'Shadow Reborn': {
    use: (e, p) => {
      // Paying half must leave a healthy cushion, not hand the opponent the LP lead.
      if (lp(e, p) < 2400 || lp(e, p) / 2 < lp(e, other(p)) - 1000) return false;
      const best = Math.max(0, ...[...e.player(0).gy, ...e.player(1).gy].filter((c) => e.info(c.name).kind === 'monster').map((c) => e.info(c.name).atk ?? 0));
      // Their battle damage is 0 this turn: not when we could win by attacking.
      return best >= Math.max(2000, bestAtk(e, p) + 500) && attackPlan(e, p).damage < lp(e, other(p)) ? { sim: 0 } : false;
    },
  },
  "The World's Greatest Fisherman": { use: (e, p) => (lp(e, p) > 1500 ? 'sim' : false) },
  'Double Evolution Pill (Skill Card)': { draw: (e, p) => lp(e, p) >= 2600 },

  // ---- card advantage: searches and draws ----
  'Rise of the Fallen': { use: always },
  'Dark Creation': { use: always },
  'Endless Traps': { use: always },
  Bandit: { use: always },
  'Into the Darkness Below': { use: always },
  'Setting Sun': { use: (e, p) => hand(e, p).length >= 2 },
  'Nightmare Sonic Blast!': { use: always },
  'Under Pressure': { use: always },
  'Tribal Synergy': { use: always },
  'Dragon Caller': { use: always },
  'Magnetic Attraction': { use: always },
  'Machine Angel Ascension': { use: always },
  'Fury of Thunder': { use: (e, p) => hand(e, p).length < 3 },
  "Archfiend's Promotion": { use: always },
  'Armed and Ready!': { use: always },
  'Land of the Ojamas (Skill Card)': { use: sim },
  'Zombie Master (Skill Card)': { use: always },
  'Ancient Ruler Rises': { use: always },
  'Cyberdark Style (Skill Card)': { use: always },
  'Ritual Ceremony': { use: always },
  'Destiny Draw (Skill Card)': { draw: always },
  'Flight of the Harpies': { draw: always },
  "Gravekeeper's Lot": { draw: always },
  'Digging for Gold': { use: (e, p) => e.player(p).gy.length >= 4 && e.player(p).deck.length > 3 },
  'Servants of the Fallen King': { use: (e, p) => e.player(p).deck.length >= 8 },
  Switcheroo: {
    // Trade away a card that can't be played: a monster needing more Tributes than we have.
    use: (e, p) => hand(e, p).some((c) => e.info(c.name).kind === 'monster' && e.tributesNeeded(lv(e, c)) > e.monsters(p).length),
  },
  "It's No Monster, It's a God!": { use: (e, p) => e.monsters(p).length >= 2 && hand(e, p).length >= 2 && !hand(e, p).some((c) => c.name === 'Obelisk the Tormentor') },
  'Viral Infection': {
    // Milling only matters when it can empty their Deck.
    use: (e, p) => e.player(other(p)).deck.length <= Math.min(3, hand(e, p).length),
  },
  "Magician's Act": {
    // Tributing Dark Magician for 2 cards: only with an empty hand and nothing for it to beat.
    use: (e, p) => hand(e, p).length === 0 && behind(e, p),
  },
  'Behold, Gate Guardian!': { use: (e, p) => hand(e, p).length <= 2 },

  // ---- summons and trades: the lookahead decides ----
  'Small Roid Big City': { use: () => ({ sim: 100 }) },
  'Victory of the Shadow Riders': { use: sim },
  'Cocoon of Ultra Evolution (Skill Card)': { use: sim },
  'The Right Hero for the Job': { use: () => ({ sim: 100 }) },
  'Fusion Party!': { use: () => ({ sim: 100 }) },
  'HEROES UNITE - FUSION!!': { use: () => ({ sim: 100 }) },
  'Beasts of Phantom': { use: () => ({ sim: 100 }) },
  'Cyber Blade Fusion': { use: () => ({ sim: 100 }) },
  'Union Combination': { use: () => ({ sim: 100 }) },
  'Thousand-Eyes Spell': { use: (e, p) => (attackPlan(e, p).damage === 0 ? { sim: 400 } : false) },
  'Believe in your Bro': { use: sim },
  'HERO World': { use: sim },
  // ---- skills-2024a (Battle City Finals) ----
  'As I Predicted...!': { draw: (e, p) => e.monsters(p).length === 0 },
  'Malevolence of the Millennium Ring': { use: (e, p) => (lp(e, p) > 2000 ? 'sim' : false) },
  'Pulling the Strings': { use: never },
  'Deserts Peril': { use: never },
  'Royal Temple of the Kings': { use: never },
  'See Me Rolling': { use: always },
  'Even the Odds': { use: always },
  'Keeper of the Valley': { use: always },
};

/** The policy for a Skill's activated part (unknown Skills: the lookahead decides). */
export function skillVerdict(e: Engine, p: Pid, name: string): SkillVerdict {
  const pol = SKILL_AI[name]?.use;
  return pol ? pol(e, p) : 'sim';
}

/** Whether to use a Draw Phase Skill instead of drawing (unknown ones: only if they cost no LP; the computer can't tell, so yes). */
export function skillDrawOk(e: Engine, p: Pid, name: string): boolean {
  const pol = SKILL_AI[name]?.draw;
  return pol ? pol(e, p) : true;
}
