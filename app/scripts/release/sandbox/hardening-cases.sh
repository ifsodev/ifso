#!/usr/bin/env bash
# Hardening cases for the two root-run wrappers (audit findings M-4, L-5 and L-6). Local, no root, no network beyond 127.0.0.1.
#   M-4  the release user owns the clone root verifies commits in: a planted gpg.ssh.program (and a forged signed-looking commit
#        reachable from the clone's origin) must NOT decide the result of `ifso-deploy-release --validate`.
#   L-5  ifso-release-ghrelease publishes only the runner's own notes file and posters/<tag>.png: no arbitrary path, no symlink,
#        no non-PNG poster.
#   and the release-hardening review: E6 (--linux only in its container), E5 (sync-public.py installed), A1 (the automatic
#   preflight outlives the oneshot unit), C11 (anvil installed, checksum-verified), C21 (push-queue.sh never overwrites tu-queue).
# Usage: bash hardening-cases.sh        Needs: git, python3, ssh-keygen, curl. Prints PASS/FAIL lines and a final count; exit 1 on FAIL.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SBIN="${HARDENING_SBIN:-$(cd "$HERE/../sbin" && pwd)}"   # HARDENING_SBIN: point at an older copy to watch the cases fail
W="$(mktemp -d "${TMPDIR:-/tmp}/ifso-hardening.XXXXXX")"
SRVPID=""
trap '[[ -n "$SRVPID" ]] && { kill "$SRVPID" 2>/dev/null; wait "$SRVPID" 2>/dev/null; }; rm -rf "$W"' EXIT
PASS=0; FAIL=0
ok() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); printf '  PASS  %s\n' "$what"; else FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$what"; fi; }
no() { local what="$1"; shift; if "$@" >"$W/.last" 2>&1; then FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$what"; tail -n 2 "$W/.last" | sed 's/^/        /'; else PASS=$((PASS + 1)); printf '  PASS  %s\n' "$what"; fi; }
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
G init -q --bare -b main "$W/queue.git"
printf 'RELEASE_USER=%s\nRELEASE_HOME=%s\nREPO_DIR=%s\nQUEUE_REPO=%s\nROOT_REPO=%s\nPRIVATE_URL=%s\nDEPLOY_BIN=/bin/false\nOPT_DIR=%s\nALLOWED_SIGNERS=%s\nRUNNER_LIB=%s\nFETCH_WAIT=0\n' \
  "$(id -un)" "$W/home" "$W/repo" "$W/queue.git" "$W/root.git" "$W/origin.git" "$W/opt" "$W/allowed_signers" "$W" >"$W/paths.conf"
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

echo "== M-2: allowed_signers holds owner keys only; a server-signed commit is a runner commit, accepted only by its trailer"
ssh-keygen -q -t ed25519 -N '' -C server -f "$W/srvkey" >/dev/null
G -C "$W/repo" config --unset gpg.ssh.program; G -C "$W/repo" config --unset gpg.ssh.allowedSignersFile   # the M-4 plant, gone
ssign() { G -C "$W/repo" -c gpg.format=ssh -c "user.signingkey=$W/srvkey" commit -q -S "$@"; }   # what the release user can do
G -C "$W/repo" checkout -q main; G -C "$W/repo" reset -q --hard "$GOOD"; G -C "$W/repo" clean -qfd
# queued commits live only in the server's queue repo (never on GitHub): one owner-signed, one unsigned, both on GOOD
G -C "$W/repo" checkout -q -b q1 "$GOOD"; echo q >"$W/repo/q"; G -C "$W/repo" add q; sign -m "feat: TU07 queued"; QOWN="$(G -C "$W/repo" rev-parse HEAD)"
G -C "$W/repo" checkout -q -b q2 "$GOOD"; echo u >"$W/repo/u"; G -C "$W/repo" add u; G -C "$W/repo" commit -q -m "feat: TU08 unsigned"; QUNS="$(G -C "$W/repo" rev-parse HEAD)"
G -C "$W/repo" push -q "$W/queue.git" "$QOWN:refs/heads/tu-queue" "$QUNS:refs/heads/other"
# the queue root pinned at arming (audit L-13): GOOD..QOWN; the unsigned "other" branch is not part of it
printf '%s %s\n' "$GOOD" "$QOWN" >"$W/queue-pin"; echo "QUEUE_PIN=$W/queue-pin" >>"$W/paths.conf"
G -C "$W/repo" checkout -q main
onmain() { G -C "$W/repo" push -q -f origin "$1:refs/heads/main"; }
# 1. no trailer at all
echo x >"$W/repo/x1"; G -C "$W/repo" add x1; ssign -m "chore: harmless"; C1="$(G -C "$W/repo" rev-parse HEAD)"; onmain "$C1"
no "server-signed commit with no owner-signed source is refused" bash "$SBIN/ifso-deploy-release" --validate "$C1"
# 2. a real pick of the owner-signed queued commit (another parent than the queued one, so not a fast-forward)
G -C "$W/repo" reset -q --hard "$GOOD"; echo m >"$W/repo/m"; G -C "$W/repo" add m; sign -m "fix: owner fix on main"; MFIX="$(G -C "$W/repo" rev-parse HEAD)"
G -C "$W/repo" -c gpg.format=ssh -c "user.signingkey=$W/srvkey" -c commit.gpgsign=true cherry-pick -x "$QOWN" >/dev/null; C2="$(G -C "$W/repo" rev-parse HEAD)"; onmain "$C2"
ok "server-signed cherry-pick of an owner-signed QUEUED commit (same patch) validates; root fetched the queued commit itself" bash "$SBIN/ifso-deploy-release" --validate "$C2"
ok "  root's own repository holds the queued commit (fetched from the queue repo)" git --git-dir="$W/root.git" cat-file -e "$QOWN^{commit}"
# 3. the same trailer, a different patch
G -C "$W/repo" reset -q --hard "$MFIX"; echo q >"$W/repo/q"; echo extra >"$W/repo/x3"; G -C "$W/repo" add q x3; ssign -m "feat: TU07 queued

(cherry picked from commit $QOWN)"; C3="$(G -C "$W/repo" rev-parse HEAD)"; onmain "$C3"
no "server-signed commit naming the owner-signed commit but carrying another patch is refused" bash "$SBIN/ifso-deploy-release" --validate "$C3"
# 4. a pick of the UNSIGNED queued commit (the PoC's poisoned update), same patch
G -C "$W/repo" reset -q --hard "$MFIX"; G -C "$W/repo" -c gpg.format=ssh -c "user.signingkey=$W/srvkey" -c commit.gpgsign=true cherry-pick -x "$QUNS" >/dev/null; C4="$(G -C "$W/repo" rev-parse HEAD)"; onmain "$C4"
no "server-signed cherry-pick of an UNSIGNED queued commit is refused (PoC)" bash "$SBIN/ifso-deploy-release" --validate "$C4"
# 5. a revert that names a commit that is not its ancestor
G -C "$W/repo" reset -q --hard "$MFIX"; echo r >"$W/repo/r"; G -C "$W/repo" add r; ssign -m "Revert \"x\"

This reverts commit $QOWN."; C5="$(G -C "$W/repo" rev-parse HEAD)"; onmain "$C5"
no "server-signed 'revert' of a commit that is not an ancestor is refused" bash "$SBIN/ifso-deploy-release" --validate "$C5"
# 6. a real revert of the pick, and its re-apply (revert of the revert)
G -C "$W/repo" reset -q --hard "$C2"; G -C "$W/repo" -c gpg.format=ssh -c "user.signingkey=$W/srvkey" -c commit.gpgsign=true revert --no-edit "$C2" >/dev/null; C6="$(G -C "$W/repo" rev-parse HEAD)"
G -C "$W/repo" -c gpg.format=ssh -c "user.signingkey=$W/srvkey" -c commit.gpgsign=true revert --no-edit "$C6" >/dev/null; C7="$(G -C "$W/repo" rev-parse HEAD)"; onmain "$C7"
ok "a runner revert (inverse patch) and its re-apply validate" bash "$SBIN/ifso-deploy-release" --validate "$C7"
onmain "$GOOD"; G -C "$W/repo" reset -q --hard "$GOOD"

echo "== L-12: root fetches private main itself, from the URL pinned in paths.conf; the release clone's refs never count"
# an OWNER-signed commit that is a clean descendant of the running revision but lives on another branch, not on main
G -C "$W/repo" checkout -q -b side "$GOOD"; echo s >"$W/repo/side"; G -C "$W/repo" add side; sign -m "feat: owner work in progress, not on main"
SIDE="$(G -C "$W/repo" rev-parse HEAD)"; G -C "$W/repo" push -q origin side; G -C "$W/repo" checkout -q main
# the planted remap: every plain `git fetch origin` (the runner's own fetch_all) now writes the side branch to origin/main
G -C "$W/repo" config --replace-all remote.origin.fetch '+refs/heads/side:refs/remotes/origin/main'
G -C "$W/repo" fetch -q origin
ok "  (the plant works: the release clone's origin/main is the side commit)" test "$(G -C "$W/repo" rev-parse refs/remotes/origin/main)" = "$SIDE"
no "an owner-signed commit off main is refused although the release clone's origin/main says otherwise" bash "$SBIN/ifso-deploy-release" --validate "$SIDE"
G -C "$W/repo" update-ref refs/remotes/origin/main "$SIDE"
no "  ... and after update-ref refs/remotes/origin/main in the release clone" bash "$SBIN/ifso-deploy-release" --validate "$SIDE"
G -C "$W/repo" config --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'; G -C "$W/repo" fetch -q origin
ok "control: the same wrapper validates a commit that IS on main" bash "$SBIN/ifso-deploy-release" --validate "$GOOD"
ok "root's copy of main is in root's own repository (refs/heads/main = the pinned URL's main)" test "$(G --git-dir="$W/root.git" rev-parse refs/heads/main 2>/dev/null)" = "$GOOD"
sed -i.bak '/^PRIVATE_URL=/d' "$W/paths.conf" && rm -f "$W/paths.conf.bak"
bash "$SBIN/ifso-deploy-release" --validate "$GOOD" >"$W/l12.out" 2>&1; rc=$?
ok "without PRIVATE_URL in paths.conf nothing is deployed (exit 75, says why)" bash -c "[[ $rc == 75 ]] && grep -q PRIVATE_URL '$W/l12.out'"
printf 'PRIVATE_URL=%s\n' "$W/origin.git" >>"$W/paths.conf"

echo "== L-5: ifso-release-ghrelease publishes only allow-listed files"
cat >"$W/srv.py" <<'EOS'
import http.server, json, os, sys
LOG = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def _body(self): return self.rfile.read(int(self.headers.get("Content-Length") or 0))
    def do_GET(self):  # an existing Release: the file exists-<tag> next to the log holds its assets list (JSON)
        f = os.path.join(os.path.dirname(LOG), "exists-" + self.path.rsplit("/", 1)[-1])
        if "/releases/tags/" in self.path and os.path.exists(f):
            return self._send(200, {"id": 9, "body": "Old notes.", "assets": json.load(open(f))})
        self._send(404, {})
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

echo "== L-11: root wrappers read release-user files without following symlinks"
rm -rf "$W/home/logs"; mkdir -p "$W/evil-logs"; printf 'x %s\n' "$SECRET" >"$W/evil-logs/alerts.log"
ln -s "$W/evil-logs" "$W/home/logs"; ln -sf "$W/db.env" "$W/home/PAUSE"
SYSTEMCTL=true bash "$SBIN/ifso-release-status" >"$W/l11.out" 2>&1
no "status with a planted PAUSE symlink and a symlinked logs/ never prints the target's text" grep -q "$SECRET" "$W/l11.out"
ok "  status still says the queue is paused (the PAUSE entry exists)" grep -q "PAUSED" "$W/l11.out"
rm -f "$W/home/logs" "$W/home/PAUSE"; mkdir -p "$W/home/logs"; printf 'plain alert line\n' >"$W/home/logs/alerts.log"; printf 'planned pause\n' >"$W/home/PAUSE"
SYSTEMCTL=true bash "$SBIN/ifso-release-status" >"$W/l11b.out" 2>&1
ok "control: regular PAUSE and alerts.log are shown" bash -c "grep -q 'PAUSED: planned pause' '$W/l11b.out' && grep -q 'plain alert line' '$W/l11b.out'"
rm -f "$W/home/PAUSE"
# the notify wrapper reads schedule.json (is the runner armed?): a symlink to a file the release user cannot write counts as no schedule
printf '{"launchAt":"2026-11-17T14:00:00Z"}\n' >"$W/root-only-schedule.json"; ln -sf "$W/root-only-schedule.json" "$W/home/schedule.json"
touch "$W/ALLOW"; printf 'ALLOW_FILE=%s\n' "$W/ALLOW" >>"$W/paths.conf"
bash "$SBIN/ifso-release-notify" "L11 probe" "text" 0 >/dev/null 2>&1
ok "notify: a symlinked schedule.json is not read (log only, as unarmed)" grep -q 'log only (not armed): L11 probe' "$W/home/logs/notify-log-only.log"
rm -f "$W/home/schedule.json" "$W/ALLOW"

echo "== B25: a poster staged AFTER its Release exists is uploaded on a later run, once"
: >"$W/api.log"; echo '[]' >"$W/exists-update-04"
ok "existing Release, no poster staged: exit 0, nothing uploaded" GH update-04 t "$W/home/.relnotes-U1.md"
ok "  (no upload, no new Release)" bash -c "! grep -qE '/uploads/|^POST /repos' '$W/api.log'"
python3 -c 'import sys; open(sys.argv[1],"wb").write(b"\x89PNG\r\n\x1a\n"+b"0"*64)' "$W/home/posters/update-04.png"
GH update-04 t "$W/home/.relnotes-U1.md" >"$W/b25.out" 2>&1
ok "existing Release + poster staged now: the poster is uploaded as update-04.png" grep -q 'releases/9/assets?name=update-04.png' "$W/api.log"
ok "  the image line goes on top of the EXISTING notes (PATCH keeps them)" bash -c "grep -A1 '^PATCH' '$W/api.log' | grep -q '!\\[update-04\\](http://x/p.png)' && grep -A1 '^PATCH' '$W/api.log' | grep -q 'Old notes'"
ok "  the runner is told 'poster attached'" grep -q 'poster attached' "$W/b25.out"
: >"$W/api.log"; echo '[{"name":"update-04.png"}]' >"$W/exists-update-04"
GH update-04 t "$W/home/.relnotes-U1.md" >"$W/b25b.out" 2>&1
ok "a Release that already has update-04.png: nothing is sent again (idempotent)" bash -c "! grep -qE '/uploads/|^PATCH' '$W/api.log' && grep -q 'poster attached' '$W/b25b.out'"

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

echo "== C11: install.sh installs anvil for the gate, checksum-verified (tests are never skipped for a missing tool)"
mkdir -p "$W/fdry"; printf '#!/bin/sh\necho anvil-stand-in\n' >"$W/fdry/anvil"; chmod +x "$W/fdry/anvil"; printf 'x\n' >"$W/fdry/forge"
tar -czf "$W/foundry.tar.gz" -C "$W/fdry" anvil forge
SUM="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$W/foundry.tar.gz")"
FOUNDRY_TARBALL="$W/foundry.tar.gz" FOUNDRY_SHA256="$(printf '0%.0s' {1..64})" SYNC_PUBLIC_SRC="$W/sync-public.py" INST "$W/pfx3" >"$W/inst4.out" 2>&1; rc=$?
ok "a foundry tarball with the wrong sha256 is refused and nothing is installed" bash -c "[[ $rc != 0 ]] && grep -qi 'sha256' '$W/inst4.out' && test ! -e '$W/pfx3/usr/local/bin/anvil'"
FOUNDRY_TARBALL="$W/foundry.tar.gz" FOUNDRY_SHA256="$SUM" SYNC_PUBLIC_SRC="$W/sync-public.py" INST "$W/pfx3" >"$W/inst5.out" 2>&1
ok "the verified tarball installs anvil (only anvil) for the gate" bash -c "test -x '$W/pfx3/usr/local/bin/anvil' && test ! -e '$W/pfx3/usr/local/bin/forge'"
# the default path: the PINNED version with the sha256 hard-coded in install.sh (never curl | sh); served from file:// here
PIN="$(sed -n 's/^FOUNDRY_PIN=//p' "$HERE/../install.sh")"
case "$(uname -m)" in x86_64 | amd64) FARCH=amd64 ;; *) FARCH=arm64 ;; esac
CI="$HERE/../../../../.github/workflows/ci.yml"
if [[ -f "$CI" ]]; then
  ok "install.sh pins the foundry version CI pins for forge (v$PIN)" bash -c "grep -q 'foundry-toolchain' '$CI' && ! grep -oE 'version: v[0-9]+\.[0-9]+\.[0-9]+' '$CI' | grep -vqx 'version: v$PIN'"
