// Shared duelist accounts, Netflix style: one "Which duelist are you?" page, then each
// duelist logs in to their own profile with a password.
//
// Every profile that was already on a phone before this update stays exactly as it was.
// The first time someone taps it, they set its password and (when the shared store is on)
// it moves into a shared account with all its progress, so the same duelist can log in
// from any phone. Until then the updated game keeps a backup copy of it in the store.
// With no shared store configured, passwords and profiles simply stay on the phone.
import { ALIAS_MAX, MAX_PROFILES, PROFILE_COLORS, createProfile, deleteProfile, loadProfiles, updateProfile, writeProfiles, type Profile } from '../eds/save';
import { CloudFail, type CloudBackend, type CloudDuelist, type CloudSave } from './backend';
import { hashBundle, isEmpty, readBundle, writeBundle, type Store } from './bundle';
import { checkLock, cloudPassword, dropLock, hasLock, loginFor, setLock } from './passwords';

export type Tile = { kind: 'local'; p: Profile; firstTime: boolean } | { kind: 'cloud'; d: CloudDuelist };

export type CloudState = 'off' | 'on' | 'offline';

export type LoginResult =
  | { ok: true; p: Profile; note?: 'moved' | 'offline' | 'pulled' }
  | { ok: false; why: 'wrong' | 'taken' | 'busy' | 'offline' | 'full' | 'other'; message: string };

interface SyncState {
  uid: string;
  /** the cloud copy's time when this phone last matched it */
  cloudAt: number;
  /** this phone's bundle fingerprint at that moment */
  hash: string;
}

const syncKey = (id: string) => `eds.sync.${id}`;
const conflictKey = (id: string) => `eds.conflict.${id}`;
const BACKED_UP_KEY = 'eds.backedUp';
const DEVICE_KEY = 'eds.device';
export const SYNC_MS = 20_000;
const TIMEOUT_MS = 12_000;

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new CloudFail('offline', 'No answer from the accounts server')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

const failCode = (e: unknown) => (e instanceof CloudFail ? e.code : 'other');

const MESSAGES = {
  wrong: 'Wrong password. Try again.',
  busy: 'Too many tries. Wait a minute, then try again.',
  offline: "Can't reach the shared accounts right now. Check your internet and try again.",
  other: 'Something went wrong. Try again.',
};

export class Accounts {
  state: CloudState;
  private cloudList: CloudDuelist[] | null = null;
  private active: Profile | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> = Promise.resolve();
  private unhook: (() => void) | null = null;

  constructor(
    readonly backend: CloudBackend | null,
    private st: Store,
    private now: () => number = () => Date.now(),
  ) {
    this.state = backend ? 'on' : 'off';
  }

  // ---------- the "Which duelist are you?" page ----------

  /** A profile on this phone that nobody has logged in to since the update. */
  firstTime(p: Profile): boolean {
    return !p.uid && !hasLock(p.id, this.st);
  }

  /** The profiles on this phone, straight away. */
  localTiles(): Tile[] {
    return loadProfiles().map((p) => ({ kind: 'local', p, firstTime: this.firstTime(p) }));
  }

  /** This phone's profiles, then every other duelist with a shared account. */
  async tiles(): Promise<Tile[]> {
    const tiles = this.localTiles();
    if (!this.backend) return tiles;
    try {
      const list = await withTimeout(this.backend.list());
      this.cloudList = list;
      this.state = 'on';
      const mine = new Set(loadProfiles().map((p) => p.uid).filter(Boolean));
      const others = list.filter((d) => !mine.has(d.uid)).sort((a, b) => a.alias.localeCompare(b.alias));
      return [...tiles, ...others.map((d): Tile => ({ kind: 'cloud', d }))];
    } catch {
      this.state = 'offline';
      return tiles;
    }
  }

  /** Is this duelist name used by someone else (on this phone or in the shared accounts)? */
  aliasTaken(alias: string, except?: Profile): boolean {
    const a = alias.trim().toLowerCase();
    if (loadProfiles().some((p) => p.id !== except?.id && p.alias.toLowerCase() === a)) return true;
    return !!this.cloudList?.some((d) => d.uid !== except?.uid && d.alias.toLowerCase() === a);
  }

  // ---------- logging in ----------

