// "Which duelist are you?": one shared page of duelists, then each logs in to their own
// profile with a password. A profile that was on this phone before accounts existed sets its
// password the first time it's picked, and keeps every bit of its progress (see src/accounts).
import { useEffect, useState } from 'preact/hooks';
import { ALIAS_MAX, loadSave, totalCards, type Profile } from '../eds/save';
import { accounts, type LoginResult, type Tile } from '../accounts';
import type { CloudDuelist } from '../accounts/backend';
import { PASSWORD_MAX, passwordProblem } from '../accounts/passwords';
import { Overlay, Win } from './Window';
import { playBlip, unlockAudio } from './sound';

export function Avatar({ p, size = 'big' }: { p: Pick<Profile, 'alias' | 'color'>; size?: 'big' | 'small' }) {
  return (
    <span class={`pavatar ${size}`} style={{ background: p.color }} aria-hidden="true">
      {(p.alias.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

type Sheet = { kind: 'login'; tile: Tile } | { kind: 'add' } | { kind: 'unlock'; p: Profile } | { kind: 'edit'; p: Profile };

export function ProfilePicker({ onPick, joining }: { onPick: (p: Profile) => void; joining?: string | null }) {
  const [tiles, setTiles] = useState<Tile[]>(() => accounts.localTiles());
  const [loading, setLoading] = useState(!!accounts.backend);
  const [manage, setManage] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(() => (accounts.localTiles().length === 0 && !accounts.backend ? { kind: 'add' } : null));

  const refresh = () => {
    setTiles(accounts.localTiles());
    void accounts.tiles().then((t) => {
      setTiles(t);
      setLoading(false);
    });
  };

  useEffect(() => {
    let live = true;
    void accounts.tiles().then((t) => {
      if (!live) return;
      setTiles(t);
      setLoading(false);
      if (t.length === 0) setSheet((s) => s ?? { kind: 'add' });
    });
    void accounts.backupAll();
    return () => {
      live = false;
    };
  }, []);

  const shown = manage ? tiles.filter((t) => t.kind === 'local') : tiles;

  const tap = (t: Tile) => {
    unlockAudio();
    playBlip();
    if (!manage) return setSheet({ kind: 'login', tile: t });
    if (t.kind !== 'local') return;
    setSheet(t.firstTime ? { kind: 'edit', p: t.p } : { kind: 'unlock', p: t.p });
  };

  const done = (p: Profile) => {
    accounts.startSync(p);
    onPick(p);
  };

  const state = accounts.state;
  return (
    <div class="screen profiles">
      <h1 class="who">{manage ? 'Manage Profiles' : 'Which duelist are you?'}</h1>
      {joining && !manage && <p class="who-sub">Log in to join room {joining}</p>}
      {!manage && state === 'on' && <p class="who-sub">Log in from any phone with your password.</p>}
      {!manage && state === 'offline' && <p class="who-sub warn">Can't reach the shared accounts. Showing this phone's duelists.</p>}
      <div class="ptiles">
        {shown.map((t) => {
          const p = t.kind === 'local' ? t.p : t.d;
          return (
            <button key={t.kind === 'local' ? t.p.id : t.d.uid} class={`ptile ${manage ? 'editing' : ''}`} onClick={() => tap(t)}>
              <span class="pav-wrap">
                <Avatar p={p} />
                {manage && <span class="pedit">✎</span>}
                {!manage && t.kind === 'local' && t.firstTime && <span class="pbadge new">NEW</span>}
                {!manage && (t.kind === 'cloud' || !t.firstTime) && (
                  <span class="pbadge lock" aria-label="Password">
                    🔒
                  </span>
                )}
              </span>
              <span class="palias">{p.alias}</span>
              {t.kind === 'cloud' ? <span class="pname">another phone</span> : p.name !== p.alias && <span class="pname">{p.name}</span>}
            </button>
          );
        })}
        {!manage && (
          <button class="ptile add" onClick={() => (playBlip(), setSheet({ kind: 'add' }))}>
            <span class="pav-wrap">
              <span class="pavatar big plus">+</span>
            </span>
            <span class="palias">New Duelist</span>
          </button>
        )}
      </div>
      {loading && !manage && <p class="who-sub">Looking for duelists…</p>}
      {tiles.some((t) => t.kind === 'local') && (
        <button class={`gbtn pmanage ${manage ? 'done' : ''}`} onClick={() => setManage(!manage)}>
          {manage ? 'Done' : 'Manage Profiles'}
        </button>
      )}
      {manage && <p class="who-sub">Tap a profile to rename it, change its password or take it off this phone.</p>}
      {sheet?.kind === 'login' && <LoginSheet tile={sheet.tile} onClose={() => setSheet(null)} onDone={done} />}
      {sheet?.kind === 'add' && <AddSheet canClose={tiles.length > 0} onClose={() => setSheet(null)} onDone={done} />}
      {sheet?.kind === 'unlock' && (
        <LoginSheet
          tile={{ kind: 'local', p: sheet.p, firstTime: false }}
          title="Manage Profile"
          onClose={() => setSheet(null)}
          onDone={(p) => {
            accounts.startSync(p);
            setSheet({ kind: 'edit', p });
          }}
        />
      )}
      {sheet?.kind === 'edit' && (
        <EditSheet
          p={sheet.p}
          onClose={() => {
            void accounts.stopSync();
            setSheet(null);
            refresh();
          }}
          onRemoved={() => {
            void accounts.stopSync();
            setSheet(null);
            const left = accounts.localTiles();
            if (left.length === 0) setManage(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function PwField({ label, value, onInput, autoFocus, fresh }: { label: string; value: string; onInput: (v: string) => void; autoFocus?: boolean; fresh?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <label class="pfield">
      <span>{label}</span>
      <span class="pw-row">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          maxLength={PASSWORD_MAX}
          autoComplete={fresh ? 'new-password' : 'current-password'}
          autoFocus={autoFocus}
          onInput={(ev) => onInput((ev.target as HTMLInputElement).value)}
        />
        <button type="button" class="pw-eye" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}>
          {show ? 'Hide' : 'Show'}
        </button>
      </span>
    </label>
  );
}

function LoginSheet({ tile, title, onClose, onDone }: { tile: Tile; title?: string; onClose: () => void; onDone: (p: Profile) => void }) {
  const firstTime = tile.kind === 'local' && tile.firstTime;
  const who: Pick<Profile, 'alias' | 'color'> = tile.kind === 'local' ? tile.p : tile.d;
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [rename, setRename] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: Event) => {
    ev.preventDefault();
    if (busy) return;
    if (firstTime) {
      const bad = passwordProblem(pw);
      if (bad) return setErr(bad);
      if (pw !== pw2) return setErr("The two passwords don't match.");
    }
    if (rename !== null && !rename.trim()) return setErr('Pick a duelist name.');
    setBusy(true);
    setErr(null);
    let r: LoginResult;
    if (tile.kind === 'cloud') r = await accounts.logInCloud(tile.d as CloudDuelist, pw);
    else if (firstTime || rename !== null) r = await accounts.setFirstPassword(tile.p, pw, rename ?? undefined);
    else r = await accounts.logIn(tile.p, pw);
    setBusy(false);
    if (r.ok) return onDone(r.p);
    if (r.why === 'taken') setRename((n) => n ?? '');
    setErr(r.message);
  };

  const heading = title ?? (firstTime ? 'Set your password' : 'Enter password');
  return (
    <Overlay onClose={busy ? undefined : onClose}>
      <Win title={heading} onClose={busy ? undefined : onClose}>
        <form class="pform" onSubmit={submit}>
          <div class="pform-head">
            <Avatar p={who} />
            <div>
              <b class="pform-who">{who.alias}</b>
              {firstTime ? (
                <p class="hint">First time since the update! Set a password so only you can open this profile. Your cards, chips and progress all stay.</p>
              ) : tile.kind === 'cloud' ? (
                <p class="hint">Log in and your progress comes to this phone too.</p>
              ) : (
                <p class="hint">Enter your password.</p>
              )}
            </div>
          </div>
          {rename !== null && (
            <label class="pfield">
              <span>New duelist name</span>
              <input value={rename} maxLength={ALIAS_MAX} placeholder="Yugi" autoComplete="off" onInput={(ev) => (setRename((ev.target as HTMLInputElement).value), setErr(null))} />
            </label>
          )}
          <PwField label={firstTime ? 'New password (4 or more characters)' : 'Password'} value={pw} onInput={(v) => (setPw(v), setErr(null))} autoFocus fresh={firstTime} />
          {firstTime && <PwField label="Type it again" value={pw2} onInput={(v) => (setPw2(v), setErr(null))} fresh />}
          {err && <p class="err">{err}</p>}
          <div class="pbtns">
            <button type="submit" class="gbtn" disabled={busy || !pw}>
              {busy ? 'One moment…' : firstTime ? 'Set password' : 'Log in'}
            </button>
          </div>
        </form>
      </Win>
    </Overlay>
  );
}

function AddSheet({ canClose, onClose, onDone }: { canClose: boolean; onClose: () => void; onDone: (p: Profile) => void }) {
  const [alias, setAlias] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: Event) => {
    ev.preventDefault();
    if (busy) return;
    if (!alias.trim()) return setErr('Pick a duelist name.');
    const bad = passwordProblem(pw);
    if (bad) return setErr(bad);
    if (pw !== pw2) return setErr("The two passwords don't match.");
    setBusy(true);
    const r = await accounts.create(alias, pw);
    setBusy(false);
    if (r.ok) onDone(r.p);
    else setErr(r.message);
  };

  const close = canClose && !busy ? onClose : undefined;
  return (
    <Overlay onClose={close}>
      <Win title="New Duelist" onClose={close}>
        <form class="pform" onSubmit={submit}>
          <div class="pform-head">
            <Avatar p={{ alias: alias || '?', color: '#3a4a8a' }} />
            <p class="hint">Pick your duelist name and a little password. You'll use them to log in from any phone.</p>
          </div>
          <label class="pfield">
            <span>Duelist name (shown in duels)</span>
            <input value={alias} maxLength={ALIAS_MAX} placeholder="Yugi" autoComplete="off" onInput={(ev) => (setAlias((ev.target as HTMLInputElement).value), setErr(null))} />
          </label>
          <PwField label="Password (4 or more characters)" value={pw} onInput={(v) => (setPw(v), setErr(null))} fresh />
          <PwField label="Type it again" value={pw2} onInput={(v) => (setPw2(v), setErr(null))} fresh />
          {err && <p class="err">{err}</p>}
          <div class="pbtns">
            <button type="submit" class="gbtn" disabled={busy || !alias.trim() || !pw}>
              {busy ? 'One moment…' : 'Create'}
            </button>
          </div>
        </form>
      </Win>
    </Overlay>
  );
}

function EditSheet({ p, onClose, onRemoved }: { p: Profile; onClose: () => void; onRemoved: () => void }) {
  const [alias, setAlias] = useState(p.alias);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const shared = !!p.uid;

  const submit = async (ev: Event) => {
    ev.preventDefault();
    if (busy) return;
    if (!alias.trim()) return setErr('Pick a duelist name.');
    if (pw) {
      const bad = passwordProblem(pw);
      if (bad) return setErr(bad);
      if (pw !== pw2) return setErr("The two passwords don't match.");
    }
    setBusy(true);
    let cur = p;
    if (alias.trim() !== p.alias) {
      const r = await accounts.rename(p, alias);
      if (!r.ok) return setBusy(false), setErr(r.message);
      cur = r.p;
    }
    if (pw) {
      const r = await accounts.changePassword(cur, pw);
      if (!r.ok) return setBusy(false), setErr(r.message);
    }
    setBusy(false);
    onClose();
  };

  if (confirmDel) {
    const s = loadSave(p.id);
    return (
      <Overlay onClose={() => setConfirmDel(false)}>
        <Win title={shared ? 'Remove from this phone?' : 'Delete profile?'} onClose={() => setConfirmDel(false)}>
          <div class="pconfirm">
            <Avatar p={p} size="small" />
            {shared ? (
              <p>
                Take <b>{p.alias}</b> off this phone? Their progress stays in their account, so they can log in again here or on any phone.
              </p>
            ) : (
              <p>
                Delete <b>{p.alias}</b>?{s ? ` Their ${totalCards(s)} cards, decks and record (W ${s.wins} L ${s.losses} D ${s.draws}) will be gone for good.` : ' This cannot be undone.'}
              </p>
            )}
          </div>
          <div class="pbtns">
            <button class="gbtn" onClick={() => setConfirmDel(false)}>
              Keep it
            </button>
            <button
              class="gbtn end"
              onClick={() => {
                accounts.remove(p);
                onRemoved();
              }}
            >
              {shared ? 'Remove' : 'Delete'}
            </button>
          </div>
        </Win>
      </Overlay>
    );
  }

  return (
    <Overlay onClose={busy ? undefined : onClose}>
      <Win title="Edit Profile" onClose={busy ? undefined : onClose}>
        <form class="pform" onSubmit={submit}>
          <div class="pform-head">
            <Avatar p={{ alias: alias || '?', color: p.color }} />
            <p class="hint">{shared ? 'Changes show on every phone.' : 'Saved on this phone.'}</p>
          </div>
          <label class="pfield">
            <span>Duelist name (shown in duels)</span>
            <input value={alias} maxLength={ALIAS_MAX} autoComplete="off" onInput={(ev) => (setAlias((ev.target as HTMLInputElement).value), setErr(null))} />
          </label>
          <PwField label="New password (leave empty to keep it)" value={pw} onInput={(v) => (setPw(v), setErr(null))} fresh />
          {pw && <PwField label="Type it again" value={pw2} onInput={(v) => (setPw2(v), setErr(null))} fresh />}
          {err && <p class="err">{err}</p>}
          <div class="pbtns">
            <button type="button" class="gbtn end" onClick={() => setConfirmDel(true)}>
              {shared ? 'Remove' : 'Delete'}
            </button>
            <button type="submit" class="gbtn" disabled={busy || !alias.trim()}>
              {busy ? 'One moment…' : 'Save'}
            </button>
          </div>
        </form>
      </Win>
    </Overlay>
  );
}
