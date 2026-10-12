// The stakes box in a Speed Duel Link Battle room: each player's bet, what a loss can cost
// each of them, Shadow Realm rescues, the King of Games crown, and the Accept buttons.
import { useState } from 'preact/hooks';
import { card } from '../eds/db';
import type { DuelSession, SessionView } from '../eds/session';
import type { SpeedSave } from '../eds/speedSave';
import type { Pid } from '../eds/types';
import { CardImg } from '../ui/CardImg';
import { Menu } from '../ui/Window';
import { playBlip } from '../ui/sound';
import { chipsOf, crownHolder, rivalsOf } from './economy';
import { anteProblem, betCards, noAnte, rescuePrize, rescueTarget, staked, type Ante } from './stakes';

/** The duel may start: nobody bet, or both players accepted the bets. */
export function stakesReady(view: SessionView): boolean {
  const [a, b] = view.seats;
  if (!staked(a.stakes, b.stakes)) return true;
  if (noAnte(a.stakes?.ante) && noAnte(b.stakes?.ante)) return true;
  return !!a.accepted && !!b.accepted;
}

export function StakesPanel({ session, view, mySeat, hotseat, betSave }: { session: DuelSession; view: SessionView; mySeat: Pid; hotseat: boolean; betSave: (seat: Pid) => SpeedSave | null }) {
  const [editing, setEditing] = useState<Pid | null>(null);
  const seats = view.seats;
  if (!seats[0].ready || !seats[1].ready) return null;
  const on = staked(seats[0].stakes, seats[1].stakes);
  if (!on) {
    const why = !seats[0].stakes?.profile || !seats[1].stakes?.profile ? 'a guest is playing' : 'an "Anything goes" deck is in';
    return <p class="hint">Friendly duel: no bets or prizes, because {why}.</p>;
  }
  const mine = (p: Pid) => p === mySeat || (hotseat && !!betSave(p));
  const bothNoBet = noAnte(seats[0].stakes?.ante) && noAnte(seats[1].stakes?.ante);
  const me = betSave(mySeat);
  const rival = seats[mySeat === 0 ? 1 : 0].name;
  const crown = me ? crownHolder(me, rival) : null;
  const rec = me ? rivalsOf(me)[rival] : undefined;
  const otherOf = (p: Pid): Pid => (p === 0 ? 1 : 0);

  /** Everything this seat gives up if it loses. */
  const risk = (p: Pid) => {
    const out: string[] = [];
    const a = seats[p].stakes?.ante;
    if (a?.card) out.push(a.card);
    if (a?.chips) out.push(`${a.chips} chip${a.chips > 1 ? 's' : ''}`);
    if (rescueTarget([seats[0], seats[1]], otherOf(p))) {
      const prize = rescuePrize(seats[p]);
      if (prize) out.push(`${prize} (rescue)`);
    }
    return out;
  };

  return (
    <div class="stakes">
      <h4>Stakes</h4>
      {crown && rec && (
        <p class="stakes-row">
          <span class={`crown ${Math.abs(rec.streak) >= 3 ? 'hot' : ''}`}>👑</span> {crown === 'me' ? seats[mySeat].name : rival} is King of Games ({crown === 'me' ? `${rec.w}-${rec.l}` : `${rec.l}-${rec.w}`}). Win to {crown === 'me' ? 'keep' : 'take'} it.
        </p>
      )}
      {([0, 1] as Pid[]).map((p) => {
        const rescue = rescueTarget([seats[0], seats[1]], p);
        return rescue ? (
          <p key={`r${p}`} class="stakes-row">
            ⛓ Rescue duel: if {seats[p].name} wins, <b>{rescue}</b> comes back from the Shadow Realm{rescuePrize(seats[otherOf(p)]) ? ` and ${seats[p].name} takes ${seats[otherOf(p)].name}'s ${rescuePrize(seats[otherOf(p)])}` : ''}.
          </p>
        ) : null;
      })}
      <div class="seat-bets">
        {([0, 1] as Pid[]).map((p) => {
          const a = seats[p].stakes?.ante;
          const lose = risk(p);
          return (
            <div key={p} class="seat-bet">
              <b>{seats[p].name}</b>
              {noAnte(a) ? (
                <span class="hint">no bet</span>
              ) : (
                <span class="stakes-row">
                  {a!.card && <CardImg name={a!.card} />}
                  <span>
                    {a!.card && <div>{a!.card}</div>}
                    {a!.chips > 0 && (
                      <div>
                        <i class="dchip" /> {a!.chips}
                      </div>
                    )}
                  </span>
                </span>
              )}
              {lose.length > 0 && <span class="loss-line">If {seats[p].name} loses: {lose.join(', ')}</span>}
              {!bothNoBet && <span class={seats[p].accepted ? 'ok' : 'hint'}>{seats[p].accepted ? '✓ accepted' : 'not accepted yet'}</span>}
              {mine(p) && (
                <button class="chip" onClick={() => (playBlip(), setEditing(editing === p ? null : p))}>
                  {editing === p ? 'Close' : noAnte(a) ? 'Place a bet' : 'Change bet'}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {editing !== null && betSave(editing) && (
        <BetPicker
          save={betSave(editing)!}
          ante={seats[editing].stakes?.ante ?? null}
          theirs={seats[otherOf(editing)].stakes?.ante ?? null}
          onBet={(a) => (session.send({ type: 'STAKE', player: editing, ante: a }), playBlip())}
        />
      )}
      {!bothNoBet && (
        <Menu
          items={([0, 1] as Pid[])
            .filter((p) => mine(p) && !seats[p].accepted)
            .map((p) => ({ label: `${seats[p].name}: Accept`, note: 'winner takes both bets', onPick: () => (setEditing(null), session.send({ type: 'ACCEPT', player: p })) }))}
        />
      )}
      <p class="hint">Changing a bet means both accept again. Leaving the duel counts as a loss.</p>
    </div>
  );
}

function BetPicker({ save, ante, theirs, onBet }: { save: SpeedSave; ante: Ante | null; theirs: Ante | null; onBet: (a: Ante | null) => void }) {
  const cards = betCards(save);
  const chips = ante?.chips ?? 0;
  const cur = ante?.card ?? null;
  const set = (a: Ante) => onBet(noAnte(a) ? null : a);
  const most = chipsOf(save);
  const match = Math.min(most, theirs?.chips ?? 0);
  return (
    <div class="stake-pick">
      <div class="stakes-row">
        <span>Chips:</span>
        <button class="chip" disabled={chips <= 0} onClick={() => set({ card: cur, chips: chips - 1 })}>
          −
        </button>
        <b>
          <i class="dchip" /> {chips}
        </b>
        <button class="chip" disabled={chips >= most} onClick={() => set({ card: cur, chips: chips + 1 })}>
          +
        </button>
        <span class="hint">of {most}</span>
        {match > 0 && match !== chips && (
          <button class="chip" onClick={() => set({ card: cur, chips: match })}>
            Match {match}
          </button>
        )}
      </div>
      {cards.length === 0 ? (
        <p class="hint">No spare cards to bet: every copy you own is in one of your decks.</p>
      ) : (
        <>
          <p class="hint">Bet a card (only spare copies no deck uses):</p>
          <div class="bet-grid">
            <button class={`bcard nocard ${!cur ? 'on' : ''}`} onClick={() => set({ card: null, chips })}>
              No card
            </button>
            {cards.slice(0, 60).map((n) => (
              <button key={n} class={`bcard ${cur === n ? 'on' : ''}`} disabled={!!anteProblem(save, { card: n, chips })} onClick={() => set({ card: n, chips })}>
                <CardImg name={n} />
                {card(n)?.kind === 'monster' && <span class="bcount">{card(n)?.atk ?? 0}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
