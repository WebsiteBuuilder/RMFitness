// Touch controls: a Master Duel-style duel screen. Tap a card to see it and what it can do,
// drag a card from your hand onto the field to play it, drag a monster onto a target to attack.
// The rules and every move go through the same engine actions as the Classic screen.
import { bigScreen, handCardW, handRoom, measuredHand } from './fit';
import type { ComponentChildren, VNode } from 'preact';
import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DuelSession } from '../eds/session';
import type { Engine } from '../eds/engine';
import { other } from '../eds/engine';
import type { Card, DuelState, FieldCard, Pid, PlayerState, Prompt, SelectOption } from '../eds/types';
import { card as cardInfo } from '../eds/db';
import { getEffect } from '../eds/effects';
import { getSkill } from '../eds/skills';
import { CardImg } from './CardImg';
import { duelSleeveOf, sleeveClass } from '../sleeves/duel';
import type { Command, Mode } from './Duel';
import { mixedSides, sideLabel } from './sideLabel';
import { attackForecast } from './forecast';
import { playBlip, unlockAudio } from './sound';
import { LpCount } from '../art/flow';
import { LpCracks, LpPops, useLpShake } from './lpHits';
import { lpCountMs } from './lpHitRules';
import { spellWord } from './gameUi';
import { useFlights } from './flights';
import { AutoDrawPill } from './heartDraw';
import { introLeft, whenIntroAt } from './immersionState';
import { CounterLines, CounterMarks, countersKey, noteCounterless, primeCounters, shownCounters } from './counters';
import './arena.css';
import './turnhud.css';
import { dangerLevel, FieldCracks } from './Atmosphere';
import { wearKey, ZoneWear } from './fieldWear';

type Action = Parameters<DuelSession['send']>[0];
type SelectPrompt = Extract<Prompt, { kind: 'select' }>;

export interface TouchCtl {
  state: DuelState;
  /** an online duel's turn timer pill for a player's bar (none offline) */
  clockFor?: (p: Pid) => ComponentChildren;
  e: Engine;
  acting: Pid;
  mySeat: Pid;
  hotseat: boolean;
  me: PlayerState;
  opp: PlayerState;
  canAct: boolean;
  /** your deck carries the Auto draw switch (a Speed Duel you play, not the tutorial) */
  autoPill?: boolean;
  /** watching the computer duel itself: every card is shown */
  spectator?: boolean;
  /** a Tag Duel where your teammate is in (their hand shows, nothing takes input) */
  locked?: boolean;
  myTurn: boolean;
  prompt: Prompt | null;
  sel: number | null;
  setSel: (uid: number | null) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  picks: number[];
  togglePick: (p: SelectPrompt, i: number) => void;
  send: (a: Action) => void;
  tap: (uid: number) => void;
  commands: Command[];
  highlight: (uid: number) => string;
  anim: { kind: string; uid?: number; player?: Pid; amount?: number; seq: number } | null;
  selCard: Card | null;
  canSeeSel: boolean;
  oppHandShown: boolean;
  nextPhaseLabel: string;
  setInfo: (name: string | null, owner?: Pid) => void;
  setPile: (p: { title: string; cards: Card[] } | null) => void;
  /** show a player's Speed Duel Skill */
  openSkill: (p: Pid) => void;
  openMenu: () => void;
  setShowLog: (v: boolean) => void;
  onFinished: (winner: Pid | 'draw') => void;
}

/** the hint line under the turn row comes and goes (it moves the row a little) */

const PHASE_NAMES: Record<string, string> = { DP: 'Draw', SP: 'Standby', M1: 'Main 1', BP: 'Battle', M2: 'Main 2', EP: 'End' };

/** A card being dragged: where it came from and where the finger is. */
interface Drag {
  uid: number;
  name: string;
  from: 'hand' | 'mz';
  x: number;
  y: number;
  /** the drop spot under the finger, if it is a legal one */
  over: string | null;
}

