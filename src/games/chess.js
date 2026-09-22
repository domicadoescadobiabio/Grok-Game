// Chess for two, with the rules handled by chess.js -- castling, en passant,
// promotion, threefold repetition and insufficient material are exactly the
// places a hand-rolled board goes quietly wrong.

import { Chess } from 'chess.js';
import { chooseMove } from './chessbot.js';
import { GameError, playerById, adjustChips, save } from '../core/players.js';
import { tableLog, setTurn } from '../core/tables.js';

const boardFor = (game, flipped) => {
  // chess.js draws from white's side; a black player should see their own men
  // at the bottom, or every move feels upside down.
  const rows = game.ascii().split('\n');
  if (!flipped) return rows.join('\n');
  const body = rows.slice(1, 9).reverse();
  const files = '     h  g  f  e  d  c  b  a';
  return [rows[0], ...body.map((r) => flipRow(r)), rows[9], files].join('\n');
};

const PIECE_NAME = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };

/**
 * "Pawn e2 to e4", "Rook a1 takes Bishop on a8".
 *
 * Algebraic notation is compact and unreadable unless you already play; the
 * board is for people who do not. The SAN is kept alongside for anyone who
 * wants it, and it is still what the move tool accepts.
 */
export function describeMove(m) {
  if (!m) return '';
  if (m.flags?.includes('k')) return 'Castles kingside (O-O)';
  if (m.flags?.includes('q')) return 'Castles queenside (O-O-O)';

  const piece = PIECE_NAME[m.piece] || 'Piece';
  let text = m.captured
    ? `${piece} ${m.from} takes ${PIECE_NAME[m.captured] || 'piece'} on ${m.to}`
    : `${piece} ${m.from} to ${m.to}`;
  if (m.promotion) text += `, promotes to ${PIECE_NAME[m.promotion]}`;
  if (m.san?.includes('#')) text += ' -- checkmate';
  else if (m.san?.includes('+')) text += ' -- check';
  return text;
}

function flipRow(row) {
  const m = row.match(/^\s*(\d)\s\|(.*)\|\s*$/);
  if (!m) return row;
  const squares = m[2].trim().split(/\s+/).reverse();
  return ` ${m[1]} | ${squares.join('  ')} |`;
}

export const chess = {
  key: 'chess',
  title: 'Chess',
  blurb: 'One on one. Moves in algebraic notation: e4, Nf3, O-O, e8=Q.',
  minSeats: 2,
  maxSeats: 2,
  defaultStake: 100,
  turnSeconds: 60,
  actionHelp: 'move <notation>, resign, draw',
  // You may resign, or accept a draw, on your opponent's clock.
  anytimeActions: ['resign', 'draw'],

  start(table) {
    if (table.seats.length !== 2) {
      throw new GameError('Chess needs exactly two players.', 'need_two');
    }
    const [a, b] = table.seats.map((s) => playerById(s.playerId));
    if (!a || !b) throw new GameError('A seat is empty.', 'empty_seat');
    for (const p of [a, b]) {
      if (p.chips < table.stake) {
        throw new GameError(`@${p.username} needs ${table.stake} chips to play and has ${p.chips}.`, 'poor');
      }
    }
    for (const p of [a, b]) adjustChips(p, -table.stake, 'chess stake');

    // Colours alternate per game so nobody keeps the white advantage.
    const whiteFirst = table.round % 2 === 0;
    const white = whiteFirst ? a : b;
    const black = whiteFirst ? b : a;

    const game = new Chess();
    table.state = {
      fen: game.fen(),
      white: white.id,
      black: black.id,
      pot: table.stake * 2,
      drawOfferedBy: null,
      moves: [],
      history: [],
    };
    table.status = 'playing';
    table.round += 1;
    setTurn(table, white.id);
    tableLog(table, `--- Game ${table.round} --- @${white.username} (white) vs @${black.username} (black)`);
    return { events: [`@${white.username} plays white and moves first. Pot: ${table.state.pot}.`] };
  },

  act(table, player, action, args = {}) {
    const st = table.state;
    const verb = String(action || '').toLowerCase();

    if (verb === 'resign') {
      const winner = playerById(st.white === player.id ? st.black : st.white);
      tableLog(table, `@${player.username} resigns.`);
      return finish(table, winner, `@${player.username} resigns.`);
    }

    if (verb === 'draw') {
      if (st.drawOfferedBy && st.drawOfferedBy !== player.id) {
        return finish(table, null, 'Draw agreed.');
      }
      st.drawOfferedBy = player.id;
      save();
      const other = playerById(st.white === player.id ? st.black : st.white);
      tableLog(table, `@${player.username} offers a draw.`);
      return { events: [`Draw offered. @${other.username} can accept by also playing "draw".`] };
    }

    if (verb !== 'move') {
      throw new GameError(`Unknown action "${action}". At chess you can move, resign or draw.`, 'bad_action');
    }

    const notation = String(args.move || args.notation || '').trim();
    if (!notation) throw new GameError('Which move? For example: e4, Nf3, O-O, exd5, e8=Q.', 'bad_move');

    const game = new Chess(st.fen);
    let result;
    try {
      result = game.move(notation);
    } catch {
      result = null;
    }
    if (!result) {
      const legal = game.moves();
      throw new GameError(
        `"${notation}" is not legal here. Legal moves: ${legal.slice(0, 18).join(', ')}${legal.length > 18 ? ` (+${legal.length - 18} more)` : ''}.`,
        'illegal_move',
      );
    }

    st.fen = game.fen();
    const described = describeMove(result);
    st.moves.push(result.san);
    (st.history ||= []).push({
      n: Math.floor(st.moves.length / 2) + (st.moves.length % 2),
      color: result.color,
      san: result.san,
      from: result.from,
      to: result.to,
      text: described,
    });
    st.drawOfferedBy = null; // a move withdraws any outstanding offer
    tableLog(table, `@${player.username}: ${described}`);

    const events = [`${described}  (${result.san})`];

    if (game.isCheckmate()) {
      events.push('Checkmate.');
      return finish(table, player, `@${player.username} wins by checkmate (${result.san}).`, events);
    }
    if (game.isStalemate()) return finish(table, null, 'Stalemate -- drawn.', events);
    if (game.isInsufficientMaterial()) return finish(table, null, 'Insufficient material -- drawn.', events);
    if (game.isThreefoldRepetition()) return finish(table, null, 'Threefold repetition -- drawn.', events);
    if (game.isDraw()) return finish(table, null, 'Drawn.', events);

    if (game.isCheck()) events.push('Check.');
    const opponent = st.white === player.id ? st.black : st.white;
    setTurn(table, opponent);
    save();
    return { events };
  },

  onTimeout(table) {
    const loser = playerById(table.turn);
    const st = table.state;
    const winner = playerById(st.white === table.turn ? st.black : st.white);
    tableLog(table, `@${loser?.username || 'a player'} ran out of time.`);
    return finish(table, winner, `@${loser?.username || 'A player'} ran out of time. @${winner?.username} wins.`);
  },

  view(table, player) {
    const st = table.state;
    if (!st || !st.fen) return 'No game in progress. Both players seated? Start one.';
    const game = new Chess(st.fen);
    const isBlack = st.black === player.id;
    const white = playerById(st.white);
    const black = playerById(st.black);

    const lines = [
      boardFor(game, isBlack),
      '',
      `White: @${white?.username}   Black: @${black?.username}   Pot: ${st.pot}`,
    ];
    if (table.status === 'playing') {
      const toMove = playerById(table.turn);
      lines.push(`To move: @${toMove?.username} (${game.turn() === 'w' ? 'white' : 'black'})${game.isCheck() ? ' -- in check' : ''}`);
      if (table.turn === player.id) {
        const legal = game.moves();
        lines.push(`Your legal moves: ${legal.slice(0, 20).join(', ')}${legal.length > 20 ? ` (+${legal.length - 20} more)` : ''}`);
      }
      if (st.drawOfferedBy && st.drawOfferedBy !== player.id) lines.push('A draw has been offered to you.');
    }
    const history = st.history || [];
    if (history.length) {
      lines.push('', 'Moves:');
      for (const h of history.slice(-6)) {
        lines.push(`  ${h.n}. ${h.color === 'w' ? 'White' : 'Black'}: ${h.text}`);
      }
    }
    return lines.join('\n');
  },
};

