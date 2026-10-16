// Finds what a finger could tap. Preact attaches onClick/onPointerDown with
// addEventListener, so every element that takes a tap is noted here as it gets its
// listener. Must be imported before the app first renders (main.tsx does).

const TAP = new Set(['click', 'pointerdown', 'mousedown', 'touchstart']);
const types = new WeakMap<Element, Set<string>>();
const live = new Set<Element>();

if (typeof EventTarget !== 'undefined' && typeof Element !== 'undefined') {
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) {
    if (TAP.has(type) && this instanceof Element) {
      let t = types.get(this);
      if (!t) types.set(this, (t = new Set()));
      t.add(type);
      live.add(this);
    }
    return add.call(this, type, fn, o);
  };
  EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) {
    if (TAP.has(type) && this instanceof Element) {
      const t = types.get(this);
      t?.delete(type);
      if (t && !t.size) live.delete(this);
    }
    return remove.call(this, type, fn, o);
  };
}

/** Elements on the page that take taps (ones that left the page are dropped as they're found). */
export function tappable(): Element[] {
  const out: Element[] = [];
  for (const el of live) {
    // (gone from the page: scans run between renders, never mid-render)
    if (!el.isConnected) {
      live.delete(el);
      continue;
    }
    out.push(el);
  }
  return out;
}
