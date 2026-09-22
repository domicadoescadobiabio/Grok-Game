// No-limit Texas Hold'em.
//
// The fiddly parts, and why they are written the way they are:
//
//  * Side pots. Players have different stacks, so an all-in for less cannot win
//    chips it never covered. Pots are rebuilt from each player's total
//    contribution at showdown rather than tracked incrementally -- one function
//    to get right instead of five.
//  * Heads-up blinds are backwards from a full ring: the dealer posts the small
//    blind and acts first before the flop, last after it. Getting this wrong is
//    invisible until someone who knows poker plays a hand.
//  * A betting round ends when everyone still in has acted AND has matched the
//    current bet. "Everyone has acted" alone is not enough -- a raise reopens it.

import { freshDeck, shuffle, draw, showCards } from './cards.js';
import { evaluate } from './handrank.js';
import { GameError, playerById, adjustChips, save } from '../core/players.js';
import { tableLog, setTurn } from '../core/tables.js';

export const poker = {
  key: 'poker',
  title: "Texas Hold'em",
  blurb: 'No-limit. Two cards each, five on the board, best five win.',
  minSeats: 2,
  maxSeats: 6,
  defaultStake: 20, // big blind
  turnSeconds: 30,
  actionHelp: 'fold, check, call, raise <amount>, allin',

  start(table) {
    const seated = table.seats
      .map((s) => playerById(s.playerId))
      .filter((p) => p && p.chips > 0);
    if (seated.length < 2) {
      throw new GameError('Hold\'em needs at least two players with chips.', 'need_two');
    }

    const bigBlind = table.stake;
    const smallBlind = Math.max(1, Math.floor(bigBlind / 2));
    const deck = shuffle(freshDeck());
    const order = seated.map((p) => p.id);
    const dealerIdx = table.round % order.length;

    const players = {};
    for (const p of seated) {
      players[p.id] = {
        id: p.id,
        username: p.username,
        cards: draw(deck, 2),
        bet: 0,        // chips in front of them this street
        committed: 0,  // chips in for the whole hand
        folded: false,
        allIn: false,
        acted: false,
      };
    }

    const st = {
      deck,
      board: [],
      players,
      order,
      dealerIdx,
      smallBlind,
      bigBlind,
      street: 'preflop',
      currentBet: 0,
      minRaise: bigBlind,
      pot: 0,
      showdown: null,
    };
    table.state = st;
    table.status = 'playing';
    table.round += 1;

    // Heads-up: the dealer is the small blind. Otherwise blinds sit to the left.
    const headsUp = order.length === 2;
    const sbIdx = headsUp ? dealerIdx : (dealerIdx + 1) % order.length;
    const bbIdx = headsUp ? (dealerIdx + 1) % order.length : (dealerIdx + 2) % order.length;

    postBlind(st, order[sbIdx], smallBlind, 'small blind', table);
    postBlind(st, order[bbIdx], bigBlind, 'big blind', table);
    st.currentBet = bigBlind;

    // Preflop action starts left of the big blind; heads-up that is the dealer.
    const firstIdx = headsUp ? dealerIdx : (bbIdx + 1) % order.length;
    const first = nextLive(st, firstIdx, true);

    tableLog(table, `--- Hand ${table.round} --- ${order.length} players, blinds ${smallBlind}/${bigBlind}`);
    setTurn(table, first);
    return { events: [`Hand ${table.round} dealt. Blinds ${smallBlind}/${bigBlind}. Pot ${st.pot}.`] };
  },

  act(table, player, action, args = {}) {
    const st = table.state;
    const me = st.players[player.id];
    if (!me) throw new GameError('You are not in this hand. Wait for the next deal.', 'not_dealt');
    if (me.folded || me.allIn) throw new GameError('You have no decision left in this hand.', 'hand_done');

    const verb = String(action || '').toLowerCase();
    const toCall = st.currentBet - me.bet;
    const events = [];
    const chipsOf = () => playerById(player.id).chips;

    if (verb === 'fold') {
      me.folded = true;
      me.acted = true;
      events.push('You fold.');
      tableLog(table, `@${me.username} folds.`);
    } else if (verb === 'check') {
      if (toCall > 0) throw new GameError(`You cannot check facing a bet of ${toCall}. Call, raise or fold.`, 'cannot_check');
      me.acted = true;
      events.push('You check.');
      tableLog(table, `@${me.username} checks.`);
    } else if (verb === 'call') {
      if (toCall <= 0) throw new GameError('There is nothing to call -- you can check.', 'nothing_to_call');
      const paid = takeChips(st, player, Math.min(toCall, chipsOf()));
      me.acted = true;
      events.push(paid < toCall ? `You call all-in for ${paid}.` : `You call ${paid}.`);
      tableLog(table, `@${me.username} calls ${paid}${me.allIn ? ' (all-in)' : ''}.`);
    } else if (verb === 'raise' || verb === 'bet') {
      const target = Number(args.amount);
      if (!Number.isFinite(target) || target <= 0) {
        throw new GameError('Raise to how much? For example: raise 60.', 'bad_amount');
      }
      if (target <= st.currentBet) {
        throw new GameError(`A raise must be more than the current bet of ${st.currentBet}.`, 'too_small');
      }
      const minTarget = st.currentBet + st.minRaise;
      const wouldBeAllIn = target - me.bet >= chipsOf();
      if (target < minTarget && !wouldBeAllIn) {
        throw new GameError(`Minimum raise is to ${minTarget}.`, 'too_small');
      }
      const paid = takeChips(st, player, Math.min(target - me.bet, chipsOf()));
      st.minRaise = Math.max(st.minRaise, me.bet - st.currentBet);
      st.currentBet = Math.max(st.currentBet, me.bet);
      // A raise puts the decision back to everyone else.
      for (const p of Object.values(st.players)) {
        if (p.id !== me.id && !p.folded && !p.allIn) p.acted = false;
      }
      me.acted = true;
      events.push(`You raise to ${me.bet}${me.allIn ? ' (all-in)' : ''}.`);
      tableLog(table, `@${me.username} raises to ${me.bet}${me.allIn ? ' (all-in)' : ''}.`);
    } else if (verb === 'allin') {
      const paid = takeChips(st, player, chipsOf());
      if (me.bet > st.currentBet) {
        st.minRaise = Math.max(st.minRaise, me.bet - st.currentBet);
        st.currentBet = me.bet;
        for (const p of Object.values(st.players)) {
          if (p.id !== me.id && !p.folded && !p.allIn) p.acted = false;
        }
      }
      me.acted = true;
      events.push(`You are all-in for ${paid}.`);
      tableLog(table, `@${me.username} is all-in for ${paid}.`);
    } else {
      throw new GameError(`Unknown action "${action}". You can fold, check, call, raise <amount> or allin.`, 'bad_action');
    }

    save();
    return advance(table, events);
  },

  onTimeout(table) {
    const st = table.state;
    const me = st.players[table.turn];
    if (!me) return { events: [] };
    // Time out into the cheapest legal action, never into losing chips.
    const toCall = st.currentBet - me.bet;
    if (toCall <= 0) {
      me.acted = true;
      tableLog(table, `@${me.username} times out and checks.`);
      return advance(table, [`@${me.username} timed out and checks.`]);
    }
    me.folded = true;
    me.acted = true;
    tableLog(table, `@${me.username} times out and folds.`);
    return advance(table, [`@${me.username} timed out and folds.`]);
  },

  view(table, player) {
    const st = table.state;
    if (!st || !st.players) return 'No hand in progress. Anyone at the table can deal.';
    const me = st.players[player.id];
    const lines = [];

    lines.push(`Board: ${st.board.length ? showCards(st.board) : '(none yet)'}   Pot: ${potTotal(st)}   Street: ${st.street}`);
    if (me) {
      lines.push(`Your cards: ${showCards(me.cards)}${me.folded ? ' (folded)' : ''}`);
      if (st.board.length >= 3 && !me.folded) {
        lines.push(`Your hand: ${evaluate([...me.cards, ...st.board]).label}`);
      }
    }
    lines.push('');
    for (const id of st.order) {
      const p = st.players[id];
      if (!p) continue;
      const chips = playerById(id)?.chips ?? 0;
      const tags = [p.folded ? 'folded' : null, p.allIn ? 'all-in' : null].filter(Boolean);
      const turn = table.turn === id ? ' <- to act' : '';
      const you = id === player.id ? ' (you)' : '';
      lines.push(`@${p.username}${you}: bet ${p.bet}, stack ${chips}${tags.length ? ` [${tags.join(', ')}]` : ''}${turn}`);
    }
    if (table.turn === player.id && me) {
      const toCall = st.currentBet - me.bet;
      lines.push('', toCall > 0
        ? `To you: call ${toCall}, raise to at least ${st.currentBet + st.minRaise}, or fold.`
        : `To you: check, or bet at least ${Math.max(st.bigBlind, st.minRaise)}.`);
    }
    if (st.showdown) lines.push('', st.showdown);
    return lines.join('\n');
  },
};

