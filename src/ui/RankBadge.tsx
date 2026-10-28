// The Ranked Duel badge: the tier's shield, the rank's stars and the one-line summary, shared by
// the Ranked screen and the home screen's tile.
import { TOP, daysLeft, ladderClock, starsAt, stepName, tierOf, type RankedProgress } from '../eds/speedCampaign/ranked';
import './ranked.css';

/** The tier's badge: a shield in the tier's colors with its first letter (a crown at the top). */
export function RankEmblem({ step, size = 'm' }: { step: number; size?: 's' | 'm' | 'l' }) {
  const t = tierOf(step);
  return (
    <span class={`rk-emblem ${size} t-${t.id}`} aria-label={stepName(step)}>
      <svg viewBox="0 0 64 72" aria-hidden="true">
        <path class="rk-shield" d="M32 3l26 9v20c0 17-11 30-26 37C17 62 6 49 6 32V12z" />
        <path class="rk-shine" d="M32 9l20 7v15c0 13-8 23-20 29z" />
      </svg>
      <b>{tierMark(t.id, t.name)}</b>
    </span>
  );
}

/** The letter on a tier's shield: a crown for Duel King, an ankh for Pharaoh. */
export const tierMark = (id: string, name: string) => (id === 'king' ? '♛' : id === 'pharaoh' ? '☥' : name[0]);

/** The rank's star slots (the top tier counts Pharaoh Points instead). */
export function RankStars({ p, fresh = 0 }: { p: Pick<RankedProgress, 'step' | 'stars' | 'kp'>; fresh?: number }) {
  if (p.step === TOP) return <span class="rk-kp">☥ {p.kp} Pharaoh Point{p.kp === 1 ? '' : 's'}</span>;
  return (
    <span class="rk-stars">
      {Array.from({ length: starsAt(p.step) }, (_, i) => (
        <span key={i} class={`${i < p.stars ? 'on' : ''} ${i < p.stars && i >= p.stars - fresh ? 'fresh' : ''}`} style={{ animationDelay: `${0.4 + (i - (p.stars - fresh)) * 0.25}s` }}>
          ★
        </span>
      ))}
    </span>
  );
}

/** The short line under the rank on the home tile. */
export function rankedNote(p: RankedProgress): string {
  return `${stepName(p.step)} · ${p.step === TOP ? `${p.kp} Pharaoh Points` : `${p.stars}/${starsAt(p.step)} stars`} · ${daysLeft(ladderClock(p))} day${daysLeft(ladderClock(p)) === 1 ? '' : 's'} left`;
}
