// The chat's quick phrases, emotes and pacing (DuelChat.tsx), kept apart from the screen so tests can load them.

/** Duel Links-style phrases: one tap sends them. */
export const QUICK_PHRASES = ['Hi! Good luck!', 'Nice move!', 'Wow!', 'Oops…', 'Thinking…', 'Your go!', 'Hurry up 😄', 'Good game!', 'Rematch?', 'Thanks!'];
/** The phrases in the order that fits the moment: greetings in the room, what fits whose turn it is, GG after it. */
export function phrasesFor(when: 'room' | 'mine' | 'theirs' | 'after'): string[] {
  const first = {
    room: ['Hi! Good luck!', 'Thanks!'],
    // (your turn: you're the one thinking, and you hand it over)
    mine: ['Thinking…', 'Nice move!', 'Your go!'],
    theirs: ['Nice move!', 'Wow!', 'Hurry up 😄'],
    after: ['Good game!', 'Rematch?', 'Thanks!'],
  }[when];
  return [...first, ...QUICK_PHRASES.filter((p) => !first.includes(p))];
}
/** Emotes: one tap sends them, shown big. */
export const EMOTES = ['👍', '😂', '😮', '😡', '😭', '🔥', '🤝', '👋'];

/** The five emotes beside the held chat button: a wave and a handshake in the room and after the duel. */
export function quickEmotes(when: 'room' | 'mine' | 'theirs' | 'after'): string[] {
  return when === 'room' || when === 'after' ? ['👋', '🤝', '👍', '😂', '🔥'] : EMOTES.slice(0, 5);
}
/** How long the chat button is held before the quick emotes show. */
export const HOLD_MS = 380;

/** At most this many lines from this phone in SPAM_MS. */
const SPAM_LINES = 4;
export const SPAM_MS = 8000;
/** How long the other player's new line shows (longer lines stay longer), and your own "sent" pill. */
export const BUBBLE_MS = 4500;
export const bubbleMs = (text: string) => Math.min(7000, Math.max(BUBBLE_MS, 2500 + 60 * Array.from(text).length));
export const MINE_MS = 2000;
/** Your line not back from the room after this long shows as not sent (tap to try again). */
export const PENDING_MS = 8000;
/** An emote-only line (one to three emoji) is shown big. */
export function isEmote(text: string): boolean {
  return /^(\p{Extended_Pictographic}\uFE0F?(\u200D\p{Extended_Pictographic}\uFE0F?)*\s?){1,3}$/u.test(text);
}

/** Lines this phone may still send right now (the rest wait SPAM_MS). */
export function canSend(sentAt: number[], now: number): boolean {
  return sentAt.filter((t) => now - t < SPAM_MS).length < SPAM_LINES;
}
