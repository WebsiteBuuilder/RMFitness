// Show-style sounds for duel cues (see ui/duelSfx). Two entry points:
//   cueSound: a cue that gets no cinematic (Cinematics setting) still makes its sound.
//   cueSting: a cinematic starting adds the show's signature sting on top of its own sounds
//   (Traps, Skills, extra Summon methods, shattering cards).
// Life Point changes sound from the on-screen counter (flow.tsx LpCount), not from here.
import * as sfx from '../ui/duelSfx';
import { playDraw } from '../ui/sound';
import type { Cue } from './cues';

export function cueSound(c: Cue, when = 0) {
  const go = () => {
    switch (c.kind) {
      case 'summon':
        return sfx.summon(c.how ?? (c.special ? 'special' : 'normal'));
      case 'set':
        return sfx.setCard();
      case 'flip':
        return sfx.flip();
      case 'activate':
        return c.what === 'trap' ? sfx.trap() : c.what === 'spell' ? sfx.spell() : sfx.monsterEffect();
      case 'skill':
        return sfx.skill();
      case 'attack':
        return sfx.attack(!c.target);
      case 'hit':
        return c.dmg ? sfx.impact() : sfx.clash();
      case 'destroy':
        return sfx.shatter();
      case 'damage':
        return sfx.impact();
      case 'leave':
        return sfx.leave();
      case 'draw':
        return c.count > 1 ? sfx.draw(c.count) : playDraw();
      default:
        // target: a pointer, no sound; heal: the counter; win: the result screen
        return;
    }
  };
  if (when > 0) setTimeout(go, when * 1000);
  else go();
}

const STING_HOW = new Set(['fusion', 'ritual', 'synchro', 'xyz', 'link']);

export function cueSting(c: Cue) {
  switch (c.kind) {
    case 'activate':
      if (c.what === 'trap') sfx.trap();
      return;
    case 'skill':
      return sfx.skill();
    case 'summon':
      if (c.how && STING_HOW.has(c.how.toLowerCase())) sfx.summon(c.how);
      return;
    case 'destroy':
      return sfx.shatter(0.05);
  }
}
