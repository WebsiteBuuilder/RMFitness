// 2v2 Tag Duels: the menu, the Tag Road (the 2v2 campaign), free tag duels, picking a
// computer partner, and the bar over the board that shows whose turn it is in a tag duel.
import { useState } from 'preact/hooks';
import { activeDeck, speedDeckProblems, type SpeedDeck, type SpeedSave } from '../eds/speedSave';
import { collectionProblems } from '../collection/economy';
import type { SoloSave } from '../eds/speedCampaign/save';
import type { CpuDuelist } from '../eds/speedCampaign/types';
import { TAG_CHAPTERS, findTagNode, foeOf, nextTagNode, pairName, partnersFor, tagChapterOpen, tagLevel, tagNodeOpen, tagNodePassed, type TagNode, type TagSettled } from '../eds/speedCampaign/tagRoad';
import { LAYOUTS, sideOfPhone, type TagLayout } from '../eds/tagDuel';
import { activeMember, benchHand } from '../eds/tag';
import type { DuelState, Pid } from '../eds/types';
import { Btn, Portrait, ResultBanner, Sheet, SoloDeckPick, Top } from './Solo';
import { CardImg } from './CardImg';
import './tag.css';

/** Everything App needs to start a tag duel. */
export interface TagPlan {
  layout: TagLayout;
  foes: [CpuDuelist, CpuDuelist];
  /** your computer partner (split, partner), then your brother's (split) */
  partners: [CpuDuelist | null, CpuDuelist | null];
  /** "free" or "road:<tag node id>" */
  ctx: string;
  level: 'easy' | 'normal' | 'hard';
}

/** What the last tag duel ended with, for the result sheet. */
export interface TagReport {
  ctx: string;
  result: 'w' | 'l' | 'd';
  settled: TagSettled | null;
  /** the deck could not earn (an Anything goes deck) */
  noEarn?: boolean;
}

interface Props {
  speed: SpeedSave;
  solo: SoloSave;
  report: TagReport | null;
  onReportSeen: () => void;
  /** start a tag duel on this phone, or create a room for the brother to join */
  onPlay: (plan: TagPlan, how: 'here' | 'host') => void;
  onJoin: (code: string) => void;
  onBack: () => void;
  /** saves the Speed Duel save (picking the deck to duel with) */
  onSpeed: (s: SpeedSave) => void;
}

type View = { v: 'home' } | { v: 'road' } | { v: 'free' } | { v: 'join' };

export function TagHub(p: Props) {
  const [view, setView] = useState<View>(() => (p.report?.ctx.startsWith('road:') ? { v: 'road' } : { v: 'home' }));
  const deck = activeDeck(p.speed);
  const problems = deck ? [...speedDeckProblems(deck), ...collectionProblems(p.speed, deck)] : ['No Speed Duel deck yet'];
  const ctx = { ...p, deckProblems: problems, deckName: deck?.name ?? '' };
  return (
    <div class="so tag">
      {view.v === 'home' && <Home {...ctx} go={setView} />}
      {view.v === 'road' && <Road {...ctx} back={() => setView({ v: 'home' })} />}
      {view.v === 'free' && <Free {...ctx} back={() => setView({ v: 'home' })} />}
      {view.v === 'join' && <Join {...ctx} back={() => setView({ v: 'home' })} />}
    </div>
  );
}

type Ctx = Props & { deckProblems: string[]; deckName: string };

