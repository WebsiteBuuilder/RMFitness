// The Card Shop: open packs from the real Speed Duel sets, browse the cards you own,
// craft cards with Duel Chips, lift a card's look one rarity step, break spare copies.
import { useMemo, useState } from 'preact/hooks';
import { card, speedCards, skillCards } from '../eds/db';
import { CHIP_CAP, COPIES, owned, type SpeedSave } from '../eds/speedSave';
import { CardImg, CardInfoPanel } from '../ui/CardImg';
import { Menu, Overlay, Win } from '../ui/Window';
import { playBlip } from '../ui/sound';
import { RarityChip } from '../level/CardLevels';
import { TIERS, cardLevels, tierIndex } from '../level/leveling';
import {
  BREAK_SHARDS,
  LOOK_UP_COST,
  SHARDS_PER_CHIP,
  cantCraft,
  cantLookUp,
  chipsOf,
  copiesInDecks,
  craft,
  craftCost,
  breakCopy,
  lookUp,
  openOwnedPack,
  packsOf,
  shardsOf,
  sortForBinder,
  spareCopies,
  type Opened,
} from './economy';
import { RARITY_SHORT, WINS_PER_SET, boosterSets, rarityIn, rarityOf, shortSetName, unlockedSets } from './sets';
import './shop.css';

type Tab = 'packs' | 'binder' | 'craft';
const PAGE = 60;

export function ChipBar({ save }: { save: SpeedSave }) {
  return (
    <div class="shop-bar">
      <span class="shop-chip" title="Duel Chips">
        <i class="dchip" /> {chipsOf(save)}/{CHIP_CAP}
      </span>
      <span title="Shards: 10 make a Duel Chip">◆ {shardsOf(save)}/{SHARDS_PER_CHIP}</span>
      <span title="Unopened packs">🂠 {packsOf(save)}</span>
    </div>
  );
}

export function CardShop({ save, onSave, onBack }: { save: SpeedSave; onSave: (s: SpeedSave) => void; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>(packsOf(save) > 0 ? 'packs' : 'binder');
  const [opened, setOpened] = useState<Opened | null>(null);
  const [sel, setSel] = useState<string | null>(null);

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
      {tab === 'packs' && <Packs save={save} onOpen={(o) => (onSave(o.save), setOpened(o))} />}
      {tab === 'binder' && <Binder save={save} names={Object.keys(save.collection ?? {})} onPick={setSel} empty="No cards yet. Open a pack!" />}
      {tab === 'craft' && <CraftList save={save} onPick={setSel} />}
      {sel && <CardSheet save={save} name={sel} onSave={onSave} onClose={() => setSel(null)} />}
      {opened && (
        <PackReveal
          opened={opened}
          canAgain={packsOf(opened.save) > 0}
          onAgain={() => {
            const o = openOwnedPack(opened.save, opened.set!);
            if (o) (onSave(o.save), setOpened(o));
          }}
          onDone={() => setOpened(null)}
        />
      )}
    </div>
  );
}

function Packs({ save, onOpen }: { save: SpeedSave; onOpen: (o: Opened) => void }) {
  const all = boosterSets();
  const open = unlockedSets(save.wins);
  const nextIn = WINS_PER_SET - (save.wins % WINS_PER_SET);
  return (
    <div class="cardlist">
      <p class="hint">
        {packsOf(save) > 0 ? `You have ${packsOf(save)} pack${packsOf(save) === 1 ? '' : 's'} to open. Pick a set:` : 'No packs to open. Win them in duels: your first win against each computer duelist each day, up to 3 wins a day against your brother, and the campaign.'}
      </p>
      <div class="pack-grid">
        {all.map((s, i) => {
          const unlocked = i < open.length;
          return (
            <button
              key={s.name}
              class={`pack ${unlocked ? '' : 'locked'} p${i % 6}`}
              disabled={!unlocked || packsOf(save) < 1}
              onClick={() => {
                const o = openOwnedPack(save, s.name);
                if (o) onOpen(o);
              }}
            >
              <span class="pack-logo">SPEED DUEL</span>
              <span class="pack-name">{shortSetName(s.name)}</span>
              <span class="pack-note">{unlocked ? `${s.cards.length} cards` : i === open.length ? `unlocks in ${nextIn} win${nextIn === 1 ? '' : 's'}` : 'locked'}</span>
            </button>
          );
        })}
      </div>
      <p class="hint">A pack has 5 cards: 4 Commons and one Rare or better. A new set unlocks every {WINS_PER_SET} wins. Copies past 3 break into shards by themselves.</p>
    </div>
  );
}

const RCLASS: Record<string, string> = { Common: 'rc', Rare: 'rr', 'Super Rare': 'rsr', 'Ultra Rare': 'rur', 'Secret Rare': 'rscr' };

