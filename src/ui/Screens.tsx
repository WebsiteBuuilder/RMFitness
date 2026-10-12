// The out-of-duel screens: title, starter deck, main menu, record, calendar,
// password, pack opening and the campaign roster.
import { useState } from 'preact/hooks';
import { allCards, card, cardByPassword } from '../eds/db';
import { PACKS, RARITY_SHORT, openPack, packByName, type PackCard } from '../eds/packs';
import { MONTHS, WEEKDAYS, addToTrunk, calendarDate, deckProblems, totalCards, type Profile, type SaveFile } from '../eds/save';
import { Avatar } from './Profiles';
import { DUELISTS, STAGE_WINS_NEEDED, displayName, isUnlocked, lockReason, stageReached, type Duelist } from '../eds/campaign';
import { STARTER_BLURB, STARTER_COLORS, buildStarterDeck, type StarterColor } from '../eds/starter';
import { randomSeed } from '../eds/rng';
import { CardImg, CardInfoPanel } from './CardImg';
import { Menu, Overlay, Win } from './Window';
import { playBlip, playWin, unlockAudio } from './sound';

/** The Egyptian Gods come in packs but cannot be used, as in EDS. */
const GODS = new Set(['Obelisk the Tormentor', 'Slifer the Sky Dragon', 'The Winged Dragon of Ra']);

export function Title({ onStart, hasSave }: { onStart: () => void; hasSave: boolean }) {
  return (
    <div class="title" onClick={() => (unlockAudio(), onStart())}>
      <div class="title-eye">◈</div>
      <div class="title-logo">
        <span class="t1">YU-GI-OH!</span>
        <span class="t2">THE ETERNAL</span>
        <span class="t2">DUELIST SOUL</span>
        <span class="t3">fan remake</span>
      </div>
      <div class="press">{hasSave ? 'TAP TO CONTINUE' : 'TAP TO START'}</div>
      <div class="title-foot">A fan project. Yu-Gi-Oh! is © Kazuki Takahashi / Konami.</div>
    </div>
  );
}

export function Intro({ onDone, presetName }: { onDone: (name: string, color: StarterColor, deck: string[]) => void; presetName?: string }) {
  const [name, setName] = useState(presetName ?? '');
  const [color, setColor] = useState<StarterColor | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const seed = useState(() => randomSeed())[0];
  const pick = (c: StarterColor) => {
    playBlip();
    setColor(c);
    setPreview(buildStarterDeck(c, seed + STARTER_COLORS.indexOf(c)));
  };
  return (
    <div class="screen intro">
      <Win title="Téa">
        {presetName ? (
          <p>Hey {presetName}! You're new here, right? Pick a Starter Deck. Each one has 40 cards.</p>
        ) : (
          <>
            <p>Hey! You're new here, right? Tell me your name, then pick a Starter Deck. Each one has 40 cards.</p>
            <label class="field">
              <span>Name</span>
              <input value={name} maxLength={10} placeholder="Duelist" onInput={(ev) => setName((ev.target as HTMLInputElement).value)} />
            </label>
          </>
        )}
        <Menu items={STARTER_COLORS.map((c) => ({ label: `${c} Deck`, selected: color === c, note: STARTER_BLURB[c], onPick: () => pick(c) }))} />
      </Win>
      {preview && color && (
        <Win title={`${color} Deck · 40 cards`}>
          <div class="grid small">
            {preview.map((n, i) => (
              <div key={i} class="gcard">
                <CardImg name={n} />
              </div>
            ))}
          </div>
          <Menu items={[{ label: `Take the ${color} Deck`, disabled: !preview, onPick: () => onDone(name.trim() || 'Duelist', color, preview) }]} />
        </Win>
      )}
    </div>
  );
}

export type MenuChoice = 'campaign' | 'link' | 'deck' | 'record' | 'calendar' | 'password' | 'pack' | 'switch' | 'delete';

