// The tool surface. Same two rules as any connector-facing API:
//  1. Stateless auth -- every tool takes a session token OR username + ID.
//  2. Every result is a complete board state, never "ok" with the rest implied.

import { z } from 'zod';
import { config } from '../config.js';
import {
  GameError, createPlayer, login as loginPlayer, authenticate, findByUsername,
  leaderboard, rebuy, playerById,
} from '../core/players.js';
import {
  createTable, joinTable, leaveTable, startRound, act, viewTable, renderTable,
  lobby, gameList, tableSummary, seatBots, clearBots,
} from '../core/engine.js';
import { record, currentClient } from '../core/activity.js';

const authShape = {
  session: z.string().optional().describe('Session token from login. Preferred.'),
  x_username: z.string().optional().describe('The player X/Twitter username. Use with player_id when you have no session.'),
  player_id: z.string().optional().describe('The 6-digit player ID from create_account.'),
};

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });
const auth = (a) => authenticate({ session: a.session, username: a.x_username, player_id: a.player_id });

function guard(name, handler) {
  return async (args = {}) => {
    const who = String(args.x_username || '').replace(/^@/, '') || undefined;
    try {
      const result = await handler(args);
      record({ kind: 'tool', name, who, client: currentClient(), ok: !result?.isError });
      return result;
    } catch (err) {
      record({ kind: 'tool', name, who, client: currentClient(), ok: false });
      if (err instanceof GameError) return fail(err.message);
      console.error('[mcp] tool failed:', err);
      return fail('The house glitched. Try again in a moment.');
    }
  };
}

