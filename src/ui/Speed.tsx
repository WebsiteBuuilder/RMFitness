// Speed Duel: the second game. Its own menu, decks (Speed Duel cards only), Skills,
// computer opponents and record, sharing profiles and the duel screen with EDS.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
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
  limitedGroupFull,
  newDeckId,
  speedDeckProblems,
  starterSkill,
  unplayableReason,
  type SpeedDeck,
  type SpeedSave,
  type Starter,
} from '../eds/speedSave';
import { CardImg, CardInfoPanel } from './CardImg';
import './deckedit.css';
import { RandomDeckSheet } from './RandomDeck';
import { DeckSwitch } from './DeckPick';
import { randomSpeedDeck, speedThemes } from '../eds/speedRandom';
import { Menu, Overlay, Win } from './Window';
import { buzz, playBlip } from './sound';
import { ShadowRealmScreen } from '../art/ShadowRealmScreen';
import { ArtLab } from '../art/ArtLab';
import { sealedCards } from '../art/shadow';
import { CardLevels, levelHeadline } from '../level/CardLevels';
import { cardLevels } from '../level/leveling';
import { showProfileLevels } from '../level/view';
import { CardShop } from '../collection/Shop';
import { RequestsScreen, StampsScreen } from '../collection/Earn';
import { boardOf } from '../collection/requests';
import { bestCrown, cantCraft, chipsOf, claimGift, collectionProblems, craft, craftCost, nextGift, ownedOnly, withStarter, type Gift } from '../collection/economy';
import { GiftReveal } from '../collection/Gift';
import { accounts } from '../accounts';
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
/** Android back inside the deck editor: closes its open sheet first (a card being read, the Skill list) */
let editBack: (() => boolean) | null = null;
export function speedHubBack(): boolean {
  return hubBack ? hubBack() : false;
}

type Sub = 'menu' | 'decks' | 'edit' | 'cpu' | 'record' | 'rankings' | 'link' | 'shadow' | 'art' | 'levels' | 'shop' | 'requests' | 'stamps';

/** profiles whose presents were put off with "Not now": none show again until the game is next opened */
const notNow = new Set<string>();

export function SpeedHub({
  controls,
  onControls,
  onSolo,
  onTag,
  onRaid,
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
  onSolo: (mode: 'campaign' | 'labyrinth' | 'practice' | 'legends' | 'ranked') => void;
  /** 2v2 Tag Duels and the Tag Road */
  onTag?: () => void;
  /** Boss Raid: you and your brother against the bosses */
  onRaid?: () => void;
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
  const [editRandom, setEditRandom] = useState(false);
  const [gift, setGift] = useState<Gift | null>(null);
  /** a present was just closed: the next one waits until the player leaves the menu and comes back */
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (sub !== 'menu') setHeld(false);
  }, [sub]);
  // A one-time present waiting on this profile (claimed when the box is torn); a second one waits for the next visit.
  useEffect(() => {
    if (gift || held || notNow.has(profile.id) || sub !== 'menu' || save.decks.length === 0) return;
    setGift(nextGift(save, profile.created, profile.id));
  }, [save, sub, gift, held]);
  const closeGift = () => (setGift(null), setHeld(true));
  const putOff = () => (notNow.add(profile.id), closeGift());
  const claim = () => {
    const next = gift && claimGift(save, profile.created, gift, profile.id);
    if (!next) return false;
    onSave(next);
    // upload the claim to the shared account now, so another phone can't claim it too
    window.setTimeout(() => void accounts.flush(), 0);
    return true;
  };
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
      if (gift) return (closeGift(), true); // Back closes a present (an unopened one comes back next visit)
      if (sub === 'menu') {
        if (tab === 'duel') return false;
        setTab('duel');
        return true;
      }
      if (sub === 'edit' && editBack?.()) return true;
      setSub(sub === 'edit' ? 'decks' : 'menu');
      return true;
    };
    return () => {
      hubBack = null;
    };
  });

  if (save.decks.length === 0) return <StarterPick onPick={(d) => onSave({ ...withStarter(save, d), decks: [d], active: d.id })} onExit={onExit} />;

  if (sub === 'decks') return <DeckList save={save} onSave={onSave} onEdit={(id, random) => (setEditing(id), setEditRandom(!!random), setSub('edit'))} onBack={() => setSub('menu')} />;
  if (sub === 'edit' && editing) {
    const d = save.decks.find((x) => x.id === editing);
    if (d) return <SpeedDeckEdit key={d.id} openRandom={editRandom} deck={d} collection={d.open ? undefined : (save.collection ?? {})} craft={d.open ? undefined : deckCrafter(save, onSave)} onChange={(nd) => onSave({ ...save, decks: save.decks.map((x) => (x.id === nd.id ? nd : x)) })} onBack={() => setSub('decks')} />;
  }
  const deckSwitch = <DeckSwitch decks={save.decks} current={deck} problemsOf={(d) => [...speedDeckProblems(d), ...collectionProblems(save, d)]} onPick={(d) => onSave({ ...save, active: d.id })} onManage={() => setSub('decks')} />;
  if (sub === 'cpu') return <CpuPick save={save} problems={problems} deckSwitch={deckSwitch} onPick={onCpu} onBack={() => setSub('menu')} />;
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
  if (sub === 'link') return <SpeedLink problems={problems} deckSwitch={deckSwitch} onPick={onLink} onBack={() => setSub('menu')} />;

  return (
    <>
      {gift && <GiftReveal key={gift.id} gift={gift} onClaim={claim} onOpen={() => (closeGift(), setSub('shop'))} onLater={closeGift} onNotNow={putOff} />}
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
        onRaid={onRaid}
        onExit={onExit}
        go={setSub}
        cpus={speedOpponents().map((o) => (o.name === 'Téa Gardner' ? 'Tea Gardner' : o.name))}
        onPickDeck={(d) => onSave({ ...save, active: d.id })}
        problemsOf={(d) => [...speedDeckProblems(d), ...collectionProblems(save, d)]}
      />
    </>
  );
}

