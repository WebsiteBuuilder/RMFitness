// "Who's dueling?": pick, add, rename or delete a profile. Each profile keeps
// its own save (cards, decks, record) on this device. No passwords.
import { useState } from 'preact/hooks';
import { ALIAS_MAX, MAX_PROFILES, NAME_MAX, createProfile, deleteProfile, loadProfiles, loadSave, totalCards, updateProfile, type Profile } from '../eds/save';
import { Overlay, Win } from './Window';
import { playBlip, unlockAudio } from './sound';

export function Avatar({ p, size = 'big' }: { p: Pick<Profile, 'alias' | 'color'>; size?: 'big' | 'small' }) {
  return (
    <span class={`pavatar ${size}`} style={{ background: p.color }} aria-hidden="true">
      {(p.alias.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

type Form = { kind: 'add' } | { kind: 'edit'; p: Profile };

export function ProfilePicker({ onPick, joining }: { onPick: (p: Profile) => void; joining?: string | null }) {
  const [list, setList] = useState<Profile[]>(() => loadProfiles());
  const [manage, setManage] = useState(false);
  const [form, setForm] = useState<Form | null>(() => (loadProfiles().length === 0 ? { kind: 'add' } : null));
  const refresh = () => setList(loadProfiles());
  const full = list.length >= MAX_PROFILES;

  const tap = (p: Profile) => {
    unlockAudio();
    playBlip();
    if (manage) setForm({ kind: 'edit', p });
    else onPick(p);
  };

  return (
    <div class="screen profiles">
      <h1 class="who">{manage ? 'Manage Profiles' : "Who's dueling?"}</h1>
      {joining && !manage && <p class="who-sub">Pick a profile to join room {joining}</p>}
      <div class="ptiles">
        {list.map((p) => (
          <button key={p.id} class={`ptile ${manage ? 'editing' : ''}`} onClick={() => tap(p)}>
            <span class="pav-wrap">
              <Avatar p={p} />
              {manage && <span class="pedit">✎</span>}
            </span>
            <span class="palias">{p.alias}</span>
            <span class="pname">{p.name}</span>
          </button>
        ))}
        {!manage && !full && (
          <button class="ptile add" onClick={() => (playBlip(), setForm({ kind: 'add' }))}>
            <span class="pav-wrap">
              <span class="pavatar big plus">+</span>
            </span>
            <span class="palias">Add Profile</span>
          </button>
        )}
      </div>
      {!manage && full && <p class="who-sub">This phone holds up to {MAX_PROFILES} profiles.</p>}
      {list.length > 0 && (
        <button class={`gbtn pmanage ${manage ? 'done' : ''}`} onClick={() => setManage(!manage)}>
          {manage ? 'Done' : 'Manage Profiles'}
        </button>
      )}
      {manage && <p class="who-sub">Tap a profile to rename or delete it.</p>}
      {form && (
        <ProfileForm
          form={form}
          list={list}
          onClose={() => setForm(null)}
          onSaved={(p) => {
            setForm(null);
            refresh();
            if (form.kind === 'add') onPick(p);
          }}
          onDeleted={() => {
            setForm(null);
            const left = loadProfiles();
            setList(left);
            if (left.length === 0) setManage(false);
          }}
        />
      )}
    </div>
  );
}

function ProfileForm({ form, list, onClose, onSaved, onDeleted }: { form: Form; list: Profile[]; onClose: () => void; onSaved: (p: Profile) => void; onDeleted: () => void }) {
  const editing = form.kind === 'edit' ? form.p : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [alias, setAlias] = useState(editing?.alias ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  // Closing is only allowed when there is somewhere to go back to.
  const canClose = list.length > 0;

  const submit = (ev: Event) => {
    ev.preventDefault();
    const a = alias.trim();
    if (!a) return setErr('Pick a Duel Alias.');
    if (list.some((p) => p.id !== editing?.id && p.alias.toLowerCase() === a.toLowerCase())) return setErr(`${a} is already taken on this phone.`);
    const p = editing ? updateProfile(editing.id, name, a) : createProfile(name, a);
    if (!p) return setErr(`This phone holds up to ${MAX_PROFILES} profiles.`);
    onSaved(p);
  };

  if (editing && confirmDel) {
    const s = loadSave(editing.id);
    return (
      <Overlay onClose={() => setConfirmDel(false)}>
        <Win title="Delete profile?" onClose={() => setConfirmDel(false)}>
          <div class="pconfirm">
            <Avatar p={editing} size="small" />
            <p>
              Delete <b>{editing.alias}</b>
              {editing.name !== editing.alias ? ` (${editing.name})` : ''}?
              {s ? ` Their ${totalCards(s)} cards, decks and record (W ${s.wins} L ${s.losses} D ${s.draws}) will be gone for good.` : ' This cannot be undone.'}
            </p>
          </div>
          <div class="pbtns">
            <button class="gbtn" onClick={() => setConfirmDel(false)}>
              Keep it
            </button>
            <button
              class="gbtn end"
              onClick={() => {
                deleteProfile(editing.id);
                onDeleted();
              }}
            >
              Delete
            </button>
          </div>
        </Win>
      </Overlay>
    );
  }

  return (
    <Overlay onClose={canClose ? onClose : undefined}>
      <Win title={editing ? 'Edit Profile' : 'Add Profile'} onClose={canClose ? onClose : undefined}>
        <form class="pform" onSubmit={submit}>
          <div class="pform-head">
            <Avatar p={{ alias: alias || '?', color: editing?.color ?? '#3a4a8a' }} />
            {!editing && <p class="hint">No password needed. Just tell us who you are.</p>}
          </div>
          <label class="pfield">
            <span>Your name</span>
            <input value={name} maxLength={NAME_MAX} placeholder="Name" autoComplete="off" onInput={(ev) => setName((ev.target as HTMLInputElement).value)} />
          </label>
          <label class="pfield">
            <span>Duel Alias (shown in duels)</span>
            <input value={alias} maxLength={ALIAS_MAX} placeholder="Yugi" autoComplete="off" onInput={(ev) => (setAlias((ev.target as HTMLInputElement).value), setErr(null))} />
          </label>
          {err && <p class="err">{err}</p>}
          <div class="pbtns">
            {editing && (
              <button type="button" class="gbtn end" onClick={() => setConfirmDel(true)}>
                Delete
              </button>
            )}
            <button type="submit" class="gbtn" disabled={!alias.trim()}>
              {editing ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </Win>
    </Overlay>
  );
}
