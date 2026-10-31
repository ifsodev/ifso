#!/usr/bin/env python3
"""Stand-in for everything the runner talks to over HTTP, for the sandbox proof only:
  the server's own API   GET /readyz, /v1/version, /v1/tuNN   (a route exists when the CURRENT release's tree contains
                         app/src/api/routes/tuNN.ts, so a check really passes only after its update was deployed)
  Telegram               POST /bot<token>/sendMessage         (recorded in requests.jsonl)
  GitHub                 GET/POST/PATCH /repos/<o>/<r>/releases..., POST /uploads/... assets
Injected failures are files in the control folder: readyz-down, verify-fail-TUnn (the route answers 500).
usage: fake_world.py <port-file> <ctl-dir> <repo-dir> <opt-dir>
"""
import json, os, re, subprocess, sys, threading, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT_FILE, CTL, REPO, OPT = sys.argv[1:5]
LOG = os.path.join(CTL, "requests.jsonl")
releases, lock = {}, threading.Lock()


def current_sha():
    try:
        return os.path.basename(os.readlink(os.path.join(OPT, "current")))
    except OSError:
        return ""


def tree_has(sha, path):
    r = subprocess.run(["git", "-c", "safe.directory=*", "-C", REPO, "cat-file", "-e", f"{sha}:{path}"], capture_output=True)
    return r.returncode == 0


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else (json.dumps(body) if not isinstance(body, str) else body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def rec(self, body=b""):
        with lock, open(LOG, "a") as f:
            text = body.decode("utf-8", "replace")
            if "/sendMessage" in self.path:  # form-encoded: record the readable text, so checks can grep it
                text = urllib.parse.unquote_plus(text)
            f.write(json.dumps({"m": self.command, "p": self.path, "body": text[:3000]}, ensure_ascii=False) + "\n")

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/readyz":
            return self.reply(503, "down", "text/plain") if os.path.exists(os.path.join(CTL, "readyz-down")) else self.reply(200, "ok", "text/plain")
        if p == "/v1/version":
            return self.reply(200, {"chainId": 4663, "sha": current_sha()})
        m = re.fullmatch(r"/v1/tu(\d\d)", p)
        if m:
            tu = f"TU{m.group(1)}"
            if not tree_has(current_sha(), f"app/src/api/routes/tu{m.group(1)}.ts"):
                return self.reply(404, {"error": "not found"})
            if os.path.exists(os.path.join(CTL, f"verify-fail-{tu}")):
                return self.reply(500, {"error": "boom"})
            if tree_has(current_sha(), f"app/src/api/routes/tu{m.group(1)}.perk"):  # perk-gated: ON, answers locked until the token exists
                return self.reply(403, {"locked": True, "message": "Hold 100,000 IFSO to unlock"})
            return self.reply(200, {"tu": tu, "ok": True})
        m = re.fullmatch(r"/repos/([^/]+/[^/]+)/releases/tags/(.+)", p)
        if m:
            r = releases.get(m.group(2))
            self.rec()
            return self.reply(200, r) if r else self.reply(404, {"message": "Not Found"})
        self.reply(404, {"error": "no route"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        self.rec(body if "uploads" not in self.path and "assets" not in self.path else b"<binary>")
        p = self.path.split("?")[0]
        if re.fullmatch(r"/bot[^/]+/sendMessage", p):
            return self.reply(200, {"ok": True, "result": {}})
        m = re.fullmatch(r"/repos/([^/]+/[^/]+)/releases", p)
        if m:
            d = json.loads(body)
            r = {"id": len(releases) + 1, "tag_name": d["tag_name"], "body": d["body"]}
            releases[d["tag_name"]] = r
            return self.reply(201, r)
        m = re.fullmatch(r"/uploads/repos/([^/]+/[^/]+)/releases/(\d+)/assets", p)
        if m:
            return self.reply(201, {"browser_download_url": f"http://127.0.0.1/asset/{m.group(2)}.png"})
        self.reply(404, {"error": "no route"})

    def do_PATCH(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        self.rec(body)
        m = re.fullmatch(r"/repos/([^/]+/[^/]+)/releases/(\d+)", self.path.split("?")[0])
        if m:
            for r in releases.values():
                if str(r["id"]) == m.group(2):
                    r["body"] = json.loads(body)["body"]
            return self.reply(200, {})
        self.reply(404, {})


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(PORT_FILE, "w").write(str(srv.server_address[1]))
srv.serve_forever()
