// A pep talk for the computer duelist: plain words turned into how it fights.
// There is no server, so the talk is read here in the game, by keywords and phrases,
// and the player sees back in plain lines how it was understood.

import type { Difficulty } from './difficulty';

export interface Tactics {
  /** -2 very careful … +2 all-out attack */
  attack: number;
  /** keep monsters face-down in Defense unless they clearly win */
  wall: boolean;
  /** -1 never tribute, 0 normal, +1 tribute for any bigger monster */
  tribute: number;
  /** traps: 'hold' waits for a big attacker, 'fire' springs them on anything */
  traps: 'normal' | 'hold' | 'fire';
  /** the Skill: when to use it */
  skill: 'normal' | 'save' | 'never';
  /** below 1500 LP, stop taking risks */
  guardLp: boolean;
  /** which monster to attack first */
  target: 'normal' | 'biggest' | 'weakest';
  /** how sharp the computer plays (Normal when not set) */
  level?: Difficulty;
}

export const DEFAULT_TACTICS: Tactics = { attack: 0, wall: false, tribute: 0, traps: 'normal', skill: 'normal', guardLp: false, target: 'normal' };

interface Rule {
  re: RegExp;
  apply: (t: Tactics) => void;
  says: string;
}

// Order matters only for the lines shown; each rule reads the whole talk.
const RULES: Rule[] = [
  { re: /\b(all[- ]?out|go hard|no mercy|reckless|rush|beat ?down|be bold|go for the throat|aggress\w*|attack (everything|always|a lot|nonstop|every turn)|full attack|hit hard|offen\w*|swing)\b/, apply: (t) => (t.attack = 2), says: 'Attack whenever it can, even into face-down cards and even trades.' },
  { re: /\b(push|pressure|keep attacking|be aggressive-ish|attack more|fight)\b/, apply: (t) => (t.attack = Math.max(t.attack, 1)), says: 'Lean on attacking.' },
  { re: /\b(careful|cautious|patient|play safe|safely|slow and steady|take it slow|don'?t rush|calm)\b/, apply: (t) => (t.attack = Math.min(t.attack, -1)), says: 'Only attack when the attack clearly wins.' },
  { re: /\b(defen[cs]\w*|wall|turtle|hide|stall|block|don'?t attack)\b/, apply: (t) => ((t.attack = -2), (t.wall = true)), says: 'Play defense: set monsters face-down and attack only for sure kills.' },
  { re: /\b(protect|guard|save|watch|keep)\b.{0,20}\b(life|lp|life points|health)\b|\b(stay alive|survive|don'?t (die|lose))\b/, apply: (t) => (t.guardLp = true), says: 'When its Life Points drop below 1500, stop taking risks.' },
  { re: /\b(tribute|big monsters?|boss monsters?|summon (the )?big|go big|ace)\b/, apply: (t) => (t.tribute = 1), says: 'Tribute Summon its big monsters whenever it can.' },
  { re: /\b(don'?t|never|no) tribut\w*|\bkeep (your|my|the) (small )?monsters\b/, apply: (t) => (t.tribute = -1), says: 'Never tribute monsters away.' },
  { re: /\b(hold|save|wait with|keep)\b.{0,20}\btraps?\b|\btraps?\b.{0,25}\b(big|strong|strongest|boss|ace|dragon)\b|\bbait\b/, apply: (t) => (t.traps = 'hold'), says: 'Save its traps for a big attacker (1800+ ATK) or a lethal hit.' },
  { re: /\b(spring|use|fire|trigger|pop)\b.{0,15}\btraps?\b.{0,20}\b(early|right away|asap|always|on everything|every time)\b|\btrap (everything|them all)\b/, apply: (t) => (t.traps = 'fire'), says: 'Spring its traps at the first chance.' },
  { re: /\b(save|hold|keep)\b.{0,15}\bskill\b|\bskill\b.{0,15}\b(late|later|when (you'?re|it'?s) losing|for later|emergency)\b/, apply: (t) => (t.skill = 'save'), says: 'Save its Skill until it is behind or the duel runs long.' },
  { re: /\b(no|don'?t use|never use|without)\b.{0,8}\b(the |your )?skill\b/, apply: (t) => (t.skill = 'never'), says: 'Never use its Skill.' },
  { re: /\b(biggest|strongest|their ace|the threat|big threat|kill the (big|strong))\b/, apply: (t) => (t.target = 'biggest'), says: 'Go after their strongest monster first.' },
  { re: /\b(weak(est)?|easy (kills|targets)|pick (them )?off|small fry|little ones)\b/, apply: (t) => (t.target = 'weakest'), says: 'Pick off their weakest monsters first.' },
  { re: /\b(burn|direct(ly)?|go for (their|the|his|her) (life|lp|face)|life points? damage|go face|hit (them|him|her) directly)\b/, apply: (t) => (t.attack = Math.max(t.attack, 1)), says: 'Go for their Life Points.' },
];

const CHEERS = /\b(you got this|you can do it|believe|heart of the cards|good luck|win|let'?s go|go get|show them|make me proud|i believe)\b/;

export interface ReadTalk {
  tactics: Tactics;
  /** how the talk was understood, one plain line each */
  lines: string[];
}

/** Reads a pep talk into fighting instructions. */
export function readPepTalk(talk: string): ReadTalk {
  const text = ` ${talk.toLowerCase().replace(/[’']/g, "'")} `;
  const t: Tactics = { ...DEFAULT_TACTICS };
  const lines: string[] = [];
  for (const r of RULES) {
    if (!r.re.test(text)) continue;
    r.apply(t);
    lines.push(r.says);
  }
  // When the talk asks for both, the stronger word wins (and the lines say what happened).
  if (t.wall && t.attack > -2) t.wall = false;
  if (!lines.length) lines.push(talk.trim() ? (CHEERS.test(text) ? 'Fired up! No plan in there, so it plays its usual way.' : "No plan found in that, so it plays its usual way. Try words like attack, careful, save traps, tribute, protect life points.") : 'No talk yet: it plays its usual way.');
  else if (CHEERS.test(text)) lines.push('Fired up!');
  return { tactics: t, lines };
}

/** A short label for a tactics set, for the VS screen. */
export function tacticsLabel(t: Tactics): string {
  const bits: string[] = [];
  bits.push(t.attack >= 2 ? 'All-out' : t.attack === 1 ? 'Aggressive' : t.attack <= -2 ? 'Defensive' : t.attack === -1 ? 'Careful' : 'Balanced');
  if (t.traps === 'hold') bits.push('saves traps');
  if (t.traps === 'fire') bits.push('fires traps');
  if (t.tribute > 0) bits.push('goes big');
  if (t.tribute < 0) bits.push('no tributes');
  if (t.guardLp) bits.push('guards LP');
  if (t.skill === 'save') bits.push('saves Skill');
  if (t.skill === 'never') bits.push('no Skill');
  if (t.target === 'biggest') bits.push('hunts their ace');
  if (t.target === 'weakest') bits.push('picks off the weak');
  return bits.join(' · ');
}
