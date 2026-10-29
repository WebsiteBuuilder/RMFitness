// Duel School: the beginner tutorial, for someone who has never played any Yu-Gi-Oh! game.
// Five short lessons, each a few picture pages and (for the first four) a real Speed Duel
// against the coach the player picked, then a little quiz. Both Decks are stacked (drawn in the
// order given), the coach's moves are scripted, and each step says in plain words what to do;
// only the move a step asks for goes through, so nobody gets lost. Some steps are the player's
// own choice, and the coach says how it went either way.
import type { Engine } from './engine';
import { aiAction } from './ai';
import type { Action, Card, DuelState, FieldCard, Pid, SeatSetup } from './types';

// ---------- the coaches ----------
export interface Coach {
  id: string;
  name: string;
  /** their card on the picker and beside every line they say */
  art: string;
  hello: string;
  /** said when a move asked for is made */
  cheers: string[];
  /** said when a move the step doesn't want is tried */
  oops: string;
  win: string;
}

export const COACHES: Coach[] = [
  { id: 'yugi', name: 'Yugi', art: 'Dark Magician', hello: "Hi! I'm Yugi. Let's learn to duel together, one step at a time.", cheers: ['Great move!', "That's the heart of the cards!", "You're a natural!", 'Exactly right!'], oops: 'Not that one yet.', win: 'You did it! The heart of the cards is with you.' },
  { id: 'joey', name: 'Joey', art: 'Red-Eyes Black Dragon', hello: "Hey, I'm Joey! Dueling's easy once ya get it. Stick with me, pal.", cheers: ['Yeah! Dat\'s how ya do it!', 'Nice one, pal!', 'Now we\'re talkin\'!', 'Ha! Ya got it!'], oops: 'Whoa, hold up, not that one.', win: 'Ya beat me! You\'re a real duelist now!' },
  { id: 'tea', name: 'Téa', art: 'Dark Magician Girl', hello: "Hi, I'm Téa! Don't worry, I'll explain everything as we go.", cheers: ['Wonderful!', "See? You've got this!", 'Perfect!', 'That was great!'], oops: "Almost! Let's try a different card.", win: 'You won! I knew you could do it!' },
];
export const coachOf = (id: string | undefined): Coach => COACHES.find((c) => c.id === id) ?? COACHES[0];

// ---------- reading the board ----------
const handCard = (st: DuelState, p: Pid, name: string): Card | undefined => st.players[p].hand.find((c) => c.name === name);
const onField = (st: DuelState, p: Pid, name?: string): FieldCard | undefined => st.players[p].mz.find((m): m is FieldCard => !!m && (!name || m.name === name));
const inGy = (st: DuelState, p: Pid, name: string) => st.players[p].gy.some((c) => c.name === name);
const monsters = (st: DuelState, p: Pid) => st.players[p].mz.filter((m): m is FieldCard => !!m);
const uidOf = (c?: Card) => c?.uid ?? -1;
const is = <K extends Action['type']>(a: Action, k: K): a is Extract<Action, { type: K }> => a.type === k;

/** What the coach points at: a CSS selector on the Touch duel screen (`on` says whether one is showing now). */
export type Aim = (st: DuelState, on: (sel: string) => boolean) => string | null;

const zoneOf = (uid: number) => `.tz[data-uid="${uid}"]`;
/** a hand card: its button once the card is picked, the card before that; a question it asks, the question */
const handAim =
  (name: string, button: 'Summon' | 'Set' | 'Activate'): Aim =>
  (st, on) => {
    if (on('.tsheet')) return on('.tsheet .toptions') ? '.tsheet .toptions' : '.tsheet .tbtns';
    const uid = uidOf(handCard(st, 0, name));
    if (uid < 0) return null;
    if (on(`.thcard.sel[data-uid="${uid}"]`)) return `.tactions .taction[data-label="${button}"]`;
    return `.thand [data-uid="${uid}"]`;
  };
const phaseAim =
  (item: 'battle' | 'end'): Aim =>
  (_st, on) =>
    on('.tphase-menu') ? (item === 'end' ? '.tphase-item.end' : '.tphase-item:not(.end)') : '.tphase-btn';
/** attacking with a monster: the monster, then its Attack button, then the target */
const attackAim =
  (attacker: (st: DuelState) => FieldCard | undefined, target: (st: DuelState) => number | null): Aim =>
  (st, on) => {
    const m = attacker(st);
    if (!m) return null;
    const t = target(st);
    if (on('.duel.aiming')) return t === null ? '.tbar.top' : zoneOf(t);
    return on(`.tz.sel[data-uid="${m.uid}"]`) ? '.tactions .taction' : zoneOf(m.uid);
  };

export interface TutStep {
  id: string;
  title: string;
  /** plain words: what this is, then what to do (it may depend on how a choice went) */
  text: string | ((st: DuelState) => string);
  /** info: read it, tap Next · do: make the move asked for · watch: the coach moves */
  kind: 'info' | 'do' | 'watch';
  /** a move the player gets to choose (the screen says so) */
  choice?: boolean;
  /** only shown when this holds (the other side of a choice skips it) */
  when?: (st: DuelState) => boolean;
  aim?: Aim;
  /** the moves this step lets through (do steps) */
  allow?: (a: Action, st: DuelState) => boolean;
  /** the step is over (do and watch steps) */
  done?: (st: DuelState) => boolean;
  /** said when a move the step doesn't want is tried */
  nudge?: string;
  /** the question on screen must be answered, not passed (a Trap to spring) */
  noPass?: boolean;
}

export const textOf = (s: TutStep, st: DuelState) => (typeof s.text === 'function' ? s.text(st) : s.text);

