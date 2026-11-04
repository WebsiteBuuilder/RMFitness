// The Duelist Room: the home hub at the top of the Duel tab, like Master Duel's home screen.
// Your Ace stands at the back of the room in a pool of light, your Mate wanders the floor, your
// deck box sits on the table in your sleeve, trophies line the shelf and today's Duelist Requests
// are pinned to the board. Everything in it is a button to the screen it shows, so the room adds
// shortcuts and takes none away (the tiles under it are unchanged). Cosmetic and navigation only.
//
// Cheap on a mid-range phone: static gradients plus three always-on animations (the Ace's float,
// the Mate's walk, the light's breath), all transform/opacity only, and they pause whenever the
// room scrolls out of sight. No WebGL, no canvas: the Ace is the card art cut out by its figure
// matte (public/cards/fig), the same picture the cards already load.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { imageUrl } from '../../eds/db';
import type { SpeedDeck, SpeedSave } from '../../eds/speedSave';
import type { Profile } from '../../eds/save';
import { loadSolo } from '../../eds/speedCampaign/save';
import { CardImg } from '../CardImg';
import { playBlip } from '../sound';
import { figUrl, useFigs } from '../../level/figs';
import { MateArt, type Face } from '../../mates/MateArt';
import { chosenMate, mateDef } from '../../mates/roster';
import { chosenSleeve } from '../../sleeves/sleeves';
import { bondTitle } from '../../ace/ace';
import { packsOf } from '../../collection/economy';
import { RankEmblem } from '../RankBadge';
import { boardNotes, roomAce, trophiesOf, type Trophy } from './roomData';
import './room.css';

export type RoomGo = 'ace' | 'mates' | 'decks' | 'shop' | 'requests' | 'rankings';

/** A spot for the Duel Pass (its own thread wires it in): a poster on the wall. */
export interface RoomPass {
  /** the tier or short status, e.g. "Tier 12" */
  note: string;
  /** rewards waiting to be claimed (the poster glows) */
  ready?: number;
  onOpen: () => void;
}

/** One thing in the room you can tap: a real button with a name tag under it. */
function Spot({ cls, tag, hot, label, onPick, children }: { cls: string; tag?: ComponentChildren; hot?: boolean; label: string; onPick: () => void; children: ComponentChildren }) {
  return (
    <button class={`sdr-spot ${cls} ${hot ? 'hot' : ''}`} aria-label={label} onClick={() => (playBlip(), onPick())}>
      {children}
      {tag && <span class="sdr-tag">{tag}</span>}
    </button>
  );
}

function TrophyArt({ t }: { t: Trophy }) {
  switch (t.kind) {
    case 'rank':
      return (
        <span class="sdr-tro rank" title={t.label}>
          <RankEmblem step={t.step} size="s" asc={t.asc} level={t.level} />
        </span>
      );
    case 'cup':
      return (
        <span class={`sdr-tro cup ${t.metal}`} title={t.label}>
          <i class="sdr-cup" />
          <b>{t.wins > 999 ? '999+' : t.wins}</b>
        </span>
      );
    case 'crown':
      return (
        <span class="sdr-tro crown" title={t.label}>
          👑
        </span>
      );
    case 'bond':
      return (
        <span class={`sdr-tro bond b${t.lv}`} title={t.label}>
          <i>★</i>
        </span>
      );
    case 'school':
      return <span class="sdr-tro school" title={t.label} />;
  }
}

/** The Ace: the card art cut out by its figure matte, standing in its light. */
function AceFigure({ name, lv }: { name: string; lv: number }) {
  useFigs(true);
  const fig = figUrl(name);
  const url = imageUrl(name);
  return (
    <span class={`sdr-acefig b${lv}`}>
      <i class="sdr-pillar" />
      <i class="sdr-pedestal" />
      {fig && url ? (
        <i class="sdr-cut" style={{ '--sdr-img': `url("${url}")`, '--sdr-fig': `url("${fig}")` } as Record<string, string>} />
      ) : (
        <span class="sdr-holo">
          <CardImg name={name} />
        </span>
      )}
    </span>
  );
}

