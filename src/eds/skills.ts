// Speed Duel Skills. Each player may bring one Skill to a Speed Duel; it starts
// face-down and flips when it is first used. Keyed by the Skill Card's name.
import type { Engine, Step } from './engine';
import type { FieldCard, Pid } from './types';
import { SKILL_LIST } from './speed/skills';

export interface SkillDef {
  /** Applies at the start of the Duel, before the first turn (e.g. adds a Field Spell to the field). */
  startOfDuel?(e: Engine, p: Pid): Step;
  /** An activated Skill: the player taps "Skill" during their own turn. */
  use?: {
    /** 'main' (default): during your Main Phase. 'start': at the start of your turn (Standby/Main Phase 1, before you do anything else is not checked). */
    phase?: 'main' | 'start';
    /** false: may be used once per turn for the whole Duel. Otherwise it is limited to `timesPerDuel` (default 1). */
    oncePerDuel?: boolean;
    timesPerDuel?: number;
    can(e: Engine, p: Pid): boolean;
    run(e: Engine, p: Pid): Step;
  };
  /** Offered (yes/no) at the start of the player's Draw Phase, instead of the normal draw. Counts as a use. */
  drawPhase?: { can(e: Engine, p: Pid): boolean; run(e: Engine, p: Pid): Step };
  /** While revealed: ATK/DEF change for a face-up monster (Skills placed "in the Field Zone"). `p` owns the Skill. */
  aura?(e: Engine, p: Pid, m: FieldCard): { atk: number; def: number } | undefined;
  /** While revealed: runs in every End Phase. */
  onEndPhase?(e: Engine, p: Pid): Step;
}

export const SKILLS: Record<string, SkillDef> = SKILL_LIST;

export function getSkill(name: string): SkillDef | undefined {
  return SKILLS[name];
}

/** Skills the game can play (shown in the Speed Duel deck editor). */
export const PLAYABLE_SKILLS = (): string[] => Object.keys(SKILLS).sort();