export function MainMenu({ save, profile, onPick }: { save: SaveFile; profile?: Profile | null; onPick: (c: MenuChoice) => void }) {
  const d = calendarDate(save.day);
  return (
    <div class="screen mainmenu">
      <div class="menu-head">
        <div class="menu-who">
          {profile && <Avatar p={profile} size="small" />}
          <span>
            <b>{profile?.alias ?? save.name}</b> · {WEEKDAYS[d.weekday]}, {MONTHS[d.month]} {d.date}
          </span>
        </div>
        <div>
          Cards {totalCards(save)} · W {save.wins} L {save.losses} D {save.draws}
          {save.pendingPacks > 0 && <b class="blink"> · {save.pendingPacks} pack to open!</b>}
        </div>
      </div>
      <Win title="Main Menu">
        <Menu
          items={[
            ...(save.pendingPacks > 0 ? [{ label: 'Open Booster Pack', note: `${save.pendingPacks} waiting`, onPick: () => onPick('pack') }] : []),
            { label: 'Campaign', note: 'duel the computer', onPick: () => onPick('campaign') },
            { label: 'Link Battle', note: 'duel your brother online or on one phone', onPick: () => onPick('link') },
            { label: 'Deck Edit', note: `Main ${save.main.length}/40`, onPick: () => onPick('deck') },
            { label: 'Record', onPick: () => onPick('record') },
            { label: 'Calendar', onPick: () => onPick('calendar') },
            { label: 'Password', onPick: () => onPick('password') },
            { label: 'Switch Profile', note: "who's dueling?", onPick: () => onPick('switch') },
          ]}
        />
      </Win>
      <button class="erase" onClick={() => onPick('delete')}>
        Delete this profile
      </button>
    </div>
  );
}

const STAGE_NAMES = ['', 'Stage 1', 'Stage 2', 'Stage 3', 'Stage 4', 'Stage 5'];

export function Campaign({ save, onBack, onDuel }: { save: SaveFile; onBack: () => void; onDuel: (d: Duelist) => void }) {
  const [pick, setPick] = useState<Duelist | null>(null);
  const reached = stageReached(save);
  const problems = deckProblems(save);
  return (
    <div class="screen">
      <Win title="Campaign" onClose={onBack}>
        {problems.length > 0 && <div class="warn">Your deck is not ready: {problems[0]}. Fix it in Deck Edit first.</div>}
        <p class="hint">Beat every duelist in a stage {STAGE_WINS_NEEDED[Math.min(reached + 1, 5)]} times to open the next stage. Each win earns a booster pack.</p>
        {[1, 2, 3, 4, 5].map((t) => (
          <div key={t} class="tier">
            <div class="tier-name">
              {STAGE_NAMES[t]}
              {t > reached ? ' · locked' : ''}
            </div>
            <Menu
              items={DUELISTS.filter((d) => d.tier === t).map((d) => {
                const r = save.record[d.name];
                const open = isUnlocked(save, d);
                return { label: displayName(d.name), disabled: !open || problems.length > 0, selected: pick?.name === d.name, note: open ? `W${r?.w ?? 0} L${r?.l ?? 0} D${r?.d ?? 0}` : lockReason(save, d), onPick: () => setPick(d) };
              })}
            />
          </div>
        ))}
      </Win>
      {pick && (
        <Overlay onClose={() => setPick(null)}>
          <Win title={displayName(pick.name)} onClose={() => setPick(null)}>
            <p>
              {STAGE_NAMES[pick.tier]} duelist · {pick.deck.length}-card deck{pick.fusion.length ? ` + ${pick.fusion.length} Fusion` : ''}.
            </p>
            <p class="hint">Record: W{save.record[pick.name]?.w ?? 0} L{save.record[pick.name]?.l ?? 0} D{save.record[pick.name]?.d ?? 0}</p>
            <Menu items={[{ label: 'Duel!', onPick: () => onDuel(pick) }, { label: 'Back', onPick: () => setPick(null) }]} />
          </Win>
        </Overlay>
      )}
    </div>
  );
}

export function Record({ save, onBack }: { save: SaveFile; onBack: () => void }) {
  const rows = Object.entries(save.record);
  return (
    <div class="screen">
      <Win title="Record" onClose={onBack}>
        <p>
          Total: {save.wins} wins, {save.losses} losses, {save.draws} draws.
        </p>
        {rows.length === 0 ? (
          <p class="hint">No duels yet.</p>
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

export function Calendar({ save, onBack }: { save: SaveFile; onBack: () => void }) {
  const d = calendarDate(save.day);
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const firstWeekday = (d.weekday - (d.date - 1) + 70) % 7;
  const cells: (number | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: lengths[d.month] }, (_, i) => i + 1)];
  return (
    <div class="screen">
      <Win title="Calendar" onClose={onBack}>
        <div class="cal-head">
          {MONTHS[d.month]} · Year {d.year}
        </div>
        <div class="cal">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => (
            <div key={i} class="cal-w">
              {w}
            </div>
          ))}
          {cells.map((c, i) => (
            <div key={i} class={`cal-d ${c === d.date ? 'today' : ''} ${c === 21 ? 'mag' : ''}`}>
              {c ?? ''}
            </div>
          ))}
        </div>
        <p class="hint">One day passes after every duel, Campaign or Link Battle. Today is highlighted.</p>
      </Win>
    </div>
  );
}