  /** First login since the update: set the profile's password (and a new name if its old one is taken). */
  async setFirstPassword(p: Profile, pw: string, newAlias?: string): Promise<LoginResult> {
    await this.pending;
    let prof = p;
    if (newAlias && newAlias.trim() !== p.alias) {
      if (this.aliasTaken(newAlias, p)) return this.taken(newAlias);
      prof = updateProfile(p.id, p.name === p.alias ? newAlias : p.name, newAlias) ?? p;
    }
    if (!hasLock(prof.id, this.st)) await setLock(prof.id, pw, this.st);
    else if ((await checkLock(prof.id, pw, this.st)) === false) return { ok: false, why: 'wrong', message: MESSAGES.wrong };
    return this.backend ? this.migrate(prof, pw) : { ok: true, p: prof };
  }

  /** Log in to a profile on this phone. */
  async logIn(p: Profile, pw: string): Promise<LoginResult> {
    await this.pending;
    if (this.backend && p.uid && p.login) {
      try {
        await withTimeout(this.backend.signIn(p.login, cloudPassword(pw)));
      } catch (e) {
        const code = failCode(e);
        if (code === 'wrong' || code === 'busy') return { ok: false, why: code, message: MESSAGES[code] };
        // No signal: the password this phone knows still opens the profile; it syncs next time.
        this.state = 'offline';
        const local = await checkLock(p.id, pw, this.st);
        return local ? { ok: true, p, note: 'offline' } : { ok: false, why: local === false ? 'wrong' : 'offline', message: local === false ? MESSAGES.wrong : MESSAGES.offline };
      }
      this.state = 'on';
      await setLock(p.id, pw, this.st); // the password may have changed on another phone
      const pulled = await this.reconcile(p);
      return { ok: true, p: loadProfiles().find((x) => x.id === p.id) ?? p, note: pulled ? 'pulled' : undefined };
    }
    const ok = await checkLock(p.id, pw, this.st);
    if (ok === null) return this.setFirstPassword(p, pw);
    if (!ok) return { ok: false, why: 'wrong', message: MESSAGES.wrong };
    // Its password was set while the shared store was off or out of reach: move it now.
    return this.backend ? this.migrate(p, pw) : { ok: true, p };
  }

  /** Log in on this phone to a duelist whose profile lives on another phone. */
  async logInCloud(d: CloudDuelist, pw: string): Promise<LoginResult> {
    await this.pending;
    if (!this.backend) return { ok: false, why: 'offline', message: MESSAGES.offline };
    try {
      await withTimeout(this.backend.signIn(d.login, cloudPassword(pw)));
    } catch (e) {
      const code = failCode(e);
      return { ok: false, why: code === 'taken' ? 'other' : code, message: MESSAGES[code === 'taken' ? 'other' : code] };
    }
    const list = loadProfiles();
    let p = list.find((x) => x.uid === d.uid);
    if (!p) {
      p = { id: d.uid, name: d.name, alias: d.alias, color: d.color, created: d.created, uid: d.uid, login: d.login };
      writeProfiles([...list, p]);
    }
    await setLock(p.id, pw, this.st);
    await this.reconcile(p);
    return { ok: true, p, note: 'pulled' };
  }

  /** A brand-new duelist: a name and a password. */
  async create(alias: string, pw: string): Promise<LoginResult> {
    await this.pending;
    const a = alias.trim().slice(0, ALIAS_MAX);
    if (!a) return { ok: false, why: 'other', message: 'Pick a duelist name.' };
    if (this.backend && !this.cloudList) await this.tiles();
    if (this.aliasTaken(a)) return this.taken(a);
    if (loadProfiles().length >= MAX_PROFILES) return { ok: false, why: 'full', message: `This phone holds up to ${MAX_PROFILES} new profiles. Log in to an existing duelist instead.` };
    const p = createProfile(a, a);
    if (!p) return { ok: false, why: 'full', message: `This phone holds up to ${MAX_PROFILES} profiles.` };
    await setLock(p.id, pw, this.st);
    return this.backend ? this.migrate(p, pw) : { ok: true, p };
  }

  private taken(alias: string): LoginResult {
    return { ok: false, why: 'taken', message: `Someone already goes by ${alias.trim()}. Pick another duelist name.` };
  }

