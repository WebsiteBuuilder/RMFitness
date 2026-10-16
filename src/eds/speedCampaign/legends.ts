// Card Legends: story chapters told by the cards themselves. Each legend is four duels with
// story scenes between them, narrated by the legend card's spirit (Red-Eyes remembers being a
// prize before it was a partner, Dark Magician remembers the oath it swore as Mahad...). Some
// duels hand you the legend's own deck. Every duelist and deck comes from the Millennium Road
// so they are already tuned; a legend only gives them new lines.
//
// What it pays (first wins only, so nothing can be farmed):
//  - 1 Duel Chip for each duel's first win (borrowed-deck duels too)
//  - finishing a legend: the legend card, 3 more Duel Chips, a pack and a title
//  - the daily Legend Rematch: one duel you have already won, picked by the day; its first
//    win that day pays 1 Duel Chip
// Duels must be played with a deck built from cards you own ("Anything goes" decks can't
// enter), like the Millennium Road.
import { COPIES, owned, type SpeedSave } from '../speedSave';
import { campaignDifficulty, type Difficulty } from '../difficulty';
import { JADEN_STORY, JOEY_STORY, YUGI_STORY, type CampaignNode } from './roster';
import { deckOf, expand, findNode } from './campaign';
import { grant } from './rewards';
import { todayString } from './labyrinth';
import type { SoloSave } from './save';
import type { CpuDuelist, DuelCondition, DuelOutcome, Reward } from './types';

/** One line of a story scene. `who` null is the legend card speaking. */
export interface Line {
  who: string | null;
  text: string;
}

/** The computer duelist: a Millennium Road duelist (its deck), with lines for this story. */
export interface LegendFoe {
  node?: string;
  /** a duelist that isn't on the road */
  duelist?: CpuDuelist;
  name?: string;
  title?: string;
  intro?: string;
  onWin?: string;
  onLose?: string;
}

/** A borrowed deck: you duel as someone else. */
export interface LegendAs {
  name: string;
  /** a Millennium Road duelist's deck */
  node?: string;
  story?: NonNullable<CampaignNode['story']>;
}

export interface LegendDuel {
  id: string;
  title: string;
  /** the scene before the duel */
  scene: Line[];
  foe: LegendFoe;
  as?: LegendAs;
  condition?: DuelCondition;
  /** the scene after you win */
  after: Line[];
}

export interface Legend {
  id: string;
  n: number;
  /** the card telling the story (its art is the cover; finishing the legend gives a copy) */
  card: string;
  title: string;
  blurb: string;
  duels: LegendDuel[];
  title_reward: string;
}

export interface LegendsProgress {
  /** duel id -> wins */
  wins: Record<string, number>;
  losses: number;
  /** the deck picked for Card Legends */
  deckId?: string | null;
  /** the last day the Legend Rematch paid its Duel Chip */
  rematchDay?: string;
  /** a legend-complete screen still to show */
  finished?: string;
  /** duel id -> wins with an Anything goes deck: the story moves on, the chips wait */
  openWins?: Record<string, number>;
}

export const LEGEND_DUEL_CHIPS = 1;
export const LEGEND_FINISH_CHIPS = 3;
export const REMATCH_CHIPS = 1;

// ---------- borrowed decks that aren't on the road ----------

const GAIA_STORY: NonNullable<CampaignNode['story']> = {
  as: 'Yugi Muto',
  main: ['Black Luster Soldier*2', 'Black Luster Ritual*2', 'Gaia The Fierce Knight*2', 'Curse of Dragon*2', 'Swift Gaia the Fierce Knight', 'Big Shield Gardna', 'Kuriboh', 'Celtic Guardian*2', 'Breaker the Magical Warrior*2', 'Dark Magician', 'Polymerization*2', 'Thousand Knives', 'Book of Moon', 'Magic Jammer', 'Mirror Wall'],
  extra: ['Gaia the Dragon Champion*2'],
  skill: null,
};

const BANDIT_KEITH: CpuDuelist = {
  id: 'bandit-keith',
  name: 'Bandit Keith',
  title: 'American Champion (Disqualified)',
  portrait: 'Barrel Dragon',
  main: ['Barrel Dragon*2', 'Slot Machine*2', 'Launcher Spider*2', 'Machine King - 3000 B.C.', 'Vorse Raider*2', 'Battle Ox*2', 'Rocket Warrior', 'Axe Raider*2', 'Axe of Despair', 'Time Machine', 'Skull Dice', 'Graceful Dice', 'Barrel Behind the Door', 'Trap Jammer', 'Acid Trap Hole', 'Dust Tornado', 'Waboku'],
  extra: [],
  skill: null,
  intro: "Nice dragon you got there. Shame if somebody... borrowed it.",
  onWin: 'In America we call that a fair deal.',
  onLose: "This ain't over. Keith always gets paid.",
  signature: ['Barrel Dragon', 'Slot Machine'],
};

