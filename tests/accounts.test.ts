// Shared duelist accounts: old phone profiles keep their progress and set a password on
// first login, then the same duelist logs in from another phone. Uses an in-memory store.
// Run: npx tsx tests/accounts.test.ts
import { Accounts } from '../src/accounts/accounts';
import { CloudFail, type BackupEntry, type CloudBackend, type CloudDuelist, type CloudSave, type DuelistMeta } from '../src/accounts/backend';
import { readBundle } from '../src/accounts/bundle';
import { cloudPassword, loginFor, passwordProblem } from '../src/accounts/passwords';
import { loadProfiles, type Profile } from '../src/eds/save';

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${what}`);
  if (!ok) failures++;
};

class MemStore {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

class MemCloud {
  users = new Map<string, { uid: string; pw: string }>();
  duelists = new Map<string, Omit<CloudDuelist, 'uid'>>();
  saves = new Map<string, CloudSave>();
  backups = new Map<string, BackupEntry>();
  offline = false;
  n = 0;
}

/** One phone's view of the shared store (each phone has its own signed-in user). */
class MemBackend implements CloudBackend {
  user: string | null = null;
  constructor(private c: MemCloud) {}
  private net() {
    if (this.c.offline) throw new CloudFail('offline');
  }
  async list() {
    this.net();
    return [...this.c.duelists].map(([uid, d]) => ({ uid, ...d }));
  }
  async create(login: string, pw: string, meta: DuelistMeta) {
    this.net();
    if (pw.length < 6) throw new CloudFail('other', 'weak');
    if (this.c.users.has(login)) throw new CloudFail('taken');
    const uid = `u${++this.c.n}`;
    this.c.users.set(login, { uid, pw });
    this.c.duelists.set(uid, { ...meta, login });
    this.user = uid;
    return uid;
  }
  async signIn(login: string, pw: string) {
    this.net();
    const u = this.c.users.get(login);
    if (!u || u.pw !== pw) throw new CloudFail('wrong');
    this.user = u.uid;
    return u.uid;
  }
  current() {
    return this.user;
  }
  async signOut() {
    this.user = null;
  }
  async getSave(uid: string) {
    this.net();
    if (this.user !== uid) throw new CloudFail('other', 'denied');
    const s = this.c.saves.get(uid);
    return s ? structuredClone(s) : null;
  }
  async putSave(uid: string, s: CloudSave) {
    this.net();
    if (this.user !== uid) throw new CloudFail('other', 'denied');
    this.c.saves.set(uid, structuredClone(s));
  }
  async putMeta(uid: string, meta: Partial<DuelistMeta & { login: string }>) {
    this.net();
    this.c.duelists.set(uid, { ...this.c.duelists.get(uid)!, ...meta });
  }
  async changePassword(pw: string) {
    this.net();
    for (const u of this.c.users.values()) if (u.uid === this.user) u.pw = pw;
  }
  async backup(id: string, e: BackupEntry) {
    this.net();
    this.c.backups.set(id, structuredClone(e));
  }
}

let clock = 1_000_000;
const now = () => (clock += 1000);
const g = globalThis as unknown as { localStorage: MemStore };

function phone(cloud: MemCloud | null, seed?: (st: MemStore) => void) {
  const st = new MemStore();
  st.setItem('eds.profiles', '[]');
  seed?.(st);
  const acc = new Accounts(cloud ? new MemBackend(cloud) : null, st, now);
  const use = () => (g.localStorage = st);
  return { st, acc, use };
}

/** a profile made before this update: list entry plus its four saves */
function oldProfile(st: MemStore, id: string, alias: string, chips: number) {
  const list = JSON.parse(st.getItem('eds.profiles')!) as Profile[];
  list.push({ id, name: alias, alias, color: '#d8453b', created: 5 });
  st.setItem('eds.profiles', JSON.stringify(list));
  st.setItem(`eds.save.${id}`, JSON.stringify({ version: 1, name: alias, wins: 7 }));
  st.setItem(`eds.speed.${id}`, JSON.stringify({ version: 1, decks: [], chips }));
  st.setItem(`eds.speedsolo.${id}`, JSON.stringify({ chapter: 3 }));
  st.setItem(`eds.online.${id}`, JSON.stringify({ code: 'ABC123', friends: [{ code: 'BRO456', name: 'Bro' }], ignored: [] }));
}

const chipsOf = (st: MemStore, id: string) => JSON.parse(st.getItem(`eds.speed.${id}`) ?? '{}').chips;

async function main() {
  // ---------- passwords ----------
  check(passwordProblem('1234') === null, 'a 4-digit PIN is a valid password');
  check(passwordProblem('123') !== null, 'three characters is too short');
  check(cloudPassword('1234').length >= 6, 'a PIN is stretched to the 6 characters the store needs');
  check(loginFor('Yugi') !== loginFor('Kaiba') && loginFor('Yugi') === loginFor(' yugi '), 'sign-in ids come from the duelist name, ignoring case and spaces');
  check(/^[^@\s]+@[^@\s]+\.[a-z]+$/.test(loginFor('Jöey Wheeler!')), 'odd names still make a valid sign-in id');

  const cloud = new MemCloud();

  // ---------- phone A: Jammy's profile from before the update ----------
  const A = phone(cloud, (st) => oldProfile(st, 'old1', 'Jammy', 21));
  A.use();
  const before = readBundle('old1', A.st);
  let tiles = await A.acc.tiles();
  check(tiles.length === 1 && tiles[0].kind === 'local' && tiles[0].firstTime, 'an old profile shows as first time since the update');
  check((await A.acc.backupAll()) === 1 && cloud.backups.get('old1')?.alias === 'Jammy', 'opening the updated game backs up the profile before anyone logs in');
  check(JSON.stringify(cloud.backups.get('old1')!.bundle) === JSON.stringify(before), 'the backup holds all four saves');
  check((await A.acc.backupAll()) === 0, 'an unchanged profile is not backed up twice');
  let p = loadProfiles()[0];
  let r = await A.acc.setFirstPassword(p, '1234');
  check(r.ok && r.note === 'moved' && !!r.p.uid, 'setting the first password moves the profile into a shared account');
  check(JSON.stringify(readBundle('old1', A.st)) === JSON.stringify(before), 'nothing on the phone changed: progress kept');
  const uid = r.ok ? r.p.uid! : '';
  check(JSON.stringify(cloud.saves.get(uid)?.bundle) === JSON.stringify(before), 'the account holds the same progress, friends included');
  check(cloud.duelists.get(uid)?.alias === 'Jammy', 'Jammy is on the shared duelist list');
  tiles = await A.acc.tiles();
  check(tiles.length === 1 && tiles[0].kind === 'local' && !tiles[0].firstTime, 'Jammy shows once, now with a password');
  p = loadProfiles()[0];
  check(!(await A.acc.logIn(p, '9999')).ok, 'a wrong password does not open it');
  check((await A.acc.logIn(p, '1234')).ok, 'the right password opens it');

  // ---------- phone B: Jammy logs in on another phone ----------
  const B = phone(cloud);
  B.use();
  tiles = await B.acc.tiles();
  const cloudTile = tiles.find((t) => t.kind === 'cloud');
  check(tiles.length === 1 && !!cloudTile, "phone B's opening page lists Jammy from the shared accounts");
  const d = cloudTile!.kind === 'cloud' ? cloudTile!.d : (null as never);
  check(!(await B.acc.logInCloud(d, '0000')).ok, 'a wrong password on phone B is refused');
  r = await B.acc.logInCloud(d, '1234');
  check(r.ok, 'the right password logs Jammy in on phone B');
  const pB = r.ok ? r.p : (null as never);
  check(JSON.stringify(readBundle(pB.id, B.st)) === JSON.stringify(before), 'all of Jammy\'s progress came to phone B');
  check(JSON.parse(B.st.getItem(`eds.online.${pB.id}`)!).code === 'ABC123', 'the friend code came along, so friends need no re-adding');
  tiles = await B.acc.tiles();
  check(tiles.length === 1 && tiles[0].kind === 'local', 'after that Jammy is a profile on phone B too');

  // playing on B, then the progress shows up on A
  B.acc.startSync(pB);
  B.st.setItem(`eds.speed.${pB.id}`, JSON.stringify({ version: 1, decks: [], chips: 25 }));
  await B.acc.stopSync();
  check(JSON.parse(cloud.saves.get(uid)!.bundle.speed!).chips === 25, 'progress made on phone B is uploaded when switching profile');
  A.use();
  r = await A.acc.logIn(loadProfiles()[0], '1234');
  check(r.ok && r.note === 'pulled' && chipsOf(A.st, 'old1') === 25, 'logging in on phone A brings the newer progress over');

  // A plays, B left behind, then B logs in: no conflict, B gets it
  A.acc.startSync(loadProfiles()[0]);
  A.st.setItem('eds.speed.old1', JSON.stringify({ version: 1, decks: [], chips: 28 }));
  await A.acc.flush();
  await A.acc.stopSync();
  B.use();
  r = await B.acc.logIn(loadProfiles()[0], '1234');
  check(r.ok && chipsOf(B.st, pB.id) === 28, 'phone B catches up the next time Jammy logs in there');

  // both phones changed: the account wins and the phone's copy is kept aside
  B.st.setItem(`eds.speed.${pB.id}`, JSON.stringify({ version: 1, decks: [], chips: 1 }));
  A.use();
  await A.acc.logIn(loadProfiles()[0], '1234');
  A.acc.startSync(loadProfiles()[0]);
  A.st.setItem('eds.speed.old1', JSON.stringify({ version: 1, decks: [], chips: 30 }));
  await A.acc.stopSync();
  B.use();
  await B.acc.logIn(loadProfiles()[0], '1234');
  check(chipsOf(B.st, pB.id) === 30 && B.st.getItem(`eds.conflict.${pB.id}`)?.includes('\\"chips\\":1') === true, 'when both phones changed, the account wins and the other copy is kept, not lost');

  // ---------- phone C: the brother has an old profile with a taken name ----------
  const C = phone(cloud, (st) => oldProfile(st, 'old2', 'jammy', 9));
  C.use();
  await C.acc.tiles();
  let pc = loadProfiles()[0];
  r = await C.acc.setFirstPassword(pc, 'kaiba1');
  check(!r.ok && r.why === 'taken', 'a name someone already moved is reported as taken');
  check(C.st.getItem('eds.speed.old2') !== null && loadProfiles().length === 1, 'the profile and its progress stay on the phone meanwhile');
  pc = loadProfiles()[0];
  r = await C.acc.setFirstPassword(pc, 'kaiba1', 'Bro');
  check(r.ok && r.note === 'moved' && r.p.alias === 'Bro', 'picking a new duelist name moves it');
  check(chipsOf(C.st, 'old2') === 9 && JSON.parse(C.st.getItem('eds.save.old2')!).name === 'Bro', 'its progress is intact and duels use the new name');
  check(cloud.duelists.size === 2, 'two duelists in the shared accounts now');

  // ---------- no signal ----------
  cloud.offline = true;
  pc = loadProfiles()[0];
  r = await C.acc.logIn(pc, 'kaiba1');
  check(r.ok && r.note === 'offline', 'with no signal the password this phone knows still opens the profile');
  check(!(await C.acc.logIn(pc, 'nope11')).ok, 'with no signal a wrong password is still refused');
  const D = phone(cloud, (st) => oldProfile(st, 'old3', 'Mai', 4));
  D.use();
  tiles = await D.acc.tiles();
  check(D.acc.state === 'offline' && tiles.length === 1, 'out of reach, the page shows this phone\'s duelists');
  r = await D.acc.setFirstPassword(loadProfiles()[0], 'harpie');
  check(r.ok && r.note === 'offline' && !r.p.uid, 'a first password set offline keeps the profile on the phone for now');
  cloud.offline = false;
  r = await D.acc.logIn(loadProfiles()[0], 'harpie');
  check(r.ok && r.note === 'moved' && !!r.p.uid, 'the next login with signal moves it into an account');

  // a move cut off right after the account was made: the next login reuses it, no duplicate
  const F = phone(cloud, (st) => oldProfile(st, 'old4', 'Tea', 2));
  F.use();
  await F.acc.tiles();
  const fb = (F.acc as unknown as { backend: MemBackend }).backend;
  const realPut = fb.putSave.bind(fb);
  fb.putSave = async () => {
    throw new CloudFail('offline');
  };
  const fbCreate = fb.create.bind(fb);
  fb.create = async (login, pw, meta) => {
    await fbCreate(login, pw, meta);
    cloud.duelists.delete(fb.user!); // the listing write was lost too
    throw new CloudFail('offline');
  };
  r = await F.acc.setFirstPassword(loadProfiles()[0], 'friend');
  check(r.ok && r.note === 'offline' && !r.p.uid, 'a move cut off after the account was made keeps the profile on the phone');
  fb.create = fbCreate;
  fb.putSave = realPut;
  const usersBefore = cloud.users.size;
  r = await F.acc.logIn(loadProfiles()[0], 'friend');
  check(r.ok && r.note === 'moved' && cloud.users.size === usersBefore && cloud.duelists.get(r.p.uid!)?.alias === 'Tea', 'the next login finishes the move into that same account, listed, with no duplicate');
  check(JSON.parse(cloud.saves.get(r.ok ? r.p.uid! : '')!.bundle.speed!).chips === 2, 'and uploads its progress');

  // ---------- brand-new duelist ----------
  r = await D.acc.create('Bro', 'abcd');
  check(!r.ok && r.why === 'taken', 'a new duelist cannot take an existing name');
  r = await D.acc.create('Joey', 'abcd');
  check(r.ok && r.note === 'moved' && cloud.duelists.get(r.p.uid!)?.alias === 'Joey', 'a new duelist gets a name, a password and a shared account');

  // ---------- rename and new password ----------
  C.use();
  pc = loadProfiles()[0];
  await C.acc.logIn(pc, 'kaiba1');
  r = await C.acc.rename(pc, 'Seto');
  check(r.ok && cloud.duelists.get(pc.uid!)?.alias === 'Seto', 'a rename shows on the shared page');
  r = await C.acc.changePassword(loadProfiles()[0], 'blue-eyes');
  check(r.ok && !(await C.acc.logIn(loadProfiles()[0], 'kaiba1')).ok && (await C.acc.logIn(loadProfiles()[0], 'blue-eyes')).ok, 'a new password replaces the old one');
  const E = phone(cloud);
  E.use();
  const seto = (await E.acc.tiles()).find((t) => t.kind === 'cloud' && t.d.alias === 'Seto');
  check(!!seto && seto.kind === 'cloud' && (await E.acc.logInCloud(seto.d, 'blue-eyes')).ok, 'the renamed duelist logs in elsewhere with the new password');

  // ---------- removing from a phone keeps the account ----------
  B.use();
  const pb = loadProfiles()[0];
  B.acc.remove(pb);
  check(loadProfiles().length === 0 && B.st.getItem(`eds.speed.${pb.id}`) === null, 'Remove takes the profile off the phone');
  check(cloud.saves.has(pb.uid!) && (await B.acc.tiles()).some((t) => t.kind === 'cloud' && t.d.uid === pb.uid), 'the account and its progress stay, ready to log in again');

  // ---------- no shared store configured ----------
  const L = phone(null, (st) => oldProfile(st, 'old9', 'Solo', 3));
  L.use();
  tiles = await L.acc.tiles();
  check(L.acc.state === 'off' && tiles.length === 1 && tiles[0].kind === 'local' && tiles[0].firstTime, 'without the shared store, profiles stay on the phone');
  r = await L.acc.setFirstPassword(loadProfiles()[0], '4321');
  check(r.ok && !r.p.uid && chipsOf(L.st, 'old9') === 3, 'a password can still be set and the progress stays');
  check(!(await L.acc.logIn(loadProfiles()[0], '1111')).ok && (await L.acc.logIn(loadProfiles()[0], '4321')).ok, 'and it guards the profile');
  check(!(L.st.getItem('eds.locks') ?? '').includes('4321'), 'the password itself is never stored');

  console.log(failures ? `\n${failures} FAILED` : '\nall account checks passed');
  process.exit(failures ? 1 : 0);
}

void main();
