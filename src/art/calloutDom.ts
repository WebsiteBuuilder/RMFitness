// Draws an attack callout over a cinematic (the duel's stage and the 3D Card Viewer share it):
// a slash of the monster's color across the screen, each word slamming in on its own beat, the
// card's name under it, and the attacker's Mate leaning in from its side yelling it too.
import { h, render } from 'preact';
import type { Ui } from './runtime';
import { mateEcho, shoutLines, shoutSize } from './callouts';
import { MateArt } from '../mates/MateArt';
import { stageMate, stageMateVoice } from '../mates/onStage';
import { playMate } from '../ui/sound';

type CalloutOpts = Parameters<NonNullable<Ui['callout']>>[0];

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/** `speed`: the playback speed (the shout lasts o.dur / speed seconds). */
export function showCallout(layer: HTMLElement, o: CalloutOpts, speed = 1): HTMLElement {
  // (one shout at a time: a new one replaces one still showing)
  layer.querySelectorAll('.art-callout').forEach((x) => x.remove());
  let n = 0;
  const lines = shoutLines(o.text.toUpperCase()).map((l) => `<span class="co-line">${l.map((w) => `<b style="--i:${n++}">${esc(w)}</b>`).join(' ')}</span>`);
  const el = document.createElement('div');
  el.className = `art-callout side-${o.side}${o.ace ? ' ace' : ''}${lines.length > 1 ? ' two' : ''}`;
  const d = o.dur / Math.max(0.25, speed);
  el.style.setProperty('--d', `${d}s`);
  el.style.setProperty('--c', hex(o.color));
  el.style.setProperty('--c2', hex(o.light));
  el.style.setProperty('--fs', `${shoutSize(o.text)}vw`);
  el.innerHTML =
    `<i class="co-band"></i><i class="co-lines"></i>` +
    `<div class="co-text${lines.length > 1 ? ' two' : ''}">${lines.join('')}</div>` +
    `<div class="co-who">${o.ace ? `<i class="co-ace">★ ACE · ${esc(o.ace.title)}</i>` : ''}<span>${esc(o.card)}</span></div>`;
  const mate = stageMate(o.seat);
  let fig: HTMLElement | null = null;
  if (mate) {
    const m = document.createElement('div');
    m.className = 'co-mate';
    m.innerHTML = `<div class="co-fig"></div><div class="co-bubble">${esc(mateEcho(o.text))}</div>`;
    fig = m.firstElementChild as HTMLElement;
    render(h(MateArt, { id: mate, face: 'laugh', class: o.side === 'far' ? 'flip' : '' }), fig);
    el.appendChild(m);
    const v = stageMateVoice(o.seat);
    if (v) window.setTimeout(() => el.isConnected && playMate(v, 'up'), 220 / Math.max(0.25, speed));
  }
  layer.appendChild(el);
  window.setTimeout(() => {
    if (fig) render(null, fig);
    el.remove();
  }, d * 1000 + 60);
  return el;
}
