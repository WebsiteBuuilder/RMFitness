// Card Legends: story chapters told by the cards, between duels. A list of legend covers, each
// opening a four-duel path; a story scene before each duel and after each win; the daily
// Legend Rematch; Duel Chips for firsts. Rules and content live in speedCampaign/legends.ts.
import { useState } from 'preact/hooks';
import { owned as ownedCopies, type SpeedDeck } from '../eds/speedSave';
import { roadDeckProblems } from '../eds/speedCampaign/campaign';
import {
  LEGENDS,
  LEGEND_CHIPS_TOTAL,
  LEGEND_DUEL_CHIPS,
  LEGEND_FINISH_CHIPS,
  REMATCH_CHIPS,
  findLegendDuel,
  legendBorrowed,
  legendById,
  legendDuelOpen,
  legendDuelWon,
  legendFinished,
  legendFoe,
  legendLevel,
  legendOpen,
  legendWins,
  legendsProgress,
  nextLegendDuel,
  rematchOf,
  rematchPays,
  type Legend,
  type LegendDuel,
  type Line,
} from '../eds/speedCampaign/legends';
import { CardImg } from './CardImg';
import { Btn, CardRow, Portrait, ResultBanner, Sheet, Top, ace, skillName, type Ctx } from './Solo';
import './legends.css';

