import { useEffect, useRef, useState } from 'preact/hooks';
import { loadDb, loadSpeedDb } from '../eds/db';
import { activeDeck, loadSpeedSave, speedDeckProblems, withSpeedResult, writeSpeedSave, type SpeedSave } from '../eds/speedSave';
import type { GameMode } from '../eds/types';
import { SpeedHub, type SpeedLinkChoice, type SpeedOpponent } from './Speed';
import { DuelSession, useDuelSession } from '../eds/session';
import { addToTrunk, deckProblems, deleteProfile, loadProfiles, loadSave, newSave, writeSave, type ControlStyle, type Profile, type SaveFile } from '../eds/save';
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
import { LinkMenu, Lobby, type LinkChoice, type SeatEntry, type SeatProfile } from './Link';
import { Avatar, ProfilePicker } from './Profiles';
import { Calendar, Campaign, DeckEdit, Intro, MainMenu, PackOpen, Password, Record, Title, type MenuChoice } from './Screens';
import { Menu, Overlay, Win } from './Window';
import { whenArtIdle } from '../art/cues';
import { recordShadow, shadowRealmOf, unsealedCpuMain, unsealedDeck, withShadow } from '../art/shadow';
import { rarityMap, withLevels } from '../level/leveling';
import { showDuelRarity } from '../level/view';
import { collectionProblems, cpuWinPrize, migrate, rivalResult } from '../collection/economy';
import { loadSets } from '../collection/sets';
import { settleStakes, staked, stakesFor } from '../collection/stakes';
import { other } from '../eds/engine';

