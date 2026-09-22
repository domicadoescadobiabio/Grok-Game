// Checkers (draughts) on an 8x8 board, with the two rules people actually
// play by: capturing is compulsory, and a king slides any distance along a
// diagonal.
//
// Squares are named like chess -- a1 to h8 -- so a move reads "c3 to d4" and a
// capture reads "c3 takes e5". Only the dark squares are used.

import { GameError, playerById, adjustChips, save } from '../core/players.js';
import { tableLog, setTurn } from '../core/tables.js';

const SIZE = 8;
const DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

// A board is 64 entries, null or { colour: 'w'|'b', king: bool }.
export const idx = (file, rank) => rank * SIZE + file;
export const nameOf = (file, rank) => String.fromCharCode(97 + file) + (rank + 1);
export function parseSquare(text) {
  const m = String(text || '').trim().toLowerCase().match(/^([a-h])([1-8])$/);
  if (!m) return null;
  return { file: m[1].charCodeAt(0) - 97, rank: Number(m[2]) - 1 };
}

export function startingBoard() {
  const board = new Array(SIZE * SIZE).fill(null);
  for (let rank = 0; rank < SIZE; rank++) {
    for (let file = 0; file < SIZE; file++) {
      if ((file + rank) % 2 !== 0) continue;       // dark squares only
      if (rank < 3) board[idx(file, rank)] = { colour: 'w', king: false };
      else if (rank > 4) board[idx(file, rank)] = { colour: 'b', king: false };
    }
  }
  return board;
}

const inside = (f, r) => f >= 0 && f < SIZE && r >= 0 && r < SIZE;
const other = (c) => (c === 'w' ? 'b' : 'w');

/**
 * Every legal move for a colour.
 *
 * Captures are compulsory, so if any exist the quiet moves are dropped
 * entirely -- a player who could take and did not has made an illegal move,
 * not a bad one.
 */
export function legalMoves(board, colour) {
  const captures = [];
  const quiet = [];

  for (let r = 0; r < SIZE; r++) {
    for (let f = 0; f < SIZE; f++) {
      const piece = board[idx(f, r)];
      if (!piece || piece.colour !== colour) continue;
      collectCaptures(board, f, r, piece, [], captures);
      if (!piece.king) {
        const forward = colour === 'w' ? 1 : -1;
        for (const df of [-1, 1]) {
          const nf = f + df;
          const nr = r + forward;
          if (inside(nf, nr) && !board[idx(nf, nr)]) {
            quiet.push({ from: nameOf(f, r), to: nameOf(nf, nr), captures: [], path: [nameOf(nf, nr)] });
          }
        }
      } else {
        for (const [df, dr] of DIRS) {
          let nf = f + df;
          let nr = r + dr;
          while (inside(nf, nr) && !board[idx(nf, nr)]) {
            quiet.push({ from: nameOf(f, r), to: nameOf(nf, nr), captures: [], path: [nameOf(nf, nr)] });
            nf += df;
            nr += dr;
          }
        }
      }
    }
  }

  if (!captures.length) return quiet;
  // Among captures, taking the most pieces is also compulsory in most rule
  // sets, and it removes a whole class of "why did it not take three?".
  const most = Math.max(...captures.map((m) => m.captures.length));
  return captures.filter((m) => m.captures.length === most);
}

function collectCaptures(board, f, r, piece, taken, out, startName) {
  const from = startName || nameOf(f, r);
  let found = false;

  for (const [df, dr] of DIRS) {
    if (piece.king) {
      let cf = f + df;
      let cr = r + dr;
      while (inside(cf, cr) && !board[idx(cf, cr)]) { cf += df; cr += dr; }
      if (!inside(cf, cr)) continue;
      const victim = board[idx(cf, cr)];
      if (!victim || victim.colour === piece.colour || taken.includes(nameOf(cf, cr))) continue;
      let lf = cf + df;
      let lr = cr + dr;
      while (inside(lf, lr) && !board[idx(lf, lr)]) {
        found = true;
        step(board, f, r, lf, lr, piece, [...taken, nameOf(cf, cr)], out, from);
        lf += df;
        lr += dr;
      }
    } else {
      const cf = f + df;
      const cr = r + dr;
      const lf = f + df * 2;
      const lr = r + dr * 2;
      if (!inside(lf, lr)) continue;
      const victim = board[idx(cf, cr)];
      if (!victim || victim.colour === piece.colour || taken.includes(nameOf(cf, cr))) continue;
      if (board[idx(lf, lr)]) continue;
      found = true;
      step(board, f, r, lf, lr, piece, [...taken, nameOf(cf, cr)], out, from);
    }
  }

  // A jump that cannot continue is itself a complete move.
  if (!found && taken.length) {
    out.push({ from, to: nameOf(f, r), captures: [...taken], path: [nameOf(f, r)] });
  }
}

