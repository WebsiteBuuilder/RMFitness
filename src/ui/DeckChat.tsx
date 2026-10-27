// Deck chat: talk to Claude in the Speed Duel deck editor. It builds whole decks from the
// cards you own, makes the edits you ask for and answers questions about cards and rules.
// Changes land in the deck straight away, each with its own Undo. The chat sits over the
// card list so the deck stays in view above it.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SpeedDeck } from '../eds/speedSave';
import { chatError, claudeModel, runTurn, type Model, type Msg } from '../deckchat/agent';
import { diffDecks, diffEmpty, type DeckDiff } from '../deckchat/tools';
import { chatKey, looksLikeKey, setChatKey } from '../deckchat/key';
import { buzz, playBlip } from './sound';
import './deckchat.css';

interface Turn {
  id: number;
  who: 'me' | 'claude' | 'note';
  text: string;
  /** what this answer changed, and the deck before it (for Undo) */
  diff?: DeckDiff;
  before?: SpeedDeck;
  undone?: boolean;
}

interface Chat {
  messages: Msg[];
  turns: Turn[];
}

/** Chats per deck, kept while the game is open (closing the chat doesn't lose it). */
const chats = new Map<string, Chat>();

const TOOL_LABEL: Record<string, string> = {
  view_deck: 'Reading your deck',
  collection_overview: 'Looking through your cards',
  search_cards: 'Searching cards',
  get_cards: 'Reading card text',
  list_skills: 'Checking Skills',
  edit_deck: 'Changing the deck',
};

const IDEAS_EMPTY = ['Build me the strongest deck you can from my cards', 'Make a Dragon deck', 'Build a deck around my best monster', 'What deck can I make?'];
const IDEAS_DECK = ['Make this deck stronger', 'What does my Skill do?', 'Swap weak monsters for better ones', 'Is this deck good? Be honest'];

const bare = (n: string) => n.replace(/ \(Skill Card\)$/, '');

/** Only for tests and screenshots: a model to use instead of Claude (window.__deckChatModel). */
const testModel = () => (globalThis as { __deckChatModel?: Model }).__deckChatModel;

