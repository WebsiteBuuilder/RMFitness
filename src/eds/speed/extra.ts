// Speed Duel: Xyz, Synchro and Link Summons from the Extra Deck. The materials come
// from the monster's own text ("2 Level 4 WATER monsters", "1 Tuner + 1+ non-Tuner
// monsters", "2+ Reptile monsters"); a card script can replace the procedure with
// its own `extraProc` (alternative summons, odd materials).
import type { Engine } from '../engine';
import type { EffectDef } from '../effects';
import type { Card, FieldCard, Pid } from '../types';
import { attrOf, levelOf, raceOf } from './helpers';

type Kind = 'Xyz' | 'Synchro' | 'Link';
export interface ExtraReq {
  kind: Kind;
  /** Xyz: the Level every material needs; Synchro: the total Level */
  level: number;
  /** Xyz/Link materials, or Synchro non-Tuners */
  min: number;
  max: number;
  qual: string;
  /** Synchro: how many Tuners, and what they must be */
  tuners: number;
  tunerQual: string;
}

const ATTRS = ['DARK', 'LIGHT', 'WATER', 'FIRE', 'EARTH', 'WIND', 'DIVINE'];
const CACHE = new Map<string, ExtraReq | null>();

const count = (n: string, plus: string | undefined) => {
  const k = Number(n);
  return { min: k, max: plus ? Math.max(k, 5) : k };
};

/** Reads the material line of an Xyz/Synchro/Link Monster. */
export function extraReq(e: Engine, name: string): ExtraReq | null {
  if (CACHE.has(name)) return CACHE.get(name)!;
  const info = e.info(name);
  const kind = (['Xyz', 'Synchro', 'Link'] as Kind[]).find((k) => k === info.sub);
  const line = info.desc.split('\n')[0].trim();
  let req: ExtraReq | null = null;
  if (kind === 'Xyz') {
    const m = line.match(/^(\d+)(\+| or more)? Level (\d+) (.*)$/);
    if (m) req = { kind, level: Number(m[3]), ...count(m[1], m[2]), qual: m[4], tuners: 0, tunerQual: '' };
  } else if (kind === 'Synchro') {
    const [left, right] = line.split(' + ');
    const t = left?.match(/^(\d+) (.*)$/);
    const n = right?.match(/^(\d+)(\+| or more)? (.*)$/);
    if (t && right) {
      const tunerQual = t[2].replace(/\bTuners?\b/, '').trim();
      if (n) req = { kind, level: info.level ?? 0, ...count(n[1], n[2]), qual: n[3].replace(/\bnon-Tuner\b/, '').trim(), tuners: Number(t[1]), tunerQual };
      else if (/^"[^"]+"$/.test(right.trim())) req = { kind, level: info.level ?? 0, min: 1, max: 1, qual: right.trim(), tuners: Number(t[1]), tunerQual };
    }
  } else if (kind === 'Link') {
    const m = line.match(/^(\d+)(\+| or more)? (.*)$/);
    if (m) req = { kind, level: 0, ...count(m[1], m[2]), qual: m[3], tuners: 0, tunerQual: '' };
  }
  CACHE.set(name, req);
  return req;
}

/** Does this monster fit a material description like "LIGHT or DARK", "Dragon-Type", "\"Heraldic Beast\"", "Synchro", "non-Link"? */
export function fits(e: Engine, c: Card, qual: string): boolean {
  let q = qual.replace(/\bmonsters?\b/gi, ' ').trim();
  if (!q) return true;
  const info = e.info(c.name);
  const names = [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (names.length && !names.some((n) => c.name.includes(n))) return false;
  q = q.replace(/"[^"]+"/g, ' ');
  const attrs = ATTRS.filter((a) => new RegExp(`\\b${a}\\b`).test(q));
  if (attrs.length && !attrs.includes(attrOf(e, c))) return false;
  if (/\bnon-Link\b/.test(q) && info.sub === 'Link') return false;
  if (/\bSynchro\b/i.test(q) && info.sub !== 'Synchro') return false;
  if (/\bEffect\b/.test(q) && (info.vanilla || info.sub === 'Normal')) return false;
  const races = q
    .replace(/non-Link|non-Tuner|Synchro|Effect|Tuner|\b(?:or|and)\b/gi, ' ')
    .replace(new RegExp(`\\b(?:${ATTRS.join('|')})\\b`, 'g'), ' ')
    .replace(/-Type/g, '')
    .split(/\s{2,}|,/)
    .map((r) => r.trim())
    .filter(Boolean);
  if (races.length && !races.some((r) => raceOf(e, c).replace(/-Type$/, '') === r)) return false;
  return true;
}

const subsets = <T>(list: T[], min: number, max: number): T[][] => {
  const out: T[][] = [];
  const n = list.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const pick = list.filter((_, i) => mask & (1 << i));
    if (pick.length >= min && pick.length <= max) out.push(pick);
  }
  return out;
};

