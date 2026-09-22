// Dominoes, block rules: a double-six set, seven tiles each, and no boneyard --
// if you cannot play, you pass.
//
// Ending a hand: go out first and you collect the pips still in everyone's
// hands. If every player passes in a row the hand is blocked, and the lightest
// hand collects the difference instead.

import { GameError, playerById, adjustChips, save } from '../core/players.js';
import { tableLog, setTurn, nextSeat } from '../core/tables.js';
import { randomBytes } from 'node:crypto';

export const tileText = (t) => `${t[0]}-${t[1]}`;
export const pips = (t) => t[0] + t[1];
const isDouble = (t) => t[0] === t[1];
const handPips = (tiles) => tiles.reduce((s, t) => s + pips(t), 0);

export function fullSet() {
  const set = [];
  for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) set.push([a, b]);
  return set; // 28 tiles
}

function shuffled(tiles) {
  const out = [...tiles];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32BE(0) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** "6-3", "63", "6 3" -> [6,3]. Returns null if it is not a tile. */
export function parseTile(input) {
  const text = String(input || '').trim();
  const m = text.match(/^(\d)\s*[-:/ ]?\s*(\d)$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a > 6 || b > 6) return null;
  return [a, b];
}

const sameTile = (x, y) => (x[0] === y[0] && x[1] === y[1]) || (x[0] === y[1] && x[1] === y[0]);

export const canPlay = (tile, ends) =>
  ends === null || tile.includes(ends[0]) || tile.includes(ends[1]);

export const boardText = (board) =>
  board.length ? board.map(tileText).join(' ') : '(empty)';

export const domino = {
  key: 'domino',
  title: 'Dominoes',
  blurb: 'Double-six set, seven tiles each. Match an end or pass.',
  minSeats: 2,
  maxSeats: 4,
  defaultStake: 25,
  turnSeconds: 30,
  actionHelp: 'play <tile> [left|right], pass',

  start(table) {
    const players = table.seats
      .map((s) => playerById(s.playerId))
      .filter((p) => p && p.chips > 0);
    if (players.length < 2) throw new GameError('Dominoes needs at least two players.', 'need_two');

    const tiles = shuffled(fullSet());
    const hands = {};
    players.forEach((p, i) => { hands[p.id] = tiles.slice(i * 7, i * 7 + 7); });

    const st = {
      hands,
      order: players.map((p) => p.id),
      board: [],
      ends: null,     // [left, right]
      passes: 0,
      blocked: false,
    };
    table.state = st;
    table.status = 'playing';
    table.round += 1;

    // Opener: highest double, or failing that the heaviest tile.
    let opener = st.order[0];
    let best = -1;
    for (const id of st.order) {
      for (const t of hands[id]) {
        const weight = (isDouble(t) ? 100 : 0) + pips(t);
        if (weight > best) { best = weight; opener = id; }
      }
    }

    tableLog(table, `--- Hand ${table.round} --- ${players.length} players, ${table.stake} a pip-point`);
    setTurn(table, opener);
    return { events: [`Seven tiles each. @${playerById(opener)?.username} opens.`] };
  },

  act(table, player, action, args = {}) {
    const st = table.state;
    const hand = st.hands[player.id];
    if (!hand) throw new GameError('You are not in this hand.', 'not_dealt');
    const verb = String(action || '').toLowerCase();
    const events = [];

    if (verb === 'pass') {
      if (hand.some((t) => canPlay(t, st.ends))) {
        const playable = hand.filter((t) => canPlay(t, st.ends)).map(tileText).join(', ');
        throw new GameError(`You can still play: ${playable}. You may only pass when stuck.`, 'can_play');
      }
      st.passes += 1;
      events.push('You pass.');
      tableLog(table, `@${player.username} passes.`);
    } else if (verb === 'play') {
      const tile = parseTile(args.tile);
      if (!tile) throw new GameError('Which tile? Say it like "6-3".', 'bad_tile');
      const held = hand.find((t) => sameTile(t, tile));
      if (!held) throw new GameError(`You do not hold ${tileText(tile)}.`, 'not_your_tile');

      if (st.ends === null) {
        st.board.push([...held]);
        st.ends = [held[0], held[1]];
      } else {
        const side = pickSide(held, st.ends, args.end);
        if (!side) {
          throw new GameError(
            `${tileText(held)} does not match either end (${st.ends[0]} or ${st.ends[1]}).`,
            'no_match',
          );
        }
        if (side === 'left') {
          // The matching half goes against the board, so the outer half becomes
          // the new end -- getting this backwards silently corrupts the line.
          const oriented = held[1] === st.ends[0] ? [held[0], held[1]] : [held[1], held[0]];
          st.board.unshift(oriented);
          st.ends[0] = oriented[0];
        } else {
          const oriented = held[0] === st.ends[1] ? [held[0], held[1]] : [held[1], held[0]];
          st.board.push(oriented);
          st.ends[1] = oriented[1];
        }
      }

      st.hands[player.id] = hand.filter((t) => !sameTile(t, held));
      st.passes = 0;
      events.push(`You play ${tileText(held)}. Board ends: ${st.ends[0]} and ${st.ends[1]}.`);
      tableLog(table, `@${player.username} plays ${tileText(held)}`);

      if (!st.hands[player.id].length) {
        return { events: [...events, ...finish(table, player.id, false).events] };
      }
    } else {
      throw new GameError(`Unknown action "${action}". You can play a tile or pass.`, 'bad_action');
    }

    save();

    // Everyone passing in a row means nobody can move: the hand is blocked.
    if (st.passes >= st.order.length) {
      return { events: [...events, ...finish(table, null, true).events] };
    }

    const next = nextSeat(table, player.id, (s) => Boolean(st.hands[s.playerId]));
    setTurn(table, next.playerId);
    return { events };
  },

  onTimeout(table) {
    const id = table.turn;
    const p = playerById(id);
    const st = table.state;
    const hand = st.hands[id] || [];
    const playable = hand.filter((t) => canPlay(t, st.ends));
    // Time out into the cheapest legal move: the heaviest playable tile, or a
    // pass when there is nothing.
    if (playable.length) {
      const pick = playable.sort((a, b) => pips(b) - pips(a))[0];
      tableLog(table, `@${p?.username} timed out; the house played ${tileText(pick)}.`);
      return this.act(table, p, 'play', { tile: tileText(pick) });
    }
    tableLog(table, `@${p?.username} timed out and passes.`);
    return this.act(table, p, 'pass');
  },

  view(table, player) {
    const st = table.state;
    if (!st?.hands) return 'No hand in progress. Anyone at the table can deal.';
    const hand = st.hands[player.id] || [];
    const lines = [
      `Board: ${boardText(st.board)}`,
      st.ends ? `Open ends: ${st.ends[0]} and ${st.ends[1]}` : 'Board is empty -- play anything.',
      '',
      `Your tiles: ${hand.map(tileText).join('  ') || '(none)'}`,
    ];
    if (table.turn === player.id) {
      const playable = hand.filter((t) => canPlay(t, st.ends));
      lines.push(playable.length
        ? `You can play: ${playable.map(tileText).join(', ')}`
        : 'Nothing matches -- you must pass.');
    }
    lines.push('');
    for (const id of st.order) {
      const who = playerById(id);
      const n = (st.hands[id] || []).length;
      lines.push(`@${who?.username}${id === player.id ? ' (you)' : ''}: ${n} tile${n === 1 ? '' : 's'}${table.turn === id ? ' <- to play' : ''}`);
    }
    return lines.join('\n');
  },

  snapshot(table, player) {
    const st = table.state;
    if (!st?.hands) return { phase: 'idle' };
    const hand = st.hands[player.id] || [];
    return {
      phase: st.blocked ? 'blocked' : 'playing',
      board: st.board,
      ends: st.ends,
      myTiles: hand,
      playable: table.turn === player.id ? hand.filter((t) => canPlay(t, st.ends)) : [],
      winners: st.winners || [],
      seats: st.order.map((id) => {
        const account = playerById(id);
        return {
          username: account?.username,
          isYou: id === player.id,
          isBot: Boolean(account?.isBot),
          isTurn: table.turn === id,
          stack: account?.chips ?? 0,
          tiles: (st.hands[id] || []).length,
          pips: table.status === 'finished' ? handPips(st.hands[id] || []) : null,
        };
      }),
    };
  },

  botAction(table, player) {
    const st = table.state;
    const hand = st.hands[player.id] || [];
    const playable = hand.filter((t) => canPlay(t, st.ends));
    if (!playable.length) return { action: 'pass' };
    // Shed weight early: heavy tiles are what you get stuck holding.
    const pick = [...playable].sort((a, b) => pips(b) - pips(a))[0];
    return { action: 'play', args: { tile: tileText(pick) } };
  },

  botFallback() {
    return { action: 'pass' };
  },
};

function pickSide(tile, ends, preferred) {
  const fitsLeft = tile.includes(ends[0]);
  const fitsRight = tile.includes(ends[1]);
  const want = String(preferred || '').toLowerCase();
  if (want === 'left' && fitsLeft) return 'left';
  if (want === 'right' && fitsRight) return 'right';
  if (fitsLeft) return 'left';
  if (fitsRight) return 'right';
  return null;
}

function finish(table, winnerId, blocked) {
  const st = table.state;
  st.blocked = blocked;
  const events = [];

  let winner = winnerId;
  if (blocked) {
    // Lightest hand takes it; a tie on pips is a wash.
    let best = Infinity;
    let tied = false;
    for (const id of st.order) {
      const total = handPips(st.hands[id]);
      if (total < best) { best = total; winner = id; tied = false; }
      else if (total === best) tied = true;
    }
    events.push('Blocked -- nobody can play.');
    if (tied) winner = null;
  }

  st.winners = [];
  if (winner) {
    const pot = st.order
      .filter((id) => id !== winner)
      .reduce((sum, id) => sum + handPips(st.hands[id]), 0);
    const prize = pot * table.stake;
    const w = playerById(winner);

    for (const id of st.order) {
      const p = playerById(id);
      if (!p) continue;
      p.stats.handsPlayed += 1;
      if (id === winner) continue;
      const loss = handPips(st.hands[id]) * table.stake;
      adjustChips(p, -loss, 'dominoes');
      p.stats.losses += 1;
      events.push(`@${p.username} holds ${handPips(st.hands[id])} pips: -${loss}`);
    }
    if (w) {
      adjustChips(w, prize, 'dominoes');
      w.stats.wins += 1;
      if (prize > (w.stats.biggestPot || 0)) w.stats.biggestPot = prize;
      st.winners.push({ username: w.username, amount: prize });
      events.push(`@${w.username} ${blocked ? 'has the lightest hand' : 'goes out'} and takes ${prize}. (${w.chips})`);
      tableLog(table, `@${w.username} wins ${prize}`);
    }
  } else {
    events.push('Tied on pips -- no chips change hands.');
    for (const id of st.order) {
      const p = playerById(id);
      if (p) p.stats.handsPlayed += 1;
    }
  }

  table.status = 'finished';
  table.turn = null;
  table.lastActionAt = Date.now();
  save();
  events.push('Hand over. Deal again when you are ready.');
  return { events };
}