// ---------- step makers ----------
const summonStep = (id: string, name: string, title: string, text: string, opts: { set?: boolean; nudge?: string } = {}): TutStep => ({
  id,
  kind: 'do',
  title,
  text,
  aim: handAim(name, opts.set ? 'Set' : 'Summon'),
  allow: (a, st) => is(a, 'SUMMON') && a.uid === uidOf(handCard(st, 0, name)) && a.faceUp === !opts.set && a.pos === (opts.set ? 'def' : 'atk'),
  done: (st) => !!onField(st, 0, name),
  nudge: opts.nudge ?? `Tap ${name}, then tap ${opts.set ? 'Set' : 'Summon'}.`,
});
const setTrapStep = (id: string, name: string, text: string): TutStep => ({
  id,
  kind: 'do',
  title: 'Set a Trap',
  text,
  aim: handAim(name, 'Set'),
  allow: (a, st) => is(a, 'SET_ST') && a.uid === uidOf(handCard(st, 0, name)),
  done: (st) => st.players[0].sz.some((c) => c?.name === name),
  nudge: `Tap ${name}, then tap Set.`,
});
const endStep = (id: string, text: string): TutStep => ({
  id,
  kind: 'do',
  title: 'End your turn',
  text,
  aim: phaseAim('end'),
  allow: (a) => is(a, 'END_TURN') || is(a, 'NEXT_PHASE'),
  done: (st) => st.turnPlayer === 1,
  nudge: 'Tap the round phase button on the right, then End Turn.',
});
const battleStep = (id: string, text: string): TutStep => ({
  id,
  kind: 'do',
  title: 'Go to battle',
  text,
  aim: phaseAim('battle'),
  allow: (a) => is(a, 'NEXT_PHASE'),
  done: (st) => st.phase === 'BP',
  nudge: 'Tap the round phase button on the right, then Battle Phase.',
});
/** the coach's turn is over and yours has started (the draw done, nothing asked) */
const yourTurn = (n: number) => (st: DuelState) => st.turn === n && st.turnPlayer === 0 && st.phase === 'M1' && !st.prompt;

// ---------- lessons ----------
export interface Slide {
  title: string;
  text: string;
  /** card pictures with a short caption under each */
  cards?: { name: string; label: string }[];
}
export interface QuizQ {
  q: string;
  options: string[];
  /** the right option's index */
  right: number;
  /** why: shown after any answer */
  why: string;
}
export interface LessonDuel {
  start: (me: string, coach: string) => Action;
  steps: TutStep[];
  /** the coach's next move (null: nothing to do) */
  coach: (e: Engine) => Action | null;
}
export interface Lesson {
  id: string;
  title: string;
  blurb: string;
  art: string;
  slides: Slide[];
  duel?: LessonDuel;
  quiz: QuizQ[];
}

/** 20-card Decks: the lesson's cards first (the opening hand, then the draws), filler after */
const deck = (cards: string[], filler = 'Feral Imp') => [...cards, ...Array(Math.max(0, 20 - cards.length)).fill(filler)];
const startAs = (first: Pid, mine: string[], theirs: string[], setup: [SeatSetup, SeatSetup], extra: string[] = [], skill: string | null = null) => (me: string, coach: string): Action => ({
  type: 'START',
  first,
  seed: 20261029,
  names: [me, coach],
  decks: [deck(mine), deck(theirs)],
  fusions: [extra, []],
  mode: 'speed',
  skills: [skill, null],
  setup: [{ stacked: true, ...setup[0] }, { stacked: true, ...setup[1] }],
});
/** the coach just ends the turn (a lesson where the coach goes first, so you draw and may attack) */
const passing = (e: Engine): Action | null => {
  const st = e.state;
  if (st.winner !== null) return null;
  if (st.prompt) return st.prompt.player === 1 ? (aiAction(e, 1) ?? { type: 'PASS', player: 1 }) : null;
  return st.turnPlayer === 1 ? { type: 'END_TURN', player: 1 } : null;
};
const coachPasses: TutStep = {
  id: 'coach-first',
  kind: 'watch',
  title: 'Coach goes first',
  text: "This time the coach goes first and just ends the turn. Going second has a bonus: you draw a card on your very first turn, and you may attack.",
  done: yourTurn(2),
};

// Lesson 1: the basics
const L1 = {
  first: 'La Jinn the Mystical Genie of the Lamp',
  trap: 'Sakuretsu Armor',
  big: 'Summoned Skull',
  spell: 'Monster Reborn',
  foe: 'Vorse Raider',
};
export const TUTORIAL_SKILL = 'Destiny Draw (Skill Card)';