fi
ok "install.sh hard-codes a sha256 for both linux arches of the pinned release" bash -c "grep -qE '^    amd64\) echo [0-9a-f]{64} ;;' '$HERE/../install.sh' && grep -qE '^    arm64\) echo [0-9a-f]{64} ;;' '$HERE/../install.sh'"
ok "install.sh never pipes a download into a shell" bash -c "! grep -vE '^[[:space:]]*#' '$HERE/../install.sh' | grep -qE 'curl[^|]*\|[[:space:]]*(ba|z)?sh'"
mkdir -p "$W/frel/v$PIN"; cp "$W/foundry.tar.gz" "$W/frel/v$PIN/foundry_v${PIN}_linux_$FARCH.tar.gz"
FOUNDRY_BASE_URL="file://$W/frel" FOUNDRY_VERSION="$PIN" SYNC_PUBLIC_SRC="$W/sync-public.py" INST "$W/pfx4" >"$W/inst6.out" 2>&1; rc=$?
ok "the pinned version's download is checked against the HARD-CODED sha256 (a tampered tarball is refused, nothing installed)" bash -c "[[ $rc != 0 ]] && grep -q \"expected \$(sed -n 's/^    $FARCH) echo \\([0-9a-f]*\\) ;;/\\1/p' '$HERE/../install.sh')\" '$W/inst6.out' && test ! -e '$W/pfx4/usr/local/bin/anvil'"
FOUNDRY_BASE_URL="file://$W/frel" FOUNDRY_VERSION=9.9.9 SYNC_PUBLIC_SRC="$W/sync-public.py" INST "$W/pfx5" >"$W/inst7.out" 2>&1; rc=$?
ok "another foundry version without FOUNDRY_SHA256 is refused" bash -c "[[ $rc != 0 ]] && grep -q 'FOUNDRY_SHA256 (64 hex) is required' '$W/inst7.out'"

