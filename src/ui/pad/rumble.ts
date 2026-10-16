// A short buzz on every connected controller that can vibrate (Chrome on Android and
// desktop; Safari ignores it). Safe to call anywhere, including tests under Node.

type Actuator = { playEffect?: (type: string, p: Record<string, number>) => Promise<unknown> };

let lastAt = 0;

export function rumble(strong: number, weak: number, ms: number, delayMs = 0) {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  // (a burst of hits in one frame is one buzz)
  if (now - lastAt < 30 && ms < 100) return;
  lastAt = now;
  try {
    for (const g of navigator.getGamepads()) {
      const a = (g as unknown as { vibrationActuator?: Actuator } | null)?.vibrationActuator;
      a?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak, startDelay: Math.max(0, Math.round(delayMs)) })?.catch?.(() => {});
    }
  } catch {
    /* no controller, or no vibration */
  }
}
