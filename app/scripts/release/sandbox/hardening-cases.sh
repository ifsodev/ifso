#!/usr/bin/env bash
# Hardening cases for the two root-run wrappers (audit findings M-4 and L-5). Local, no root, no network beyond 127.0.0.1.
#   M-4  the release user owns the clone root verifies commits in: a planted gpg.ssh.program (and a forged signed-looking commit
#        reachable from the clone's origin) must NOT decide the result of `ifso-deploy-release --validate`.
# Usage: bash hardening-cases.sh        Needs: git, python3, ssh-keygen, curl. Prints PASS/FAIL lines and a final count; exit 1 on FAIL.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SBIN="${HARDENING_SBIN:-$(cd "$HERE/../sbin" && pwd)}"   # HARDENING_SBIN: point at an older copy to watch the cases fail
W="$(mktemp -d "${TMPDIR:-/tmp}/ifso-hardening.XXXXXX")"
trap 'rm -rf "$W"' EXIT
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

echo "hardening cases: $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
