// HTTP surface. Two front doors to one engine: a visual web client at /play,
// and an MCP endpoint for playing from a chat. Both call the same functions in
// core/engine.js, so a game cannot behave differently depending on the door.

import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { handleMcpRequest, mcpUrl } from './mcp/server.js';
import {
  db, leaderboard, findByUsername, flush, login as loginPlayer,
  authenticate, GameError,
} from './core/players.js';
import { lobby, gameList, snapshot } from './core/engine.js';
import { recent, stats } from './core/activity.js';
import { livePage } from './web/live.js';
import { appPage } from './web/app.js';

const app = express();
app.set('trust proxy', 1);
app.use(cors({
  exposedHeaders: ['mcp-session-id'],
  allowedHeaders: ['content-type', 'mcp-session-id', 'authorization', 'mcp-protocol-version'],
}));
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    site: config.siteName,
    players: Object.keys(db.players).length,
    tables: Object.keys(db.tables).length,
    uptime: Math.round(process.uptime()),
  });
});

app.post('/mcp', handleMcpRequest);
app.get('/mcp', (_req, res) => res.status(405).json({
  jsonrpc: '2.0',
  error: { code: -32000, message: 'This MCP server is stateless. Use POST.' },
  id: null,
}));
app.delete('/mcp', (_req, res) => res.status(405).end());

app.get('/api/games', (_req, res) => res.json({ games: gameList() }));
app.get('/api/lobby', (req, res) => res.json({ tables: lobby({ game: req.query.game }) }));
app.get('/api/leaderboard', (req, res) =>
  res.json({ leaderboard: leaderboard(Math.min(50, Number(req.query.limit) || 10)) }));

app.get('/api/player/:username', (req, res) => {
  const p = findByUsername(req.params.username);
  if (!p) return res.status(404).json({ error: 'no such player' });
  res.json({ username: p.username, chips: p.chips, stats: p.stats, seatedAt: p.seatedAt });
});

// Monitoring: tells a connected connector from a silent one without guessing.
app.get('/api/activity', (req, res) =>
  res.json({ stats: stats(), recent: recent(Math.min(200, Number(req.query.limit) || 50)) }));

app.get('/live', (_req, res) => res.type('html').send(livePage()));

// ---------------------------------------------------------------- web screen
//
// READ ONLY BY DESIGN. The arcade is played through an AI connector; the
// browser is a screen you can leave open beside the chat, not a second set of
// controls. Only login and state live here -- there is no endpoint that can
// deal a hand, take a turn, or move chips, so the two surfaces cannot disagree
// about who did what.

const sendError = (res, err) => {
  if (err instanceof GameError) {
    const status = ['no_session', 'unauthenticated', 'bad_pin', 'no_account'].includes(err.code) ? 401 : 400;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  console.error('[web]', err);
  return res.status(500).json({ error: 'server error' });
};

const withPlayer = (handler) => (req, res) => {
  try {
    const player = authenticate({ session: req.body?.session || req.query?.session });
    return handler(req, res, player);
  } catch (err) {
    return sendError(res, err);
  }
};

app.get('/play', (_req, res) => res.type('html').send(appPage()));


app.post('/api/login', (req, res) => {
  try {
    const { player, session } = loginPlayer(req.body?.x_username, req.body?.player_id);
    res.json({ session, username: player.username, chips: player.chips });
  } catch (err) { sendError(res, err); }
});

app.get('/api/state', withPlayer((_req, res, player) => res.json(snapshot(player))));








app.get('/', (_req, res) => {
  res.type('text/plain').send([
    `${config.siteName} -- poker, blackjack and chess.`,
    '',
    'Played entirely through an AI connector. The browser is a screen, not a',
    `controller: open ${config.publicUrl.replace(/\/$/, '')}/play beside your chat to watch the table.`,
    '',
    'TO PLAY --',
    '',
    '1. grok.com/connectors -> New Connector -> Custom',
    `2. paste this MCP server URL:  ${mcpUrl()}`,
    '3. say: make me an arcade account, my X username is @yourname',
    '4. it gives you a PLAYER ID. Keep it. From any chat, on any device:',
    '     log in to the arcade with account @yourname ID 421337',
    '',
    'Then: "open a poker table", "add a computer opponent", "deal".',
    'Share the 4-letter code and friends join from their own chat.',
    '',
    'Checking whether your connector reached us?  /live',
  ].join('\n'));
});

const server = app.listen(config.port, () => {
  console.log(`${config.siteName} listening on :${config.port}`);
  console.log(`MCP endpoint: ${mcpUrl()}`);
  console.log(`save file:    ${config.dataFile}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flush();
    server.close(() => process.exit(0));
  });
}
