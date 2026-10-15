// Shared accounts in Firebase (Google's free plan): Authentication signs duelists in,
// the Realtime Database keeps their progress. Layout (rules in database.rules.json):
//   duelists/<uid>   name, color, sign-in id: anyone can read the list, only its owner writes
//   saves/<uid>      the profile's progress: only its owner reads or writes
//   backups/<phone>/<profile id>  copies of profiles not moved yet: only that phone writes
// Loaded only when a config exists, so the game stays light without it.
import type { FirebaseApp, FirebaseOptions } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import type { Database } from 'firebase/database';
import { CloudFail, type BackupEntry, type CloudBackend, type CloudDuelist, type CloudSave, type DuelistMeta } from './backend';

function fail(e: unknown): CloudFail {
  const code = (e as { code?: string })?.code ?? '';
  if (code === 'auth/email-already-in-use') return new CloudFail('taken');
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found' || code === 'auth/invalid-login-credentials') return new CloudFail('wrong');
  if (code === 'auth/too-many-requests') return new CloudFail('busy');
  if (code === 'auth/network-request-failed' || code === 'unavailable') return new CloudFail('offline');
  return new CloudFail('other', e instanceof Error ? e.message : String(e));
}

export class FirebaseBackend implements CloudBackend {
  private ready: Promise<{ app: FirebaseApp; auth: Auth; db: Database }> | null = null;
  private backupReady: Promise<{ db: Database; uid: string }> | null = null;
  private user: string | null = null;

  constructor(private config: FirebaseOptions) {}

  private init() {
    this.ready ??= (async () => {
      const { initializeApp, getApps } = await import('firebase/app');
      const { getAuth, onAuthStateChanged } = await import('firebase/auth');
      const { getDatabase } = await import('firebase/database');
      const app = getApps().find((a) => a.name === '[DEFAULT]') ?? initializeApp(this.config);
      const auth = getAuth(app);
      onAuthStateChanged(auth, (u) => (this.user = u?.uid ?? null));
      await auth.authStateReady();
      this.user = auth.currentUser?.uid ?? null;
      return { app, auth, db: getDatabase(app) };
    })();
    return this.ready;
  }

  async list(): Promise<CloudDuelist[]> {
    const { db } = await this.init();
    const { ref, get } = await import('firebase/database');
    try {
      const snap = await get(ref(db, 'duelists'));
      const v = (snap.val() ?? {}) as Record<string, Omit<CloudDuelist, 'uid'>>;
      return Object.entries(v)
        .filter(([, d]) => d && typeof d.login === 'string' && typeof d.alias === 'string')
        .map(([uid, d]) => ({ uid, alias: d.alias, name: d.name ?? d.alias, color: d.color ?? '#2f7fe0', login: d.login, created: d.created ?? 0 }));
    } catch (e) {
      throw fail(e);
    }
  }

  async create(login: string, password: string, meta: DuelistMeta): Promise<string> {
    const { auth, db } = await this.init();
    const { createUserWithEmailAndPassword } = await import('firebase/auth');
    const { ref, set } = await import('firebase/database');
    try {
      const cred = await createUserWithEmailAndPassword(auth, login, password);
      this.user = cred.user.uid;
      // The account exists now; if listing it fails, the next login lists it (see migrate).
      await set(ref(db, `duelists/${cred.user.uid}`), { ...meta, login }).catch(() => {});
      return cred.user.uid;
    } catch (e) {
      throw fail(e);
    }
  }

  async signIn(login: string, password: string): Promise<string> {
    const { auth } = await this.init();
    const { signInWithEmailAndPassword } = await import('firebase/auth');
    try {
      const cred = await signInWithEmailAndPassword(auth, login, password);
      this.user = cred.user.uid;
      return cred.user.uid;
    } catch (e) {
      throw fail(e);
    }
  }

  current(): string | null {
    return this.user;
  }

  async signOut() {
    const { auth } = await this.init();
    const { signOut } = await import('firebase/auth');
    await signOut(auth);
    this.user = null;
  }

  async getSave(uid: string): Promise<CloudSave | null> {
    const { db } = await this.init();
    const { ref, get } = await import('firebase/database');
    try {
      const snap = await get(ref(db, `saves/${uid}`));
      const v = snap.val() as CloudSave | null;
      return v && typeof v.at === 'number' ? { at: v.at, bundle: v.bundle ?? {}, by: v.by } : null;
    } catch (e) {
      throw fail(e);
    }
  }

  async putSave(uid: string, s: CloudSave) {
    const { db } = await this.init();
    const { ref, set } = await import('firebase/database');
    try {
      await set(ref(db, `saves/${uid}`), s);
    } catch (e) {
      throw fail(e);
    }
  }

  async putMeta(uid: string, meta: Partial<DuelistMeta & { login: string }>) {
    const { db } = await this.init();
    const { ref, update } = await import('firebase/database');
    try {
      await update(ref(db, `duelists/${uid}`), meta);
    } catch (e) {
      throw fail(e);
    }
  }

  async changePassword(password: string) {
    const { auth } = await this.init();
    const { updatePassword } = await import('firebase/auth');
    if (!auth.currentUser) throw new CloudFail('other', 'Not logged in');
    try {
      await updatePassword(auth.currentUser, password);
    } catch (e) {
      throw fail(e);
    }
  }

  /** Backups sign in as this phone (an anonymous account in a second app), apart from the duelist. */
  private backupInit() {
    this.backupReady ??= (async () => {
      const { initializeApp, getApps } = await import('firebase/app');
      const { getAuth, signInAnonymously } = await import('firebase/auth');
      const { getDatabase } = await import('firebase/database');
      const app = getApps().find((a) => a.name === 'eds-backup') ?? initializeApp(this.config, 'eds-backup');
      const auth = getAuth(app);
      await auth.authStateReady();
      const uid = auth.currentUser?.uid ?? (await signInAnonymously(auth)).user.uid;
      return { db: getDatabase(app), uid };
    })().catch((e) => {
      this.backupReady = null;
      throw fail(e);
    });
    return this.backupReady;
  }

  async backup(profileId: string, entry: BackupEntry) {
    const { db, uid } = await this.backupInit();
    const { ref, set } = await import('firebase/database');
    try {
      await set(ref(db, `backups/${uid}/${profileId}`), entry);
    } catch (e) {
      throw fail(e);
    }
  }
}
