// Pacing the computer's turn like Master Duel: nothing happens under the "X'S TURN" banner,
// then each move gets its own beat, long enough to read, with a short spotlight on the card
// that was Set, activated, Summoned or switched. Big moments still get the 3D cinematics
// (the caller waits for them); this only makes sure every small move is visible too.
import type { Action } from '../eds/types';

/** How long the turn banner stays up (TouchDuel shows "X'S TURN" for 1.1s, "DUEL!" for 1.3s), plus a breath. */
export const BANNER_MS = 1100;
export const DUEL_BANNER_MS = 1300;
const AFTER_BANNER = 250;

/** Moves the player should see happen: each gets a full beat and a spotlight. */
const VISIBLE = new Set<Action['type']>(['SUMMON', 'SET_ST', 'ACTIVATE', 'FLIP_SUMMON', 'CHANGE_POS', 'ATTACK', 'MONSTER_EFFECT', 'SPECIAL', 'SKILL', 'GRAVE_EFFECT', 'QUICK_EFFECT']);
/** Answers and phase steps: short. */
const QUICK = new Set<Action['type']>(['NEXT_PHASE', 'PASS', 'CHOOSE', 'YES', 'NO', 'CANCEL']);

export interface PaceInfo {
  /** ms since the current turn began (when its banner went up) */
  sinceTurn: number;
  /** the first turn (the "DUEL!" banner) */
  firstTurn: boolean;
  /** the move is the turn player's own (not an answer during the other player's turn) */
  ownTurn: boolean;
  /** the Animation speed setting (1 normal, higher is faster) */
  animSpeed: number;
}

/** How long the computer waits before sending `action`. */
export function cpuDelay(action: Action, p: PaceInfo): number {
  const k = Math.max(0.25, p.animSpeed || 1);
  const beat = VISIBLE.has(action.type) ? 950 : QUICK.has(action.type) ? 350 : 500;
  let ms = beat / k;
  // Its turn starts once the banner is gone.
  if (p.ownTurn) ms = Math.max(ms, (p.firstTurn ? DUEL_BANNER_MS : BANNER_MS) + AFTER_BANNER - p.sinceTurn);
  return Math.round(ms);
}

/** The card a move is about, for the spotlight (null for phase steps and answers). */
export function spotUid(action: Action): number | null {
  return VISIBLE.has(action.type) && 'uid' in action ? action.uid : null;
}

let styled = false;
function style() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = `
@keyframes cpu-spot { 0% { box-shadow: 0 0 0 0 rgba(255, 214, 90, 0); } 25% { box-shadow: 0 0 0 3px rgba(255, 214, 90, 0.95), 0 0 18px 6px rgba(255, 190, 60, 0.75); } 100% { box-shadow: 0 0 0 0 rgba(255, 214, 90, 0); } }
.cpu-spot { animation: cpu-spot 0.9s ease-out; position: relative; z-index: 3; }
@media (prefers-reduced-motion: reduce) { .cpu-spot { animation: none; outline: 3px solid rgba(255, 214, 90, 0.9); } }`;
  document.head.appendChild(el);
}

/** Briefly highlights the card with this uid wherever it is shown now (hand, field, zone). */
export function spotlight(uid: number, ms = 900) {
  if (typeof document === 'undefined') return;
  style();
  // After the move renders: the card may have just moved to the field.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[data-uid="${uid}"]`))) {
        el.classList.remove('cpu-spot');
        void el.offsetWidth;
        el.classList.add('cpu-spot');
        window.setTimeout(() => el.classList.remove('cpu-spot'), ms);
      }
    }),
  );
}
