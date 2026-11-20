/* Game Review Desk: chess.com games + local Stockfish review. */
'use strict';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const DRAW_CODES = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);
const TC_ORDER = ['rapid', 'blitz', 'bullet', 'daily'];
const TC_COLOR = { rapid: 'var(--s1)', blitz: 'var(--s2)', bullet: 'var(--s3)', daily: 'var(--s4)' };
const TC_LABEL = { rapid: 'Rapid', blitz: 'Blitz', bullet: 'Bullet', daily: 'Daily' };
const CLS = {
  best:       { label: 'Best',       sym: '★', desc: 'the engine’s top choice' },
  excellent:  { label: 'Excellent',  sym: '!', desc: 'almost as good as the best move' },
  good:       { label: 'Good',       sym: '✓', desc: 'a solid move' },
  inaccuracy: { label: 'Inaccuracy', sym: '?!', desc: 'gave away a little' },
  mistake:    { label: 'Mistake',    sym: '?', desc: 'gave away a real chunk of the advantage' },
  blunder:    { label: 'Blunder',    sym: '??', desc: 'a serious error' },
  forced:     { label: 'Forced',     sym: '→', desc: 'the only legal move' },
};
const CLS_ORDER = ['best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder'];
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟︎' };

const S = {
  user: '', games: [], archives: [], archiveIdx: -1, stats: null,
  tc: null, current: null, ply: 0, flip: false,
  analyses: new Map(), pending: new Map(), engine: null, batchRunning: false,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage full or blocked */ } },
};
const depth = () => +$('depth').value;
const fmtDate = (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDateLong = (t) => new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/* ---------------- math ---------------- */
const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
const moveAcc = (loss) => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
function evalWp(e) { // white win % for an eval in white's POV
  if (e.term) return e.term === 'w' ? 100 : e.term === 'b' ? 0 : 50;
  if (e.mate != null) return e.mate > 0 ? 100 : 0;
  return winPct(e.cp);
}
function evalCp(e) { // clamped centipawns, white POV
  if (e.term) return e.term === 'w' ? 1000 : e.term === 'b' ? -1000 : 0;
  if (e.mate != null) return e.mate > 0 ? 1000 : -1000;
  return Math.max(-1000, Math.min(1000, e.cp));
}
function fmtEval(e) {
  if (!e) return '';
  if (e.term) return e.term === 'd' ? '½-½' : e.term === 'w' ? '1-0' : '0-1';
  if (e.mate != null) return (e.mate > 0 ? '+M' : '−M') + Math.abs(e.mate);
  const v = e.cp / 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

/* ---------------- chess.com API ---------------- */
async function getJSON(url) {
  let r;
  try { r = await fetch(url); } catch (e) { throw new Error('Could not reach chess.com. Check your connection.'); }
  if (r.status === 404) throw new Error('not-found');
  if (r.status === 429) throw new Error('chess.com is rate limiting requests. Wait a minute and try again.');
  if (!r.ok) throw new Error('chess.com API returned ' + r.status);
  return r.json();
}

function normGame(g) {
  if (!g.pgn || (g.rules && g.rules !== 'chess')) return null;
  const meWhite = g.white.username.toLowerCase() === S.user;
  const me = meWhite ? g.white : g.black, opp = meWhite ? g.black : g.white;
  const res = me.result === 'win' ? 'W' : DRAW_CODES.has(me.result) ? 'D' : 'L';
  return {
    url: g.url, pgn: g.pgn, end: g.end_time, tc: g.time_class, rated: g.rated !== false,
    color: meWhite ? 'w' : 'b', res,
    me: { name: me.username, rating: me.rating, result: me.result },
    opp: { name: opp.username, rating: opp.rating, result: opp.result },
    white: g.white, black: g.black,
  };
}

async function loadUser(name) {
  S.user = name.trim().toLowerCase();
  S.games = []; S.current = null; S.archiveIdx = -1; S.tc = null;
  ['ratingsCard', 'recentCard', 'historyCard', 'gamesCard', 'reviewCard'].forEach((id) => $(id).classList.add('hidden'));
  setStatus('Loading ' + esc(name) + ' from chess.com…');
  let profile, stats, arch;
  try {
    [profile, stats, arch] = await Promise.all([
      getJSON('https://api.chess.com/pub/player/' + encodeURIComponent(S.user)),
      getJSON('https://api.chess.com/pub/player/' + encodeURIComponent(S.user) + '/stats'),
      getJSON('https://api.chess.com/pub/player/' + encodeURIComponent(S.user) + '/games/archives'),
    ]);
  } catch (e) {
    setStatus(e.message === 'not-found' ? 'No chess.com player called “' + esc(name) + '”. Check the spelling.' : esc(e.message), true);
    return;
  }
  store.set('grd:lastUser', name.trim());
  history.replaceState(null, '', '?u=' + encodeURIComponent(name.trim()));
  S.stats = stats;
  S.profile = profile;
  S.archives = arch.archives || [];
  S.archiveIdx = S.archives.length;
  // Pull months (newest first) until there are enough games for a useful history.
  while (S.archiveIdx > 0 && S.games.length < 40 && S.archives.length - S.archiveIdx < 3) {
    await loadOlderMonth(false);
  }
  if (!S.games.length) {
    setStatus('No standard chess games found in the last few months for ' + esc(name) + '.', true);
    renderRatings();
    return;
  }
  hideStatus();
  pickDefaultTc();
  renderAll();
}

async function loadOlderMonth(render = true) {
  if (S.archiveIdx <= 0) return;
  S.archiveIdx--;
  const url = S.archives[S.archiveIdx];
  if (render) $('loadOlder').disabled = true;
  try {
    const data = await getJSON(url);
    const got = (data.games || []).map(normGame).filter(Boolean);
    const seen = new Set(S.games.map((g) => g.url));
    S.games.push(...got.filter((g) => !seen.has(g.url)));
    S.games.sort((a, b) => b.end - a.end);
  } catch (e) {
    setStatus('Could not load ' + esc(url.split('/').slice(-2).join('/')) + ': ' + esc(e.message), true);
  }
  if (render) renderAll();
}

function pickDefaultTc() {
  const counts = {};
  S.games.slice(0, 30).forEach((g) => (counts[g.tc] = (counts[g.tc] || 0) + 1));
  S.tc = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 'rapid';
}

/* ---------------- engine ---------------- */
class Engine {
  constructor() {
    const blob = new Blob([window.STOCKFISH_SRC], { type: 'application/javascript' });
    this.w = new Worker(URL.createObjectURL(blob));
    this.listener = null;
    this.queue = Promise.resolve();
    this.w.onmessage = (e) => { const line = String(e.data); if (this.listener) this.listener(line); };
    this.send('uci');
    this.send('setoption name Hash value 32');
    this.send('isready');
  }
  send(c) { this.w.postMessage(c); }
  newGame() { this.send('ucinewgame'); }
  analyse(fen, d) {
    const run = () => new Promise((resolve) => {
      const stm = fen.split(' ')[1];
      const sgn = stm === 'w' ? 1 : -1;
      let last = {};
      this.listener = (line) => {
        if (line.startsWith('info') && line.includes(' score ') && !line.includes('bound')) {
          const m = line.match(/score (cp|mate) (-?\d+)/);
          const pv = line.match(/ pv (\S+)/);
          if (m) last = m[1] === 'cp' ? { cp: sgn * +m[2] } : { mate: sgn * +m[2] };
          if (pv) last.best = pv[1];
        } else if (line.startsWith('bestmove')) {
          this.listener = null;
          const bm = line.split(' ')[1];
          if (bm && bm !== '(none)') last.best = bm;
          resolve(last);
        }
      };
      this.send('position fen ' + fen);
      this.send('go depth ' + d);
    });
    this.queue = this.queue.then(run, run);
    return this.queue;
  }
}
function engine() { if (!S.engine) S.engine = new Engine(); return S.engine; }

/* ---------------- analysis ---------------- */
const akey = (g, d = depth()) => g.url + '|' + d;

function parseGame(game) {
  const c = new Chess();
  if (!c.load_pgn(game.pgn, { sloppy: true })) throw new Error('Could not read this game’s moves.');
  const hist = c.history({ verbose: true });
  const startFen = (c.header() || {}).FEN || START_FEN;
  const r = new Chess(startFen);
  const fens = [r.fen()];
  const moves = [];
  for (const m of hist) {
    const before = r.fen();
    const legal = r.moves().length;
    const mv = r.move({ from: m.from, to: m.to, promotion: m.promotion });
    moves.push({ san: mv.san, from: mv.from, to: mv.to, uci: mv.from + mv.to + (mv.promotion || ''), color: mv.color, fenBefore: before, forced: legal === 1 });
    fens.push(r.fen());
  }
  return { startFen, fens, moves };
}

function terminalEval(fen) {
  const t = new Chess(fen);
  if (t.in_checkmate()) return { term: t.turn() === 'w' ? 'b' : 'w' };
  if (t.in_stalemate() || t.insufficient_material()) return { term: 'd' };
  return null;
}

function buildAnalysis(game, parsed, evals, d) {
  const plies = parsed.moves.map((m, i) => {
    const eb = evals[i], ea = evals[i + 1];
    const sign = m.color === 'w' ? 1 : -1;
    const wpB = evalWp(eb), wpA = evalWp(ea);
    const moverB = m.color === 'w' ? wpB : 100 - wpB;
    const moverA = m.color === 'w' ? wpA : 100 - wpA;
    const loss = Math.max(0, moverB - moverA);
    const cpl = Math.max(0, sign * (evalCp(eb) - evalCp(ea)));
    let cls;
    if (m.forced) cls = 'forced';
    else if (eb.best && eb.best === m.uci) cls = 'best';
    else if (loss < 2) cls = 'excellent';
    else if (loss < 5) cls = 'good';
    else if (loss < 10) cls = 'inaccuracy';
    else if (loss < 20) cls = 'mistake';
    else cls = 'blunder';
    let bestSan = null;
    if (eb.best && eb.best !== m.uci) {
      try {
        const t = new Chess(m.fenBefore);
        const bm = t.move({ from: eb.best.slice(0, 2), to: eb.best.slice(2, 4), promotion: eb.best[4] });
        if (bm) bestSan = bm.san;
      } catch (e) { /* ignore */ }
    }
    return { ...m, evalBefore: eb, evalAfter: ea, wpBefore: wpB, wpAfter: wpA, loss, cpl, cls, acc: m.forced ? null : moveAcc(loss), bestSan };
  });
  const side = (c) => {
    const ps = plies.filter((p) => p.color === c);
    const accs = ps.filter((p) => p.acc != null).map((p) => p.acc);
    const counts = {};
    CLS_ORDER.concat('forced').forEach((k) => (counts[k] = 0));
    ps.forEach((p) => counts[p.cls]++);
    let accuracy = null;
    if (accs.length) {
      const harm = accs.length / accs.reduce((s, a) => s + 1 / Math.max(a, 1), 0);
      accuracy = (mean(accs) + harm) / 2;
    }
    return { accuracy, acpl: ps.length ? mean(ps.map((p) => p.cpl)) : null, counts, moves: ps.length };
  };
  return { depth: d, evals, plies, fens: parsed.fens, w: side('w'), b: side('b') };
}

function cachedAnalysis(game, d = depth()) {
  const k = akey(game, d);
  if (S.analyses.has(k)) return S.analyses.get(k);
  const raw = store.get('grd:v1:' + k);
  if (!raw) return null;
  try {
    const evals = JSON.parse(raw).map((e) => {
      const o = {};
      if (e[0] != null) o.cp = e[0];
      if (e[1] != null) o.mate = e[1];
      if (e[2]) o.best = e[2];
      if (e[3]) o.term = e[3];
      return o;
    });
    const parsed = parseGame(game);
    if (evals.length !== parsed.fens.length) return null;
    const a = buildAnalysis(game, parsed, evals, d);
    S.analyses.set(k, a);
    return a;
  } catch (e) { return null; }
}

function getAnalysis(game, onProgress) {
  const d = depth();
  const k = akey(game, d);
  const cached = cachedAnalysis(game, d);
  if (cached) return Promise.resolve(cached);
  if (S.pending.has(k)) {
    const p = S.pending.get(k);
    if (onProgress) p.listeners.add(onProgress);
    return p.promise;
  }
  const entry = { listeners: new Set(onProgress ? [onProgress] : []) };
  entry.promise = (async () => {
    const parsed = parseGame(game);
    const eng = engine();
    eng.newGame();
    const evals = [];
    const total = parsed.fens.length;
    for (let i = 0; i < total; i++) {
      const fen = parsed.fens[i];
      const term = terminalEval(fen);
      evals.push(term || await eng.analyse(fen, d));
      entry.listeners.forEach((f) => f(i + 1, total));
    }
    store.set('grd:v1:' + k, JSON.stringify(evals.map((e) => [e.cp ?? null, e.mate ?? null, e.best || null, e.term || null])));
    const a = buildAnalysis(game, parsed, evals, d);
    S.analyses.set(k, a);
    S.pending.delete(k);
    onAnalysisDone(game);
    return a;
  })();
  entry.promise.catch(() => S.pending.delete(k));
  S.pending.set(k, entry);
  return entry.promise;
}

function onAnalysisDone(game) {
  renderRecent();
  renderGamesTable();
  if (S.current && S.current.url === game.url) renderReview();
}

/* ---------------- ratings & projection ---------------- */
function tcsPresent() { return TC_ORDER.filter((tc) => S.games.some((g) => g.tc === tc)); }

function currentRating(tc) {
  const st = S.stats && S.stats['chess_' + tc];
  if (st && st.last) return st.last.rating;
  const g = S.games.find((x) => x.tc === tc);
  return g ? g.me.rating : null;
}

function projection(tc) {
  const games = S.games.filter((g) => g.tc === tc && g.rated).slice(0, 5);
  if (!games.length) return null;
  const n = games.length;
  const W = games.filter((g) => g.res === 'W').length, L = games.filter((g) => g.res === 'L').length, D = n - W - L;
  const avgOpp = mean(games.map((g) => g.opp.rating));
  const perf = avgOpp + 400 * (W - L) / n;
  const ests = [];
  games.forEach((g) => {
    const a = cachedAnalysis(g);
    if (!a) return;
    const mine = a[g.color], theirs = a[g.color === 'w' ? 'b' : 'w'];
    if (mine.acpl == null || theirs.acpl == null) return;
    const ratio = Math.max(0.67, Math.min(1.5, Math.exp((theirs.acpl - mine.acpl) / 100)));
    ests.push(g.opp.rating * ratio);
  });
  const accEst = ests.length ? mean(ests) : null;
  const projected = accEst != null ? (perf + accEst) / 2 : perf;
  const older = S.games.filter((g) => g.tc === tc && g.rated)[5];
  const now = currentRating(tc);
  const change = older && now != null ? now - older.me.rating : null;
  return { games, n, W, L, D, avgOpp, perf, accEst, analyzed: ests.length, projected, now, change };
}

/* ---------------- rendering ---------------- */
function setStatus(html, err) { const el = $('status'); el.innerHTML = html; el.classList.remove('hidden'); el.classList.toggle('err', !!err); }
function hideStatus() { $('status').classList.add('hidden'); }

function renderAll() {
  renderRatings();
  renderRecent();
  renderHistory();
  renderGamesFilter();
  renderGamesTable();
  if (S.current) renderReview();
}

function renderRatings() {
  const p = S.profile || {};
  $('profileTitle').innerHTML = esc(p.username || S.user) + (p.title ? ' <span class="sub">' + esc(p.title) + '</span>' : '') +
    ' <span class="sub">current chess.com ratings</span>';
  const tiles = [];
  TC_ORDER.forEach((tc) => {
    const st = S.stats && S.stats['chess_' + tc];
    if (!st || !st.last) return;
    const rec = st.record || {};
    tiles.push(`<div class="tile"><div class="label">${TC_LABEL[tc]}</div><div class="value">${st.last.rating}</div>
      <div class="foot">Best ${st.best ? st.best.rating : '—'} · ${rec.win || 0}W ${rec.loss || 0}L ${rec.draw || 0}D</div></div>`);
  });
  $('ratingTiles').innerHTML = tiles.join('') || '<div class="muted">No rated games yet.</div>';
  $('ratingsCard').classList.remove('hidden');
}

function renderRecent() {
  if (!S.games.length) return;
  const tcs = tcsPresent();
  if (!tcs.includes(S.tc)) S.tc = tcs[0];
  $('tcTabs').innerHTML = tcs.map((tc) => `<button data-tc="${tc}" class="${tc === S.tc ? 'on' : ''}">${TC_LABEL[tc]}</button>`).join('');
  const pr = projection(S.tc);
  $('recentCard').classList.remove('hidden');
  if (!pr) {
    $('recentTiles').innerHTML = '<div class="muted">No rated ' + TC_LABEL[S.tc].toLowerCase() + ' games loaded.</div>';
    $('recentTable').innerHTML = '';
    $('analyzeRecent').disabled = true;
    return;
  }
  const delta = (v) => v == null ? '' : `<span class="${v >= 0 ? 'delta-up' : 'delta-down'}">${v >= 0 ? '▲ +' : '▼ −'}${Math.abs(Math.round(v))}</span>`;
  const vsNow = (v) => pr.now == null ? '' : ' · ' + delta(v - pr.now) + ' vs now';
  $('recentTiles').innerHTML = `
    <div class="tile"><div class="label">Current ${TC_LABEL[S.tc]}</div><div class="value">${pr.now ?? '—'}</div>
      <div class="foot">${pr.change != null ? delta(pr.change) + ' over these ' + pr.n : 'Change unavailable'}</div></div>
    <div class="tile"><div class="label">Performance</div><div class="value">${Math.round(pr.perf)}</div>
      <div class="foot">${pr.W}W ${pr.L}L ${pr.D}D vs avg ${Math.round(pr.avgOpp)}${vsNow(pr.perf)}</div></div>
    <div class="tile"><div class="label">Accuracy-based</div><div class="value">${pr.accEst != null ? Math.round(pr.accEst) : '—'}</div>
      <div class="foot">${pr.analyzed ? pr.analyzed + ' of ' + pr.n + ' games analyzed' : 'Analyze the games to fill this in'}</div></div>
    <div class="tile" style="box-shadow: inset 3px 0 0 var(--accent)"><div class="label">Projected rating</div><div class="value">${Math.round(pr.projected)}</div>
      <div class="foot">${pr.analyzed ? 'Blend of both' : 'Results only so far'}${vsNow(pr.projected)}</div></div>`;
  const rows = pr.games.map((g) => {
    const a = cachedAnalysis(g);
    const mine = a && a[g.color], theirs = a && a[g.color === 'w' ? 'b' : 'w'];
    const busy = S.pending.has(akey(g));
    return `<tr class="${S.current && S.current.url === g.url ? 'sel' : ''}">
      <td>${fmtDate(g.end)}</td><td><span class="dot ${g.color}"></span></td>
      <td>${esc(g.opp.name)} <span class="muted">(${g.opp.rating})</span></td>
      <td><span class="res ${g.res}">${g.res}</span></td>
      <td>${mine && mine.accuracy != null ? mine.accuracy.toFixed(1) + '%' : busy ? '<span class="muted">analyzing…</span>' : '<span class="muted">—</span>'}</td>
      <td>${theirs && theirs.accuracy != null ? theirs.accuracy.toFixed(1) + '%' : '<span class="muted">—</span>'}</td>
      <td>${mine && mine.acpl != null ? Math.round(mine.acpl) : '<span class="muted">—</span>'}</td>
      <td><button data-review="${esc(g.url)}">Review</button></td></tr>`;
  });
  $('recentTable').innerHTML = `<tr><th>Date</th><th>Side</th><th>Opponent</th><th>Result</th><th>Your accuracy</th><th>Their accuracy</th><th>Your ACPL</th><th></th></tr>` + rows.join('');
  const allDone = pr.games.every((g) => cachedAnalysis(g));
  $('analyzeRecent').disabled = S.batchRunning || allDone;
  $('analyzeRecent').textContent = allDone ? 'All 5 analyzed' : S.batchRunning ? 'Analyzing…' : 'Analyze these ' + pr.n;
}

async function analyzeRecent() {
  const pr = projection(S.tc);
  if (!pr) return;
  S.batchRunning = true;
  renderRecent();
  const bar = $('batchProgress');
  bar.classList.remove('hidden');
  const todo = pr.games.filter((g) => !cachedAnalysis(g));
  let gi = 0;
  try {
    for (const g of todo) {
      await getAnalysis(g, (d, t) => { bar.firstElementChild.style.width = ((gi + d / t) / todo.length * 100) + '%'; });
      gi++;
    }
  } catch (e) {
    setStatus('Analysis stopped: ' + esc(e.message), true);
  }
  S.batchRunning = false;
  bar.classList.add('hidden');
  renderRecent();
}

function renderGamesFilter() {
  const sel = $('gameFilter');
  const v = sel.value;
  sel.innerHTML = '<option value="all">All time controls</option>' + tcsPresent().map((tc) => `<option value="${tc}">${TC_LABEL[tc]}</option>`).join('');
  sel.value = [...sel.options].some((o) => o.value === v) ? v : 'all';
}

function renderGamesTable() {
  if (!S.games.length) return;
  $('gamesCard').classList.remove('hidden');
  const f = $('gameFilter').value;
  const list = S.games.filter((g) => f === 'all' || g.tc === f);
  const months = S.archives.length - S.archiveIdx;
  $('gamesSub').textContent = list.length + ' games from the last ' + months + ' month' + (months === 1 ? '' : 's');
  $('loadOlder').disabled = S.archiveIdx <= 0;
  $('gamesTable').innerHTML = `<tr><th>Date</th><th>Type</th><th>Side</th><th>Opponent</th><th>Your rating</th><th>Result</th><th>Your accuracy</th><th></th></tr>` +
    list.map((g) => {
      const a = cachedAnalysis(g);
      const acc = a && a[g.color].accuracy;
      return `<tr class="${S.current && S.current.url === g.url ? 'sel' : ''}"><td>${fmtDate(g.end)}</td><td>${TC_LABEL[g.tc] || esc(g.tc)}${g.rated ? '' : ' <span class="muted small">unrated</span>'}</td>
        <td><span class="dot ${g.color}"></span></td><td>${esc(g.opp.name)} <span class="muted">(${g.opp.rating})</span></td>
        <td>${g.me.rating}</td><td><span class="res ${g.res}">${g.res}</span> <span class="muted small">${esc(resultWord(g))}</span></td>
        <td>${acc != null ? acc.toFixed(1) + '%' : '<span class="muted">—</span>'}</td>
        <td><button data-review="${esc(g.url)}">Review</button></td></tr>`;
    }).join('');
}

function resultWord(g) {
  const r = g.res === 'W' ? g.opp.result : g.me.result;
  return { checkmated: 'checkmate', resigned: 'resignation', timeout: 'time', abandoned: 'abandoned', agreed: 'agreed', repetition: 'repetition', stalemate: 'stalemate', insufficient: 'insufficient material', '50move': '50-move rule', timevsinsufficient: 'time vs insufficient' }[r] || '';
}

/* ---- rating history chart ---- */
function renderHistory() {
  const el = $('historyChart');
  const tcs = tcsPresent();
  const series = tcs.map((tc) => ({ tc, pts: S.games.filter((g) => g.tc === tc && g.rated).slice().reverse() })).filter((s) => s.pts.length > 1);
  if (!series.length) { $('historyCard').classList.add('hidden'); return; }
  $('historyCard').classList.remove('hidden');
  const W = Math.max(320, el.clientWidth || 800), H = 240, m = { l: 44, r: 64, t: 12, b: 26 };
  const all = series.flatMap((s) => s.pts);
  const t0 = Math.min(...all.map((g) => g.end)), t1 = Math.max(...all.map((g) => g.end));
  let r0 = Math.min(...all.map((g) => g.me.rating)), r1 = Math.max(...all.map((g) => g.me.rating));
  const pad = Math.max(20, (r1 - r0) * 0.1); r0 -= pad; r1 += pad;
  const x = (t) => m.l + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const y = (r) => m.t + (1 - (r - r0) / (r1 - r0)) * (H - m.t - m.b);
  const step = niceStep((r1 - r0) / 4);
  let grid = '';
  for (let v = Math.ceil(r0 / step) * step; v <= r1; v += step) {
    grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${v}</text>`;
  }
  const days = (t1 - t0) / 86400;
  const tickN = Math.min(6, Math.max(2, Math.floor((W - m.l - m.r) / 110)));
  for (let i = 0; i <= tickN; i++) {
    const t = t0 + (t1 - t0) * i / tickN;
    grid += `<text x="${x(t)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--muted)">${days < 3 ? new Date(t * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : fmtDate(t)}</text>`;
  }
  const lines = series.map((s) => {
    const d = s.pts.map((g, i) => (i ? 'L' : 'M') + x(g.end).toFixed(1) + ',' + y(g.me.rating).toFixed(1)).join('');
    const last = s.pts[s.pts.length - 1];
    return `<path d="${d}" fill="none" stroke="${TC_COLOR[s.tc]}" stroke-width="2" stroke-linejoin="round"/>
      <text x="${x(last.end) + 8}" y="${y(last.me.rating) + 4}" font-size="12" fill="var(--ink-2)">${TC_LABEL[s.tc]} ${last.me.rating}</text>`;
  }).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating after each loaded game">
    <line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" stroke="var(--axis)"/>${grid}${lines}
    <g id="hHover"></g><rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" style="cursor:pointer"/></svg>
    <div class="legend">${series.map((s) => `<span><i style="background:${TC_COLOR[s.tc]}"></i>${TC_LABEL[s.tc]}</span>`).join('')}</div>`;
  const svg = el.querySelector('svg'), hover = el.querySelector('#hHover');
  let tip = null, nearest = null;
  const pick = (ev) => {
    const pt = svgPoint(svg, ev, W);
    let best = null, bd = Infinity;
    series.forEach((s) => s.pts.forEach((g) => {
      const d = Math.hypot((x(g.end) - pt.x) * 0.6, y(g.me.rating) - pt.y);
      if (d < bd) { bd = d; best = { g, s }; }
    }));
    return best;
  };
  svg.addEventListener('mousemove', (ev) => {
    nearest = pick(ev);
    if (!nearest) return;
    const { g, s } = nearest;
    const cx = x(g.end), cy = y(g.me.rating);
    hover.innerHTML = `<line x1="${cx}" x2="${cx}" y1="${m.t}" y2="${H - m.b}" stroke="var(--axis)" stroke-dasharray="3 3"/>
      <circle cx="${cx}" cy="${cy}" r="5" fill="${TC_COLOR[s.tc]}" stroke="var(--surface)" stroke-width="2"/>`;
    tip = tip || makeTip(el);
    tip.innerHTML = `<b>${TC_LABEL[s.tc]} ${g.me.rating}</b> · <span class="res ${g.res}">${g.res}</span><br>vs ${esc(g.opp.name)} (${g.opp.rating})<br><span class="muted">${fmtDateLong(g.end)} · click to review</span>`;
    placeTip(tip, el, svg, cx, cy, W);
  });
  svg.addEventListener('mouseleave', () => { hover.innerHTML = ''; if (tip) { tip.remove(); tip = null; } });
  svg.addEventListener('click', () => { if (nearest) openReview(nearest.g); });
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}
function svgPoint(svg, ev, W) {
  const r = svg.getBoundingClientRect();
  const k = W / r.width;
  return { x: (ev.clientX - r.left) * k, y: (ev.clientY - r.top) * k };
}
function makeTip(el) { const t = document.createElement('div'); t.className = 'tip'; el.appendChild(t); return t; }
function placeTip(tip, el, svg, cx, cy, W) {
  const k = svg.getBoundingClientRect().width / W;
  const px = cx * k, py = cy * k;
  const tw = tip.offsetWidth, cw = el.clientWidth;
  let left = px + 14;
  if (left + tw > cw) left = px - tw - 14;
  tip.style.left = Math.max(0, left) + 'px';
  tip.style.top = Math.max(0, py - 20) + 'px';
}

/* ---- review ---- */
async function openReview(game) {
  S.current = game;
  S.flip = game.color === 'b';
  S.ply = 0;
  $('reviewCard').classList.remove('hidden');
  renderGamesTable();
  renderRecent();
  renderReview();
  $('reviewCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const bar = $('gameProgress');
  if (!cachedAnalysis(game)) {
    bar.classList.remove('hidden');
    bar.firstElementChild.style.width = '0';
    try {
      await getAnalysis(game, (d, t) => {
        if (S.current === game) bar.firstElementChild.style.width = (d / t * 100) + '%';
      });
    } catch (e) {
      setStatus('Could not analyze this game: ' + esc(e.message), true);
    }
    bar.classList.add('hidden');
  }
}

function currentData() {
  const g = S.current;
  const a = cachedAnalysis(g);
  let parsed;
  if (a) parsed = { fens: a.fens, moves: a.plies };
  else {
    if (!g._parsed) g._parsed = parseGame(g);
    parsed = g._parsed;
  }
  return { g, a, fens: parsed.fens, moves: parsed.moves };
}

function renderReview() {
  const g = S.current;
  if (!g) return;
  let data;
  try { data = currentData(); } catch (e) { setStatus(esc(e.message), true); return; }
  const { a, fens, moves } = data;
  S.ply = Math.max(0, Math.min(S.ply, moves.length));
  $('reviewTitle').innerHTML = `Game review <span class="sub">${TC_LABEL[g.tc] || esc(g.tc)} · ${fmtDateLong(g.end)} · <a href="${esc(g.url)}" target="_blank" rel="noopener" style="color:var(--accent)">open on chess.com</a>${a ? ' · Stockfish depth ' + a.depth : ' · analyzing…'}</span>`;
  const pl = (p, c) => `<span><span class="dot ${c}"></span> <b>${esc(p.username)}</b> <span class="muted">(${p.rating})</span></span>` +
    (a && a[c].accuracy != null ? `<span class="muted">${a[c].accuracy.toFixed(1)}% accuracy</span>` : '<span></span>');
  $('topPlayer').innerHTML = S.flip ? pl(g.white, 'w') : pl(g.black, 'b');
  $('bottomPlayer').innerHTML = S.flip ? pl(g.black, 'b') : pl(g.white, 'w');
  renderBoard(fens[S.ply], S.ply ? moves[S.ply - 1] : null, a);
  // eval bar
  const e = a ? a.evals[S.ply] : null;
  const wp = e ? evalWp(e) : 50;
  const bar = $('evalbar');
  bar.classList.toggle('flip', S.flip);
  bar.firstElementChild.style.height = wp + '%';
  bar.title = e ? 'Eval ' + fmtEval(e) + ' · White ' + Math.round(wp) + '%' : '';
  renderComment(data);
  renderMoveList(data);
  renderWpChart(data);
  renderSummary(data);
  renderKeyMoments(data);
}

function renderBoard(fen, lastMove, a) {
  const c = new Chess(fen);
  const b = c.board();
  const files = 'abcdefgh';
  let html = '';
  for (let vr = 0; vr < 8; vr++) {
    for (let vf = 0; vf < 8; vf++) {
      const r = S.flip ? 7 - vr : vr, f = S.flip ? 7 - vf : vf;
      const sq = files[f] + (8 - r);
      const p = b[r][f];
      const light = (r + f) % 2 === 0;
      const hl = lastMove && (lastMove.from === sq || lastMove.to === sq);
      let inner = p ? `<span class="pc ${p.color}">${GLYPH[p.type]}</span>` : '';
      if (vf === 7) inner += `<span class="coord r" style="left:auto;right:3px">${8 - r}</span>`;
      if (vr === 7) inner += `<span class="coord f" style="right:auto;left:3px">${files[f]}</span>`;
      if (lastMove && lastMove.cls && lastMove.to === sq) inner += `<span class="mark cls-${lastMove.cls}" style="background:var(--c)" title="${CLS[lastMove.cls].label}">${CLS[lastMove.cls].sym}</span>`;
      html += `<div class="sq ${light ? 'l' : 'd'}${hl ? ' hl' : ''}">${inner}</div>`;
    }
  }
  // Arrow: engine's preferred move in the position before the move just played (when it differs).
  let arrow = '';
  if (lastMove && lastMove.evalBefore && lastMove.evalBefore.best && lastMove.evalBefore.best !== lastMove.uci && ['inaccuracy', 'mistake', 'blunder', 'good'].includes(lastMove.cls)) {
    arrow = arrowSvg(lastMove.evalBefore.best, 'var(--good)');
  }
  html += `<svg class="arrows" viewBox="0 0 8 8">${arrow}</svg>`;
  $('board').innerHTML = html;
}

function arrowSvg(uci, color) {
  const pos = (s) => {
    let f = s.charCodeAt(0) - 97, r = 8 - +s[1];
    if (S.flip) { f = 7 - f; r = 7 - r; }
    return [f + 0.5, r + 0.5];
  };
  const [x1, y1] = pos(uci.slice(0, 2)), [x2, y2] = pos(uci.slice(2, 4));
  const ang = Math.atan2(y2 - y1, x2 - x1), len = Math.hypot(x2 - x1, y2 - y1);
  const ex = x1 + Math.cos(ang) * (len - 0.35), ey = y1 + Math.sin(ang) * (len - 0.35);
  const hx = (d, a) => [x2 - Math.cos(ang + a) * d, y2 - Math.sin(ang + a) * d];
  const [ax, ay] = hx(0.45, 0.5), [bx, by] = hx(0.45, -0.5);
  return `<g opacity=".8"><line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke="${color}" stroke-width=".16" stroke-linecap="round"/>
    <polygon points="${x2},${y2} ${ax},${ay} ${bx},${by}" fill="${color}"/></g>`;
}

function moveLabel(i, m) { return Math.floor(i / 2) + 1 + (m.color === 'w' ? '. ' : '… ') + m.san; }

function renderComment({ g, a, moves }) {
  const el = $('comment');
  if (S.ply === 0) {
    el.innerHTML = a ? `Start position. Use ← → (or click the graph or a move) to step through. Green arrows show what Stockfish preferred when a move fell short.`
      : `<span class="muted">Stockfish is reviewing this game in your browser. You can already step through the moves.</span>`;
    return;
  }
  const i = S.ply - 1;
  const m = moves[i];
  if (!a) { el.innerHTML = `<b>${esc(moveLabel(i, m))}</b> <span class="muted">· waiting for the engine…</span>`; return; }
  const who = m.color === 'w' ? 'White' : 'Black';
  const mineOrTheirs = m.color === g.color ? 'You' : 'Your opponent';
  const after = fmtEval(m.evalAfter);
  const moverWp = m.color === 'w' ? m.wpAfter : 100 - m.wpAfter;
  let txt = `<span class="cls-${m.cls}"><span class="badge">${CLS[m.cls].sym}</span> <b>${esc(moveLabel(i, m))}</b> is <span class="cls">${CLS[m.cls].label.toLowerCase()}</span></span>: ${CLS[m.cls].desc}.`;
  txt += ` <span class="muted">(${mineOrTheirs} played it.)</span><br>Eval after: <b>${after}</b> · ${who}'s win chance ${Math.round(moverWp)}%`;
  if (m.loss >= 1 && !['best', 'excellent', 'forced'].includes(m.cls)) txt += ` (−${m.loss.toFixed(1)} pts)`;
  if (m.bestSan && m.cls !== 'best' && m.cls !== 'excellent') txt += `<br>Stockfish preferred <b>${esc(m.bestSan)}</b>, which kept the eval at ${fmtEval(m.evalBefore)}.`;
  el.innerHTML = txt;
}

function renderMoveList({ a, moves }) {
  const el = $('moveList');
  let html = '';
  const startBlack = moves.length && moves[0].color === 'b';
  const cells = startBlack ? [null, ...moves] : moves.slice();
  for (let k = 0; k < cells.length; k += 2) {
    html += `<div class="n">${k / 2 + 1}.</div>`;
    for (let j = 0; j < 2; j++) {
      const m = cells[k + j];
      if (!m) { html += '<div class="m"></div>'; continue; }
      const idx = moves.indexOf(m) + 1;
      const badge = m.cls && !['best', 'excellent', 'good', 'forced'].includes(m.cls) ? `<span class="badge cls-${m.cls}" style="background:var(--c)">${CLS[m.cls].sym}</span>` :
        m.cls === 'best' ? `<span class="badge cls-best" style="background:var(--c)">★</span>` : '';
      html += `<div class="m${idx === S.ply ? ' cur' : ''}" data-ply="${idx}"><span>${esc(m.san)} ${badge}</span><span class="ev">${a && m.evalAfter ? fmtEval(m.evalAfter) : ''}</span></div>`;
    }
  }
  el.innerHTML = html;
  const cur = el.querySelector('.cur');
  if (cur) {
    const top = cur.offsetTop - el.offsetTop;
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - 30) el.scrollTop = top - el.clientHeight / 2;
  }
}

function renderSummary({ g, a }) {
  const el = $('summary');
  if (!a) { el.innerHTML = '<div class="muted" style="grid-column:1/-1">Summary appears when the analysis finishes.</div>'; return; }
  const wName = esc(g.white.username), bName = esc(g.black.username);
  const youW = g.color === 'w' ? ' (you)' : '', youB = g.color === 'b' ? ' (you)' : '';
  let html = `<div></div><div class="h num">${wName}${youW}</div><div class="h num">${bName}${youB}</div>
    <div>Accuracy</div><div class="num acc">${a.w.accuracy != null ? a.w.accuracy.toFixed(1) : '—'}</div><div class="num acc">${a.b.accuracy != null ? a.b.accuracy.toFixed(1) : '—'}</div>
    <div>Avg centipawn loss</div><div class="num">${a.w.acpl != null ? Math.round(a.w.acpl) : '—'}</div><div class="num">${a.b.acpl != null ? Math.round(a.b.acpl) : '—'}</div>`;
  CLS_ORDER.forEach((k) => {
    html += `<div class="cls-${k}"><span class="badge">${CLS[k].sym}</span> ${CLS[k].label}</div><div class="num">${a.w.counts[k]}</div><div class="num">${a.b.counts[k]}</div>`;
  });
  el.innerHTML = html;
}

function renderKeyMoments({ g, a, moves }) {
  const el = $('keyMoments');
  if (!a) { el.innerHTML = '<div class="muted small">After analysis.</div>'; return; }
  const top = moves.map((m, i) => ({ m, i })).filter((x) => x.m.loss >= 8).sort((p, q) => q.m.loss - p.m.loss).slice(0, 4).sort((p, q) => p.i - q.i);
  if (!top.length) { el.innerHTML = '<div class="muted small">No big swings. A clean game from both sides.</div>'; return; }
  el.innerHTML = top.map(({ m, i }) => `<button data-ply="${i + 1}" class="cls-${m.cls}"><span class="badge">${CLS[m.cls].sym}</span>
    <b>${esc(moveLabel(i, m))}</b> ${m.color === g.color ? 'by you' : 'by opponent'} · win chance −${Math.round(m.loss)} pts${m.bestSan ? ' · better: ' + esc(m.bestSan) : ''}</button>`).join('');
}

function renderWpChart({ g, a, moves }) {
  const el = $('wpChart');
  const W = Math.max(300, el.clientWidth || 700), H = 190, m = { l: 34, r: 8, t: 8, b: 22 };
  if (!a) { el.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="var(--surface-2)" rx="6"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="var(--muted)" font-size="13">Waiting for Stockfish…</text></svg>`; return; }
  const n = a.evals.length - 1;
  const x = (i) => m.l + (n ? i / n : 0) * (W - m.l - m.r);
  const y = (wp) => m.t + (1 - wp / 100) * (H - m.t - m.b);
  const pts = a.evals.map((e, i) => [x(i), y(evalWp(e))]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
  const area = line + `L${x(n)},${H - m.b}L${x(0)},${H - m.b}Z`;
  let grid = '';
  [0, 50, 100].forEach((v) => grid += `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${v}%</text>`);
  grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(50)}" y2="${y(50)}" stroke="var(--muted)" stroke-dasharray="4 4" stroke-width="1" opacity=".7"/>`;
  const tickEvery = n > 120 ? 20 : n > 60 ? 10 : 5;
  for (let mv = tickEvery; mv * 2 <= n + 1; mv += tickEvery) grid += `<text x="${x(mv * 2 - 1)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--muted)">${mv}</text>`;
  const marks = moves.map((mv, i) => ['inaccuracy', 'mistake', 'blunder'].includes(mv.cls)
    ? `<circle cx="${x(i + 1)}" cy="${y(mv.wpAfter)}" r="${mv.cls === 'blunder' ? 5.5 : 4.5}" class="cls-${mv.cls}" fill="var(--c)" stroke="var(--surface)" stroke-width="2"/>` : '').join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="White win chance after each move">
    <rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="var(--wp-black)" rx="4"/>
    <path d="${area}" fill="var(--wp-white)"/>${grid}
    <path d="${line}" fill="none" stroke="var(--wp-line)" stroke-width="2" stroke-linejoin="round"/>
    <line id="wpCur" x1="${x(S.ply)}" x2="${x(S.ply)}" y1="${m.t}" y2="${H - m.b}" stroke="var(--accent)" stroke-width="2"/>
    ${marks}<g id="wpHover"></g>
    <rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" style="cursor:pointer"/></svg>
    <div class="legend"><span><i style="background:var(--wp-line)"></i>White win chance</span>
      ${['inaccuracy', 'mistake', 'blunder'].map((k) => `<span class="cls-${k}"><span class="badge">${CLS[k].sym}</span> ${CLS[k].label}</span>`).join('')}
      <span class="muted">x-axis: move number</span></div>`;
  const svg = el.querySelector('svg'), hover = el.querySelector('#wpHover');
  let tip = null;
  const idxAt = (ev) => Math.max(0, Math.min(n, Math.round((svgPoint(svg, ev, W).x - m.l) / (W - m.l - m.r) * n)));
  svg.addEventListener('mousemove', (ev) => {
    const i = idxAt(ev);
    const wp = evalWp(a.evals[i]);
    hover.innerHTML = `<line x1="${x(i)}" x2="${x(i)}" y1="${m.t}" y2="${H - m.b}" stroke="var(--ink-2)" stroke-dasharray="3 3"/>
      <circle cx="${x(i)}" cy="${y(wp)}" r="4.5" fill="var(--wp-line)" stroke="var(--surface)" stroke-width="2"/>`;
    tip = tip || makeTip(el);
    const mv = i ? moves[i - 1] : null;
    tip.innerHTML = (mv ? `<b>${esc(moveLabel(i - 1, mv))}</b> <span class="cls-${mv.cls}"><span class="badge">${CLS[mv.cls].sym}</span> ${CLS[mv.cls].label}</span><br>` : '<b>Start</b><br>') +
      `White ${Math.round(wp)}% · Black ${Math.round(100 - wp)}%<br><span class="muted">Eval ${fmtEval(a.evals[i])}</span>`;
    placeTip(tip, el, svg, x(i), y(wp), W);
  });
  svg.addEventListener('mouseleave', () => { hover.innerHTML = ''; if (tip) { tip.remove(); tip = null; } });
  svg.addEventListener('click', (ev) => { S.ply = idxAt(ev); renderReview(); });
}

/* ---------------- events ---------------- */
function go(ply) { if (!S.current) return; S.ply = ply; renderReview(); }
function maxPly() { try { return currentData().moves.length; } catch (e) { return 0; } }

$('lookup').addEventListener('submit', (e) => { e.preventDefault(); const v = $('username').value.trim(); if (v) loadUser(v); });
$('loadOlder').addEventListener('click', () => loadOlderMonth(true));
$('gameFilter').addEventListener('change', renderGamesTable);
$('analyzeRecent').addEventListener('click', analyzeRecent);
$('depth').addEventListener('change', () => { store.set('grd:depth', $('depth').value); renderAll(); if (S.current && !cachedAnalysis(S.current)) openReview(S.current); });
$('tcTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tc]'); if (b) { S.tc = b.dataset.tc; renderRecent(); } });
document.addEventListener('click', (e) => {
  const r = e.target.closest('[data-review]');
  if (r) { const g = S.games.find((x) => x.url === r.dataset.review); if (g) openReview(g); return; }
  const p = e.target.closest('[data-ply]');
  if (p) go(+p.dataset.ply);
});
$('navStart').addEventListener('click', () => go(0));
$('navPrev').addEventListener('click', () => go(Math.max(0, S.ply - 1)));
$('navNext').addEventListener('click', () => go(Math.min(maxPly(), S.ply + 1)));
$('navEnd').addEventListener('click', () => go(maxPly()));
$('navFlip').addEventListener('click', () => { S.flip = !S.flip; renderReview(); });
document.addEventListener('keydown', (e) => {
  if (!S.current || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (e.key === 'ArrowLeft') { go(Math.max(0, S.ply - 1)); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { go(Math.min(maxPly(), S.ply + 1)); e.preventDefault(); }
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(maxPly());
  else if (e.key === 'f' || e.key === 'F') { S.flip = !S.flip; renderReview(); }
});
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { renderHistory(); if (S.current) renderReview(); }, 150); });

$('themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  store.set('grd:theme', root.dataset.theme);
});

(function init() {
  const th = store.get('grd:theme');
  if (th) document.documentElement.dataset.theme = th;
  const d = store.get('grd:depth');
  if (d && [...$('depth').options].some((o) => o.value === d)) $('depth').value = d;
  const u = new URLSearchParams(location.search).get('u') || store.get('grd:lastUser');
  if (u) { $('username').value = u; loadUser(u); }
})();