const basics: Lesson = {
  id: 'basics',
  title: 'The basics',
  blurb: 'Cards, Life Points, summoning, Traps, Tributes, Spells, attacking',
  art: 'Summoned Skull',
  slides: [
    { title: 'What is a duel?', text: 'Two duelists play cards against each other. Each starts with 4000 Life Points (LP). Knock your opponent down to 0 and you win!' },
    {
      title: 'Three kinds of cards',
      text: 'Monsters fight for you. Spells are magic you use on your turn. Traps are set face-down and spring as a surprise, often on your opponent\'s turn.',
      cards: [
        { name: 'La Jinn the Mystical Genie of the Lamp', label: 'Monster (yellow or orange)' },
        { name: 'Monster Reborn', label: 'Spell (green)' },
        { name: 'Sakuretsu Armor', label: 'Trap (pink)' },
      ],
    },
    {
      title: 'Reading a monster',
      text: 'The stars at the top are its Level. ATK at the bottom is how hard it hits, DEF is how well it guards. Levels 1 to 4 are free to play. 5 and 6 need 1 Tribute, 7 and up need 2.',
      cards: [{ name: 'Summoned Skull', label: 'Level 6 · ATK 2500 · DEF 1200' }],
    },
    { title: 'Taking turns', text: 'A turn goes: Draw a card, then Main Phase (play cards), then Battle Phase (attack), then End. Speed Duel is the quick kind of duel: 4 cards in your first hand, 3 spots for monsters and 3 for Spells and Traps.' },
  ],
  duel: {
    start: startAs(0, [L1.first, L1.trap, L1.big, 'Celtic Guardian', L1.spell], [L1.foe, 'Mystical Elf', 'Beaver Warrior', 'Feral Imp', 'Battle Ox'], [{}, {}], [], TUTORIAL_SKILL),
    coach: (e) => {
      const st = e.state;
      if (st.winner !== null) return null;
      if (st.prompt) return st.prompt.player === 1 ? (aiAction(e, 1) ?? { type: 'PASS', player: 1 }) : null;
      if (st.turnPlayer !== 1) return null;
      const foe = handCard(st, 1, L1.foe);
      if (e.inMainPhase() && foe && !st.players[1].normalSummoned) return { type: 'SUMMON', player: 1, uid: foe.uid, zone: e.freeMonsterZone(1), pos: 'atk', faceUp: true };
      const m = onField(st, 1, L1.foe);
      if (m && st.turn === 2 && e.inMainPhase()) return { type: 'NEXT_PHASE', player: 1 };
      if (m && st.phase === 'BP' && e.canAttackWith(1, m)) {
        const t = onField(st, 0);
        return { type: 'ATTACK', player: 1, uid: m.uid, target: t ? t.uid : null };
      }
      return { type: 'END_TURN', player: 1 };
    },
    steps: [
      { id: 'board', kind: 'info', title: 'This is the duel', text: "Your side is the bottom half, the coach's is the top. The cards along the bottom are your hand: only you can see them.", aim: () => '.thand' },
      { id: 'lp', kind: 'info', title: 'Life Points', text: 'You both have 4000 Life Points (LP). Attacks take them away. Whoever hits 0 first loses.', aim: () => '.tbar.top .tlp' },
      { id: 'skill', kind: 'info', title: 'Your Skill', text: 'This button is your Skill: a special power you pick before a duel. Yours is Destiny Draw: if you ever lose 2000 LP, you may pick any card from your Deck to draw. Tap it any time to read it.', aim: () => '.tbar.bottom .tskill' },
      summonStep('summon', L1.first, 'Play a monster', 'La Jinn is Level 4 (4 stars), so it can be played for free. Tap La Jinn, then tap Summon. (You can also drag a card up onto the field.)', { nudge: 'Tap La Jinn (the green genie), then tap Summon.' }),
      { id: 'atk', kind: 'info', title: 'Attack Position', text: "La Jinn stands upright: that's Attack Position, ready to fight. The number under it is its ATK, 1800. You can only play one monster this way each turn.", aim: (st) => zoneOf(uidOf(onField(st, 0, L1.first))) },
      { id: 'tribute-later', kind: 'info', title: 'Big monsters cost more', text: "Summoned Skull is Level 6, too strong to play for free: it needs a Tribute (one of your monsters on the field goes to make room). You'll do that next turn.", aim: (st) => `.thand [data-uid="${uidOf(handCard(st, 0, L1.big))}"]` },
      setTrapStep('set', L1.trap, "Traps wait face-down for the right moment. Sakuretsu Armor destroys a monster that attacks you. Tap it, then tap Set."),
      endStep('end1', "Whoever goes first can't attack on their first turn, so you're done. Tap the round phase button on the right, then End Turn."),
      { id: 'coach-turn', kind: 'watch', title: "The coach's turn", text: 'Every turn starts by drawing a card. Watch what the coach does.', done: (st) => !!onField(st, 1, L1.foe) },
      { id: 'threat', kind: 'info', title: 'Uh oh', text: "The coach played Vorse Raider: 1900 ATK. That's more than La Jinn's 1800. When monsters fight, the bigger ATK wins.", aim: (st) => zoneOf(uidOf(onField(st, 1, L1.foe))) },
      { id: 'coach-attacks', kind: 'watch', title: 'The Battle Phase', text: "After playing cards, a duelist may move on to the Battle Phase and attack.", done: (st) => st.prompt?.player === 0 && st.prompt.kind === 'response' },
      {
        id: 'spring',
        kind: 'do',
        noPass: true,
        title: 'Spring your Trap!',
        text: 'Vorse Raider attacks La Jinn! If it hits, La Jinn is destroyed and you lose 100 LP (1900 minus 1800). Tap Sakuretsu Armor to spring it.',
        aim: (_st, on) => (on('.tsheet .toptions') ? '.tsheet .toptions' : null),
        allow: (a) => is(a, 'CHOOSE'),
        done: (st) => inGy(st, 1, L1.foe),
        nudge: "Tap Sakuretsu Armor to spring it. \"Don't chain\" would let the attack hit.",
      },
      { id: 'gy', kind: 'info', title: 'Gotcha!', text: 'Your Trap destroyed the attacker. Destroyed and used cards go to the Graveyard (GY), the pile beside the field. Tap a GY any time to look inside.', aim: () => '.tpile.gy[data-pile="gy1"]' },
      { id: 'coach-ends', kind: 'watch', title: "The coach's turn", text: 'With nothing left to attack with, the coach ends the turn.', done: yourTurn(3) },
      { id: 'drew', kind: 'info', title: 'You drew a card', text: 'Your turn started with a draw: Monster Reborn, a Spell. Spells do their thing right away. Keep it for a moment.', aim: (st) => `.thand [data-uid="${uidOf(handCard(st, 0, L1.spell))}"]` },
      {
        id: 'tribute',
        kind: 'do',
        title: 'Tribute Summon',
        text: 'Now play Summoned Skull (2500 ATK). Tap it, tap Summon, then pick La Jinn as the Tribute.',
        aim: handAim(L1.big, 'Summon'),
        allow: (a, st) => (is(a, 'SUMMON') && a.uid === uidOf(handCard(st, 0, L1.big)) && a.faceUp && a.pos === 'atk') || is(a, 'CHOOSE') || is(a, 'CANCEL'),
        done: (st) => !!onField(st, 0, L1.big) && !st.prompt,
        nudge: 'Tap Summoned Skull, then Summon, then pick La Jinn.',
      },
      {
        id: 'reborn',
        kind: 'do',
        choice: true,
        title: 'Use a Spell',
        text: "La Jinn went to the Graveyard. Monster Reborn brings back a monster from either Graveyard, even the coach's! Tap Monster Reborn, then Activate. Bring back La Jinn or Vorse Raider: you pick.",
        aim: handAim(L1.spell, 'Activate'),
        allow: (a, st) => (is(a, 'ACTIVATE') && a.uid === uidOf(handCard(st, 0, L1.spell))) || is(a, 'CHOOSE') || is(a, 'CANCEL') || (is(a, 'YES') && st.prompt?.kind === 'yesno'),
        done: (st) => monsters(st, 0).length >= 2 && !st.prompt,
        nudge: 'Tap Monster Reborn, then Activate. When it asks about Attack Position, say Yes so it can attack.',
      },
      {
        id: 'reborn-out',
        kind: 'info',
        title: 'Back from the Graveyard',
        text: (st) => (onField(st, 0, L1.foe) ? "Sneaky! You took the coach's own Vorse Raider (1900 ATK). Monsters you bring back fight for you." : 'La Jinn is back (1800 ATK)! Tributed monsters are not gone forever.'),
      },
      battleStep('battle', 'The coach has no monsters left to block, so your monsters can hit their Life Points directly. Tap the phase button, then Battle Phase.'),
      {
        id: 'hit',
        kind: 'do',
        title: 'Attack!',
        text: 'Tap Summoned Skull, then Attack directly. (You can also drag a monster up onto the coach.)',
        aim: attackAim((st) => onField(st, 0, L1.big), () => null),
        allow: (a, st) => is(a, 'ATTACK') && a.uid === uidOf(onField(st, 0, L1.big)) && a.target === null,
        done: (st) => !!onField(st, 0, L1.big)?.attacked && !st.prompt,
        nudge: 'Tap Summoned Skull, then Attack directly.',
      },
      {
        id: 'finish',
        kind: 'do',
        title: 'Finish it!',
        text: '2500 damage! The coach is down to 1500 LP. Attack with your other monster to win.',
        aim: attackAim((st) => monsters(st, 0).find((m) => m.name !== L1.big && !m.attacked), () => null),
        allow: (a) => is(a, 'ATTACK') && a.target === null,
        done: (st) => st.winner !== null,
        nudge: 'Tap your other monster, then Attack directly.',
      },
    ],
  },
  quiz: [
    { q: 'How do you win a duel?', options: ["Bring your opponent's Life Points to 0", 'Have the most cards in your hand', 'Summon 3 monsters'], right: 0, why: 'Everyone starts with 4000 LP. Hit 0 and you lose.' },
    { q: 'Which monster needs a Tribute to Summon?', options: ['A Level 4 monster', 'A Level 6 monster', 'A Level 1 monster'], right: 1, why: 'Level 5 and 6 need 1 Tribute, Level 7 and up need 2. Level 1 to 4 are free.' },
    { q: 'How does a Trap card work?', options: ['It works the moment you draw it', 'You Set it face-down, then spring it later, even on the opponent\'s turn', 'It only works with no monsters out'], right: 1, why: "Traps are Set first and wait for the right moment, like when you're attacked." },
  ],
};

