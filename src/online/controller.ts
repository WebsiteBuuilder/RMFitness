// The one friends service for the whole app: the signed-in profile's presence, the
// friends panel's state, and the hooks into the app for hosting and joining rooms.
import type { GameMode } from '../eds/types';
import type { Profile } from '../eds/save';
import type { DuelSession } from '../eds/session';
import { newRoomCode } from '../sync/types';
import { Presence, type OutgoingInvite } from './presence';
import { AutoTransport, queueNet } from './autoNet';
import { checkCloud, cloudState, onCloudState } from '../sync/cloud';
import { parseFriendCode, type Activity, type Transport } from './protocol';
import { loadOnline, writeOnline } from './store';
import type { BoardStats } from '../collection/rankings';
import { Matchmaker, type Match } from './matchmaking';
import { GlobalChat, loadGc, writeGc, type Doing, type GcNote } from './globalChat';
import { onlineDb } from '../sync/cloud';

/** The "Opponent found!" screen stays up this long before the duel room opens. */
export const VERSUS_MS = 1800;
/** The joining phone waits a little longer, so the host's room is open by the time it knocks. */
const GUEST_EXTRA_MS = 500;

export interface AppHooks {
  /** open a room as its host, under this code, for this game */
  host(room: string, game: GameMode): void;
  /** join a friend's room */
  join(room: string, game: GameMode): void;
  /** this profile has a deck ready for that game (otherwise invites can't be sent or taken) */
  deckProblem(game: GameMode): string | null;
}

export type Notice = { id: number; text: string };

/** Which part of the Chat page shows: the room everyone sees, the list of conversations, one conversation, or who is online. */
export type ChatView = { tab: 'all' } | { tab: 'dms' } | { tab: 'people' } | { tab: 'dm'; code: string; name: string; color: string };