// ---------- the legends ----------

const D = (id: string, title: string, foe: LegendFoe, scene: Line[], after: Line[], extra: Partial<LegendDuel> = {}): LegendDuel => ({ id, title, foe, scene, after, ...extra });
const me = (text: string): Line => ({ who: null, text });
const say = (who: string, text: string): Line => ({ who, text });

export const LEGENDS: Legend[] = [
  {
    id: 'redeyes',
    n: 1,
    card: 'Red-Eyes Black Dragon',
    title: "The Gambler's Dragon",
    blurb: 'Red-Eyes Black Dragon was a prize before it was a partner. This is how it found the duelist who never folds.',
    title_reward: 'Red-Eyes Legend',
    duels: [
      D(
        're1',
        'A Dragon Behind Glass',
        { node: 'c1-rex', intro: "Red-Eyes is MY dragon! Want to see it? Beat me first, chump.", onWin: 'Ha! The glass case stays locked.', onLose: "Fine, fine. But Red-Eyes never even fights for me..." },
        [me('I am Red-Eyes Black Dragon. My card holds potential, they say. Rex Raptor kept me in a glass case and never once let me fly.'), say('Rex Raptor', 'Red-Eyes is the rarest card on this island, and it stays in my binder. Why risk it?'), me('A dragon that never duels forgets how to burn. Come, duelist. Show him a real duel.')],
        [me('Rex shook. For the first time in years, I felt the deck shuffle around me.'), say('Rex Raptor', "One loss means nothing! I'll ante Red-Eyes in a real duel and win it all back.")],
      ),
      D(
        're2',
        'The Ante Duel',
        { node: 'c1-rex', title: 'Duelist Kingdom Finalist', intro: "Red-Eyes is the pot. Winner keeps it. You in, Wheeler?", onWin: 'Told you. Dinos rule!', onLose: "No... my Red-Eyes! Take care of it, I guess." },
        [me('Then came Joey Wheeler: a duelist with a borrowed deck, a sister to save and nothing to lose.'), say('Joey Wheeler', 'I got a lucky streak and a whole lotta heart. Let\'s roll the dice!'), me('You are Joey now. Win me.')],
        [say('Joey Wheeler', 'Red-Eyes! I won ya fair and square, pal. You\'re my partner now.'), me('He did not put me in a case. He put me on top of his deck.')],
        { as: { name: 'Joey Wheeler', story: JOEY_STORY } },
      ),
      D(
        're3',
        'Bandit at the Docks',
        { duelist: BANDIT_KEITH },
        [me('Word of a newly won Red-Eyes travels fast. A man in a bandana waited at the docks with a stolen star chip and a smile.'), say('Bandit Keith', "Dragon like that's worth a fortune back home. Let's make a little wager.")],
        [say('Bandit Keith', 'Cheap tricks... I had a card up every sleeve!'), me('His machines rusted. I did not. Still, one duelist remained who could truly claim me.')],
      ),
      D(
        're4',
        'Partners',
        { node: 'c7-joey', title: "Red-Eyes' Partner", intro: "You wanna know if you deserve Red-Eyes? Show me your heart, not just your cards!", onWin: 'Heart of the cards, baby! Try again, pal.', onLose: "Heh... ya earned it. Red-Eyes likes you. I can tell." },
        [me('Joey wanted to know one thing before he let you hold me: would you fold when the dice turned bad?'), say('Joey Wheeler', "Red-Eyes taught me ya don't win by playin' safe. Let's see if it taught you too.")],
        [me('Joey grinned and handed me over. "Treat him like a partner, not a trophy." I will remember that.')],
      ),
    ],
  },
  {
    id: 'harpies',
    n: 2,
    card: 'Harpie Lady Sisters',
    title: 'Sisters of the Storm',
    blurb: 'Three Harpie Ladies, one storm, and the duelist who taught them to hunt as one.',
    title_reward: 'Harpie Legend',
    duels: [
      D(
        'hp1',
        'The Swarm',
        { node: 'c1-weevil', intro: 'Birds eat bugs? Not on my island! My swarm eats birds.', onWin: 'Hehehe. Nest destroyed.', onLose: 'Wings everywhere... disgusting!' },
        [me('We are the Harpie Lady Sisters. Before we were three, we were one Harpie Lady alone in the wind, and the insects knew it.'), say('Weevil Underwood', 'A lone little bird. My Parasite... ahem, my swarm will clip those wings.')],
        [me('The swarm scattered. Above the clouds, a voice laughed: Mai Valentine had been watching.')],
      ),
      D(
        'hp2',
        'Mai Takes Wing',
        { node: 'c2-odion', name: 'Rare Hunter', title: 'Servant of the Ghouls', intro: 'Master Marik wants those Harpies. Every trap is set.', onWin: 'Your birds are caged.', onLose: 'The traps... all sprung for nothing.' },
        [say('Mai Valentine', "A Rare Hunter thinks he can take my girls? Watch and learn, sweetie."), me('You are Mai now. Her Harpies are your Harpies. Her pride is your pride.')],
        [say('Mai Valentine', 'Three ladies, one storm. That\'s how a lady duels.'), me('From one Harpie, three. The Elegant Egotist made us sisters.')],
        { as: { name: 'Mai Valentine', node: 'c7-mai' } },
      ),
      D(
        'hp3',
        'Storm Over the Sea',
        { node: 'c1-mako', intro: 'The sea fears no storm! My Fiend Kraken will drag you under.', onWin: 'The ocean always wins.', onLose: 'A fine storm. The sea salutes you.' },
        [me('A storm needs open sky. Mako Tsunami brought the sea up to meet us.'), say('Mako Tsunami', 'Fly too low and the waves will take you, birds!')],
        [me('We danced on the lightning while his monsters sank. One duel left: our sister in spirit, Mai herself.')],
      ),
      D(
        'hp4',
        'The Elegant Egotist',
        { node: 'c7-mai', title: 'Queen of the Harpies', intro: "You want my sisters? Then beat me, the elegant way.", onWin: 'Better luck next time, honey.', onLose: 'Hmph. Fine. They like you. Take care of my girls.' },
        [say('Mai Valentine', "I don't hand out my Harpies to just anyone. Show me your style."), me('We will fly for whoever wins. That is the way of the storm.')],
        [me('Mai blew a kiss to the wind. We three fly with you now.')],
      ),
    ],
  },
  {
    id: 'toons',
    n: 3,
    card: 'Toon World',
    title: 'The Book of Toons',
    blurb: "A storybook that laughs back. Pegasus drew it, the Toons live in it, and anything that enters comes out... funny.",
    title_reward: 'Toon Legend',
    duels: [
      D(
        'tn1',
        'The Locked Library',
        { node: 'c1-paradox', intro: 'The Book of Toons sleeps behind our labyrinth. Only one door is true.', onWin: 'Wrong door!', onLose: 'Which of us lied? Both!' },
        [me('I am Toon World, a book with a heartbeat. Pegasus hid me deep in his castle behind the brothers who guard every door.'), say('Para', 'One of us always tells the truth...'), say('Dox', '...and the other always duels!')],
        [me('The labyrinth folded like paper. My pages fluttered open, and the Toons peeked out to see who had come.')],
      ),
      D(
        'tn2',
        'Ink and Bone',
        { node: 'c2-bonz', intro: "Cartoons? Ha! My zombies aren't scared of cartoons.", onWin: 'Back to the grave with you!', onLose: "I'm scared of cartoons now." },
        [say('Maximillion Pegasus', "Oh, splendid! A test audience. Let's see my little Toons perform, shall we?"), me('You are Pegasus now. Every Toon I hold is yours to command.')],
        [say('Maximillion Pegasus', 'The zombies laughed themselves to pieces. Marvelous!'), me('Pegasus closed my cover gently. "Now, who else deserves to read you?"')],
        { as: { name: 'Maximillion Pegasus', node: 'c1-pegasus' } },
      ),
      D(
        'tn3',
        'The Joke Thief',
        { node: 'c2-espa', intro: 'My Jinzo shuts down every trick. Your Toons will stop laughing.', onWin: 'Silence. My Jinzo sees all.', onLose: 'I never saw that punchline coming.' },
        [me('Espa Roba wanted my pages for his own. His Jinzo hates tricks, and Toons are nothing but tricks.'), say('Espa Roba', 'I read minds. Yours says you\'re about to lose.')],
        [me('Even a psychic cannot predict a cartoon. Pegasus himself waited at the castle gate.')],
      ),
      D(
        'tn4',
        'The Final Page',
        { node: 'c1-pegasus', title: 'Author of the Toons', intro: "Every story needs a final chapter. Shall I write yours?", onWin: 'The end! For you, anyway.', onLose: "Bravo! The book is yours... do read it to the Toons at bedtime." },
        [say('Maximillion Pegasus', 'I drew every Toon by hand. Now beat them, and the book chooses you.'), me('I open myself on his field before the duel even begins. That is only fair. It is his book.')],
        [me('Pegasus bowed. My last page now carries your name.')],
        { condition: { text: 'Pegasus starts with Toon World already face-up on his field.', cpu: { spells: ['Toon World'] } } },
      ),
    ],
  },
  {
    id: 'darkmagician',
    n: 4,
    card: 'Dark Magician',
    title: "The Magician's Oath",
    blurb: 'Before it was a card, Dark Magician was Mahad, a priest who swore to guard the Pharaoh forever.',
    title_reward: 'Dark Magician Legend',
    duels: [
      D(
        'dm1',
        'The False Master',
        { node: 'c2-arkana', intro: "I am the true master of the Dark Magician! I'll prove it in a deadly duel.", onWin: 'The real master stands before you.', onLose: 'Master Marik will be... displeased.' },
        [me('I am the Dark Magician. A man named Arkana claims to be my master. He has never even heard my true name.'), say('Arkana', 'Dark Magician serves whoever holds the card. And I hold three.')],
        [me('His copies of me fell silent. He had the card, but never my oath. Let me tell you where it began.')],
      ),
      D(
        'dm2',
        'The Thief King',
        { node: 'c6-bakura', name: 'Thief King Bakura', title: 'Raider of Kul Elna', intro: "Your Millennium Ring is mine, priest. I'll take your soul with it.", onWin: 'Another treasure for the King of Thieves.', onLose: 'This priest... he bound his soul to a card?!' },
        [me('Three thousand years ago I was Mahad, keeper of the Millennium Ring. The Thief King came for it, and for the Pharaoh.'), say('Mahad', 'I swear on my soul: as long as I exist, no harm comes to my king.'), me('You are Mahad now. Keep the oath.')],
        [me('To win, Mahad gave his soul to his own ka. That is how I became the Dark Magician. That is my oath.')],
        { as: { name: 'Mahad', story: { ...YUGI_STORY!, as: 'Mahad' } } },
      ),
      D(
        'dm3',
        'The Lantern in the Dark',
        { node: 'c6-lantern', intro: 'The Thief King still haunts these ruins. His lantern finds every soul.', onWin: 'Another light goes out.', onLose: 'The magician burns brighter than my lantern...' },
        [me('The Thief King\'s shadow still walks the ruins, carried by Hollow Saib and his lantern.'), say('Hollow Saib', 'The priest is dust. Who will guard the Pharaoh now?')],
        [me('Mana, my apprentice, would have laughed at him. One more duel: the one my oath was always for.')],
      ),
      D(
        'dm4',
        'The Pharaoh\'s Guardian',
        { duelist: { id: 'yugi-legend', name: 'Yugi Muto', title: 'Heart of the Cards', portrait: 'Dark Magician', main: YUGI_STORY!.main, extra: YUGI_STORY!.extra, skill: YUGI_STORY!.skill, intro: 'Dark Magician has guarded me since the beginning. If you want him to stand by you too... show me your heart.', onWin: 'He stays with me for now. Come back stronger!', onLose: 'He chose you. I can feel it. Take good care of him.', signature: ['Dark Magician'] } },
        [say('Yugi Muto', "Dark Magician isn't just my strongest card. He's my friend."), me('I will duel against my own king today, to see if you are worth a second oath.')],
        [me('Yugi smiled. I swear it again, to you this time: as long as I exist, you will not stand alone.')],
      ),
    ],
  },
  {
    id: 'luster',
    n: 5,
    card: 'Black Luster Soldier',
    title: 'The Soldier of Chaos',
    blurb: 'Only a ritual can call him. Only the worthy can finish it. A legend of the oldest tomb.',
    title_reward: 'Black Luster Legend',
    duels: [
      D(
        'bl1',
        'The Sealed Stair',
        { node: 'c3-scout', intro: 'No one descends to the ritual chamber. The Gravekeepers forbid it.', onWin: 'The tomb stays sealed.', onLose: 'Go, then. The chamber will judge you.' },
        [me('I am the Black Luster Soldier. I sleep under the tomb, waiting for a ritual no one has finished in a thousand years.'), say('Nefer', 'Turn back. The ones who seek the Soldier never return.')],
        [me('The first seal cracked. Far below, my sword stirred in the dark.')],
      ),
      D(
        'bl2',
        'Sand and Riddles',
        { node: 'c3-sorcerer', intro: 'The second seal is a riddle of sand. Answer with a duel.', onWin: 'Wrong answer.', onLose: 'Clever. The sand parts for you.' },
        [say('Seshat', 'The ritual needs a Spell, an offering and a will. Which do you lack?'), me('Most fail here. The sand swallows their courage before it swallows them.')],
        [me('The second seal fell. The ritual chamber lay open. Now someone had to finish the ritual.')],
      ),
      D(
        'bl3',
        'The Ritual',
        { node: 'c3-abidos', intro: 'I, Abidos, am the last guardian of the ritual chamber. Kneel, or duel.', onWin: 'The ritual fails. As it always has.', onLose: 'The Soldier wakes... I have not seen his light in a thousand years.' },
        [me('A young duelist with a puzzle around his neck once finished my ritual. You will finish it with his deck.'), say('Abidos the Third', 'Many have stood in that circle. None have walked out.'), me('You are Yugi now. Call me.')],
        [me('The ritual completed. I stood again, sword in hand, armor shining with chaos.')],
        { as: { name: 'Yugi Muto', story: GAIA_STORY } },
      ),
      D(
        'bl4',
        'The Seer\'s Test',
        { node: 'c3-ishizu', title: 'Seer of the Tomb', intro: 'I have seen the Soldier in your future. Let us see if the future can be changed.', onWin: 'The future held. You fall.', onLose: 'The Necklace showed me a different ending... you wrote a new one.' },
        [say('Ishizu Ishtar', 'The Soldier serves only one who can face what the Necklace foresees.'), me('A soldier follows a commander, not a ritual. Show me you can lead.')],
        [me('Ishizu lowered her eyes. I have chosen my commander. Chaos is at your command.')],
      ),
    ],
  },
  {
    id: 'neos',
    n: 6,
    card: 'Elemental HERO Neos',
    title: 'The Hero from Neo Space',
    blurb: 'A hero from beyond the stars, a card shot into space, and the boy who caught it.',
    title_reward: 'Neos Legend',
    duels: [
      D(
        'ns1',
        'Falling Star',
        { node: 'c4-chazz', intro: 'Some space card fell into the Academy? Finders keepers, slacker.', onWin: 'Ch-ch-ch-Chazz wins!', onLose: 'Ugh. Keep your star junk.' },
        [me('I am Elemental HERO Neos. A rocket carried me into deep space, and I came back as a shooting star over Duel Academy.'), say('Chazz Princeton', 'The Chazz saw it land first. That makes it mine.')],
        [me('Chazz grumbled off. But someone else had seen the star fall, someone who never stopped dreaming about heroes.')],
      ),
      D(
        'ns2',
        'Contact Fusion',
        { node: 'c5-viper', intro: 'Heroes are weak. Discipline is strength. Let me show you, Yuki.', onWin: 'Weakness, punished.', onLose: 'Those Neo-Spacians... what are they?' },
        [say('Jaden Yuki', 'Neos! I knew we\'d meet! Let\'s get our game on!'), me('You are Jaden now. My Neo-Spacian friends answer when you call.')],
        [say('Jaden Yuki', 'Woo! That was sweet. Neos and me, we\'re a team now.'), me('His heart burned like a star. But the Shadow Riders had noticed us too.')],
        { as: { name: 'Jaden Yuki', story: JADEN_STORY } },
      ),
      D(
        'ns3',
        'Shadow Rider',
        { node: 'c5-titan', intro: 'The darkness takes heroes first. Your star will go out.', onWin: 'Into the darkness!', onLose: 'Light... too much light!' },
        [me('Titan wanted my light for the Sacred Beasts. Heroes are made for nights like this.'), say('Titan', 'A hero from space? Out here, nobody can hear you fuse.')],
        [me('The shadows broke. One last test waited at the Academy: the boy who caught me wanted to see if you could shine too.')],
      ),
      D(
        'ns4',
        'Get Your Game On',
        { duelist: { id: 'jaden-legend', name: 'Jaden Yuki', title: 'Slifer Red Hero', portrait: 'Elemental HERO Neos', main: JADEN_STORY!.main, extra: JADEN_STORY!.extra, skill: JADEN_STORY!.skill, intro: "Neos told me about you! C'mon, let's have some fun!", onWin: 'Gotcha! That was a blast. Go again?', onLose: 'Aw man, you got me! Neos, go with \'em. They\'re the real deal.', signature: ['Elemental HERO Neos'] } },
        [say('Jaden Yuki', 'Dueling is about having fun. If you can make me laugh while you beat me, Neos is yours.'), me('A hero chooses the one who duels with joy.')],
        [me('Jaden laughed the whole way down to 0 LP. I will fly with you now, from Neo Space to your deck.')],
      ),
    ],
  },
  {
    id: 'cyber',
    n: 7,
    card: 'Cyber Dragon',
    title: 'The Cyber Style',
    blurb: "A dojo on a cliff, a style of perfect respect, and the machine dragon at its heart.",
    title_reward: 'Cyber Legend',
    duels: [
      D(
        'cy1',
        'The Younger Brother',
        { node: 'c4-syrus', intro: "I-I'm not as good as my brother. But I won't run anymore!", onWin: 'I did it! I really did it!', onLose: "I'll get stronger. I promise." },
        [me('I am Cyber Dragon, heart of the Cyber Style dojo. Two brothers trained there. The younger one was always afraid of me.'), say('Syrus Truesdale', 'Zane says respect your opponent. So... I respectfully have to beat you!')],
        [me('Syrus bowed, shaking but proud. Respect has to be earned on both sides of the field.')],
      ),
      D(
        'cy2',
        'The Successor',
        { node: 'c4-alexis', intro: "They call you Zane's successor? Prove it.", onWin: 'Not quite a Kaiser yet.', onLose: 'That was the real Cyber Style. Impressive.' },
        [say('Zane Truesdale', 'The Cyber Style is about respect: crush your opponent with everything you have.'), me('You are Zane now. Fight with all of me.')],
        [say('Zane Truesdale', 'Hmph. Respect, delivered.'), me('That was the Kaiser before the darkness. He would not stay that way.')],
        { as: { name: 'Zane Truesdale', node: 'c4-zane' } },
      ),
      D(
        'cy3',
        'Stampede',
        { node: 'c4-tyranno', intro: 'Dinos versus machines? Sarge, I like those odds!', onWin: 'Extinction is for machines!', onLose: 'That dragon of yours has some DNA after all.' },
        [me('Word spread that a new duelist carried the Cyber Style. Hassleberry wanted to test it the loud way.'), say('Tyranno Hassleberry', 'My DNA says you\'re about to get stomped!')],
        [me('The dinosaurs fell. Now there was only the Kaiser himself, waiting on the cliff.')],
      ),
      D(
        'cy4',
        'The Kaiser',
        { node: 'c4-zane', title: 'Master of the Cyber Style', intro: 'Show me the Cyber Style, or show me nothing.', onWin: 'Not yet. Come back with more.', onLose: 'You have earned the dragon. And my respect.' },
        [say('Zane Truesdale', 'A dragon that falls to an unworthy master is a broken machine. Duel me.'), me('He made me. Now he tests whether I can be yours.')],
        [me('The Kaiser turned his back on the cliff and nodded once. I am your dragon now.')],
      ),
    ],
  },
  {
    id: 'blueeyes',
    n: 8,
    card: 'Blue-Eyes White Dragon',
    title: "The White Dragon's Tablet",
    blurb: "The last legend. A girl with white hair, a priest who loved her, and the dragon that rose from her soul.",
    title_reward: 'Blue-Eyes Legend',
    duels: [
      D(
        'be1',
        'The Tablet Market',
        { node: 'c6-cutpurse', intro: 'A stone tablet with a white dragon? Worth a fortune. Hands off, it\'s mine.', onWin: 'Sold! To me.', onLose: 'Take your rock. It gives me the creeps anyway.' },
        [me('I am the Blue-Eyes White Dragon. Long ago my spirit lived inside a girl named Kisara. Now my tablet is sold in the ruins like a trinket.'), say('Sly Kesh', 'Ancient tablet, glowing eyes, very rare. Highest bidder takes it.')],
        [me('The tablet hummed in your hands. Somewhere in the sand, someone was digging for it too.')],
      ),
      D(
        'be2',
        'Grave Robbers',
        { node: 'c6-gravedigger', intro: 'The tablet came from my dig. Give it back, or join the dead in it.', onWin: 'Back in the ground it goes.', onLose: 'Keep digging, then. You\'ll find the priest.' },
        [say('Old Mukhtar', 'That stone was in a priest\'s tomb. He wants it back. So do I.'), me('The priest was Seto, who loved Kisara. When the Thief King came for her, I rose to protect them both.')],
        [me('Mukhtar fled. Let me show you the night I was born.')],
      ),
      D(
        'be3',
        'Kisara',
        { node: 'c6-bakura', name: 'Thief King Bakura', title: 'Raider of Kul Elna', intro: 'That girl\'s soul holds a white dragon. I will take it for my Diabound.', onWin: 'The dragon is mine.', onLose: 'A girl... gave her life for that priest? Fool.' },
        [say('Priest Seto', 'Kisara, stay behind me. He will not have you.'), me('Kisara stepped in front of him instead. You are Seto now. Do not let her sacrifice be for nothing.')],
        [me('Kisara fell, and I rose in her place: the white dragon, born from a promise. Seto carved me into stone so she would never be forgotten.')],
        { as: { name: 'Priest Seto', node: 'c7-kaiba' } },
      ),
      D(
        'be4',
        'Kaiba',
        { node: 'c7-kaiba', title: "The Dragon's Heir", intro: "You think a story makes you worthy of Blue-Eyes? Only power does. Duel me.", onWin: 'Blue-Eyes answers to me alone.', onLose: 'Hmph... The dragon looked at you the way it looks at me. Take it, before I change my mind.' },
        [say('Seto Kaiba', 'Ancient tablets. Ghost stories. None of that matters. Blue-Eyes is the strongest dragon because I make it so.'), me('He does not remember Kisara. But every time he draws me, he fights to protect something.')],
        [me('Kaiba crossed his arms and looked away. Kisara would have smiled. My tablet, my story, my wings: they are yours now.')],
      ),
    ],
  },
];

