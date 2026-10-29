import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { loadDb, loadSpeedDb } from '../eds/db';
import { activeDeck, loadSpeedSave, speedDeckProblems, withSpeedResult, writeSpeedSave, type SpeedSave } from '../eds/speedSave';
import type { Action, GameMode } from '../eds/types';
import { SpeedHub, speedHubBack, type SpeedLinkChoice, type SpeedOpponent } from './Speed';
import { ConfirmSheet } from './ConfirmSheet';
import { SpeedResult, type ResultReward, type SpeedResultData } from './SpeedResult';
import { DuelSession, useDuelSession, type SessionView } from '../eds/session';
import { addToTrunk, controlsOf, deckProblems, loadProfiles, loadSave, newSave, withControls, writeSave, type ControlStyle, type Profile, type SaveFile } from '../eds/save';
import type { DuelState, Pid } from '../eds/types';
import { LocalAdapter } from '../sync/local';
import { DuelChat } from './DuelChat';
import { MemoryAdapter } from '../sync/memory';
import { aiAction } from '../eds/ai';
import { DEFAULT_TACTICS, type Tactics } from '../eds/tactics';
import { savedDifficulty, type Difficulty } from '../eds/difficulty';
import { cpuDelay, spotUid, spotlight } from './cpuPace';
import { applyPackUnlocks, displayName, type Duelist } from '../eds/campaign';
import { randomSeed } from '../eds/rng';
import { PeerAdapter } from '../sync/peer';
import { FirebaseAdapter, NET_TOOK_WIN } from '../sync/firebase';
import { cloudState } from '../sync/cloud';
import { liveRoomOf, setLiveRoom, touchLiveRoom, type LiveRoom } from '../online/liveRoom';
import type { SyncAdapter } from '../sync/types';
import { Duel } from './Duel';
import { useBackButton } from './backButton';
import { DeckSwitch } from './DeckPick';
import { LinkMenu, Lobby, startFromSeats, type LinkChoice, type SeatEntry, type SeatProfile } from './Link';
import { TossScreen } from './Toss';
import { boardStatsOf } from './Rankings';
import { postProfileRank } from './RankedLadder';
import { rematchDock } from './Rematch';
import type { Series } from '../eds/session';
import { Avatar, ProfilePicker } from './Profiles';
import { accounts } from '../accounts';
import { Calendar, Campaign, DeckEdit, Intro, MainMenu, PackOpen, Password, Record, Title, type MenuChoice } from './Screens';
import { Menu, Overlay, Win } from './Window';
import { SoloHud, Solo, WatchBar, soloBack, type SoloMode } from './Solo';
import { forfeit, outcomeOf } from '../eds/speedCampaign/outcome';
import { loadSolo, writeSolo } from '../eds/speedCampaign/save';
import { settleSolo, type SoloReport } from '../eds/speedCampaign/settle';
import { cancelRanked, settleLinkRanked } from '../eds/speedCampaign/ranked';
import type { CpuDuelSpec, DuelContext } from '../eds/speedCampaign/types';
import { CardImg } from './CardImg';
import { whenArtIdle } from '../art/cues';
import { getAnimSpeed } from '../art/settings';
import { recordShadow, shadowRealmOf, unsealedCpuMain, unsealedDeck, withShadow } from '../art/shadow';
import { rarityMap, TIERS, tierIndex, withLevels, type Deeds, type LevelReport } from '../level/leveling';
import { showDuelRarity } from '../level/view';
import type { Rival } from '../collection/economy';
import { chipsOf, collectionProblems, cpuWinPrize, crownHolder, migrate, packsOf, retiredNotice, retiredPaid, rivalResult, rivalsOf, tooQuick, RIVAL_MIN_TURNS } from '../collection/economy';
import { noteRequests, summaryOf } from '../collection/requests';
import { loadSets, openPack } from '../collection/sets';
import { registerPackOpener } from '../eds/speedCampaign/rewards';
import { DuelPot } from '../collection/StakesPanel';
import { rescueFirst, settleStakes, settleTicket, staked, stakesFor, ticketOf, withTicket, type DuelTicket, type StakeSeat } from '../collection/stakes';
import { other } from '../eds/engine';
import { TagBar, TagHub, type TagPlan, type TagReport } from './Tag';
import { RaidHub, RaidPlay, RaidRoom, raidActive, type RaidEnd, type RaidReport } from './Raid';
import { RaidSession } from '../eds/raidSession';
import { CLEAR_REWARDS, loadRaidProgress, raidPool, settleRaid, writeRaidProgress, type RaidDef, type RaidMsg } from '../eds/raid';
import { grant } from '../eds/speedCampaign/rewards';
import { ctlOf, runsComputers, sideOfPhone, tagStart, whoMoves, type TagDuelist, type TagTeams } from '../eds/tagDuel';
import { TAG_LP, activeMember, sideName } from '../eds/tag';
import { settleTagRoad } from '../eds/speedCampaign/tagRoad';
import { deckOf } from '../eds/speedCampaign/campaign';
import type { CpuDuelist } from '../eds/speedCampaign/types';
import { online } from '../online/controller';
import { setUiGame } from './gameUi';
import { replayOf, saveReplay, type Replay } from '../eds/replays';
import { ReplayPlayer } from './Replay';

/** The game a duelist was last in on this phone ('speed' or the EDS 'menu'). */
const lastGame = (id: string): string | null => {
  try {
    return localStorage.getItem(`eds.lastGame.${id}`);
  } catch {
    return null;
  }
};
const hasSpeedSave = (id: string): boolean => {
  try {
    return localStorage.getItem(`eds.speed.${id}`) !== null;
  } catch {
    return false;
  }
};
/** How long the board settles before the computer thinks (counted inside its usual pause). */
const THINK_BEAT = 300;
const setLastGame = (id: string, g: string) => {
  try {
    localStorage.setItem(`eds.lastGame.${id}`, g);
  } catch {
    /* storage full */
  }
};

type Screen = 'title' | 'profiles' | 'intro' | 'menu' | 'campaign' | 'link' | 'duel' | 'deck' | 'record' | 'calendar' | 'password' | 'pack' | 'speed';

