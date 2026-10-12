// Link Battle: create or join an online room, or play on one phone.
import { useState } from 'preact/hooks';
import type { DuelSession, SessionView } from '../eds/session';
import type { Pid } from '../eds/types';
import { deckProblems, type SaveFile } from '../eds/save';
import { buildStarterDeck, STARTER_COLORS } from '../eds/starter';
import { randomSeed } from '../eds/rng';
import { Menu, Win } from './Window';

export type LinkChoice = { mode: 'host' } | { mode: 'join'; code: string } | { mode: 'hotseat' };

export function LinkMenu({ save, onPick, onBack }: { save: SaveFile; onPick: (c: LinkChoice) => void; onBack: () => void }) {
  const [code, setCode] = useState('');
  const problems = deckProblems(save);
  return (
    <div class="screen">
      <Win title="Link Battle" onClose={onBack}>
        {problems.length > 0 && (
          <div class="warn">
            Your deck is not ready: {problems[0]}. Fix it in Deck Edit first.
          </div>
        )}
        <Menu
          items={[
            { label: 'Create a room', note: 'you get a 4-letter code to send', disabled: problems.length > 0, onPick: () => onPick({ mode: 'host' }) },
            { label: 'Play on this phone', note: 'take turns; your brother gets a starter deck', disabled: problems.length > 0, onPick: () => onPick({ mode: 'hotseat' }) },
          ]}
        />
        <div class="joinrow">
          <input class="code" value={code} maxLength={4} placeholder="CODE" onInput={(ev) => setCode((ev.target as HTMLInputElement).value.toUpperCase())} />
          <button class="gbtn" disabled={code.length !== 4 || problems.length > 0} onClick={() => onPick({ mode: 'join', code })}>
            Join
          </button>
        </div>
      </Win>
    </div>
  );
}

export function Lobby({ session, view, mySeat, hotseat, save, onLeave }: { session: DuelSession; view: SessionView; mySeat: Pid; hotseat: boolean; save: SaveFile; onLeave: () => void }) {
  const { seats, status, detail } = view;
  const code = session.adapter.roomCode;
  const [guestName, setGuestName] = useState('');
  const bothReady = seats[0].ready && seats[1].ready;
  const iAmReady = seats[mySeat].ready;

  const ready = () => session.send({ type: 'JOIN', player: mySeat, name: save.name, deck: save.main, fusion: save.fusion });
  const readyGuest = () => {
    const color = STARTER_COLORS[Math.floor(Math.random() * 3)];
    session.send({ type: 'JOIN', player: 1, name: guestName.trim() || 'Player 2', deck: buildStarterDeck(color, randomSeed()), fusion: [] });
  };
  const start = () => session.send({ type: 'START', first: Math.random() < 0.5 ? 0 : 1, seed: randomSeed(), names: [seats[0].name, seats[1].name], decks: [seats[0].deck, seats[1].deck], fusions: [seats[0].fusion, seats[1].fusion] });

  return (
    <div class="screen">
      <Win title={code ? `Room ${code}` : 'Play on this phone'} onClose={onLeave}>
        {code && <p class={`status s-${status}`}>{detail || status}</p>}
        {code && session.adapter.isHost && status === 'waiting' && (
          <p>
            Tell your brother the code <b>{code}</b> or send him this link:{' '}
            <button class="chip" onClick={() => void navigator.clipboard?.writeText(`${location.origin}${location.pathname}?join=${code}`)}>
              Copy invite link
            </button>
          </p>
        )}
        <div class="seats">
          {([0, 1] as Pid[]).map((s) => (
            <div key={s} class={`seat ${seats[s].ready ? 'on' : ''}`}>
              {seats[s].ready ? `${seats[s].name} · ${seats[s].deck.length} cards ✓` : `Player ${s + 1}: not ready`}
            </div>
          ))}
        </div>
        {!iAmReady && <Menu items={[{ label: `Ready with ${save.name}'s deck (${save.main.length} cards)`, onPick: ready }]} />}
        {hotseat && seats[0].ready && !seats[1].ready && (
          <div>
            <label class="field">
              <span>Player 2 name</span>
              <input value={guestName} maxLength={10} placeholder="Brother" onInput={(ev) => setGuestName((ev.target as HTMLInputElement).value)} />
            </label>
            <Menu items={[{ label: 'Give Player 2 a random Starter Deck', onPick: readyGuest }]} />
          </div>
        )}
        {bothReady && (session.adapter.isHost ? <Menu items={[{ label: 'Start Duel (coin toss)', onPick: start }]} /> : <p class="hint">Waiting for the host to start…</p>)}
      </Win>
    </div>
  );
}
