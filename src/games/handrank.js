// Seven-card poker hand evaluation.
//
// Returns a comparable score plus the five cards that made it, so a showdown
// can both pick the winner and explain itself. The score is a single integer:
//
//   category * 15^5 + kicker1 * 15^4 + ... + kicker5
//
// Categories run 0 (high card) to 8 (straight flush), and every tiebreak is a
// card value from 2..14, so lexicographic comparison of the kickers falls out
// of ordinary integer comparison. Split pots are then just equal scores.

import { RANKS, rankValue, suitOf } from './cards.js';

export const CATEGORIES = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
];

const BASE = 15;
const score = (category, kickers) =>
  kickers.slice(0, 5).reduce((acc, k) => acc * BASE + k, category) * Math.pow(BASE, Math.max(0, 5 - kickers.length));

/** Highest straight in a set of distinct values, or 0. Handles the wheel. */
function straightHigh(values) {
  const set = new Set(values);
  if (set.has(14)) set.add(1); // ace plays low for A-2-3-4-5
  const sorted = [...set].sort((a, b) => b - a);
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] - 1) {
      run += 1;
      if (run >= 5) return sorted[i] + 4;
    } else {
      run = 1;
    }
  }
  return 0;
}

/**
 * Evaluate the best five-card hand out of any number of cards (5, 6 or 7).
 * @returns {{score:number, category:string, categoryRank:number, cards:string[], label:string}}
 */
export function evaluate(cards) {
  if (!Array.isArray(cards) || cards.length < 5) {
    throw new Error(`evaluate needs at least 5 cards, got ${cards?.length}`);
  }

  const byValue = new Map(); // value -> [cards]
  const bySuit = new Map();  // suit  -> [cards]
  for (const card of cards) {
    const v = rankValue(card);
    const s = suitOf(card);
    if (!byValue.has(v)) byValue.set(v, []);
    if (!bySuit.has(s)) bySuit.set(s, []);
    byValue.get(v).push(card);
    bySuit.get(s).push(card);
  }

  const values = [...byValue.keys()].sort((a, b) => b - a);
  const flushSuit = [...bySuit.entries()].find(([, cs]) => cs.length >= 5)?.[0] || null;

  // Straight flush -- checked against the flush suit only, since five cards of
  // one suit cannot also form a straight in another.
  if (flushSuit) {
    const suited = bySuit.get(flushSuit);
    const high = straightHigh(suited.map(rankValue));
    if (high) {
      return done(8, [high], pickStraight(suited, high));
    }
  }

  const counts = values.map((v) => ({ v, n: byValue.get(v).length }));
  const quads = counts.filter((c) => c.n === 4).map((c) => c.v);
  const trips = counts.filter((c) => c.n === 3).map((c) => c.v);
  const pairs = counts.filter((c) => c.n === 2).map((c) => c.v);

  if (quads.length) {
    const v = quads[0];
    const kicker = values.find((x) => x !== v);
    return done(7, [v, kicker], [...byValue.get(v), byValue.get(kicker)[0]]);
  }

  if (trips.length && (pairs.length || trips.length > 1)) {
    const three = trips[0];
    const pairValue = trips.length > 1 ? Math.max(...trips.slice(1)) : pairs[0];
    const pairCards = byValue.get(pairValue).slice(0, 2);
    return done(6, [three, pairValue], [...byValue.get(three), ...pairCards]);
  }

  if (flushSuit) {
    const suited = bySuit.get(flushSuit)
      .sort((a, b) => rankValue(b) - rankValue(a))
      .slice(0, 5);
    return done(5, suited.map(rankValue), suited);
  }

  const straight = straightHigh(values);
  if (straight) {
    return done(4, [straight], pickStraight(cards, straight));
  }

  if (trips.length) {
    const v = trips[0];
    const kickers = values.filter((x) => x !== v).slice(0, 2);
    return done(3, [v, ...kickers], [...byValue.get(v), ...kickers.map((k) => byValue.get(k)[0])]);
  }

  if (pairs.length >= 2) {
    const [hi, lo] = pairs.slice(0, 2);
    const kicker = values.find((x) => x !== hi && x !== lo);
    return done(2, [hi, lo, kicker], [
      ...byValue.get(hi).slice(0, 2), ...byValue.get(lo).slice(0, 2), byValue.get(kicker)[0],
    ]);
  }

  if (pairs.length === 1) {
    const v = pairs[0];
    const kickers = values.filter((x) => x !== v).slice(0, 3);
    return done(1, [v, ...kickers], [
      ...byValue.get(v).slice(0, 2), ...kickers.map((k) => byValue.get(k)[0]),
    ]);
  }

  const top = values.slice(0, 5);
  return done(0, top, top.map((v) => byValue.get(v)[0]));

  function done(category, kickers, best) {
    return {
      score: score(category, kickers),
      category: CATEGORIES[category],
      categoryRank: category,
      cards: best,
      label: describe(category, kickers),
    };
  }
}

// Pull the actual cards forming a straight that ends at `high`.
function pickStraight(cards, high) {
  const out = [];
  for (let v = high; v > high - 5; v--) {
    const want = v === 1 ? 14 : v; // the wheel's ace
    const card = cards.find((c) => rankValue(c) === want && !out.includes(c));
    if (card) out.push(card);
  }
  return out;
}

const name = (v) => RANKS[Math.max(0, v - 2)] || '?';

function describe(category, k) {
  switch (category) {
    case 8: return k[0] === 14 ? 'Royal Flush' : `Straight Flush, ${name(k[0])} high`;
    case 7: return `Four ${name(k[0])}s`;
    case 6: return `Full House, ${name(k[0])}s over ${name(k[1])}s`;
    case 5: return `Flush, ${name(k[0])} high`;
    case 4: return `Straight, ${name(k[0])} high`;
    case 3: return `Three ${name(k[0])}s`;
    case 2: return `Two Pair, ${name(k[0])}s and ${name(k[1])}s`;
    case 1: return `Pair of ${name(k[0])}s`;
    default: return `${name(k[0])} high`;
  }
}

/** Compare two evaluations: positive when `a` wins. */
export const compareHands = (a, b) => a.score - b.score;

// ---------------------------------------------------------------- three cards

/**
 * Three-card hands, for the front row in Chinese poker. Only three categories
 * exist there -- no straights or flushes are counted, which is the standard
 * rule and also why this cannot reuse `evaluate`.
 */
export function evaluate3(cards) {
  if (cards.length !== 3) throw new Error(`evaluate3 needs 3 cards, got ${cards.length}`);
  const values = cards.map(rankValue).sort((a, b) => b - a);
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);

  const trips = [...counts.entries()].find(([, n]) => n === 3);
  if (trips) {
    return { score: score3(3, [trips[0]]), category: 'Three of a Kind', label: `Three ${name3(trips[0])}s`, cards };
  }
  const pair = [...counts.entries()].find(([, n]) => n === 2);
  if (pair) {
    const kicker = values.find((v) => v !== pair[0]);
    return { score: score3(1, [pair[0], kicker]), category: 'Pair', label: `Pair of ${name3(pair[0])}s`, cards };
  }
  return { score: score3(0, values), category: 'High Card', label: `${name3(values[0])} high`, cards };
}

const score3 = (category, kickers) =>
  kickers.slice(0, 3).reduce((acc, k) => acc * 15 + k, category) * Math.pow(15, Math.max(0, 3 - kickers.length));

const name3 = (v) => RANKS[Math.max(0, v - 2)] || '?';