echo "== C21: push-queue.sh pushes a rebuilt queue to a NEW branch and never overwrites tu-queue"
G init -q --bare -b main "$W/srvqueue.git"
G clone -q "$W/origin.git" "$W/mac" 2>/dev/null
G -C "$W/mac" checkout -q -b tu-queue origin/main
echo q1 >"$W/mac/q"; G -C "$W/mac" add q; G -C "$W/mac" commit -q -m "feat(tu01): one"
PQ() { (cd "$W/mac" && GIT_CONFIG_GLOBAL=/dev/null QUEUE_URL="$W/srvqueue.git" SKIP_CHOWN=1 bash "$HERE/../push-queue.sh" "$@"); }
PQ >"$W/pq1.out" 2>&1
ok "first push creates tu-queue on the server" test "$(G -C "$W/srvqueue.git" rev-parse tu-queue 2>/dev/null)" = "$(G -C "$W/mac" rev-parse tu-queue)"
OLDQ="$(G -C "$W/srvqueue.git" rev-parse tu-queue)"
G -C "$W/mac" checkout -q -b queue-r1 origin/main; echo q2 >"$W/mac/q"; G -C "$W/mac" add q; G -C "$W/mac" commit -q -m "feat(tu01): one, rebuilt"
LOCAL_BRANCH=queue-r1 PQ >"$W/pq2.out" 2>&1; rc=$?
ok "a rebuilt queue without a new branch name is refused (tu-queue exists) and says what to do" bash -c "[[ $rc != 0 ]] && grep -q 'NEW branch' '$W/pq2.out' && test \"\$(git -C '$W/srvqueue.git' rev-parse tu-queue)\" = '$OLDQ'"
LOCAL_BRANCH=queue-r1 PQ tu-queue >"$W/pq3.out" 2>&1; rc=$?
ok "naming tu-queue explicitly is refused too (never overwritten, never forced)" bash -c "[[ $rc != 0 ]] && test \"\$(git -C '$W/srvqueue.git' rev-parse tu-queue)\" = '$OLDQ'"
LOCAL_BRANCH=queue-r1 PQ queue-r1 >"$W/pq4.out" 2>&1
ok "the rebuilt queue lands on the NEW branch queue-r1; tu-queue keeps the old tip" bash -c "test \"\$(git -C '$W/srvqueue.git' rev-parse queue-r1)\" = \"\$(git -C '$W/mac' rev-parse queue-r1)\" && test \"\$(git -C '$W/srvqueue.git' rev-parse tu-queue)\" = '$OLDQ'"
LOCAL_BRANCH=queue-r1 PQ queue-r1 >"$W/pq5.out" 2>&1; rc=$?
ok "pushing to a branch name that already exists is refused" bash -c "[[ $rc != 0 ]] && grep -q 'already exists' '$W/pq5.out'"
ok "README has the 'Rebuilt queue' section push-queue.sh points to, with remap and update-ref" bash -c "grep -q '^## Rebuilt queue' '$HERE/../README.md' && grep -q 'release.py remap' '$HERE/../README.md' && grep -q 'update-ref refs/heads/tu-queue' '$HERE/../README.md'"

