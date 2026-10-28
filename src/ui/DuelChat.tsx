// Chat between the two players of an online room: typed lines, quick phrases and emotes.
// Lines ride the room's own log (a CHAT action the duel ignores), so they reach the other
// phone the same way the moves do, over the online service or phone to phone, and a phone
// that rejoins sees what was said. Nothing here covers the board for long: new lines float
// in as bubbles for a few seconds, and the full chat drops down over the top of the screen.
import { useEffect, useRef, useState } from 'preact/hooks';
import { CHAT_MAX, cleanChat, type ChatLine, type DuelSession } from '../eds/session';
import type { Pid } from '../eds/types';
import * as sfx from './duelSfx';
import { BUBBLE_MS, canSend, EMOTES, isEmote, MINE_MS, NEWS_MS, QUICK_PHRASES, SPAM_MS } from './chatRules';
import './chat.css';

const MUTE_KEY = 'eds.chat.muted';

const readMuted = () => {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * Where the button sits: 'duel' under the top bar, clear of the field and the hand; 'low' bottom right,
 * clear of the room's window (lobby, who goes first); 'top' in the top corner, over the result screen.
 */
export type ChatPlace = 'duel' | 'low' | 'top';

export function DuelChat({ session, chat, mySeat, names, place = 'duel' }: { session: DuelSession; chat: ChatLine[]; mySeat: Pid; names: [string, string]; place?: ChatPlace }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [muted, setMuted] = useState(readMuted);
  const [bubbles, setBubbles] = useState<ChatLine[]>([]);
  const [slow, setSlow] = useState(false);
  const slowTimer = useRef<number>();
  useEffect(() => () => clearTimeout(slowTimer.current), []);
  /** lines already seen (the ones there when the chat first showed don't pop up again) */
  const seen = useRef<Set<string> | null>(null);
  const [unread, setUnread] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opp: Pid = mySeat === 0 ? 1 : 0;
  const shown = muted ? chat.filter((l) => l.player === mySeat) : chat;

  // New lines: a bubble over the board (unless the chat is open), a blip and the unread count for the other's.
  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(chat.map((l) => l.id));
      return;
    }
    // (a log arriving after a rejoin brings old lines: they are history, not news)
    const now = Date.now();
    const fresh = chat.filter((l) => !seen.current!.has(l.id) && now - l.at < NEWS_MS);
    for (const l of chat) seen.current.add(l.id);
    if (!fresh.length) return;
    const theirs = fresh.filter((l) => l.player === opp && !muted);
    const pop = fresh.filter((l) => l.player === mySeat || !muted);
    if (theirs.length) sfx.chatPing();
    if (open) return;
    if (theirs.length) setUnread((n) => n + theirs.length);
    if (!pop.length) return;
    setBubbles((b) => [...b, ...pop].slice(-3));
    for (const l of pop) setTimeout(() => setBubbles((b) => b.filter((x) => x.id !== l.id)), l.player === mySeat ? MINE_MS : BUBBLE_MS);
  }, [chat.length, chat[chat.length - 1]?.id]);

  useEffect(() => {
    if (!open) return;
    setUnread(0);
    setBubbles([]);
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, shown.length]);

  // Escape (a keyboard or a controller's B) closes the chat.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [open]);

  // A phone keyboard (iPhone scrolls the page under it): the sheet follows the visible part of the screen.
  const [vv, setVv] = useState<{ top: number; h: number } | null>(null);
  useEffect(() => {
    const v = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!open || !v) return;
    const on = () => setVv(v.offsetTop > 0 || v.height < window.innerHeight - 1 ? { top: Math.round(v.offsetTop), h: Math.round(v.height) } : null);
    v.addEventListener('resize', on);
    v.addEventListener('scroll', on);
    on();
    return () => (v.removeEventListener('resize', on), v.removeEventListener('scroll', on), setVv(null));
  }, [open]);

  const say = (raw: string): boolean => {
    const text = cleanChat(raw);
    if (!text) return false;
    const now = Date.now();
    const sent = session.chatSentAt;
    if (!canSend(sent, now)) {
      setSlow(true);
      clearTimeout(slowTimer.current);
      slowTimer.current = window.setTimeout(() => setSlow(false), SPAM_MS / 2);
      return false;
    }
    session.chatSentAt = [...sent.filter((t) => now - t < SPAM_MS), now];
    session.send({ type: 'CHAT', player: mySeat, text });
    return true;
  };

  const quick = (text: string) => {
    if (say(text)) setOpen(false);
  };

  const submit = (e: Event) => {
    e.preventDefault();
    if (say(draft)) setDraft('');
    input.current?.focus();
  };

  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    try {
      localStorage.setItem(MUTE_KEY, m ? '1' : '0');
    } catch {
      /* this time only */
    }
  };

  const theirName = names[opp] || 'your opponent';
  const theirBubbles = bubbles.filter((l) => l.player !== mySeat).slice(-2);
  const myBubble = bubbles.filter((l) => l.player === mySeat).slice(-1)[0];

  return (
    <>
      {/* their lines by their name in the top bar (never over the field); taps go through */}
      {theirBubbles.length > 0 && !open && (
        <div class={`chat-bubbles at-${place}`} aria-live="polite">
          {theirBubbles.map((l) => (
            <div key={l.id} class={`chat-bubble ${isEmote(l.text) ? 'emote' : ''}`}>
              <b>{names[l.player] || 'Opponent'}</b>
              <span>{l.text}</span>
            </div>
          ))}
        </div>
      )}
      {/* your own line: a short "sent" pill beside the button */}
      {myBubble && !open && (
        <div key={myBubble.id} class={`chat-sent at-${place} ${isEmote(myBubble.text) ? 'emote' : ''}`} aria-hidden="true">
          {myBubble.text}
        </div>
      )}
      <button class={`chat-fab at-${place} ${open ? 'on' : ''}`} aria-label={unread ? `Chat, ${unread} new` : 'Chat'} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z" fill="currentColor" />
        </svg>
        {unread > 0 && <span class="chat-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {/* the chat drops down over the top of the screen: your hand, your side of the field and the
          room's buttons stay in view and keep working while it is open */}
      {open && (
        <div class={`chat-sheet at-${place}`} role="dialog" aria-label={`Chat with ${theirName}`} style={vv ? { top: `${vv.top + 8}px`, maxHeight: `${Math.max(180, vv.h - 16)}px` } : undefined}>
          <div class="chat-head">
            <span class="chat-title">Chat with {theirName}</span>
            <button class={`chat-mute ${muted ? 'on' : ''}`} onClick={toggleMute} aria-pressed={muted}>
              {muted ? `🔕 Unmute` : `🔔 Mute ${names[opp] || 'them'}`}
            </button>
            <button class="chat-x" aria-label="Close chat" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <div class="chat-list" ref={list}>
            {shown.length === 0 && <p class="chat-empty">{muted ? `${names[opp] || 'Your opponent'} is muted. Tap Unmute to see their messages again.` : 'Say hi! Tap a phrase or type a message.'}</p>}
            {shown.map((l, i) => (
              <div key={l.id} class={`chat-line ${l.player === mySeat ? 'mine' : 'theirs'} ${isEmote(l.text) ? 'emote' : ''}`}>
                {/* (the name once per run of lines from the other player) */}
                {l.player !== mySeat && shown[i - 1]?.player !== l.player && <b>{names[l.player] || 'Opponent'}</b>}
                <span>{l.text}</span>
              </div>
            ))}
          </div>
          <div class="chat-quick">
            {EMOTES.map((t) => (
              <button key={t} class="chat-emote" onClick={() => quick(t)} aria-label={`Send ${t}`}>
                {t}
              </button>
            ))}
          </div>
          <div class="chat-quick">
            {QUICK_PHRASES.map((t) => (
              <button key={t} class="chat-phrase" onClick={() => quick(t)}>
                {t}
              </button>
            ))}
          </div>
          <form class="chat-form" onSubmit={submit}>
            <input ref={input} type="text" enterKeyHint="send" autocomplete="off" maxLength={CHAT_MAX} placeholder="Type a message" value={draft} onInput={(e) => setDraft((e.target as HTMLInputElement).value)} aria-label="Message" />
            <button type="submit" class="chat-send" disabled={!cleanChat(draft) || slow}>
              Send
            </button>
          </form>
          {slow && (
            <p class="chat-slow" role="status">
              Slow down a moment… you can send again in a few seconds.
            </p>
          )}
        </div>
      )}
    </>
  );
}
