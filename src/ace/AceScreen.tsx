// The Ace page: pick the monster that is your Ace, see its bond (wins with it, what each level adds
// to its entrance) and watch the entrance in the 3D viewer at any bond level.
import { useMemo, useState } from 'preact/hooks';
import type { SpeedSave } from '../eds/speedSave';
import { activeDeck } from '../eds/speedSave';
import { card } from '../eds/db';
import { Win } from '../ui/Window';
import { CardImg } from '../ui/CardImg';
import { playBlip, playWin, unlockAudio } from '../ui/sound';
import { ArtLab } from '../art/ArtLab';
import { calloutFor } from '../art/callouts';
import { profileFor } from '../art/profile';
import { chosenMate } from '../mates/roster';
import { aceOf, aceWinsFor, BOND_LEVELS, bondLevel, bondTitle, MAX_BOND, nextBond, withAce } from './ace';
import './ace.css';

const isMonster = (n: string) => card(n)?.kind === 'monster';

export function AceScreen({ save, onSave, onBack }: { save: SpeedSave; onSave: (s: SpeedSave) => void; onBack: () => void }) {
  const ace = aceOf(save);
  const [q, setQ] = useState('');
  const [look, setLook] = useState<string | null>(ace?.name ?? null);
  const [watch, setWatch] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const deck = activeDeck(save);
  const inDeck = useMemo(() => new Set([...(deck?.main ?? []), ...(deck?.extra ?? [])]), [deck]);
  /** every monster this duelist owns: bonded ones first, then the ones in the deck, then by level and ATK */
  const mons = useMemo(() => {
    const names = Object.keys(save.collection ?? {}).filter((n) => (save.collection?.[n] ?? 0) > 0 && isMonster(n));
    const w = (n: string) => aceWinsFor(save, n);
    return names.sort((a, b) => w(b) - w(a) || Number(inDeck.has(b)) - Number(inDeck.has(a)) || (card(b)?.level ?? 0) - (card(a)?.level ?? 0) || (card(b)?.atk ?? 0) - (card(a)?.atk ?? 0) || a.localeCompare(b));
  }, [save.collection, save.aceWins, inDeck]);
  const shown = q.trim().length >= 2 ? mons.filter((n) => n.toLowerCase().includes(q.trim().toLowerCase())) : mons;

  const name = look ?? mons[0] ?? null;
  const wins = name ? aceWinsFor(save, name) : 0;
  const lv = bondLevel(wins);
  const nx = nextBond(wins);
  const isAce = !!ace && ace.name === name;
  const shout = name ? calloutFor(name, profileFor(card(name), name).attackName, true)?.text : null;

  if (watch && name) return <ArtLab initial={name} ace={{ lv, mate: chosenMate(save) }} onBack={() => setWatch(false)} />;

  const pick = (n: string) => {
    playBlip();
    setNote(null);
    setLook(n);
  };
  const make = () => {
    if (!name) return;
    unlockAudio();
    onSave(withAce(save, name));
    playWin();
    setNote(inDeck.has(name) ? `${name} is your Ace. Summon it in a duel to see its entrance.` : `${name} is your Ace. Put it in your deck to bring it to duels.`);
  };

  return (
    <div class="screen aces">
      <Win title="Ace Monster" onClose={onBack}>
        {!name ? (
          <p class="hint">You don't own any monsters yet. Open a pack in the Card Shop first.</p>
        ) : (
          <>
            <div class={`ac-hero lv${lv}`}>
              <div class="ac-card">
                <i class="ac-aura" />
                <CardImg name={name} />
              </div>
              <div class="ac-info">
                <b class="ac-name">{name}</b>
                <span class="ac-title">
                  ★ Bond {lv} · {bondTitle(lv)}
                </span>
                {shout && <span class="ac-shout">“{shout}”</span>}
                <div class="ac-meter" aria-label={nx ? `${wins} of ${nx.at} wins` : 'Top bond'}>
                  <i style={{ width: `${nx ? Math.round((100 * (wins - BOND_LEVELS[lv - 1].wins)) / (nx.at - BOND_LEVELS[lv - 1].wins)) : 100}%` }} />
                </div>
                <small>
                  {wins} {wins === 1 ? 'win' : 'wins'} as your Ace · {nx ? `${nx.need} more for ${bondTitle(nx.lv)}` : 'the highest bond'}
                </small>
                {!inDeck.has(name) && <small class="ac-warn">Not in your deck ({deck?.name ?? 'none'})</small>}
              </div>
            </div>
            <div class="ac-act">
              {isAce ? <span class="ac-is">★ Your Ace</span> : <button class="gbtn ac-go" onClick={make}>Make {name} your Ace</button>}
              <button class="gbtn" onClick={() => (unlockAudio(), playBlip(), setWatch(true))}>
                Watch its entrance
              </button>
              {isAce && (
                <button class="gbtn ac-off" onClick={() => (onSave(withAce(save, null)), setNote('No Ace for now.'))}>
                  No Ace
                </button>
              )}
              {note && <span class="ac-note">{note}</span>}
            </div>
            <ol class="ac-levels">
              {BOND_LEVELS.map((b) => (
                <li key={b.lv} class={b.lv <= lv ? 'got' : ''}>
                  <b>{b.lv <= lv ? '★' : '☆'} {b.title}</b>
                  <span>{b.wins ? `${b.wins} wins` : 'From the start'}</span>
                  <small>{b.adds}</small>
                </li>
              ))}
            </ol>
            <input class="ac-q" placeholder="Find one of your monsters…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
            <div class="ac-grid">
              {shown.slice(0, 120).map((n) => {
                const w = aceWinsFor(save, n);
                return (
                  <button key={n} class={`ac-pick ${n === name ? 'on' : ''} ${ace?.name === n ? 'ace' : ''}`} onClick={() => pick(n)} aria-label={n}>
                    <CardImg name={n} />
                    {ace?.name === n ? <i class="ac-tag">★ ACE</i> : w > 0 ? <i class="ac-tag dim">{w}W</i> : null}
                    {inDeck.has(n) && <i class="ac-dot" title="In your deck" />}
                  </button>
                );
              })}
            </div>
            {shown.length > 120 && <p class="hint">Showing 120 of {shown.length}. Search to find the rest.</p>}
          </>
        )}
        <p class="ac-foot">
          Just for show: an Ace never changes a duel and pays nothing. Wins with it in your deck grow its bond (up to {MAX_BOND}) in Road, Labyrinth, Legends, Ranked, computer and online duels. Practice and Anything goes decks don't count.
        </p>
      </Win>
    </div>
  );
}
