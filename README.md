# Grok Game

An arcade you play by talking to an AI.

**Live:** https://arcade-production-9205.up.railway.app
**MCP URL for connectors:** `https://arcade-production-9205.up.railway.app/mcp`

Seven table games, **played entirely through an AI connector**. Add the MCP URL
to Grok (or any MCP client) and play by talking -- against the house bots or
against friends at a shared table.

The web page at `/play` is a **screen, not a controller**: log in with your
player ID and it draws the cards and the board beside your chat. It cannot act.
That is enforced on the server, not just hidden in the UI -- there is no
endpoint that deals, moves or bets, so the two surfaces cannot disagree about
what happened.

## How a player joins (chat)

1. [grok.com/connectors](https://grok.com/connectors) → **New Connector** →
   **Custom**, paste the `/mcp` URL.
2. *"make me an arcade account, my X username is @yourname"* → a 6-digit
   **player ID**. Keep it; it is the password.
3. *"open a poker table"* → a 4-letter code. Share it.
4. Your friends, from their own chats: *"join arcade table ABCD"*.

Everyone starts with 1000 chips. Bust out and `rebuy` gives 500 back, once every
30 minutes.

## Computer opponents

Every table can seat house bots, so nothing needs a second human:

- **Chess** -- alpha-beta over material and piece-square tables, run under a
  ~900ms budget with iterative deepening. It takes hanging pieces and finds a
  mate in one. See `chessbot.js` for why the search is time-bounded: a fixed
  depth 3 took *ten seconds* from a busy middlegame, because chess.js
  `moves({verbose:true})` costs 2.4ms against 0.16ms for the plain call.
- **Dam** -- the same idea on a smaller tree, so it searches deeper. Compulsory
  capture prunes most of the branching for free.
- **Poker** -- scores its hole cards preflop and the real made hand after the
  flop, then compares that to the pot odds it is being offered, with a little
  noise so it cannot be read perfectly.
- **Blackjack** -- basic strategy, minus splits.
- **Domino** -- sheds the heaviest playable tile, which is what you get stuck
  holding when a hand blocks.
- **Capsa** -- arranges automatically; see `autoArrange` for why it does not
  search all 72,072 splits.
- **Bingo** -- calls a number. There is nothing else to do.

Bots are minted per table rather than drawn from a global pool. The pool version
ran dry the moment a ninth table wanted an opponent, and the ninth table just sat
there looking broken.

A bot is an ordinary account with `isBot` set, so it sits, bets and busts
through the same code a person does. There is no path where the house cheats.

## The games

| game | players | clock | actions |
| --- | --- | --- | --- |
| Texas Hold'em | 2–6 | 30s | `fold` `check` `call` `raise <amount>` `allin` |
| Blackjack | 1–5 vs dealer | 15s | `hit` `stand` `double` |
| Chess | 2 | 60s | `move <notation>` `resign` `draw` |
| Capsa Susun | 2–4 | 120s | `arrange` three rows, or `auto` |
| Domino (Gaple) | 2–4 | 30s | `play <tile> [left\|right]` `pass` |
| Dam (draughts) | 2 | 60s | `move <from> <to>` `resign` |
| Bingo | 2–6 | 30s | `call` |

Chess moves are reported in words -- *"Pawn e2 to e4"*, *"Rook a1 takes Bishop
on a8"*, *"Castles kingside"* -- with the algebraic form kept alongside. The
board is for people who do not already read notation; `move` still accepts the
short form (`e4`, `Nf3`, `O-O`, `e8=Q`). The web board is lettered and numbered
on its edges, and the last move's squares stay highlighted.

## The screen

`/play` draws chip stacks in real denominations, highlights the winning seat,
and throws confetti when you take a pot. Sound is off until you switch it on --
browsers block audio before a gesture, and it is rude besides.

Everything you hear is synthesised in the browser; there are no audio files to
ship or host. Web Audio covers chips, cards, a knock on the table for a check,
and the countdown chime; `speechSynthesis` says the action out loud, with the
pitch derived from the player's name so a table sounds like several people
rather than one narrator. Sounds are triggered from the **table log** -- the
same lines the chat shows -- rather than from state diffs, so the two surfaces
can never describe the hand differently.

The countdown is a chime that gets more insistent under ten seconds. It does
not count numbers out loud.

## Clocks

| game | thinking time |
| --- | --- |
| Blackjack | 15s |
| Texas Hold'em | 30s |
| Chess | 60s |

## Turns, and the thing a connector cannot do

**Nothing can tap a player on the shoulder.** MCP is request/response: the
server has no way to push "it's your turn" into someone's chat. A player learns
it is their move by asking (`table`), which is free and can be called any time.

So every table is turn-based and asynchronous — closer to correspondence chess
than to a live table. Because there is no background loop, *the clock is settled
by the next person who touches the table*: poker folds you (or checks, if
checking is free), blackjack stands your hand, and chess awards the game to your
opponent. One quiet player can never freeze a table.

The same mechanism drives the bots. `catchUp()` runs on **every** read and
write, not just on actions, so merely looking at the table is enough to make a
computer opponent take its turn. Without that, a player could ask "whose turn is
it?" and be told it was the bot's — forever.

## Run it

```bash
npm install
npm start           # http://localhost:4900
npm test            # rules and engine (46 tests)
npm run test:mcp    # 35 end-to-end checks against a running /mcp endpoint
```

## Layout

```
src/
  config.js              env + tuning
  server.js              express: /mcp, connect note, read-only JSON API
  mcp/
    server.js            stateless Streamable-HTTP MCP endpoint
    tools.js             the 15 tools an AI sees
  core/
    players.js           accounts, chips, sessions
    tables.js            seats, turns, clocks -- knows nothing about any game
    engine.js            what a player can do; the layer the tools call
    activity.js          request monitor behind /live
  games/
    index.js             registry
    cards.js             deck, shuffle, formatting
    handrank.js          7-card poker evaluation
    poker.js  blackjack.js  chess.js  chessbot.js
    capsa.js  domino.js  dam.js  bingo.js
  store/jsonStore.js     atomic debounced JSON persistence
```

A game plugs in by exporting `start`, `act`, `view`, `onTimeout` and some
metadata. `tables.js` handles seats, turn order and clocks for all of them, so
a fourth game does not touch the plumbing.

## Things worth knowing before changing anything

- **The hand evaluator decides who gets the money**, so it has real tests,
  including 3000 random deals. Touch `handrank.js` and run `npm test`.
- **Side pots are rebuilt from each player's total contribution** at showdown
  rather than tracked incrementally — one function to get right instead of five.
  An all-in for less can only win the chips it covered.
- **Heads-up poker blinds are backwards from a full ring**: the dealer posts the
  small blind and acts first preflop, last after it. Getting this wrong is
  invisible until someone who plays poker sits down.
- **A betting round ends when everyone still in has acted *and* matched the
  bet.** A raise clears everyone else's `acted` flag — "everyone has acted"
  alone would end the round on a raise nobody answered.
- **Resigning and accepting a draw are not moves**, so they bypass the turn
  check (`anytimeActions`). Without that, an offer could never be accepted.
- **Leaving mid-hand folds or resigns.** Standing up is not an escape hatch from
  a pot you are losing.
- **Deploy needs a volume at `data/`** — the save file is every account and every
  chip. Without one, a redeploy wipes the arcade.

## Adding a game

A game exports `start`, `act`, `view`, `onTimeout`, `snapshot`, `botAction` and
some metadata, then goes in `games/index.js`. `tables.js` already handles seats,
turn order and clocks, so nothing in the plumbing changes. The existing games
run 290–520 lines each.

What actually decides whether a game fits here:

- **Turn-based.** MCP cannot push, so anything real-time is out.
- **Readable as text.** It is played from a chat window; mahjong's 144 tiles are
  not.
- **Bot-able.** Every table can seat a computer opponent, so the game needs a
  policy that is at least not embarrassing.

## Not built yet

- Tournaments, sit-and-gos, or any structure above a single table.
- Blackjack splits (one seat, two hands — the turn system would need to learn
  about it).
- Spectating a table you are not seated at.