function makeOnline(code: string, isHost: boolean): SyncAdapter {
  // rooms live on the online service whenever it can be used (still checking counts: the room waits for it)
  return cloudState() !== 'off' ? new FirebaseAdapter(code, isHost) : new PeerAdapter(code, isHost);
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

// Campaign and Labyrinth packs open from the real Speed Duel sets.
registerPackOpener(openPack);

type NewsCards = { who: string; won: string[]; lost: string[] }[];

export function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [save, setSaveState] = useState<SaveFile | null>(null);
  const [screen, setScreen] = useState<Screen>('title');
  // A new screen fades in (opacity only: a transform here would move the screens' fixed layers).
  useLayoutEffect(() => {
    const el = document.getElementById('app');
    if (!el) return;
    el.classList.remove('scr-in');
    void el.offsetWidth;
    el.classList.add('scr-in');
  }, [screen]);
  const [dbReady, setDbReady] = useState(false);
  const [session, setSession] = useState<DuelSession | null>(null);
  const [hotseat, setHotseat] = useState(false);
  const [cpu, setCpu] = useState(false);
  /** how sharp the computer plays this duel */
  const [cpuLevel, setCpuLevel] = useState<Difficulty>('normal');
  const [mySeat, setMySeat] = useState<Pid>(0);
  /** the profile sitting in Player 2's seat of a hotseat duel, if any */
  const [p2Profile, setP2Profile] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Speed Duel: this profile's decks and record, and which game the current duel belongs to */
  const [speedSave, setSpeedSaveState] = useState<SpeedSave | null>(null);
  const [duelMode, setDuelMode] = useState<GameMode>('eds');
  const [speedReady, setSpeedReady] = useState(false);
  const [speedFailed, setSpeedFailed] = useState(false);
  /** Speed Duel solo modes: which one is open, the duel in progress and the last result */
  const [soloMode, setSoloMode] = useState<SoloMode | null>(null);
  const soloDuel = useRef<{ ctx: DuelContext; startLp: number; spec: CpuDuelSpec } | null>(null);
  const [soloReport, setSoloReport] = useState<SoloReport | null>(null);
  /** 2v2 Tag Duels: the menu is open, the last tag duel's result, and the room this phone hosts */
  const [tagOpen, setTagOpen] = useState(false);
  const [tagReport, setTagReport] = useState<TagReport | null>(null);
  const tagHost = useRef<TagPlan | null>(null);
  /** Boss Raid: the menu is open, the last raid's result, the raid this phone hosts, a raid with a computer partner */
  const [raidOpen, setRaidOpen] = useState(false);
  const [raidReport, setRaidReport] = useState<RaidReport | null>(null);
  const raidHost = useRef<{ def: RaidDef; level: Difficulty } | null>(null);
  const [raidLocal, setRaidLocal] = useState<RaidSession | null>(null);
  /** watching the computer duel itself: speed and pause */
  const [watchSpeed, setWatchSpeed] = useState(1);
  const [watchPaused, setWatchPaused] = useState(false);
  /** what the last Speed Duel won or lost (packs, chips, bets), shown over the Speed menu */
  const [speedNews, setSpeedNews] = useState<string[]>([]);
  /** cards each player won and lost, for the after-duel screen */
  const [newsCards, setNewsCards] = useState<NewsCards>([]);
  /** the Speed Duel result screen (VICTORY / DEFEAT and rewards), shown after a duel against the computer or a Link Battle */
  const [speedResult, setSpeedResult] = useState<SpeedResultData | null>(null);
  /** the duel just finished, to watch again from the result screen; and the replay playing */
  const [lastReplay, setLastReplay] = useState<Replay | null>(null);
  const [replaying, setReplaying] = useState<Replay | null>(null);
  /** the Android back button asked to leave a duel in progress: confirm first */
  const [askLeave, setAskLeave] = useState(false);
  /** a duel on this phone that was never finished: the players say who gave up */
  const [unfinished, setUnfinished] = useState<{ id: string; t: DuelTicket } | null>(null);
  /** news from an older walk-out settled as a new duel started, shown after that duel */
  const carryNews = useRef<string[]>([]);
  /** the online room being played in, kept on tickets so only that room's rejoin waits */
  const roomCode = useRef<string | undefined>(undefined);
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
  // Speed Duel screens get the modern look; EDS keeps its GBA pixel font.
  setUiGame(screen === 'speed' || (screen === 'duel' && (session?.engine.state.rules?.mode ?? session?.seats[0].mode ?? duelMode) === 'speed') ? 'speed' : 'eds');

  const setSave = (s: SaveFile) => {
    setSaveState(s);
    if (profile) writeSave(profile.id, s);
  };

  const setSpeedSave = (s: SpeedSave) => {
    setSpeedSaveState(s);
    if (profile) writeSpeedSave(profile.id, s);
  };

  /** Settles a duel left unfinished (see settleTicket): the bets, the record, no prizes. */
  const settleLeftDuel = (s: SpeedSave, winner?: Pid) => {
    const left = settleTicket(s, winner);
    if (!left) return null;
    const next = withSpeedResult(rivalResult(left.save, { result: left.result, opp: left.opp, turns: 0, counts: false }).save, left.result, left.opp);
    return { save: next, lines: left.lines, won: left.won, lost: left.lost };
  };

  /** A profile's Speed Duel save, moved onto the collection economy the first time. */
  const speedSaveOf = (id: string, settleLeft = false) => {
    const raw = loadSpeedSave(id);
    let s = migrate(raw);
    const paid = retiredPaid(raw, s);
    const retiredNews = paid.copies || paid.chips || paid.decks.length ? [retiredNotice(paid)] : [];
    if (retiredNews.length) setSpeedNews(retiredNews);
    const t = ticketOf(s);
    if (settleLeft && t && !session) {
      // A duel on this phone left unfinished: ask who gave up. A Link Battle this profile
      // walked out of (the app was closed) counts as a loss, unless it's being rejoined.
      if (t.partner) setUnfinished({ id, t });
      // (a recent one may still be going on another phone logged in as this duelist: it settles later)
      else if ((!pendingJoin || pendingJoin !== t.room) && liveRoomOf(id)?.room !== t.room && !(t.room && Date.now() - t.at < 3 * 3600_000)) {
        const left = settleLeftDuel(s)!;
        s = left.save;
        setSpeedNews([...retiredNews, ...left.lines]);
        setNewsCards([{ who: '', won: left.won, lost: left.lost }]);
      }
    }
    if (s !== raw) writeSpeedSave(id, s);
    return s;
  };

  /** Both players on this phone said who gave up their unfinished duel. */
  const settleUnfinished = (winner: Pid) => {
    if (!unfinished) return;
    const t0 = unfinished.t;
    const lines = [`${t0.seats[other(winner)].name} gave up the unfinished duel, so ${t0.seats[winner].name} wins it.`];
    const cards: NewsCards = [];
    for (const id of [unfinished.id, unfinished.t.partner!]) {
      const s = migrate(loadSpeedSave(id));
      const t = ticketOf(s);
      const r = t && settleLeftDuel(s, winner);
      if (!t || !r) continue;
      writeSpeedSave(id, r.save);
      if (id === profile?.id) setSpeedSaveState(r.save);
      const who = t.seats[t.seat].name;
      lines.push(...r.lines.slice(1));
      cards.push({ who, won: r.won, lost: r.lost });
    }
    setUnfinished(null);
    setSpeedNews(lines);
    setNewsCards(cards);
  };

  /**
   * A Link Battle with stakes started: each profile in it keeps a ticket, so closing the app
   * never dodges a bet. An older walk-out still on the save settles first.
   */
  const ticketsFor = (seats: [StakeSeat, StakeSeat], key: string) => {
    if (!speedSave || !profile || !staked(seats[0].stakes, seats[1].stakes)) return;
    const partner = hotseat && p2Profile && p2Profile !== profile.id ? p2Profile : undefined;
    if (hotseat && !partner) return;
    const stamp = (s: SpeedSave, seat: Pid, partnerId?: string) => {
      const old = ticketOf(s);
      if (old && old.key !== key && !old.partner) {
        const left = settleLeftDuel(s)!;
        carryNews.current.push(...left.lines);
        s = left.save;
      }
      return withTicket(s, { seat, seats, at: Date.now(), key, partner: partnerId, room: partnerId ? undefined : roomCode.current });
    };
    setSpeedSave(stamp(speedSave, mySeat, partner));
    if (partner) writeSpeedSave(partner, stamp(speedSaveOf(partner), other(mySeat), profile.id));
  };

  const pickProfile = (p: Profile) => {
    const s = loadSave(p.id);
    // a duelist logging in on a new phone opens in Speed Duel if that's where their decks are
    const game = lastGame(p.id) ?? (hasSpeedSave(p.id) ? 'speed' : null);
    setProfile(p);
    setSaveState(s);
    setSpeedSaveState(speedSaveOf(p.id, true));
    online.setProfile(p);
    setScreen(!s ? 'intro' : pendingJoin ? 'link' : game === 'speed' ? 'speed' : 'menu');
    // an online duel this phone was in when the game closed (a refresh, a crash): straight back in
    const live = s && !pendingJoin ? liveRoomOf(p.id) : null;
    if (live && cloudState() !== 'off') resumeRoom(live);
  };
  /** Opens the online room a duel was left in: the room kept every move, so it carries on where it was. */
  const resumeRoom = (live: LiveRoom) => {
    setCpu(false);
    setHotseat(false);
    setP2Profile(null);
    setDuelMode(live.mode);
    setMySeat(live.host ? 0 : 1);
    roomCode.current = live.room;
    setSession(new DuelSession(new FirebaseAdapter(live.room, live.host)));
    setScreen('duel');
  };
  // Back too late: the other phone took the win. The duel is settled as this phone's loss, with the result screen.
  useEffect(() => {
    if (!session || hotseat || cpu) return;
    const ses = session;
    const check = () => {
      if (ses.status !== 'error' || ses.detail !== NET_TOOK_WIN || settled.current === ses || gameOf() !== 'speed') return;
      settled.current = ses;
      const st = ses.engine.state;
      const left = speedSave ? settleLeftDuel(speedSave) : null;
      if (left) setSpeedSave(left.save);
      const lines = left ? left.lines.map((l) => l.replace(/^(.*) left the duel against (.*), so it counted as a loss\.$/, "$1 didn't rejoin within two minutes, so the duel against $2 counted as a loss.")) : ['Your opponent took the win.'];
      const cards: NewsCards = left ? [{ who: '', won: left.won, lost: left.lost }] : [];
      setSpeedNews(lines);
      setNewsCards(cards);
      if (st.started) setSpeedResult(resultOf({ ...st, winner: other(mySeat), winReason: 'You were gone over two minutes, so the duel went to them' }, mySeat, false, speedSave, left?.save ?? null, null, lines, cards));
      ses.close();
      setSession(null);
      setP2Profile(null);
      setScreen('speed');
    };
    return ses.listen(check);
  }, [session, speedSave]);
  // The online room being played in is kept on the phone (refreshed as moves come in), so
  // closing the game never loses the duel; leaving the duel or the room forgets it.
  useEffect(() => {
    if (!profile) return;
    const id = profile.id;
    if (!session) return setLiveRoom(id, null);
    const skip = noResume.current;
    noResume.current = false;
    const room = session.adapter.kind === 'firebase' && !hotseat && !skip && !tagHost.current && !raidHost.current ? session.adapter.roomCode : null;
    if (!room) return;
    setLiveRoom(id, { room, host: session.adapter.isHost, mode: duelMode });
    // kept fresh while the room is open (however long a wait); a tag duel or raid isn't reopened
    const timer = window.setInterval(() => {
      const st = session.engine.state;
      if (st.tag || session.log.some((a) => (a as { type: string }).type === 'RAID_START')) setLiveRoom(id, null);
      else touchLiveRoom(id, room);
    }, 20_000);
    return () => clearInterval(timer);
  }, [session]);
  // Remembers which game this duelist was in, so a stay-logged-in visit opens straight into it.
  useEffect(() => {
    if (profile && (screen === 'speed' || screen === 'menu')) setLastGame(profile.id, screen);
  }, [profile, screen]);
  /** Title tapped: the duelist kept logged in on this phone goes straight in. */
  const [resuming, setResuming] = useState<string | null>(null);
  const start = () => {
    const kept = accounts.stayed();
    if (!kept) return setScreen('profiles');
    setResuming(kept.alias || kept.name);
    void accounts.resume().then((p) => {
      setResuming(null);
      if (!p) return setScreen('profiles');
      accounts.startSync(p);
      pickProfile(p);
    });
  };

  const switchProfile = () => {
    void accounts.stopSync(); // upload this duelist's latest progress to their account
    accounts.forget();
    session?.close();
    setSession(null);
    setProfile(null);
    online.setProfile(null);
    setSaveState(null);
    setSpeedSaveState(null);
    setSoloMode(null);
    setConfirmDelete(false);
    setScreen('profiles');
  };

  /** Duels against the computer: the run of duels against the same opponent, for the rematch call. */
  const cpuSeries = useRef<{ opp: string; series: Series } | null>(null);
  /** starts the last computer duel again (null: the duel on screen has no rematch) */
  const cpuAgain = useRef<(() => void) | null>(null);
  /**
   * A duel against the computer: rock-paper-scissors first (the START waits for it), or in a
   * rematch the last duel's loser picks. `again` starts the same duel over.
   */
  const tossThenStart = (ses: DuelSession, build: (first: Pid) => Action, opp?: string, again?: () => void) => {
    ses.autoStart = build;
    const prev = opp && cpuSeries.current?.opp === opp && rematching.current ? cpuSeries.current.series : null;
    rematching.current = false;
    cpuSeries.current = opp ? { opp, series: prev ?? { wins: [0, 0], draws: 0, last: null } } : null;
    cpuAgain.current = again ?? null;
    if (prev) {
      ses.series = { ...prev, wins: [...prev.wins] as [number, number] };
      ses.round = 1;
    }
    const last = prev?.last;
    ses.send(last === 0 || last === 1 ? { type: 'TOSS', how: 'loser', chooser: other(last) } : { type: 'TOSS', how: 'rps' });
  };
  /** this render's duel starters (a rematch tapped later must see the saves as they are now) */
  const fresh = useRef<{ startSpeedCpu?: (o: SpeedOpponent) => void; startCampaign?: (d: Duelist) => void }>({});
  /** the next computer duel is a rematch (keeps the series going) */
  const rematching = useRef(false);

  /** A room's duel is over: keep the room open for a rematch (online, or two players on this phone). */
  const parkRoom = (ses: DuelSession | null) => {
    if (!ses) return;
    const st = ses.engine.state;
    const canRematch = !cpu && !st.tag && !!ses.adapter.restart && (hotseat || (ses.adapter.kind !== 'local' && ses.status === 'connected'));
    if (!canRematch) return ses.close();
    const seat = mySeat;
    const hs = hotseat;
    const mode = gameOf();
    const p2 = p2Profile;
    const close = () => {
      unpark();
      if (!hs && ses.engine.state.winner !== null) ses.send({ type: 'REMATCH', player: seat, want: false });
      // a beat for the "no" to reach the other phone
      window.setTimeout(() => ses.close(), 600);
      rematchDock.set(null);
    };
    const round0 = ses.round;
    const unsub = ses.listen(() => {
      if (ses.startRematch()) return;
      // the host started the rematch: back into the room
      if (ses.round > round0) {
        unpark();
        rematchDock.set(null);
        settled.current = null;
        setSpeedResult(null);
        setSpeedNews([]);
        setNewsCards([]);
        setCpu(false);
        setHotseat(hs);
        setMySeat(seat);
        setDuelMode(mode);
        setP2Profile(p2);
        rematchP2.current = hs ? p2 : null;
        setSession(ses);
        setScreen('duel');
      }
    });
    const unpark = () => {
      unsub();
      if (parked.current?.ses === ses) parked.current = null;
    };
    parked.current?.close();
    parked.current = { ses, close };
    rematchDock.set({ kind: 'room', session: ses, mySeat: seat, hotseat: hs, onClose: close });
  };
  /** the room kept open after its duel, for a rematch */
  const parked = useRef<{ ses: DuelSession; close: () => void } | null>(null);
  /** a rematch on one phone: who sat in Player 2's seat */
  const rematchP2 = useRef<string | null>(null);
  /** A computer duel is over: offer to run it back. */
  const offerCpuRematch = (ses: DuelSession | null) => {
    const again = cpuAgain.current;
    const cs = cpuSeries.current;
    cpuAgain.current = null;
    if (!ses || !again || !cs || !save) return;
    cs.series = ses.series;
    const close = () => rematchDock.set(null);
    rematchDock.set({ kind: 'cpu', me: save.name, opp: cs.opp, series: ses.series, onClose: close, again: () => (close(), (rematching.current = true), again()) });
  };
  // Starting any other duel, or leaving the profile, closes a room kept open for a rematch.
  useEffect(() => {
    if (session && parked.current && parked.current.ses !== session) parked.current.close();
    if (session && rematchDock.dock?.kind === 'cpu') rematchDock.set(null);
  }, [session]);
  // The computer rematch call rides on the result screen; once that's closed it goes too.
  useEffect(() => {
    if (!speedResult && !session && rematchDock.dock?.kind === 'cpu') rematchDock.set(null);
  }, [speedResult]);
  useEffect(() => {
    if (!profile) {
      parked.current?.close();
      rematchDock.set(null);
    }
  }, [profile]);

  const startCampaign = (d: Duelist) => {
    if (!save) return;
    session?.close();
    const ses = new DuelSession(new MemoryAdapter());
    ses.send({ type: 'JOIN', player: 0, name: save.name, deck: save.main, fusion: save.fusion });
    ses.send({ type: 'JOIN', player: 1, name: displayName(d.name), deck: d.deck, fusion: d.fusion });
    tossThenStart(ses, (first) => ({ type: 'START', first, seed: randomSeed(), names: [save.name, displayName(d.name)], decks: [save.main, d.deck], fusions: [save.fusion, d.fusion] }), displayName(d.name), () => fresh.current.startCampaign?.(d));
    setHotseat(false);
    setCpu(true);
    setCpuLevel('normal');
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
    tossThenStart(ses, (first) => ({ type: 'START', first, seed: randomSeed(), names: [save.name, o.name], decks: [deck.main, o.main], fusions: [deck.extra, o.extra], mode: 'speed', skills: [deck.skill, o.skill] }), o.name, () => fresh.current.startSpeedCpu?.(o));
    setHotseat(false);
    setCpu(true);
    setCpuLevel(o.level ?? savedDifficulty());
    setMySeat(0);
    setP2Profile(null);
    setDuelMode('speed');
    setSession(ses);
    setScreen('duel');
  };

  fresh.current = { startSpeedCpu, startCampaign };

  /** A solo duel (practice, campaign, Labyrinth) against the computer. */
  const startSoloDuel = (spec: CpuDuelSpec) => {
    if (!save) return;
    session?.close();
    const ses = new DuelSession(new MemoryAdapter());
    const seed = spec.seed ?? randomSeed();
    // Rock-paper-scissors decides who goes first, unless the duel says (or watching the computer duel itself).
    const fixed = spec.first === 'me' || spec.first === 'cpu' || spec.seed !== undefined || !!spec.watch;
    const first = spec.first === 'me' ? 0 : spec.first === 'cpu' ? 1 : spec.seed !== undefined ? (spec.seed % 2) as Pid : Math.random() < 0.5 ? 0 : 1;
    ses.send({ type: 'JOIN', player: 0, name: spec.me.name, deck: spec.me.main, fusion: spec.me.extra, mode: 'speed', skill: spec.me.skill });
    ses.send({ type: 'JOIN', player: 1, name: spec.cpu.name, deck: spec.cpu.main, fusion: spec.cpu.extra, mode: 'speed', skill: spec.cpu.skill });
    const startAs = (f: Pid): Action => ({ type: 'START', first: f, seed, names: [spec.me.name, spec.cpu.name], decks: [spec.me.main, spec.cpu.main], fusions: [spec.me.extra, spec.cpu.extra], mode: 'speed', skills: [spec.me.skill, spec.cpu.skill], setup: [spec.me.setup ?? null, spec.cpu.setup ?? null] });
    if (fixed) ses.send(startAs(first));
    else tossThenStart(ses, startAs);
    soloDuel.current = { ctx: spec.context, startLp: spec.me.setup?.lp ?? 4000, spec };
    setWatchPaused(false);
    setSoloReport(null);
    setHotseat(false);
    setCpu(true);
    setCpuLevel(spec.level ?? 'normal');
    setMySeat(0);
    setP2Profile(null);
    setDuelMode('speed');
    setSession(ses);
    setScreen('duel');
  };

  /** Files a solo duel's result (or a forfeit) and goes back to that mode's screen. */
  const endSoloDuel = (left: boolean) => {
    const sd = soloDuel.current;
    if (!sd || !profile) return false;
    soloDuel.current = null;
    const o = !left && session ? outcomeOf(session.engine.state, 0, sd.startLp) : forfeit(sd.startLp);
    const speedNow = speedSave ?? loadSpeedSave(profile.id);
    const soloBefore = loadSolo(profile.id);
    // Backing out of a Ranked Duel before it starts (at the toss) costs nothing; the same opponent waits.
    if (left && sd.ctx.kind === 'ranked' && !session?.engine.state.started) {
      writeSolo(profile.id, cancelRanked(soloBefore));
      setSoloReport(null);
      session?.close();
      setSession(null);
      setScreen('speed');
      return true;
    }
    // An Anything goes deck moves the solo modes on but earns nothing, Duelist Requests included.
    const anyGoes = sd.ctx.kind === 'labyrinth' ? !!soloBefore.labyrinth.run?.open : sd.ctx.kind !== 'practice' && !!sd.ctx.open;
    const r = settleSolo(sd.ctx, o, speedNow, soloBefore);
    writeSolo(profile.id, r.solo);
    // Duelist Requests: Road and Labyrinth duels count (Practice and watching never do).
    const st = session?.engine.state;
    const req = !left && st && sd.ctx.kind !== 'practice' && !sd.spec.watch && !anyGoes ? noteRequests(r.speed, summaryOf(st, 0), true) : null;
    if (req?.lines.length) {
      setSpeedNews(req.lines);
      setNewsCards([{ who: '', won: req.cards, lost: [] }]);
    }
    const speedOut = req ? req.save : r.speed;
    if (speedOut !== speedNow) setSpeedSave(speedOut);
    setSoloReport(left && sd.ctx.kind !== 'labyrinth' && sd.ctx.kind !== 'ranked' ? null : r.report);
    lastSoloSpec.current = sd.spec;
    session?.close();
    setSession(null);
    setP2Profile(null);
    setScreen('speed');
    return true;
  };
  const lastSoloSpec = useRef<CpuDuelSpec | null>(null);

  /** `hostCode`: a room code picked in advance (a friend invite names it) */
  /** the room about to open is a tag duel or raid (not reopened after a refresh) */
  const noResume = useRef(false);
  const openSession = (c: LinkChoice | SpeedLinkChoice, mode: GameMode = 'eds', hostCode?: string) => {
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
      roomCode.current = c.mode === 'join' ? c.code : (hostCode ?? newCode());
      setSession(new DuelSession(makeOnline(roomCode.current, c.mode === 'host')));
    }
    setScreen('duel');
  };

  /** A tag duelist played by the computer. */
  const cpuTag = (d: CpuDuelist): TagDuelist => ({ name: d.name, ...deckOf(d), ctl: 'cpu' });
  /** The four duelists of a tag duel, from the plan and the two seats (this phone is seat 0). */
  const tagTeams = (plan: TagPlan, seats: { name: string; deck: string[]; fusion: string[]; skill?: string | null }[]): TagTeams => {
    const human = (i: Pid): TagDuelist => ({ name: seats[i].name, main: seats[i].deck, extra: seats[i].fusion, skill: seats[i].skill ?? null, ctl: i });
    const foes: [TagDuelist, TagDuelist] = [cpuTag(plan.foes[0]), cpuTag(plan.foes[1])];
    if (plan.layout === 'together') return [[human(0), human(1)], foes];
    if (plan.layout === 'split') return [[human(0), cpuTag(plan.partners[0]!)], [human(1), cpuTag(plan.partners[1]!)]];
    return [[human(0), cpuTag(plan.partners[0]!)], foes];
  };
  /** Starts a tag duel on this phone (with a computer partner) or opens a room for the brother. */
  const playTag = (plan: TagPlan, how: 'here' | 'host') => {
    if (!save || !myDeckNow()) return;
    const d = myDeckNow()!;
    setTagReport(null);
    setCpuLevel(plan.level);
    if (how === 'host') {
      tagHost.current = plan;
      openSession({ mode: 'host' }, 'speed');
      return;
    }
    session?.close();
    tagHost.current = null;
    const ses = new DuelSession(new MemoryAdapter());
    ses.send({ type: 'JOIN', player: 0, name: save.name, deck: d.main, fusion: d.extra, mode: 'speed', skill: d.skill });
    ses.send({ type: 'JOIN', player: 1, name: plan.foes[0].name, deck: deckOf(plan.foes[0]).main, fusion: deckOf(plan.foes[0]).extra, mode: 'speed', skill: plan.foes[0].skill });
    ses.send(tagStart(tagTeams(plan, [{ name: save.name, deck: d.main, fusion: d.extra, skill: d.skill }]), Math.random() < 0.5 ? 0 : 1, randomSeed(), plan.ctx));
    setHotseat(false);
    setCpu(false);
    setMySeat(0);
    setP2Profile(null);
    setDuelMode('speed');
    setSession(ses);
    setScreen('duel');
  };
  const joinTag = (code: string) => {
    tagHost.current = null;
    setTagReport(null);
    noResume.current = true;
    openSession({ mode: 'join', code }, 'speed');
  };
  /** Starts a raid on this phone with a computer partner, or opens a room for the brother. */
  const playRaid = (def: RaidDef, level: Difficulty, how: 'here' | 'host', partner: CpuDuelist | null) => {
    if (!save || !myDeckNow()) return;
    const d = myDeckNow()!;
    setRaidReport(null);
    tagHost.current = null;
    if (how === 'host') {
      raidHost.current = { def, level };
      openSession({ mode: 'host' }, 'speed');
      return;
    }
    raidHost.current = null;
    session?.close();
    setSession(null);
    const rs = new RaidSession(new MemoryAdapter());
    const pd = deckOf(partner!);
    rs.send({ type: 'RAID_START', plan: { raid: def.id, seed: randomSeed(), level, heroes: [{ name: save.name, main: d.main, extra: d.extra, skill: d.skill, ctl: 0 }, { name: partner!.name, main: pd.main, extra: pd.extra, skill: pd.skill, ctl: 'cpu' }] } });
    setDuelMode('speed');
    setMySeat(0);
    setRaidLocal(rs);
    setScreen('duel');
  };
  const joinRaid = (code: string) => {
    raidHost.current = null;
    tagHost.current = null;
    setRaidReport(null);
    noResume.current = true;
    openSession({ mode: 'join', code }, 'speed');
  };
  /** Files a finished (or abandoned) raid on this phone: progress, first-clear rewards, then the raid menu. */
  const endRaid = (r: RaidEnd) => {
    if (!profile) return;
    const raid = r.raid;
    const id = raid.def?.id ?? raidHost.current?.def.id ?? '';
    const speedNow = speedSave ?? loadSpeedSave(profile.id);
    const noEarn = !!activeDeck(speedNow)?.open;
    const dealt = raid.total[r.hero];
    const s = settleRaid(loadRaidProgress(profile.id), id, r.won && !r.left, dealt);
    writeRaidProgress(profile.id, s.progress);
    let lines: string[] = [];
    let cards: string[] = [];
    if (s.firstClear && !noEarn && raid.def) {
      const g = grant(speedNow, loadSolo(profile.id), CLEAR_REWARDS, raidPool(raid.def));
      setSpeedSave(g.speed);
      lines = g.lines;
      cards = g.cards;
    }
    setRaidReport({ raid: id, won: r.won && !r.left, left: r.left, stage: raid.stage, dealt, firstClear: s.firstClear, lines, cards, noEarn });
    raidHost.current = null;
    raidLocal?.close();
    setRaidLocal(null);
    session?.close();
    setSession(null);
    setP2Profile(null);
    setRaidOpen(true);
    setScreen('speed');
  };
  /** This profile's Speed Duel deck as it plays (Shadow Realm cards sit out). */
  const myDeckNow = () => {
    const full = speedSave ? activeDeck(speedSave) : null;
    return speedSave && full ? unsealedDeck(speedSave, full) : null;
  };
  /** Files a tag duel on this phone (Tag Road progress and first-win rewards) and goes back to the 2v2 menu. */
  const endTagDuel = (winner: Pid | 'draw' | null) => {
    const st = session?.engine.state;
    if (!st?.tag || !profile) return;
    settled.current = session;
    const side = sideOfPhone(st, mySeat);
    const result = winner === null ? 'l' : winner === 'draw' ? 'd' : winner === side ? 'w' : 'l';
    const ctx = st.tag.ctx ?? 'free';
    let report: TagReport = { ctx, result, settled: null };
    if (ctx.startsWith('road:')) {
      const speedNow = speedSave ?? loadSpeedSave(profile.id);
      const solo = loadSolo(profile.id);
      // An Anything goes deck moves you along the road but earns nothing; the prizes wait for a win with your own cards.
      const noEarn = !!activeDeck(speedNow)?.open;
      const r = settleTagRoad(speedNow, solo, ctx.slice(5), winner === null ? forfeit(TAG_LP) : outcomeOf(st, side, TAG_LP), Date.now(), noEarn);
      writeSolo(profile.id, r.solo);
      if (r.speed !== speedNow) setSpeedSave(r.speed);
      report = { ctx, result, settled: r, noEarn };
    }
    tagHost.current = null;
    setTagReport(report);
    session?.close();
    setSession(null);
    setP2Profile(null);
    setTagOpen(true);
    setScreen('speed');
  };
  // Friends: invites open or join rooms through here; friends see what this player is doing.
  online.bindApp({
    host: (room, game) => ((tagHost.current = null), (raidHost.current = null), openSession({ mode: 'host' }, game, room)),
    join: (room, game) => ((tagHost.current = null), (raidHost.current = null), openSession({ mode: 'join', code: room }, game)),
    deckProblem: (game) => {
      if (!save || !dbReady) return 'Your game is still loading';
      if (game === 'eds') return deckProblems(save)[0] ?? null;
      if (!speedReady) return 'Speed Duel cards are still loading';
      const deck = speedSave ? activeDeck(speedSave) : null;
      if (!deck || !speedSave) return 'Build a Speed Duel deck first';
      return [...speedDeckProblems(deck), ...collectionProblems(speedSave, deck)][0] ?? null;
    },
  });
  useEffect(() => online.watchSession(screen === 'duel' ? session : null, duelMode, screen === 'duel'), [session, screen, duelMode]);
  // Duelist Rankings: friends see this profile's link-battle record.
  useEffect(() => {
    if (profile && save) online.setBoard(boardStatsOf(save.name, speedSave, save, profile.id));
  }, [profile, save, speedSave, screen]);
  // The floating Friends button only shows on menus with no buttons along the bottom; the
  // Speed Duel side has its own Friends row on the Duel tab, and invites still pop up anywhere.
  useEffect(() => online.showButton(!!profile && !!save && (screen === 'menu' || screen === 'link')), [profile, save, screen]);

  /** The game the duel on screen belongs to (a guest follows the host's game). */
  const gameOf = (): GameMode => session?.engine.state.rules?.mode ?? session?.seats[0].mode ?? duelMode;

  /** On one phone, leaving a Speed Duel asks which player is giving up. */
  const [whoQuits, setWhoQuits] = useState(false);
  /** Online with the connection gone, leaving asks first: it counts as this player's loss. */
  const [offlineLeave, setOfflineLeave] = useState(false);

  /** the session whose result was already written (a duel settles once) */
  const settled = useRef<DuelSession | null>(null);

  const leaveDuel = (quitter?: Pid, sure = false): void => {
    if (endSoloDuel(true)) return;
    // A tag duel: leaving gives up for your team (both phones see the surrender); nothing is bet.
    const tst = session?.engine.state;
    if (session && tst?.tag && tst.started) {
      if (tst.winner === null && session.adapter.roomCode) session.send({ type: 'SURRENDER', player: sideOfPhone(tst, mySeat) });
      return endTagDuel(tst.winner);
    }
    tagHost.current = null;
    raidHost.current = null;
    const mode = gameOf();
    // Leaving a Speed Duel against another player counts as a loss: surrender first, so
    // bets and prizes settle on both phones.
    const st = session?.engine.state;
    if (mode === 'speed' && !cpu && session && st?.started && st.winner === null) {
      if (hotseat && quitter === undefined) return setWhoQuits(true);
      setWhoQuits(false);
      // The other phone can't hear us: leaving now is this player's loss (switching the
      // connection off never dodges a bet). Asked first, since waiting may bring them back.
      if (!hotseat && session.status !== 'connected') {
        // (an opponent who didn't come back: the win is taken at once, nothing to confirm)
        if (!sure && !session.adapter.abandoned?.()) return setOfflineLeave(true);
        setOfflineLeave(false);
        // the other phone walked out long ago (online rooms say so): the win goes to the one who stayed
        const won = !!session.adapter.abandoned?.();
        const left0 = speedSave ? settleLeftDuel(speedSave, won ? mySeat : undefined) : null;
        settled.current = session;
        // a duel that got going still moves the Ranked ladder: dropping out can't dodge a lost star
        let left = left0;
        let rankedLine: string | null = null;
        const base = left0?.save ?? speedSave;
        if (base && profile && st.turn >= RIVAL_MIN_TURNS && !activeDeck(base)?.open) {
          const lr = settleLinkRanked(base, loadSolo(profile.id), won ? 'w' : 'l', st.players[other(mySeat)].name);
          writeSolo(profile.id, lr.solo);
          postProfileRank(profile, save?.name || profile.alias, lr.solo.ranked);
          rankedLine = lr.line;
          if (left0) left = { ...left0, save: lr.speed };
          else setSpeedSave(lr.speed);
        }
        if (left) setSpeedSave(left.save);
        const lines = [
          ...(left ? left.lines.map((l) => l.replace(' gave up the unfinished duel, so ', " didn't rejoin within two minutes, so ")) : [won ? "Your opponent didn't come back, so the win is yours." : 'The connection was lost, so this friendly duel has no result.']),
          ...(rankedLine ? [rankedLine] : []),
        ];
        const cards: NewsCards = left ? [{ who: '', won: left.won, lost: left.lost }] : [];
        setSpeedNews(lines);
        setNewsCards(cards);
        // the one who stayed gets the full victory screen
        if (!won) session.adapter.forfeit?.();
        if (won) setSpeedResult(resultOf({ ...st, winner: mySeat, winReason: "Opponent disconnected and didn't come back" }, mySeat, false, speedSave, left?.save ?? null, null, lines, cards));
        session.close();
        setSession(null);
        setP2Profile(null);
        setScreen('speed');
        return;
      }
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

  /** The finished Speed Duel goes into this duelist's replays (and is the one the result screen offers). */
  const keepReplay = () => {
    const st = session?.engine.state;
    if (!profile || !session || !st) return setLastReplay(null);
    // (not a duel the computer played against itself; written after the duel's own results, which come first)
    const r = soloDuel.current?.spec.watch ? null : replayOf(session.log, st, mySeat, cpu ? 'cpu' : hotseat ? 'hotseat' : 'online');
    setLastReplay(r);
    const id = profile.id;
    if (r) window.setTimeout(() => saveReplay(id, r), 1500);
  };
  const finishDuel = (winner: Pid | 'draw', oppName: string): void => {
    if (session && settled.current === session) return;
    settled.current = session;
    keepReplay();
    if (!save) return leaveDuel();
    if (endSoloDuel(false)) return;
    if (session?.engine.state.tag) return endTagDuel(winner);
    const mine = winner === 'draw' ? 'd' : winner === mySeat ? 'w' : 'l';
    if (gameOf() === 'speed') {
      // Speed Duel keeps its own record; no booster packs or calendar days.
      // Overkill finish: the loser is sent to the Shadow Realm and their best monster is sealed.
      const sr = session ? shadowRealmOf(session.engine.state) : null;
      if (sr) recordShadow(sr);
      // Card leveling: each profile's cards rank up from what they did this duel.
      const st = session?.engine.state;
      let myLevels: LevelReport | null = null;
      const lv = (s: SpeedSave, seat: Pid) => {
        // A surrender before the duel got going teaches the cards nothing (no free level points).
        if (!st || tooQuick({ surrender: /surrendered$/.test(st.winReason), turns: st.turn, damage: lpLostIn(st) })) return s;
        // Past Overframe only duels that count move the meter: your own deck against the computer, or a duel with stakes.
        const two = session?.seats;
        const deep = cpu ? !activeDeck(s)?.open : !!two && staked(two[0].stakes, two[1].stakes);
        const r = withLevels(s, st, seat, Date.now(), deep);
        if (seat === mySeat) myLevels = r.report;
        return r.save;
      };
      // The collection: packs and chips won, bets and rescues between two players.
      const seats = session?.seats;
      const news: string[] = [];
      const cards: NewsCards = [];
      const prizes = (s: SpeedSave, seat: Pid, result: 'w' | 'l' | 'd', opp: string): SpeedSave => {
        if (cpu) {
          if (result !== 'w') return s;
          const r = cpuWinPrize(s, opp, activeDeck(s));
          if (seat === mySeat) news.push(...r.lines);
          return r.save;
        }
        if (!st || !seats || !seats[other(seat)].stakes?.profile) return s;
        const bet = settleStakes(s, seat, st, [seats[0], seats[1]], winner);
        const before = crownHolder(s, opp);
        const rv = rivalResult(bet.save, { result, opp, turns: st.turn, counts: staked(seats[0].stakes, seats[1].stakes), online: !hotseat, surrender: /surrendered$/.test(st.winReason), damage: lpLostIn(st) });
        // Online link battles that count also move this duelist's Ranked ladder (on their own phone).
        let save2 = rv.save;
        const realDuel = !hotseat && seat === mySeat && profile && st.turn >= RIVAL_MIN_TURNS && !tooQuick({ surrender: /surrendered$/.test(st.winReason), turns: st.turn, damage: lpLostIn(st) });
        if (realDuel && !activeDeck(s)?.open) {
          const lr = settleLinkRanked(save2, loadSolo(profile.id), result, opp);
          writeSolo(profile.id, lr.solo);
          postProfileRank(profile, save?.name || profile.alias, lr.solo.ranked);
          save2 = lr.speed;
          if (lr.line) rv.lines.push(lr.line);
          if (lr.lines.length) rv.lines.push(...lr.lines.filter((l) => !l.includes(': ') || l.startsWith('Title')));
          if (lr.cards.length) cards.push({ who: seats[seat].name, won: lr.cards, lost: [] });
        }
        rv.save = save2;
        const after = crownHolder(rv.save, opp);
        if (after === 'me' && before !== 'me') rv.lines.unshift(`👑 ${seats[seat].name} takes the King of Games crown from ${opp}!`);
        cards.push({ who: seats[seat].name, won: bet.won, lost: bet.lost });
        const named = (l: string) => (l.startsWith('👑') || !hotseat ? l : `${seats[seat].name}: ${l}`);
        news.push(...(seat === mySeat ? [...bet.lines, ...rv.lines.map(named)] : rv.lines.map(named)));
        return rv.save;
      };
      // Duelist Requests: duels that pay prizes move today's requests on.
      const reqs = (s: SpeedSave, seat: Pid): SpeedSave => {
        if (!st) return s;
        const counts = cpu ? !activeDeck(s)?.open : !!seats && staked(seats[0].stakes, seats[1].stakes) && !tooQuick({ surrender: /surrendered$/.test(st.winReason), turns: st.turn, damage: lpLostIn(st) });
        const r = noteRequests(s, summaryOf(st, seat), counts);
        const who = seats?.[seat].name ?? '';
        news.push(...(hotseat && !cpu ? r.lines.map((l) => `${who}: ${l}`) : r.lines));
        if (r.cards.length) cards.push({ who, won: r.cards, lost: [] });
        return r.save;
      };
      // A rescue frees the rescued card through the Shadow Realm's own "a win frees one".
      const first = (s: SpeedSave, seat: Pid) => (!cpu && st && seats ? rescueFirst(s, seat, st, [seats[0], seats[1]], winner) : s);
      const mineAfter = speedSave ? withTicket(reqs(lv(prizes(withShadow(first(withSpeedResult(speedSave, mine, oppName), mySeat), mine, sr, mySeat, oppName, cpu).save, mySeat, mine, oppName), mySeat), mySeat), null) : null;
      if (mineAfter) setSpeedSave(mineAfter);
      if (hotseat && p2Profile && p2Profile !== profile?.id) {
        const theirs = mine === 'w' ? 'l' : mine === 'l' ? 'w' : 'd';
        const seat2 = other(mySeat);
        writeSpeedSave(p2Profile, withTicket(reqs(lv(prizes(withShadow(first(withSpeedResult(speedSaveOf(p2Profile), theirs, save.name), seat2), theirs, sr, seat2, save.name, false).save, seat2, theirs, save.name), seat2), seat2), null));
      }
      const allNews = [...carryNews.current, ...news];
      setSpeedNews(allNews);
      carryNews.current = [];
      setNewsCards(cards);
      if (st) {
        const data = resultOf(st, mySeat, hotseat, speedSave, mineAfter, myLevels, allNews, cards);
        // a duel with another player: the head-to-head so far
        const rv = !cpu && !hotseat && mineAfter ? rivalsOf(mineAfter)[oppName] : undefined;
        if (rv && rv.w + rv.l + rv.d > 0) data.rival = { opp: oppName, ...rv };
        setSpeedResult(data);
      }
      if (cpu) {
        session?.close();
        offerCpuRematch(session);
      } else parkRoom(session);
      setSession(null);
      setP2Profile(null);
      setScreen('speed');
      return;
    }
    // Link Battle results get their own rows, so a brother called "Yugi Muto" can't open Campaign stages.
    const recordName = cpu ? oppName : `Link: ${oppName}`;
    const next = withResult(save, mine, recordName);
    setSave(next);
    // Hotseat with a second profile: Player 2's own save gets the result too.
    if (hotseat && p2Profile && p2Profile !== profile?.id) {
      const theirs = loadSave(p2Profile);
      if (theirs) writeSave(p2Profile, withResult(theirs, mine === 'w' ? 'l' : mine === 'l' ? 'w' : 'd', `Link: ${save.name}`));
    }
    if (cpu) {
      session?.close();
      offerCpuRematch(session);
    } else parkRoom(session);
    setSession(null);
    setP2Profile(null);
    setScreen(next.pendingPacks > 0 ? 'pack' : 'menu');
  };

  /** The leave-duel sheet (from the back button) was confirmed. */
  const confirmLeave = () => {
    setAskLeave(false);
    const st = session?.engine.state;
    // Leaving an online duel concedes it, so your opponent isn't left waiting.
    // (offline, nobody would hear it: leaveDuel settles that leave instead)
    if (session && st?.started && st.winner === null && session.adapter.roomCode && !hotseat && !st.tag && session.status === 'connected') session.send({ type: 'SURRENDER', player: mySeat });
    leaveDuel();
  };
  const closeResult = () => {
    setReplaying(null);
    setSpeedResult(null);
    setSpeedNews([]);
    setNewsCards([]);
  };

  // Android back button: back to the main menu from any menu screen; in a duel, ask first.
  useBackButton(() => {
    if (replaying) {
      setReplaying(null);
      return true;
    }
    if (online.panelOpen) {
      online.openPanel(false);
      return true;
    }
    // A raid asks before leaving (its own sheet).
    if (raidActive()) return soloBack();
    if (screen === 'duel' && session) {
      const st = session.engine.state;
      if (st.winner !== null) {
        const opp = st.players[mySeat === 0 ? 1 : 0].name;
        finishDuel(st.winner, opp === 'Téa Gardner' ? 'Tea Gardner' : opp);
        return true;
      }
      // A duel in progress asks first (an in-game sheet); a second back press keeps dueling.
      if (st.started) {
        setAskLeave(!askLeave);
        return true;
      }
      leaveDuel();
      return true;
    }
    if (screen === 'speed' && speedResult) {
      closeResult();
      return true;
    }
    // Speed Duel's own screens step back to the Speed Duel menu first.
    if (screen === 'speed' && !soloMode && speedHubBack()) return true;
    // The solo modes step back through their own sheets and screens.
    if (screen === 'speed' && (soloMode || tagOpen || raidOpen)) return soloBack();
    if (screen !== 'title' && screen !== 'profiles' && screen !== 'intro' && screen !== 'menu' && screen !== 'duel') {
      setScreen('menu');
      return true;
    }
    return false;
  });

  if (screen === 'title') return <Title hasSave={loadProfiles().length > 0} who={accounts.stayed()?.alias} opening={resuming} onStart={start} />;
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
        onSpeed={(_name, color, deck) => {
          const s = newSave(profile.alias);
          s.starter = color;
          s.main = deck;
          addToTrunk(s, []);
          setSave(s);
          setLastGame(profile.id, 'speed');
          setSpeedSaveState(speedSaveOf(profile.id, true));
          setScreen(pendingJoin ? 'link' : 'speed');
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
    if (c === 'controls') return setSave(withControls(save, 'eds', controlsOf(save, 'eds') === 'touch' ? 'classic' : 'touch'));
    if (c === 'speed' && profile) setSpeedSaveState(speedSaveOf(profile.id, true));
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
                {profile.name !== profile.alias ? ` (${profile.name})` : ''}?{' '}
                {profile.uid ? 'It leaves this phone, but their progress stays in their account, so they can log in again any time.' : 'All of their cards, decks and record will be gone for good.'}
              </p>
            </div>
            <Menu
              items={[
                { label: 'Keep it', onPick: () => setConfirmDelete(false) },
                {
                  label: `Delete ${profile.alias}`,
                  onPick: () => {
                    accounts.remove(profile); // a shared account keeps its progress; only this phone's copy goes
                    online.forget(profile.id);
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

  /** Each seat's control style for the game on screen (each game keeps its own): in a hotseat duel Player 2's own profile decides theirs. */
  const controlsFor = (p: Pid): ControlStyle => {
    const game = gameOf();
    if (hotseat && p === 1) return controlsOf(p2Profile ? loadSave(p2Profile) : null, game);
    return controlsOf(save, game);
  };
  const setControls = (p: Pid, c: ControlStyle) => {
    const game = gameOf();
    if (hotseat && p === 1) {
      const theirs = p2Profile && p2Profile !== profile.id ? loadSave(p2Profile) : null;
      if (theirs) writeSave(p2Profile!, withControls(theirs, game, c));
      // A guest's choice lasts for this duel only.
      return;
    }
    setSave(withControls(save, game, c));
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
      const newsOverlay = speedNews.length > 0 && (
            <Overlay onClose={() => setSpeedNews([])}>
              <Win title="After the duel" onClose={() => setSpeedNews([])}>
                {newsCards
                  .filter((c) => c.won.length + c.lost.length > 0)
                  .map((c, j, all) => (
                    <div key={j} class="news-cards">
                      {all.length > 1 && c.who && <b class="nc-who">{c.who}</b>}
                      {c.won.map((n, i) => (
                        <span key={`w${i}`} class="nc won">
                          <CardImg name={n} />
                          won
                        </span>
                      ))}
                      {c.lost.map((n, i) => (
                        <span key={`l${i}`} class="nc lost">
                          <CardImg name={n} />
                          lost
                        </span>
                      ))}
                    </div>
                  ))}
                <ul class="prize-lines">
                  {speedNews.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
                <Menu items={[{ label: 'OK', onPick: () => setSpeedNews([]) }]} />
              </Win>
            </Overlay>
          );
      if (speedResult) {
        // against the computer the rematch is a button beside Continue (no banner over the rewards)
        const cpuDock = rematchDock.dock?.kind === 'cpu' ? rematchDock.dock : null;
        return (
          <>
            {/* (hidden, not closed, while the replay plays: back from it is the same result screen) */}
            <div style={replaying ? { display: 'none' } : undefined}>
              <SpeedResult data={speedResult} onContinue={closeResult} onRematch={cpuDock ? () => (cpuDock.again(), closeResult()) : undefined} onReplay={lastReplay ? () => setReplaying(lastReplay) : undefined} />
            </div>
            {replaying && <ReplayPlayer replay={replaying} controls={controlsFor(0)} onClose={() => setReplaying(null)} />}
          </>
        );
      }
      if (raidOpen)
        return (
          <RaidHub
            speed={speedSave ?? speedSaveOf(profile.id)}
            solo={loadSolo(profile.id)}
            progress={loadRaidProgress(profile.id)}
            report={raidReport}
            onReportSeen={() => setRaidReport(null)}
            onPlay={playRaid}
            onJoin={joinRaid}
            onSpeed={setSpeedSave}
            onBack={() => (setRaidReport(null), setRaidOpen(false))}
          />
        );
      if (tagOpen)
        return (
          <TagHub
            speed={speedSave ?? speedSaveOf(profile.id)}
            solo={loadSolo(profile.id)}
            report={tagReport}
            onReportSeen={() => setTagReport(null)}
            onPlay={playTag}
            onJoin={joinTag}
            onSpeed={setSpeedSave}
            onBack={() => (setTagReport(null), setTagOpen(false))}
          />
        );
      if (soloMode)
        return (
          <>
            <Solo
              mode={soloMode}
              profile={profile}
              name={save.name}
              speed={speedSave ?? speedSaveOf(profile.id)}
              onSpeed={setSpeedSave}
              report={soloReport}
              lastSpec={lastSoloSpec.current}
              onReportSeen={() => setSoloReport(null)}
              onDuel={startSoloDuel}
              onMode={setSoloMode}
              onExit={() => (setSoloReport(null), setSoloMode(null))}
            />
            {!soloReport && newsOverlay}
          </>
        );
      return (
        <>
          <SpeedHub key={profile.id} onTag={() => setTagOpen(true)} onRaid={() => setRaidOpen(true)} controls={controlsOf(save, 'speed')} onControls={() => setSave(withControls(save, 'speed', controlsOf(save, 'speed') === 'touch' ? 'classic' : 'touch'))} onSolo={setSoloMode} profile={profile} save={speedSave ?? speedSaveOf(profile.id)} onSave={setSpeedSave} onExit={() => setScreen('menu')} onCpu={startSpeedCpu} onLink={(c) => openSession(c, 'speed')} />
          {unfinished && (
            <Overlay>
              <Win title="Unfinished duel">
                <p>
                  {unfinished.t.seats[0].name} and {unfinished.t.seats[1].name} never finished their duel on this phone, so the bets are still on. Who gave up?
                </p>
                <Menu items={([0, 1] as Pid[]).map((p) => ({ label: `${unfinished.t.seats[p].name} gave up`, onPick: () => settleUnfinished(other(p)) }))} />
              </Win>
            </Overlay>
          )}
          {newsOverlay}
        </>
      );
    case 'duel': {
      const watching = soloDuel.current?.spec.watch;
      if (raidLocal) return <RaidPlay rs={raidLocal} phone={0} controlsFor={controlsFor} onControls={setControls} onEnd={endRaid} />;
      if (!session) return menu;
      if (offlineLeave)
        return (
          <Overlay onClose={() => setOfflineLeave(false)}>
            <Win title={session.adapter.abandoned?.() ? "Your opponent didn't come back" : 'Connection lost'} onClose={() => setOfflineLeave(false)}>
              {session.adapter.abandoned?.() ? (
                <p>Your opponent didn't rejoin within two minutes. Leave now and the win is yours.</p>
              ) : (
                <p>The other phone can't be reached. Leaving now counts as your loss, bets included. Waiting keeps the duel going: it carries on as soon as you're both back.</p>
              )}
              <Menu
                items={[
                  ...(session.adapter.abandoned?.()
                    ? [
                        { label: 'Take the win', onPick: () => leaveDuel(mySeat, true) },
                        { label: 'Keep waiting', onPick: () => setOfflineLeave(false) },
                      ]
                    : [
                        { label: 'Keep waiting', onPick: () => setOfflineLeave(false) },
                        { label: 'Leave and take the loss', onPick: () => leaveDuel(mySeat, true) },
                      ]),
                ]}
              />
            </Win>
          </Overlay>
        );
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
      return (
        <>
          <Running deckSwitch={speedSave && speedSave.decks.length > 1 ? <DeckSwitch decks={speedSave.decks} current={activeDeck(speedSave)} problemsOf={(d) => [...speedDeckProblems(d), ...collectionProblems(speedSave, d)]} onPick={(d) => setSpeedSave({ ...speedSave, active: d.id })} /> : undefined} session={session} hotseat={hotseat} cpu={cpu} cpuLevel={cpuLevel} mySeat={mySeat} mode={duelMode} entries={tagHost.current || raidHost.current ? noStakes(entries) : entries} onRaidEnd={endRaid} tag={raidHost.current ? raidRoom(raidHost.current.def, raidHost.current.level) : tagHost.current ? { note: tagNote(tagHost.current), start: (seats) => tagStart(tagTeams(tagHost.current!, seats), Math.random() < 0.5 ? 0 : 1, randomSeed(), tagHost.current!.ctx) } : undefined} betSave={(seat) => (seat === mySeat ? speedSave : hotseat && p2Profile && p2Profile !== profile.id ? speedSaveOf(p2Profile) : null)} others={hotseat ? others() : []} onSeatProfile={setP2Profile} controlsFor={controlsFor} onControls={setControls} onLeave={() => leaveDuel()} onFinished={finishDuel} onStarted={(seats, key) => ticketsFor([seats[0], seats[1]], key)} rematchP2={rematchP2.current} watch={watching ? { tactics: watching.tactics, speed: watchSpeed, paused: watchPaused } : undefined} />
          {soloDuel.current && <SoloHud vs={soloDuel.current.spec.vs} />}
          {watching && <WatchBar speed={watchSpeed} paused={watchPaused} onSpeed={setWatchSpeed} onPause={setWatchPaused} onLeave={() => leaveDuel()} />}
          {askLeave && session.engine.state.started && session.engine.state.winner === null && (
            <ConfirmSheet look={gameOf() === 'speed' ? 'md' : 'gba'} title="Leave this duel?" confirmLabel="Leave" cancelLabel="Keep dueling" danger onCancel={() => setAskLeave(false)} onConfirm={confirmLeave}>
              {soloDuel.current?.ctx.kind === 'labyrinth' ? 'It counts as a loss and costs a heart.' : soloDuel.current?.ctx.kind === 'ranked' ? 'It counts as a Ranked loss.' : session.adapter.roomCode && !hotseat ? 'Leaving concedes the duel: it counts as your loss.' : 'This duel will end here.'}
            </ConfirmSheet>
          )}
        </>
      );
    }
    default:
      return menu;
  }
}

/** The room a Boss Raid host opens: Start sends the raid with both seats' decks. */
function raidRoom(def: RaidDef, level: Difficulty): { note: string; title: string; start: (seats: SessionView['seats']) => Action } {
  return {
    title: 'Boss Raid',
    note: `you and your brother vs ${def.title}`,
    start: (seats) => {
      const hero = (i: Pid) => ({ name: seats[i].name, main: seats[i].deck, extra: seats[i].fusion, skill: seats[i].skill ?? null, ctl: i });
      const m: RaidMsg = { type: 'RAID_START', plan: { raid: def.id, seed: randomSeed(), level, heroes: [hero(0), hero(1)] } };
      return m as unknown as Action;
    },
  };
}

/** A tag room's seats carry no bets. */
function noStakes(entries: Partial<Record<GameMode, SeatEntry>>): Partial<Record<GameMode, SeatEntry>> {
  const out: Partial<Record<GameMode, SeatEntry>> = {};
  for (const [k, v] of Object.entries(entries) as [GameMode, SeatEntry][]) out[k] = { ...v, stakes: undefined };
  return out;
}

function tagNote(p: TagPlan): string {
  const vs = `${p.foes[0].name} & ${p.foes[1].name}`;
  if (p.layout === 'split') return `you and ${p.partners[0]?.name} vs your brother and ${p.partners[1]?.name}`;
  return `you and your brother vs ${vs}${p.ctx.startsWith('road:') ? ' (Tag Road)' : ''}`;
}
/** What the Speed Duel result screen shows: read from the finished duel and the save before and after it was settled. */
function resultOf(st: DuelState, mySeat: Pid, hotseat: boolean, before: SpeedSave | null, after: SpeedSave | null, levels: LevelReport | null, lines: string[], cards: NewsCards): SpeedResultData {
  const w = st.winner;
  const me = st.players[mySeat];
  const opp = st.players[other(mySeat)];
  const outcome = w === null || w === 'draw' ? 'draw' : hotseat || w === mySeat ? 'win' : 'lose';
  const title = w === null || w === 'draw' ? 'DRAW' : hotseat ? `${st.players[w].name} WINS` : w === mySeat ? 'VICTORY' : 'DEFEAT';
  const rewards: ResultReward[] = [];
  if (before && after) {
    const chips = chipsOf(after) - chipsOf(before);
    const packs = packsOf(after) - packsOf(before);
    if (chips > 0) rewards.push({ kind: 'chips', n: chips });
    if (packs > 0) rewards.push({ kind: 'packs', n: packs });
  }
  const rows = levels?.rows ?? [];
  for (const r of rows) {
    const t = tierIndex(r.after);
    if (t > tierIndex(r.before)) rewards.push({ kind: 'rank', card: r.name, tier: TIERS[t].short, tierName: TIERS[t].name });
  }
  const earned = rows.filter((r) => r.after > r.before).length;
  if (earned > 0) rewards.push({ kind: 'xp', cards: earned });
  for (const c of cards) {
    const who = cards.length > 1 && c.who ? c.who : undefined;
    for (const n of c.won) rewards.push({ kind: 'card', card: n, won: true, who });
    for (const n of c.lost) rewards.push({ kind: 'card', card: n, won: false, who });
  }
  for (const l of lines) rewards.push({ kind: 'line', text: l });
  // never a blank screen: say why nothing came of it
  if (!rewards.length) {
    const quit = /surrendered$/.test(st.winReason) && st.winner !== mySeat;
    rewards.push({ kind: 'line', text: quit && st.turn < 3 ? 'Given up before the duel got going: no rewards, and no card level points.' : outcome === 'win' ? 'Nothing riding on this one.' : 'No rewards this time.' });
  }
  return { outcome, title, reason: st.winReason || undefined, lp: [{ name: me.name, lp: me.lp }, { name: opp.name, lp: opp.lp }], turns: st.turn, rewards, stats: duelStats(st, mySeat) };
}
/** What this player's cards did in the duel, and the card that did the most (Master Duel's MVP). */
function duelStats(st: DuelState, seat: Pid): SpeedResultData['stats'] {
  const deeds = (st.fx?.lvl as { s: Record<string, Deeds>[] } | undefined)?.s?.[seat];
  if (!deeds) return undefined;
  let dealt = 0;
  let kills = 0;
  let plays = 0;
  let mvp: { name: string; score: number } | null = null;
  for (const [name, d] of Object.entries(deeds)) {
    const dmg = (d.bd ?? 0) + (d.dd ?? 0) + (d.ed ?? 0);
    dealt += dmg;
    kills += d.k ?? 0;
    plays += d.p ?? 0;
    const score = dmg + 600 * (d.k ?? 0) + 100 * (d.p ?? 0);
    if (score > 0 && (!mvp || score > mvp.score)) mvp = { name, score };
  }
  return { dealt, kills, plays, mvp: mvp?.name };
}
/** Life Points both players lost (damage and costs) over the whole duel. */
const lpLostIn = (st: DuelState) => ((st.fx.lpLost ?? [0, 0]) as number[]).reduce((a, b) => a + (b ?? 0), 0);

/** Your all-time record with another player, from your save (null: none yet). */
function rivalOf(s: SpeedSave | null, opp: string): Rival | null {
  if (!s || !opp) return null;
  return rivalsOf(s)[opp === 'Téa Gardner' ? 'Tea Gardner' : opp] ?? null;
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
  cpuLevel = 'normal',
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
  onStarted,
  watch,
  tag,
  rematchP2,
  onRaidEnd,
  deckSwitch,
}: {
  /** the room's "Duel with … Change" line (Speed Duel decks), before the duel starts */
  deckSwitch?: preact.ComponentChildren;
  session: DuelSession;
  hotseat: boolean;
  cpu: boolean;
  /** how sharp the computer plays (not used when watching: each side has its own tactics) */
  cpuLevel?: Difficulty;
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
  /** a Link Battle with stakes just started (keep a ticket in case the app is closed) */
  onStarted?: (seats: SessionView['seats'], key: string) => void;
  /** the computer plays both seats (Practice: watch a duel), at the viewer's speed */
  watch?: { tactics: [Tactics, Tactics]; speed: number; paused: boolean };
  /** this phone hosts a 2v2 Tag Duel room (or a Boss Raid: `title`) */
  tag?: { note: string; title?: string; start: (seats: SessionView['seats']) => Action };
  /** a Boss Raid played in this room ended */
  onRaidEnd?: (r: RaidEnd) => void;
  /** a rematch on one phone: who sat in Player 2's seat */
  rematchP2?: string | null;
}) {
  const view = useDuelSession(session);
  // a guest follows the host's game
  setUiGame(view.state.rules?.mode ?? view.seats[0].mode ?? mode);
  useEffect(() => {
    if (view.state.started && view.state.winner === null && !cpu && !view.state.tag && view.state.rules?.mode === 'speed') onStarted?.(view.seats, String(view.state.seed));
  }, [view.state.started]);
  const cpuStreak = useRef(0);
  // When the current turn began (its banner went up): the computer waits for the banner to finish.
  const turnAt = useRef({ turn: -1, at: 0 });
  if (view.state.turn !== turnAt.current.turn) turnAt.current = { turn: view.state.turn, at: Date.now() };
  // Dev builds only: lets UI tests reach the end of a duel.
  if (import.meta.env.DEV) (window as unknown as { __session?: DuelSession }).__session = session;
  // The computer takes its turn a beat after each change, so the player can follow along.
  useEffect(() => {
    // A tag duel: the computer duelists move from phone 0 only, whenever one of them is in and on the spot.
    const tagCpu = !!view.state.tag && runsComputers(mySeat);
    if (!(cpu || tagCpu) || !view.state.started || view.state.winner !== null || watch?.paused) return;
    // The computer thinks once the board is still (after any cinematic and the move's own animation),
    // so its thinking never lands in the middle of an animation as a stutter.
    let t = 0;
    let dead = false;
    const think = () => {
      if (dead) return;
      // Watching: whichever seat has something to do moves, each with its own pep talk.
      let seat: Pid = mySeat === 0 ? 1 : 0;
      let action = watch ? null : aiAction(session.engine, seat, { ...DEFAULT_TACTICS, level: cpuLevel });
      if (tagCpu) {
        const w = whoMoves(session.engine.state);
        seat = w.side;
        action = w.ctl === 'cpu' ? aiAction(session.engine, seat, { ...DEFAULT_TACTICS, level: cpuLevel }) : null;
      }
      if (watch) {
        const st = session.engine.state;
        const first: Pid = (st.prompt?.player ?? st.turnPlayer) as Pid;
        for (const p of [first, (first === 0 ? 1 : 0) as Pid]) {
          action = aiAction(session.engine, p, watch.tactics[p]);
          if (action) {
            seat = p;
            break;
          }
        }
      }
      if (!action) {
        cpuStreak.current = 0;
        return;
      }
      // Safety net: if the computer somehow keeps sending moves the rules ignore, end its turn.
      cpuStreak.current++;
      if (cpuStreak.current > 80) {
        cpuStreak.current = 0;
        session.send({ type: 'END_TURN', player: seat });
        return;
      }
      const quick = action.type === 'NEXT_PHASE' || action.type === 'PASS' || action.type === 'CHOOSE';
      // Master Duel pacing: nothing under the turn banner, then a readable beat per move (shorter at a
      // faster Animation speed) with a spotlight on the card it moves...
      const st = session.engine.state;
      const pace = watch ? (quick ? 250 : 900) / watch.speed : cpuDelay(action, { sinceTurn: Date.now() - turnAt.current.at, firstTurn: st.turn === 1, ownTurn: st.turnPlayer === seat && !st.prompt, animSpeed: getAnimSpeed() });
      const send = () => {
        const uid = spotUid(action!);
        session.send(action!);
        if (uid !== null) spotlight(uid);
      };
      t = window.setTimeout(send, Math.max(0, pace - THINK_BEAT));
    };
    // ...and never in the middle of a 3D cinematic.
    const stopWaiting = whenArtIdle(() => (t = window.setTimeout(think, THINK_BEAT)));
    return () => ((dead = true), stopWaiting(), clearTimeout(t));
  }, [cpu, cpuLevel, view.moves, view.state.started, view.state.winner, session, mySeat, watch?.paused, watch?.speed]);
  // Card leveling: each card in the duel shows its owner's rarity.
  // (a tag duel: each side shows the rarities of the phones playing on it; computers have none)
  const sideRarity = (side: Pid) => {
    const c = view.state.tag?.ctl?.[side];
    if (!c) return view.seats[side].rarity;
    return Object.assign({}, ...c.filter((x): x is Pid => x !== 'cpu').map((x) => view.seats[x].rarity ?? {}));
  };
  showDuelRarity(view.state.started && view.state.rules?.mode === 'speed' ? [sideRarity(0), sideRarity(1)] : null);
  useEffect(() => () => showDuelRarity(null), []);
  // A Boss Raid: the host started it in the room; both phones play it from the room's log.
  // Online rooms between two phones: a chat over every screen of the room (not tag duels or raids).
  // It is always the first child below, so it stays the same chat (open, typed text) as the screens change.
  // (a tag or raid room's lobby too, for its first two phones: they can't tell yet what the room is for)
  const chatOn = !!session.adapter.roomCode && !hotseat && !cpu && !watch && !view.state.tag && mySeat <= 1;
  const st0 = view.state;
  // (your own turn's steps and anything asking you to choose; the other player's steps leave it open)
  const toss = view.toss;
  const attention =
    st0.started && st0.winner === null
      ? `${st0.turnPlayer === mySeat ? `${st0.turn}:${st0.phase}:${st0.battle ? 1 : 0}` : 'theirs'}:${st0.prompt?.player === mySeat ? `${view.moves}` : ''}`
      : // (who goes first: the throw or the call is yours, then the pick)
        !st0.started && toss
        ? `toss:${toss.round}:${toss.hands[mySeat] ? 1 : 0}:${toss.chooser === mySeat && toss.first === null ? 'pick' : ''}`
        : '';
  const chat = chatOn ? <DuelChat session={session} chat={view.chat} mySeat={mySeat} attention={attention} classic={controlsFor(mySeat) === 'classic'} mine={st0.started && st0.winner === null && st0.turnPlayer === mySeat} place={view.state.started ? 'duel' : 'low'} names={[view.seats[0].name || (view.state.started ? view.state.players[0].name : ''), view.seats[1].name || (view.state.started ? view.state.players[1].name : '')]} /> : null;
  if (onRaidEnd && view.log.some((a) => (a as { type: string }).type === 'RAID_START')) return <RaidRoom adapter={session.adapter} phone={mySeat} controlsFor={controlsFor} onControls={onControls} onEnd={onRaidEnd} />;
  if (!view.state.started && view.toss && !tag) {
    const game = view.seats[0].mode ?? mode;
    return (
      <>
        {chat}
        <TossScreen session={session} view={view} mySeat={mySeat} hotseat={hotseat} cpuSeat={cpu ? other(mySeat) : null} buildStart={session.autoStart ?? ((first) => startFromSeats(session.seats, game, first))} rival={cpu || hotseat || tag ? null : rivalOf(betSave(mySeat), view.seats[other(mySeat)].name)} />
      </>
    );
  }
  if (!view.state.started)
    return (
      <>
        {chat}
        <Lobby session={session} view={view} mySeat={mySeat} hotseat={hotseat} mode={mode} entries={entries} others={others} onSeatProfile={onSeatProfile} onLeave={onLeave} betSave={betSave} tag={tag} rematchP2={rematchP2} deckSwitch={deckSwitch} />
      </>
    );
  if (view.state.tag) {
    // A tag duel: this phone sees the board from its team's side and moves only when its duelist is in.
    const st = view.state;
    const side = sideOfPhone(st, mySeat);
    const locked = ctlOf(st, side, activeMember(st, side)) !== mySeat;
    const label = (s: Pid, m: 0 | 1) => (ctlOf(st, s, m) === mySeat ? 'You' : st.tag!.teams[s].names[m]);
    return (
      <>
        <Duel session={session} view={view} mySeat={side} hotseat={false} controlsFor={controlsFor} onControls={onControls} onLeave={onLeave} onFinished={(w) => onFinished(w, sideName(st, other(side)))} locked={locked} />
        <TagBar state={st} phone={mySeat} labels={label} />
      </>
    );
  }
  const oppName = view.state.players[mySeat === 0 ? 1 : 0].name === 'Téa Gardner' ? 'Tea Gardner' : view.state.players[mySeat === 0 ? 1 : 0].name;
  return (
    <>
      {chat}
      <Duel session={session} view={view} mySeat={mySeat} hotseat={hotseat} controlsFor={controlsFor} onControls={onControls} onLeave={onLeave} onFinished={(w) => onFinished(w, oppName)} spectator={!!watch} clock={!cpu && !hotseat && !watch} />
      {!cpu && view.state.winner === null && <DuelPot view={view} />}
    </>
  );
}