export function registerTools(server) {
  server.registerTool('help', {
    title: 'How the arcade works',
    description: 'Explain the arcade, the games and the commands. Call this if you have never played.',
    inputSchema: {},
  }, guard('help', async () => text(HELP)));

  server.registerTool('games', {
    title: 'What can I play',
    description: 'List the games, how many players each takes, and the actions each accepts.',
    inputSchema: {},
  }, guard('games', async () => text(
    ['Games in the arcade:', '', ...gameList().map(
      (g) => `${g.title} (${g.key}) -- ${g.blurb}\n  ${g.players} players, default stake ${g.defaultStake}, actions: ${g.actions}`,
    )].join('\n'),
  )));

  server.registerTool('create_account', {
    title: 'Create an account',
    description: 'Create an account for an X username and return its player ID. Only for a player who has never played. The player ID is a password -- show it once and tell them to keep it.',
    inputSchema: { x_username: z.string().describe('X/Twitter username, with or without the @.') },
  }, guard('create_account', async ({ x_username }) => {
    const player = createPlayer(x_username);
    const { session } = loginPlayer(player.username, player.pin);
    return text([
      `Account created for @${player.username}.`,
      `PLAYER ID: ${player.pin}  <- save this, it is how you log in from anywhere.`,
      `Session token (use it for the rest of this conversation): ${session}`,
      '',
      `You start with ${player.chips} chips. Use "games" to see what is on, or "lobby" to find a table.`,
    ].join('\n'));
  }));

  server.registerTool('login', {
    title: 'Log in',
    description: 'Log a player in with their X username and player ID, e.g. "log in to the arcade with account @marcellnode ID 421337".',
    inputSchema: {
      x_username: z.string().describe('X/Twitter username.'),
      player_id: z.string().describe('The 6-digit player ID.'),
    },
  }, guard('login', async ({ x_username, player_id }) => {
    const { player, session } = loginPlayer(x_username, player_id);
    const seat = tableSummary(player);
    return text([
      `Logged in as @${player.username}. Chips: ${player.chips}.`,
      `Session token: ${session}`,
      seat ? `You are seated at table ${seat.id} (${seat.game}, ${seat.status}).` : 'You are not at a table yet.',
    ].join('\n'));
  }));

  server.registerTool('me', {
    title: 'Your account',
    description: 'Chips, record, and which table you are sitting at.',
    inputSchema: { ...authShape },
  }, guard('me', async (args) => {
    const p = auth(args);
    const seat = tableSummary(p);
    return text([
      `@${p.username} -- ${p.chips} chips`,
      `Hands played ${p.stats.handsPlayed}, wins ${p.stats.wins}, losses ${p.stats.losses}, biggest pot ${p.stats.biggestPot}`,
      seat ? `Seated at ${seat.id} (${seat.game}, ${seat.status})` : 'Not seated.',
      p.chips === 0 ? 'You are busted -- use rebuy.' : '',
    ].filter(Boolean).join('\n'));
  }));

  server.registerTool('lobby', {
    title: 'Open tables',
    description: 'List the open tables. Every game has a permanent room that is always there, plus any extra tables people have opened. Optionally filter by game.',
    inputSchema: { game: z.enum(['poker', 'blackjack', 'chess', 'chinesepoker', 'domino', 'checkers', 'bingo']).optional() },
  }, guard('lobby', async ({ game }) => {
    const rows = lobby({ game });
    if (!rows.length) return text('No open tables. Create one with create_table.');
    return text(['Open tables:', '', ...rows.map(
      (t) => `${t.id}  ${t.name.padEnd(20)} ${String(t.players).padStart(2)}/${t.maxSeats} seats  `
        + `stake ${String(t.stake).padStart(3)}  ${t.status.padEnd(8)}`
        + (t.seats.length ? `  ${t.seats.map((u) => '@' + u).join(', ')}` : ''),
    ), '',
      'Sit down with join_table. Give it a 4-letter code to join a specific table --',
      'that is how you join a friend -- or just a game name like "poker" to be put in',
      'whichever room already has people in it.'].join('\n'));
  }));

  server.registerTool('create_table', {
    title: 'Open your own table',
    description: 'Open an EXTRA table and sit down, when the standing rooms are not what you want -- a different stake, or a private game. To play right now, prefer join_table with a game name: every game already has an open room. Share the 4-letter code so friends can join.',
    inputSchema: {
      game: z.enum(['poker', 'blackjack', 'chess', 'chinesepoker', 'domino', 'checkers', 'bingo']),
      stake: z.number().int().positive().optional().describe('Chips per hand (poker: the big blind).'),
      name: z.string().optional(),
      private: z.boolean().optional().describe('Hide it from the lobby; joinable by code only.'),
      ...authShape,
    },
  }, guard('create_table', async (args) => {
    const p = auth(args);
    const table = createTable(p, args.game, { name: args.name, stake: args.stake, isPrivate: args.private });
    return text([
      `Table ${table.id} is open: ${args.game}, stake ${table.stake}.`,
      `Tell your friends: "join arcade table ${table.id}".`,
      '',
      renderTable(table, p),
    ].join('\n'));
  }));

  server.registerTool('join_table', {
    title: 'Sit at a table',
    description: 'Sit down at a table. Give a 4-letter code to join a specific one -- that is how you join a friend -- or just a game name ("poker", "chess", "dominoes") to be seated at an open room for it. Every game always has one.',
    inputSchema: {
      code: z.string().describe('A 4-letter table code like "K7QD", or a game name like "poker".'),
      ...authShape,
    },
  }, guard('join_table', async (args) => {
    const p = auth(args);
    const { table } = joinTable(p, args.code);
    return text(`You sit down at ${table.id}.\n\n${renderTable(table, p)}`);
  }));

  server.registerTool('leave_table', {
    title: 'Leave the table',
    description: 'Stand up. Leaving mid-hand folds or resigns -- it does not get your chips back.',
    inputSchema: { ...authShape },
  }, guard('leave_table', async (args) => {
    const p = auth(args);
    const { tableId, forfeited } = leaveTable(p);
    return text(`You leave table ${tableId}.${forfeited ? ' The hand in progress was forfeited.' : ''} Chips: ${p.chips}.`);
  }));

  server.registerTool('add_computer', {
    title: 'Add a computer opponent',
    description: 'Seat a bot at your table so you can play without waiting for anyone. Ask before the round starts.',
    inputSchema: {
      count: z.number().int().min(1).max(5).optional().describe('How many, default 1.'),
      ...authShape,
    },
  }, guard('add_computer', async (args) => {
    const p = auth(args);
    const { table, added } = seatBots(p, args.count || 1);
    return text(`${added.map((n) => '@' + n).join(', ')} ${added.length === 1 ? 'sits' : 'sit'} down.

${renderTable(table, p)}`);
  }));

  server.registerTool('remove_computers', {
    title: 'Clear the bots',
    description: 'Send every computer opponent away from your table.',
    inputSchema: { ...authShape },
  }, guard('remove_computers', async (args) => {
    const p = auth(args);
    const { table, removed } = clearBots(p);
    return text(`${removed} computer opponent${removed === 1 ? '' : 's'} left.

${renderTable(table, p)}`);
  }));

  server.registerTool('deal', {
    title: 'Start the next round',
    description: 'Deal the next hand (or start the next chess game) at your table. Any seated player can call it.',
    inputSchema: { ...authShape },
  }, guard('deal', async (args) => {
    const p = auth(args);
    const { table, events } = startRound(p);
    return text([...events, '', renderTable(table, p)].join('\n'));
  }));

  server.registerTool('play', {
    title: 'Take your turn',
    description:
      'Make your move. The action depends on the game:\n' +
      '  poker:        fold, check, call, raise (with amount), allin\n' +
      '  blackjack:    hit, stand, double\n' +
      '  chess:        move (with move, e.g. "e4" or "O-O"), resign, draw\n' +
      '  chinesepoker: arrange (with front, middle, back), or auto\n' +
      '  domino:       play (with tile, e.g. "6-3", and optional end left/right), pass\n' +
      '  checkers:     move (with from and to, e.g. from "c3" to "d4"), resign\n' +
      '  bingo:        call\n' +
      'Pass the player\'s intent straight through; do not decide their move for them.',
    inputSchema: {
      action: z.string().describe('fold | check | call | raise | allin | hit | stand | double | move | resign | draw | arrange | auto | play | pass'),
      amount: z.number().int().positive().optional().describe('For poker raises: the total to raise TO.'),
      move: z.string().optional().describe('For chess: algebraic notation, e.g. "Nf3".'),
      from: z.string().optional().describe('For checkers: the square to move from, e.g. "c3".'),
      to: z.string().optional().describe('For checkers: the square to move to, e.g. "d4".'),
      tile: z.string().optional().describe('For domino: the tile, e.g. "6-3".'),
      end: z.enum(['left', 'right']).optional().describe('For domino: which end to play on.'),
      front: z.string().optional().describe('For chinese poker: the 3 front cards, e.g. "As Kd 7c".'),
      middle: z.string().optional().describe('For chinese poker: the 5 middle cards.'),
      back: z.string().optional().describe('For chinese poker: the 5 back cards.'),
      ...authShape,
    },
  }, guard('play', async (args) => {
    const p = auth(args);
    const { table, events } = act(p, args.action, {
      amount: args.amount, move: args.move, from: args.from, to: args.to,
      tile: args.tile, end: args.end,
      front: args.front, middle: args.middle, back: args.back,
    });
    return text([...events, '', renderTable(table, p)].join('\n'));
  }));

  server.registerTool('table', {
    title: 'Look at the table',
    description: 'Show the current table: board, hands, whose turn it is, and the clock. Costs nothing -- call it whenever you need to check whether it is your turn.',
    inputSchema: { ...authShape },
  }, guard('table', async (args) => text(viewTable(auth(args)))));

  server.registerTool('rebuy', {
    title: 'Top up a busted stack',
    description: `Get ${config.rebuyChips} chips back after going broke. Once every ${config.rebuyCooldownMinutes} minutes.`,
    inputSchema: { ...authShape },
  }, guard('rebuy', async (args) => {
    const p = auth(args);
    const chips = rebuy(p);
    return text(`Topped up. You have ${chips} chips.`);
  }));

  server.registerTool('leaderboard', {
    title: 'Biggest stacks',
    description: 'Top players by chips.',
    inputSchema: { limit: z.number().int().min(1).max(25).optional() },
  }, guard('leaderboard', async ({ limit }) => {
    const rows = leaderboard(limit || 10);
    if (!rows.length) return text('Nobody has played yet.');
    return text(['Biggest stacks:', ...rows.map(
      (r, i) => `${i + 1}. @${r.username} -- ${r.chips} chips (${r.wins} wins in ${r.handsPlayed} hands, biggest pot ${r.biggestPot})`,
    )].join('\n'));
  }));

  server.registerTool('whois', {
    title: 'Look up a player',
    description: 'Public record for any player by X username.',
    inputSchema: { x_username: z.string() },
  }, guard('whois', async ({ x_username }) => {
    const p = findByUsername(x_username);
    if (!p) return fail(`No account for @${String(x_username).replace(/^@/, '')}.`);
    return text(`@${p.username} -- ${p.chips} chips, ${p.stats.wins} wins in ${p.stats.handsPlayed} hands, biggest pot ${p.stats.biggestPot}.`);
  }));
}

