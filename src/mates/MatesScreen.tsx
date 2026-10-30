// The Mates page: every Mate, the one you take to duels, and buying the rest with Duel Chips
// (some are earned instead: wins, Duel School). Tap the big one to see it react.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SpeedSave } from '../eds/speedSave';
import { Win } from '../ui/Window';
import { ConfirmSheet } from '../ui/ConfirmSheet';
import { chipsOf } from '../collection/economy';
import { playBlip, playMate, playWin, unlockAudio } from '../ui/sound';
import { MateArt } from './MateArt';
import { buyMate, cantBuy, chosenMate, costNote, EMOTES, hasMate, MATES, mateDef, pickMate, type MateId, type MateReact } from './roster';
import { REACT_SPEC, tapReact } from './react';
import './mates.css';

export function MatesScreen({ save, onSave, onBack }: { save: SpeedSave; onSave: (s: SpeedSave) => void; onBack: () => void }) {
  const current = chosenMate(save);
  const [look, setLook] = useState<MateId>(current);
  const [act, setAct] = useState<{ react: MateReact | null; key: number }>({ react: 'wave', key: 1 });
  const [buying, setBuying] = useState<MateId | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const last = useRef<MateReact | null>(null);
  const timer = useRef(0);
  const def = mateDef(look)!;
  const owned = hasMate(save, look);

  const show = (r: MateReact) => {
    unlockAudio();
    clearTimeout(timer.current);
    setAct((a) => ({ react: r, key: a.key + 1 }));
    playMate(def.voice, r === 'sad' || r === 'hurt' ? 'down' : r === 'sleep' ? 'flat' : 'up');
    timer.current = window.setTimeout(() => setAct((a) => ({ react: null, key: a.key })), REACT_SPEC[r].ms || 1400);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const pick = (id: MateId) => {
    playBlip();
    setNote(null);
    setLook(id);
    clearTimeout(timer.current);
    setAct((a) => ({ react: 'hop', key: a.key + 1 }));
    timer.current = window.setTimeout(() => setAct((a) => ({ react: null, key: a.key })), 800);
  };
  const take = () => {
    const next = pickMate(save, look);
    if (!next) return;
    onSave(next);
    show('cheer');
    setNote(`${def.name} will stand beside your field in Speed Duels.`);
  };
  const buy = () => {
    const id = buying;
    setBuying(null);
    const next = id && buyMate(save, id);
    if (!next) return;
    // (bought mates come along straight away)
    onSave(pickMate(next, id) ?? next);
    playWin();
    show('cheer');
    setNote(`${mateDef(id)!.name} is yours, and comes to your duels now.`);
  };
  const why = cantBuy(save, look);
  const price = 'chips' in def.cost ? def.cost.chips : 0;
  const spec = act.react ? REACT_SPEC[act.react] : null;

  return (
    <div class="screen mates">
      <Win title="Mates" onClose={onBack}>
        <div class="mt-stage">
          <button class="mt-big" aria-label={`${def.name}: tap to see it react`} onClick={() => show(tapReact(def.taps, last.current, Math.random()))}>
            <i class="mt-floor" />
            <div key={act.key} class={`mate-act ${act.react ? `r-${act.react}` : 'r-idle'}`}>
              <MateArt id={look} face={spec?.face ?? 'idle'} />
            </div>
          </button>
          <div class="mt-info">
            <b>{def.name}</b>
            <p>{def.blurb}</p>
            <span class={`mt-cost ${owned ? 'own' : ''}`}>{look === current ? '★ With you in duels' : owned ? 'Yours' : costNote(save, def)}</span>
          </div>
        </div>
        <div class="mt-emotes" role="group" aria-label="Try its reactions">
          {EMOTES.map((e) => (
            <button key={e.react} class="mt-try" onClick={() => show(e.react)}>
              {e.label}
            </button>
          ))}
        </div>
        <div class="mt-act">
          {look === current ? (
            <span class="mt-hint">In a duel: tap your Mate to make it react, hold it for these emotes. Your opponent sees them too.</span>
          ) : owned ? (
            <button class="gbtn mt-go" onClick={take}>
              Take {def.name} to duels
            </button>
          ) : price ? (
            <button class="gbtn mt-go" disabled={!!why} onClick={() => (playBlip(), setBuying(look))}>
              {why && chipsOf(save) < price ? `${price} Duel Chips · you have ${chipsOf(save)}` : `Get for ${price} Duel Chips`}
            </button>
          ) : (
            <span class="mt-hint">🔒 {costNote(save, def)} to unlock.</span>
          )}
          {note && <span class="mt-note">{note}</span>}
        </div>

        <div class="mt-grid">
          {MATES.map((m) => {
            const has = hasMate(save, m.id);
            return (
              <button key={m.id} class={`mt-card ${look === m.id ? 'on' : ''} ${has ? '' : 'locked'}`} onClick={() => pick(m.id)}>
                <span class="mt-pic">
                  <MateArt id={m.id} />
                </span>
                <b>{m.name}</b>
                <small>{m.id === current ? '★ With you' : has ? 'Yours' : 'chips' in m.cost ? `${m.cost.chips} chips` : '🔒 Earn'}</small>
              </button>
            );
          })}
        </div>
        <p class="mt-foot">Mates are just for fun: they never change a duel. You have {chipsOf(save)} Duel Chips.</p>
      </Win>
      {buying && (
        <ConfirmSheet look="md" title={`Get ${mateDef(buying)!.name}?`} confirmLabel={`Spend ${price} Duel Chips`} onConfirm={buy} onCancel={() => setBuying(null)}>
          You have {chipsOf(save)} Duel Chips. {mateDef(buying)!.name} joins your Mates for good.
        </ConfirmSheet>
      )}
    </div>
  );
}
