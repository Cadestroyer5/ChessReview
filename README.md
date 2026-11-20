# Game Review Desk

A browser-only dashboard for your chess.com games.

- Pulls your profile, ratings and recent games from chess.com's public API (no login).
- Reviews any game with Stockfish 10 running locally in your browser: per-move labels (best, excellent, good, inaccuracy, mistake, blunder), accuracy, average centipawn loss, turning points, and a win-chance graph.
- Shows your current ratings, a rating history chart, and a performance / accuracy-based / projected rating for your last 5 games (method explained in the page).

## Run it
Open `index.html` in Chrome, Edge or Firefox (double-click works), type your chess.com username, press **Load games**.
Or serve the folder: `python3 -m http.server` and open http://localhost:8000.
You can link straight to a user with `index.html?u=yourname`.

Analysis results are cached in your browser, so a reviewed game opens instantly next time.
Depth 12 takes roughly 20–60 seconds per game; raise it for more accurate reviews.

## Files
- `index.html`, `app.js`: the app
- `lib/chess.js`: move rules (chess.js 0.10.3, BSD)
- `lib/stockfish-src.js`: Stockfish 10 compiled to JavaScript (stockfish.js 10.0.2, GPLv3), embedded so it works from disk

Not affiliated with chess.com.