// Lesson 2: battles, positions and the damage math
const L2 = { gaia: 'Gaia The Fierce Knight', celtic: 'Celtic Guardian', imp: 'Feral Imp', wall: 'Giant Soldier of Stone', hidden: 'Kuriboh' };
const battles: Lesson = {
  id: 'battles',
  title: 'Battles',
  blurb: 'Attack and Defense Position, face-down monsters, the damage math',
  art: 'Gaia The Fierce Knight',
  slides: [
    {
      title: 'Attack or Defense?',
      text: 'A monster standing upright is in Attack Position and fights with its ATK. Turned sideways it is in Defense Position and guards with its DEF. Face-down, it is a hidden monster in Defense Position.',
      cards: [
        { name: 'Feral Imp', label: 'Attack: ATK 1300' },
        { name: 'Giant Soldier of Stone', label: 'Defense: DEF 2000' },
      ],
    },
    { title: 'The damage math', text: "Attack a monster in Attack Position: the lower ATK is destroyed and its owner loses the difference. Attack a monster in Defense Position: if your ATK is higher it's destroyed, but nobody loses LP. If its DEF is higher, nothing is destroyed and YOU lose the difference." },
  ],
  duel: {
    start: startAs(1, [L2.celtic, 'Beaver Warrior', 'Mystical Elf', 'Axe Raider', 'Battle Ox'], [], [{ monsters: [L2.gaia] }, { lp: 1000, monsters: [L2.imp], defense: [L2.wall], facedown: [L2.hidden] }]),
    coach: passing,
    steps: [
      coachPasses,
      { id: 'look', kind: 'info', title: "The coach's monsters", text: 'Feral Imp stands upright: Attack Position, ATK 1300. Giant Soldier of Stone lies sideways: Defense Position, DEF 2000. The face-down card is a mystery monster, also in Defense Position.', aim: (st) => zoneOf(uidOf(onField(st, 1, L2.wall))) },
      { id: 'yours', kind: 'info', title: 'Your monster', text: 'You already have Gaia The Fierce Knight out: 2300 ATK. The coach has only 1000 LP left.', aim: (st) => zoneOf(uidOf(onField(st, 0, L2.gaia))) },
      summonStep('summon2', L2.celtic, 'Bring a friend', 'Summon Celtic Guardian (1400 ATK) too: tap it, then Summon.'),
      battleStep('bp2', 'Now to the Battle Phase: tap the phase button, then Battle Phase.'),
      {
        id: 'pick',
        kind: 'do',
        choice: true,
        title: 'Pick a target',
        text: 'Celtic Guardian (1400 ATK) can attack the sideways Giant Soldier of Stone (DEF 2000), or the face-down mystery card. Tap Celtic Guardian, tap Attack, then pick a target.',
        aim: (st, on) => {
          const c = onField(st, 0, L2.celtic);
          if (!c) return null;
          if (on('.duel.aiming')) return zoneOf(uidOf(onField(st, 1, L2.wall)));
          return on(`.tz.sel[data-uid="${c.uid}"]`) ? '.tactions .taction' : zoneOf(c.uid);
        },
        allow: (a, st) => {
          if (!is(a, 'ATTACK') || a.uid !== uidOf(onField(st, 0, L2.celtic))) return false;
          const t = monsters(st, 1).find((m) => m.uid === a.target);
          return !!t && (t.name === L2.wall || !t.faceUp);
        },
        done: (st) => !!onField(st, 0, L2.celtic)?.attacked && !st.prompt,
        nudge: 'Pick Giant Soldier of Stone (sideways) or the face-down card. Feral Imp is saved for Gaia.',
      },
      {
        id: 'pick-out',
        kind: 'info',
        title: 'How did it go?',
        text: (st) =>
          st.players[0].lp < 4000
            ? "Ouch! Giant Soldier's DEF 2000 is higher than Celtic's 1400 ATK. Nothing was destroyed and you lost the difference: 600 LP. Don't run into a wall!"
            : "The face-down card flipped up: Kuriboh, DEF 200. Celtic's 1400 ATK beats it, so it's destroyed. But the coach lost no LP: Defense Position protects its owner.",
      },
      {
        id: 'win2',
        kind: 'do',
        title: 'The winning hit',
        text: 'Gaia (2300 ATK) vs Feral Imp (1300 ATK) in Attack Position: the Imp is destroyed and the coach loses the difference, 1000. Attack Feral Imp to win!',
        aim: attackAim((st) => onField(st, 0, L2.gaia), (st) => uidOf(onField(st, 1, L2.imp))),
        allow: (a, st) => is(a, 'ATTACK') && a.uid === uidOf(onField(st, 0, L2.gaia)) && a.target === uidOf(onField(st, 1, L2.imp)),
        done: (st) => st.winner !== null,
        nudge: 'Tap Gaia, tap Attack, then tap Feral Imp (the one standing upright).',
      },
    ],
  },
  quiz: [
    { q: 'Your 1800 ATK monster attacks a 1200 ATK monster in Attack Position. What happens?', options: ['Both are destroyed', 'Theirs is destroyed and they lose 600 LP', 'Nothing happens'], right: 1, why: 'Higher ATK wins, and the loser\'s owner takes the difference: 1800 minus 1200.' },
    { q: 'Your 1400 ATK monster attacks a monster in Defense Position with 2000 DEF. What happens?', options: ['Their monster is destroyed', 'They lose 600 LP', 'Nothing is destroyed and you lose 600 LP'], right: 2, why: 'A higher DEF bounces the attack back at you.' },
    { q: 'How can you tell a monster is in Defense Position?', options: ["It's turned sideways", 'It glows red', "It's upside down"], right: 0, why: 'Upright is Attack Position, sideways is Defense Position.' },
  ],
};

