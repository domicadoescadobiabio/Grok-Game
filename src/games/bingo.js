// Bingo, played in turns.
//
// Everyone buys a 5x5 card, then players take turns calling the next number --
// the turn order is the chess-like part: it goes round the table rather than a
// caller shouting at a room. Numbers mark themselves on every card, and the
// first completed line wins the pot. A second line in the same call splits it.
//
// There is no decision to make here, which is the point: it is the fast game
// between the slow ones.

import { randomBytes } from 'node:crypto';
import { GameError, playerById, adjustChips, save } from '../core/players.js';
import { tableLog, setTurn, nextSeat } from '../core/tables.js';

export const COLUMNS = ['B', 'I', 'N', 'G', 'O'];
const RANGE = 15; // B is 1-15, I is 16-30, and so on

const randInt = (n) => randomBytes(4).readUInt32BE(0) % n;

/** A standard card: five columns of five, with the middle square free. */
export function makeCard() {
  const grid = [];
  for (let col = 0; col < 5; col++) {
    const low = col * RANGE + 1;
    const pool = Array.from({ length: RANGE }, (_, i) => low + i);
    const column = [];
    for (let row = 0; row < 5; row++) column.push(pool.splice(randInt(pool.length), 1)[0]);
    grid.push(column);
  }
  grid[2][2] = 0; // free square
  return grid;
}

export const columnOf = (n) => COLUMNS[Math.floor((n - 1) / RANGE)];
export const callText = (n) => `${columnOf(n)}-${n}`;

/** Which numbers on a card have been called (the free square always counts). */
export function marksFor(card, called) {
  const set = new Set(called);
  return card.map((column) => column.map((n) => n === 0 || set.has(n)));
}

/** The name of a completed line, or null. */
export function findLine(card, called) {
  const m = marksFor(card, called);
  for (let row = 0; row < 5; row++) {
    if ([0, 1, 2, 3, 4].every((col) => m[col][row])) return `row ${row + 1}`;
  }
  for (let col = 0; col < 5; col++) {
    if (m[col].every(Boolean)) return `column ${COLUMNS[col]}`;
  }
  if ([0, 1, 2, 3, 4].every((i) => m[i][i])) return 'diagonal';
  if ([0, 1, 2, 3, 4].every((i) => m[i][4 - i])) return 'diagonal';
  return null;
}

export function cardText(card, called) {
  const m = marksFor(card, called);
  const lines = [COLUMNS.join('   ')];
  for (let row = 0; row < 5; row++) {
    const cells = [];
    for (let col = 0; col < 5; col++) {
      const n = card[col][row];
      const label = n === 0 ? 'FREE' : String(n).padStart(2, ' ');
      cells.push(m[col][row] ? `[${label}]` : ` ${label} `);
    }
    lines.push(cells.join(''));
  }
  return lines.join('\n');
}

