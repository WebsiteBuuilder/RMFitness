// Speed Duel solo modes: The Millennium Road (story campaign), the Duel Labyrinth
// (roguelite runs) and Practice Duels. Master Duel-style screens over the shared duel.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { card } from '../eds/db';
import { loadProfiles, type Profile } from '../eds/save';
import { STARTERS, activeDeck, deckFromStarter, loadSpeedSave, owned as ownedCopies, speedDeckProblems, type SpeedDeck, type SpeedSave } from '../eds/speedSave';
import { CHAPTERS, DEALER_CONDITIONS, type CampaignNode, type Chapter } from '../eds/speedCampaign/roster';
import { allCampaignDuelists, chapterCleared, chapterOpen, currentChapter, deckOf, findNode, nodeOpen, nodePassed, repairRoadDeck, soloDeckProblems, starCount, startRoad, takePick } from '../eds/speedCampaign/campaign';
import { deckCode, fighterCode, readDeckCode, talkOf } from '../eds/speedCampaign/deckCode';
import { readPepTalk, tacticsLabel } from '../eds/tactics';
import { campaignDifficulty, labyrinthDifficulty, savedDifficulty } from '../eds/difficulty';
import { CURSES, EVENTS, UPGRADES, afterDuel, choose, stake, dailySeed, dailyStarter, duelFor, duelistById, enter, eventById, reachable, readResultCode, resultCode, stopById, todayString, newRun, type Choice, type Run, type RunSummary, type Stop } from '../eds/speedCampaign/labyrinth';
import { STAR_TEXT } from '../eds/speedCampaign/outcome';
import { relic } from '../eds/speedCampaign/relics';
import { loadSolo, writeSolo, type SoloSave, type WatchPrefs } from '../eds/speedCampaign/save';
import { endRunPaid, type SoloReport } from '../eds/speedCampaign/settle';
import type { CpuDuelSpec, CpuDuelist, VsInfo } from '../eds/speedCampaign/types';
import { randomSeed } from '../eds/rng';
import { CardImg, CardInfoPanel } from './CardImg';
import { SpeedDeckEdit, speedOpponents } from './Speed';
import { buzz, playBlip, playFanfare, playLose, playStar, playVs } from './sound';
import { Legends } from './Legends';
import { deckSummary } from './DeckPick';
import './solo.css';

export type SoloMode = 'campaign' | 'labyrinth' | 'practice' | 'legends';

interface Props {
  mode: SoloMode;
  profile: Profile;
  /** the player's duelist name */
  name: string;
  speed: SpeedSave;
  onSpeed: (s: SpeedSave) => void;
  report: SoloReport | null;
  lastSpec: CpuDuelSpec | null;
  onReportSeen: () => void;
  /** onCancel undoes whatever led here if the player backs out of the VS screen */
  onDuel: (spec: CpuDuelSpec, onCancel?: () => void) => void;
  onMode: (m: SoloMode) => void;
  onExit: () => void;
}

export function Solo(p: Props) {
  const [solo, setSoloState] = useState<SoloSave>(() => loadSolo(p.profile.id));
  const setSolo = (s: SoloSave) => {
    setSoloState(s);
    writeSolo(p.profile.id, s);
  };
  const [vs, setVs] = useState<{ spec: CpuDuelSpec; cancel?: () => void } | null>(null);
  /** The duel really starts (after the VS splash). */
  const go = (spec: CpuDuelSpec) => {
    setVs(null);
    // From here, closing the app mid-duel counts as losing a Labyrinth duel.
    const run = solo.labyrinth.run;
    if (spec.context.kind === 'labyrinth' && run) setSolo({ ...solo, labyrinth: { ...solo.labyrinth, run: stake(run) } });
    p.onDuel(spec);
  };
  const ctx = { ...p, solo, setSolo, onDuel: (spec: CpuDuelSpec, cancel?: () => void) => (spec.vs && !spec.retry ? setVs({ spec, cancel }) : go(spec)) };
  return (
    <>
      {p.mode === 'practice' ? <Practice {...ctx} /> : p.mode === 'labyrinth' ? <Labyrinth {...ctx} /> : p.mode === 'legends' ? <Legends {...ctx} /> : <Road {...ctx} />}
      {vs && <VsSplash spec={vs.spec} onGo={() => go(vs.spec)} onCancel={() => (setVs(null), vs.cancel?.())} />}
    </>
  );
}

// ---------- the phone's back gesture ----------
// Each open sheet (and each screen's back arrow) registers what Back does; the newest wins.
const backStack: (() => void)[] = [];
export function useBack(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = () => ref.current();
    backStack.push(h);
    return () => {
      const i = backStack.lastIndexOf(h);
      if (i >= 0) backStack.splice(i, 1);
    };
  }, []);
}

/** The phone's Back inside the solo modes: closes the open sheet or goes back one screen.
 * App's back-button hook calls this while a solo mode is on screen. */
export function soloBack(): boolean {
  const h = backStack[backStack.length - 1];
  if (!h) return false;
  h();
  return true;
}

/** The strongest monster in a deck, for its portrait. */
export const ace = (main: string[]) => [...main].filter((n) => card(n)?.kind === 'monster').sort((a, b) => (card(b)?.atk ?? 0) - (card(a)?.atk ?? 0))[0] ?? main[0];

// ---------- the VS splash ----------
/** How long the VS screen stays up before the duel starts by itself (longer with conditions or goals to read). */
const VS_AUTO_MS = 4000;

