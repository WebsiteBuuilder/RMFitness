// Global chat on screen: the Chat page (the room everyone sees, private messages, who is online)
// and the notice a private message brings up on any screen, a duel included, with a reply box
// right in it so the duel never has to be left.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { online, type ChatView } from './controller';
import { GC_MAX, type Convo, type GcNote, type GcPerson, type SendResult } from './globalChat';
import { showCode } from './protocol';
import * as sfx from '../ui/duelSfx';
import './gchat.css';

const DOING: Record<GcPerson['doing'], string> = { menu: 'Online', room: 'In a duel room', duel: 'In a duel' };

function Av({ name, color, size = 'm' }: { name: string; color: string; size?: 'm' | 's' }) {
  return (
    <span class={`gc-av ${size}`} style={{ background: color }} aria-hidden="true">
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

function when(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

const SAID: Record<Exclude<SendResult, 'sent'>, string> = {
  slow: 'Slow down… a few seconds.',
  empty: '',
  offline: "Can't reach the online service right now.",
};

/** A private message as a phone notification while the game is in the background (if the player allowed them). */
function phoneNote(n: GcNote) {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const body = n.text;
  const opts = { body, tag: `gc-${n.from}`, icon: `${import.meta.env.BASE_URL ?? '/'}icons/icon-192.png` };
  void (async () => {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) return await reg.showNotification(`💬 ${n.name}`, opts);
    } catch {
      /* falls through */
    }
    try {
      new Notification(`💬 ${n.name}`, opts);
    } catch {
      /* not allowed here */
    }
  })();
}

online.onChatNote = (n) => {
  sfx.chatPing();
  try {
    navigator.vibrate?.([30, 40, 30]);
  } catch {
    /* none */
  }
  phoneNote(n);
};

/** How long a notice stays up when nobody touches it. */
const NOTE_MS = 7000;

/** Private messages just in: a card at the top of any screen. Tap to read it all; Reply answers right there. */
export function ChatNotes() {
  const o = online;
  const n = o.chatNotes[o.chatNotes.length - 1];
  if (!n || o.chatView) return null;
  return <Note key={n.id} n={n} more={o.chatNotes.length - 1} />;
}

function Note({ n, more }: { n: GcNote; more: number }) {
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const [said, setSaid] = useState('');
  const [sent, setSent] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // (left alone it goes after a few seconds; typing a reply keeps it up)
  useEffect(() => {
    if (replying) return;
    const t = setTimeout(() => online.dismissNote(n.from), sent ? 1200 : NOTE_MS);
    return () => clearTimeout(t);
  }, [replying, sent, n.id]);
  useEffect(() => void (replying && input.current?.focus()), [replying]);
  const send = () => {
    const r = online.gchat?.sendDm({ code: n.from, name: n.name, color: n.color }, draft) ?? 'offline';
    if (r === 'sent') {
      setDraft('');
      setReplying(false);
      setSent(true);
    } else setSaid(SAID[r]);
  };
  return (
    <div class={`gc-note ${replying ? 'replying' : ''}`} role="alert">
      <button class="gc-note-main" onClick={() => online.openChat({ tab: 'dm', code: n.from, name: n.name, color: n.color })}>
        <Av name={n.name} color={n.color} />
        <span class="gc-note-txt">
          <b>
            {n.name}
            {more > 0 && <em> +{more} more</em>}
          </b>
          <span>{sent ? 'Reply sent ✓' : n.text}</span>
        </span>
      </button>
      {!replying && !sent && (
        <div class="gc-note-btns">
          <button class="gc-btn go" onClick={() => setReplying(true)}>
            Reply
          </button>
          <button class="gc-x" aria-label="Close" onClick={() => online.dismissNote(n.from)}>
            ✕
          </button>
        </div>
      )}
      {replying && (
        <form class="gc-form" onSubmit={(e) => (e.preventDefault(), send())}>
          <input ref={input} value={draft} maxLength={GC_MAX} placeholder={`Reply to ${n.name}`} enterKeyHint="send" onInput={(e) => (setSaid(''), setDraft((e.target as HTMLInputElement).value))} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setReplying(false))} />
          <button class="gc-btn go" type="submit" disabled={!draft.trim()}>
            Send
          </button>
          <button class="gc-x" type="button" aria-label="Cancel" onClick={() => setReplying(false)}>
            ✕
          </button>
        </form>
      )}
      {said && <div class="gc-said">{said}</div>}
      {!replying && !sent && <div class="gc-note-timer" style={{ animationDuration: `${NOTE_MS}ms` }} />}
    </div>
  );
}

