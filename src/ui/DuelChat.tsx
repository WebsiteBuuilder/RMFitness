// Chat between the two players of an online room: typed lines, quick phrases and emotes.
// Lines ride the room's own log (a CHAT action the duel ignores), so they reach the other
// phone the same way the moves do, over the online service or phone to phone, and a phone
// that rejoins sees what was said. Nothing here covers the board for long: new lines float
// in as bubbles for a few seconds, and the full chat is a small sheet over the bottom.
import { useEffect, useRef, useState } from 'preact/hooks';
import { CHAT_MAX, cleanChat, type ChatLine, type DuelSession } from '../eds/session';
import type { Pid } from '../eds/types';
import * as sfx from './duelSfx';
import { BUBBLE_MS, canSend, EMOTES, isEmote, QUICK_PHRASES, SPAM_MS } from './chatRules';
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
  /** lines already seen (the ones there when the chat first showed don't pop up again) */
  const seen = useRef<Set<string> | null>(null);
  const [unread, setUnread] = useState(0);
  const sentAt = useRef<number[]>([]);
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
    const fresh = chat.filter((l) => !seen.current!.has(l.id));
    if (!fresh.length) return;
    for (const l of fresh) seen.current.add(l.id);
    const theirs = fresh.filter((l) => l.player === opp && !muted);
    const pop = fresh.filter((l) => l.player === mySeat || !muted);
    if (theirs.length) sfx.chatPing();
    if (open) return;
    if (theirs.length) setUnread((n) => n + theirs.length);
    if (!pop.length) return;
    setBubbles((b) => [...b, ...pop].slice(-2));
    const ids = new Set(pop.map((l) => l.id));
    setTimeout(() => setBubbles((b) => b.filter((x) => !ids.has(x.id))), BUBBLE_MS);
  }, [chat.length, chat[chat.length - 1]?.id]);

  useEffect(() => {
    if (!open) return;
    setUnread(0);
    setBubbles([]);
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, shown.length]);

  // Back / Escape closes the sheet.
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

  // A phone keyboard over the sheet (iPhone): lift the sheet above it.
  const [lift, setLift] = useState(0);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!open || !vv) return;
    const on = () => setLift(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    vv.addEventListener('resize', on);
    vv.addEventListener('scroll', on);
    on();
    return () => (vv.removeEventListener('resize', on), vv.removeEventListener('scroll', on), setLift(0));
  }, [open]);

  const say = (raw: string): boolean => {
    const text = cleanChat(raw);
    if (!text) return false;
    const now = Date.now();
    if (!canSend(sentAt.current, now)) {
      setSlow(true);
      setTimeout(() => setSlow(false), SPAM_MS / 2);
      return false;
    }
    sentAt.current = [...sentAt.current.filter((t) => now - t < SPAM_MS), now];
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

  const who = (p: Pid) => (p === mySeat ? 'You' : names[p] || 'Opponent');

  return (
    <>
      {bubbles.length > 0 && !open && (
        <div class={`chat-bubbles at-${place}`} aria-live="polite">
          {bubbles.map((l) => (
            <div key={l.id} class={`chat-bubble ${l.player === mySeat ? 'mine' : 'theirs'} ${isEmote(l.text) ? 'emote' : ''}`}>
              <b>{who(l.player)}</b>
              <span>{l.text}</span>
            </div>
          ))}
        </div>
      )}
      <button class={`chat-fab at-${place} ${open ? 'on' : ''}`} aria-label={unread ? `Chat, ${unread} new` : 'Chat'} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z" fill="currentColor" />
        </svg>
        {unread > 0 && <span class="chat-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div class="chat-back" onClick={() => setOpen(false)}>
          <div class="chat-sheet" role="dialog" aria-label={`Chat with ${names[opp] || 'your opponent'}`} style={lift ? { marginBottom: `${lift}px` } : undefined} onClick={(e) => e.stopPropagation()}>
            <div class="chat-head">
              <span class="chat-title">Chat with {names[opp] || 'your opponent'}</span>
              <button class={`chat-mute ${muted ? 'on' : ''}`} onClick={toggleMute} aria-pressed={muted}>
                {muted ? 'Muted' : 'Mute'}
              </button>
              <button class="chat-x" aria-label="Close chat" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            <div class="chat-list" ref={list}>
              {shown.length === 0 && <p class="chat-empty">{muted ? `${names[opp] || 'Your opponent'} is muted. Tap Muted to see their messages again.` : 'Say hi! Tap a phrase or type a message.'}</p>}
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
              <input ref={input} type="text" enterKeyHint="send" autocomplete="off" maxLength={CHAT_MAX} placeholder={slow ? 'Slow down a moment…' : 'Type a message'} value={draft} onInput={(e) => setDraft((e.target as HTMLInputElement).value)} aria-label="Message" />
              <button type="submit" class="chat-send" disabled={!cleanChat(draft) || slow}>
                Send
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