function finish(table, winner, headline, events = []) {
  const st = table.state;
  const white = playerById(st.white);
  const black = playerById(st.black);
  for (const p of [white, black]) if (p) p.stats.handsPlayed += 1;

  st.winner = winner ? winner.username : null;
  st.outcome = headline;
  if (winner) {
    adjustChips(winner, st.pot, 'chess pot');
    winner.stats.wins += 1;
    const loser = winner.id === white?.id ? black : white;
    if (loser) loser.stats.losses += 1;
    if (st.pot > (winner.stats.biggestPot || 0)) winner.stats.biggestPot = st.pot;
    events.push(`${headline} Pot of ${st.pot} to @${winner.username} (now ${winner.chips}).`);
  } else {
    const half = Math.floor(st.pot / 2);
    if (white) adjustChips(white, half, 'chess draw');
    if (black) adjustChips(black, st.pot - half, 'chess draw');
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

// ---------------------------------------------------------------- the bot

chess.botAction = function botAction(table, player) {
  const st = table.state;
  if (!st?.fen) return null;
  // Accept a draw when the position is genuinely level and the game is long.
  const move = chooseMove(st.fen, { budgetMs: 900 });
  if (!move) return null;
  return { action: 'move', args: { move } };
};

chess.botFallback = function botFallback(table) {
  const game = new Chess(table.state.fen);
  const legal = game.moves();
  return legal.length ? { action: 'move', args: { move: legal[0] } } : { action: 'resign' };
};

chess.snapshot = function snapshot(table, player) {
  const st = table.state;
  if (!st?.fen) return { phase: 'idle' };
  const game = new Chess(st.fen);
  const isBlack = st.black === player.id;
  const white = playerById(st.white);
  const black = playerById(st.black);
  const myTurn = table.turn === player.id;
  return {
    phase: 'playing',
    fen: st.fen,
    // Rows from rank 8 down, each with 8 squares; the client flips for black.
    board: game.board().map((row) => row.map((sq) => (sq ? { type: sq.type, color: sq.color, square: sq.square } : null))),
    youAre: isBlack ? 'b' : 'w',
    turnColor: game.turn(),
    inCheck: game.isCheck(),
    // Verbose only for the player to move: it is the expensive call.
    legal: myTurn ? game.moves({ verbose: true }).map((m) => ({ from: m.from, to: m.to, san: m.san, promotion: m.promotion || null })) : [],
    lastMove: st.history?.length ? st.history[st.history.length - 1] : null,
    moves: st.moves,
    history: st.history || [],
    pot: st.pot,
    drawOfferedToYou: Boolean(st.drawOfferedBy && st.drawOfferedBy !== player.id),
    winner: st.winner || null,
    outcome: st.outcome || null,
    players: {
      w: { username: white?.username, isYou: !isBlack, isBot: Boolean(white?.isBot) },
      b: { username: black?.username, isYou: isBlack, isBot: Boolean(black?.isBot) },
    },
  };
};
