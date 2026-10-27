// Ranked Duel: the monthly ladder against the computer. The emblem and stars up top, the next
// opponent, one big Duel! button; the ladder's prizes and past seasons below. Rules and
// numbers live in speedCampaign/ranked.ts.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { owned as ownedCopies, type SpeedDeck } from '../eds/speedSave';
import { soloDeckProblems } from '../eds/speedCampaign/campaign';
import { DIFFICULTY_LABEL } from '../eds/difficulty';
import { todayString } from '../eds/speedCampaign/labyrinth';
import {
  LINK_STARS_PER_DAY,
  SEASON_MIN_WINS,
  ladderClock,
  rankedFirst,
  DAILY_GOAL,
  KING_MILESTONE,
  KING_MILESTONES,
  TOP,
  starsToNext,
  winsToday,
  RANKED_TIERS,
  daysLeft,
  openRanked,
  prizeText,
  rankedFoe,
  rankedProgress,
  seasonName,
  stepName,
  tierFloor,
  tierIndexOf,
  tierOf,
  type RankedProgress,
} from '../eds/speedCampaign/ranked';
import { ace, Btn, CardRow, Portrait, ResultBanner, Sheet, SoloDeckPick, Top, skillName, soloDecks, type Ctx } from './Solo';
import { playStar } from './sound';
import { RankEmblem, RankStars } from './RankBadge';
import './ranked.css';

/** Prize lines to show: packs as one count (their cards show in the row above), chips and titles as they are. */
function prizeLines(lines: string[]): string[] {
  const packs = lines.filter((l) => !l.startsWith('Title: ') && l.includes(': ')).length;
  return [...(packs ? [`${packs} pack${packs === 1 ? '' : 's'} opened`] : []), ...lines.filter((l) => l.startsWith('Title: ') || !l.includes(': '))];
}

