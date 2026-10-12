import { useEffect, useRef, useState } from 'preact/hooks';
import { loadDb } from '../eds/db';
import { DuelSession, useDuelSession } from '../eds/session';
import { addToTrunk, deleteProfile, loadProfiles, loadSave, newSave, writeSave, type ControlStyle, type Profile, type SaveFile } from '../eds/save';
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
import { LinkMenu, Lobby, type LinkChoice, type SeatProfile } from './Link';
import { Avatar, ProfilePicker } from './Profiles';
import { Calendar, Campaign, DeckEdit, Intro, MainMenu, PackOpen, Password, Record, Title, type MenuChoice } from './Screens';
import { Menu, Overlay, Win } from './Window';

type Screen = 'title' | 'profiles' | 'intro' | 'menu' | 'campaign' | 'link' | 'duel' | 'deck' | 'record' | 'calendar' | 'password' | 'pack';

function makeOnline(code: string, isHost: boolean): SyncAdapter {
  return FirebaseAdapter.available() ? new FirebaseAdapter(code, isHost) : new PeerAdapter(code, isHost);
}

/** A copy of the save with one duel's result written in: record, totals, a day passes, a pack for a win. */
function withResult(s: SaveFile, result: 'w' | 'l' | 'd', oppName: string): SaveFile {
  const next: SaveFile = { ...s, record: { ...s.record }, day: s.day + 1 };
  const r = { ...(next.record[oppName] ?? { w: 0, l: 0, d: 0 }) };
  r[result]++;
  if (result === 'w') {
    next.wins++;
    next.pendingPacks++;
  } else if (result === 'l') next.losses++;
  else next.draws++;
  next.record[oppName] = r;
  applyPackUnlocks(next);
  return next;
}

