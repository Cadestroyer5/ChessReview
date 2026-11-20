# Running on Mewtwo

Served at http://mewtwo/chess-review/ (nginx route in ServerLandingPage `nginx/snippets/chessreview.conf`
proxies to 127.0.0.1:8775).

First install (as coolguy):

    sudo git clone https://github.com/Cadestroyer5/ChessReview.git /srv/chessreview && sudo bash /srv/chessreview/deploy/install.sh

Saved games and reviews: /var/lib/chessreview/users/<player>.json (one file per chess.com player).

Updates: `update-repos` pulls /srv/chessreview. Page changes (index.html, app.js, lib/) show up on reload.
If `deploy/serve.py` or `deploy/chessreview.service` changed, re-run `sudo bash /srv/chessreview/deploy/install.sh`
to restart the service.
