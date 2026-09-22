// Stateless Streamable-HTTP MCP endpoint.
//
// Grok's custom connectors call a public MCP URL and may not hold a session
// between calls, so a fresh server+transport is built per request and torn down
// after. All game continuity lives in the session token our login tool returns,
// not in the transport.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';
import { config } from '../config.js';
import { record, clientLabel, requestContext } from '../core/activity.js';

export function buildServer() {
  const server = new McpServer(
    { name: 'arcade', version: '0.1.0' },
    {
      instructions: [
        'ARCADE is a card room and chess club played through chat: Texas Hold-em, blackjack and chess, against other real people.',
        'If the player has never played, call create_account and show them the PLAYER ID once. Otherwise call login with their X username and player ID, keep the returned session token for the rest of the conversation, and pass it to every other tool.',
        'Relay the table view verbatim, in a code block -- the board, the cards and the chip counts are the game screen.',
        'Take the players decisions from the player. Never choose a poker action, a chess move, or whether to hit, and never act "for" them to save a round trip. If they are unsure, show the table and the legal options.',
        'Nothing can notify a player when it is their turn, so when they ask whether it is their move, call the table tool and read back the answer rather than guessing from earlier in the conversation.',
      ].join(' '),
    },
  );
  registerTools(server);
  return server;
}

export async function handleMcpRequest(req, res) {
  // Log the handshake before the SDK touches it. When someone adds this server
  // as a connector, initialize + tools/list is exactly what arrives -- so this
  // is the line that answers "did my connector actually connect?".
  const method = req.body?.method;
  const client = clientLabel(req);
  if (method === 'initialize' || method === 'tools/list') {
    record({ kind: method, client });
  }

  // Carried through async calls so a tool handler can name its caller without
  // a module-level global that concurrent requests would trample.
  return requestContext.run({ client }, async () => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] request failed:', err);
      record({ kind: 'error', client, detail: String(err?.message || err).slice(0, 120), ok: false });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });
}

export const mcpUrl = () => `${config.publicUrl.replace(/\/$/, '')}/mcp`;
