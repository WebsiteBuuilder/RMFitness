// The Card Shop: open packs from the real Speed Duel sets, browse the cards you own,
// craft cards with Duel Chips, lift a card's look one rarity step, break spare copies.
import { useMemo, useState } from 'preact/hooks';
import { card, speedCards, skillCards } from '../eds/db';
import { CHIP_CAP, COPIES, owned, unplayableReason, type SpeedSave } from '../eds/speedSave';
import { CardImg, CardInfoPanel } from '../ui/CardImg';
import { Menu, Overlay, Win } from '../ui/Window';
import { playBlip, playHit, playSummon, playWin } from '../ui/sound';
import { RarityChip } from '../level/CardLevels';
import { TIERS, cardLevels, tierIndex } from '../level/leveling';
import {
  BREAK_SHARDS,
  LOOK_UP_COST,
  RIVAL_MIN_TURNS,
  SHARDS_PER_CHIP,
  breakAllSpares,
  breakCopy,
  cantCraft,
  cantLookUp,
  chipsOf,
  copiesInDecks,
  craft,
  craftCost,
  lookUp,
  openOwnedPack,
  packsOf,
  pityLeft,
  shardsOf,
  sortForBinder,
  spareCopies,
  todaysPrizes,
  type Opened,
} from './economy';
import { RARITIES, RARITY_SHORT, WINS_PER_SET, boosterSets, rarityIn, rarityOf, setByName, shortSetName, unlockedSets, type Rarity } from './sets';

const setCards = (name: string): [string, Rarity][] => setByName(name)?.cards ?? [];
import './shop.css';

type Tab = 'packs' | 'binder' | 'craft';
const PAGE = 60;
const RCLASS: Record<string, string> = { Common: 'rc', Rare: 'rr', 'Super Rare': 'rsr', 'Ultra Rare': 'rur', 'Secret Rare': 'rscr' };
const isHit = (r: Rarity) => r !== 'Common' && r !== 'Rare';
const buzz = (ms: number | number[]) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
};

/** Duel Chips, shards and packs, labelled. Tap for how to earn each and what's left today. */
export function ChipBar({ save, cpus = [] }: { save: SpeedSave; cpus?: string[] }) {
  const [help, setHelp] = useState(false);
  const left = todaysPrizes(save, cpus);
  return (
    <>
      <button class="shop-bar" onClick={() => (playBlip(), setHelp(true))} aria-label="Duel Chips, shards and packs: tap for details">
        <span class="shop-chip">
          <i class="dchip" /> Chips {chipsOf(save)}/{CHIP_CAP}
        </span>
        <span>◆ Shards {shardsOf(save)}/{SHARDS_PER_CHIP}</span>
        <span>🂠 Packs {packsOf(save)}</span>
        <span class="shop-q">?</span>
      </button>
      {help && (
        <Overlay onClose={() => setHelp(false)}>
          <Win title="Chips, shards and packs" onClose={() => setHelp(false)}>
            <p>
              <i class="dchip" /> <b>Duel Chips</b> craft cards and lift a card's look. You can hold {CHIP_CAP}. They come slowly: your first 3-star win on each campaign duel, each Labyrinth boss, one win a day over your brother, and shards.
            </p>
            <p>
              ◆ <b>Shards</b> come from breaking spare copies. {SHARDS_PER_CHIP} make a chip.
            </p>
            <p>
              🂠 <b>Packs</b> come from your first win against each computer duelist each day, up to 3 wins a day over your brother (duels of {RIVAL_MIN_TURNS}+ turns), and the campaign.
            </p>
            <p class="today">
              <b>Still to win today:</b> {left.cpu.length ? `a pack from ${left.cpu.length} computer duelist${left.cpu.length === 1 ? '' : 's'}` : 'every computer duelist is beaten'}, {left.rivalPacks} rival pack{left.rivalPacks === 1 ? '' : 's'}
              {left.rivalChip ? ' and the rival chip' : ''}.
            </p>
            <Menu items={[{ label: 'OK', onPick: () => setHelp(false) }]} />
          </Win>
        </Overlay>
      )}
    </>
  );
}