export function Ranked(p: Ctx) {
  const { solo, setSolo, speed } = p;
  // Coming in: file a duel the game was closed in, and turn the season over if the month changed.
  const [forfeited, setForfeited] = useState(false);
  useEffect(() => {
    const o = openRanked(speed, solo);
    if (o.speed !== speed) p.onSpeed(o.speed);
    setSolo(o.solo);
    if (o.forfeited) setForfeited(true);
  }, []);
  const rp = rankedProgress(solo);
  // Own decks only: Anything goes decks can't climb.
  const decks = soloDecks(speed).filter((d) => !d.open);
  const deck = decks.find((d) => d.id === rp.deckId && soloDeckProblems(speed, d).length === 0) ?? decks.find((d) => soloDeckProblems(speed, d).length === 0) ?? decks[0] ?? null;
  const problems = deck ? soloDeckProblems(speed, deck) : ['Build a deck from your cards first (Deck tab → Decks), or start the Millennium Road.'];
  const [deckPick, setDeckPick] = useState(false);
  const [help, setHelp] = useState(false);
  const rep = p.report?.kind === 'ranked' ? p.report : null;
  const tier = tierOf(rp.step);
  // the next opponent (a Wandering Duelist's deck is built once, not on every render)
  const foe = useMemo(() => rankedFoe(rp), [rp.season, rp.played, rp.step]);
  const lastFoe = useMemo(() => (rep ? rankedFoe({ ...rp, step: rep.settled.before.step, played: Math.max(0, rp.played - 1) }).duelist : null), [rep]);
  const today = ladderClock(rp);
  const bonusLeft = rp.bonusDay !== todayString(today);
  const won = winsToday(rp, today);
  const goalDone = rp.goalDay === todayString(today);
  const toNext = starsToNext(rp);
  const linkUsed = rp.linkDay?.[0] === todayString(today) ? rp.linkDay[1] : 0;
  const nextName = rp.step === TOP ? null : stepName(rp.step + 1);

  const duel = () => {
    if (!deck || problems.length) return;
    const lp = tier.cpuLp;
    const hand = tier.cpuHand;
    const setup = lp || hand ? { ...(lp ? { lp } : {}), ...(hand ? { openingHand: hand } : {}) } : null;
    const notes = [
      rankedFirst(rp) === 'me' ? 'You go first.' : `${foe.duelist.name} goes first.`,
      ...(foe.wandering ? ['Wandering Duelist: a deck shuffled together for this one duel.'] : []),
      ...(lp || hand ? [`${tier.name} rule: the computer starts with ${lp ?? 4000} LP${hand ? ` and ${hand} extra card` : ''}.`] : []),
      `${DIFFICULTY_LABEL[tier.level]} computer. ${tier.loses ? 'A loss takes a star.' : "Losses don't cost stars in this tier."} Leaving costs a star (or today's bonus star if you have none).`,
    ];
    p.onDuel({
      me: { name: p.name, main: deck.main, extra: deck.extra, skill: deck.skill },
      cpu: { name: foe.duelist.name, main: foe.main, extra: foe.extra, skill: foe.duelist.skill, ...(setup ? { setup } : {}) },
      first: rankedFirst(rp),
      context: { kind: 'ranked', season: rp.season },
      level: tier.level,
      vs: {
        label: `RANKED · ${stepName(rp.step).toUpperCase()}`,
        mePortrait: ace(deck.main),
        cpuPortrait: foe.duelist.portrait,
        cpuTitle: foe.duelist.title,
        line: foe.duelist.intro,
        notes,
        goals: [],
      },
    });
  };

  const tierNow = tierIndexOf(rp.step);
  return (
    <div class="screen so road rk">
      <Top
        title="Ranked Duel"
        sub={`${seasonName(rp.season)} · ${daysLeft(today)} day${daysLeft(today) === 1 ? '' : 's'} left`}
        onBack={p.onExit}
        right={
          <button class="so-chip" onClick={() => setHelp(true)}>
            How it works
          </button>
        }
      />
      <div class="so-body">
        <div class={`rk-hero t-${tier.id}`}>
          <RankEmblem step={rp.step} size="l" />
          <div class="rk-hero-t">
            <span class="so-label">YOUR RANK</span>
            <b>{stepName(rp.step)}</b>
            <RankStars p={rp} />
            {toNext !== null ? (
              <span class="rk-next">
                {toNext} star{toNext === 1 ? '' : 's'} to {nextName}
              </span>
            ) : (
              <span class="rk-next">
                {rp.kp >= KING_MILESTONE * KING_MILESTONES ? 'Every King milestone claimed' : `Next pack at ${KING_MILESTONE * ((rp.kingPaid ?? 0) + 1)} King points`}
              </span>
            )}
            <span class="rk-rec">
              {rp.w}W · {rp.l}L this season
              {rp.streak >= 2 ? ` · 🔥 ${rp.streak} in a row` : ''}
            </span>
          </div>
        </div>
        <div class="rk-ladder" aria-label={`Tier ${tierNow + 1} of ${RANKED_TIERS.length}: ${tier.name}`}>
          {RANKED_TIERS.map((t, i) => (
            <span key={t.id} class={`rk-pip t-${t.id} ${i < tierNow ? 'past' : i === tierNow ? 'now' : ''}`}>
              <i>{t.id === 'king' ? '♛' : t.name[0]}</i>
            </span>
          ))}
        </div>
        <div class="rk-bonus">
          <span class={bonusLeft ? 'on' : ''}>{bonusLeft ? '★ First win: +1 star' : '✓ Bonus star gone today'}</span>
          <span class={rp.streak >= 2 ? 'on' : ''}>{rp.streak >= 2 ? '🔥 Streak: +1 star' : '🔥 3 in a row: +1'}</span>
          <span class={goalDone || !tier.loses ? '' : 'on'}>{goalDone ? '✓ Daily pack won' : tier.loses ? `🎁 ${Math.min(won, DAILY_GOAL)}/${DAILY_GOAL} wins: a pack` : '🎁 Daily pack from Silver'}</span>
          <span class={linkUsed < LINK_STARS_PER_DAY ? 'on' : ''}>⚔ Online wins: +1 ({linkUsed}/{LINK_STARS_PER_DAY})</span>
        </div>

        <div class="rk-foe">
          <Portrait d={foe.duelist} size="m" />
          <div>
            <span class="so-label">NEXT OPPONENT</span>
            <b>{foe.duelist.name}</b>
            <span>{foe.duelist.title}</span>
            <em>
              {DIFFICULTY_LABEL[tier.level]} computer{tier.cpuLp ? ` · ${tier.cpuLp} LP` : ''}
              {tier.cpuHand ? ` · +${tier.cpuHand} card` : ''}
            </em>
          </div>
        </div>
        <Btn kind="gold" class="rk-go" disabled={problems.length > 0} onClick={() => duel()}>
          Ranked Duel!
        </Btn>

        <div class="so-deckbar">
          <div>
            <b>Your deck{deck ? `: ${deck.name}` : ''}</b>
            <span class={problems.length ? 'so-bad' : 'so-good'}>{problems.length ? problems[0] : `${deck!.main.length} cards · ${skillName(deck!.skill)}`}</span>
          </div>
          <Btn kind="blue" onClick={() => setDeckPick(true)}>
            Change
          </Btn>
        </div>

        <div class="so-group">Season prizes</div>
        <div class="rk-prizes">
          {RANKED_TIERS.map((t, i) =>
            i === 0 ? null : (
              <div key={t.id} class={`rk-prize ${rp.paid.includes(i) ? 'got' : ''} ${i === tierNow ? 'now' : ''}`}>
                <RankEmblem step={tierFloor(i)} size="s" />
                <b>{t.name}</b>
                <span>
                  {prizeText(t.prize)}
                  {t.id === 'king' ? ' + a title' : ''}
                </span>
                <i>{rp.paid.includes(i) ? '✓' : ''}</i>
              </div>
            ),
          )}
        </div>
        <p class="so-dim">Each prize pays once a season, the first time you reach the tier. After a season of 10+ wins, the next starts you two tiers below your best and pays those tiers again.</p>

        {rp.history.length > 0 && (
          <>
            <div class="so-group">Past seasons</div>
            {rp.history.map((h) => (
              <div key={h.season} class="rk-past">
                <RankEmblem step={h.peak} size="s" />
                <b>{seasonName(h.season)}</b>
                <span>
                  best {stepName(h.peak)}
                  {h.kp ? ` (${h.kp} King points)` : ''} · {h.w}W {h.l}L
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      {deckPick && (
        <SoloDeckPick
          title="Deck for Ranked Duel"
          decks={decks}
          current={deck}
          problemsOf={(d) => soloDeckProblems(speed, d)}
          note={decks.length ? 'Ranked takes decks built from cards you own. Anything goes decks stay out.' : 'No decks yet. Start the Millennium Road or build a deck from your cards.'}
          onPick={(d: SpeedDeck) => (setSolo({ ...solo, ranked: { ...rp, deckId: d.id } }), setDeckPick(false))}
          onClose={() => setDeckPick(false)}
        />
      )}
      {help && (
        <Sheet title="How Ranked works" onClose={() => setHelp(false)}>
          <div class="so-reward">Win a duel: +1 star. Fill a rank's stars to climb (3 a rank up to Silver, 4 from Gold).</div>
          <div class="so-reward">First win each day: +1 bonus star. Third win in a row and on: +1 streak star.</div>
          <div class="so-reward">From Silver up a loss takes a star back and can drop a rank, but never out of a tier you've reached.</div>
          <div class="so-reward">Higher tiers bring later Millennium Road duelists, a sharper computer and, from Bronze, Wandering Duelists with brand-new decks.</div>
          <div class="so-reward">From Silver up, the day's {DAILY_GOAL}rd Ranked win pays a pack.</div>
          <div class="so-reward">Online link battles with a friend count too: +1 star a win (up to {LINK_STARS_PER_DAY} a day), and a loss costs a star where Ranked losses do.</div>
          <div class="so-reward">Duel King is the top: every win there is a King point, and every {KING_MILESTONE} points pays a pack ({KING_MILESTONES} a season).</div>
          <p class="so-dim">Seasons run a calendar month; with 10+ wins, the next one starts you two tiers below your best. Leaving a Ranked Duel, or closing the game during one, is a loss and costs a star in any tier. Own decks only.</p>
        </Sheet>
      )}
      {forfeited && !rep && (
        <Sheet title="Ranked Duel left" onClose={() => setForfeited(false)}>
          <p>The game closed during your last Ranked Duel, so it counted as a loss.</p>
          <Btn kind="gold" onClick={() => setForfeited(false)}>
            OK
          </Btn>
        </Sheet>
      )}
      {!rep && !forfeited && rp.news && <SeasonSheet p={rp} onDone={() => setSolo({ ...solo, ranked: { ...rp, news: null } })} own={(n) => ownedCopies(speed, n)} />}
      {rep && lastFoe && <ResultSheet rep={rep} foe={lastFoe} onNext={() => (p.onReportSeen(), duel())} onDone={p.onReportSeen} own={(n) => ownedCopies(speed, n)} canGo={!problems.length} />}
    </div>
  );
}

function SeasonSheet({ p, onDone, own }: { p: RankedProgress; onDone: () => void; own: (n: string) => number }) {
  const n = p.news!;
  return (
    <Sheet>
      <div class="so-clear">
        <span class="so-label">NEW SEASON · {seasonName(p.season).toUpperCase()}</span>
        <RankEmblem step={n.start} size="l" />
        <h3>You start at {stepName(n.start)}</h3>
        <p>
          Last season ({seasonName(n.last.season)}): best {stepName(n.last.peak)}, {n.last.w}W {n.last.l}L.
        </p>
        {n.last.w < SEASON_MIN_WINS && <p class="so-dim">Under {SEASON_MIN_WINS} wins last season, so this one starts fresh at Rookie.</p>}
      </div>
      {n.cards.length > 0 && (
        <>
          <div class="so-group">Starting prizes</div>
          <CardRow names={n.cards} reveal own={own} />
        </>
      )}
      {prizeLines(n.lines).map((l) => (
        <div key={l} class="so-reward">
          {l}
        </div>
      ))}
      <Btn kind="gold" onClick={onDone}>
        Start climbing
      </Btn>
    </Sheet>
  );
}

function ResultSheet({ rep, foe, onNext, onDone, own, canGo }: { rep: Extract<NonNullable<Ctx['report']>, { kind: 'ranked' }>; foe: { name: string; portrait: string; onWin: string; onLose: string }; onNext: () => void; onDone: () => void; own: (n: string) => number; canGo: boolean }) {
  const s = rep.settled;
  const won = rep.outcome.result === 'w';
  const up = s.after.step > s.before.step;
  const down = s.after.step < s.before.step;
  useEffect(() => {
    if (s.gained > 0) for (let i = 0; i < s.gained; i++) playStar(0.5 + i * 0.25);
  }, []);
  const fresh = s.gained > 0 ? (up ? s.after.stars : Math.min(s.gained, s.after.stars)) : 0;
  return (
    <Sheet>
      <ResultBanner result={rep.outcome.result} />
      {s.forfeit && <p class="so-center so-dim">You left the duel: it counts as a loss.</p>}
      <div class={`rk-change ${up ? 'up' : down ? 'down' : ''} ${s.newTier ? `tier t-${s.newTier.id}` : ''}`}>
        {s.newTier && <span class="rk-burst" aria-hidden="true" />}
        {up && <span class="rk-flash">{s.newTier ? `${s.newTier.name.toUpperCase()} TIER!` : 'RANK UP!'}</span>}
        {down && <span class="rk-flash down">RANK DOWN</span>}
        <RankEmblem step={s.after.step} size="l" />
        <b>{stepName(s.after.step)}</b>
        <RankStars p={s.after} fresh={fresh} />
        <span class="rk-delta">
          {s.gained > 0 ? `+${s.gained} star${s.gained === 1 ? '' : 's'}` : s.gained < 0 ? '−1 star' : won ? '' : s.forfeit ? "No star to lose, so today's bonus star is gone" : tierOf(s.before.step).loses ? 'No stars to lose at this rank' : 'No star lost in this tier'}
          {s.bonus ? ' · daily bonus' : ''}
          {s.streakBonus ? ` · 🔥 ${s.streak} in a row` : ''}
        </span>
      </div>
      {s.lines.length > 0 && (
        <>
          <div class="so-group">{[s.newTier ? `${s.newTier.name} reached: season prize` : null, s.goalPaid ? 'daily Ranked pack' : null, s.kingPaid ? 'Duel King milestone' : null].filter(Boolean).join(' + ').replace(/^./, (c) => c.toUpperCase())}</div>
          {s.cards.length > 0 && <CardRow names={s.cards} reveal own={own} />}
          {prizeLines(s.lines).map((l) => (
            <div key={l} class="so-reward">
              {l}
            </div>
          ))}
        </>
      )}
      {s.capped && <div class="so-warn">Your Duel Chips are full (30). Spend some in the Card Shop so the next ones aren't lost.</div>}
      {!s.forfeit && (
        <div class="so-intro">
          <Portrait d={foe} size="s" />
          <p class="so-quote">“{won ? foe.onLose : foe.onWin}”</p>
        </div>
      )}
      <Btn kind="gold" disabled={!canGo} onClick={onNext}>
        Next Ranked Duel
      </Btn>
      <Btn onClick={onDone}>Back to the ladder</Btn>
    </Sheet>
  );
}