// ---------- lookups ----------

const DUELS = new Map<string, { duel: LegendDuel; legend: Legend; index: number }>();
for (const l of LEGENDS) l.duels.forEach((duel, index) => DUELS.set(duel.id, { duel, legend: l, index }));
export const findLegendDuel = (id: string) => DUELS.get(id);
export const legendById = (id: string) => LEGENDS.find((l) => l.id === id);

/** The computer duelist for a legend duel: the road duelist with this story's lines. */
export function legendFoe(d: LegendDuel): CpuDuelist {
  const base = d.foe.duelist ?? findNode(d.foe.node!)!.node.duelist;
  const f = d.foe;
  return { ...base, name: f.name ?? base.name, title: f.title ?? base.title, intro: f.intro ?? base.intro, onWin: f.onWin ?? base.onWin, onLose: f.onLose ?? base.onLose };
}

/** A borrowed deck, when you duel as someone else. */
export function legendBorrowed(d: LegendDuel): { name: string; main: string[]; extra: string[]; skill: string | null } | null {
  if (!d.as) return null;
  if (d.as.story) return { name: d.as.name, main: expand(d.as.story.main), extra: expand(d.as.story.extra), skill: d.as.story.skill };
  const dl = deckOf(findNode(d.as.node!)!.node.duelist);
  return { name: d.as.name, ...dl };
}

