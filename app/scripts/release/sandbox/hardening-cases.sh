#!/usr/bin/env bash
# Hardening cases for the two root-run wrappers (audit findings M-4, L-5 and L-6). Local, no root, no network beyond 127.0.0.1.
#   M-4  the release user owns the clone root verifies commits in: a planted gpg.ssh.program (and a forged signed-looking commit
#        reachable from the clone's origin) must NOT decide the result of `ifso-deploy-release --validate`.
#   L-5  ifso-release-ghrelease publishes only the runner's own notes file and posters/<tag>.png: no arbitrary path, no symlink,
#        no non-PNG poster.
# Usage: bash hardening-cases.sh        Needs: git, python3, ssh-keygen, curl. Prints PASS/FAIL lines and a final count; exit 1 on FAIL.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SBIN="${HARDENING_SBIN:-$(cd "$HERE/../sbin" && pwd)}"   # HARDENING_SBIN: point at an older copy to watch the cases fail
W="$(mktemp -d "${TMPDIR:-/tmp}/ifso-hardening.XXXXXX")"
SRVPID=""
trap '[[ -n "$SRVPID" ]] && { kill "$SRVPID" 2>/dev/null; wait "$SRVPID" 2>/dev/null; }; rm -rf "$W"' EXIT
PASS=0; FAIL=0
ok() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); printf '  PASS  %s\n' "$what"; else FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$what"; fi; }
no() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$what"; else PASS=$((PASS + 1)); printf '  PASS  %s\n' "$what"; fi; }
G() { GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -c user.name=t -c user.email=t@example.invalid "$@"; }

# ---- world: origin, release clone, signing key, running revision
ssh-keygen -q -t ed25519 -N '' -C t@example.invalid -f "$W/key" >/dev/null
printf 't@example.invalid namespaces="git" %s\n' "$(cut -d' ' -f1,2 "$W/key.pub")" >"$W/allowed_signers"
G init -q --bare -b main "$W/origin.git"
G clone -q "$W/origin.git" "$W/repo" 2>/dev/null
G -C "$W/repo" checkout -q -b main 2>/dev/null
sign() { G -C "$W/repo" -c gpg.format=ssh -c "user.signingkey=$W/key" commit -q -S "$@"; }
echo a >"$W/repo/a"; G -C "$W/repo" add a; sign -m base
BASE="$(G -C "$W/repo" rev-parse HEAD)"
G -C "$W/repo" push -q origin main
mkdir -p "$W/opt/releases/$BASE" "$W/home/posters"; ln -s "$W/opt/releases/$BASE" "$W/opt/current"
printf 'RELEASE_USER=%s\nRELEASE_HOME=%s\nREPO_DIR=%s\nDEPLOY_BIN=/bin/false\nOPT_DIR=%s\nALLOWED_SIGNERS=%s\nRUNNER_LIB=%s\nFETCH_WAIT=0\n' \
  "$(id -un)" "$W/home" "$W/repo" "$W/opt" "$W/allowed_signers" "$W" >"$W/paths.conf"
export IFSO_RELEASE_CONF="$W/paths.conf" IFSO_RELEASE_LIB="$SBIN"
unset SUDO_UID

echo "== M-4: signature gate in ifso-deploy-release"
echo b >"$W/repo/b"; G -C "$W/repo" add b; sign -m good
GOOD="$(G -C "$W/repo" rev-parse HEAD)"; G -C "$W/repo" push -q origin main
ok "control: a commit signed by an allowed key validates" bash "$SBIN/ifso-deploy-release" --validate "$GOOD"
# forged commit (sshsig-looking header, no real signature) on top of the running revision, served as origin/main
G -C "$W/repo" reset -q --hard "$BASE"
tree="$(G -C "$W/repo" rev-parse "$BASE^{tree}")"
forged="$(printf 'tree %s\nparent %s\nauthor x <x@x> 0 +0000\ncommitter x <x@x> 0 +0000\ngpgsig -----BEGIN SSH SIGNATURE-----\n AAAA\n -----END SSH SIGNATURE-----\n\nforged\n' "$tree" "$BASE" \
  | G -C "$W/repo" hash-object -t commit -w --stdin)"
