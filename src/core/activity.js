// A ring buffer of everything that reaches the server, so "is my connector
// actually talking to this thing?" has an answer you can look at instead of
// guess at. Kept in memory on purpose: it is a monitor, not game state.

import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage();
export const currentClient = () => requestContext.getStore()?.client || 'unknown';

const MAX = 200;
const entries = [];

let counters = {
  initialize: 0,
  toolsList: 0,
  toolCalls: 0,
  errors: 0,
};

export function record(entry) {
  const row = { at: Date.now(), ...entry };
  entries.unshift(row);
  if (entries.length > MAX) entries.length = MAX;

  if (entry.kind === 'initialize') counters.initialize += 1;
  else if (entry.kind === 'tools/list') counters.toolsList += 1;
  else if (entry.kind === 'tool') counters.toolCalls += 1;
  if (entry.ok === false) counters.errors += 1;

  // One line per event in the deploy logs too -- `railway logs` is the fastest
  // place to watch a connector hand-shake land.
  const who = entry.who ? ` @${entry.who}` : '';
  const detail = entry.detail ? ` ${entry.detail}` : '';
  const status = entry.ok === false ? ' REFUSED' : '';
  console.log(`[${entry.kind}]${who} ${entry.name || ''}${detail}${status} via ${entry.client || 'unknown'}`.replace(/\s+/g, ' '));
  return row;
}

export const recent = (limit = 50) => entries.slice(0, limit);

export const stats = () => ({
  ...counters,
  lastEventAt: entries[0]?.at || null,
  buffered: entries.length,
});

// A short label for whoever is calling: Grok, Claude, curl, our own tests.
export function clientLabel(req) {
  const ua = String(req.get?.('user-agent') || '').toLowerCase();
  const declared = req.body?.params?.clientInfo?.name;
  if (declared) return declared;
  if (ua.includes('grok') || ua.includes('xai')) return 'grok';
  if (ua.includes('claude') || ua.includes('anthropic')) return 'claude';
  if (ua.includes('node')) return 'node';
  if (ua.includes('curl')) return 'curl';
  return ua.split(' ')[0] || 'unknown';
}
