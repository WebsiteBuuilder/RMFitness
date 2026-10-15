// The Speed Duel home screen, laid out like Master Duel: a slim top bar, one calm page per tab
// (Duel, Solo, Deck, Shop, Duelist) and a tab bar along the bottom. Every screen the old
// one-long-list menu reached is still one or two taps away; Speed.tsx owns those screens.
import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { card, imageUrl } from '../eds/db';
import { CONTROL_NAMES, type ControlStyle, type Profile } from '../eds/save';
import type { SpeedDeck, SpeedSave } from '../eds/speedSave';
import type { SealedCard } from '../art/shadow';
import { CardImg } from './CardImg';
import { Avatar } from './Profiles';
import { Menu, Overlay, Win } from './Window';
import { playBlip } from './sound';
import { ChipBar } from '../collection/Shop';
import { chipsOf, packsOf, type Rival } from '../collection/economy';
import { stampsToClaim } from '../collection/stamps';
import { online } from '../online/controller';
import './speedhome.css';

export type HomeTab = 'duel' | 'solo' | 'deck' | 'shop' | 'me';

/** The screens a home tile opens (the hub's sub-screens, plus the modes App runs). */
export type HomeGo = 'decks' | 'cpu' | 'record' | 'rankings' | 'link' | 'shadow' | 'art' | 'levels' | 'shop' | 'requests' | 'stamps';

/** The tab the player was on, kept across duels so they come back where they left. */
let lastTab: HomeTab = 'duel';
export function rememberedTab(): HomeTab {
  return lastTab;
}

/** The deck's strongest monster: its picture fronts the deck on the home screen. */
export function deckAce(deck: SpeedDeck | null | undefined): string | null {
  if (!deck) return null;
  let best: string | null = null;
  let atk = -1;
  for (const n of [...deck.main, ...deck.extra]) {
    const a = card(n)?.atk;
    if (a !== undefined && a > atk) (best = n), (atk = a);
  }
  return best ?? deck.main[0] ?? null;
}

const TABS: { id: HomeTab; label: string; icon: ComponentChildren }[] = [
  {
    id: 'duel',
    label: 'Duel',
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M4 3l7.5 7.5M3.5 3H7v.5M20 3l-7.5 7.5M20.5 3H17v.5M6.5 14.5l-3 3 3 3 3-3M17.5 14.5l3 3-3 3-3-3M8 13l8-8M16 13L8 5" />
      </svg>
    ),
  },
  {
    id: 'solo',
    label: 'Solo',
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M12 6c-2-1.5-5-2-8-1.5v14c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-14c-3-.5-6 0-8 1.5zM12 6v14" />
      </svg>
    ),
  },
  {
    id: 'deck',
    label: 'Deck',
    icon: (
      <svg viewBox="0 0 24 24">
        <rect x="8" y="3" width="11" height="15" rx="1.5" />
        <path d="M5.5 6.5V20a1 1 0 001 1H16" />
      </svg>
    ),
  },
  {
    id: 'shop',
    label: 'Shop',
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M5 8h14l-1 12H6L5 8zM9 8V6a3 3 0 016 0v2" />
      </svg>
    ),
  },
  {
    id: 'me',
    label: 'Duelist',
    icon: (
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c1-4.5 4-6.5 8-6.5s7 2 8 6.5" />
      </svg>
    ),
  },
];

/** A big picture button: card art behind a title, like Master Duel's mode banners. */
function Tile({ art, title, sub, badge, hot, size = 'big', fy, onPick }: { art: string; title: string; sub?: string; badge?: string | number | null; hot?: boolean; size?: 'hero' | 'big' | 'half'; fy?: number; onPick: () => void }) {
  const url = imageUrl(art);
  return (
    <button class={`sdh-tile ${size} ${hot ? 'hot' : ''}`} onClick={() => (playBlip(), onPick())}>
      <span class="sdh-tile-art" style={url ? { backgroundImage: `url("${url}")`, backgroundPositionY: `${fy ?? 36}%` } : undefined} />
      <span class="sdh-tile-txt">
        <b>{title}</b>
        {sub && <small>{sub}</small>}
      </span>
      {badge !== undefined && badge !== null && badge !== 0 && badge !== '' && <i class="sdh-badge">{badge}</i>}
      <span class="sdh-tile-go">›</span>
    </button>
  );
}

/** A plain list row for things that don't need a picture. */
function Row({ label, note, badge, onPick }: { label: string; note?: string; badge?: string | number | null; onPick: () => void }) {
  return (
    <button class="sdh-row" onClick={() => (playBlip(), onPick())}>
      <span class="sdh-row-l">{label}</span>
      {note && <span class="sdh-row-n">{note}</span>}
      {badge ? <i class="sdh-badge inline">{badge}</i> : null}
      <span class="sdh-row-go">›</span>
    </button>
  );
}

