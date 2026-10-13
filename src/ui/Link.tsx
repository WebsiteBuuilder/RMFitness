// Link Battle: create or join an online room, or play on one phone.
import { useState } from 'preact/hooks';
import type { DuelSession, SessionView } from '../eds/session';
import type { GameMode, Pid } from '../eds/types';
import { speedDeckProblems, type SpeedDeck } from '../eds/speedSave';
import { guestSpeedDeck } from './Speed';
import { deckProblems, type Profile, type SaveFile } from '../eds/save';
import { Avatar } from './Profiles';
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
            { label: 'Play on this phone', note: 'take turns; Player 2 uses their own profile or a Starter Deck', disabled: problems.length > 0, onPick: () => onPick({ mode: 'hotseat' }) },
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

/** Another profile on this phone that could take Player 2's seat in a hotseat duel. */
export interface SeatProfile {
  profile: Profile;
  save: SaveFile | null;
  /** their Speed Duel deck, when they have one */
  /** `play` is the deck as dealt: without cards sealed in the Shadow Realm */
  speed?: { deck: SpeedDeck | null; play?: SpeedDeck | null };
}

/** What a player brings to the table for one of the two games. */
export interface SeatEntry {
  name: string;
  deck: string[];
  fusion: string[];
  skill?: string | null;
  problems: string[];
}

const GAME_NAME: Record<GameMode, string> = { eds: 'Eternal Duelist Soul', speed: 'Speed Duel' };

