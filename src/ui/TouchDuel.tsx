// Touch controls: a Master Duel-style duel screen. Tap a card to see it and what it can do,
// drag a card from your hand onto the field to play it, drag a monster onto a target to attack.
// The rules and every move go through the same engine actions as the Classic screen.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DuelSession } from '../eds/session';
import type { Engine } from '../eds/engine';
import { other } from '../eds/engine';
import type { Card, DuelState, FieldCard, Pid, PlayerState, Prompt, SelectOption } from '../eds/types';
import { card as cardInfo } from '../eds/db';
import { CardImg } from './CardImg';
import type { Command, Mode } from './Duel';
import { playBlip, unlockAudio } from './sound';
import { LpCount } from '../art/flow';
import { spellWord } from './gameUi';

type Action = Parameters<DuelSession['send']>[0];
type SelectPrompt = Extract<Prompt, { kind: 'select' }>;

export interface TouchCtl {
  state: DuelState;
  e: Engine;
  acting: Pid;
  mySeat: Pid;
  hotseat: boolean;
  me: PlayerState;
  opp: PlayerState;
  canAct: boolean;
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
  setInfo: (name: string | null) => void;
  setPile: (p: { title: string; cards: Card[] } | null) => void;
  /** show a player's Speed Duel Skill */
  openSkill: (p: Pid) => void;
  openMenu: () => void;
  setShowLog: (v: boolean) => void;
  onFinished: (winner: Pid | 'draw') => void;
}

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
  const [, setResized] = useState(0);
  useEffect(() => {
    const on = () => setResized((n) => n + 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  useLayoutEffect(() => {
    const el = midRef.current;
    const b = el && document.body.classList.contains('art3d-on') ? el.getBoundingClientRect() : null;
    const box = b && b.width > 0 ? { top: Math.round(b.top), left: Math.round(b.left), width: Math.round(b.width) } : null;
    if (box?.top !== midBox?.top || box?.left !== midBox?.left || box?.width !== midBox?.width) setMidBox(box);
  });

  const idle = canAct && !prompt && state.winner === null;
  const actions = commands.filter((c) => !c.disabled && c.label !== 'Card Info');

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
  const turnWho = state.turnPlayer === acting && !ctl.locked ? 'YOUR TURN' : `${state.players[state.turnPlayer].name.toUpperCase()}'S TURN`;
  useEffect(() => {
    if (state.winner !== null) return;
    if (state.turn === 1 && state.log.length < 6) showBanner('DUEL!', 'duel', 1300, turnWho);
    else showBanner(turnWho, state.turnPlayer === acting ? 'mine' : 'theirs', 1100, `Turn ${state.turn}`);
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
      const below = r.top < 150;
      // A hand card's buttons sit above your Life Points bar, never over it (or your portrait).
      const bar = el.closest('.thand') ? root.current?.querySelector('.tbar.bottom')?.getBoundingClientRect() : null;
      const top = bar ? Math.min(r.top, bar.top) : r.top;
      setBubble({ x, y: below ? r.bottom + 6 : top - 6, below });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [sel, actions.length, mode, state]);

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
        if (e.canNormalSummon(acting, f.card)) me.mz.forEach((z, i) => (e.monsterZoneOpen(acting, i) || (z !== null && (info.level ?? 0) >= 5)) && out.add(`mz${i}`));
      } else {
        const ok = (info?.kind === 'spell' && e.canActivateMain(acting, uid)) || e.canSet(acting, f.card);
        if (ok) {
          me.sz.forEach((z, i) => z === null && out.add(`sz${i}`));
          if (info?.sub === 'Field') out.add('field');
        }
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
      if (spot.startsWith('mz')) send({ type: 'SUMMON', player: acting, uid: d.uid, zone: Number(spot.slice(2)), pos: 'atk', faceUp: true });
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
  const onUp = (ev: PointerEvent) => {
    const p = press.current;
    press.current = null;
    if (!p || p.id !== ev.pointerId || !drag) return;
    dragged.current = true;
    setTimeout(() => (dragged.current = false), 50);
    const d = { ...drag, over: spotAt(ev.clientX, ev.clientY, spots!) };
    setDrag(null);
    drop(d);
  };
  const onCancel = () => {
    press.current = null;
    setDrag(null);
  };
  const dragProps = (c: Card, from: 'hand' | 'mz') => ({
    onPointerDown: (ev: PointerEvent) => onDown(ev, c, from),
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onCancel,
  });

  const tapCard = (uid: number) => {
    if (dragged.current) return;
    setPhaseOpen(false);
    tap(uid);
  };

  const spotCls = (id: string) => (spots ? (spots.has(id) ? (drag?.over === id ? ' drop-on' : ' drop-ok') : '') : '');

  // ----- field pieces -----
  const zone = (c: FieldCard | null, owner: Pid, kind: 'm' | 's', i: number) => {
    const visible = c ? c.faceUp || owner === acting || !!ctl.spectator : false;
    const mine = owner === acting;
    const dropId = mine ? `${kind}z${i}` : c && kind === 'm' ? `t${c.uid}` : undefined;
    const draggable = mine && kind === 'm' && c && state.phase === 'BP';
    return (
      <div
        key={`${owner}${kind}${i}`}
        class={`tz tz-${kind} ${c ? '' : 'empty'} ${c ? highlight(c.uid) : ''}${dropId ? spotCls(dropId) : ''}`}
        data-uid={c?.uid}
        data-drop={dropId}
        onClick={(ev) => {
          ev.stopPropagation();
          if (c) tapCard(c.uid);
          else setSel(null);
        }}
        {...(draggable ? dragProps(c, 'mz') : {})}
      >
        {c && (
          <div class={`fcard ${c.pos === 'def' ? 'def' : ''} ${c.faceUp ? '' : 'fd'} ${!c.faceUp && visible ? 'myset' : ''}`}>
            <CardImg name={c.name} back={!visible} owner={c.owner} />
            {!c.faceUp && visible && <span class="setmark">SET</span>}
          </div>
        )}
        {c && c.faceUp && kind === 'm' && (
          <div class={`tstat ${c.pos === 'def' ? 'def' : ''}`}>
            {c.pos === 'atk' ? e.atkOf(c) : e.defOf(c)}
          </div>
        )}
        {c && c.equips.length > 0 && <div class="eqmark">{c.equips.length}</div>}
        {c && (c.mats?.length ?? 0) > 0 && <div class="matmark" title="Xyz Materials">{c.mats!.length}</div>}
      </div>
    );
  };

  const fieldZone = (p: Pid) => {
    const ps = state.players[p];
    const mine = p === acting;
    return (
      <div
        class={`tz tz-f ${ps.field ? '' : 'empty'} ${ps.field ? highlight(ps.field.uid) : ''}${mine ? spotCls('field') : ''}${ps.field && !ps.field.faceUp && (mine || ctl.spectator) ? ' myset' : ''}`}
        data-uid={ps.field?.uid}
        data-drop={mine ? 'field' : undefined}
        onClick={(ev) => {
          ev.stopPropagation();
          if (ps.field) tapCard(ps.field.uid);
        }}
      >
        {ps.field ? <CardImg name={ps.field.name} back={!ps.field.faceUp && !mine && !ctl.spectator} /> : <span class="tz-label">FIELD</span>}
        {ps.field && !ps.field.faceUp && (mine || ctl.spectator) && <span class="setmark">SET</span>}
      </div>
    );
  };

  const gy = (p: Pid) => {
    const ps = state.players[p];
    return (
      <button class="tpile" onClick={(ev) => (ev.stopPropagation(), ctl.setPile({ title: `${ps.name}'s Graveyard`, cards: ps.gy }))}>
        {ps.gy.length > 0 ? <CardImg name={ps.gy[ps.gy.length - 1].name} /> : <span class="tz-label">GY</span>}
        <span class="tcount">{ps.gy.length}</span>
      </button>
    );
  };

  const deck = (p: Pid) => {
    const ps = state.players[p];
    const extra = ps.fusion.length > 0 || ps.removed.length > 0;
    return (
      <div class="tpile deck">
        {ps.deck.length > 0 ? <CardImg name="" back /> : <span class="tz-label">DECK</span>}
        <span class="tcount">{ps.deck.length}</span>
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

  const lpBar = (p: Pid, top: boolean) => {
    const ps = state.players[p];
    const hurt = anim && (anim.kind === 'damage' || anim.kind === 'heal') && anim.player === p ? `lp-${anim.kind}` : '';
    const isTurn = state.turnPlayer === p;
    const directOk = top && spots?.has('direct');
    return (
      <div
        class={`tbar ${top ? 'top' : 'bottom'} ${isTurn ? 'turn' : ''}${directOk ? (drag?.over === 'direct' ? ' drop-on' : ' drop-ok') : ''} ${mode && top && canDirect() ? 'drop-ok' : ''}`}
        data-drop={top ? 'direct' : undefined}
        onClick={() => top && mode && canDirect() && (send({ type: 'ATTACK', player: acting, uid: mode.uid, target: null }), setMode(null))}
      >
        <div class="tavatar">{ps.name.slice(0, 1).toUpperCase()}</div>
        <div class="tname">
          <b>{ps.name}</b>
          <span>
            Hand {ps.hand.length}
            {!top && ps.normalSummoned ? ' · Summoned' : ''}
          </span>
        </div>
        {ps.skill && (
          <button
            class={`tskill ${ps.skillRevealed ? 'up' : ''} ${p === acting && canAct && e.canUseSkill(acting) ? 'ready' : ''}`}
            onClick={(ev) => (ev.stopPropagation(), ctl.openSkill(p))}
          >
            Skill
          </button>
        )}
        <div class={`tlp ${hurt}`}>
          <small>LP</small>
          <LpCount value={ps.lp} who={p} />
          {anim && anim.kind === 'damage' && anim.player === p && <span class="dmg">-{anim.amount}</span>}
        </div>
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
        <div class="tsheet">
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
        <div class="tsheet">
          <div class="tsheet-title">{prompt.title}</div>
          <div class="toptions">
            {prompt.options.map((o, i) => (
              <button key={i} class="topt" onClick={() => send({ type: 'CHOOSE', player: acting, picks: [i] })}>
                {optionCard(o) ? <CardImg name={optionCard(o)!} /> : <span class="topt-text">{o.label}</span>}
                <span class="topt-label">Activate</span>
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
      return (
        <div class="tsheet">
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
              return (
                <button key={i} class={`topt ${ctl.picks.includes(i) ? 'on' : ''} ${name ? '' : 'text'}`} onClick={() => ctl.togglePick(prompt, i)}>
                  {name !== null ? <CardImg name={name} back={name === ''} /> : null}
                  <span class={name !== null ? 'topt-label' : 'topt-text'}>{o.label}</span>
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
    if (state.prompt && state.prompt.player !== acting) return <div class="ttoast">{state.players[state.prompt.player].name} is deciding…</div>;
    if (mode)
      return (
        <div class="ttoast aim">
          Tap a glowing monster{canDirect() ? ' or their portrait' : ''} to attack
          <button class="tbtn small" onClick={() => setMode(null)}>
            Cancel
          </button>
        </div>
      );
    return null;
  };

  const hint = (): string | null => {
    if (!myTurn || !idle || sel !== null || drag) return null;
    if (state.phase === 'BP') return state.firstTurn ? null : 'Drag a monster onto a target to attack';
    if (e.inMainPhase() && state.turn <= 4) return 'Drag a card up to play it, or tap it for options';
    return null;
  };

  const handCount = me.hand.length;
  // Fan the hand: cards overlap more as the hand grows so it always fits the screen.
  // (the same sizes as layout.css: --th-w)
  const cardW = window.innerWidth <= 380 ? 64 : window.innerHeight >= 760 ? 78 : 70;
  const room = Math.min(window.innerWidth, 560) - 20;
  const overlap = handCount > 1 ? Math.min(0.8, Math.max(0, (handCount * cardW - room) / ((handCount - 1) * cardW))) : 0;

  const midText = (
    <>
      <span class={`tturn ${myTurn ? 'mine' : ''}`}>
        {myTurn && !ctl.locked ? 'Your turn' : `${state.players[state.turnPlayer].name}'s turn`} · {PHASE_NAMES[state.phase]}
      </span>
      {hint() && <span class="thint">{hint()}</span>}
    </>
  );

  return (
    <div
      class={`duel touch ${canAct ? '' : 'spectate'} ${drag ? 'dragging' : ''} ${e.speed ? 'speed' : ''}`}
      ref={root}
      onClick={() => {
        setSel(null);
        setPhaseOpen(false);
      }}
    >
      {lpBar(oppId, true)}
      <div class="topp-hand">
        {opp.hand.map((c) => (
          <div key={c.uid} class={`thc ${anim?.uid === c.uid ? 'anim-draw' : ''}`} onClick={(ev) => (ev.stopPropagation(), ctl.oppHandShown && ctl.setInfo(c.name))}>
            <CardImg name={c.name} back={!ctl.oppHandShown} owner={c.owner} />
          </div>
        ))}
      </div>

      <div class="tboard">
        <div class="tmat" style={{ '--cols': String(me.mz.length + 2) } as Record<string, string>}>
          <div class="trow">
            {deck(oppId)}
            {opp.sz
              .map((c, i) => zone(c, oppId, 's', i))
              .slice()
              .reverse()}
            {fieldZone(oppId)}
          </div>
          <div class="trow">
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
              setPhaseOpen(!phaseOpen);
            }}
          >
            <span>{state.phase}</span>
            <small>T{state.turn}</small>
          </button>
        </div>

        {selCard && canSeeSel && !drag && (
          <div class="tdetail" onClick={(ev) => (ev.stopPropagation(), ctl.setInfo(selCard.name))}>
            <CardImg name={selCard.name} class="tdetail-img" owner={selCard.owner} />
            <div class="tdetail-text">
              <b>{selCard.name}</b>
              <DetailLine name={selCard.name} />
              <p>{cardInfo(selCard.name)?.desc}</p>
              <span class="tdetail-more">Tap for full text</span>
            </div>
          </div>
        )}
      </div>

      {/* the turn / phase row again, flat over the 3D field figures (the field's tilt keeps the
          row itself under the figures layer); only while the figures are on */}
      {midBox && (
        <div class="tmid tmid-float" style={{ top: `${midBox.top}px`, left: `${midBox.left}px`, width: `${midBox.width}px` }}>
          {midText}
        </div>
      )}
      {lpBar(acting, false)}
      <div class="thand" style={{ '--overlap': overlap.toFixed(3) } as Record<string, string>}>
        {me.hand.map((c) => (
          <div
            key={c.uid}
            data-uid={c.uid}
            class={`thcard ${highlight(c.uid)} ${anim?.uid === c.uid && anim.kind === 'draw' ? 'anim-draw' : ''} ${drag?.uid === c.uid ? 'lifted' : ''}`}
            onClick={(ev) => (ev.stopPropagation(), tapCard(c.uid))}
            {...dragProps(c, 'hand')}
          >
            <CardImg name={c.name} back={!canAct && !ctl.spectator && !ctl.locked} owner={c.owner} />
            {(canAct || ctl.spectator || ctl.locked) && <span class="hname">{c.name}</span>}
          </div>
        ))}
        {handCount === 0 && <div class="thint">No cards in hand</div>}
      </div>

      {bubble && (
        <div class={`tactions ${bubble.below ? 'below' : ''}`} style={{ left: `${bubble.x}px`, top: `${bubble.y}px` }} onClick={(ev) => ev.stopPropagation()}>
          {actions.map((c) => (
            <button key={c.label} class={`taction ${c.label === 'Attack' || c.label === 'Summon' || c.label === 'Activate' ? 'main' : ''}`} onClick={c.onPick}>
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
            <button key={i} class={`tlink ${l.player === acting ? 'mine' : 'theirs'} ${l.negated ? 'neg' : ''}`} onClick={() => ctl.setInfo(l.card.name)}>
              <CardImg name={l.card.name} />
              <span>{i + 1}</span>
            </button>
          ))}
        </div>
      )}

      {banner && (
        <div key={banner.key} class={`tbanner ${banner.kind}`}>
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
