// Engine events → cues: everything a cinematic needs, resolved at the moment the
// event reaches the screen (card names, face-up or not, where the card sits on
// the board). The renderer never reads the duel state itself.
import { card } from '../eds/db';
import type { Card, DuelState, EngineEvent, FieldCard, Pid } from '../eds/types';
import { shadowRealmOf, type ShadowResult } from './shadow';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CardRef {
  uid: number;
  /** '' when the viewer may not know the card (face-down and not theirs) */
  name: string;
  faceUp: boolean;
  controller: Pid;
  /** whose card it is (its finish, Speed Duel card leveling, is the owner's) */
  owner?: Pid;
  /** screen rectangle of the card on the board, when it is there */
  rect: Rect | null;
  def: boolean;
  /** (activate's field list) destroyed by the effect in the same update */
  dies?: boolean;
}

export type Cue =
  /** how: the summon method when known (Fusion, Ritual, Xyz, Synchro, Link, Tribute...) */
  | { kind: 'summon'; card: CardRef; special: boolean; how?: SummonHow }
  /** a card leaves the field (or the GY) without being destroyed: banished, bounced, shuffled away */
  | { kind: 'leave'; card: CardRef; to: 'hand' | 'deck' | 'banish' | 'extra' }
  /** Life Points gained from an effect */
  | { kind: 'heal'; player: Pid; amount: number }
  /** cards drawn by an effect (not the normal draw) */
  | { kind: 'draw'; player: Pid; count: number }
  | { kind: 'set'; card: CardRef; monster: boolean }
  | { kind: 'flip'; card: CardRef }
  | { kind: 'activate'; card: CardRef; what: 'spell' | 'trap' | 'monster'; targets?: Target[]; field?: CardRef[] }
  /** a chain link's target, picked after its activation already played (a human choosing) */
  | { kind: 'target'; card: CardRef; targets: Target[] }
  | { kind: 'skill'; player: Pid; name: string }
  | { kind: 'attack'; attacker: CardRef; target: CardRef | null; defender: Pid }
  | { kind: 'hit'; attacker: CardRef | null; target: CardRef | null; defender: Pid; dmg?: { player: Pid; amount: number } }
  | { kind: 'damage'; player: Pid; amount: number }
  | { kind: 'destroy'; card: CardRef }
  | { kind: 'win'; winner: Pid | 'draw'; shadow: ShadowResult | null };

/** What an effect targets, and whether it is destroyed in the same update. */
export interface Target {
  card: CardRef;
  destroyed: boolean;
}

/** Field monsters as they were last seen on screen (a destroyed card's last place). */
export type FieldMemo = Map<number, CardRef>;

const zoneEl = (uid: number) => document.querySelector(`[data-uid="${uid}"]`) as HTMLElement | null;

export function rectOf(uid: number, host: HTMLElement | null): Rect | null {
  if (!host) return null;
  const el = zoneEl(uid);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  if (r.width === 0) return null;
  return { x: r.left - h.left + r.width / 2, y: r.top - h.top + r.height / 2, w: r.width, h: r.height };
}

function locate(state: DuelState, uid: number): { card: Card; controller: Pid; field: FieldCard | null } | null {
  for (const p of [0, 1] as Pid[]) {
    const ps = state.players[p];
    for (const c of [...ps.mz, ...ps.sz, ps.field]) if (c && c.uid === uid) return { card: c, controller: p, field: c };
    for (const list of [ps.hand, ps.gy, ps.removed, ps.deck, ps.fusion]) {
      const c = list.find((x) => x.uid === uid);
      if (c) return { card: c, controller: p, field: null };
    }
  }
  return null;
}

