# EDS rule / structure notes (from yugipedia, Oct 2026)

Source pages: Yu-Gi-Oh!_The_Eternal_Duelist_Soul, Initial_Deck_(EDS), the 23 pack pages, the 24 opponent pages,
and the Japanese sibling Yu-Gi-Oh!_Duel_Monsters_5:_Expert_1 (EDS is the localization of DM5/DM6-era engine).

## Deck construction
- Main Deck: 40 to 60 cards (DM5 page; EDS page says "40-card minimum"). Upper limit of 60 is a game rule the OCG did not have then.
- Side Deck: 0 to 15 cards, swapped between Duels of a Match (OCG at the time required exactly 15 or 0).
- No separate Fusion Deck in EDS: Fusion Monsters are placed in the Main Deck, and Fusion cards added to the Deck
  do NOT count toward the 40-card minimum. (Yugipedia lists Joey's Thousand Dragon and Kaiba's 2x Blue-Eyes Ultimate
  Dragon as a separate "Fusion Deck" for the AI decks.)
- Starting deck ("Initial Deck"): choose Red, Green or Black; always exactly 40 cards drawn from 11 pools.
  Fixed pool 1 (every deck): Black Pendant, Change of Heart, Magic Jammer, Monster Reborn, Mystical Space Typhoon x2,
  Pot of Greed, Seven Tools of the Bandit, Swords of Revealing Light, Trap Hole x2. Fixed pool 5: Mystical Elf, Summoned Skull.
  Random: 1 of (Dark Hole/Raigeki) [Black gets both], 1 of (Megamorph/Premature Burial/Snatch Steal) [Black gets all 3],
  1 of (Bell of Destruction/Call Of The Haunted/Mirror Force) [Black gets all 3], 3/6/3 Normal monsters from pools 6/7/8
  (Red favors pool 6, Green pool 7, Black pool 8), 9 from a 57-card low/mid Normal pool, 2 from a 12-card Lv5-6 Normal pool,
  1 from a 7-card Effect monster pool.
- Limited/Semi-Limited list: game follows the "May 2001 Lists"; there are NO Forbidden cards. Examples of Limited (1 copy):
  Exodia the Forbidden One, Jinzo, Raigeki; Semi-Limited (2 copies): Sangan, Heavy Storm, Graceful Charity.
  (AI decks confirm: 1x Raigeki, Dark Hole, Monster Reborn, Change of Heart, Mirror Force, Pot of Greed, Harpie's Feather Duster;
  2x Graceful Charity, Witch of the Black Forest, Sangan, Heavy Storm appear.)
- Unusable cards: the three Egyptian God cards (Obelisk #817, Slifer #818, Ra #819), the three Ticket cards
  (The Monarchy #814, Set Sail for the Kingdom #815, Glory of the King's Hand #816) and Insect Monster Token (#820)
  cannot be put in a Deck. 819 numbered cards + token = 820 entries in the list.
- Cards 1-813 are in strict alphabetical order (duplicate numbers = alternate artworks: Blue-Eyes White Dragon 82/83,
  Celtic Guardian 104/105, Dark Magician 150/151, Flame Swordsman 235/236, Gaia The Fierce Knight 252/253,
  Launcher Spider 405/406, Pendulum Machine 543/544, Polymerization 552/553, Thousand Dragon 715/716, Tiger Axe 720/721).

## Duel flow
- Who goes first: rock-paper-scissors (DM5 page).
- Matches are best of three Duels; single Duels are the normal campaign mode.
- Hand limit, first-turn-attack rule, and summoning limits are NOT stated on yugipedia. (Era rules: one Normal Summon/Set per
  turn, discard to 6 at End Phase, no attacking on the first turn of the Duel - these are the standard 2001 rules the game
  implements; verify in-game if exactness matters.)

## Campaign structure
- 5 tiers ("Stages"). Tier 1 available from start; Tier N+1 unlocks after beating every duelist in Tier N a set number of
  times: 2x for Tier 2, 3x for Tier 3, 4x for Tier 4, 5x for Tier 5.
- Tier 5 extras: Simon appears when you win the National Tournament (held in November); Maximillion Pegasus when you own a
  copy of Toon World; Trusdale when you collect all 819 cards.
- In-game calendar advances one day per duel. Weekly Yu-Gi-Oh! gift pack event every Tuesday; Yu-Gi-Oh! Magazine gift pack
  on the 21st of each month; random events (mailed packs, challenges) on certain days. Grandpa pack also exists as a special pack.
- Random "Ghoul" encounters: defeating a Ghoul awards a Green Millennium Puzzle pack.

## Booster packs
- Each pack = 5 cards: 4 commons + 1 card drawn from the rare slot using weighted rarity pools
  (Rare / Super Rare / Ultra Rare / Secret Rare / Normal Rare).
- Password entry: enter a card's 8-digit password to obtain it; some cards (e.g. Chakra) have no password and can't be
  entered; a card you already own or that is not in the game returns an error. (DM5: password entry costs 500 points.)
- Pack unlock conditions are in packs.json. Summary:
  - From start: Dark Magician, Mystical Elf, Red-Eyes B. Dragon
  - Judge Man: 10 total wins; Tiger Axe: reach Stage 2; Garoozis: reach Stage 3; Blue-Eyes Ultimate Dragon: reach Stage 4
  - Cyber Harpie: beat all Stage 1 duelists 10x each; Gate Guardian: 10 wins in Stage 2; Great Moth: all Stage 2 duelists 10x each
  - Relinquished: 10 wins in Stage 3; Black Luster Soldier: all Stage 3 duelists 10x each
  - Blue Millennium Puzzle: 10 wins vs Stage 4; Eye of Wdjat: each Stage 4 opponent 10x
  - 20 wins vs a specific duelist: Yugi Muto -> Blue-Eyes White Dragon; Joey Wheeler -> Exodia the Forbidden One;
    Mako Tsunami -> Gemini Elf; Mai Valentine -> Launcher Spider; Umbra & Lumis -> Battle Ox; Marik Ishtar -> Blue-Eyes Toon Dragon;
    Seto Kaiba -> Green Millennium Puzzle; Yami Yugi -> Buster Blader
  - Yellow Millennium Puzzle: defeat Simon
- Blue-Eyes White Dragon pack list caveat: the EDS pack page has no visible list; its 61 Set-contains entries (rarities only)
  matched exactly, in alphabetical order, the DM5 "Legend of Blue Eyes White Dragon" pack list, so that list was used.
- Judge Man pack lists "Judge Man" twice (Ultra Rare and Super Rare) as printed.
- Eye of Wdjat pack contains the alternate-artwork versions (marked "artwork": 2 in packs.json).

## Multiplayer
- Two GBAs, two cartridges and a Game Link Cable; Wireless Adapter not supported; cards can be traded between carts.