  /** Moves a phone profile into a new shared account, progress and friends included. */
  private async migrate(p: Profile, pw: string): Promise<LoginResult> {
    const b = this.backend!;
    if (!this.cloudList) {
      try {
        this.cloudList = await withTimeout(b.list());
      } catch {
        this.state = 'offline';
        return { ok: true, p, note: 'offline' }; // stays on this phone; moves at the next login
      }
    }
    if (this.aliasTaken(p.alias, p)) return this.taken(p.alias);
    const meta = { alias: p.alias, name: p.name, color: p.color || PROFILE_COLORS[0], created: p.created || this.now() };
    let uid: string | null = null;
    let login = '';
    for (let n = 0; n < 8 && !uid; n++) {
      login = loginFor(p.alias, n);
      try {
        uid = await withTimeout(b.create(login, cloudPassword(pw), meta));
      } catch (e) {
        const code = failCode(e);
        if (code === 'taken') {
          // Our own account from a move cut off by a lost signal answers to the same password: reuse it.
          try {
            uid = await withTimeout(b.signIn(login, cloudPassword(pw)));
            await withTimeout(b.putMeta(uid, { ...meta, login })).catch(() => {});
          } catch {
            /* someone else's (a renamed duelist's old login): try the next one */
          }
          continue;
        }
        if (code === 'busy') return { ok: false, why: 'busy', message: MESSAGES.busy };
        this.state = 'offline';
        return { ok: true, p, note: 'offline' };
      }
    }
    if (!uid) return this.taken(p.alias);
    this.state = 'on';
    const bundle = readBundle(p.id, this.st);
    const at = this.now();
    try {
      await withTimeout(b.putSave(uid, { at, bundle, by: this.device() }));
      this.writeSync(p.id, { uid, cloudAt: at, hash: hashBundle(bundle) });
    } catch {
      // The account exists; the first sync after login uploads the progress.
    }
    const moved: Profile = { ...p, uid, login };
    writeProfiles(loadProfiles().map((x) => (x.id === p.id ? moved : x)));
    this.cloudList = [...(this.cloudList ?? []), { uid, login, ...meta }];
    return { ok: true, p: moved, note: 'moved' };
  }

  // ---------- keeping phone and account in step ----------

  /** Brings this phone and the account to the same progress. True when the account's copy was taken. */
  async reconcile(p: Profile): Promise<boolean> {
    const b = this.backend;
    if (!b || !p.uid) return false;
    let cloud: CloudSave | null;
    try {
      cloud = await withTimeout(b.getSave(p.uid));
    } catch {
      return false;
    }
    const local = readBundle(p.id, this.st);
    const h = hashBundle(local);
    const sy = this.readSync(p.id);
    const same = sy && sy.uid === p.uid;
    if (!cloud) {
      await this.push(p, local, 0);
      return false;
    }
    if (same && cloud.at === sy.cloudAt) {
      if (h !== sy.hash) await this.push(p, local, cloud.at);
      return false;
    }
    // The account moved on elsewhere (or this phone has never seen it).
    if (same && h !== sy.hash && !isEmpty(local)) {
      // Both changed: the account wins, and this phone's copy is kept aside, never thrown away.
      try {
        this.st.setItem(conflictKey(p.id), JSON.stringify({ at: this.now(), bundle: local }));
      } catch {
        /* storage full */
      }
    }
    writeBundle(p.id, cloud.bundle, this.st);
    this.writeSync(p.id, { uid: p.uid, cloudAt: cloud.at, hash: hashBundle(readBundle(p.id, this.st)) });
    return true;
  }

  private async push(p: Profile, bundle: ReturnType<typeof readBundle>, after: number) {
    const at = Math.max(this.now(), after + 1);
    try {
      await withTimeout(this.backend!.putSave(p.uid!, { at, bundle, by: this.device() }));
      this.writeSync(p.id, { uid: p.uid!, cloudAt: at, hash: hashBundle(bundle) });
    } catch {
      /* tried again on the next sync */
    }
  }

  /** Uploads the playing profile's progress whenever it changed. */
  startSync(p: Profile) {
    this.stopTimer();
    this.active = p;
    if (!this.backend || !p.uid) return;
    this.timer = setInterval(() => void this.flush(), SYNC_MS);
    if (typeof document !== 'undefined') {
      const onHide = () => {
        if (document.visibilityState === 'hidden') void this.flush();
      };
      const onLeave = () => void this.flush();
      document.addEventListener('visibilitychange', onHide);
      window.addEventListener('pagehide', onLeave);
      this.unhook = () => {
        document.removeEventListener('visibilitychange', onHide);
        window.removeEventListener('pagehide', onLeave);
      };
    }
  }

  /** The duelist left (Switch Profile): upload what's new and stop. */
  stopSync(): Promise<void> {
    const done = this.flush();
    this.stopTimer();
    this.active = null;
    return done;
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unhook?.();
    this.unhook = null;
  }

