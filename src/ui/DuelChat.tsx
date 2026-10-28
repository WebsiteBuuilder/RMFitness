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
import { bubbleMs, canSend, EMOTES, HOLD_MS, isEmote, MINE_MS, PENDING_MS, phrasesFor, quickEmotes, SPAM_MS } from './chatRules';
import './chat.css';

/** a light tap on the phone (Android; iPhone browsers have none) as a line goes out or comes in */
const buzz = () => {
  try {
    navigator.vibrate?.(12);
  } catch {
    /* none */
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
  mine = false,
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
  /** your turn in the duel: the chat opens over the top (your hand stays free); on theirs it rises over your hand (their field stays in view) */
  mine?: boolean;
}) {
  const [open, setOpenState] = useState(session.chatOpen);
  const [ring, setRing] = useState(false);
  const [draft, setDraftState] = useState(session.chatDraft);
  // (kept on the room, so the chat picks up where it was when the duel turns into the result screen)
  const setOpen = (o: boolean) => ((session.chatOpen = o), setOpenState(o));
  const setDraft = (d: string) => ((session.chatDraft = d), setDraftState(d));
  const timers = useRef(new Set<number>());
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);
  // (mute: for this room only, so the next opponent isn't hidden)
  const [muted, setMutedState] = useState(session.chatMuted);
  const setMuted = (m: boolean) => setMutedState((session.chatMuted = m));
  /** your lines on their way (the other phone's host puts them in the room); one not back in a few seconds can be sent again */
  const [, setTick] = useState(0);
  const [bubbles, setBubbles] = useState<ChatLine[]>([]);
  const [slow, setSlow] = useState(false);
  const [hint, setHint] = useState('');
  const hintTimer = useRef<number>();
  useEffect(() => () => clearTimeout(hintTimer.current), []);
  const showHint = (h: string) => {
    setHint(h);
    clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(''), 1800);
  };
  const slowTimer = useRef<number>();
  useEffect(() => () => clearTimeout(slowTimer.current), []);
  const [unread, setUnreadState] = useState(session.chatUnread);
  const setUnread = (f: (n: number) => number) => setUnreadState((session.chatUnread = f(session.chatUnread)));
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opp: Pid = mySeat === 0 ? 1 : 0;
  const shown = muted ? chat.filter((l) => l.player === mySeat) : chat;
  const pendingCount = session.chatPending.length;
  const failed = session.chatPending.some((p) => Date.now() - p.at >= PENDING_MS);
  const lastLine = shown[shown.length - 1];

  // New lines: a bubble over the board (unless the chat is open), a blip and the unread count for the other's.
  useEffect(() => {
    if (!session.chatSeen) {
      session.chatSeen = new Set(chat.map((l) => l.id));
      return;
    }
    const had = new Set(session.chatSeen);
    for (const l of chat) session.chatSeen.add(l.id);
    // (your own lines back from the room: no longer on their way)
    const waiting = session.chatPending.length;
    for (const l of chat) {
      if (had.has(l.id) || l.player !== mySeat) continue;
      const i = session.chatPending.findIndex((p) => (l.cid ? p.id === l.cid : p.text === l.text));
      if (i >= 0) session.chatPending = session.chatPending.filter((_, j) => j !== i);
    }
    if (session.chatPending.length !== waiting) setTick((n) => n + 1);
    // (news: a line said now; the log loading after a rejoin or reload brings history: no ping, no bubble, no count)
    const fresh = chat.filter((l) => !had.has(l.id) && !l.old);
    if (fresh.length) announce(fresh);
  }, [chat.length, chat[chat.length - 1]?.id]);

  const mutedNow = useRef(muted);
  mutedNow.current = muted;
  const announce = (fresh: ChatLine[]) => {
    const muted = mutedNow.current;
    const theirs = fresh.filter((l) => l.player === opp && !muted);
    if (theirs.length) (sfx.chatPing(), buzz());
    // (the open chat shows the line itself: the small one in its one-line strip)
    if (session.chatOpen) return;
    // (unread until the chat is opened: the bubble goes away, the count stays)
    if (theirs.length) setUnread((n) => n + theirs.length);
    // (one line at a time: a newer one replaces the one showing; your own pill shows as you send)
    const last = theirs[theirs.length - 1];
    if (last) pop(last, bubbleMs(last.text));
  };
  const pop = (l: ChatLine, ms: number) => {
    setBubbles((b) => [...b.filter((x) => (x.player === mySeat) !== (l.player === mySeat)), l]);
    const t = window.setTimeout(() => {
      timers.current.delete(t);
      setBubbles((b) => b.filter((x) => x.id !== l.id));
    }, ms);
    timers.current.add(t);
  };

  // (opening the chat reads what was said; a line arriving while it's open shows in it, or as a bubble over the small one)
  useEffect(() => {
    if (!open) {
      // (closing the chat lets go of lines that didn't get through: the "!" goes)
      const left = session.chatPending.filter((p) => Date.now() - p.at < PENDING_MS);
      if (left.length !== session.chatPending.length) (session.chatPending = left), setTick((n) => n + 1);
      return;
    }
    setUnread(() => 0);
    setBubbles([]);
  }, [open]);
  useEffect(() => {
    const el = list.current;
    if (open && el) el.scrollTop = el.scrollHeight;
  }, [open, shown.length, pendingCount]);

  // The duel needs you (your prompt, an attack, a new phase or turn): the chat closes; what you typed stays.
  // (from '': coming up already open on a screen that needs you, e.g. the toss after a rematch, it closes too)
  const lastAttention = useRef('');
  useEffect(() => {
    // (the other player's turn starting or going on leaves it open: that's the time to talk)
    // (nor does the duel ending: the chat carries on over the result)
    if (attention !== lastAttention.current && attention !== 'theirs:' && attention !== '' && open) setOpen(false);
    lastAttention.current = attention;
  }, [attention]);

  // A short screen (iPhone SE): emotes and phrases share one row, so the history keeps room.
  const [short, setShort] = useState(() => typeof window !== 'undefined' && window.innerHeight < 700);
  // (the phone turned or the window resized: the duel's chat measures its room again)
  const [turned, setTurned] = useState(0);
  useEffect(() => {
    const on = () => {
      // (a phone keyboard opening shrinks the window on some Androids: typing, nothing is measured again)
      if (document.activeElement === input.current) return;
      setShort(window.innerHeight < 700);
      setTurned((n) => n + 1);
    };
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  // In the duel the open chat never reaches the turn and phase controls (End Turn stays in reach). On
  // their turn it rises over your hand, so their whole field stays in view; on yours it drops over the
  // top, so your hand and your side stay free to play. Where that leaves little room it shrinks to one
  // row of buttons and the box.
  // (Classic on a short phone, your turn: too little room over the top, so it goes over the help box under your hand)
  const [under, setUnder] = useState(false);
  const up = place === 'duel' && mine && !under;
  const sheet = useRef<HTMLDivElement>(null);
  const fab = useRef<HTMLButtonElement>(null);
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!open || place !== 'duel') return (setRoom(null), setUnder(false));
    // (Touch: the turn row and the round phase button beside it; Classic: the centre strip)
    const boxes = [...document.querySelectorAll('.duel.touch .tmid, .duel.touch .tphase, .duel .field .center')].map((el) => el.getBoundingClientRect()).filter((b) => b.bottom > 0);
    const f = fab.current?.getBoundingClientRect();
    if (!boxes.length || !f) return setRoom(null);
    // (where it rests: over the top it starts just above the button's top, from the bottom 8px up)
    const fromTop = Math.min(...boxes.map((b) => b.top)) - (f.top - 4) - 6;
    const fromBottom = window.innerHeight - 8 - Math.max(...boxes.map((b) => b.bottom)) - 6;
    if (!mine) return (setUnder(false), setRoom(Math.floor(fromBottom)));
    const hand = document.querySelector('.duel:not(.touch) .hand')?.getBoundingClientRect();
    const underHand = hand ? window.innerHeight - 8 - hand.bottom - 6 : -1;
    const low = fromTop < 160 && underHand > fromTop;
    setUnder(low);
    setRoom(Math.floor(low ? underHand : fromTop));
  }, [open, place, short, turned, mine]);
  // (your turn: always the small one, so as little of the board as can be is covered)
  const mini = (room !== null && room < 230) || up;
  /** holding the eye button: the chat fades away so the field shows through */
  const [peek, setPeek] = useState(false);
  // (the chat closing under a held eye: no pointer-up ever comes)
  useEffect(() => void (!open && setPeek(false)), [open]);

  // A tap on the board outside the chat closes it, and the tap still does what it does (play a card).
  const ringBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open && !ring) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (fab.current?.contains(t) || sheet.current?.contains(t) || ringBox.current?.contains(t)) return;
      setOpen(false);
      setRing(false);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [open, ring]);

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

  const say = (raw: string, again?: string): boolean => {
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
    // (a line sent again keeps its tag: if the first copy turns up after all, the room shows it once)
    const id = again ?? Math.random().toString(36).slice(2, 10);
    session.chatPending = [...session.chatPending.filter((p) => p.id !== id), { id, text, at: now }];
    session.send({ type: 'CHAT', player: mySeat, text, cid: id });
    buzz();
    if (!session.chatOpen) pop({ id, player: mySeat, text, at: now, old: false }, MINE_MS);
    const t = window.setTimeout(() => (timers.current.delete(t), setTick((n) => n + 1)), PENDING_MS + 50);
    timers.current.add(t);
    return true;
  };

  const quick = (text: string) => {
    if (say(text)) (setOpen(false), setRing(false));
  };

  // Hold the chat button: emotes and the phrases for the moment pop up beside it. Slide onto one and let
  // go to send it, or let go on the button and tap one; no chat to open.
  const holdTimer = useRef<number>();
  const held = useRef(false);
  const heldUpAt = useRef(0);
  const [aim, setAim] = useState<string | null>(null);
  /** the button filling up while it's held (the cue on an iPhone, which can't buzz) */
  const [holding, setHolding] = useState(false);
  /** each hold that brings the row up (a second hold while it shows follows the slide again) */
  const [holds, setHolds] = useState(0);
  useEffect(() => () => clearTimeout(holdTimer.current), []);
  const holdStart = (e: PointerEvent) => {
    held.current = false;
    clearTimeout(holdTimer.current);
    // (the chat is open: its own buttons are right there)
    if (open) return;
    // (a touch stays with the button it started on: let it go, so the slide can be followed over the row)
    try {
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      /* not captured */
    }
    setHolding(true);
    holdTimer.current = window.setTimeout(() => {
      held.current = true;
      setHolding(false);
      setRing(true);
      setHolds((n) => n + 1);
      buzz();
    }, HOLD_MS);
  };
  const holdEnd = () => (clearTimeout(holdTimer.current), setHolding(false));
  const itemAt = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('.chat-ring [data-say]') ?? null;
  useEffect(() => {
    if (!ring || !held.current) return;
    const move = (e: PointerEvent) => setAim(itemAt(e.clientX, e.clientY)?.dataset.say ?? null);
    const up = (e: PointerEvent) => {
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      setAim(null);
      // (the hold is over: a click that may follow this release is ignored, later taps are taps again;
      // after a long press some phones send no click at all)
      held.current = false;
      heldUpAt.current = Date.now();
      const it = itemAt(e.clientX, e.clientY);
      if (it?.dataset.say) {
        held.current = false;
        quick(it.dataset.say);
      }
    };
    // (the phone took the touch away, e.g. a call: nothing sent, the row stays for a tap)
    const cancel = () => {
      held.current = false;
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      setAim(null);
    };
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', cancel, true);
    return () => (document.removeEventListener('pointermove', move, true), document.removeEventListener('pointerup', up, true), document.removeEventListener('pointercancel', cancel, true));
  }, [ring, holds]);
  const fabTap = () => {
    if (held.current || Date.now() - heldUpAt.current < 400) return;
    if (ring) return setRing(false);
    setOpen(!open);
  };
  useEffect(() => void (attention && attention !== 'theirs:' && setRing(false)), [attention]);
  // (lines still on their way when this chat came up, e.g. on the result screen: check on them in time)
  useEffect(() => {
    for (const p of session.chatPending) {
      const t = window.setTimeout(() => (timers.current.delete(t), setTick((n) => n + 1)), Math.max(0, PENDING_MS - (Date.now() - p.at)) + 50);
      timers.current.add(t);
    }
  }, []);
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

  const toggleMute = () => setMuted(!muted);
  const retry = (id: string, text: string) => {
    say(text, id);
    setTick((n) => n + 1);
  };

  const theirName = names[opp] || 'your opponent';
  const moment = place === 'low' ? 'room' : place === 'top' ? 'after' : mine ? 'mine' : 'theirs';
  const phrases = phrasesFor(moment);
  // (one at a time: a newer line replaces the one showing)
  const theirBubbles = bubbles.filter((l) => l.player !== mySeat).slice(-1);
  const myBubble = bubbles.filter((l) => l.player === mySeat).slice(-1)[0];

  // (a phone keyboard: the chat sits just above it; in the duel otherwise it stops under the turn controls)
  const sheetStyle: Record<string, string> | undefined =
    place !== 'top'
      ? vv
        ? { top: 'auto', bottom: `${Math.max(0, window.innerHeight - vv.top - vv.h) + 8}px`, '--room': `${Math.max(120, vv.h - 16)}px` }
        : room !== null
          ? { '--room': `${Math.max(120, room)}px` }
          : undefined
      : vv
        ? { top: `${vv.top + 8}px`, maxHeight: `${Math.max(120, vv.h - 16)}px` }
        : undefined;
  const peekFrom = useRef(0);
  const peekOff = () => {
    // (a quick tap does nothing to see: say how it works)
    if (peek && Date.now() - peekFrom.current < 250) showHint('Hold the eye to see the field');
    setPeek(false);
  };
  const peekButton = (
    <button type="button" class="chat-peek" aria-label="Hold to see the field" onPointerDown={() => ((peekFrom.current = Date.now()), setPeek(true))} onPointerUp={peekOff} onPointerCancel={() => setPeek(false)} onPointerLeave={() => setPeek(false)} onContextMenu={(e) => e.preventDefault()}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path d="M12 5C6.5 5 2.7 9.2 1.5 12c1.2 2.8 5 7 10.5 7s9.3-4.2 10.5-7C21.3 9.2 17.5 5 12 5zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2.2a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z" fill="currentColor" />
      </svg>
    </button>
  );
  const muteButton = (
    <button type="button" class={`chat-mute ${muted ? 'on' : ''}`} onClick={toggleMute} aria-pressed={muted} aria-label={muted ? `${theirName}'s messages are hidden: tap to show them` : `Hide ${theirName}'s messages`}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z" fill="currentColor" opacity={muted ? 1 : 0.55} />
        {/* (Hide: the bubble crossed out; Show: the bubble whole) */}
        {!muted && <path d="M3 3l18 18" stroke="#f7c948" stroke-width="2.4" stroke-linecap="round" />}
      </svg>
      <span>{muted ? 'Show' : 'Hide'}</span>
    </button>
  );

  const emoteButtons = [...quickEmotes(moment), ...EMOTES.filter((e) => !quickEmotes(moment).includes(e))].map((t) => (
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
      {theirBubbles.length > 0 && !open && (
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
      {myBubble && !open && !ring && (
        <div key={myBubble.id} class={`chat-sent at-${place} ${isEmote(myBubble.text) ? 'emote' : ''}`} role="status">
          <b>You:</b>
          <span>{myBubble.text}</span>
        </div>
      )}
      {ring && !open && (
        <>
          <div ref={ringBox} class={`chat-ring at-${place}`} role="menu" aria-label="Quick chat">
            <div class="chat-ring-emotes">
              {quickEmotes(moment).map((t) => (
                <button key={t} type="button" role="menuitem" data-say={t} class={`chat-emote ${aim === t ? 'aim' : ''}`} onClick={() => quick(t)} aria-label={`Send ${t}`}>
                  {t}
                </button>
              ))}
            </div>
            <div class="chat-ring-phrases">
              {phrases.slice(0, 2).map((t) => (
                <button key={t} type="button" role="menuitem" data-say={t} class={`chat-phrase ${aim === t ? 'aim' : ''}`} onClick={() => quick(t)}>
                  {t}
                </button>
              ))}
            </div>
            {slow && (
              <p class="chat-slow" role="status">
                Slow down… a few seconds.
              </p>
            )}
          </div>
        </>
      )}
      <button ref={fab} class={`chat-fab at-${place} ${open || ring ? 'on' : ''} ${holding ? 'holding' : ''}`} aria-label={unread ? `Chat, ${unread} new (hold for quick emotes)` : 'Chat (hold for quick emotes)'} aria-expanded={open} onClick={fabTap} onPointerDown={holdStart} onPointerUp={holdEnd} onPointerLeave={holdEnd} onPointerCancel={holdEnd} onContextMenu={(e) => e.preventDefault()}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z" fill="currentColor" />
        </svg>
        {failed ? <span class="chat-badge" aria-label="A message wasn't sent">!</span> : unread > 0 && <span class="chat-badge">{unread > 9 ? '9+' : unread}</span>}
        {muted && (
          <span class="chat-muted-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="12" height="12">
              <path d="M3 3l18 18M21 3L3 21" stroke="#ffd2d2" stroke-width="3.5" stroke-linecap="round" />
            </svg>
          </span>
        )}
      </button>
      {/* the chat: in the duel it rises over your hand (the field and the turn controls stay in view and
          keep working), in the room it sits over the bottom, over the result screen at the top */}
      {open && (
        <div ref={sheet} class={`chat-sheet at-${place} ${up ? 'up' : ''} ${mini ? 'mini' : ''} ${peek ? 'peek' : ''}`} role="dialog" aria-label={`Chat with ${theirName}`} style={sheetStyle}>
          <div class="chat-head">
            <span class={`chat-title ${hint ? 'hint' : ''}`}>{hint || `Chat with ${theirName}`}</span>
            {place === 'duel' && peekButton}
            {muteButton}
            <button class="chat-x" aria-label="Close chat" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <div class="chat-list" ref={list}>
            {shown.length === 0 && <p class="chat-empty">{muted ? `${names[opp] ? `${names[opp]}'s` : "Your opponent's"} messages are hidden. Tap Show to see them again.` : 'Say hi! Tap a phrase or type a message. Tip: hold the chat button for quick emotes.'}</p>}
            {shown.map((l, i) => (
              <div key={l.id} class={`chat-line ${l.player === mySeat ? 'mine' : 'theirs'} ${isEmote(l.text) ? 'emote' : ''}`}>
                {/* (the name once per run of lines from the other player) */}
                {l.player !== mySeat && shown[i - 1]?.player !== l.player && <b>{names[l.player] || 'Opponent'}</b>}
                <span>{l.text}</span>
              </div>
            ))}
            {session.chatPending.map((p) =>
              Date.now() - p.at < PENDING_MS ? (
                <div key={p.id} class={`chat-line mine pending ${isEmote(p.text) ? 'emote' : ''}`}>
                  <span>{p.text}</span>
                </div>
              ) : (
                <button key={p.id} type="button" class="chat-line mine failed" onClick={() => retry(p.id, p.text)}>
                  <span>{p.text}</span>
                  <small>Not sent · tap to try again</small>
                </button>
              ),
            )}
          </div>
          {/* (the small chat has no list: the latest line shows here) */}
          {/* (the small chat has no list: the latest line shows in its top line, by Hide and close) */}
          {mini && (
            <div class="chat-last-row">
              <p class="chat-last">{lastLine ? <><b>{lastLine.player === mySeat ? 'You' : names[lastLine.player] || 'Opponent'}:</b> {lastLine.text}</> : <span class="chat-last-none">Chat with {theirName}</span>}</p>
              {muteButton}
              <button type="button" class="chat-x" aria-label="Close chat" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
          )}
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
                // (a word still being put together on a Japanese or Chinese keyboard: left alone until it's done)
                if ((e as InputEvent).isComposing) return setDraft(box.value);
                const cut = Array.from(box.value).slice(0, CHAT_MAX).join('');
                if (cut !== box.value) box.value = cut;
                setDraft(cut);
              }} aria-label="Message" />
            <button type="submit" class="chat-send" disabled={!cleanChat(draft) || slow}>
              Send
            </button>
            {mini && peekButton}
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
