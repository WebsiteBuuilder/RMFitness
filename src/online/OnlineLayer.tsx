// Friends on screen: the Friends button, the friends panel, duel invites and short notices.
import { useEffect, useState } from 'preact/hooks';
import type { GameMode } from '../eds/types';
import { Overlay, Win } from '../ui/Window';
import { online } from './controller';
import { INVITE_MS, type FriendView, type IncomingInvite } from './presence';
import { parseFriendCode, showCode, type Activity } from './protocol';
import './online.css';

const GAME: Record<GameMode, string> = { speed: 'Speed Duel', eds: 'Eternal Duelist Soul' };
const GAME_KEY = 'eds.online.game';

function useOnline() {
  const [, bump] = useState(0);
  useEffect(() => online.subscribe(() => bump((n) => n + 1)), []);
  // a slow clock for "last seen" and invite countdowns
  useEffect(() => {
    const t = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return online;
}

function ago(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function doing(a: Activity | null): string {
  if (!a || a.kind === 'menu') return 'Online';
  if (a.kind === 'room') return a.open ? `In room ${a.room} · ${GAME[a.game]}` : `Starting a ${GAME[a.game]}`;
  return a.game ? `In a ${GAME[a.game]}` : 'In a duel';
}

function Dot({ f }: { f: FriendView }) {
  const busy = f.online && f.activity && f.activity.kind !== 'menu' && !(f.activity.kind === 'room' && f.activity.open);
  return <span class={`ol-dot ${f.online ? (busy ? 'busy' : 'on') : ''}`} aria-label={f.online ? 'online' : 'offline'} />;
}

function Bubble({ name, color }: { name: string; color: string }) {
  return (
    <span class="ol-bubble" style={{ background: color }}>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** Everything friends-related that floats over the app. */
export function OnlineLayer() {
  const o = useOnline();
  const button = o.button;
  const pr = o.presence;
  if (!pr) return null;
  const invite = pr.incoming[0];
  const count = pr.onlineCount();
  const requests = pr.data.friends.filter((f) => f.status === 'request').length;
  const out = pr.outgoing?.state === 'waiting' ? pr.outgoing : null;
  return (
    <>
      {button && !o.panelOpen && (
        <button class={`ol-pill ${count > 0 ? 'live' : ''}`} onClick={() => o.openPanel()} aria-label="Friends">
          <span class="ol-pill-ic">👥</span>
          <span>Friends</span>
          {count > 0 && <span class="ol-pill-n">{count} online</span>}
          {requests > 0 && <span class="ol-badge">{requests}</span>}
        </button>
      )}
      {out && !o.panelOpen && (
        <div class="ol-toast ol-waiting">
          <span>
            Invited <b>{pr.data.friends.find((f) => f.code === out.to)?.name ?? 'your friend'}</b> to room {out.room}…
          </span>
          <button class="gbtn" onClick={() => pr.cancelInvite()}>
            Cancel
          </button>
        </div>
      )}
      {invite && <InviteCard inv={invite} />}
      {o.notice && !invite && (
        <div class="ol-toast" key={o.notice.id} role="status">
          {o.notice.text}
        </div>
      )}
      {o.panelOpen && <FriendsPanel />}
    </>
  );
}

function InviteCard({ inv }: { inv: IncomingInvite }) {
  const pr = online.presence!;
  const f = pr.data.friends.find((x) => x.code === inv.from);
  const left = Math.max(0, INVITE_MS - (Date.now() - inv.at));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    navigator.vibrate?.([80, 60, 80]);
  }, [inv.id]);
  return (
    <div class="ol-invite" role="alertdialog" aria-label="Duel invite">
      <div class="ol-invite-top">
        <Bubble name={inv.name} color={f?.color ?? '#888'} />
        <div>
          <b>{inv.name}</b> wants to duel!
          <div class="ol-sub">
            {GAME[inv.game]} · room {inv.room}
          </div>
        </div>
      </div>
      {err && <div class="warn">{err}</div>}
      <div class="ol-invite-btns">
        <button class="gbtn ol-go" onClick={() => setErr(online.joinRoom(inv.room, inv.game, inv.id))}>
          Duel!
        </button>
        <button class="gbtn" onClick={() => pr.answer(inv.id, false)}>
          Not now
        </button>
      </div>
      <div class="ol-timer" style={{ width: `${(left / INVITE_MS) * 100}%` }} />
    </div>
  );
}

function FriendsPanel() {
  const o = online;
  const pr = o.presence!;
  const [game, setGameState] = useState<GameMode>(() => {
    try {
      return localStorage.getItem(GAME_KEY) === 'eds' ? 'eds' : 'speed';
    } catch {
      return 'speed';
    }
  });
  const setGame = (g: GameMode) => {
    setGameState(g);
    try {
      localStorage.setItem(GAME_KEY, g);
    } catch {
      /* fine for this visit */
    }
  };
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const close = () => o.openPanel(false);
  const link = `${location.origin}${location.pathname}?friend=${pr.data.code}`;

  const share = async () => {
    try {
      if (navigator.share) return await navigator.share({ title: 'Add me as a friend', text: `Add me on Speed Duel! My friend code is ${showCode(pr.data.code)}`, url: link });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy your friend link:', link);
    }
  };

  const add = () => {
    const c = parseFriendCode(code);
    if (!c) return setMsg('A friend code is 6 letters and numbers, like K7Q-2MX.');
    const r = pr.add(c);
    setCode('');
    setMsg(r === 'self' ? "That's your own code." : r === 'already' ? 'Already on your list.' : r === 'accepted' ? 'Friend added!' : 'Added! They show up here as soon as their game is open.');
  };

  const state = pr.state;
  const stateText =
    state === 'ready' ? 'You are online' : state === 'connecting' ? 'Going online…' : state === 'elsewhere' ? 'This profile is open on another phone. Close it there to go online here.' : "Can't reach the online service. Check your connection.";
  const list = pr.friends();
  const requests = list.filter((f) => f.status === 'request');
  const friends = list.filter((f) => f.status !== 'request');
  const added = o.addedFromLink;

  return (
    <Overlay onClose={close}>
      <Win title="Friends" onClose={close} class="ol-panel">
        <div class={`ol-state ${state}`}>
          <span class="ol-dot on" /> {stateText}
        </div>
        {added && <div class="ol-note">Friend request sent to {showCode(added)}. They show up here once their game is open.</div>}

        <div class="ol-me">
          <div>
            <div class="ol-sub">Your friend code</div>
            <div class="ol-code">{showCode(pr.data.code)}</div>
          </div>
          <button class="gbtn" onClick={share}>
            {copied ? 'Link copied!' : 'Share link'}
          </button>
        </div>

        <div class="ol-add">
          <input
            class="code"
            value={code}
            maxLength={40}
            placeholder="FRIEND CODE"
            autocapitalize="characters"
            onInput={(e) => setCode((e.target as HTMLInputElement).value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button class="gbtn" disabled={!code.trim()} onClick={add}>
            Add
          </button>
        </div>
        {msg && <div class="ol-note">{msg}</div>}

        {requests.length > 0 && (
          <>
            <div class="ol-h">Friend requests</div>
            {requests.map((f) => (
              <div class="ol-row" key={f.code}>
                <Bubble name={f.name} color={f.color} />
                <div class="ol-who">
                  <b>{f.name}</b>
                  <div class="ol-sub">wants to be friends</div>
                </div>
                <button class="gbtn ol-go" onClick={() => pr.accept(f.code)}>
                  Accept
                </button>
                <button class="gbtn" onClick={() => pr.remove(f.code)}>
                  No
                </button>
              </div>
            ))}
          </>
        )}

        <div class="ol-h ol-h-game">
          <span>Friends</span>
          <span class="ol-seg">
            {(['speed', 'eds'] as GameMode[]).map((g) => (
              <button key={g} class={game === g ? 'on' : ''} onClick={() => setGame(g)}>
                {g === 'speed' ? 'Speed Duel' : 'EDS'}
              </button>
            ))}
          </span>
        </div>
        {friends.length === 0 && <div class="ol-empty">No friends yet. Share your link, or add their code above.</div>}
        {friends.map((f) => (
          <FriendRow key={f.code} f={f} game={game} onRemove={() => setConfirm(f.code)} onMsg={setMsg} />
        ))}
        {confirm && (
          <div class="ol-confirm">
            <span>Remove {friends.find((f) => f.code === confirm)?.name ?? 'this friend'}?</span>
            <button
              class="gbtn end"
              onClick={() => {
                pr.remove(confirm);
                setConfirm(null);
              }}
            >
              Remove
            </button>
            <button class="gbtn" onClick={() => setConfirm(null)}>
              Keep
            </button>
          </div>
        )}
      </Win>
    </Overlay>
  );
}

function FriendRow({ f, game, onRemove, onMsg }: { f: FriendView; game: GameMode; onRemove: () => void; onMsg: (m: string | null) => void }) {
  const a = f.activity;
  const openRoom = f.online && a?.kind === 'room' && a.open ? a : null;
  const busy = f.online && a && a.kind !== 'menu' && !openRoom;
  let sub: string;
  const reach = online.presence?.reach.get(f.code);
  if (reach === 'blocked' && !f.online) sub = "Their game is open, but the phones can't link yet. Retrying…";
  else if (f.status === 'sent') sub = f.online ? 'Connecting…' : 'Added · shows up when their game is open';
  else if (f.online) sub = doing(a);
  else sub = f.lastSeen ? `Offline · seen ${ago(Date.now() - f.lastSeen)}` : 'Offline · their game is closed';
  return (
    <div class={`ol-row ${f.online ? 'online' : ''}`}>
      <span class="ol-av">
        <Bubble name={f.name} color={f.color} />
        <Dot f={f} />
      </span>
      <div class="ol-who">
        <b>{f.name}</b>
        <div class="ol-sub">{sub}</div>
      </div>
      {f.status === 'friend' && openRoom && (
        <button class="gbtn ol-go" onClick={() => onMsg(online.joinRoom(openRoom.room, openRoom.game))}>
          Join
        </button>
      )}
      {f.status === 'friend' && f.online && !openRoom && (
        <button class="gbtn ol-go" disabled={!!busy} onClick={() => onMsg(online.inviteFriend(f.code, game))}>
          Duel
        </button>
      )}
      <button class="ol-x" onClick={onRemove} aria-label={`Remove ${f.name}`}>
        ⋯
      </button>
    </div>
  );
}