// ---------------------------------------------------------------- helpers

function postBlind(st, playerId, amount, label, table) {
  const player = playerById(playerId);
  const paid = takeChips(st, player, Math.min(amount, player.chips));
  tableLog(table, `@${player.username} posts the ${label} (${paid}).`);
}

/** Move chips from a stack into the pot, marking all-in when the stack empties. */
function takeChips(st, player, amount) {
  const take = Math.max(0, Math.min(amount, player.chips));
  adjustChips(player, -take, 'poker');
  const p = st.players[player.id];
  p.bet += take;
  p.committed += take;
  st.pot += take;
  if (player.chips === 0) p.allIn = true;
  return take;
}

const livePlayers = (st) => st.order.map((id) => st.players[id]).filter((p) => p && !p.folded);
const actingPlayers = (st) => livePlayers(st).filter((p) => !p.allIn);
const potTotal = (st) => st.pot;

function nextLive(st, fromIdx, inclusive = false) {
  const n = st.order.length;
  for (let step = inclusive ? 0 : 1; step <= n; step++) {
    const p = st.players[st.order[(fromIdx + step) % n]];
    if (p && !p.folded && !p.allIn) return p.id;
  }
  return null;
}

function advance(table, events) {
  const st = table.state;

  // Everyone folded to one player: they take it without showing.
  const live = livePlayers(st);
  if (live.length === 1) {
    return award(table, [{ amount: st.pot, winners: [live[0]] }], events, false);
  }

  const acting = actingPlayers(st);
  const roundDone = acting.every((p) => p.acted && p.bet === st.currentBet);

  if (!roundDone) {
    const fromIdx = st.order.indexOf(table.turn);
    const next = nextLive(st, fromIdx);
    if (next) {
      setTurn(table, next);
      return { events };
    }
  }

  return nextStreet(table, events);
}