export function Lobby({
  session,
  view,
  mySeat,
  hotseat,
  mode,
  entries,
  others = [],
  onSeatProfile,
  onLeave,
}: {
  session: DuelSession;
  view: SessionView;
  mySeat: Pid;
  hotseat: boolean;
  /** the game this player chose before opening the room */
  mode: GameMode;
  /** this player's deck for each game they can play */
  entries: Partial<Record<GameMode, SeatEntry>>;
  others?: SeatProfile[];
  onSeatProfile?: (id: string | null) => void;
  onLeave: () => void;
}) {
  const { seats, status, detail } = view;
  const code = session.adapter.roomCode;
  const [guestName, setGuestName] = useState('');
  const [copied, setCopied] = useState(false);
  /** Phones open the share sheet (Messages, WhatsApp...); elsewhere the link is copied. */
  const invite = async (room: string) => {
    const url = `${location.origin}${location.pathname}?join=${room}`;
    try {
      if (navigator.share) return await navigator.share({ title: 'Duel me!', text: `Join my duel room ${room}`, url });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt('Copy this link:', url);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  // The host decides the game; a guest follows whatever the host readied for.
  const roomMode: GameMode = mySeat === 0 || !seats[0].ready ? mode : (seats[0].mode ?? 'eds');
  const mine = entries[roomMode];
  const bothReady = seats[0].ready && seats[1].ready;
  const sameGame = (seats[0].mode ?? 'eds') === (seats[1].mode ?? 'eds');
  const iAmReady = seats[mySeat].ready && (seats[mySeat].mode ?? 'eds') === roomMode;

  const join = (player: Pid, e: SeatEntry) => session.send({ type: 'JOIN', player, name: e.name, deck: e.deck, fusion: e.fusion, mode: roomMode, skill: e.skill ?? null });
  const ready = () => mine && mine.problems.length === 0 && join(mySeat, mine);
  const readyGuest = () => {
    onSeatProfile?.(null);
    const name = guestName.trim() || 'Player 2';
    if (roomMode === 'speed') {
      const d = guestSpeedDeck();
      join(1, { name, deck: d.main, fusion: d.extra, skill: d.skill, problems: [] });
    } else {
      const color = STARTER_COLORS[Math.floor(Math.random() * 3)];
      join(1, { name, deck: buildStarterDeck(color, randomSeed()), fusion: [], problems: [] });
    }
  };
  const seatFor = (o: SeatProfile): SeatEntry | null => {
    if (roomMode === 'speed') {
      const d = o.speed?.deck;
      return d ? { name: o.profile.alias, deck: (o.speed?.play ?? d).main, fusion: d.extra, skill: d.skill, problems: speedDeckProblems(d) } : null;
    }
    return o.save ? { name: o.profile.alias, deck: o.save.main, fusion: o.save.fusion, problems: deckProblems(o.save) } : null;
  };
  const readyProfile = (o: SeatProfile) => {
    const e = seatFor(o);
    if (!e || e.problems.length > 0) return;
    onSeatProfile?.(o.profile.id);
    join(1, e);
  };
  const seatNote = (o: SeatProfile) => {
    const e = seatFor(o);
    if (!e) return roomMode === 'speed' ? 'no Speed Duel deck yet' : 'no deck yet: pick a Starter Deck first';
    if (e.problems.length > 0) return 'deck not ready: fix it in Deck Edit';
    return roomMode === 'speed' ? `${e.deck.length} cards${e.skill ? ` · ${e.skill}` : ''}` : `${e.deck.length} cards · W ${o.save?.wins ?? 0} L ${o.save?.losses ?? 0}`;
  };
  const start = () =>
    session.send({
      type: 'START',
      first: Math.random() < 0.5 ? 0 : 1,
      seed: randomSeed(),
      names: [seats[0].name, seats[1].name],
      decks: [seats[0].deck, seats[1].deck],
      fusions: [seats[0].fusion, seats[1].fusion],
      ...(roomMode === 'speed' ? { mode: 'speed' as const, skills: [seats[0].skill ?? null, seats[1].skill ?? null] as [string | null, string | null] } : {}),
    });

  return (
    <div class="screen">
      <Win title={code ? `Room ${code} · ${GAME_NAME[roomMode]}` : `Play on this phone · ${GAME_NAME[roomMode]}`} onClose={onLeave}>
        {code && <p class={`status s-${status}`}>{detail || status}</p>}
        {code && session.adapter.isHost && status === 'waiting' && (
          <p>
            Tell your brother the code <b>{code}</b> or send him this link:{' '}
            <button class={`chip ${copied ? 'copied' : ''}`} onClick={() => void invite(code)}>
              {copied ? 'Link copied!' : 'Send invite link'}
            </button>
          </p>
        )}
        <div class="seats">
          {([0, 1] as Pid[]).map((s) => (
            <div key={s} class={`seat ${seats[s].ready ? 'on' : ''}`}>
              {seats[s].ready ? `${seats[s].name} · ${seats[s].deck.length} cards${seats[s].mode === 'speed' ? ' · Speed Duel' : ''} ✓` : `Player ${s + 1}: not ready`}
            </div>
          ))}
        </div>
        {!iAmReady &&
          (mine ? (
            mine.problems.length > 0 ? (
              <div class="warn">
                Your {GAME_NAME[roomMode]} deck is not ready: {mine.problems[0]}.
              </div>
            ) : (
              <Menu items={[{ label: `Ready with ${mine.name}'s ${GAME_NAME[roomMode]} deck (${mine.deck.length} cards)`, onPick: ready }]} />
            )
          ) : (
            <div class="warn">This room is a {GAME_NAME[roomMode]}. Build a {GAME_NAME[roomMode]} deck first.</div>
          ))}
        {bothReady && !sameGame && <div class="warn">The two players readied for different games. Player 2, tap Ready again.</div>}
        {hotseat && seats[0].ready && !seats[1].ready && (
          <div>
            {others.length > 0 && (
              <>
                <p class="p2-head">Player 2: who's dueling?</p>
                <div class="p2-list">
                  {others.map((o) => {
                    const e = seatFor(o);
                    const ok = !!e && e.problems.length === 0;
                    return (
                      <button key={o.profile.id} class="p2-pick" disabled={!ok} onClick={() => readyProfile(o)}>
                        <Avatar p={o.profile} size="small" />
                        <span class="p2-text">
                          <b>{o.profile.alias}</b>
                          <span>{seatNote(o)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p class="p2-head">Or a guest:</p>
              </>
            )}
            <label class="pfield">
              <span>Player 2 name</span>
              <input value={guestName} maxLength={10} placeholder="Brother" onInput={(ev) => setGuestName((ev.target as HTMLInputElement).value)} />
            </label>
            <Menu items={[{ label: 'Give Player 2 a random Starter Deck', onPick: readyGuest }]} />
          </div>
        )}
        {bothReady && sameGame && (session.adapter.isHost ? <Menu items={[{ label: 'Start Duel (rock-paper-scissors decides who goes first)', onPick: start }]} /> : <p class="hint">Waiting for the host to start…</p>)}
      </Win>
    </div>
  );
}
