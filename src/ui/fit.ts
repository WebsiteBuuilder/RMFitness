/* Big screens (tablets, laptops, desktops): the sizes the duel's JavaScript needs to agree with
   fitscreen.css, and keeping phones in portrait while tablets and computers turn freely. */

/** A tablet, laptop or desktop window: the same test as fitscreen.css's big-screen media query. */
export function bigScreen(): boolean {
  return typeof window !== 'undefined' && window.innerWidth >= 700 && window.innerHeight >= 600;
}

/** A landscape tablet or computer: the player bars move to the corners (fitscreen.css). */
export function landscapeBig(): boolean {
  return typeof window !== 'undefined' && window.innerWidth >= 900 && window.innerHeight >= 600 && window.innerWidth / window.innerHeight >= 1.25;
}

/** Width of a card in your hand (fitscreen.css / layout.css: --th-w). */
export function handCardW(): number {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (bigScreen()) return Math.round(Math.min(200, Math.max(96, h * 0.17)) * 0.685);
  return w <= 380 ? 64 : h >= 880 ? 100 : h >= 820 ? 88 : h >= 760 ? 78 : 70;
}

/** Big screens: the hand's real card width and room, measured (CSS vh can differ from innerHeight
    on iPad Safari); phones keep the arithmetic above, which costs no layout read per render. */
export function measuredHand(hand: Element | null | undefined): { cardW: number; room: number } {
  if (!bigScreen() || !hand) return { cardW: handCardW(), room: handRoom() };
  const card = hand.querySelector('.thcard') as HTMLElement | null;
  const cs = getComputedStyle(hand);
  const room = hand.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return { cardW: card?.offsetWidth || handCardW(), room: room > 0 ? room : handRoom() };
}

/** The room your hand has to fan out in (a phone column on phones, the whole width on big screens). */
export function handRoom(): number {
  const w = window.innerWidth;
  // (landscape: between the two corner bars, --fit-bar)
  if (landscapeBig()) return w - 2 * (Math.min(430, Math.max(320, w * 0.27)) + 24) - 20;
  return (bigScreen() ? w * 0.9 : Math.min(w, 560)) - 20;
}

/** Phones stay in portrait (the installed app may turn now, for tablets): a lock only takes in
    fullscreen, which is how the installed app runs; a browser tab ignores it. */
export function lockPhonePortrait() {
  if (typeof screen === 'undefined') return;
  const small = Math.min(screen.width, screen.height) < 600;
  const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
  if (small && o?.lock) o.lock('portrait').catch(() => {});
}
