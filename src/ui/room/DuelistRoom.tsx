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
import { chosenMate, mateDef, type MateId } from '../../mates/roster';
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

/** How long a tapped thing springs before its screen opens (short: it must never feel slow). */
const PRESS_MS = 120;

/** One press at a time across the whole room: a double tap, or two things tapped at once,
 *  opens one screen. */
let pressing = false;
/** The Mate cheers whenever something in the room is tapped. */
const cheers = new Set<() => void>();
/** Fewer cores than this: a lighter room (no drifting dust). */
const LITE_CORES = 4;
const lite = typeof navigator !== 'undefined' && (navigator.hardwareConcurrency ?? 8) <= LITE_CORES;

/** One thing in the room you can tap: a real button with a name tag under it. */
function Spot({ cls, tag, hot, label, onPick, children, twin }: { cls: string; tag?: ComponentChildren; hot?: boolean; label: string; onPick: () => void; children?: ComponentChildren; twin?: boolean }) {
  // no timer outlives the room
  const timers = useRef<number[]>([]);
  useEffect(() => () => (timers.current.forEach(clearTimeout), (pressing = false)), []);
  return (
    <button
      class={`sdr-spot ${cls} ${hot ? 'hot' : ''}`}
      aria-label={twin ? undefined : label}
      aria-hidden={twin ? 'true' : undefined}
      tabIndex={twin ? -1 : undefined}
      onClick={(e) => {
        // keyboard and controller presses go straight there (the spring is for fingers)
        if (e.detail === 0) return void (playBlip(), onPick());
        if (pressing) return;
        pressing = true;
        playBlip();
        for (const f of cheers) f();
        // a quick press-and-spring on the thing itself, then the screen it opens
        const el = e.currentTarget as HTMLElement;
        el.classList.add('pop');
        timers.current.push(
          window.setTimeout(onPick, PRESS_MS),
          window.setTimeout(() => (el.classList.remove('pop'), (pressing = false)), 320),
        );
      }}
    >
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
          <b class="sdr-plaque">{t.wins > 999 ? '999+' : t.wins}</b>
        </span>
      );
    case 'crown':
      return (
        <span class="sdr-tro crown" title={t.label}>
          <i class="sdr-crown" />
        </span>
      );
    case 'bond':
      return (
        <span class={`sdr-tro bond b${t.lv}`} title={t.label}>
          <i>★</i>
        </span>
      );
    case 'school':
      return (
        <span class="sdr-tro school" title={t.label}>
          <i class="sdr-scroll" />
        </span>
      );
  }
}

/** A duelist's name short enough for a note ("Yami Yugi" → "Yami", "Mai Valentine" → "Mai"). */
const shortName = (who: string) => {
  const w = who.replace(/^The /, '').split(' ');
  return w[0].length <= 3 && w[1] ? `${w[0]} ${w[1]}` : w[0];
};
/** 2000 → "2k", 1500 → "1.5k" */
const short = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));

/** The Ace: the card art cut out by its figure matte, standing in its light. */
function AceFigure({ name, lv }: { name: string; lv: number }) {
  useFigs(true);
  const fig = figUrl(name);
  const url = imageUrl(name);
  // the cut-out shows once its matte has really loaded (a missing matte would hide the monster)
  const [matte, setMatte] = useState<'wait' | 'ok' | 'bad'>('wait');
  useEffect(() => {
    if (!fig) return;
    setMatte('wait');
    let live = true;
    const im = new Image();
    im.onload = () => live && setMatte('ok');
    im.onerror = () => live && setMatte('bad');
    im.src = fig;
    return () => void (live = false);
  }, [fig]);
  return (
    <span class={`sdr-acefig b${lv}`}>
      <i class="sdr-pillar" />
      <i class="sdr-halo" />
      <i class="sdr-pedestal" />
      {fig && url && matte !== 'bad' ? (
        <i class={`sdr-cutw ${matte === 'ok' ? 'in' : ''}`}>
          <i class="sdr-cut" style={{ '--sdr-img': `url("${url}")`, '--sdr-fig': `url("${fig}")` } as Record<string, string>} />
        </i>
      ) : (
        <span class="sdr-holo">
          <CardImg name={name} />
        </span>
      )}
    </span>
  );
}

/** The Mate pulls a face now and then (a smile, a wow, a yawn): one timer, only while the room
 *  is on screen and the app is in front, and only the Mate re-renders. */
