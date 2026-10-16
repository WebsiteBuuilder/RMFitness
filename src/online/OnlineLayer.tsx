// Friends and matchmaking on screen: the Friends button, the Friends page, duel invites,
// the Find a Match search bar, the "Opponent found!" screen and short notices.
import { useEffect, useState } from 'preact/hooks';
import type { GameMode } from '../eds/types';
import { online, VERSUS_MS } from './controller';
import { INVITE_MS, type FriendView, type IncomingInvite, type RecentRec } from './presence';
import { parseFriendCode, showCode, type Activity } from './protocol';
import { duelistTitle, type BoardStats } from '../collection/rankings';
import type { Match } from './matchmaking';
import './online.css';
import './friends.css';

const GAME: Record<GameMode, string> = { speed: 'Speed Duel', eds: 'Eternal Duelist Soul' };
const GAME_KEY = 'eds.online.game';
const TAB_KEY = 'eds.online.tab';

type Tab = 'friends' | 'recent' | 'add';

function useOnline() {
  const [, bump] = useState(0);
  useEffect(() => online.subscribe(() => bump((n) => n + 1)), []);
  // a slow clock for "last seen", invite countdowns and the search timer
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

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function doing(a: Activity | null): string {
  if (!a || a.kind === 'menu') return 'Online · ready to duel';
  if (a.kind === 'room') return a.open ? `In an open ${GAME[a.game]} room` : `Starting a ${GAME[a.game]}`;
  return a.game ? `In a ${GAME[a.game]}` : 'In a duel';
}

/** "🎴 Expert Duelist · 12-4" from a shared record, or nothing yet. */
function rankLine(b: BoardStats | undefined): string | null {
  if (!b) return null;
  const t = duelistTitle(b);
  return `${t.icon} ${t.name} · ${b.w}-${b.l}${b.d ? `-${b.d}` : ''}`;
}

function Bubble({ name, color, size = 'm' }: { name: string; color: string; size?: 'm' | 'l' | 'xl' }) {
  return (
    <span class={`ol-bubble fr-b-${size}`} style={{ background: color }}>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** Everything friends- and matchmaking-related that floats over the app. */
export function OnlineLayer() {
  const o = useOnline();
  const pr = o.presence;
  if (o.versus) return <Versus m={o.versus} />;
  if (!pr) return null;
  const invite = pr.incoming[0];
  const count = pr.onlineCount();
  const requests = pr.data.friends.filter((f) => f.status === 'request').length;
  const out = pr.outgoing?.state === 'waiting' ? pr.outgoing : null;
  return (
    <>
      {o.button && !o.panelOpen && !o.mm.searching && (
        <button class={`ol-pill ${count > 0 ? 'live' : ''}`} onClick={() => o.openPanel()} aria-label="Friends">
          <span class="ol-pill-ic">👥</span>
          <span>Friends</span>
          {count > 0 && <span class="ol-pill-n">{count} online</span>}
          {requests > 0 && <span class="ol-badge">{requests}</span>}
        </button>
      )}
      {o.mm.searching && !o.panelOpen && <SearchBar />}
      {out && !o.panelOpen && (
        <div class="ol-toast ol-waiting">
          <span>
            Invited <b>{pr.data.friends.find((f) => f.code === out.to)?.name ?? 'your friend'}</b> to duel…
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
      {o.panelOpen && <FriendsPage />}
    </>
  );
}

// ---------- Find a Match ----------

/** The search, floating over the menus so the player can look at decks while waiting. */
function SearchBar() {
  const mm = online.mm;
  const off = mm.state === 'offline';
  return (
    <div class={`mm-bar ${off ? 'off' : ''}`} role="status">
      <span class="mm-radar" aria-hidden="true">
        <i />
      </span>
      <span class="mm-bar-txt">
        <b>{off ? "Can't reach the online service" : 'Finding an opponent…'}</b>
        <small>{off ? 'Retrying. Check your Wi-Fi or data.' : `${GAME[mm.game]} · ${clock(Date.now() - mm.since)}`}</small>
      </span>
      <button class="mm-cancel" onClick={() => online.cancelMatch()}>
        Cancel
      </button>
    </div>
  );
}

/** "Opponent found!": who you're up against, then straight into the room. */
function Versus({ m }: { m: Match }) {
  const pr = online.presence;
  const me = { name: pr?.me.name ?? 'You', color: pr?.me.color ?? '#3a62d0', board: pr?.me.board };
  const them = m.opponent;
  const friend = pr?.data.friends.find((f) => f.code === them.code && f.status === 'friend');
  return (
    <div class="mm-vs" role="alertdialog" aria-label="Opponent found">
      <div class="mm-vs-flash" />
      <div class="mm-vs-h">Opponent found!</div>
      <div class="mm-vs-row">
        <div class="mm-vs-side me">
          <Bubble name={me.name} color={me.color} size="xl" />
          <b>{me.name}</b>
          <small>{rankLine(me.board) ?? '🃏 Rookie Duelist'}</small>
        </div>
        <div class="mm-vs-x">VS</div>
        <div class="mm-vs-side them">
          <Bubble name={them.name} color={them.color} size="xl" />
          <b>{them.name}</b>
          <small>{rankLine(them.board) ?? '🃏 Rookie Duelist'}</small>
          {friend && <span class="mm-vs-tag">Your friend</span>}
        </div>
      </div>
      <div class="mm-vs-sub">{m.role === 'host' ? 'Opening the duel room…' : 'Joining their duel room…'}</div>
      <div class="mm-vs-bar">
        <i style={{ animationDuration: `${VERSUS_MS + (m.role === 'guest' ? 1200 : 0)}ms` }} />
      </div>
    </div>
  );
}

// ---------- invites ----------

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
            {GAME[inv.game]}
            {f?.board ? ` · ${rankLine(f.board)}` : ''}
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

// ---------- the Friends page ----------

function stored<T extends string>(key: string, ok: readonly T[], fallback: T): [T, (v: T) => void] {
  const [v, set] = useState<T>(() => {
    try {
      const x = localStorage.getItem(key) as T | null;
      return x && ok.includes(x) ? x : fallback;
    } catch {
      return fallback;
    }
  });
  return [
    v,
    (x: T) => {
      set(x);
      try {
        localStorage.setItem(key, x);
      } catch {
        /* fine for this visit */
      }
    },
  ];
}

function FriendsPage() {
  const o = online;
  const pr = o.presence!;
  const [game, setGame] = stored<GameMode>(GAME_KEY, ['speed', 'eds'], 'speed');
  const list = pr.friends();
  const requests = list.filter((f) => f.status === 'request');
  const [tab, setTab] = stored<Tab>(TAB_KEY, ['friends', 'recent', 'add'], 'friends');
  const [msg, setMsg] = useState<string | null>(null);
  const close = () => o.openPanel(false);
  // Android back closes the page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), close());
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const added = o.addedFromLink;
  const recent = pr.recent();
  const online_ = list.filter((f) => f.status === 'friend' && f.online);

  const state = pr.state;
  const stateText = state === 'ready' ? 'Online' : state === 'connecting' ? 'Going online…' : state === 'elsewhere' ? 'Open on another phone' : 'Offline';

  return (
    <div class="fr" role="dialog" aria-label="Friends">
      <header class="fr-top">
        <button class="fr-back" onClick={close} aria-label="Close">
          ‹
        </button>
        <h1>Friends</h1>
        <span class={`fr-state ${state}`}>
          <i />
          {stateText}
        </span>
      </header>
      {state === 'elsewhere' && <div class="fr-warn">This duelist is open on another phone or window. Close it there to go online here.</div>}
      {state === 'offline' && <div class="fr-warn">Can't reach the online service. Check your Wi-Fi or mobile data; it keeps trying.</div>}

      <MeCard />

      <nav class="fr-tabs">
        <button class={tab === 'friends' ? 'on' : ''} onClick={() => setTab('friends')}>
          Friends
          {online_.length > 0 && <em class="live">{online_.length}</em>}
          {requests.length > 0 && <em class="req">{requests.length}</em>}
        </button>
        <button class={tab === 'recent' ? 'on' : ''} onClick={() => setTab('recent')}>
          Recent{recent.length ? <em>{recent.length}</em> : null}
        </button>
        <button class={tab === 'add' ? 'on' : ''} onClick={() => setTab('add')}>
          Add friend
        </button>
      </nav>

      <div class="fr-body">
        {added && <div class="fr-note">Added {showCode(added)}. They show up here as soon as their game is open.</div>}
        {msg && (
          <div class="fr-note" onClick={() => setMsg(null)}>
            {msg}
          </div>
        )}
        {tab === 'friends' && <FriendsTab list={list} game={game} setGame={setGame} onMsg={setMsg} goAdd={() => setTab('add')} />}
        {tab === 'recent' && <RecentTab recent={recent} onMsg={setMsg} />}
        {tab === 'add' && <AddTab onAdded={(m) => (setMsg(m), setTab('friends'))} />}
      </div>
    </div>
  );
}

/** This player: name, title, friend code and the share button. */
function MeCard() {
  const pr = online.presence!;
  const [copied, setCopied] = useState(false);
  const link = `${location.origin}${location.pathname}?friend=${pr.data.code}`;
  const share = async () => {
    try {
      if (navigator.share) return await navigator.share({ title: 'Add me as a friend', text: `Duel me in Speed Duel! My friend code is ${showCode(pr.data.code)}`, url: link });
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
  return (
    <div class="fr-me">
      <Bubble name={pr.me.name} color={pr.me.color} size="l" />
      <div class="fr-me-txt">
        <b>{pr.me.name}</b>
        <small>{rankLine(pr.me.board) ?? '🃏 Rookie Duelist'}</small>
        <span class="fr-code">
          Code <b>{showCode(pr.data.code)}</b>
        </span>
      </div>
      <button class="fr-btn gold" onClick={share}>
        {copied ? 'Copied!' : 'Share'}
      </button>
    </div>
  );
}

function FriendsTab({ list, game, setGame, onMsg, goAdd }: { list: FriendView[]; game: GameMode; setGame: (g: GameMode) => void; onMsg: (m: string | null) => void; goAdd: () => void }) {
  const pr = online.presence!;
  const [menu, setMenu] = useState<string | null>(null);
  const requests = list.filter((f) => f.status === 'request');
  const on = list.filter((f) => f.status !== 'request' && f.online);
  const off = list.filter((f) => f.status !== 'request' && !f.online);
  const anyone = list.some((f) => f.status !== 'request');
  return (
    <>
      {requests.length > 0 && (
        <section>
          <h2>Friend requests</h2>
          {requests.map((f) => (
            <div class="fr-row" key={f.code}>
              <Bubble name={f.name} color={f.color} />
              <div class="fr-who">
                <b>{f.name}</b>
                <small>wants to be friends</small>
              </div>
              <button class="fr-btn go" onClick={() => pr.accept(f.code)}>
                Accept
              </button>
              <button class="fr-btn" onClick={() => pr.remove(f.code)}>
                No
              </button>
            </div>
          ))}
        </section>
      )}
      {!anyone && (
        <div class="fr-empty">
          <div class="fr-empty-ic">👥</div>
          <b>No friends yet</b>
          <p>Share your code or link, or add theirs. Once both games are open you see each other online and can duel with one tap.</p>
          <button class="fr-btn gold" onClick={goAdd}>
            Add a friend
          </button>
        </div>
      )}
      {anyone && (
        <div class="fr-game">
          <span>Duel invites are for</span>
          <span class="fr-seg">
            {(['speed', 'eds'] as GameMode[]).map((g) => (
              <button key={g} class={game === g ? 'on' : ''} onClick={() => setGame(g)}>
                {g === 'speed' ? 'Speed Duel' : 'EDS'}
              </button>
            ))}
          </span>
        </div>
      )}
      {on.length > 0 && (
        <section>
          <h2>
            Online <em>{on.length}</em>
          </h2>
          {on.map((f) => (
            <FriendRow key={f.code} f={f} game={game} menu={menu === f.code} onMenu={(x) => setMenu(x ? f.code : null)} onMsg={onMsg} />
          ))}
        </section>
      )}
      {off.length > 0 && (
        <section>
          <h2>Offline</h2>
          {off.map((f) => (
            <FriendRow key={f.code} f={f} game={game} menu={menu === f.code} onMenu={(x) => setMenu(x ? f.code : null)} onMsg={onMsg} />
          ))}
        </section>
      )}
      {anyone && on.length === 0 && game === 'speed' && <MatchHint onMsg={onMsg} />}
    </>
  );
}

/** Nobody around: point at Find a Match. */
function MatchHint({ onMsg }: { onMsg: (m: string | null) => void }) {
  return (
    <div class="fr-hint">
      <span>No friends online right now. Duel whoever else is searching instead?</span>
      <button
        class="fr-btn go"
        onClick={() => {
          const err = online.findMatch('speed');
          if (err) return onMsg(err);
          online.openPanel(false);
        }}
      >
        Find a Match
      </button>
    </div>
  );
}

function FriendRow({ f, game, menu, onMenu, onMsg }: { f: FriendView; game: GameMode; menu: boolean; onMenu: (open: boolean) => void; onMsg: (m: string | null) => void }) {
  const pr = online.presence!;
  const a = f.activity;
  const openRoom = f.online && a?.kind === 'room' && a.open ? a : null;
  const busy = f.online && a && a.kind !== 'menu' && !openRoom;
  let sub: string;
  const reach = pr.reach.get(f.code);
  if (reach === 'blocked' && !f.online) sub = "Their game is open, but the phones can't link yet. Retrying…";
  else if (f.status === 'sent') sub = f.online ? 'Connecting…' : 'Added · waiting for their game to open';
  else if (f.online) sub = doing(a);
  else sub = f.lastSeen ? `Seen ${ago(Date.now() - f.lastSeen)}` : 'Not seen online yet';
  const rank = rankLine(f.board);
  return (
    <div class={`fr-row ${f.online ? 'online' : ''} ${busy ? 'busy' : ''}`}>
      <span class="fr-av">
        <Bubble name={f.name} color={f.color} />
        <i class="fr-dot" />
      </span>
      <div class="fr-who">
        <b>{f.name}</b>
        {rank && <small class="fr-rank">{rank}</small>}
        <small>{sub}</small>
      </div>
      {f.status === 'friend' && openRoom && (
        <button class="fr-btn go" onClick={() => onMsg(online.joinRoom(openRoom.room, openRoom.game))}>
          Join
        </button>
      )}
      {f.status === 'friend' && f.online && !openRoom && (
        <button class="fr-btn go" disabled={!!busy} onClick={() => onMsg(online.inviteFriend(f.code, game))}>
          {busy ? 'Busy' : 'Duel'}
        </button>
      )}
      <button class="fr-more" onClick={() => onMenu(!menu)} aria-label={`More for ${f.name}`}>
        ⋯
      </button>
      {menu && (
        <div class="fr-menu">
          <span>
            Code {showCode(f.code)} · friends since {ago(Date.now() - f.since).replace(' ago', '')}
          </span>
          <button
            class="fr-btn bad"
            onClick={() => {
              pr.remove(f.code);
              onMenu(false);
            }}
          >
            Remove friend
          </button>
        </div>
      )}
    </div>
  );
}

function RecentTab({ recent, onMsg }: { recent: (RecentRec & { status: string | null })[]; onMsg: (m: string | null) => void }) {
  const pr = online.presence!;
  if (!recent.length)
    return (
      <div class="fr-empty">
        <div class="fr-empty-ic">🔎</div>
        <b>Nobody yet</b>
        <p>Duelists you meet with Find a Match show up here, so you can add the good ones as friends.</p>
      </div>
    );
  return (
    <section>
      <h2>Met through Find a Match</h2>
      {recent.map((r) => (
        <div class="fr-row" key={r.code}>
          <Bubble name={r.name} color={r.color} />
          <div class="fr-who">
            <b>{r.name}</b>
            {r.board && <small class="fr-rank">{rankLine(r.board)}</small>}
            <small>Matched {ago(Date.now() - r.at)}</small>
          </div>
          {r.status === 'friend' ? (
            <span class="fr-tag">Friends ✓</span>
          ) : r.status === 'sent' ? (
            <span class="fr-tag">Added</span>
          ) : (
            <button
              class="fr-btn go"
              onClick={() => {
                const res = pr.add(r.code, r.name, r.color);
                onMsg(res === 'accepted' ? `${r.name} is your friend now` : `Added ${r.name}. You're friends as soon as both games are open.`);
              }}
            >
              + Friend
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

function AddTab({ onAdded }: { onAdded: (msg: string) => void }) {
  const pr = online.presence!;
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const add = () => {
    const c = parseFriendCode(code);
    if (!c) return setErr('A friend code is 6 letters and numbers, like K7Q-2MX.');
    const r = pr.add(c);
    setCode('');
    if (r === 'self') return setErr("That's your own code.");
    if (r === 'already') return setErr('Already on your list.');
    onAdded(r === 'accepted' ? 'Friend added!' : `Added ${showCode(c)}. You're friends as soon as both games are open.`);
  };
  return (
    <section class="fr-add">
      <h2>Type their friend code</h2>
      <div class="fr-add-row">
        <input
          value={code}
          maxLength={40}
          placeholder="K7Q-2MX"
          autocapitalize="characters"
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => (setErr(null), setCode((e.target as HTMLInputElement).value.toUpperCase()))}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button class="fr-btn go" disabled={!code.trim()} onClick={add}>
          Add
        </button>
      </div>
      {err && <div class="fr-err">{err}</div>}
      <ol class="fr-how">
        <li>
          Your code is <b>{showCode(pr.data.code)}</b>. Tap <b>Share</b> above to text your link: opening it adds you on their phone.
        </li>
        <li>Adding a code makes you friends on both phones, no accept step.</li>
        <li>Friends show online while their game is open. Tap Duel and they get an invite.</li>
        <li>Your friends list moves with your duelist when you log in on another phone.</li>
      </ol>
    </section>
  );
}
