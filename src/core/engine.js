// The layer the MCP tools talk to. Everything here is "what a player can do",
// expressed once so the chat surface stays thin.

import { config } from '../config.js';
import { GameError, playerById, save, db } from './players.js';
import {
  createTable as makeTable, requireTable, requireSeat, tableOf, sit, stand,
  seatOf, setTurn, requireTurn, turnExpired, turnSecondsLeft, recentLog,
  listTables, sweepIdleTables,
} from './tables.js';
import { getGame, gameList } from '../games/index.js';
import { runBots, addBots, removeBots } from './bots.js';
import { ensureOpenWorld, findOpenTable, resolveGameKey } from './world.js';

export { gameList };

/**
 * Before anything reads or writes a table, settle any turn whose clock ran out.
 * There is no background timer in a connector-driven server: the next person to
 * ask a question is what makes time pass.
 */
function catchUp(table) {
  const guard = 12; // a timeout can cascade (fold, fold, fold) but not forever
  for (let i = 0; i < guard && turnExpired(table); i++) {
    const game = getGame(table.game);
    if (!game?.onTimeout) break;
    try {
      game.onTimeout(table);
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
      break;
    }
  }
  // Then let any computer opponent move. This runs on reads as well as writes:
  // simply looking at the table must never leave it parked on a bot's turn,
  // because there is no background loop to move it for us.
  runBots(table);
  return table;
}

export function createTable(player, gameKey, { name, stake, isPrivate } = {}) {
  const game = getGame(gameKey);
  if (!game) {
    throw new GameError(`No game called "${gameKey}". We have: ${Object.keys(gameList()).length ? gameList().map((g) => g.key).join(', ') : ''}.`, 'no_game');
  }
  if (tableOf(player)) {
    throw new GameError(`You are already at table ${player.seatedAt}. Leave it first.`, 'already_seated');
  }

  const bet = Number(stake) > 0 ? Math.floor(Number(stake)) : game.defaultStake;
  if (bet > player.chips) {
    throw new GameError(`A ${bet} chip stake is more than your ${player.chips} chips.`, 'poor');
  }

  const table = makeTable({
    game: game.key,
    host: player,
    name,
    stake: bet,
    maxSeats: game.maxSeats,
    turnSeconds: game.turnSeconds,
    isPrivate: Boolean(isPrivate),
  });
  sit(table, player, 0);
  return table;
}

/**
 * Sit down. `target` is either a four-letter code -- the way you join a
 * friend -- or the name of a game, which puts you in whichever open room for
 * it has the most people already in it.
 */
export function joinTable(player, target) {
  sweepIdleTables();
  ensureOpenWorld();

  const gameKey = resolveGameKey(target);
  let table;
  if (gameKey) {
    table = findOpenTable(gameKey);
    if (!table) {
      throw new GameError(`Every ${getGame(gameKey).title} table is busy. Try again in a moment.`, 'no_table');
    }
  } else {
    table = requireTable(target);
  }

  const game = getGame(table.game);
  catchUp(table);
  sit(table, player, table.stake);
  return { table, game };
}

export function leaveTable(player) {
  const table = requireSeat(player);
  const wasPlaying = table.status === 'playing';
  const game = getGame(table.game);

  // Walking out mid-hand is a fold, not an escape from the pot.
  if (wasPlaying && game?.act) {
    try {
      if (table.game === 'poker') game.act(table, player, 'fold');
      else if (table.game === 'chess') game.act(table, player, 'resign');
    } catch { /* hand may already be over */ }
  }
  const id = table.id;
  stand(table, player);

  // A table with only bots left is a ghost: nobody will ever deal at it, and
  // the bots sitting there are locked out of every other table until the idle
  // sweep runs an hour later. There are only eight of them, so break it up.
  const stillThere = db.tables[id];
  if (stillThere && !stillThere.seats.some((s) => !playerById(s.playerId)?.isBot)) {
    removeBots(stillThere);
    // A house room outlives its players; only a gathering gets broken up.
    if (!stillThere.isHouse) delete db.tables[id];
  }
  save();
  return { tableId: id, forfeited: wasPlaying };
}

