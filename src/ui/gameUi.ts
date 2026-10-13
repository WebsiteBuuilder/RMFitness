// Which game's screens are up: Speed Duel screens get the modern Master Duel-style look
// (`ui-speed` on <html>, see speedui.css) and Speed Duel wording ("Spell", not "Magic").
import type { GameMode } from '../eds/types';

let current: GameMode = 'eds';

/** App calls this as it renders; cheap to call every render. */
export function setUiGame(g: GameMode) {
  if (g === current && typeof document !== 'undefined' && document.documentElement.classList.contains('ui-speed') === (g === 'speed')) return;
  current = g;
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('ui-speed', g === 'speed');
}

export const uiGame = (): GameMode => current;

/** "Spell" in Speed Duel, "Magic" in Eternal Duelist Soul (as the GBA game says). */
export const spellWord = (speed: boolean = current === 'speed'): string => (speed ? 'Spell' : 'Magic');
