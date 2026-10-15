// Speed Duel: the second game. Its own menu, decks (Speed Duel cards only), Skills,
// computer opponents and record, sharing profiles and the duel screen with EDS.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { card, skillCards, speedCards } from '../eds/db';
import { loadSave, type ControlStyle, type Profile } from '../eds/save';
import { Rankings } from './Rankings';
import { SpeedHome, rememberedTab, type HomeTab } from './SpeedHome';
import { getSkill } from '../eds/skills';
import {
  COPIES,
  EXTRA_MAX,
  LIMITED_LIST_NAME,
  MAIN_MAX,
  MAIN_MIN,
  MAX_DECKS,
  STARTERS,
  activeDeck,
  deckFromStarter,
  isExtraCard,
  limitStatus,
  newDeckId,
  speedDeckProblems,
  starterSkill,
  unplayableReason,
  type SpeedDeck,
  type SpeedSave,
  type Starter,
} from '../eds/speedSave';
import { CardImg, CardInfoPanel } from './CardImg';
import { Menu, Overlay, Win } from './Window';
import { playBlip } from './sound';
import { ShadowRealmScreen } from '../art/ShadowRealmScreen';
import { ArtLab } from '../art/ArtLab';
import { sealedCards } from '../art/shadow';
import { CardLevels, levelHeadline } from '../level/CardLevels';
import { cardLevels } from '../level/leveling';
import { showProfileLevels } from '../level/view';
import { CardShop } from '../collection/Shop';
import { RequestsScreen, StampsScreen } from '../collection/Earn';
import { boardOf } from '../collection/requests';
import { bestCrown, collectionProblems, ownedOnly, withStarter } from '../collection/economy';
import { preloadArt3d } from '../art/preload';
import { online } from '../online/controller';
import { DIFFICULTIES, DIFFICULTY_LABEL, DIFFICULTY_NOTE, saveDifficulty, savedDifficulty, type Difficulty } from '../eds/difficulty';

/** Speed Duel products, oldest first (codes as in public/cards/speed.json `sets`). */
const SPEED_SETS: [string, string][] = [
  ['SS01', 'Destiny Masters'],
  ['SS02', 'Duelists of Tomorrow'],
  ['SBLS', 'Arena of Lost Souls'],
  ['STP1', 'Tournament Pack 1'],
  ['SBAD', 'Attack from the Deep'],
  ['SS03', 'Ultimate Predators'],
  ['SBSC', 'Scars of Battle'],
  ['STP2', 'Tournament Pack 2'],
  ['SBTK', 'Trials of the Kingdom'],
  ['SS04', 'Match of the Millennium'],
  ['SS05', 'Twisted Nightmares'],
  ['SBCB', 'Battle City Box'],
  ['SGX1', 'GX: Duel Academy Box'],
  ['STP3', 'Tournament Pack 3'],
  ['STP4', 'Tournament Pack 4'],
  ['SGX2', 'GX: Midterm Paradox'],
  ['STP5', 'Tournament Pack 5'],
  ['SGX3', 'GX: Duelists of Shadows'],
  ['SBC1', 'Streets of Battle City'],
  ['STP6', 'Tournament Pack 6'],
];

export type SpeedLinkChoice = { mode: 'host' } | { mode: 'join'; code: string } | { mode: 'hotseat' };

/** A computer opponent: a character with their Speed Duel deck and Skill. */
export interface SpeedOpponent {
  name: string;
  title: string;
  main: string[];
  extra: string[];
  skill: string | null;
  /** how sharp the computer plays */
  level?: Difficulty;
}

export function speedOpponents(): SpeedOpponent[] {
  return STARTERS.map((s) => {
    const d = deckFromStarter(s);
    return { name: s.character, title: s.title, main: d.main, extra: d.extra, skill: d.skill };
  });
}

/** Android back inside the Speed Duel menu: steps back to the hub before leaving it (see App). */
let hubBack: (() => boolean) | null = null;
export function speedHubBack(): boolean {
  return hubBack ? hubBack() : false;
}

type Sub = 'menu' | 'decks' | 'edit' | 'cpu' | 'record' | 'rankings' | 'link' | 'shadow' | 'art' | 'levels' | 'shop' | 'requests' | 'stamps';