// Lesson 3: effects and chains
const L3 = { flip: 'Old Vindictive Magician', trap: 'Sakuretsu Armor', kuri: 'Kuriboh', luster: 'Luster Dragon', fissure: 'Fissure', skull: 'Summoned Skull', imp: 'Feral Imp', jammer: 'Trap Jammer' };
const chains: Lesson = {
  id: 'chains',
  title: 'Effects and chains',
  blurb: 'FLIP effects, effects from your hand, answering a card with a card',
  art: 'Kuriboh',
  slides: [
    { title: 'Effect Monsters', text: "Orange monsters have an ability written in their text box. Some work when they're flipped face-up (FLIP), some from your hand, some once per turn. Read a card any time: tap it, then tap its text.", cards: [{ name: 'Old Vindictive Magician', label: 'FLIP: destroy a monster' }, { name: 'Kuriboh', label: 'From your hand: block damage' }] },
    { title: 'Chains', text: 'When a card is played, the other duelist may answer with a card of their own, and so on. That pile of answers is a chain. The LAST card played works FIRST.' },
  ],
  duel: {
    start: startAs(0, [L3.flip, L3.trap, L3.kuri, L3.luster, L3.fissure], [], [{}, { lp: 1900, monsters: [L3.skull, L3.imp], set: [L3.jammer] }]),
    coach: (e) => {
      const st = e.state;
      if (st.winner !== null) return null;
      if (st.prompt) {
        if (st.prompt.player !== 1) return null;
        const p = st.prompt;
        const jam = p.kind === 'response' ? p.options.findIndex((o) => o.label === L3.jammer) : -1;
        return jam >= 0 ? { type: 'CHOOSE', player: 1, picks: [jam] } : (aiAction(e, 1) ?? { type: 'PASS', player: 1 });
      }
      if (st.turnPlayer !== 1) return null;
      if (st.turn === 2 && e.inMainPhase()) return { type: 'NEXT_PHASE', player: 1 };
      if (st.phase === 'BP') {
        // the Skull first, into your face-down monster; then whatever can still attack
        const order = [onField(st, 1, L3.skull), onField(st, 1, L3.imp)].filter((m): m is FieldCard => !!m && e.canAttackWith(1, m));
        const m = order[0];
        if (m) {
          const t = onField(st, 0);
          return { type: 'ATTACK', player: 1, uid: m.uid, target: t ? t.uid : null };
        }
      }
      return { type: 'END_TURN', player: 1 };
    },
    steps: [
      { id: 'effect', kind: 'info', title: 'An Effect Monster', text: 'Old Vindictive Magician is orange: it has an effect. FLIP: when it is turned face-up, it destroys one of the coach\'s monsters.', aim: (st) => `.thand [data-uid="${uidOf(handCard(st, 0, L3.flip))}"]` },
      summonStep('set-flip', L3.flip, 'Set a monster', 'Play it face-down so it can be flipped later: tap Old Vindictive Magician, then Set. Face-down monsters are in Defense Position.', { set: true }),
      setTrapStep('set-trap3', L3.trap, 'Set your Sakuretsu Armor too: tap it, then Set.'),
      { id: 'kuri', kind: 'info', title: 'Help from your hand', text: 'Kuriboh works from your hand: when an attack would hurt you, throw it away and take no damage. Keep it in your hand for now.', aim: (st) => `.thand [data-uid="${uidOf(handCard(st, 0, L3.kuri))}"]` },
      { id: 'their-set', kind: 'info', title: 'Careful!', text: "The coach has a face-down card in the back row: a Spell or a Trap. You can't see which until it's used.", aim: (st) => { const c = st.players[1].sz.find((x) => !!x); return c ? zoneOf(c.uid) : null; } },
      endStep('end3', 'Done for now. Tap the phase button, then End Turn.'),
      { id: 'c3', kind: 'watch', title: "The coach's turn", text: 'The coach goes straight to battle…', done: (st) => st.prompt?.player === 0 && st.prompt.kind === 'response' },
      {
        id: 'spring3',
        kind: 'do',
        noPass: true,
        title: 'Spring your Trap',
        text: 'Summoned Skull attacks your face-down monster! Spring Sakuretsu Armor on it: tap the card.',
        aim: (_st, on) => (on('.tsheet .toptions') ? '.tsheet .toptions' : null),
        allow: (a) => is(a, 'CHOOSE'),
        done: (st) => inGy(st, 0, L3.trap),
        nudge: 'Tap Sakuretsu Armor to spring it.',
      },
      { id: 'chain', kind: 'info', title: 'A chain!', text: "The coach answered with their face-down card, Trap Jammer. That's a chain: the last card played works first, so Trap Jammer stopped your Sakuretsu Armor before it could work.", aim: () => '.tpile.gy[data-pile="gy1"]' },
      {
        id: 'flip',
        kind: 'do',
        choice: true,
        title: 'FLIP!',
        text: "The attack flipped your Old Vindictive Magician face-up. It loses the fight, but its FLIP effect still goes off. Destroy Summoned Skull (2500 ATK) or Feral Imp (1300 ATK)? Tap one.",
        aim: (_st, on) => (on('.tsheet .toptions') ? '.tsheet .toptions' : null),
        allow: (a) => is(a, 'CHOOSE'),
        done: (st) => (inGy(st, 1, L3.skull) || inGy(st, 1, L3.imp)) && st.prompt?.kind !== 'select',
        nudge: 'Tap Summoned Skull or Feral Imp.',
      },
      { id: 'flip-out', kind: 'info', title: 'Boom', text: (st) => (inGy(st, 1, L3.skull) ? 'Smart: Summoned Skull was the biggest threat. But Feral Imp can still attack, and you have no monsters left…' : "Feral Imp is gone. Summoned Skull already attacked this turn, so you're safe for now.") },
      { id: 'c3b', kind: 'watch', title: "The coach's turn", text: 'Here it comes…', done: (st) => (st.prompt?.player === 0 && st.prompt.kind === 'yesno') || yourTurn(3)(st) },
      {
        id: 'kuri-use',
        kind: 'do',
        choice: true,
        title: 'Kuriboh time?',
        text: 'Feral Imp attacks you directly for 1300! Throw Kuriboh away to take no damage (Yes), or keep it and take the hit (No).',
        aim: () => '.tsheet .tbtns',
        allow: (a, st) => (is(a, 'YES') || is(a, 'NO')) && st.prompt?.kind === 'yesno',
        done: (st) => st.prompt?.kind !== 'yesno',
      },
      { id: 'kuri-out', kind: 'info', title: 'Phew', when: (st) => st.turn === 2, text: (st) => (inGy(st, 0, L3.kuri) ? 'Kuriboh took the hit for you: no damage!' : 'You kept Kuriboh, and took 1300 damage. Sometimes saving a card for later is worth it.') },
      { id: 'c3c', kind: 'watch', title: "The coach's turn", text: 'The coach ends the turn.', done: yourTurn(3) },
      { id: 'drew3', kind: 'info', title: 'A new Spell', text: "You drew Fissure: it destroys the coach's face-up monster with the lowest ATK. With only one monster there, that's the one!", aim: (st) => `.thand [data-uid="${uidOf(handCard(st, 0, L3.fissure))}"]` },
      {
        id: 'fissure',
        kind: 'do',
        title: 'Clear the way',
        text: 'Tap Fissure, then Activate.',
        aim: handAim(L3.fissure, 'Activate'),
        allow: (a, st) => (is(a, 'ACTIVATE') && a.uid === uidOf(handCard(st, 0, L3.fissure))) || is(a, 'CHOOSE'),
        done: (st) => monsters(st, 1).length === 0 && !st.prompt,
        nudge: 'Tap Fissure, then Activate.',
      },
      summonStep('luster', L3.luster, 'Summon', 'The coach has 1900 LP and no monsters. Summon Luster Dragon (1900 ATK).'),
      battleStep('bp3', 'Tap the phase button, then Battle Phase.'),
      { id: 'win3', kind: 'do', title: 'Exactly enough', text: 'Attack directly with Luster Dragon: 1900 damage for the win!', aim: attackAim((st) => onField(st, 0, L3.luster), () => null), allow: (a) => is(a, 'ATTACK') && a.target === null, done: (st) => st.winner !== null, nudge: 'Tap Luster Dragon, then Attack directly.' },
    ],
  },
  quiz: [
    { q: 'In a chain, which card works first?', options: ['The first one played', 'The last one played', 'The strongest one'], right: 1, why: 'A chain works backwards: the newest answer goes first.' },
    { q: 'What is a FLIP effect?', options: ['An effect that happens when a face-down monster is turned face-up', 'A coin toss', 'Turning a monster sideways'], right: 0, why: 'Old Vindictive Magician went off when the attack flipped it.' },
    { q: "Where does Kuriboh's effect work from?", options: ['Your Graveyard', 'Your Deck', 'Your hand'], right: 2, why: 'Some effects work straight from your hand, like Kuriboh.' },
  ],
};

