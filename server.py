#!/usr/bin/env python3
"""PACTOMETRO – minimal proxy server. Run: python3 server.py"""

import urllib.request
import urllib.error
from http.server import HTTPServer, SimpleHTTPRequestHandler
import os, sys

API_BASE = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2"

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/"):
            upstream = API_BASE + self.path[4:]
            try:
                req = urllib.request.Request(upstream, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req) as r:
                    body = r.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "public, max-age=30")
                self.end_headers()
                self.wfile.write(body)
            except urllib.error.HTTPError as e:
                self.send_response(e.code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(e.read())
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(f'{{"error":"{e}"}}'.encode())
        else:
            super().do_GET()

    def log_message(self, fmt, *args):
        status = args[1]
        color = "\033[32m" if status.startswith("2") else "\033[33m" if status.startswith("3") else "\033[31m"
        print(f"  {color}{self.command}\033[0m {self.path}  {color}{status}\033[0m")

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    os.chdir(os.path.dirname(os.path.abspath(__file__)) or ".")
    server = HTTPServer(("", port), Handler)
    print(f"\n  ◆  PACTOMETRO  →  \033[36mhttp://localhost:{port}\033[0m\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
