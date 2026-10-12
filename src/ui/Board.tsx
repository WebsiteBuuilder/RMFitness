import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Session, SessionView } from '../game/session';
import type { CardInst, Loc, Phase, PlayerId, PlayerState, ZoneName } from '../game/types';
import { PHASES, PHASE_LABEL } from '../game/types';
import { findCard, lastUndoable, zoneLabel } from '../game/reducer';
import { randomSeed } from '../game/rng';
import { cardById, cardImageUrl } from '../data/cards';
import { CardFace, CardView } from './CardView';
import { Action, Modal, Sheet } from './Sheet';
import { playAlert, playHit, playSummon, unlockAudio } from './sound';

type SheetState =
  | { kind: 'card'; iid: string }
  | { kind: 'pile'; player: PlayerId; zone: 'deck' }
  | { kind: 'lp'; player: PlayerId }
  | { kind: 'battle'; attacker: string; target: string | null }
  | { kind: 'menu' }
  | null;

type ModalState =
  | { kind: 'browse'; player: PlayerId; zone: 'deck' | 'gy' | 'banished' | 'extra' }
  | { kind: 'read'; iid: string }
  | { kind: 'log' }
  | null;

interface Targeting {
  iid: string;
  zone: 'm' | 's';
  faceDown: boolean;
  defense: boolean;
  token?: boolean;
}

/** A drop target on the table, encoded in data-drop as "zone:index:player". */
interface Drop {
  zone: ZoneName | 'player';
  index: number;
  player: PlayerId;
}

interface Drag {
  iid: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  over: string | null;
}

function other(p: PlayerId): PlayerId {
  return p === 0 ? 1 : 0;
}

function dropKey(d: Drop): string {
  return `${d.zone}:${d.index}:${d.player}`;
}

function parseDrop(key: string): Drop {
  const [zone, index, player] = key.split(':');
  return { zone: zone as Drop['zone'], index: Number(index), player: Number(player) as PlayerId };
}

function isMonster(card: CardInst): boolean {
  const d = cardById(card.cardId);
  return d ? /Monster/i.test(d.type) : card.token || card.cardId === null;
}
function isTrap(card: CardInst): boolean {
  return /Trap/i.test(cardById(card.cardId)?.type ?? '');
}
function isFieldSpell(card: CardInst): boolean {
  const d = cardById(card.cardId);
  return !!d && /Spell/i.test(d.type) && /Field/i.test(d.race ?? '');
}
function isExtraType(card: CardInst): boolean {
  return /Fusion|Synchro|XYZ|Xyz|Link/i.test(cardById(card.cardId)?.type ?? '');
}
function atkOf(card: CardInst): number {
  return cardById(card.cardId)?.atk ?? 0;
}
function defOf(card: CardInst): number {
  return cardById(card.cardId)?.def ?? 0;
}

