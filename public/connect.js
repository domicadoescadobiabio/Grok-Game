// The connect page.
//
// xAI publishes no deep link that prefills a connector, so "one click" here
// means: put the URL on the clipboard and open the connectors page in the same
// gesture. The paste is the one step that cannot be automated away.

(() => {
  const MCP_URL = location.origin + '/mcp';
  const CONNECTORS = 'https://grok.com/connectors';

  const urlBox = document.getElementById('url');
  const copied = document.getElementById('copied');
  urlBox.value = MCP_URL;

  async function copy() {
    try {
      await navigator.clipboard.writeText(MCP_URL);
      return true;
    } catch {
      // Clipboard API needs a secure context and permission; selecting the text
      // at least leaves it one keystroke away.
      urlBox.focus();
      urlBox.select();
      try { return document.execCommand('copy'); } catch { return false; }
    }
  }

  function flash(message) {
    copied.textContent = message;
    copied.hidden = false;
  }

  document.getElementById('go').onclick = async () => {
    const ok = await copy();
    flash(ok
      ? 'Copied. Paste it into New Connector → Custom.'
      : 'Copy the URL below, then paste it into New Connector → Custom.');
    // Opened after the copy so the clipboard write happens inside the gesture.
    window.open(CONNECTORS, '_blank', 'noopener');
  };

  document.getElementById('copy').onclick = async () => {
    flash(await copy() ? 'Copied.' : 'Select the URL and copy it.');
  };

  // The game list comes from the server so this page cannot drift out of date.
  fetch('/api/games')
    .then((r) => r.json())
    .then(({ games }) => {
      document.getElementById('games').innerHTML = games.map((g) =>
        '<span class="game"><b>' + esc(g.title) + '</b>'
        + '<span>' + esc(g.players) + ' &middot; ' + g.turnSeconds + 's</span></span>').join('');
    })
    .catch(() => { /* the page still works without it */ });

  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
})();
