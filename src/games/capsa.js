// Capsa Susun (Chinese poker). Thirteen cards, split into three rows:
//
//   back   5 cards  -- must be the strongest
//   middle 5 cards
//   front  3 cards  -- must be the weakest
//
// Setting them out of order is a "foul" and loses every row. Scoring compares
// each row against each opponent's matching row: one unit per row won.
//
// This is the game in the arcade that suits a chat best: one decision per hand,
// not a dozen. You arrange, everyone else arranges, and it scores itself.

import { freshDeck, shuffle, draw, showCards, parseCard } from './cards.js';
import { evaluate, evaluate3 } from './handrank.js';
import { GameError, playerById, adjustChips, save } from '../core/players.js';
import { tableLog, setTurn, nextSeat } from '../core/tables.js';

const rowLabel = (row, cards) =>
  `${row}: ${showCards(cards)} -- ${(row === 'front' ? evaluate3(cards) : evaluate(cards)).label}`;

/** Rows in order, strongest first, so a foul check is one pass. */
export function checkArrangement({ front, middle, back }) {
  if (front.length !== 3) throw new GameError('The front row takes exactly 3 cards.', 'bad_rows');
  if (middle.length !== 5) throw new GameError('The middle row takes exactly 5 cards.', 'bad_rows');
  if (back.length !== 5) throw new GameError('The back row takes exactly 5 cards.', 'bad_rows');

  const all = [...front, ...middle, ...back];
  if (new Set(all).size !== 13) throw new GameError('Each card can only be used once.', 'duplicate_card');

  const b = evaluate(back);
  const m = evaluate(middle);
  const f = evaluate3(front);
  // Front is three cards and scored on its own ladder, so it cannot be compared
  // to the middle by score. Only pairs and trips can ever out-rank a five-card
  // hand there, and only against a five-card high card or pair -- which is what
  // this check encodes.
  const frontTooStrong =
    (f.category === 'Three of a Kind' && m.categoryRank <= 3 && m.score < 3 * Math.pow(15, 5)) ||
    (f.category === 'Pair' && m.categoryRank === 0);
  const foul = b.score < m.score || frontTooStrong;
  return { foul, back: b, middle: m, front: f };
}

/**
 * Pick a legal arrangement automatically.
 *
 * Exhaustive search is C(13,5) x C(8,5) = 72,072 splits, each needing three
 * evaluations -- too slow to do inside a request. Instead: try the strongest
 * five-card hands available as the back row, then the best legal middle from
 * what is left. That finds a good, always-legal arrangement in milliseconds.
 */
export function autoArrange(cards) {
  const combos5 = combinations(cards, 5)
    .map((c) => ({ cards: c, hand: evaluate(c) }))
    .sort((a, b) => b.hand.score - a.hand.score);

  for (const back of combos5.slice(0, 40)) {
    const rest8 = cards.filter((c) => !back.cards.includes(c));
    const middles = combinations(rest8, 5)
      .map((c) => ({ cards: c, hand: evaluate(c) }))
      .filter((m) => m.hand.score <= back.hand.score)
      .sort((a, b) => b.hand.score - a.hand.score);

    for (const middle of middles.slice(0, 25)) {
      const front = rest8.filter((c) => !middle.cards.includes(c));
      const attempt = { front, middle: middle.cards, back: back.cards };
      if (!checkArrangement(attempt).foul) return attempt;
    }
  }
  // Fallback that is always legal: sorted low to high, weakest three in front.
  const sorted = [...cards].sort((a, b) => evaluate3([a, a, b]).score - evaluate3([b, b, a]).score);
  return { front: sorted.slice(0, 3), middle: sorted.slice(3, 8), back: sorted.slice(8, 13) };
}

