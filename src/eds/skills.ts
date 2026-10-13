// Speed Duel Skills. Each player may bring one Skill to a Speed Duel; it starts
// face-down and flips when it is first used. Keyed by the Skill Card's name.
import type { Engine, Step } from './engine';
import type { EffectDef } from './effects';
import type { FieldCard, Pid } from './types';
import { SKILL_LIST } from './speed/skills';

export interface SkillDef {
  /** Applies at the start of the Duel, before the first turn (e.g. adds a Field Spell to the field). */
  startOfDuel?(e: Engine, p: Pid): Step;
  /** An activated Skill: the player taps "Skill" during their own turn. */
  use?: {
    /** undefined: any time during your turn. 'main': during your Main Phase. 'start': at the start of your turn (Standby/Main Phase 1, before you do anything else is not checked). 'battle': at the start of your Battle Phase (before any attack). */
    phase?: 'main' | 'start' | 'battle';
    /** false: may be used once per turn for the whole Duel. Otherwise it is limited to `timesPerDuel` (default 1). */
    oncePerDuel?: boolean;
    timesPerDuel?: number;
    /** audit-skills: true = not limited to once per turn by the engine (the Skill keeps its own per-turn limits). */
    repeat?: boolean;
    can(e: Engine, p: Pid): boolean;
    run(e: Engine, p: Pid): Step;
  };
  /** Offered (yes/no) at the start of the player's Draw Phase, instead of the normal draw. Counts as a use. */
  drawPhase?: { can(e: Engine, p: Pid): boolean; run(e: Engine, p: Pid): Step };
  /** While revealed: ATK/DEF change for a face-up monster (Skills placed "in the Field Zone"). `p` owns the Skill. */
  aura?(e: Engine, p: Pid, m: FieldCard): { atk: number; def: number } | undefined;
  /** Runs in every End Phase (the Skill checks its own conditions; it need not be revealed). */
  onEndPhase?(e: Engine, p: Pid): Step;
  /** Whether the computer should use this Skill now (false: never, e.g. Skills that can lose the Duel). Default: whenever it can. */
  ai?: boolean | ((e: Engine, p: Pid) => boolean);
  // ---------- audit-skills: continuous Skill effects ----------
  /**
   * Continuous hooks of the Skill, applied all Duel long (face-up or not: each Skill gates itself), as if the Skill were an
   * active Spell/Trap its owner controls (e.liveST() lists it with a stand-in card from e.skillCard(p)).
   */
  eff?: EffectDef;
  /** false: this monster of the Skill's owner cannot attack right now. */
  mayAttack?(e: Engine, p: Pid, m: FieldCard): boolean;
  /** This monster of the Skill's owner can attack directly. */
  canAttackDirectly?(e: Engine, p: Pid, m: FieldCard): boolean;
  /** Extra attacks this monster of the Skill's owner may make this Battle Phase. */
  extraAttacks?(e: Engine, p: Pid, m: FieldCard): number;
  /** This monster of the Skill's owner can attack while in face-up Defense Position. */
  attackInDefense?(e: Engine, p: Pid, m: FieldCard): boolean;
  /** ATK added to an attacking monster during damage calculation (`target` null: a direct attack). */
  attackBonus?(e: Engine, p: Pid, attacker: FieldCard, target: FieldCard | null): number;
  /** An attack was declared (either player's). */
  onAttack?(e: Engine, p: Pid, attacker: FieldCard, target: FieldCard | null): Step;
  /** The end of the Battle Phase (either player's). */
  onBattlePhaseEnd?(e: Engine, p: Pid): Step;
  /** A face-up monster would be destroyed: true when the Skill replaced the destruction. */
  destroyReplace?(e: Engine, p: Pid, m: FieldCard, byBattle: boolean): Generator<import('./types').Prompt, boolean, import('./engine').Choice>;
  /** The Skill's owner may Tribute Summon this monster in addition to the Normal Summon this turn. */
  extraTributeFor?(e: Engine, p: Pid, card: import('./types').Card): boolean;
  /** The field counts as having an active card of this name (Tomb of the Pharaoh: "Necrovalley"). */
  namesAs?(e: Engine, p: Pid): string | undefined;
}

export const SKILLS: Record<string, SkillDef> = SKILL_LIST;

export function getSkill(name: string): SkillDef | undefined {
  return SKILLS[name];
}

/** Skills the game can play (shown in the Speed Duel deck editor). */
export const PLAYABLE_SKILLS = (): string[] => Object.keys(SKILLS).sort();
