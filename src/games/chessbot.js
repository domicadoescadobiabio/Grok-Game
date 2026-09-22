// A small chess opponent: alpha-beta over material plus piece-square tables,
// run under a time budget.
//
// It is not trying to be strong -- it is trying to be a real opponent that
// punishes a hanging piece, finds a mate in one, and never plays a legal move
// at random. See chooseMove for why the search is time-bounded rather than
// fixed-depth.

import { Chess } from 'chess.js';

const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

// Squares are indexed from white's a8; the tables reward central control and
// development, which is most of what separates a bot from a random mover.
const PAWN = [
  0, 0, 0, 0, 0, 0, 0, 0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5, 5, 10, 25, 25, 10, 5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, -5, -10, 0, 0, -10, -5, 5,
  5, 10, 10, -20, -20, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0,
];
const KNIGHT = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20, 0, 0, 0, 0, -20, -40,
  -30, 0, 10, 15, 15, 10, 0, -30,
  -30, 5, 15, 20, 20, 15, 5, -30,
  -30, 0, 15, 20, 20, 15, 0, -30,
  -30, 5, 10, 15, 15, 10, 5, -30,
  -40, -20, 0, 5, 5, 0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
];
const BISHOP = [
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 10, 10, 5, 0, -10,
  -10, 5, 5, 10, 10, 5, 5, -10,
  -10, 0, 10, 10, 10, 10, 0, -10,
  -10, 10, 10, 10, 10, 10, 10, -10,
  -10, 5, 0, 0, 0, 0, 5, -10,
  -20, -10, -10, -10, -10, -10, -10, -20,
];
const ROOK = [
  0, 0, 0, 0, 0, 0, 0, 0,
  5, 10, 10, 10, 10, 10, 10, 5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  0, 0, 0, 5, 5, 0, 0, 0,
];
const QUEEN = [
  -20, -10, -10, -5, -5, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 5, 5, 5, 0, -10,
  -5, 0, 5, 5, 5, 5, 0, -5,
  0, 0, 5, 5, 5, 5, 0, -5,
  -10, 5, 5, 5, 5, 5, 0, -10,
  -10, 0, 5, 0, 0, 0, 0, -10,
  -20, -10, -10, -5, -5, -10, -10, -20,
];
const KING = [
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
  20, 20, 0, 0, 0, 0, 20, 20,
  20, 30, 10, 0, 0, 10, 30, 20,
];
const TABLES = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };

const squareIndex = (square) => {
  const file = square.charCodeAt(0) - 97;       // a..h -> 0..7
  const rank = 8 - Number(square[1]);           // 8..1 -> 0..7
  return rank * 8 + file;
};

/** Score in centipawns from white's point of view. */
export function evaluateBoard(game) {
  let score = 0;
  for (const row of game.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const base = VALUE[piece.type];
      const idx = squareIndex(piece.square);
      const table = TABLES[piece.type];
      const positional = piece.color === 'w' ? table[idx] : table[63 - idx];
      score += piece.color === 'w' ? base + positional : -(base + positional);
    }
  }
  return score;
}

function search(game, depth, alpha, beta, maximising, deadline) {
  const moves = orderMoves(game);

  if (!moves.length) {
    // No legal moves: mate or stalemate. Prefer mating sooner, being mated later.
    if (game.isCheckmate()) return maximising ? -900000 - depth : 900000 + depth;
    return 0;
  }
  if (depth === 0) return evaluateBoard(game);
  if (Date.now() > deadline) throw OUT_OF_TIME;

  if (maximising) {
    let best = -Infinity;
    for (const move of moves) {
      game.move(move);
      best = Math.max(best, search(game, depth - 1, alpha, beta, false, deadline));
      game.undo();
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  }
  let best = Infinity;
  for (const move of moves) {
    game.move(move);
    best = Math.min(best, search(game, depth - 1, alpha, beta, true, deadline));
    game.undo();
    beta = Math.min(beta, best);
    if (beta <= alpha) break;
  }
  return best;
}

const OUT_OF_TIME = Symbol('out of time');

/**
 * Move ordering from the SAN string alone.
 *
 * The obvious version asks for moves({verbose:true}) and sorts on the captured
 * piece -- but that call costs 2.4ms against 0.16ms for the plain one, and in a
 * search it is called at every node. Reading "x", "+" and "=" out of the
 * notation is free and orders nearly as well.
 */
function orderMoves(game) {
  const moves = game.moves();
  return moves.sort((a, b) => sanScore(b) - sanScore(a));
}

function sanScore(san) {
  let s = 0;
  if (san.includes('x')) {
    s += 100;
    const victim = san[san.indexOf('x') + 1];
    // A capture by a pawn (lowercase file letter leads) is usually the good one.
    s += /[A-Z]/.test(san[0]) ? 0 : 20;
    if ('QR'.includes(victim?.toUpperCase?.() || '')) s += 30;
  }
  if (san.includes('#')) s += 1000;
  else if (san.includes('+')) s += 50;
  if (san.includes('=')) s += 80;
  if (san.startsWith('O-O')) s += 15;
  return s;
}

/**
 * Pick a move for whoever is to play, inside a time budget.
 *
 * Iterative deepening rather than a fixed depth: move generation in chess.js is
 * expensive enough that depth 3 from a busy middlegame took ten seconds, which
 * is not a thing you can do inside an HTTP request. Searching 1, then 2, then 3
 * and keeping the last completed result means the bot is as strong as the clock
 * allows and never blocks.
 */
export function chooseMove(fen, { budgetMs = 900, maxDepth = 4 } = {}) {
  const game = new Chess(fen);
  const moves = orderMoves(game);
  if (!moves.length) return null;
  if (moves.length === 1) return moves[0];

  const white = game.turn() === 'w';
  const deadline = Date.now() + budgetMs;
  let best = moves[0];

  for (let depth = 1; depth <= maxDepth; depth++) {
    let localBest = null;
    let localScore = white ? -Infinity : Infinity;
    try {
      for (const move of moves) {
        game.move(move);
        const value = search(game, depth - 1, -Infinity, Infinity, !white, deadline);
        game.undo();
        if (white ? value > localScore : value < localScore) {
          localScore = value;
          localBest = move;
        }
      }
    } catch (err) {
      if (err !== OUT_OF_TIME) throw err;
      break; // keep the deepest fully-searched answer
    }
    if (localBest) best = localBest;
    if (Math.abs(localScore) > 800000) break; // forced mate found
    if (Date.now() > deadline) break;
  }
  return best;
}
