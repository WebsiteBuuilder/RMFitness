// The chat's quick phrases, emotes and pacing (DuelChat.tsx), kept apart from the screen so tests can load them.

/** Duel Links-style phrases: one tap sends them. */
export const QUICK_PHRASES = ['Hi! Good luck!', 'Nice move!', 'Wow!', 'Oops…', 'Thinking…', 'Your turn!', 'Hurry up 😄', 'Good game!', 'Rematch?', 'Thanks!'];
/** Emotes: one tap sends them, shown big. */
export const EMOTES = ['👍', '😂', '😮', '😡', '😭', '🔥', '🤝', '👋'];

/** At most this many lines from this phone in SPAM_MS. */
const SPAM_LINES = 4;
export const SPAM_MS = 8000;
/** How long a new line floats over the board. */
export const BUBBLE_MS = 4500;

/** An emote-only line (one to three emoji) is shown big. */
export function isEmote(text: string): boolean {
  return /^(\p{Extended_Pictographic}\uFE0F?(\u200D\p{Extended_Pictographic}\uFE0F?)*\s?){1,3}$/u.test(text);
}

/** Lines this phone may still send right now (the rest wait SPAM_MS). */
export function canSend(sentAt: number[], now: number): boolean {
  return sentAt.filter((t) => now - t < SPAM_MS).length < SPAM_LINES;
}
