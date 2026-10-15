# Shared duelist accounts

The opening page asks "Which duelist are you?". Each duelist logs in with a password.
Profiles that were on a phone before this update keep everything: the first time one is
tapped, its owner sets a password and it moves into a shared account with all its progress
(cards, Duel Chips, decks, campaigns, card levels, friend code and friends).

Without a Firebase config the passwords and profiles stay on each phone. With one, every
account works from any phone, and each phone backs up its profiles that have not moved yet.

## Turning on shared accounts (free, about 5 minutes)

1. Go to https://console.firebase.google.com, sign in with a Google account, **Create a project** (any name, Analytics off).
2. **Build → Authentication → Get started**. Under *Sign-in method* turn on **Email/Password** and **Anonymous**.
3. **Build → Realtime Database → Create database**, pick a location, *Start in locked mode*. Open the **Rules** tab, paste the contents of `database.rules.json` from this repo, **Publish**.
4. **Project settings (gear) → Your apps → Web (`</>`)**, register an app (no hosting). Copy the `firebaseConfig` object it shows.
5. Paste that object into `src/sync/firebaseConfig.ts` (or into the project thread and Claude will do it).

The config values are public by design; the database rules decide who can read what:
anyone can see the list of duelist names, only a duelist can read or write their own progress.

## Where things are

- `src/accounts/accounts.ts` login, first-password move, sync between phone and account, backups
- `src/accounts/firebaseBackend.ts` the Firebase store; `backend.ts` the interface it fills
- `src/ui/Profiles.tsx` the "Which duelist are you?" page
- Every profile backup is in the Firebase console under Realtime Database → `backups`; accounts under `duelists` and `saves`.

Forgotten password: delete the user in Firebase Authentication and the `duelists/<uid>` entry; the profile can then be
made again (its progress is still in `saves/<uid>` and can be copied over).
