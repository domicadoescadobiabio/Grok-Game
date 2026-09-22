// A monitor page, not a game client. Its only job is to answer, in one glance:
// "is my connector actually reaching this server, and what is it sending?"
// It polls /api/activity, so nothing here is part of playing the game.

export function livePage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ARCADE monitor</title>
<style>
  :root { color-scheme: dark; --bg:#0b0c0e; --fg:#d7d3cb; --dim:#6f6a62; --acc:#c8a15a; --ok:#6bbf73; --bad:#d4736a; --line:#23252a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .wrap { max-width: 860px; margin:0 auto; padding: 28px 16px 60px; }
  h1 { font-size:20px; letter-spacing:.16em; color:var(--acc); margin:0 0 2px; }
  .sub { color:var(--dim); margin:0 0 22px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin-bottom:22px; }
  .card { background:#131417; border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
  .card b { display:block; font-size:24px; color:var(--fg); font-weight:600; }
  .card span { color:var(--dim); font-size:11px; letter-spacing:.09em; text-transform:uppercase; }
  .status { display:flex; align-items:center; gap:9px; margin-bottom:18px; padding:11px 14px; border:1px solid var(--line); border-radius:8px; background:#131417; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--dim); flex:none; }
  .dot.on { background:var(--ok); box-shadow:0 0 9px var(--ok); }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:6px 9px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-size:11px; letter-spacing:.09em; text-transform:uppercase; font-weight:600; }
  td.t { color:var(--dim); white-space:nowrap; }
  .tag { display:inline-block; padding:1px 7px; border-radius:4px; background:#1d1f24; color:var(--acc); font-size:12px; }
  .tag.tool { color:#8fb7d8; }
  .tag.err { color:var(--bad); }
  .who { color:var(--ok); }
  .empty { color:var(--dim); padding:26px 9px; text-align:center; }
  code { background:#131417; border:1px solid var(--line); border-radius:4px; padding:1px 5px; color:var(--acc); }
</style>
</head>
<body>
<div class="wrap">
  <h1>ARCADE MONITOR</h1>
  <p class="sub">Every call that reaches the MCP endpoint. Refreshes every 3s.</p>

  <div class="status"><span class="dot" id="dot"></span><span id="statusText">waiting for the first call...</span></div>

  <div class="cards">
    <div class="card"><span>handshakes</span><b id="init">0</b></div>
    <div class="card"><span>tool lists</span><b id="list">0</b></div>
    <div class="card"><span>tool calls</span><b id="calls">0</b></div>
    <div class="card"><span>refused</span><b id="errors">0</b></div>
  </div>

  <table>
    <thead><tr><th>when</th><th>event</th><th>who</th><th>detail</th><th>client</th></tr></thead>
    <tbody id="rows"><tr><td colspan="5" class="empty">nothing yet &mdash; add the connector and say hello to it</td></tr></tbody>
  </table>

  <p class="sub" style="margin-top:26px">
    MCP URL: <code id="mcp"></code>
  </p>
</div>
<script>
  document.getElementById('mcp').textContent = location.origin + '/mcp';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
  };

  async function tick() {
    try {
      const r = await fetch('/api/activity?limit=60');
      const d = await r.json();
      init.textContent = d.stats.initialize;
      list.textContent = d.stats.toolsList;
      calls.textContent = d.stats.toolCalls;
      errors.textContent = d.stats.errors;

      const last = d.stats.lastEventAt;
      const fresh = last && Date.now() - last < 120000;
      dot.className = 'dot' + (fresh ? ' on' : '');
      statusText.textContent = last
        ? (fresh ? 'connector is talking to us right now (last call ' + ago(last) + ')'
                 : 'quiet - last call ' + ago(last))
        : 'waiting for the first call...';

      rows.innerHTML = d.recent.length ? d.recent.map(e => {
        const cls = e.ok === false ? 'tag err' : (e.kind === 'tool' ? 'tag tool' : 'tag');
        const label = e.kind === 'tool' ? e.name : e.kind;
        return '<tr><td class="t">' + ago(e.at) + '</td>'
          + '<td><span class="' + cls + '">' + esc(label) + '</span></td>'
          + '<td class="who">' + (e.who ? '@' + esc(e.who) : '') + '</td>'
          + '<td>' + esc(e.detail || '') + (e.ok === false ? ' <span class="tag err">refused</span>' : '') + '</td>'
          + '<td class="t">' + esc(e.client || '') + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="empty">nothing yet &mdash; add the connector and say hello to it</td></tr>';
    } catch (err) {
      statusText.textContent = 'monitor cannot reach the server';
      dot.className = 'dot';
    }
  }
  tick();
  setInterval(tick, 3000);
</script>
</body>
</html>`;
}