// Lesson 4: the Extra Deck and Fusion
const L4 = { poly: 'Polymerization', fm: 'Flame Manipulator', masaki: 'Masaki the Legendary Swordsman', gaia: 'Gaia The Fierce Knight', curse: 'Curse of Dragon', flame: 'Flame Swordsman', champ: 'Gaia the Dragon Champion' };
const fusion: Lesson = {
  id: 'fusion',
  title: 'The Extra Deck',
  blurb: 'Fusion Summons: two monsters become one strong one',
  art: 'Gaia the Dragon Champion',
  slides: [
    { title: 'The Extra Deck', text: 'Besides your Deck, you can have a small Extra Deck (up to 6 cards). It holds Fusion Monsters: strong monsters you make by combining others with a card like Polymerization.', cards: [{ name: 'Polymerization', label: 'The Fusion Spell' }, { name: 'Flame Swordsman', label: 'A Fusion Monster' }] },
    { title: 'Fusion Materials', text: 'A Fusion Monster lists the monsters it\'s made from at the top of its text. Have them in your hand or on the field, play Polymerization, and they go to the Graveyard to make it.', cards: [{ name: 'Flame Manipulator', label: 'Material' }, { name: 'Masaki the Legendary Swordsman', label: 'Material' }] },
  ],
  duel: {
    start: startAs(1, [L4.poly, L4.fm, L4.masaki, L4.gaia, L4.curse], [], [{}, { lp: 1800 }], [L4.flame, L4.champ]),
    coach: passing,
    steps: [
      coachPasses,
      { id: 'extra', kind: 'info', title: 'Your Extra Deck', text: 'This button is your Extra Deck. Two Fusion Monsters wait in it: Flame Swordsman and Gaia the Dragon Champion. Tap it any time to look.', aim: () => '.tpile.deck[data-pile="deck0"] .textra button' },
      { id: 'mats', kind: 'info', title: 'You have both!', text: 'Flame Swordsman = Flame Manipulator + Masaki the Legendary Swordsman. Gaia the Dragon Champion = Gaia The Fierce Knight + Curse of Dragon. All four are in your hand.', aim: () => '.thand' },
      {
        id: 'poly',
        kind: 'do',
        choice: true,
        title: 'Fusion!',
        text: 'Tap Polymerization, then Activate, then pick which Fusion Monster to make.',
        aim: handAim(L4.poly, 'Activate'),
        allow: (a, st) => (is(a, 'ACTIVATE') && a.uid === uidOf(handCard(st, 0, L4.poly))) || is(a, 'CHOOSE') || is(a, 'CANCEL') || is(a, 'YES'),
        done: (st) => (!!onField(st, 0, L4.flame) || !!onField(st, 0, L4.champ)) && !st.prompt,
        nudge: 'Tap Polymerization, then Activate.',
      },
      { id: 'fused', kind: 'info', title: 'Fusion Summon!', text: (st) => `${onField(st, 0, L4.champ) ? 'Gaia the Dragon Champion: 2600 ATK, way more than the coach\'s 1800 LP.' : 'Flame Swordsman: 1800 ATK, exactly the coach\'s 1800 LP.'} Its two materials went to the Graveyard. A Fusion Monster can attack the turn it arrives.` },
      battleStep('bp4', 'Tap the phase button, then Battle Phase.'),
      { id: 'win4', kind: 'do', title: 'Attack!', text: 'Attack the coach directly to win.', aim: attackAim((st) => monsters(st, 0)[0], () => null), allow: (a) => is(a, 'ATTACK') && a.target === null, done: (st) => st.winner !== null, nudge: 'Tap your Fusion Monster, then Attack directly.' },
    ],
  },
  quiz: [
    { q: 'Where do Fusion Monsters wait before they are summoned?', options: ['In your hand', 'In your Extra Deck', 'In the Graveyard'], right: 1, why: 'Fusion Monsters live in the Extra Deck until you make them.' },
    { q: 'What does Polymerization need?', options: ['The Fusion Materials written on the Fusion Monster', 'Any two monsters', '1000 Life Points'], right: 0, why: 'Each Fusion Monster lists exactly which monsters make it.' },
    { q: 'How many cards can a Speed Duel Extra Deck hold?', options: ['15', '6', 'As many as you like'], right: 1, why: 'Speed Duel keeps it small: up to 6.' },
  ],
};