/** The Chat button's count: private messages first (they're to you), then the room. */
export function chatBadge(): { n: number; dm: boolean } {
  const u = online.chatUnread();
  return u.dms ? { n: u.dms, dm: true } : { n: u.all, dm: false };
}

/** The Chat page. */
export function ChatPage({ view }: { view: ChatView }) {
  const o = online;
  const gc = o.gchat;
  const close = () => o.openChat(null);
  const back = () => (view.tab === 'dm' ? o.openChat({ tab: 'dms' }) : close());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), back());
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view]);
  const u = o.chatUnread();
  const people = gc?.people ?? [];
  const state = gc?.state ?? 'off';
  const tab = view.tab === 'dm' ? 'dms' : view.tab;
  return (
    <div class="fr gc" role="dialog" aria-label="Chat">
      <header class="fr-top">
        <button class="fr-back" onClick={back} aria-label={view.tab === 'dm' ? 'Back to messages' : 'Close'}>
          ‹
        </button>
        {view.tab === 'dm' ? (
          <DmHead v={view} />
        ) : (
          <>
            <h1>Chat</h1>
            <span class={`fr-state ${state === 'on' ? 'ready' : state === 'connecting' ? 'connecting' : 'offline'}`}>
              <i />
              {state === 'on' ? `${people.length + 1} online` : state === 'connecting' ? 'Connecting…' : 'Offline'}
            </span>
          </>
        )}
      </header>
      {!gc && <div class="fr-warn">Chat needs the online service. Check your Wi-Fi or data; it keeps trying.</div>}
      {view.tab !== 'dm' && (
        <nav class="fr-tabs">
          <button class={tab === 'all' ? 'on' : ''} onClick={() => o.openChat({ tab: 'all' })}>
            Everyone{u.all > 0 && <em class="req">{u.all > 9 ? '9+' : u.all}</em>}
          </button>
          <button class={tab === 'dms' ? 'on' : ''} onClick={() => o.openChat({ tab: 'dms' })}>
            Messages{u.dms > 0 && <em class="req">{u.dms}</em>}
          </button>
          <button class={tab === 'people' ? 'on' : ''} onClick={() => o.openChat({ tab: 'people' })}>
            Online{people.length > 0 && <em class="live">{people.length}</em>}
          </button>
        </nav>
      )}
      {gc && view.tab === 'all' && <Room />}
      {gc && view.tab === 'dms' && <Convos />}
      {gc && view.tab === 'people' && <People />}
      {gc && view.tab === 'dm' && <Dm v={view} />}
    </div>
  );
}

function DmHead({ v }: { v: Extract<ChatView, { tab: 'dm' }> }) {
  const gc = online.gchat;
  const on = gc?.people.find((p) => p.code === v.code);
  const [menu, setMenu] = useState(false);
  return (
    <>
      <Av name={v.name} color={v.color} />
      <span class="gc-dm-who">
        <b>{v.name}</b>
        <small class={on ? 'on' : ''}>{on ? DOING[on.doing] : 'Offline · sees it next time they play'}</small>
      </span>
      <button class="fr-more" onClick={() => setMenu(!menu)} aria-label={`More for ${v.name}`}>
        ⋯
      </button>
      {menu && (
        <div class="fr-menu gc-menu">
          <span>Code {showCode(v.code)}</span>
          <button
            class="fr-btn bad"
            onClick={() => {
              gc?.block(v.code, true);
              online.openChat({ tab: 'dms' });
            }}
          >
            Block {v.name}
          </button>
        </div>
      )}
    </>
  );
}

