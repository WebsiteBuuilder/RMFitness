// The Ranked leaderboard: this season's ladder for everyone who plays the game (from the shared
// board online, src/online/rankedBoard.ts), plus the duelists this phone knows and friends who
// shared their rank. Shown on the Ranked screen (top five and your rival) and in full under
// Duelist Rankings → Ranked.
import { useEffect, useState } from 'preact/hooks';
import { loadProfiles, loadSave, type Profile } from '../eds/save';
import { loadSolo } from '../eds/speedCampaign/save';
import { TOP, starsAt, migrateRanked, seasonOf, ladderClock, stepName, type RankedProgress } from '../eds/speedCampaign/ranked';
import { mergeLadder, postRanked, rowOf, watchRanked, type BoardPost, type LadderRow } from '../online/rankedBoard';
export { mergeLadder, starsBetween, type LadderRow } from '../online/rankedBoard';
import { online } from '../online/controller';
import { RankEmblem } from './RankBadge';
import './rankings.css';

/** The key a duelist posts under: their shared account when they have one, so two phones make one line. */
export const boardKey = (p: Profile) => p.uid ?? p.id;

/** Puts a profile's rank on the shared board. */
export function postProfileRank(p: Profile, name: string, rp: RankedProgress | undefined) {
  if (rp && rp.season === seasonOf(ladderClock(rp))) void postRanked(boardKey(p), name || p.alias, p.color, migrateRanked(rp));
}

/** This season's ladder from what this phone knows: its profiles and friends who shared their rank. */
export function localLadder(me: Profile, myName: string, season: string): LadderRow[] {
  const out: LadderRow[] = [];
  const names = new Set<string>();
  for (const p of loadProfiles()) {
    const rp = loadSolo(p.id).ranked;
    const name = p.id === me.id ? myName : loadSave(p.id)?.name || p.alias;
    if (names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    if (!rp || rp.season !== season || rp.w + rp.l + (rp.d ?? 0) === 0) continue;
    out.push(rowOf(name, p.color, migrateRanked(rp), p.id === me.id ? 'me' : 'phone'));
  }
  const live = new Set(online.presence?.friends().filter((f) => f.online).map((f) => f.code) ?? []);
  for (const f of online.presence?.data.friends ?? []) {
    const rk = f.board?.rk;
    if (f.status !== 'friend' || !rk || rk.s !== season || names.has(f.name.toLowerCase())) continue;
    names.add(f.name.toLowerCase());
    out.push(rowOf(f.name, f.color, { step: Math.min(rk.step, TOP), stars: Math.min(rk.st ?? 0, starsAt(Math.min(rk.step, TOP)) - 1), kp: rk.kp, w: f.board!.w, l: f.board!.l }, 'friend', live.has(f.code)));
  }
  return out;
}

/** Follows this season's board: local duelists plus the shared one. `world` is false with no online service. */
export function useLadder(me: Profile, myName: string, season: string): { rows: LadderRow[]; world: boolean } {
  const [world, setWorld] = useState<BoardPost[] | null>(null);
  const [, tick] = useState(0);
  useEffect(() => watchRanked(season, setWorld), [season]);
  useEffect(() => online.subscribe(() => tick((n) => n + 1)), []);
  const rows = mergeLadder(localLadder(me, myName, season), world, boardKey(me));
  return { rows, world: world !== null };
}

/** Where a row stands: "Gold II · 2★" or "Pharaoh · 12 PP". */
export const rowRank = (r: Pick<LadderRow, 'step' | 'stars' | 'kp'>) => (r.step === TOP ? `${stepName(r.step)} · ${r.kp} PP` : `${stepName(r.step)} · ${r.stars}★`);

const who = (r: LadderRow) => (r.kind === 'me' ? 'you' : r.kind === 'phone' ? 'on this phone' : r.kind === 'friend' ? (r.online ? 'friend · online' : 'friend') : `${r.w}W ${r.l}L`);

/** The board's lines. With `limit`, the top ones and your own line after a gap. */
export function LadderList({ rows, limit }: { rows: LadderRow[]; limit?: number }) {
  const meAt = rows.findIndex((r) => r.kind === 'me');
  const shown = limit && rows.length > limit ? rows.slice(0, limit) : rows;
  const extra = limit && meAt >= limit ? rows[meAt] : null;
  const line = (r: LadderRow, i: number) => (
    <li key={r.name} class={`rank-row ${r.kind === 'me' ? 'me' : ''} ${i === 0 ? 'top' : ''}`}>
      <span class="rank-place">{i === 0 ? '👑' : i + 1}</span>
      <RankEmblem step={r.step} size="s" />
      <span class="rank-who">
        <b>{r.name}</b>
        <small>{who(r)}</small>
      </span>
      <span class="rank-rec">
        <b>{stepName(r.step)}</b>
        <small>{r.step === TOP ? `${r.kp} Pharaoh Points` : `${r.stars} star${r.stars === 1 ? '' : 's'}`}</small>
      </span>
    </li>
  );
  return (
    <ol class="rank-list">
      {shown.map(line)}
      {extra && (
        <>
          <li class="rank-gap" aria-hidden="true">
            ⋯
          </li>
          {line(extra, meAt)}
        </>
      )}
    </ol>
  );
}
