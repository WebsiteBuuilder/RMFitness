// Boss Raid screens: the raid menu (pick a raid, team up with your brother or a computer
// partner), and the raid itself: your own board, the boss's shared Life Point bar over it,
// your teammate's board in a strip you can tap to watch, Team Power assists, the boon pick
// between fights and the raid's end.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DuelSession, SessionView } from '../eds/session';
import type { Action, Pid } from '../eds/types';
import { activeDeck, speedDeckProblems, type SpeedDeck, type SpeedSave } from '../eds/speedSave';
import { collectionProblems } from '../collection/economy';
import type { SoloSave } from '../eds/speedCampaign/save';
import type { CpuDuelist } from '../eds/speedCampaign/types';
import { partnersFor } from '../eds/speedCampaign/tagRoad';
import { DIFFICULTIES, DIFFICULTY_LABEL, type Difficulty } from '../eds/difficulty';
import { ASSISTS, BOONS, PINGS, POWER_MAX, POWER_STEP, RAIDS, type PingId, duelistById, raidOpen, type AssistKind, type FeedItem, type Raid, type RaidDef, type RaidProgress } from '../eds/raid';
import { RaidSession, useRaid } from '../eds/raidSession';
import { aiAction } from '../eds/ai';
import { DEFAULT_TACTICS } from '../eds/tactics';
import type { ControlStyle } from '../eds/save';
import type { SyncAdapter } from '../sync/types';
import { Btn, Portrait, ResultBanner, Sheet, SoloDeckPick, Top, useBack } from './Solo';
import { CardImg } from './CardImg';
import { Duel } from './Duel';
import { cpuDelay, spotUid, spotlight } from './cpuPace';
import { whenArtIdle } from '../art/cues';
import { getAnimSpeed } from '../art/settings';
import { playBlip } from './sound';
import './tag.css';
import './raid.css';

// =====================================================================
// The raid menu
// =====================================================================

/** What the last raid ended with, for the result sheet over the menu. */
export interface RaidReport {
  raid: string;
  won: boolean;
  left: boolean;
  /** the furthest fight reached (0 = wave 1) */
  stage: number;
  dealt: number;
  firstClear: boolean;
  lines: string[];
  cards: string[];
  noEarn: boolean;
}

interface HubProps {
  speed: SpeedSave;
  solo: SoloSave;
  progress: RaidProgress;
  report: RaidReport | null;
  onReportSeen: () => void;
  /** start on this phone with a computer partner, or create a room for the brother */
  onPlay: (def: RaidDef, level: Difficulty, how: 'here' | 'host', partner: CpuDuelist | null) => void;
  onJoin: (code: string) => void;
  onSpeed: (s: SpeedSave) => void;
  onBack: () => void;
}

const bossOf = (def: RaidDef) => duelistById(def.boss)!;

export function RaidHub(p: HubProps) {
  const [sel, setSel] = useState<RaidDef | null>(null);
  const [joining, setJoining] = useState(false);
  const deck = activeDeck(p.speed);
  const problems = deck ? [...speedDeckProblems(deck), ...collectionProblems(p.speed, deck)] : ['No Speed Duel deck yet'];
  const rep = p.report;
  const repDef = rep ? RAIDS.find((r) => r.id === rep.raid) : undefined;
  return (
    <div class="so raid">
      <Top title="Boss Raid" sub="you and your brother, two boards, one boss" onBack={p.onBack} />
      <div class="so-body">
        <div class="rd-how">
          <b>How raids work</b>
          <span>
            You each duel on <em>your own full board</em> with your own deck and 4000 LP.
          </span>
          <span>
            The enemy has <em>one Life Point pool</em>: every hit either of you lands comes off it on both boards.
          </span>
          <span>
            Every {POWER_STEP} damage either of you deals fills your shared <em>Team Power</em>: pass a card, heal, strike the boss, or revive a fallen teammate.
          </span>
          <span>Two waves of henchmen, then the boss. At half LP the boss rages.</span>
        </div>
        <div class="rd-list">
          {RAIDS.map((def) => {
            const open = raidOpen(p.progress, def);
            const done = p.progress.cleared.includes(def.id);
            const boss = bossOf(def);
            return (
              <button key={def.id} class={`rd-raid ${open ? '' : 'locked'} ${done ? 'done' : ''}`} disabled={!open} onClick={() => (playBlip(), setSel(def))}>
                <span class="rd-raid-art">
                  <CardImg name={boss.portrait} />
                </span>
                <span class="rd-raid-t">
                  <em>Raid {def.n}</em>
                  <b>{open ? def.title : '???'}</b>
                  <span>{open ? def.blurb : `Beat ${RAIDS[def.n - 2].title} to open`}</span>
                </span>
                <span class="rd-raid-tag">{done ? '✓' : open ? 'NEW' : '🔒'}</span>
              </button>
            );
          })}
        </div>
        <button class="tag-big blue" onClick={() => (playBlip(), setJoining(true))}>
          <b>Join your brother's raid</b>
          <span>Type the 4-letter code from his phone</span>
        </button>
        <DeckBar speed={p.speed} problems={problems} onSpeed={p.onSpeed} />
      </div>
      {sel && <RaidSetup def={sel} p={p} problems={problems} onClose={() => setSel(null)} />}
      {joining && <JoinSheet problems={problems} onJoin={p.onJoin} onClose={() => setJoining(false)} />}
      {rep && repDef && (
        <Sheet>
          <ResultBanner result={rep.won ? 'w' : 'l'} />
          <p class="so-center">{rep.won ? `${repDef.title} cleared! ${bossOf(repDef).name} is beaten.` : rep.left ? 'You left the raid.' : `The raid ended at ${repDef.stages[rep.stage].label}.`}</p>
          <p class="so-center so-dim">You dealt {rep.dealt} damage.</p>
          {rep.lines.length > 0 && (
            <div class="tag-rewards">
              <b>First clear rewards</b>
              {rep.cards.length > 0 && (
                <div class="tag-cards">
                  {rep.cards.slice(0, 12).map((c, i) => (
                    <CardImg key={i} name={c} />
                  ))}
                </div>
              )}
              {rep.lines
                .filter((l) => /Duel Chip/.test(l))
                .map((l) => (
                  <span key={l}>{l}</span>
                ))}
            </div>
          )}
          {rep.won && !rep.firstClear && <p class="so-dim so-center">Already cleared: replays are for glory.</p>}
          {rep.won && rep.noEarn && <p class="so-dim so-center">An Anything goes deck earns nothing, but the clear counts.</p>}
          <Btn kind="gold" onClick={p.onReportSeen}>
            Continue
          </Btn>
        </Sheet>
      )}
    </div>
  );
}