echo "== ID1: the runner's own commits on private main carry the OWNER identity by default (Vercel skips non-team authors, incident 17)"
# the owner's principal in allowed_signers (README step 2) is where install.sh reads the owner identity from
OWNER_LINE="1234+owner-x@users.noreply.github.com namespaces=\"git\" $(cut -d' ' -f1,2 "$W/key.pub")"
OWNER_ID="owner-x <1234+owner-x@users.noreply.github.com>"
IDCFG() { printf '%s <%s>' "$(git config --file "$1/var/lib/ifso-release/.gitconfig" user.name)" "$(git config --file "$1/var/lib/ifso-release/.gitconfig" user.email)"; }
IDINST() { PREFIX="$1" SYNC_PUBLIC_SRC="$W/sync-public.py" bash "$HERE/../install.sh"; }
IDINST "$W/pfx-id0" >"$W/id0.out" 2>&1; rc=$?
ok "no owner key in allowed_signers and no identity given: install.sh refuses (never guesses) and says how" bash -c "[[ $rc != 0 ]] && grep -q 'allowed_signers' '$W/id0.out' && test ! -e '$W/pfx-id0/var/lib/ifso-release/.gitconfig'"
mkdir -p "$W/pfx-id/etc/ifso-release"; printf '# owner keys only\n%s\n' "$OWNER_LINE" >"$W/pfx-id/etc/ifso-release/allowed_signers"
IDINST "$W/pfx-id" >"$W/id1.out" 2>&1; rc=$?
ok "install.sh without RELEASE_GIT_NAME / RELEASE_GIT_EMAIL installs (no refusal)" test "$rc" = 0
ok "  the release user's git identity is the owner's (login + noreply address from allowed_signers)" test "$(IDCFG "$W/pfx-id")" = "$OWNER_ID"
ok "  paths.conf records the owner identity" bash -c "grep -qx 'RELEASE_GIT_NAME=\"owner-x\"' '$W/pfx-id/etc/ifso-release/paths.conf' && grep -qx 'RELEASE_GIT_EMAIL=\"1234+owner-x@users.noreply.github.com\"' '$W/pfx-id/etc/ifso-release/paths.conf'"
mkdir -p "$W/pfx-id2/etc/ifso-release"; printf '%s\n' "$OWNER_LINE" >"$W/pfx-id2/etc/ifso-release/allowed_signers"
PREFIX="$W/pfx-id2" SYNC_PUBLIC_SRC="$W/sync-public.py" RELEASE_GIT_NAME=ifsodev RELEASE_GIT_EMAIL=350520651+ifsodev@users.noreply.github.com bash "$HERE/../install.sh" >"$W/id2.out" 2>&1
ok "an explicit identity still overrides, with a warning that it is not the owner" bash -c "test \"\$(git config --file '$W/pfx-id2/var/lib/ifso-release/.gitconfig' user.name)\" = ifsodev && grep -q 'WARNING: the runner.s commits on private main will be authored by ifsodev' '$W/id2.out'"
IDINST "$W/pfx-id2" >"$W/id3.out" 2>&1
ok "a re-run without an identity replaces an older non-owner identity (the server's ifsodev) by the owner's, and says so" bash -c "test \"\$(git config --file '$W/pfx-id2/var/lib/ifso-release/.gitconfig' user.email)\" = 1234+owner-x@users.noreply.github.com && grep -q 'replaced by owner-x' '$W/id3.out'"
ok "README says runner commits on private main carry the owner identity (incident 17)" bash -c "grep -q 'owner identity' '$HERE/../README.md' && grep -q 'incident 17' '$HERE/../README.md'"

