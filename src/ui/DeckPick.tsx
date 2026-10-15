// Choosing which deck to duel with, right before a duel: a deck line with a Change button
// and the list of decks to pick from. The menu screens (VS Computer, Link Battle) use the
// window style; the solo screens use SoloDeckPick in Solo.tsx.
import { useState } from 'preact/hooks';
import type { SpeedDeck } from '../eds/speedSave';
import { Menu, Overlay, Win } from './Window';
import { playBlip } from './sound';
import './deckpick.css';

export const deckSummary = (d: SpeedDeck) => `${d.main.length}${d.extra.length ? `+${d.extra.length}` : ''} cards · ${d.skill?.replace(/ \(Skill Card\)$/, '') ?? 'no Skill'}`;

/** The deck line above a duel menu: the deck you'll duel with and a Change button (window style). */
export function DeckSwitch({ decks, current, problemsOf, onPick, onManage }: { decks: SpeedDeck[]; current: SpeedDeck | null; problemsOf: (d: SpeedDeck) => string[]; onPick: (d: SpeedDeck) => void; onManage?: () => void }) {
  const [open, setOpen] = useState(false);
  const bad = current ? problemsOf(current) : ['No deck yet'];
  return (
    <>
      <button class="dp-line" onClick={() => (playBlip(), setOpen(true))}>
        <span class="dp-line-t">
          <small>Duel with</small>
          <b>
            {current?.name ?? 'No deck'}
            {current?.open ? ' · Anything goes' : ''}
          </b>
          <span class={bad.length ? 'dp-bad' : 'dp-good'}>{bad.length ? bad[0] : deckSummary(current!)}</span>
        </span>
        <span class="dp-change">Change ▾</span>
      </button>
      {open && (
        <DeckMenu
          decks={decks}
          current={current}
          problemsOf={problemsOf}
          onPick={(d) => (onPick(d), setOpen(false))}
          onManage={onManage}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** The list of decks to duel with (window style). */
export function DeckMenu({ decks, current, problemsOf, onPick, onManage, onClose }: { decks: SpeedDeck[]; current: SpeedDeck | null; problemsOf: (d: SpeedDeck) => string[]; onPick: (d: SpeedDeck) => void; onManage?: () => void; onClose: () => void }) {
  return (
    <Overlay onClose={onClose}>
      <Win title="Duel with which deck?" onClose={onClose} class="dp-win">
        <Menu
          class="scroll"
          items={[
            ...decks.map((d) => {
              const bad = problemsOf(d);
              return { label: `${d.id === current?.id ? '★ ' : ''}${d.name}${d.open ? ' · Anything goes' : ''}`, note: bad.length ? `not ready: ${bad[0]}` : deckSummary(d), selected: d.id === current?.id, onPick: () => (playBlip(), onPick(d)) };
            }),
            ...(onManage ? [{ label: 'Build and edit decks ›', onPick: () => (onClose(), onManage()) }] : []),
          ]}
        />
        {decks.some((d) => d.open) && <p class="hint">Anything goes decks earn nothing and can't be bet.</p>}
      </Win>
    </Overlay>
  );
}