export function SpeedHub({
  controls,
  onControls,
  onSolo,
  onTag,
  profile,
  save,
  onSave,
  onExit,
  onCpu,
  onLink,
}: {
  /** this profile's Speed Duel control style (EDS keeps its own) */
  controls: ControlStyle;
  onControls: () => void;
  /** opens a solo mode: the Millennium Road campaign, the Duel Labyrinth or Practice */
  onSolo: (mode: 'campaign' | 'labyrinth' | 'practice' | 'legends') => void;
  /** 2v2 Tag Duels and the Tag Road */
  onTag?: () => void;
  profile: Profile;
  save: SpeedSave;
  onSave: (s: SpeedSave) => void;
  onExit: () => void;
  onCpu: (o: SpeedOpponent) => void;
  onLink: (c: SpeedLinkChoice) => void;
}) {
  const [sub, setSub] = useState<Sub>('menu');
  const [tab, setTab] = useState<HomeTab>(rememberedTab);
  const [editing, setEditing] = useState<string | null>(null);
  // the duel's 3D engine downloads while the player is still here
  useEffect(() => preloadArt3d(), []);
  const deck = activeDeck(save);
  const problems = deck ? [...speedDeckProblems(deck), ...collectionProblems(save, deck)] : ['Build a deck first'];
  // Card pictures on these screens show this profile's card rarities.
  showProfileLevels(cardLevels(save));
  useEffect(() => () => showProfileLevels(null), []);
  useEffect(() => {
    hubBack = () => {
      if (save.decks.length === 0) return false;
      if (sub === 'menu') {
        if (tab === 'duel') return false;
        setTab('duel');
        return true;
      }
      setSub(sub === 'edit' ? 'decks' : 'menu');
      return true;
    };
    return () => {
      hubBack = null;
    };
  });

  if (save.decks.length === 0) return <StarterPick onPick={(d) => onSave({ ...withStarter(save, d), decks: [d], active: d.id })} onExit={onExit} />;

  if (sub === 'decks') return <DeckList save={save} onSave={onSave} onEdit={(id) => (setEditing(id), setSub('edit'))} onBack={() => setSub('menu')} />;
  if (sub === 'edit' && editing) {
    const d = save.decks.find((x) => x.id === editing);
    if (d) return <SpeedDeckEdit deck={d} collection={d.open ? undefined : (save.collection ?? {})} onChange={(nd) => onSave({ ...save, decks: save.decks.map((x) => (x.id === nd.id ? nd : x)) })} onBack={() => setSub('decks')} />;
  }
  if (sub === 'cpu') return <CpuPick save={save} problems={problems} onPick={onCpu} onBack={() => setSub('menu')} />;
  if (sub === 'shop') return <CardShop save={save} onSave={onSave} onBack={() => setSub('menu')} />;
  if (sub === 'requests') return <RequestsScreen save={save} onSave={onSave} onBack={() => setSub('menu')} />;
  if (sub === 'stamps') return <StampsScreen save={save} onSave={onSave} onBack={() => setSub('menu')} />;
  if (sub === 'record') return <SpeedRecord save={save} onBack={() => setSub('menu')} />;
  if (sub === 'rankings') return <Rankings profile={profile} speed={save} eds={loadSave(profile.id)} onBack={() => setSub('menu')} />;
  if (sub === 'art') return <ArtLab onBack={() => setSub('menu')} />;
  if (sub === 'shadow') return <ShadowRealmScreen save={save} onSave={onSave} onBack={() => setSub('menu')} />;
  if (sub === 'levels') return <CardLevels save={save} deckNames={[...new Set(save.decks.flatMap((d) => [...d.main, ...d.extra]))]} onBack={() => setSub('menu')} />;
  const headline = levelHeadline(save);
  const sealed = sealedCards(save);
  const crown = bestCrown(save);
  if (sub === 'link') return <SpeedLink problems={problems} onPick={onLink} onBack={() => setSub('menu')} />;

  return (
    <SpeedHome
      tab={tab}
      onTab={setTab}
      profile={profile}
      save={save}
      deck={deck}
      problems={problems}
      sealed={sealed}
      headline={headline}
      crown={crown}
      requestsNote={requestsNote(save)}
      controls={controls}
      onControls={onControls}
      onSolo={onSolo}
      onTag={onTag}
      onExit={onExit}
      go={setSub}
      cpus={speedOpponents().map((o) => (o.name === 'Téa Gardner' ? 'Tea Gardner' : o.name))}
    />
  );
}