/** Monsters this player could use as material for the given monster. */
function candidates(e: Engine, p: Pid, req: ExtraReq): FieldCard[] {
  return e.monsters(p).filter((m) => {
    if (!m.faceUp) return false;
    const info = e.info(m.name);
    if (req.kind === 'Xyz') return !m.token && info.sub !== 'Xyz' && info.sub !== 'Link' && levelOf(e, m) === req.level && fits(e, m, req.qual);
    if (req.kind === 'Synchro') return info.sub !== 'Xyz' && info.sub !== 'Link' && levelOf(e, m) > 0;
    return fits(e, m, req.qual);
  });
}

/** Is this exact group of monsters a legal set of materials? */
/** b19: a Tuner, or a monster an effect made a Tuner while face-up (tags.tuner: Assault Blackwing - Onimaru the Divine Thunder). */
export const isTuner = (e: Engine, m: FieldCard) => !!e.info(m.name).tuner || m.tags?.tuner === 1;
export function validMaterials(e: Engine, req: ExtraReq, mats: FieldCard[]): boolean {
  if (req.kind !== 'Synchro') return mats.length >= req.min && mats.length <= req.max;
  const tuners = mats.filter((m) => isTuner(e, m) && fits(e, m, req.tunerQual));
  if (tuners.length < req.tuners) return false;
  // The Tuners count as Tuners only up to the number needed; any other Tuner must fit as a non-Tuner.
  const asTuner = tuners.slice(0, req.tuners);
  const rest = mats.filter((m) => !asTuner.includes(m));
  if (rest.length < req.min || rest.length > req.max) return false;
  if (!rest.every((m) => !isTuner(e, m) && fits(e, m, req.qual))) return false;
  return mats.reduce((a, m) => a + levelOf(e, m), 0) === req.level;
}

function materialSets(e: Engine, p: Pid, req: ExtraReq): FieldCard[][] {
  const pool = candidates(e, p, req);
  const lo = req.kind === 'Synchro' ? req.tuners + req.min : req.min;
  const hi = req.kind === 'Synchro' ? req.tuners + req.max : req.max;
  return subsets(pool, lo, hi).filter((s) => validMaterials(e, req, s));
}

export const extraSummonable = (e: Engine, p: Pid, name: string) => {
  const req = extraReq(e, name);
  return !!req && materialSets(e, p, req).length > 0;
};

/** The built-in Summon procedure for an Xyz/Synchro/Link Monster (installSpeed registers it with the engine). */
export function builtinExtraProc(e: Engine, name: string): EffectDef['extraProc'] {
  const req = extraReq(e, name);
  if (!req) return undefined;
  return {
    can: (e2: Engine, _card: Card, p: Pid) => materialSets(e2, p, req).length > 0,
    *run(e2: Engine, card: Card, p: Pid) {
      const sets = materialSets(e2, p, req);
      if (!sets.length) return;
      // At most 3 Monster Zones: offer each legal group of materials as one choice.
      let mats = sets[0];
      if (sets.length > 1) {
        const choice = yield { kind: 'select', player: p, title: `${req.kind} Summon ${card.name} using:`, options: sets.map((s) => ({ label: s.map((m) => m.name).join(' + ') })), min: 1, max: 1, cancel: true };
        if (typeof choice !== 'object' || !('picks' in choice) || !choice.picks.length) return;
        mats = sets[choice.picks[0]] ?? sets[0];
      }
      yield* e2.extraSummon(p, card.uid, mats.map((m) => m.uid), req.kind);
    },
  };
}
