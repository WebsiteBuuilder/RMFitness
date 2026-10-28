// Deck chat: talk to Claude in the Speed Duel deck editor. It builds whole decks from the
// cards you own, makes the edits you ask for and answers questions about cards and rules.
// Changes land in the deck straight away, each with its own Undo. The chat sits over the
// card list so the deck stays in view above it.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SpeedDeck } from '../eds/speedSave';
import { chatError, checkKey, claudeModel, costOf, keepTurn, runTurn, tooLong, type Model, type Msg } from '../deckchat/agent';
import { diffDecks, diffEmpty, redoDiff, undoDiff, type DeckDiff } from '../deckchat/tools';
import { chatKey, looksLikeKey, setChatKey } from '../deckchat/key';
import { clean, localModel, type Memory } from '../deckchat/local';
import { buzz, playBlip } from './sound';
import { card, imageUrl } from '../eds/db';
import './deckchat.css';

interface Turn {
  id: number;
  who: 'me' | 'claude' | 'note';
  text: string;
  /** what this answer changed, and the deck before it (for Undo) */
  diff?: DeckDiff;
  before?: SpeedDeck;
  undone?: boolean;
  /** what the answer cost on the player's key, in dollars */
  cost?: number;
}

interface Chat {
  messages: Msg[];
  turns: Turn[];
}

/** Chats per deck: kept in memory and on the phone, so closing the chat or the game doesn't lose them. */
const chats = new Map<string, Chat>();
const STORE = (deckId: string) => `eds.deckChat.${deckId}`;

function loadChat(deckId: string): Chat {
  const hit = chats.get(deckId);
  if (hit) return hit;
  try {
    const c = JSON.parse(localStorage.getItem(STORE(deckId)) ?? 'null') as Chat | null;
    if (c && Array.isArray(c.messages) && Array.isArray(c.turns)) return c;
  } catch {
    /* none saved */
  }
  return { messages: [], turns: [] };
}

/** A deleted deck's chat goes with it. */
export function forgetDeckChat(deckId: string) {
  chats.delete(deckId);
  try {
    localStorage.removeItem(STORE(deckId));
  } catch {
    /* nothing saved */
  }
}

function storeChat(deckId: string, c: Chat) {
  chats.set(deckId, c);
  try {
    if (!c.turns.length) return localStorage.removeItem(STORE(deckId));
    // a long chat keeps its last 60 lines on screen; the model history is dropped (not cut) when it gets too big
    const keep: Chat = { turns: c.turns.slice(-60), messages: c.messages };
    let raw = JSON.stringify(keep);
    if (raw.length > 120_000) raw = JSON.stringify({ turns: keep.turns, messages: keep.messages.slice(-20) });
    localStorage.setItem(STORE(deckId), raw);
  } catch {
    /* storage full or blocked: it lasts until the game closes */
  }
}

const TOOL_LABEL: Record<string, string> = {
  view_deck: 'Reading your deck',
  collection_overview: 'Looking through your cards',
  search_cards: 'Searching cards',
  get_cards: 'Reading card text',
  list_skills: 'Checking Skills',
  edit_deck: 'Changing the deck',
};

const IDEAS_EMPTY = ['Build my strongest deck', 'Make a Dragon deck', 'Make an aggressive deck', 'What can I build?'];
const IDEAS_DECK = ['Make it stronger', 'What does my Skill do?', 'Swap weak monsters', 'Is this deck good?'];

const bare = (n: string) => n.replace(/ \(Skill Card\)$/, '');

/** What a running tool is doing, in a few words ("Adding Blue-Eyes White Dragon and 9 more"). */
function toolLine(name: string, input: unknown): string {
  const i = (input ?? {}) as { add?: { name?: string }[]; remove?: { name?: string }[]; name?: string; text?: string; names?: string[] };
  if (name === 'edit_deck') {
    const add = (i.add ?? []).map((x) => x.name).filter(Boolean) as string[];
    const rem = (i.remove ?? []).map((x) => x.name).filter(Boolean) as string[];
    const list = add.length ? add : rem;
    if (list.length) return `${add.length ? 'Adding' : 'Taking out'} ${list[0]}${list.length > 1 ? ` and ${list.length - 1} more` : ''}`;
  }
  if (name === 'search_cards' && (i.name || i.text)) return `Searching for "${i.name ?? i.text}"`;
  if (name === 'search_cards') {
    const q = input as { kind?: string; race?: string; attribute?: string };
    const what = q.kind === 'extra' ? 'Extra Deck monsters' : q.kind ? `${q.kind}s` : 'cards';
    return `Searching ${[q.attribute, q.race].filter(Boolean).join(' ')} ${q.race || q.attribute ? (q.kind && q.kind !== 'monster' ? what : 'monsters') : what}`.replace(/\s+/g, ' ');
  }
  if (name === 'get_cards' && i.names?.length) return `Reading ${i.names[0]}${i.names.length > 1 ? ` and ${i.names.length - 1} more` : ''}`;
  return TOOL_LABEL[name] ?? 'Working';
}

