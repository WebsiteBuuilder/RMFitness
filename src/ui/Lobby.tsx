import { useState } from 'preact/hooks';
import type { Session, SessionView } from '../game/session';
import type { CardRef, DeckList, PlayerId } from '../game/types';
import { STARTER_DECKS } from '../data/starterDecks';
import { cardByName, resolveDeck } from '../data/cards';
import { randomSeed } from '../game/rng';

function DeckPicker({ seat, name, onReady }: { seat: PlayerId; name: string; onReady: (deck: DeckList, skill: CardRef | null, name: string) => void }) {
  const [deckIdx, setDeckIdx] = useState(0);
  const [skillIdx, setSkillIdx] = useState(0);
  const [playerName, setPlayerName] = useState(name);
  const deck = STARTER_DECKS[deckIdx];
  const skill = skillIdx < 0 ? null : deck.skills[skillIdx];
  const skillData = skill ? cardByName(skill.name) : undefined;
  return (
    <div class="picker">
      <div class="picker-seat">Player {seat + 1}</div>
      <label class="field">
        <span>Name</span>
        <input value={playerName} maxLength={16} onInput={(e) => setPlayerName((e.target as HTMLInputElement).value)} />
      </label>
      <div class="field">
        <span>Deck</span>
        <div class="deck-list">
          {STARTER_DECKS.map((d, i) => (
            <button key={d.title} class={`deck-btn ${i === deckIdx ? 'on' : ''}`} onClick={() => (setDeckIdx(i), setSkillIdx(0))}>
              <b>{d.character}</b>
              <small>{d.title.replace(/.*\((.*)\)/, '$1')} · {d.main.length} cards{d.extra.length ? ` + ${d.extra.length} Extra` : ''}</small>
            </button>
          ))}
        </div>
      </div>
      <div class="field">
        <span>Skill (face-down, flip when its condition is met)</span>
        <div class="skill-row">
          {deck.skills.map((s, i) => (
            <button key={s.name} class={`chip ${i === skillIdx ? 'on' : ''}`} onClick={() => setSkillIdx(i)}>
              {s.name}
            </button>
          ))}
          <button class={`chip ${skillIdx < 0 ? 'on' : ''}`} onClick={() => setSkillIdx(-1)}>
            No Skill
          </button>
        </div>
        {skillData && <p class="skill-text">{skillData.desc}</p>}
      </div>
      <button class="big-btn primary" onClick={() => onReady(resolveDeck(deck), skill ? { name: skill.name, id: cardByName(skill.name)?.id ?? null } : null, playerName || `Player ${seat + 1}`)}>
        Ready
      </button>
    </div>
  );
}

export function Lobby({ session, view, mySeat, hotseat, myName, onLeave }: { session: Session; view: SessionView; mySeat: PlayerId; hotseat: boolean; myName: string; onLeave: () => void }) {
  const { state, status, detail } = view;
  const code = session.adapter.roomCode;
  const bothReady = state.players[0].ready && state.players[1].ready;
  const seatsToPick: PlayerId[] = hotseat ? ([0, 1] as PlayerId[]).filter((s) => !state.players[s].ready) : state.players[mySeat].ready ? [] : [mySeat];

  const start = () => {
    session.send({ type: 'START', first: Math.random() < 0.5 ? 0 : 1, seed: randomSeed() });
  };

  return (
    <div class="lobby">
      <div class="lobby-head">
        <button class="icon-btn" onClick={onLeave} aria-label="Back">
          ‹
        </button>
        <div>
          {code ? (
            <>
              <div class="room-code">Room {code}</div>
              <div class={`status status-${status}`}>{detail}</div>
            </>
          ) : (
            <div class="room-code">Hotseat</div>
          )}
        </div>
      </div>
      {code && session.adapter.isHost && status === 'waiting' && (
        <div class="share-box">
          Tell your brother the code <b>{code}</b>, or send this link:
          <button class="chip" onClick={() => void navigator.clipboard?.writeText(`${location.origin}${location.pathname}?join=${code}`)}>
            Copy invite link
          </button>
        </div>
      )}
      <div class="ready-row">
        {([0, 1] as PlayerId[]).map((s) => (
          <div key={s} class={`ready-pill ${state.players[s].ready ? 'on' : ''}`}>
            {state.players[s].ready ? `${state.players[s].name} ✓` : `Player ${s + 1}: choosing…`}
          </div>
        ))}
      </div>
      {seatsToPick.slice(0, 1).map((s) => (
        <DeckPicker
          key={s}
          seat={s}
          name={hotseat ? (s === 0 ? myName : '') : myName}
          onReady={(deck, skill, name) => session.send({ type: 'JOIN', player: s, name, deck, skill })}
        />
      ))}
      {bothReady && (session.adapter.isHost ? (
        <button class="big-btn primary start-btn" onClick={start}>
          Start Duel (coin flip)
        </button>
      ) : (
        <p class="home-note">Waiting for the host to start the duel…</p>
      ))}
    </div>
  );
}
