// Plays each game through the engine the way the tools will, so the rules are
// tested without the MCP layer in the way.
//
// DATA_FILE is pointed at a scratch file so a test run never touches real chips.
process.env.DATA_FILE = process.env.DATA_FILE || './data/test-games.json';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { db, createPlayer, playerById, GameError } from '../src/core/players.js';
import { createTable, joinTable, startRound, act, viewTable, leaveTable, lobby } from '../src/core/engine.js';
import { buildPots } from '../src/games/poker.js';
import { handValue, isBlackjack } from '../src/games/blackjack.js';

let seq = 0;
const newPlayer = (chips = 1000) => {
  const p = createPlayer(`t${Date.now().toString(36)}${seq++}`);
  p.chips = chips;
  return p;
};

test.after(() => {
  try { fs.unlinkSync(process.env.DATA_FILE); } catch { /* fine */ }
});

// ---------------------------------------------------------------- blackjack

test('blackjack: hands resolve and chips move', () => {
  const a = newPlayer();
  const b = newPlayer();
  const table = createTable(a, 'blackjack', { stake: 50 });
  joinTable(b, table.id);

  const before = a.chips + b.chips;
  startRound(a);
  assert.equal(table.status, 'playing');
  assert.equal(a.chips + b.chips, before - 100, 'both bets leave the stacks');

  // Play both hands out to whatever the shoe gives us.
  for (let guard = 0; guard < 30 && table.status === 'playing'; guard++) {
    const turn = playerById(table.turn);
    const hand = table.state.hands[turn.id];
    const { total } = handValue(hand.cards);
    act(turn, total < 17 ? 'hit' : 'stand');
  }

  assert.equal(table.status, 'finished');
  for (const p of [a, b]) {
    const hand = table.state.hands[p.id];
    assert.ok(hand.result, `@${p.username} has no result`);
    assert.ok(p.chips >= 0);
  }
});

test('blackjack: double is refused after the first two cards', () => {
  const a = newPlayer();
  const table = createTable(a, 'blackjack', { stake: 10 });
  startRound(a);
  if (table.status !== 'playing') return; // dealt a blackjack, nothing to test
  act(a, 'hit');
  if (table.status !== 'playing') return; // busted on the draw
  assert.throws(() => act(a, 'double'), (e) => e instanceof GameError && e.code === 'cannot_double');
});

test('blackjack: a natural pays three to two', () => {
  const a = newPlayer(1000);
  const b = newPlayer(1000);
  const table = createTable(a, 'blackjack', { stake: 100 });
  joinTable(b, table.id);
  startRound(a);

  // Force the situation rather than dealing until it shows up. A holds a
  // natural, which never acts -- B standing is what runs the dealer out.
  //
  // status is reset too: roughly one deal in twenty gives the DEALER a natural,
  // which settles the round immediately and used to make this test fail at
  // random with "no round in progress".
  table.status = 'playing';
  table.state.revealed = false;
  table.state.phase = 'playing';
  table.state.hands[a.id].cards = ['As', 'Kd'];
  table.state.hands[a.id].status = 'blackjack';
  table.state.hands[b.id].cards = ['9c', '7h'];
  table.state.hands[b.id].status = 'playing';
  table.state.dealer = ['Tc', '8h'];
  table.turn = b.id;

  const aBefore = a.chips;
  act(b, 'stand');
  assert.equal(table.status, 'finished');
  assert.equal(a.chips, aBefore + 250, 'a 100 bet returns 250 on blackjack');
  assert.match(table.state.hands[a.id].result, /blackjack/);
});

// ---------------------------------------------------------------- chess

test('chess: legal moves advance, illegal ones are refused with help', () => {
  const a = newPlayer();
  const b = newPlayer();
  const table = createTable(a, 'chess', { stake: 100 });
  joinTable(b, table.id);
  startRound(a);

  const white = playerById(table.state.white);
  const black = playerById(table.state.black);
  assert.equal(table.turn, white.id, 'white moves first');
  assert.equal(a.chips + b.chips, 1800, 'both stakes are in the pot');

  act(white, 'move', { move: 'e4' });
  assert.equal(table.turn, black.id);

  assert.throws(
    () => act(black, 'move', { move: 'e5xd9' }),
    (e) => e instanceof GameError && e.code === 'illegal_move' && /Legal moves:/.test(e.message),
  );
  assert.throws(() => act(white, 'move', { move: 'e5' }), (e) => e.code === 'not_your_turn');
});

