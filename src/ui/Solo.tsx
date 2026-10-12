// Speed Duel solo modes: The Millennium Road (story campaign), the Duel Labyrinth
// (roguelite runs) and Practice Duels. Master Duel-style screens over the shared duel.
import { useMemo, useState } from 'preact/hooks';
import { card } from '../eds/db';
import { loadProfiles, type Profile } from '../eds/save';
import { STARTERS, activeDeck, deckFromStarter, loadSpeedSave, speedDeckProblems, type SpeedDeck, type SpeedSave } from '../eds/speedSave';
import { CHAPTERS, DEALER_CONDITIONS, type CampaignNode, type Chapter } from '../eds/speedCampaign/roster';
import { allCampaignDuelists, chapterCleared, chapterOpen, currentChapter, deckOf, findNode, nodeOpen, roadDeckProblems, starCount, startRoad, takePick } from '../eds/speedCampaign/campaign';
import { deckCode, readDeckCode } from '../eds/speedCampaign/deckCode';
import { CURSES, EVENTS, UPGRADES, choose, dailySeed, dailyStarter, duelFor, duelistById, enter, eventById, reachable, readResultCode, resultCode, stopById, todayString, newRun, type Choice, type Run, type RunSummary, type Stop } from '../eds/speedCampaign/labyrinth';
import { STAR_TEXT } from '../eds/speedCampaign/outcome';
import { relic } from '../eds/speedCampaign/relics';
import { loadSolo, writeSolo, type SoloSave } from '../eds/speedCampaign/save';
import { endRun, type SoloReport } from '../eds/speedCampaign/settle';
import type { CpuDuelSpec, CpuDuelist } from '../eds/speedCampaign/types';
import { randomSeed } from '../eds/rng';
import { CardImg, CardInfoPanel } from './CardImg';
import { SpeedDeckEdit, speedOpponents } from './Speed';
import { playBlip } from './sound';
import './solo.css';

export type SoloMode = 'campaign' | 'labyrinth' | 'practice';

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
  onDuel: (spec: CpuDuelSpec) => void;
  onMode: (m: SoloMode) => void;
  onExit: () => void;
}

export function Solo(p: Props) {
  const [solo, setSoloState] = useState<SoloSave>(() => loadSolo(p.profile.id));
  const setSolo = (s: SoloSave) => {
    setSoloState(s);
    writeSolo(p.profile.id, s);
  };
  const ctx = { ...p, solo, setSolo };
  if (p.mode === 'practice') return <Practice {...ctx} />;
  if (p.mode === 'labyrinth') return <Labyrinth {...ctx} />;
  return <Road {...ctx} />;
}

type Ctx = Props & { solo: SoloSave; setSolo: (s: SoloSave) => void };

