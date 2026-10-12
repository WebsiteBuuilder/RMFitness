// The stakes box in a Speed Duel Link Battle room: each player's bet, Shadow Realm
// rescues, the King of Games crown, and the Accept buttons.
import { useState } from 'preact/hooks';
import type { DuelSession, SessionView } from '../eds/session';
import type { SpeedSave } from '../eds/speedSave';
import type { Pid } from '../eds/types';
import { CardImg } from '../ui/CardImg';
import { Menu } from '../ui/Window';
import { playBlip } from '../ui/sound';
import { chipsOf, crownHolder, rivalsOf } from './economy';
import { anteProblem, betCards, noAnte, rescueTarget, staked, type Ante } from './stakes';

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

  return (
    <div class="stakes">
      <h4>Stakes</h4>
      {crown && rec && (
        <p class="stakes-row">
          <span class={`crown ${Math.abs(rec.streak) >= 3 ? 'hot' : ''}`}>👑</span> {crown === 'me' ? seats[mySeat].name : rival} is King of Games ({crown === 'me' ? `${rec.w}-${rec.l}` : `${rec.l}-${rec.w}`})
        </p>
      )}
      {([0, 1] as Pid[]).map((p) => {
        const rescue = rescueTarget([seats[0], seats[1]], p);
        return rescue ? (
          <p key={`r${p}`} class="stakes-row">
            ⛓ {seats[p].name} can rescue <b>{rescue}</b>: win to free it and take {seats[p === 0 ? 1 : 0].name}'s strongest monster.
          </p>
        ) : null;
      })}
      {([0, 1] as Pid[]).map((p) => {
        const a = seats[p].stakes?.ante;
        return (
          <div key={p} class="stakes-row">
            <span>{seats[p].name} bets:</span>
            {noAnte(a) ? (
              <span class="hint">nothing</span>
            ) : (
              <>
                {a!.card && (
                  <>
                    <CardImg name={a!.card} /> <b>{a!.card}</b>
                  </>
                )}
                {a!.chips > 0 && (
                  <b>
                    <i class="dchip" /> {a!.chips}
                  </b>
                )}
              </>
            )}
            {!bothNoBet && <span>{seats[p].accepted ? '✓ accepted' : '· not yet'}</span>}
            {mine(p) && (
              <button class="chip" onClick={() => (playBlip(), setEditing(editing === p ? null : p))}>
                {editing === p ? 'Close' : 'Change bet'}
              </button>
            )}
          </div>
        );
      })}
      {editing !== null && betSave(editing) && (
        <BetPicker
          save={betSave(editing)!}
          ante={seats[editing].stakes?.ante ?? null}
          onBet={(a) => (session.send({ type: 'STAKE', player: editing, ante: a }), playBlip())}
        />
      )}
      {!bothNoBet && (
        <Menu
          items={([0, 1] as Pid[])
            .filter((p) => mine(p) && !seats[p].accepted)
            .map((p) => ({ label: `${seats[p].name}: Accept the bets`, note: 'the winner takes both', onPick: () => (setEditing(null), session.send({ type: 'ACCEPT', player: p })) }))}
        />
      )}
      <p class="hint">The winner takes both bets. Leaving the duel counts as a loss.</p>
    </div>
  );
}

function BetPicker({ save, ante, onBet }: { save: SpeedSave; ante: Ante | null; onBet: (a: Ante | null) => void }) {
  const cards = betCards(save);
  const chips = ante?.chips ?? 0;
  const cur = ante?.card ?? null;
  const set = (a: Ante) => onBet(noAnte(a) ? null : a);
  const most = chipsOf(save);
  return (
    <div class="stake-pick">
      <div class="stakes-row">
        <span>Duel Chips:</span>
        <button class="chip" disabled={chips <= 0} onClick={() => set({ card: cur, chips: chips - 1 })}>
          −
        </button>
        <b>
          <i class="dchip" /> {chips}
        </b>
        <button class="chip" disabled={chips >= most} onClick={() => set({ card: cur, chips: chips + 1 })}>
          +
        </button>
        <span class="hint">you have {most}</span>
      </div>
      {cards.length === 0 ? (
        <p class="hint">No spare cards to bet: every copy you own is in one of your decks.</p>
      ) : (
        <Menu
          items={[
            { label: 'No card', selected: !cur, onPick: () => set({ card: null, chips }) },
            ...cards.slice(0, 60).map((n) => ({ label: n, selected: cur === n, disabled: !!anteProblem(save, { card: n, chips }), onPick: () => set({ card: n, chips }) })),
          ]}
        />
      )}
    </div>
  );
}