function DeckBar({ speed, problems, onSpeed }: { speed: SpeedSave; problems: string[]; onSpeed: (s: SpeedSave) => void }) {
  const [open, setOpen] = useState(false);
  const deck = activeDeck(speed);
  const problemsOf = (d: SpeedDeck) => [...speedDeckProblems(d), ...collectionProblems(speed, d)];
  return (
    <>
      <div class="so-deckbar">
        <div>
          <b>Your deck{deck ? `: ${deck.name}` : ''}</b>
          <span class={problems.length ? 'so-bad' : 'so-good'}>{problems.length ? problems[0] : `${deck!.main.length} cards · ready`}</span>
        </div>
        {speed.decks.length > 1 && (
          <Btn kind="blue" onClick={() => setOpen(true)}>
            Change
          </Btn>
        )}
      </div>
      {open && (
        <SoloDeckPick
          title="Deck for the raid"
          decks={speed.decks}
          current={deck}
          problemsOf={problemsOf}
          note="Anything goes decks can raid, but they earn nothing."
          onPick={(d) => (onSpeed({ ...speed, active: d.id }), setOpen(false))}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function JoinSheet({ problems, onJoin, onClose }: { problems: string[]; onJoin: (code: string) => void; onClose: () => void }) {
  const [code, setCode] = useState('');
  const ok = /^[A-Z]{4}$/.test(code);
  return (
    <Sheet title="Join a raid" onClose={onClose}>
      <p class="so-dim">Your brother picks a raid and taps Team up with your brother, then reads you the code.</p>
      <input class="tag-code" value={code} maxLength={4} placeholder="CODE" autoCapitalize="characters" onInput={(e) => setCode((e.target as HTMLInputElement).value.toUpperCase().replace(/[^A-Z]/g, ''))} />
      {problems.length > 0 && <div class="so-warn">Fix your deck first: {problems[0]}</div>}
      <Btn kind="gold" disabled={!ok || problems.length > 0} onClick={() => onJoin(code)}>
        Join raid {ok ? code : ''}
      </Btn>
    </Sheet>
  );
}

function RaidSetup({ def, p, problems, onClose }: { def: RaidDef; p: HubProps; problems: string[]; onClose: () => void }) {
  const partners = partnersFor(p.solo);
  const [partner, setPartner] = useState<CpuDuelist>(partners[0]);
  const [level, setLevel] = useState<Difficulty>('normal');
  const [picking, setPicking] = useState(false);
  const bad = problems.length > 0;
  if (picking)
    return (
      <Sheet title="Your computer partner" onClose={() => setPicking(false)}>
        <p class="so-dim">Joey is always ready. Every Millennium Road duelist you beat joins this list.</p>
        <div class="tag-partners">
          {partners.map((d) => (
            <button key={d.id} class={`tag-partner ${partner.id === d.id ? 'on' : ''}`} onClick={() => (setPartner(d), setPicking(false))}>
              <Portrait d={d} size="s" />
              <span>
                <b>{d.name}</b>
                <em>{d.title}</em>
              </span>
            </button>
          ))}
        </div>
      </Sheet>
    );
  return (
    <Sheet title={`RAID ${def.n}: ${def.title.toUpperCase()}`} onClose={onClose}>
      <div class="rd-stages">
        {def.stages.map((s, i) => (
          <div key={i} class={`rd-stage ${s.boss ? 'boss' : ''}`}>
            <em>{s.label}</em>
            <span class="rd-stage-foes">
              {s.boss ? (
                <Portrait d={duelistById(s.foes[0])!} size="m" />
              ) : (
                <>
                  <Portrait d={duelistById(s.foes[0])!} size="s" />
                  <Portrait d={duelistById(s.foes[1])!} size="s" />
                </>
              )}
            </span>
            <b>{s.pool.toLocaleString()} LP</b>
          </div>
        ))}
      </div>
      <p class="so-dim so-center">{def.rage.text.replace(/^[^!]*! /, 'At half LP: ')}</p>
      <div class="rd-levels">
        {DIFFICULTIES.map((d) => (
          <button key={d} class={`rd-level ${level === d ? 'on' : ''}`} onClick={() => (playBlip(), setLevel(d))}>
            {DIFFICULTY_LABEL[d]}
          </button>
        ))}
      </div>
      {bad && <div class="so-warn">Fix your deck first: {problems[0]}</div>}
      <Btn kind="gold" disabled={bad} onClick={() => p.onPlay(def, level, 'host', null)}>
        Team up with your brother
      </Btn>
      <p class="so-dim so-center">You get a code. He taps Join your brother's raid in Boss Raid.</p>
      <div class="rd-cpu">
        <Btn kind="blue" disabled={bad} onClick={() => p.onPlay(def, level, 'here', partner)}>
          Raid with {partner.name}
        </Btn>
        <button class="tag-pick" onClick={() => setPicking(true)}>
          computer partner <i>change</i>
        </button>
      </div>
    </Sheet>
  );
}

// =====================================================================
// The raid
// =====================================================================

let active = 0;
/** A raid is on screen (the back button asks before leaving it). */
export const raidActive = () => active > 0;

/** A raid played over a linked room's log (the room's duel session keeps the connection). */
export function RaidRoom({ adapter, phone, controlsFor, onControls, onEnd }: { adapter: SyncAdapter; phone: Pid; controlsFor?: (p: Pid) => ControlStyle; onControls?: (p: Pid, c: ControlStyle) => void; onEnd: (r: RaidEnd) => void }) {
  const [rs] = useState(() => new RaidSession(adapter, false));
  useEffect(() => () => rs.close(), [rs]);
  return <RaidPlay rs={rs} phone={phone} controlsFor={controlsFor} onControls={onControls} onEnd={onEnd} />;
}

export interface RaidEnd {
  raid: Raid;
  /** the duelist this phone played */
  hero: Pid;
  won: boolean;
  left: boolean;
}

/** A board as the duel screen sees it: moves go into the raid's log for that board. */
function boardSession(rs: RaidSession, b: Pid): DuelSession {
  const board = rs.raid.boards[b]!;
  return { engine: board.engine, adapter: { roomCode: null }, send: (a: Action) => rs.send({ type: 'RAID_MOVE', b, a, at: board.moves }) } as unknown as DuelSession;
}

/** A board's state key: the view only changes when the board does (the duel screen's double-tap guard relies on it). */
function boardKey(rs: RaidSession, b: Pid): string {
  const st = rs.raid.boards[b]?.engine.state;
  return st ? `${rs.raid.stage}:${st.turn}:${st.phase}:${st.log.length}:${st.winner}:${st.prompt?.title ?? ''}:${st.prompt?.player ?? ''}:${st.players[0].lp}:${st.players[1].lp}:${rs.status}` : '';
}

function viewOf(rs: RaidSession, b: Pid): SessionView {
  const board = rs.raid.boards[b]!;
  const seat = (name: string) => ({ name, deck: [], fusion: [], ready: true });
  return {
    state: board.engine.state,
    seats: [seat(rs.raid.name(b)), seat(board.foe.name)],
    status: rs.status,
    detail: rs.detail,
    log: [],
    toss: null,
    rematch: [null, null],
    series: { wins: [0, 0], draws: 0, last: null },
    round: 0,
    chat: [],
    moves: 0,
  };
}

export function RaidPlay({ rs, phone, controlsFor, onControls, onEnd }: { rs: RaidSession; phone: Pid; controlsFor?: (p: Pid) => ControlStyle; onControls?: (p: Pid, c: ControlStyle) => void; onEnd: (r: RaidEnd) => void }) {
  useRaid(rs);
  const raid = rs.raid;
  // Dev builds only: lets UI tests reach any point of a raid.
  if (import.meta.env.DEV) (window as unknown as { __raid?: RaidSession }).__raid = rs;
  const hero = (raid.heroOf(phone) ?? 0) as Pid;
  const mate = (hero === 0 ? 1 : 0) as Pid;
  /** the fight whose end this phone has seen (Continue on the result) */
  const [ack, setAck] = useState('');
  /** this fight, counting a retry as a new one */
  const fight = `${raid.stage}:${raid.retries}`;
  const [watchMate, setWatchMate] = useState(false);
  const [askLeave, setAskLeave] = useState(false);
  const [assist, setAssist] = useState(false);
  const shownBoard = useRef<Pid | null>(null);

  useEffect(() => {
    active++;
    return () => void active--;
  }, []);
  useBack(() => setAskLeave((x) => !x));

  // Each new fight starts on your own board.
  useEffect(() => setWatchMate(false), [fight]);

  useComputers(rs, phone, shownBoard);
  useAway(rs, hero, phone);

  const leave = () => {
    setAskLeave(false);
    if (raid.plan && raid.phase !== 'won' && raid.phase !== 'lost') rs.send({ type: 'RAID_LEAVE', hero });
    onEnd({ raid, hero, won: false, left: true });
  };

  if (!raid.plan || !raid.def) return <div class="loading">Starting the raid…</div>;

  const mine = raid.boards[hero];
  const theirs = raid.boards[mate];
  const fightOver = raid.phase !== 'duel';
  const myOver = !mine || mine.engine.state.winner !== null;
  // Which board fills the screen: yours; its result until you tap Continue; your teammate's while you watch them or after you fell.
  const myRunning = !!mine && !myOver;
  let show: Pid | null = null;
  if (myRunning && !watchMate) show = hero;
  else if (mine && myOver && ack !== fight && !watchMate) show = hero;
  else if (!fightOver && theirs && (watchMate || myOver)) show = mate;
  else if (myRunning) show = hero;
  shownBoard.current = show;

  const leaveSheet = askLeave && (
    <Sheet title="Leave the raid?" onClose={() => setAskLeave(false)}>
      <p>{theirs && raid.running(mate) ? `${raid.name(mate)} keeps fighting on their own.` : 'The raid ends here for you.'} Leaving earns nothing.</p>
      <Btn kind="red" onClick={leave}>
        Leave the raid
      </Btn>
      <Btn onClick={() => setAskLeave(false)}>Keep raiding</Btn>
    </Sheet>
  );

  if (show !== null) {
    const watching = show !== hero;
    return (
      <div class="rd-play">
        <BoardDuel key={`${fight}:${show}`} rs={rs} b={show} watching={watching} controlsFor={controlsFor} onControls={onControls} onLeave={() => setAskLeave(true)} onFinished={() => (watching ? setWatchMate(false) : setAck(fight))} />
        <RaidHud rs={rs} hero={hero} shown={show} onWatch={(w) => setWatchMate(w)} onAssist={() => setAssist(true)} />
        <Feed raid={raid} hero={hero} />
        <StageBanner raid={raid} />
        {raid.away[mate] && !raid.left[mate] && <div class="rd-away">{raid.name(mate)}'s phone dropped. The computer plays for them until they're back.</div>}
        {assist && <AssistSheet rs={rs} hero={hero} onClose={() => setAssist(false)} />}
        {leaveSheet}
      </div>
    );
  }

  if (raid.phase === 'boons') return (
    <>
      <Intermission rs={rs} hero={hero} onLeave={() => setAskLeave(true)} />
      {leaveSheet}
    </>
  );
  if (raid.phase === 'won' || raid.phase === 'lost') return <RaidOver
        raid={raid}
        hero={hero}
        onRetry={() => rs.send({ type: 'RAID_RETRY' })}
        onDone={() => {
          // Done with a lost raid: your teammate can still try again without you.
          if (raid.phase === 'lost') rs.send({ type: 'RAID_LEAVE', hero });
          onEnd({ raid, hero, won: raid.phase === 'won', left: false });
        }}
      />;
  // a fight still going with no board to show (you left it): wait for it
  return (
    <div class="so raid">
      <Top title={raid.def.title} sub={raid.stageDef()?.label} onBack={() => setAskLeave(true)} />
      <div class="so-body">
        <p class="so-center">Waiting for the fight to end…</p>
      </div>
      {leaveSheet}
    </div>
  );
}

function BoardDuel({ rs, b, watching, controlsFor, onControls, onLeave, onFinished }: { rs: RaidSession; b: Pid; watching: boolean; controlsFor?: (p: Pid) => ControlStyle; onControls?: (p: Pid, c: ControlStyle) => void; onLeave: () => void; onFinished: () => void }) {
  const session = useMemo(() => boardSession(rs, b), [rs, rs.raid.boards[b]]);
  const key = boardKey(rs, b);
  const view = useMemo(() => viewOf(rs, b), [rs, rs.raid.boards[b], key]);
  return <Duel session={session} view={view} mySeat={0} hotseat={false} controlsFor={controlsFor} onControls={onControls} onLeave={onLeave} onFinished={onFinished} spectator={watching} />;
}

/**
 * The computer's moves on the boards this phone runs: the enemy on your own board, and both
 * seats of a computer teammate's board. Each board keeps its own timer, so a busy board never
 * holds up the other.
 */
function useComputers(rs: RaidSession, phone: Pid, shown: { current: Pid | null }) {
  const raid = rs.raid;
  type Timer = { key: string; fired: boolean; tries: number; cancel: () => void };
  const timers = useRef<[Timer | null, Timer | null]>([null, null]);
  const streak = useRef([0, 0]);
  const [, poke] = useState(0);
  const turnAt = useRef<[{ turn: number; at: number }, { turn: number; at: number }]>([
    { turn: -1, at: 0 },
    { turn: -1, at: 0 },
  ]);
  const sentAssist = useRef('');
  useEffect(() => {
    for (const b of [0, 1] as Pid[]) {
      const x = raid.boards[b];
      const st = x?.engine.state;
      if (st && st.turn !== turnAt.current[b].turn) turnAt.current[b] = { turn: st.turn, at: Date.now() };
      const key = x && st ? `${raid.stage}:${b}:${st.turn}:${st.phase}:${st.log.length}:${st.prompt?.title ?? ''}:${st.prompt?.player ?? ''}:${raid.phase}:${raid.driver(b)}:${raid.heroIsCpu(b)}` : '';
      const t = timers.current[b];
      // Still waiting on this move, or it went out and the board hasn't answered yet.
      if (t && t.key === key && !t.fired) continue;
      const stuck = t && t.key === key && t.fired ? t.tries + 1 : 0;
      t?.cancel();
      timers.current[b] = null;
      if (!x || !st || raid.phase !== 'duel' || st.winner !== null || raid.driver(b) !== phone) continue;
      const seat = (st.prompt?.player ?? st.turnPlayer) as Pid;
      if (seat === 0 && !raid.heroIsCpu(b)) continue;
      const action = aiAction(x.engine, seat, { ...DEFAULT_TACTICS, level: seat === 1 ? raid.foeLevel() : raid.plan!.level });
      // A move the board ignored: back out of the prompt or end the turn instead of trying it again.
      const unstick: Action[] = st.prompt
        ? [{ type: 'PASS', player: seat }, { type: 'CANCEL', player: seat }, { type: 'NO', player: seat }]
        : [{ type: 'END_TURN', player: seat }, { type: 'NEXT_PHASE', player: seat }];
      if (!action && !stuck) {
        streak.current[b] = 0;
        continue;
      }
      if (stuck > unstick.length + 1) continue; // nothing works: leave it for a human to see
      streak.current[b]++;
      let a: Action = stuck ? unstick[(stuck - 1) % unstick.length] : streak.current[b] > 80 ? { type: 'END_TURN', player: seat } : action!;
      if (streak.current[b] > 80) streak.current[b] = 0;
      const onScreen = shown.current === b;
      const quick = a.type === 'NEXT_PHASE' || a.type === 'PASS' || a.type === 'CHOOSE';
      const pace = stuck ? 250 : onScreen ? cpuDelay(a, { sinceTurn: Date.now() - turnAt.current[b].at, firstTurn: st.turn === 1, ownTurn: st.turnPlayer === seat && !st.prompt, animSpeed: getAnimSpeed() }) : quick ? 300 : 800;
      const timer: Timer = { key, fired: false, tries: stuck, cancel: () => {} };
      const at = x.moves;
      const send = () => {
        timer.fired = true;
        rs.send({ type: 'RAID_MOVE', b, a, at });
        const uid = spotUid(a);
        if (uid !== null && shown.current === b) spotlight(uid);
        // If the move changed nothing, nothing redraws: look again shortly.
        window.setTimeout(() => poke((v) => v + 1), 400);
      };
      let h = 0;
      const stop = onScreen && !stuck ? whenArtIdle(() => (h = window.setTimeout(send, pace))) : ((h = window.setTimeout(send, pace)), () => {});
      timer.cancel = () => (stop(), clearTimeout(h));
      timers.current[b] = timer;
    }
    // A computer teammate (or one standing in for a dropped phone) spends Team Power.
    if (raid.phase === 'duel') {
      for (const h of [0, 1] as Pid[]) {
        if (!raid.heroIsCpu(h) || raid.driver(h) !== phone || raid.left[h]) continue;
        const k = raid.cpuAssist(h);
        const once = `${raid.stage}:${h}:${k?.kind}:${raid.power}:${raid.feed.length}`;
        if (!k || sentAssist.current === once) continue;
        sentAssist.current = once;
        rs.send({ type: 'RAID_ASSIST', hero: h, kind: k.kind, uid: k.uid });
      }
    }
  });
  // A computer teammate picks its boon (Team Spirit if offered).
  useEffect(() => {
    if (raid.phase !== 'boons') return;
    for (const h of [0, 1] as Pid[]) {
      if (!raid.heroIsCpu(h) || raid.driver(h) !== phone || raid.picks[h] !== null || raid.left[h]) continue;
      const pick = raid.offers[h].includes('power') ? 'power' : raid.offers[h][0];
      const t = window.setTimeout(() => rs.send({ type: 'RAID_BOON', hero: h, boon: pick }), 900);
      return () => clearTimeout(t);
    }
  }, [raid.phase, raid.stage, raid.picks[0], raid.picks[1], raid.away[0], raid.away[1]]);
  useEffect(() => () => timers.current.forEach((t) => t?.cancel()), []);
}

/**
 * Two linked phones: if your teammate's phone stays unreachable, your computer plays their
 * board so the raid doesn't stall; when your own phone gets back it takes its board back.
 */
function useAway(rs: RaidSession, hero: Pid, phone: Pid) {
  const raid = rs.raid;
  const mate = (hero === 0 ? 1 : 0) as Pid;
  const online = !!rs.adapter.roomCode;
  const down = rs.status !== 'connected';
  useEffect(() => {
    if (!online || !raid.plan) return;
    if (!down) {
      if (raid.away[hero]) rs.send({ type: 'RAID_AWAY', hero, away: false });
      return;
    }
    // Only the host's phone says who dropped: a guest that lost the link would only be guessing.
    if (phone !== 0 || raid.away[mate] || raid.left[mate] || raid.heroIsCpu(mate)) return;
    const t = window.setTimeout(() => rs.send({ type: 'RAID_AWAY', hero: mate, away: true }), 20000);
    return () => clearTimeout(t);
  }, [online, down, raid.away[hero], raid.away[mate], !!raid.plan]);
}

/** The boss's Life Point bar, your teammate's board in a strip, and Team Power. */
function RaidHud({ rs, hero, shown, onWatch, onAssist }: { rs: RaidSession; hero: Pid; shown: Pid; onWatch: (w: boolean) => void; onAssist: () => void }) {
  const raid = rs.raid;
  const st = raid.stageDef()!;
  const mate = (hero === 0 ? 1 : 0) as Pid;
  const mb = raid.boards[mate];
  const ms = mb?.engine.state;
  const pct = Math.max(0, Math.min(100, (raid.pool / raid.poolMax) * 100));
  const foeName = st.boss ? duelistById(raid.def!.boss)!.name : st.label;
  const mateStatus = !mb ? 'left the raid' : ms!.winner !== null ? (ms!.winner === 0 ? 'won' : 'fell') : ms!.turnPlayer === 0 ? 'their turn' : "enemy's turn";
  const watching = shown !== hero;
  const myState = raid.boards[hero]?.engine.state;
  const iFell = !raid.boards[hero] || (myState?.winner !== null && myState?.winner !== 0);
  const canSomething = (['revive', 'strike', 'heal', 'gift'] as AssistKind[]).some((k) => raid.canAssist(hero, k));
  // A big hit shakes the bar; the lost chunk drains a moment after the fill drops.
  const [shake, setShake] = useState(false);
  const lastPool = useRef(raid.pool);
  useEffect(() => {
    const drop = lastPool.current - raid.pool;
    lastPool.current = raid.pool;
    if (drop < 1000) return;
    setShake(true);
    const t = setTimeout(() => setShake(false), 450);
    return () => clearTimeout(t);
  }, [raid.pool]);
  return (
    <div class={`rd-hud ${raid.rage ? 'rage' : ''}`}>
      <div class={`rd-bar ${shake ? 'shake' : ''}`} role="status" aria-label={`${foeName}: ${raid.pool} of ${raid.poolMax} LP`}>
        <span class="rd-bar-l">
          <b>{foeName}</b>
          <em>{st.boss ? (raid.rage ? 'RAGING' : 'BOSS') : `${raid.stage + 1}/${raid.def!.stages.length}`}</em>
        </span>
        <span class="rd-bar-track">
          <span class="rd-bar-ghost" style={{ width: `${pct}%` }} />
          <span class="rd-bar-fill" style={{ width: `${pct}%` }} />
          {st.boss && <span class="rd-bar-mark" />}
          <span class="rd-bar-n">
            {raid.pool.toLocaleString()} / {raid.poolMax.toLocaleString()}
          </span>
        </span>
      </div>
      <div class="rd-team">
        {mb ? (
          <button class={`rd-mate ${ms!.winner !== null && ms!.winner !== 0 ? 'down' : ''} ${watching ? 'on' : ''}`} onClick={() => (playBlip(), onWatch(!watching))}>
            <b>{watching ? `Watching ${raid.name(mate)}` : raid.name(mate)}</b>
            {watching && <span class="rd-mate-st">tap: back to yours</span>}
            {!watching && raid.comboReady(hero) && <span class="rd-combo">COMBO READY</span>}
            {!watching && (
              <>
                <span class="rd-mate-lp">{ms!.players[0].lp} LP</span>
                <span class="rd-mate-mz">
                  {ms!.players[0].mz.map((m, i) => (
                    <i key={i} class={m ? (m.faceUp ? 'up' : 'set') : ''} />
                  ))}
                </span>
                <span class="rd-mate-st">{mateStatus}</span>
              </>
            )}
          </button>
        ) : (
          <span class="rd-mate down">
            <b>{raid.name(mate)}</b>
            <span class="rd-mate-st">left the raid</span>
          </span>
        )}
        <button class={`rd-power ${canSomething ? 'ready' : ''}`} onClick={() => (playBlip(), onAssist())} aria-label={`Team Power ${raid.power} of ${POWER_MAX}`}>
          <span class="rd-pips">
            {Array.from({ length: POWER_MAX }, (_, i) => (
              <i key={i} class={i < raid.power ? 'on' : ''} />
            ))}
          </span>
          <b>{iFell ? 'Help' : 'Assist'}</b>
        </button>
      </div>
      {rs.adapter.roomCode && rs.status !== 'connected' && <div class="rd-net">{rs.detail || 'Connection lost. Reconnecting…'}</div>}
    </div>
  );
}

function AssistSheet({ rs, hero, onClose }: { rs: RaidSession; hero: Pid; onClose: () => void }) {
  const raid = rs.raid;
  useRaid(rs);
  const mate = (hero === 0 ? 1 : 0) as Pid;
  const [gift, setGift] = useState(false);
  const hand = raid.boards[hero]?.engine.state.players[0].hand ?? [];
  const send = (kind: AssistKind, uid?: number) => {
    rs.send({ type: 'RAID_ASSIST', hero, kind, uid });
    onClose();
  };
  const toNext = POWER_STEP - raid.charge[hero];
  if (gift)
    return (
      <Sheet title={`Pass a card to ${raid.name(mate)}`} onClose={() => setGift(false)}>
        {!raid.canAssist(hero, 'gift') && <p class="so-warn">You can pass a card between moves, while your teammate is still dueling.</p>}
        <div class="rd-gift">
          {hand.map((c) => (
            <button key={c.uid} class="rd-gift-c" disabled={!raid.canAssist(hero, 'gift', c.uid)} onClick={() => (playBlip(), send('gift', c.uid))}>
              <CardImg name={c.name} />
              <span>{c.name}</span>
            </button>
          ))}
        </div>
      </Sheet>
    );
  const human = raid.plan?.heroes[mate].ctl !== 'cpu' && !raid.left[mate];
  return (
    <Sheet title="Team Power" onClose={onClose}>
      <div class="rd-pips big">
        {Array.from({ length: POWER_MAX }, (_, i) => (
          <i key={i} class={i < raid.power ? 'on' : ''} />
        ))}
      </div>
      <p class="so-dim so-center">{raid.power < POWER_MAX ? `${toNext} more damage from you fills the next one.` : 'Full! Spend it.'} You and {raid.name(mate)} share it.</p>
      {(['revive', 'gift', 'heal', 'strike'] as AssistKind[])
        .map((k) => ({ k, why: raid.assistBlock(hero, k) }))
        .sort((a, b) => Number(!!a.why) - Number(!!b.why))
        .map(({ k, why }) => {
        return (
          <button key={k} class={`rd-assist ${k}`} disabled={!!why} onClick={() => (playBlip(), k === 'gift' ? setGift(true) : send(k))}>
            <em>{ASSISTS[k].cost} Power</em>
            <b>{ASSISTS[k].title}</b>
            <span>{ASSISTS[k].text}</span>
            {why && <small>{why}</small>}
          </button>
        );
      })}
      {human && (
        <div class="rd-pings">
          {(Object.keys(PINGS) as PingId[]).map((id) => (
            <button key={id} onClick={() => (playBlip(), rs.send({ type: 'RAID_PING', hero, ping: id }), onClose())}>
              {PINGS[id]}
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/** Callouts: your teammate's hits, Team Power, assists, rage. */
function Feed({ raid, hero }: { raid: Raid; hero: Pid }) {
  const seen = useRef(raid.feed.length ? raid.feed[raid.feed.length - 1].n : 0);
  const [items, setItems] = useState<(FeedItem & { at: number; times?: number })[]>([]);
  const last = raid.feed.length ? raid.feed[raid.feed.length - 1].n : 0;
  useEffect(() => {
    const fresh = raid.feed.filter((f) => f.n > seen.current && !((f.kind === 'hit' || f.kind === 'ping') && f.hero === hero) && f.kind !== 'stage' && f.kind !== 'rage');
    seen.current = last;
    if (!fresh.length) return;
    const now = Date.now();
    setItems((cur) => {
      let out = cur.filter((x) => now - x.at < 2600);
      for (const f of fresh) {
        // a revive clears the "fell" callout; the same callout twice reads "×2"
        if (f.kind === 'revive') out = out.filter((x) => x.kind !== 'fall');
        const same = out.find((x) => x.text === f.text);
        if (same) out = out.map((x) => (x === same ? { ...x, times: (x.times ?? 1) + 1, at: now } : x));
        else out.push({ ...f, at: now });
      }
      return out.slice(-2);
    });
  }, [last]);
  useEffect(() => {
    if (!items.length) return;
    const t = setTimeout(() => setItems((cur) => cur.filter((x) => Date.now() - x.at < 2600)), 2700);
    return () => clearTimeout(t);
  }, [items]);
  // Callouts name you as "you" (two duelists with the same name: only your own deeds).
  const you = (f: FeedItem) => {
    const me = raid.name(hero);
    if (!me || (me === raid.name(hero === 0 ? 1 : 0) && f.hero !== hero)) return f.text;
    const t = f.text.split(me).join('you').replace(/^you strikes /, 'you strike ');
    return t[0].toUpperCase() + t.slice(1);
  };
  return (
    <div class="rd-feed" aria-live="polite">
      {items.map((f) => (
        <div key={f.n} class={`rd-toast ${f.kind}`}>
          {(f.kind === 'hit' || f.kind === 'combo') && <b class="rd-toast-n">-{f.amount}</b>}
          <span>{you(f)}</span>
          {f.times && f.times > 1 && <b class="rd-toast-x">×{f.times}</b>}
        </div>
      ))}
    </div>
  );
}

/** "WAVE 2" / the boss's name, big, as each fight starts; "RAGE" when the boss rages. */
function StageBanner({ raid }: { raid: Raid }) {
  const [show, setShow] = useState<{ k: string; big: string; small: string } | null>(null);
  const st = raid.stageDef()!;
  const key = `${raid.stage}:${raid.retries}`;
  useEffect(() => {
    const boss = duelistById(raid.def!.boss)!;
    // after the duel's own "DUEL!" banner
    const a = setTimeout(() => setShow({ k: key, big: st.boss ? boss.name.toUpperCase() : st.label.toUpperCase(), small: st.boss ? st.note ?? 'BOSS FIGHT' : (st.note ?? '') }), 1500);
    const t = setTimeout(() => setShow((x) => (x?.k === key ? null : x)), 3700);
    return () => (clearTimeout(a), clearTimeout(t));
  }, [key]);
  useEffect(() => {
    if (!raid.rage) return;
    setShow({ k: 'rage', big: 'RAGE!', small: raid.def!.rage.text });
    const t = setTimeout(() => setShow(null), 2600);
    return () => clearTimeout(t);
  }, [raid.rage]);
  if (!show) return null;
  return (
    <div class={`rd-banner ${show.k === 'rage' ? 'rage' : ''}`} key={show.k}>
      <b>{show.big}</b>
      <span>{show.small}</span>
    </div>
  );
}

/** Between fights: what you did, your boon pick, and who comes next. */
const AUTO_PICK = 30;

function Intermission({ rs, hero, onLeave }: { rs: RaidSession; hero: Pid; onLeave: () => void }) {
  const raid = rs.raid;
  const mate = (hero === 0 ? 1 : 0) as Pid;
  const st = raid.stageDef()!;
  const next = raid.def!.stages[raid.stage + 1];
  const picked = raid.picks[hero];
  // Nobody waits forever on a phone left on the table: the first boon is picked after 30 seconds.
  const [left, setLeft] = useState(AUTO_PICK);
  useEffect(() => {
    if (picked) return;
    setLeft(AUTO_PICK);
    const t = window.setInterval(() => setLeft((n) => n - 1), 1000);
    return () => clearInterval(t);
  }, [picked, raid.stage]);
  useEffect(() => {
    if (!picked && left <= 0 && raid.offers[hero].length) rs.send({ type: 'RAID_BOON', hero, boon: raid.offers[hero][0] });
  }, [left <= 0]);
  return (
    <div class="so raid">
      <div class="rd-inter">
        <div class="rd-cleared">{st.label} cleared!</div>
        <div class="rd-dmg">
          <span>
            <em>You</em>
            <b>{raid.total[hero].toLocaleString()}</b>
          </span>
          <span>
            <em>{raid.name(mate)}</em>
            <b>{raid.total[mate].toLocaleString()}</b>
          </span>
        </div>
        <p class="so-dim so-center">damage dealt so far</p>
        <h3 class="rd-h">{picked ? 'Your boon' : 'Pick a boon for the next fight'}</h3>
        <div class="rd-boons">
          {raid.offers[hero].map((id) => (
            <button key={id} class={`rd-boon ${picked === id ? 'on' : ''} ${picked && picked !== id ? 'off' : ''}`} disabled={!!picked} onClick={() => (playBlip(), rs.send({ type: 'RAID_BOON', hero, boon: id }))}>
              <b>{BOONS[id].title}</b>
              <span>{BOONS[id].text}</span>
            </button>
          ))}
        </div>
        {!picked && left <= 15 && <p class="so-center so-dim rd-auto">Picks {BOONS[raid.offers[hero][0]]?.title} in {Math.max(0, left)}s</p>}
        {picked && raid.picks[mate] === null && !raid.left[mate] && <p class="so-center rd-wait">Waiting for {raid.name(mate)} to pick…</p>}
        {next && (
          <div class="rd-next">
            <em>Next: {next.label}</em>
            <span class="rd-stage-foes">
              {next.boss ? (
                <Portrait d={duelistById(next.foes[0])!} size="m" />
              ) : (
                <>
                  <Portrait d={duelistById(next.foes[0])!} size="s" />
                  <Portrait d={duelistById(next.foes[1])!} size="s" />
                </>
              )}
            </span>
            <span>
              {next.boss ? duelistById(next.foes[0])!.name : `${duelistById(next.foes[0])!.name} & ${duelistById(next.foes[1])!.name}`} · {next.pool.toLocaleString()} LP
            </span>
          </div>
        )}
        <Btn onClick={onLeave}>
          Leave the raid
        </Btn>
      </div>
    </div>
  );
}

function RaidOver({ raid, hero, onDone, onRetry }: { raid: Raid; hero: Pid; onDone: () => void; onRetry: () => void }) {
  const mate = (hero === 0 ? 1 : 0) as Pid;
  const won = raid.phase === 'won';
  const mvp: Pid = raid.total[0] >= raid.total[1] ? 0 : 1;
  useBack(onDone);
  return (
    <div class="so raid">
      <div class="rd-inter">
        <ResultBanner result={won ? 'w' : 'l'} />
        <p class="so-center">{won ? `${raid.def!.title} cleared! ${duelistById(raid.def!.boss)!.name} is beaten.` : raid.left[mate] ? `You fell at ${raid.stageDef()!.label}.` : `You both fell at ${raid.stageDef()!.label}.`}</p>
        <div class="rd-dmg">
          <span class={mvp === hero ? 'mvp' : ''}>
            <em>You</em>
            <b>{raid.total[hero].toLocaleString()}</b>
          </span>
          <span class={mvp === mate ? 'mvp' : ''}>
            <em>{raid.name(mate)}</em>
            <b>{raid.total[mate].toLocaleString()}</b>
          </span>
        </div>
        <p class="so-dim so-center">damage dealt · ★ most damage</p>
        <div class="rd-stats">
          <span>Biggest hit {raid.best[hero].toLocaleString()}</span>
          <span>Biggest hit {raid.best[mate].toLocaleString()}</span>
          <span>Assists {raid.used[hero]}</span>
          <span>Assists {raid.used[mate]}</span>
        </div>
        {raid.combos > 0 && <p class="so-dim so-center">{raid.combos} tag-team {raid.combos === 1 ? 'combo' : 'combos'}</p>}
        {!won && !raid.left[hero] && (
          <Btn kind="blue" onClick={() => (playBlip(), onRetry())}>
            Try {raid.stageDef()!.boss ? 'the boss' : raid.stageDef()!.label} again
          </Btn>
        )}
        <Btn kind="gold" onClick={onDone}>
          Continue
        </Btn>
      </div>
    </div>
  );
}
