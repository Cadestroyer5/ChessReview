#!/usr/bin/env python3
"""Serve Game Review Desk on Mewtwo (127.0.0.1:8775, behind nginx at /chess-review/).

Static files come from the repo checkout. It answers HEAD (the landing page's status light
uses HEAD /) and hides .git, deploy/ and other dotfiles.

It also keeps every game the page loads, and every engine review, on the server so they
survive a cleared browser and show up on any device:
  GET  api/user/<name>            -> {"games": [...], "months": [...], "analysis": {...}}
  POST api/user/<name>/games      {"games": [chess.com game objects], "months": [archive urls]}
  POST api/user/<name>/analysis   {"key": "<game url>|<depth>", "evals": [...]}
Data lives in one JSON file per player under --data (default $STATE_DIRECTORY or ./data).
"""
import argparse
import functools
import http.server
import json
import os
import posixpath
import re
import tempfile
import threading
import urllib.parse

HIDDEN = {"deploy", "data"}
NAME_RE = re.compile(r"^[a-z0-9_-]{1,50}$")
MAX_BODY = 25 * 1024 * 1024
LOCK = threading.Lock()


class Store:
    def __init__(self, root):
        self.root = root
        os.makedirs(os.path.join(root, "users"), exist_ok=True)

    def _path(self, name):
        return os.path.join(self.root, "users", name + ".json")

    def load(self, name):
        try:
            with open(self._path(name), encoding="utf-8") as f:
                d = json.load(f)
        except FileNotFoundError:
            d = {}
        d.setdefault("games", {})
        d.setdefault("months", [])
        d.setdefault("analysis", {})
        return d

    def save(self, name, d):
        fd, tmp = tempfile.mkstemp(dir=os.path.join(self.root, "users"), prefix=".tmp-")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(d, f, separators=(",", ":"))
        os.replace(tmp, self._path(name))


class Handler(http.server.SimpleHTTPRequestHandler):
    store = None

    # ---- static files ----
    def _blocked(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        parts = [p for p in posixpath.normpath(path).split("/") if p]
        return any(p.startswith(".") or p in HIDDEN for p in parts)

    def send_head(self):
        if self._api_parts() is not None:
            self.send_error(405)
            return None
        if self._blocked():
            self.send_error(404)
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def end_headers(self):
        # Pages and scripts change on git pull; let browsers revalidate instead of caching stale code.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ---- API ----
    def _api_parts(self):
        path = urllib.parse.urlsplit(self.path).path
        if not path.startswith("/api/"):
            return None
        return [urllib.parse.unquote(p) for p in path[5:].split("/") if p]

    def _json(self, code, obj):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _user(self, parts):
        if len(parts) < 2 or parts[0] != "user":
            return None
        name = parts[1].lower()
        return name if NAME_RE.match(name) else None

    def do_GET(self):
        parts = self._api_parts()
        if parts is None:
            return super().do_GET()
        name = self._user(parts)
        if not name or len(parts) != 2:
            return self._json(404, {"error": "not found"})
        with LOCK:
            d = self.store.load(name)
        self._json(200, {"games": list(d["games"].values()), "months": d["months"], "analysis": d["analysis"]})

    def do_POST(self):
        parts = self._api_parts()
        name = self._user(parts or [])
        if not name or len(parts) != 3 or parts[2] not in ("games", "analysis"):
            return self._json(404, {"error": "not found"})
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self._json(415, {"error": "send JSON"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return self._json(413, {"error": "body too large"})
        try:
            body = json.loads(self.rfile.read(n))
        except ValueError:
            return self._json(400, {"error": "bad JSON"})
        if not isinstance(body, dict):
            return self._json(400, {"error": "bad request"})

        with LOCK:
            d = self.store.load(name)
            if parts[2] == "games":
                games = body.get("games") or []
                months = body.get("months") or []
                if not isinstance(games, list) or not isinstance(months, list):
                    return self._json(400, {"error": "bad request"})
                added = 0
                for g in games:
                    url = isinstance(g, dict) and g.get("url")
                    if not isinstance(url, str) or not url.startswith("https://www.chess.com/"):
                        continue
                    if url not in d["games"]:
                        added += 1
                    d["games"][url] = g
                for m in months:
                    if isinstance(m, str) and m.startswith("https://api.chess.com/") and m not in d["months"]:
                        d["months"].append(m)
                self.store.save(name, d)
                return self._json(200, {"added": added, "total": len(d["games"])})
            key, evals = body.get("key"), body.get("evals")
            if not isinstance(key, str) or len(key) > 300 or not isinstance(evals, list) or len(evals) > 3000:
                return self._json(400, {"error": "bad request"})
            d["analysis"][key] = evals
            self.store.save(name, d)
            return self._json(200, {"ok": True, "reviews": len(d["analysis"])})


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8775)
    ap.add_argument("--root", default=os.path.dirname(here))
    ap.add_argument("--data", default=os.environ.get("STATE_DIRECTORY") or os.path.join(os.path.dirname(here), "data"))
    a = ap.parse_args()
    Handler.store = Store(a.data)
    handler = functools.partial(Handler, directory=a.root)
    server = http.server.ThreadingHTTPServer((a.host, a.port), handler)
    print(f"Game Review Desk serving {a.root} on http://{a.host}:{a.port}/ (saved games in {a.data})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