export function Password({ save, onSave, onBack }: { save: SaveFile; onSave: (s: SaveFile) => void; onBack: () => void }) {
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [got, setGot] = useState<string | null>(null);
  const submit = () => {
    const c = cardByPassword(pw);
    if (!c) return setMsg('ERROR: no card has that password.');
    if (save.usedPasswords.includes(pw)) return setMsg('ERROR: that password was already used.');
    if ((save.trunk[c.name] ?? 0) > 0 || save.main.includes(c.name) || save.side.includes(c.name) || save.fusion.includes(c.name)) return setMsg(`ERROR: you already have ${c.name}.`);
    const next = { ...save, trunk: { ...save.trunk }, usedPasswords: [...save.usedPasswords, pw] };
    addToTrunk(next, [c.name]);
    onSave(next);
    setGot(c.name);
    setMsg(`${c.name} was added to your Trunk!`);
    setPw('');
  };
  return (
    <div class="screen">
      <Win title="Password" onClose={onBack}>
        <p>Enter the 8-digit number printed in the bottom-left corner of a card. Each password works once.</p>
        <div class="pwrow">
          <input class="pw" inputMode="numeric" maxLength={8} value={pw} onInput={(ev) => setPw((ev.target as HTMLInputElement).value.replace(/\D/g, ''))} placeholder="00000000" />
          <button class="gbtn" disabled={pw.length !== 8} onClick={submit}>
            OK
          </button>
        </div>
        {msg && <p class={msg.startsWith('ERROR') ? 'err' : 'good'}>{msg}</p>}
        {got && <CardInfoPanel name={got} />}
      </Win>
    </div>
  );
}

