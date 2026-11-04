// The Ranked Duel badge: the tier's shield, the rank's stars and the one-line summary, shared by
// the Ranked screen and the home screen's tile.
import { PHARAOH_LEVEL, TOP, ascStars, daysLeft, ladderClock, pharaohLevel, rankName, starsAt, stepName, tierOf, type RankedProgress } from '../eds/speedCampaign/ranked';
import './ranked.css';

/** The tier's badge: a shield in the tier's colors with its first letter (a crown at the top),
 * a Pharaoh Level under it and a star for each Ascension this season. */
export function RankEmblem({ step, size = 'm', asc = 0, level = 0 }: { step: number; size?: 's' | 'm' | 'l'; asc?: number; level?: number }) {
  const t = tierOf(step);
  return (
    <span class={`rk-emblem ${size} t-${t.id} ${asc ? 'asc' : ''}`} aria-label={`${step === TOP && level ? `Pharaoh ${level}` : stepName(step)}${asc ? `, Ascended ${asc}` : ''}`}>
      <svg viewBox="0 0 64 72" aria-hidden="true">
        <path class="rk-shield" d="M32 3l26 9v20c0 17-11 30-26 37C17 62 6 49 6 32V12z" />
        <path class="rk-shine" d="M32 9l20 7v15c0 13-8 23-20 29z" />
      </svg>
      <b>{tierMark(t.id, t.name)}</b>
      {step === TOP && level > 0 && <em class="rk-lvl">{level}</em>}
      {asc > 0 && <i class="rk-asc">{ascStars(asc)}</i>}
    </span>
  );
}

/** The letter on a tier's shield: a crown for Duel King, an ankh for Pharaoh. */
export const tierMark = (id: string, name: string) => (id === 'king' ? '♛' : id === 'pharaoh' ? '☥' : name[0]);

/** The rank's star slots (the top tier counts Pharaoh Points instead, with the bar to the next Pharaoh Level). */
export function RankStars({ p, fresh = 0 }: { p: Pick<RankedProgress, 'step' | 'stars' | 'kp'>; fresh?: number }) {
  if (p.step === TOP) {
    const into = p.kp % PHARAOH_LEVEL;
    return (
      <span class="rk-kp">
        ☥ {p.kp} Pharaoh Point{p.kp === 1 ? '' : 's'}
        <span class="rk-lvlbar" aria-label={`${into} of ${PHARAOH_LEVEL} points to Pharaoh ${pharaohLevel(p.kp) + 1}`}>
          <i style={{ transform: `scaleX(${into / PHARAOH_LEVEL})` }} />
        </span>
      </span>
    );
  }
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
  return `${rankName(p)}${p.asc ? ` ${ascStars(p.asc)}` : ''} · ${p.step === TOP ? `${p.kp} Pharaoh Points` : `${p.stars}/${starsAt(p.step)} stars`} · ${daysLeft(ladderClock(p))} day${daysLeft(ladderClock(p)) === 1 ? '' : 's'} left`;
}
