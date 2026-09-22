// Blackjack: everyone at the table plays their own hand against one dealer.
//
// Dealer stands on all 17s, blackjack pays 3:2, double is allowed on the first
// two cards only. No splits yet -- they turn one seat into two hands, which the
// turn system would have to learn about.

import { freshDeck, shuffle, draw, showCards } from './cards.js';
import { config } from '../config.js';
import { GameError, playerById, adjustChips, save } from '../core/players.js';
import { tableLog, setTurn, nextSeat, seatOf } from '../core/tables.js';

export const BLACKJACK_PAYS = 1.5;

/** Best total for a hand, and whether an ace is still counted as 11. */
export function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    const r = card[0];
    if (r === 'A') { aces += 1; total += 11; }
    else if ('TJQK'.includes(r)) total += 10;
    else total += Number(r);
  }
  let soft = aces > 0;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
    soft = aces > 0;
  }
  return { total, soft: soft && total <= 21 };
}

export const isBlackjack = (cards) => cards.length === 2 && handValue(cards).total === 21;

const describeHand = (cards) => {
  const { total, soft } = handValue(cards);
  return `${showCards(cards)} (${soft ? 'soft ' : ''}${total})`;
};

export const blackjack = {
  key: 'blackjack',
  title: 'Blackjack',
  blurb: 'Beat the dealer without going over 21.',
  minSeats: 1,
  maxSeats: 5,
  defaultStake: 50,
  turnSeconds: 15,
  actionHelp: 'hit, stand, double',

  start(table) {
    const players = table.seats
      .map((s) => playerById(s.playerId))
      .filter((p) => p && p.chips >= table.stake);

    if (!players.length) {
      throw new GameError(`Nobody at this table can cover the ${table.stake} chip bet.`, 'poor');
    }

    const deck = shuffle(freshDeck());
    const hands = {};
    for (const p of players) {
      adjustChips(p, -table.stake, 'blackjack bet');
      hands[p.id] = { cards: draw(deck, 2), bet: table.stake, status: 'playing', doubled: false };
    }
    const dealer = draw(deck, 2);

    table.state = { deck, dealer, hands, phase: 'playing', revealed: false };
    table.status = 'playing';
    table.round += 1;

    tableLog(table, `--- Round ${table.round} --- dealer shows ${showCards([dealer[0]])}`);
    for (const p of players) {
      const hand = hands[p.id];
      if (isBlackjack(hand.cards)) {
        hand.status = 'blackjack';
        tableLog(table, `@${p.username} is dealt blackjack: ${showCards(hand.cards)}`);
      }
    }

    // Dealer blackjack ends it immediately -- nobody gets to act into a hand
    // that is already decided.
    if (isBlackjack(dealer)) {
      tableLog(table, `Dealer turns over blackjack: ${showCards(dealer)}`);
      return settle(table);
    }

    const first = firstToAct(table);
    if (!first) return dealerPlay(table);
    setTurn(table, first);
    return { events: [`Round ${table.round} dealt. Dealer shows ${showCards([dealer[0]])}.`] };
  },

  act(table, player, action, args = {}) {
    const hand = table.state.hands[player.id];
    if (!hand) throw new GameError('You are not in this round. Wait for the next deal.', 'not_dealt');
    if (hand.status !== 'playing') throw new GameError('Your hand is already finished.', 'hand_done');

    const events = [];
    const verb = String(action || '').toLowerCase();

    if (verb === 'hit') {
      const [card] = draw(table.state.deck, 1);
      hand.cards.push(card);
      const { total } = handValue(hand.cards);
      events.push(`You draw ${showCards([card])} -> ${describeHand(hand.cards)}`);
      tableLog(table, `@${player.username} hits: ${describeHand(hand.cards)}`);
      if (total > 21) {
        hand.status = 'bust';
        events.push('Bust.');
      } else if (total === 21) {
        hand.status = 'stand';
        events.push('Twenty-one -- standing.');
      }
    } else if (verb === 'stand') {
      hand.status = 'stand';
      events.push(`You stand on ${describeHand(hand.cards)}`);
      tableLog(table, `@${player.username} stands on ${handValue(hand.cards).total}`);
    } else if (verb === 'double') {
      if (hand.cards.length !== 2) {
        throw new GameError('You can only double on your first two cards.', 'cannot_double');
      }
      if (player.chips < hand.bet) {
        throw new GameError(`Doubling costs another ${hand.bet} chips and you have ${player.chips}.`, 'poor');
      }
      adjustChips(player, -hand.bet, 'blackjack double');
      hand.bet *= 2;
      hand.doubled = true;
      const [card] = draw(table.state.deck, 1);
      hand.cards.push(card);
      const { total } = handValue(hand.cards);
      hand.status = total > 21 ? 'bust' : 'stand';
      events.push(`You double to ${hand.bet} and draw ${showCards([card])} -> ${describeHand(hand.cards)}${total > 21 ? ' Bust.' : ''}`);
      tableLog(table, `@${player.username} doubles to ${hand.bet}: ${describeHand(hand.cards)}`);
    } else {
      throw new GameError(`Unknown action "${action}". At blackjack you can hit, stand or double.`, 'bad_action');
    }

    save();
    return advance(table, player.id, events);
  },

  onTimeout(table) {
    const id = table.turn;
    const hand = table.state.hands[id];
    const p = playerById(id);
    if (hand && hand.status === 'playing') {
      hand.status = 'stand';
      tableLog(table, `@${p?.username || 'someone'} timed out and stands on ${handValue(hand.cards).total}.`);
    }
    return advance(table, id, [`@${p?.username || 'A player'} ran out of time and stands.`]);
  },

  view(table, player) {
    const st = table.state;
    if (!st || !st.hands) return 'No round in progress. Anyone at the table can deal.';
    const lines = [];
    const dealerCards = st.revealed ? st.dealer : [st.dealer[0]];
    lines.push(`Dealer: ${showCards(dealerCards)}${st.revealed ? ` (${handValue(st.dealer).total})` : ' + face-down'}`);
    lines.push('');
    for (const seat of table.seats) {
      const hand = st.hands[seat.playerId];
      if (!hand) { lines.push(`@${seat.username}: sitting out this round`); continue; }
      const you = seat.playerId === player.id ? ' <- you' : '';
      const turn = table.turn === seat.playerId ? ' (to act)' : '';
      lines.push(`@${seat.username}: ${describeHand(hand.cards)} bet ${hand.bet} [${hand.status}]${turn}${you}`);
    }
    return lines.join('\n');
  },
};