echo "== S1: sudoers is valid for sudo-rs (the server) and classic sudo; the wrappers, not sudo, check the TUnn argument"
SUD="${HARDENING_SUDOERS:-$HERE/../sudoers}"   # HARDENING_SUDOERS: point at an older copy to watch the cases fail
ok "no setting sudo-rs rejects (requiretty: 'unknown setting' on the server)" bash -c "! grep -vE '^[[:space:]]*#' '$SUD' | grep -q 'requiretty'"
ok "no argument pattern in a command rule (sudo-rs does not match TU[0-9][0-9]): arguments are a plain '*' or exact words" bash -c "! grep -vE '^[[:space:]]*#' '$SUD' | grep -qE '/usr/local/sbin/[a-z-]+ [^,\\\\]*[][?]'"
ok "L-13: the queue pin is root only (ifso-release-pin-queue is in no sudoers rule)" bash -c "! grep -q 'pin-queue' '$SUD'"
ok "ops may retry and preflight with any argument (the wrapper decides)" bash -c "grep -qF '/usr/local/sbin/ifso-release-retry *' '$SUD' && grep -qF '/usr/local/sbin/ifso-release-preflight *' '$SUD'"
# stand-ins for the runner and preflight: they record that a wrapper got past its own argument check
printf 'import sys\nopen(sys.argv[0] + ".called", "a").write(" ".join(sys.argv[1:]) + "\\n")\n' >"$W/release.py"; cp "$W/release.py" "$W/preflight.py"
for a in XX07 TU7 TU007 'TU01; id' 'TU01 TU02' '../TU01' 'tu01' ''; do
  rm -f "$W"/*.py.called
  ok "retry refuses '$a' before running anything" bash -c "! bash '$SBIN/ifso-release-retry' $([[ -n $a ]] && printf '%q' "$a") 2>'$W/s1.err' && grep -q 'usage: ifso-release-retry TUnn' '$W/s1.err' && test ! -e '$W/release.py.called'"
  [[ -z $a ]] && continue
  ok "preflight refuses '$a' before running anything" bash -c "! bash '$SBIN/ifso-release-preflight' $(printf '%q' "$a") 2>'$W/s1.err' && grep -q 'usage: ifso-release-preflight' '$W/s1.err' && test ! -e '$W/preflight.py.called'"
done
rm -f "$W"/*.py.called
ok "retry TU07 passes the wrapper's check and reaches the runner" bash -c "bash '$SBIN/ifso-release-retry' TU07 && grep -qx 'retry TU07' '$W/release.py.called'"
ok "preflight TU01 passes the wrapper's check and reaches the preflight" bash -c "bash '$SBIN/ifso-release-preflight' TU01 && grep -qx 'run --only TU01' '$W/preflight.py.called'"
rm -f "$W/release.py" "$W/preflight.py" "$W"/*.py.called

echo "== A4: no check fetches the website (ifso.tech sits behind Vercel's Security Checkpoint: scripted requests get a 403 page)"
SITE_HITS="$(grep -rnE 'https?://(www\.)?ifso\.tech' "$HERE/../lib" "$HERE/../sbin" "$HERE/../arm.sh" "$HERE/../install.sh" "$HERE/../push-queue.sh" "$HERE/../../server" 2>/dev/null | grep -vE ':[0-9]+:[[:space:]]*#' || true)"
ok "no runner, wrapper or server script requests https://ifso.tech (api.ifso.tech is Cloudflare, not Vercel)" test -z "$SITE_HITS"
[[ -z "$SITE_HITS" ]] || printf '        %s\n' "$SITE_HITS"
ok "the frontend-live check is Vercel's state of the exact sha (DECISIONS 49), not page content" bash -c "grep -q 'def wait_vercel_ready' '$HERE/../lib/release.py' && grep -q 'step(\"frontend\", s_frontend)' '$HERE/../lib/release.py'"

echo "hardening cases: $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
