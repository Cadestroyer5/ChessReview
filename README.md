# Game Review Desk

A browser-only dashboard for your chess.com games.

- Pulls your profile, ratings and recent games from chess.com's public API (no login).
- Reviews any game with Stockfish 10 running locally in your browser: per-move labels (best, excellent, good, inaccuracy, mistake, blunder), accuracy, average centipawn loss, turning points, and a win-chance graph.
- Shows your current ratings, a rating history chart, and a performance / accuracy-based / projected rating for your last 5 games (method explained in the page).

## Run it
Open `index.html` in Chrome, Edge or Firefox (double-click works), type your chess.com username, press **Load games**.
Or serve the folder: `python3 -m http.server` and open http://localhost:8000.
You can link straight to a user with `index.html?u=yourname`.

Every move gets an explanation: the tactics it found (forks, pins, skewers, discovered attacks and checks, double checks, batteries, free pieces, removing the defender, back-rank and smothered mates), the ones it missed, the ones it allowed, and the engine's line. The spotter is `lib/tactics.js`.

Games against bots aren't in chess.com's public API. Bring them in with **Import PGN** (bottom of the game list): on chess.com open Profile → Games, select the games, press Download, and drop the .pgn file in. Imported games are listed under "vs Bot" (or their time control) and are left out of the rating maths.

When served by `deploy/serve.py` (as on Mewtwo), every game the page loads and every review is saved on the server, so they're there next time on any device, even if chess.com is unreachable. Opened straight from disk, reviews are only cached in the browser.
Depth 12 takes roughly 20–60 seconds per game; raise it for more accurate reviews.

## Files
- `index.html`, `app.js`: the app
- `lib/tactics.js`: tactic spotter used for the move explanations
- `deploy/`: Mewtwo server, systemd unit and installer (see deploy/README.md)
- `lib/chess.js`: move rules (chess.js 0.10.3, BSD)
- `lib/stockfish-src.js`: Stockfish 10 compiled to JavaScript (stockfish.js 10.0.2, GPLv3), embedded so it works from disk

Not affiliated with chess.com.