const HELP = `${config.siteName} -- a card room and chess club you play by talking.

FIRST TIME
  create_account with the player's X username -> a PLAYER ID. Save it.
  You start with ${config.startingChips} chips. Busted? rebuy gives ${config.rebuyChips} back.
LATER, ANYWHERE
  login with the X username + player ID -> a session token for this chat.

FINDING A GAME
  Every game has a room that is always open. You do not have to make one.
  lobby            who is where, right now
  join_table       sit down -- a 4-letter code, or just "poker" / "chess"
  add_computer     fill the empty seats with house bots
  create_table     only if you want your own stake, or a private game
  games            what is on

PLAYING
  deal             start the next hand
  play             take your turn
  table            look at the board -- free, call it any time
  leave_table      stand up (mid-hand this folds or resigns)

THE GAMES
  Texas Hold'em  2-6.  fold / check / call / raise <amount> / allin     30s
  Blackjack      1-5.  hit / stand / double                            15s
  Chess          2.    move <notation> / resign / draw                 60s
  Chinese Poker  2-4.  arrange three rows, or "auto"                   120s
  Dominoes       2-4.  play <tile> [left|right] / pass                 30s
  Checkers       2.    move <from> <to> / resign                       60s
  Bingo          2-6.  call                                            30s

HOW TURNS WORK
  Everyone plays from their own chat, so nobody can be interrupted mid-thought.
  Nothing can tap you on the shoulder when it is your turn -- call "table" to
  check. You get ${config.turnSeconds} seconds; run out and poker folds you,
  blackjack stands, and chess awards the game to your opponent.`;