/** Decks that can enter: built from cards you own (the road deck counts; "Anything goes" decks don't). */
function eligibleDecks(p: Ctx): SpeedDeck[] {
  const out: SpeedDeck[] = [];
  const seen = new Set<string>();
  for (const d of [...(p.speed.road ? [p.speed.road] : []), ...p.speed.decks]) {
    if (d.open || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
  }
  return out;
}

export function Legends(p: Ctx) {
  const { solo, setSolo, speed } = p;
  const lp = legendsProgress(solo);
  const decks = eligibleDecks(p);
  const deck = decks.find((d) => d.id === lp.deckId) ?? decks.find((d) => roadDeckProblems(speed, d).length === 0) ?? decks[0] ?? null;
  const problems = deck ? roadDeckProblems(speed, deck) : ['Build a deck from cards you own first (Speed Duel menu → Decks), or start the Millennium Road.'];
  const rep = p.report?.kind === 'legend' ? p.report : null;
  const repFound = rep ? findLegendDuel(rep.duelId) : null;
  const [openId, setOpenId] = useState<string | null>(() => repFound?.legend.id ?? null);
  const [scene, setScene] = useState<{ duel: LegendDuel; rematch: boolean } | null>(null);
  const [help, setHelp] = useState(false);
  const [deckPick, setDeckPick] = useState(false);
  const next = nextLegendDuel(solo);
  const rematch = rematchOf(solo);
  const pays = rematchPays(solo);
  const finished = lp.finished ? legendById(lp.finished) : null;
  const done = LEGENDS.filter((l) => legendFinished(solo, l)).length;
  const sel = openId ? legendById(openId) : null;

  const duel = (d: LegendDuel, isRematch: boolean) => {
    const found = findLegendDuel(d.id)!;
    const foe = legendFoe(d);
    const borrowed = legendBorrowed(d);
    const mine = borrowed ?? (deck && !problems.length ? { name: p.name, main: deck.main, extra: deck.extra, skill: deck.skill } : null);
    if (!mine) return;
    const deckOfFoe = { main: foe.main.flatMap((e) => (/\*\d$/.test(e) ? Array<string>(Number(e.slice(-1))).fill(e.slice(0, -2)) : [e])), extra: foe.extra.flatMap((e) => (/\*\d$/.test(e) ? Array<string>(Number(e.slice(-1))).fill(e.slice(0, -2)) : [e])) };
    const first = !legendDuelWon(solo, d.id);
    const notes = [
      ...(d.condition ? [d.condition.text] : []),
      ...(first ? [`First win: ${LEGEND_DUEL_CHIPS} Duel Chip${found.index === found.legend.duels.length - 1 ? `, plus ${found.legend.card}, ${LEGEND_FINISH_CHIPS} more chips, a pack and a title` : ''}.`] : isRematch && pays ? [`Legend Rematch: a win pays ${REMATCH_CHIPS} Duel Chip today.`] : ['Already won: this replay pays nothing.']),
    ];
    p.onDuel({
      me: { name: mine.name, main: mine.main, extra: mine.extra, skill: mine.skill, setup: d.condition?.player },
      cpu: { name: foe.name, main: deckOfFoe.main, extra: deckOfFoe.extra, skill: foe.skill, setup: d.condition?.cpu },
      first: d.condition?.cpuFirst ? 'cpu' : 'coin',
      context: { kind: 'legend', duelId: d.id, ...(isRematch ? { rematch: true } : {}) },
      level: legendLevel(found.legend, found.index),
      vs: {
        label: isRematch ? 'LEGEND REMATCH' : borrowed ? `STORY DUEL · YOU ARE ${borrowed.name.toUpperCase()}` : `LEGEND ${found.legend.n} · ${found.legend.title.toUpperCase()}`,
        mePortrait: borrowed ? found.legend.card : ace(mine.main),
        cpuPortrait: foe.portrait,
        cpuTitle: foe.title,
        line: foe.intro,
        notes,
        goals: [],
      },
    });
  };

  const seen = () => p.onReportSeen();
  const clearFinished = () => setSolo({ ...solo, legends: { ...lp, finished: undefined } });

  return (
    <div class="screen so road lg">
      <Top
        title="Card Legends"
        sub={`${done}/${LEGENDS.length} legends · ${speed.chips ?? 0}/30 Duel Chips`}
        onBack={sel ? () => setOpenId(null) : p.onExit}
        right={
          <button class="so-chip" onClick={() => setHelp(true)}>
            Rewards
          </button>
        }
      />
      {!sel ? (
        <div class="so-body">
          <p class="so-blurb">Every famous card has a story. Duel through it, hear it from the card itself, and earn Duel Chips along the way.</p>
          {rematch && (
            <button class={`lg-rematch ${pays ? '' : 'spent'}`} disabled={!pays || (!legendBorrowed(rematch) && problems.length > 0)} onClick={() => setScene({ duel: rematch, rematch: true })}>
              <Portrait d={legendFoe(rematch)} size="s" />
              <div>
                <span class="so-label">TODAY'S LEGEND REMATCH</span>
                <b>
                  {rematch.title} · {legendFoe(rematch).name}
                </b>
                <span>{pays ? `Win it to earn ${REMATCH_CHIPS} Duel Chip. A new rematch comes tomorrow.` : 'Done for today. A new rematch comes tomorrow.'}</span>
              </div>
            </button>
          )}
          {next && (
            <Btn kind="gold" disabled={!legendBorrowed(next.duel) && problems.length > 0} onClick={() => (setOpenId(next.legend.id), setScene({ duel: next.duel, rematch: false }))}>
              Continue: {next.legend.card}, duel {next.index + 1}
            </Btn>
          )}
          <div class="lg-covers">
            {LEGENDS.map((l, i) => {
              const open = legendOpen(solo, l);
              const w = legendWins(solo, l);
              return (
                <button key={l.id} class={`lg-cover ${open ? '' : 'locked'} ${legendFinished(solo, l) ? 'done' : ''}`} disabled={!open} onClick={() => setOpenId(l.id)}>
                  <div class="lg-art">
                    <CardImg name={l.card} />
                  </div>
                  <span class="lg-n">Legend {l.n}</span>
                  <b>{open ? l.title : '???'}</b>
                  <span class="lg-prog">{open ? `${w}/${l.duels.length} duels` : `Finish legend ${i} first`}</span>
                </button>
              );
            })}
          </div>
          <DeckBar deck={deck} problems={problems} onPick={() => setDeckPick(true)} />
        </div>
      ) : (
        <LegendView {...p} legend={sel} deckProblems={problems} onScene={(d) => setScene({ duel: d, rematch: false })} deck={deck} onPickDeck={() => setDeckPick(true)} />
      )}

      {scene && <SceneSheet legend={findLegendDuel(scene.duel.id)!.legend} lines={scene.duel.scene} title={scene.duel.title} borrowed={legendBorrowed(scene.duel)?.name ?? null} onClose={() => setScene(null)} onGo={() => (setScene(null), duel(scene.duel, scene.rematch))} />}
      {deckPick && (
        <Sheet title="Deck for Card Legends" onClose={() => setDeckPick(false)}>
          {decks.length === 0 && <p class="so-dim">No decks built from owned cards yet. Start the Millennium Road or build a deck from your collection.</p>}
          {decks.map((d) => {
            const pr = roadDeckProblems(speed, d);
            return (
              <button key={d.id} class={`lg-deck ${deck?.id === d.id ? 'on' : ''}`} onClick={() => (setSolo({ ...solo, legends: { ...lp, deckId: d.id } }), setDeckPick(false))}>
                <b>{d.name}</b>
                <span class={pr.length ? 'so-bad' : 'so-good'}>{pr.length ? pr[0] : `${d.main.length} cards · ${skillName(d.skill)}`}</span>
              </button>
            );
          })}
          <p class="so-dim">"Anything goes" decks can't enter: Card Legends pays chips, so it only takes decks made from cards you own.</p>
        </Sheet>
      )}
      {help && (
        <Sheet title="What Card Legends pays" onClose={() => setHelp(false)}>
          <div class="so-reward">First win of every duel: {LEGEND_DUEL_CHIPS} Duel Chip</div>
          <div class="so-reward">Finish a legend: the legend card, {LEGEND_FINISH_CHIPS} more Duel Chips, a pack and a title</div>
          <div class="so-reward">Today's Legend Rematch: {REMATCH_CHIPS} Duel Chip a day</div>
          <p class="so-dim">
            That's {LEGEND_CHIPS_TOTAL} chips across the 8 legends, plus one a day from the rematch. Chips stop at 30, so spend them in the Card Shop. Replays and losses pay nothing.
          </p>
        </Sheet>
      )}

      {rep && repFound && (
        <ResultSheet
          {...p}
          rep={rep}
          onDone={() => {
            seen();
            if (rep.outcome.result === 'w' && !rep.settled.finished) {
              const n = nextLegendDuel(solo);
              if (n && n.legend.id === repFound.legend.id && !rep.rematch) setScene({ duel: n.duel, rematch: false });
            }
          }}
        />
      )}
      {!rep && finished && <FinishedSheet legend={finished} onDone={() => (clearFinished(), setOpenId(null))} />}
    </div>
  );
}

function DeckBar({ deck, problems, onPick }: { deck: SpeedDeck | null; problems: string[]; onPick: () => void }) {
  return (
    <div class="so-deckbar">
      <div>
        <b>Your deck{deck ? `: ${deck.name}` : ''}</b>
        <span class={problems.length ? 'so-bad' : 'so-good'}>{problems.length ? problems[0] : `${deck!.main.length} cards · ${skillName(deck!.skill)}`}</span>
      </div>
      <Btn kind="blue" onClick={onPick}>
        Change
      </Btn>
    </div>
  );
}

function LegendView(p: Ctx & { legend: Legend; deck: SpeedDeck | null; deckProblems: string[]; onScene: (d: LegendDuel) => void; onPickDeck: () => void }) {
  const { solo, legend: l } = p;
  return (
    <div class="so-body">
      <div class="lg-head">
        <div class="lg-art big">
          <CardImg name={l.card} />
        </div>
        <div>
          <span class="so-label">LEGEND {l.n}</span>
          <h3>{l.title}</h3>
          <p class="so-dim">{l.blurb}</p>
        </div>
      </div>
      <div class="so-path">
        {l.duels.map((d, i) => {
          const open = legendDuelOpen(solo, l, i);
          const won = legendDuelWon(solo, d.id);
          const foe = legendFoe(d);
          const last = i === l.duels.length - 1;
          return (
            <button key={d.id} class={`so-node ${last ? 'boss' : ''} ${open ? '' : 'locked'} ${won ? 'won' : ''}`} disabled={!open} onClick={() => p.onScene(d)}>
              <Portrait d={foe} size={last ? 'm' : 's'} />
              <div class="so-node-t">
                <b>{open ? d.title : '???'}</b>
                <span>{open ? `vs ${foe.name}` : 'Win the duel before this one'}</span>
                {open && d.as && <em>Story duel: you play as {d.as.name}</em>}
                {open && last && <em>Finale · {l.card}</em>}
              </div>
              <span class={`lg-pay ${won ? 'won' : ''}`}>{won ? '✓' : `+${LEGEND_DUEL_CHIPS + (last ? LEGEND_FINISH_CHIPS : 0)}`}</span>
            </button>
          );
        })}
      </div>
      <DeckBar deck={p.deck} problems={p.deckProblems} onPick={p.onPickDeck} />
    </div>
  );
}

/** The story before a duel: the card's own words in gold, everyone else with their name. */
function Scene({ legend, lines }: { legend: Legend; lines: Line[] }) {
  return (
    <div class="lg-scene">
      {lines.map((ln, i) => (
        <div key={i} class={`lg-line ${ln.who ? 'lg-who' : 'lg-card'}`} style={{ animationDelay: `${i * 0.25}s` }}>
          {ln.who ? <b>{ln.who}</b> : <b class="lg-cardname">{legend.card}</b>}
          <span>{ln.who ? `“${ln.text}”` : ln.text}</span>
        </div>
      ))}
    </div>
  );
}

function SceneSheet({ legend, lines, title, borrowed, onClose, onGo }: { legend: Legend; lines: Line[]; title: string; borrowed: string | null; onClose: () => void; onGo: () => void }) {
  return (
    <Sheet onClose={onClose}>
      <div class="so-intro">
        <div class="lg-art small">
          <CardImg name={legend.card} />
        </div>
        <div>
          <span class="so-label">{legend.title.toUpperCase()}</span>
          <h3>{title}</h3>
        </div>
      </div>
      <Scene legend={legend} lines={lines} />
      {borrowed && <div class="so-cond blue">You duel as {borrowed}, with their deck. Your own deck sits this one out.</div>}
      <Btn kind="gold" onClick={onGo}>
        Duel!
      </Btn>
    </Sheet>
  );
}

function ResultSheet(p: Ctx & { rep: Extract<NonNullable<Ctx['report']>, { kind: 'legend' }>; onDone: () => void }) {
  const { rep } = p;
  const found = findLegendDuel(rep.duelId)!;
  const foe = legendFoe(found.duel);
  const s = rep.settled;
  const won = rep.outcome.result === 'w';
  return (
    <Sheet>
      <ResultBanner result={rep.outcome.result} />
      <div class="so-intro">
        <Portrait d={foe} size="s" />
        <p class="so-quote">“{won ? foe.onLose : foe.onWin}”</p>
      </div>
      {won && s.firstWin && <Scene legend={found.legend} lines={found.duel.after} />}
      {won && s.cards.length > 0 && (
        <>
          <div class="so-group">Added to your collection</div>
          <CardRow names={s.cards} reveal own={(n) => ownedCopies(p.speed, n)} />
        </>
      )}
      {s.lines
        .filter((l) => !s.cards.includes(l))
        .map((l) => (
          <div key={l} class="so-reward">
            {l}
          </div>
        ))}
      {s.capped && <div class="so-warn">Your Duel Chips are full (30). Spend some in the Card Shop so the next ones aren't lost.</div>}
      {won && !s.firstWin && !s.rematchPaid && <p class="so-center so-dim">A replay: no chips this time.{rep.rematch ? ' The rematch already paid today.' : ''}</p>}
      {!won && <p class="so-center">A loss costs nothing. Tune your deck and try again.</p>}
      <Btn kind="gold" onClick={p.onDone}>
        Continue
      </Btn>
    </Sheet>
  );
}

function FinishedSheet({ legend, onDone }: { legend: Legend; onDone: () => void }) {
  const nextL = LEGENDS[LEGENDS.indexOf(legend) + 1];
  return (
    <Sheet>
      <div class="so-clear">
        <span class="so-label">LEGEND COMPLETE</span>
        <div class="lg-art hero">
          <CardImg name={legend.card} />
        </div>
        <h3>{legend.title}</h3>
        <p>
          {legend.card} joins your collection, with the title {legend.title_reward}.
        </p>
        {nextL ? <p>Next legend: {nextL.card}, “{nextL.title}”</p> : <p>Every legend is told. The cards remember you.</p>}
      </div>
      <Btn kind="gold" onClick={onDone}>
        Continue
      </Btn>
    </Sheet>
  );
}
