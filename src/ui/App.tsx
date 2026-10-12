import { useEffect, useRef, useState } from 'preact/hooks';
import { loadDb } from '../eds/db';
import { DuelSession, useDuelSession } from '../eds/session';
import { addToTrunk, eraseSave, loadSave, newSave, writeSave, type SaveFile } from '../eds/save';
import type { Pid } from '../eds/types';
import { LocalAdapter } from '../sync/local';
import { MemoryAdapter } from '../sync/memory';
import { aiAction } from '../eds/ai';
import { applyPackUnlocks, displayName, type Duelist } from '../eds/campaign';
import { randomSeed } from '../eds/rng';
import { PeerAdapter } from '../sync/peer';
import { FirebaseAdapter } from '../sync/firebase';
import type { SyncAdapter } from '../sync/types';
import { Duel } from './Duel';
import { LinkMenu, Lobby, type LinkChoice } from './Link';
import { Calendar, Campaign, DeckEdit, Intro, MainMenu, PackOpen, Password, Record, Title, type MenuChoice } from './Screens';

type Screen = 'title' | 'intro' | 'menu' | 'campaign' | 'link' | 'duel' | 'deck' | 'record' | 'calendar' | 'password' | 'pack';

function makeOnline(code: string, isHost: boolean): SyncAdapter {
  return FirebaseAdapter.available() ? new FirebaseAdapter(code, isHost) : new PeerAdapter(code, isHost);
}

export function App() {
  const [save, setSaveState] = useState<SaveFile | null>(() => loadSave());
  const [screen, setScreen] = useState<Screen>('title');
  const [dbReady, setDbReady] = useState(false);
  const [session, setSession] = useState<DuelSession | null>(null);
  const [hotseat, setHotseat] = useState(false);
  const [cpu, setCpu] = useState(false);
  const [mySeat, setMySeat] = useState<Pid>(0);
  const [pendingJoin, setPendingJoin] = useState<string | null>(() => {
    const code = new URLSearchParams(location.search).get('join');
    return code && /^[A-Z]{4}$/i.test(code) ? code.toUpperCase() : null;
  });

  useEffect(() => {
    void loadDb().then(() => setDbReady(true));
  }, []);

  const setSave = (s: SaveFile) => {
    setSaveState(s);
    writeSave(s);
  };

  const startCampaign = (d: Duelist) => {
    if (!save) return;
    session?.close();
    const ses = new DuelSession(new MemoryAdapter());
    ses.send({ type: 'JOIN', player: 0, name: save.name, deck: save.main, fusion: save.fusion });
    ses.send({ type: 'JOIN', player: 1, name: displayName(d.name), deck: d.deck, fusion: d.fusion });
    ses.send({ type: 'START', first: Math.random() < 0.5 ? 0 : 1, seed: randomSeed(), names: [save.name, displayName(d.name)], decks: [save.main, d.deck], fusions: [save.fusion, d.fusion] });
    setHotseat(false);
    setCpu(true);
    setMySeat(0);
    setSession(ses);
    setScreen('duel');
  };

  const openSession = (c: LinkChoice) => {
    session?.close();
    setCpu(false);
    if (c.mode === 'hotseat') {
      setHotseat(true);
      setMySeat(0);
      setSession(new DuelSession(new LocalAdapter(false)));
    } else {
      setHotseat(false);
      setMySeat(c.mode === 'host' ? 0 : 1);
      setSession(new DuelSession(makeOnline(c.mode === 'join' ? c.code : newCode(), c.mode === 'host')));
    }
    setScreen('duel');
  };

  const leaveDuel = () => {
    session?.close();
    setSession(null);
    setScreen('menu');
  };

  const finishDuel = (winner: Pid | 'draw', oppName: string) => {
    if (!save) return leaveDuel();
    const next: SaveFile = { ...save, record: { ...save.record }, day: save.day + 1 };
    const r = { ...(next.record[oppName] ?? { w: 0, l: 0, d: 0 }) };
    if (winner === 'draw') {
      next.draws++;
      r.d++;
    } else if (winner === mySeat) {
      next.wins++;
      r.w++;
      next.pendingPacks++;
    } else {
      next.losses++;
      r.l++;
    }
    next.record[oppName] = r;
    applyPackUnlocks(next);
    setSave(next);
    session?.close();
    setSession(null);
    setScreen(next.pendingPacks > 0 ? 'pack' : 'menu');
  };

  if (!save) {
    if (screen === 'title') return <Title hasSave={false} onStart={() => setScreen('intro')} />;
    return (
      <Intro
        onDone={(name, color, deck) => {
          const s = newSave(name);
          s.starter = color;
          s.main = deck;
          // every card also exists in the trunk count? No: EDS keeps deck cards out of the trunk.
          addToTrunk(s, []);
          setSave(s);
          setScreen(pendingJoin ? 'link' : 'menu');
        }}
      />
    );
  }

  if (screen === 'title') return <Title hasSave onStart={() => setScreen(pendingJoin ? 'link' : 'menu')} />;
  if (!dbReady) return <div class="loading">Loading card data…</div>;

  if (screen === 'link' && pendingJoin) {
    const code = pendingJoin;
    setPendingJoin(null);
    history.replaceState(null, '', location.pathname);
    openSession({ mode: 'join', code });
    return null;
  }

  const onMenu = (c: MenuChoice) => {
    if (c === 'erase') {
      if (confirm('Erase all save data? Your cards and record will be lost.')) {
        eraseSave();
        setSaveState(null);
        setScreen('title');
      }
      return;
    }
    if (c === 'trade') return;
    setScreen(c);
  };

  switch (screen) {
    case 'menu':
      return <MainMenu save={save} onPick={onMenu} />;
    case 'campaign':
      return <Campaign save={save} onBack={() => setScreen('menu')} onDuel={startCampaign} />;
    case 'deck':
      return <DeckEdit save={save} onSave={setSave} onBack={() => setScreen('menu')} />;
    case 'record':
      return <Record save={save} onBack={() => setScreen('menu')} />;
    case 'calendar':
      return <Calendar save={save} onBack={() => setScreen('menu')} />;
    case 'password':
      return <Password save={save} onSave={setSave} onBack={() => setScreen('menu')} />;
    case 'pack':
      return <PackOpen save={save} onSave={setSave} onDone={() => setScreen('menu')} />;
    case 'link':
      return <LinkMenu save={save} onPick={openSession} onBack={() => setScreen('menu')} />;
    case 'duel':
      if (!session) return <MainMenu save={save} onPick={onMenu} />;
      return <Running session={session} hotseat={hotseat} cpu={cpu} mySeat={mySeat} save={save} onLeave={leaveDuel} onFinished={finishDuel} />;
    default:
      return <MainMenu save={save} onPick={onMenu} />;
  }
}

function newCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  return code;
}

function Running({ session, hotseat, cpu, mySeat, save, onLeave, onFinished }: { session: DuelSession; hotseat: boolean; cpu: boolean; mySeat: Pid; save: SaveFile; onLeave: () => void; onFinished: (winner: Pid | 'draw', opp: string) => void }) {
  const view = useDuelSession(session);
  const cpuStreak = useRef(0);
  // The computer takes its turn a beat after each change, so the player can follow along.
  useEffect(() => {
    if (!cpu || !view.state.started || view.state.winner !== null) return;
    const action = aiAction(session.engine, mySeat === 0 ? 1 : 0);
    if (!action) {
      cpuStreak.current = 0;
      return;
    }
    // Safety net: if the computer somehow keeps sending moves the rules ignore, end its turn.
    cpuStreak.current++;
    if (cpuStreak.current > 80) {
      cpuStreak.current = 0;
      session.send({ type: 'END_TURN', player: mySeat === 0 ? 1 : 0 });
      return;
    }
    const quick = action.type === 'NEXT_PHASE' || action.type === 'PASS' || action.type === 'CHOOSE';
    const t = setTimeout(() => session.send(action), quick ? 350 : 800);
    return () => clearTimeout(t);
  }, [cpu, view.log.length, view.state.started, view.state.winner, session, mySeat]);
  if (!view.state.started) return <Lobby session={session} view={view} mySeat={mySeat} hotseat={hotseat} save={save} onLeave={onLeave} />;
  const oppName = view.state.players[mySeat === 0 ? 1 : 0].name === 'Téa Gardner' ? 'Tea Gardner' : view.state.players[mySeat === 0 ? 1 : 0].name;
  return <Duel session={session} view={view} mySeat={mySeat} hotseat={hotseat} onLeave={onLeave} onFinished={(w) => onFinished(w, oppName)} />;
}
