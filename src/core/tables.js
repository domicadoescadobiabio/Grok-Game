// Tables: seats, turns and clocks, shared by every game.
//
// This file knows nothing about cards or pieces. Games plug in through the
// registry and are handed a table to mutate; anything here is true whether the
// table is playing poker or chess.

import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { db, save, GameError, playerById } from './players.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

export function newTableCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const bytes = randomBytes(4);
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!db.tables[code]) return code;
  }
  throw new GameError('Could not allocate a table code.', 'no_code');
}

export function createTable({ game, host, name, stake, maxSeats, turnSeconds, isPrivate = false }) {
  const id = newTableCode();
  const table = {
    id,
    game,
    name: name || `${host.username}'s table`,
    hostId: host.id,
    stake,
    maxSeats,
    isPrivate,
    // Per game: a blackjack decision is not a chess move.
    turnLimit: turnSeconds || config.turnSeconds,
    seats: [],
    status: 'waiting', // waiting | playing | finished
    turn: null,        // playerId whose move it is
    turnStartedAt: 0,
    round: 0,
    state: {},         // the game's own state
    log: [],
    createdAt: Date.now(),
    lastActionAt: Date.now(),
  };
  db.tables[id] = table;
  save();
  return table;
}

export const getTable = (id) => db.tables[String(id || '').toUpperCase()] || null;

export function requireTable(id) {
  const table = getTable(id);
  if (!table) throw new GameError(`No table with code ${String(id || '').toUpperCase()}.`, 'no_table');
  return table;
}

export const seatOf = (table, playerId) => table.seats.find((s) => s.playerId === playerId) || null;

export function tableOf(player) {
  if (!player.seatedAt) return null;
  const table = getTable(player.seatedAt);
  if (!table || !seatOf(table, player.id)) {
    // The table was cleaned up under them; do not leave a dangling pointer.
    player.seatedAt = null;
    save();
    return null;
  }
  return table;
}

export function requireSeat(player) {
  const table = tableOf(player);
  if (!table) throw new GameError('You are not at a table. Join or create one first.', 'no_seat');
  return table;
}

export function sit(table, player, buyIn) {
  if (seatOf(table, player.id)) return table;
  if (player.seatedAt && player.seatedAt !== table.id) {
    throw new GameError(`You are already seated at table ${player.seatedAt}. Leave it first.`, 'already_seated');
  }
  if (table.seats.length >= table.maxSeats) {
    throw new GameError(`Table ${table.id} is full (${table.maxSeats} seats).`, 'table_full');
  }
  if (table.status === 'playing') {
    throw new GameError(`Table ${table.id} is mid-hand. Try again when the round ends.`, 'in_progress');
  }
  if (buyIn > 0 && player.chips < buyIn) {
    throw new GameError(`You need ${buyIn} chips to sit here and you have ${player.chips}.`, 'poor');
  }

  table.seats.push({
    playerId: player.id,
    username: player.username,
    joinedAt: Date.now(),
    sittingOut: false,
  });
  player.seatedAt = table.id;
  table.lastActionAt = Date.now();
  tableLog(table, `@${player.username} sits down.`);
  save();
  return table;
}

export function stand(table, player) {
  table.seats = table.seats.filter((s) => s.playerId !== player.id);
  player.seatedAt = null;
  table.lastActionAt = Date.now();
  tableLog(table, `@${player.username} leaves.`);
  if (table.turn === player.id) table.turn = null;
  if (!table.seats.length) delete db.tables[table.id];
  save();
}

export function tableLog(table, text) {
  table.log.unshift({ at: Date.now(), text });
  if (table.log.length > 60) table.log.length = 60;
  save();
}

export const recentLog = (table, n = 8) => table.log.slice(0, n).map((l) => l.text);

// ---------------------------------------------------------------- turns

export function setTurn(table, playerId) {
  table.turn = playerId;
  table.turnStartedAt = Date.now();
  table.lastActionAt = Date.now();
  save();
}

export function requireTurn(table, player) {
  if (table.status !== 'playing') {
    throw new GameError('No hand is in progress. Start one first.', 'not_playing');
  }
  if (table.turn !== player.id) {
    const who = table.turn ? playerById(table.turn)?.username : null;
    throw new GameError(who ? `It is @${who}'s turn, not yours.` : 'It is not your turn.', 'not_your_turn');
  }
}

export const turnLimitOf = (table) => table.turnLimit || config.turnSeconds;

export const turnSecondsLeft = (table) =>
  Math.max(0, Math.ceil(turnLimitOf(table) - (Date.now() - table.turnStartedAt) / 1000));

export const turnExpired = (table) =>
  table.status === 'playing' && table.turn && turnSecondsLeft(table) <= 0;

// ---------------------------------------------------------------- seat order

export function activeSeats(table) {
  return table.seats.filter((s) => !s.sittingOut);
}

export function seatIndex(table, playerId) {
  return table.seats.findIndex((s) => s.playerId === playerId);
}

/** The next seat after `fromId` that passes `predicate`, wrapping once. */
export function nextSeat(table, fromId, predicate = () => true) {
  const n = table.seats.length;
  if (!n) return null;
  const start = Math.max(0, seatIndex(table, fromId));
  for (let step = 1; step <= n; step++) {
    const seat = table.seats[(start + step) % n];
    if (predicate(seat)) return seat;
  }
  return null;
}

// ---------------------------------------------------------------- listing

export function listTables({ game, includePrivate = false } = {}) {
  return Object.values(db.tables)
    .filter((t) => (!game || t.game === game) && (includePrivate || !t.isPrivate))
    .sort((a, b) => b.lastActionAt - a.lastActionAt)
    .map((t) => ({
      id: t.id,
      game: t.game,
      name: t.name,
      stake: t.stake,
      players: t.seats.length,
      maxSeats: t.maxSeats,
      status: t.status,
      seats: t.seats.map((s) => s.username),
    }));
}

/**
 * Drop tables nobody has touched in a long time. Called opportunistically on
 * reads, because there is no background loop: a connector-driven server only
 * runs while someone is talking to it.
 */
export function sweepIdleTables() {
  const cutoff = Date.now() - config.tableIdleMinutes * 60 * 1000;
  for (const table of Object.values(db.tables)) {
    if (table.lastActionAt > cutoff) continue;
    for (const seat of table.seats) {
      const p = playerById(seat.playerId);
      if (!p) continue;
      if (p.seatedAt === table.id) p.seatedAt = null;
      // Bot accounts belong to the table; they go with it.
      if (p.isBot) delete db.players[p.id];
    }
    delete db.tables[table.id];
  }
  save();
}