export function startRound(player) {
  const table = requireSeat(player);
  const game = getGame(table.game);
  catchUp(table);

  if (table.status === 'playing') {
    throw new GameError('A round is already in progress.', 'in_progress');
  }
  if (table.seats.length < game.minSeats) {
    throw new GameError(`${game.title} needs at least ${game.minSeats} players. There ${table.seats.length === 1 ? 'is' : 'are'} ${table.seats.length}.`, 'need_players');
  }
  const result = game.start(table);
  const botEvents = runBots(table);  // deal straight into the bots' actions
  save();
  return { table, game, events: [...(result.events || []), ...botEvents] };
}

export function act(player, action, args = {}) {
  const table = requireSeat(player);
  const game = getGame(table.game);
  catchUp(table);

  if (table.status !== 'playing') {
    throw new GameError('No round is in progress. Start one first.', 'not_playing');
  }
  // Some actions are not moves. Resigning, and accepting a draw offer, have to
  // work on your opponent's clock -- otherwise an offer can never be accepted.
  const free = (game.anytimeActions || []).includes(String(action || '').toLowerCase());
  if (!free) requireTurn(table, player);
  const result = game.act(table, player, action, args);
  // Play out every bot that is now up, so a human never has to poke the table
  // to make the computer move.
  const botEvents = runBots(table);
  save();
  return { table, game, events: [...(result.events || []), ...botEvents] };
}

export function viewTable(player) {
  const table = requireSeat(player);
  catchUp(table);
  return renderTable(table, player);
}

export function renderTable(table, player) {
  const game = getGame(table.game);
  const lines = [
    `${game.title} -- table ${table.id}${table.isPrivate ? ' (private)' : ''}  stake ${table.stake}`,
    `Seats: ${table.seats.map((s) => '@' + s.username).join(', ') || '(empty)'}   Status: ${table.status}`,
    '',
    game.view(table, player),
  ];

  if (table.status === 'playing' && table.turn) {
    const who = playerById(table.turn);
    lines.push('', table.turn === player.id
      ? `Your move. ${turnSecondsLeft(table)}s on the clock. Actions: ${game.actionHelp}`
      : `Waiting on @${who?.username} (${turnSecondsLeft(table)}s left).`);
  }

  const log = recentLog(table, 6);
  if (log.length) lines.push('', 'Recent:', ...log.map((l) => `  ${l}`));
  lines.push('', `You have ${player.chips} chips.`);
  return lines.join('\n');
}

/** Seat computer opponents so a player can start without waiting for anyone. */
export function seatBots(player, count = 1) {
  const table = requireSeat(player);
  if (table.status === 'playing') {
    throw new GameError('Wait for the round to finish before adding players.', 'in_progress');
  }
  const added = addBots(table, count);
  return { table, added };
}

export function clearBots(player) {
  const table = requireSeat(player);
  if (table.status === 'playing') {
    throw new GameError('Wait for the round to finish before removing players.', 'in_progress');
  }
  const removed = removeBots(table);
  return { table, removed };
}

export function lobby({ game } = {}) {
  sweepIdleTables();
  ensureOpenWorld();
  return listTables({ game });
}

export function tableSummary(player) {
  const table = tableOf(player);
  return table ? { id: table.id, game: table.game, status: table.status } : null;
}

export const turnClock = () => config.turnSeconds;

/** Everything a visual client needs in one object. */
export function snapshot(player) {
  const table = tableOf(player);
  if (table) catchUp(table);
  // Not seated? Then the screen shows the room list, from the same call the
  // chat uses, so the two surfaces cannot disagree about what is open.
  const rooms = table ? null : lobby();
  const game = table ? getGame(table.game) : null;
  return {
    player: {
      username: player.username,
      chips: player.chips,
      stats: player.stats,
    },
    table: table ? {
      id: table.id,
      game: table.game,
      title: game.title,
      name: table.name,
      stake: table.stake,
      status: table.status,
      round: table.round,
      isYourTurn: table.turn === player.id,
      turnUsername: table.turn ? playerById(table.turn)?.username : null,
      secondsLeft: table.status === 'playing' && table.turn ? turnSecondsLeft(table) : null,
      actionHelp: game.actionHelp,
      minSeats: game.minSeats,
      maxSeats: game.maxSeats,
      seatCount: table.seats.length,
      log: recentLog(table, 10),
    } : null,
    game: table && game.snapshot ? game.snapshot(table, player) : null,
    lobby: rooms,
  };
}
