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

  async function copyText(value, fallbackInput) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // The Clipboard API needs a secure context and permission. Fall back to
      // a throwaway input so this still works over plain http and in older
      // browsers, and leave the text selected either way.
      const input = fallbackInput || Object.assign(document.createElement('input'), {
        value,
        readOnly: true,
        style: 'position:fixed;top:-100px;opacity:0',
      });
      if (!fallbackInput) document.body.appendChild(input);
      input.focus();
      input.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      if (!fallbackInput) input.remove();
      return ok;
    }
  }

  const copy = () => copyText(MCP_URL, urlBox);

  // The line under the button is the only place feedback can go, so it holds
  // the instruction until there is something better to say.
  const RESTING = copied.innerHTML;
  let settle;
  function flash(message) {
    copied.textContent = message;
    clearTimeout(settle);
    settle = setTimeout(() => { copied.innerHTML = RESTING; }, 4000);
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

  // The contract address. The whole pill is the button, and the label is what
  // reports back -- there is nowhere else on the page for the feedback to go.
  const caBtn = document.getElementById('ca');
  if (caBtn) {
    const act = document.getElementById('ca-act');
    const addr = caBtn.querySelector('.ca-addr');
    const full = caBtn.dataset.ca;
    let restore;

    // Too narrow for all 44 characters? Drop the middle, not the end. Both
    // ends are what somebody compares against a listing -- and on a pump.fun
    // address the last four are the whole point.
    function fit() {
      addr.textContent = full;
      if (addr.scrollWidth <= addr.clientWidth) return;
      for (let keep = 18; keep >= 4; keep--) {
        addr.textContent = full.slice(0, keep) + '…' + full.slice(-keep);
        if (addr.scrollWidth <= addr.clientWidth) return;
      }
    }
    fit();
    addEventListener('resize', fit);
    caBtn.onclick = async () => {
      const ok = await copyText(caBtn.dataset.ca);
      act.textContent = ok ? 'copied' : 'press ctrl+c';
      caBtn.classList.toggle('done', ok);
      clearTimeout(restore);
      restore = setTimeout(() => {
        act.textContent = 'copy';
        caBtn.classList.remove('done');
      }, 1800);
    };
  }

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
