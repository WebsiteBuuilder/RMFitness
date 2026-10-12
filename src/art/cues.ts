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
  /** screen rectangle of the card on the board, when it is there */
  rect: Rect | null;
  def: boolean;
}

export type Cue =
  | { kind: 'summon'; card: CardRef; special: boolean }
  | { kind: 'set'; card: CardRef; monster: boolean }
  | { kind: 'flip'; card: CardRef }
  | { kind: 'activate'; card: CardRef; what: 'spell' | 'trap' | 'monster' }
  | { kind: 'skill'; player: Pid; name: string }
  | { kind: 'attack'; attacker: CardRef; target: CardRef | null; defender: Pid }
  | { kind: 'hit'; attacker: CardRef | null; target: CardRef | null; defender: Pid }
  | { kind: 'damage'; player: Pid; amount: number }
  | { kind: 'destroy'; card: CardRef }
  | { kind: 'win'; winner: Pid | 'draw'; shadow: ShadowResult | null };

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
  const faceUp = f.field ? f.field.faceUp : true;
  const known = faceUp || f.controller === viewer;
  return { uid, name: known ? f.card.name : '', faceUp, controller: f.controller, rect: rectOf(uid, host) ?? old?.rect ?? null, def: f.field?.pos === 'def' };
}

/** Remembers every monster on the field and where it is drawn. */
export function memoField(state: DuelState, viewer: Pid, host: HTMLElement | null): FieldMemo {
  const m: FieldMemo = new Map();
  for (const p of [0, 1] as Pid[])
    for (const c of state.players[p].mz) {
      if (!c) continue;
      m.set(c.uid, { uid: c.uid, name: c.faceUp || p === viewer ? c.name : '', faceUp: c.faceUp, controller: p, rect: rectOf(c.uid, host), def: c.pos === 'def' });
    }
  return m;
}

/** Turns new engine events into cues. `memo` is the field before these events. */
export interface CueTrack {
  /** the attack being animated (its hit can arrive in a later batch, after responses) */
  battle: { attacker: number; target: number | null } | null;
}

export function toCues(events: EngineEvent[], state: DuelState, viewer: Pid, host: HTMLElement | null, memo: FieldMemo, track: CueTrack = { battle: null }): Cue[] {
  const out: Cue[] = [];
  for (const ev of events) {
    const r = (uid: number | undefined | null) => (uid === undefined || uid === null ? null : ref(state, uid, viewer, host, memo));
    switch (ev.kind) {
      case 'summon': {
        const c = r(ev.uid);
        if (!c) break;
        if (!c.faceUp && c.controller !== viewer) out.push({ kind: 'set', card: c, monster: true });
        else out.push({ kind: 'summon', card: c, special: false });
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
        out.push({ kind: 'activate', card: { ...c, name, faceUp: true }, what: k });
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
      case 'to-gy': {
        // Only monsters leaving the field get a destruction; discards and used spells are quiet.
        const was = memo.get(ev.uid ?? -1);
        if (was) {
          const name = locate(state, was.uid)?.card.name ?? was.name;
          out.push({ kind: 'destroy', card: { ...was, name, faceUp: true } });
        }
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
      return 3;
    default:
      return 1;
  }
}

// ---------- busy flag: the computer waits for cinematics to finish ----------
let busy = false;
const idleWaiters = new Set<() => void>();
export function setArtBusy(b: boolean) {
  busy = b;
  if (!b) for (const f of [...idleWaiters]) (idleWaiters.delete(f), f());
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
