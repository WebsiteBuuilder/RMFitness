// Deck chat's conversation loop: sends the chat to a model with the deck tools, runs the
// tools it asks for against the working deck, and loops until it answers. The model is a
// plain function so tests can script one; claudeModel() is the real one (Claude API,
// called straight from the phone with the duelist's own key).
import type Anthropic from '@anthropic-ai/sdk';
import { DECK_RULES, TOOLS, deckReport, runTool, type ChatWorld } from './tools';
import type { SpeedDeck } from '../eds/speedSave';

export type Msg = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlock;

export interface ModelReply {
  content: Block[];
  stop_reason: string | null;
}

export interface ModelRequest {
  system: string;
  tools: typeof TOOLS;
  messages: Msg[];
}

/** One model call. onText gets the reply's words as they arrive (when the model streams). */
export type Model = (req: ModelRequest, onText?: (delta: string) => void, signal?: AbortSignal) => Promise<ModelReply>;

export const MODEL_ID = 'claude-opus-5-5';
const MAX_STEPS = 25;

export const SYSTEM = `You are the deck builder inside a Speed Duel game (Yu-Gi-Oh! Speed Duel, like Master Duel's deck editor). You talk with the duelist on their phone while they edit one deck, and you can read their cards and change that deck with tools.

${DECK_RULES}

How to work:
- Only use cards the tools show. Never invent cards or effects; check card text with get_cards before you explain what a card does.
- Unless the deck is an Anything goes deck, the duelist can only use cards they own (search_cards and list_skills only show those).
- Call several tools at once when they don't depend on each other (for example a few searches in one go).
- To build a full deck: call collection_overview, pick a plan that fits what they own (a theme, Attribute or Type with enough monsters), search for the pieces, then build it with as few edit_deck calls as you can (clear plus all adds in one call is best). Aim for a legal 20-card Main Deck unless they ask for more: roughly 11-13 monsters (mostly Level 4 or lower, a few strong Level 5-6 tributes at most), with the rest spells and traps that support them, a fitting Skill, and Extra Deck monsters only when the deck can actually summon them (it has the materials and Polymerization or the right Levels). Check the result and fix anything refused.
- For edits, make exactly what they asked and keep the rest of the deck.
- Every change shows up in the deck at once with an Undo button, so just do it; don't ask for permission first. Ask a short question only when the request really could mean very different decks.
- Asked what to get next: search with include_unowned and name cards worth chasing in packs or the Card Shop.
- Questions about rules, cards or strategy: answer from the card text and Speed Duel rules (4000 LP, 4-card opening hand, 3 Monster Zones and 3 Spell/Trap Zones, no Main Phase 2, Skills).

How to answer: the screen is small. Reply in plain short sentences, no tables or headings. After building or editing, say in two or three sentences what the deck does and its key cards; the duelist sees the full list of changes separately, so don't repeat it card by card.`;

export interface TurnHooks {
  onText?: (delta: string) => void;
  /** a tool is running ("search_cards"...) */
  onTool?: (name: string, input: unknown) => void;
  /** the deck changed (after every edit_deck that changed something) */
  onDeck?: (deck: SpeedDeck, prev: SpeedDeck) => void;
  signal?: AbortSignal;
}

export interface TurnResult {
  messages: Msg[];
  text: string;
  deck: SpeedDeck;
  /** the model refused or stopped early: shown as a note, not a reply */
  stopped?: string;
}