G -C "$W/repo" push -q -f origin "$forged:refs/heads/main"
# what a compromised release user plants in its own clone: a "verifier" that always says yes
cat >"$W/evil-keygen" <<EOS
#!/bin/sh
echo "ran as \$(id -un): \$*" >>"$W/PWNED"
echo 'Good "git" signature for t@example.invalid with ED25519 key SHA256:x'
exit 0
EOS
chmod +x "$W/evil-keygen"
G -C "$W/repo" config gpg.ssh.program "$W/evil-keygen"
G -C "$W/repo" config gpg.ssh.allowedSignersFile /dev/null
no "forged commit + planted gpg.ssh.program: --validate refuses" bash "$SBIN/ifso-deploy-release" --validate "$forged"
ok "the planted program never ran" test ! -e "$W/PWNED"
G -C "$W/repo" push -q -f origin "$GOOD:refs/heads/main"
ok "genuine signed commit still validates with the same planted config" bash "$SBIN/ifso-deploy-release" --validate "$GOOD"
ok "the planted program still never ran" test ! -e "$W/PWNED"
ok "common.sh no longer exports safe.directory=*" bash -c "! grep -n \"GIT_CONFIG_VALUE_0='\\*'\" '$SBIN/common.sh'"

echo "== L-6: ancestry checks ignore grafts, replace refs and the commit graph planted in the release clone"
# an unrelated signed root commit X (not a descendant of the running revision BASE), served as origin/main by an origin the
# release user controls; the planted graft says "X's parent is BASE", which would make X look like a clean 1-commit update
X="$(G -C "$W/repo" -c gpg.format=ssh -c "user.signingkey=$W/key" -c gpg.ssh.program=ssh-keygen commit-tree -S -m "old signed root" "$(G -C "$W/repo" rev-parse "$BASE^{tree}")")"
G clone -q --bare "$W/origin.git" "$W/evil.git" && G -C "$W/repo" push -q -f "$W/evil.git" "$X:refs/heads/main"
G -C "$W/repo" remote set-url origin "$W/evil.git"
no "control: a signed commit unrelated to the running revision is refused" bash "$SBIN/ifso-deploy-release" --validate "$X"
printf '%s %s\n' "$X" "$BASE" >"$W/repo/.git/info/grafts"
no "planted .git/info/grafts: the unrelated signed commit is still refused" bash "$SBIN/ifso-deploy-release" --validate "$X"
rm -f "$W/repo/.git/info/grafts"
ok "rgit pins GIT_GRAFT_FILE=/dev/null and core.commitGraph=false" bash -c "grep -q 'GIT_GRAFT_FILE=/dev/null' '$SBIN/common.sh' && grep -q 'core.commitGraph=false' '$SBIN/common.sh'"
G -C "$W/repo" remote set-url origin "$W/origin.git"

echo "== L-5: ifso-release-ghrelease publishes only allow-listed files"
cat >"$W/srv.py" <<'EOS'
import http.server, json, sys
LOG = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def _body(self): return self.rfile.read(int(self.headers.get("Content-Length") or 0))
    def do_GET(self): self._send(404, {})
    def do_PATCH(self): open(LOG, "ab").write(b"PATCH\n" + self._body() + b"\n"); self._send(200, {})
    def do_POST(self):
        b = self._body(); open(LOG, "ab").write(self.command.encode() + b" " + self.path.encode() + b"\n" + b + b"\n")
        if "/uploads/" in self.path: self._send(201, {"browser_download_url": "http://x/p.png"})
        else: self._send(201, {"id": 1})
s = http.server.HTTPServer(("127.0.0.1", 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()
EOS
python3 -I "$W/srv.py" "$W/api.log" >"$W/port" &
SRVPID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -s "$W/port" ]] && break; sleep 0.3; done
PORT="$(cat "$W/port")"
printf 'GITHUB_RELEASE_TOKEN=test-not-a-token\nPUBLIC_REPO=o/r\nGITHUB_API_BASE=http://127.0.0.1:%s\nGITHUB_UPLOAD_BASE=http://127.0.0.1:%s/uploads\n' "$PORT" "$PORT" >"$W/release.env"
printf 'RELEASE_ENV=%s\n' "$W/release.env" >>"$W/paths.conf"
SECRET="TOP-SECRET-DB-PASSWORD-$$"; printf '%s\n' "$SECRET" >"$W/db.env"
GH() { bash "$SBIN/ifso-release-ghrelease" "$@"; }
no "notes file outside the release home is refused" GH update-01 t "$W/db.env"
no "notes file with the wrong name is refused" GH update-01 t "$W/home/other.md"
ln -s "$W/db.env" "$W/home/.relnotes-U1.md"
no "notes file that is a symlink to a secret is refused" GH update-01 t "$W/home/.relnotes-U1.md"
ok "nothing was sent to the API for refused notes" test ! -s "$W/api.log"
rm -f "$W/home/.relnotes-U1.md"; printf 'Plain public notes.\n' >"$W/home/.relnotes-U1.md"
ln -s "$W/db.env" "$W/home/posters/update-01.png"
ok "symlinked poster: release is created without the picture" GH update-01 t "$W/home/.relnotes-U1.md"
ok "the API got the notes" grep -q 'Plain public notes' "$W/api.log"
no "the secret was never published (symlink poster)" grep -q "$SECRET" "$W/api.log"
ok "no asset upload happened" bash -c "! grep -q '/uploads/' '$W/api.log'"
: >"$W/api.log"; rm -f "$W/home/posters/update-01.png"
printf '%s\n' "$SECRET" >"$W/home/posters/update-02.png"
ok "regular file that is not a PNG: release created without the picture" GH update-02 t "$W/home/.relnotes-U1.md"
no "the secret was never published (non-PNG poster)" grep -q "$SECRET" "$W/api.log"
: >"$W/api.log"
python3 -c 'import sys; open(sys.argv[1],"wb").write(b"\x89PNG\r\n\x1a\n"+b"0"*64)' "$W/home/posters/update-03.png"
ok "a real PNG poster is uploaded" GH update-03 t "$W/home/.relnotes-U1.md"
ok "the upload happened" grep -q '/uploads/' "$W/api.log"