// Lesson 5: your deck and the game
const game: Lesson = {
  id: 'game',
  title: 'Your deck and the game',
  blurb: 'Deck rules, Skills, the hand limit, and what to play next',
  art: 'Jar of Greed',
  slides: [
    { title: 'Building a deck', text: 'A Speed Duel Deck has 20 to 30 cards, plus an Extra Deck of up to 6. You can have up to 3 copies of any card. Build yours in the Deck tab, or let the game make one for you with Random deck.' },
    { title: 'Skills', text: 'Each deck may bring 1 Skill: a special power that is not a card. Some are always on, some you tap the Skill button to use, usually once per duel. Pick yours in the deck editor.', cards: [{ name: 'Destiny Draw (Skill Card)', label: 'Skill' }] },
    { title: 'A few more rules', text: "Whoever goes first doesn't draw and can't attack on turn 1. You can Normal Summon (or Set) one monster per turn. At the end of your turn, you can't have more than 6 cards in hand: extras go to the Graveyard." },
    { title: 'Get more cards', text: 'Win duels to earn card packs, then open them in the Shop tab. Duel Chips are rare: spend them to craft exactly the card you want. Cards you use a lot level up and get shinier.', cards: [{ name: 'Jar of Greed', label: 'Card Shop' }] },
    { title: 'What to play next', text: 'Duel tab: VS Computer, Link Battle with your brother, and Ranked. Solo tab: The Millennium Road story, Card Legends, the Duel Labyrinth, and Practice Duel to try any deck with nothing at stake.' },
  ],
  quiz: [
    { q: 'How many cards go in a Speed Duel Main Deck?', options: ['Exactly 40', '20 to 30', '60'], right: 1, why: 'Speed Duel Decks are small and quick: 20 to 30 cards.' },
    { q: 'How many copies of one card can a deck have?', options: ['3', '1', 'Any number'], right: 0, why: 'Up to 3 copies of any card.' },
    { q: 'How many Skills can a deck use in a duel?', options: ['3', 'None', '1'], right: 2, why: 'One Skill per duel, chosen with the deck.' },
    { q: 'How many cards can you keep in your hand at the end of your turn?', options: ['4', '6', '10'], right: 1, why: 'The hand limit is 6: extras are thrown away at the End Phase.' },
  ],
};