function combinations(arr, k) {
  const out = [];
  const pick = (start, chosen) => {
    if (chosen.length === k) return out.push([...chosen]);
    for (let i = start; i < arr.length; i++) {
      chosen.push(arr[i]);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return out;
}

/** Turns "As Ks Qs" or "As,Ks,Qs" into card codes, checked against a hand. */
function parseRow(text, hand, rowName, count) {
  const parts = String(text || '').split(/[\s,]+/).filter(Boolean);
  if (parts.length !== count) {
    throw new GameError(`The ${rowName} row needs ${count} cards, you gave ${parts.length}.`, 'bad_rows');
  }
  return parts.map((raw) => {
    const card = parseCard(raw);
    if (!card) throw new GameError(`"${raw}" is not a card. Use forms like As, Kh, Td, 7c.`, 'bad_card');
    if (!hand.includes(card)) throw new GameError(`You were not dealt ${card}.`, 'not_your_card');
    return card;
  });
}

export const capsa = {
  key: 'capsa',
  title: 'Capsa Susun',
  blurb: 'Thirteen cards into three rows. Strongest at the back, weakest in front.',
  minSeats: 2,
  maxSeats: 4,
  defaultStake: 50,
  turnSeconds: 120, // arranging thirteen cards takes longer than calling a bet
  actionHelp: 'arrange front: <3 cards> middle: <5 cards> back: <5 cards>, or auto',

  start(table) {
    const players = table.seats
      .map((s) => playerById(s.playerId))
      .filter((p) => p && p.chips >= table.stake * 6); // worst case: lose every row
    if (players.length < 2) {
      throw new GameError(`Capsa needs two players who can cover ${table.stake * 6} chips.`, 'poor');
    }

    const deck = shuffle(freshDeck());
    const hands = {};
    for (const p of players) {
      hands[p.id] = { cards: draw(deck, 13), arranged: null, foul: false };
    }

    table.state = { hands, order: players.map((p) => p.id), phase: 'arranging', results: null };
    table.status = 'playing';
    table.round += 1;
    tableLog(table, `--- Hand ${table.round} --- ${players.length} players, ${table.stake} a row`);
    setTurn(table, players[0].id);
    return { events: [`Thirteen cards each. Arrange them, or say "auto" and the house will do it.`] };
  },

  act(table, player, action, args = {}) {
    const st = table.state;
    const mine = st.hands[player.id];
    if (!mine) throw new GameError('You are not in this hand.', 'not_dealt');
    if (mine.arranged) throw new GameError('You have already set your rows.', 'already_set');

    const verb = String(action || '').toLowerCase();
    let rows;

    if (verb === 'auto') {
      rows = autoArrange(mine.cards);
    } else if (verb === 'arrange' || verb === 'set') {
      if (!args.front || !args.middle || !args.back) {
        throw new GameError('Give all three rows: front (3), middle (5), back (5). Or say "auto".', 'bad_rows');
      }
      rows = {
        front: parseRow(args.front, mine.cards, 'front', 3),
        middle: parseRow(args.middle, mine.cards, 'middle', 5),
        back: parseRow(args.back, mine.cards, 'back', 5),
      };
      const used = [...rows.front, ...rows.middle, ...rows.back];
      if (new Set(used).size !== 13) throw new GameError('Use each of your 13 cards exactly once.', 'duplicate_card');
    } else {
      throw new GameError(`Unknown action "${action}". Say "arrange" with three rows, or "auto".`, 'bad_action');
    }

    const check = checkArrangement(rows);
    mine.arranged = rows;
    mine.foul = check.foul;
    mine.hands = { front: check.front, middle: check.middle, back: check.back };
    tableLog(table, `@${player.username} sets their rows${check.foul ? ' -- and fouls' : ''}.`);

    const events = [
      rowLabel('back', rows.back),
      rowLabel('middle', rows.middle),
      rowLabel('front', rows.front),
    ];
    if (check.foul) events.push('That is a foul: the rows are out of order. You lose every row this hand.');

    save();
    const next = nextSeat(table, player.id, (s) => st.hands[s.playerId] && !st.hands[s.playerId].arranged);
    if (next) {
      setTurn(table, next.playerId);
      return { events };
    }
    return { events: [...events, ...score(table).events] };
  },

  onTimeout(table) {
    const id = table.turn;
    const p = playerById(id);
    const mine = table.state.hands[id];
    if (mine && !mine.arranged) {
      // Time out into a legal arrangement rather than a foul: the clock should
      // cost you the choice, not the whole hand.
      const rows = autoArrange(mine.cards);
      const check = checkArrangement(rows);
      mine.arranged = rows;
      mine.foul = check.foul;
      mine.hands = { front: check.front, middle: check.middle, back: check.back };
      tableLog(table, `@${p?.username} ran out of time; the house set their rows.`);
    }
    const next = nextSeat(table, id, (s) => table.state.hands[s.playerId] && !table.state.hands[s.playerId].arranged);
    if (next) {
      setTurn(table, next.playerId);
      return { events: [`@${p?.username} timed out and was arranged automatically.`] };
    }
    return score(table);
  },

  view(table, player) {
    const st = table.state;
    if (!st?.hands) return 'No hand in progress. Anyone at the table can deal.';
    const mine = st.hands[player.id];
    const lines = [];

    if (mine && !mine.arranged) {
      lines.push(`Your thirteen: ${showCards(mine.cards)}`);
      lines.push('');
      lines.push('Set three rows -- back (5) must beat middle (5), which must beat front (3).');
      lines.push('Example: arrange front: As Kd 7c  middle: 9h 9s 4d 4c 2h  back: Qs Js Ts 9c 8d');
      lines.push('Or just say "auto".');
    } else if (mine) {
      lines.push(rowLabel('back', mine.arranged.back));
      lines.push(rowLabel('middle', mine.arranged.middle));
      lines.push(rowLabel('front', mine.arranged.front));
      if (mine.foul) lines.push('FOUL -- rows out of order.');
    }

    lines.push('');
    for (const id of st.order) {
      const h = st.hands[id];
      const who = playerById(id);
      const you = id === player.id ? ' (you)' : '';
      lines.push(`@${who?.username}${you}: ${h.arranged ? (h.foul ? 'set -- fouled' : 'set') : 'still arranging'}`);
    }
    if (st.results) {
      lines.push('', 'Result:', ...st.results.lines);
    }
    return lines.join('\n');
  },

  snapshot(table, player) {
    const st = table.state;
    if (!st?.hands) return { phase: 'idle' };
    const mine = st.hands[player.id];
    const done = table.status === 'finished';
    return {
      phase: st.phase,
      myCards: mine && !mine.arranged ? mine.cards : [],
      myRows: mine?.arranged || null,
      myFoul: Boolean(mine?.foul),
      results: st.results || null,
      winners: st.winners || [],
      seats: st.order.map((id) => {
        const h = st.hands[id];
        const account = playerById(id);
        return {
          username: account?.username,
          isYou: id === player.id,
          isBot: Boolean(account?.isBot),
          isTurn: table.turn === id,
          stack: account?.chips ?? 0,
          arranged: Boolean(h.arranged),
          foul: Boolean(h.foul),
          rows: done && h.arranged ? h.arranged : null,
          labels: done && h.hands
            ? { back: h.hands.back.label, middle: h.hands.middle.label, front: h.hands.front.label }
            : null,
          net: st.results?.net?.[id] ?? null,
        };
      }),
    };
  },

  botAction() {
    return { action: 'auto' };
  },
  botFallback() {
    return { action: 'auto' };
  },
};

function score(table) {
  const st = table.state;
  st.phase = 'scoring';
  const ids = st.order;
  const net = Object.fromEntries(ids.map((id) => [id, 0]));
  const lines = [];

  // Every pair of players compares all three rows. A foul loses all three
  // without comparing anything.
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const ha = st.hands[a];
      const hb = st.hands[b];
      let units = 0;

      if (ha.foul && !hb.foul) units = -3;
      else if (hb.foul && !ha.foul) units = 3;
      else if (!ha.foul && !hb.foul) {
        for (const row of ['back', 'middle', 'front']) {
          const diff = ha.hands[row].score - hb.hands[row].score;
          if (diff > 0) units += 1;
          else if (diff < 0) units -= 1;
        }
      }
      net[a] += units;
      net[b] -= units;
      const an = playerById(a)?.username;
      const bn = playerById(b)?.username;
      lines.push(`@${an} vs @${bn}: ${units > 0 ? '+' : ''}${units}`);
    }
  }

  st.winners = [];
  for (const id of ids) {
    const p = playerById(id);
    if (!p) continue;
    const delta = net[id] * table.stake;
    p.stats.handsPlayed += 1;
    if (delta > 0) {
      adjustChips(p, delta, 'capsa');
      p.stats.wins += 1;
      st.winners.push({ username: p.username, amount: delta });
    } else if (delta < 0) {
      adjustChips(p, delta, 'capsa');
      p.stats.losses += 1;
    }
    lines.push(`@${p.username}: ${net[id] > 0 ? '+' : ''}${net[id]} rows = ${delta > 0 ? '+' : ''}${delta} chips (${p.chips})`);
    tableLog(table, `@${p.username} ${net[id] > 0 ? 'wins' : net[id] < 0 ? 'loses' : 'breaks even on'} ${Math.abs(delta)}`);
  }

  st.results = { net, lines };
  table.status = 'finished';
  table.turn = null;
  table.lastActionAt = Date.now();
  save();
  return { events: ['Showdown:', ...lines, 'Hand over. Deal again when you are ready.'] };
}