/** How sharp the computer plays: a legend's number stands in for the road's chapter. */
export const legendLevel = (l: Legend, index: number): Difficulty => campaignDifficulty(l.n, index === l.duels.length - 1);

// ---------- progress ----------

export const legendsProgress = (solo: SoloSave): LegendsProgress => solo.legends ?? { wins: {}, losses: 0 };
export const legendDuelWon = (solo: SoloSave, id: string) => (legendsProgress(solo).wins[id] ?? 0) > 0;
/** Beaten with any deck, Anything goes included: enough to open the next duel. */
export const legendDuelPassed = (solo: SoloSave, id: string) => legendDuelWon(solo, id) || (legendsProgress(solo).openWins?.[id] ?? 0) > 0;
export const legendFinished = (solo: SoloSave, l: Legend) => legendDuelPassed(solo, l.duels[l.duels.length - 1].id);
export const legendWins = (solo: SoloSave, l: Legend) => l.duels.filter((d) => legendDuelPassed(solo, d.id)).length;

/** The first legend is open from the start; each next one opens when the one before is finished. */
export function legendOpen(solo: SoloSave, l: Legend): boolean {
  const i = LEGENDS.indexOf(l);
  return i <= 0 || legendFinished(solo, LEGENDS[i - 1]);
}
export function legendDuelOpen(solo: SoloSave, l: Legend, index: number): boolean {
  return legendOpen(solo, l) && (index === 0 || legendDuelPassed(solo, l.duels[index - 1].id));
}

