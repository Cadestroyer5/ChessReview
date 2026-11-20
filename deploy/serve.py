#!/usr/bin/env python3
"""Serve Game Review Desk on Mewtwo (127.0.0.1:8775, behind nginx at /chess-review/).

A tiny static file server: it serves the app files from the repo checkout, answers HEAD
(the landing page's status light uses HEAD /), and hides .git, deploy/ and other dotfiles.
"""
import argparse
import functools
import http.server
import os
import posixpath
import urllib.parse

HIDDEN = {"deploy"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def _blocked(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        parts = [p for p in posixpath.normpath(path).split("/") if p]
        return any(p.startswith(".") or p in HIDDEN for p in parts)

    def send_head(self):
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


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8775)
    ap.add_argument("--root", default=os.path.dirname(here))
    a = ap.parse_args()
    handler = functools.partial(Handler, directory=a.root)
    server = http.server.ThreadingHTTPServer((a.host, a.port), handler)
    print(f"Game Review Desk serving {a.root} on http://{a.host}:{a.port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
