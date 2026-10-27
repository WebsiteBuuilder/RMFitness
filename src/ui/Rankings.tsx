// Duelist Rankings: every duelist this phone knows (its profiles, and friends who shared their
// record while online), ranked by link-battle results, with show titles from Rookie to King of
// Games. The top spot holds the Millennium Puzzle. Bragging rights only: nothing here pays.
import { useEffect, useState } from 'preact/hooks';
import { loadProfiles, loadSave, type Profile, type SaveFile } from '../eds/save';
import { loadSpeedSave, type SpeedSave } from '../eds/speedSave';
import { shadowLog } from '../art/shadow';
import { boardRows, duelistTitle, linkStats, rankOf, rivalRows, type BoardEntry, type BoardStats } from '../collection/rankings';
import { crownHolder } from '../collection/economy';
import { online } from '../online/controller';
import { Win } from './Window';
import { loadSolo } from '../eds/speedCampaign/save';
import { TOP, ladderClock, seasonName, seasonOf, stepName } from '../eds/speedCampaign/ranked';
import { RankEmblem } from './RankBadge';
import './rankings.css';

/** Duelists this name sent to the Shadow Realm on this phone. */
export const shadowSends = (name: string) => shadowLog().filter((e) => e.winner === name).length;

/** A profile's record, as shown on the board and shared with friends. */
export function boardStatsOf(name: string, speed: SpeedSave | null, eds: SaveFile | null, profileId?: string): BoardStats {
  const out = linkStats(speed, eds, shadowSends(name));
  const rp = profileId ? loadSolo(profileId).ranked : undefined;
  return rp && rp.w + rp.l > 0 ? { ...out, rk: { s: rp.season, step: rp.step, kp: rp.kp } } : out;
}

/** This season's Ranked ladder: everyone who has played it this month, highest rank first. */
function rankedRows(entries: BoardEntry[]) {
  const season = seasonOf(ladderClock(undefined));
  return entries
    .filter((e) => e.rk && e.rk.s === season && e.rk.step <= TOP)
    .sort((a, b) => b.rk!.step - a.rk!.step || b.rk!.kp - a.rk!.kp || a.name.localeCompare(b.name));
}