echo "== E6: run-sandbox.sh --linux runs only inside its throwaway container (it rewrites bun, paths.conf, allowed_signers)"
env -u IFSO_SANDBOX_CONTAINER bash "$HERE/run-sandbox.sh" --linux >"$W/linux1.out" 2>&1; rc1=$?
ok "--linux without the container marker refuses (exit 2) and says why" bash -c "[[ $rc1 == 2 ]] && grep -q 'only inside the throwaway container' '$W/linux1.out'"
IFSO_SANDBOX_CONTAINER=1 bash "$HERE/run-sandbox.sh" --linux >"$W/linux2.out" 2>&1; rc2=$?
if [[ -e /.dockerenv || -e /run/.containerenv ]]; then
  ok "(inside a container) the marker plus /.dockerenv is accepted past the guard" bash -c "! grep -q 'only inside the throwaway container' '$W/linux2.out'"
else
  ok "--linux with the env marker but no /.dockerenv (a real host) still refuses" bash -c "[[ $rc2 == 2 ]] && grep -q 'only inside the throwaway container' '$W/linux2.out'"
fi
ok "README never tells anyone to run the --linux sandbox on a real server" bash -c "! grep -qE 'bash sandbox/run-sandbox.sh --linux' '$HERE/../README.md' && grep -q 'never on a real server' '$HERE/../README.md'"

echo "== E5: install.sh installs sync-public.py from the path given at install time (no public copy works without it)"
INST() { PREFIX="$1" RELEASE_GIT_NAME="Ifso Release" RELEASE_GIT_EMAIL=release@example.invalid bash "$HERE/../install.sh"; }
INST "$W/pfx1" >"$W/inst1.out" 2>&1; rc=$?
ok "install.sh without SYNC_PUBLIC_SRC refuses (nothing to copy) and says how" bash -c "[[ $rc != 0 ]] && grep -q 'SYNC_PUBLIC_SRC' '$W/inst1.out'"
printf '# stand-in for docs/tools/sync-public.py\n' >"$W/sync-public.py"
SYNC_PUBLIC_SRC="$W/sync-public.py" INST "$W/pfx2" >"$W/inst2.out" 2>&1
ok "install.sh with SYNC_PUBLIC_SRC installs it where paths.conf points" bash -c "f=\$(sed -n 's/^SYNC_PUBLIC_PY=//p' '$W/pfx2/etc/ifso-release/paths.conf' | tr -d '\"'); cmp -s '$W/sync-public.py' \"\$f\""
INST "$W/pfx2" >"$W/inst3.out" 2>&1
ok "a second install.sh run keeps the installed copy (no SYNC_PUBLIC_SRC needed again)" grep -q 'stand-in' "$W/pfx2/usr/local/lib/ifso-release/lib/sync-public.py"
ok "no reference to the missing server push script" bash -c "! grep -rq 'push-to-server[.]sh' '$HERE/..'"

echo "== A1: the automatic preflight outlives the oneshot pass (systemd would kill the whole cgroup by default)"
ok "ifso-release.service keeps the detached preflight alive (KillMode=process)" grep -qx 'KillMode=process' "$HERE/../systemd/ifso-release.service"
ok "the runner starts the preflight in its own session (detached)" grep -q 'start_new_session=True' "$HERE/../lib/release.py"

echo "hardening cases: $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