/** Scrolls a list to its newest line as lines come in (unless the player scrolled up to read). */
function useStick(len: number) {
  const ref = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [len]);
  const onScroll = () => {
    const el = ref.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return { ref, onScroll };
}

function Composer({ placeholder, onSend }: { placeholder: string; onSend: (t: string) => SendResult }) {
  const [draft, setDraft] = useState('');
  const [said, setSaid] = useState('');
  const send = () => {
    const r = onSend(draft);
    if (r === 'sent') setDraft('');
    else setSaid(SAID[r]);
  };
  return (
    <div class="gc-compose">
      {said && <div class="gc-said">{said}</div>}
      <form class="gc-form" onSubmit={(e) => (e.preventDefault(), send())}>
        <input value={draft} maxLength={GC_MAX} placeholder={placeholder} enterKeyHint="send" onInput={(e) => (setSaid(''), setDraft((e.target as HTMLInputElement).value))} />
        <button class="gc-btn go" type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

/** The room everyone online sees. */
function Room() {
  const gc = online.gchat!;
  const lines = gc.all;
  const me = gc.me.code;
  const stick = useStick(lines.length);
  const [menu, setMenu] = useState<string | null>(null);
  // (on screen: everything in it is read)
  useEffect(() => gc.readAll(), [lines.length]);
  return (
    <>
      <div class="gc-list" ref={stick.ref} onScroll={stick.onScroll}>
        {!lines.length && (
          <div class="fr-empty">
            <div class="fr-empty-ic">💬</div>
            <b>Say hi to everyone</b>
            <p>Everyone with the game open sees this room. Tap a name to message them on their own.</p>
          </div>
        )}
        {lines.map((l) => {
          const mine = l.from === me;
          return (
            <div key={l.id} class={`gc-line ${mine ? 'mine' : ''}`}>
              {!mine && (
                <button class="gc-line-av" onClick={() => setMenu(menu === l.id ? null : l.id)} aria-label={`${l.name}: message or block`}>
                  <Av name={l.name} color={l.color} size="s" />
                </button>
              )}
              <div class="gc-say">
                {!mine && (
                  <button class="gc-name" style={{ color: l.color }} onClick={() => setMenu(menu === l.id ? null : l.id)}>
                    {l.name}
                  </button>
                )}
                <span>{l.text}</span>
                <time>{when(l.at)}</time>
                {menu === l.id && (
                  <div class="gc-line-menu">
                    <button class="fr-btn go" onClick={() => online.openChat({ tab: 'dm', code: l.from, name: l.name, color: l.color })}>
                      Message {l.name}
                    </button>
                    <button class="fr-btn bad" onClick={() => (gc.block(l.from, true), setMenu(null))}>
                      Block
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <Composer placeholder="Message everyone online" onSend={(t) => gc.sendAll(t)} />
    </>
  );
}

function Convos() {
  const gc = online.gchat!;
  const list = gc.data.convos;
  const [perm, setPerm] = useState(() => (typeof Notification === 'undefined' ? 'none' : Notification.permission));
  const ask = async () => {
    try {
      setPerm(await Notification.requestPermission());
    } catch {
      setPerm('denied');
    }
  };
  return (
    <div class="gc-list">
      {perm === 'default' && (
        <div class="fr-hint">
          <span>🔔 Get a phone notification when someone messages you while the game is in the background.</span>
          <button class="fr-btn gold" onClick={ask}>
            Turn on
          </button>
        </div>
      )}
      {!list.length && (
        <div class="fr-empty">
          <div class="fr-empty-ic">✉️</div>
          <b>No messages yet</b>
          <p>Pick anyone on the Online tab to send them a message. They get it even in the middle of a duel.</p>
          <button class="fr-btn gold" onClick={() => online.openChat({ tab: 'people' })}>
            See who's online
          </button>
        </div>
      )}
      {list.map((c: Convo) => {
        const last = c.lines[c.lines.length - 1];
        const on = gc.isOnline(c.code);
        return (
          <button key={c.code} class={`fr-row gc-convo ${on ? 'online' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => online.openChat({ tab: 'dm', code: c.code, name: c.name, color: c.color })}>
            <span class="fr-av">
              <Av name={c.name} color={c.color} />
              <i class="fr-dot" />
            </span>
            <span class="fr-who">
              <b>{c.name}</b>
              <small>{last ? `${last.mine ? 'You: ' : ''}${last.text}` : ''}</small>
            </span>
            <span class="gc-convo-end">
              {last && <time>{when(last.at)}</time>}
              {c.unread > 0 && <em>{c.unread}</em>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function People() {
  const gc = online.gchat!;
  const friends = new Set(online.presence?.data.friends.filter((f) => f.status === 'friend').map((f) => f.code) ?? []);
  const list = [...gc.people].sort((a, b) => Number(friends.has(b.code)) - Number(friends.has(a.code)));
  return (
    <div class="gc-list">
      {!list.length && (
        <div class="fr-empty">
          <div class="fr-empty-ic">🌙</div>
          <b>Nobody else is online</b>
          <p>Anyone who opens the game shows up here. You can still say something in Everyone: they see it when they come on.</p>
        </div>
      )}
      {list.map((p) => (
        <div key={p.code} class={`fr-row online ${p.doing !== 'menu' ? 'busy' : ''}`}>
          <span class="fr-av">
            <Av name={p.name} color={p.color} />
            <i class="fr-dot" />
          </span>
          <span class="fr-who">
            <b>{p.name}</b>
            <small>
              {friends.has(p.code) ? 'Friend · ' : ''}
              {DOING[p.doing]}
            </small>
          </span>
          <button class="fr-btn go" onClick={() => online.openChat({ tab: 'dm', code: p.code, name: p.name, color: p.color })}>
            Message
          </button>
        </div>
      ))}
    </div>
  );
}

function Dm({ v }: { v: Extract<ChatView, { tab: 'dm' }> }) {
  const gc = online.gchat!;
  const c = gc.data.convos.find((x) => x.code === v.code);
  const lines = c?.lines ?? [];
  const stick = useStick(lines.length);
  useEffect(() => gc.read(v.code), [lines.length, v.code]);
  return (
    <>
      <div class="gc-list gc-dm" ref={stick.ref} onScroll={stick.onScroll}>
        {!lines.length && (
          <div class="fr-empty">
            <div class="fr-empty-ic">👋</div>
            <b>Say hi to {v.name}</b>
            <p>They get a notice on their screen, even mid-duel.</p>
          </div>
        )}
        {lines.map((l) => (
          <div key={l.id} class={`gc-line ${l.mine ? 'mine' : ''}`}>
            <div class="gc-say">
              <span>{l.text}</span>
              <time>{when(l.at)}</time>
            </div>
          </div>
        ))}
      </div>
      <Composer placeholder={`Message ${v.name}`} onSend={(t) => gc.sendDm(v, t)} />
    </>
  );
}

/** The floating Chat button on menus (beside Friends), with the unread count. */
export function ChatPill() {
  const b = chatBadge();
  return (
    <button class={`ol-pill gc-pill ${b.dm ? 'dm' : ''}`} onClick={() => online.openChat(b.dm ? { tab: 'dms' } : { tab: 'all' })} aria-label={b.n ? `Chat, ${b.n} new` : 'Chat'}>
      <span class="ol-pill-ic">💬</span>
      <span>Chat</span>
      {b.n > 0 && <span class="ol-badge">{b.n > 9 ? '9+' : b.n}</span>}
    </button>
  );
}
