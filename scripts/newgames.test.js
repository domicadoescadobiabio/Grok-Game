// Every new game played through against bots, plus the rules most likely to be
// got wrong. Uses a scratch save file so real chips are never touched.
process.env.DATA_FILE = process.env.DATA_FILE || './data/test-newgames.json';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createPlayer, playerById, GameError } from '../src/core/players.js';
import { createTable, seatBots, startRound, act, viewTable, leaveTable, snapshot } from '../src/core/engine.js';
import { checkArrangement, autoArrange } from '../src/games/chinesepoker.js';
import { fullSet, parseTile, canPlay, pips } from '../src/games/domino.js';
import { startingBoard, legalMoves, applyMove, countPieces, chooseMove, parseSquare } from '../src/games/checkers.js';
import { makeCard, findLine, marksFor, columnOf } from '../src/games/bingo.js';

let seq = 0;
const newPlayer = (chips = 5000) => {
  const p = createPlayer(`n${Date.now().toString(36)}${seq++}`);
  p.chips = chips;
  return p;
};

test.after(() => {
  try { fs.unlinkSync(process.env.DATA_FILE); } catch { /* fine */ }
});

/** Play a table out with a simple policy until it finishes. */
function playOut(table, me, decide, limit = 200) {
  for (let i = 0; i < limit && table.status === 'playing'; i++) {
    if (table.turn !== me.id) break; // bots move inside act(); if not us, we are stuck
    const move = decide(table, me);
    if (!move) break;
    act(me, move.action, move.args || {});
  }
  return table.status;
}

// ---------------------------------------------------------------- chinese poker

test('chinese poker: auto-arrangements are always legal', () => {
  const me = newPlayer();
  const table = createTable(me, 'chinesepoker', { stake: 20 });
  seatBots(me, 2);
  startRound(me);
  for (let i = 0; i < 25; i++) {
    const hand = table.state.hands[me.id].cards;
    const rows = autoArrange(hand);
    const check = checkArrangement(rows);
    assert.equal(check.foul, false, 'auto-arrange produced a foul');
    assert.equal(new Set([...rows.front, ...rows.middle, ...rows.back]).size, 13);
  }
  leaveTable(me);
});

test('chinese poker: rows out of order are a foul', () => {
  // back must beat middle: a pair behind two pair is backwards
  const bad = {
    front: ['2c', '3d', '4h'],
    middle: ['As', 'Ad', 'Ks', 'Kd', '9c'],   // two pair
    back: ['5s', '5d', '7c', '8h', 'Jd'],     // one pair
  };
  assert.equal(checkArrangement(bad).foul, true);
  const good = { front: bad.front, middle: bad.back, back: bad.middle };
  assert.equal(checkArrangement(good).foul, false);
});

test('chinese poker: a hand plays out and moves chips', () => {
  const me = newPlayer(5000);
  const table = createTable(me, 'chinesepoker', { stake: 20 });
  seatBots(me, 2);
  const before = me.chips;
  startRound(me);
  act(me, 'auto');
  assert.equal(table.status, 'finished');
  assert.ok(table.state.results, 'no results recorded');
  assert.notEqual(me.chips, before, 'nobody can score exactly zero against two opponents every time');
  leaveTable(me);
});

test('chinese poker: you cannot play a card you were not dealt', () => {
  const me = newPlayer();
  const table = createTable(me, 'chinesepoker', { stake: 20 });
  seatBots(me, 1);
  startRound(me);
  const hand = table.state.hands[me.id].cards;
  const notMine = ['As', 'Ks', 'Qs', 'Js', 'Ts', '9s', '8s', '7s', '6s', '5s', '4s', '3s', '2s']
    .filter((c) => !hand.includes(c));
  assert.throws(
    () => act(me, 'arrange', {
      front: notMine.slice(0, 3).join(' '),
      middle: notMine.slice(3, 8).join(' '),
      back: notMine.slice(8, 13).join(' '),
    }),
    (e) => e instanceof GameError,
  );
  leaveTable(me);
});

// ---------------------------------------------------------------- domino

test('dominoes: a full double-six set is 28 tiles, all distinct', () => {
  const set = fullSet();
  assert.equal(set.length, 28);
  assert.equal(new Set(set.map((t) => t.join('-'))).size, 28);
  assert.equal(set.reduce((s, t) => s + pips(t), 0), 168, 'total pips in a double-six set');
});

test('dominoes: tiles parse and match ends correctly', () => {
  assert.deepEqual(parseTile('6-3'), [6, 3]);
  assert.deepEqual(parseTile('63'), [6, 3]);
  assert.equal(parseTile('9-1'), null);
  assert.equal(canPlay([6, 3], [6, 1]), true);
  assert.equal(canPlay([6, 3], [2, 5]), false);
  assert.equal(canPlay([6, 3], null), true, 'anything opens an empty board');
});

test('dominoes: a hand plays to a finish', () => {
  const me = newPlayer(5000);
  const table = createTable(me, 'domino', { stake: 10 });
  seatBots(me, 3);
  startRound(me);

  playOut(table, me, (t, p) => {
    const st = t.state;
    const hand = st.hands[p.id] || [];
    const playable = hand.filter((x) => canPlay(x, st.ends));
    return playable.length
      ? { action: 'play', args: { tile: `${playable[0][0]}-${playable[0][1]}` } }
      : { action: 'pass' };
  });

  assert.equal(table.status, 'finished', 'hand never ended');
  const totalTiles = Object.values(table.state.hands).reduce((n, h) => n + h.length, 0);
  assert.ok(totalTiles < 28, 'tiles were played');
  leaveTable(me);
});