function PackReveal({ opened, canAgain, onAgain, onDone }: { opened: Opened; canAgain: boolean; onAgain: () => void; onDone: () => void }) {
  const [torn, setTorn] = useState(false);
  const [flipped, setFlipped] = useState<boolean[]>(() => opened.cards.map(() => false));
  const [info, setInfo] = useState<string | null>(null);
  const key = opened.cards.join('|') + opened.save.created + (opened.save as { packs?: number }).packs;
  const all = flipped.every(Boolean);
  const flip = (i: number) => {
    if (flipped[i]) return setInfo(opened.cards[i]);
    playBlip();
    setFlipped(flipped.map((f, j) => f || j === i));
  };
  return (
    <Overlay>
      <div class="reveal" key={key}>
        {!torn ? (
          <button class="pack big" onClick={() => (playBlip(), setTorn(true))}>
            <span class="pack-logo">SPEED DUEL</span>
            <span class="pack-name">{shortSetName(opened.set ?? '')}</span>
            <span class="pack-note">tap to open</span>
          </button>
        ) : (
          <>
            <div class="reveal-row">
              {opened.cards.map((n, i) => {
                const r = rarityIn(opened.set, n);
                return (
                  <button key={i} class={`rv ${flipped[i] ? 'up' : ''} ${RCLASS[r]}`} style={{ animationDelay: `${i * 90}ms` }} onClick={() => flip(i)}>
                    <span class="rv-in">
                      <span class="rv-back">
                        <CardImg name={n} back />
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
                  ? [...(canAgain ? [{ label: 'Open another', onPick: onAgain }] : []), { label: 'Done', onPick: onDone }]
                  : [{ label: 'Flip all', onPick: () => (playBlip(), setFlipped(opened.cards.map(() => true))) }]
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

function Binder({ save, names, onPick, empty }: { save: SpeedSave; names: string[]; onPick: (n: string) => void; empty: string }) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const list = useMemo(() => sortForBinder(names.filter((n) => card(n) && n.toLowerCase().includes(q.toLowerCase()))), [names, q]);
  return (
    <div class="cardlist">
      <div class="filters">
        <input class="search" placeholder="Search name" value={q} onInput={(ev) => (setQ((ev.target as HTMLInputElement).value), setLimit(PAGE))} />
      </div>
      <p class="hint">{list.length ? `${list.length} cards` : empty}</p>
      <div class="binder">
        {list.slice(0, limit).map((n) => (
          <button key={n} class="bcard" onClick={() => onPick(n)}>
            <CardImg name={n} />
            {owned(save, n) > 0 && <span class="bcount">×{owned(save, n)}</span>}
            <span class={`brar ${RCLASS[rarityOf(n)]}`}>{RARITY_SHORT[rarityOf(n)]}</span>
          </button>
        ))}
      </div>
      {list.length > limit && (
        <button class="gbtn more" onClick={() => setLimit(limit + PAGE)}>
          Show more ({list.length - limit} left)
        </button>
      )}
    </div>
  );
}

function CraftList({ save, onPick }: { save: SpeedSave; onPick: (n: string) => void }) {
  const names = useMemo(() => [...speedCards(), ...skillCards()].map((c) => c.name).filter((n) => owned(save, n) < (card(n)?.sub === 'Skill' ? 1 : COPIES)), [save]);
  return (
    <>
      <p class="hint shop-pad">
        Craft any Speed Duel card with Duel Chips: Common 1, Rare 2, Super Rare 4, Ultra Rare and Skills 6, Secret Rare 8. Chips come slowly: your first 3-star win on each campaign duel, Labyrinth bosses, one win over your brother a day, and shards.
      </p>
      <Binder save={save} names={names} onPick={onPick} empty="You own 3 of everything!" />
    </>
  );
}

function CardSheet({ save, name, onSave, onClose }: { save: SpeedSave; name: string; onSave: (s: SpeedSave) => void; onClose: () => void }) {
  const [info, setInfo] = useState(false);
  const have = owned(save, name);
  const used = copiesInDecks(save, name);
  const xp = cardLevels(save)[name] ?? 0;
  const t = tierIndex(xp);
  const r = rarityOf(name);
  const noCraft = cantCraft(save, name);
  const noLook = cantLookUp(save, name);
  const act = (next: SpeedSave | null) => next && (playBlip(), onSave(next));
  return (
    <Overlay onClose={onClose}>
      <Win title={name} onClose={onClose}>
        <div class="sheet">
          <CardImg name={name} />
          <div>
            <p>
              {r} · you own {have}
              {used ? ` · your decks use ${used}` : ''}
            </p>
            {have > 0 && (
              <p>
                Look: <RarityChip xp={xp} /> {TIERS[t].name}
              </p>
            )}
          </div>
        </div>
        <Menu
          items={[
            { label: `Craft one · ${craftCost(name)} Duel Chip${craftCost(name) > 1 ? 's' : ''}`, disabled: !!noCraft, note: noCraft ?? undefined, onPick: () => act(craft(save, name)) },
            ...(have > 0 ? [{ label: `Lift its look to ${TIERS[Math.min(t + 1, TIERS.length - 1)].name} · ${LOOK_UP_COST} chips`, disabled: !!noLook, note: noLook ?? 'the look only, never its stats', onPick: () => act(lookUp(save, name)) }] : []),
            ...(have > 0 ? [{ label: `Break a spare copy · +${BREAK_SHARDS[r]} shards`, disabled: spareCopies(save, name) < 1, note: spareCopies(save, name) < 1 ? 'your decks use every copy' : undefined, onPick: () => act(breakCopy(save, name)) }] : []),
            { label: 'Card Info', onPick: () => setInfo(true) },
          ]}
        />
      </Win>
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
