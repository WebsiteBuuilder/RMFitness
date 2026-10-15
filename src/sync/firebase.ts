import type { GameEvent } from './events';
import { AdapterBase, SyncAdapter } from './types';
import { firebaseConfig, firebaseRooms } from './firebaseConfig';

/**
 * Room log in Firebase Realtime Database: rooms/<CODE>/events/<pushKey>.
 * Both players push; push keys sort chronologically, which gives the order.
 * Loaded only when a config exists, so the bundle stays light without it.
 */
export class FirebaseAdapter extends AdapterBase implements SyncAdapter {
  readonly kind = 'firebase' as const;
  readonly isHost: boolean;
  readonly roomCode: string;
  private unsub: (() => void) | null = null;
  private push: ((ev: GameEvent) => Promise<void>) | null = null;
  private pending: GameEvent[] = [];

  constructor(roomCode: string, isHost: boolean) {
    super();
    this.roomCode = roomCode.toUpperCase();
    this.isHost = isHost;
    this.setStatus('connecting', 'Connecting…');
    void this.start();
  }

  static available(): boolean {
    return firebaseConfig !== null && firebaseRooms;
  }

  private async start() {
    if (!firebaseConfig) {
      this.setStatus('error', 'Firebase is not configured');
      return;
    }
    try {
      const { initializeApp, getApps } = await import('firebase/app');
      const { getDatabase, ref, push, onValue, set, serverTimestamp } = await import('firebase/database');
      const app = getApps()[0] ?? initializeApp(firebaseConfig);
      const db = getDatabase(app);
      const room = ref(db, `rooms/${this.roomCode}`);
      const eventsRef = ref(db, `rooms/${this.roomCode}/events`);
      if (this.isHost) await set(ref(db, `rooms/${this.roomCode}/createdAt`), serverTimestamp());
      this.push = async (ev) => {
        await push(eventsRef, { ...ev, ts: Date.now() });
      };
      this.unsub = onValue(
        room,
        (snap) => {
          const val = snap.val() as { events?: Record<string, GameEvent & { ts: number }> } | null;
          const entries = val?.events ? Object.keys(val.events).sort() : [];
          this.events = entries.map((k, i) => ({ ...val!.events![k], seq: i }));
          this.emit();
          this.setStatus('connected', `Room ${this.roomCode}`);
        },
        (err) => this.setStatus('error', err.message),
      );
      for (const ev of this.pending) await this.push(ev);
      this.pending = [];
    } catch (e) {
      this.setStatus('error', e instanceof Error ? e.message : String(e));
    }
  }

  send(ev: GameEvent) {
    if (this.push) void this.push(ev);
    else this.pending.push(ev);
  }

  close() {
    this.unsub?.();
    this.listeners.clear();
    this.statusListeners.clear();
  }
}
