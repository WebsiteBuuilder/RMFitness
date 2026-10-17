// Where shared duelist accounts live. The game talks to this interface only, so the
// hosted store (Firebase today) can be swapped, and tests can use an in-memory one.

/** A profile's progress: the raw saved text of each of its four saves on a phone. */
export type BundleKey = 'save' | 'speed' | 'solo' | 'online';
export type Bundle = Partial<Record<BundleKey, string>>;

/** One duelist on the shared "Which duelist are you?" page. */
export interface CloudDuelist {
  uid: string;
  alias: string;
  name: string;
  color: string;
  /** the sign-in id the game made for this duelist (never typed by anyone) */
  login: string;
  created: number;
}

export type DuelistMeta = Pick<CloudDuelist, 'alias' | 'name' | 'color' | 'created'>;

export interface CloudSave {
  /** when this copy was written (the writing phone's clock) */
  at: number;
  bundle: Bundle;
  /** which phone wrote it */
  by?: string;
}

/** A copy of a profile kept the first time an updated phone opens, before anyone logs in. */
export interface BackupEntry {
  alias: string;
  name: string;
  color: string;
  created: number;
  at: number;
  bundle: Bundle;
  /** the shared account it later moved into, once known */
  uid?: string;
}

export type CloudFailCode = 'taken' | 'wrong' | 'offline' | 'busy' | 'other';

export class CloudFail extends Error {
  constructor(
    readonly code: CloudFailCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface CloudBackend {
  /** every duelist with a shared account */
  list(): Promise<CloudDuelist[]>;
  /** make an account and sign in to it; throws CloudFail('taken') when the login exists */
  create(login: string, password: string, meta: DuelistMeta): Promise<string>;
  /** throws CloudFail('wrong') for a bad password */
  signIn(login: string, password: string): Promise<string>;
  /** the account signed in right now */
  current(): string | null;
  /** the account this browser stayed signed in to, once the store has loaded */
  restore?(): Promise<string | null>;
  signOut(): Promise<void>;
  getSave(uid: string): Promise<CloudSave | null>;
  putSave(uid: string, s: CloudSave): Promise<void>;
  putMeta(uid: string, meta: Partial<DuelistMeta & { login: string }>): Promise<void>;
  /** changes the signed-in account's password */
  changePassword(password: string): Promise<void>;
  /** keeps a copy of a phone's profile (device = this phone's id, profileId = its local id) */
  backup(profileId: string, entry: BackupEntry): Promise<void>;
}
