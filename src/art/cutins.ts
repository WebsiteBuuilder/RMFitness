// Anime portrait cut-ins: on an attack declaration, a chain the other duelist answers, and the
// final blow, the screen splits on a slant between the two duelists' faces (the card art that
// stands for each: a computer duelist's portrait, a player's Ace or best monster), speed lines
// racing behind the one who acts and a short shout across the seam. Under a second, tap to skip,
// "Portrait cut-ins" in the duel Menu.
//
// This file is the plan (which moments get one, and what is shouted) and who is on screen; the
// director plays a 'cutin' cue (runtime.ts cutIn) and cutinDom.ts draws it.
import { card, imageUrl } from '../eds/db';
import type { Pid } from '../eds/types';
import { aceFor } from '../ace/ace';
import type { ChainCard, Cue, CutInWhy } from './cues';

/** A duelist as a cut-in shows them. */
export interface Face {
  /** their name (the name plate) */
  name: string;
  /** the card whose art stands for their face */
  art: string;
  /** the line under the name ('' when none) */
  title: string;
}

/** How long each cut-in lasts at 1× (cinematic seconds). Every one stays under a second. */
export const CUTIN_DUR: Record<CutInWhy, number> = { attack: 0.74, chain: 0.78, final: 0.96 };
/** From this far before its end the next cinematic of the chain starts under it (the cut-in wipes away over it). */
export const CUTIN_OVERLAP = 0.16;

// ---------- who is on screen ----------
let faces: [Face | null, Face | null] = [null, null];
/** a solo duel's own portraits and titles (the computer duelist's, from the VS splash), by seat */
let hints: [Partial<Face> | null, Partial<Face> | null] = [null, null];
let warm: HTMLImageElement[] = [];
let warmKey = '';

/** The duel screen calls this with each seat's duelist (null to stop): both phones of an online room see both. */
export function showDuelFaces(f: [Face | null, Face | null] | null) {
  // (the hints are FaceHints' own: a duel screen drawn before the duel starts must not wipe them)
  faces = f ?? [null, null];
  preloadFaces();
}

/** A solo duel: the computer duelist's portrait and title (and in a computer-vs-computer duel, both). */
export function showFaceHints(h: [Partial<Face> | null, Partial<Face> | null] | null) {
  hints = h ?? [null, null];
  preloadFaces();
}

/** (the decoded pictures are kept while the duel is on) */
export const facesWarm = () => warm.length;

/** Seat `p`'s face on screen now (null: none known, so no cut-ins this duel). */
export function duelFace(p: Pid): Face | null {
  const f = faces[p];
  if (!f) return null;
  const h = hints[p];
  const art = h?.art && card(h.art) ? h.art : f.art;
  return { name: f.name, art, title: h?.title ?? f.title };
}

/** Both faces are known: cut-ins can play. */
export const facesReady = () => !!duelFace(0) && !!duelFace(1);

/** The pictures are fetched and decoded as the duel opens, so the first cut-in never pops in blank. */
function preloadFaces() {
  if (typeof Image === 'undefined') return;
  const urls = ([0, 1] as Pid[]).map((p) => duelFace(p)).map((f) => (f ? imageUrl(f.art) : null)).filter((u): u is string => !!u);
  const key = urls.join('|');
  if (key === warmKey) return;
  warmKey = key;
  warm = urls.map((u) => {
    const im = new Image();
    im.decoding = 'async';
    im.src = u;
    void im.decode?.().catch(() => {});
    return im;
  });
}

/** The strongest monster in a deck (what stands for a player with no Ace picked). */
export function bestMonster(main: string[]): string {
  return [...main].filter((n) => card(n)?.kind === 'monster').sort((a, b) => (card(b)?.atk ?? 0) - (card(a)?.atk ?? 0))[0] ?? main[0] ?? '';
}

// ---------- what is shouted ----------
/** A card's name as a duelist shouts it (the part before a comma: "Raviel", not "Raviel, Lord of Phantasms"). */
export function shoutName(name: string): string {
  const n = name.split(',')[0].trim();
  return n || name;
}

const pick = <T>(xs: T[], i: number): T => xs[((i % xs.length) + xs.length) % xs.length];