function ref(state: DuelState, uid: number, viewer: Pid, host: HTMLElement | null, memo: FieldMemo): CardRef | null {
  const f = locate(state, uid);
  const old = memo.get(uid);
  if (!f) return old ?? null;
  // A monster that has already left the field (destroyed in this batch) is shown as it
  // last stood there: a face-down defender stays face-down until its flip is shown.
  if (!f.field && old) return live({ ...old, rect: rectOf(uid, host) ?? old.rect }, host);
  const faceUp = f.field ? f.field.faceUp : true;
  const known = faceUp || f.controller === viewer;
  return live({ uid, name: known ? f.card.name : '', faceUp, controller: f.controller, owner: f.card.owner, rect: rectOf(uid, host) ?? old?.rect ?? null, def: f.field?.pos === 'def' }, host);
}

/**
 * Makes `rect` follow the card on screen: the board can show the card's old
 * place (its hand, say) when the cue is made and its new zone a moment later,
 * once the cinematic lands and the board catches up.
 */
function live(c: CardRef, host: HTMLElement | null): CardRef {
  let last = c.rect;
  return Object.defineProperty(c, 'rect', {
    enumerable: true,
    configurable: true,
    get: () => (last = rectOf(c.uid, host ?? (typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.art-stage'))) ?? last),
  });
}

/** Cards that leave the field after event `i`, before the next activation (what that effect destroyed). */
function gone(events: EngineEvent[], i: number): Set<number> {
  const s = new Set<number>();
  for (let j = i + 1; j < events.length; j++) {
    const e = events[j];
    if (e.kind === 'activate') break;
    if (e.kind === 'to-gy' && e.uid !== undefined) s.add(e.uid);
  }
  return s;
}

/** A battle's damage plays with the blow that dealt it (one moment, not two). */
export function coalesce(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (c.kind === 'damage' && prev?.kind === 'hit' && !prev.dmg) out[out.length - 1] = { ...prev, dmg: { player: c.player, amount: c.amount } };
    else out.push(c);
  }
  return out;
}

/** Remembers every monster on the field and where it is drawn. */
export function memoField(state: DuelState, viewer: Pid, host: HTMLElement | null, prev?: FieldMemo): FieldMemo {
  const m: FieldMemo = new Map();
  for (const p of [0, 1] as Pid[])
    for (const c of state.players[p].mz) {
      if (!c) continue;
      m.set(c.uid, { uid: c.uid, name: c.faceUp || p === viewer ? c.name : '', faceUp: c.faceUp, controller: p, owner: c.owner, rect: rectOf(c.uid, host) ?? prev?.get(c.uid)?.rect ?? null, def: c.pos === 'def' });
    }
  return m;
}

export type SummonHow = 'normal' | 'tribute' | 'special' | 'fusion' | 'ritual' | 'xyz' | 'synchro' | 'link';
const HOWS = new Set<SummonHow>(['normal', 'tribute', 'special', 'fusion', 'ritual', 'xyz', 'synchro', 'link']);

/** The engine's `to` on a card that moves (to-hand / to-gy events) → the leave cue's destination. */
const LEAVE_TO: Record<string, 'hand' | 'deck' | 'banish' | 'extra'> = { hand: 'hand', deck: 'deck', banish: 'banish', extra: 'extra' };

/**
 * Which moves get a leave cue: anything leaving the field, the GY or the banishment, a card added
 * from the Deck to the hand (a search is shown to both players), and cards banished from the
 * hand or Deck (face-up). A card shuffled from the hand into the Deck stays quiet (nothing is revealed).
 */
function shownLeave(zone: string | undefined, to: 'hand' | 'deck' | 'banish' | 'extra'): boolean {
  switch (zone) {
    case 'mz':
    case 'sz':
    case 'field':
    case 'gy':
    case 'removed':
      return true;
    case 'deck':
      return to === 'hand' || to === 'banish';
    case 'hand':
      return to === 'banish';
    default:
      return false;
  }
}

/** Turns new engine events into cues. `memo` is the field before these events. */
export interface CueTrack {
  /** the attack being animated (its hit can arrive in a later batch, after responses) */
  battle: { attacker: number; target: number | null } | null;
}

export function toCues(events: EngineEvent[], state: DuelState, viewer: Pid, host: HTMLElement | null, memo: FieldMemo, track: CueTrack = { battle: null }): Cue[] {
  const out: Cue[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const r = (uid: number | undefined | null) => (uid === undefined || uid === null ? null : ref(state, uid, viewer, host, memo));
    switch (ev.kind) {
      case 'summon': {
        const c = r(ev.uid);
        if (!c) break;
        const how = HOWS.has(ev.how as SummonHow) ? (ev.how as SummonHow) : undefined;
        if (!c.faceUp && c.controller !== viewer) out.push({ kind: 'set', card: c, monster: true });
        else out.push(how ? { kind: 'summon', card: c, special: how !== 'normal' && how !== 'tribute', how } : { kind: 'summon', card: c, special: false });
        break;
      }
      case 'set': {
        const c = r(ev.uid);
        if (c) out.push({ kind: 'set', card: { ...c, name: c.controller === viewer ? c.name : '' }, monster: card(c.name)?.kind === 'monster' || memo.has(c.uid) || !!state.players[c.controller].mz.find((m) => m?.uid === c.uid) });
        break;
      }
      case 'flip': {
        const c = r(ev.uid);
        if (c) out.push({ kind: 'flip', card: { ...c, name: locate(state, c.uid)?.card.name ?? c.name } });
        break;
      }
      // 'effect': a triggered or continuous effect at work (the engine's lazy announcement, see Engine.trig)
      case 'effect':
      case 'activate': {
        if (ev.uid === undefined) {
          const p = ev.player ?? 0;
          const skill = state.players[p].skill;
          if (skill) out.push({ kind: 'skill', player: p, name: skill });
          break;
        }
        const c = r(ev.uid);
        if (!c) break;
        const name = locate(state, c.uid)?.card.name ?? c.name;
        const k = card(name)?.kind ?? 'spell';
        // the face-up monsters on the field as they stood before this update (board-wide effects strike them)
        const doomed = gone(events, i);
        const field: CardRef[] = [...memo.values()].filter((m) => m.faceUp && m.name).map((m) => ({ ...m, rect: rectOf(m.uid, host) ?? m.rect, dies: doomed.has(m.uid) }));
        out.push({ kind: 'activate', card: { ...c, name, faceUp: true }, what: k, field });
        break;
      }
      case 'target': {
        const t = r(ev.target);
        if (!t) break;
        const tg: Target = { card: t, destroyed: gone(events, i).has(t.uid) };
        const prev = [...out].reverse().find((x) => x.kind === 'activate' && x.card.uid === ev.uid);
        if (prev && prev.kind === 'activate') (prev.targets ??= []).push(tg);
        else {
          const c = r(ev.uid);
          if (c) out.push({ kind: 'target', card: { ...c, name: locate(state, c.uid)?.card.name ?? c.name, faceUp: true }, targets: [tg] });
        }
        break;
      }
      case 'attack': {
        const a = r(ev.uid);
        if (!a) break;
        track.battle = { attacker: a.uid, target: ev.target ?? null };
        out.push({ kind: 'attack', attacker: a, target: r(ev.target), defender: a.controller === 0 ? 1 : 0 });
        break;
      }
      case 'hit': {
        // Direct attacks name the attacker; battles name the monster attacked.
        const b = track.battle;
        const direct = b ? b.target === null : false;
        const a = b ? r(b.attacker) : null;
        const t = direct ? null : r(ev.uid);
        out.push({ kind: 'hit', attacker: a, target: t, defender: (ev.player ?? 1) as Pid });
        break;
      }
      case 'damage':
        if ((ev.amount ?? 0) > 0) out.push({ kind: 'damage', player: (ev.player ?? 0) as Pid, amount: ev.amount ?? 0 });
        break;
      case 'to-hand':
      case 'to-gy': {
        const to = LEAVE_TO[ev.to ?? ''];
        if (to || ev.kind === 'to-hand') {
          // A card moved without being destroyed: banished, bounced, searched, shuffled away.
          if (!to || !shownLeave(ev.zone, to)) break;
          const c = r(ev.uid);
          if (!c) break;
          const name = ev.down && c.controller !== viewer ? '' : locate(state, c.uid)?.card.name ?? c.name;
          out.push({ kind: 'leave', card: { ...c, name, faceUp: !!name }, to });
          break;
        }
        // Only monsters leaving the field get a destruction; discards and used spells are quiet.
        const was = memo.get(ev.uid ?? -1);
        if (was) {
          const name = locate(state, was.uid)?.card.name ?? was.name;
          out.push({ kind: 'destroy', card: { ...was, name, faceUp: true } });
        }
        break;
      }
      case 'heal':
        if ((ev.amount ?? 0) > 0) out.push({ kind: 'heal', player: (ev.player ?? 0) as Pid, amount: ev.amount ?? 0 });
        break;
      case 'draw': {
        // Only draws by an effect: the Draw Phase draw is the board's own animation.
        if (!ev.effect) break;
        const p = (ev.player ?? 0) as Pid;
        const prev = out[out.length - 1];
        if (prev?.kind === 'draw' && prev.player === p) prev.count++;
        else out.push({ kind: 'draw', player: p, count: 1 });
        break;
      }
      case 'win':
        out.push({ kind: 'win', winner: state.winner ?? 'draw', shadow: shadowRealmOf(state) });
        break;
    }
  }
  return out;
}

/** How grand a cue is, for trimming a long backlog (reconnects, fast computer turns). */
export function weight(c: Cue): number {
  switch (c.kind) {
    case 'win':
      return 9;
    case 'summon':
    case 'attack':
    case 'hit':
    case 'destroy':
      return 5;
    case 'damage':
    case 'flip':
    case 'skill':
      return 4;
    case 'activate':
    case 'target':
    case 'leave':
      return 3;
    case 'heal':
    case 'draw':
      return 2;
    default:
      return 1;
  }
}

// ---------- busy flag: the computer waits for cinematics to finish ----------
// `busy`: the computer must wait (a chain is queued or playing). `focus`: the
// monsters (uids) a cinematic has on stage right now; the field figures of those
// step aside while the rest keep standing. Listeners hear every change.
let busy = false;
const focus = new Set<number>();
const idleWaiters = new Set<() => void>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const f of [...listeners]) f();
};
export function setArtBusy(b: boolean) {
  const changed = b !== busy;
  busy = b;
  if (!b) for (const f of [...idleWaiters]) (idleWaiters.delete(f), f());
  if (changed) notify();
}
export function artBusy() {
  return busy;
}
/** Runs `f` once no cinematic is playing; returns a cancel function. */
export function whenArtIdle(f: () => void): () => void {
  if (!busy) {
    f();
    return () => {};
  }
  idleWaiters.add(f);
  return () => idleWaiters.delete(f);
}
/** Calls `f` whenever the busy flag or the focus changes; returns an unsubscribe function. */
export function onArtChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
/** The monsters a cinematic is about (their field figures step aside for it). */
export function focusArt(uids: Iterable<number>) {
  let changed = false;
  for (const u of uids) if (!focus.has(u)) (focus.add(u), (changed = true));
  if (changed) notify();
}
/** The stage is empty again: every field figure stands. */
export function clearArtFocus() {
  if (!focus.size) return;
  focus.clear();
  notify();
}
export function artFocus(): ReadonlySet<number> {
  return focus;
}
/** The monsters a cue puts on stage. */
export function cueUids(c: Cue): number[] {
  switch (c.kind) {
    case 'summon':
    case 'set':
    case 'flip':
    case 'activate':
    case 'destroy':
    case 'leave':
      return [c.card.uid];
    case 'attack':
      return c.target ? [c.attacker.uid, c.target.uid] : [c.attacker.uid];
    case 'hit':
      return [c.attacker?.uid, c.target?.uid].filter((u): u is number => u !== undefined);
    default:
      return [];
  }
}

/** A banner shown twice at once (the same title within 100 ms) is shown once: call per banner, false = drop it. */
export function bannerOnce(): (title: string) => boolean {
  let last = '';
  let at = -1e9;
  return (title) => {
    const now = performance.now();
    if (title === last && now - at < 100) return false;
    last = title;
    at = now;
    return true;
  };
}
