import { useState } from 'preact/hooks';
import { LocalAdapter } from '../sync/local';
import { FirebaseAdapter } from '../sync/firebase';
import { newRoomCode } from '../sync/types';

export type StartChoice =
  | { mode: 'hotseat'; resume: boolean }
  | { mode: 'host'; code: string }
  | { mode: 'join'; code: string };

export function Home({ name, setName, onStart }: { name: string; setName: (n: string) => void; onStart: (c: StartChoice) => void }) {
  const [code, setCode] = useState('');
  const canResume = LocalAdapter.hasSave();
  const transport = FirebaseAdapter.available() ? 'Firebase' : 'direct phone-to-phone connection';
  return (
    <div class="home">
      <div class="home-logo">
        <div class="home-title">Speed Duel</div>
        <div class="home-sub">ONLINE</div>
      </div>
      <label class="field">
        <span>Your name</span>
        <input value={name} maxLength={16} placeholder="Duelist" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </label>
      <div class="home-buttons">
        <button class="big-btn primary" onClick={() => onStart({ mode: 'host', code: newRoomCode() })}>
          Create online room
        </button>
        <div class="join-row">
          <input
            class="code-input"
            value={code}
            maxLength={4}
            placeholder="CODE"
            autoCapitalize="characters"
            onInput={(e) => setCode((e.target as HTMLInputElement).value.toUpperCase().replace(/[^A-Z]/g, ''))}
          />
          <button class="big-btn" disabled={code.length !== 4} onClick={() => onStart({ mode: 'join', code })}>
            Join room
          </button>
        </div>
        <button class="big-btn" onClick={() => onStart({ mode: 'hotseat', resume: false })}>
          Play on this device (hotseat)
        </button>
        {canResume && (
          <button class="big-btn ghost" onClick={() => onStart({ mode: 'hotseat', resume: true })}>
            Resume last hotseat duel
          </button>
        )}
      </div>
      <p class="home-note">Online rooms use a {transport}. Both players open this page, one creates a room and the other types the 4-letter code.</p>
    </div>
  );
}