// Try one jump, then look for more from where we land.
function step(board, f, r, lf, lr, piece, taken, out, from) {
  const copy = [...board];
  copy[idx(f, r)] = null;
  for (const t of taken) {
    const sq = parseSquare(t);
    copy[idx(sq.file, sq.rank)] = null;
  }
  const crowned = piece.king || (piece.colour === 'w' ? lr === SIZE - 1 : lr === 0);
  copy[idx(lf, lr)] = { colour: piece.colour, king: crowned };

  const deeper = [];
  // A man that crowns mid-jump stops there in these rules; a king keeps going.
  if (!(crowned && !piece.king)) {
    collectCaptures(copy, lf, lr, copy[idx(lf, lr)], taken, deeper, from);
  }
  if (deeper.length) out.push(...deeper);
  else out.push({ from, to: nameOf(lf, lr), captures: [...taken], path: [nameOf(lf, lr)] });
}

export function applyMove(board, move) {
  const next = [...board];
  const from = parseSquare(move.from);
  const to = parseSquare(move.to);
  const piece = next[idx(from.file, from.rank)];
  next[idx(from.file, from.rank)] = null;
  for (const t of move.captures) {
    const sq = parseSquare(t);
    next[idx(sq.file, sq.rank)] = null;
  }
  const crowned = piece.king || (piece.colour === 'w' ? to.rank === SIZE - 1 : to.rank === 0);
  next[idx(to.file, to.rank)] = { colour: piece.colour, king: crowned };
  return { board: next, crowned: crowned && !piece.king };
}

export const countPieces = (board, colour) =>
  board.reduce((n, sq) => n + (sq && sq.colour === colour ? 1 : 0), 0);

export function describeMove(move) {
  if (!move.captures.length) return `${move.from} to ${move.to}`;
  return `${move.from} takes ${move.captures.join(' and ')}, landing on ${move.to}`;
}

export function boardText(board, flipped) {
  const rows = [];
  const ranks = flipped ? [...Array(SIZE).keys()] : [...Array(SIZE).keys()].reverse();
  const files = flipped ? [...Array(SIZE).keys()].reverse() : [...Array(SIZE).keys()];
  for (const r of ranks) {
    let line = `${r + 1} |`;
    for (const f of files) {
      const sq = board[idx(f, r)];
      const ch = !sq ? ((f + r) % 2 === 0 ? '.' : ' ')
        : sq.colour === 'w' ? (sq.king ? 'W' : 'w')
        : (sq.king ? 'B' : 'b');
      line += ` ${ch}`;
    }
    rows.push(`${line} |`);
  }
  rows.push(`   ${files.map((f) => String.fromCharCode(97 + f)).join(' ')}`);
  return rows.join('\n');
}

// ---------------------------------------------------------------- the bot

const pieceValue = (sq) => (sq.king ? 3.2 : 1) + (sq.colour === 'w' ? 0 : 0);

function evaluateBoard(board) {
  let score = 0;
  for (let r = 0; r < SIZE; r++) {
    for (let f = 0; f < SIZE; f++) {
      const sq = board[idx(f, r)];
      if (!sq) continue;
      // Advancing matters, and the back row is worth holding early.
      const advance = sq.king ? 0 : (sq.colour === 'w' ? r : SIZE - 1 - r) * 0.06;
      const value = pieceValue(sq) + advance;
      score += sq.colour === 'w' ? value : -value;
    }
  }
  return score;
}

