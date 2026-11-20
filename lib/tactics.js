/* Tactic spotter for Game Review Desk.
 *
 * Works straight from FEN strings (no engine): given a position and a move, it reports the
 * tactical motifs that move creates for the side that played it: forks, pins, skewers,
 * discovered attacks and checks, double checks, batteries, free captures, removing the
 * defender, pieces left hanging, back-rank and smothered mates, promotions.
 * The review uses it on the move played, the engine's preferred move and the engine's line,
 * so it can say which tactics were found, missed or allowed.
 */
(function () {
  'use strict';
  const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
  const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KING = ORTHO.concat(DIAG);

  const sqName = (s) => 'abcdefgh'[s & 7] + ((s >> 3) + 1);
  const sqIdx = (n) => (n.charCodeAt(0) - 97) + 8 * (+n[1] - 1);
  const onB = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
  const other = (c) => (c === 'w' ? 'b' : 'w');

  function parse(fen) {
    const [placement, turn] = fen.split(' ');
    const b = new Array(64).fill(null);
    placement.split('/').forEach((row, i) => {
      const r = 7 - i;
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) { f += +ch; continue; }
        b[r * 8 + f] = { t: ch.toLowerCase(), c: ch === ch.toUpperCase() ? 'w' : 'b' };
        f++;
      }
    });
    return { b, turn };
  }

  function raysFor(t) { return t === 'b' ? DIAG : t === 'r' ? ORTHO : t === 'q' ? KING : null; }

  // Squares attacked by the piece on s (sliders stop at the first piece, which is included).
  function attacks(b, s) {
    const p = b[s];
    if (!p) return [];
    const f = s & 7, r = s >> 3, out = [];
    if (p.t === 'p') {
      const dr = p.c === 'w' ? 1 : -1;
      [-1, 1].forEach((df) => { if (onB(f + df, r + dr)) out.push((r + dr) * 8 + f + df); });
    } else if (p.t === 'n' || p.t === 'k') {
      (p.t === 'n' ? KNIGHT : KING).forEach(([df, dr]) => { if (onB(f + df, r + dr)) out.push((r + dr) * 8 + f + df); });
    } else {
      raysFor(p.t).forEach(([df, dr]) => {
        let x = f + df, y = r + dr;
        while (onB(x, y)) { const t = y * 8 + x; out.push(t); if (b[t]) break; x += df; y += dr; }
      });
    }
    return out;
  }

  function attackers(b, s, c) {
    const out = [];
    for (let i = 0; i < 64; i++) if (b[i] && b[i].c === c && attacks(b, i).includes(s)) out.push(i);
    return out;
  }

  function kingSq(b, c) { for (let i = 0; i < 64; i++) if (b[i] && b[i].t === 'k' && b[i].c === c) return i; return -1; }

  // Walk a ray from s: the first two pieces met, with their squares.
  function rayPieces(b, s, df, dr) {
    const out = [];
    let x = (s & 7) + df, y = (s >> 3) + dr;
    while (onB(x, y) && out.length < 2) { const t = y * 8 + x; if (b[t]) out.push(t); x += df; y += dr; }
    return out;
  }

  // Is the piece on s en prise: attacked and either undefended or attacked by something cheaper?
  function enPrise(b, s) {
    const p = b[s];
    if (!p || p.t === 'k') return false;
    const att = attackers(b, s, other(p.c));
    if (!att.length) return false;
    const def = attackers(b, s, p.c);
    if (!def.length) return true;
    return att.some((a) => VAL[b[a].t] < VAL[p.t]);
  }

  function apply(fen, uci) {
    const g = new Chess(fen);
    const mv = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
    if (!mv) return null;
    return { mv, fen: g.fen(), game: g };
  }

  const pc = (p, s) => NAME[p.t] + ' on ' + sqName(s);

  /* Motifs created by playing uci in fen, from the mover's point of view.
     prevUci (optional) is the move just before it, so plain recaptures are not called tactics. */
  function motifs(fen, uci, prevUci) {
    const res = apply(fen, uci);
    if (!res) return [];
    const { mv, game } = res;
    const B = parse(fen).b, A = parse(res.fen).b;
    const me = mv.color, them = other(me);
    const from = sqIdx(mv.from), to = sqIdx(mv.to);
    const moved = A[to];
    const out = [];
    const add = (type, text, weight) => out.push({ type, text, weight });
    const theirK = kingSq(A, them);
    const checkers = theirK >= 0 ? attackers(A, theirK, me) : [];

    // Mates
    if (game.in_checkmate()) {
      const ks = theirK, kf = ks & 7, kr = ks >> 3;
      const around = KING.map(([df, dr]) => onB(kf + df, kr + dr) ? (kr + dr) * 8 + kf + df : -1).filter((x) => x >= 0);
      const fwd = them === 'w' ? 1 : -1;
      const front = [-1, 0, 1].map((df) => onB(kf + df, kr + fwd) ? (kr + fwd) * 8 + kf + df : -1).filter((x) => x >= 0);
      const boxed = front.every((s) => A[s] && A[s].c === them);
      if (moved.t === 'n' && around.every((s) => A[s] && A[s].c === them)) add('smothered mate', 'Smothered mate: the king is boxed in by its own pieces and the knight on ' + sqName(to) + ' delivers mate.', 100);
      else if ((moved.t === 'r' || moved.t === 'q') && (kr === 0 || kr === 7) && (to >> 3) === kr && boxed) add('back-rank mate', 'Back-rank mate: the king is stuck behind its own pawns on the back rank.', 100);
      else add('checkmate', 'Checkmate.', 100);
      return out;
    }

    // Double check / discovered check
    if (checkers.length >= 2) add('double check', 'Double check from the ' + checkers.map((s) => NAME[A[s].t] + ' on ' + sqName(s)).join(' and the ') + ': the king has to move.', 60);
    else if (checkers.length === 1 && checkers[0] !== to) add('discovered check', 'Discovered check: moving the ' + NAME[moved.t] + ' opens a line for the ' + pc(A[checkers[0]], checkers[0]) + '.', 50);

    // Captures: free piece, winning trade, removing the defender
    const recapture = prevUci && prevUci.slice(2, 4) === mv.to;
    if (mv.captured && !recapture) {
      const capV = VAL[mv.captured];
      const defended = attackers(A, to, them).length > 0;
      if (!defended && capV >= 1) add('free piece', 'Wins a free ' + NAME[mv.captured] + ': nothing was defending it on ' + mv.to + '.', 30 + capV * 5);
      else if (capV > VAL[mv.piece]) add('winning trade', 'Trades up: the ' + NAME[mv.piece] + ' takes a ' + NAME[mv.captured] + ', which is worth more.', 30 + capV - VAL[mv.piece]);
      // Removing the defender: something the captured piece defended is now loose.
      const capPiece = { t: mv.captured, c: them };
      const defendedBefore = attacks(B, to).filter((s) => B[s] && B[s].c === them && B[s].t !== 'k');
      defendedBefore.forEach((s) => {
        if (s === to || !A[s] || A[s].c !== them) return;
        const nowDef = attackers(A, s, them).length;
        const nowAtt = attackers(A, s, me).length;
        if (nowAtt && !nowDef && VAL[A[s].t] >= 3) add('removing the defender', 'Removes the defender: the ' + NAME[capPiece.t] + ' was guarding the ' + pc(A[s], s) + ', which is now hanging.', 35 + VAL[A[s].t]);
      });
    }

    if (mv.promotion) add('promotion', 'Promotes to a ' + NAME[mv.promotion] + '.', 45);

    // Fork: the moved piece hits two or more worthwhile targets.
    if (moved && moved.t !== 'k') {
      const targets = attacks(A, to).filter((s) => {
        const p = A[s];
        if (!p || p.c !== them) return false;
        if (p.t === 'k') return true;
        if (VAL[p.t] > VAL[moved.t]) return true;
        return VAL[p.t] >= 3 && attackers(A, s, them).length === 0;
      });
      const safe = !enPrise(A, to) || checkers.includes(to);
      if (targets.length >= 2 && safe) {
        const names = targets.map((s) => NAME[A[s].t]);
        const royal = names.includes('king') && names.includes('queen');
        add(royal ? 'royal fork' : 'fork', (royal ? 'Royal fork: ' : 'Fork: ') + 'the ' + NAME[moved.t] + ' on ' + sqName(to) + ' attacks the ' +
          targets.map((s) => pc(A[s], s)).join(' and the ') + ' at once.', 55 + (royal ? 10 : 0));
      }
    }

    // Pins and skewers made by any of our sliders that the move affects.
    const sliders = [];
    for (let i = 0; i < 64; i++) if (A[i] && A[i].c === me && raysFor(A[i].t)) sliders.push(i);
    const seen = new Set();
    sliders.forEach((s) => {
      raysFor(A[s].t).forEach(([df, dr]) => {
        const [x, y] = rayPieces(A, s, df, dr);
        if (x == null || y == null) return;
        const P = A[x], Q = A[y];
        if (P.c !== them || Q.c !== them) return;
        const before = rayPieces(B, s, df, dr);
        const existed = B[s] && B[s].c === me && B[s].t === A[s].t && s !== to && before[0] === x && before[1] === y;
        if (existed) return;
        const key = s + ':' + x + ':' + y;
        if (seen.has(key)) return;
        seen.add(key);
        if (VAL[Q.t] > VAL[P.t] && P.t !== 'k' && (Q.t === 'k' || (VAL[Q.t] > VAL[A[s].t] && P.t !== 'p'))) {
          const abs = Q.t === 'k';
          add('pin', 'Pin: the ' + pc(A[s], s) + ' pins the ' + pc(P, x) + ' to the ' + NAME[Q.t] +
            (abs ? '; it cannot legally move.' : '; moving it would lose the ' + NAME[Q.t] + '.'), abs ? 45 : 35);
        } else if ((P.t === 'k' || VAL[P.t] > VAL[Q.t]) && VAL[P.t] >= 5 && (attackers(A, y, them).length === 0 || VAL[Q.t] > VAL[A[s].t]) && !enPrise(A, s)) {
          add('skewer', 'Skewer: the ' + pc(A[s], s) + ' attacks the ' + pc(P, x) + '; when it moves, the ' + pc(Q, y) + ' behind it falls.', 50);
        }
      });
    });

    // Discovered attack (not check): moving away opened a line onto a valuable piece.
    if (!checkers.length || checkers.includes(to)) {
      sliders.forEach((s) => {
        if (s === to) return;
        const before = new Set(attacks(B, s));
        attacks(A, s).forEach((t) => {
          const p = A[t];
          if (!p || p.c !== them || p.t === 'k' || before.has(t)) return;
          if (VAL[p.t] >= 3 && (VAL[p.t] > VAL[A[s].t] || attackers(A, t, them).length === 0)) {
            add('discovered attack', 'Discovered attack: moving the ' + NAME[moved.t] + ' uncovers the ' + pc(A[s], s) + ', which now hits the ' + pc(p, t) + '.', 45);
          }
        });
      });
    }

    // Battery: the moved piece lines up with another of our sliders on the same line.
    if (moved && raysFor(moved.t)) {
      const alignedBefore = new Set();
      if (B[from]) raysFor(moved.t).forEach(([df, dr]) => {
        const [x] = rayPieces(B, from, df, dr);
        if (x != null && B[x].c === me && (df && dr ? ['b', 'q'] : ['r', 'q']).includes(B[x].t)) alignedBefore.add(x);
      });
      const forward = me === 'w' ? 1 : -1;
      raysFor(moved.t).forEach(([df, dr]) => {
        const diag = df !== 0 && dr !== 0;
        const [x] = rayPieces(A, to, df, dr);
        if (x == null || A[x].c !== me || alignedBefore.has(x)) return;
        if (!(diag ? ['b', 'q'] : ['r', 'q']).includes(A[x].t)) return;
        // Look past each end of the pair for an enemy piece the battery is aimed at.
        const ahead = rayPieces(A, x, df, dr)[0], behind = rayPieces(A, to, -df, -dr)[0];
        const hit = [ahead, behind].find((h) => h != null && A[h].c === them && (A[h].t === 'k' || VAL[A[h].t] >= 1));
        const pointsForward = dr * forward > 0 || -dr * forward > 0;
        if (hit == null && !(df === 0 && pointsForward)) return;
        const line = diag ? 'diagonal' : df === 0 ? sqName(to)[0] + '-file' : 'rank';
        add('battery', 'Battery: the ' + NAME[moved.t] + ' and ' + NAME[A[x].t] + ' line up on the ' + line +
          (hit != null ? ', aimed at the ' + pc(A[hit], hit) : '') + ', doubling the pressure.', 25);
      });
    }

    // Plain attack on a bigger or loose piece (only if nothing sharper was found).
    if (!out.some((o) => o.weight >= 40) && moved && moved.t !== 'k') {
      attacks(A, to).forEach((s) => {
        const p = A[s];
        if (!p || p.c !== them || p.t === 'k') return;
        if (!attacks(B, from).includes(s) || from === to) {
          if (VAL[p.t] > VAL[moved.t] || (VAL[p.t] >= 3 && !attackers(A, s, them).length)) add('threat', 'Attacks the ' + pc(p, s) + (VAL[p.t] > VAL[moved.t] ? ' with a cheaper piece.' : ', which is undefended.'), 20);
        }
      });
    }

    if (checkers.length === 1 && checkers[0] === to && !out.length) add('check', 'Check.', 10);
    if (mv.flags.includes('k') || mv.flags.includes('q')) add('castling', 'Castles: the king tucks away and the rook joins the game.', 5);

    out.sort((a, b) => b.weight - a.weight);
    return out;
  }

  /* Our own pieces left loose after this move: the opponent can win them next. */
  function hanging(fen, uci) {
    const res = apply(fen, uci);
    if (!res) return [];
    const A = parse(res.fen).b, me = res.mv.color;
    const out = [];
    for (let s = 0; s < 64; s++) {
      if (!A[s] || A[s].c !== me || A[s].t === 'k' || A[s].t === 'p') continue;
      if (enPrise(A, s)) {
        const att = attackers(A, s, other(me));
        const cheap = att.reduce((m, a) => (VAL[A[a].t] < VAL[A[m].t] ? a : m), att[0]);
        out.push({ sq: sqName(s), piece: NAME[A[s].t], value: VAL[A[s].t], by: NAME[A[cheap].t] + ' on ' + sqName(cheap) });
      }
    }
    return out.sort((a, b) => b.value - a.value);
  }

  function material(fen) {
    const { b } = parse(fen);
    let w = 0, k = 0;
    b.forEach((p) => { if (p && p.t !== 'k') { if (p.c === 'w') w += VAL[p.t]; else k += VAL[p.t]; } });
    return w - k;
  }

  /* Play a UCI line from fen; returns SAN list and fens after each move (stops at an illegal move). */
  function line(fen, ucis) {
    const g = new Chess(fen);
    const sans = [], fens = [];
    for (const u of ucis) {
      const mv = g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || 'q' });
      if (!mv) break;
      sans.push(mv.san); fens.push(g.fen());
    }
    return { sans, fens, uci: ucis.slice(0, sans.length) };
  }

  window.Tactics = { motifs, hanging, material, line, VAL, NAME };
})();