test('chess: scholar\'s mate ends the game and pays the pot', () => {
  const a = newPlayer();
  const b = newPlayer();
  const table = createTable(a, 'chess', { stake: 100 });
  joinTable(b, table.id);
  startRound(a);
  const white = playerById(table.state.white);
  const black = playerById(table.state.black);
  const whiteBefore = white.chips;

  for (const [who, mv] of [[white, 'e4'], [black, 'e5'], [white, 'Qh5'], [black, 'Nc6'],
    [white, 'Bc4'], [black, 'Nf6'], [white, 'Qxf7#']]) {
    act(who, 'move', { move: mv });
  }

  assert.equal(table.status, 'finished');
  assert.equal(white.chips, whiteBefore + 200, 'winner takes the whole pot');
});

test('chess: resigning hands the pot to the opponent', () => {
  const a = newPlayer();
  const b = newPlayer();
  const table = createTable(a, 'chess', { stake: 50 });
  joinTable(b, table.id);
  startRound(a);
  const white = playerById(table.state.white);
  const black = playerById(table.state.black);
  const blackBefore = black.chips;
  act(white, 'resign');
  assert.equal(table.status, 'finished');
  assert.equal(black.chips, blackBefore + 100);
});

test('chess: a draw offer needs both players', () => {
  const a = newPlayer();
  const b = newPlayer();
  const table = createTable(a, 'chess', { stake: 40 });
  joinTable(b, table.id);
  startRound(a);
  const white = playerById(table.state.white);
  const black = playerById(table.state.black);
  const before = { w: white.chips, b: black.chips };

  act(white, 'draw');
  assert.equal(table.status, 'playing', 'one offer is not a draw');
  act(black, 'draw');
  assert.equal(table.status, 'finished');
  assert.equal(white.chips, before.w + 40);
  assert.equal(black.chips, before.b + 40);
});

// ---------------------------------------------------------------- poker

test('poker: blinds post and heads-up order is right', () => {
  const a = newPlayer();
  const b = newPlayer();
  const table = createTable(a, 'poker', { stake: 20 });
  joinTable(b, table.id);
  startRound(a);

  const st = table.state;
  assert.equal(st.pot, 30, 'small blind 10 + big blind 20');
  // Heads-up: the dealer posts the small blind and acts first preflop.
  const dealerId = st.order[st.dealerIdx];
  assert.equal(table.turn, dealerId, 'dealer acts first heads-up');
  assert.equal(st.players[dealerId].bet, 10, 'dealer posted the small blind');
});

test('poker: a fold ends the hand and pays the other player', () => {
  const a = newPlayer(1000);
  const b = newPlayer(1000);
  const table = createTable(a, 'poker', { stake: 20 });
  joinTable(b, table.id);
  startRound(a);

  const folder = playerById(table.turn);
  const winner = folder.id === a.id ? b : a;
  const winnerBefore = winner.chips;
  const pot = table.state.pot;
  act(folder, 'fold');

  assert.equal(table.status, 'finished');
  assert.equal(winner.chips, winnerBefore + pot, 'the whole pot goes to the last player standing');
  assert.equal(a.chips + b.chips, 2000, 'no chips created or destroyed');
});

test('poker: check-down to showdown keeps the chips conserved', () => {
  const a = newPlayer(1000);
  const b = newPlayer(1000);
  const table = createTable(a, 'poker', { stake: 20 });
  joinTable(b, table.id);
  startRound(a);

  for (let guard = 0; guard < 40 && table.status === 'playing'; guard++) {
    const turn = playerById(table.turn);
    const me = table.state.players[turn.id];
    const toCall = table.state.currentBet - me.bet;
    act(turn, toCall > 0 ? 'call' : 'check');
  }

  assert.equal(table.status, 'finished');
  assert.equal(a.chips + b.chips, 2000, 'chips are conserved through a showdown');
  assert.equal(table.state.board.length, 5, 'all five board cards were dealt');
});

