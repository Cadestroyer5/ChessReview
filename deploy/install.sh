#!/usr/bin/env bash
# Install or update Game Review Desk on Mewtwo. Run from anywhere:
#   sudo bash /srv/chessreview/deploy/install.sh      (after the first clone)
# or, the first time, with the one-liner in deploy/README.md.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }

DIR=/srv/chessreview
REPO=https://github.com/Cadestroyer5/ChessReview.git
OWNER=${SUDO_USER:-coolguy}

echo "[1/5] Checkout at $DIR"
if [ ! -d "$DIR/.git" ]; then
  git clone --progress "$REPO" "$DIR"
else
  echo "      already there"
fi
chown -R "$OWNER:$OWNER" "$DIR"   # update-repos runs as $OWNER and pulls here

echo "[2/5] Service user 'chessreview'"
id chessreview >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin chessreview
echo "      ok"

echo "[3/5] systemd unit"
install -m 644 "$DIR/deploy/chessreview.service" /etc/systemd/system/chessreview.service
systemctl daemon-reload
systemctl enable --now chessreview.service
systemctl restart chessreview.service

echo "[4/5] update-repos list"
if ! grep -qE "^$DIR([[:space:]]|$)" /etc/mewtwo-repos 2>/dev/null; then
  echo "$DIR" >> /etc/mewtwo-repos
  echo "      added $DIR (static files: a pull is the whole deploy)"
else
  echo "      already listed"
fi

echo "[5/5] Checking it answers"
for i in 1 2 3 4 5; do
  if curl -fsI http://127.0.0.1:8775/ >/dev/null; then
    echo "      app OK on 127.0.0.1:8775"
    curl -fsI http://localhost/chess-review/ >/dev/null && echo "      nginx route OK: http://mewtwo/chess-review/" \
      || echo "      nginx route not answering yet (is /srv/landing up to date?)"
    exit 0
  fi
  sleep 1
done
echo "      app did not answer; see: journalctl -u chessreview -n 30"
exit 1