export function DuelistRoom({ profile, save, deck, deckAce, pass, go, onDeck }: { profile: Profile; save: SpeedSave; deck: SpeedDeck | null | undefined; deckAce: string | null; pass?: RoomPass; go: (to: RoomGo) => void; onDeck: () => void }) {
  const solo = useMemo(() => loadSolo(profile.id), [profile.id, save]);
  const trophies = useMemo(() => trophiesOf(save, solo), [save, solo]);
  const board = useMemo(() => boardNotes(save), [save]);
  const ace = roomAce(save, deckAce);
  const mate = chosenMate(save);
  const sleeve = chosenSleeve(save, solo);
  const packs = packsOf(save);
  const lv = ace?.ace?.lv ?? 0;

  // Pause the room's animations while it's scrolled away (or the tab is behind another app).
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The Mate reacts now and then: a smile, a wave, a yawn. One timer, nothing per frame.
  const [face, setFace] = useState<Face>('idle');
  useEffect(() => {
    if (!seen) return;
    const faces: Face[] = ['happy', 'idle', 'wow', 'idle', 'love', 'idle', 'smirk', 'sleep'];
    let i = 0;
    const t = setInterval(() => setFace(faces[i++ % faces.length]), 3800);
    return () => clearInterval(t);
  }, [seen]);

  return (
    <div ref={ref} class={`sdr ${seen ? '' : 'off'}`} role="group" aria-label={`${profile.alias}'s Duelist Room`}>
      <div class="sdr-walls" aria-hidden="true">
        <i class="sdr-window" />
        <i class="sdr-light" />
        <i class="sdr-floor" />
        <i class="sdr-rug" />
      </div>
      <div class="sdr-stage">
        {/* the shelf: trophies you've earned */}
        <Spot cls="sdr-shelf" label={`Trophies: ${trophies.length ? trophies.map((t) => t.label).join(', ') : 'none yet'}. Opens Duelist Rankings`} tag="Trophies" onPick={() => go('rankings')}>
          <span class="sdr-planks">
            <span class="sdr-plank">{trophies.length ? trophies.slice(0, 3).map((t, i) => <TrophyArt key={i} t={t} />) : <em>Win duels to fill this shelf</em>}</span>
            <span class="sdr-plank">{trophies.slice(3).map((t, i) => <TrophyArt key={i} t={t} />)}</span>
          </span>
        </Spot>

        {/* the missions board: today's Duelist Requests */}
        <Spot cls="sdr-board" label={`Duelist Requests, ${board.done} of ${board.notes.length} done today`} tag={board.notes.length ? `Requests ${board.done}/${board.notes.length}` : 'Requests'} hot={board.notes.length > 0 && board.done < board.notes.length} onPick={() => go('requests')}>
          <span class="sdr-cork">
            {board.notes.length ? (
              board.notes.map((n, i) => (
                <span key={i} class={`sdr-note n${i} ${n.done ? 'done' : ''}`}>
                  <i class="sdr-pin" />
                  <b>{n.who.replace(/^The /, '').split(' ')[0]}</b>
                  <small>{n.done ? '✓ done' : `${n.have}/${n.need}`}</small>
                </span>
              ))
            ) : (
              <span class="sdr-note n1">
                <i class="sdr-pin" />
                <small>new ones soon</small>
              </span>
            )}
          </span>
        </Spot>

        {/* the Duel Pass poster (when the pass exists) */}
        {pass && (
          <Spot cls="sdr-pass" label={`Duel Pass, ${pass.note}${pass.ready ? `, ${pass.ready} to claim` : ''}`} tag={pass.ready ? `Pass · ${pass.ready}!` : 'Duel Pass'} hot={!!pass.ready} onPick={pass.onOpen}>
            <span class="sdr-poster">
              <b>DUEL PASS</b>
              <small>{pass.note}</small>
            </span>
          </Spot>
        )}

        {/* your Ace, standing behind you */}
        {ace && (
          <Spot cls="sdr-ace" label={`Ace Monster: ${ace.name}${ace.ace ? `, ${bondTitle(ace.ace.lv)}` : ''}`} tag={ace.ace ? `Ace ★${ace.ace.lv}` : 'Pick an Ace'} onPick={() => go('ace')}>
            <AceFigure name={ace.name} lv={lv} />
          </Spot>
        )}

        {/* your Mate, wandering */}
        <span class="sdr-walk">
          <Spot cls="sdr-mate" label={`Your Mate, ${mateDef(mate)?.name ?? 'Mate'}. Opens Mates`} tag={mateDef(mate)?.name} onPick={() => go('mates')}>
            <i class="sdr-shadow" />
            <span class="sdr-turn">
              <span class="sdr-mate-bob">
                <MateArt id={mate} face={face} />
              </span>
            </span>
          </Spot>
        </span>

        {/* the table: deck box in your sleeve, and the packs waiting */}
        <span class="sdr-table" aria-hidden="true" />
        <Spot cls="sdr-deckbox" label={`Active deck: ${deck?.name ?? 'none'}${save.decks.length > 1 ? '. Tap to switch' : ''}`} tag={deck ? deck.name : 'Decks'} onPick={onDeck}>
          <span class="sdr-box">
            <CardImg name="" back sleeve={sleeve} />
            <CardImg name="" back sleeve={sleeve} />
            <b>{deck ? deck.main.length : 0}</b>
          </span>
        </Spot>
        <Spot cls="sdr-packs" label={packs ? `Card Shop: ${packs} pack${packs === 1 ? '' : 's'} to open` : 'Card Shop'} tag={packs ? `Open ${packs}!` : 'Shop'} hot={packs > 0} onPick={() => go('shop')}>
          <span class={`sdr-crate ${packs ? 'full' : ''}`}>
            {packs > 0 && (
              <>
                <i class="sdr-pack p1" />
                {packs > 1 && <i class="sdr-pack p2" />}
                {packs > 2 && <i class="sdr-pack p3" />}
              </>
            )}
          </span>
        </Spot>
      </div>
    </div>
  );
}