test('poker: raising reopens the action for everyone else', () => {
  const a = newPlayer();
  const b = newPlayer();
  const c = newPlayer();
  const table = createTable(a, 'poker', { stake: 20 });
  joinTable(b, table.id);
  joinTable(c, table.id);
  startRound(a);

  const first = playerById(table.turn);
  act(first, 'call');
  const second = playerById(table.turn);
  act(second, 'raise', { amount: 60 });
  // The first caller must get another decision now that the bet went up.
  assert.equal(table.state.players[first.id].acted, false);
  assert.notEqual(table.turn, second.id);
});

test('poker: a raise below the minimum is refused', () => {
  const a = newPlayer();
  const b = newPlayer();
  const table = createTable(a, 'poker', { stake: 20 });
  joinTable(b, table.id);
  startRound(a);
  const turn = playerById(table.turn);
  assert.throws(() => act(turn, 'raise', { amount: 25 }),
    (e) => e instanceof GameError && e.code === 'too_small');
});

test('poker: side pots only pay what a short stack covered', () => {
  // A is all-in for less; B and C keep betting. A can win only the main pot.
  const st = {
    order: ['A', 'B', 'C'],
    players: {
      A: { id: 'A', username: 'a', committed: 100, folded: false },
      B: { id: 'B', username: 'b', committed: 400, folded: false },
      C: { id: 'C', username: 'c', committed: 400, folded: false },
    },
  };
  const pots = buildPots(st);
  assert.equal(pots.length, 2);
  assert.equal(pots[0].amount, 300, 'main pot is 100 from each');
  assert.deepEqual(pots[0].eligible.map((p) => p.id).sort(), ['A', 'B', 'C']);
  assert.equal(pots[1].amount, 600, 'side pot is the extra 300 each from B and C');
  assert.deepEqual(pots[1].eligible.map((p) => p.id).sort(), ['B', 'C']);
});

test('poker: folded chips stay in the pot but win nothing', () => {
  const st = {
    order: ['A', 'B', 'C'],
    players: {
      A: { id: 'A', username: 'a', committed: 50, folded: true },
      B: { id: 'B', username: 'b', committed: 200, folded: false },
      C: { id: 'C', username: 'c', committed: 200, folded: false },
    },
  };
  const pots = buildPots(st);
  const total = pots.reduce((s, p) => s + p.amount, 0);
  assert.equal(total, 450, 'the folder\'s 50 is still in play');
  for (const pot of pots) {
    assert.ok(!pot.eligible.some((p) => p.id === 'A'), 'a folded player is never eligible');
  }
});

// ---------------------------------------------------------------- tables

test('a player cannot sit at two tables', () => {
  const a = newPlayer();
  const t1 = createTable(a, 'blackjack', {});
  assert.throws(() => createTable(a, 'poker', {}), (e) => e.code === 'already_seated');
  leaveTable(a);
  assert.doesNotThrow(() => createTable(a, 'poker', {}));
});

test('leaving mid-hand forfeits rather than escaping the pot', () => {
  const a = newPlayer(1000);
  const b = newPlayer(1000);
  const table = createTable(a, 'poker', { stake: 20 });
  joinTable(b, table.id);
  startRound(a);
  const quitter = playerById(table.turn);
  const stayer = quitter.id === a.id ? b : a;
  const pot = table.state.pot;
  const stayerBefore = stayer.chips;

  leaveTable(quitter);
  assert.equal(stayer.chips, stayerBefore + pot, 'the remaining player takes the pot');
  assert.equal(quitter.seatedAt, null);
});

test('the lobby lists open tables', () => {
  const a = newPlayer();
  const table = createTable(a, 'chess', { name: 'Test Room' });
  const rows = lobby({ game: 'chess' });
  const mine = rows.find((r) => r.id === table.id);
  assert.ok(mine, 'the new table shows up');
  assert.equal(mine.name, 'Test Room');
  assert.equal(mine.players, 1);
});

test('the view never throws for any seated player', () => {
  const a = newPlayer();
  const b = newPlayer();
  const table = createTable(a, 'poker', { stake: 20 });
  joinTable(b, table.id);
  assert.ok(viewTable(a).includes(table.id), 'view works before a hand');
  startRound(a);
  for (const p of [a, b]) {
    const text = viewTable(p);
    assert.ok(text.length > 40);
    assert.ok(!text.includes('undefined'), 'no undefined leaked into the view');
  }
});
