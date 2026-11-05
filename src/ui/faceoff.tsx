// The face-off before a Speed Duel: both duelists sweep in from opposite sides with their
// Mates, meet on a crack of lightning, and a "DUEL!" slam splits them apart to show the
// field, where the opening hands are dealt. About 2.7 s; a tap skips it.
// Pure show: nothing here touches the duel. While it plays, the computer waits and the
// opening deal holds (introLeft()).
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DuelState, Pid } from '../eds/types';
import { MateArt } from '../mates/MateArt';
import type { MateId } from '../mates/roster';
import * as sfx from './duelSfx';
import { setIntroFor } from './immersionState';
import { entranceComing } from './music';
import './immersion.css';
import { duelBadge } from '../pass/duel';
import { FaceOffBadge } from '../pass/ui';

export const INTRO_MS = 2700;
/** when the panels start to split (the deal can begin under them) */
export const INTRO_SPLIT_MS = 2150;
const SKIP_MS = 320;

export { introLeft } from './immersionState';
export function startIntro(ms = INTRO_MS) {
  setIntroFor(ms);
}

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A duel just starting (no move made yet) gets the face-off. */
export function introDue(state: DuelState): boolean {
  return state.rules?.mode === 'speed' && state.turn === 1 && state.winner === null && state.log.length < 6 && !reduced();
}

export function FaceOff({ state, acting, mateOf, onDone }: { state: DuelState; acting: Pid; mateOf: (p: Pid) => MateId | null; onDone: () => void }) {
  const [out, setOut] = useState(false);
  const [stage, setStage] = useState(0);
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    setIntroFor(0);
    onDone();
  };
  useEffect(() => {
    // your entrance jingle opening the duel is the face-off's music: the sweep and clash step aside for it
    const quiet = entranceComing(state.seed, acting, state.turn);
    if (!quiet) sfx.faceoffSweep();
    const ts = [
      setTimeout(() => (quiet || sfx.faceoffClash(), setStage(1)), 430),
      setTimeout(() => (sfx.duelSlam(), setStage(2)), 1450),
      setTimeout(finish, INTRO_MS),
    ];
    return () => (ts.forEach(clearTimeout), setIntroFor(0));
  }, []);
  const skip = () => {
    if (out || done.current) return;
    setOut(true);
    setIntroFor(SKIP_MS);
    setTimeout(finish, SKIP_MS);
  };
  const opp: Pid = acting === 0 ? 1 : 0;
  const side = (p: Pid, top: boolean) => {
    const ps = state.players[p];
    const id = mateOf(p);
    const first = state.turnPlayer === p;
    const badge = duelBadge(p);
    return (
      <div class={`fo-panel ${top ? 'opp' : 'me'}`}>
        <div class="fo-streaks" />
        <div class="fo-mate">{id ? <MateArt id={id} face={stage >= 1 ? (top ? 'angry' : 'happy') : 'idle'} class={top ? 'flip' : ''} /> : <span class="fo-initial">{ps.name.slice(0, 1).toUpperCase()}</span>}</div>
        <div class="fo-who">
          <b class="fo-name" style={{ '--len': String(Math.max(6, ps.name.length)) } as Record<string, string>}>
            {ps.name}
          </b>
          {badge && <FaceOffBadge b={badge} />}
          <span class="fo-line">
            LP {ps.lp} · Deck {ps.deck.length + ps.hand.length}
          </span>
          {first && <span class="fo-first">Goes first</span>}
        </div>
      </div>
    );
  };
  return (
    <div class={`fo ${out ? 'out' : ''} s${stage}`} onPointerDown={skip} role="dialog" aria-label={`${state.players[opp].name} versus ${state.players[acting].name}. Duel!`}>
      {side(opp, true)}
      {side(acting, false)}
      <svg class="fo-seam" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="-2,55.5 14,53.2 22,54.4 37,51.4 46,52.6 58,49.6 69,50.5 81,47.6 90,48.3 102,44.5" />
      </svg>
      <div class="fo-vs">VS</div>
      <button class="fo-skip main" onClick={skip}>
        Tap to skip
      </button>
      {stage >= 2 && (
        <>
          <div class="fo-flash" />
          <div class="fo-ring" />
          <div class="fo-duel">DUEL!</div>
        </>
      )}
    </div>
  );
}