function DeckBar({ deckProblems, deckName, speed, onSpeed }: Ctx) {
  const [open, setOpen] = useState(false);
  const problemsOf = (d: SpeedDeck) => [...speedDeckProblems(d), ...collectionProblems(speed, d)];
  return (
    <>
      <div class="so-deckbar">
        <div>
          <b>Your deck{deckName ? `: ${deckName}` : ''}</b>
          <span class={deckProblems.length ? 'so-bad' : 'so-good'}>{deckProblems.length ? deckProblems[0] : `${activeDeck(speed)!.main.length} cards · ready`}</span>
        </div>
        {speed.decks.length > 1 && (
          <Btn kind="blue" onClick={() => setOpen(true)}>
            Change
          </Btn>
        )}
      </div>
      {open && (
        <SoloDeckPick
          title="Deck for Tag Duels"
          decks={speed.decks}
          current={activeDeck(speed)}
          problemsOf={problemsOf}
          note="Anything goes decks can play, but they earn nothing on the Tag Road."
          onPick={(d) => (onSpeed({ ...speed, active: d.id }), setOpen(false))}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function Home(p: Ctx & { go: (v: View) => void }) {
  const next = nextTagNode(p.solo);
  return (
    <>
      <Top title="2v2 Tag Duels" sub="two decks, one field, 8000 LP per team" onBack={p.onBack} />
      <div class="so-body">
        <div class="tag-rules">
          <b>How tag duels work</b>
          <span>Teammates share the field, the Graveyard and 8000 LP. Each brings their own Deck, Extra Deck, Skill and hand.</span>
          <span>Turns go: you, an opponent, your partner, the other opponent, and around again.</span>
          <span>Set traps belong to the team: either of you can spring them.</span>
        </div>
        <button class="tag-big gold" onClick={() => p.go({ v: 'road' })}>
          <b>Tag Road</b>
          <span>The 2v2 campaign: the Millennium Road's duelists in pairs. Next: {pairName(next)}</span>
        </button>
        <button class="tag-big" onClick={() => p.go({ v: 'free' })}>
          <b>Tag Duel</b>
          <span>Same team or split teams with your brother, or you with a computer partner</span>
        </button>
        <button class="tag-big blue" onClick={() => p.go({ v: 'join' })}>
          <b>Join your brother's room</b>
          <span>Type the 4-letter code from his phone</span>
        </button>
        <DeckBar {...p} />
      </div>
    </>
  );
}

function Join(p: Ctx & { back: () => void }) {
  const [code, setCode] = useState('');
  const ok = /^[A-Z]{4}$/.test(code);
  return (
    <>
      <Top title="Join a tag room" onBack={p.back} />
      <div class="so-body">
        <p class="so-dim">Your brother creates the room from 2v2 Tag Duels on his phone, then reads you the code.</p>
        <input class="tag-code" value={code} maxLength={4} placeholder="CODE" autoCapitalize="characters" onInput={(e) => setCode((e.target as HTMLInputElement).value.toUpperCase().replace(/[^A-Z]/g, ''))} />
        <Btn kind="gold" disabled={!ok || p.deckProblems.length > 0} onClick={() => p.onJoin(code)}>
          Join room {ok ? code : ''}
        </Btn>
        <DeckBar {...p} />
      </div>
    </>
  );
}

/** Choose who you play with, then go. */
function WithWho({ p, layouts, foes, ctx, level, onClose, title }: { p: Ctx; layouts: TagLayout[]; foes: [CpuDuelist, CpuDuelist]; ctx: string; level: TagPlan['level']; onClose: () => void; title: string }) {
  const partners = partnersFor(p.solo);
  const [layout, setLayout] = useState<TagLayout | null>(layouts.length === 1 ? layouts[0] : null);
  const [mine, setMine] = useState<CpuDuelist>(partners[0]);
  const [his, setHis] = useState<CpuDuelist>(partners[Math.min(1, partners.length - 1)]);
  const [picking, setPicking] = useState<0 | 1 | null>(null);
  const bad = p.deckProblems.length > 0;
  const plan = (l: TagLayout): TagPlan => ({ layout: l, foes, partners: [l === 'together' ? null : mine, l === 'split' ? his : null], ctx, level });
  const L = LAYOUTS.filter((l) => layouts.includes(l.id));
  if (picking !== null)
    return (
      <Sheet title={picking === 0 ? 'Your computer partner' : "Your brother's computer partner"} onClose={() => setPicking(null)}>
        <p class="so-dim">Joey is always ready. Every Millennium Road duelist you beat joins this list.</p>
        <div class="tag-partners">
          {partners.map((d) => (
            <button key={d.id} class={`tag-partner ${(picking === 0 ? mine : his).id === d.id ? 'on' : ''}`} onClick={() => ((picking === 0 ? setMine : setHis)(d), setPicking(null))}>
              <Portrait d={d} size="s" />
              <span>
                <b>{d.name}</b>
                <em>{d.title}</em>
              </span>
            </button>
          ))}
        </div>
      </Sheet>
    );
  return (
    <Sheet title={title} onClose={onClose}>
      <div class="tag-vs">
        <Portrait d={foes[0]} size="m" />
        <Portrait d={foes[1]} size="m" />
      </div>
      <p class="so-center">
        <b>{foes[0].name}</b> & <b>{foes[1].name}</b>
      </p>
      {!layout && (
        <div class="tag-layouts">
          {L.map((l) => (
            <button key={l.id} class="tag-big" onClick={() => setLayout(l.id)}>
              <b>{l.title}</b>
              <span>{l.text}</span>
            </button>
          ))}
        </div>
      )}
      {layout && (
        <>
          <div class="tag-teams">
            <div class="tag-team mine">
              <em>Your team</em>
              <b>You</b>
              {layout === 'together' ? (
                <b>Your brother</b>
              ) : (
                <button class="tag-pick" onClick={() => setPicking(0)}>
                  {mine.name} <i>change</i>
                </button>
              )}
            </div>
            <div class="tag-team foe">
              <em>Against</em>
              {layout === 'split' ? (
                <>
                  <b>Your brother</b>
                  <button class="tag-pick" onClick={() => setPicking(1)}>
                    {his.name} <i>change</i>
                  </button>
                </>
              ) : (
                <>
                  <b>{foes[0].name}</b>
                  <b>{foes[1].name}</b>
                </>
              )}
            </div>
          </div>
          {layout === 'split' && <p class="so-dim so-center">Split teams: you and {mine.name} take on your brother and {his.name}. The duelists above sit this one out.</p>}
          {bad && <div class="so-warn">Fix your deck first: {p.deckProblems[0]}</div>}
          {layout === 'partner' ? (
            <Btn kind="gold" disabled={bad} onClick={() => p.onPlay(plan('partner'), 'here')}>
              Duel!
            </Btn>
          ) : (
            <>
              <Btn kind="gold" disabled={bad} onClick={() => p.onPlay(plan(layout), 'host')}>
                Create a room for your brother
              </Btn>
              <p class="so-dim so-center">You get a code. He taps Join your brother's room in 2v2 Tag Duels.</p>
            </>
          )}
          {layouts.length > 1 && <Btn onClick={() => setLayout(null)}>Other team setup</Btn>}
        </>
      )}
    </Sheet>
  );
}

function Road(p: Ctx & { back: () => void }) {
  const next = nextTagNode(p.solo);
  const [chId, setChId] = useState(() => {
    const id = p.report?.ctx.startsWith('road:') ? p.report.ctx.slice(5) : next.id;
    return TAG_CHAPTERS.find((c) => c.nodes.some((n) => n.id === id))?.id ?? TAG_CHAPTERS[0].id;
  });
  const [sel, setSel] = useState<TagNode | null>(null);
  const ch = TAG_CHAPTERS.find((c) => c.id === chId) ?? TAG_CHAPTERS[0];
  const rep = p.report?.ctx.startsWith('road:') ? p.report : null;
  const repNode = rep ? findTagNode(rep.ctx.slice(5))?.node : undefined;
  return (
    <>
      <Top title="Tag Road" sub="beat every pair with your partner" onBack={p.back} />
      <div class="so-body">
        <div class="so-chapters">
          {TAG_CHAPTERS.map((x) => {
            const open = tagChapterOpen(p.solo, x);
            const done = tagNodePassed(p.solo, x.nodes[x.nodes.length - 1].id);
            return (
              <button key={x.id} class={`so-chap ${x.id === ch.id ? 'on' : ''} ${done ? 'done' : ''}`} disabled={!open} onClick={() => setChId(x.id)}>
                {open ? x.n : '🔒'}
              </button>
            );
          })}
        </div>
        <div class="so-chapter">
          <div class="so-chapter-h">
            <span>Chapter {ch.n}</span>
            <b>{ch.title}</b>
          </div>
        </div>
        <div class="so-path">
          {ch.nodes.map((n, i) => {
            const open = tagNodeOpen(p.solo, ch, i);
            const won = tagNodePassed(p.solo, n.id);
            const a = foeOf(n.pair[0]);
            const b = foeOf(n.pair[1]);
            return (
              <button key={n.id} class={`so-node tag-node ${n.boss ? 'boss' : ''} ${open ? '' : 'locked'} ${won ? 'won' : ''} ${n.id === next.id ? 'next' : ''}`} disabled={!open} onClick={() => setSel(n)}>
                <span class="tag-pair">
                  <Portrait d={a} size="s" />
                  <Portrait d={b} size="s" />
                </span>
                <div class="so-node-t">
                  <b>{open ? pairName(n) : '???'}</b>
                  <span>{open ? (n.boss ? 'Boss pair' : `${a.title} & ${b.title}`) : 'Win the tag duel before this one'}</span>
                </div>
                {won && <span class="tag-check">✓</span>}
              </button>
            );
          })}
        </div>
        <DeckBar {...p} />
      </div>
      {sel && (
        <WithWho
          p={p}
          title={sel.boss ? 'BOSS TAG DUEL' : 'TAG DUEL'}
          layouts={['together', 'partner']}
          foes={[foeOf(sel.pair[0]), foeOf(sel.pair[1])]}
          ctx={`road:${sel.id}`}
          level={tagLevel(sel)}
          onClose={() => setSel(null)}
        />
      )}
      {rep && repNode && (
        <Sheet>
          <ResultBanner result={rep.result} />
          <p class="so-center">{rep.result === 'w' ? `You beat ${pairName(repNode)}!` : `${pairName(repNode)} won this time.`}</p>
          {rep.settled && rep.settled.lines.length > 0 && (
            <div class="tag-rewards">
              <b>First win rewards</b>
              {rep.settled.cards.length > 0 && (
                <div class="tag-cards">
                  {rep.settled.cards.slice(0, 12).map((c, i) => (
                    <CardImg key={i} name={c} />
                  ))}
                </div>
              )}
            </div>
          )}
          {rep.noEarn && rep.result === 'w' && <p class="so-dim so-center">An Anything goes deck earns nothing, but the win counts on the road. This pair's prizes wait for a win with your own cards.</p>}
          {rep.settled?.cleared && <p class="so-center tag-clear">Chapter {rep.settled.cleared.n} cleared! The next chapter is open.</p>}
          <Btn kind="gold" onClick={p.onReportSeen}>
            Continue
          </Btn>
        </Sheet>
      )}
    </>
  );
}

function Free(p: Ctx & { back: () => void }) {
  const all = TAG_CHAPTERS.flatMap((c) => c.nodes);
  const [sel, setSel] = useState<TagNode | null>(null);
  const rep = p.report && !p.report.ctx.startsWith('road:') ? p.report : null;
  return (
    <>
      <Top title="Tag Duel" sub="pick the pair to face; counts for nothing" onBack={p.back} />
      <div class="so-body">
        <DeckBar {...p} />
        <Btn kind="gold" onClick={() => setSel(all[Math.floor(Math.random() * all.length)])}>
          Random pair
        </Btn>
        <div class="so-path">
          {all.map((n) => (
            <button key={n.id} class={`so-node tag-node ${n.boss ? 'boss' : ''}`} onClick={() => setSel(n)}>
              <span class="tag-pair">
                <Portrait d={foeOf(n.pair[0])} size="s" />
                <Portrait d={foeOf(n.pair[1])} size="s" />
              </span>
              <div class="so-node-t">
                <b>{pairName(n)}</b>
                <span>{TAG_CHAPTERS.find((c) => c.nodes.includes(n))?.title}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
      {sel && <WithWho p={p} title="TAG DUEL" layouts={['together', 'split', 'partner']} foes={[foeOf(sel.pair[0]), foeOf(sel.pair[1])]} ctx="free" level="normal" onClose={() => setSel(null)} />}
      {rep && (
        <Sheet>
          <ResultBanner result={rep.result} />
          <Btn kind="gold" onClick={p.onReportSeen}>
            Continue
          </Btn>
        </Sheet>
      )}
    </>
  );
}

/**
 * The strip over a tag duel's board: the four duelists in turn order with the one in for each
 * team lit, who is moving now, and (while your partner is in) a button to look at your own hand.
 */
export function TagBar({ state, phone, labels }: { state: DuelState; phone: Pid; labels: (side: Pid, member: 0 | 1) => string }) {
  const [peek, setPeek] = useState(false);
  const t = state.tag;
  if (!t || state.winner !== null) return null;
  const mySide = sideOfPhone(state, phone);
  const myMember = t.ctl ? (t.ctl[mySide].indexOf(phone) as -1 | 0 | 1) : 0;
  const mine = myMember === 0 || myMember === 1 ? benchHand(state, mySide, myMember) : null;
  const order: [Pid, 0 | 1][] = [
    [mySide, 0],
    [mySide === 0 ? 1 : 0, 0],
    [mySide, 1],
    [mySide === 0 ? 1 : 0, 1],
  ];
  return (
    <>
      <div class="tagbar" role="status">
        {order.map(([side, m]) => {
          const isIn = activeMember(state, side) === m;
          const turn = state.turnPlayer === side && isIn;
          return (
            <span key={`${side}${m}`} class={`tb-d ${side === mySide ? 'ally' : 'foe'} ${isIn ? 'in' : ''} ${turn ? 'turn' : ''}`}>
              {labels(side, m)}
            </span>
          );
        })}
        {mine && (
          <button class="tb-peek" onClick={() => setPeek(true)}>
            Hand {mine.length}
          </button>
        )}
      </div>
      {peek && mine && (
        <div class="tb-shade" onClick={() => setPeek(false)}>
          <div class="tb-sheet" onClick={(e) => e.stopPropagation()}>
            <b>Your hand: you play it on your next turn</b>
            <div class="tb-hand">
              {mine.map((c) => (
                <CardImg key={c.uid} name={c.name} />
              ))}
            </div>
            <button class="so-btn plain" onClick={() => setPeek(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
