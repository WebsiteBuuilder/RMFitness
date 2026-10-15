// The random deck maker sheet in the deck editors: pick a style, a theme and a size, roll,
// look the deck over, roll again or use it. Works for Speed Duel decks (owned cards, or
// every card in an "Anything goes" deck) and the Eternal Duelist Soul deck.
import { useMemo, useState } from 'preact/hooks';
import { deckSplit, type RandomDeck, type RandomOptions, type RandomResult, type RandomStyle, type RandomTheme } from '../eds/randomDeck';
import { card } from '../eds/db';
import { CardImg } from './CardImg';
import { Overlay, Win } from './Window';
import { playBlip } from './sound';
import './randomdeck.css';

export type MakeOptions = Omit<RandomOptions, 'keep' | 'rand'> & { keepCards: boolean };

const STYLES: [RandomStyle, string][] = [
  ['balanced', 'Balanced'],
  ['beatdown', 'Beatdown'],
  ['control', 'Traps'],
];

const plural = (r: string) => (/(Fish|Psychic|Cyberse)$/.test(r) ? r : r.endsWith('y') ? r.slice(0, -1) + 'ies' : r + 's');

export function RandomDeckSheet({
  sizes,
  themes,
  make,
  hasCards,
  owned,
  onUse,
  onClose,
}: {
  /** Main Deck sizes offered (the first is picked) */
  sizes: number[];
  themes: (size: number) => { attributes: string[]; races: string[] };
  make: (o: MakeOptions) => RandomResult;
  /** the deck being edited already has cards (offers "keep them") */
  hasCards: boolean;
  /** decks from the duelist's own cards say so */
  owned: boolean;
  onUse: (d: RandomDeck) => void;
  onClose: () => void;
}) {
  const [style, setStyle] = useState<RandomStyle>('balanced');
  const [theme, setTheme] = useState<string>('surprise');
  const [size, setSize] = useState(sizes[0]);
  const [keep, setKeep] = useState(false);
  const [roll, setRoll] = useState<RandomResult | null>(null);
  const t = useMemo(() => themes(size), [size]);
  const themeOf = (): RandomTheme => {
    if (theme === 'any' || theme === 'surprise') return { kind: theme };
    const [kind, value] = theme.split(':');
    return kind === 'a' ? { kind: 'attribute', value } : { kind: 'race', value };
  };
  const go = () => {
    playBlip();
    setRoll(make({ size, style, theme: themeOf(), keepCards: keep }));
  };
  const deck = roll && !('error' in roll) ? roll : null;
  const split = deck ? deckSplit(deck.main) : null;
  const sorted = (l: string[]) => {
    const order = { monster: 0, spell: 1, trap: 2 } as Record<string, number>;
    return [...l].sort((a, b) => (order[card(a)?.kind ?? ''] ?? 3) - (order[card(b)?.kind ?? ''] ?? 3) || (card(b)?.level ?? 0) - (card(a)?.level ?? 0) || a.localeCompare(b));
  };

  return (
    <Overlay onClose={onClose}>
      <Win title="🎲 Random deck maker" onClose={onClose} class="rdm">
        {!deck ? (
          <>
            <p class="hint">{owned ? 'Builds a deck that can duel, from the cards you own.' : 'Builds a deck that can duel, from every card.'} You can roll as many times as you like.</p>
            <div class="rdm-row">
              <span>Style</span>
              <div class="rdm-chips">
                {STYLES.map(([s, l]) => (
                  <button key={s} class={`chip ${style === s ? 'on' : ''}`} onClick={() => setStyle(s)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <div class="rdm-row">
              <span>Theme</span>
              <select class="setpick" value={theme} onChange={(e) => setTheme((e.target as HTMLSelectElement).value)} aria-label="Theme">
                <option value="surprise">Surprise me</option>
                <option value="any">Mixed: the best cards</option>
                {t.attributes.length > 0 && (
                  <optgroup label="Attribute">
                    {t.attributes.map((a) => (
                      <option key={a} value={`a:${a}`}>
                        {a}
                      </option>
                    ))}
                  </optgroup>
                )}
                {t.races.length > 0 && (
                  <optgroup label="Type">
                    {t.races.map((r) => (
                      <option key={r} value={`r:${r}`}>
                        {plural(r)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
            {sizes.length > 1 && (
              <div class="rdm-row">
                <span>Cards</span>
                <div class="rdm-chips">
                  {sizes.map((n) => (
                    <button key={n} class={`chip ${size === n ? 'on' : ''}`} onClick={() => setSize(n)}>
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {hasCards && (
              <label class="rdm-keep">
                <input type="checkbox" checked={keep} onChange={(e) => setKeep((e.target as HTMLInputElement).checked)} />
                Keep the cards already in this deck and fill the rest
              </label>
            )}
            {roll && 'error' in roll && <div class="warn">{roll.error}</div>}
            <button class="gbtn rdm-go" onClick={go}>
              🎲 Roll a deck
            </button>
          </>
        ) : (
          <>
            <div class="rdm-head">
              <b>{deck.label}</b>
              <span>
                {deck.main.length} cards · {split!.monsters} monsters, {split!.spells} spells, {split!.traps} traps
                {deck.extra.length ? ` · ${deck.extra.length} Extra` : ''}
              </span>
              <span>Skill: {deck.skill ?? 'none'}</span>
              {deck.notes.map((n) => (
                <span key={n} class="hint">
                  {n}
                </span>
              ))}
            </div>
            <div class="grid small rdm-grid">
              {[...sorted(deck.main), ...deck.extra].map((n, i) => (
                <div key={i} class="gcard">
                  <CardImg name={n} />
                </div>
              ))}
            </div>
            <div class="rdm-actions">
              <button class="gbtn" onClick={go}>
                🎲 Roll again
              </button>
              <button class="gbtn gold" onClick={() => (playBlip(), onUse(deck))}>
                Use this deck
              </button>
            </div>
            <button class="chip rdm-back" onClick={() => setRoll(null)}>
              ‹ Change style or theme
            </button>
          </>
        )}
      </Win>
    </Overlay>
  );
}