function nextStreet(table, events) {
  const st = table.state;
  for (const p of Object.values(st.players)) {
    p.bet = 0;
    p.acted = false;
  }
  st.currentBet = 0;
  st.minRaise = st.bigBlind;

  const order = ['preflop', 'flop', 'turn', 'river', 'showdown'];
  st.street = order[order.indexOf(st.street) + 1];

  if (st.street === 'flop') st.board.push(...draw(st.deck, 3));
  else if (st.street === 'turn' || st.street === 'river') st.board.push(...draw(st.deck, 1));

  if (st.street === 'showdown') return showdown(table, events);

  events.push(`${st.street}: ${showCards(st.board)}`);
  tableLog(table, `${st.street}: ${showCards(st.board)}`);

  // With everyone but one all-in there are no more decisions -- run it out.
  if (actingPlayers(st).length <= 1) return nextStreet(table, events);

  // Post-flop, action starts left of the dealer.
  const first = nextLive(st, st.dealerIdx);
  if (!first) return nextStreet(table, events);
  setTurn(table, first);
  save();
  return { events };
}

/**
 * Split the pot into main and side pots from each player's total contribution.
 * Folded players' chips stay in the pot; they are just never eligible to win.
 */
export function buildPots(st) {
  const contributions = st.order
    .map((id) => st.players[id])
    .filter(Boolean)
    .map((p) => ({ p, amount: p.committed }));

  const levels = [...new Set(contributions.map((c) => c.amount).filter((a) => a > 0))].sort((a, b) => a - b);
  const pots = [];
  let previous = 0;

  for (const level of levels) {
    let amount = 0;
    for (const c of contributions) {
      amount += Math.max(0, Math.min(c.amount, level) - previous);
    }
    const eligible = contributions
      .filter((c) => !c.p.folded && c.amount >= level)
      .map((c) => c.p);
    if (amount > 0 && eligible.length) pots.push({ amount, eligible });
    else if (amount > 0 && pots.length) pots[pots.length - 1].amount += amount;
    previous = level;
  }
  return pots;
}