/** The attacker's shout. `ace`: it is their Ace; `direct`: nothing stands in the way. */
export function attackLine(name: string, o: { ace: boolean; direct: boolean }, i: number): string {
  const s = shoutName(name);
  if (o.ace) return pick([`${s}, my Ace! Show them!`, `Rise and strike, ${s}!`, `Now, ${s}! Our moment!`], i);
  if (o.direct) return pick([`${s}, attack directly!`, `Straight at you! Go, ${s}!`, `Nothing stops this! ${s}!`], i);
  return pick([`Go, ${s}!`, `${s}, attack!`, `Battle! Strike, ${s}!`, `Take this! ${s}!`], i);
}

/** The answering duelist's shout as their card joins the chain. */
export function chainLine(link: ChainCard, i: number): string {
  const s = shoutName(link.card.name);
  if (!s) return pick(['Not yet!', 'I chain a card!'], i);
  if (link.what === 'trap') return pick([`Trap card, open! ${s}!`, `Not yet! ${s}!`, `I chain ${s}!`], i);
  if (link.what === 'spell') return pick([`Quick-Play! ${s}!`, `I chain ${s}!`], i);
  return pick([`${s}, your effect!`, `I chain ${s}!`], i);
}

/** The winner's shout before the final blow replays. */
export function finalLine(i: number): string {
  return pick(['This ends now!', "It's over!", 'This duel is mine!', 'Game over!'], i);
}

/** What the duelist who is hit shows (a mark by their face). */
export const FOE_MARK: Record<CutInWhy, string> = { attack: '!?', chain: '!!', final: 'NO…!' };

// ---------- which moments get one ----------
/**
 * Picks the moments of one chain that get a cut-in, for one duel (Flow keeps one). Only the
 * moments that matter, so the duel stays quick: a duelist's first attack each turn, every attack
 * by their Ace, the first time the other duelist answers in a chain, and the final blow.
 */
export class CutInPlan {
  /** turn:seat pairs that already had their attack cut-in */
  private attacked = new Set<string>();
  /** cut-ins so far this duel (picks the shout: both phones see the same moments in the same order) */
  private n = 0;

  /** `turn`: the duel's turn number now. Returns the cues with cut-ins put in, and which positions are new. */
  plan(cues: Cue[], turn: number): { cues: Cue[]; added: number[] } {
    const out: Cue[] = [];
    const added: number[] = [];
    if (!facesReady()) return { cues, added };
    const slam = cues.some((c) => c.kind === 'slam');
    let chained = false;
    const firstReplay = cues.findIndex((c) => c.replay);
    const win = cues.find((c) => c.kind === 'win');
    cues.forEach((c, i) => {
      const put = (cut: Cue) => (added.push(out.length), out.push(cut), this.n++);
      // the final blow: the winner's grin and the loser's shock, before the blow replays
      if (i === firstReplay && win && win.kind === 'win' && win.winner !== 'draw') {
        const w = win.winner;
        const a = cues.find((x, j) => j >= i && x.kind === 'hit' && x.replay);
        const about = a && a.kind === 'hit' && a.attacker?.faceUp !== false ? (a.attacker?.name ?? '') : '';
        put({ kind: 'cutin', why: 'final', seat: w, foe: w === 0 ? 1 : 0, line: finalLine(this.n), about });
      } else if (c.kind === 'attack' && !c.replay && c.attacker.name) {
        const seat = c.attacker.controller;
        const own = (c.attacker.owner ?? seat) === seat;
        const ace = own && !!aceFor(seat, c.attacker.name);
        const key = `${turn}:${seat}`;
        if (ace || !this.attacked.has(key)) {
          this.attacked.add(key);
          put({ kind: 'cutin', why: 'attack', seat, foe: seat === 0 ? 1 : 0, line: attackLine(c.attacker.name, { ace, direct: !c.target }, this.n), about: c.attacker.name });
        }
      } else if (c.kind === 'chain' && !c.replay && !slam && !chained && c.added >= 2 && c.added <= 3) {
        // (a "Not so fast!" slam already gives the answer its moment; a long back-and-forth gets
        // the first answer and the counter, then the spotlight carries the rest)
        const top = c.stack.find((l) => l.n === c.added);
        const under = c.stack.find((l) => l.n === c.added - 1);
        if (top && under && top.card.controller !== under.card.controller) {
          chained = true;
          const seat = top.card.controller;
          put({ kind: 'cutin', why: 'chain', seat, foe: seat === 0 ? 1 : 0, line: chainLine(top, this.n), about: top.card.name });
        }
      }
      out.push(c);
    });
    return { cues: out, added };
  }
}