/** Only for tests and screenshots: a model to use instead of Claude (window.__deckChatModel). */
/** Stops the chat's running turn (Android back / pad B press it first). true when one was running. */
let stopRunning: (() => boolean) | null = null;
export const stopDeckChat = () => stopRunning?.() ?? false;

const testModel = () => (globalThis as { __deckChatModel?: Model }).__deckChatModel;

export function DeckChat({ deck, collection, onChange, onFresh, onBusy, onRead, onClose }: { deck: SpeedDeck; collection?: Record<string, number>; onChange: (d: SpeedDeck) => void; /** cards that just came in, so their tiles can glow */ onFresh?: (names: string[]) => void; /** Claude is working: the editor holds still */ onBusy?: (busy: boolean) => void; onRead: (name: string, list: string[]) => void; onClose: () => void }) {
  const [chat, setChatState] = useState<Chat>(() => loadChat(deck.id));
  const setChat = (c: Chat) => (storeChat(deck.id, c), setChatState(c));
  const [sureNew, setSureNew] = useState(false);
  const [text, setText] = useState('');
  /** what Claude is doing right now (null while it writes), the steps it has done this turn, and whether a turn runs */
  const [busy, setBusy] = useState<string | null>(null);
  const [trail, setTrail] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [live, setLive] = useState('');
  const [key, setKey] = useState(chatKey);
  const [keyOpen, setKeyOpen] = useState(false);
  const [tall, setTall] = useState(false);
  const stop = useRef<AbortController | null>(null);
  /** what the free helper remembers between messages (the cards it just touched) */
  const helperMemory = useRef<Memory>({ added: [], removed: [] });
  const running = useRef(false);
  const lastStep = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const deckRef = useRef(deck);
  deckRef.current = deck;
  // the newest onChange: the turn runs across renders and must not save into an old copy
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.turns.length, live, busy, trail.length]);
  useEffect(() => {
    stopRunning = () => (stop.current ? (stop.current.abort(), true) : false);
    return () => {
      stop.current?.abort();
      stopRunning = null;
    };
  }, []);
  // iPhones put the keyboard over fixed sheets: keep the sheet above it
  const [lift, setLift] = useState<{ bottom: number; height: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const fit = () => {
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      setLift(covered > 80 ? { bottom: covered, height: Math.min(vv.height - 44, vv.height * 0.9) } : null);
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    return () => (vv.removeEventListener('resize', fit), vv.removeEventListener('scroll', fit));
  }, []);
  // ready to type (phones wait for a tap, so the keyboard doesn't cover the deck)
  useEffect(() => {
    if (!matchMedia('(pointer: coarse)').matches) input.current?.focus();
  }, []);

  const send = async (raw: string) => {
    const msg = raw.trim();
    // a ref, not state: two quick taps must not start two paid turns
    if (!msg || working || running.current) return;
    // "undo" said in the chat presses the Undo on the newest change
    const said = clean(msg);
    // ("undo that last change please", "give me back my old deck"; not "how do i undo?")
    // a "don't", "didn't" or "no" just before undo keeps the change ("i didn't mean to undo", "no undo"); "nah undo it" still undoes
    const undoWord = /\b(undo|revert)\b|\b(reverse|cancel) (that|it|this|the last (one|change))\b|\bctrl ?z\b/.test(said);
    // only the part of the message that says undo counts ("I don't like that, undo it" undoes)
    const undoPart = clean(msg.split(/[,.;!]+/).find((x) => /\b(undo|revert)\b/i.test(x)) ?? msg);
    // "no undo that" and "i didnt like that undo it" undo; "dont undo", "i didnt mean to undo" don't
    const negated = /\b(dont|didnt|do not|wouldnt|shouldnt|wont|never|not|cant)\s+(?:(?:mean|want|need|have) to |wanna |gotta )?(undo|revert)\b/.test(undoPart) || /\b(keep it|like it|leave it)\b/.test(undoPart);
    const putBack = (/^(put it back|put it back how it was|put everything back|make it how it was)$/.test(said) && !helperMemory.current.removed.length) || /\bchange (it|that|this|everything) back\b|\bgo back to (how it was|before|the old (one|deck)|what it was)\b|\b(my|the) (old|previous|original) deck back\b|\bhow it was before\b/.test(said);
    // "can you undo that?" is a request
    const politeAsk = /^\s*(can|could|would|will) (you|u)\b|^\s*(pls|please)\b/i.test(msg);
    const wantsUndo = (politeAsk || (!/^(how|what|why|can i|should|is|does|when|would)\b/.test(said) && !/\?\s*$/.test(msg))) && !/\bredo\b|\bundo the undo\b/.test(said) && !negated && !/\b(undo|revert) (is|button|does|means|work)\b/.test(said) && (undoWord || putBack || /^(?:(?:ugh|nah|nvm|ok|okay|just|oh|hmm|no) )*(go back|take (it|that) back)( again)?$/.test(said) || /\b(give|bring|put|get) (me )?(back )?(my )?(old|previous|last|original) deck( back)?\b/.test(said));
    // "undo the last two changes" (said as "undo two of those"); "undo everything" takes them all back
    const all = /\bundo (everything|all( of it| the changes| of them)?|it all)\b/.test(said);
    const many = all ? 99 : Number(said.match(/\bundo (?:the )?(?:last )?(\d|two|three)\b/)?.[1]?.replace('two', '2').replace('three', '3') ?? 1);
    // "undo and add 2 kuriboh": the rest is asked again after the undo
    const rest = said.match(/\b(?:undo|revert)\b(?: (?:it|that|this))?\s+(?:and|then|and then)\s+(.+)$/)?.[1];
    if (wantsUndo && !lastChange) {
      setText('');
      return setChat({ ...chat, turns: [...chat.turns, { id: Date.now(), who: 'me', text: msg }, { id: Date.now() + 1, who: 'claude', text: changes.length ? 'Everything is already undone. Say "redo" to put a change back.' : "There's no change to undo yet." }] });
    }
    if (wantsUndo && lastChange) {
      playBlip();
      setText('');
      const live = changes.filter((x) => !x.undone);
      const target = live[Math.max(0, live.length - many)] ?? lastChange;
      const n = live.length - live.indexOf(target);
      // newest first, each change taken off the deck as it is
      let back = deckRef.current;
      for (const x of live.slice(live.indexOf(target)).reverse()) if (x.diff && x.before) back = undoDiff(back, x.diff, x.before);
      return undo(target, [{ id: Date.now(), who: 'me', text: msg }, { id: Date.now() + 1, who: 'claude', text: `Undid the last ${n > 1 ? `${n} changes` : 'change'}. Say "redo" to put it back.${rest ? ` Now say "${rest}" again and I'll do that on the deck as it is now.` : ''}` }], back);
    }
    if (/^(redo|redo (it|that)|undo the undo)$/.test(said) && redoable) {
      playBlip();
      setText('');
      return redo(redoable, [{ id: Date.now(), who: 'me', text: msg }, { id: Date.now() + 1, who: 'claude', text: 'Put the change back.' }]);
    }
    // Claude when the duelist added a key, else the built-in helper (free, works offline)
    const model = testModel() ?? (key ? claudeModel(key) : localModel(() => ({ deck: deckRef.current, collection }), helperMemory.current));
    running.current = true;
    playBlip();
    setText('');
    const before = deckRef.current;
    let turns: Turn[] = [...chat.turns, { id: Date.now(), who: 'me', text: msg }];
    setChat({ ...chat, turns });
    setBusy('Thinking');
    setTrail([]);
    lastStep.current = null;
    setWorking(true);
    onBusy?.(true);
    setLive('');
    const ac = new AbortController();
    stop.current = ac;
    let history = chat.messages;
    try {
      const hooks = {
        signal: ac.signal,
        onText: (d: string) => (setLive((t) => t + d), setBusy(null)),
        onTool: (n: string, i: unknown) => {
          const step = toolLine(n, i);
          // the step before this one is done: it joins the trail
          const was = lastStep.current;
          if (was) setTrail((t) => [...t, was]);
          lastStep.current = step;
          setBusy(step);
          setLive('');
        },
        onDeck: (d: SpeedDeck, prev: SpeedDeck) => (changeRef.current(d), onFresh?.(Object.keys(diffDecks(prev, d).added)), setTall(false)),
      };
      const r = await runTurn(model, history, msg, { deck: before, collection }, hooks).catch((e) => {
        // the chat outgrew the model: start the history over once and ask again
        if (!tooLong(e) || !history.length) throw e;
        history = [];
        return runTurn(model, history, msg, { deck: before, collection }, hooks);
      });
      const diff = diffDecks(before, r.deck);
      const cost = r.usage.length ? costOf(r.usage) : undefined;
      turns = [...turns, { id: Date.now() + 1, who: 'claude', text: r.text || (diffEmpty(diff) ? 'Done.' : 'Here you go.'), cost, ...(diffEmpty(diff) ? {} : { diff, before }) }];
      if (r.stopped) turns.push({ id: Date.now() + 2, who: 'note', text: r.stopped });
      // a refused turn leaves no trace in the history, so it can't sour later answers
      setChat({ messages: r.refused ? history : keepTurn(history, msg, r.text), turns });
    } catch (e) {
      // the deck may already have changed in this turn: keep the Undo for it
      const diff = diffDecks(before, deckRef.current);
      // the free helper never loads the Claude SDK (it may not be reachable offline)
      const why = key ? await chatError(e).catch(() => 'Something went wrong. Try again.') : (e as Error)?.name === 'AbortError' ? 'Stopped.' : `Something went wrong: ${(e as Error)?.message ?? e}`;
      if (!diffEmpty(diff)) turns = [...turns, { id: Date.now() + 1, who: 'claude', text: 'I changed the deck before this stopped.', diff, before }];
      // Claude keeps the request in mind (the history stays append-only)
      const messages: Msg[] = [...history, { role: 'user', content: [{ type: 'text', text: msg }] }, { role: 'assistant', content: [{ type: 'text', text: `(I was stopped before I finished${diffEmpty(diff) ? '' : ', after changing the deck'}.)` }] }];
      setChat({ messages, turns: [...turns, { id: Date.now() + 2, who: 'note', text: why }] });
      if (key && /didn't work|isn't allowed|no credit/.test(why)) setKeyOpen(true);
      buzz(30);
    } finally {
      stop.current = null;
      running.current = false;
      onBusy?.(false);
      setBusy(null);
      setTrail([]);
      setWorking(false);
      setLive('');
    }
  };

  const undo = (t: Turn, said: Turn[] = [], after?: SpeedDeck) => {
    if (!t.before || !t.diff) return;
    // "take that out" must not reach for cards an Undo already took back
    helperMemory.current = { added: [], removed: [], wanted: helperMemory.current.wanted };
    playBlip();
    onChange(after ?? undoDiff(deckRef.current, t.diff, t.before));
    // later changes were made on top of this one, so they go too
    const at = chat.turns.indexOf(t);
    // Claude hears about it, and sees the deck as it is now with the next message
    setChat({
      messages: chat.messages.length ? [...chat.messages, { role: 'user', content: [{ type: 'text', text: '(I pressed Undo on your last change, so the deck went back. You will see the current deck with my next message.)' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Got it.' }] }] : chat.messages,
      turns: [...chat.turns.map((x, i) => (i >= at && x.diff ? { ...x, undone: true } : x)), ...said],
    });
  };

  const redo = (t: Turn, said: Turn[] = []) => {
    if (!t.diff) return;
    playBlip();
    onChange(redoDiff(deckRef.current, t.diff));
    onFresh?.(Object.keys(t.diff.added));
    setChat({
      messages: chat.messages.length ? [...chat.messages, { role: 'user', content: [{ type: 'text', text: '(I pressed Redo, so your change is back in the deck.)' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Got it.' }] }] : chat.messages,
      turns: [...chat.turns.map((x) => (x === t ? { ...x, undone: false } : x)), ...said],
    });
  };

  const changes = chat.turns.filter((t) => t.diff);
  const lastChange = [...changes].reverse().find((t) => !t.undone);
  // Redo puts back the oldest undone change first, the reverse of the Undo order
  const redoable = changes.slice(lastChange ? changes.indexOf(lastChange) + 1 : 0).find((t) => t.undone) ?? null;
  const asked = new Set(chat.turns.filter((t) => t.who === 'me').map((t) => t.text));
  const ideas = (deck.main.length ? IDEAS_DECK : IDEAS_EMPTY).filter((s) => !asked.has(s));

  return (
    <div class={`dc ${tall ? 'dc-tall' : ''}`} role="dialog" aria-label="Deck chat" style={lift ? { bottom: `${lift.bottom}px`, height: `${lift.height}px` } : undefined}>
      <div class="dc-head">
        <button class="dc-grip" onClick={() => setTall(!tall)} aria-label={tall ? 'Make the chat smaller' : 'Make the chat bigger'}>
          <b>✦ Deck chat</b>
          <span>{tall ? '▾' : '▴'}</span>
        </button>
        <button class={`chip dc-keybtn ${key ? 'on' : ''}`} hidden={keyOpen} onClick={() => setKeyOpen(true)} aria-label={key ? 'Claude is on: key settings' : 'Optional: use Claude with your own key'}>
          {key ? 'Claude ✓' : 'Claude'}
        </button>
        {chat.turns.length > 0 && !working && (
          <button class={`chip ${sureNew ? 'on' : ''}`} onClick={() => (playBlip(), sureNew ? (setChat({ messages: [], turns: [] }), (helperMemory.current = { added: [], removed: [] }), setSureNew(false)) : setSureNew(true))} onBlur={() => setSureNew(false)} aria-label="Start a new chat">
            {sureNew ? 'Clear chat?' : 'New'}
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
          onClear={() => (setChatKey(''), setKey(''), setKeyOpen(false), playBlip())}
          onClose={() => setKeyOpen(false)}
        />
      )}

      <div class="dc-list" ref={list} aria-live="polite">
        {chat.turns.length === 0 && !keyOpen && (
          <div class="dc-hello">
            <p>
              Tell me what you want and I'll {deck.main.length ? 'change this deck' : 'build the deck'} from {collection ? 'the cards you own' : 'every Speed Duel card'}. I can answer questions about cards and rules too.
            </p>
            <p class="dc-dim">Every change shows up in your deck right away, with an Undo.{key ? '' : ' Free, and works offline.'}</p>
          </div>
        )}
        {chat.turns.map((t) => (
          <div key={t.id} class={`dc-msg dc-${t.who}`}>
            <div class="dc-bubble">{t.text}</div>
            {t.cost !== undefined && <span class="dc-cost">{t.cost < 0.01 ? 'under 1¢' : `about ${Math.round(t.cost * 100)}¢`} of credit</span>}
            {t.diff && <Changes diff={t.diff} undone={!!t.undone} canUndo={t === lastChange && !working} canRedo={t === redoable && !working} onUndo={() => undo(t)} onRedo={() => redo(t)} onRead={onRead} />}
          </div>
        ))}
        {working && (
          <div class="dc-msg dc-claude">
            {trail.length > 0 && (
              <ul class="dc-trail">
                {trail.slice(-5).map((t, i) => (
                  <li key={i}>✓ {t}</li>
                ))}
              </ul>
            )}
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

      {!working && !chat.turns[chat.turns.length - 1]?.diff && (
        <div class={`dc-ideas ${chat.turns.length ? 'dc-ideas-one' : ''}`}>
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
          ref={input}
          rows={1}
          value={text}
          placeholder="Ask for a deck or a change…"
          aria-label="Message"
          maxLength={800}
          onInput={(ev) => setText((ev.target as HTMLTextAreaElement).value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) (ev.preventDefault(), send(text));
          }}
        />
        {working ? (
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
function Changes({ diff, undone, canUndo, canRedo, onUndo, onRedo, onRead }: { diff: DeckDiff; undone: boolean; canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; onRead: (n: string, list: string[]) => void }) {
  const add = Object.entries(diff.added);
  const rem = Object.entries(diff.removed);
  const total = (l: [string, number][]) => l.reduce((a, [, k]) => a + k, 0);
  const [open, setOpen] = useState(add.length + rem.length <= 6);
  // the card reader steps through every card this change touched
  const touched = [...add, ...rem].map(([n]) => n);
  const row = (n: string, k: number, plus: boolean) => (
    <li key={`${plus ? '+' : '-'}${n}`}>
      <button class={`dc-card ${plus ? 'dc-plus' : 'dc-minus'}`} onClick={() => onRead(n, touched)} aria-label={`${plus ? 'Added' : 'Took out'} ${k} ${n}: tap to read`}>
        {imageUrl(n) ? <img class="dc-thumb" src={imageUrl(n)!} alt="" loading="lazy" draggable={false} /> : <i class={`dc-thumb dc-k-${card(n)?.kind ?? 'monster'}`} />}
        <b>
          {plus ? '+' : '−'}
          {k}
        </b>
        <span>{n}</span>
      </button>
    </li>
  );
  return (
    <div class={`dc-change ${undone ? 'undone' : ''}`}>
      <div class="dc-change-head">
        <button class="dc-change-sum" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Hide the changes' : 'Show the changes'}>
          <span class="dc-sum">
            {undone && <span class="dc-dim">Undone:</span>}
            {add.length > 0 && <span class="dc-plus">+{total(add)}</span>}
            {rem.length > 0 && <span class="dc-minus">−{total(rem)}</span>}
            {(add.length > 0 || rem.length > 0) && <span>cards</span>}
            {diff.skill && <span>· Skill</span>}
            {diff.renamed && <span>· Renamed</span>}
          </span>
          <span class="dc-chev">{open ? '▾' : '▸'}</span>
        </button>
        {canUndo && !undone && (
          <button class="chip dc-undo" onClick={onUndo}>
            ↶ Undo
          </button>
        )}
        {canRedo && undone && (
          <button class="chip dc-undo" onClick={onRedo}>
            ↷ Redo
          </button>
        )}
      </div>
      {open && (
        <ul>
          {diff.skill && (
            <li>
              <span class="dc-card dc-line">✦ Skill: {diff.skill.to ? bare(diff.skill.to) : 'none'}</span>
            </li>
          )}
          {diff.renamed && (
            <li>
              <span class="dc-card dc-line">✎ Named "{diff.renamed}"</span>
            </li>
          )}
          {add.map(([n, k]) => row(n, k, true))}
          {rem.map(([n, k]) => row(n, k, false))}
        </ul>
      )}
    </div>
  );
}

function KeyPanel({ has, onSave, onClear, onClose }: { has: boolean; onSave: (k: string) => void; onClear: () => void; onClose: () => void }) {
  const [k, setK] = useState('');
  const [check, setCheck] = useState<{ state: 'busy' | 'bad'; text: string } | null>(null);
  const bad = k.trim() !== '' && !looksLikeKey(k);
  const save = async () => {
    setCheck({ state: 'busy', text: 'Checking the key…' });
    const why = await checkKey(k.trim());
    if (why) return void (setCheck({ state: 'bad', text: why }), buzz(30));
    setCheck(null);
    onSave(k.trim());
  };
  const paste = async () => {
    try {
      setK((await navigator.clipboard.readText()).trim());
    } catch {
      setCheck({ state: 'bad', text: 'Paste with a long press in the box instead.' });
    }
  };
  return (
    <div class="dc-key">
      <p>
        <b>Optional upgrade: Claude.</b> The built-in helper is free and needs nothing. With your own Anthropic API key, Claude answers instead and understands almost anything you ask (a deck build is usually 10-30¢ of credit, a question a few cents; each answer shows what it cost). The key stays on this phone only.{' '}
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
          Get a key
        </a>
      </p>
      <div class="dc-key-row">
        <input type="password" autoComplete="off" autoCapitalize="off" spellcheck={false} placeholder={has ? 'Key saved ✓ · paste a new one to change' : 'sk-ant-…'} value={k} onInput={(ev) => (setK((ev.target as HTMLInputElement).value), setCheck(null))} aria-label="Anthropic API key" />
        {typeof navigator !== 'undefined' && 'readText' in (navigator.clipboard ?? {}) && (
          <button class="chip" onClick={paste}>
            Paste
          </button>
        )}
      </div>
      {!has && (
        <ol class="dc-steps">
          <li>Sign in at console.anthropic.com (tap Get a key)</li>
          <li>Add a little credit under Billing ($5 lasts a long time)</li>
          <li>Create a key, copy it, and paste it here</li>
        </ol>
      )}
      {bad && !check && <p class="dc-warn">That doesn't look like a key. It starts with sk-ant-.</p>}
      {check && <p class={check.state === 'bad' ? 'dc-warn' : 'dc-dim'}>{check.text}</p>}
      <div class="dc-key-acts">
        {has && (
          <button class="chip" onClick={onClear}>
            Use free helper
          </button>
        )}
        <button class="chip" onClick={onClose}>
          {has ? 'Close' : 'No thanks'}
        </button>
        <button class="gbtn gold" disabled={!looksLikeKey(k) || check?.state === 'busy'} onClick={save}>
          {check?.state === 'busy' ? 'Checking…' : 'Save key'}
        </button>
      </div>
    </div>
  );
}
