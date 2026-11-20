# Running on Mewtwo

Served at http://mewtwo/chess-review/ (nginx route in ServerLandingPage `nginx/snippets/chessreview.conf`
proxies to 127.0.0.1:8775).

First install (as coolguy):

    sudo git clone https://github.com/Cadestroyer5/ChessReview.git /srv/chessreview && sudo bash /srv/chessreview/deploy/install.sh

Updates: `update-repos` pulls /srv/chessreview; the app is static files, so nothing needs restarting
unless `deploy/serve.py` or `deploy/chessreview.service` changed (then re-run install.sh).