// ---------- small pieces ----------
function Top({ title, sub, onBack, right }: { title: string; sub?: string; onBack: () => void; right?: preact.ComponentChildren }) {
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

function Sheet({ title, onClose, children, wide }: { title?: string; onClose?: () => void; children: preact.ComponentChildren; wide?: boolean }) {
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

function Btn({ children, onClick, kind = 'plain', disabled }: { children: preact.ComponentChildren; onClick?: () => void; kind?: 'plain' | 'gold' | 'blue' | 'red'; disabled?: boolean }) {
  return (
    <button class={`so-btn ${kind}`} disabled={disabled} onClick={() => (playBlip(), onClick?.())}>
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
const skillName = (n: string | null | undefined) => (n ? n.replace(/ \(Skill Card\)$/, '') : 'no Skill');

const Stars = ({ s }: { s?: boolean[] }) => (
  <span class="so-stars">
    {[0, 1, 2].map((i) => (
      <span key={i} class={s?.[i] ? 'on' : ''}>
        ★
      </span>
    ))}
  </span>
);

function Portrait({ d, size = 'm' }: { d: Pick<CpuDuelist, 'portrait' | 'name'>; size?: 's' | 'm' | 'l' }) {
  return (
    <div class={`so-portrait ${size}`}>
      <CardImg name={d.portrait} />
    </div>
  );
}

function CardRow({ names, onPick, picked }: { names: string[]; onPick?: (n: string) => void; picked?: string | null }) {
  const [info, setInfo] = useState<string | null>(null);
  return (
    <>
      <div class="so-cards">
        {names.map((n, i) => (
          <button key={`${n}${i}`} class={`so-card ${picked === n ? 'on' : ''}`} onClick={() => (onPick ? onPick(n) : setInfo(n))}>
            <CardImg name={n} />
            <span>{n}</span>
          </button>
        ))}
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

function ResultBanner({ result }: { result: 'w' | 'l' | 'd' }) {
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
}

function Practice(p: Ctx) {
  const { solo, setSolo, speed } = p;
  const prefs = solo.practice;
  const setPrefs = (x: Partial<SoloSave['practice']>) => setSolo({ ...solo, practice: { ...prefs, ...x } });
  const [deckId, setDeckId] = useState<string | null>(activeDeck(speed)?.id ?? null);
  const [pickFoe, setPickFoe] = useState(false);
  const [share, setShare] = useState(false);
  const [paste, setPaste] = useState(false);
  const [pasteText, setPasteText] = useState('');
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
      if (d) out.push({ id: `code:${c.code}`, name: c.name, title: `${d.name} (deck code)`, portrait: d.main.find((n) => card(n)?.kind === 'monster') ?? d.main[0], main: d.main, extra: d.extra, skill: d.skill, group: 'Brothers and friends' });
    }
    if (myDeck) out.push({ id: 'mirror', name: 'Mirror Match', title: `a copy of ${myDeck.name}`, portrait: myDeck.main.find((n) => card(n)?.kind === 'monster') ?? myDeck.main[0], main: myDeck.main, extra: myDeck.extra, skill: myDeck.skill, group: 'Brothers and friends' });
    return out;
  }, [solo, myDeck?.id, prefs.codes.length]);
  const foe = foes.find((f) => f.id === prefs.oppId) ?? foes[0];
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
    });
  };

  const rep = p.report?.kind === 'practice' ? p.report : null;
  const groups = [...new Set(foes.map((f) => f.group))];
  const LPS = [2000, 4000, 6000, 8000];
  const myCode = myDeck ? deckCode(myDeck) : '';

  return (
    <div class="screen so">
      <Top title="Practice Duel" sub="nothing here counts for your record, the Shadow Realm or card levels" onBack={p.onExit} />
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
        <Btn kind="gold" disabled={!foe || problems.length > 0} onClick={start}>
          Duel!
        </Btn>
        <div class="so-row">
          <Btn onClick={() => setShare(true)} disabled={!myDeck}>
            Share my deck code
          </Btn>
          <Btn onClick={() => setPaste(true)}>Add a deck code</Btn>
        </div>
      </div>

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
          <p class="so-dim">Paste a deck code your brother sent you.</p>
          <textarea class="so-code" value={pasteText} placeholder="SD1...." onInput={(e) => setPasteText((e.target as HTMLTextAreaElement).value)} />
          {pasteText && !readDeckCode(pasteText) && <div class="so-warn">That doesn't look like a deck code.</div>}
          <Btn
            kind="gold"
            disabled={!readDeckCode(pasteText)}
            onClick={() => {
              const d = readDeckCode(pasteText)!;
              const code = pasteText.trim().replace(/\s+/g, '');
              const codes = [{ name: d.name, code }, ...prefs.codes.filter((c) => c.code !== code)].slice(0, 8);
              setPrefs({ codes, oppId: `code:${code}` });
              setPasteText('');
              setPaste(false);
            }}
          >
            Add
          </Btn>
        </Sheet>
      )}
      {rep && (
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
  /** the result screens after a duel: 0 result, then one per star pick, then the chapter clear */
  const [stage, setStage] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);

  if (!c.starter) return <RoadStart {...p} />;
  if (editing && c.deck)
    return (
      <SpeedDeckEdit
        deck={c.deck}
        collection={speed.collection ?? {}}
        onChange={(d) => setSolo({ ...solo, campaign: { ...c, deck: d } })}
        onBack={() => setEditing(false)}
      />
    );

  const ch = CHAPTERS.find((x) => x.id === chId) ?? CHAPTERS[0];
  const deck = c.deck;
  const problems = deck ? roadDeckProblems(speed, deck) : ['No road deck'];
  const owned = Object.values(speed.collection ?? {}).reduce((a, b) => a + b, 0);
  const allIds = CHAPTERS.flatMap((x) => x.nodes.map((n) => n.id));

  const duel = (node: CampaignNode) => {
    // The Masked Dealer deals a different Duel Condition every duel.
    const n = node.condition === DEALER_CONDITIONS[0] ? { ...node, condition: DEALER_CONDITIONS[Math.floor(Math.random() * DEALER_CONDITIONS.length)] } : node;
    const d = deckOf(n.duelist);
    const mine = n.story ? { main: n.story.main.flatMap((e) => (/\*\d$/.test(e) ? Array<string>(Number(e.slice(-1))).fill(e.slice(0, -2)) : [e])), extra: n.story.extra, skill: n.story.skill, name: n.story.as } : deck ? { main: deck.main, extra: deck.extra, skill: deck.skill, name: p.name } : null;
    if (!mine) return;
    p.onDuel({
      me: { name: mine.name, main: mine.main, extra: mine.extra, skill: mine.skill, setup: n.condition?.player },
      cpu: { name: n.duelist.name, main: d.main, extra: d.extra, skill: d.skill, setup: n.condition?.cpu },
      first: n.condition?.cpuFirst ? 'cpu' : 'coin',
      context: { kind: 'campaign', nodeId: n.id },
    });
  };

  const rep = p.report?.kind === 'campaign' ? p.report : null;
  const repNode = rep ? findNode(rep.nodeId) : null;
  const pickList = rep?.settled.picks ?? [];
  const clearedCh = rep?.outcome.result === 'w' ? rep.settled.cleared : null;
  const advance = (from: number) => {
    const next = from + 1;
    if (next >= 1 && next <= pickList.length) return setStage(next);
    if (clearedCh && next <= pickList.length + 1) return setStage(pickList.length + 1);
    setStage(0);
    if (clearedCh) setSolo({ ...solo, campaign: { ...solo.campaign, cleared: undefined } });
    p.onReportSeen();
  };

  return (
    <div class="screen so road">
      <Top
        title="The Millennium Road"
        sub={`${starCount(solo, allIds)}/${allIds.length * 3} stars · ${c.items.length}/7 Millennium Items`}
        onBack={p.onExit}
        right={
          <button class="so-chip" onClick={() => setView(view === 'map' ? 'trophies' : 'map')}>
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
          <div class="so-group">Titles</div>
          <p>{c.titles.length ? c.titles.join(' · ') : 'None yet. Bosses give you titles.'}</p>
          <div class="so-group">Collection</div>
          <p>
            {owned} cards owned. Every win on the road adds cards from your opponent's deck. Your road deck can only use cards you own.
          </p>
          <p class="so-dim">Millennium Items you win here also show up as relics in the Duel Labyrinth.</p>
        </div>
      ) : (
        <div class="so-body">
          <div class="so-chapters">
            {CHAPTERS.map((x) => {
              const open = chapterOpen(solo, x);
              return (
                <button key={x.id} class={`so-chap ${x.id === ch.id ? 'on' : ''} ${chapterCleared(solo, x) ? 'done' : ''}`} disabled={!open} onClick={() => setChId(x.id)}>
                  {open ? (x.postgame ? '★' : x.n) : '🔒'}
                </button>
              );
            })}
          </div>
          <div class="so-chapter">
            <div class="so-chapter-h">
              <span>{ch.postgame ? 'Post-game' : `Chapter ${ch.n}`}</span>
              <b>{ch.title}</b>
              <Stars s={[starCount(solo, ch.nodes.map((n) => n.id)) >= ch.nodes.length, starCount(solo, ch.nodes.map((n) => n.id)) >= ch.nodes.length * 2, starCount(solo, ch.nodes.map((n) => n.id)) >= ch.nodes.length * 3]} />
            </div>
            <p class="so-blurb">{ch.blurb}</p>
          </div>
          <div class="so-path">
            {ch.nodes.map((n, i) => {
              const open = nodeOpen(solo, ch, i);
              const wins = c.wins[n.id] ?? 0;
              return (
                <button key={n.id} class={`so-node ${n.boss ? 'boss' : ''} ${open ? '' : 'locked'} ${wins ? 'won' : ''}`} disabled={!open} onClick={() => setSel(n)}>
                  <Portrait d={n.duelist} size={n.boss ? 'm' : 's'} />
                  <div class="so-node-t">
                    <b>{open ? n.duelist.name : '???'}</b>
                    <span>{open ? n.duelist.title : 'Win the duel before this one'}</span>
                    {n.story && open && <em>Story duel: you play as {n.story.as}</em>}
                    {n.boss && open && <em>Boss · {ch.item}</em>}
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
              </div>
            </div>
          </div>
          <div class="so-deckbar">
            <div>
              <b>Road deck</b>
              <span class={problems.length ? 'so-bad' : 'so-good'}>{problems.length ? problems[0] : `${deck!.main.length} cards · ${skillName(deck!.skill)}`}</span>
            </div>
            <Btn kind="blue" onClick={() => setEditing(true)}>
              Edit
            </Btn>
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
          {sel.story && <div class="so-cond blue">You duel as {sel.story.as}, with their deck. Your own road deck sits this one out.</div>}
          <div class="so-goals">
            {STAR_TEXT(sel.goal).map((t, i) => (
              <div key={t} class={c.stars[sel.id]?.[i] ? 'on' : ''}>
                <span>★</span> {t}
              </div>
            ))}
          </div>
          <div class="so-dim">Their deck: {deckOf(sel.duelist).main.length} cards{sel.duelist.skill ? ` · Skill: ${skillName(sel.duelist.skill)}` : ''}</div>
          {!sel.story && problems.length > 0 && <div class="so-warn">Fix your road deck first: {problems[0]}</div>}
          <Btn kind="gold" disabled={!sel.story && problems.length > 0} onClick={() => (setSel(null), duel(sel))}>
            Duel!
          </Btn>
        </Sheet>
      )}

      {rival && <RivalSheet {...p} deck={deck} problems={problems} onClose={() => setRival(false)} />}

      {rep && repNode && stage === 0 && (
        <Sheet>
          <ResultBanner result={rep.outcome.result} />
          <div class="so-intro">
            <Portrait d={repNode.node.duelist} size="s" />
            <p class="so-quote">“{rep.outcome.result === 'w' ? repNode.node.duelist.onLose : repNode.node.duelist.onWin}”</p>
          </div>
          {rep.outcome.result === 'w' ? (
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
                  <CardRow names={rep.settled.cards} />
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
          <Btn kind="gold" onClick={() => advance(0)}>
            Continue
          </Btn>
        </Sheet>
      )}
      {rep && stage >= 1 && stage <= pickList.length && (
        <Sheet>
          <div class="so-group">New star! Choose one card to keep</div>
          <CardRow names={pickList[stage - 1]} picked={picked} onPick={setPicked} />
          <Btn
            kind="gold"
            disabled={!picked}
            onClick={() => {
              p.onSpeed(takePick(speed, picked!));
              setPicked(null);
              advance(stage);
            }}
          >
            Take it
          </Btn>
        </Sheet>
      )}
      {rep && clearedCh && stage === pickList.length + 1 && <ChapterClear ch={clearedCh} onDone={() => advance(stage)} />}
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
        <h3>{ch.item}</h3>
        <p>{relic(ch.item)?.text ?? ch.itemText}</p>
        <p class="so-dim">It's also a relic you can find in the Duel Labyrinth now.</p>
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
            <DeckListView main={preview.main} extra={preview.extra} />
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
  const setRun = (r: Run) => {
    if (r.over) {
      const done = endRun(solo, r);
      setSolo(done.solo);
      setEnded(done.summary);
      return;
    }
    setSolo({ ...solo, labyrinth: { ...lab, run: r } });
  };
  if (ended) return <RunEnd {...p} s={ended} onDone={() => (setEnded(null), p.onReportSeen())} />;
  if (!run) return <LabyrinthStart {...p} />;
  return <RunView {...p} run={run} setRun={setRun} />;
}

function LabyrinthStart(p: Ctx) {
  const { solo, setSolo } = p;
  const lab = solo.labyrinth;
  const [sheet, setSheet] = useState<'new' | 'daily' | 'upgrades' | 'history' | 'compare' | null>(null);
  const [starter, setStarter] = useState(STARTERS[0].character);
  const [curse, setCurse] = useState(0);
  const [code, setCode] = useState('');
  const today = todayString();
  const doneToday = lab.history.find((h) => h.daily === today);
  const begin = (o: { starter: string; seed: number; daily?: string; curse: number }) => {
    const run = newRun({ ...o, upgrades: lab.upgrades });
    setSolo({ ...solo, labyrinth: { ...lab, run } });
  };
  const theirs = readResultCode(code);
  return (
    <div class="screen so lab">
      <Top title="Duel Labyrinth" sub={`${lab.fragments} Soul Fragments`} onBack={p.onExit} />
      <div class="so-body">
        <div class="so-prologue">
          <span class="so-label">THE LABYRINTH</span>
          <p>Three floors of duels, shops, wagers and treasure. Start from a Starter Deck, pick a new card after every win and hunt Millennium relics. You have 3 hearts: lose a duel, lose a heart.</p>
        </div>
        <Btn kind="gold" onClick={() => setSheet('new')}>
          New run
        </Btn>
        <Btn kind="blue" onClick={() => setSheet('daily')}>
          Daily Labyrinth · {today}
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
              <button key={s.character} class={`so-chip ${starter === s.character ? 'on' : ''}`} onClick={() => setStarter(s.character)}>
                {s.character}
              </button>
            ))}
          </div>
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
          <Btn kind="gold" onClick={() => begin({ starter, seed: randomSeed(), curse })}>
            Enter the Labyrinth
          </Btn>
        </Sheet>
      )}
      {sheet === 'daily' && (
        <Sheet title={`Daily Labyrinth · ${today}`} onClose={() => setSheet(null)}>
          <p>Everyone gets the same map, the same Starter Deck ({dailyStarter(today)}) and the same cards today. Play it, then text your result code to your brother.</p>
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
                </b>
                <span>
                  {h.daily ? `Daily ${h.daily} · ` : ''}
                  {h.wins} wins{h.curse ? ` · Curse ${h.curse}` : ''} · +{h.fragments} fragments
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

function RunView(p: Ctx & { run: Run; setRun: (r: Run) => void }) {
  const { run, setRun } = p;
  const up = p.solo.labyrinth.upgrades;
  const [peek, setPeek] = useState<Stop | null>(null);
  const [showDeck, setShowDeck] = useState(false);
  const [relicInfo, setRelicInfo] = useState<string | null>(null);
  const [quit, setQuit] = useState(false);
  const [lost, setLost] = useState(p.report?.kind === 'labyrinth' && p.report.outcome.result !== 'w' && !p.report.ended);
  const can = reachable(run);
  const floor = run.floors[run.floor];
  const act = (c: Choice) => setRun(choose(run, c, up));

  const startDuel = () => {
    const d = duelFor(run, up);
    if (!d) return;
    const deck = deckOf(d.foe);
    p.onDuel({
      me: { name: p.name, main: run.main, extra: run.extra, skill: run.skill, setup: d.me },
      cpu: { name: d.foe.name, main: deck.main, extra: deck.extra, skill: deck.skill, setup: d.cpu },
      first: 'coin',
      context: { kind: 'labyrinth', runId: run.id, stopId: run.inDuel! },
    });
  };

  const inDuel = run.inDuel ? stopById(run, run.inDuel) : null;
  const duelInfo = run.inDuel ? duelFor(run, up) : null;
  const pend = run.pending;

  return (
    <div class="screen so lab">
      <Top
        title={`Floor ${run.floor + 1} of 3${run.daily ? ' · Daily' : ''}`}
        sub={`${run.starter}${run.curse ? ` · Curse ${run.curse}` : ''}`}
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
                  const x = (col: number, width: number) => ((col + 1) / (width + 1)) * 100;
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
                    <button key={st.id} style={{ left: `${((st.col + 1) / (row.length + 1)) * 100}%` }} class={`so-stop k-${st.kind} ${live ? 'live' : ''} ${seen ? 'seen' : ''} ${here ? 'here' : ''}`} disabled={!live} onClick={() => setPeek(st)}>
                      <span class="so-stop-i">{STOP_ICON[st.kind]}</span>
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
            <Btn kind="gold" onClick={startDuel}>
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
              <Btn kind="blue" disabled={it.sold || run.dp < it.price || (it.kind === 'heal' && run.hearts >= run.maxHearts) || (it.kind === 'remove' && run.main.length <= 20)} onClick={() => act({ kind: 'buy', index: i })}>
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
                <Btn key={c.label} kind={i === 0 ? 'gold' : 'plain'} disabled={ev.id === 'ring' && i === 0 && run.hearts <= 1} onClick={() => act({ kind: 'event', option: i })}>
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
          <Btn disabled={run.main.length <= 20} onClick={() => act({ kind: 'rest', option: 'cut' })}>
            Train: cut a card from your deck
          </Btn>
          {run.hearts >= run.maxHearts && run.main.length <= 20 && <Btn onClick={() => act({ kind: 'rest', option: 'cut' })}>Move on</Btn>}
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
          <ResultBanner result="l" />
          <p class="so-center">
            You lost a heart. <Hearts n={run.hearts} max={run.maxHearts} />
          </p>
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
        +{pend.dp} Duel Points{pend.heal ? ' · a heart back' : ''}
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
          {card(sel)?.desc.slice(0, 160)}
          {(card(sel)?.desc.length ?? 0) > 160 ? '…' : ''}
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
  const names = [...new Set([...run.main, ...run.extra])].sort((a, b) => (card(a)?.kind ?? '').localeCompare(card(b)?.kind ?? '') || a.localeCompare(b));
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
          <p class="so-reward">+{s.fragments} Soul Fragments</p>
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