export function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [save, setSaveState] = useState<SaveFile | null>(null);
  const [screen, setScreen] = useState<Screen>('title');
  const [dbReady, setDbReady] = useState(false);
  const [session, setSession] = useState<DuelSession | null>(null);
  const [hotseat, setHotseat] = useState(false);
  const [cpu, setCpu] = useState(false);
  const [mySeat, setMySeat] = useState<Pid>(0);
  /** the profile sitting in Player 2's seat of a hotseat duel, if any */
  const [p2Profile, setP2Profile] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingJoin, setPendingJoin] = useState<string | null>(() => {
    const code = new URLSearchParams(location.search).get('join');
    return code && /^[A-Z]{4}$/i.test(code) ? code.toUpperCase() : null;
  });

  const [dbFailed, setDbFailed] = useState(false);
  const tryLoadDb = () => {
    setDbFailed(false);
    void loadDb().then((ok) => (ok ? setDbReady(true) : setDbFailed(true)));
  };
  useEffect(tryLoadDb, []);

  const setSave = (s: SaveFile) => {
    setSaveState(s);
    if (profile) writeSave(profile.id, s);
  };

  const pickProfile = (p: Profile) => {
    const s = loadSave(p.id);
    setProfile(p);
    setSaveState(s);
    setScreen(!s ? 'intro' : pendingJoin ? 'link' : 'menu');
  };

  const switchProfile = () => {
    session?.close();
    setSession(null);
    setProfile(null);
    setSaveState(null);
    setConfirmDelete(false);
    setScreen('profiles');
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
    setP2Profile(null);
    setSession(ses);
    setScreen('duel');
  };

  const openSession = (c: LinkChoice) => {
    session?.close();
    setCpu(false);
    setP2Profile(null);
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
    setP2Profile(null);
    setScreen('menu');
  };

  const finishDuel = (winner: Pid | 'draw', oppName: string) => {
    if (!save) return leaveDuel();
    const mine = winner === 'draw' ? 'd' : winner === mySeat ? 'w' : 'l';
    const next = withResult(save, mine, oppName);
    setSave(next);
    // Hotseat with a second profile: Player 2's own save gets the result too.
    if (hotseat && p2Profile && p2Profile !== profile?.id) {
      const theirs = loadSave(p2Profile);
      if (theirs) writeSave(p2Profile, withResult(theirs, mine === 'w' ? 'l' : mine === 'l' ? 'w' : 'd', save.name));
    }
    session?.close();
    setSession(null);
    setP2Profile(null);
    setScreen(next.pendingPacks > 0 ? 'pack' : 'menu');
  };

  if (screen === 'title') return <Title hasSave={loadProfiles().length > 0} onStart={() => setScreen('profiles')} />;
  if (!profile) return <ProfilePicker onPick={pickProfile} joining={pendingJoin} />;

  if (!save) {
    return (
      <Intro
        presetName={profile.alias}
        onDone={(_name, color, deck) => {
          const s = newSave(profile.alias);
          s.starter = color;
          s.main = deck;
          // EDS keeps deck cards out of the trunk, so the trunk starts empty.
          addToTrunk(s, []);
          setSave(s);
          setScreen(pendingJoin ? 'link' : 'menu');
        }}
      />
    );
  }

  if (!dbReady)
    return dbFailed ? (
      <div class="loading">
        <p>Couldn't load the card data. Check the connection and try again.</p>
        <button class="gbtn" onClick={tryLoadDb}>
          Try again
        </button>
      </div>
    ) : (
      <div class="loading">Loading card data…</div>
    );

  if (screen === 'link' && pendingJoin) {
    const code = pendingJoin;
    setPendingJoin(null);
    history.replaceState(null, '', location.pathname);
    openSession({ mode: 'join', code });
    return null;
  }

  const onMenu = (c: MenuChoice) => {
    if (c === 'delete') return setConfirmDelete(true);
    if (c === 'switch') return switchProfile();
    if (c === 'controls') return setSave({ ...save, controls: save.controls === 'touch' ? 'classic' : 'touch' });
    setScreen(c);
  };

  const menu = (
    <>
      <MainMenu save={save} profile={profile} onPick={onMenu} />
      {confirmDelete && (
        <Overlay onClose={() => setConfirmDelete(false)}>
          <Win title="Delete this profile?" onClose={() => setConfirmDelete(false)}>
            <div class="pconfirm">
              <Avatar p={profile} size="small" />
              <p>
                Delete <b>{profile.alias}</b>
                {profile.name !== profile.alias ? ` (${profile.name})` : ''}? All of their cards, decks and record will be gone for good.
              </p>
            </div>
            <Menu
              items={[
                { label: 'Keep it', onPick: () => setConfirmDelete(false) },
                {
                  label: `Delete ${profile.alias}`,
                  onPick: () => {
                    deleteProfile(profile.id);
                    switchProfile();
                  },
                },
              ]}
            />
          </Win>
        </Overlay>
      )}
    </>
  );

  /** Each seat's control style: in a hotseat duel Player 2's own profile decides theirs. */
  const controlsFor = (p: Pid): ControlStyle => {
    if (hotseat && p === 1) return (p2Profile ? loadSave(p2Profile)?.controls : null) ?? save.controls ?? 'classic';
    return save.controls ?? 'classic';
  };
  const setControls = (p: Pid, c: ControlStyle) => {
    if (hotseat && p === 1) {
      const theirs = p2Profile && p2Profile !== profile.id ? loadSave(p2Profile) : null;
      if (theirs) writeSave(p2Profile!, { ...theirs, controls: c });
      // A guest's choice lasts for this duel only.
      return;
    }
    setSave({ ...save, controls: c });
  };

  const others = (): SeatProfile[] =>
    loadProfiles()
      .filter((p) => p.id !== profile.id)
      .map((p) => ({ profile: p, save: loadSave(p.id) }));

  switch (screen) {
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
      if (!session) return menu;
      return <Running session={session} hotseat={hotseat} cpu={cpu} mySeat={mySeat} save={save} others={hotseat ? others() : []} onSeatProfile={setP2Profile} controlsFor={controlsFor} onControls={setControls} onLeave={leaveDuel} onFinished={finishDuel} />;
    default:
      return menu;
  }
}

function newCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  return code;
}

function Running({
  session,
  hotseat,
  cpu,
  mySeat,
  save,
  others,
  onSeatProfile,
  controlsFor,
  onControls,
  onLeave,
  onFinished,
}: {
  session: DuelSession;
  hotseat: boolean;
  cpu: boolean;
  mySeat: Pid;
  save: SaveFile;
  others: SeatProfile[];
  onSeatProfile: (id: string | null) => void;
  controlsFor: (p: Pid) => ControlStyle;
  onControls: (p: Pid, c: ControlStyle) => void;
  onLeave: () => void;
  onFinished: (winner: Pid | 'draw', opp: string) => void;
}) {
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
  if (!view.state.started) return <Lobby session={session} view={view} mySeat={mySeat} hotseat={hotseat} save={save} others={others} onSeatProfile={onSeatProfile} onLeave={onLeave} />;
  const oppName = view.state.players[mySeat === 0 ? 1 : 0].name === 'Téa Gardner' ? 'Tea Gardner' : view.state.players[mySeat === 0 ? 1 : 0].name;
  return <Duel session={session} view={view} mySeat={mySeat} hotseat={hotseat} controlsFor={controlsFor} onControls={onControls} onLeave={onLeave} onFinished={(w) => onFinished(w, oppName)} />;
}
