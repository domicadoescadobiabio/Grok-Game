import { blackjack } from './blackjack.js';
import { poker } from './poker.js';
import { chess } from './chess.js';
import { chinesePoker } from './chinesepoker.js';
import { domino } from './domino.js';
import { checkers } from './checkers.js';
import { bingo } from './bingo.js';

export const GAMES = { blackjack, poker, chess, chinesepoker: chinesePoker, domino, checkers, bingo };

export const gameList = () => Object.values(GAMES).map((g) => ({
  key: g.key,
  title: g.title,
  blurb: g.blurb,
  players: g.minSeats === g.maxSeats ? `${g.minSeats}` : `${g.minSeats}-${g.maxSeats}`,
  defaultStake: g.defaultStake,
  turnSeconds: g.turnSeconds,
  actions: g.actionHelp,
}));

export const getGame = (key) => GAMES[String(key || '').toLowerCase()] || null;