/** The next duel to play: the first open one you haven't won. */
export function nextLegendDuel(solo: SoloSave): { legend: Legend; duel: LegendDuel; index: number } | null {
  for (const l of LEGENDS) for (let i = 0; i < l.duels.length; i++) if (legendDuelOpen(solo, l, i) && !legendDuelPassed(solo, l.duels[i].id)) return { legend: l, duel: l.duels[i], index: i };
  return null;
}

/** Small stable hash for the day's pick. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Today's Legend Rematch: one duel you have already won, the same all day. Null until you've won one. */
export function rematchOf(solo: SoloSave, day = todayString()): LegendDuel | null {
  const won = LEGENDS.flatMap((l) => l.duels).filter((d) => legendDuelWon(solo, d.id));
  if (!won.length) return null;
  return won[hash(day) % won.length];
}
/** Whether today's rematch can still pay its Duel Chip. */
export const rematchPays = (solo: SoloSave, day = todayString()) => legendsProgress(solo).rematchDay !== day;

/** The most chips Card Legends can pay before the daily rematch: for the help text and the test. */
export const LEGEND_CHIPS_TOTAL = LEGENDS.reduce((a, l) => a + l.duels.length * LEGEND_DUEL_CHIPS + LEGEND_FINISH_CHIPS, 0);