function firstToAct(table) {
  const seat = table.seats.find((s) => table.state.hands[s.playerId]?.status === 'playing');
  return seat ? seat.playerId : null;
}

function advance(table, fromId, events) {
  const next = nextSeat(table, fromId, (s) => table.state.hands[s.playerId]?.status === 'playing');
  if (next) {
    setTurn(table, next.playerId);
    return { events };
  }
  const result = dealerPlay(table);
  return { events: [...events, ...result.events] };
}

function dealerPlay(table) {
  const st = table.state;
  st.revealed = true;
  st.phase = 'dealer';
  const events = [];

  // Nobody left standing means the dealer never has to draw.
  const anyLive = Object.values(st.hands).some((h) => h.status === 'stand' || h.status === 'blackjack');
  if (anyLive) {
    while (handValue(st.dealer).total < 17) {
      const [card] = draw(st.deck, 1);
      st.dealer.push(card);
    }
  }
  const dealerTotal = handValue(st.dealer).total;
  events.push(`Dealer: ${describeHand(st.dealer)}${dealerTotal > 21 ? ' -- bust.' : ''}`);
  tableLog(table, `Dealer ${describeHand(st.dealer)}`);
  return settle(table, events);
}

function settle(table, events = []) {
  const st = table.state;
  st.revealed = true;
  st.phase = 'payout';
  const dealerTotal = handValue(st.dealer).total;
  const dealerBJ = isBlackjack(st.dealer);

  for (const [playerId, hand] of Object.entries(st.hands)) {
    const p = playerById(playerId);
    if (!p) continue;
    p.stats.handsPlayed += 1;

    let payout = 0;
    let outcome;
    const total = handValue(hand.cards).total;

    if (hand.status === 'bust') {
      outcome = `busts on ${total}`;
    } else if (hand.status === 'blackjack' && !dealerBJ) {
      payout = Math.round(hand.bet * (1 + BLACKJACK_PAYS));
      outcome = `blackjack, wins ${payout - hand.bet}`;
    } else if (dealerBJ && hand.status !== 'blackjack') {
      outcome = 'loses to dealer blackjack';
    } else if (hand.status === 'blackjack' && dealerBJ) {
      payout = hand.bet;
      outcome = 'pushes -- both blackjack';
    } else if (dealerTotal > 21) {
      payout = hand.bet * 2;
      outcome = `wins ${hand.bet} (dealer bust)`;
    } else if (total > dealerTotal) {
      payout = hand.bet * 2;
      outcome = `wins ${hand.bet} with ${total}`;
    } else if (total === dealerTotal) {
      payout = hand.bet;
      outcome = `pushes on ${total}`;
    } else {
      outcome = `loses ${hand.bet} with ${total} to ${dealerTotal}`;
    }

    if (payout > 0) adjustChips(p, payout, 'blackjack payout');
    if (payout > hand.bet) p.stats.wins += 1;
    else if (payout === 0) p.stats.losses += 1;

    hand.result = outcome;
    hand.payout = payout;
    hand.won = payout > hand.bet;
    hand.pushed = payout === hand.bet && payout > 0;
    events.push(`@${p.username} ${outcome}. Chips: ${p.chips}`);
    tableLog(table, `@${p.username} ${outcome}`);
  }

  table.status = 'finished';
  table.turn = null;
  table.lastActionAt = Date.now();
  save();
  events.push('Round over. Deal again when everyone is ready.');
  return { events };
}