function showdown(table, events) {
  const st = table.state;
  const pots = buildPots(st);
  const results = [];

  for (const pot of pots) {
    const ranked = pot.eligible
      .map((p) => ({ p, hand: evaluate([...p.cards, ...st.board]) }))
      .sort((a, b) => b.hand.score - a.hand.score);
    const best = ranked[0].hand.score;
    const winners = ranked.filter((r) => r.hand.score === best);
    results.push({ amount: pot.amount, winners: winners.map((w) => w.p), label: winners[0].hand.label });
  }

  const reveal = livePlayers(st)
    .map((p) => `@${p.username}: ${showCards(p.cards)} -- ${evaluate([...p.cards, ...st.board]).label}`)
    .join('\n');
  st.showdown = reveal;
  events.push('Showdown:', reveal);
  tableLog(table, 'Showdown.');

  return award(table, results, events, true);
}

function award(table, pots, events, shown) {
  const st = table.state;
  for (const id of st.order) {
    const p = playerById(id);
    if (p) p.stats.handsPlayed += 1;
  }

  for (const pot of pots) {
    const share = Math.floor(pot.amount / pot.winners.length);
    let remainder = pot.amount - share * pot.winners.length;
    for (const w of pot.winners) {
      const player = playerById(w.id);
      if (!player) continue;
      // Odd chips go to the first winner in seat order; poker rooms do the same.
      const take = share + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      adjustChips(player, take, 'poker pot');
      (st.winners ||= []).push({ username: player.username, amount: take, how: pot.label || null });
      player.stats.wins += 1;
      if (pot.amount > (player.stats.biggestPot || 0)) player.stats.biggestPot = pot.amount;
      const how = pot.label ? ` with ${pot.label}` : '';
      events.push(`@${player.username} wins ${take}${how}. Stack: ${player.chips}`);
      tableLog(table, `@${player.username} wins ${take}${how}.`);
    }
  }

  for (const id of st.order) {
    const p = st.players[id];
    const account = playerById(id);
    if (p && account && !pots.some((pot) => pot.winners.some((w) => w.id === id))) {
      account.stats.losses += 1;
    }
  }

  table.status = 'finished';
  table.turn = null;
  table.lastActionAt = Date.now();
  st.pot = 0;
  save();
  events.push('Hand over. Deal again when you are ready.');
  return { events };
}

// ---------------------------------------------------------------- the bot

/**
 * A tight-ish opponent. Preflop it scores its two cards; postflop it uses the
 * real evaluator against the board. It compares that strength to the pot odds
 * it is being offered, with a little noise so it cannot be read perfectly.
 *
 * It is not trying to beat a good player. It is trying to fold trash, pay off
 * with a hand, and occasionally raise -- which is enough to make a table feel
 * like a table.
 */
