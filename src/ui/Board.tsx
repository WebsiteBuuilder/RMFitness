import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Session, SessionView } from '../game/session';
import type { CardInst, Loc, Phase, PlayerId, PlayerState, ZoneName } from '../game/types';
import { PHASES, PHASE_LABEL } from '../game/types';
import { findCard, lastUndoable, zoneLabel } from '../game/reducer';
import { randomSeed } from '../game/rng';
import { cardById, cardImageUrl } from '../data/cards';
import { CardView } from './CardView';
import { Action, Modal, Sheet } from './Sheet';
import { playAlert, playHit, playSummon, unlockAudio } from './sound';

type SheetState =
  | { kind: 'card'; iid: string }
  | { kind: 'pile'; player: PlayerId; zone: 'deck' }
  | { kind: 'lp'; player: PlayerId }
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
  /** token placement instead of a move */
  token?: boolean;
}

function other(p: PlayerId): PlayerId {
  return p === 0 ? 1 : 0;
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
  const seenSummon = useRef<number>(-1);
  const seenLp = useRef<[number, number] | null>(null);
  const seenWait = useRef<PlayerId | null>(null);

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

  // Summon flash and sound, LP hit sound, Wait alert.
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
  }, [state, mySeat]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const myUndo = useMemo(() => lastUndoable(events, mySeat), [events, mySeat]);

  const canSee = (card: CardInst, loc: Loc) => {
    if (!card.faceDown) return true;
    if (hotseat) return loc.player === mySeat;
    return loc.player === mySeat;
  };

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

  const onSlotTap = (player: PlayerId, zone: 'm' | 's', index: number, card: CardInst | null) => {
    if (locked && !targeting) {
      setToast('Board is locked');
      return;
    }
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
    if (card) setSheet({ kind: 'card', iid: card.iid });
  };

  const onSingleTap = (player: PlayerId, zone: 'field' | 'skill', card: CardInst | null) => {
    if (targeting) {
      setToast('Pick a zone on the field');
      return;
    }
    if (locked) {
      setToast('Board is locked');
      return;
    }
    if (card) setSheet({ kind: 'card', iid: card.iid });
    else if (zone === 'field') setToast(`${player === mySeat ? 'Your' : "Opponent's"} Field Zone is empty`);
  };

  const onPileTap = (player: PlayerId, zone: 'deck' | 'gy' | 'banished' | 'extra' | 'hand') => {
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

  const cardActions = (iid: string): { title: string; subtitle: string; actions: Action[] } | null => {
    const f = findCard(state, iid);
    if (!f) return null;
    const { card, loc } = f;
    const visible = canSee(card, loc);
    const title = visible ? card.name : 'Face-down card';
    const subtitle = `${loc.player === mySeat ? 'Your' : `${opp.name}'s`} ${zoneLabel(loc)}`;
    const a: Action[] = [];
    const toOwner = (zone: ZoneName, place?: 'top' | 'bottom'): Loc => ({ player: card.owner, zone, place });
    const z = loc.zone;
    const isMonsterCard = () => {
      const d = cardById(card.cardId);
      return d ? /Monster/i.test(d.type) : true;
    };
    const isField = () => /Field/i.test(cardById(card.cardId)?.race ?? '') && /Spell/i.test(cardById(card.cardId)?.type ?? '');

    if (z === 'hand' || z === 'gy' || z === 'banished' || z === 'extra' || z === 'deck') {
      if (isMonsterCard() && !card.token) {
        a.push({ label: 'Summon (Attack)', tone: 'primary', onPick: () => startTargeting({ iid, zone: 'm', faceDown: false, defense: false }) });
        a.push({ label: 'Set (face-down Defense)', onPick: () => startTargeting({ iid, zone: 'm', faceDown: true, defense: true }) });
        a.push({ label: 'Special Summon (Defense)', onPick: () => startTargeting({ iid, zone: 'm', faceDown: false, defense: true }) });
      } else if (!card.token) {
        if (isField()) a.push({ label: 'Activate in Field Zone', tone: 'primary', onPick: () => move(iid, toOwner('field'), false) });
        a.push({ label: 'Activate (face-up)', tone: isField() ? undefined : 'primary', onPick: () => startTargeting({ iid, zone: 's', faceDown: false, defense: false }) });
        a.push({ label: 'Set (face-down)', onPick: () => startTargeting({ iid, zone: 's', faceDown: true, defense: false }) });
      }
      if (z === 'hand') a.push({ label: 'Reveal to opponent', onPick: () => (send({ type: 'REVEAL', player: mySeat, iid }), setSheet(null)) });
    }
    if (z === 'm') {
      a.push({ label: card.defense ? 'Change to Attack Position' : 'Change to Defense Position', tone: 'primary', onPick: () => (send({ type: 'POSITION', player: mySeat, iid }), setSheet(null)) });
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
      const extraType = /Fusion|Synchro|XYZ|Xyz|Link/i.test(cardById(card.cardId)?.type ?? '');
      if (extraType && z !== 'extra') a.push({ label: 'To Extra Deck', onPick: () => move(iid, toOwner('extra')) });
      if (!extraType && z !== 'deck') {
        a.push({ label: 'To top of Deck', onPick: () => move(iid, toOwner('deck', 'top')) });
        a.push({ label: 'To bottom of Deck', onPick: () => move(iid, toOwner('deck', 'bottom')) });
      }
    }
    if (card.token) a.push({ label: 'Remove token', tone: 'danger', onPick: () => move(iid, toOwner('gy')) });
    if (visible && card.cardId !== null) a.push({ label: 'Read card', onPick: () => (setSheet(null), setModal({ kind: 'read', iid })) });
    return { title, subtitle, actions: a };
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

  const sheetContent = (() => {
    if (!sheet) return null;
    if (sheet.kind === 'card') {
      const c = cardActions(sheet.iid);
      if (!c) return null;
      return <Sheet title={c.title} subtitle={c.subtitle} actions={c.actions} onClose={() => setSheet(null)} />;
    }
    if (sheet.kind === 'pile') return <Sheet title="Your Deck" subtitle={`${me.deck.length} cards`} actions={deckActions()} onClose={() => setSheet(null)} />;
    if (sheet.kind === 'lp') return <Sheet title={`${state.players[sheet.player].name}: ${state.players[sheet.player].lp} LP`} subtitle="Tap an amount" actions={lpActions(sheet.player)} onClose={() => setSheet(null)} />;
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

  return (
    <div class={`board ${targeting ? 'targeting' : ''}`}>
      <Side p={opp} pid={other(mySeat)} top mySeat={mySeat} state={state} targeting={targeting} canSee={canSee} onSlotTap={onSlotTap} onSingleTap={onSingleTap} onPileTap={onPileTap} onLp={() => setSheet({ kind: 'lp', player: other(mySeat) })} statusDot={status} />

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
            Turn {state.turn} · {turnMine ? 'Your turn' : `${opp.name}'s turn`}
          </div>
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

      <Side p={me} pid={mySeat} top={false} mySeat={mySeat} state={state} targeting={targeting} canSee={canSee} onSlotTap={onSlotTap} onSingleTap={onSingleTap} onPileTap={onPileTap} onLp={() => setSheet({ kind: 'lp', player: mySeat })} statusDot={status} />

      <div class="hand">
        {me.hand.map((c) => (
          <CardView key={c.iid} card={c} canPeek size="hand" selected={targeting?.iid === c.iid} onClick={() => (locked ? setToast('Board is locked') : setSheet({ kind: 'card', iid: c.iid }))} />
        ))}
        {me.hand.length === 0 && <div class="hint hand-empty">Your hand is empty</div>}
      </div>

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
      {status !== 'connected' && session.adapter.kind !== 'local' && <div class={`conn-banner status-${status}`}>{detail}</div>}
      {toast && <div class="toast">{toast}</div>}
      {sheetContent}
      {modalContent}
    </div>
  );
}

function Pile({ label, count, onClick, dim }: { label: string; count: number; onClick: () => void; dim?: boolean }) {
  return (
    <button class={`pile ${count === 0 ? 'empty' : ''} ${dim ? 'dim' : ''}`} onClick={onClick}>
      <span class="pile-count">{count}</span>
      <span class="pile-label">{label}</span>
    </button>
  );
}

function Side({ p, pid, top, mySeat, state, targeting, canSee, onSlotTap, onSingleTap, onPileTap, onLp, statusDot }: { p: PlayerState; pid: PlayerId; top: boolean; mySeat: PlayerId; state: SessionView['state']; targeting: Targeting | null; canSee: (c: CardInst, l: Loc) => boolean; onSlotTap: (player: PlayerId, zone: 'm' | 's', index: number, card: CardInst | null) => void; onSingleTap: (player: PlayerId, zone: 'field' | 'skill', card: CardInst | null) => void; onPileTap: (player: PlayerId, zone: 'deck' | 'gy' | 'banished' | 'extra' | 'hand') => void; onLp: () => void; statusDot: string }) {
  const mine = pid === mySeat;
  const slot = (zone: 'm' | 's', i: number) => {
    const card = zone === 'm' ? p.monsters[i] : p.spells[i];
    const hot = targeting && targeting.zone === zone && !card;
    return (
      <div key={`${zone}${i}`} class={`zone ${zone === 'm' ? 'zone-m' : 'zone-s'} ${hot ? 'hot' : ''} ${!card ? 'empty' : ''}`} onClick={() => onSlotTap(pid, zone, i, card)}>
        {card ? <CardView card={card} canPeek={canSee(card, { player: pid, zone, index: i })} flash={state.lastSummon?.iid === card.iid && state.lastSummon.seq >= state.log.length - 3} /> : <span class="zone-label">{zone === 'm' ? 'M' : 'S/T'}</span>}
      </div>
    );
  };
  const single = (zone: 'field' | 'skill') => {
    const card = zone === 'field' ? p.field : p.skill;
    return (
      <div class={`zone zone-${zone} ${!card ? 'empty' : ''}`} onClick={() => onSingleTap(pid, zone, card)}>
        {card ? <CardView card={card} canPeek={canSee(card, { player: pid, zone })} /> : <span class="zone-label">{zone === 'field' ? 'Field' : 'Skill'}</span>}
      </div>
    );
  };
  const monsters = [0, 1, 2].map((i) => slot('m', i));
  const spells = [0, 1, 2].map((i) => slot('s', i));
  const rowFar = (
    <div class="zone-row">
      {top ? <Pile label="Deck" count={p.deck.length} onClick={() => onPileTap(pid, 'deck')} dim /> : <Pile label="Extra" count={p.extra.length} onClick={() => onPileTap(pid, 'extra')} />}
      {spells}
      {top ? <Pile label="Extra" count={p.extra.length} onClick={() => onPileTap(pid, 'extra')} dim /> : <Pile label="Deck" count={p.deck.length} onClick={() => onPileTap(pid, 'deck')} />}
    </div>
  );
  const rowNear = (
    <div class="zone-row">
      {top ? <Pile label="GY" count={p.gy.length} onClick={() => onPileTap(pid, 'gy')} /> : single('field')}
      {monsters}
      {top ? single('field') : <Pile label="GY" count={p.gy.length} onClick={() => onPileTap(pid, 'gy')} />}
    </div>
  );
  const bar = (
    <div class={`side-bar ${mine ? 'mine' : 'theirs'} ${state.turnPlayer === pid ? 'active' : ''}`}>
      <div class="side-name">
        {!mine && <span class={`dot dot-${statusDot}`} />}
        {p.name || `Player ${pid + 1}`}
      </div>
      <button class="lp" onClick={onLp}>
        {p.lp} <small>LP</small>
      </button>
      <div class="side-chips">
        {!mine && <span class="chip static">Hand {p.hand.length}</span>}
        <button class="chip" onClick={() => onPileTap(pid, 'banished')}>
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