export function Board({ session, view, mySeat, hotseat, onSwap, onLeave }: { session: Session; view: SessionView; mySeat: PlayerId; hotseat: boolean; onSwap: () => void; onLeave: () => void }) {
  const { state, events, status, detail } = view;
  const me = state.players[mySeat];
  const opp = state.players[other(mySeat)];
  const [sheet, setSheet] = useState<SheetState>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [targeting, setTargeting] = useState<Targeting | null>(null);
  const [locked, setLocked] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [passScreen, setPassScreen] = useState(false);
  const dragRef = useRef<Drag | null>(null);
  const suppressTap = useRef(false);
  const seenSummon = useRef<number>(-1);
  const seenLp = useRef<[number, number] | null>(null);
  const seenWait = useRef<PlayerId | null>(null);
  const seenTurn = useRef<number>(state.turn);

  const send = (ev: Parameters<Session['send']>[0]) => {
    unlockAudio();
    session.send(ev);
  };

  // Keep the screen awake during a duel (where the browser allows it).
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const request = async () => {
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        if (wl && document.visibilityState === 'visible') lock = await wl.request('screen');
      } catch {
        /* not available */
      }
    };
    void request();
    const onVis = () => void request();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release();
    };
  }, []);

  // Summon flash and sound, LP hit sound, Wait alert, hotseat hand-over.
  useEffect(() => {
    const s = state.lastSummon;
    if (s && s.seq !== seenSummon.current) {
      if (seenSummon.current >= 0) playSummon();
      seenSummon.current = s.seq;
    }
    const lp: [number, number] = [state.players[0].lp, state.players[1].lp];
    if (seenLp.current && (lp[0] < seenLp.current[0] || lp[1] < seenLp.current[1])) playHit();
    seenLp.current = lp;
    if (state.waitFlag !== null && state.waitFlag !== seenWait.current && state.waitFlag !== mySeat) playAlert();
    seenWait.current = state.waitFlag;
    if (hotseat && state.turn !== seenTurn.current) {
      seenTurn.current = state.turn;
      setPassScreen(true);
    }
  }, [state, mySeat, hotseat]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const myUndo = useMemo(() => lastUndoable(events, mySeat), [events, mySeat]);

  const canSee = (card: CardInst, loc: Loc) => !card.faceDown || loc.player === mySeat;

  const move = (iid: string, to: Loc, faceDown?: boolean, defense?: boolean) => {
    send({ type: 'MOVE', player: mySeat, iid, to, faceDown, defense });
    setSheet(null);
    setModal(null);
    setTargeting(null);
  };

  const startTargeting = (t: Targeting) => {
    setTargeting(t);
    setSheet(null);
    setModal(null);
  };

  // ---------- drops (shared by drag and by tap-targeting) ----------

  /** Handles a card landing on a drop target. Returns a message when nothing happened. */
  const dropCard = (iid: string, d: Drop): string | null => {
    const f = findCard(state, iid);
    if (!f) return null;
    const { card, loc } = f;
    const p = state.players[d.player];
    if (d.zone === 'm' || d.zone === 's') {
      const arr = d.zone === 'm' ? p.monsters : p.spells;
      const occupant = arr[d.index];
      if (occupant && occupant.iid === iid) return null;
      if (occupant) {
        // Dropping a monster onto an opponent's monster declares an attack.
        if (d.zone === 'm' && loc.zone === 'm' && loc.player === mySeat && d.player !== mySeat && isMonster(card)) {
          setSheet({ kind: 'battle', attacker: iid, target: occupant.iid });
          return null;
        }
        return 'That zone is taken';
      }
      if (d.zone === 'm' && !isMonster(card)) return 'Only monsters go in Monster Zones';
      if (d.zone === 's' && isMonster(card)) return 'Spells and Traps go in the Spell/Trap Zones';
      if (loc.zone === 'm' || loc.zone === 's' || loc.zone === 'field' || loc.zone === 'skill') {
        move(iid, { player: d.player, zone: d.zone, index: d.index }, card.faceDown, d.zone === 'm' ? card.defense : false);
      } else if (d.zone === 'm') {
        move(iid, { player: d.player, zone: 'm', index: d.index }, false, false);
      } else {
        const faceDown = isTrap(card);
        move(iid, { player: d.player, zone: 's', index: d.index }, faceDown, false);
      }
      return null;
    }
    if (d.zone === 'field') {
      if (p.field && p.field.iid !== iid) return 'The Field Zone is taken';
      if (!isFieldSpell(card) && loc.zone !== 'field') return 'Only Field Spells go in the Field Zone';
      move(iid, { player: d.player, zone: 'field' }, card.faceDown && loc.zone === 'field' ? card.faceDown : false);
      return null;
    }
    if (d.zone === 'player') {
      if (loc.zone === 'm' && loc.player === mySeat && d.player !== mySeat && isMonster(card)) {
        setSheet({ kind: 'battle', attacker: iid, target: null });
        return null;
      }
      return null;
    }
    if (d.zone === 'deck') {
      if (isExtraType(card)) return 'Extra Deck monsters go back to the Extra Deck';
      move(iid, { player: card.owner, zone: 'deck', place: 'top' });
      return null;
    }
    if (d.zone === 'extra') {
      if (!isExtraType(card)) return 'Only Fusion monsters go in the Extra Deck';
      move(iid, { player: card.owner, zone: 'extra' });
      return null;
    }
    if (d.zone === 'gy' || d.zone === 'banished' || d.zone === 'hand') {
      move(iid, { player: card.owner, zone: d.zone });
      return null;
    }
    return null;
  };

  // ---------- pointer drag ----------

  const onCardPointerDown = (iid: string) => (e: PointerEvent) => {
    if (locked || targeting) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const f = findCard(state, iid);
    if (!f) return;
    // Opponent's hidden cards cannot be dragged; everything on the table can (manual table).
    if (f.loc.zone === 'hand' && f.loc.player !== mySeat) return;
    const d: Drag = { iid, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, active: false, over: null };
    dragRef.current = d;
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const onMove = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const dx = ev.clientX - cur.startX;
      const dy = ev.clientY - cur.startY;
      if (!cur.active && Math.hypot(dx, dy) < 10) return;
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = under?.closest<HTMLElement>('[data-drop]')?.dataset.drop ?? null;
      const next = { ...cur, x: ev.clientX, y: ev.clientY, active: true, over: target };
      dragRef.current = next;
      setDrag(next);
    };
    const finish = (ev: PointerEvent, cancelled: boolean) => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      const cur = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!cur) return;
      if (cur.active) {
        suppressTap.current = true;
        setTimeout(() => (suppressTap.current = false), 300);
        if (cancelled) return;
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const key = under?.closest<HTMLElement>('[data-drop]')?.dataset.drop;
        if (key) {
          const msg = dropCard(cur.iid, parseDrop(key));
          if (msg) setToast(msg);
        }
      }
    };
    const onUp = (ev: PointerEvent) => finish(ev, false);
    const onCancel = (ev: PointerEvent) => finish(ev, true);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
  };

  const tapCard = (iid: string) => {
    if (suppressTap.current) return;
    if (locked) {
      setToast('Board is locked');
      return;
    }
    setSheet({ kind: 'card', iid });
  };

  // ---------- taps on zones ----------

  const onSlotTap = (player: PlayerId, zone: 'm' | 's', index: number, card: CardInst | null) => {
    if (suppressTap.current) return;
    if (targeting) {
      if (card) {
        setToast('That zone is taken');
        return;
      }
      if (zone !== targeting.zone) {
        setToast(`Pick a ${targeting.zone === 'm' ? 'Monster' : 'Spell/Trap'} Zone`);
        return;
      }
      if (targeting.token) {
        send({ type: 'TOKEN', player: mySeat, index, name: 'Token' });
        setTargeting(null);
        return;
      }
      move(targeting.iid, { player, zone, index }, targeting.faceDown, targeting.defense);
      return;
    }
    if (card) tapCard(card.iid);
  };

  const onSingleTap = (player: PlayerId, zone: 'field' | 'skill', card: CardInst | null) => {
    if (suppressTap.current) return;
    if (targeting) {
      setToast('Pick a zone on the field');
      return;
    }
    if (card) tapCard(card.iid);
    else if (zone === 'field') setToast(`${player === mySeat ? 'Your' : "Opponent's"} Field Zone is empty`);
  };

  const onPileTap = (player: PlayerId, zone: 'deck' | 'gy' | 'banished' | 'extra' | 'hand') => {
    if (suppressTap.current) return;
    if (targeting) {
      setToast('Pick a zone on the field, or cancel');
      return;
    }
    if (zone === 'hand') return;
    if (zone === 'deck') {
      if (player !== mySeat) {
        setToast(`${opp.name}'s Deck: ${opp.deck.length} cards`);
        return;
      }
      setSheet({ kind: 'pile', player, zone: 'deck' });
      return;
    }
    if (zone === 'extra' && player !== mySeat) {
      setToast(`${opp.name}'s Extra Deck: ${opp.extra.length} cards`);
      return;
    }
    setModal({ kind: 'browse', player, zone });
  };

  // ---------- sheets ----------

  const cardActions = (iid: string): { title: string; subtitle: string; card: CardInst; visible: boolean; actions: Action[] } | null => {
    const f = findCard(state, iid);
    if (!f) return null;
    const { card, loc } = f;
    const visible = canSee(card, loc);
    const title = visible ? card.name : 'Face-down card';
    const subtitle = `${loc.player === mySeat ? 'Your' : `${opp.name}'s`} ${zoneLabel(loc)}`;
    const a: Action[] = [];
    const toOwner = (zone: ZoneName, place?: 'top' | 'bottom'): Loc => ({ player: card.owner, zone, place });
    const z = loc.zone;

    if (z === 'hand' || z === 'gy' || z === 'banished' || z === 'extra' || z === 'deck') {
      if (isMonster(card) && !card.token) {
        a.push({ label: 'Summon (Attack)', tone: 'primary', onPick: () => startTargeting({ iid, zone: 'm', faceDown: false, defense: false }) });
        a.push({ label: 'Set (face-down Defense)', onPick: () => startTargeting({ iid, zone: 'm', faceDown: true, defense: true }) });
        a.push({ label: 'Special Summon (Defense)', onPick: () => startTargeting({ iid, zone: 'm', faceDown: false, defense: true }) });
      } else if (!card.token) {
        if (isFieldSpell(card)) a.push({ label: 'Activate in Field Zone', tone: 'primary', onPick: () => move(iid, toOwner('field'), false) });
        a.push({ label: 'Activate (face-up)', tone: isFieldSpell(card) ? undefined : 'primary', onPick: () => startTargeting({ iid, zone: 's', faceDown: false, defense: false }) });
        a.push({ label: 'Set (face-down)', onPick: () => startTargeting({ iid, zone: 's', faceDown: true, defense: false }) });
      }
      if (z === 'hand') a.push({ label: 'Reveal to opponent', onPick: () => (send({ type: 'REVEAL', player: mySeat, iid }), setSheet(null)) });
    }
    if (z === 'm') {
      if (loc.player === mySeat && !card.faceDown) a.push({ label: 'Attack…', tone: 'primary', onPick: () => setSheet({ kind: 'battle', attacker: iid, target: opp.monsters.find((m) => m)?.iid ?? null }) });
      a.push({ label: card.defense ? 'Change to Attack Position' : 'Change to Defense Position', tone: loc.player === mySeat && !card.faceDown ? undefined : 'primary', onPick: () => (send({ type: 'POSITION', player: mySeat, iid }), setSheet(null)) });
      a.push({ label: card.faceDown ? 'Flip face-up (Flip Summon)' : 'Flip face-down', onPick: () => (send({ type: 'FLIP', player: mySeat, iid }), setSheet(null)) });
      a.push({ label: 'Move to another Monster Zone', onPick: () => startTargeting({ iid, zone: 'm', faceDown: card.faceDown, defense: card.defense }) });
    }
    if (z === 's') {
      a.push({ label: card.faceDown ? 'Activate (flip face-up)' : 'Flip face-down', tone: 'primary', onPick: () => (send({ type: 'FLIP', player: mySeat, iid }), setSheet(null)) });
      a.push({ label: 'Move to another Spell/Trap Zone', onPick: () => startTargeting({ iid, zone: 's', faceDown: card.faceDown, defense: false }) });
    }
    if (z === 'field') {
      a.push({ label: card.faceDown ? 'Activate (flip face-up)' : 'Flip face-down', tone: 'primary', onPick: () => (send({ type: 'FLIP', player: mySeat, iid }), setSheet(null)) });
    }
    if (z === 'skill') {
      a.push({ label: card.faceDown ? 'Activate Skill (flip face-up)' : 'Flip Skill face-down', tone: 'primary', onPick: () => (send({ type: 'FLIP', player: mySeat, iid }), setSheet(null)) });
    }
    if (z === 'm' || z === 's' || z === 'field' || z === 'skill') {
      a.push({ label: `Add counter (${card.counters})`, onPick: () => (send({ type: 'COUNTER', player: mySeat, iid, delta: 1 }), setSheet(null)) });
      if (card.counters > 0) a.push({ label: 'Remove counter', onPick: () => (send({ type: 'COUNTER', player: mySeat, iid, delta: -1 }), setSheet(null)) });
    }
    if (z !== 'skill' && !card.token) {
      if (z !== 'gy') a.push({ label: 'To Graveyard', onPick: () => move(iid, toOwner('gy')) });
      if (z !== 'banished') a.push({ label: 'Banish', onPick: () => move(iid, toOwner('banished')) });
      if (z !== 'hand') a.push({ label: 'To hand', onPick: () => move(iid, toOwner('hand')) });
      if (isExtraType(card) && z !== 'extra') a.push({ label: 'To Extra Deck', onPick: () => move(iid, toOwner('extra')) });
      if (!isExtraType(card) && z !== 'deck') {
        a.push({ label: 'To top of Deck', onPick: () => move(iid, toOwner('deck', 'top')) });
        a.push({ label: 'To bottom of Deck', onPick: () => move(iid, toOwner('deck', 'bottom')) });
      }
    }
    if (card.token) a.push({ label: 'Remove token', tone: 'danger', onPick: () => move(iid, toOwner('gy')) });
    if (visible && card.cardId !== null) a.push({ label: 'Read full card', onPick: () => (setSheet(null), setModal({ kind: 'read', iid })) });
    return { title, subtitle, card, visible, actions: a };
  };

  const deckActions = (): Action[] => {
    const top = me.deck[0];
    return [
      { label: 'Draw 1', tone: 'primary', onPick: () => (send({ type: 'DRAW', player: mySeat, n: 1 }), setSheet(null)) },
      { label: 'Shuffle', onPick: () => (send({ type: 'SHUFFLE', player: mySeat, seed: randomSeed() }), setSheet(null)) },
      { label: 'Look through Deck', onPick: () => (setSheet(null), setModal({ kind: 'browse', player: mySeat, zone: 'deck' })) },
      { label: 'Mill top card to Graveyard', disabled: !top, onPick: () => top && move(top.iid, { player: mySeat, zone: 'gy' }) },
      { label: 'Reveal top card', disabled: !top, onPick: () => top && (send({ type: 'REVEAL', player: mySeat, iid: top.iid }), setSheet(null)) },
    ];
  };

  const lpActions = (target: PlayerId): Action[] => {
    const lp = state.players[target].lp;
    const d = (delta: number): Action => ({ label: `${delta > 0 ? '+' : ''}${delta}`, tone: delta < 0 ? 'danger' : undefined, onPick: () => (send({ type: 'LP', player: mySeat, target, delta }), setSheet(null)) });
    return [
      d(-100), d(-200), d(-300), d(-400), d(-500), d(-600), d(-800), d(-1000), d(-1500), d(-2000), d(+500), d(+1000),
      { label: `Halve (${Math.ceil(lp / 2)})`, onPick: () => (send({ type: 'LP', player: mySeat, target, set: Math.ceil(lp / 2) }), setSheet(null)) },
      {
        label: 'Custom amount…',
        onPick: () => {
          const v = prompt('Change LP by (use minus for damage):', '-');
          const n = v === null ? NaN : parseInt(v, 10);
          if (!isNaN(n)) send({ type: 'LP', player: mySeat, target, delta: n });
          setSheet(null);
        },
      },
    ];
  };

  const menuActions = (): Action[] => [
    { label: 'Roll a die', onPick: () => (send({ type: 'DICE', player: mySeat, value: 1 + Math.floor(Math.random() * 6) }), setSheet(null)) },
    { label: 'Toss a coin', onPick: () => (send({ type: 'COIN', player: mySeat, heads: Math.random() < 0.5 }), setSheet(null)) },
    { label: 'Place a token', onPick: () => startTargeting({ iid: '', zone: 'm', faceDown: false, defense: false, token: true }) },
    { label: 'Undo my last action', disabled: myUndo === null, onPick: () => (myUndo !== null && send({ type: 'UNDO', player: mySeat, target: myUndo }), setSheet(null)) },
    { label: locked ? 'Unlock board' : 'Lock board (prevent accidental taps)', onPick: () => (setLocked(!locked), setSheet(null)) },
    ...(hotseat ? [{ label: `Switch to ${opp.name || 'other player'}'s view`, onPick: () => (onSwap(), setSheet(null)) }] : []),
    { label: 'Leave duel', tone: 'danger', onPick: onLeave },
  ];

  /** Battle calculator: what happens if `attacker` attacks `target` (or directly). */
  const battle = (attackerIid: string, targetIid: string | null) => {
    const a = findCard(state, attackerIid);
    if (!a) return null;
    const t = targetIid ? findCard(state, targetIid) : null;
    const atk = atkOf(a.card);
    const result = { destroyAttacker: false, destroyTarget: false, damageTo: null as PlayerId | null, damage: 0, flipTarget: false };
    let text: string;
    if (!t) {
      result.damageTo = other(mySeat);
      result.damage = atk;
      text = `Direct attack for ${atk} damage.`;
    } else if (t.card.defense) {
      const def = defOf(t.card);
      result.flipTarget = t.card.faceDown;
      if (atk > def) {
        result.destroyTarget = true;
        text = `ATK ${atk} beats DEF ${def}: "${t.card.name}" is destroyed, no damage.`;
      } else if (atk < def) {
        result.damageTo = mySeat;
        result.damage = def - atk;
        text = `ATK ${atk} is under DEF ${def}: you take ${def - atk} damage.`;
      } else text = `ATK ${atk} equals DEF ${def}: nothing is destroyed.`;
    } else {
      const tAtk = atkOf(t.card);
      if (atk > tAtk) {
        result.destroyTarget = true;
        result.damageTo = other(mySeat);
        result.damage = atk - tAtk;
        text = `ATK ${atk} vs ATK ${tAtk}: "${t.card.name}" is destroyed, ${opp.name} takes ${atk - tAtk}.`;
      } else if (atk < tAtk) {
        result.destroyAttacker = true;
        result.damageTo = mySeat;
        result.damage = tAtk - atk;
        text = `ATK ${atk} vs ATK ${tAtk}: "${a.card.name}" is destroyed, you take ${tAtk - atk}.`;
      } else {
        result.destroyAttacker = true;
        result.destroyTarget = true;
        text = `ATK ${atk} vs ATK ${tAtk}: both monsters are destroyed.`;
      }
    }
    return { a, t, atk, text, result };
  };

  const sheetContent = (() => {
    if (!sheet) return null;
    if (sheet.kind === 'card') {
      const c = cardActions(sheet.iid);
      if (!c) return null;
      const data = cardById(c.card.cardId);
      return (
        <Sheet title={c.title} subtitle={c.subtitle} actions={c.actions} onClose={() => setSheet(null)}>
          <div class="sheet-preview">
            <div class="card card-big">
              <CardFace card={c.card} hidden={!c.visible} />
            </div>
            {c.visible && data && (
              <div class="sheet-preview-text">
                <div class="read-meta">
                  {data.type}
                  {data.attribute ? ` · ${data.attribute}` : ''}
                  {data.level !== undefined ? ` · Lv ${data.level}` : ''}
                  {data.atk !== undefined ? ` · ${data.atk} / ${data.def ?? '-'}` : ''}
                </div>
                <p>{data.desc}</p>
              </div>
            )}
          </div>
        </Sheet>
      );
    }
    if (sheet.kind === 'pile') return <Sheet title="Your Deck" subtitle={`${me.deck.length} cards`} actions={deckActions()} onClose={() => setSheet(null)} />;
    if (sheet.kind === 'lp') return <Sheet title={`${state.players[sheet.player].name}: ${state.players[sheet.player].lp} LP`} subtitle="Tap an amount" actions={lpActions(sheet.player)} onClose={() => setSheet(null)} />;
    if (sheet.kind === 'battle') {
      const b = battle(sheet.attacker, sheet.target);
      if (!b) return null;
      const targets = opp.monsters.filter((m): m is CardInst => !!m);
      const actions: Action[] = [
        { label: 'Apply result', tone: 'primary', onPick: () => (send({ type: 'BATTLE', player: mySeat, attacker: sheet.attacker, target: sheet.target, result: b.result }), setSheet(null)) },
        { label: 'Just declare (handle it by hand)', onPick: () => (send({ type: 'BATTLE', player: mySeat, attacker: sheet.attacker, target: sheet.target }), setSheet(null)) },
      ];
      return (
        <Sheet title={`"${b.a.card.name}" attacks`} subtitle={b.text} actions={actions} onClose={() => setSheet(null)}>
          <div class="battle-pick">
            <button class={`chip ${sheet.target === null ? 'on' : ''}`} onClick={() => setSheet({ ...sheet, target: null })}>
              Direct attack
            </button>
            {targets.map((m) => (
              <button key={m.iid} class={`chip ${sheet.target === m.iid ? 'on' : ''}`} onClick={() => setSheet({ ...sheet, target: m.iid })}>
                {m.faceDown ? 'Face-down monster' : `${m.name} (${m.defense ? 'DEF ' + defOf(m) : 'ATK ' + atkOf(m)})`}
              </button>
            ))}
          </div>
          <p class="hint">The result uses printed ATK/DEF. If an effect changes the numbers, pick "Just declare" and adjust LP yourself.</p>
        </Sheet>
      );
    }
    return <Sheet title="Menu" actions={menuActions()} onClose={() => setSheet(null)} />;
  })();

  const modalContent = (() => {
    if (!modal) return null;
    if (modal.kind === 'log') {
      return (
        <Modal title="Duel log" onClose={() => setModal(null)}>
          <ol class="log">
            {state.log
              .slice()
              .reverse()
              .map((l, i) => (
                <li key={i} class={l.player === mySeat ? 'mine' : ''}>
                  {l.text}
                </li>
              ))}
          </ol>
        </Modal>
      );
    }
    if (modal.kind === 'read') {
      const f = findCard(state, modal.iid);
      const data = f ? cardById(f.card.cardId) : undefined;
      if (!f) return null;
      const img = cardImageUrl(f.card.cardId);
      return (
        <Modal title={f.card.name} onClose={() => setModal(null)}>
          <div class="read">
            {img && <img class="read-img" src={img} alt={f.card.name} />}
            <div class="read-text">
              {data && (
                <div class="read-meta">
                  {data.type}
                  {data.attribute ? ` · ${data.attribute}` : ''}
                  {data.race && data.type !== 'Skill Card' ? ` · ${data.race}` : ''}
                  {data.level !== undefined ? ` · Level ${data.level}` : ''}
                  {data.atk !== undefined ? ` · ATK ${data.atk} / DEF ${data.def ?? '-'}` : ''}
                  {data.character ? ` · ${data.character}` : ''}
                </div>
              )}
              <p>{data?.desc ?? 'Card text is not in the database yet.'}</p>
            </div>
          </div>
        </Modal>
      );
    }
    const p = state.players[modal.player];
    const list = p[modal.zone];
    const label = { deck: 'Deck', gy: 'Graveyard', banished: 'Banished', extra: 'Extra Deck' }[modal.zone];
    return (
      <Modal title={`${modal.player === mySeat ? 'Your' : `${opp.name}'s`} ${label} (${list.length})`} onClose={() => setModal(null)}>
        {modal.zone === 'deck' && <p class="hint">Top of the Deck first. Remember to shuffle after searching.</p>}
        <div class="browse-grid">
          {list.map((c) => (
            <CardView key={c.iid} card={{ ...c, faceDown: false }} canPeek size="list" onClick={() => setSheet({ kind: 'card', iid: c.iid })} />
          ))}
          {list.length === 0 && <p class="hint">Empty.</p>}
        </div>
      </Modal>
    );
  })();

  const turnMine = state.turnPlayer === mySeat;
  const dragCard = drag?.active ? findCard(state, drag.iid)?.card ?? null : null;

  const sideProps = { mySeat, state, targeting, drag, canSee, onSlotTap, onSingleTap, onPileTap, onCardPointerDown, statusDot: status };

  return (
    <div class={`board ${targeting ? 'targeting' : ''} ${drag?.active ? 'dragging-on' : ''}`}>
      <Side p={opp} pid={other(mySeat)} top {...sideProps} onLp={() => setSheet({ kind: 'lp', player: other(mySeat) })} />

      <div class="center-bar">
        <div class="phase-bar">
          {PHASES.map((ph: Phase) => (
            <button key={ph} class={`phase ${state.phase === ph ? 'on' : ''} ${turnMine ? 'mine' : 'theirs'}`} onClick={() => send({ type: 'PHASE', player: mySeat, phase: ph })}>
              {PHASE_LABEL[ph]}
            </button>
          ))}
        </div>
        <div class="center-tools">
          <div class="turn-tag">
            T{state.turn} · {turnMine ? 'Your turn' : `${opp.name}'s turn`}
          </div>
          <button class="tool-btn" onClick={() => send({ type: 'DRAW', player: mySeat, n: 1 })} disabled={me.deck.length === 0}>
            Draw
          </button>
          <button class="tool-btn" onClick={() => setModal({ kind: 'log' })}>
            Log
          </button>
          <button class={`tool-btn wait ${state.waitFlag === mySeat ? 'on' : ''}`} onClick={() => send(state.waitFlag === mySeat ? { type: 'WAIT_CLEAR', player: mySeat } : { type: 'WAIT', player: mySeat })}>
            {state.waitFlag === mySeat ? 'Waiting…' : 'WAIT'}
          </button>
          <button class="tool-btn end" onClick={() => send({ type: 'END_TURN', player: mySeat })}>
            End Turn
          </button>
          <button class="tool-btn" onClick={() => setSheet({ kind: 'menu' })}>
            ☰
          </button>
        </div>
      </div>

      <Side p={me} pid={mySeat} top={false} {...sideProps} onLp={() => setSheet({ kind: 'lp', player: mySeat })} />

      <div class="hand" data-drop={dropKey({ zone: 'hand', index: 0, player: mySeat })}>
        {me.hand.map((c) => (
          <CardView key={c.iid} card={c} canPeek size="hand" selected={targeting?.iid === c.iid} dragging={drag?.active && drag.iid === c.iid} onClick={() => tapCard(c.iid)} onPointerDown={onCardPointerDown(c.iid)} />
        ))}
        {me.hand.length === 0 && <div class="hint hand-empty">Your hand is empty</div>}
      </div>
      <div class="hand-hint">Drag a card onto a zone, or tap it for options</div>

      {dragCard && drag && (
        <div class="drag-ghost card card-hand" style={{ left: drag.x, top: drag.y }}>
          <CardFace card={dragCard} hidden={false} />
        </div>
      )}
      {targeting && (
        <div class="target-banner">
          {targeting.token ? 'Tap an empty Monster Zone for the token' : `Tap an empty ${targeting.zone === 'm' ? 'Monster' : 'Spell/Trap'} Zone`}
          <button class="chip" onClick={() => setTargeting(null)}>
            Cancel
          </button>
        </div>
      )}
      {state.waitFlag !== null && state.waitFlag !== mySeat && (
        <div class="wait-banner" onClick={() => send({ type: 'WAIT_CLEAR', player: mySeat })}>
          <b>WAIT!</b> {opp.name} wants to respond. Tap when ready.
        </div>
      )}
      {state.winner !== null && (
        <div class="winner-banner">
          {state.players[state.winner].name} wins the Duel!
          <button class="chip" onClick={() => send({ type: 'LP', player: mySeat, target: other(state.winner!), set: state.rules.startingLp })}>
            Keep playing
          </button>
        </div>
      )}
      {passScreen && hotseat && (
        <div class="pass-screen" onClick={() => setPassScreen(false)}>
          <div class="pass-title">Turn {state.turn}</div>
          <div class="pass-name">Pass the phone to {state.players[state.turnPlayer].name}</div>
          <div class="hint">Tap when ready</div>
        </div>
      )}
      {status !== 'connected' && session.adapter.kind !== 'local' && <div class={`conn-banner status-${status}`}>{detail}</div>}
      {toast && <div class="toast">{toast}</div>}
      {sheetContent}
      {modalContent}
    </div>
  );
}