class OnlineController {
  presence: Presence | null = null;
  profile: Profile | null = null;
  panelOpen = false;
  /** global chat: the room everyone sees and private messages (needs the online service) */
  gchat: GlobalChat | null = null;
  /** the Chat page is open on this */
  chatView: ChatView | null = null;
  /** private messages just in, newest last, shown as notices on any screen */
  chatNotes: GcNote[] = [];
  /** set for each message just in (sound, a buzz, a phone notification when the game is in the background) */
  onChatNote: (n: GcNote) => void = () => {};
  /** the Friends button shows (menus, not duels) */
  button = false;
  notice: Notice | null = null;
  /** shown on the panel: someone's friend link was opened */
  addedFromLink: string | null = null;
  private app: AppHooks | null = null;
  private listeners = new Set<() => void>();
  private unsubPresence: (() => void) | null = null;
  private unsubSession: (() => void) | null = null;
  private pendingFriend: string | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeSeq = 0;
  private lastOut: OutgoingInvite | null = null;
  /** this window stepped aside for another window of the same profile */
  passive = false;
  private instance = Math.random().toString(36).slice(2);
  private channel: BroadcastChannel | null = null;
  private transport: Transport | null = null;
  /** which queue the current search is on */
  private mmKind: 'cloud' | 'peer' = 'cloud';
  /** tests swap in their own transport */
  makeTransport: () => Transport = () => new AutoTransport();
  /** Find a Match: the queue for a duel against whoever else is searching */
  readonly mm: Matchmaker;
  /** the match being shown on the "Opponent found!" screen, before its room opens */
  versus: Match | null = null;
  /** the room the last Find a Match opened: its lobby readies both players by itself */
  matchedRoom: { room: string; opponent: string } | null = null;
  /** the search stopped because the game went to the background: it picks up on return */
  private resumeSearch = false;
  private versusTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.mm = new Matchmaker({
      net: () => {
        // a search started while the check runs waits for it and lands on the right queue by itself
        this.mmKind = cloudState() === 'off' ? 'peer' : 'cloud';
        return queueNet();
      },
      me: () => {
        const pr = this.presence;
        return { name: pr?.me.name ?? this.profile?.alias ?? 'Duelist', color: pr?.me.color ?? this.profile?.color ?? '#888888', code: pr?.data.code ?? '', ...(pr?.me.board ? { board: pr.me.board } : {}) };
      },
    });
    this.mm.subscribe(() => this.changed());
    // the online service came through after this phone had gone online the old way: switch over
    onCloudState((st) => {
      const t = this.transport;
      // a search still on the old queue moves over too, so it can meet phones on the service
      if (st === 'on' && this.mm.state === 'searching' && this.mmKind === 'peer' && !this.versus) {
        const g = this.mm.game;
        this.mm.cancel();
        this.findMatch(g);
      }
      if (st === 'on' && t instanceof AutoTransport && t.kind === 'peer' && this.profile && !this.versus) {
        const p = this.profile;
        this.unsubPresence?.();
        this.presence?.stop();
        this.presence = null;
        this.goOnline(p);
        this.changed();
      }
      if (st === 'on' && this.profile && this.presence && !this.gchat) this.startChat();
    });
    this.mm.onMatch = (m) => this.matched(m);
    if (typeof location !== 'undefined') {
      const p = new URLSearchParams(location.search);
      const f = p.get('friend');
      this.pendingFriend = f ? parseFriendCode(f) : null;
      if (this.pendingFriend) {
        p.delete('friend');
        const q = p.toString();
        history.replaceState(null, '', location.pathname + (q ? `?${q}` : ''));
      }
    }
    try {
      this.channel = new BroadcastChannel('eds-online-v1');
      this.channel.onmessage = (e: MessageEvent) => {
        const m = e.data as { t?: string; profile?: string; from?: string };
        if (m?.t === 'claim' && m.from !== this.instance && m.profile && m.profile === this.profile?.id && this.presence) this.stepAside();
      };
    } catch {
      /* no BroadcastChannel: one window at a time is all that works */
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') {
          // A phone in a pocket can't duel: leave the queue, and rejoin it on the way back.
          if (this.mm.searching) {
            this.resumeSearch = true;
            this.mm.cancel();
          }
          return;
        }
        if (this.resumeSearch) {
          this.resumeSearch = false;
          if (this.profile && !this.versus) this.findMatch(this.mm.game);
        }
        if (cloudState() === 'off') void checkCloud();
        if (this.passive && this.profile) {
          this.passive = false;
          this.goOnline(this.profile);
          this.changed();
        } else this.presence?.wake();
      });
      window.addEventListener('online', () => this.presence?.wake());
      // closing the game leaves the queue at once (the broker forgets the slot)
      window.addEventListener('pagehide', () => this.mm.cancel());
    }
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed() {
    this.watchOutgoing();
    const a = this.presence?.activity;
    if (a && this.gchat) this.gchat.setDoing(a.kind as Doing);
    for (const cb of this.listeners) cb();
  }

  bindApp(h: AppHooks) {
    this.app = h;
  }

  /** The profile playing on this phone goes online (null: back to the profile picker). */
  setProfile(p: Profile | null) {
    if (p?.id === this.profile?.id) {
      if (p && this.presence) this.presence.setMe({ ...this.presence.me, name: p.alias, color: p.color });
      if (p) this.gchat?.setMe({ code: '', name: p.alias, color: p.color });
      return;
    }
    this.unsubPresence?.();
    this.presence?.stop();
    this.presence = null;
    this.stopChat();
    this.cancelMatch();
    this.profile = p;
    this.panelOpen = false;
    this.lastOut = null;
    this.passive = false;
    if (p) {
      const pr = this.goOnline(p);
      if (this.pendingFriend) {
        const r = pr.add(this.pendingFriend);
        if (r === 'added' || r === 'accepted') this.addedFromLink = this.pendingFriend;
        this.pendingFriend = null;
        this.panelOpen = true;
      }
    }
    this.changed();
  }

  private goOnline(p: Profile): Presence {
    // fresh from storage: another window of this game may have changed the list
    const data = loadOnline(p.id);
    const transport = this.makeTransport();
    this.transport = transport;
    const pr = new Presence({ transport, data, me: { name: p.alias, color: p.color }, save: (d) => writeOnline(p.id, d) });
    this.presence = pr;
    this.unsubPresence = pr.subscribe(() => this.changed());
    pr.onNotice = (text) => this.say(text);
    pr.start();
    this.startChat();
    // the newest window of this profile is the one online; any older one steps aside
    this.channel?.postMessage({ t: 'claim', profile: p.id, from: this.instance });
    return pr;
  }

  /** Global chat goes online with the profile (only over the online service: there is no room without it). */
  private startChat() {
    const p = this.profile;
    const pr = this.presence;
    if (!p || !pr || this.gchat) return;
    if (cloudState() !== 'on') {
      void checkCloud();
      return;
    }
    const gc = new GlobalChat({ db: onlineDb, me: { code: pr.data.code, name: p.alias, color: p.color }, data: loadGc(p.id), save: (d) => writeGc(p.id, d) });
    this.gchat = gc;
    gc.subscribe(() => this.changed());
    gc.onNote = (n) => this.chatIn(n);
    gc.start();
  }

  private stopChat() {
    this.gchat?.stop();
    this.gchat = null;
    this.chatView = null;
    this.chatNotes = [];
  }

  private chatIn(n: GcNote) {
    const v = this.chatView;
    // (the conversation is on screen: it shows there, read)
    if (v?.tab === 'dm' && v.code === n.from && typeof document !== 'undefined' && document.visibilityState === 'visible') {
      this.gchat?.read(n.from);
    } else {
      // (one notice per player: a newer message from them replaces theirs)
      this.chatNotes = [...this.chatNotes.filter((x) => x.from !== n.from), n].slice(-3);
    }
    this.onChatNote(n);
    this.changed();
  }

  dismissNote(from: string) {
    const left = this.chatNotes.filter((x) => x.from !== from);
    if (left.length === this.chatNotes.length) return;
    this.chatNotes = left;
    this.changed();
  }

  /** Opens the Chat page (null closes it). */
  openChat(v: ChatView | null = { tab: 'all' }) {
    this.chatView = v;
    if (v?.tab === 'dm') {
      this.gchat?.read(v.code);
      this.dismissNote(v.code);
    }
    if (v) this.panelOpen = false;
    this.changed();
  }

  /** Unread room lines and private messages, for the Chat buttons. */
  chatUnread(): { all: number; dms: number } {
    const gc = this.gchat;
    return gc ? { all: gc.allUnread(), dms: gc.dmUnread() } : { all: 0, dms: 0 };
  }

  /** Another window (the installed app, a browser tab) took this profile online. */
  private stepAside() {
    this.stopChat();
    this.cancelMatch();
    this.unsubPresence?.();
    this.unsubPresence = null;
    this.presence?.stop();
    this.presence = null;
    this.passive = true;
    this.panelOpen = false;
    this.changed();
  }

  /** Clears a deleted profile's friends from the phone. */
  forget(profileId: string) {
    try {
      localStorage.removeItem(`eds.online.${profileId}`);
    } catch {
      /* nothing to clear */
    }
  }

  /** Shares this player's link-battle record with friends (Duelist Rankings). */
  setBoard(board: BoardStats) {
    const pr = this.presence;
    if (!pr || JSON.stringify(pr.me.board) === JSON.stringify(board)) return;
    pr.setMe({ ...pr.me, board });
  }

  showButton(on: boolean) {
    if (on === this.button) return;
    this.button = on;
    this.changed();
  }

  openPanel(open = true) {
    this.panelOpen = open;
    if (!open) this.addedFromLink = null;
    this.changed();
  }

  say(text: string, ms = 3500) {
    this.notice = { id: ++this.noticeSeq, text };
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
      this.changed();
    }, ms);
    this.changed();
  }

  /** Follows the duel on screen, so friends see "in a room" or "in a duel". */
  watchSession(session: DuelSession | null, game: GameMode, onScreen: boolean) {
    this.unsubSession?.();
    this.unsubSession = null;
    const pr = this.presence;
    if (!pr) return;
    if (!session || !onScreen) return pr.setActivity({ kind: 'menu' });
    // another duel started: the queue would only pull this player away from it
    if (this.mm.searching) this.cancelMatch();
    const update = () => {
      const room = session.adapter.roomCode;
      const online = session.adapter.kind !== 'local' && !!room;
      let a: Activity;
      if (!online || session.state.started || !session.adapter.isHost) a = { kind: 'duel', game: session.state.rules?.mode ?? session.seats[0].mode ?? game };
      else a = { kind: 'room', room: room!, game, open: session.status !== 'connected' };
      this.presence?.setActivity(a);
    };
    update();
    this.unsubSession = session.listen(update);
  }

  // ---------- Find a Match ----------

  /** Joins the queue. Returns why not, when it can't. */
  findMatch(game: GameMode = 'speed'): string | null {
    if (!this.app || !this.profile) return 'Your game is still loading';
    if (!this.presence) return this.passive ? 'This duelist is open in another window' : 'Not online yet';
    const problem = this.app.deckProblem(game);
    if (problem) return problem;
    this.resumeSearch = false;
    this.mm.start(game);
    return null;
  }

  cancelMatch() {
    this.resumeSearch = false;
    this.mm.cancel();
    if (this.versusTimer) clearTimeout(this.versusTimer);
    this.versusTimer = null;
    if (this.versus) {
      this.versus = null;
      this.changed();
    }
  }

  /** Someone else pressed the button: show who, then open (or join) the room. */
  private matched(m: Match) {
    this.versus = m;
    this.presence?.metRecently(m.opponent);
    navigator.vibrate?.([60, 40, 120]);
    this.changed();
    if (this.versusTimer) clearTimeout(this.versusTimer);
    this.versusTimer = setTimeout(
      () => {
        this.versusTimer = null;
        const app = this.app;
        this.versus = null;
        this.mm.clear();
        this.panelOpen = false;
        this.matchedRoom = { room: m.room, opponent: m.opponent.name };
        if (app) {
          if (m.role === 'host') {
            app.host(m.room, m.game);
            this.presence?.setActivity({ kind: 'room', room: m.room, game: m.game, open: true });
          } else app.join(m.room, m.game);
        }
        this.changed();
      },
      VERSUS_MS + (m.role === 'guest' ? GUEST_EXTRA_MS : 0),
    );
  }

  /** One tap on a friend: open a room (or reuse the one open) and invite them to it. */
  inviteFriend(code: string, game: GameMode): string | null {
    const pr = this.presence;
    if (!pr || !this.app) return 'Not online yet';
    const problem = this.app.deckProblem(game);
    if (problem) return problem;
    const a = pr.activity;
    let room: string;
    if (a.kind === 'room' && a.open && a.game === game) room = a.room;
    else {
      room = newRoomCode();
      this.app.host(room, game);
      pr.setActivity({ kind: 'room', room, game, open: true });
    }
    if (!pr.invite(code, room, game)) return 'They just went offline';
    this.cancelMatch();
    this.panelOpen = false;
    this.changed();
    return null;
  }

  /** Taking an invite, or hopping into a friend's open room. */
  joinRoom(room: string, game: GameMode, inviteId?: string): string | null {
    const pr = this.presence;
    if (!pr || !this.app) return 'Not online yet';
    const problem = this.app.deckProblem(game);
    if (problem) {
      if (inviteId) pr.answer(inviteId, false);
      return problem;
    }
    if (inviteId && !pr.answer(inviteId, true)) return 'That invite expired';
    this.cancelMatch();
    this.panelOpen = false;
    this.app.join(room, game);
    this.changed();
    return null;
  }

  /** Tells the inviter how their invite went. */
  private watchOutgoing() {
    const out = this.presence?.outgoing ?? null;
    const prev = this.lastOut;
    this.lastOut = out;
    if (!out || (prev && prev.id === out.id && prev.state === out.state) || out.state === 'waiting') return;
    const name = this.presence?.data.friends.find((f) => f.code === out.to)?.name ?? 'Your friend';
    const text: Record<string, string> = {
      accepted: `${name} is joining your room`,
      declined: `${name} said not now`,
      busy: `${name} is busy in another duel`,
      expired: `${name} didn't answer`,
      offline: `${name} went offline`,
    };
    if (text[out.state]) queueMicrotask(() => this.say(text[out.state]));
  }
}

export const online = new OnlineController();