export function TouchDuel({ ctl, overlays }: { ctl: TouchCtl; overlays: ComponentChildren }) {
  const { state, e, acting, me, opp, canAct, myTurn, prompt, sel, setSel, mode, setMode, send, tap, commands, highlight, anim, selCard, canSeeSel } = ctl;
  const oppId = other(acting);
  /** the selected card when it is in play (its counters show in the preview) */
  const selField = selCard ? e.fieldCard(selCard.uid) : null;
  const [phaseOpen, setPhaseOpen] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [bubble, setBubble] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const press = useRef<{ uid: number; name: string; from: 'hand' | 'mz'; x: number; y: number; id: number } | null>(null);
  /** set after a drag so the click that follows the finger lifting doesn't also select */
  const dragged = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  // where the turn / phase row sits on screen (its flat copy over the field figures follows it)
  const midRef = useRef<HTMLDivElement>(null);
  const [midBox, setMidBox] = useState<{ top: number; left: number; width: number } | null>(null);
  const [resized, setResized] = useState(0);
  useEffect(() => {
    const on = () => setResized((n) => n + 1);
    window.addEventListener('resize', on);
    // the field swings into place as the duel opens: place the turn row again once it has
    const t = setTimeout(on, 900);
    // (and when the row itself changes size: not on every step of a turn, which forced a layout each time)
    const ro = typeof ResizeObserver !== 'undefined' && midRef.current ? new ResizeObserver(on) : null;
    if (ro && midRef.current) ro.observe(midRef.current);
    return () => (window.removeEventListener('resize', on), clearTimeout(t), ro?.disconnect());
  }, []);
  // (measured only when the layout can have moved: not after every render, which forced a layout each time)
  const figuresOn = typeof document !== 'undefined' && document.body.classList.contains('art3d-on');
  useLayoutEffect(() => {
    const el = midRef.current;
    const b = el && figuresOn ? el.getBoundingClientRect() : null;
    const box = b && b.width > 0 ? { top: Math.round(b.top), left: Math.round(b.left), width: Math.round(b.width) } : null;
    if (box?.top !== midBox?.top || box?.left !== midBox?.left || box?.width !== midBox?.width) setMidBox(box);
  }, [resized, figuresOn, state.winner]);

  useFlights(root, state, acting);
  // Life Points dropping shake the board, scaled to the hit (lpHits.tsx)
  useLpShake(root, ctl.hotseat ? null : acting, !!e.speed, '.tmat, .tbar, .thand', !!ctl.spectator);

  // The opening swing starts two frames after the screen opens, once its first heavy frame is painted.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let a = requestAnimationFrame(() => (a = requestAnimationFrame(() => setArmed(true))));
    return () => cancelAnimationFrame(a);
  }, []);

  // The finishing blow: the field shakes and darkens and the loser's Life Points flash red
  // for a beat, after their count reaches 0, before the result slides in.
  // (it waits for the finishing cinematic to leave the stage, so it plays on the visible board)
  const [resultUp, setResultUp] = useState(state.winner !== null);
  const [koOn, setKoOn] = useState(false);
  useEffect(() => {
    setKoOn(false);
    if (state.winner === null) return setResultUp(false);
    let t: ReturnType<typeof setTimeout>;
    const t0 = Date.now();
    const wait = () => {
      if (document.body.classList.contains('art-on') && Date.now() - t0 < 20000) return void (t = setTimeout(wait, 100));
      // (a breath after the stage has faded away, then a full beat on the red board)
      t = setTimeout(() => {
        setKoOn(true);
        t = setTimeout(() => setResultUp(true), 1800);
      }, 450);
    };
    wait();
    return () => clearTimeout(t);
  }, [state.winner]);
  const loser: Pid | null = state.winner === null || state.winner === 'draw' ? null : other(state.winner);

  const idle = canAct && !prompt && state.winner === null;
  const actions = commands.filter((c) => !c.disabled && c.label !== 'Card Info');
  /** who the duel is waiting on right now: whoever has a choice open, else the turn player */
  const decider: Pid | null = state.winner !== null ? null : state.prompt ? state.prompt.player : state.turnPlayer;
  /** a player's first name, for the short labels */
  const first = (p: Pid) => state.players[p].name.split(' ')[0];

  useEffect(() => setPhaseOpen(false), [state.phase, state.turn, state.prompt]);

  // ----- Master Duel-style banners: duel start, whose turn, the phase, and a spotlight on activated cards -----
  const [banner, setBanner] = useState<{ text: string; sub?: string; kind: string; key: number } | null>(null);
  const [spot, setSpot] = useState<{ name: string; who: string; key: number } | null>(null);
  const showBanner = (text: string, kind: string, ms: number, sub?: string) => {
    const key = Date.now() + Math.random();
    setBanner({ text, sub, kind, key });
    setTimeout(() => setBanner((b) => (b?.key === key ? null : b)), ms);
  };
  // (a tag duel: while your teammate is in, it's their turn, by name)
  const turnWho = state.turnPlayer === acting && !ctl.locked && !ctl.spectator ? 'YOUR TURN' : `${state.players[state.turnPlayer].name.split(' ')[0].toUpperCase()}'S TURN`;
  useEffect(() => {
    if (state.winner !== null) return;
    if (state.turn === 1 && state.log.length < 6) {
      // after the face-off (which has its own "DUEL!"), straight to whose turn it is
      const wait = introLeft();
      if (wait <= 0) return showBanner('DUEL!', 'duel', 1300, turnWho);
      return whenIntroAt(0, () => showBanner(turnWho, state.turnPlayer === acting ? 'mine' : 'theirs', 1300, 'Turn 1'));
    } else showBanner(turnWho, state.turnPlayer === acting ? 'mine' : 'theirs', 1300, `Turn ${state.turn}`);
  }, [state.turn]);
  const lastPhase = useRef(state.phase);
  useEffect(() => {
    const was = lastPhase.current;
    lastPhase.current = state.phase;
    if (was === state.phase || state.winner !== null) return;
    if (state.phase === 'BP') showBanner('BATTLE PHASE', 'phase', 900);
    else if (state.phase === 'M2') showBanner('MAIN PHASE 2', 'phase', 800);
    else if (state.phase === 'EP') showBanner('END PHASE', 'phase', 700);
  }, [state.phase]);
  const lastChain = useRef(0);
  const lastSpotSeq = useRef(0);
  useEffect(() => {
    const n = state.chain.length;
    const grew = n > lastChain.current;
    lastChain.current = n;
    let name: string | null = null;
    let who: Pid | null = null;
    if (grew) {
      const link = state.chain[n - 1];
      name = link.card.name;
      who = link.player;
    } else {
      const ev = state.lastEvent;
      if (ev && ev.seq !== lastSpotSeq.current && ev.kind === 'activate' && ev.uid !== undefined) {
        lastSpotSeq.current = ev.seq;
        const f = e.find(ev.uid);
        if (f) (name = f.card.name), (who = ev.player ?? f.loc.player);
      }
    }
    if (!name || who === null) return;
    const key = Date.now() + Math.random();
    setSpot({ name, who: who === acting ? 'You activate' : `${state.players[who].name} activates`, key });
    setTimeout(() => setSpot((sp) => (sp?.key === key ? null : sp)), 1300);
  }, [state.chain.length, state.lastEvent?.seq]);
  // A little buzz when someone takes damage, on phones that support it.
  useEffect(() => {
    if (anim?.kind === 'damage') navigator.vibrate?.(anim.player === acting ? [40, 30, 60] : 25);
  }, [anim?.seq]);

  // Keep the action bubble pinned over the selected card.
  useLayoutEffect(() => {
    if (sel === null || actions.length === 0 || mode) {
      setBubble(null);
      return;
    }
    const place = () => {
      const el = root.current?.querySelector(`[data-uid="${sel}"]`);
      if (!el) return setBubble(null);
      const r = el.getBoundingClientRect();
      const w = window.innerWidth;
      const x = Math.min(Math.max(r.left + r.width / 2, 80), w - 80);
      // Cards near the top get their buttons underneath instead.
      // (a card on the field gets them underneath: above, they'd cover the turn row and the targets)
      const below = r.top < 150 || !el.closest('.thand');
      // A hand card's buttons sit above your Life Points bar, never over it (or your portrait).
      const bar = el.closest('.thand') ? root.current?.querySelector('.tbar.bottom')?.getBoundingClientRect() : null;
      const top = bar ? Math.min(r.top, bar.top) : r.top;
      const y = below ? r.bottom + 6 : top - 6;
      // the same spot: no new object, so no second render of the whole duel
      setBubble((b) => (b && b.x === x && b.y === y && b.below === below ? b : { x, y, below }));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [sel, actions.length, mode, me.hand.length, state.phase, state.turn, resized]);

  // With the 3D figures up, a monster's counter badges ride in a flat layer over them (a figure
  // drawn over its own zone hid them): placed at each holder's zone, measured when they change.
  const fieldCards = [...me.mz, ...me.sz, me.field, ...opp.mz, ...opp.sz, opp.field];
  // (counters already on the field as the screen opens are not "gained")
  useState(() => primeCounters(fieldCards));
  noteCounterless(fieldCards);
  const ctrHolders = figuresOn ? [...me.mz, ...opp.mz].filter((c): c is FieldCard => shownCounters(c).length > 0) : [];
  const ctrKey = ctrHolders.map((c) => `${c.uid}:${countersKey(shownCounters(c))}`).join(';');
  const [ctrBoxes, setCtrBoxes] = useState<{ uid: number; x: number; y: number }[]>([]);
  useLayoutEffect(() => {
    const el = root.current;
    const boxes: { uid: number; x: number; y: number }[] = [];
    if (el)
      for (const c of ctrHolders) {
        const z = el.querySelector(`.tz-m[data-uid="${c.uid}"]`);
        const r = z?.getBoundingClientRect();
        if (r && r.width > 0) boxes.push({ uid: c.uid, x: Math.round(r.left - r.width * 0.1), y: Math.round(r.bottom - r.height * 0.2) });
      }
    setCtrBoxes((b) => (b.length === boxes.length && b.every((x, i) => x.uid === boxes[i].uid && x.x === boxes[i].x && x.y === boxes[i].y) ? b : boxes));
  }, [ctrKey, resized]);

  // The card preview opens on the side of the board away from a tapped field card (it never covers it).
  const [detailRight, setDetailRight] = useState(false);
  useLayoutEffect(() => {
    if (sel === null) return;
    const el = root.current?.querySelector(`[data-uid="${sel}"]`);
    const r = el && el.closest('.tmat') ? el.getBoundingClientRect() : null;
    const right = !!r && r.left + r.width / 2 < window.innerWidth * 0.58;
    setDetailRight((d) => (d === right ? d : right));
  }, [sel]);

  // ----- what a dragged card may be dropped on -----
  const dropSpots = (uid: number, from: 'hand' | 'mz'): Set<string> => {
    const out = new Set<string>();
    if (!idle || !myTurn) return out;
    const f = e.find(uid);
    if (!f) return out;
    if (from === 'hand' && e.inMainPhase()) {
      const info = cardInfo(f.card.name);
      if (info?.kind === 'monster') {
        // A tribute frees a zone, so any of your zones takes a monster that needs tributes.
        if (e.canNormalSummon(acting, f.card)) {
          if (e.canNormalSummon(acting, f.card, true)) me.mz.forEach((z, i) => (e.monsterZoneOpen(acting, i) || (z !== null && (info.level ?? 0) >= 5)) && out.add(`mz${i}`));
          // the SET pad: drop here to Set it face-down
          out.add('set');
        }
      } else {
        const ok = (info?.kind === 'spell' && e.canActivateMain(acting, uid)) || e.canSet(acting, f.card);
        if (ok) {
          me.sz.forEach((z, i) => z === null && out.add(`sz${i}`));
          if (info?.sub === 'Field') out.add('field');
        }
        if (e.canSet(acting, f.card) && me.sz.some((z) => z === null)) out.add('set');
      }
    }
    if (from === 'mz' && state.phase === 'BP') {
      const m = f.card as FieldCard;
      if (e.canAttackWith(acting, m)) {
        for (const t of e.legalTargets(acting, m)) out.add(`t${t.uid}`);
        if (e.monsters(oppId).length === 0 || e.canAttackDirectly(m)) out.add('direct');
      }
    }
    return out;
  };

  const spots = drag ? dropSpots(drag.uid, drag.from) : null;

  const drop = (d: Drag) => {
    const f = e.find(d.uid);
    if (!f || !d.over) return;
    const spot = d.over;
    if (d.from === 'hand') {
      const info = cardInfo(f.card.name);
      if (spot === 'set') {
        if (info?.kind === 'monster') send({ type: 'SUMMON', player: acting, uid: d.uid, zone: e.freeMonsterZone(acting), pos: 'def', faceUp: false });
        else send({ type: 'SET_ST', player: acting, uid: d.uid, zone: me.sz.findIndex((z) => z === null) });
      } else if (spot.startsWith('mz')) send({ type: 'SUMMON', player: acting, uid: d.uid, zone: Number(spot.slice(2)), pos: 'atk', faceUp: true });
      else {
        const zone = spot === 'field' ? me.sz.findIndex((z) => z === null) : Number(spot.slice(2));
        // Spells are played face-up when they can be; Traps (and Spells that can't be used now) are Set.
        if (info?.kind === 'spell' && e.canActivateMain(acting, d.uid)) send({ type: 'ACTIVATE', player: acting, uid: d.uid, zone });
        else send({ type: 'SET_ST', player: acting, uid: d.uid, zone });
      }
    } else if (spot === 'direct') send({ type: 'ATTACK', player: acting, uid: d.uid, target: null });
    else if (spot.startsWith('t')) send({ type: 'ATTACK', player: acting, uid: d.uid, target: Number(spot.slice(1)) });
    setSel(null);
  };

  const spotAt = (x: number, y: number, allowed: Set<string>): string | null => {
    const el = document.elementFromPoint(x, y)?.closest('[data-drop]') as HTMLElement | null;
    const id = el?.dataset.drop ?? null;
    return id && allowed.has(id) ? id : null;
  };

  const onDown = (ev: PointerEvent, c: Card, from: 'hand' | 'mz') => {
    if (!idle || !myTurn) return;
    press.current = { uid: c.uid, name: c.name, from, x: ev.clientX, y: ev.clientY, id: ev.pointerId };
  };
  const onMove = (ev: PointerEvent) => {
    const p = press.current;
    if (!p || p.id !== ev.pointerId) return;
    if (!drag) {
      if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 12) return;
      const allowed = dropSpots(p.uid, p.from);
      if (allowed.size === 0) {
        press.current = null;
        return;
      }
      (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
      unlockAudio();
      setSel(null);
      setDrag({ uid: p.uid, name: p.name, from: p.from, x: ev.clientX, y: ev.clientY, over: null });
      return;
    }
    ev.preventDefault();
    setDrag({ ...drag, x: ev.clientX, y: ev.clientY, over: spotAt(ev.clientX, ev.clientY, spots!) });
  };
  /**
   * Let go near (not exactly on) a lit spot: the closest one takes it, like Master Duel's forgiving
   * drops. The SET pad and the opponent's portrait only count when hit exactly.
   */
  const nearSpot = (x: number, y: number, allowed: Set<string>, reach: number): string | null => {
    let best: string | null = null;
    let dist = reach;
    for (const el of document.querySelectorAll<HTMLElement>('[data-drop]')) {
      const id = el.dataset.drop!;
      if (!allowed.has(id) || id === 'set' || id === 'direct') continue;
      const r = el.getBoundingClientRect();
      const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
      if (d < dist) (dist = d), (best = id);
    }
    return best;
  };
  const onUp = (ev: PointerEvent) => {
    const p = press.current;
    press.current = null;
    if (!p || p.id !== ev.pointerId || !drag) return;
    dragged.current = true;
    setTimeout(() => (dragged.current = false), 50);
    // a card from the hand pulled well up onto the field lands in the nearest free zone
    const lifted = p.from === 'hand' && p.y - ev.clientY > 70;
    const d = { ...drag, over: spotAt(ev.clientX, ev.clientY, spots!) ?? nearSpot(ev.clientX, ev.clientY, spots!, lifted ? 140 : 40) };
    setDrag(null);
    drop(d);
  };
  const onCancel = () => {
    press.current = null;
    setDrag(null);
  };

  const tapCard = (uid: number) => {
    if (dragged.current) return;
    setPhaseOpen(false);
    tap(uid);
  };

  // (what a memoized Piece's handlers call: always this render's)
  const live = useRef({ tapCard, setSel, onDown, onMove, onUp, onCancel });
  live.current = { tapCard, setSel, onDown, onMove, onUp, onCancel };
  const liveDrag = (c: Card, from: 'hand' | 'mz') => ({
    onPointerDown: (ev: PointerEvent) => live.current.onDown(ev, c, from),
    onPointerMove: (ev: PointerEvent) => live.current.onMove(ev),
    onPointerUp: (ev: PointerEvent) => live.current.onUp(ev),
    onPointerCancel: () => live.current.onCancel(),
  });

  const spotCls = (id: string) => (spots ? (spots.has(id) ? (drag?.over === id ? ' drop-on' : ' drop-ok') : '') : '');

  // ----- field pieces -----
  const zone = (c: FieldCard | null, owner: Pid, kind: 'm' | 's', i: number) => {
    const visible = c ? c.faceUp || owner === acting || !!ctl.spectator : false;
    const mine = owner === acting;
    const dropId = mine ? `${kind}z${i}` : c && kind === 'm' ? `t${c.uid}` : undefined;
    const draggable = mine && kind === 'm' && c && state.phase === 'BP';
    const wear = e.speed && kind === 'm' ? wearKey(state, owner, i) : '';
    const cls = `tz tz-${kind} ${c ? '' : 'empty'} ${c ? highlight(c.uid) : ''}${dropId ? spotCls(dropId) : ''}${wear ? ' worn' : ''}`;
    const named = c && c.faceUp ? e.nameOf(c) : '';
    const stat = c && c.faceUp && kind === 'm' ? (c.pos === 'atk' ? e.atkOf(c) : e.defOf(c)) : '';
    // raised or lowered from the printed value: the plate turns green or red
    const printed = c && stat !== '' ? (c.pos === 'atk' ? cardInfo(c.name)?.atk : cardInfo(c.name)?.def) : undefined;
    const shift = typeof printed === 'number' && printed >= 0 && stat !== '' ? (stat > printed ? ' up' : stat < printed ? ' down' : '') : '';
    // aiming an attack (tap Attack, then a target): each target says how the battle would go
    const fc = c && !mine && kind === 'm' && mode?.kind === 'attack' && cls.includes(' pick') ? forecast(mode.uid, c.uid) : null;
    const fcShort = fc ? (fc.tone === 'good' ? (/(\d+) damage/.exec(fc.text)?.[1] ? `+${/(\d+) damage/.exec(fc.text)![1]}` : 'Win') : fc.tone === 'bad' ? (/take (\d+)/.exec(fc.text) ? `−${/take (\d+)/.exec(fc.text)![1]}` : 'Lose') : fc.text.includes('luck:') ? '🎲' : fc.text.startsWith('both') ? 'Trade' : fc.text.startsWith('face') ? '?' : '0') : '';
    const sig = c ? `${fcShort}|${cls}|${c.uid}|${c.name}|${c.owner}|${c.pos}|${c.faceUp}|${visible}|${named}|${stat}|${c.equips.length}|${c.mats?.length ?? 0}|${countersKey(shownCounters(c))}|${kind === 'm' && figuresOn}|${!!draggable}|${wear}|${duelSleeveOf(c.owner) ?? ''}` : `${cls}|${wear}`;
    return <Piece key={`${owner}${kind}${i}`} sig={sig} render={() => (
      <div
        class={cls}
        data-uid={c?.uid}
        data-drop={dropId}
        onClick={(ev) => {
          ev.stopPropagation();
          if (c) live.current.tapCard(c.uid);
          else live.current.setSel(null);
        }}
        {...(draggable ? liveDrag(c, 'mz') : {})}
      >
        {/* (always there in a Speed Duel's Monster Zone, so it sees the first mark land) */}
        {e.speed && kind === 'm' && <ZoneWear state={state} p={owner} zone={i} />}
        {c && (
          <div class={`fcard ${c.pos === 'def' ? 'def' : ''} ${c.faceUp ? '' : 'fd'} ${!c.faceUp && visible ? `myset${sleeveClass(duelSleeveOf(c.owner))}` : ''}`}>
            <CardImg name={c.name} back={!visible} owner={c.owner} />
            {/* (a face-down card's glint is idle life: idlelife.css) */}
            <i class="tshine" aria-hidden="true" />
            {!c.faceUp && visible && <span class="setmark">SET</span>}
            {c.faceUp && named !== c.name && <span class="namechg">{named}</span>}
          </div>
        )}
        {c && c.faceUp && kind === 'm' && (
          <div class={`tstat ${c.pos === 'def' ? 'def' : ''}${shift}`}>
            {stat}
          </div>
        )}
        {fc && <div class={`tfc ${fc.tone}`}>{fcShort}</div>}
        {c && c.equips.length > 0 && <div class="eqmark">{c.equips.length}</div>}
        {c && (c.mats?.length ?? 0) > 0 && <div class="matmark" title="Xyz Materials">{c.mats!.length}</div>}
        {!(kind === 'm' && figuresOn) && <CounterMarks list={shownCounters(c)} uid={c?.uid} />}
      </div>
    )} />;
  };

  const fieldZone = (p: Pid) => {
    const ps = state.players[p];
    const mine = p === acting;
    // A Field Skill (Power of Dark, Peak Performance...) sits face-up in the empty Field Zone, like the real game
    const sk = !ps.field && ps.skill && ps.skillRevealed ? getSkill(ps.skill) : undefined;
    const fieldSkill = sk?.aura && sk.startOfDuel ? ps.skill : null;
    return (
      <div
        class={`tz tz-f ${ps.field ? '' : 'empty'} ${ps.field ? highlight(ps.field.uid) : ''}${mine ? spotCls('field') : ''}${ps.field && !ps.field.faceUp && (mine || ctl.spectator) ? ' myset' : ''}`}
        data-uid={ps.field?.uid}
        data-drop={mine ? 'field' : undefined}
        onClick={(ev) => {
          ev.stopPropagation();
          if (ps.field) tapCard(ps.field.uid);
          else if (fieldSkill) ctl.openSkill(p);
        }}
      >
        {ps.field ? <CardImg name={ps.field.name} back={!ps.field.faceUp && !mine && !ctl.spectator} owner={ps.field.owner} /> : fieldSkill ? <CardImg name={fieldSkill} class="tz-skillcard" /> : <span class="tz-label">FIELD</span>}
        {ps.field && !ps.field.faceUp && (mine || ctl.spectator) && <span class="setmark">SET</span>}
        <CounterMarks list={ps.field ? shownCounters(ps.field) : fieldSkill && ps.skillRevealed ? shownCounters(e.skillCard(p)) : []} />
      </div>
    );
  };

  const gy = (p: Pid) => {
    const ps = state.players[p];
    return (
      <button class="tpile gy" data-pile={`gy${p}`} onClick={(ev) => (ev.stopPropagation(), ctl.setPile({ title: `${ps.name}'s Graveyard`, cards: ps.gy }))}>
        {ps.gy.length > 0 ? <CardImg name={ps.gy[ps.gy.length - 1].name} owner={ps.gy[ps.gy.length - 1].owner} /> : <span class="tz-label">GY</span>}
        <span class="tcount">{ps.gy.length}</span>
      </button>
    );
  };

  const deck = (p: Pid) => {
    const ps = state.players[p];
    const extra = ps.fusion.length > 0 || ps.removed.length > 0;
    return (
      <div class={`tpile deck${p === acting && ctl.autoPill ? ' has-auto' : ''}`} data-pile={`deck${p}`}>
        {ps.deck.length > 0 ? <CardImg name="" back owner={p} shine /> : <span class="tz-label">DECK</span>}
        <span class="tcount">{ps.deck.length}</span>
        {p === acting && ctl.autoPill && <AutoDrawPill />}
        {extra && (
          <div class="textra">
            {ps.fusion.length > 0 && (
              <button class={p === acting && ctl.canAct && !ctl.prompt && ps.fusion.some((c) => e.canSpecialProc(acting, c)) ? 'xready' : ''} onClick={(ev) => (ev.stopPropagation(), p === acting && ctl.setPile({ title: e.speed ? 'Extra Deck' : 'Fusion Deck', cards: ps.fusion }))}>
                {e.speed ? 'Extra' : 'F'} {ps.fusion.length}
              </button>
            )}
            {ps.removed.length > 0 && <button onClick={(ev) => (ev.stopPropagation(), ctl.setPile({ title: `${ps.name}'s removed cards`, cards: ps.removed }))}>Out {ps.removed.length}</button>}
          </div>
        )}
      </div>
    );
  };

  /**
   * The tab hanging off a player's bar toward the field: whose turn it is, and who the duel is
   * waiting on (their choice, or yours). One look at either bar says who moves next.
   */
  const statusTab = (p: Pid, top: boolean) => {
    // (the opponent's side: the middle row carries it, the tab would sit on their hand)
    if (decider === null || top) return null;
    const mine = p === acting && !ctl.locked && !ctl.spectator;
    const isTurn = state.turnPlayer === p;
    const asked = state.prompt?.player === p;
    if (!isTurn && !asked) return null;
    // your own choice: the sheet that slides up over your bar says it in gold
    if (mine && asked && canAct) return null;
    let kind = 'mine';
    let text: string;
    let dots = false;
    if (asked) {
      // a choice open (a chain, a trap's question, a Skill's pick): it's the big news
      kind += ' ask';
      if (mine) text = 'Your choice!';
      else ((text = `${first(p)} is choosing`), (dots = true));
    } else if (decider === p) {
      text = mine ? 'Your turn' : `${first(p)}'s turn`;
      dots = !mine;
    } else {
      // your turn, but the duel waits on the other player's answer
      kind += ' wait';
      text = mine ? `Waiting on ${first(decider)}` : `${first(p)}'s turn`;
      dots = true;
    }
    return (
      <span class={`ttab ${top ? 'top' : 'bottom'} ${kind}${mine ? ' me' : ''}`} key={`${kind}|${text}`}>
        <b>{text}</b>
        {dots && (
          <i class="tdots" aria-hidden="true">
            <i />
            <i />
            <i />
          </i>
        )}
      </span>
    );
  };

  // the gauge drains as long as the counter rolls (lpCountMs: longer for bigger changes)
  const lpWas = useRef<Record<number, { lp: number; ms: number }>>({});
  const lpBar = (p: Pid, top: boolean) => {
    const ps = state.players[p];
    const hurt = anim && (anim.kind === 'damage' || anim.kind === 'heal') && anim.player === p ? `lp-${anim.kind}` : '';
    const was = lpWas.current[p];
    if (!was || was.lp !== state.players[p].lp) lpWas.current[p] = { lp: state.players[p].lp, ms: was ? lpCountMs(state.players[p].lp - was.lp) : 600 };
    const drainMs = lpWas.current[p].ms;
    const isTurn = state.turnPlayer === p;
    const directOk = top && spots?.has('direct');
    // the Duel Disk gauge lights whole cells (20 of them: lphit.css), so any Life Points left keep one lit
    const frac = Math.ceil(Math.max(0, Math.min(1, ps.lp / Math.max(e.speed ? 4000 : 8000, ps.lp))) * 20) / 20;
    return (
      <div
        class={`tbar ${top ? 'top' : 'bottom'} ${isTurn ? 'turn' : 'idle-bar'}${decider === p ? ' acts' : ''}${directOk ? (drag?.over === 'direct' ? ' drop-on' : ' drop-ok') : ''} ${mode && top && canDirect() ? 'drop-ok' : ''}`}
        data-drop={top ? 'direct' : undefined}
        onClick={() => top && mode && canDirect() && (send({ type: 'ATTACK', player: acting, uid: mode.uid, target: null }), setMode(null))}
      >
        <LpCracks key={`cr${p}`} who={p} speed={!!e.speed} />
        <div class="tavatar">{ps.name.slice(0, 1).toUpperCase()}</div>
        <div class="tname">
          <b>{ps.name}</b>
          <span>
            Hand {ps.hand.length}
            {!top && ps.normalSummoned ? ' · Summoned' : ''}
          </span>
        </div>
        {statusTab(p, top)}
        {ctl.clockFor?.(p)}
        {ps.skill && (
          <button
            class={`tskill ${ps.skillRevealed ? 'up' : ''} ${p === acting && canAct && e.canUseSkill(acting) ? 'ready' : ''}`}
            onClick={(ev) => (ev.stopPropagation(), ctl.openSkill(p))}
          >
            Skill
            {ps.skillRevealed && <CounterMarks list={shownCounters(e.skillCard(p))} />}
          </button>
        )}
        <div class={`tlp ${hurt}`}>
          <small>LP</small>
          <LpCount value={ps.lp} who={p} />
          <LpPops key={`pop${p}`} who={p} speed={!!e.speed} below={top} />
        </div>
        <i class={`tgauge ${dangerLevel(ps.lp, !!e.speed) ? 'low' : frac <= 0.5 ? 'mid' : ''}`}>
          <i class="trail" style={{ transform: `scaleX(${frac.toFixed(4)})` }} />
          <i class="fill" style={{ transform: `scaleX(${frac.toFixed(4)})`, transitionDuration: `${drainMs}ms, 400ms` }} />
        </i>
        {top && (
          <button class="tgear" aria-label="Menu" onClick={(ev) => (ev.stopPropagation(), ctl.openMenu())}>
            ☰
          </button>
        )}
      </div>
    );
  };

  /** While aiming an attack chosen from the buttons, the opponent's portrait takes a direct attack. */
  const canDirect = (): boolean => {
    if (!mode) return false;
    const m = e.fieldCard(mode.uid);
    return !!m && (e.monsters(oppId).length === 0 || e.canAttackDirectly(m));
  };

  // ----- phase button -----
  const phaseItems: { label: string; onPick: () => void }[] = [];
  if (myTurn && idle) {
    if (state.phase !== 'EP' && state.phase !== 'M2' && ctl.nextPhaseLabel !== 'End Phase') phaseItems.push({ label: ctl.nextPhaseLabel === 'Battle' ? 'Battle Phase' : ctl.nextPhaseLabel === 'Main 2' ? 'Main Phase 2' : ctl.nextPhaseLabel, onPick: () => send({ type: 'NEXT_PHASE', player: acting }) });
    phaseItems.push({ label: 'End Turn', onPick: () => send({ type: 'END_TURN', player: acting }) });
  }

  // ----- prompts -----
  const optionCard = (o: SelectOption): string | null => {
    if (o.uid === undefined) return null;
    const f = e.find(o.uid);
    if (!f) return null;
    const fc = f.card as FieldCard;
    const hidden = (f.loc.zone === 'mz' || f.loc.zone === 'sz' || f.loc.zone === 'field') && !fc.faceUp && f.loc.player !== acting;
    const handHidden = f.loc.zone === 'hand' && f.loc.player !== acting && !ctl.oppHandShown;
    return hidden || handHidden ? '' : f.card.name;
  };

  const sheet = () => {
    if (state.winner !== null && !resultUp) return null;
    if (state.winner !== null) {
      const won = state.winner === 'draw' ? null : state.winner === ctl.mySeat;
      const title = state.winner === 'draw' ? 'DRAW' : ctl.hotseat ? `${state.players[state.winner].name} wins` : won ? 'VICTORY' : 'DEFEAT';
      return (
        <div class={`tresult ${won === false ? 'lose' : ''}`}>
          <div class="tresult-title">{title}</div>
          <p>{state.winReason}</p>
          <div class="tbtns">
            <button class="tbtn main" onClick={() => ctl.onFinished(state.winner!)}>
              Continue
            </button>
            <button class="tbtn" onClick={() => ctl.setShowLog(true)}>
              Duel log
            </button>
          </div>
        </div>
      );
    }
    if (prompt?.kind === 'yesno')
      return (
        <div class="tsheet mine-choice">
          <div class="tsheet-who">Your choice</div>
          <div class="tsheet-title">{prompt.title}</div>
          <div class="tbtns">
            <button class="tbtn main" onClick={() => send({ type: 'YES', player: acting })}>
              Yes
            </button>
            <button class="tbtn" onClick={() => send({ type: 'NO', player: acting })}>
              No
            </button>
          </div>
        </div>
      );
    if (prompt?.kind === 'response')
      return (
        <div class="tsheet mine-choice resp">
          <div class="tsheet-who">Your choice</div>
          <div class="tsheet-title">{prompt.title}</div>
          <div class="toptions">
            {prompt.options.map((o, i) => (
              <button key={i} class="topt" onClick={() => send({ type: 'CHOOSE', player: acting, picks: [i] })}>
                {optionCard(o) ? <CardImg name={optionCard(o)!} /> : <span class="topt-text">{o.label}</span>}
                <span class="topt-label">{optionCard(o) ? `Activate ${optionCard(o)}` : 'Activate'}</span>
              </button>
            ))}
          </div>
          <div class="tbtns">
            <button class="tbtn" onClick={() => send({ type: 'PASS', player: acting })}>
              Don't chain
            </button>
          </div>
        </div>
      );
    if (prompt?.kind === 'select') {
      const multi = prompt.max > 1 || prompt.min === 0;
      const mixed = mixedSides(e, prompt.options);
      return (
        <div class="tsheet mine-choice">
          <div class="tsheet-who">Your choice</div>
          <div class="tsheet-title">
            {prompt.title}
            {multi && (
              <span class="tsheet-count">
                {ctl.picks.length}/{prompt.max}
              </span>
            )}
          </div>
          <div class="toptions">
            {prompt.options.map((o, i) => {
              const name = optionCard(o);
              const side = mixed && o.uid !== undefined && e.fieldCard(o.uid) ? (e.controller(o.uid) === acting ? 'Yours: ' : 'Theirs: ') : '';
              return (
                <button key={i} class={`topt ${ctl.picks.includes(i) ? 'on' : ''} ${name ? '' : 'text'}`} onClick={() => ctl.togglePick(prompt, i)}>
                  {name !== null ? <CardImg name={name} back={name === ''} owner={name === '' && o.uid !== undefined ? e.fieldCard(o.uid)?.owner : undefined} /> : null}
                  {prompt.max > 1 && ctl.picks.includes(i) && <i class="topt-ord">{ctl.picks.indexOf(i) + 1}</i>}
                  <span class={name !== null ? 'topt-label' : 'topt-text'}>{side}{sideLabel(o, ctl.acting)}</span>
                </button>
              );
            })}
          </div>
          {(multi || prompt.cancel) && (
            <div class="tbtns">
              {multi && (
                <button class="tbtn main" disabled={ctl.picks.length < prompt.min} onClick={() => send({ type: 'CHOOSE', player: acting, picks: ctl.picks })}>
                  OK
                </button>
              )}
              {prompt.cancel && (
                <button class="tbtn" onClick={() => send({ type: 'CANCEL', player: acting })}>
                  Cancel
                </button>
              )}
            </div>
          )}
        </div>
      );
    }
    // (someone else's choice: the middle row says so)
    if (state.prompt && state.prompt.player !== acting) return null;
    if (mode)
      return (
        <div class="ttoast aim">
          {document.documentElement.classList.contains('pad-on') ? `Choose a target: A on a glowing monster${canDirect() ? ' or their portrait' : ''} · B cancels` : `Tap a glowing monster${canDirect() ? ' or their portrait' : ''}`}
          <button class="tbtn small" onClick={() => setMode(null)}>
            Cancel
          </button>
        </div>
      );
    // the first turns' hint: a small pill over your hand, never over the field
    const h = hint();
    if (h) return <div class="ttoast hint">{h}</div>;
    return null;
  };

  const forecast = (uid: number, target: number | null) => attackForecast(e, uid, target);

  const hint = (): string | null => {
    if (!myTurn || !idle || sel !== null || drag) return null;
    // (with a controller: the buttons, not the finger moves)
    const pad = document.documentElement.classList.contains('pad-on');
    if (state.phase === 'BP') {
      if (state.firstTurn) return null;
      // nothing left to swing: point at ending the turn instead
      if (!e.monsters(acting).some((m) => e.canAttackWith(acting, m))) return pad ? 'All done? X for phases, then End Turn' : 'All done? Tap the phase button to end your turn';
      return pad ? 'Pick a monster with A, then Attack' : 'Drag a monster onto a target to attack';
    }
    if (e.inMainPhase() && state.turn <= 4) return pad ? 'Press A on a card to play it · X for phases' : 'Drag a card up to play it, onto SET to Set it, or tap it';
    return null;
  };

  const handCount = me.hand.length;
  // Big screens: the hand's real card width and room, measured when it resizes (never during a render)
  const [handBox, setHandBox] = useState<{ cardW: number; room: number } | null>(null);
  useLayoutEffect(() => {
    const el = root.current?.querySelector('.thand');
    if (!el || !bigScreen() || typeof ResizeObserver === 'undefined') return void setHandBox(null);
    const measure = () => {
      const v = measuredHand(el);
      setHandBox((b) => (b && b.cardW === v.cardW && b.room === v.room ? b : v));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // (a card can change size while the row doesn't: --th-w follows the window's height)
    const card = el.querySelector('.thcard');
    if (card) ro.observe(card);
    return () => ro.disconnect();
  }, [handCount === 0, resized]);
  // Fan the hand: cards overlap more as the hand grows so it always fits the screen.
  // (the same sizes as layout.css: --th-w)
  const box = handBox ?? { cardW: handCardW(), room: handRoom() };
  const cardW = box.cardW;
  // (the outer cards of the 3D fan swing out by about 20px each: leave them that room)
  const room = box.room - 40;
  const overlap = handCount > 1 ? Math.min(0.8, Math.max(0, (handCount * cardW - room) / ((handCount - 1) * cardW))) : 0;

  // the other player has a choice open: the middle row says so (never what: a prompt's title can name
  // a card in their hand, their Extra Deck or a Set card)
  const theirAsk = state.winner === null && !!state.prompt && state.prompt.player !== acting;
  const midText = (
    <>
      <span class={`tturn ${state.turnPlayer === acting && !ctl.locked && !ctl.spectator ? 'mine' : ''}${theirAsk ? ' ask' : ''}`} key={`t${state.turn}${theirAsk ? 'a' : ''}`}>
        {(state.turnPlayer !== acting || theirAsk) && <i class="tturn-arrow up" aria-hidden="true" />}
        <b>{theirAsk ? `${first(state.prompt!.player)} is choosing` : myTurn && !ctl.locked && !ctl.spectator ? 'Your turn' : `${first(state.turnPlayer)}'s turn`}</b>
        {theirAsk || decider !== acting ? (
          <i class="tdots" aria-hidden="true">
            <i />
            <i />
            <i />
          </i>
        ) : null}
        {!theirAsk && <span class="tturn-ph">{PHASE_NAMES[state.phase]}</span>}
        {state.turnPlayer === acting && !theirAsk && <i class="tturn-arrow down" aria-hidden="true" />}
      </span>
    </>
  );

  /** a card in your hand that has something to do right now (a controller's hints say Play only on those) */
  const playable = canAct && myTurn && !prompt && state.winner === null && e.inMainPhase();
  const canPlayNow = (c: Card) => {
    if (!playable) return false;
    const info = cardInfo(c.name);
    if (info?.kind === 'monster') {
      const eff = getEffect(c.name);
      return e.canNormalSummon(acting, c) || (!!eff?.summonProc && e.canSpecialProc(acting, c)) || (!!eff?.handIgnition && e.canUseMonsterEffect(acting, c));
    }
    return (info?.kind === 'spell' && e.canActivateMain(acting, c.uid)) || e.canSet(acting, c);
  };
  /** a controller's Y: the full text of the card the ring is on (never a face-down card that isn't yours) */
  const padCardText = (ev: Event) => {
    const uid = Number((ev.target as HTMLElement).closest?.('[data-uid]')?.getAttribute('data-uid'));
    const found = Number.isFinite(uid) ? e.find(uid) : null;
    if (!found) return;
    const mine = found.loc.player === acting || !!ctl.spectator;
    const z = found.loc.zone;
    const open = z === 'hand' ? mine || ctl.oppHandShown : z === 'mz' || z === 'sz' || z === 'field' ? (found.card as FieldCard).faceUp || mine : z !== 'deck';
    if (!open) return;
    ev.preventDefault();
    ctl.setInfo(found.card.name, found.card.owner);
  };

  return (
    <div
      {...({ onpady: padCardText } as object)}
      class={`duel touch${armed ? ' armed' : ''} ${canAct ? '' : 'spectate'} ${drag ? 'dragging' : ''} ${mode ? 'aiming' : ''} ${e.speed ? 'speed' : ''} ${state.turnPlayer === acting ? 'turn-me' : 'turn-opp'}${theirAsk ? ' wait-them' : ''}${prompt && canAct && state.prompt?.player === acting ? ' my-choice' : ''} ph-${state.phase}${koOn && !resultUp ? ' ko' : ''}${loser !== null ? ` ko-${loser === acting ? 'me' : 'opp'}` : ''}`}
      ref={root}
      onClick={() => {
        setSel(null);
        setPhaseOpen(false);
      }}
    >
      <i class="tedge" key={`edge${state.turn}`} aria-hidden="true" />
      {lpBar(oppId, true)}
      <div class="topp-hand">
        {opp.hand.map((c, i) => (
          <div key={c.uid} data-uid={c.uid} style={{ '--arc': (i - (opp.hand.length - 1) / 2).toFixed(2), '--arc2': ((i - (opp.hand.length - 1) / 2) ** 2).toFixed(2) } as Record<string, string>} class={`thc ${anim?.uid === c.uid ? 'anim-draw' : ''}`} onClick={(ev) => (ev.stopPropagation(), ctl.oppHandShown && ctl.setInfo(c.name, c.owner))}>
            <CardImg name={c.name} back={!ctl.oppHandShown} owner={c.owner} />
          </div>
        ))}
      </div>

      {/* (outside the field box: its size containment would keep the preview under the figures and the turn row) */}
      <div class="tdetail-anchor">
        {selCard && canSeeSel && !drag && !mode && (
          <div class={`tdetail${detailRight ? ' right' : ''}`} onClick={(ev) => (ev.stopPropagation(), ctl.setInfo(selCard.name, selCard.owner))}>
            <span class="tdetail-pic">
              <CardImg name={selCard.name} class="tdetail-img" owner={selCard.owner} />
            </span>
            <div class="tdetail-text">
              <b>{e.nameOf(selCard)}</b>
              {e.nameOf(selCard) !== selCard.name && <small class="tdetail-printed">Card: {selCard.name} (its name is changed)</small>}
              <DetailLine name={selCard.name} />
              <CounterLines list={shownCounters(selField)} />
              <p>{cardInfo(selCard.name)?.desc}</p>
              <span class="tdetail-more">{document.documentElement.classList.contains('pad-on') ? 'Y: full text' : 'Tap for full text'}</span>
            </div>
          </div>
        )}
      </div>
      <div class="tboard">
        <div class="tarena" aria-hidden="true">
          <i class="tarena-glow" />
          <i class="tarena-floor" />
        </div>
        <div class="tmat" style={{ '--cols': String(me.mz.length + 2) } as Record<string, string>}>
          {e.speed && <FieldCracks level={state.winner == null ? dangerLevel(opp.lp, true) : 0} side="opp" />}
          {e.speed && <FieldCracks level={state.winner == null ? dangerLevel(me.lp, true) : 0} side="me" />}
          <div class="trow opp">
            {deck(oppId)}
            {opp.sz
              .map((c, i) => zone(c, oppId, 's', i))
              .slice()
              .reverse()}
            {fieldZone(oppId)}
          </div>
          <div class="trow opp">
            {gy(oppId)}
            {opp.mz
              .map((c, i) => zone(c, oppId, 'm', i))
              .slice()
              .reverse()}
            <div class="tz-spacer" />
          </div>
          <div class="tmid" ref={midRef}>
            {midText}
          </div>
          <div class="trow">
            <div class="tz-spacer" />
            {me.mz.map((c, i) => zone(c, acting, 'm', i))}
            {gy(acting)}
          </div>
          <div class="trow">
            {fieldZone(acting)}
            {me.sz.map((c, i) => zone(c, acting, 's', i))}
            {deck(acting)}
          </div>
        </div>

        <div class="tphase" onClick={(ev) => ev.stopPropagation()}>
          {phaseOpen && phaseItems.length > 0 && (
            <div class="tphase-menu">
              {phaseItems.map((it) => (
                <button key={it.label} class={`tphase-item ${it.label === 'End Turn' ? 'end' : ''}`} onClick={() => (setPhaseOpen(false), it.onPick())}>
                  {it.label}
                </button>
              ))}
            </div>
          )}
          <button
            class={`tphase-btn ${myTurn ? 'mine' : ''} ${phaseItems.length > 0 ? 'live' : ''}`}
            disabled={phaseItems.length === 0}
            onClick={() => {
              unlockAudio();
              playBlip();
              setPhaseOpen((o) => !o);
            }}
          >
            <span>{state.phase}</span>
            <small>T{state.turn}</small>
          </button>
        </div>

      </div>

      {/* a monster's counter badges, flat over the 3D field figures (see ctrBoxes) */}
      {ctrBoxes.length > 0 && (
        <div class="ctrfloat" aria-hidden="true">
          {ctrBoxes.map((b) => {
            const c = e.fieldCard(b.uid);
            return c ? (
              <div key={b.uid} class="ctrfloat-at" style={{ left: `${b.x}px`, top: `${b.y}px` }}>
                <CounterMarks list={shownCounters(c)} uid={b.uid} />
              </div>
            ) : null;
          })}
        </div>
      )}
      {/* the turn / phase row again, flat over the 3D field figures (the field's tilt keeps the
          row itself under the figures layer); only while the figures are on */}
      {midBox && (
        <div class="tmid tmid-float" style={{ top: `${midBox.top}px`, left: `${midBox.left}px`, width: `${midBox.width}px` }}>
          {midText}
        </div>
      )}
      {lpBar(acting, false)}
      <div class="thand" style={{ '--overlap': overlap.toFixed(3) } as Record<string, string>}>
        {me.hand.map((c, i) => {
          const arc = (i - (handCount - 1) / 2).toFixed(2);
          const cls = `thcard${canPlayNow(c) ? ' can' : ''} ${highlight(c.uid)} ${anim?.uid === c.uid && anim.kind === 'draw' ? 'anim-draw' : ''} ${drag?.uid === c.uid ? 'lifted' : ''}`;
          const shown = canAct || !!ctl.spectator || !!ctl.locked;
          return (
            <Piece
              key={c.uid}
              sig={`${cls}|${c.name}|${arc}|${shown}`}
              render={() => (
                <div
                  data-uid={c.uid}
                  style={{ '--arc': arc, '--arc2': ((i - (handCount - 1) / 2) ** 2).toFixed(2) } as Record<string, string>}
                  class={cls}
                  onClick={(ev) => (ev.stopPropagation(), live.current.tapCard(c.uid))}
                  {...liveDrag(c, 'hand')}
                >
                  <CardImg name={c.name} back={!shown} owner={c.owner} />
                  {shown && <i class="tshine" aria-hidden="true" />}
                  {shown && <span class="hname">{c.name}</span>}
                </div>
              )}
            />
          );
        })}
        {handCount === 0 && <div class="thint">No cards in hand</div>}
      </div>

      {bubble && (
        <div class={`tactions ${bubble.below ? 'below' : ''}`} style={{ left: `${bubble.x}px`, top: `${bubble.y}px` }} onClick={(ev) => ev.stopPropagation()}>
          {actions.map((c) => (
            <button key={c.label} data-label={c.label.split(' ·')[0]} class={`taction ${c.label === 'Attack' || c.label === 'Summon' || c.label === 'Activate' ? 'main' : ''}`} onClick={c.onPick}>
              {c.label}
            </button>
          ))}
        </div>
      )}

      <div class="tsheet-wrap" onClick={(ev) => ev.stopPropagation()}>
        {sheet()}
      </div>

      {state.chain.length > 0 && (
        <div class="tchain" onClick={(ev) => ev.stopPropagation()}>
          <span class="tchain-title">Chain</span>
          {state.chain.map((l, i) => (
            <button key={i} class={`tlink ${l.player === acting ? 'mine' : 'theirs'} ${l.negated ? 'neg' : ''}`} onClick={() => ctl.setInfo(l.card.name, l.card.owner)}>
              <CardImg name={l.card.name} owner={l.card.owner} />
              <span>{i + 1}</span>
            </button>
          ))}
        </div>
      )}

      {banner && (
        <div key={banner.key} class={`tbanner ${banner.kind}`}>
          {banner.kind !== 'phase' && <i class="tsweep" />}
          <b>{banner.text}</b>
          {banner.sub && <small>{banner.sub}</small>}
        </div>
      )}

      {spot && (
        <div key={spot.key} class="tspot">
          <CardImg name={spot.name} />
          <span>{spot.who}</span>
        </div>
      )}

      {drag && spots?.has('set') && (
        <div class={`tset-pad ${drag.over === 'set' ? 'drop-on' : ''}`} data-drop="set" aria-label="Set face-down">
          <span class="tset-card" />
          <b>SET</b>
          <small>face-down</small>
        </div>
      )}
      {drag && drag.from === 'mz' && drag.over && (drag.over === 'direct' || drag.over.startsWith('t')) && (() => {
        const f = forecast(drag.uid, drag.over === 'direct' ? null : Number(drag.over.slice(1)));
        return f ? (
          <div class={`tforecast ${f.tone}`} style={{ left: `${Math.min(window.innerWidth - 100, Math.max(100, drag.x))}px`, top: `${Math.max(8, drag.y - 120)}px` }}>
            <b>{f.vs}</b>
            <span>{f.text}</span>
          </div>
        ) : null;
      })()}
      {drag && (
        <div class={`tghost ${drag.over ? 'over' : ''}`} style={{ left: `${drag.x}px`, top: `${drag.y}px` }}>
          <CardImg name={drag.name} owner={e.find(drag.uid)?.card.owner} />
        </div>
      )}

      {overlays}
    </div>
  );
}

function DetailLine({ name }: { name: string }) {
  const info = cardInfo(name);
  if (!info) return null;
  if (info.kind === 'monster')
    return (
      <span class="tdetail-type">
        {'★'.repeat(Math.min(info.level ?? 0, 12))} {info.attribute}/{info.race}
        <br />
        ATK {info.atk} · DEF {info.def}
      </span>
    );
  return <span class="tdetail-type">{`${info.sub} ${info.kind === 'spell' ? spellWord() : 'Trap'}`}</span>;
}

/**
 * A piece of the board drawn again only when its `sig` (what it shows) changes: the engine
 * reports every step of a turn and the screen renders for each, but most zones are unchanged.
 * Its handlers must read through a ref (they are kept from the render that drew it).
 */
const Piece = memo(
  ({ render }: { sig: string; render: () => VNode }) => render(),
  (a, b) => a.sig === b.sig,
);
