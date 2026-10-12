import { useEffect, useState } from 'preact/hooks';
import { Session, useSession } from '../game/session';
import type { PlayerId } from '../game/types';
import { loadCards } from '../data/cards';
import { LocalAdapter } from '../sync/local';
import { PeerAdapter } from '../sync/peer';
import { FirebaseAdapter } from '../sync/firebase';
import type { SyncAdapter } from '../sync/types';
import { Home, StartChoice } from './Home';
import { Lobby } from './Lobby';
import { Board } from './Board';

function makeOnline(code: string, isHost: boolean): SyncAdapter {
  return FirebaseAdapter.available() ? new FirebaseAdapter(code, isHost) : new PeerAdapter(code, isHost);
}

export function App() {
  const [name, setName] = useState(() => localStorage.getItem('sdo.name') ?? '');
  const [session, setSession] = useState<Session | null>(null);
  const [hotseat, setHotseat] = useState(false);
  const [mySeat, setMySeat] = useState<PlayerId>(0);
  const [cardsReady, setCardsReady] = useState(false);

  useEffect(() => {
    void loadCards().then(() => setCardsReady(true));
  }, []);

  useEffect(() => {
    localStorage.setItem('sdo.name', name);
  }, [name]);

  // ?join=CODE from an invite link goes straight into that room.
  useEffect(() => {
    const code = new URLSearchParams(location.search).get('join');
    if (code && /^[A-Z]{4}$/i.test(code) && !session) {
      history.replaceState(null, '', location.pathname);
      start({ mode: 'join', code: code.toUpperCase() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = (c: StartChoice) => {
    session?.close();
    if (c.mode === 'hotseat') {
      setHotseat(true);
      setMySeat(0);
      setSession(new Session(new LocalAdapter(c.resume)));
    } else {
      setHotseat(false);
      setMySeat(c.mode === 'host' ? 0 : 1);
      setSession(new Session(makeOnline(c.code, c.mode === 'host')));
    }
  };

  const leave = () => {
    if (session && session.state.started && !confirm('Leave this duel?')) return;
    session?.close();
    setSession(null);
  };

  if (!session) return <Home name={name} setName={setName} onStart={start} />;
  return <Running session={session} hotseat={hotseat} mySeat={mySeat} setMySeat={setMySeat} myName={name} onLeave={leave} cardsReady={cardsReady} />;
}

function Running({ session, hotseat, mySeat, setMySeat, myName, onLeave, cardsReady }: { session: Session; hotseat: boolean; mySeat: PlayerId; setMySeat: (p: PlayerId) => void; myName: string; onLeave: () => void; cardsReady: boolean }) {
  const view = useSession(session);
  // In hotseat the active seat follows the turn player, so the phone shows the hand of whoever is up.
  useEffect(() => {
    if (hotseat && view.state.started) setMySeat(view.state.turnPlayer);
  }, [hotseat, view.state.turnPlayer, view.state.started, setMySeat]);

  if (!cardsReady) return <div class="loading">Loading cards…</div>;
  if (!view.state.started) return <Lobby session={session} view={view} mySeat={mySeat} hotseat={hotseat} myName={myName} onLeave={onLeave} />;
  return <Board session={session} view={view} mySeat={mySeat} hotseat={hotseat} onSwap={() => setMySeat(mySeat === 0 ? 1 : 0)} onLeave={onLeave} />;
}