export function CardShop({ save, onSave, onBack }: { save: SpeedSave; onSave: (s: SpeedSave) => void; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>(packsOf(save) > 0 ? 'packs' : 'binder');
  const [opened, setOpened] = useState<Opened[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const show = (o: Opened[]) => (setN(n + 1), setOpened(o));

  /** Opens up to `count` packs of a set in a row. */
  const openSome = (from: SpeedSave, set: string, count: number) => {
    const out: Opened[] = [];
    let cur = from;
    for (let i = 0; i < count; i++) {
      const o = openOwnedPack(cur, set, Date.now() + i * 7919);
      if (!o) break;
      out.push(o);
      cur = o.save;
    }
    if (!out.length) return;
    onSave(cur);
    show(out);
  };

  return (
    <div class="screen deckedit shop">
      <div class="tabs">
        {(['packs', 'binder', 'craft'] as Tab[]).map((t) => (
          <button key={t} class={`tab ${tab === t ? 'on' : ''}`} onClick={() => (playBlip(), setTab(t))}>
            {t === 'packs' ? `Packs${packsOf(save) ? ` (${packsOf(save)})` : ''}` : t === 'binder' ? 'My cards' : 'Craft'}
          </button>
        ))}
        <button class="tab x" onClick={onBack}>
          Done
        </button>
      </div>
      <ChipBar save={save} />
      {tab === 'packs' && <Packs save={save} onOpen={(set, all) => openSome(save, set, all ? packsOf(save) : 1)} />}
      {tab === 'binder' && <MyCards save={save} onSave={onSave} onPick={setSel} />}
      {tab === 'craft' && <CraftList save={save} onPick={setSel} />}
      {sel && <CardSheet save={save} name={sel} onSave={onSave} onClose={() => setSel(null)} />}
      {opened &&
        (opened.length === 1 ? (
          <PackReveal
            key={n}
            opened={opened[0]}
            left={packsOf(opened[0].save)}
            onAgain={(all) => openSome(opened[0].save, opened[0].set!, all ? packsOf(opened[0].save) : 1)}
            onDone={() => setOpened(null)}
          />
        ) : (
          <PackSummary key={n} opened={opened} onDone={() => setOpened(null)} />
        ))}
    </div>
  );
}

/** The set's showpiece card (its rarest), drawn on the pack. */
const coverOf = (cards: [string, Rarity][]) => [...cards].sort((a, b) => RARITIES.indexOf(b[1]) - RARITIES.indexOf(a[1]) || a[0].localeCompare(b[0]))[0]?.[0];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How many of a set's cards the profile owns. */
const completion = (save: SpeedSave, cards: [string, Rarity][]) => {
  const names = [...new Set(cards.map(([n]) => n))];
  return { have: names.filter((n) => owned(save, n) > 0).length, of: names.length };
};

function Packs({ save, onOpen }: { save: SpeedSave; onOpen: (set: string, all: boolean) => void }) {
  const all = boosterSets();
  const open = unlockedSets(save.wins);
  const toNext = WINS_PER_SET - (save.wins % WINS_PER_SET);
  const [pick, setPick] = useState<string | null>(null);
  return (
    <div class="cardlist">
      <p class="hint">
        {packsOf(save) > 0 ? `You have ${packsOf(save)} pack${packsOf(save) === 1 ? '' : 's'} to open. Pick a set:` : 'No packs to open. Win them in duels (tap the bar above to see how).'}
      </p>
      {open.length < all.length && (
        <div class="next-set">
          <span>
            Next set: <b>{shortSetName(all[open.length].name)}</b> in {toNext} win{toNext === 1 ? '' : 's'}
          </span>
          <span class="bar">
            <i style={{ width: `${((WINS_PER_SET - toNext) / WINS_PER_SET) * 100}%` }} />
          </span>
        </div>
      )}
      <div class="pack-grid">
        {all.map((s, i) => {
          const unlocked = i < open.length;
          const c = completion(save, s.cards);
          return (
            <button
              key={s.name}
              class={`pack ${unlocked ? '' : 'locked'} p${i % 6}`}
              disabled={!unlocked || packsOf(save) < 1}
              onClick={() => (playBlip(), packsOf(save) > 1 ? setPick(s.name) : onOpen(s.name, false))}
            >
              {coverOf(s.cards) && (
                <span class="pack-art">
                  <CardImg name={coverOf(s.cards)!} />
                </span>
              )}
              <span class="pack-logo">SPEED DUEL</span>
              <span class="pack-name">{shortSetName(s.name)}</span>
              <span class="pack-note">{unlocked ? `${c.have}/${c.of} owned` : i === open.length ? `${toNext} more win${toNext === 1 ? '' : 's'}` : 'locked'}</span>
            </button>
          );
        })}
      </div>
      <p class="pity">
        ✦ Ultra Rare or better guaranteed within <b>{plural(pityLeft(save), 'pack')}</b>
      </p>
      <p class="hint">A pack has 5 cards: 4 Commons and one hit hiding among them: Super Rare 85%, Ultra Rare 10%, Secret Rare 5% (when the set has one). Copies past 3 break into shards by themselves.</p>
      {pick && (
        <Overlay onClose={() => setPick(null)}>
          <Win title={shortSetName(pick)} onClose={() => setPick(null)}>
            <Menu
              items={[
                { label: 'Open 1 pack', onPick: () => (setPick(null), onOpen(pick, false)) },
                { label: `Open all ${packsOf(save)}`, note: 'see every card at once', onPick: () => (setPick(null), onOpen(pick, true)) },
              ]}
            />
          </Win>
        </Overlay>
      )}
    </div>
  );
}

function PackReveal({ opened, left, onAgain, onDone }: { opened: Opened; left: number; onAgain: (all: boolean) => void; onDone: () => void }) {
  const [torn, setTorn] = useState(false);
  const [flipped, setFlipped] = useState<boolean[]>(() => opened.cards.map(() => false));
  const [flash, setFlash] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const rar = opened.cards.map((n) => rarityIn(opened.set, n));
  const all = flipped.every(Boolean);
  const flipOne = (i: number, cur: boolean[]) => {
    const r = rar[i];
    if (isHit(r)) {
      setFlash(RCLASS[r]);
      window.setTimeout(() => setFlash(null), 900);
      buzz(r === 'Secret Rare' ? [60, 40, 120] : r === 'Ultra Rare' ? [50, 30, 80] : 40);
      if (r === 'Super Rare') playHit();
      else (playWin(), r === 'Secret Rare' && window.setTimeout(playSummon, 250));
    } else playBlip();
    return cur.map((f, j) => f || j === i);
  };
  const flip = (i: number) => {
    if (flipped[i]) return setInfo(opened.cards[i]);
    setFlipped(flipOne(i, flipped));
  };
  // Flip all: the Commons first, then a beat, then the hit.
  const flipAll = () => {
    const commons = flipped.map((f, i) => f || !isHit(rar[i]));
    playBlip();
    setFlipped(commons);
    const hits = rar.map((r, i) => (isHit(r) && !flipped[i] ? i : -1)).filter((i) => i >= 0);
    if (hits.length) window.setTimeout(() => setFlipped((cur) => hits.reduce((c, i) => flipOne(i, c), cur)), 700);
  };
  const tear = () => {
    playSummon();
    buzz(30);
    setTorn(true);
  };
  return (
    <Overlay>
      <div class={`reveal ${flash ? `flash ${flash}` : ''}`}>
        {!torn ? (
          <button class="pack big tearable" onClick={tear}>
            {opened.set && coverOf(setCards(opened.set)) && (
              <span class="pack-art">
                <CardImg name={coverOf(setCards(opened.set))!} />
              </span>
            )}
            <span class="pack-logo">SPEED DUEL</span>
            <span class="pack-name">{shortSetName(opened.set ?? '')}</span>
            <span class="pack-note">tap to tear it open</span>
          </button>
        ) : (
          <>
            <div class="reveal-row">
              {opened.cards.map((n, i) => {
                const r = rar[i];
                return (
                  <button key={i} class={`rv ${flipped[i] ? 'up' : ''} ${RCLASS[r]} ${isHit(r) ? 'hit' : ''}`} style={{ animationDelay: `${i * 90}ms` }} onClick={() => flip(i)}>
                    <span class="rv-in">
                      <span class="rv-back">
                        <i class="sd-back" />
                      </span>
                      <span class="rv-face">
                        <CardImg name={n} />
                        <span class="rv-r">{RARITY_SHORT[r]}</span>
                        {opened.fresh.includes(n) && <span class="rv-new">NEW</span>}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {all && opened.shards > 0 && <p class="hint">Copies past 3 broke into {opened.shards} shards.</p>}
            <Menu
              items={
                all
                  ? [
                      ...(left > 0 ? [{ label: 'Open another', note: `${left} left`, onPick: () => onAgain(false) }] : []),
                      ...(left > 1 ? [{ label: `Open all ${left}`, onPick: () => onAgain(true) }] : []),
                      { label: 'Done', onPick: onDone },
                    ]
                  : [{ label: 'Flip all', onPick: flipAll }]
              }
            />
          </>
        )}
      </div>
      {info && (
        <Overlay onClose={() => setInfo(null)}>
          <Win title="Card Info" onClose={() => setInfo(null)}>
            <CardInfoPanel name={info} />
          </Win>
        </Overlay>
      )}
    </Overlay>
  );
}

/** Several packs opened at once: every card in one grid, best first. */
function PackSummary({ opened, onDone }: { opened: Opened[]; onDone: () => void }) {
  const set = opened[0].set;
  const fresh = new Set(opened.flatMap((o) => o.fresh));
  const cards = opened.flatMap((o) => o.cards).sort((a, b) => RARITIES.indexOf(rarityIn(set, b)) - RARITIES.indexOf(rarityIn(set, a)));
  const shards = opened.reduce((t, o) => t + o.shards, 0);
  return (
    <Overlay>
      <div class="reveal summary">
        <p>
          <b>{opened.length} packs</b> of {shortSetName(set ?? '')}: {fresh.size} new card{fresh.size === 1 ? '' : 's'}
          {shards ? `, ${shards} shards from extra copies` : ''}.
        </p>
        <div class="binder">
          {cards.map((n, i) => (
            <span key={i} class={`bcard rv-up ${RCLASS[rarityIn(set, n)]}`}>
              <CardImg name={n} />
              <span class={`brar ${RCLASS[rarityIn(set, n)]}`}>{RARITY_SHORT[rarityIn(set, n)]}</span>
              {fresh.has(n) && <span class="bnew">NEW</span>}
            </span>
          ))}
        </div>
        <Menu items={[{ label: 'Done', onPick: onDone }]} />
      </div>
    </Overlay>
  );
}

function Grid({ save, names, onPick, empty, cost, note }: { save: SpeedSave; names: string[]; onPick: (n: string) => void; empty: string; cost?: boolean; note?: string }) {
  const [limit, setLimit] = useState(PAGE);
  return (
    <>
      <p class="hint">{names.length ? note ?? `${names.length} cards` : empty}</p>
      <div class="binder">
        {names.slice(0, limit).map((n) => (
          <button key={n} class={`bcard ${owned(save, n) ? '' : 'missing'}`} onClick={() => onPick(n)}>
            <CardImg name={n} />
            {owned(save, n) > 0 && <span class="bcount">×{owned(save, n)}</span>}
            <span class={`brar ${RCLASS[rarityOf(n)]}`}>{RARITY_SHORT[rarityOf(n)]}</span>
            {cost && (
              <span class={`bcost ${chipsOf(save) >= craftCost(n) ? '' : 'no'}`}>
                <i class="dchip" />
                {craftCost(n)}
              </span>
            )}
          </button>
        ))}
      </div>
      {names.length > limit && (
        <button class="gbtn more" onClick={() => setLimit(limit + PAGE)}>
          Show more ({names.length - limit} left)
        </button>
      )}
    </>
  );
}

function MyCards({ save, onSave, onPick }: { save: SpeedSave; onSave: (s: SpeedSave) => void; onPick: (n: string) => void }) {
  const [q, setQ] = useState('');
  const [sure, setSure] = useState(false);
  const [set, setSet] = useState<string>('');
  const sets = unlockedSets(save.wins);
  const pool = set ? [...new Set(setCards(set).map(([n]) => n))] : Object.keys(save.collection ?? {});
  const names = useMemo(() => sortForBinder(pool.filter((n) => card(n) && n.toLowerCase().includes(q.toLowerCase()))), [save, q, set]);
  const have = set ? names.filter((n) => owned(save, n) > 0).length : names.length;
  const spares = breakAllSpares(save);
  return (
    <div class="cardlist">
      <div class="filters">
        <input class="search" placeholder="Search name" value={q} onInput={(ev) => setQ((ev.target as HTMLInputElement).value)} />
        {spares && (
          <button class="chip" onClick={() => setSure(true)}>
            Break spares
          </button>
        )}
      </div>
      <div class="filters">
        <select class="search" value={set} onChange={(ev) => setSet((ev.target as HTMLSelectElement).value)}>
          <option value="">Every card I own</option>
          {sets.map((x) => (
            <option key={x.name} value={x.name}>
              {shortSetName(x.name)}
            </option>
          ))}
        </select>
      </div>
      <Grid save={save} names={names} onPick={onPick} empty="No cards yet. Open a pack!" note={set ? `${have}/${names.length} owned: tap a grey card to craft it` : undefined} />
      {sure && spares && (
        <Confirm
          title="Break all spares?"
          text={`${spares.copies} cop${spares.copies === 1 ? 'y' : 'ies'} no deck uses become ${spares.shards} shards. You keep at least one of every card.`}
          yes="Break them"
          onYes={() => (playBlip(), onSave(spares.save), setSure(false))}
          onNo={() => setSure(false)}
        />
      )}
    </div>
  );
}

function CraftList({ save, onPick }: { save: SpeedSave; onPick: (n: string) => void }) {
  const [q, setQ] = useState('');
  const [afford, setAfford] = useState(false);
  const [rar, setRar] = useState<Rarity | null>(null);
  const [every, setEvery] = useState(false);
  const inSets = useMemo(() => new Set(unlockedSets(save.wins).flatMap((x) => x.cards.map(([n]) => n))), [save.wins]);
  const all = useMemo(() => [...speedCards(), ...skillCards()].map((c) => c.name).filter((n) => !unplayableReason(n) || card(n)?.sub === 'Skill'), []);
  const names = all.filter(
    (n) =>
      owned(save, n) < (card(n)?.sub === 'Skill' ? 1 : COPIES) &&
      (!afford || chipsOf(save) >= craftCost(n)) &&
      (!rar || rarityOf(n) === rar) &&
      (every || inSets.has(n) || card(n)?.sub === 'Skill') &&
      (!q || n.toLowerCase().includes(q.toLowerCase())),
  );
  return (
    <div class="cardlist">
      <p class="hint">Craft any card the game can play. Common 1 chip, Rare 2, Super Rare 4, Ultra Rare and Skills 6, Secret Rare 8.</p>
      <div class="filters">
        <input class="search" placeholder="Search name" value={q} onInput={(ev) => setQ((ev.target as HTMLInputElement).value)} />
        <button class={`chip ${afford ? 'on' : ''}`} onClick={() => setAfford(!afford)}>
          Can afford
        </button>
        <button class={`chip ${every ? 'on' : ''}`} onClick={() => setEvery(!every)}>
          {every ? 'Every card' : 'My sets'}
        </button>
      </div>
      <div class="filters">
        {RARITIES.filter((r) => r !== 'Rare').map((r) => (
          <button key={r} class={`chip ${rar === r ? 'on' : ''}`} onClick={() => setRar(rar === r ? null : r)}>
            {RARITY_SHORT[r]}
          </button>
        ))}
      </div>
      <Grid save={save} names={[...names].sort((a, b) => RARITIES.indexOf(rarityOf(b)) - RARITIES.indexOf(rarityOf(a)) || a.localeCompare(b))} onPick={onPick} empty={afford ? 'Nothing you can afford yet.' : 'You own 3 of everything here!'} cost note={`${names.length} cards ${every ? 'in the game' : 'from the sets you have unlocked, plus Skills'}`} />
    </div>
  );
}

function Confirm({ title, text, yes, onYes, onNo }: { title: string; text: string; yes: string; onYes: () => void; onNo: () => void }) {
  return (
    <Overlay onClose={onNo}>
      <Win title={title} onClose={onNo}>
        <p>{text}</p>
        <Menu
          items={[
            { label: yes, onPick: onYes },
            { label: 'Cancel', onPick: onNo },
          ]}
        />
      </Win>
    </Overlay>
  );
}

function CardSheet({ save, name, onSave, onClose }: { save: SpeedSave; name: string; onSave: (s: SpeedSave) => void; onClose: () => void }) {
  const [info, setInfo] = useState(false);
  const [ask, setAsk] = useState<null | { title: string; text: string; yes: string; run: () => SpeedSave | null }>(null);
  const [done, setDone] = useState<string | null>(null);
  const have = owned(save, name);
  const used = copiesInDecks(save, name);
  const xp = cardLevels(save)[name] ?? 0;
  const t = tierIndex(xp);
  const r = rarityOf(name);
  const noCraft = cantCraft(save, name);
  const noLook = cantLookUp(save, name);
  const cost = craftCost(name);
  const nextLook = TIERS[Math.min(t + 1, TIERS.length - 1)].name;
  return (
    <Overlay onClose={onClose}>
      <Win title={name} onClose={onClose}>
        <div class="sheet">
          <span class={done ? 'crafted' : ''} key={done ?? ''}>
            <CardImg name={name} />
          </span>
          <div>
            <p>
              {r} · <span class="pips">{Array.from({ length: COPIES }, (_, i) => (i < have ? '●' : '○')).join('')}</span> you own {have}
              {used ? ` · your decks use ${used}` : ''}
            </p>
            {have > 0 && (
              <p>
                Look: <RarityChip xp={xp} /> {TIERS[t].name}
              </p>
            )}
            {done && <p class="good">{done}</p>}
          </div>
        </div>
        <Menu
          items={[
            {
              label: `Craft one · ${plural(cost, 'chip')}`,
              disabled: !!noCraft,
              note: noCraft ?? undefined,
              onPick: () => setAsk({ title: 'Craft it?', text: `Spend ${cost} of your ${chipsOf(save)} Duel Chips on ${name}?`, yes: `Craft · ${cost} chip${cost > 1 ? 's' : ''}`, run: () => craft(save, name) }),
            },
            ...(have > 0
              ? [
                  {
                    label: `Lift its look to ${nextLook} · ${LOOK_UP_COST} chips`,
                    disabled: !!noLook,
                    note: noLook ?? 'the look only, never its stats',
                    onPick: () => setAsk({ title: 'Lift its look?', text: `Spend ${LOOK_UP_COST} of your ${chipsOf(save)} Duel Chips to show ${name} as ${nextLook}? Its stats never change.`, yes: `Lift · ${LOOK_UP_COST} chips`, run: () => lookUp(save, name) }),
                  },
                  {
                    label: `Break a spare copy · +${plural(BREAK_SHARDS[r], 'shard')}`,
                    disabled: spareCopies(save, name) < 1 || have < 2,
                    note: have < 2 ? 'you only have one' : spareCopies(save, name) < 1 ? 'your decks use every copy' : undefined,
                    onPick: () => setAsk({ title: 'Break a copy?', text: `Break one ${name} into ${plural(BREAK_SHARDS[r], 'shard')}? You'll have ${have - 1} left.`, yes: 'Break it', run: () => breakCopy(save, name) }),
                  },
                ]
              : []),
            { label: 'Card Info', onPick: () => setInfo(true) },
          ]}
        />
      </Win>
      {ask && (
        <Confirm
          title={ask.title}
          text={ask.text}
          yes={ask.yes}
          onNo={() => setAsk(null)}
          onYes={() => {
            const next = ask.run();
            if (next) {
              playWin();
              buzz(40);
              onSave(next);
              setDone(ask.title === 'Craft it?' ? 'Crafted!' : ask.title === 'Lift its look?' ? 'Looking sharp!' : 'Broken into shards.');
            }
            setAsk(null);
          }}
        />
      )}
      {info && (
        <Overlay onClose={() => setInfo(false)}>
          <Win title="Card Info" onClose={() => setInfo(false)}>
            <CardInfoPanel name={name} />
          </Win>
        </Overlay>
      )}
    </Overlay>
  );
}