function search(board, colour, depth, alpha, beta, maximising) {
  const moves = legalMoves(board, colour);
  if (!moves.length) return maximising ? -1000 : 1000;   // no move = lost
  if (depth === 0) return evaluateBoard(board);

  if (maximising) {
    let best = -Infinity;
    for (const m of moves) {
      best = Math.max(best, search(applyMove(board, m).board, other(colour), depth - 1, alpha, beta, false));
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  }
  let best = Infinity;
  for (const m of moves) {
    best = Math.min(best, search(applyMove(board, m).board, other(colour), depth - 1, alpha, beta, true));
    beta = Math.min(beta, best);
    if (beta <= alpha) break;
  }
  return best;
}

export function chooseMove(board, colour, depth = 5) {
  const moves = legalMoves(board, colour);
  if (!moves.length) return null;
  if (moves.length === 1) return moves[0];

  const white = colour === 'w';
  let best = moves[0];
  let bestScore = white ? -Infinity : Infinity;
  for (const m of moves) {
    const value = search(applyMove(board, m).board, other(colour), depth - 1, -Infinity, Infinity, !white);
    if (white ? value > bestScore : value < bestScore) {
      bestScore = value;
      best = m;
    }
  }
  return best;
}

// ---------------------------------------------------------------- the game

export const checkers = {
  key: 'checkers',
  title: 'Checkers',
  blurb: 'Eight by eight. Capturing is compulsory, and kings fly.',
  minSeats: 2,
  maxSeats: 2,
  defaultStake: 75,
  turnSeconds: 60,
  actionHelp: 'move <from> <to> (e.g. move c3 d4), resign',
  anytimeActions: ['resign'],

  start(table) {
    if (table.seats.length !== 2) throw new GameError('Checkers needs exactly two players.', 'need_two');
    const [a, b] = table.seats.map((s) => playerById(s.playerId));
    for (const p of [a, b]) {
      if (p.chips < table.stake) {
        throw new GameError(`@${p.username} needs ${table.stake} chips and has ${p.chips}.`, 'poor');
      }
    }
    for (const p of [a, b]) adjustChips(p, -table.stake, 'checkers stake');

    const whiteFirst = table.round % 2 === 0;
    const white = whiteFirst ? a : b;
    const black = whiteFirst ? b : a;

    table.state = {
      board: startingBoard(),
      white: white.id,
      black: black.id,
      turnColour: 'w',
      pot: table.stake * 2,
      history: [],
    };
    table.status = 'playing';
    table.round += 1;
    setTurn(table, white.id);
    tableLog(table, `--- Game ${table.round} --- @${white.username} (white) vs @${black.username} (black)`);
    return { events: [`@${white.username} has white and moves first. Pot: ${table.state.pot}.`] };
  },

  act(table, player, action, args = {}) {
    const st = table.state;
    const verb = String(action || '').toLowerCase();

    if (verb === 'resign') {
      const winner = playerById(st.white === player.id ? st.black : st.white);
      return finish(table, winner, `@${player.username} resigns.`);
    }
    if (verb !== 'move') {
      throw new GameError(`Unknown action "${action}". You can move or resign.`, 'bad_action');
    }

    const colour = st.white === player.id ? 'w' : 'b';
    const from = String(args.from || '').toLowerCase();
    const to = String(args.to || args.move || '').toLowerCase();
    if (!parseSquare(from) || !parseSquare(to)) {
      throw new GameError('Give two squares, like: move c3 d4.', 'bad_move');
    }

    const moves = legalMoves(st.board, colour);
    const chosen = moves.find((m) => m.from === from && m.to === to);
    if (!chosen) {
      const mustCapture = moves.length && moves[0].captures.length;
      throw new GameError(
        `${from} to ${to} is not legal.${mustCapture ? ' Capturing is compulsory here.' : ''} ` +
        `Legal: ${moves.slice(0, 10).map(describeMove).join('; ')}${moves.length > 10 ? ' ...' : ''}`,
        'illegal_move',
      );
    }

    const result = applyMove(st.board, chosen);
    st.board = result.board;
    st.history.push({ colour, text: describeMove(chosen) + (result.crowned ? ', and is crowned' : '') });
    tableLog(table, `@${player.username}: ${describeMove(chosen)}${result.crowned ? ' (crowned)' : ''}`);

    const events = [describeMove(chosen) + (result.crowned ? ' -- crowned.' : '.')];
    if (chosen.captures.length > 1) events.push(`Took ${chosen.captures.length} pieces.`);

    const opponentColour = other(colour);
    const opponentMoves = legalMoves(st.board, opponentColour);
    if (!opponentMoves.length || !countPieces(st.board, opponentColour)) {
      return finish(table, player, `@${player.username} wins -- no moves left for the other side.`, events);
    }

    st.turnColour = opponentColour;
    setTurn(table, opponentColour === 'w' ? st.white : st.black);
    save();
    return { events };
  },

  onTimeout(table) {
    const st = table.state;
    const loser = playerById(table.turn);
    const winner = playerById(st.white === table.turn ? st.black : st.white);
    return finish(table, winner, `@${loser?.username} ran out of time.`);
  },

  view(table, player) {
    const st = table.state;
    if (!st?.board) return 'No game in progress.';
    const isBlack = st.black === player.id;
    const white = playerById(st.white);
    const black = playerById(st.black);
    const lines = [
      boardText(st.board, isBlack),
      '',
      `lowercase = man, uppercase = king   w/W white, b/B black`,
      `White: @${white?.username} (${countPieces(st.board, 'w')})   Black: @${black?.username} (${countPieces(st.board, 'b')})   Pot: ${st.pot}`,
    ];
    if (table.status === 'playing' && table.turn === player.id) {
      const moves = legalMoves(st.board, isBlack ? 'b' : 'w');
      lines.push(moves.length && moves[0].captures.length ? 'You must capture.' : 'Your move.');
      lines.push(`Legal: ${moves.slice(0, 8).map(describeMove).join('; ')}${moves.length > 8 ? ` (+${moves.length - 8} more)` : ''}`);
    }
    if (st.history.length) {
      lines.push('', 'Recent:');
      for (const h of st.history.slice(-5)) lines.push(`  ${h.colour === 'w' ? 'White' : 'Black'}: ${h.text}`);
    }
    return lines.join('\n');
  },

  snapshot(table, player) {
    const st = table.state;
    if (!st?.board) return { phase: 'idle' };
    const isBlack = st.black === player.id;
    const white = playerById(st.white);
    const black = playerById(st.black);
    return {
      phase: 'playing',
      board: st.board,
      youAre: isBlack ? 'b' : 'w',
      turnColour: st.turnColour,
      legal: table.turn === player.id ? legalMoves(st.board, isBlack ? 'b' : 'w') : [],
      counts: { w: countPieces(st.board, 'w'), b: countPieces(st.board, 'b') },
      history: st.history,
      pot: st.pot,
      winner: st.winner || null,
      outcome: st.outcome || null,
      players: {
        w: { username: white?.username, isYou: !isBlack, isBot: Boolean(white?.isBot) },
        b: { username: black?.username, isYou: isBlack, isBot: Boolean(black?.isBot) },
      },
    };
  },

  botAction(table, player) {
    const st = table.state;
    const colour = st.white === player.id ? 'w' : 'b';
    const move = chooseMove(st.board, colour, 5);
    if (!move) return null;
    return { action: 'move', args: { from: move.from, to: move.to } };
  },

  botFallback(table, player) {
    const st = table.state;
    const colour = st.white === player.id ? 'w' : 'b';
    const moves = legalMoves(st.board, colour);
    return moves.length
      ? { action: 'move', args: { from: moves[0].from, to: moves[0].to } }
      : { action: 'resign' };
  },
};

function finish(table, winner, headline, events = []) {
  const st = table.state;
  const white = playerById(st.white);
  const black = playerById(st.black);
  st.winner = winner ? winner.username : null;
  st.outcome = headline;
  for (const p of [white, black]) if (p) p.stats.handsPlayed += 1;

  if (winner) {
    adjustChips(winner, st.pot, 'checkers pot');
    winner.stats.wins += 1;
    const loser = winner.id === white?.id ? black : white;
    if (loser) loser.stats.losses += 1;
    if (st.pot > (winner.stats.biggestPot || 0)) winner.stats.biggestPot = st.pot;
    events.push(`${headline} Pot of ${st.pot} to @${winner.username} (now ${winner.chips}).`);
  } else {
    const half = Math.floor(st.pot / 2);
    if (white) adjustChips(white, half, 'checkers draw');
    if (black) adjustChips(black, st.pot - half, 'checkers draw');
    events.push(`${headline} Pot split.`);
  }

  tableLog(table, headline);
  table.status = 'finished';
  table.turn = null;
  table.lastActionAt = Date.now();
  save();
  events.push('Game over. Start another when you are ready.');
  return { events };
}