poker.botAction = function botAction(table, player) {
  const st = table.state;
  const me = st.players[player.id];
  if (!me || me.folded || me.allIn) return null;

  const toCall = st.currentBet - me.bet;
  const pot = st.pot;
  const stack = player.chips;
  const strength = st.board.length >= 3
    ? postflopStrength(me.cards, st.board)
    : preflopStrength(me.cards);

  // Pot odds: the share of the final pot we must put in to keep playing.
  const odds = toCall > 0 ? toCall / (pot + toCall) : 0;
  const noise = (Math.random() - 0.5) * 0.08;
  const value = strength + noise;

  if (toCall <= 0) {
    // Free to see the next card. Bet when strong, otherwise take the card.
    if (value > 0.72 && stack > st.bigBlind * 2) {
      const target = Math.min(stack + me.bet, Math.max(st.bigBlind, Math.round(pot * 0.6)));
      if (target > st.currentBet) return { action: 'raise', args: { amount: target } };
    }
    return { action: 'check' };
  }

  if (value > 0.86 && stack > toCall) {
    const target = Math.min(stack + me.bet, st.currentBet + Math.max(st.minRaise, Math.round(pot * 0.75)));
    if (target > st.currentBet) return { action: 'raise', args: { amount: target } };
    return { action: 'call' };
  }
  if (value > odds + 0.12) return { action: 'call' };
  if (toCall <= st.bigBlind && value > 0.3) return { action: 'call' }; // cheap look
  return { action: 'fold' };
};

poker.botFallback = function botFallback(table, player) {
  const st = table.state;
  const me = st.players[player.id];
  return { action: st.currentBet - me.bet > 0 ? 'fold' : 'check' };
};

/** Rough 0..1 for two hole cards, in the spirit of a Chen-style count. */
function preflopStrength(cards) {
  const [a, b] = cards.map((c) => rankOf(c));
  const suited = cards[0][1] === cards[1][1];
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  const gap = high - low;

  if (a === b) return Math.min(0.98, 0.55 + (a - 2) * 0.035);  // pairs: 22 ~0.55, AA ~0.97
  let score = (high - 2) / 24 + (low - 2) / 48;                 // high card weighted
  if (suited) score += 0.09;
  if (gap === 1) score += 0.06;
  else if (gap === 2) score += 0.03;
  else if (gap > 4) score -= 0.06;
  return Math.max(0.05, Math.min(0.95, score));
}

/** 0..1 from the actual made hand, so the bot slows down with nothing. */
function postflopStrength(hole, board) {
  const made = evaluate([...hole, ...board]);
  const byCategory = [0.22, 0.42, 0.62, 0.76, 0.85, 0.9, 0.95, 0.98, 0.99];
  let score = byCategory[made.categoryRank] ?? 0.3;

  // A bare pair that lives on the board is worth much less than our own pair.
  if (made.categoryRank === 1) {
    const boardRanks = new Set(board.map(rankOf));
    const holeRanks = hole.map(rankOf);
    if (!holeRanks.some((r) => boardRanks.has(r)) && holeRanks[0] !== holeRanks[1]) score -= 0.18;
  }
  return Math.max(0.05, Math.min(0.99, score));
}

const rankOf = (card) => '23456789TJQKA'.indexOf(card[0]) + 2;

/** Structured state for a visual client. Hole cards are only ever the caller's. */
poker.snapshot = function snapshot(table, player) {
  const st = table.state;
  if (!st?.players) return { phase: 'idle' };
  const me = st.players[player.id];
  const showAll = table.status === 'finished' && livePlayers(st).length > 1;
  const winners = table.status === 'finished' ? (st.winners || []) : [];
  return {
    winners,
    phase: st.street,
    board: st.board,
    pot: st.pot,
    currentBet: st.currentBet,
    minRaiseTo: st.currentBet + st.minRaise,
    toCall: me ? Math.max(0, st.currentBet - me.bet) : 0,
    hole: me ? me.cards : [],
    myHand: me && st.board.length >= 3 && !me.folded
      ? evaluate([...me.cards, ...st.board]).label : null,
    seats: st.order.map((id) => {
      const p = st.players[id];
      const account = playerById(id);
      return {
        username: p.username,
        isYou: id === player.id,
        isBot: Boolean(account?.isBot),
        isTurn: table.turn === id,
        bet: p.bet,
        stack: account?.chips ?? 0,
        folded: p.folded,
        allIn: p.allIn,
        cards: id === player.id || (showAll && !p.folded) ? p.cards : null,
        hand: showAll && !p.folded && st.board.length === 5
          ? evaluate([...p.cards, ...st.board]).label : null,
      };
    }),
  };
};
