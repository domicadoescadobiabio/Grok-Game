// The open world: a standing room for every game, there before anyone asks.
//
// The arcade used to start empty. You opened a table, handed friends a
// four-letter code, and anyone who was not told the code never found it --
// which meant a new player's first move was always to create something rather
// than to walk into something.
//
// Now each game owns a permanent room. This file's whole job is to keep that
// true: seed whatever is missing, and open an overflow room for a game whose
// rooms are all full or mid-hand, so "sit me at a poker table" cannot fail.
// It is called on reads, like everything else here -- a connector-driven
// server only runs while somebody is talking to it, so there is no boot
// moment to rely on and no background loop to keep the world stocked.

import { db, save, playerById } from './players.js';
import { createTable } from './tables.js';
import { GAMES, gameList, getGame } from '../games/index.js';

// Fixed codes, so the rooms are the same places tomorrow as today. Four
// characters from the same alphabet the random codes use -- no I, O, 0 or 1,
// because these get read aloud and typed back.
const HOUSE_CODES = {
  poker: 'PKER',
  blackjack: 'BJAK',
  chess: 'CHES',
  chinesepoker: 'CPKR',
  domino: 'DMNS',
  checkers: 'CKRS',
  bingo: 'BNGA',
};

/** Can somebody walk in right now? Full or mid-hand both mean no. */
export const isJoinable = (t) =>
  !t.isPrivate && t.seats.length < t.maxSeats && t.status !== 'playing';

const humansAt = (t) =>
  t.seats.filter((s) => !playerById(s.playerId)?.isBot).length;

const roomsFor = (gameKey) =>
  Object.values(db.tables).filter((t) => t.game === gameKey && !t.isPrivate);

function openRoom(game, { code = null, ordinal = 1 } = {}) {
  return createTable({
    game: game.key,
    host: null,
    name: ordinal > 1 ? `${game.title} room ${ordinal}` : `${game.title} room`,
    stake: game.defaultStake,
    maxSeats: game.maxSeats,
    turnSeconds: game.turnSeconds,
    // Only the first room of each game is furniture. Overflow rooms are
    // ordinary tables: they disappear when the last player stands up, and
    // this function puts another one back the moment one is needed again.
    isHouse: Boolean(code),
    id: code,
  });
}

/**
 * Make sure every game has a room, and that at least one of them has a free
 * seat. Cheap enough to call on every lobby read.
 */
export function ensureOpenWorld() {
  let changed = false;

  for (const { key } of gameList()) {
    const game = getGame(key);
    const rooms = roomsFor(key);

    if (!rooms.some((t) => t.isHouse)) {
      openRoom(game, { code: HOUSE_CODES[key] });
      changed = true;
    }
    // Re-read: the room we just seeded counts.
    if (!roomsFor(key).some(isJoinable)) {
      openRoom(game, { ordinal: roomsFor(key).length + 1 });
      changed = true;
    }
  }

  if (changed) save();
  return changed;
}

/** The room to put someone in when they name a game rather than a code. */
export function findOpenTable(gameKey) {
  ensureOpenWorld();
  return roomsFor(gameKey)
    .filter(isJoinable)
    // A room with people in it beats an empty one -- the point is to meet
    // somebody. Between two equally populated rooms, the permanent one wins.
    .sort((a, b) =>
      (humansAt(b) - humansAt(a))
      || (b.seats.length - a.seats.length)
      || (Number(Boolean(b.isHouse)) - Number(Boolean(a.isHouse))))[0] || null;
}

const ALIASES = {
  holdem: 'poker', texas: 'poker', texasholdem: 'poker', nlhe: 'poker',
  twentyone: 'blackjack', 21: 'blackjack', bj: 'blackjack',
  draughts: 'checkers', dama: 'checkers',
  dominoes: 'domino', dominos: 'domino',
  chinese: 'chinesepoker', pusoy: 'chinesepoker', openface: 'chinesepoker',
};

/** "poker", "Texas Hold'em", "dominoes" -> a game key. Null if it is not one. */
export function resolveGameKey(input) {
  const raw = String(input || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!raw) return null;
  if (GAMES[raw]) return raw;
  if (ALIASES[raw]) return ALIASES[raw];
  const byTitle = gameList().find(
    (g) => g.title.toLowerCase().replace(/[^a-z0-9]/g, '') === raw);
  return byTitle ? byTitle.key : null;
}
