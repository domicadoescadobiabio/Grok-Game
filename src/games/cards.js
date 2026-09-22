// A deck, and the shared vocabulary for talking about cards in chat.

import { randomBytes } from 'node:crypto';

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS = ['s', 'h', 'd', 'c'];
export const SUIT_NAME = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
export const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };

export const rankValue = (card) => RANKS.indexOf(card[0]) + 2; // 2..14
export const suitOf = (card) => card[1];

export function freshDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

/**
 * Fisher-Yates using crypto randomness. Card games are exactly where a weak
 * shuffle turns into someone quietly winning every pot.
 */
export function shuffle(deck) {
  const out = [...deck];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32BE(0) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const draw = (deck, n = 1) => deck.splice(0, n);

export const showCard = (card) => `${card[0]}${SUIT_SYMBOL[card[1]]}`;
export const showCards = (cards) => cards.map(showCard).join(' ');

/** Parses "ah", "AH", "A♥", "ace of hearts" into "Ah". Returns null if unclear. */
export function parseCard(input) {
  const text = String(input || '').trim().toLowerCase();
  const bySymbol = text.replace(/[♠]/g, 's').replace(/[♥]/g, 'h')
    .replace(/[♦]/g, 'd').replace(/[♣]/g, 'c');
  const m = bySymbol.match(/^(10|[23456789tjqka])\s*(?:of\s*)?([shdc])/);
  if (!m) return null;
  const rank = m[1] === '10' ? 'T' : m[1].toUpperCase();
  if (!RANKS.includes(rank)) return null;
  return rank + m[2];
}
