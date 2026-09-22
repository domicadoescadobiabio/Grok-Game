// The connection monitor: every call that reaches the MCP endpoint.
// Answers "is my connector actually talking to this thing?" without
// reading deploy logs.
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
