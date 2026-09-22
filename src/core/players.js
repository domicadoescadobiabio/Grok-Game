// Accounts, chips and sessions. An account is an X username plus a 6-digit ID
// that works as its password, so a player can log in from any chat on any
// device by saying one sentence.

import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { createStore } from '../store/jsonStore.js';

const DEFAULTS = {
  version: 1,
  players: {},
  usernames: {},
  sessions: {},
  tables: {},
  history: [],
};

const store = createStore(config.dataFile, DEFAULTS);
export const db = store.data;
export const save = () => store.markDirty();
export const flush = () => store.flush();

export class GameError extends Error {
  constructor(message, code = 'error') {
    super(message);
    this.code = code;
  }
}

const norm = (u) => String(u || '').trim().replace(/^@+/, '').toLowerCase();

export const findByUsername = (username) => {
  const id = db.usernames[norm(username)];
  return id ? db.players[id] : null;
};

export const playerById = (id) => db.players[id] || null;

export function createPlayer(username) {
  const uname = norm(username);
  if (!/^[a-z0-9_]{1,15}$/.test(uname)) {
    throw new GameError('That does not look like an X username (letters, numbers, underscore, max 15).', 'bad_username');
  }
  if (db.usernames[uname]) {
    throw new GameError(`@${uname} already has an account. Log in with your player ID instead.`, 'taken');
  }

  const id = `p_${randomUUID().slice(0, 8)}`;
  const pin = String(100000 + (randomBytes(4).readUInt32BE(0) % 900000));
  db.players[id] = {
    id,
    username: uname,
    pin,
    chips: config.startingChips,
    lastRebuyAt: 0,
    seatedAt: null, // table id, when sitting
    stats: { handsPlayed: 0, wins: 0, losses: 0, biggestPot: 0, chipsWon: 0, chipsLost: 0 },
    createdAt: Date.now(),
    lastSeen: Date.now(),
  };
  db.usernames[uname] = id;
  save();
  return db.players[id];
}

export function issueSession(player) {
  const token = `ar_${randomBytes(18).toString('base64url')}`;
  db.sessions[token] = { playerId: player.id, createdAt: Date.now(), lastUsed: Date.now() };
  save();
  return token;
}

export function login(username, pin) {
  const player = findByUsername(username);
  if (!player) {
    throw new GameError(`No account for @${norm(username)} yet. Create one first.`, 'no_account');
  }
  if (String(pin).trim() !== String(player.pin)) {
    throw new GameError('Wrong player ID for that username.', 'bad_pin');
  }
  player.lastSeen = Date.now();
  save();
  return { player, session: issueSession(player) };
}

/**
 * Accepts a session token, or username + player ID on every call. A connector
 * may open a fresh connection per tool call, so nothing may depend on the
 * transport remembering anything.
 */
export function authenticate({ session, username, player_id } = {}) {
  if (session) {
    const s = db.sessions[session];
    if (!s) throw new GameError('Session expired or unknown. Log in again.', 'no_session');
    if (Date.now() - s.createdAt > config.sessionTtlHours * 3600 * 1000) {
      delete db.sessions[session];
      save();
      throw new GameError('Session expired. Log in again.', 'no_session');
    }
    const player = db.players[s.playerId];
    if (!player) throw new GameError('Account missing for this session.', 'no_account');
    s.lastUsed = Date.now();
    player.lastSeen = Date.now();
    save();
    return player;
  }
  if (username && player_id) {
    const { player } = login(username, player_id);
    return player;
  }
  throw new GameError('Not logged in. Log in with your X username and player ID first.', 'unauthenticated');
}

// ---------------------------------------------------------------- chips

export function adjustChips(player, delta, reason) {
  player.chips = Math.max(0, player.chips + delta);
  if (delta > 0) player.stats.chipsWon += delta;
  else player.stats.chipsLost += -delta;
  save();
  return { chips: player.chips, delta, reason };
}

export function rebuy(player) {
  if (player.chips > 0) {
    throw new GameError(`You still have ${player.chips} chips. Rebuy is only for busted players.`, 'not_busted');
  }
  const wait = config.rebuyCooldownMinutes * 60 * 1000 - (Date.now() - player.lastRebuyAt);
  if (player.lastRebuyAt && wait > 0) {
    throw new GameError(`Next rebuy in ${Math.ceil(wait / 60000)} minutes.`, 'cooldown');
  }
  player.chips = config.rebuyChips;
  player.lastRebuyAt = Date.now();
  save();
  return player.chips;
}

export function leaderboard(limit = 10) {
  return Object.values(db.players)
    .map((p) => ({
      username: p.username,
      chips: p.chips,
      handsPlayed: p.stats.handsPlayed,
      wins: p.stats.wins,
      biggestPot: p.stats.biggestPot,
      createdAt: p.createdAt,
    }))
    // Ties are the norm before anyone has played, so break them the same way
    // every time instead of letting object order decide.
    .sort((a, b) =>
      b.chips - a.chips ||
      b.wins - a.wins ||
      a.createdAt - b.createdAt ||
      a.username.localeCompare(b.username))
    .slice(0, limit)
    .map(({ createdAt, ...row }) => row);
}

export function logHistory(text) {
  db.history.unshift({ at: Date.now(), text });
  if (db.history.length > 300) db.history.length = 300;
  save();
}
