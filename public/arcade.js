// The screen: draws whatever /api/state reports, and never acts.
// Served as a static file; see src/web/page.js for how it is wired up.
(() => {
  const SUIT = { s:'\u2660', h:'\u2665', d:'\u2666', c:'\u2663' };
  // The hollow U+2654 set reads as grey once outlined, so both sides use the
  // solid glyphs and colour is what tells them apart.
  const SOLID = { k:'\u265A', q:'\u265B', r:'\u265C', b:'\u265D', n:'\u265E', p:'\u265F' };
  const GLYPH = { w: SOLID, b: SOLID };
  const app = document.getElementById('app');

  // ---------------------------------------------------------------- sound
  //
  // Everything is synthesised in the browser: no audio files to ship, host or
  // wait on. Voices use speech synthesis with a per-player pitch, so a table
  // sounds like several people rather than one robot. Nothing plays until the
  // player turns it on -- browsers block audio before a gesture anyway, and
  // sound that starts by itself is rude.
  const Sound = (() => {
    let ctx = null;
    let on = localStorage.getItem('arcade_sound') === '1';

    // Chrome populates getVoices() asynchronously; asking before it fires
    // returns an empty list and the first line of speech comes out silent.
    let voices = [];
    const loadVoices = () => { voices = window.speechSynthesis?.getVoices() || []; };
    if (window.speechSynthesis) {
      loadVoices();
      window.speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
    }
    const ready = () => {
      if (!on) return null;
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    };

    // A struck-object sound: a short burst of filtered noise.
    function noise(duration, freq, q, gain) {
      const c = ready();
      if (!c) return;
      const frames = Math.floor(c.sampleRate * duration);
      const buf = c.createBuffer(1, frames, c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
      const src = c.createBufferSource();
      src.buffer = buf;
      const filter = c.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq;
      filter.Q.value = q;
      const vol = c.createGain();
      vol.gain.value = gain;
      src.connect(filter).connect(vol).connect(c.destination);
      src.start();
    }

    function tone(freq, duration, type, gain, slideTo) {
      const c = ready();
      if (!c) return;
      const osc = c.createOscillator();
      const vol = c.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, c.currentTime);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, c.currentTime + duration);
      vol.gain.setValueAtTime(0.0001, c.currentTime);
      vol.gain.exponentialRampToValueAtTime(gain || 0.14, c.currentTime + 0.012);
      vol.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + duration);
      osc.connect(vol).connect(c.destination);
      osc.start();
      osc.stop(c.currentTime + duration + 0.02);
    }

    const hash = (str) => {
      let h = 0;
      for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) >>> 0;
      return h;
    };

    return {
      get enabled() { return on; },
      toggle() {
        on = !on;
        localStorage.setItem('arcade_sound', on ? '1' : '0');
        if (on) { ready(); this.chips(2); }
        return on;
      },
      card() { noise(0.09, 2600, 1.1, 0.16); },
      deal(n) { for (let i = 0; i < (n || 2); i++) setTimeout(() => this.card(), i * 130); },
      chips(n) {
        const count = Math.max(1, Math.min(5, n || 2));
        for (let i = 0; i < count; i++) {
          setTimeout(() => noise(0.055, 3200 + Math.random() * 1800, 5, 0.2), i * 55);
        }
      },
      knock() { noise(0.07, 320, 2, 0.28); },          // check: a rap on the table
      bell(urgency) {                                   // countdown, no numbers
        const base = 760 + (urgency || 0) * 190;
        tone(base, 0.16, 'triangle', 0.1);
        setTimeout(() => tone(base * 1.5, 0.12, 'triangle', 0.07), 90);
      },
      win() {
        [0, 1, 2, 3].forEach((i) => setTimeout(
          () => tone([523, 659, 784, 1047][i], 0.32, 'triangle', 0.13), i * 105));
        setTimeout(() => this.chips(5), 260);
      },
      lose() { tone(392, 0.4, 'sine', 0.1, 196); },
      push() { tone(523, 0.18, 'sine', 0.09); },
      /** Say a word in a voice that stays the same for a given player. */
      say(text, who) {
        if (!on || !window.speechSynthesis) return;
        const u = new SpeechSynthesisUtterance(text);
        const h = hash(who || 'dealer');
        u.pitch = 0.75 + (h % 60) / 100;      // 0.75 .. 1.34
        u.rate = 1.05 + ((h >> 6) % 20) / 100;
        u.volume = 0.85;
        if (!voices.length) loadVoices();
        // Prefer the local English voices; picking one per player is what makes
        // a table sound like several people instead of one narrator.
        const pool = voices.filter((v) => /^en/i.test(v.lang));
        const pick = (pool.length ? pool : voices);
        if (pick.length) u.voice = pick[h % pick.length];
        window.speechSynthesis.speak(u);
      },
    };
  })();
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  let session = localStorage.getItem('arcade_session') || '';
  let state = null;
  let error = '';
  let selected = null;   // chess: selected square
  let polling = null;
  let lastSig = '';      // what was on screen last time we drew
  let amtValue = null;   // the raise box, preserved across polls

  // ---------------------------------------------------------------- api
  async function api(path, body) {
    const res = await fetch(path, body ? {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session, ...body }),
    } : {});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'request failed'), { status: res.status });
    return data;
  }

  async function refresh() {
    if (!session) return render();
    try {
      state = await api('/api/state?session=' + encodeURIComponent(session));
      error = '';
    } catch (e) {
      if (e.status === 401) { session = ''; localStorage.removeItem('arcade_session'); }
      else error = e.message;
    }
    render();
  }

  // Everything on screen except the countdown, which ticks every second and
  // would otherwise force a full redraw -- taking the focus and the half-typed
  // raise amount with it.
  function signature() {
    if (!state) return 'none';
    const { secondsLeft, ...table } = state.table || {};
    return JSON.stringify([state.player, table, state.game, selected, error]);
  }

  async function run(fn) {
    try { error = ''; amtValue = null; await fn(); } catch (e) { error = e.message; }
    await refresh();
  }

  // ---------------------------------------------------------------- pieces
  const cardEl = (code, small) => {
    if (!code) return '<div class="card back' + (small ? ' sm' : '') + '"></div>';
    const suit = code[1], red = suit === 'h' || suit === 'd';
    const rank = code[0] === 'T' ? '10' : code[0];
    return '<div class="card' + (red ? ' red' : '') + (small ? ' sm' : '') + '">'
      + '<span>' + rank + SUIT[suit] + '</span>'
      + '<span class="mid">' + SUIT[suit] + '</span>'
      + '<span class="br">' + rank + SUIT[suit] + '</span></div>';
  };
  // Real denominations, tallest column first, so a big bet looks big without
  // drawing four hundred discs.
  const DENOMS = [100, 25, 10, 5, 1];
  function chipStack(amount, showAmount) {
    const n = Math.max(0, Math.round(amount || 0));
    if (!n) return '';
    let left = n;
    const cols = [];
    for (const d of DENOMS) {
      let count = Math.floor(left / d);
      if (!count) continue;
      left -= count * d;
      count = Math.min(count, 8); // taller than this and the column is just noise
      cols.push('<div class="col">' + Array.from({ length: count },
        () => '<div class="chip c' + d + '"></div>').join('') + '</div>');
      if (cols.length >= 4) break;
    }
    if (!cols.length) return '';
    return '<div class="stack">' + cols.join('')
      + (showAmount ? '<span class="amt">' + n + '</span>' : '') + '</div>';
  }

  const hand = (cards, small) => '<div class="hand">' + (cards || []).map(c => cardEl(c, small)).join('') + '</div>';
  const backs = (n, small) => '<div class="hand">' + Array.from({length:n}, () => cardEl(null, small)).join('') + '</div>';


  // ---------------------------------------------------------------- reactions
  let seenLog = null;      // the log line we last reacted to
  let lastBellAt = 0;
  let celebrated = '';     // table+round we have already cheered for

  const ACTION_SOUNDS = [
    [/\bchecks?\b/i,                 'check',  (w) => { Sound.knock(); Sound.say('check', w); }],
    [/\bcalls? (\d+)/i,              'call',   (w) => { Sound.chips(2); Sound.say('call', w); }],
    [/\braises? to (\d+)/i,          'raise',  (w) => { Sound.chips(4); Sound.say('raise', w); }],
    [/\ball-?in\b/i,                 'allin',  (w) => { Sound.chips(5); Sound.say('all in', w); }],
    [/\bfolds?\b/i,                  'fold',   (w) => { Sound.card(); Sound.say('fold', w); }],
    [/\bposts the (small|big) blind/i,'blind',  () => Sound.chips(1)],
    [/\bhits?:/i,                     'hit',    (w) => { Sound.card(); Sound.say('hit', w); }],
    [/\bstands? on\b/i,              'stand',  (w) => Sound.say('stand', w)],
    [/\bdoubles? to\b/i,             'double', (w) => { Sound.chips(4); Sound.say('double', w); }],
    [/^Dealer /i,                      'dealer', () => Sound.deal(1)],
    [/--- (Hand|Round|Game) /i,        'deal',   () => Sound.deal(3)],
    [/\bwins?\b/i,                   'win',    () => {}],   // handled by the banner
    [/\bsits down\b/i,               'sit',    () => Sound.knock()],
  ];

  function reactToLog(log) {
    if (!Sound.enabled) { seenLog = log[0] || null; return; }
    if (seenLog === null) { seenLog = log[0] || null; return; }   // first paint: stay quiet

    const fresh = [];
    for (const line of log) {           // newest first
      if (line === seenLog) break;
      fresh.unshift(line);              // replay in the order they happened
    }
    seenLog = log[0] || seenLog;
    if (!fresh.length) return;

    fresh.slice(-4).forEach((line, i) => {
      const who = (line.match(/^@([\w]+)/) || [])[1] || 'dealer';
      const rule = ACTION_SOUNDS.find(([re]) => re.test(line));
      if (rule) setTimeout(() => rule[2](who), i * 420);
    });
  }

  // A rising chime as the clock runs out -- no numbers, just more insistent.
  function clockSound() {
    const t = state?.table;
    if (!Sound.enabled || !t || !t.isYourTurn || t.secondsLeft == null) return;
    const left = t.secondsLeft;
    if (left > 10 || left <= 0) return;
    const gap = left > 5 ? 2000 : 900;
    if (Date.now() - lastBellAt < gap) return;
    lastBellAt = Date.now();
    Sound.bell(left <= 3 ? 2 : left <= 6 ? 1 : 0);
  }

  function celebrate() {
    const t = state?.table, g = state?.game || {};
    if (!t || t.status !== 'finished') return;
    const key = t.id + ':' + t.round;
    if (celebrated === key) return;
    celebrated = key;

    const me = state.player.username;
    const iWon = t.game === 'chess' ? g.winner === me
      : t.game === 'poker' ? (g.winners || []).some(w => w.username === me)
      : (g.seats || []).some(x => x.isYou && x.won);

    if (iWon) { Sound.win(); confetti(); }
    else if (t.game === 'blackjack' && (g.seats || []).some(x => x.isYou && x.pushed)) Sound.push();
    else Sound.lose();
  }

  function confetti() {
    const colours = ['#d9b06a', '#5fa76a', '#5c8fb8', '#d2564b', '#e6e3dc'];
    for (let i = 0; i < 40; i++) {
      const bit = document.createElement('div');
      bit.className = 'confetti';
      bit.style.left = Math.random() * 100 + 'vw';
      bit.style.background = colours[i % colours.length];
      bit.style.animationDuration = (1.6 + Math.random() * 1.4) + 's';
      bit.style.animationDelay = (Math.random() * 0.4) + 's';
      document.body.appendChild(bit);
      setTimeout(() => bit.remove(), 3400);
    }
  }

  // ---------------------------------------------------------------- views
  function render(force) {
    if (!session) { lastSig = ''; seenLog = null; return renderGate(); }
    if (!state) { app.innerHTML = 'loading…'; return; }

    if (state.table) {
      reactToLog(state.table.log || []);
      celebrate();
      clockSound();
    } else {
      seenLog = null;
      celebrated = '';
    }

    const sig = signature();
    if (!force && sig === lastSig) return tickClock();
    lastSig = sig;

    app.innerHTML = header() + (state.table ? renderTable() : renderPicker()) + errorBar();
    wire();
  }

  // Cheap path: the board is unchanged, only the clock moved.
  function tickClock() {
    clockSound();
    const bar = document.querySelector('.turnbar');
    const t = state.table;
    if (bar && t && t.status === 'playing' && t.secondsLeft != null) {
      const urgent = t.isYourTurn && t.secondsLeft <= 10;
      bar.className = 'turnbar' + (urgent ? ' urgent' : '');
      bar.innerHTML = '<span class="dot' + (t.isYourTurn ? ' on' : '') + '"></span>'
        + (t.isYourTurn ? 'Your turn' : 'Waiting on @' + esc(t.turnUsername))
        + ' &middot; ' + t.secondsLeft + 's';
    }
  }

  const errorBar = () => error ? '<div class="err">' + esc(error) + '</div>' : '';

  const header = () => '<header>'
    + '<span class="logo"><img src="/logo.png" alt="" width="24" height="24">GROK GAME</span>'
    + '<span class="chips">@' + esc(state.player.username) + ' &middot; <b>' + state.player.chips + '</b> chips</span>'
    + '<span class="spacer"></span>'
    + '<button class="snd' + (Sound.enabled ? ' on' : '') + '" data-act="sound">'
    + (Sound.enabled ? '\u266a sound on' : 'sound off') + '</button>'
    + '<button class="ghost" data-act="logout">sign out</button>'
    + '</header>';

  function renderGate() {
    app.innerHTML = '<div class="gate">'
      + '<h1>ARCADE</h1><p>Watch your table while you play in chat.</p>'
      + '<input id="u" placeholder="your X username" autocomplete="off">'
      + '<input id="p" placeholder="player ID" inputmode="numeric" autocomplete="off">'
      + '<button class="btn primary" id="go">watch</button>'
      + errorBar()
      + '<div class="note">No account yet? Ask your AI:<br>'
      + '<code class="say">make me an arcade account</code><br>'
      + 'It hands back the player ID you type here.</div></div>';
    document.getElementById('go').onclick = async () => {
      const u = document.getElementById('u').value.trim().replace(/^@/, '');
      const p = document.getElementById('p').value.trim();
      if (!u) { error = 'Pick a username first.'; return render(); }
      if (!p) { error = 'Enter the player ID your AI gave you.'; return render(true); }
      await run(async () => {
        const r = await api('/api/login', { x_username: u, player_id: p });
        session = r.session;
        localStorage.setItem('arcade_session', session);
      });
    };
  }

  function renderPicker() {
    const games = [
      { title: "Texas Hold'em", blurb: 'No-limit. Two cards each, five on the board.',
        meta: '2-6 players &middot; 30s a turn', say: 'open a poker table', art: hand(['As', 'Kh'], true) },
      { title: 'Blackjack', blurb: 'Beat the dealer without going over 21.',
        meta: '1-5 vs dealer &middot; 15s a turn', say: 'open a blackjack table', art: hand(['Ad', 'Ts'], true) },
      { title: 'Chess', blurb: 'One on one, against a person or the computer.',
        meta: '2 players &middot; 60s a move', say: 'open a chess table',
        art: '<span class="piece w" style="font-size:44px">\u265A</span><span class="piece b" style="font-size:44px">\u265B</span>' },
    ];
    return '<div class="chatbox" style="margin-bottom:18px"><b>This screen only watches</b>'
      + '<div>The arcade is played in your AI chat. Open a table there and it shows up here.</div></div>'
      + '<h2>Say one of these in your chat</h2><div class="picker">'
      + games.map(function (g) {
        return '<div class="gamecard">'
          + '<div class="art">' + g.art + '</div>'
          + '<h3>' + g.title + '</h3><p>' + g.blurb + '</p>'
          + '<div class="meta">' + g.meta + '</div>'
          + '<code class="say" style="margin-top:10px;display:inline-block">' + esc(g.say) + '</code>'
          + '</div>';
      }).join('')
      + '</div>';
  }

  function renderTable() {
    const t = state.table, g = state.game || {};
    const body = t.game === 'poker' ? pokerTable(g)
      : t.game === 'blackjack' ? blackjackTable(g)
      : chessTable(g);
    return '<h2>' + esc(t.title) + ' &middot; table ' + t.id + ' &middot; stake ' + t.stake + '</h2>'
      + body + banner() + turnBar() + controls() + logBox();
  }

  // Shown once a round ends: who won, and what it cost or paid you.
  function banner() {
    const t = state.table, g = state.game || {};
    if (t.status !== 'finished') return '';
    const me = state.player.username;

    if (t.game === 'chess') {
      if (!g.outcome) return '';
      const iWon = g.winner === me;
      return '<div class="banner' + (g.winner && !iWon ? ' lose' : '') + '">'
        + '<div class="big">' + (g.winner ? (iWon ? 'You win' : '@' + esc(g.winner) + ' wins') : 'Drawn') + '</div>'
        + '<div class="sub">' + esc(g.outcome) + '</div></div>';
    }

    if (t.game === 'poker') {
      const winners = g.winners || [];
      if (!winners.length) return '';
      const mine = winners.find(w => w.username === me);
      return '<div class="banner' + (mine ? '' : ' lose') + '">'
        + '<div class="big">' + (mine ? 'You win ' + mine.amount : '@' + esc(winners[0].username) + ' wins ' + winners[0].amount) + '</div>'
        + '<div class="sub">' + esc(winners.map(w => '@' + w.username + ' ' + w.amount + (w.how ? ' with ' + w.how : '')).join('  \u00b7  ')) + '</div></div>';
    }

    const mySeat = (g.seats || []).find(x => x.isYou);
    if (!mySeat || !mySeat.result) return '';
    return '<div class="banner' + (mySeat.won ? '' : (mySeat.pushed ? '' : ' lose')) + '">'
      + '<div class="big">' + (mySeat.won ? 'You win' : mySeat.pushed ? 'Push' : 'Dealer takes it') + '</div>'
      + '<div class="sub">' + esc(mySeat.result) + '</div></div>';
  }

  function turnBar() {
    const t = state.table;
    if (t.status !== 'playing') {
      return '<div class="turnbar"><span class="dot"></span>'
        + (t.seatCount < t.minSeats
          ? 'Needs ' + t.minSeats + ' players — add a computer opponent.'
          : (t.round ? 'Round over.' : 'Ready when you are.')) + '</div>';
    }
    const urgent = t.isYourTurn && t.secondsLeft != null && t.secondsLeft <= 10;
    return '<div class="turnbar' + (urgent ? ' urgent' : '') + '"><span class="dot' + (t.isYourTurn ? ' on' : '') + '"></span>'
      + (t.isYourTurn ? 'Your turn' : 'Waiting on @' + esc(t.turnUsername))
      + (t.secondsLeft != null ? ' &middot; ' + t.secondsLeft + 's' : '') + '</div>';
  }

  // What to type in the chat, instead of buttons. Keeping the exact wording
  // here means a player never has to guess the phrasing.
  function controls() {
    const t = state.table, g = state.game || {};
    const say = (text) => '<code class="say">' + esc(text) + '</code>';

    if (t.status !== 'playing') {
      const lines = [];
      if (t.seatCount < t.minSeats) lines.push('Needs ' + t.minSeats + ' players. Say ' + say('add a computer opponent'));
      else if (t.seatCount < t.maxSeats) lines.push('Say ' + say('add a computer opponent') + ' for another seat.');
      lines.push('Say ' + say(t.game === 'chess' ? 'start the game' : 'deal') + ' when you are ready.');
      return '<div class="chatbox"><b>Play from your chat</b>' + lines.map(function (l) { return '<div>' + l + '</div>'; }).join('') + '</div>';
    }
    if (!t.isYourTurn) return '';

    let options;
    if (t.game === 'poker') {
      options = [g.toCall > 0 ? say('call') : say('check'), say('raise to ' + g.minRaiseTo), say('all in'), say('fold')];
    } else if (t.game === 'blackjack') {
      options = [say('hit'), say('stand')].concat(g.canDouble ? [say('double')] : []);
    } else {
      options = [say('e4'), say('Nf3'), say('resign'), say(g.drawOfferedToYou ? 'accept the draw' : 'offer a draw')];
    }
    const legal = (g.legal || []).slice(0, 8).map(function (m) { return m.san; }).join(', ');
    return '<div class="chatbox"><b>Your turn &mdash; say it in your chat</b>'
      + '<div>' + options.join(' &nbsp; ') + '</div>'
      + (t.game === 'chess' && legal ? '<div class="tip">Any legal move works: ' + esc(legal) + '</div>' : '')
      + '</div>';
  }

  function logBox() {
    const log = state.table.log || [];
    if (!log.length) return '';
    // Chess has its own move list; showing the log too just prints every move
    // twice. Keep it for the finish, which is where the result appears.
    if (state.table.game === 'chess' && state.table.status === 'playing') return '';
    return '<div class="log">' + log.map(l => '<div>' + esc(l) + '</div>').join('') + '</div>';
  }

  // ---------------------------------------------------------------- poker
  function pokerTable(g) {
    if (!g.seats) return '<div class="felt"><div class="pot">Waiting to deal</div></div>';
    const community = (g.board || []).concat(Array(Math.max(0, 5 - (g.board || []).length)).fill(null));
    return '<div class="felt">'
      + '<div class="pot">POT ' + g.pot + (g.phase ? ' &middot; ' + esc(g.phase) : '') + '</div>'
      + '<div class="potchips">' + chipStack(g.pot) + '</div>'
      + '<div class="board">' + community.map(c => c ? cardEl(c) : '<div class="card back" style="opacity:.25"></div>').join('') + '</div>'
      + (g.myHand ? '<div class="pot" style="color:#cfd6d2;font-weight:600">you have ' + esc(g.myHand) + '</div>' : '')
      + '<div class="seats">' + g.seats.map(s => '<div class="seat' + (s.isTurn ? ' turn' : '')
        + (s.folded ? ' folded' : '')
        + ((g.winners || []).some(w => w.username === s.username) ? ' winner' : '') + '">'
        + '<div class="who">@' + esc(s.username)
        + (s.isYou ? '<span class="tag you">you</span>' : '')
        + (s.isBot ? '<span class="tag">cpu</span>' : '')
        + (s.allIn ? '<span class="tag">all in</span>' : '') + '</div>'
        + (s.cards ? hand(s.cards, true) : backs(2, true))
        + chipStack(s.bet, true)
        + '<div class="line">stack ' + s.stack + '</div>'
        + (s.hand ? '<div class="line">' + esc(s.hand) + '</div>' : '')
        + '</div>').join('')
      + '</div></div>';
  }

  // ---------------------------------------------------------------- blackjack
  function blackjackTable(g) {
    if (!g.seats) return '<div class="felt"><div class="pot">Waiting to deal</div></div>';
    const d = g.dealer;
    return '<div class="felt">'
      + '<div class="pot">DEALER' + (d.total != null ? ' &middot; ' + d.total + (d.bust ? ' BUST' : '') : '') + '</div>'
      + '<div class="board">' + (d.cards || []).map(c => cardEl(c)).join('') + (d.hidden ? cardEl(null) : '') + '</div>'
      + '<div class="seats">' + g.seats.map(s => '<div class="seat' + (s.isTurn ? ' turn' : '')
        + (s.status === 'bust' ? ' folded' : '') + (s.won ? ' winner' : '') + '">'
        + '<div class="who">@' + esc(s.username)
        + (s.isYou ? '<span class="tag you">you</span>' : '')
        + (s.isBot ? '<span class="tag">cpu</span>' : '') + '</div>'
        + hand(s.cards, true)
        + chipStack(s.bet, true)
        + '<div class="line">'
        + (s.total != null ? (s.soft ? 'soft ' : '') + s.total : '-')
        + ' &middot; ' + esc(s.status) + '</div>'
        + (s.result ? '<div class="line">' + esc(s.result) + '</div>' : '')
        + '</div>').join('')
      + '</div></div>';
  }

  // ---------------------------------------------------------------- chess
  function chessTable(g) {
    if (!g.board) return '<div class="felt"><div class="pot">Waiting to start</div></div>';
    const flip = g.youAre === 'b';
    const rows = flip ? [...g.board].reverse().map(r => [...r].reverse()) : g.board;
    const targets = selected ? g.legal.filter(m => m.from === selected).map(m => m.to) : [];
    const last = g.lastMove || null;

    let html = '<div class="chessboard">';
    rows.forEach((row, ri) => row.forEach((sq, fi) => {
      const rank = flip ? ri + 1 : 8 - ri;
      const file = String.fromCharCode(97 + (flip ? 7 - fi : fi));
      const name = file + rank;
      const dark = (ri + fi) % 2 === 1;
      const isTarget = targets.includes(name);
      const cls = ['sq', dark ? 'dark' : 'light',
        selected === name ? 'sel' : '',
        isTarget ? 'target' : '',
        isTarget && sq ? 'occupied' : '',
        last && last.from === name ? 'from' : '',
        last && last.to === name ? 'to' : '',
        g.inCheck && sq && sq.type === 'k' && sq.color === g.turnColor ? 'check' : ''].filter(Boolean).join(' ');
      // Files along the bottom edge, ranks up the left -- as printed on a board.
      const coords = (fi === 0 ? '<span class="coord rank">' + rank + '</span>' : '')
        + (ri === 7 ? '<span class="coord file">' + file + '</span>' : '');
      html += '<div class="' + cls + '" data-sq="' + name + '">' + coords
        + (sq ? '<span class="piece ' + sq.color + '">' + GLYPH[sq.color][sq.type] + '</span>' : '')
        + '</div>';
    }));
    html += '</div>';

    const p = g.players;
    html += '<div class="seats" style="margin-top:14px">'
      + ['w','b'].map(c => '<div class="seat' + (g.turnColor === c && state.table.status === 'playing' ? ' turn' : '') + '">'
        + '<div class="who">' + (c === 'w' ? '\u2654 white' : '\u265A black') + ' &middot; @' + esc(p[c].username || '?')
        + (p[c].isYou ? '<span class="tag you">you</span>' : '')
        + (p[c].isBot ? '<span class="tag">cpu</span>' : '') + '</div></div>').join('')
      + '</div>';
    const history = g.history || [];
    if (history.length) {
      html += '<div class="movelist">' + history.slice().reverse().map((h, i) =>
        '<div class="mv' + (i === 0 ? ' last' : '') + '">'
        + '<span class="n">' + h.n + '.</span>'
        + '<span class="side piece ' + h.color + '" style="font-size:13px">\u265F</span>'
        + '<span class="txt">' + esc(h.text) + '</span>'
        + '<span class="san">' + esc(h.san) + '</span></div>').join('') + '</div>';
    }
    return html;
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    app.querySelectorAll('[data-act]').forEach(function (el) {
      el.onclick = function () {
        if (el.dataset.act === 'sound') { Sound.toggle(); return render(true); }
        if (el.dataset.act !== 'logout') return;
        session = '';
        localStorage.removeItem('arcade_session');
        state = null;
        lastSig = '';
        render();
      };
    });
  }

  // Poll whenever we are signed in -- NOT only when it is someone else's turn.
  // The same account can be played from a chat at the same time, so "it is my
  // turn" is not a promise that nothing will change: raising from Grok left
  // this page frozen on the old street, because it had stopped asking.
  function startPolling() {
    clearInterval(polling);
    polling = setInterval(() => { if (session && !document.hidden) refresh(); }, 2000);
    // Coming back to the tab should be instant, not up to two seconds stale.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }

  refresh();
  startPolling();
})();
