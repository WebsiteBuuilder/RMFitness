// The Shadow Realm page in the Speed Duel menu: the cards this profile has sealed
// away, the computer duelists' cards they sealed, and who was sent there lately.
// Each sealed card has the bail-out button: own up to it and the card comes back.
import { useEffect, useState } from 'preact/hooks';
import type { SpeedSave } from '../eds/speedSave';
import { CardImg } from '../ui/CardImg';
import { Win } from '../ui/Window';
import { bailoutsOf, MAX_SEALED, OVERKILL_MARGIN, releaseSealed, sealedCards, shadowLog, type SealedCard } from './shadow';
import { chime, swell } from './sfx';

const when = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function ShadowRealmScreen({ save, onSave, onBack }: { save: SpeedSave; onSave: (s: SpeedSave) => void; onBack: () => void }) {
  const mine = sealedCards(save);
  // the card(s) being begged for: a name, every card (null), or nobody (undefined)
  const [asking, setAsking] = useState<string | null | undefined>(undefined);
  const [freed, setFreed] = useState<string[]>([]);
  const begs = bailoutsOf(save);
  const confess = () => {
    const r = releaseSealed(save, asking ?? null);
    setAsking(undefined);
    if (!r.freed.length) return;
    swell(0.9);
    chime(0.7, 0.55);
    onSave(r.save);
    setFreed(r.freed);
  };
  const theirs = Object.entries((save as SpeedSave & { cpuSealed?: Record<string, SealedCard[]> }).cpuSealed ?? {}).filter(([, l]) => l.length);
  const log = shadowLog();
  return (
    <div class="screen">
      <Win title="Shadow Realm" onClose={onBack}>
        <p class="hint">
          Finish a duel with {OVERKILL_MARGIN.toLocaleString()} or more damage past 0 and the loser is sent to the Shadow Realm. Their strongest monster is sealed there and sits out every duel until they win one. Up to {MAX_SEALED} cards can be sealed at once.
        </p>
        <h3 class="sr-h">Your sealed cards</h3>
        {mine.length === 0 ? (
          <p class="hint">None. Keep it that way.</p>
        ) : (
          <div class="sr-cards">
            {mine.map((s, i) => (
              <div class="sr-card" key={s.name}>
                <CardImg name={s.name} />
                <span>
                  <b>{s.name}</b>
                  <br />
                  sealed by {s.by} · {when(s.at)}
                  {i === 0 ? <em> · freed by your next win</em> : null}
                  <br />
                  <button class="chip sr-beg" onClick={() => setAsking(s.name)}>
                    I'm wack, give me my monster back
                  </button>
                </span>
              </div>
            ))}
            {mine.length > 1 && (
              <button class="sr-beg-all" onClick={() => setAsking(null)}>
                I'm wack, give me all {mine.length} back
              </button>
            )}
          </div>
        )}
        {(mine.length > 0 || begs > 0) && <p class="hint sr-begs">{begs === 0 ? 'Win a duel to free one the proud way, or beg for it back right now.' : `You've begged ${begs} card${begs === 1 ? '' : 's'} back out of the Shadow Realm.`}</p>}
        {theirs.length > 0 && (
          <>
            <h3 class="sr-h">Cards you sealed from the computer</h3>
            {theirs.map(([who, list]) => (
              <p key={who}>
                <b>{who}</b>: {list.map((s) => s.name).join(', ')}
              </p>
            ))}
          </>
        )}
        <h3 class="sr-h">Sent to the Shadow Realm</h3>
        {log.length === 0 ? (
          <p class="hint">Nobody yet.</p>
        ) : (
          <ul class="log sr-log">
            {log.slice(0, 20).map((e) => (
              <li key={e.at}>
                <span class="lt">{when(e.at)}</span> <b>{e.loser}</b> by {e.winner} (+{e.excess}){e.card ? ` · lost ${e.card}` : ''}
              </li>
            ))}
          </ul>
        )}
      </Win>
      {asking !== undefined && <Confession names={asking === null ? mine.map((x) => x.name) : [asking]} onYes={confess} onNo={() => setAsking(undefined)} />}
      {freed.length > 0 && <Freed names={freed} onDone={() => setFreed([])} />}
    </div>
  );
}

/** The confession: say it, and the card is yours again. */
function Confession({ names, onYes, onNo }: { names: string[]; onYes: () => void; onNo: () => void }) {
  return (
    <div class="sr-sheet" onClick={onNo}>
      <div class="sr-sheet-in" onClick={(e) => e.stopPropagation()}>
        <div class="sr-sheet-cards">
          {names.map((n) => (
            <CardImg key={n} name={n} />
          ))}
        </div>
        <p class="sr-say">Say it with your chest:</p>
        <p class="sr-quote">"I'm wack. Give me my monster{names.length > 1 ? 's' : ''} back."</p>
        <p class="hint">{names.length > 1 ? `All ${names.length} cards come` : `${names[0]} comes`} straight back to your decks. Free, no duel needed. The Shadow Realm page remembers you begged.</p>
        <button class="sr-yes" onClick={onYes}>
          I'm wack 😩
        </button>
        <button class="chip" onClick={onNo}>
          Nah, I'll win {names.length > 1 ? 'them' : 'it'} back
        </button>
      </div>
    </div>
  );
}

/** The card climbing out of the Shadow Realm. */
function Freed({ names, onDone }: { names: string[]; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, []);
  return (
    <div class="sr-sheet sr-freed" onClick={onDone}>
      <div class="sr-freed-cards">
        {names.map((n, i) => (
          <div class="sr-rise" key={n} style={{ animationDelay: `${i * 0.15}s` }}>
            <CardImg name={n} />
          </div>
        ))}
      </div>
      <p class="sr-quote">{names.length > 1 ? `${names.length} monsters crawl` : `${names[0]} crawls`} out of the Shadow Realm</p>
      <p class="hint">Back in your decks for the next duel.</p>
    </div>
  );
}