type Screen = 'title' | 'profiles' | 'intro' | 'menu' | 'campaign' | 'link' | 'duel' | 'deck' | 'record' | 'calendar' | 'password' | 'pack' | 'speed';

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
  /** Speed Duel: this profile's decks and record, and which game the current duel belongs to */
  const [speedSave, setSpeedSaveState] = useState<SpeedSave | null>(null);
  const [duelMode, setDuelMode] = useState<GameMode>('eds');
  const [speedReady, setSpeedReady] = useState(false);
  const [speedFailed, setSpeedFailed] = useState(false);
  /** what the last Speed Duel won or lost (packs, chips, bets), shown over the Speed menu */
  const [speedNews, setSpeedNews] = useState<string[]>([]);
  const [pendingJoin, setPendingJoin] = useState<string | null>(() => {
    const code = new URLSearchParams(location.search).get('join');
    return code && /^[A-Z]{4}$/i.test(code) ? code.toUpperCase() : null;
  });

  const [dbFailed, setDbFailed] = useState(false);
  const tryLoadDb = () => {
    setDbFailed(false);
    void loadDb().then((ok) => {
      if (!ok) return setDbFailed(true);
      setDbReady(true);
      tryLoadSpeed();
    });
  };
  const tryLoadSpeed = () => {
    setSpeedFailed(false);
    void loadSpeedDb().then(async (ok) => {
      // The set list only shapes packs; without it packs fall back to one mixed set.
      if (ok) await loadSets();
      ok ? setSpeedReady(true) : setSpeedFailed(true);
    });
  };
  useEffect(tryLoadDb, []);

  const setSave = (s: SaveFile) => {
    setSaveState(s);
    if (profile) writeSave(profile.id, s);
  };

  const setSpeedSave = (s: SpeedSave) => {
    setSpeedSaveState(s);
    if (profile) writeSpeedSave(profile.id, s);
  };

  /** A profile's Speed Duel save, moved onto the collection economy the first time. */
  const speedSaveOf = (id: string) => {
    const raw = loadSpeedSave(id);
    const s = migrate(raw);
    if (s !== raw) writeSpeedSave(id, s);
    return s;
  };

  const pickProfile = (p: Profile) => {
    const s = loadSave(p.id);
    setProfile(p);
    setSaveState(s);
    setSpeedSaveState(speedSaveOf(p.id));
    setScreen(!s ? 'intro' : pendingJoin ? 'link' : 'menu');
  };

  const switchProfile = () => {
    session?.close();
    setSession(null);
    setProfile(null);
    setSaveState(null);
    setSpeedSaveState(null);
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
    setDuelMode('eds');
    setSession(ses);
    setScreen('duel');
  };

  const startSpeedCpu = (o: SpeedOpponent) => {
    const full = speedSave ? activeDeck(speedSave) : null;
    if (!save || !full || !speedSave || speedDeckProblems(full).length > 0 || collectionProblems(speedSave, full).length > 0) return;
    // Cards sealed in the Shadow Realm sit this duel out, on both sides.
    const deck = unsealedDeck(speedSave, full);
    o = { ...o, main: unsealedCpuMain(speedSave, o.name, o.main) };
    session?.close();
    const ses = new DuelSession(new MemoryAdapter());
    ses.send({ type: 'JOIN', player: 0, name: save.name, deck: deck.main, fusion: deck.extra, mode: 'speed', skill: deck.skill, rarity: rarityMap(speedSave, [...deck.main, ...deck.extra]) });
    ses.send({ type: 'JOIN', player: 1, name: o.name, deck: o.main, fusion: o.extra, mode: 'speed', skill: o.skill });
    ses.send({ type: 'START', first: Math.random() < 0.5 ? 0 : 1, seed: randomSeed(), names: [save.name, o.name], decks: [deck.main, o.main], fusions: [deck.extra, o.extra], mode: 'speed', skills: [deck.skill, o.skill] });
    setHotseat(false);
    setCpu(true);
    setMySeat(0);
    setP2Profile(null);
    setDuelMode('speed');
    setSession(ses);
    setScreen('duel');
  };

  const openSession = (c: LinkChoice | SpeedLinkChoice, mode: GameMode = 'eds') => {
    session?.close();
    setCpu(false);
    setP2Profile(null);
    setDuelMode(mode);
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

  /** The game the duel on screen belongs to (a guest follows the host's game). */
  const gameOf = (): GameMode => session?.engine.state.rules?.mode ?? session?.seats[0].mode ?? duelMode;

  /** On one phone, leaving a Speed Duel asks which player is giving up. */
  const [whoQuits, setWhoQuits] = useState(false);

  const leaveDuel = (quitter?: Pid) => {
    const mode = gameOf();
    // Leaving a Speed Duel against another player counts as a loss: surrender first, so
    // bets and prizes settle on both phones.
    const st = session?.engine.state;
    if (mode === 'speed' && !cpu && session && st?.started && st.winner === null) {
      if (hotseat && quitter === undefined) return setWhoQuits(true);
      setWhoQuits(false);
      const loser = quitter ?? mySeat;
      session.send({ type: 'SURRENDER', player: loser });
      const opp = st.players[other(mySeat)].name;
      window.setTimeout(() => finishDuel(other(loser), opp === 'Téa Gardner' ? 'Tea Gardner' : opp), 400);
      return;
    }
    session?.close();
    setSession(null);
    setP2Profile(null);
    setScreen(mode === 'speed' ? 'speed' : 'menu');
  };

  const finishDuel = (winner: Pid | 'draw', oppName: string) => {
    if (!save) return leaveDuel();
    const mine = winner === 'draw' ? 'd' : winner === mySeat ? 'w' : 'l';
    if (gameOf() === 'speed') {
      // Speed Duel keeps its own record; no booster packs or calendar days.
      // Overkill finish: the loser is sent to the Shadow Realm and their best monster is sealed.
      const sr = session ? shadowRealmOf(session.engine.state) : null;
      if (sr) recordShadow(sr);
      // Card leveling: each profile's cards rank up from what they did this duel.
      const st = session?.engine.state;
      const lv = (s: SpeedSave, seat: Pid) => (st ? withLevels(s, st, seat).save : s);
      // The collection: packs and chips won, bets and rescues between two players.
      const seats = session?.seats;
      const news: string[] = [];
      const prizes = (s: SpeedSave, seat: Pid, result: 'w' | 'l' | 'd', opp: string): SpeedSave => {
        if (cpu) {
          if (result !== 'w') return s;
          const r = cpuWinPrize(s, opp, activeDeck(s));
          if (seat === mySeat) news.push(...r.lines);
          return r.save;
        }
        if (!st || !seats || !seats[other(seat)].stakes?.profile) return s;
        const bet = settleStakes(s, seat, st, [seats[0], seats[1]], winner);
        const rv = rivalResult(bet.save, { result, opp, turns: st.turn, counts: staked(seats[0].stakes, seats[1].stakes) });
        news.push(...(seat === mySeat ? [...bet.lines, ...rv.lines] : rv.lines.map((l) => `${seats[seat].name}: ${l}`)));
        return rv.save;
      };
      if (speedSave) setSpeedSave(lv(prizes(withShadow(withSpeedResult(speedSave, mine, oppName), mine, sr, mySeat, oppName, cpu).save, mySeat, mine, oppName), mySeat));
      if (hotseat && p2Profile && p2Profile !== profile?.id) {
        const theirs = mine === 'w' ? 'l' : mine === 'l' ? 'w' : 'd';
        const seat2 = other(mySeat);
        writeSpeedSave(p2Profile, lv(prizes(withShadow(withSpeedResult(speedSaveOf(p2Profile), theirs, save.name), theirs, sr, seat2, save.name, false).save, seat2, theirs, save.name), seat2));
      }
      setSpeedNews(news);
      session?.close();
      setSession(null);
      setP2Profile(null);
      setScreen('speed');
      return;
    }
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
    if (c === 'speed' && profile) setSpeedSaveState(speedSaveOf(profile.id));
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
      .map((p) => {
        const ss = speedSaveOf(p.id);
        const d = activeDeck(ss);
        return { profile: p, save: loadSave(p.id), speed: { deck: d, play: d && unsealedDeck(ss, d), rarity: d ? rarityMap(ss, [...d.main, ...d.extra]) : undefined, stakes: d ? stakesFor(ss, !!d.open) : undefined, problems: d ? collectionProblems(ss, d) : [] } };
      });

  const myFullDeck = speedSave ? activeDeck(speedSave) : null;
  const myDeck = speedSave && myFullDeck ? unsealedDeck(speedSave, myFullDeck) : null;
  const entries: Partial<Record<GameMode, SeatEntry>> = {
    eds: { name: save.name, deck: save.main, fusion: save.fusion, problems: deckProblems(save) },
    ...(myDeck && speedReady ? { speed: { name: save.name, deck: myDeck.main, fusion: myDeck.extra, skill: myDeck.skill, rarity: rarityMap(speedSave!, [...myDeck.main, ...myDeck.extra]), stakes: stakesFor(speedSave!, !!myFullDeck!.open), problems: [...speedDeckProblems(myFullDeck!), ...collectionProblems(speedSave!, myFullDeck!)] } } : {}),
  };

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
      return <LinkMenu save={save} onPick={(c) => openSession(c, 'eds')} onBack={() => setScreen('menu')} />;
    case 'speed':
      if (!speedReady)
        return speedFailed ? (
          <div class="loading">
            <p>Couldn't load the Speed Duel cards. Check the connection and try again.</p>
            <button class="gbtn" onClick={tryLoadSpeed}>
              Try again
            </button>
            <button class="gbtn" onClick={() => setScreen('menu')}>
              Back
            </button>
          </div>
        ) : (
          <div class="loading">Loading Speed Duel cards…</div>
        );
      return (
        <>
          <SpeedHub profile={profile} save={speedSave ?? speedSaveOf(profile.id)} onSave={setSpeedSave} onExit={() => setScreen('menu')} onCpu={startSpeedCpu} onLink={(c) => openSession(c, 'speed')} />
          {speedNews.length > 0 && (
            <Overlay onClose={() => setSpeedNews([])}>
              <Win title="After the duel" onClose={() => setSpeedNews([])}>
                <ul class="prize-lines">
                  {speedNews.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
                <Menu items={[{ label: 'OK', onPick: () => setSpeedNews([]) }]} />
              </Win>
            </Overlay>
          )}
        </>
      );
    case 'duel':
      if (!session) return menu;
      if (whoQuits) {
        const names = session.engine.state.players.map((p) => p.name);
        return (
          <Overlay onClose={() => setWhoQuits(false)}>
            <Win title="Leave the duel?" onClose={() => setWhoQuits(false)}>
              <p>Leaving counts as a loss for whoever gives up.</p>
              <Menu
                items={[
                  ...([0, 1] as Pid[]).map((p) => ({ label: `${names[p]} gives up`, onPick: () => leaveDuel(p) })),
                  { label: 'Keep dueling', onPick: () => setWhoQuits(false) },
                ]}
              />
            </Win>
          </Overlay>
        );
      }
      return <Running session={session} hotseat={hotseat} cpu={cpu} mySeat={mySeat} mode={duelMode} entries={entries} betSave={(seat) => (seat === mySeat ? speedSave : hotseat && p2Profile && p2Profile !== profile.id ? speedSaveOf(p2Profile) : null)} others={hotseat ? others() : []} onSeatProfile={setP2Profile} controlsFor={controlsFor} onControls={setControls} onLeave={() => leaveDuel()} onFinished={finishDuel} />;
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
  mode,
  entries,
  betSave,
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
  mode: GameMode;
  entries: Partial<Record<GameMode, SeatEntry>>;
  betSave: (seat: Pid) => SpeedSave | null;
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
    // ...and never in the middle of a 3D cinematic.
    let t = 0;
    const stopWaiting = whenArtIdle(() => (t = window.setTimeout(() => session.send(action), quick ? 350 : 800)));
    return () => (stopWaiting(), clearTimeout(t));
  }, [cpu, view.log.length, view.state.started, view.state.winner, session, mySeat]);
  // Card leveling: each card in the duel shows its owner's rarity.
  showDuelRarity(view.state.started && view.state.rules?.mode === 'speed' ? [view.seats[0].rarity, view.seats[1].rarity] : null);
  useEffect(() => () => showDuelRarity(null), []);
  if (!view.state.started) return <Lobby session={session} view={view} mySeat={mySeat} hotseat={hotseat} mode={mode} entries={entries} others={others} onSeatProfile={onSeatProfile} onLeave={onLeave} betSave={betSave} />;
  const oppName = view.state.players[mySeat === 0 ? 1 : 0].name === 'Téa Gardner' ? 'Tea Gardner' : view.state.players[mySeat === 0 ? 1 : 0].name;
  return <Duel session={session} view={view} mySeat={mySeat} hotseat={hotseat} controlsFor={controlsFor} onControls={onControls} onLeave={onLeave} onFinished={(w) => onFinished(w, oppName)} />;
}