export function Rankings({ profile, speed, eds, onBack }: { profile: Profile; speed: SpeedSave | null; eds: SaveFile | null; onBack: () => void }) {
  // friends' records arrive while they're online
  const [, tick] = useState(0);
  useEffect(() => online.subscribe(() => tick((n) => n + 1)), []);
  const [tab, setTab] = useState<'board' | 'ranked' | 'rivals'>('board');

  const myName = eds?.name || profile.alias;
  const me: BoardEntry = { name: myName, kind: 'me', color: profile.color, ...boardStatsOf(myName, speed, eds, profile.id) };
  const entries: BoardEntry[] = [me];
  const names = new Set([myName.toLowerCase()]);
  for (const p of loadProfiles()) {
    if (p.id === profile.id) continue;
    const s = loadSave(p.id);
    const name = s?.name || p.alias;
    if (names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    entries.push({ name, kind: 'phone', color: p.color, ...boardStatsOf(name, loadSpeedSave(p.id), s, p.id) });
  }
  const live = new Set(online.presence?.friends().filter((f) => f.online).map((f) => f.code) ?? []);
  for (const f of online.presence?.data.friends ?? []) {
    if (f.status !== 'friend' || !f.board || names.has(f.name.toLowerCase())) continue;
    names.add(f.name.toLowerCase());
    entries.push({ name: f.name, kind: 'friend', color: f.color, online: live.has(f.code), ...f.board });
  }
  const rows = boardRows(entries);
  const mine = rows.find((r) => r.kind === 'me')!;
  const t = duelistTitle(me);
  const pts = rankOf(me);
  const pct = t.next ? Math.round(((pts - t.at) / (t.next.at - t.at)) * 100) : 100;
  const rivals = rivalRows(speed, eds);
  const ranked = rankedRows(entries);

  return (
    <div class="screen">
      <Win title="Duelist Rankings" onClose={onBack} class="rank-win">
        {tab === 'ranked' ? (
          <div class="rank-me">
            {me.rk && me.rk.s === seasonOf(ladderClock(undefined)) ? <RankEmblem step={me.rk.step} size="m" /> : <RankEmblem step={0} size="m" />}
            <div class="rank-me-text">
              <b>{myName}</b>
              <span class="rank-title">
                {me.rk && me.rk.s === seasonOf(ladderClock(undefined)) ? `${stepName(me.rk.step)} · #${Math.max(1, ranked.findIndex((r) => r.kind === 'me') + 1)} of ${ranked.length}` : 'No Ranked Duels yet this season'}
              </span>
              <span class="rank-next">Ranked Duel · {seasonName(seasonOf(ladderClock(undefined)))} season</span>
            </div>
          </div>
        ) : (
        <div class="rank-me">
          <span class="rank-icon" aria-hidden="true">
            {t.icon}
          </span>
          <div class="rank-me-text">
            <b>{myName}</b>
            <span class="rank-title">
              {t.name} · #{mine.place} of {rows.length}
            </span>
            <span class="rank-bar" aria-label={t.next ? `${pct}% of the way to ${t.next.name}` : 'top title'}>
              <i style={{ width: `${Math.max(4, pct)}%` }} />
            </span>
            <span class="rank-next">{t.next ? `${pts} rank points · ${t.next.at - pts} more for ${t.next.name}` : `${pts} rank points · the top title`}</span>
          </div>
        </div>
        )}
        <div class="rank-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'board'} class={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>
            Leaderboard
          </button>
          <button role="tab" aria-selected={tab === 'ranked'} class={tab === 'ranked' ? 'on' : ''} onClick={() => setTab('ranked')}>
            Ranked
          </button>
          <button role="tab" aria-selected={tab === 'rivals'} class={tab === 'rivals' ? 'on' : ''} onClick={() => setTab('rivals')}>
            Rivals
          </button>
        </div>
        {tab === 'board' ? (
          <ol class="rank-list">
            {rows.map((r) => (
              <li key={r.name} class={`rank-row ${r.kind === 'me' ? 'me' : ''} ${r.place === 1 && r.points > 0 ? 'top' : ''}`}>
                <span class="rank-place">{r.place}</span>
                <span class="rank-dot" style={{ background: r.color ?? '#888' }} aria-hidden="true" />
                <span class="rank-who">
                  <b>
                    {r.name}
                    {r.place === 1 && r.points > 0 && <span class="rank-pharaoh"> 👁 Pharaoh</span>}
                  </b>
                  <small>
                    {r.title.icon} {r.title.name} · {r.kind === 'me' ? 'you' : r.kind === 'phone' ? 'on this phone' : r.online ? 'friend · online' : 'friend'}
                  </small>
                </span>
                <span class="rank-rec">
                  <b>
                    {r.w}-{r.l}
                    {r.d ? `-${r.d}` : ''}
                  </b>
                  <small>
                    {r.streak >= 2 ? `🔥${r.streak} ` : ''}
                    {r.shadow ? `☠${r.shadow} ` : ''}
                    {r.points} pts
                  </small>
                </span>
              </li>
            ))}
          </ol>
        ) : tab === 'ranked' ? (
          ranked.length === 0 ? (
            <p class="hint">Nobody has played Ranked Duel this season yet. Climb from the Duel tab, and your brother shows up here once he does.</p>
          ) : (
            <ol class="rank-list">
              {ranked.map((r, i) => (
                <li key={r.name} class={`rank-row ${r.kind === 'me' ? 'me' : ''} ${i === 0 ? 'top' : ''}`}>
                  <span class="rank-place">{i + 1}</span>
                  <RankEmblem step={r.rk!.step} size="s" />
                  <span class="rank-who">
                    <b>{r.name}</b>
                    <small>{r.kind === 'me' ? 'you' : r.kind === 'phone' ? 'on this phone' : r.online ? 'friend · online' : 'friend'}</small>
                  </span>
                  <span class="rank-rec">
                    <b>{stepName(r.rk!.step)}</b>
                    <small>{r.rk!.step === TOP ? `${r.rk!.kp} King points` : seasonName(r.rk!.s)}</small>
                  </span>
                </li>
              ))}
            </ol>
          )
        ) : rivals.length === 0 ? (
          <p class="hint">No link battles yet. Beat your brother online and he shows up here.</p>
        ) : (
          <ol class="rank-list">
            {rivals.map((r) => {
              const crown = speed ? crownHolder(speed, r.name) : null;
              return (
                <li key={r.name} class="rank-row">
                  <span class="rank-place">{crown === 'me' ? '👑' : crown === 'them' ? '💀' : '⚔'}</span>
                  <span class="rank-who">
                    <b>{r.name}</b>
                    <small>{crown === 'me' ? 'you hold the King of Games crown' : crown === 'them' ? 'they hold the crown: win it back' : 'all square'}</small>
                  </span>
                  <span class="rank-rec">
                    <b>
                      {r.w}-{r.l}
                      {r.d ? `-${r.d}` : ''}
                    </b>
                    <small>{r.streak >= 2 ? `🔥${r.streak} in a row` : r.streak <= -2 ? `${-r.streak} losses in a row` : `${r.w + r.l + r.d} duels`}</small>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        {tab === 'ranked' && <p class="hint rank-foot">This month's Ranked Duel ladder: duelists on this phone, and friends while they share their record online. It resets with the season.</p>}
        {tab !== 'ranked' && <p class="hint rank-foot">Link battles in both games count: 10 points a win, 3 a draw, minus 5 a loss. 🔥 win streak · ☠ sent to the Shadow Realm. Friends' records update while they're online. Rankings are bragging rights only and never pay prizes.</p>}
      </Win>
    </div>
  );
}
