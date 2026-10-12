# Speed Duel Online

A free browser game for two people to duel with Yu-Gi-Oh! Speed Duel cards and Skills on
phones or computers. This is the **manual table** baseline: the game keeps both screens in
sync, tracks life points, phases and the log, and you move the cards yourself. Rule
enforcement is layered on later.

Play: open the site, one player creates a room and shares the 4-letter code, the other
joins. "Hotseat" plays both seats on one device.

## How it works

- `src/game/` is the engine: every action is an event in an append-only log and the table
  is the replay of that log (`reducer.ts`). Undo skips an event; rejoining replays the log.
- `src/sync/` carries the log between players: `local.ts` (hotseat, saved on the device),
  `peer.ts` (direct phone-to-phone over WebRTC, no account) and `firebase.ts` (Firebase
  Realtime Database, used automatically when `firebaseConfig.ts` has a config).
- `src/ui/` is the Preact interface: lobby, board, tap-then-action-sheet controls.
- `src/data/starterDecks.json` holds the six 2019 Speed Duel Starter Decks.
- `public/cards/` is the card database and images, produced by `scripts/fetch_cards.py`
  (run by the "Update card database" workflow). Images are re-hosted once, as the card
  database's terms ask, and never fetched from players' phones.

## Development

```bash
npm install
npm run dev        # local server
npm run build      # type-check + production build into dist/
npm run check-decks
```

Deploys to GitHub Pages from `main` through `.github/workflows/pages.yml`.

## Known limits of this first slice

- The full event log is shared with both players, so hidden information (deck order, hand)
  is hidden by the interface, not by the transport. Private branches come in Slice 1B.
- Drag and drop is not in yet; tap a card, then tap the zone.