export function PackOpen({ save, onSave, onDone }: { save: SaveFile; onSave: (s: SaveFile) => void; onDone: () => void }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [cards, setCards] = useState<PackCard[] | null>(null);
  const [shown, setShown] = useState(0);
  const [info, setInfo] = useState<string | null>(null);
  const unlocked = PACKS.filter((p) => save.unlockedPacks.includes(p.name));
  const options = unlocked.length ? unlocked.map((p) => p.name) : save.unlockedPacks;
  const open = (name: string) => {
    unlockAudio();
    const got = openPack(packByName(name), randomSeed());
    setChosen(name);
    setCards(got);
    setShown(0);
    const next = { ...save, trunk: { ...save.trunk }, pendingPacks: Math.max(0, save.pendingPacks - 1) };
    addToTrunk(next, got.map((c) => c.name));
    onSave(next);
  };
  const reveal = () => {
    playBlip();
    if (cards && shown < cards.length) {
      setShown(shown + 1);
      if (shown + 1 === cards.length) playWin();
    }
  };
  if (!cards)
    return (
      <div class="screen">
        <Win title="You won a Booster Pack!">
          <p>Choose a pack. Each has 5 cards: 4 commons and 1 from the rare slot.</p>
          <Menu items={options.map((n) => ({ label: n, note: packByName(n)?.cards.length ? `${packByName(n)!.cards.length} cards` : undefined, onPick: () => open(n) }))} />
        </Win>
      </div>
    );
  return (
    <div class="screen packopen" onClick={reveal}>
      <Win title={chosen ?? 'Pack'}>
        <div class="packrow">
          {cards.map((c, i) => (
            <div key={i} class={`pcard ${i < shown ? 'up' : ''}`} onClick={(ev) => (ev.stopPropagation(), i < shown ? setInfo(c.name) : reveal())}>
              <CardImg name={c.name} back={i >= shown} />
              {i < shown && <span class={`rar r-${RARITY_SHORT[c.rarity] ?? 'C'}`}>{RARITY_SHORT[c.rarity] ?? 'C'}</span>}
            </div>
          ))}
        </div>
        {shown < cards.length ? <p class="hint">Tap to reveal</p> : <Menu items={[{ label: save.pendingPacks > 0 ? `Open another pack (${save.pendingPacks} left)` : 'Done', onPick: () => (save.pendingPacks > 0 ? setCards(null) : onDone()) }]} />}
      </Win>
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

/** Deck Edit: Trunk, Main Deck, Side Deck, Fusion Deck. */
export function DeckEdit({ save, onSave, onBack }: { save: SaveFile; onSave: (s: SaveFile) => void; onBack: () => void }) {
  type Tab = 'main' | 'side' | 'fusion' | 'trunk';
  const [tab, setTab] = useState<Tab>('main');
  const [filter, setFilter] = useState<'all' | 'monster' | 'spell' | 'trap'>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const counts = (list: string[]) => {
    const m: Record<string, number> = {};
    for (const n of list) m[n] = (m[n] ?? 0) + 1;
    return m;
  };
  const listFor = (t: Tab): Record<string, number> => (t === 'trunk' ? save.trunk : counts(save[t]));
  const entries = Object.entries(listFor(tab))
    .filter(([, c]) => c > 0)
    .filter(([n]) => {
      const info = card(n);
      if (filter !== 'all' && info?.kind !== filter) return false;
      return !q || n.toLowerCase().includes(q.toLowerCase());
    })
    .sort(([a], [b]) => (card(a)?.n ?? 0) - (card(b)?.n ?? 0) || a.localeCompare(b));

  const move = (name: string, from: Tab, to: Tab) => {
    const next: SaveFile = { ...save, trunk: { ...save.trunk }, main: [...save.main], side: [...save.side], fusion: [...save.fusion] };
    if (from === 'trunk') {
      if ((next.trunk[name] ?? 0) <= 0) return;
      next.trunk[name]--;
    } else {
      const i = next[from].indexOf(name);
      if (i < 0) return;
      next[from].splice(i, 1);
    }
    if (to === 'trunk') next.trunk[name] = (next.trunk[name] ?? 0) + 1;
    else next[to].push(name);
    onSave(next);
    playBlip();
  };
  const isFusion = (n: string) => card(n)?.sub === 'Fusion';
  /** Ticket cards and the Egyptian Gods are keepsakes in EDS: they cannot go in a Deck. */
  const keepsake = (n: string) => card(n)?.sub === 'Ticket' || GODS.has(n);
  const copies = (n: string) => save.main.filter((x) => x === n).length + save.side.filter((x) => x === n).length + save.fusion.filter((x) => x === n).length;
  const dbKnown = allCards().length > 0;

  return (
    <div class="screen deckedit">
      <div class="tabs">
        {(['main', 'side', 'fusion', 'trunk'] as Tab[]).map((t) => (
          <button key={t} class={`tab ${tab === t ? 'on' : ''}`} onClick={() => (setTab(t), setSel(null))}>
            {t === 'main' ? `Main ${save.main.length}/40` : t === 'side' ? `Side ${save.side.length}/15` : t === 'fusion' ? `Fusion ${save.fusion.length}/20` : `Trunk ${Object.values(save.trunk).reduce((a, b) => a + b, 0)}`}
          </button>
        ))}
        <button class="tab x" onClick={onBack}>
          Exit
        </button>
      </div>
      <div class="filters">
        {(['all', 'monster', 'spell', 'trap'] as const).map((f) => (
          <button key={f} class={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'monster' ? 'Monsters' : f === 'spell' ? 'Magic' : 'Traps'}
          </button>
        ))}
        <input class="search" placeholder="Search" value={q} onInput={(ev) => setQ((ev.target as HTMLInputElement).value)} />
      </div>
      <div class="cardlist">
        {entries.length === 0 && <p class="hint">Nothing here{dbKnown ? '' : ' (card data still loading)'}.</p>}
        {entries.map(([n, c]) => {
          const info = card(n);
          return (
            <button key={n} class={`crow ${sel === n ? 'sel' : ''} k-${info?.kind ?? 'monster'}`} onClick={() => setSel(sel === n ? null : n)}>
              <CardImg name={n} class="crow-img" />
              <span class="crow-name">{n}</span>
              <span class="crow-stat">{info?.kind === 'monster' ? `★${info.level} ${info.atk}/${info.def}` : info?.sub ?? ''}</span>
              <span class="crow-count">×{c}</span>
            </button>
          );
        })}
      </div>
      {sel && (
        <Win title={sel} class="msgwin">
          <Menu
            items={[
              ...(keepsake(sel) ? [{ label: 'A keepsake: it cannot be used in a Duel', disabled: true, onPick: () => {} }] : []),
              ...(tab !== 'trunk' ? [{ label: 'To Trunk', onPick: () => move(sel, tab, 'trunk') }] : []),
              ...(tab !== 'main' && !isFusion(sel) && !keepsake(sel) ? [{ label: 'To Main Deck', disabled: copies(sel) >= 3, onPick: () => move(sel, tab, 'main') }] : []),
              ...(tab !== 'side' && !keepsake(sel) ? [{ label: 'To Side Deck', disabled: copies(sel) >= 3 || save.side.length >= 15, onPick: () => move(sel, tab, 'side') }] : []),
              ...(tab !== 'fusion' && isFusion(sel) ? [{ label: 'To Fusion Deck', disabled: copies(sel) >= 3 || save.fusion.length >= 20, onPick: () => move(sel, tab, 'fusion') }] : []),
              { label: 'Card Info', onPick: () => setInfo(sel) },
            ]}
          />
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