// ---------------------------------------------------------------- the bot

/**
 * Basic strategy, minus splits (which the table does not support yet).
 * Deliberately not perfect -- it is a house dealer's rule of thumb, and it
 * makes the same mistakes a decent human makes.
 */
blackjack.botAction = function botAction(table, player) {
  const hand = table.state.hands[player.id];
  if (!hand || hand.status !== 'playing') return null;
  const { total, soft } = handValue(hand.cards);
  const up = table.state.dealer[0];
  const upValue = up[0] === 'A' ? 11 : 'TJQK'.includes(up[0]) ? 10 : Number(up[0]);
  const first = hand.cards.length === 2;

  // Double where it is clearly right and affordable.
  if (first && player.chips >= hand.bet) {
    if (!soft && total === 11) return { action: 'double' };
    if (!soft && total === 10 && upValue <= 9) return { action: 'double' };
    if (!soft && total === 9 && upValue >= 3 && upValue <= 6) return { action: 'double' };
  }

  if (soft) return { action: total <= 17 ? 'hit' : 'stand' };
  if (total <= 11) return { action: 'hit' };
  if (total >= 17) return { action: 'stand' };
  // 12-16: stand against a dealer who is likely to bust, otherwise take a card.
  if (total === 12) return { action: upValue >= 4 && upValue <= 6 ? 'stand' : 'hit' };
  return { action: upValue <= 6 ? 'stand' : 'hit' };
};

blackjack.botFallback = () => ({ action: 'stand' });

blackjack.snapshot = function snapshot(table, player) {
  const st = table.state;
  if (!st?.hands) return { phase: 'idle' };
  const dealerCards = st.revealed ? st.dealer : [st.dealer[0]];
  const myHand = st.hands[player.id];
  return {
    phase: st.phase,
    revealed: st.revealed,
    dealer: {
      cards: dealerCards,
      hidden: st.revealed ? 0 : 1,
      total: st.revealed ? handValue(st.dealer).total : null,
      bust: st.revealed && handValue(st.dealer).total > 21,
    },
    canDouble: Boolean(myHand && myHand.status === 'playing' && myHand.cards.length === 2
      && player.chips >= myHand.bet),
    seats: table.seats.map((seat) => {
      const hand = st.hands[seat.playerId];
      const account = playerById(seat.playerId);
      const value = hand ? handValue(hand.cards) : null;
      return {
        username: seat.username,
        isYou: seat.playerId === player.id,
        isBot: Boolean(account?.isBot),
        isTurn: table.turn === seat.playerId,
        stack: account?.chips ?? 0,
        cards: hand ? hand.cards : [],
        total: value ? value.total : null,
        soft: value ? value.soft : false,
        bet: hand ? hand.bet : 0,
        status: hand ? hand.status : 'out',
        result: hand?.result || null,
        won: Boolean(hand?.won),
        pushed: Boolean(hand?.pushed),
      };
    }),
  };
};