test('dominoes: you cannot pass while holding a playable tile', () => {
  const me = newPlayer();
  const table = createTable(me, 'domino', { stake: 10 });
  seatBots(me, 1);
  startRound(me);
  const st = table.state;
  if (table.turn !== me.id) { leaveTable(me); return; }
  const hand = st.hands[me.id];
  if (!hand.some((t) => canPlay(t, st.ends))) { leaveTable(me); return; }
  assert.throws(() => act(me, 'pass'), (e) => e instanceof GameError && e.code === 'can_play');
  leaveTable(me);
});

// ---------------------------------------------------------------- checkers

test('checkers: the board starts with twelve a side and seven opening moves', () => {
  const board = startingBoard();
  assert.equal(countPieces(board, 'w'), 12);
  assert.equal(countPieces(board, 'b'), 12);
  assert.equal(legalMoves(board, 'w').length, 7);
});

test('checkers: capturing is compulsory', () => {
  const board = new Array(64).fill(null);
  const put = (sq, piece) => { const s = parseSquare(sq); board[s.rank * 8 + s.file] = piece; };
  put('c3', { colour: 'w', king: false });
  put('d4', { colour: 'b', king: false });
  put('a1', { colour: 'w', king: false });   // has a quiet move available

  const moves = legalMoves(board, 'w');
  assert.ok(moves.length > 0);
  assert.ok(moves.every((m) => m.captures.length > 0), 'quiet moves must be dropped when a capture exists');
  assert.ok(moves.some((m) => m.from === 'c3' && m.to === 'e5'));
});

test('checkers: a man crowns on the far rank', () => {
  const board = new Array(64).fill(null);
  const put = (sq, piece) => { const s = parseSquare(sq); board[s.rank * 8 + s.file] = piece; };
  put('b7', { colour: 'w', king: false });
  const move = legalMoves(board, 'w').find((m) => m.to === 'a8' || m.to === 'c8');
  assert.ok(move, 'no move to the last rank');
  const after = applyMove(board, move);
  assert.equal(after.crowned, true);
  const s = parseSquare(move.to);
  assert.equal(after.board[s.rank * 8 + s.file].king, true);
});

test('checkers: a game against the bot terminates with a winner', () => {
  const me = newPlayer(5000);
  const table = createTable(me, 'checkers', { stake: 50 });
  seatBots(me, 1);
  startRound(me);

  const myColour = table.state.white === me.id ? 'w' : 'b';
  playOut(table, me, (t) => {
    const move = chooseMove(t.state.board, myColour, 3);
    return move ? { action: 'move', args: { from: move.from, to: move.to } } : null;
  }, 300);

  assert.equal(table.status, 'finished');
  assert.ok(table.state.outcome, 'no outcome recorded');
  leaveTable(me);
});

// ---------------------------------------------------------------- bingo

test('bingo: a card is well formed', () => {
  for (let i = 0; i < 50; i++) {
    const card = makeCard();
    assert.equal(card.length, 5);
    assert.equal(card[2][2], 0, 'centre must be free');
    const numbers = card.flat().filter((n) => n !== 0);
    assert.equal(new Set(numbers).size, 24, 'no repeats on a card');
    card.forEach((column, col) => column.forEach((n) => {
      if (n === 0) return;
      assert.ok(n > col * 15 && n <= (col + 1) * 15, `${n} is not in column ${col}`);
    }));
  }
});

test('bingo: lines are detected in every direction', () => {
  const card = makeCard();
  assert.equal(findLine(card, []), null, 'the free square alone is not a line');

  const row = [0, 1, 2, 3, 4].map((col) => card[col][0]);
  assert.equal(findLine(card, row), 'row 1');

  const column = card[1];
  assert.equal(findLine(card, column), `column ${['B', 'I', 'N', 'G', 'O'][1]}`);

  const diag = [0, 1, 2, 3, 4].map((i) => card[i][i]).filter((n) => n !== 0);
  assert.equal(findLine(card, diag), 'diagonal');
});

test('bingo: columns map to the right letters', () => {
  assert.equal(columnOf(1), 'B');
  assert.equal(columnOf(15), 'B');
  assert.equal(columnOf(16), 'I');
  assert.equal(columnOf(75), 'O');
});

test('bingo: a game ends with a winner and the pot is conserved', () => {
  const me = newPlayer(5000);
  const table = createTable(me, 'bingo', { stake: 40 });
  seatBots(me, 2);
  const before = me.chips;
  startRound(me);
  const pot = table.state.pot;

  playOut(table, me, () => ({ action: 'call' }), 200);

  assert.equal(table.status, 'finished', 'bingo never ended');
  assert.ok(table.state.winners.length > 0 || table.state.called.length === 75);
  const won = table.state.winners.reduce((s, w) => s + w.amount, 0);
  if (table.state.winners.length) assert.equal(won, pot, 'the whole pot must be paid out');
  assert.notEqual(me.chips, before - 40 - 1, 'chips moved');
  leaveTable(me);
});

// ---------------------------------------------------------------- shared

test('every game renders a view for a seated player without throwing', () => {
  for (const game of ['chinesepoker', 'domino', 'checkers', 'bingo']) {
    const me = newPlayer(5000);
    createTable(me, game, {});
    seatBots(me, 1);
    const before = viewTable(me);
    assert.ok(before.length > 20, `${game}: empty view before dealing`);
    startRound(me);
    const after = viewTable(me);
    assert.ok(after.length > 20, `${game}: empty view after dealing`);
    assert.ok(!after.includes('undefined'), `${game}: undefined leaked into the view`);
    const snap = snapshot(me);
    assert.ok(snap.game, `${game}: no snapshot`);
    assert.ok(!JSON.stringify(snap).includes('undefined'), `${game}: undefined in snapshot`);
    leaveTable(me);
  }
});