function requestsNote(save: SpeedSave): string {
  const b = boardOf(save);
  if (!b) return 'back once the clock catches up';
  const done = b.list.filter((r) => r.done).length;
  return done === b.list.length ? 'all done today ✓ new ones tomorrow' : `${done}/${b.list.length} done today · each pays a card`;
}

function StarterPick({ onPick, onExit }: { onPick: (d: SpeedDeck) => void; onExit: () => void }) {
  const [sel, setSel] = useState<Starter | null>(null);
  const preview = sel ? deckFromStarter(sel) : null;
  return (
    <div class="screen">
      <Win title="Pick your first Speed Duel deck" onClose={onExit}>
        <p>Each one is a real Speed Duel Starter Deck with its Skill. Its cards become yours. Win packs and Duel Chips to grow your collection, plus 3 welcome packs to start.</p>
        <Menu items={STARTERS.map((s) => ({ label: s.character, note: s.title.replace(/^.*\(|\)$/g, ''), selected: sel === s, onPick: () => (playBlip(), setSel(s)) }))} />
      </Win>
      {sel && preview && (
        <Win title={`${sel.character} · ${preview.main.length} cards`}>
          {preview.skill && <p>Skill: {preview.skill}</p>}
          <div class="grid small">
            {[...preview.main, ...preview.extra].map((n, i) => (
              <div key={i} class="gcard">
                <CardImg name={n} />
              </div>
            ))}
          </div>
          <Menu items={[{ label: `Take ${sel.character}'s deck`, onPick: () => onPick(preview) }]} />
        </Win>
      )}
    </div>
  );
}

function DeckList({ save, onSave, onEdit, onBack }: { save: SpeedSave; onSave: (s: SpeedSave) => void; onEdit: (id: string) => void; onBack: () => void }) {
  const [sel, setSel] = useState<SpeedDeck | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const add = (d: SpeedDeck) => {
    onSave({ ...save, decks: [...save.decks, d] });
    setAdding(false);
    onEdit(d.id);
  };
  const full = save.decks.length >= MAX_DECKS;
  return (
    <div class="screen">
      <Win title="Speed Duel Decks" onClose={onBack}>
        <Menu
          items={[
            ...save.decks.map((d) => {
              const bad = [...speedDeckProblems(d), ...collectionProblems(save, d)];
              return { label: `${d.id === activeDeck(save)?.id ? '★ ' : ''}${d.name}${d.open ? ' · Anything goes' : ''}`, note: bad.length ? `not ready: ${bad[0]}` : `${d.main.length}+${d.extra.length} · ${d.skill ?? 'no Skill'}`, selected: sel?.id === d.id, onPick: () => (setSel(d), setConfirmDel(false)) };
            }),
            { label: 'New deck', disabled: full, note: full ? `${MAX_DECKS} decks max` : undefined, onPick: () => setAdding(true) },
          ]}
        />
        <p class="hint">★ is the deck you duel with.</p>
      </Win>
      {sel && (
        <Overlay onClose={() => setSel(null)}>
          <Win title={sel.name} onClose={() => setSel(null)}>
            {confirmDel ? (
              <Menu
                items={[
                  { label: 'Keep it', onPick: () => setConfirmDel(false) },
                  {
                    label: `Delete ${sel.name}`,
                    onPick: () => {
                      const decks = save.decks.filter((d) => d.id !== sel.id);
                      onSave({ ...save, decks, active: save.active === sel.id ? (decks[0]?.id ?? null) : save.active });
                      setSel(null);
                    },
                  },
                ]}
              />
            ) : (
              <Menu
                items={[
                  { label: 'Duel with this deck', disabled: activeDeck(save)?.id === sel.id, onPick: () => (onSave({ ...save, active: sel.id }), setSel(null)) },
                  { label: 'Edit', onPick: () => onEdit(sel.id) },
                  { label: 'Copy', disabled: full, onPick: () => (onSave({ ...save, decks: [...save.decks, { ...sel, id: newDeckId(), name: `${sel.name} copy`.slice(0, 20) }] }), setSel(null)) },
                  { label: 'Delete', disabled: save.decks.length <= 1, onPick: () => setConfirmDel(true) },
                ]}
              />
            )}
          </Win>
        </Overlay>
      )}
      {adding && (
        <Overlay onClose={() => setAdding(false)}>
          <Win title="New deck" onClose={() => setAdding(false)}>
            <Menu
              items={[
                { label: 'Empty deck', note: 'from the cards you own', onPick: () => add({ id: newDeckId(), name: `Deck ${save.decks.length + 1}`, main: [], extra: [], skill: null }) },
                { label: 'Anything goes deck', note: "every card; earns nothing and can't be bet", onPick: () => add({ id: newDeckId(), name: `Anything ${save.decks.length + 1}`, main: [], extra: [], skill: null, open: true }) },
                ...STARTERS.map((s) => ({ label: `Start from ${s.character}`, note: 'the copies you own', onPick: () => add(ownedOnly(save, deckFromStarter(s))) })),
              ]}
            />
          </Win>
        </Overlay>
      )}
    </div>
  );
}

