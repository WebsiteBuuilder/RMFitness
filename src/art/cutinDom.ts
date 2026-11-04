// Draws a portrait cut-in over the stage (cutins.ts plans them, the director times them): the
// screen splits on a slant, the opponent's face in the top half and yours in the bottom one. The
// duelist who acts slams in lit in their colours over racing speed lines, the other slides in
// darkened with a mark by their face, and the shout cuts across the seam. CSS transforms and
// opacity only (cutin.css), one element tree per cut-in, gone when it ends.
import { card, imageUrl } from '../eds/db';
import { ELEMENT_COLORS } from './profile';
import type { CutInShow } from './runtime';
import type { Face } from './cutins';
import { FOE_MARK } from './cutins';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/** A duelist's colours: their face card's Attribute (gold when it has none). */
export function faceColors(f: Face): [string, string] {
  const a = card(f.art)?.attribute as keyof typeof ELEMENT_COLORS | undefined;
  const c = a && ELEMENT_COLORS[a];
  return c ? [hex(c[0]), hex(c[1])] : ['#e0a41a', '#ffe9a8'];
}

/** How big the shout is drawn: long lines shrink to stay on screen. */
export const lineSize = (line: string) => {
  const longest = Math.max(...shoutRows(line).map((r) => r.length));
  return Math.max(0.62, Math.min(1, 15 / Math.max(1, longest)));
};

/** A long shout breaks after its first "!" onto two rows ("TRAP CARD, OPEN!" / "MIRROR FORCE!"). */
export function shoutRows(line: string): string[] {
  const i = line.indexOf('! ');
  return line.length > 20 && i > 0 && i < line.length - 3 ? [line.slice(0, i + 1), line.slice(i + 2)] : [line];
}

function half(f: Face, top: boolean, lead: boolean, why: CutInShow['why']): string {
  const url = imageUrl(f.art);
  const [c1, c2] = faceColors(f);
  return (
    `<div class="ci-half ${top ? 'ci-top' : 'ci-bot'} ${lead ? 'ci-lead' : 'ci-foe'}" style="--c1:${c1};--c2:${c2}">` +
    `<i class="ci-bg"></i>${lead ? '<i class="ci-lines"></i>' : ''}` +
    `<i class="ci-face"${url ? ` style="background-image:url('${url}')"` : ''}></i>` +
    `<div class="ci-plate"><b>${esc(f.name)}</b>${f.title ? `<span>${esc(f.title)}</span>` : ''}</div>` +
    (lead ? '' : `<b class="ci-mark">${FOE_MARK[why]}</b>`) +
    `</div>`
  );
}

/** Shows one cut-in (a new one replaces one still showing). */
// It is drawn on the page, over the chain spotlight's cards (z 71) and the board's bars: the
// faces are the moment. Taps go through it to the stage, which skips it.
export function showCutIn(_layer: HTMLElement, o: CutInShow): HTMLElement {
  const layer = document.body;
  hideCutIn();
  const el = document.createElement('div');
  const leadTop = o.lead === 'far';
  el.className = `cut-in why-${o.why} lead-${leadTop ? 'top' : 'bot'}`;
  el.style.setProperty('--d', `${o.dur}s`);
  // the seam's slant, so the shout lies along it on any screen
  // (the window's size: no layout is read mid-frame)
  const W = window.innerWidth;
  const H = window.innerHeight;
  const band = Math.min(H * 0.6, W * 1.25);
  el.style.setProperty('--band', `${Math.round(band)}px`);
  el.style.setProperty('--ang', `${(-Math.atan2(band * 0.16, W) * 180) / Math.PI}deg`);
  el.style.setProperty('--fs', String(lineSize(o.line)));
  const [l1, l2] = faceColors(o.me);
  el.style.setProperty('--l1', l1);
  el.style.setProperty('--l2', l2);
  const top = leadTop ? o.me : o.foe;
  const bot = leadTop ? o.foe : o.me;
  el.innerHTML =
    `<div class="ci-band">${half(top, true, leadTop, o.why)}${half(bot, false, !leadTop, o.why)}` +
    `<i class="ci-seam"></i><div class="ci-line"><span>${shoutRows(o.line.toUpperCase()).map(esc).join('<br>')}</span></div></div>` +
    `<i class="ci-flash"></i>`;
  layer.appendChild(el);
  const t = window.setTimeout(() => el.remove(), o.dur * 1000 + 40);
  (el as HTMLElement & { _t?: number })._t = t;
  return el;
}

/** Takes the cut-in on `layer` away at once. */
export function hideCutIn(_layer?: HTMLElement) {
  document.querySelectorAll<HTMLElement & { _t?: number }>('body > .cut-in').forEach((x) => (clearTimeout(x._t), x.remove()));
}
