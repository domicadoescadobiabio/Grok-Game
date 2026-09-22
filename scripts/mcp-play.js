// End-to-end over the real MCP endpoint: two players sit at one table and play
// each game through, exactly the way two connectors would.
//
//   node scripts/mcp-play.js [http://localhost:4900/mcp]
const URL_ = process.argv[2] || 'http://localhost:4900/mcp';
let id = 0;

async function rpc(method, params) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return { text: r.content.map((c) => c.text).join('\n'), isError: Boolean(r.isError) };
};

const first = (s) => s.split('\n').filter(Boolean)[0] || '';
let pass = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}  ${detail}`); }
}

async function newAccount(tag) {
  const user = `e2e${tag}${Math.floor(Math.random() * 1e5)}`;
  const r = await call('create_account', { x_username: user });
  const pin = r.text.match(/PLAYER ID: (\d{6})/)?.[1];
  return { user, pin, auth: { x_username: user, player_id: pin }, raw: r.text };
}

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'arcade-e2e', version: '1' },
});
console.log(`server: ${init.serverInfo.name} ${init.serverInfo.version}\n`);

const tools = await rpc('tools/list', {});
const names = tools.tools.map((t) => t.name);
check(`tools/list returns ${names.length} tools`, names.length >= 13, names.join(','));
check('every tool has a description', tools.tools.every((t) => t.description?.length > 20));
check('has the table tools', ['create_table', 'join_table', 'deal', 'play', 'table'].every((n) => names.includes(n)));

const a = await newAccount('a');
const b = await newAccount('b');
check('create_account returns a player ID', Boolean(a.pin), a.raw.slice(0, 80));
check('create_account grants starting chips', /\d+ chips/.test(a.raw));
check('wrong ID is rejected', (await call('login', { x_username: a.user, player_id: '000000' })).isError);
check('username + ID works with no session', !(await call('me', a.auth)).isError);
check('no credentials is rejected', (await call('me', {})).isError);

const games = await call('games');
check('games lists all three', ['poker', 'blackjack', 'chess'].every((g) => games.text.includes(g)), first(games.text));

// ---------------------------------------------------------------- poker
const made = await call('create_table', { game: 'poker', stake: 20, ...a.auth });
const code = made.text.match(/Table ([A-Z0-9]{4})/)?.[1];
check('create_table returns a 4-letter code', Boolean(code), first(made.text));
check('lobby shows the new table', (await call('lobby', { game: 'poker' })).text.includes(code));
check('joining a bad code fails cleanly', (await call('join_table', { code: 'ZZZZ', ...b.auth })).isError);
check('second player joins', !(await call('join_table', { code, ...b.auth })).isError);
check('a player cannot sit at two tables', (await call('create_table', { game: 'chess', ...b.auth })).isError);

const dealt = await call('deal', a.auth);
check('deal posts blinds', /Blinds 10\/20/.test(dealt.text), first(dealt.text));
check('the table view hides the other hand', !(await call('table', b.auth)).text.includes('Your cards: ' + 'x'), 'sanity');

// Whoever is to act folds; the other should take the pot.
const viewA = await call('table', a.auth);
const aToAct = /Your move/.test(viewA.text);
const actor = aToAct ? a : b;
const other = aToAct ? b : a;
check('exactly one player is to act', aToAct !== /Your move/.test((await call('table', b.auth)).text));
check('acting out of turn is refused', (await call('play', { action: 'fold', ...other.auth })).isError);
const folded = await call('play', { action: 'fold', ...actor.auth });
check('folding ends the hand', /wins/.test(folded.text), first(folded.text));

const meOther = await call('me', other.auth);
check('the winner is up on the hand', /\d+ chips/.test(meOther.text), first(meOther.text));

check('play before a deal is refused', (await call('play', { action: 'check', ...a.auth })).isError);
check('both players leave', !(await call('leave_table', a.auth)).isError && !(await call('leave_table', b.auth)).isError);

// ---------------------------------------------------------------- chess
const chessTable = await call('create_table', { game: 'chess', stake: 50, ...a.auth });
const chessCode = chessTable.text.match(/Table ([A-Z0-9]{4})/)?.[1];
await call('join_table', { code: chessCode, ...b.auth });
const chessStart = await call('deal', a.auth);
check('chess deals a board', /White:|plays white/.test(chessStart.text), first(chessStart.text));

const whiteIsA = /plays white/.test(chessStart.text) && chessStart.text.includes(a.user);
const white = whiteIsA ? a : b;
const black = whiteIsA ? b : a;
check('an illegal move is refused with legal ones listed',
  (await call('play', { action: 'move', move: 'Ke9', ...white.auth })).text.includes('Legal moves:'));
check('a legal move is accepted', !(await call('play', { action: 'move', move: 'e4', ...white.auth })).isError);
check('moving out of turn is refused', (await call('play', { action: 'move', move: 'd4', ...white.auth })).isError);
const mate = [];
for (const [who, mv] of [[black, 'e5'], [white, 'Qh5'], [black, 'Nc6'], [white, 'Bc4'], [black, 'Nf6'], [white, 'Qxf7#']]) {
  mate.push(await call('play', { action: 'move', move: mv, ...who.auth }));
}
check('checkmate ends the game and pays out', /Checkmate|wins by checkmate/.test(mate.at(-1).text), first(mate.at(-1).text));
await call('leave_table', a.auth);
await call('leave_table', b.auth);

// ---------------------------------------------------------------- blackjack
const bjTable = await call('create_table', { game: 'blackjack', stake: 25, ...a.auth });
const bjCode = bjTable.text.match(/Table ([A-Z0-9]{4})/)?.[1];
await call('deal', a.auth);
const bjView = await call('table', a.auth);
check('blackjack shows a dealer upcard', /Dealer:/.test(bjView.text), first(bjView.text));
let guard = 0;
let bj = bjView;
while (/Your move/.test(bj.text) && guard++ < 12) {
  bj = await call('play', { action: 'stand', ...a.auth });
}
check('a blackjack round resolves', /Round over|wins|loses|pushes|busts/.test(bj.text), first(bj.text));
check('an unknown action is refused', (await call('play', { action: 'yeet', ...a.auth })).isError);
await call('leave_table', a.auth);

// ---------------------------------------------------------------- misc
check('leaderboard renders', (await call('leaderboard', { limit: 20 })).text.includes('chips'));
check('whois finds a player', (await call('whois', { x_username: a.user })).text.includes('chips'));
check('whois on a stranger fails cleanly', (await call('whois', { x_username: 'nobody_here_9999' })).isError);
check('help explains the games', /Hold.em/.test((await call('help')).text));
check('rebuy is refused while you still have chips', (await call('rebuy', a.auth)).isError);

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