function Pile({ label, count, onClick, dim, drop, hot }: { label: string; count: number; onClick: () => void; dim?: boolean; drop?: string; hot?: boolean }) {
  return (
    <button class={`pile ${count === 0 ? 'empty' : ''} ${dim ? 'dim' : ''} ${hot ? 'hot' : ''}`} onClick={onClick} data-drop={drop}>
      <span class="pile-count">{count}</span>
      <span class="pile-label">{label}</span>
    </button>
  );
}

interface SideProps {
  p: PlayerState;
  pid: PlayerId;
  top: boolean;
  mySeat: PlayerId;
  state: SessionView['state'];
  targeting: Targeting | null;
  drag: Drag | null;
  canSee: (c: CardInst, l: Loc) => boolean;
  onSlotTap: (player: PlayerId, zone: 'm' | 's', index: number, card: CardInst | null) => void;
  onSingleTap: (player: PlayerId, zone: 'field' | 'skill', card: CardInst | null) => void;
  onPileTap: (player: PlayerId, zone: 'deck' | 'gy' | 'banished' | 'extra' | 'hand') => void;
  onCardPointerDown: (iid: string) => (e: PointerEvent) => void;
  onLp: () => void;
  statusDot: string;
}

function Side({ p, pid, top, mySeat, state, targeting, drag, canSee, onSlotTap, onSingleTap, onPileTap, onCardPointerDown, onLp, statusDot }: SideProps) {
  const mine = pid === mySeat;
  const over = drag?.active ? drag.over : null;
  const slot = (zone: 'm' | 's', i: number) => {
    const card = zone === 'm' ? p.monsters[i] : p.spells[i];
    const key = dropKey({ zone, index: i, player: pid });
    const hot = (targeting && targeting.zone === zone && !card) || over === key;
    return (
      <div key={key} class={`zone ${zone === 'm' ? 'zone-m' : 'zone-s'} ${hot ? 'hot' : ''} ${!card ? 'empty' : ''}`} data-drop={key} onClick={() => onSlotTap(pid, zone, i, card)}>
        {card ? (
          <CardView card={card} canPeek={canSee(card, { player: pid, zone, index: i })} flash={state.lastSummon?.iid === card.iid && state.lastSummon.seq >= state.log.length - 3} dragging={drag?.active && drag.iid === card.iid} onPointerDown={onCardPointerDown(card.iid)} />
        ) : (
          <span class="zone-label">{zone === 'm' ? 'M' : 'S/T'}</span>
        )}
      </div>
    );
  };
  const single = (zone: 'field' | 'skill') => {
    const card = zone === 'field' ? p.field : p.skill;
    const key = dropKey({ zone, index: 0, player: pid });
    return (
      <div class={`zone zone-${zone} ${!card ? 'empty' : ''} ${over === key ? 'hot' : ''}`} data-drop={zone === 'field' ? key : undefined} onClick={() => onSingleTap(pid, zone, card)}>
        {card ? <CardView card={card} canPeek={canSee(card, { player: pid, zone })} onPointerDown={zone === 'field' ? onCardPointerDown(card.iid) : undefined} /> : <span class="zone-label">{zone === 'field' ? 'Field' : 'Skill'}</span>}
      </div>
    );
  };
  const pile = (zone: 'deck' | 'extra' | 'gy', label: string, count: number) => {
    const key = dropKey({ zone, index: 0, player: pid });
    return <Pile label={label} count={count} onClick={() => onPileTap(pid, zone)} dim={!mine} drop={mine ? key : undefined} hot={over === key} />;
  };
  const monsters = [0, 1, 2].map((i) => slot('m', i));
  const spells = [0, 1, 2].map((i) => slot('s', i));
  const rowFar = (
    <div class="zone-row">
      {top ? pile('deck', 'Deck', p.deck.length) : pile('extra', 'Extra', p.extra.length)}
      {spells}
      {top ? pile('extra', 'Extra', p.extra.length) : pile('deck', 'Deck', p.deck.length)}
    </div>
  );
  const rowNear = (
    <div class="zone-row">
      {top ? pile('gy', 'GY', p.gy.length) : single('field')}
      {monsters}
      {top ? single('field') : pile('gy', 'GY', p.gy.length)}
    </div>
  );
  const playerKey = dropKey({ zone: 'player', index: 0, player: pid });
  const banishKey = dropKey({ zone: 'banished', index: 0, player: pid });
  const bar = (
    <div class={`side-bar ${mine ? 'mine' : 'theirs'} ${state.turnPlayer === pid ? 'active' : ''} ${over === playerKey ? 'hot' : ''}`} data-drop={mine ? undefined : playerKey}>
      <div class="side-name">
        {!mine && <span class={`dot dot-${statusDot}`} />}
        {p.name || `Player ${pid + 1}`}
      </div>
      <button class="lp" onClick={onLp}>
        {p.lp} <small>LP</small>
      </button>
      <div class="side-chips">
        {!mine && <span class="chip static">Hand {p.hand.length}</span>}
        <button class={`chip ${over === banishKey ? 'on' : ''}`} data-drop={mine ? banishKey : undefined} onClick={() => onPileTap(pid, 'banished')}>
          Banished {p.banished.length}
        </button>
        {single('skill')}
      </div>
    </div>
  );
  return top ? (
    <div class="side side-top">
      {bar}
      {rowFar}
      {rowNear}
    </div>
  ) : (
    <div class="side side-bottom">
      {rowNear}
      {rowFar}
      {bar}
    </div>
  );
}