export const bingo = {
  key: 'bingo',
  title: 'Bingo',
  blurb: 'Buy a card, take turns calling numbers, first line takes the pot.',
  minSeats: 2,
  maxSeats: 6,
  defaultStake: 40,
  turnSeconds: 30,
  actionHelp: 'call',

  start(table) {
    const players = table.seats
      .map((s) => playerById(s.playerId))
      .filter((p) => p && p.chips >= table.stake);
    if (players.length < 2) {
      throw new GameError(`Bingo needs two players who can cover the ${table.stake} card.`, 'poor');
    }

    const cards = {};
    for (const p of players) {
      adjustChips(p, -table.stake, 'bingo card');
      cards[p.id] = makeCard();
    }

    table.state = {
      cards,
      order: players.map((p) => p.id),
      called: [],
      pot: table.stake * players.length,
      lastCall: null,
      winners: [],
    };
    table.status = 'playing';
    table.round += 1;
    tableLog(table, `--- Game ${table.round} --- ${players.length} cards, pot ${table.state.pot}`);
    setTurn(table, players[0].id);
    return { events: [`Cards dealt. Pot is ${table.state.pot}. Take turns calling numbers.`] };
  },

  act(table, player, action) {
    const st = table.state;
    if (String(action || '').toLowerCase() !== 'call') {
      throw new GameError(`Unknown action "${action}". At bingo you can only call.`, 'bad_action');
    }

    const remaining = [];
    for (let n = 1; n <= 75; n++) if (!st.called.includes(n)) remaining.push(n);
    if (!remaining.length) return finish(table, [], 'Every number was called with no line.');

    const number = remaining[randInt(remaining.length)];
    st.called.push(number);
    st.lastCall = number;
    tableLog(table, `@${player.username} calls ${callText(number)}`);

    const events = [`${callText(number)} called. (${st.called.length} numbers so far)`];

    // Anyone can complete a line on anyone's call.
    const lined = st.order
      .map((id) => ({ id, line: findLine(st.cards[id], st.called) }))
      .filter((x) => x.line);
    if (lined.length) {
      return finish(table, lined, null, events);
    }

    save();
    const next = nextSeat(table, player.id, (s) => Boolean(st.cards[s.playerId]));
    setTurn(table, next.playerId);
    return { events };
  },

  onTimeout(table) {
    const p = playerById(table.turn);
    tableLog(table, `@${p?.username} timed out; the house called for them.`);
    return this.act(table, p, 'call');
  },

  view(table, player) {
    const st = table.state;
    if (!st?.cards) return 'No game in progress. Anyone at the table can deal.';
    const lines = [];
    if (st.lastCall) lines.push(`Last call: ${callText(st.lastCall)}   (${st.called.length} called)`);
    lines.push(`Pot: ${st.pot}`);
    const card = st.cards[player.id];
    if (card) {
      lines.push('', 'Your card:', cardText(card, st.called));
      const line = findLine(card, st.called);
      if (line) lines.push(`BINGO -- ${line}!`);
    }
    lines.push('');
    for (const id of st.order) {
      const who = playerById(id);
      const marks = marksFor(st.cards[id], st.called).flat().filter(Boolean).length;
      lines.push(`@${who?.username}${id === player.id ? ' (you)' : ''}: ${marks}/25 marked${table.turn === id ? ' <- to call' : ''}`);
    }
    const recent = st.called.slice(-12).map(callText).join('  ');
    if (recent) lines.push('', `Recent calls: ${recent}`);
    return lines.join('\n');
  },

  snapshot(table, player) {
    const st = table.state;
    if (!st?.cards) return { phase: 'idle' };
    const card = st.cards[player.id];
    return {
      phase: 'playing',
      called: st.called,
      lastCall: st.lastCall,
      pot: st.pot,
      myCard: card || null,
      myMarks: card ? marksFor(card, st.called) : null,
      myLine: card ? findLine(card, st.called) : null,
      winners: st.winners || [],
      seats: st.order.map((id) => {
        const account = playerById(id);
        return {
          username: account?.username,
          isYou: id === player.id,
          isBot: Boolean(account?.isBot),
          isTurn: table.turn === id,
          stack: account?.chips ?? 0,
          marked: marksFor(st.cards[id], st.called).flat().filter(Boolean).length,
          card: table.status === 'finished' ? st.cards[id] : null,
        };
      }),
    };
  },

  botAction() {
    return { action: 'call' };
  },
  botFallback() {
    return { action: 'call' };
  },
};

function finish(table, lined, headline, events = []) {
  const st = table.state;
  st.winners = [];

  for (const id of st.order) {
    const p = playerById(id);
    if (p) p.stats.handsPlayed += 1;
  }

  if (!lined.length) {
    // Nobody lined: hand the cards' cost back rather than keeping it.
    const refund = Math.floor(st.pot / st.order.length);
    for (const id of st.order) {
      const p = playerById(id);
      if (p) adjustChips(p, refund, 'bingo refund');
    }
    events.push(headline || 'No winner.', `Cards refunded (${refund} each).`);
  } else {
    const share = Math.floor(st.pot / lined.length);
    let remainder = st.pot - share * lined.length;
    for (const { id, line } of lined) {
      const p = playerById(id);
      if (!p) continue;
      const take = share + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      adjustChips(p, take, 'bingo pot');
      p.stats.wins += 1;
      if (take > (p.stats.biggestPot || 0)) p.stats.biggestPot = take;
      st.winners.push({ username: p.username, amount: take, how: line });
      events.push(`BINGO! @${p.username} completes a ${line} and takes ${take}. (${p.chips})`);
      tableLog(table, `@${p.username} wins ${take} with a ${line}`);
    }
    for (const id of st.order) {
      if (lined.some((w) => w.id === id)) continue;
      const p = playerById(id);
      if (p) p.stats.losses += 1;
    }
  }

  table.status = 'finished';
  table.turn = null;
  table.lastActionAt = Date.now();
  save();
  events.push('Game over. Deal again when you are ready.');
  return { events };
}