export function SpeedHome({
  tab,
  onTab,
  profile,
  save,
  deck,
  problems,
  sealed,
  headline,
  crown,
  requestsNote,
  controls,
  onControls,
  onSolo,
  onTag,
  onExit,
  go,
  cpus,
}: {
  tab: HomeTab;
  onTab: (t: HomeTab) => void;
  profile: Profile;
  save: SpeedSave;
  deck: SpeedDeck | null | undefined;
  problems: string[];
  sealed: SealedCard[];
  headline: string | null;
  crown: { rival: string; rec: Rival } | null;
  requestsNote: string;
  controls: ControlStyle;
  onControls: () => void;
  onSolo: (mode: 'campaign' | 'labyrinth' | 'practice' | 'legends') => void;
  onTag?: () => void;
  onExit: () => void;
  go: (to: HomeGo) => void;
  /** computer duelists' record names, for the chip help's "still to win today" */
  cpus: string[];
}) {
  const [settings, setSettings] = useState(false);
  const [rules, setRules] = useState(false);
  lastTab = tab;
  // Lift the floating Friends button above the tab bar while the home screen is up.
  useEffect(() => {
    document.documentElement.classList.add('sd-home');
    return () => document.documentElement.classList.remove('sd-home');
  }, []);

  const packs = packsOf(save);
  const stamps = stampsToClaim(save);
  const ace = deckAce(deck);
  const shopBadge = packs + stamps || null;
  const badges: Partial<Record<HomeTab, string | number | null>> = {
    deck: problems.length ? '!' : null,
    shop: shopBadge,
    me: sealed.length || null,
  };
  const pick = (t: HomeTab) => {
    if (t === tab) return;
    playBlip();
    onTab(t);
  };

  return (
    <div class="sdh">
      <header class="sdh-top">
        <button class="sdh-who" onClick={() => (playBlip(), onTab('me'))} aria-label="Your duelist page">
          <Avatar p={profile} size="small" />
          <span class="sdh-who-txt">
            <b>
              {profile.alias}
              {crown && <span class={`crown ${crown.rec.streak >= 3 ? 'hot' : ''}`}> 👑</span>}
            </b>
            <small>
              {save.wins}W · {save.losses}L{save.draws ? ` · ${save.draws}D` : ''}
            </small>
          </span>
        </button>
        <div class="sdh-cash">
          <ChipBar save={save} cpus={cpus} compact />
        </div>
        <button class="sdh-gear" onClick={() => (playBlip(), setSettings(true))} aria-label="Settings">
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
          </svg>
        </button>
      </header>

      <main class="sdh-page" key={tab}>
        {tab === 'duel' && (
          <>
            <button class="sdh-deck" onClick={() => (playBlip(), go('decks'))}>
              <span class="sdh-deck-pic">{ace ? <CardImg name={ace} /> : <span class="cimg cback" />}</span>
              <span class="sdh-deck-txt">
                <small>Active deck</small>
                <b>{deck ? deck.name : 'No deck yet'}</b>
                <span>
                  {deck ? `${deck.main.length} cards` : 'Pick a deck to duel'}
                  {deck?.skill ? ` · ${deck.skill}` : ''}
                </span>
                {crown && (
                  <span class="sdh-crown">
                    👑 King of Games over {crown.rival} ({crown.rec.w}-{crown.rec.l})
                  </span>
                )}
              </span>
              <span class="sdh-tile-go">›</span>
            </button>

            {problems.length > 0 && (
              <button class="sdh-note bad" onClick={() => (playBlip(), go('decks'))}>
                <span>Deck not ready: {problems[0]}</span>
                <b>Fix ›</b>
              </button>
            )}
            {sealed.length > 0 && (
              <div class="sdh-note bad">
                <span>
                  {sealed.map((x) => x.name).join(', ')} {sealed.length === 1 ? 'is' : 'are'} sealed in the Shadow Realm. Win a duel to free {sealed.length === 1 ? 'it' : 'one'}, or
                </span>
                <button class="chip" onClick={() => (playBlip(), go('shadow'))}>
                  beg for {sealed.length === 1 ? 'it' : 'them'} back
                </button>
              </div>
            )}
            {headline && (
              <button class="sdh-note gold" onClick={() => (playBlip(), go('levels'))}>
                <span>★ {headline}</span>
                <b>See ›</b>
              </button>
            )}

            <Tile size="hero" art="Dark Magician" fy={30} title="Link Battle" sub="Duel your brother online or on one phone" onPick={() => go('link')} />
            <div class="sdh-pair">
              <Tile size="half" art="Blue-Eyes White Dragon" title="VS Computer" sub="Counts for your record" onPick={() => go('cpu')} />
              {onTag && <Tile size="half" art="Harpie Lady Sisters" title="Tag Duel" sub="2v2 and Tag Road" onPick={onTag} />}
            </div>
            <button class="sdh-friends" onClick={() => (playBlip(), online.openPanel())}>
              👥 Friends <span>see who's online and invite them</span>
            </button>
          </>
        )}

        {tab === 'solo' && (
          <>
            <h2 class="sdh-h">Solo</h2>
            <Tile art="Obelisk the Tormentor" fy={30} title="The Millennium Road" sub="Story campaign: earn cards, beat the bosses" onPick={() => onSolo('campaign')} />
            <Tile art="Dark Magician Girl" fy={30} title="Card Legends" sub="Stories told by the cards: earn Duel Chips" onPick={() => onSolo('legends')} />
            <Tile art="Labyrinth Wall" title="Duel Labyrinth" sub="Roguelite runs, a new map every time" onPick={() => onSolo('labyrinth')} />
            <Tile art="Kuriboh" title="Practice Duel" sub="Any deck vs any duelist, no record" onPick={() => onSolo('practice')} />
          </>
        )}

        {tab === 'deck' && (
          <>
            <h2 class="sdh-h">Deck</h2>
            <Tile art={ace ?? 'Celtic Guardian'} fy={30} title="Decks" sub={`${save.decks.length} deck${save.decks.length === 1 ? '' : 's'} · build and edit`} badge={problems.length ? '!' : null} onPick={() => go('decks')} />
            <Tile art="Cyber Dragon" title="Card Levels" sub="Cards rank up N → R → SR → UR as you duel" onPick={() => go('levels')} />
            <Tile art="Summoned Skull" fy={30} title="3D Card Viewer" sub="Watch any card's summon and attack" onPick={() => go('art')} />
          </>
        )}

        {tab === 'shop' && (
          <>
            <h2 class="sdh-h">Shop</h2>
            <Tile art="Jar of Greed" title="Card Shop" sub={packs ? `${packs} pack${packs === 1 ? '' : 's'} to open!` : `Packs, your cards, crafting · ${chipsOf(save)} Duel Chips`} badge={packs || null} hot={packs > 0} onPick={() => go('shop')} />
            <div class="sdh-pair">
              <Tile size="half" art="Time Wizard" title="Requests" sub={requestsNote} onPick={() => go('requests')} />
              <Tile size="half" art="Monster Reborn" title="Set Stamps" sub={stamps ? `${stamps} to claim!` : 'Collect a set, earn its rewards'} badge={stamps || null} hot={stamps > 0} onPick={() => go('stamps')} />
            </div>
          </>
        )}

        {tab === 'me' && (
          <>
            <div class="sdh-card">
              <Avatar p={profile} size="big" />
              <div>
                <b>{profile.alias}</b>
                <span>
                  {save.wins} wins · {save.losses} losses · {save.draws} draws
                </span>
                {crown && <span class="sdh-crown">👑 King of Games over {crown.rival}</span>}
              </div>
            </div>
            <Tile art="Slifer the Sky Dragon" fy={28} title="Duelist Rankings" sub="Leaderboard, rivals and titles" onPick={() => go('rankings')} />
            <Tile art="Relinquished" title="Shadow Realm" sub={sealed.length ? `${sealed.length} of your cards sealed` : 'Who got sent there'} badge={sealed.length || null} hot={sealed.length > 0} onPick={() => go('shadow')} />
            <div class="sdh-list">
              <Row label="Record" note="wins and losses by opponent" onPick={() => go('record')} />
            </div>
          </>
        )}
      </main>

      <nav class="sdh-tabs">
        {TABS.map((t) => (
          <button key={t.id} class={`sdh-tab ${tab === t.id ? 'on' : ''}`} onClick={() => pick(t.id)} aria-label={t.label}>
            {t.icon}
            <span>{t.label}</span>
            {badges[t.id] ? <i class={`sdh-dot ${t.id === 'shop' ? 'gold' : ''}`}>{badges[t.id]}</i> : null}
          </button>
        ))}
      </nav>

      {settings && (
        <Overlay onClose={() => setSettings(false)}>
          <Win title="Settings" onClose={() => setSettings(false)}>
            <Menu
              items={[
                { label: `Controls: ${CONTROL_NAMES[controls]}`, note: controls === 'touch' ? 'tap and drag, like Master Duel' : 'menu window, like the GBA game', onPick: onControls },
                { label: 'Speed Duel rules', onPick: () => (setSettings(false), setRules(true)) },
                { label: 'Back to Eternal Duelist Soul', onPick: onExit },
              ]}
            />
          </Win>
        </Overlay>
      )}
      {rules && (
        <Overlay onClose={() => setRules(false)}>
          <Win title="Speed Duel rules" onClose={() => setRules(false)}>
            <p>Speed Duel cards only. 4000 LP, 4-card hands, 3 Monster and 3 Spell/Trap Zones, no Main Phase 2, and one Skill per Duel.</p>
            <Menu items={[{ label: 'OK', onPick: () => setRules(false) }]} />
          </Win>
        </Overlay>
      )}
    </div>
  );
}
