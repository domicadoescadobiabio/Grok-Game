// The open world: the arcade has rooms before anyone asks for them.
//
// These are the promises the rest of the product now leans on -- "sit me at a
// poker table" must always find a seat, and a room must not vanish when the
// last player stands up.
process.env.DATA_FILE = process.env.DATA_FILE || './data/test-world.json';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { db, createPlayer, GameError } from '../src/core/players.js';
import { joinTable, leaveTable, lobby, startRound, seatBots } from '../src/core/engine.js';
import { ensureOpenWorld, resolveGameKey, findOpenTable } from '../src/core/world.js';
import { gameList } from '../src/games/index.js';

let seq = 0;
const newPlayer = (chips = 1000) => {
  const p = createPlayer(`w${Date.now().toString(36)}${seq++}`);
  p.chips = chips;
  return p;
};

const reset = () => { db.tables = {}; };

test('every game has a room, seeded from nothing', () => {
  reset();
  ensureOpenWorld();
  for (const g of gameList()) {
    const rooms = Object.values(db.tables).filter((t) => t.game === g.key);
    assert.ok(rooms.length >= 1, `${g.key} has no room`);
    assert.ok(rooms.some((t) => t.isHouse), `${g.key} has no permanent room`);
  }
});

test('seeding twice does not double the world', () => {
  reset();
  ensureOpenWorld();
  const first = Object.keys(db.tables).length;
  ensureOpenWorld();
  assert.equal(Object.keys(db.tables).length, first);
});

test('a game name seats you; a code still works too', () => {
  reset();
  const p = newPlayer();
  const { table } = joinTable(p, 'poker');
  assert.equal(table.game, 'poker');
  assert.equal(p.seatedAt, table.id);

  leaveTable(p);
  const q = newPlayer();
  const joined = joinTable(q, table.id).table;
  assert.equal(joined.id, table.id);
});

test('names people actually use resolve to a game', () => {
  assert.equal(resolveGameKey("Texas Hold'em"), 'poker');
  assert.equal(resolveGameKey('dominoes'), 'domino');
  assert.equal(resolveGameKey('draughts'), 'checkers');
  // A table code is not a game name, or every code would be swallowed here.
  assert.equal(resolveGameKey('PKER'), null);
  assert.equal(resolveGameKey('K7QD'), null);
});

test('a permanent room survives the last player standing up', () => {
  reset();
  const p = newPlayer();
  const { table } = joinTable(p, 'chess');
  const id = table.id;
  leaveTable(p);
  assert.ok(db.tables[id], 'the room was torn down with its last player');
  assert.equal(db.tables[id].seats.length, 0);
});

test('a busy room means another one opens, not a refusal', () => {
  reset();
  // Chess seats two. Fill the permanent room and start a hand, so it is both
  // full and mid-hand -- the two ways a room can be shut.
  const a = newPlayer();
  const b = newPlayer();
  const first = joinTable(a, 'chess').table;
  joinTable(b, first.id);
  startRound(a);

  const c = newPlayer();
  const second = joinTable(c, 'chess').table;
  assert.notEqual(second.id, first.id);
  assert.equal(second.game, 'chess');
});

test('an overflow room is temporary; the permanent one is not', () => {
  reset();
  const a = newPlayer();
  const b = newPlayer();
  const house = joinTable(a, 'chess').table;
  joinTable(b, house.id);
  startRound(a);

  const c = newPlayer();
  const overflow = joinTable(c, 'chess').table;
  assert.equal(overflow.isHouse, false);
  leaveTable(c);
  assert.ok(!db.tables[overflow.id], 'the overflow room outlived its only player');
  assert.ok(db.tables[house.id], 'the permanent room went with it');
});

test('the lobby lists the world with the permanent rooms first', () => {
  reset();
  const rows = lobby();
  assert.equal(rows.length >= gameList().length, true);
  const firstSeven = rows.slice(0, gameList().length);
  assert.ok(firstSeven.every((r) => r.isHouse), 'a temporary table outranked the furniture');
  assert.ok(rows.every((r) => typeof r.turnSeconds === 'number'));
});

test('you can still fill a room with bots and play alone', () => {
  reset();
  const p = newPlayer();
  joinTable(p, 'poker');
  const { added } = seatBots(p, 2);
  assert.equal(added.length, 2);
  const { table } = startRound(p);
  assert.equal(table.status, 'playing');
});

test('joining a game nobody offers is refused, not invented', () => {
  reset();
  const p = newPlayer();
  assert.throws(() => joinTable(p, 'ZZZZ'), GameError);
});

test.after(() => {
  try { fs.unlinkSync(process.env.DATA_FILE); } catch { /* never existed */ }
});