/** One duelist message, answered: runs tools until the model is done. */
export async function runTurn(model: Model, history: Msg[], userText: string, world: ChatWorld, hooks: TurnHooks = {}): Promise<TurnResult> {
  // The deck as it is now goes with the message, so Claude sees hand edits made between turns.
  const messages: Msg[] = [...history, { role: 'user', content: [{ type: 'text', text: `${userText}\n\n<current_deck>\n${deckReport(world)}\n</current_deck>` }] }];
  let deck = world.deck;
  let text = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await model({ system: SYSTEM, tools: TOOLS, messages }, hooks.onText, hooks.signal);
    messages.push({ role: 'assistant', content: reply.content as Anthropic.Beta.BetaContentBlockParam[] });
    const said = reply.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
    if (said) text += (text ? '\n\n' : '') + said.trim();
    if (reply.stop_reason === 'refusal') return { messages, text, deck, stopped: "Claude can't help with that one. Try asking another way." };
    const calls = reply.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (reply.stop_reason !== 'tool_use' || !calls.length) {
      // a reply cut off mid tool call still needs its results, or every later request is refused
      if (calls.length) messages.push({ role: 'user', content: calls.map((c) => ({ type: 'tool_result' as const, tool_use_id: c.id, content: 'Not run: your reply was cut off.', is_error: true })) });
      if (reply.stop_reason === 'max_tokens') return { messages, text, deck, stopped: 'The answer was cut off. Ask it to go on.' };
      return { messages, text, deck };
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      hooks.onTool?.(call.name, call.input);
      const r = runTool({ ...world, deck }, call.name, call.input);
      if (r.deck && JSON.stringify(r.deck) !== JSON.stringify(deck)) {
        const prev = deck;
        deck = r.deck;
        hooks.onDeck?.(deck, prev);
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: r.text, ...(r.error ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { messages, text, deck, stopped: 'That took too many steps. Ask again with a smaller change.' };
}

/** The real model: Claude, called from the phone with the duelist's own API key. */
export function claudeModel(apiKey: string): Model {
  let client: Anthropic | null = null;
  return async (req, onText, signal) => {
    if (!client) {
      const { default: Sdk } = await import('@anthropic-ai/sdk');
      // The key is the player's own, typed into this phone and sent only to Anthropic.
      client = new Sdk({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
    }
    const stream = client.beta.messages.stream(
      {
        model: MODEL_ID,
        max_tokens: 32000,
        system: req.system,
        tools: req.tools.map((t) => ({ ...t, input_schema: t.input_schema as Anthropic.Beta.BetaTool.InputSchema })),
        messages: req.messages,
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal },
    );
    if (onText) stream.on('text', (d) => onText(d));
    const m = await stream.finalMessage();
    return { content: m.content, stop_reason: m.stop_reason };
  };
}

/** Tries a key without spending credit (looks up the model). null when it works, else why not. */
export async function checkKey(apiKey: string): Promise<string | null> {
  const { default: Sdk } = await import('@anthropic-ai/sdk');
  try {
    await new Sdk({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 }).models.retrieve(MODEL_ID);
    return null;
  } catch (e) {
    if (e instanceof Sdk.AuthenticationError) return "That key didn't work. Copy it again from console.anthropic.com.";
    return chatError(e);
  }
}

/** A problem talking to Claude, in the player's words. */
export async function chatError(e: unknown): Promise<string> {
  const { default: Sdk } = await import('@anthropic-ai/sdk');
  if (e instanceof Sdk.APIUserAbortError) return 'Stopped.';
  if (e instanceof Sdk.AuthenticationError) return "That key didn't work. Tap Key at the top of the chat to fix it.";
  if (e instanceof Sdk.PermissionDeniedError) return "That key isn't allowed to use Claude. Tap Key at the top of the chat to fix it.";
  if (e instanceof Sdk.RateLimitError) return 'Claude is busy for this key right now. Wait a minute and try again.';
  if (e instanceof Sdk.BadRequestError) return /credit/i.test(e.message) ? 'The key has no credit left. Add some at console.anthropic.com.' : `Claude couldn't read that request (${e.message.slice(0, 120)}).`;
  if (e instanceof Sdk.APIConnectionError) return 'No connection to Claude. Check the internet and try again.';
  if (e instanceof Sdk.APIError) return `Claude had a problem (${e.status ?? 'error'}). Try again.`;
  return `Something went wrong: ${(e as Error)?.message ?? e}`;
}