export const LESSONS: Lesson[] = [basics, battles, chains, fusion, game];

// ---------- running a lesson's steps ----------
/** The step after `i` that isn't over yet (a step already done when reached, or not meant for this game, is skipped). */
export function nextStep(steps: TutStep[], i: number, st: DuelState): number {
  let j = i;
  while (j < steps.length && ((steps[j].when && !steps[j].when!(st)) || (steps[j].kind !== 'info' && steps[j].done?.(st)))) j++;
  return j;
}

/** Does the current step let this move of yours through? Passing (and the game's own pass) always goes, except when a Trap is wanted. */
export function allowed(steps: TutStep[], i: number, a: Action, st: DuelState): boolean {
  const s = steps[i];
  if (!s) return true;
  if (is(a, 'SURRENDER')) return true;
  if (is(a, 'PASS')) return !s.noPass;
  if (s.kind !== 'do') return false;
  return !!s.allow?.(a, st);
}

/** May the coach move now? On watch steps, and whenever the rules ask the coach something (not while you read). */
export function coachMayMove(steps: TutStep[], i: number, st: DuelState): boolean {
  if (st.winner !== null) return false;
  const s = steps[i];
  if (!s) return true;
  if (st.prompt?.player === 1) return s.kind !== 'info';
  return s.kind === 'watch';
}

// ---------- the save: offered once, a one-time prize per lesson ----------
type WithSchool = { school?: string[]; schoolSkip?: boolean; schoolCoach?: string; packs?: number };
const W = (s: object) => s as WithSchool;

export const lessonsDone = (s: object): string[] => W(s).school ?? [];
/** the first lesson not done yet (all done: null) */
export const nextLesson = (s: object): Lesson | null => LESSONS.find((l) => !lessonsDone(s).includes(l.id)) ?? null;
/** a lesson opens once the one before it is done */
export const lessonOpen = (s: object, id: string): boolean => {
  const i = LESSONS.findIndex((l) => l.id === id);
  return i === 0 || (i > 0 && lessonsDone(s).includes(LESSONS[i - 1].id));
};
export const LESSON_PACKS = 1;

/** A lesson finished: the first time ever it pays one card pack (finishing it again pays nothing). */
export function finishLesson<S extends object>(s: S, id: string): { save: S; packs: number } {
  if (!LESSONS.some((l) => l.id === id) || lessonsDone(s).includes(id)) return { save: s, packs: 0 };
  return { save: { ...s, school: [...lessonsDone(s), id], packs: (W(s).packs ?? 0) + LESSON_PACKS }, packs: LESSON_PACKS };
}

/** Should the menu offer Duel School? A duelist who has never dueled and hasn't said no or started it. */
export const offerSchool = (s: object & { wins: number; losses: number; draws: number }): boolean => !W(s).schoolSkip && lessonsDone(s).length === 0 && s.wins + s.losses + s.draws === 0;
/** The offer was answered ("Teach me!" or "I know how to play"): it doesn't come back (Duel School stays in the Solo tab, the prizes too). */
export const skipSchool = <S extends object>(s: S): S => (W(s).schoolSkip ? s : { ...s, schoolSkip: true });
export const schoolCoach = (s: object): string | undefined => W(s).schoolCoach;
export const withCoach = <S extends object>(s: S, id: string): S => ({ ...s, schoolCoach: id });