// ---------- settling a duel ----------

export interface LegendSettled {
  speed: SpeedSave;
  solo: SoloSave;
  lines: string[];
  cards: string[];
  firstWin: boolean;
  /** the rematch's chip was paid */
  rematchPaid: boolean;
  /** this win finished the legend */
  finished: Legend | null;
  /** chips that would have come but the 30 cap was full */
  capped: boolean;
  /** won with an Anything goes deck: the story moves on, nothing is paid */
  noEarn?: boolean;
}

/** Files a Card Legends duel: the record, and chips and cards for firsts (and the daily rematch). */
export function settleLegend(speed: SpeedSave, solo: SoloSave, duelId: string, o: DuelOutcome, rematch = false, seed = Date.now(), open = false): LegendSettled {
  const found = findLegendDuel(duelId);
  const p = legendsProgress(solo);
  const none: LegendSettled = { speed, solo, lines: [], cards: [], firstWin: false, rematchPaid: false, finished: null, capped: false };
  if (!found) return none;
  if (o.forfeit) return none;
  if (o.result !== 'w') return { ...none, solo: { ...solo, legends: { ...p, losses: p.losses + 1 } } };
  const { duel, legend, index } = found;
  // An Anything goes deck: the story moves on (and its scene plays the first time), but no chips or cards.
  if (open) return { ...none, noEarn: true, firstWin: !legendDuelPassed(solo, duelId), solo: { ...solo, legends: { ...p, openWins: { ...p.openWins, [duelId]: (p.openWins?.[duelId] ?? 0) + 1 } } } };
  const firstWin = !legendDuelWon(solo, duelId);
  const today = todayString();
  const rewards: Reward[] = [];
  let rematchPaid = false;
  if (firstWin) {
    rewards.push({ kind: 'chips', n: LEGEND_DUEL_CHIPS });
    if (index === legend.duels.length - 1) {
      if (owned(speed, legend.card) < COPIES) rewards.push({ kind: 'card', name: legend.card });
      rewards.push({ kind: 'chips', n: LEGEND_FINISH_CHIPS }, { kind: 'pack' }, { kind: 'title', name: legend.title_reward });
    }
  } else if (rematch && p.rematchDay !== today && rematchOf(solo, today)?.id === duelId) {
    rewards.push({ kind: 'chips', n: REMATCH_CHIPS });
    rematchPaid = true;
  }
  const chipsDue = rewards.reduce((a, r) => a + (r.kind === 'chips' ? r.n : 0), 0);
  const pool = expand(legendFoe(duel).main);
  const g = rewards.length ? grant(speed, solo, rewards, pool, seed) : { speed, solo, lines: [], cards: [] };
  const capped = chipsDue > 0 && (g.speed.chips ?? 0) - (speed.chips ?? 0) < chipsDue;
  const finished = firstWin && index === legend.duels.length - 1 ? legend : null;
  const legends: LegendsProgress = {
    ...p,
    wins: { ...p.wins, [duelId]: (p.wins[duelId] ?? 0) + 1 },
    ...(rematchPaid ? { rematchDay: today } : {}),
    ...(finished ? { finished: finished.id } : {}),
  };
  return { speed: g.speed, solo: { ...g.solo, legends }, lines: g.lines, cards: g.cards, firstWin, rematchPaid, finished, capped };
}