function requestsNote(save: SpeedSave): string {
  const b = boardOf(save);
  if (!b) return 'back once the clock catches up';
  const done = b.list.filter((r) => r.done).length;
  return done === b.list.length ? 'all done today ✓ new ones tomorrow' : `${done}/${b.list.length} done today · each pays a card`;
}

/** The strongest monster in a deck: its face on a picker tile. */
const aceOf = (main: string[]) => [...main].filter((n) => card(n)?.kind === 'monster').sort((a, b) => (card(b)?.atk ?? 0) - (card(a)?.atk ?? 0))[0] ?? main[0];

/** A duelist or deck to pick: their ace card's art, the name, one line under it. */
function PickTile({ art, name, note, on, disabled, onPick }: { art: string; name: string; note: string; on: boolean; disabled?: boolean; onPick: () => void }) {
  return (
    <button class={`sp-pick ${on ? 'on' : ''}`} disabled={disabled} onClick={onPick}>
      <span class="sp-pick-art">
        <CardImg name={art} />
      </span>
      <b>{name}</b>
      <small>{note}</small>
    </button>
  );
}

function StarterPick({ onPick, onExit }: { onPick: (d: SpeedDeck) => void; onExit: () => void }) {
  const [sel, setSel] = useState<Starter | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const preview = sel ? deckFromStarter(sel) : null;
  return (
    <div class="screen">
      <Win title="Pick your first Speed Duel deck" onClose={onExit}>
        <p>Each one is a real Speed Duel Starter Deck with its Skill. Its cards become yours. Win packs and Duel Chips to grow your collection, plus 3 welcome packs to start.</p>
        <div class="sp-picks">
          {STARTERS.map((s) => {
            const d = deckFromStarter(s);
            return <PickTile key={s.character} art={aceOf(d.main)} name={s.character} note={d.skill ? d.skill.replace(/ \(Skill Card\)$/, '') : s.title.replace(/^.*\(|\)$/g, '')} on={sel === s} onPick={() => (playBlip(), setSel(s))} />;
          })}
        </div>
      </Win>
      {sel && preview && (
        <Win title={`${sel.character} · ${preview.main.length} cards`}>
          <button class="sp-go" onClick={() => onPick(preview)}>
            Take {sel.character}'s deck
          </button>
          {preview.skill && (
            <p class="starter-skill">
              <b>Skill: {preview.skill.replace(/ \(Skill Card\)$/, '')}</b>
              {card(preview.skill)?.desc && <span> {card(preview.skill)!.desc}</span>}
            </p>
          )}
          <p class="hint">Tap a card to read it.</p>
          <div class="grid small">
            {[...preview.main, ...preview.extra].map((n, i) => (
              <button key={i} class="gcard" onClick={() => (playBlip(), setInfo(n))} aria-label={n}>
                <CardImg name={n} />
              </button>
            ))}
          </div>
        </Win>
      )}
      {info && (
        <Overlay onClose={() => setInfo(null)}>
          <Win title="Card Info" onClose={() => setInfo(null)}>
            <CardInfoPanel name={info} />
          </Win>
        </Overlay>
      )}
    </div>
  );
}