const PAGE = 60;
type Tab = 'cards' | 'main' | 'extra' | 'skill';
type Kind = 'all' | 'monster' | 'spell' | 'trap' | 'extra';

/**
 * Deck editor: every Speed Duel card, 3 copies each, plus the deck's Skill. With a
 * `collection`, only cards (and Skills) owned there are offered, up to the copies owned.
 */
export function SpeedDeckEdit({ deck, onChange, onBack, collection }: { deck: SpeedDeck; onChange: (d: SpeedDeck) => void; onBack: () => void; collection?: Record<string, number> }) {
  const [tab, setTab] = useState<Tab>('cards');
  const [kind, setKind] = useState<Kind>('all');
  const [q, setQ] = useState('');
  const [inText, setInText] = useState(false);
  const [setF, setSetF] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [sel, setSel] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const pool = useMemo(() => speedCards().filter((c) => !collection || (collection[c.name] ?? 0) > 0), [collection]);
  const skills = useMemo(() => skillCards().filter((c) => !collection || (collection[c.name] ?? 0) > 0), [collection]);
  const ownedCopies = (n: string) => (collection ? Math.min(COPIES, collection[n] ?? 0) : COPIES);
  const problems = speedDeckProblems(deck);
  const copies = (n: string) => deck.main.filter((x) => x === n).length + deck.extra.filter((x) => x === n).length;

  const matches = (name: string) => {
    const c = card(name);
    if (!c) return false;
    if (kind === 'extra' ? !isExtraCard(name) : kind !== 'all' && (c.kind !== kind || (kind === 'monster' && isExtraCard(name)))) return false;
    if (setF !== 'all' && !(c.speedSets ?? []).some((s) => (setF === 'GX' ? s.startsWith('SGX') : s === setF))) return false;
    if (!q) return true;
    const needle = q.toLowerCase();
    return name.toLowerCase().includes(needle) || (inText && c.desc.toLowerCase().includes(needle));
  };

  const set = (d: Partial<SpeedDeck>) => {
    onChange({ ...deck, ...d });
    playBlip();
  };
  const addCard = (n: string) => {
    if (isExtraCard(n)) set({ extra: [...deck.extra, n] });
    else set({ main: [...deck.main, n] });
  };
  const removeCard = (n: string) => {
    const from = deck.extra.includes(n) ? 'extra' : 'main';
    const list = [...deck[from]];
    list.splice(list.indexOf(n), 1);
    set({ [from]: list });
  };
  const canAdd = (n: string) => !unplayableReason(n) && copies(n) < ownedCopies(n) && (isExtraCard(n) ? deck.extra.length < EXTRA_MAX : deck.main.length < MAIN_MAX) && limitStatus(n) !== 'Forbidden';

  const counted = (list: string[]) => {
    const m = new Map<string, number>();
    for (const n of list) m.set(n, (m.get(n) ?? 0) + 1);
    return [...m.entries()].filter(([n]) => matches(n)).sort(([a], [b]) => (card(a)?.kind ?? '').localeCompare(card(b)?.kind ?? '') || a.localeCompare(b));
  };

  let rows: [string, number | null][] = [];
  if (tab === 'cards') rows = pool.filter((c) => matches(c.name) && (showAll || !unplayableReason(c.name))).map((c) => [c.name, copies(c.name) || null]);
  else if (tab === 'main') rows = counted(deck.main);
  else if (tab === 'extra') rows = counted(deck.extra);
  const shown = rows.slice(0, limit);

  const statLine = (n: string) => {
    const c = card(n);
    if (!c) return '';
    const lim = limitStatus(n);
    const base = c.kind === 'monster' ? `★${c.level ?? '?'} ${c.atk ?? 0}/${c.def ?? 0}` : c.sub;
    return lim ? `${base} · ${lim}` : base;
  };

  return (
    <div class="screen deckedit">
      <div class="tabs">
        {(['cards', 'main', 'extra', 'skill'] as Tab[]).map((t) => (
          <button key={t} class={`tab ${tab === t ? 'on' : ''}`} onClick={() => (setTab(t), setSel(null), setLimit(PAGE))}>
            {t === 'cards' ? (collection ? 'Owned' : 'All cards') : t === 'main' ? `Main ${deck.main.length}` : t === 'extra' ? `Extra ${deck.extra.length}/${EXTRA_MAX}` : 'Skill'}
          </button>
        ))}
        <button class="tab x" onClick={onBack}>
          Done
        </button>
      </div>
      <div class="sd-deckhead">
        <button class="chip" onClick={() => setRenaming(true)}>
          {deck.name} ✎
        </button>
        <span class={problems.length ? 'err' : 'good'}>{problems.length ? problems[0] : `Ready · ${deck.main.length} cards${deck.skill ? ` · ${deck.skill}` : ''}`}</span>
      </div>
      {deck.open && <p class="hint shop-pad">Anything goes deck: every card is here, but duels with it earn no packs or chips and it can't be bet.</p>}
      {collection && tab === 'cards' && pool.length < 40 && <p class="hint shop-pad">Only cards you own are here. Get more from packs and crafting in the Card Shop.</p>}
      {tab !== 'skill' && (
        <div class="filters">
          {(['all', 'monster', 'spell', 'trap', 'extra'] as Kind[]).map((f) => (
            <button key={f} class={`chip ${kind === f ? 'on' : ''}`} onClick={() => (setKind(f), setLimit(PAGE))}>
              {f === 'all' ? 'All' : f === 'monster' ? 'Mon' : f === 'spell' ? 'Spell' : f === 'trap' ? 'Trap' : 'Extra'}
            </button>
          ))}
          <input class="search" placeholder={inText ? 'Search text' : 'Search name'} value={q} onInput={(ev) => (setQ((ev.target as HTMLInputElement).value), setLimit(PAGE))} />
          <button class={`chip ${inText ? 'on' : ''}`} onClick={() => setInText(!inText)} title="Search card text too">
            Txt
          </button>
          <select class="setpick" value={setF} onChange={(ev) => (setSetF((ev.target as HTMLSelectElement).value), setLimit(PAGE))} aria-label="Speed Duel set">
            <option value="all">All sets</option>
            <option value="GX">Speed Duel GX (all 3)</option>
            {SPEED_SETS.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}
      {tab === 'skill' ? (
        <div class="cardlist">
          <p class="hint">Bring one Skill to each Duel. It starts face-down and flips when you use it. Only Skills the game can play are listed.</p>
          {skills
            .filter((s) => getSkill(s.name))
            .map((s) => (
              <button key={s.name} class={`crow ${deck.skill === s.name ? 'sel' : ''} k-spell`} onClick={() => setSel(s.name)}>
                <CardImg name={s.name} class="crow-img" />
                <span class="crow-name">{s.name}</span>
                <span class="crow-stat">
                  {s.character}
                  {limitStatus(s.name) ? ` · ${limitStatus(s.name)}` : ''}
                </span>
                <span class="crow-count">{deck.skill === s.name ? '✓' : ''}</span>
              </button>
            ))}
        </div>
      ) : (
        <div class="cardlist">
          {tab === 'cards' && (
            <p class="hint">
              {rows.length} card{rows.length === 1 ? '' : 's'}.{' '}
              <button class="chip" onClick={() => (setShowAll(!showAll), setLimit(PAGE))}>
                {showAll ? 'Hide cards not in the game yet' : 'Also show cards not in the game yet'}
              </button>
            </p>
          )}
          {shown.length === 0 && <p class="hint">Nothing here.</p>}
          {shown.map(([n, c]) => {
            const why = unplayableReason(n);
            const ci = card(n);
            return (
              <button key={n} class={`crow ${sel === n ? 'sel' : ''} k-${ci?.kind ?? 'monster'} ${why ? 'off' : ''}`} onClick={() => setSel(sel === n ? null : n)}>
                <CardImg name={n} class="crow-img" />
                <span class="crow-name">{n}</span>
                <span class="crow-stat">{why ? 'not in game yet' : statLine(n)}</span>
                <span class="crow-count">{c ? `×${c}` : ''}</span>
              </button>
            );
          })}
          {rows.length > limit && (
            <button class="gbtn more" onClick={() => setLimit(limit + PAGE)}>
              Show more ({rows.length - limit} left)
            </button>
          )}
        </div>
      )}
      {sel && tab === 'skill' && (
        <Win title={sel} class="msgwin">
          <Menu
            items={[
              deck.skill === sel ? { label: 'Remove this Skill', onPick: () => (set({ skill: null }), setSel(null)) } : { label: 'Use this Skill', disabled: limitStatus(sel) === 'Forbidden', onPick: () => (set({ skill: sel }), setSel(null)) },
              { label: 'Skill text', onPick: () => setInfo(sel) },
            ]}
          />
        </Win>
      )}
      {sel && tab !== 'skill' && (
        <Win title={sel} class="msgwin">
          {unplayableReason(sel) && <p class="hint">Can't be used yet: {unplayableReason(sel)}.</p>}
          <Menu
            items={[
              ...(!unplayableReason(sel) ? [{ label: isExtraCard(sel) ? 'Add to Extra Deck' : 'Add to Main Deck', disabled: !canAdd(sel), note: `${copies(sel)}/${ownedCopies(sel)}`, onPick: () => addCard(sel) }] : []),
              ...(copies(sel) > 0 ? [{ label: 'Remove one', onPick: () => removeCard(sel) }] : []),
              { label: 'Card Info', onPick: () => setInfo(sel) },
            ]}
          />
        </Win>
      )}
      {info && (
        <Overlay onClose={() => setInfo(null)}>
          <Win title="Card Info" onClose={() => setInfo(null)}>
            <CardInfoPanel name={info} />
            {limitStatus(info) && (
              <p class="hint">
                {limitStatus(info)} on the {LIMITED_LIST_NAME}.
              </p>
            )}
          </Win>
        </Overlay>
      )}
      {renaming && (
        <Overlay onClose={() => setRenaming(false)}>
          <Win title="Deck name" onClose={() => setRenaming(false)}>
            <input value={deck.name} maxLength={20} onInput={(ev) => onChange({ ...deck, name: (ev.target as HTMLInputElement).value.slice(0, 20) || 'Deck' })} />
            <p class="hint">
              Main Deck {MAIN_MIN}-{MAIN_MAX} cards, Extra Deck up to {EXTRA_MAX}, {COPIES} copies of a card at most, and the {LIMITED_LIST_NAME}.
            </p>
            <Menu items={[{ label: 'OK', onPick: () => setRenaming(false) }]} />
          </Win>
        </Overlay>
      )}
    </div>
  );
}

function CpuPick({ save, problems, onPick, onBack }: { save: SpeedSave; problems: string[]; onPick: (o: SpeedOpponent) => void; onBack: () => void }) {
  const opps = useMemo(() => speedOpponents(), []);
  const [sel, setSel] = useState<SpeedOpponent | null>(null);
  const [level, setLevel] = useState<Difficulty>(savedDifficulty);
  const pickLevel = (d: Difficulty) => (setLevel(d), saveDifficulty(d));
  return (
    <div class="screen">
      <Win title="Duel the Computer" onClose={onBack}>
        {problems.length > 0 && <div class="warn">Your deck is not ready: {problems[0]}.</div>}
        <Menu
          items={opps.map((o) => {
            const r = save.record[o.name];
            return { label: o.name, disabled: problems.length > 0, selected: sel?.name === o.name, note: `W${r?.w ?? 0} L${r?.l ?? 0} D${r?.d ?? 0}`, onPick: () => setSel(o) };
          })}
        />
      </Win>
      {sel && (
        <Overlay onClose={() => setSel(null)}>
          <Win title={sel.name} onClose={() => setSel(null)}>
            <p>
              {sel.title} · {sel.main.length}-card deck{sel.extra.length ? ` + ${sel.extra.length} Extra` : ''}
              {sel.skill ? ` · Skill: ${sel.skill}` : ''}
            </p>
            <p class="hint">Computer level</p>
            <Menu items={DIFFICULTIES.map((d) => ({ label: DIFFICULTY_LABEL[d], note: DIFFICULTY_NOTE[d], selected: level === d, onPick: () => pickLevel(d) }))} />
            <Menu items={[{ label: 'Duel!', onPick: () => onPick({ ...sel, level }) }, { label: 'Back', onPick: () => setSel(null) }]} />
          </Win>
        </Overlay>
      )}
    </div>
  );
}

function SpeedRecord({ save, onBack }: { save: SpeedSave; onBack: () => void }) {
  const rows = Object.entries(save.record);
  return (
    <div class="screen">
      <Win title="Speed Duel Record" onClose={onBack}>
        <p>
          Total: {save.wins} wins, {save.losses} losses, {save.draws} draws.
        </p>
        {rows.length === 0 ? (
          <p class="hint">No Speed Duels yet.</p>
        ) : (
          <table class="rec">
            <thead>
              <tr>
                <th>Opponent</th>
                <th>W</th>
                <th>L</th>
                <th>D</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([n, r]) => (
                <tr key={n}>
                  <td>{n}</td>
                  <td>{r.w}</td>
                  <td>{r.l}</td>
                  <td>{r.d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Win>
    </div>
  );
}

function SpeedLink({ problems, onPick, onBack }: { problems: string[]; onPick: (c: SpeedLinkChoice) => void; onBack: () => void }) {
  const [code, setCode] = useState('');
  const bad = problems.length > 0;
  return (
    <div class="screen">
      <Win title="Speed Duel Link Battle" onClose={onBack}>
        {bad && <div class="warn">Your deck is not ready: {problems[0]}.</div>}
        <Menu
          items={[
            { label: 'Friends', note: 'see who is online and invite them with one tap', onPick: () => online.openPanel() },
            { label: 'Create a room', note: 'you get a 4-letter code to send', disabled: bad, onPick: () => onPick({ mode: 'host' }) },
            { label: 'Play on this phone', note: 'take turns; Player 2 uses their own profile or a Starter Deck', disabled: bad, onPick: () => onPick({ mode: 'hotseat' }) },
          ]}
        />
        <div class="joinrow">
          <input class="code" value={code} maxLength={4} placeholder="CODE" onInput={(ev) => setCode((ev.target as HTMLInputElement).value.toUpperCase())} />
          <button class="gbtn" disabled={code.length !== 4 || bad} onClick={() => onPick({ mode: 'join', code })}>
            Join
          </button>
        </div>
        <p class="hint">Both players need to be in Speed Duel. A room code works for either game: whoever joins duels with the deck for the host's game.</p>
      </Win>
    </div>
  );
}

/** A random Starter Deck for a guest in Player 2's seat. */
export function guestSpeedDeck(): SpeedDeck {
  const s = STARTERS[Math.floor(Math.random() * STARTERS.length)];
  return deckFromStarter(s);
}

export { starterSkill };
