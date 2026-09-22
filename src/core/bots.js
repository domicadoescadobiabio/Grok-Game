// Computer opponents.
//
// A bot is an ordinary account with `isBot` set, so it sits, bets and busts
// through exactly the same code a person does -- there is no parallel path where
// the house can quietly cheat. Each game supplies a `botAction`; this file only
// decides when to call it.

import { config } from '../config.js';
import { db, save, playerById, GameError } from './players.js';
import { sit, seatOf, tableLog } from './tables.js';
import { getGame } from '../games/index.js';

export const BOT_NAMES = [
  'ada', 'boris', 'cleo', 'dmitri', 'esme', 'fitz', 'greta', 'hugo',
];

// A bot account exists per table, not per name.
//
// A single global pool of eight ran dry the moment nine tables wanted an
// opponent -- and because a seated bot is locked to one table, the ninth table
// simply got no opponent and sat there looking broken. Minting "ada at table
// K7QD" costs nothing and cannot run out.
const botId = (name, tableId) => `bot_${name}_${tableId}`;

/** Fetch (or mint) a bot account for one seat at one table. */
export function getBot(name, tableId) {
  const id = botId(name, tableId);
  let bot = db.players[id];
  if (!bot) {
    bot = db.players[id] = {
      id,
      username: name,
      pin: null,           // nobody logs in as a bot
      isBot: true,
      chips: config.startingChips * 10, // the house never leaves the table broke
      lastRebuyAt: 0,
      seatedAt: null,
      stats: { handsPlayed: 0, wins: 0, losses: 0, biggestPot: 0, chipsWon: 0, chipsLost: 0 },
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    save();
  }
  // Bots are topped up rather than busted out; they exist to keep tables alive.
  if (bot.chips < config.startingChips) bot.chips = config.startingChips * 10;
  return bot;
}

export const isBot = (player) => Boolean(player?.isBot);

/** Seat `count` bots at a table, skipping names already there. */
export function addBots(table, count = 1) {
  const game = getGame(table.game);
  const room = Math.min(count, game.maxSeats - table.seats.length);
  if (room <= 0) {
    throw new GameError(`Table ${table.id} has no free seats.`, 'table_full');
  }
  const added = [];
  for (const name of BOT_NAMES) {
    if (added.length >= room) break;
    const bot = getBot(name, table.id);
    if (bot.seatedAt || seatOf(table, bot.id)) continue;
    sit(table, bot, 0);
    added.push(bot.username);
  }
  if (!added.length) throw new GameError('Could not seat a computer opponent.', 'no_bots');
  return added;
}

export function removeBots(table) {
  const bots = table.seats.filter((s) => playerById(s.playerId)?.isBot);
  for (const seat of bots) {
    table.seats = table.seats.filter((s) => s.playerId !== seat.playerId);
    // Delete the account outright: it belongs to this table and nothing else
    // will ever look it up, so keeping it only grows the save file.
    delete db.players[seat.playerId];
  }
  save();
  return bots.length;
}

/**
 * Play out every consecutive bot turn until a human is up, the round ends, or
 * we hit the guard. The guard matters: a bug that leaves the turn on the same
 * bot would otherwise spin forever inside one HTTP request.
 */
export function runBots(table, { limit = 60 } = {}) {
  const game = getGame(table.game);
  if (!game?.botAction) return [];
  const events = [];

  for (let i = 0; i < limit; i++) {
    if (table.status !== 'playing' || !table.turn) break;
    const actor = playerById(table.turn);
    if (!actor?.isBot) break;

    let decision;
    try {
      decision = game.botAction(table, actor);
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
      decision = null;
    }
    if (!decision) break;

    try {
      const result = game.act(table, actor, decision.action, decision.args || {});
      for (const e of result.events || []) events.push(`@${actor.username}: ${e}`);
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
      // A bot that proposed something illegal must not wedge the table.
      tableLog(table, `@${actor.username} passes (${err.message}).`);
      const fallback = game.botFallback?.(table, actor);
      if (!fallback) break;
      try {
        game.act(table, actor, fallback.action, fallback.args || {});
      } catch {
        break;
      }
    }
    // Deliberately NOT "stop if the turn did not change". In poker the same bot
    // legitimately acts twice in a row: it checks, that closes the street, and
    // post-flop action starts with it again. Treating that as no-progress left
    // the table frozen on the bot's turn. An accepted action is progress; the
    // loop limit is what stops a genuine cycle.
  }

  save();
  return events;
}