function DeckList({ save, onSave, onEdit, onBack }: { save: SpeedSave; onSave: (s: SpeedSave) => void; onEdit: (id: string, random?: boolean) => void; onBack: () => void }) {
  const [sel, setSel] = useState<SpeedDeck | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const add = (d: SpeedDeck, random = false) => {
    onSave({ ...save, decks: [...save.decks, d] });
    setAdding(false);
    onEdit(d.id, random);
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
                { label: '🎲 Random deck', note: 'built for you from the cards you own', onPick: () => add({ id: newDeckId(), name: `Random ${save.decks.length + 1}`, main: [], extra: [], skill: null }, true) },
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
type Kind = 'all' | 'monster' | 'spell' | 'trap' | 'extra';
type Sort = 'type' | 'name' | 'atk' | 'def' | 'level';
const SORTS: [Sort, string][] = [
  ['type', 'Type'],
  ['level', 'Level'],
  ['atk', 'ATK'],
  ['def', 'DEF'],
  ['name', 'Name'],
];
const ATTRS = ['DARK', 'LIGHT', 'EARTH', 'WATER', 'FIRE', 'WIND', 'DIVINE'];
const KIND_ORDER: Record<string, number> = { monster: 0, spell: 1, trap: 2 };

/** Master Duel's deck order: monsters (highest Level first), then Spells, then Traps; ties by name. */
function byType(a: string, b: string): number {
  const x = card(a);
  const y = card(b);
  return (KIND_ORDER[x?.kind ?? ''] ?? 3) - (KIND_ORDER[y?.kind ?? ''] ?? 3) || (y?.level ?? 0) - (x?.level ?? 0) || (x?.sub ?? '').localeCompare(y?.sub ?? '') || a.localeCompare(b);
}

function sorter(by: Sort): (a: string, b: string) => number {
  if (by === 'type') return byType;
  if (by === 'name') return (a, b) => a.localeCompare(b);
  const key = (n: string) => {
    const c = card(n);
    if (c?.kind !== 'monster') return -1;
    return by === 'atk' ? (c.atk ?? 0) : by === 'def' ? (c.def ?? 0) : (c.level ?? 0);
  };
  return (a, b) => key(b) - key(a) || byType(a, b);
}

/** Quick add (a tap adds or takes out at once) is off unless the player turns it on. */
const QUICK_KEY = 'eds.deckQuickAdd';
function savedQuick(): boolean {
  try {
    return localStorage.getItem(QUICK_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * A tap and a long press for a card tile, like Master Duel's deck editor.
 * Returns the props for a card tile.
 */
function useTileTouch() {
  const held = useRef<{ t: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (held.current) clearTimeout(held.current.t);
    held.current = null;
  };
  return (onTap: () => void, onHold: () => void) => ({
    onPointerDown: (ev: PointerEvent) => {
      clear();
      fired.current = false;
      held.current = { x: ev.clientX, y: ev.clientY, t: setTimeout(() => ((fired.current = true), buzz(15), onHold()), 420) };
    },
    onPointerMove: (ev: PointerEvent) => {
      if (held.current && Math.hypot(ev.clientX - held.current.x, ev.clientY - held.current.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu: (ev: Event) => ev.preventDefault(),
    onClick: () => {
      if (fired.current) return void (fired.current = false);
      onTap();
    },
  });
}

/** Crafting from inside the deck editor: spends Duel Chips exactly like the Card Shop (economy.ts decides). */
export interface DeckCrafter {
  chips: number;
  cost: (n: string) => number;
  /** why it can't be crafted now (null: it can) */
  why: (n: string) => string | null;
  run: (n: string) => void;
}
export function deckCrafter(save: SpeedSave, onSave: (s: SpeedSave) => void): DeckCrafter {
  return {
    chips: chipsOf(save),
    cost: craftCost,
    why: (n) => cantCraft(save, n),
    run: (n) => {
      const next = craft(save, n);
      if (next) onSave(next);
    },
  };
}

/** How big the cards in the editor's list are (S fits the most, L shows names). */
type TileSize = 's' | 'm' | 'l';
const SIZE_KEY = 'eds.deckTileSize';
function savedSize(): TileSize {
  try {
    const v = localStorage.getItem(SIZE_KEY);
    return v === 's' || v === 'l' ? v : 'm';
  } catch {
    return 'm';
  }
}

export function SpeedDeckEdit({ deck, onChange, onBack, collection, craft: crafter, openRandom = false }: { deck: SpeedDeck; onChange: (d: SpeedDeck) => void; onBack: () => void; collection?: Record<string, number>; /** crafting with Duel Chips, for decks built from your own cards */ craft?: DeckCrafter; openRandom?: boolean }) {
  const [random, setRandom] = useState(openRandom);
  /** the deck as it was before a random deck replaced it */
  const [undo, setUndo] = useState<SpeedDeck | null>(null);
  const [kind, setKind] = useState<Kind>('all');
  const [sort, setSort] = useState<Sort>('type');
  const [attr, setAttr] = useState('all');
  const [lvl, setLvl] = useState('all');
  const [q, setQ] = useState('');
  const [inText, setInText] = useState(false);
  const [setF, setSetF] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const [moreFilters, setMoreFilters] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  /** the card being read before anything changes, and the cards ‹ › step through */
  const [view, setView] = useState<{ n: string; list: string[] } | null>(null);
  const [viewFromDeck, setViewFromDeck] = useState(false);
  /** a card picture shown as big as the screen allows */
  const [zoom, setZoom] = useState<string | null>(null);
  /** the Skill being read in the Skill list before it goes on */
  const [skillView, setSkillView] = useState<string | null>(null);
  const [quick, setQuickState] = useState(savedQuick);
  const setQuick = (on: boolean) => {
    setQuickState(on);
    try {
      localStorage.setItem(QUICK_KEY, on ? '1' : '0');
    } catch {
      /* private mode: it lasts until the editor closes */
    }
  };
  const [skillPick, setSkillPick] = useState(false);
  /** the list also shows cards you don't own yet, to craft them */
  const [crafting, setCrafting] = useState(false);
  const [size, setSizeState] = useState<TileSize>(savedSize);
  const nextSize = () => {
    const v: TileSize = size === 's' ? 'm' : size === 'm' ? 'l' : 's';
    setSizeState(v);
    try {
      localStorage.setItem(SIZE_KEY, v);
    } catch {
      /* private mode: it lasts until the editor closes */
    }
  };
  const [renaming, setRenaming] = useState(false);
  /** why the last tap couldn't add a card (shown for a moment) */
  const [note, setNote] = useState<{ text: string; id: number } | null>(null);
  /** the card just added, so its tile in the deck can flash */
  const [fresh, setFresh] = useState<{ n: string; id: number } | null>(null);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 1800);
    return () => clearTimeout(t);
  }, [note]);
  const craftOn = crafting && !!crafter && !!collection;
  // with Craft on, the list is the cards you can still make: ones you don't own all 3 of
  const pool = useMemo(() => speedCards().filter((c) => !collection || (craftOn ? (collection[c.name] ?? 0) < COPIES : (collection[c.name] ?? 0) > 0)), [collection, craftOn]);
  // the Skill list also offers Skills you can craft
  const skills = useMemo(() => skillCards().filter((c) => !collection || !!crafter || (collection[c.name] ?? 0) > 0), [collection, !!crafter]);
  const ownsCard = (n: string) => !collection || (collection[n] ?? 0) > 0;
  const ownedCopies = (n: string) => (collection ? Math.min(COPIES, collection[n] ?? 0) : COPIES);
  const problems = speedDeckProblems(deck);
  const copies = (n: string) => deck.main.filter((x) => x === n).length + deck.extra.filter((x) => x === n).length;
  const tile = useTileTouch();
  useEffect(() => {
    editBack = () => {
      if (zoom) return (setZoom(null), true);
      if (skillView) return (setSkillView(null), true);
      if (view) return (setView(null), true);
      if (skillPick) return (setSkillPick(false), true);
      if (renaming) return (setRenaming(false), true);
      if (random) return (setRandom(false), true);
      return false;
    };
    return () => {
      editBack = null;
    };
  });

  const matches = (name: string) => {
    const c = card(name);
    if (!c) return false;
    if (kind === 'extra' ? !isExtraCard(name) : kind !== 'all' && (c.kind !== kind || (kind === 'monster' && isExtraCard(name)))) return false;
    if (setF !== 'all' && !(c.speedSets ?? []).some((s) => (setF === 'GX' ? s.startsWith('SGX') : s === setF))) return false;
    if (attr !== 'all' && (c.kind !== 'monster' || c.attribute !== attr)) return false;
    if (lvl !== 'all' && (c.kind !== 'monster' || String(c.level ?? '') !== lvl)) return false;
    if (!q) return true;
    const needle = q.toLowerCase();
    return name.toLowerCase().includes(needle) || (inText && c.desc.toLowerCase().includes(needle));
  };

  const set = (d: Partial<SpeedDeck>) => {
    onChange({ ...deck, ...d });
    playBlip();
  };
  /** why this card can't go in (null: it can) */
  const whyNot = (n: string): string | null => {
    const why = unplayableReason(n);
    if (why) return `Not in the game yet: ${why}`;
    if (limitStatus(n) === 'Forbidden') return 'Forbidden on the Limited List';
    if (!ownsCard(n)) return crafter ? "You don't own it yet: craft it below" : "You don't own it yet";
    if (copies(n) >= ownedCopies(n)) return ownedCopies(n) < COPIES ? ownedCopies(n) === 1 ? 'Your only copy is already in the deck' : `All ${ownedCopies(n)} of your copies are already in the deck` : `${COPIES} copies at most`;
    const group = limitedGroupFull([...deck.main, ...deck.extra], n);
    if (group) return group;
    if (isExtraCard(n) ? deck.extra.length >= EXTRA_MAX : deck.main.length >= MAIN_MAX) return isExtraCard(n) ? `The Extra Deck is full (${EXTRA_MAX})` : `The Main Deck is full (${MAIN_MAX})`;
    return null;
  };
  const canAdd = (n: string) => !whyNot(n);
  const addCard = (n: string) => {
    const why = whyNot(n);
    if (why) return void (buzz(30), setNote({ text: why, id: Date.now() }));
    if (isExtraCard(n)) set({ extra: [...deck.extra, n] });
    else set({ main: [...deck.main, n] });
    setFresh({ n, id: Date.now() });
  };
  const removeCard = (n: string) => {
    const from = deck.extra.includes(n) ? 'extra' : 'main';
    const list = [...deck[from]];
    list.splice(list.indexOf(n), 1);
    set({ [from]: list });
  };

  const cmp = sorter(sort);
  const rows = useMemo(
    () => pool.filter((c) => matches(c.name) && (showAll || !unplayableReason(c.name))).map((c) => c.name).sort(cmp),
    [pool, kind, setF, attr, lvl, q, inText, showAll, sort],
  );
  const shown = rows.slice(0, limit);
  const main = [...deck.main].sort(byType);
  const extra = [...deck.extra].sort(byType);
  const count = (k: string) => deck.main.filter((n) => card(n)?.kind === k).length;
  const filtered = kind !== 'all' || attr !== 'all' || lvl !== 'all' || setF !== 'all' || !!q;

  const openPool = (n: string) => (playBlip(), setViewFromDeck(false), setView({ n, list: rows }));
  const openDeck = (n: string) => (playBlip(), setViewFromDeck(true), setView({ n, list: [...new Set([...main, ...extra])] }));

  const deckTile = (n: string, i: number) => (
    <button
      key={`${n}-${i}`}
      class={`dk-tile ${fresh?.n === n ? 'dk-fresh' : ''}`}
      aria-label={quick ? `${n}: tap to take out, hold to read` : `${n}: tap to read, then take out`}
      data-pad-x="Remove one"
      data-pad-y=""
      {...({ onpadx: () => removeCard(n), onpady: () => openDeck(n) } as object)}
      {...tile(() => (quick ? removeCard(n) : openDeck(n)), () => openDeck(n))}
    >
      <CardImg name={n} />
    </button>
  );

  return (
    <div class="screen deckedit dk">
      <div class="dk-head">
        <button class="dk-done" onClick={onBack}>
          ‹ Done
        </button>
        <button class="chip dk-name" onClick={() => setRenaming(true)}>
          {deck.name} ✎
        </button>
        <button class="chip sd-dice" onClick={() => (playBlip(), setRandom(true))} aria-label="Random deck maker">
          🎲
        </button>
        {undo && (
          <button class="chip" onClick={() => (onChange(undo), setUndo(null), playBlip())}>
            ↶ Undo
          </button>
        )}
      </div>
      <div class={`dk-status ${problems.length ? 'err' : 'good'}`}>{problems.length ? problems[0] : `Ready to duel · ${deck.main.length} cards`}</div>

      <div class="dk-deck">
        <div class="dk-counts">
          <b>Main {deck.main.length}</b>
          <span class="dk-k dk-mon">M {count('monster')}</span>
          <span class="dk-k dk-spell">S {count('spell')}</span>
          <span class="dk-k dk-trap">T {count('trap')}</span>
          <b class="dk-ex">
            Extra {deck.extra.length}/{EXTRA_MAX}
          </b>
          <button class={`dk-skill ${deck.skill ? '' : 'none'}`} onClick={() => (playBlip(), setSkillPick(true))} aria-label="Skill">
            ✦ {deck.skill ? deck.skill.replace(/ \(Skill Card\)$/, '') : 'Pick a Skill'}
          </button>
        </div>
        {main.length ? <div class="dk-grid">{main.map(deckTile)}</div> : <p class="hint">{quick ? 'Tap cards below to put them in your deck.' : 'Tap a card below to read it, then press Add.'}</p>}
        {extra.length > 0 && <div class="dk-grid dk-extra">{extra.map(deckTile)}</div>}
      </div>

      {random && (
        <RandomDeckSheet
          sizes={[20, 25, 30]}
          themes={(n) => speedThemes(collection, n)}
          make={(o) => randomSpeedDeck(collection, { ...o, keep: o.keepCards ? deck : undefined })}
          hasCards={deck.main.length + deck.extra.length > 0}
          owned={!!collection}
          onUse={(r) => {
            setUndo(deck);
            onChange({ ...deck, main: r.main, extra: r.extra, skill: r.skill });
            setRandom(false);
          }}
          onClose={() => setRandom(false)}
        />
      )}

      <div class="dk-pool">
        <div class="filters dk-filters">
          {(['all', 'monster', 'spell', 'trap', 'extra'] as Kind[]).map((f) => (
            <button key={f} class={`chip ${kind === f ? 'on' : ''}`} onClick={() => (setKind(f), setLimit(PAGE))}>
              {f === 'all' ? 'All' : f === 'monster' ? 'Monster' : f === 'spell' ? 'Spell' : f === 'trap' ? 'Trap' : 'Extra'}
            </button>
          ))}
          <button class={`chip ${moreFilters || attr !== 'all' || lvl !== 'all' || setF !== 'all' ? 'on' : ''}`} onClick={() => setMoreFilters(!moreFilters)} aria-label="More filters and sort">
            Sort ▾
          </button>
        </div>
        <div class="filters dk-filters">
          <input class="search" type="search" placeholder={inText ? 'Search card text' : 'Search name'} value={q} onInput={(ev) => (setQ((ev.target as HTMLInputElement).value), setLimit(PAGE))} />
          <button class={`chip ${inText ? 'on' : ''}`} onClick={() => setInText(!inText)} title="Search card text too">
            In text
          </button>
          {filtered && (
            <button class="chip" onClick={() => (setKind('all'), setAttr('all'), setLvl('all'), setSetF('all'), setQ(''), setLimit(PAGE))}>
              Clear
            </button>
          )}
        </div>
        {moreFilters && (
          <div class="filters dk-filters dk-more">
            <label>
              Sort
              <select value={sort} onChange={(ev) => setSort((ev.target as HTMLSelectElement).value as Sort)}>
                {SORTS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Attribute
              <select value={attr} onChange={(ev) => (setAttr((ev.target as HTMLSelectElement).value), setLimit(PAGE))}>
                <option value="all">Any</option>
                {ATTRS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Level
              <select value={lvl} onChange={(ev) => (setLvl((ev.target as HTMLSelectElement).value), setLimit(PAGE))}>
                <option value="all">Any</option>
                {Array.from({ length: 12 }, (_, i) => String(i + 1)).map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Set
              <select class="setpick" value={setF} onChange={(ev) => (setSetF((ev.target as HTMLSelectElement).value), setLimit(PAGE))} aria-label="Speed Duel set">
                <option value="all">All sets</option>
                <option value="GX">Speed Duel GX (all 3)</option>
                {SPEED_SETS.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button class="chip" onClick={() => (setShowAll(!showAll), setLimit(PAGE))}>
              {showAll ? 'Hide cards not in the game' : 'Show cards not in the game'}
            </button>
          </div>
        )}
        {deck.open && <p class="hint">Anything goes deck: every card is here, but duels with it earn no packs or chips and it can't be bet.</p>}
        {collection && !craftOn && pool.length < 40 && <p class="hint">Only cards you own are here. {crafter ? 'Tap Craft to see the rest and make them with Duel Chips.' : 'Get more from packs and crafting in the Card Shop.'}</p>}
        <p class="hint dk-hint">
          <span>
            {rows.length} card{rows.length === 1 ? '' : 's'} · {quick ? 'tap to add · hold to read' : 'tap to read, then Add'}
          </span>
        </p>
        <div class="dk-tools">
          {crafter && collection && (
            <button class={`chip dk-craftchip ${crafting ? 'on' : ''}`} role="switch" aria-checked={crafting} onClick={() => (playBlip(), setCrafting(!crafting), setLimit(PAGE))} aria-label="Show cards to craft">
              <i class="dchip" /> Craft · {crafter.chips}
            </button>
          )}
          <button class="chip dk-size" onClick={() => (playBlip(), nextSize())} aria-label={`Card size ${size.toUpperCase()}: tap to change`}>
            ⊞ {size === 's' ? 'Small' : size === 'm' ? 'Medium' : 'Big'}
          </button>
          <button class={`chip dk-quick ${quick ? 'on' : ''}`} role="switch" aria-checked={quick} onClick={() => (playBlip(), setQuick(!quick))}>
            Quick add {quick ? 'on' : 'off'}
          </button>
        </div>
        {craftOn && <p class="hint">Cards you can still craft, with their price in Duel Chips. Tap one to read it and craft it.</p>}
        {shown.length === 0 && <p class="hint">Nothing here.</p>}
        <div class={`dk-grid dk-poolgrid dk-size-${size}`}>
          {shown.map((n) => {
            const why = unplayableReason(n);
            const inDeck = copies(n);
            const can = canAdd(n);
            const mine = ownsCard(n);
            return (
              <button
                key={n}
                class={`dk-tile ${why ? 'off' : ''} ${!can ? 'maxed' : ''} ${mine ? '' : 'unowned'}`}
                aria-label={quick ? `${n}: tap to add, hold to read` : `${n}: tap to read, then add`}
                // a controller's X adds a copy, Y shows the card, like Master Duel's deck editor
                data-pad-x={why || !can ? '' : 'Add one'}
                data-pad-y=""
                {...({ onpadx: () => !why && can && addCard(n), onpady: () => openPool(n) } as object)}
                {...tile(() => (quick && mine ? addCard(n) : openPool(n)), () => openPool(n))}
              >
                <CardImg name={n} />
                {limitStatus(n) && <i class="dk-lim">{limitStatus(n) === 'Forbidden' ? '⊘' : limitStatus(n)!.slice(-1)}</i>}
                {mine ? (
                  <i class="dk-own">
                    {inDeck > 0 ? `${inDeck}/` : ''}
                    {collection ? Math.min(collection[n] ?? 0, 9) : COPIES}
                  </i>
                ) : (
                  crafter && (
                    <i class="dk-own dk-cost">
                      <i class="dchip" />
                      {crafter.cost(n)}
                    </i>
                  )
                )}
                {size === 'l' && <span class="dk-tname">{n}</span>}
              </button>
            );
          })}
        </div>
        {rows.length > limit && (
          <button class="gbtn more" onClick={() => setLimit(limit + PAGE)}>
            Show more ({rows.length - limit} left)
          </button>
        )}
      </div>

      {note && (
        <div class="dk-note" key={note.id} role="status">
          {note.text}
        </div>
      )}

      {skillPick && (
        <Overlay onClose={() => setSkillPick(false)}>
          <Win title="Skill" onClose={() => setSkillPick(false)}>
            <p class="hint">Bring one Skill to each Duel. It starts face-down and flips when you use it. Tap a Skill to read it first{crafter && collection ? '; the faded ones can be crafted with Duel Chips' : ''}.</p>
            <div class="cardlist dk-skills">
              {skills
                .filter((sk) => getSkill(sk.name))
                // yours first, then the ones you could craft
                .sort((a, b) => Number(ownsCard(b.name)) - Number(ownsCard(a.name)))
                .map((sk) => (
                  <button
                    key={sk.name}
                    class={`crow ${deck.skill === sk.name ? 'sel' : ''} ${ownsCard(sk.name) ? '' : 'unowned'} k-spell`}
                    onClick={() => (playBlip(), setSkillView(sk.name))}
                  >
                    <CardImg name={sk.name} class="crow-img" />
                    <span class="crow-name">{sk.name.replace(/ \(Skill Card\)$/, '')}</span>
                    <span class="crow-stat">
                      {sk.character}
                      {limitStatus(sk.name) ? ` · ${limitStatus(sk.name)}` : ''}
                    </span>
                    <span class="crow-count">
                      {deck.skill === sk.name ? (
                        '✓'
                      ) : ownsCard(sk.name) ? (
                        ''
                      ) : (
                        <>
                          <i class="dchip" />
                          {crafter?.cost(sk.name)}
                        </>
                      )}
                    </span>
                  </button>
                ))}
            </div>
          </Win>
        </Overlay>
      )}
      {view && (
        <CardView
          view={view}
          inDeck={viewFromDeck}
          copies={copies(view.n)}
          owned={ownedCopies(view.n)}
          why={whyNot(view.n)}
          craft={crafter && collection ? crafter : undefined}
          zoom={zoom === view.n}
          onZoom={(on) => setZoom(on ? view.n : null)}
          deckLine={isExtraCard(view.n) ? `Extra ${deck.extra.length}/${EXTRA_MAX}` : `Main ${deck.main.length}/${MAIN_MAX}`}
          onStep={(n) => setView({ ...view, n })}
          onAdd={() => addCard(view.n)}
          onRemove={() => removeCard(view.n)}
          onClose={() => setView(null)}
        />
      )}
      {skillView && (
        <Overlay onClose={() => setSkillView(null)}>
          <Win title="Skill" class="dk-view" onClose={() => setSkillView(null)}>
            <div class="dk-view-card" onClick={(ev) => (ev.target as HTMLElement).closest('.cinfo-pic') && setZoom(skillView)}>
              <CardInfoPanel name={skillView} />
            </div>
            {limitStatus(skillView) && (
              <p class="hint">
                {limitStatus(skillView)} on the {LIMITED_LIST_NAME}.
              </p>
            )}
            <div class="dk-view-acts">
              <button class="gbtn" onClick={() => (playBlip(), setSkillView(null))}>
                Back
              </button>
              {deck.skill === skillView ? (
                <button class="gbtn" onClick={() => (set({ skill: null }), setSkillView(null), setSkillPick(false))}>
                  Remove Skill
                </button>
              ) : (
                <button class="gbtn gold" disabled={limitStatus(skillView) === 'Forbidden' || !ownsCard(skillView)} onClick={() => (set({ skill: skillView }), setSkillView(null), setSkillPick(false))}>
                  Use this Skill
                </button>
              )}
            </div>
            {crafter && collection && !ownsCard(skillView) && <CraftButton name={skillView} craft={crafter} />}
          </Win>
        </Overlay>
      )}
      {zoom && !view && <CardZoom name={zoom} onClose={() => setZoom(null)} />}
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

/**
 * A card read big before anything changes: Add and Remove are the confirm, ‹ › (or a swipe,
 * or a controller's LB/RB) read the next card without closing.
 */
function CardView({ view, inDeck, copies, owned, why, deckLine, craft: crafter, zoom, onZoom, onStep, onAdd, onRemove, onClose }: { view: { n: string; list: string[] }; /** stepping through the deck's cards (one per name) */ inDeck: boolean; copies: number; owned: number; why: string | null; craft?: DeckCrafter; /** the picture is open full-screen */ zoom: boolean; onZoom: (on: boolean) => void; /** "Main 21/30": the deck this card goes in */ deckLine: string; onStep: (n: string) => void; onAdd: () => void; onRemove: () => void; onClose: () => void }) {
  const { n, list } = view;
  const i = list.indexOf(n);
  const canStep = list.length > 1 && i >= 0;
  /** which way the last step went, so the next card slides in from that side */
  const [dir, setDir] = useState(0);
  /** the card panel, moved straight under the finger while swiping (no re-render per move) */
  const cardEl = useRef<HTMLDivElement>(null);
  const setDrag = (x: number) => {
    const el = cardEl.current;
    if (!el) return;
    el.style.transition = x ? 'none' : '';
    el.style.transform = x ? `translateX(${x}px)` : '';
  };
  /** the last Add or Remove, shown as +1 / −1 on the picture */
  const [bump, setBump] = useState<{ d: 1 | -1; id: number } | null>(null);
  const step = (d: number) => {
    const next = list[i + d];
    if (i < 0 || !next) return;
    playBlip();
    setDir(d);
    setBump(null);
    onStep(next);
  };
  const swipe = useRef<{ x: number; y: number; side: boolean | null } | null>(null);
  const skill = card(n)?.sub === 'Skill';
  const notReady = unplayableReason(n);
  const change = (d: 1 | -1) => {
    if (d > 0) onAdd();
    else onRemove();
    buzz(12);
    setBump({ d, id: Date.now() });
  };
  return (
    <Overlay onClose={onClose}>
      <Win title={canStep ? (inDeck ? `In your deck · ${i + 1} of ${list.length}` : `Card ${i + 1} of ${list.length}`) : 'Card'} class="dk-view" onClose={onClose}>
        <div
          class="dk-view-swipe"
          onTouchStart={(ev) => (swipe.current = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, side: null })}
          onTouchMove={(ev) => {
            const s = swipe.current;
            if (!s || !canStep) return;
            const dx = ev.touches[0].clientX - s.x;
            const dy = ev.touches[0].clientY - s.y;
            // the first real move decides: sideways steps cards, up and down scrolls the text
            if (s.side === null && Math.hypot(dx, dy) > 8) s.side = Math.abs(dx) > Math.abs(dy) * 1.2;
            // past the first or last card it barely moves, so the end of the list is felt
            if (s.side) setDrag(list[i + (dx < 0 ? 1 : -1)] ? dx * 0.6 : dx * 0.15);
          }}
          onTouchEnd={(ev) => {
            const s = swipe.current;
            swipe.current = null;
            setDrag(0);
            if (!s?.side) return;
            const dx = ev.changedTouches[0].clientX - s.x;
            if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
          }}
          onTouchCancel={() => ((swipe.current = null), setDrag(0))}
        >
          <div class={`dk-view-card ${dir < 0 ? 'from-left' : dir > 0 ? 'from-right' : ''}`} key={n} ref={cardEl} onClick={(ev) => (ev.target as HTMLElement).closest('.cinfo-pic') && (playBlip(), onZoom(true))}>
            <CardInfoPanel name={n} />
            <i class="dk-view-zoom" aria-hidden="true">
              ⤢
            </i>
            {!skill && (
              <i class="dk-view-own" key={bump?.id ?? 0}>
                {copies}/{owned}
              </i>
            )}
            {bump && (
              <i class={`dk-view-bump ${bump.d > 0 ? 'up' : 'down'}`} key={bump.id}>
                {bump.d > 0 ? '+1' : '−1'}
              </i>
            )}
          </div>
        </div>
        {limitStatus(n) && (
          <p class="hint">
            {limitStatus(n)} on the {LIMITED_LIST_NAME}.
          </p>
        )}
        {notReady && <p class="hint dk-view-why">Not in the game yet: {notReady}</p>}
        {!skill ? (
          <>
            <div class="dk-view-acts dk-view-row">
              <button class="gbtn dk-step" disabled={!canStep || i === 0} onClick={() => step(-1)} aria-label="Previous card">
                ‹
              </button>
              <button class="gbtn" disabled={copies === 0} onClick={() => change(-1)}>
                Remove
              </button>
              <button class="gbtn gold" disabled={!!why} onClick={() => change(1)}>
                {isExtraCard(n) ? '+ Extra' : '+ Add'}
              </button>
              <button class="gbtn dk-step" disabled={!canStep || i === list.length - 1} onClick={() => step(1)} aria-label="Next card">
                ›
              </button>
            </div>
            <p class={`hint dk-view-count ${bump ? 'pulse' : ''}`} key={bump?.id ?? 0}>
              {owned ? `${copies} of ${owned} in your deck` : 'Not in your collection yet'} · {deckLine}
              {why && !notReady && owned > 0 && <span class="dk-view-whyline">{why}</span>}
            </p>
            {crafter && !notReady && owned < COPIES && <CraftButton name={n} craft={crafter} />}
          </>
        ) : null}
      </Win>
      {zoom && <CardZoom name={n} onClose={() => onZoom(false)} />}
    </Overlay>
  );
}

/** Craft one copy from the deck editor: the first tap arms it, the second spends the chips. */
function CraftButton({ name, craft: crafter }: { name: string; craft: DeckCrafter }) {
  const [armed, setArmed] = useState(false);
  const [done, setDone] = useState(0);
  useEffect(() => setArmed(false), [name]);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  const cost = crafter.cost(name);
  const why = crafter.why(name);
  const chips = (k: number) => `${k} Duel Chip${k === 1 ? '' : 's'}`;
  return (
    <div class="dk-craft">
      <button
        class={`gbtn dk-craft-btn ${armed ? 'armed' : ''}`}
        disabled={!!why}
        onClick={() => {
          if (!armed) return void (playBlip(), setArmed(true));
          crafter.run(name);
          buzz(25);
          setArmed(false);
          setDone(Date.now());
        }}
      >
        <i class="dchip" /> {armed ? `Tap again to spend ${cost}` : `Craft one · ${cost}`}
      </button>
      <span class={`dk-craft-note ${done ? 'done' : ''}`} key={done}>
        {done ? 'Crafted! ' : ''}
        {why ? why.replace(/^needs/, 'Needs') : `You have ${chips(crafter.chips)}`}
      </span>
    </div>
  );
}

/** A card picture as big as the screen allows; a tap anywhere closes it. */
function CardZoom({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <div class="dk-zoom" role="dialog" aria-label={`${name}, full size`} onClick={(ev) => (ev.stopPropagation(), playBlip(), onClose())}>
      <CardImg name={name} class="dk-zoom-img" />
      <span class="dk-zoom-hint">Tap to close</span>
    </div>
  );
}

function CpuPick({ save, problems, deckSwitch, onPick, onBack }: { save: SpeedSave; problems: string[]; deckSwitch: preact.ComponentChildren; onPick: (o: SpeedOpponent) => void; onBack: () => void }) {
  const opps = useMemo(() => speedOpponents(), []);
  const [sel, setSel] = useState<SpeedOpponent | null>(null);
  const [level, setLevel] = useState<Difficulty>(savedDifficulty);
  const pickLevel = (d: Difficulty) => (setLevel(d), saveDifficulty(d));
  return (
    <div class="screen">
      <Win title="Duel the Computer" onClose={onBack}>
        {deckSwitch}
        <div class="sp-picks">
          {opps.map((o) => {
            const r = save.record[o.name];
            return <PickTile key={o.name} art={aceOf(o.main)} name={o.name} note={r ? `${r.w ?? 0} won · ${r.l ?? 0} lost` : 'Not duelled yet'} on={sel?.name === o.name} disabled={problems.length > 0} onPick={() => (playBlip(), setSel(o))} />;
          })}
        </div>
      </Win>
      {sel && (
        <Overlay onClose={() => setSel(null)}>
          <Win title={sel.name} onClose={() => setSel(null)}>
            <p>
              {sel.title} · {sel.main.length}-card deck{sel.extra.length ? ` + ${sel.extra.length} Extra` : ''}
              {sel.skill ? ` · Skill: ${sel.skill}` : ''}
            </p>
            <p class="hint">Computer level</p>
            <div class="sp-levels" role="radiogroup">
              {DIFFICULTIES.map((d) => (
                <button key={d} role="radio" aria-checked={level === d} class={`sp-level ${level === d ? 'on' : ''}`} onClick={() => (playBlip(), pickLevel(d))}>
                  {DIFFICULTY_LABEL[d]}
                </button>
              ))}
            </div>
            <p class="hint sp-level-note">{DIFFICULTY_NOTE[level]}</p>
            <button class="sp-go" onClick={() => onPick({ ...sel, level })}>
              Duel!
            </button>
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

function SpeedLink({ problems, deckSwitch, onPick, onBack }: { problems: string[]; deckSwitch: preact.ComponentChildren; onPick: (c: SpeedLinkChoice) => void; onBack: () => void }) {
  const [code, setCode] = useState('');
  const bad = problems.length > 0;
  return (
    <div class="screen">
      <Win title="Speed Duel Link Battle" onClose={onBack}>
        {deckSwitch}
        <Menu
          items={[
            {
              label: 'Find a Match',
              note: 'duel whoever else is searching right now',
              disabled: bad,
              onPick: () => {
                const err = online.findMatch('speed');
                if (err) online.say(err);
                else onBack();
              },
            },
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
