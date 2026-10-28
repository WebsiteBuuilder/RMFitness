// Chat between the two players of an online room: typed lines, quick phrases and emotes.
// Lines ride the room's own log (a CHAT action the duel ignores), so they reach the other
// phone the same way the moves do, over the online service or phone to phone, and a phone
// that rejoins sees what was said. Nothing here covers the board for long: new lines float
// in as bubbles for a few seconds, and in the duel the full chat rises over your hand, so
// the whole field (theirs and yours) stays in view.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { CHAT_MAX, cleanChat, type ChatLine, type DuelSession } from '../eds/session';
import type { Pid } from '../eds/types';
import * as sfx from './duelSfx';
import { bubbleMs, canSend, EMOTES, isEmote, MINE_MS, phrasesFor, SPAM_MS } from './chatRules';
import './chat.css';

const MUTE_KEY = 'eds.chat.muted';

/** a light tap on the phone (Android; iPhone browsers have none) as a line goes out or comes in */
const buzz = () => {
  try {
    navigator.vibrate?.(12);
  } catch {
    /* none */
  }
};

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

export function DuelChat({
  session,
  chat,
  mySeat,
  names,
  place = 'duel',
  attention = '',
  classic = false,
}: {
  session: DuelSession;
  chat: ChatLine[];
  mySeat: Pid;
  names: [string, string];
  place?: ChatPlace;
  /** changes when the duel needs this player (a prompt, an attack, a new phase): the open chat gets out of the way */
  attention?: string;
  /** Classic controls in the duel (a thinner top bar) */
  classic?: boolean;
}) {
  const [open, setOpenState] = useState(session.chatOpen);
  const [draft, setDraftState] = useState(session.chatDraft);
  // (kept on the room, so the chat picks up where it was when the duel turns into the result screen)
  const setOpen = (o: boolean) => ((session.chatOpen = o), setOpenState(o));
  const setDraft = (d: string) => ((session.chatDraft = d), setDraftState(d));
  const timers = useRef(new Set<number>());
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);
  const [muted, setMuted] = useState(readMuted);
  const [bubbles, setBubbles] = useState<ChatLine[]>([]);
  const [slow, setSlow] = useState(false);
  const slowTimer = useRef<number>();
  useEffect(() => () => clearTimeout(slowTimer.current), []);
  const [unread, setUnreadState] = useState(session.chatUnread);
  const setUnread = (f: (n: number) => number) => setUnreadState((session.chatUnread = f(session.chatUnread)));
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opp: Pid = mySeat === 0 ? 1 : 0;
  const shown = muted ? chat.filter((l) => l.player === mySeat) : chat;

  // New lines: a bubble over the board (unless the chat is open), a blip and the unread count for the other's.
  useEffect(() => {
    if (!session.chatSeen) {
      session.chatSeen = new Set(chat.map((l) => l.id));
      return;
    }
    const had = new Set(session.chatSeen);
    for (const l of chat) session.chatSeen.add(l.id);
    // (news: a line said now; the log loading after a rejoin or reload brings history: no ping, no bubble, no count)
    const fresh = chat.filter((l) => !had.has(l.id) && !l.old);
    if (fresh.length) announce(fresh);
  }, [chat.length, chat[chat.length - 1]?.id]);

  const mutedNow = useRef(muted);
  mutedNow.current = muted;
  const announce = (fresh: ChatLine[]) => {
    const muted = mutedNow.current;
    const theirs = fresh.filter((l) => l.player === opp && !muted);
    const pop = fresh.filter((l) => l.player === mySeat || !muted);
    if (theirs.length) (sfx.chatPing(), buzz());
    // (the chat open in full shows the line itself; the small one has no list, so the bubble shows)
    if (session.chatOpen && !miniNow.current) return;
    // (unread until the chat is opened: the bubble goes away, the count stays)
    if (theirs.length) setUnread((n) => n + theirs.length);
    // (one line each at a time: a newer one replaces the one showing)
    const lastTheirs = pop.filter((l) => l.player !== mySeat).pop();
    const lastMine = pop.filter((l) => l.player === mySeat).pop();
    if (!lastTheirs && !lastMine) return;
    setBubbles((b) => [lastTheirs ?? b.find((x) => x.player !== mySeat), lastMine ?? b.find((x) => x.player === mySeat)].filter((x): x is ChatLine => !!x));
    for (const l of [lastTheirs, lastMine]) {
      if (!l) continue;
      const t = window.setTimeout(() => {
        timers.current.delete(t);
        setBubbles((b) => b.filter((x) => x.id !== l.id));
      }, l.player === mySeat ? MINE_MS : bubbleMs(l.text));
      timers.current.add(t);
    }
  };

  useEffect(() => {
    if (!open) return;
    setUnread(() => 0);
    setBubbles([]);
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, shown.length]);

  // The duel needs you (your prompt, an attack, a new phase or turn): the chat closes; what you typed stays.
  const lastAttention = useRef(attention);
  useEffect(() => {
    // (the other player's turn starting or going on leaves it open: that's the time to talk)
    if (attention !== lastAttention.current && attention !== 'theirs:' && open) setOpen(false);
    lastAttention.current = attention;
  }, [attention]);

  // A short screen (iPhone SE): emotes and phrases share one row, so the history keeps room.
  const [short, setShort] = useState(() => typeof window !== 'undefined' && window.innerHeight < 700);
  // (the phone turned or the window resized: the duel's chat measures its room again)
  const [turned, setTurned] = useState(0);
  useEffect(() => {
    const on = () => (setShort(window.innerHeight < 700), setTurned((n) => n + 1));
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  // In the duel the open chat rises over your hand and stops below the turn and phase controls: their
  // whole field, the middle of the board and End Turn stay in view; where that leaves little room it
  // shrinks to one row of buttons and the box.
  const sheet = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!open || place !== 'duel') return setRoom(null);
    // (Touch: the turn row and the round phase button beside it; Classic: the centre strip)
    const marks = [...document.querySelectorAll('.duel.touch .tmid, .duel.touch .tphase, .duel .field .center')].map((el) => el.getBoundingClientRect().bottom).filter((b) => b > 0);
    // (its resting bottom: while it rises in, its box is still moving)
    const bottom = sheet.current ? parseFloat(getComputedStyle(sheet.current).bottom) : NaN;
    const limit = marks.length ? Math.max(...marks) : NaN;
    const r = Math.floor(window.innerHeight - bottom - limit - 6);
    setRoom(Number.isFinite(r) ? r : null);
  }, [open, place, short, turned]);
  const mini = room !== null && room < 230;
  const miniNow = useRef(mini);
  miniNow.current = mini;
  /** holding the eye button: the chat fades away so the field shows through */
  const [peek, setPeek] = useState(false);
  // (the chat closing under a held eye: no pointer-up ever comes)
  useEffect(() => void (!open && setPeek(false)), [open]);

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
    buzz();
    return true;
  };

  const quick = (text: string) => {
    if (say(text)) (setOpen(false), setRing(false));
  };

  // Hold the chat button: a row of emotes and the phrases for the moment pops up by it, one tap sends
  // (no chat to open, nothing over the field).
  const [ring, setRing] = useState(false);
  const holdTimer = useRef<number>();
  const held = useRef(false);
  useEffect(() => () => clearTimeout(holdTimer.current), []);
  const holdStart = () => {
    held.current = false;
    clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      held.current = true;
      setRing(true);
      buzz();
    }, 380);
  };
  const holdEnd = () => clearTimeout(holdTimer.current);
  const fabTap = () => {
    if (held.current) return void (held.current = false);
    if (ring) return setRing(false);
    setOpen(!open);
  };
  useEffect(() => void (attention && setRing(false)), [attention]);
  useEffect(() => {
    if (!ring) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), setRing(false));
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [ring]);

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
  const phrases = phrasesFor(place === 'low' ? 'room' : place === 'top' ? 'after' : 'duel');
  // (one at a time: a newer line replaces the one showing)
  const theirBubbles = bubbles.filter((l) => l.player !== mySeat).slice(-1);
  const myBubble = bubbles.filter((l) => l.player === mySeat).slice(-1)[0];

  // (a phone keyboard: the chat sits just above it; in the duel otherwise it stops under the turn controls)
  const sheetStyle: Record<string, string> | undefined =
    place !== 'top'
      ? vv
        ? { bottom: `${Math.max(0, window.innerHeight - vv.top - vv.h) + 8}px`, '--room': `${Math.max(120, vv.h - 16)}px` }
        : room !== null
          ? { '--room': `${Math.max(120, room)}px` }
          : undefined
      : vv
        ? { top: `${vv.top + 8}px`, maxHeight: `${Math.max(120, vv.h - 16)}px` }
        : undefined;
  const peekButton = (
    <button type="button" class="chat-peek" aria-label="Hold to see the field" onPointerDown={() => setPeek(true)} onPointerUp={() => setPeek(false)} onPointerCancel={() => setPeek(false)} onPointerLeave={() => setPeek(false)} onContextMenu={(e) => e.preventDefault()}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path d="M12 5C6.5 5 2.7 9.2 1.5 12c1.2 2.8 5 7 10.5 7s9.3-4.2 10.5-7C21.3 9.2 17.5 5 12 5zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2.2a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z" fill="currentColor" />
      </svg>
    </button>
  );
  const muteButton = (
    <button type="button" class={`chat-mute ${muted ? 'on' : ''}`} onClick={toggleMute} aria-pressed={muted} aria-label={muted ? `${theirName} is muted: tap to see their messages again` : `Mute ${theirName}`} title={muted ? 'Unmute' : 'Mute'}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path d="M3 9.5v5h4l5 4.5v-14L7 9.5z" fill="currentColor" />
        {muted ? <path d="M16 9l5 6m0-6l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" />}
      </svg>
    </button>
  );

  const emoteButtons = EMOTES.map((t) => (
    <button key={t} class="chat-emote" onClick={() => quick(t)} aria-label={`Send ${t}`}>
      {t}
    </button>
  ));
  const phraseButtons = phrases.map((t) => (
    <button key={t} class="chat-phrase" onClick={() => quick(t)}>
      {t}
    </button>
  ));

  return (
    <>
      {/* their lines by their name, under their bar; a tap opens the chat, taps around it go through */}
      {theirBubbles.length > 0 && (!open || mini) && (
        <div class={`chat-bubbles at-${place} ${classic ? 'classic' : ''}`} aria-live="polite">
          {theirBubbles.map((l) => (
            <div key={l.id} class={`chat-bubble ${isEmote(l.text) ? 'emote' : ''}`} style={{ '--out': `${bubbleMs(l.text) - 350}ms` } as Record<string, string>} onClick={() => setOpen(true)}>
              <b>{names[l.player] || 'Opponent'}</b>
              <span>{l.text}</span>
            </div>
          ))}
        </div>
      )}
      {/* your own line: a short "sent" pill beside the button */}
      {myBubble && !open && (
        <div key={myBubble.id} class={`chat-sent at-${place} ${isEmote(myBubble.text) ? 'emote' : ''}`} role="status">
          <b>You:</b>
          <span>{myBubble.text}</span>
        </div>
      )}
      {ring && !open && (
        <>
          <button type="button" class="chat-ring-off" aria-label="Close quick chat" onClick={() => setRing(false)} />
          <div class={`chat-ring at-${place} ${classic ? 'classic' : ''}`} role="menu" aria-label="Quick chat">
            {EMOTES.slice(0, 6).map((t) => (
              <button key={t} type="button" role="menuitem" class="chat-emote" onClick={() => quick(t)} aria-label={`Send ${t}`}>
                {t}
              </button>
            ))}
            {phrases.slice(0, 3).map((t) => (
              <button key={t} type="button" role="menuitem" class="chat-phrase" onClick={() => quick(t)}>
                {t}
              </button>
            ))}
          </div>
        </>
      )}
      <button class={`chat-fab at-${place} ${open || ring ? 'on' : ''}`} aria-label={unread ? `Chat, ${unread} new (hold for quick emotes)` : 'Chat (hold for quick emotes)'} aria-expanded={open} onClick={fabTap} onPointerDown={holdStart} onPointerUp={holdEnd} onPointerLeave={holdEnd} onPointerCancel={holdEnd} onContextMenu={(e) => e.preventDefault()}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z" fill="currentColor" />
        </svg>
        {unread > 0 && <span class="chat-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {/* the chat: in the duel it rises over your hand (the field and the turn controls stay in view and
          keep working), in the room it sits over the bottom, over the result screen at the top */}
      {open && (
        <div ref={sheet} class={`chat-sheet at-${place} ${mini ? 'mini' : ''} ${peek ? 'peek' : ''}`} role="dialog" aria-label={`Chat with ${theirName}`} style={sheetStyle}>
          <div class="chat-head">
            <span class="chat-title">Chat with {theirName}</span>
            {place === 'duel' && peekButton}
            {muteButton}
            <button class="chat-x" aria-label="Close chat" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <div class="chat-list" ref={list}>
            {shown.length === 0 && <p class="chat-empty">{muted ? `${names[opp] || 'Your opponent'} is muted. Tap the speaker to see their messages again.` : 'Say hi! Tap a phrase or type a message. Tip: hold the chat button for quick emotes.'}</p>}
            {shown.map((l, i) => (
              <div key={l.id} class={`chat-line ${l.player === mySeat ? 'mine' : 'theirs'} ${isEmote(l.text) ? 'emote' : ''}`}>
                {/* (the name once per run of lines from the other player) */}
                {l.player !== mySeat && shown[i - 1]?.player !== l.player && <b>{names[l.player] || 'Opponent'}</b>}
                <span>{l.text}</span>
              </div>
            ))}
          </div>
          {short || mini ? (
            <div class="chat-quick">
              {emoteButtons.slice(0, 3)}
              {phraseButtons.slice(0, 3)}
              {emoteButtons.slice(3)}
              {phraseButtons.slice(3)}
            </div>
          ) : (
            <>
              <div class="chat-quick">{emoteButtons}</div>
              <div class="chat-quick">{phraseButtons}</div>
            </>
          )}
          <form class="chat-form" onSubmit={submit}>
            <input ref={input} type="text" enterKeyHint="send" autocomplete="off" placeholder="Type a message" value={draft} onInput={(e) => {
                const box = e.target as HTMLInputElement;
                const cut = Array.from(box.value).slice(0, CHAT_MAX).join('');
                if (cut !== box.value) box.value = cut;
                setDraft(cut);
              }} aria-label="Message" />
            <button type="submit" class="chat-send" disabled={!cleanChat(draft) || slow}>
              Send
            </button>
            {mini && peekButton}
            {mini && muteButton}
            {mini && (
              <button type="button" class="chat-x" aria-label="Close chat" onClick={() => setOpen(false)}>
                ×
              </button>
            )}
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