function RoomMate({ id, live }: { id: MateId; live: boolean }) {
  const [face, setFace] = useState<Face>('idle');
  const [hop, setHop] = useState(0);
  // something in the room was tapped: a happy hop
  useEffect(() => {
    const f = () => (setFace('happy'), setHop((n) => n + 1));
    cheers.add(f);
    return () => void cheers.delete(f);
  }, []);
  const [front, setFront] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const f = () => setFront(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, []);
  useEffect(() => {
    if (!live || !front) return;
    const faces: Face[] = ['happy', 'idle', 'wow', 'idle', 'love', 'idle', 'smirk', 'sleep'];
    let i = 0;
    const t = setInterval(() => setFace(faces[i++ % faces.length]), 3800);
    return () => clearInterval(t);
  }, [live, front]);
  return (
    <span key={hop} class={`sdr-mate-hop ${hop ? 'go' : ''}`}>
      <MateArt id={id} face={face} />
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

  // Pause the room's animations while it's scrolled away (browsers already stop them in the background).
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Furniture shifts a few pixels against the wall as a mouse moves (computers only: phones
  // keep still). One CSS variable per frame at most, transform only.
  useEffect(() => {
    const el = ref.current;
    if (!el || !seen || typeof matchMedia === 'undefined' || !matchMedia('(hover: hover) and (pointer: fine)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    let x = 0;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), el.style.setProperty('--sdr-px', x.toFixed(3))));
    };
    el.addEventListener('pointermove', move);
    return () => (el.removeEventListener('pointermove', move), cancelAnimationFrame(raf));
  }, [seen]);

  return (
    <div ref={ref} class={`sdr ${seen ? '' : 'off'} ${pass ? 'has-pass' : ''} ${lite ? 'lite' : ''}`} role="group" aria-label={`${profile.alias}'s Duelist Room`}>
      <div class="sdr-walls" aria-hidden="true">
        <i class="sdr-window" />
        <i class="sdr-light" />
        <i class="sdr-dust" />
        <i class="sdr-floor" />
        <i class="sdr-rug" />
      </div>
      <div class="sdr-stage">
        {/* the shelf: trophies you've earned */}
        <Spot cls="sdr-shelf" label={`Trophies: ${trophies.length ? trophies.map((t) => t.label).join(', ') : 'none yet'}. Opens Duelist Rankings`} tag="Trophies" onPick={() => go('rankings')}>
          <span class="sdr-planks">
            <span class="sdr-plank">{trophies.length ? trophies.slice(0, 3).map((t, i) => <TrophyArt key={i} t={t} />) : <>
                  <span class="sdr-tro cup ghost">
                    <i class="sdr-cup" />
                  </span>
                  <em>Win duels to fill this shelf</em>
                </>}</span>
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
                  <b>{shortName(n.who)}</b>
                  <small>{n.done ? '✓ done' : `${short(n.have)}/${short(n.need)}`}</small>
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
          <Spot cls="sdr-ace" label={`Ace Monster: ${ace.name}${ace.ace ? `, ${bondTitle(ace.ace.lv)}` : ''}`} onPick={() => go('ace')}>
            <AceFigure name={ace.name} lv={lv} />
          </Spot>
        )}
        {/* the Ace's tag is its own tap target above the floor, so the Mate's patch never takes it */}
        {ace && (
          <Spot cls="sdr-acetag" twin label="" tag={ace.ace ? `Ace ★${ace.ace.lv}` : 'Pick an Ace'} onPick={() => go('ace')} />
        )}

        {/* your Mate, wandering */}
        {/* (the button is the still patch of floor it walks on: a steady tap target and focus ring) */}
        <Spot cls="sdr-matezone" label={`Your Mate, ${mateDef(mate)?.name ?? 'Mate'}. Opens Mates`} onPick={() => go('mates')}>
          <span class="sdr-walk">
            <span class="sdr-mate">
              <i class="sdr-shadow" />
              <span class="sdr-turn">
                <span class="sdr-mate-bob">
                  <RoomMate id={mate} live={seen} />
                </span>
              </span>
              <span class="sdr-tag">{mateDef(mate)?.name}</span>
            </span>
          </span>
        </Spot>

        {/* the table: deck box in your sleeve, and the packs waiting */}
        <span class="sdr-table" aria-hidden="true" />
        <Spot cls="sdr-deckbox" label={`Active deck: ${deck?.name ?? 'none'}${save.decks.length > 1 ? '. Tap to switch' : ''}`} tag={deck ? `${deck.name}${save.decks.length > 1 ? ' ⇄' : ''}` : 'Decks'} onPick={onDeck}>
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