export function DeckChat({ deck, collection, onChange, onRead, onClose }: { deck: SpeedDeck; collection?: Record<string, number>; onChange: (d: SpeedDeck) => void; onRead: (name: string) => void; onClose: () => void }) {
  const [chat, setChatState] = useState<Chat>(() => chats.get(deck.id) ?? { messages: [], turns: [] });
  const setChat = (c: Chat) => (chats.set(deck.id, c), setChatState(c));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [live, setLive] = useState('');
  const [key, setKey] = useState(chatKey);
  const [keyOpen, setKeyOpen] = useState(!chatKey() && !testModel());
  const [tall, setTall] = useState(false);
  const stop = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const deckRef = useRef(deck);
  deckRef.current = deck;
  // the newest onChange: the turn runs across renders and must not save into an old copy
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.turns.length, live, busy]);
  useEffect(() => () => stop.current?.abort(), []);

  const send = async (raw: string) => {
    const msg = raw.trim();
    if (!msg || busy) return;
    const model = testModel() ?? (key ? claudeModel(key) : null);
    if (!model) return setKeyOpen(true);
    playBlip();
    setText('');
    const before = deckRef.current;
    let turns: Turn[] = [...chat.turns, { id: Date.now(), who: 'me', text: msg }];
    setChat({ ...chat, turns });
    setBusy('Thinking');
    setLive('');
    const ac = new AbortController();
    stop.current = ac;
    try {
      const r = await runTurn(model, chat.messages, msg, { deck: before, collection }, {
        signal: ac.signal,
        onText: (d) => (setLive((t) => t + d), setBusy(null)),
        onTool: (n) => (setBusy(TOOL_LABEL[n] ?? 'Working'), setLive('')),
        onDeck: (d) => changeRef.current(d),
      });
      const diff = diffDecks(before, r.deck);
      turns = [...turns, { id: Date.now() + 1, who: 'claude', text: r.text || (diffEmpty(diff) ? 'Done.' : 'Here you go.'), ...(diffEmpty(diff) ? {} : { diff, before }) }];
      if (r.stopped) turns.push({ id: Date.now() + 2, who: 'note', text: r.stopped });
      setChat({ messages: r.messages, turns });
    } catch (e) {
      // the deck may already have changed in this turn: keep the Undo for it
      const diff = diffDecks(before, deckRef.current);
      const why = await chatError(e);
      if (!diffEmpty(diff)) turns = [...turns, { id: Date.now() + 1, who: 'claude', text: 'I changed the deck before this stopped.', diff, before }];
      setChat({ messages: chat.messages, turns: [...turns, { id: Date.now() + 2, who: 'note', text: why }] });
      if (/key/i.test(why)) setKeyOpen(true);
      buzz(30);
    } finally {
      stop.current = null;
      setBusy(null);
      setLive('');
    }
  };

  const undo = (t: Turn) => {
    if (!t.before) return;
    playBlip();
    onChange(t.before);
    // later changes were made on top of this one, so they go too
    const at = chat.turns.indexOf(t);
    // Claude hears about it, and sees the deck as it is now with the next message
    setChat({
      messages: chat.messages.length ? [...chat.messages, { role: 'user', content: [{ type: 'text', text: '(I pressed Undo on your last change, so the deck went back. You will see the current deck with my next message.)' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Got it.' }] }] : chat.messages,
      turns: chat.turns.map((x, i) => (i >= at && x.diff ? { ...x, undone: true } : x)).concat({ id: Date.now(), who: 'note', text: 'Undone. The deck is back to how it was.' }),
    });
  };

  const lastChange = [...chat.turns].reverse().find((t) => t.diff && !t.undone);
  const ideas = deck.main.length ? IDEAS_DECK : IDEAS_EMPTY;

  return (
    <div class={`dc ${tall ? 'dc-tall' : ''}`} role="dialog" aria-label="Deck chat">
      <div class="dc-head">
        <button class="dc-grip" onClick={() => setTall(!tall)} aria-label={tall ? 'Make the chat smaller' : 'Make the chat bigger'}>
          <b>✦ Deck chat</b>
          <span>{tall ? '▾' : '▴'}</span>
        </button>
        <button class={`chip dc-keybtn ${key ? '' : 'on'}`} onClick={() => setKeyOpen(!keyOpen)}>
          {key ? 'Key' : 'Add key'}
        </button>
        {chat.turns.length > 0 && !busy && (
          <button class="chip" onClick={() => (playBlip(), setChat({ messages: [], turns: [] }))} aria-label="Start a new chat">
            New
          </button>
        )}
        <button class="win-x dc-x" onClick={onClose} aria-label="Close chat">
          ×
        </button>
      </div>

      {keyOpen && (
        <KeyPanel
          has={!!key}
          onSave={(k) => (setChatKey(k), setKey(k), setKeyOpen(false), playBlip())}
          onClear={() => (setChatKey(''), setKey(''), playBlip())}
          onClose={() => setKeyOpen(false)}
        />
      )}

      <div class="dc-list" ref={list} aria-live="polite">
        {chat.turns.length === 0 && (
          <div class="dc-hello">
            <p>
              Tell me what you want and I'll {deck.main.length ? 'change this deck' : 'build the deck'} from {collection ? 'the cards you own' : 'every Speed Duel card'}. I can answer questions about cards and rules too.
            </p>
            <p class="dc-dim">Every change shows up in your deck right away, with an Undo.</p>
          </div>
        )}
        {chat.turns.map((t) => (
          <div key={t.id} class={`dc-msg dc-${t.who}`}>
            <div class="dc-bubble">{t.text}</div>
            {t.diff && <Changes diff={t.diff} undone={!!t.undone} canUndo={t === lastChange && !busy} onUndo={() => undo(t)} onRead={onRead} />}
          </div>
        ))}
        {(busy || live) && (
          <div class="dc-msg dc-claude">
            {live ? <div class="dc-bubble">{live}</div> : null}
            {busy && (
              <div class="dc-busy">
                <i class="dc-dots" aria-hidden="true">
                  <b />
                  <b />
                  <b />
                </i>
                {busy}
              </div>
            )}
          </div>
        )}
      </div>

      {!busy && (
        <div class="dc-ideas">
          {(chat.turns.length ? ideas.slice(0, 2) : ideas).map((s) => (
            <button key={s} class="chip" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        class="dc-input"
        onSubmit={(ev) => {
          ev.preventDefault();
          send(text);
        }}
      >
        <textarea
          rows={1}
          value={text}
          placeholder={key || testModel() ? 'Ask for a deck, a change or a card…' : 'Add your key first'}
          aria-label="Message"
          maxLength={800}
          onInput={(ev) => setText((ev.target as HTMLTextAreaElement).value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) (ev.preventDefault(), send(text));
          }}
        />
        {busy ? (
          <button type="button" class="gbtn dc-send" onClick={() => stop.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" class="gbtn gold dc-send" disabled={!text.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}

/** What one answer changed: tap a card to read it; Undo puts the deck back. */
function Changes({ diff, undone, canUndo, onUndo, onRead }: { diff: DeckDiff; undone: boolean; canUndo: boolean; onUndo: () => void; onRead: (n: string) => void }) {
  const add = Object.entries(diff.added);
  const rem = Object.entries(diff.removed);
  const total = (l: [string, number][]) => l.reduce((a, [, k]) => a + k, 0);
  const [open, setOpen] = useState(add.length + rem.length <= 6);
  return (
    <div class={`dc-change ${undone ? 'undone' : ''}`}>
      <div class="dc-change-head">
        <button class="dc-change-sum" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span>
            {undone ? 'Undone: ' : 'Deck changed: '}
            {[add.length ? `+${total(add)} in` : '', rem.length ? `−${total(rem)} out` : '', diff.skill ? 'new Skill' : '', diff.renamed ? 'renamed' : ''].filter(Boolean).join(' · ')}
          </span>
          <span class="dc-dim">{open ? 'Hide ▾' : 'See ▸'}</span>
        </button>
        {canUndo && !undone && (
          <button class="chip dc-undo" onClick={onUndo}>
            ↶ Undo
          </button>
        )}
      </div>
      {open && (
        <ul>
          {add.map(([n, k]) => (
            <li key={`+${n}`}>
              <button class="dc-card dc-plus" onClick={() => onRead(n)}>
                +{k} {n}
              </button>
            </li>
          ))}
          {rem.map(([n, k]) => (
            <li key={`-${n}`}>
              <button class="dc-card dc-minus" onClick={() => onRead(n)}>
                −{k} {n}
              </button>
            </li>
          ))}
          {diff.skill && (
            <li>
              <span class="dc-card">✦ Skill: {diff.skill.to ? bare(diff.skill.to) : 'none'}</span>
            </li>
          )}
          {diff.renamed && (
            <li>
              <span class="dc-card">✎ Named "{diff.renamed}"</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function KeyPanel({ has, onSave, onClear, onClose }: { has: boolean; onSave: (k: string) => void; onClear: () => void; onClose: () => void }) {
  const [k, setK] = useState('');
  const bad = k.trim() !== '' && !looksLikeKey(k);
  return (
    <div class="dc-key">
      <p>
        <b>Deck chat runs on Claude.</b> Paste an Anthropic API key once and it stays on this phone only. Get one at{' '}
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
          console.anthropic.com
        </a>
        . A deck build costs a few cents of API credit.
      </p>
      <input type="password" autoComplete="off" autoCapitalize="off" spellcheck={false} placeholder={has ? 'Key saved · paste a new one to change it' : 'sk-ant-…'} value={k} onInput={(ev) => setK((ev.target as HTMLInputElement).value)} aria-label="Anthropic API key" />
      {bad && <p class="dc-warn">That doesn't look like a key. It starts with sk-ant-.</p>}
      <div class="dc-key-acts">
        {has && (
          <button class="chip" onClick={onClear}>
            Remove key
          </button>
        )}
        <button class="chip" onClick={onClose}>
          {has ? 'Close' : 'Later'}
        </button>
        <button class="gbtn gold" disabled={!looksLikeKey(k)} onClick={() => onSave(k)}>
          Save key
        </button>
      </div>
    </div>
  );
}