function VsSplash({ spec, onGo, onCancel }: { spec: CpuDuelSpec; onGo: () => void; onCancel: () => void }) {
  const v = spec.vs!;
  useBack(onCancel);
  useEffect(() => {
    playVs();
    buzz([40, 60, 90]);
  }, []);
  // The duel starts by itself after a beat (time to read the conditions); Duel! starts it now.
  const started = useRef(false);
  const go = () => {
    if (started.current) return;
    started.current = true;
    onGo();
  };
  useEffect(() => {
    const t = setTimeout(go, VS_AUTO_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div class="so vs">
      <div class="vs-label">{v.label}</div>
      <div class="vs-side me">
        <div class="vs-art">
          <CardImg name={v.mePortrait} />
        </div>
        <b>{spec.me.name}</b>
      </div>
      <div class="vs-mark">VS</div>
      <div class="vs-side cpu">
        <div class="vs-art">
          <CardImg name={v.cpuPortrait} />
        </div>
        <b>{spec.cpu.name}</b>
        <span>{v.cpuTitle}</span>
      </div>
      <p class="vs-line">“{v.line}”</p>
      {v.notes.length > 0 && (
        <div class="vs-notes">
          {v.notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}
      {v.goals.length > 0 && (
        <div class="vs-goals">
          {v.goals.map((g) => (
            <div key={g}>
              <span>★</span> {g}
            </div>
          ))}
        </div>
      )}
      <button class="so-btn gold vs-go" onClick={(e) => (e.stopPropagation(), playBlip(), go())}>
        Duel!
        <i class="vs-timer" style={{ animationDuration: `${VS_AUTO_MS}ms` }} />
      </button>
    </div>
  );
}

/** A small chip on the duel screen with the Duel Conditions and star goals in play. */
export function SoloHud({ vs }: { vs?: VsInfo }) {
  const [open, setOpen] = useState(false);
  if (!vs || (vs.notes.length === 0 && vs.goals.length === 0)) return null;
  return (
    <div class={`so-hud ${open ? 'open' : ''}`} onClick={() => setOpen(!open)}>
      {open ? (
        <>
          {vs.notes.map((n) => (
            <div key={n} class="n">
              {n}
            </div>
          ))}
          {vs.goals.map((g) => (
            <div key={g} class="g">
              ★ {g}
            </div>
          ))}
        </>
      ) : (
        <span>{vs.goals.length ? `★ ${vs.goals.length} goals` : ''}{vs.goals.length && vs.notes.length ? ' · ' : ''}{vs.notes.length ? `${vs.notes.length} rule${vs.notes.length > 1 ? 's' : ''}` : ''}</span>
      )}
    </div>
  );
}

export type Ctx = Props & { solo: SoloSave; setSolo: (s: SoloSave) => void };

// ---------- small pieces ----------
export function Top({ title, sub, onBack, right }: { title: string; sub?: string; onBack: () => void; right?: preact.ComponentChildren }) {
  useBack(onBack);
  return (
    <div class="so-top">
      <button class="so-back" onClick={onBack} aria-label="Back">
        ‹
      </button>
      <div class="so-top-t">
        <b>{title}</b>
        {sub && <span>{sub}</span>}
      </div>
      {right}
    </div>
  );
}

export function Sheet({ title, onClose, children, wide }: { title?: string; onClose?: () => void; children: preact.ComponentChildren; wide?: boolean }) {
  // Back closes the sheet; a sheet you must answer just ignores it.
  useBack(() => onClose?.());
  return (
    <div class="so-shade" onClick={onClose}>
      <div class={`so-sheet ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        {title && (
          <div class="so-sheet-h">
            <b>{title}</b>
            {onClose && (
              <button class="so-x" onClick={onClose} aria-label="Close">
                ×
              </button>
            )}
          </div>
        )}
        <div class="so-sheet-b">{children}</div>
      </div>
    </div>
  );
}

export function Btn({ children, onClick, kind = 'plain', disabled, class: cls }: { children: preact.ComponentChildren; onClick?: () => void; kind?: 'plain' | 'gold' | 'blue' | 'red'; disabled?: boolean; class?: string }) {
  return (
    <button class={`so-btn ${kind}${cls ? ` ${cls}` : ''}`} disabled={disabled} onClick={() => (playBlip(), onClick?.())}>
      {children}
    </button>
  );
}

/** The Eye of Wdjat, drawn (phones lack a font with the hieroglyph). */
export function MilEye({ size = 22 }: { size?: number }) {
  return (
    <svg class="so-eyesvg" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M4 30c10-12 22-17 28-17s18 5 28 17c-10 10-22 15-28 15S14 40 4 30z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round" />
      <circle cx="32" cy="29" r="8" fill="currentColor" />
      <path d="M26 44l-4 14M22 58c4 2 8 1 10-3M38 44c2 6 6 10 12 10" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" />
      <path d="M8 18c8-6 16-8 24-8" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" />
    </svg>
  );
}

/** Skill names without the "(Skill Card)" tag some carry. */
export const skillName = (n: string | null | undefined) => (n ? n.replace(/ \(Skill Card\)$/, '') : 'no Skill');

const Stars = ({ s }: { s?: boolean[] }) => (
  <span class="so-stars">
    {[0, 1, 2].map((i) => (
      <span key={i} class={s?.[i] ? 'on' : ''}>
        ★
      </span>
    ))}
  </span>
);

export function Portrait({ d, size = 'm' }: { d: Pick<CpuDuelist, 'portrait' | 'name'>; size?: 's' | 'm' | 'l' }) {
  return (
    <div class={`so-portrait ${size}`}>
      <CardImg name={d.portrait} />
    </div>
  );
}

export function CardRow({ names, onPick, picked, reveal, own }: { names: string[]; onPick?: (n: string) => void; picked?: string | null; reveal?: boolean; own?: (n: string) => number }) {
  const [info, setInfo] = useState<string | null>(null);
  // Revealed cards flip over one at a time, each with a sparkle.
  useEffect(() => {
    if (reveal) names.forEach((_, i) => playStar(0.35 + i * 0.3));
  }, []);
  return (
    <>
      <div class={`so-cards ${reveal ? 'reveal' : ''}`}>
        {names.map((n, i) => {
          const have = own?.(n);
          return (
            <button key={`${n}${i}`} class={`so-card ${picked === n ? 'on' : ''}`} style={reveal ? { animationDelay: `${0.35 + i * 0.3}s` } : undefined} onClick={() => (onPick ? onPick(n) : setInfo(n))}>
              <CardImg name={n} />
              <span>{n}</span>
              {have !== undefined && <i class={have === 0 ? 'new' : ''}>{have === 0 ? 'NEW' : `own ${have}`}</i>}
            </button>
          );
        })}
      </div>
      {info && (
        <Sheet title="Card Info" onClose={() => setInfo(null)}>
          <CardInfoPanel name={info} />
        </Sheet>
      )}
    </>
  );
}

/** A deck as a compact list: name ×copies. */
function DeckListView({ main, extra }: { main: string[]; extra: string[] }) {
  const [info, setInfo] = useState<string | null>(null);
  const group = (list: string[]) => {
    const m = new Map<string, number>();
    for (const n of list) m.set(n, (m.get(n) ?? 0) + 1);
    return [...m].sort(([a], [b]) => (card(a)?.kind ?? '').localeCompare(card(b)?.kind ?? '') || a.localeCompare(b));
  };
  return (
    <div class="so-decklist">
      {[...group(main), ...group(extra)].map(([n, q]) => (
        <button key={n} class={`so-dl k-${card(n)?.kind ?? 'monster'}`} onClick={() => setInfo(n)}>
          <CardImg name={n} />
          <span>{n}</span>
          <i>×{q}</i>
        </button>
      ))}
      {info && (
        <Sheet title="Card Info" onClose={() => setInfo(null)}>
          <CardInfoPanel name={info} />
        </Sheet>
      )}
    </div>
  );
}

export function ResultBanner({ result }: { result: 'w' | 'l' | 'd' }) {
  useEffect(() => {
    if (result === 'w') (playFanfare(), buzz([30, 50, 30, 50, 120]));
    else (playLose(), buzz(250));
  }, []);
  return <div class={`so-result ${result}`}>{result === 'w' ? 'VICTORY' : result === 'l' ? 'DEFEAT' : 'DRAW'}</div>;
}

// =====================================================================
// Practice Duel
// =====================================================================
interface PracticeFoe {
  id: string;
  name: string;
  title: string;
  portrait: string;
  main: string[];
  extra: string[];
  skill: string | null;
  group: string;
  condition?: CampaignNode['condition'];
  /** a pep talk that came with a fighter code */
  talk?: string;
}

// The Practice tab last open, so leaving a duel comes back to it.
let practiceTab: 'play' | 'watch' = 'play';

function Practice(p: Ctx) {
  const { solo, setSolo, speed } = p;
  const prefs = solo.practice;
  const setPrefs = (x: Partial<SoloSave['practice']>) => setSolo({ ...solo, practice: { ...prefs, ...x } });
  const [deckId, setDeckId] = useState<string | null>(activeDeck(speed)?.id ?? null);
  const [pickFoe, setPickFoe] = useState(false);
  const [share, setShare] = useState(false);
  const [paste, setPaste] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [tab, setTabState] = useState<'play' | 'watch'>(p.report?.kind === 'practice' && p.report.ctx.watch ? 'watch' : practiceTab);
  const setTab = (t: 'play' | 'watch') => setTabState((practiceTab = t));
  const myDeck = speed.decks.find((d) => d.id === deckId) ?? activeDeck(speed);

  const foes = useMemo<PracticeFoe[]>(() => {
    const out: PracticeFoe[] = [];
    for (const o of speedOpponents()) out.push({ id: `starter:${o.name}`, name: o.name, title: o.title.replace(/^.*\(|\)$/g, '') + ' Starter', portrait: o.main.find((n) => card(n)?.kind === 'monster') ?? o.main[0], main: o.main, extra: o.extra, skill: o.skill, group: 'Starter Decks' });
    for (const ch of CHAPTERS)
      ch.nodes.forEach((n, i) => {
        if (!nodeOpen(solo, ch, i)) return;
        const d = deckOf(n.duelist);
        out.push({ id: `road:${n.id}`, name: n.duelist.name, title: n.duelist.title, portrait: n.duelist.portrait, ...d, group: 'Met on the Millennium Road', condition: n.condition });
      });
    for (const prof of loadProfiles()) {
      if (prof.id === p.profile.id) continue;
      const d = activeDeck(loadSpeedSave(prof.id));
      if (d && speedDeckProblems(d).length === 0) out.push({ id: `profile:${prof.id}`, name: prof.alias, title: `${d.name} (this phone)`, portrait: d.main.find((n) => card(n)?.kind === 'monster') ?? d.main[0], main: d.main, extra: d.extra, skill: d.skill, group: 'Brothers and friends' });
    }
    for (const c of prefs.codes) {
      const d = readDeckCode(c.code);
      if (d) out.push({ id: `code:${c.code}`, talk: talkOf(c.code), name: c.name, title: `${d.name} (${talkOf(c.code) ? 'fighter' : 'deck'} code)`, portrait: d.main.find((n) => card(n)?.kind === 'monster') ?? d.main[0], main: d.main, extra: d.extra, skill: d.skill, group: 'Brothers and friends' });
    }
    if (myDeck) out.push({ id: 'mirror', name: 'Mirror Match', title: `a copy of ${myDeck.name}`, portrait: myDeck.main.find((n) => card(n)?.kind === 'monster') ?? myDeck.main[0], main: myDeck.main, extra: myDeck.extra, skill: myDeck.skill, group: 'Brothers and friends' });
    return out;
  }, [solo, myDeck?.id, prefs.codes.length]);
  // (until one is picked: the first starter that isn't the deck you're testing, not a mirror of it)
  const foe = foes.find((f) => f.id === prefs.oppId) ?? foes.find((f) => f.skill !== myDeck?.skill || f.main.join() !== myDeck?.main.join()) ?? foes[0];
  const problems = myDeck ? speedDeckProblems(myDeck) : ['Build a deck first'];

  const start = () => {
    if (!myDeck || !foe || problems.length) return;
    const cond = prefs.conditions ? foe.condition : undefined;
    const lp = (n: number, base?: number) => (n !== 4000 ? n : base);
    p.onDuel({
      me: { name: p.name, main: myDeck.main, extra: myDeck.extra, skill: myDeck.skill, setup: { ...(cond?.player ?? {}), lp: lp(prefs.myLp, cond?.player?.lp) } },
      cpu: { name: foe.name, main: foe.main, extra: foe.extra, skill: prefs.cpuSkill === 'none' ? null : foe.skill, setup: { ...(cond?.cpu ?? {}), lp: lp(prefs.cpuLp, cond?.cpu?.lp) } },
      first: cond?.cpuFirst && prefs.first === 'coin' ? 'cpu' : prefs.first,
      context: { kind: 'practice', oppId: foe.id, deckId: myDeck.id, first: prefs.first, conditions: prefs.conditions },
      level: savedDifficulty(),
      vs: { label: 'PRACTICE DUEL', mePortrait: ace(myDeck.main), cpuPortrait: foe.portrait, cpuTitle: foe.title, line: 'Nothing rides on this one. Show me what that deck can do.', notes: cond ? [cond.text] : [], goals: [] },
    });
  };

  const rep = p.report?.kind === 'practice' ? p.report : null;
  const groups = [...new Set(foes.map((f) => f.group))];
  const LPS = [2000, 4000, 6000, 8000];
  const myCode = myDeck ? deckCode(myDeck) : '';

  return (
    <div class="screen so">
      <Top title="Practice Duel" sub="test any deck · nothing here counts" onBack={p.onExit} />
      <div class="so-tabs">
        <button class={tab === 'play' ? 'on' : ''} onClick={() => setTab('play')}>
          You duel
        </button>
        <button class={tab === 'watch' ? 'on' : ''} onClick={() => setTab('watch')}>
          Computer vs computer
        </button>
      </div>
      {tab === 'watch' ? (
        <WatchSetup {...p} foes={foes.filter((f) => f.id !== 'mirror')} onPaste={() => setPaste(true)} />
      ) : (
      <div class="so-body">
        <div class="so-vs">
          <div class="so-vs-side">
            <span class="so-label">Your deck</span>
            {myDeck ? <Portrait d={{ name: myDeck.name, portrait: myDeck.main.find((n) => card(n)?.kind === 'monster') ?? myDeck.main[0] }} /> : <div class="so-portrait m" />}
            <b>{myDeck?.name ?? 'No deck'}</b>
            <div class="so-chips">
              {speed.decks.map((d) => (
                <button key={d.id} class={`so-chip ${d.id === myDeck?.id ? 'on' : ''}`} onClick={() => setDeckId(d.id)}>
                  {d.name}
                </button>
              ))}
            </div>
          </div>
          <div class="so-vs-mid">VS</div>
          <div class="so-vs-side">
            <span class="so-label">Opponent</span>
            {foe && <Portrait d={foe} />}
            <b>{foe?.name}</b>
            <span class="so-dim">{foe?.title}</span>
            <Btn onClick={() => setPickFoe(true)}>Change</Btn>
          </div>
        </div>
        {problems.length > 0 && <div class="so-warn">Your deck isn't ready: {problems[0]}</div>}
        <div class="so-opts">
          <div class="so-opt">
            <span>Goes first</span>
            <div class="so-chips">
              {(['coin', 'me', 'cpu'] as const).map((f) => (
                <button key={f} class={`so-chip ${prefs.first === f ? 'on' : ''}`} onClick={() => setPrefs({ first: f })}>
                  {f === 'coin' ? 'Coin toss' : f === 'me' ? 'Me' : 'Them'}
                </button>
              ))}
            </div>
          </div>
          <div class="so-opt">
            <span>My LP</span>
            <div class="so-chips">
              {LPS.map((n) => (
                <button key={n} class={`so-chip ${prefs.myLp === n ? 'on' : ''}`} onClick={() => setPrefs({ myLp: n })}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div class="so-opt">
            <span>Their LP</span>
            <div class="so-chips">
              {LPS.map((n) => (
                <button key={n} class={`so-chip ${prefs.cpuLp === n ? 'on' : ''}`} onClick={() => setPrefs({ cpuLp: n })}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div class="so-opt">
            <span>Their Skill</span>
            <div class="so-chips">
              <button class={`so-chip ${prefs.cpuSkill !== 'none' ? 'on' : ''}`} onClick={() => setPrefs({ cpuSkill: 'theirs' })}>
                {skillName(foe?.skill)}
              </button>
              <button class={`so-chip ${prefs.cpuSkill === 'none' ? 'on' : ''}`} onClick={() => setPrefs({ cpuSkill: 'none' })}>
                No Skill
              </button>
            </div>
          </div>
          {foe?.condition && (
            <div class="so-opt">
              <span>Boss rules</span>
              <div class="so-chips">
                <button class={`so-chip ${prefs.conditions ? 'on' : ''}`} onClick={() => setPrefs({ conditions: true })}>
                  On
                </button>
                <button class={`so-chip ${!prefs.conditions ? 'on' : ''}`} onClick={() => setPrefs({ conditions: false })}>
                  Off
                </button>
              </div>
              {prefs.conditions && <p class="so-dim">{foe.condition.text}</p>}
            </div>
          )}
        </div>
        <div class="so-sticky-go">
          <Btn kind="gold" disabled={!foe || problems.length > 0} onClick={start}>
            Duel!
          </Btn>
        </div>
        <div class="so-row">
          <Btn onClick={() => setShare(true)} disabled={!myDeck}>
            Share my deck code
          </Btn>
          <Btn onClick={() => setPaste(true)}>Add a deck code</Btn>
        </div>
      </div>
      )}

      {pickFoe && (
        <Sheet title="Pick an opponent" onClose={() => setPickFoe(false)} wide>
          {groups.map((g) => (
            <div key={g}>
              <div class="so-group">{g}</div>
              <div class="so-foes">
                {foes
                  .filter((f) => f.group === g)
                  .map((f) => (
                    <button key={f.id} class={`so-foe ${foe?.id === f.id ? 'on' : ''}`} onClick={() => (setPrefs({ oppId: f.id }), setPickFoe(false))}>
                      <Portrait d={f} size="s" />
                      <b>{f.name}</b>
                      <span>{f.title}</span>
                    </button>
                  ))}
              </div>
            </div>
          ))}
          <p class="so-dim">Beat duelists on the Millennium Road to add them here.</p>
        </Sheet>
      )}
      {share && myDeck && (
        <Sheet title={`${myDeck.name}: deck code`} onClose={() => setShare(false)}>
          <p class="so-dim">Text this to your brother. He taps "Add a deck code" in Practice Duel to fight your deck.</p>
          <textarea class="so-code" readOnly value={myCode} onFocus={(e) => (e.target as HTMLTextAreaElement).select()} />
          <Btn kind="blue" onClick={() => void navigator.clipboard?.writeText(myCode).catch(() => {})}>
            Copy
          </Btn>
        </Sheet>
      )}
      {paste && (
        <Sheet title="Add a deck code" onClose={() => setPaste(false)}>
          <p class="so-dim">Paste a deck code or fighter code your brother sent you.</p>
          <textarea class="so-code" value={pasteText} placeholder="SD1...." onInput={(e) => setPasteText((e.target as HTMLTextAreaElement).value)} />
          {pasteText && !readDeckCode(pasteText) && <div class="so-warn">That doesn't look like a deck code.</div>}
          <Btn
            kind="gold"
            disabled={!readDeckCode(pasteText)}
            onClick={() => {
              const d = readDeckCode(pasteText)!;
              const code = pasteText.trim().replace(/\s+/g, '');
              const codes = [{ name: d.name, code }, ...prefs.codes.filter((c) => c.code !== code)].slice(0, 8);
              // In Computer vs computer, a pasted fighter lands on the second side.
              setPrefs(tab === 'watch' ? { codes, watch: { ...WATCH_DEFAULT, ...prefs.watch, b: `code:${code}`, talkB: talkOf(code) } } : { codes, oppId: `code:${code}` });
              setPasteText('');
              setPaste(false);
            }}
          >
            Add
          </Btn>
        </Sheet>
      )}
      {rep?.ctx.watch && (
        <Sheet onClose={p.onReportSeen}>
          <div class="so-result w">{rep.outcome.result === 'd' ? 'DRAW' : `${(rep.outcome.result === 'w' ? p.lastSpec?.me.name : p.lastSpec?.cpu.name) ?? ''} WINS`}</div>
          <p class="so-center so-dim">
            {rep.outcome.result === 'w' ? `${rep.outcome.myLp} LP left` : rep.outcome.result === 'l' ? `${rep.outcome.oppLp} LP left` : 'Nobody won'} · turn {rep.outcome.turns}
          </p>
          <div class="so-row">
            <Btn kind="gold" onClick={() => (p.onReportSeen(), p.lastSpec && p.onDuel(p.lastSpec))}>
              Rematch
            </Btn>
            <Btn onClick={p.onReportSeen}>Change the talks</Btn>
          </div>
        </Sheet>
      )}
      {rep && !rep.ctx.watch && (
        <Sheet onClose={p.onReportSeen}>
          <ResultBanner result={rep.outcome.result} />
          <p class="so-center so-dim">
            {rep.outcome.result === 'w' ? `Won with ${rep.outcome.myLp} LP left` : rep.outcome.result === 'l' ? `They had ${rep.outcome.oppLp} LP left` : 'Nobody won'} · turn {rep.outcome.turns}
          </p>
          <div class="so-row">
            <Btn kind="gold" onClick={() => p.lastSpec && p.onDuel(p.lastSpec)}>
              Rematch
            </Btn>
            <Btn onClick={p.onReportSeen}>Done</Btn>
          </div>
        </Sheet>
      )}
    </div>
  );
}

const WATCH_DEFAULT: WatchPrefs = { a: null, b: null, talkA: '', talkB: '' };

/** Ready-made talks to start from. */
const TALKS: { label: string; talk: string }[] = [
  { label: 'All-out', talk: 'Go all-out! Attack every turn and go for their life points.' },
  { label: 'Careful', talk: 'Be careful. Only attack when it clearly wins, and protect your life points.' },
  { label: 'Trap master', talk: 'Save your traps for their biggest monster and play defense until then.' },
  { label: 'Go big', talk: 'Tribute for your big monsters and hunt their strongest monster.' },
];

/** Computer vs computer: pick two fighters, coach each one, then watch. */
function WatchSetup(p: Ctx & { foes: PracticeFoe[]; onPaste: () => void }) {
  const { solo, setSolo, speed } = p;
  const w = { ...WATCH_DEFAULT, ...solo.practice.watch };
  const setW = (x: Partial<WatchPrefs>) => setSolo({ ...solo, practice: { ...solo.practice, watch: { ...w, ...x } } });
  const [picking, setPicking] = useState<'a' | 'b' | null>(null);
  const [share, setShare] = useState(false);
  const mine: PracticeFoe[] = speed.decks
    .filter((d) => speedDeckProblems(d).length === 0)
    .map((d) => ({ id: `deck:${d.id}`, name: d.name, title: 'your deck', portrait: ace(d.main), main: d.main, extra: d.extra, skill: d.skill, group: 'Your decks' }));
  const all = [...mine, ...p.foes];
  const A = all.find((f) => f.id === w.a) ?? all[0];
  const B = all.find((f) => f.id === w.b) ?? all.find((f) => f.id !== A?.id) ?? all[0];
  const readA = readPepTalk(w.talkA);
  const readB = readPepTalk(w.talkB);
  const groups = [...new Set(all.map((f) => f.group))];
  const myDeckA = A?.id.startsWith('deck:') ? speed.decks.find((d) => `deck:${d.id}` === A.id) : undefined;
  const code = myDeckA ? fighterCode(myDeckA, w.talkA) : '';

  const go = () => {
    if (!A || !B) return;
    const nameB = B.name === A.name ? `${B.name} (2)` : B.name;
    p.onDuel({
      me: { name: A.name, main: A.main, extra: A.extra, skill: A.skill },
      cpu: { name: nameB, main: B.main, extra: B.extra, skill: B.skill },
      first: 'coin',
      context: { kind: 'practice', oppId: B.id, deckId: null, first: 'coin', conditions: false, watch: true },
      watch: { tactics: [readA.tactics, readB.tactics] },
      vs: { label: 'COMPUTER VS COMPUTER', mePortrait: A.portrait, cpuPortrait: B.portrait, cpuTitle: B.title, line: w.talkB.trim() || B.title, notes: [`${A.name}: ${tacticsLabel(readA.tactics)}`, `${nameB}: ${tacticsLabel(readB.tactics)}`], goals: [] },
    });
  };

  const side = (key: 'a' | 'b', f: PracticeFoe | undefined, talk: string, read: ReturnType<typeof readPepTalk>) => (
    <div class="so-fighter">
      <div class="so-fighter-h">
        {f ? <Portrait d={f} size="s" /> : <div class="so-portrait s" />}
        <div>
          <span class="so-label">{key === 'a' ? 'Fighter 1' : 'Fighter 2'}</span>
          <b>{f?.name ?? 'Pick a deck'}</b>
          <span class="so-dim">{f?.title}</span>
        </div>
        <Btn onClick={() => setPicking(key)}>Change</Btn>
      </div>
      <textarea
        class="so-talk"
        maxLength={400}
        value={talk}
        placeholder="Give it a pep talk: how should it fight?"
        onInput={(e) => setW(key === 'a' ? { talkA: (e.target as HTMLTextAreaElement).value } : { talkB: (e.target as HTMLTextAreaElement).value })}
      />
      <div class="so-chips">
        {TALKS.map((x) => (
          <button key={x.label} class="so-chip" onClick={() => setW(key === 'a' ? { talkA: x.talk } : { talkB: x.talk })}>
            {x.label}
          </button>
        ))}
      </div>
      <ul class="so-understood">
        {read.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );

  return (
    <div class="so-body">
      <p class="so-dim">Pick two decks, coach each computer duelist, then sit back and watch them fight. Nothing here counts.</p>
      {side('a', A, w.talkA, readA)}
      <div class="so-vs-mid so-center">VS</div>
      {side('b', B, w.talkB, readB)}
      <Btn kind="gold" disabled={!A || !B} onClick={go}>
        Send them out!
      </Btn>
      <div class="so-row">
        <Btn onClick={() => setShare(true)} disabled={!myDeckA}>
          Share fighter 1
        </Btn>
        <Btn onClick={p.onPaste}>Add a fighter code</Btn>
      </div>
      <p class="so-dim">A fighter code is your deck plus your pep talk. Text it to your brother; he adds it here and it fights the way you coached it.</p>
      {picking && (
        <Sheet title={`Pick fighter ${picking === 'a' ? 1 : 2}`} onClose={() => setPicking(null)} wide>
          {groups.map((g) => (
            <div key={g}>
              <div class="so-group">{g}</div>
              <div class="so-foes">
                {all
                  .filter((f) => f.group === g)
                  .map((f) => (
                    <button
                      key={f.id}
                      class={`so-foe ${(picking === 'a' ? A : B)?.id === f.id ? 'on' : ''}`}
                      onClick={() => {
                        // A fighter code brings its own pep talk along.
                        const talk = f.talk ? (picking === 'a' ? { talkA: f.talk } : { talkB: f.talk }) : {};
                        setW(picking === 'a' ? { a: f.id, ...talk } : { b: f.id, ...talk });
                        setPicking(null);
                      }}
                    >
                      <Portrait d={f} size="s" />
                      <b>{f.name}</b>
                      <span>{f.title}</span>
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </Sheet>
      )}
      {share && myDeckA && (
        <Sheet title={`${myDeckA.name}: fighter code`} onClose={() => setShare(false)}>
          <p class="so-dim">Your deck and your pep talk in one code. Your brother taps "Add a fighter code" in Computer vs computer.</p>
          <textarea class="so-code" readOnly value={code} onFocus={(e) => (e.target as HTMLTextAreaElement).select()} />
          <Btn kind="blue" onClick={() => void navigator.clipboard?.writeText(code).catch(() => {})}>
            Copy
          </Btn>
        </Sheet>
      )}
    </div>
  );
}

/** Watching the computer duel itself: pause and speed, over the duel screen. */
export function WatchBar({ speed, paused, onSpeed, onPause, onLeave }: { speed: number; paused: boolean; onSpeed: (n: number) => void; onPause: (b: boolean) => void; onLeave: () => void }) {
  return (
    <div class="so-watchbar">
      <button onClick={() => onPause(!paused)}>{paused ? '▶ Play' : '❚❚ Pause'}</button>
      {[1, 2, 4].map((n) => (
        <button key={n} class={speed === n ? 'on' : ''} onClick={() => onSpeed(n)}>
          {n}x
        </button>
      ))}
      <button onClick={onLeave}>Stop</button>
    </div>
  );
}

// =====================================================================
// The Millennium Road
// =====================================================================
function Road(p: Ctx) {
  const { solo, setSolo, speed } = p;
  const c = solo.campaign;
  const [chId, setChId] = useState<string>(() => (p.report?.kind === 'campaign' ? (findNode(p.report.nodeId)?.chapter.id ?? currentChapter(solo).id) : currentChapter(solo).id));
  const [sel, setSel] = useState<CampaignNode | null>(null);
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState<'map' | 'trophies'>('map');
  const [rival, setRival] = useState(false);
  const [picking, setPicking] = useState(false);
  /** the result screens after a duel: 0 result, then one per star pick, then the chapter clear */
  const [stage, setStage] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const scrolled = useRef(false);
  // A road deck that lost copies (an old bet or break): take them out and refill it from the collection.
  const [repaired, setRepaired] = useState<string[]>([]);
  useEffect(() => {
    const r = c.deck ? repairRoadDeck(speed, c.deck) : null;
    if (!r) return;
    setSolo({ ...solo, campaign: { ...c, deck: r.deck } });
    p.onSpeed({ ...speed, road: r.deck });
    setRepaired(r.removed);
  }, [c.deck, speed.collection]);

  // The road deck or any of your decks. Anything goes decks walk the road too, but their wins pay nothing.
  const ownDecks = speed.decks;
  const chosen = c.deckId ? (ownDecks.find((d) => d.id === c.deckId) ?? null) : null;
  const deck = chosen ?? c.deck;
  const storyOwn = !!c.storyOwn;
  const setStoryOwn = (b: boolean) => setSolo({ ...solo, campaign: { ...c, storyOwn: b } });
  if (!c.starter) return <RoadStart {...p} />;
  if (editing && deck)
    return (
      <SpeedDeckEdit
        deck={deck}
        collection={deck.open ? undefined : (speed.collection ?? {})}
        onChange={(d) => (chosen ? p.onSpeed({ ...speed, decks: speed.decks.map((x) => (x.id === d.id ? d : x)) }) : (setSolo({ ...solo, campaign: { ...c, deck: d } }), p.onSpeed({ ...speed, road: d })))}
        onBack={() => setEditing(false)}
      />
    );

  const ch = CHAPTERS.find((x) => x.id === chId) ?? CHAPTERS[0];
  const problems = deck ? soloDeckProblems(speed, deck) : ['No road deck'];
  const owned = Object.values(speed.collection ?? {}).reduce((a, b) => a + b, 0);
  const allIds = CHAPTERS.flatMap((x) => x.nodes.map((n) => n.id));
  // The first duel you haven't won yet: the road's next stop.
  const nextUp = (() => {
    for (const x of CHAPTERS) for (let i = 0; i < x.nodes.length; i++) if (nodeOpen(solo, x, i) && !nodePassed(solo, x.nodes[i].id)) return { chapter: x, node: x.nodes[i] };
    return null;
  })();
  const scrollTo = (el: HTMLElement | null) => {
    if (!el || scrolled.current) return;
    scrolled.current = true;
    setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 150);
  };

  /** `retry`: straight back in from a loss (the VS screen was seen a moment ago). */
  const duel = (node: CampaignNode, retry = false) => {
    // The Masked Dealer deals a different Duel Condition every duel.
    const n = node.condition === DEALER_CONDITIONS[0] ? { ...node, condition: DEALER_CONDITIONS[Math.floor(Math.random() * DEALER_CONDITIONS.length)] } : node;
    const d = deckOf(n.duelist);
    // Two losses in a row on a duel: the next try starts with 1000 extra LP.
    const help = (c.tries?.[n.id] ?? 0) >= 2;
    const useStory = n.story && !storyOwn;
    const mine = useStory && n.story ? { main: n.story.main.flatMap((e) => (/\*\d$/.test(e) ? Array<string>(Number(e.slice(-1))).fill(e.slice(0, -2)) : [e])), extra: n.story.extra, skill: n.story.skill, name: n.story.as } : deck ? { main: deck.main, extra: deck.extra, skill: deck.skill, name: p.name } : null;
    if (!mine) return;
    p.onDuel({
      me: { name: mine.name, main: mine.main, extra: mine.extra, skill: mine.skill, setup: help ? { ...n.condition?.player, lp: (n.condition?.player?.lp ?? 4000) + 1000 } : n.condition?.player },
      cpu: { name: n.duelist.name, main: d.main, extra: d.extra, skill: d.skill, setup: n.condition?.cpu },
      first: n.condition?.cpuFirst ? 'cpu' : 'coin',
      context: { kind: 'campaign', nodeId: n.id, ...(!useStory && deck?.open ? { open: true } : {}) },
      level: campaignDifficulty((findNode(n.id)?.chapter ?? ch).n, n.boss),
      vs: { label: n.boss ? `BOSS DUEL · ${ch.item.toUpperCase()}` : useStory && n.story ? `STORY DUEL · YOU ARE ${n.story.as.toUpperCase()}` : `CHAPTER ${ch.n}`.replace('CHAPTER 8', 'POST-GAME'), mePortrait: ace(mine.main), cpuPortrait: n.duelist.portrait, cpuTitle: n.duelist.title, line: n.duelist.intro, notes: [...(n.condition ? [n.condition.text] : []), ...(help ? ['Helping hand: after two losses you start with 1000 extra LP.'] : [])], goals: !useStory && deck?.open ? [] : STAR_TEXT(n.goal) },
      ...(retry ? { retry: true } : {}),
    });
  };

  const rep = p.report?.kind === 'campaign' ? p.report : null;
  const repNode = rep ? findNode(rep.nodeId) : null;
  // Star picks and the chapter-clear screen are saved, so they come back if the app closed.
  const pickList = c.pendingPicks ?? [];
  const clearedCh = c.cleared ? (CHAPTERS.find((x) => x.id === c.cleared) ?? null) : null;
  const afterResult = !rep || stage === 1;
  /** Moves past whatever was just shown; when nothing is left, the next duel's intro opens. */
  const advance = (next: SoloSave) => {
    if ((next.campaign.pendingPicks ?? []).length || next.campaign.cleared) return setStage(1);
    setStage(0);
    if (rep?.outcome.result === 'w' && nextUp) (setChId(nextUp.chapter.id), setSel(nextUp.node));
    if (rep) p.onReportSeen();
  };

  return (
    <div class="screen so road">
      <Top
        title="The Millennium Road"
        sub={`${starCount(solo, allIds)}/${allIds.length * 3} stars · ${c.items.filter((x) => relic(x)?.millennium).length}/7 Millennium Items`}
        onBack={p.onExit}
        right={
          <button class="so-chip" onClick={() => (setView(view === 'map' ? 'trophies' : 'map'), window.scrollTo(0, 0))}>
            {view === 'map' ? 'Trophies' : 'Map'}
          </button>
        }
      />
      {view === 'trophies' ? (
        <div class="so-body">
          <div class="so-group">Millennium Items</div>
          <div class="so-items">
            {CHAPTERS.filter((x) => !x.postgame).map((x) => (
              <div key={x.id} class={`so-item ${c.items.includes(x.item) ? 'on' : ''}`}>
                <span class="so-eye">
                  <MilEye />
                </span>
                <b>{x.item}</b>
                <span>{c.items.includes(x.item) ? relic(x.item)?.text ?? x.itemText : `Beat chapter ${x.n}`}</span>
              </div>
            ))}
          </div>
          <div class="so-group">Duel Chips</div>
          <p>
            {speed.chips ?? 0}/30. You earn one the first time you three-star a duel, one a day from a Labyrinth boss, one a day for beating your brother, and more from Card Legends (every first win, every finished legend and a daily rematch). They're for betting in duels with your brother.
          </p>
          <div class="so-group">Titles</div>
          <p>{c.titles.length ? c.titles.join(' · ') : 'None yet. Bosses give you titles.'}</p>
          <div class="so-group">Collection</div>
          <p>
            {owned} cards owned. Your first win over each duelist gives you their signature cards and a pack, and new stars let you pick from their deck. Your road deck can only use cards you own.
          </p>
          <p class="so-dim">Millennium Items you win here can be brought into a Duel Labyrinth run as a starting relic.</p>
        </div>
      ) : (
        <div class="so-body">
          <div class="so-chapters">
            {CHAPTERS.map((x) => {
              const open = chapterOpen(solo, x);
              return (
                <button key={x.id} class={`so-chap ${x.id === ch.id ? 'on' : ''} ${chapterCleared(solo, x) || nodePassed(solo, x.nodes[x.nodes.length - 1].id) ? 'done' : ''}`} disabled={!open} onClick={() => setChId(x.id)}>
                  {open ? (x.postgame ? '★' : x.n) : '🔒'}
                </button>
              );
            })}
          </div>
          <div class="so-chapter">
            <div class="so-chapter-h">
              <span>{ch.postgame ? 'Post-game' : `Chapter ${ch.n}`}</span>
              <b>{ch.title}</b>
              <Stars s={[0, 1, 2].map((k) => ch.nodes.every((n) => c.stars[n.id]?.[k]))} />
            </div>
            <p class="so-blurb">{ch.blurb}</p>
          </div>
          {nextUp && (
            <Btn kind="gold" onClick={() => (setChId(nextUp.chapter.id), setSel(nextUp.node))}>
              Continue the road: {nextUp.node.duelist.name}
            </Btn>
          )}
          <div class="so-path">
            {ch.nodes.map((n, i) => {
              const open = nodeOpen(solo, ch, i);
              const wins = c.wins[n.id] ?? 0;
              const waiting = !wins && nodePassed(solo, n.id);
              const isNext = nextUp?.node.id === n.id;
              return (
                <button key={n.id} ref={isNext ? scrollTo : undefined} class={`so-node ${n.boss ? 'boss' : ''} ${open ? '' : 'locked'} ${wins || waiting ? 'won' : ''} ${isNext ? 'next' : ''}`} disabled={!open} onClick={() => setSel(n)}>
                  <Portrait d={n.duelist} size={n.boss ? 'm' : 's'} />
                  <div class="so-node-t">
                    <b>{open ? n.duelist.name : '???'}</b>
                    <span>{open ? n.duelist.title : 'Win the duel before this one'}</span>
                    {n.story && open && <em>Story duel: you play as {n.story.as}</em>}
                    {n.boss && open && <em>Boss · {ch.item}</em>}
                    {waiting && <em class="so-waiting">Prizes waiting</em>}
                  </div>
                  <Stars s={c.stars[n.id]} />
                </button>
              );
            })}
            <div class={`so-node item ${chapterCleared(solo, ch) ? 'won' : 'locked'}`}>
              <span class="so-eye big">
                <MilEye size={34} />
              </span>
              <div class="so-node-t">
                <b>{ch.item}</b>
                <span>{relic(ch.item)?.text ?? ch.itemText}</span>
                {!chapterCleared(solo, ch) && nodePassed(solo, ch.nodes[ch.nodes.length - 1].id) && <em class="so-waiting">Item waiting: beat the boss with your own cards</em>}
              </div>
            </div>
          </div>
          <div class="so-deckbar">
            <div>
              <b>
                {chosen ? `Your deck: ${chosen.name}` : 'Road deck'}
                {chosen?.open && <span class="so-anygoes">Anything goes</span>}
              </b>
              <span class={problems.length ? 'so-bad' : 'so-good'}>{problems.length ? problems[0] : `${deck!.main.length} cards · ${skillName(deck!.skill)}`}</span>
              {chosen?.open && !problems.length && <span class="so-dim">Wins open the road but pay no cards, chips or Items.</span>}
              {!chosen && repaired.length > 0 && <span class="so-dim">Took out {repaired.length === 1 ? repaired[0] : `${repaired.length} cards`} you no longer own and refilled the deck from your collection.</span>}
            </div>
            {ownDecks.length > 0 && (
              <Btn kind="blue" onClick={() => setPicking(true)}>
                Change
              </Btn>
            )}
            <Btn onClick={() => setEditing(true)}>Edit</Btn>
          </div>
          <Btn onClick={() => setRival(true)}>Rival duel: your brother's deck</Btn>
        </div>
      )}

      {sel && (
        <Sheet onClose={() => setSel(null)}>
          <div class="so-intro">
            <Portrait d={sel.duelist} size="l" />
            <div>
              <span class="so-label">{sel.boss ? 'BOSS DUEL' : sel.story ? 'STORY DUEL' : 'DUEL'}</span>
              <h3>{sel.duelist.name}</h3>
              <span class="so-dim">{sel.duelist.title}</span>
            </div>
          </div>
          <p class="so-quote">“{sel.duelist.intro}”</p>
          {sel.condition && (
            <div class="so-cond">
              <b>Duel Condition</b>
              {sel.condition === DEALER_CONDITIONS[0] ? (
                <span>The Dealer deals one of these at random each duel: {DEALER_CONDITIONS.map((c) => c.text.split(':')[0]).join(', ')}.</span>
              ) : (
                <span>{sel.condition.text}</span>
              )}
            </div>
          )}
          {sel.story && (
            <div class="so-cond blue so-storypick">
              <span>{storyOwn ? `Story duel, but you bring your own deck instead of ${sel.story.as}'s.` : `You duel as ${sel.story.as}, with their deck.`}</span>
              <div class="so-seg">
                <button class={storyOwn ? '' : 'on'} onClick={() => setStoryOwn(false)}>
                  Story deck
                </button>
                <button class={storyOwn ? 'on' : ''} onClick={() => setStoryOwn(true)}>
                  My deck
                </button>
              </div>
            </div>
          )}
          {(sel.story && !storyOwn) || !deck?.open || problems.length ? (
            <div class="so-goals">
              {STAR_TEXT(sel.goal).map((t, i) => (
                <div key={t} class={c.stars[sel.id]?.[i] ? 'on' : ''}>
                  <span>★</span> {t}
                </div>
              ))}
            </div>
          ) : (
            <p class="so-dim">Anything goes deck: no stars or prizes, but a win still opens the next duel.</p>
          )}
          <div class="so-dim">Their deck: {deckOf(sel.duelist).main.length} cards{sel.duelist.skill ? ` · Skill: ${skillName(sel.duelist.skill)}` : ''}</div>
          {(!sel.story || storyOwn) && deck && (
            <div class="so-deckbar">
              <div>
                <b>
                  Your deck: {deck.name}
                  {deck.open && <span class="so-anygoes">Anything goes</span>}
                </b>
                <span class={problems.length ? 'so-bad' : 'so-good'}>{problems.length ? problems[0] : `${deck.main.length} cards · ${skillName(deck.skill)}`}</span>
              </div>
              {ownDecks.length > 0 && (
                <Btn kind="blue" onClick={() => setPicking(true)}>
                  Change
                </Btn>
              )}
            </div>
          )}
          <Btn kind="gold" disabled={(!sel.story || storyOwn) && problems.length > 0} onClick={() => (setSel(null), duel(sel))}>
            Duel!
          </Btn>
        </Sheet>
      )}

      {p.report?.kind === 'practice' && (
        <Sheet>
          <ResultBanner result={p.report.outcome.result} />
          <p class="so-center so-dim">Rival duel against {p.lastSpec?.cpu.name ?? 'your rival'}. It doesn't change your road.</p>
          <Btn kind="gold" onClick={() => (p.onReportSeen(), p.lastSpec && p.onDuel(p.lastSpec))}>
            Rematch
          </Btn>
          <Btn onClick={p.onReportSeen}>Back to the road</Btn>
        </Sheet>
      )}
      {rival && <RivalSheet {...p} deck={deck} problems={problems} onClose={() => setRival(false)} />}
      {picking && (
        <SoloDeckPick
          title="Deck for the Millennium Road"
          decks={[...(c.deck ? [c.deck] : []), ...ownDecks]}
          current={deck}
          problemsOf={(d) => soloDeckProblems(speed, d)}
          note={ANY_GOES_PICK_NOTE}
          onPick={(d) => (setSolo({ ...solo, campaign: { ...c, deckId: d.id === c.deck?.id ? null : d.id } }), setPicking(false))}
          onClose={() => setPicking(false)}
        />
      )}

      {rep && repNode && stage === 0 && (
        <Sheet>
          <ResultBanner result={rep.outcome.result} />
          <div class="so-intro">
            <Portrait d={repNode.node.duelist} size="s" />
            <p class="so-quote">“{rep.outcome.result === 'w' ? repNode.node.duelist.onLose : repNode.node.duelist.onWin}”</p>
          </div>
          {rep.outcome.result === 'w' && rep.settled.noEarn ? (
            <p class="so-center">The road moves on. Anything goes decks don't earn stars or prizes, so this duel's prizes wait for a win with your own cards.</p>
          ) : rep.outcome.result === 'w' ? (
            <>
              <div class="so-goals">
                {STAR_TEXT(repNode.node.goal).map((t, i) => (
                  <div key={t} class={`${rep.settled.stars[i] ? 'on' : ''} ${rep.settled.newStars[i] ? 'new' : ''}`}>
                    <span>★</span> {t}
                    {rep.settled.newStars[i] ? ' · NEW' : ''}
                  </div>
                ))}
              </div>
              {rep.settled.cards.length > 0 && (
                <>
                  <div class="so-group">Added to your collection</div>
                  <CardRow names={rep.settled.cards} reveal />
                </>
              )}
              {rep.settled.lines
                .filter((l) => !rep.settled.cards.includes(l))
                .map((l) => (
                  <div key={l} class="so-reward">
                    {l}
                  </div>
                ))}
            </>
          ) : (
            <p class="so-center">Tune your road deck and try again. A loss here costs nothing.</p>
          )}
          {rep.outcome.result !== 'w' && (
            <Btn kind="gold" disabled={problems.length > 0 && !(repNode.node.story && !storyOwn)} onClick={() => (advance(solo), duel(repNode.node, true))}>
              Try again
            </Btn>
          )}
          <Btn kind={rep.outcome.result === 'w' ? 'gold' : undefined} onClick={() => advance(solo)}>
            Continue
          </Btn>
        </Sheet>
      )}
      {afterResult && pickList.length > 0 && (
        <Sheet>
          <div class="so-group">New star! Choose one card to keep</div>
          <CardRow names={pickList[0]} picked={picked} onPick={setPicked} own={(n) => ownedCopies(speed, n)} />
          <Btn
            kind="gold"
            disabled={!picked}
            onClick={() => {
              const t = takePick(speed, solo, picked!);
              p.onSpeed(t.speed);
              setSolo(t.solo);
              setPicked(null);
              advance(t.solo);
            }}
          >
            Take it
          </Btn>
        </Sheet>
      )}
      {afterResult && pickList.length === 0 && clearedCh && (
        <ChapterClear
          ch={clearedCh}
          onDone={() => {
            const next = { ...solo, campaign: { ...solo.campaign, cleared: undefined } };
            setSolo(next);
            advance(next);
          }}
        />
      )}
    </div>
  );
}

function ChapterClear({ ch, onDone }: { ch: Chapter; onDone: () => void }) {
  const next = CHAPTERS[CHAPTERS.indexOf(ch) + 1];
  return (
    <Sheet>
      <div class="so-clear">
        <span class="so-label">{ch.postgame ? 'THE KING OF GAMES' : `CHAPTER ${ch.n} CLEAR`}</span>
        <div class="so-eye huge">
          <MilEye size={84} />
        </div>
        <h3>{ch.postgame ? 'King of Games' : ch.item}</h3>
        {ch.postgame ? <p>You beat the King himself. The title is yours.</p> : <p>{relic(ch.item)?.text ?? ch.itemText}</p>}
        {!ch.postgame && <p class="so-dim">You can now bring it into the Duel Labyrinth as a starting relic.</p>}
        {next && <p>Next: {next.postgame ? 'a challenger waits beyond the road...' : `Chapter ${next.n}, ${next.title}`}</p>}
      </div>
      <Btn kind="gold" onClick={onDone}>
        Continue
      </Btn>
    </Sheet>
  );
}

function RoadStart(p: Ctx) {
  const [sel, setSel] = useState<string | null>(null);
  const st = STARTERS.find((s) => s.character === sel);
  const preview = st ? deckFromStarter(st) : null;
  const first = CHAPTERS[0];
  return (
    <div class="screen so road">
      <Top title="The Millennium Road" onBack={p.onExit} />
      <div class="so-body">
        <div class="so-prologue">
          <span class="so-label">PROLOGUE</span>
          <p>Pegasus built the Speed Realm, a duel world that pulled in duelists from every era. Then a stranger in a mask, the Masked Dealer, shattered the seven Millennium Items and handed each piece to a champion.</p>
          <p>Win them back. You start with one Starter Deck. Every duelist you beat adds cards from their deck to your collection, and your road deck can only use what you own.</p>
        </div>
        <div class="so-group">Choose your Starter Deck</div>
        <div class="so-foes">
          {STARTERS.map((s) => {
            const d = deckFromStarter(s);
            const art = d.main.find((n) => card(n)?.kind === 'monster') ?? d.main[0];
            return (
              <button key={s.character} class={`so-foe ${sel === s.character ? 'on' : ''}`} onClick={() => setSel(s.character)}>
                <Portrait d={{ name: s.character, portrait: art }} size="s" />
                <b>{s.character}</b>
                <span>{skillName(d.skill)}</span>
              </button>
            );
          })}
        </div>
        {preview && st && (
          <>
            <div class="so-group">
              {st.character}'s deck · {preview.main.length} cards
            </div>
            <Btn
              kind="gold"
              onClick={() => {
                const r = startRoad(p.speed, p.solo, st.character);
                p.onSpeed(r.speed);
                p.setSolo(r.solo);
              }}
            >
              Begin the road with {st.character}
            </Btn>
            <DeckListView main={preview.main} extra={preview.extra} />
          </>
        )}
        <p class="so-dim">First stop: {first.title}.</p>
      </div>
    </div>
  );
}

function RivalSheet(p: Ctx & { deck: SpeedDeck | null; problems: string[]; onClose: () => void }) {
  const others = loadProfiles()
    .filter((x) => x.id !== p.profile.id)
    .map((x) => ({ name: x.alias, deck: activeDeck(loadSpeedSave(x.id)) }))
    .filter((x): x is { name: string; deck: SpeedDeck } => !!x.deck && speedDeckProblems(x.deck).length === 0);
  const codes = p.solo.practice.codes.map((c) => ({ name: c.name, deck: readDeckCode(c.code) })).filter((x): x is { name: string; deck: SpeedDeck } => !!x.deck);
  const list = [...others, ...codes];
  const go = (r: { name: string; deck: SpeedDeck }) => {
    if (!p.deck) return;
    p.onClose();
    // A rival duel is practice with your road deck: it counts for nothing, so nobody farms it.
    p.onDuel({
      me: { name: p.name, main: p.deck.main, extra: p.deck.extra, skill: p.deck.skill },
      cpu: { name: r.name, main: r.deck.main, extra: r.deck.extra, skill: r.deck.skill },
      first: 'coin',
      context: { kind: 'practice', oppId: `rival:${r.name}`, deckId: p.deck.id, first: 'coin', conditions: false },
      level: savedDifficulty(),
    });
  };
  return (
    <Sheet title="Rival duel" onClose={p.onClose}>
      <p class="so-dim">Take your road deck against your brother's real deck, played by the computer. It's a test of how far your road deck has come and doesn't change your road.</p>
      {p.problems.length > 0 && <div class="so-warn">Fix your road deck first: {p.problems[0]}</div>}
      {list.length === 0 && <p>No rival decks yet. Your brother can make a profile on this phone, or send you his deck code (Practice Duel, "Share my deck code").</p>}
      <div class="so-foes">
        {list.map((r) => (
          <button key={r.name + r.deck.name} class="so-foe" disabled={p.problems.length > 0} onClick={() => go(r)}>
            <Portrait d={{ name: r.name, portrait: r.deck.main.find((n) => card(n)?.kind === 'monster') ?? r.deck.main[0] }} size="s" />
            <b>{r.name}</b>
            <span>{r.deck.name}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

// =====================================================================
// Duel Labyrinth
// =====================================================================
const STOP_ICON: Record<Stop['kind'], string> = { duel: '⚔', elite: '☠', shop: '🛒', event: '?', rest: '☾', treasure: '◆', boss: '♛' };
const STOP_NAME: Record<Stop['kind'], string> = { duel: 'Duel', elite: 'Elite duel', shop: 'Card Shop', event: 'Wager', rest: 'Rest', treasure: 'Treasure', boss: 'Floor boss' };

/** Where a stop sits across its row (percent): spread edge to edge so narrow phones keep a gap. */
const mapX = (col: number, width: number) => ((col + 0.5) / width) * 100;

function Hearts({ n, max }: { n: number; max: number }) {
  return (
    <span class="so-hearts">
      {Array.from({ length: max }, (_, i) => (
        <span key={i} class={i < n ? 'on' : ''}>
          ♥
        </span>
      ))}
    </span>
  );
}

function Labyrinth(p: Ctx) {
  const { solo, setSolo } = p;
  const lab = solo.labyrinth;
  const run = lab.run;
  const [ended, setEnded] = useState<RunSummary | null>(p.report?.kind === 'labyrinth' ? p.report.ended : null);
  // A duel still marked as being played means the app closed mid-duel: that duel is lost.
  const [walkedOut] = useState(() => !!run?.staked && !p.report);
  useEffect(() => {
    if (walkedOut && run?.staked) setRun(afterDuel(run, 'l', run.daily ? [] : lab.upgrades));
  }, []);
  const setRun = (r: Run) => {
    if (r.over) {
      const done = endRunPaid(p.speed, solo, r);
      if (done.speed !== p.speed) p.onSpeed(done.speed);
      setSolo(done.solo);
      setEnded(done.summary);
      return;
    }
    setSolo({ ...solo, labyrinth: { ...lab, run: r } });
  };
  if (ended) return <RunEnd {...p} s={ended} onDone={() => (setEnded(null), p.onReportSeen())} />;
  if (!run) return <LabyrinthStart {...p} />;
  return <RunView {...p} run={run} setRun={setRun} walkedOut={walkedOut} />;
}

function LabyrinthStart(p: Ctx) {
  const { solo, setSolo } = p;
  const lab = solo.labyrinth;
  const [sheet, setSheet] = useState<'new' | 'daily' | 'upgrades' | 'history' | 'compare' | null>(null);
  const [starter, setStarter] = useState(STARTERS[0].character);
  // Or one of your own decks (any of them, Anything goes too) instead of a Starter Deck.
  const myDecks = soloDecks(p.speed);
  const [myDeckId, setMyDeckId] = useState<string | null>(lab.deckId ?? null);
  const myDeck = myDecks.find((d) => d.id === myDeckId) ?? null;
  const myProblems = myDeck ? soloDeckProblems(p.speed, myDeck) : [];
  const [curse, setCurse] = useState(0);
  const [bring, setBring] = useState<string | null>(null);
  const items = solo.campaign.items.filter((x) => relic(x)?.millennium);
  const [code, setCode] = useState('');
  const today = todayString();
  // shown as "Oct 17", not the date code the Daily is keyed by
  const todayLabel = new Date(`${today}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const doneToday = lab.history.find((h) => h.daily === today);
  const begin = (o: { starter: string; seed: number; daily?: string; curse: number; bring?: string; deck?: SpeedDeck }) => {
    const run = newRun({ ...o, upgrades: lab.upgrades });
    setSolo({ ...solo, labyrinth: { ...lab, run, ...(o.daily ? {} : { deckId: o.deck?.id ?? null }) } });
  };
  const theirs = readResultCode(code);
  return (
    <div class="screen so lab">
      <Top title="Duel Labyrinth" sub={`${lab.fragments} Soul Fragments`} onBack={p.onExit} />
      <div class="so-body">
        <div class="so-prologue">
          <span class="so-label">THE LABYRINTH</span>
          <p>Three floors of duels, shops, wagers and treasure. Start from a Starter Deck or one of your own decks, pick a new card after every win and hunt Millennium relics. You have 3 hearts: lose a duel, lose a heart. Clear all three floors for a booster pack: the first clear at each Curse, then one clear a day. The Daily and Anything goes decks pay no pack.</p>
        </div>
        <Btn kind="gold" onClick={() => setSheet('new')}>
          New run
        </Btn>
        <Btn kind="blue" onClick={() => setSheet('daily')}>
          Daily Labyrinth · {todayLabel}
          {doneToday ? ' · played' : ''}
        </Btn>
        <div class="so-row">
          <Btn onClick={() => setSheet('upgrades')}>Upgrades</Btn>
          <Btn onClick={() => setSheet('history')}>Runs</Btn>
          <Btn onClick={() => setSheet('compare')}>Compare</Btn>
        </div>
        {lab.best && (
          <p class="so-dim">
            Best run: {lab.best.won ? 'cleared all 3 floors' : `reached floor ${lab.best.floor}`} with {lab.best.starter}, {lab.best.wins} wins{lab.best.curse ? `, Curse ${lab.best.curse}` : ''}.
          </p>
        )}
      </div>
      {sheet === 'new' && (
        <Sheet title="New run" onClose={() => setSheet(null)}>
          <div class="so-group">Starter Deck</div>
          <div class="so-chips">
            {STARTERS.map((s) => (
              <button key={s.character} class={`so-chip ${!myDeck && starter === s.character ? 'on' : ''}`} onClick={() => (setStarter(s.character), setMyDeckId(null))}>
                {s.character}
              </button>
            ))}
          </div>
          {myDecks.length > 0 && (
            <>
              <div class="so-group">Or bring your own deck</div>
              <div class="so-mydecks">
                {myDecks.map((d) => {
                  const bad = soloDeckProblems(p.speed, d);
                  return (
                    <button key={d.id} class={`lg-deck ${myDeckId === d.id ? 'on' : ''}`} onClick={() => (playBlip(), setMyDeckId(myDeckId === d.id ? null : d.id))}>
                      <b>
                        {myDeckId === d.id ? '★ ' : ''}
                        {d.name}
                        {d.open && <span class="so-anygoes">Anything goes</span>}
                      </b>
                      <span class={bad.length ? 'so-bad' : 'so-good'}>{bad.length ? bad[0] : deckSummary(d)}</span>
                    </button>
                  );
                })}
              </div>
              {myDeck?.open && <p class="so-dim">{ANY_GOES_NOTE} No Soul Fragments either.</p>}
            </>
          )}
          {lab.curseUnlocked > 0 && (
            <>
              <div class="so-group">Curse</div>
              <div class="so-chips">
                {Array.from({ length: lab.curseUnlocked + 1 }, (_, i) => (
                  <button key={i} class={`so-chip ${curse === i ? 'on' : ''}`} onClick={() => setCurse(i)}>
                    {i}
                  </button>
                ))}
              </div>
              {curse > 0 && (
                <ul class="so-curses">
                  {CURSES.slice(0, curse).map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          {lab.curseUnlocked === 0 && <p class="so-dim">Clear a run to unlock Curses: harder runs that pay more.</p>}
          <div class="so-group">Bring a Millennium Item</div>
          {items.length === 0 ? (
            <p class="so-dim">Millennium Items you win on The Millennium Road can be brought in here as a starting relic.</p>
          ) : (
            <>
              <div class="so-chips">
                <button class={`so-chip ${!bring ? 'on' : ''}`} onClick={() => setBring(null)}>
                  None
                </button>
                {items.map((it) => (
                  <button key={it} class={`so-chip ${bring === it ? 'on' : ''}`} onClick={() => setBring(it)}>
                    {it}
                  </button>
                ))}
              </div>
              {bring && <p class="so-dim">{relic(bring)?.text}</p>}
            </>
          )}
          <Btn kind="gold" disabled={myProblems.length > 0} onClick={() => begin({ starter, seed: randomSeed(), curse, bring: bring ?? undefined, deck: myDeck ?? undefined })}>
            Enter the Labyrinth
          </Btn>
        </Sheet>
      )}
      {sheet === 'daily' && (
        <Sheet title={`Daily Labyrinth · ${todayLabel}`} onClose={() => setSheet(null)}>
          <p>Everyone gets the same map, the same Starter Deck ({dailyStarter(today)}) and the same cards today. Upgrades, Items, Curses and your own decks stay home, so it's a fair race. Play it, then text your result code to your brother.</p>
          {doneToday ? (
            <>
              <p>
                You played today's: {doneToday.won ? 'cleared!' : `floor ${doneToday.floor}`}, {doneToday.wins} wins.
              </p>
              <textarea class="so-code" readOnly value={resultCode(doneToday, p.name)} />
              <Btn kind="blue" onClick={() => void navigator.clipboard?.writeText(resultCode(doneToday, p.name)).catch(() => {})}>
                Copy result code
              </Btn>
            </>
          ) : (
            <Btn kind="gold" onClick={() => begin({ starter: dailyStarter(today), seed: dailySeed(today), daily: today, curse: 0 })}>
              Start today's run
            </Btn>
          )}
        </Sheet>
      )}
      {sheet === 'upgrades' && (
        <Sheet title={`Upgrades · ${lab.fragments} Soul Fragments`} onClose={() => setSheet(null)}>
          <p class="so-dim">Every run pays Soul Fragments, more the further you get. Upgrades last forever.</p>
          {UPGRADES.map((u) => {
            const have = lab.upgrades.includes(u.id);
            return (
              <div key={u.id} class="so-shopitem">
                <div>
                  <b>{u.name}</b>
                  <span>{u.text}</span>
                </div>
                <Btn kind={have ? 'plain' : 'blue'} disabled={have || lab.fragments < u.price} onClick={() => setSolo({ ...solo, labyrinth: { ...lab, fragments: lab.fragments - u.price, upgrades: [...lab.upgrades, u.id] } })}>
                  {have ? 'Owned' : `${u.price}`}
                </Btn>
              </div>
            );
          })}
        </Sheet>
      )}
      {sheet === 'history' && (
        <Sheet title="Your runs" onClose={() => setSheet(null)}>
          {lab.history.length === 0 && <p>No runs yet.</p>}
          {lab.history.map((h, i) => (
            <div key={i} class="so-shopitem">
              <div>
                <b>
                  {h.won ? 'Cleared' : `Floor ${h.floor}`} · {h.starter}
                  {h.open && <span class="so-anygoes">Anything goes</span>}
                </b>
                <span>
                  {h.daily ? `Daily ${h.daily} · ` : ''}
                  {h.wins} wins{h.curse ? ` · Curse ${h.curse}` : ''}{h.open ? '' : ` · +${h.fragments} fragments`}
                </span>
              </div>
            </div>
          ))}
        </Sheet>
      )}
      {sheet === 'compare' && (
        <Sheet title="Compare Daily runs" onClose={() => setSheet(null)}>
          <p class="so-dim">Paste the result code your brother texted you.</p>
          <textarea class="so-code" value={code} placeholder="DL-..." onInput={(e) => setCode((e.target as HTMLTextAreaElement).value)} />
          {code && !theirs && <div class="so-warn">That isn't a result code.</div>}
          {theirs &&
            (() => {
              const mine = lab.history.find((h) => h.daily === theirs.daily);
              const score = (won: boolean, floor: number, wins: number) => (won ? 1000 : 0) + floor * 100 + wins;
              const myScore = mine ? score(mine.won, mine.floor, mine.wins) : -1;
              const theirScore = score(theirs.won, theirs.floor, theirs.wins);
              return (
                <div class="so-compare">
                  <div class={myScore > theirScore ? 'win' : ''}>
                    <b>{p.name}</b>
                    <span>{mine ? `${mine.won ? 'Cleared' : `Floor ${mine.floor}`} · ${mine.wins} wins` : 'not played'}</span>
                  </div>
                  <div class={theirScore > myScore ? 'win' : ''}>
                    <b>{theirs.name}</b>
                    <span>
                      {theirs.won ? 'Cleared' : `Floor ${theirs.floor}`} · {theirs.wins} wins
                    </span>
                  </div>
                  <p class="so-center">{myScore === theirScore ? "It's a tie!" : myScore > theirScore ? `You win ${theirs.daily}!` : `${theirs.name} wins ${theirs.daily}.`}</p>
                </div>
              );
            })()}
        </Sheet>
      )}
    </div>
  );
}

function RunView(p: Ctx & { run: Run; setRun: (r: Run) => void; walkedOut?: boolean }) {
  const { run, setRun } = p;
  // The Daily ignores upgrades so both brothers play the same run.
  const up = run.daily ? [] : p.solo.labyrinth.upgrades;
  const [peek, setPeek] = useState<Stop | null>(null);
  const [showDeck, setShowDeck] = useState(false);
  const [relicInfo, setRelicInfo] = useState<string | null>(null);
  const [quit, setQuit] = useState(false);
  const [lost, setLost] = useState(!!p.walkedOut || (p.report?.kind === 'labyrinth' && p.report.outcome.result !== 'w' && !p.report.ended));
  const can = reachable(run);
  const floor = run.floors[run.floor];
  const act = (c: Choice) => setRun(choose(run, c, up));

  /** Steps onto a duel stop (or the one you're on) and opens the VS screen. */
  const startDuel = (at: Run = run) => {
    const before = run;
    if (at !== run) setRun(at);
    const d = duelFor(at, up);
    if (!d) return;
    const deck = deckOf(d.foe);
    const kind = stopById(at, at.inDuel!)?.kind;
    p.onDuel({
      me: { name: p.name, main: at.main, extra: at.extra, skill: at.skill, setup: d.me },
      cpu: { name: d.foe.name, main: deck.main, extra: deck.extra, skill: deck.skill, setup: d.cpu },
      first: 'coin',
      context: { kind: 'labyrinth', runId: at.id, stopId: at.inDuel! },
      level: labyrinthDifficulty(at.floor, kind === 'boss', at.curse),
      // The Daily deals every duel the same way for both brothers.
      seed: at.daily ? (at.seed + at.step * 7919) >>> 0 : undefined,
      vs: { label: `FLOOR ${at.floor + 1} · ${kind === 'boss' ? 'FLOOR BOSS' : kind === 'elite' ? 'ELITE DUEL' : 'DUEL'}`, mePortrait: ace(at.main), cpuPortrait: d.foe.portrait, cpuTitle: d.foe.title, line: d.foe.intro, notes: [...d.notes, ...(at.relics.length ? [`Relics: ${at.relics.join(', ')}`] : [])], goals: [] },
    }, at !== before ? () => setRun(before) : undefined);
  };

  const inDuel = run.inDuel ? stopById(run, run.inDuel) : null;
  const lastStop = run.at ? stopById(run, run.at) : null;
  const beatBy = lastStop?.foe ? duelistById(lastStop.foe) : undefined;
  const duelInfo = run.inDuel ? duelFor(run, up) : null;
  const pend = run.pending;

  return (
    <div class="screen so lab">
      <Top
        title={`Floor ${run.floor + 1} of 3${run.daily ? ' · Daily' : ''}`}
        sub={`${run.ownDeck ? 'Deck' : 'Starter'}: ${run.starter}${run.open ? ' (Anything goes)' : ''}${run.curse ? ` · Curse ${run.curse}` : ''}`}
        onBack={p.onExit}
        right={
          <div class="so-runstat">
            <Hearts n={run.hearts} max={run.maxHearts} />
            <span class="so-dp">{run.dp} DP</span>
          </div>
        }
      />
      <div class="so-body">
        <div class="so-relics">
          {run.relics.length === 0 && <span class="so-dim">No relics yet</span>}
          {run.relics.map((r) => (
            <button key={r} class={`so-relic ${relic(r)?.millennium ? 'mil' : ''}`} onClick={() => setRelicInfo(r)}>
              {relic(r)?.millennium ? <MilEye size={14} /> : '◆'}{' '}
              {r}
            </button>
          ))}
        </div>
        <div class="so-map">
          <svg class="so-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {floor.rows.flatMap((row, r) =>
              row.flatMap((st) =>
                st.next.map((id) => {
                  const to = stopById(run, id)!;
                  const R = floor.rows.length;
                  const y = (row: number) => ((R - 1 - row + 0.5) / R) * 100;
                  const x = mapX;
                  const walked = run.visited.includes(st.id) && run.visited.includes(id);
                  return <line key={st.id + id} class={walked ? 'walked' : ''} x1={x(st.col, row.length)} y1={y(r)} x2={x(to.col, floor.rows[to.row].length)} y2={y(to.row)} vector-effect="non-scaling-stroke" />;
                }),
              ),
            )}
          </svg>
          {floor.rows
            .slice()
            .reverse()
            .map((row, ri) => (
              <div key={ri} class="so-maprow">
                {row.map((st) => {
                  const live = can.some((x) => x.id === st.id);
                  const seen = run.visited.includes(st.id);
                  const here = run.at === st.id;
                  const foe = st.foe ? duelistById(st.foe) : null;
                  return (
                    <button key={st.id} style={{ left: `${mapX(st.col, row.length)}%` }} class={`so-stop k-${st.kind} ${live ? 'live' : ''} ${seen ? 'seen' : ''} ${here ? 'here' : ''}`} disabled={!live} onClick={() => (foe ? startDuel(enter(run, st.id, up)) : setPeek(st))}>
                      {foe ? (
                        <span class="so-stop-a">
                          <CardImg name={foe.portrait} />
                          <i>{STOP_ICON[st.kind]}</i>
                        </span>
                      ) : (
                        <span class="so-stop-i">{STOP_ICON[st.kind]}</span>
                      )}
                      <span class="so-stop-n">{foe ? foe.name : STOP_NAME[st.kind]}</span>
                    </button>
                  );
                })}
              </div>
            ))}
        </div>
        {inDuel && duelInfo && (
          <div class="so-next">
            <Portrait d={duelInfo.foe} size="s" />
            <div>
              <b>{duelInfo.foe.name}</b>
              <span>{STOP_NAME[inDuel.kind]}</span>
              {duelInfo.notes.map((n) => (
                <em key={n}>{n}</em>
              ))}
            </div>
            <Btn kind="gold" onClick={() => startDuel()}>
              Duel!
            </Btn>
          </div>
        )}
        <div class="so-row">
          <Btn onClick={() => setShowDeck(true)}>
            Run deck ({run.main.length}
            {run.extra.length ? `+${run.extra.length}` : ''})
          </Btn>
          <Btn kind="red" onClick={() => setQuit(true)}>
            Give up
          </Btn>
        </div>
        <p class="so-dim">Leaving a duel halfway counts as a loss. Your run is saved after every stop.</p>
      </div>

      {peek && (
        <Sheet title={STOP_NAME[peek.kind]} onClose={() => setPeek(null)}>
          {peek.foe ? (
            (() => {
              const f = duelistById(peek.foe)!;
              return (
                <div class="so-intro">
                  <Portrait d={f} size="m" />
                  <div>
                    <h3>{f.name}</h3>
                    <span class="so-dim">{f.title}</span>
                    <p class="so-quote">“{f.intro}”</p>
                  </div>
                </div>
              );
            })()
          ) : (
            <p>{peek.kind === 'shop' ? 'Spend Duel Points on cards, relics, a heart or removing a card.' : peek.kind === 'event' ? 'Someone wants to make a deal.' : peek.kind === 'rest' ? 'Get a heart back, or cut a card from your deck.' : 'A relic waits here.'}</p>
          )}
          <Btn
            kind="gold"
            onClick={() => {
              const r = enter(run, peek.id, up);
              setPeek(null);
              setRun(r);
            }}
          >
            Go
          </Btn>
        </Sheet>
      )}

      {pend?.kind === 'draft' && <DraftSheet run={run} act={act} />}
      {pend?.kind === 'shop' && (
        <Sheet title={`Card Shop · ${run.dp} DP`}>
          {pend.items.map((it, i) => (
            <div key={i} class={`so-shopitem ${it.sold ? 'sold' : ''}`}>
              {it.kind === 'card' && <CardImg name={it.name!} class="so-mini" />}
              <div>
                <b>{it.kind === 'card' ? it.name : it.kind === 'relic' ? `◆ ${it.name}` : it.kind === 'heal' ? 'A heart back' : 'Remove a card'}</b>
                <span>{it.kind === 'relic' ? relic(it.name!)?.text : it.kind === 'card' ? (card(it.name!)?.kind === 'monster' ? `ATK ${card(it.name!)?.atk} / DEF ${card(it.name!)?.def}` : card(it.name!)?.sub) : ''}</span>
              </div>
              <Btn kind="blue" disabled={it.sold || run.dp < it.price || (it.kind === 'heal' && run.hearts >= run.maxHearts) || (it.kind === 'remove' && run.main.length <= 20 && !run.extra.length)} onClick={() => act({ kind: 'buy', index: i })}>
                {it.sold ? 'Sold' : `${it.price}`}
              </Btn>
            </div>
          ))}
          <Btn kind="gold" onClick={() => act({ kind: 'leave' })}>
            Leave the shop
          </Btn>
        </Sheet>
      )}
      {pend?.kind === 'event' &&
        (() => {
          const ev = eventById(pend.event);
          return (
            <Sheet title={ev.title}>
              <div class="so-intro">
                <Portrait d={{ name: ev.who, portrait: ev.art }} size="m" />
                <div>
                  <h3>{ev.who}</h3>
                  <p class="so-quote">{ev.text}</p>
                </div>
              </div>
              {ev.choices.map((c, i) => (
                <Btn key={c.label} kind={i === 0 ? 'gold' : 'plain'} disabled={i === 0 && ((ev.id === 'ring' && run.hearts <= 1) || (ev.id === 'graveyard' && run.main.length <= 20) || (ev.id === 'shadi' && run.hearts <= 1) || (ev.id === 'rebecca' && run.main.length <= 20 && !run.extra.length))} onClick={() => act({ kind: 'event', option: i })}>
                  {c.label} · {c.note}
                </Btn>
              ))}
            </Sheet>
          );
        })()}
      {pend?.kind === 'rest' && (
        <Sheet title="Rest">
          <p>A quiet corner of the Labyrinth.</p>
          <Btn kind="gold" disabled={run.hearts >= run.maxHearts || run.curse >= 8} onClick={() => act({ kind: 'rest', option: 'heal' })}>
            Rest: a heart back
          </Btn>
          <Btn disabled={run.main.length <= 20 && !run.extra.length} onClick={() => act({ kind: 'rest', option: 'cut' })}>
            Train: cut a card from your deck
          </Btn>
          {(run.hearts >= run.maxHearts || run.curse >= 8) && run.main.length <= 20 && !run.extra.length && <Btn onClick={() => act({ kind: 'leave' })}>Move on</Btn>}
        </Sheet>
      )}
      {pend?.kind === 'remove' && <PickFromDeck title="Cut a card" note={run.main.length <= 20 ? 'Your Main Deck is at 20, the minimum.' : 'Tap a card to remove one copy.'} run={run} onPick={(n) => act({ kind: 'remove', card: n })} />}
      {pend?.kind === 'swap' && <PickFromDeck title={`Make room for ${pend.card}`} note="Your deck is full (30). Tap a card to swap out, or keep your deck as it is." run={run} onPick={(n) => act({ kind: 'swap', out: n })} />}
      {pend?.kind === 'treasure' && (
        <Sheet title="Treasure">
          <div class="so-clear">
            <div class="so-eye huge">{relic(pend.relic)?.millennium ? <MilEye size={84} /> : '◆'}</div>
            <h3>{pend.relic}</h3>
            <p>{relic(pend.relic)?.text}</p>
          </div>
          <Btn kind="gold" onClick={() => act({ kind: 'treasure' })}>
            Take it
          </Btn>
        </Sheet>
      )}

      {showDeck && (
        <Sheet title={`Run deck · ${run.main.length} cards`} onClose={() => setShowDeck(false)} wide>
          <p class="so-dim">Skill: {skillName(run.skill)}</p>
          <DeckListView main={run.main} extra={run.extra} />
        </Sheet>
      )}
      {relicInfo && (
        <Sheet title={relicInfo} onClose={() => setRelicInfo(null)}>
          <p>{relic(relicInfo)?.text}</p>
        </Sheet>
      )}
      {quit && (
        <Sheet title="Give up this run?" onClose={() => setQuit(false)}>
          <p>You keep the Soul Fragments earned so far.</p>
          <Btn kind="red" onClick={() => (setQuit(false), setRun({ ...run, over: 'lost', pending: undefined, inDuel: undefined }))}>
            Give up
          </Btn>
          <Btn onClick={() => setQuit(false)}>Keep going</Btn>
        </Sheet>
      )}
      {lost && !run.pending && (
        <Sheet>
          <ResultBanner result={p.report?.kind === 'labyrinth' && p.report.outcome.result === 'd' ? 'd' : 'l'} />
          {beatBy && (
            <div class="so-intro">
              <Portrait d={beatBy} size="s" />
              <p class="so-quote">“{beatBy.onWin}”</p>
            </div>
          )}
          <p class="so-center">
            You lost a heart. <Hearts n={run.hearts} max={run.maxHearts} />
          </p>
          {p.walkedOut && <p class="so-center so-dim">The app closed during your last duel, so it counts as a loss.</p>}
          {run.nextDuel && <p class="so-center so-dim">Still waiting for your next duel: {run.nextDuel.text}.</p>}
          {inDuel?.kind === 'boss' && <p class="so-center so-dim">The floor boss blocks the way. Try again when you're ready.</p>}
          <Btn kind="gold" onClick={() => (setLost(false), p.onReportSeen())}>
            Continue
          </Btn>
        </Sheet>
      )}
    </div>
  );
}

function DraftSheet({ run, act }: { run: Run; act: (c: Choice) => void }) {
  const pend = run.pending as Extract<Run['pending'], { kind: 'draft' }>;
  const [sel, setSel] = useState<string | null>(null);
  return (
    <Sheet>
      <ResultBanner result="w" />
      <p class="so-center">
        +{pend.dp} Duel Points{pend.heal ? ' · a heart back' : ''}{pend.chip ? ' · +1 Duel Chip' : ''}
      </p>
      {pend.relic && (
        <div class="so-reward">
          {relic(pend.relic)?.millennium ? <MilEye size={16} /> : '◆'} {pend.relic}: {relic(pend.relic)?.text}
        </div>
      )}
      <div class="so-group">Choose a card for your run deck</div>
      <CardRow names={pend.options} picked={sel} onPick={setSel} />
      {sel && (
        <div class="so-dim so-center">
          {card(sel)?.kind === 'monster' ? `Level ${card(sel)?.level} · ATK ${card(sel)?.atk} / DEF ${card(sel)?.def}` : `${card(sel)?.sub} ${card(sel)?.kind}`}
          <br />
          {card(sel)?.desc}
        </div>
      )}
      <div class="so-row">
        <Btn kind="gold" disabled={!sel} onClick={() => act({ kind: 'draft', pick: sel })}>
          Take it
        </Btn>
        <Btn onClick={() => act({ kind: 'draft', pick: null })}>Skip</Btn>
      </div>
    </Sheet>
  );
}

function PickFromDeck({ title, note, run, onPick }: { title: string; note: string; run: Run; onPick: (n: string | null) => void }) {
  const swap = run.pending?.kind === 'swap';
  // Making room swaps out a Main Deck card, so the Extra Deck isn't offered then.
  const names = [...new Set(swap ? run.main : [...run.main, ...run.extra])].sort((a, b) => (card(a)?.kind ?? '').localeCompare(card(b)?.kind ?? '') || a.localeCompare(b));
  const canCut = (n: string) => run.extra.includes(n) || run.main.length > 20 || run.pending?.kind === 'swap';
  return (
    <Sheet title={title} wide>
      <p class="so-dim">{note}</p>
      <div class="so-cards small">
        {names.map((n) => (
          <button key={n} class="so-card" disabled={!canCut(n)} onClick={() => onPick(n)}>
            <CardImg name={n} />
            <span>
              {n} ×{[...run.main, ...run.extra].filter((x) => x === n).length}
            </span>
          </button>
        ))}
      </div>
      <Btn onClick={() => onPick(null)}>{run.pending?.kind === 'swap' ? "Don't take the new card" : 'Cut nothing'}</Btn>
    </Sheet>
  );
}

function RunEnd(p: Ctx & { s: RunSummary; onDone: () => void }) {
  const { s } = p;
  const code = resultCode(s, p.name);
  return (
    <div class="screen so lab">
      <Top title="Duel Labyrinth" onBack={p.onDone} />
      <div class="so-body">
        <div class="so-clear">
          <span class="so-label">{s.won ? 'LABYRINTH CLEARED' : 'RUN OVER'}</span>
          <div class="so-eye huge">{s.won ? '♛' : '☠'}</div>
          <h3>{s.won ? 'You beat all three floors!' : `You reached floor ${s.floor}`}</h3>
          <p>
            {s.wins} wins with {s.starter}
            {s.curse ? ` at Curse ${s.curse}` : ''}.
          </p>
          {s.open ? <p class="so-dim">Anything goes deck: no Soul Fragments, chips or packs for this run.</p> : <p class="so-reward">+{s.fragments} Soul Fragments</p>}
          {s.won && !s.open && !s.daily && !s.pack?.length && <p class="so-dim">No pack this time: clears pay one for a new Curse level, then one a day.</p>}
          {s.pack && s.pack.length > 0 && (
            <>
              <div class="so-group">Clear prize: a booster pack</div>
              <CardRow names={s.pack} reveal own={(n) => ownedCopies(p.speed, n)} />
            </>
          )}
          {s.won && s.curse < 10 && <p>Curse {s.curse + 1} is now open.</p>}
        </div>
        {code && (
          <>
            <div class="so-group">Daily result code: text it to your brother</div>
            <textarea class="so-code" readOnly value={code} />
            <Btn kind="blue" onClick={() => void navigator.clipboard?.writeText(code).catch(() => {})}>
              Copy
            </Btn>
          </>
        )}
        <Btn kind="gold" onClick={p.onDone}>
          Continue
        </Btn>
      </div>
    </div>
  );
}

// Re-exported for tests that walk the screens.
export const SOLO_DEBUG = { EVENTS, allCampaignDuelists };

/** Every deck the solo modes can take: the road deck first, then all your decks (Anything goes too). */
export function soloDecks(speed: SpeedSave): SpeedDeck[] {
  const out: SpeedDeck[] = [];
  const seen = new Set<string>();
  for (const d of [...(speed.road ? [speed.road] : []), ...speed.decks]) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
  }
  return out;
}

/** What an Anything goes deck means in the solo modes, said the same way everywhere. */
export const ANY_GOES_NOTE = 'Anything goes deck: wins move you forward but pay no cards, chips or prizes.';
export const ANY_GOES_PICK_NOTE = 'Any deck can play, Anything goes decks too. Their wins move you forward but pay no cards, chips or prizes, so those wait for a win with a deck made from cards you own.';

/** The deck list in the solo screens' sheet style. */
export function SoloDeckPick({ title, decks, current, problemsOf, note, onPick, onClose }: { title: string; decks: SpeedDeck[]; current: SpeedDeck | null; problemsOf: (d: SpeedDeck) => string[]; note?: string; onPick: (d: SpeedDeck) => void; onClose: () => void }) {
  return (
    <Sheet title={title} onClose={onClose}>
      {decks.map((d) => {
        const bad = problemsOf(d);
        return (
          <button key={d.id} class={`lg-deck ${current?.id === d.id ? 'on' : ''}`} onClick={() => (playBlip(), onPick(d))}>
            <b>
              {current?.id === d.id ? '★ ' : ''}
              {d.name}
              {d.open ? ' · Anything goes' : ''}
            </b>
            <span class={bad.length ? 'so-bad' : 'so-good'}>{bad.length ? bad[0] : deckSummary(d)}</span>
          </button>
        );
      })}
      {note && <p class="so-dim">{note}</p>}
    </Sheet>
  );
}