  flush(): Promise<void> {
    const p = this.active;
    const b = this.backend;
    if (!p?.uid || !b) return this.pending;
    this.pending = this.pending.then(async () => {
      if (b.current() !== p.uid || !loadProfiles().some((x) => x.id === p.id)) return;
      const local = readBundle(p.id, this.st);
      const sy = this.readSync(p.id);
      if (sy && sy.uid === p.uid && sy.hash === hashBundle(local)) return;
      await this.push(p, local, sy?.cloudAt ?? 0);
    });
    return this.pending;
  }

  /** Keeps a copy of every profile on this phone that has not moved into an account yet. */
  async backupAll(): Promise<number> {
    const b = this.backend;
    if (!b) return 0;
    let done: Record<string, string> = {};
    try {
      done = JSON.parse(this.st.getItem(BACKED_UP_KEY) ?? '{}') ?? {};
    } catch {
      done = {};
    }
    let n = 0;
    for (const p of loadProfiles()) {
      if (p.uid) continue;
      const bundle = readBundle(p.id, this.st);
      const h = hashBundle(bundle);
      if (done[p.id] === h) continue;
      try {
        await withTimeout(b.backup(p.id, { alias: p.alias, name: p.name, color: p.color, created: p.created, at: this.now(), bundle }));
        done[p.id] = h;
        n++;
      } catch {
        break; // out of reach: try again next time the game opens
      }
    }
    try {
      this.st.setItem(BACKED_UP_KEY, JSON.stringify(done));
    } catch {
      /* storage full */
    }
    return n;
  }

  // ---------- managing a profile (after its password was entered) ----------

  async rename(p: Profile, alias: string): Promise<LoginResult> {
    const a = alias.trim().slice(0, ALIAS_MAX);
    if (!a) return { ok: false, why: 'other', message: 'Pick a duelist name.' };
    if (this.aliasTaken(a, p)) return this.taken(a);
    const next = updateProfile(p.id, p.name === p.alias ? a : p.name, a) ?? p;
    if (this.backend && p.uid && this.backend.current() === p.uid) {
      try {
        await withTimeout(this.backend.putMeta(p.uid, { alias: next.alias, name: next.name }));
        this.cloudList = this.cloudList?.map((d) => (d.uid === p.uid ? { ...d, alias: next.alias, name: next.name } : d)) ?? null;
      } catch {
        /* the shared page shows the old name until the next rename */
      }
    }
    return { ok: true, p: next };
  }

  async changePassword(p: Profile, pw: string): Promise<LoginResult> {
    if (this.backend && p.uid) {
      if (this.backend.current() !== p.uid) return { ok: false, why: 'offline', message: MESSAGES.offline };
      try {
        await withTimeout(this.backend.changePassword(cloudPassword(pw)));
      } catch (e) {
        const code = failCode(e) === 'busy' ? 'busy' : 'offline';
        return { ok: false, why: code, message: MESSAGES[code] };
      }
    }
    await setLock(p.id, pw, this.st);
    return { ok: true, p };
  }

  /** Takes the profile off this phone. A shared account keeps its progress; a phone-only one is gone. */
  remove(p: Profile) {
    if (this.active?.id === p.id) {
      // stop syncing first, so the emptied phone copy never overwrites the account
      this.stopTimer();
      this.active = null;
    }
    deleteProfile(p.id);
    for (const k of [syncKey(p.id), conflictKey(p.id), `eds.online.${p.id}`]) {
      try {
        this.st.removeItem(k);
      } catch {
        /* ignore */
      }
    }
    dropLock(p.id, this.st);
  }

  // ---------- small helpers ----------

  private readSync(id: string): SyncState | null {
    try {
      const v = JSON.parse(this.st.getItem(syncKey(id)) ?? 'null') as SyncState | null;
      return v && typeof v.uid === 'string' ? v : null;
    } catch {
      return null;
    }
  }

  private writeSync(id: string, s: SyncState) {
    try {
      this.st.setItem(syncKey(id), JSON.stringify(s));
    } catch {
      /* storage full */
    }
  }

  device(): string {
    try {
      let d = this.st.getItem(DEVICE_KEY);
      if (!d) {
        d = Math.random().toString(36).slice(2, 10);
        this.st.setItem(DEVICE_KEY, d);
      }
      return d;
    } catch {
      return 'unknown';
    }
  }
}
