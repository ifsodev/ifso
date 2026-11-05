#!/usr/bin/env bash
# Decides which CI job groups a run needs (used by the `changes` job in ci.yml; ci-local.sh --explain prints the same).
# Prints key=value lines (contracts, app, web, docs, release, reason) to stdout and, on GitHub, to $GITHUB_OUTPUT.
#
# Inputs (env): EVENT (github.event_name), BEFORE (github.event.before), REF (github.ref), HEAD_SHA (default HEAD).
# Everything runs (all groups true) when the diff cannot be trusted or the CI itself changed:
#   - any event other than push (pull_request, workflow_dispatch, schedule), any tag push;
#   - a branch's first push (BEFORE all zeros or empty), or a previous tip that is gone (rewritten branch);
#   - any change under .github/ (the workflow, its scripts, semgrep/gitleaks/slither config);
#   - any path this script does not know (a new top-level file or folder), so nothing new slips past the filters.
# Groups and why (each list is every input the group's tests read, not only its own folder):
#   contracts: contracts/                     -> contracts, invariants, slither, halmos, coverage, mutation
#   app:       app/, contracts/ (the anvil suites deploy contracts/out, parity vectors), docker-compose.yml -> app
#   web:       web/, the app code the site vendors and its tests import (app/src, app package files),
#              contracts/deployments/ (copied into web/src/config)  -> web
#   release:   app/scripts/release/ (the release runner: unit tests and hardening cases, audit I-21) -> release
#   docs:      the public root docs (README, SECURITY, CHANGELOG, FRONTEND, LICENSE), .gitattributes and web/src, which
#              the app copy tests and the README/owner-powers checks read -> docs (a cheap job: those checks only)
# Paths that feed no job: .audit-grade/ (generated reports), .githooks/ (local pre-commit only), .gitignore.
set -euo pipefail
EVENT="${EVENT:-push}"; BEFORE="${BEFORE:-}"; REF="${REF:-}"; HEAD_SHA="${HEAD_SHA:-HEAD}"
out() {
  printf 'contracts=%s\napp=%s\nweb=%s\ndocs=%s\nrelease=%s\nreason=%s\n' "$1" "$2" "$3" "$4" "$5" "$6"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'contracts=%s\napp=%s\nweb=%s\ndocs=%s\nrelease=%s\nreason=%s\n' "$1" "$2" "$3" "$4" "$5" "$6" >>"$GITHUB_OUTPUT"
  fi
  exit 0
}
all() { out true true true true true "$1"; }

[ "$EVENT" = push ] || all "event $EVENT runs everything"
case "$REF" in refs/tags/*) all "tag push runs everything" ;; esac
if [ -z "$BEFORE" ] || [ "$BEFORE" = 0000000000000000000000000000000000000000 ]; then all "first push of this ref"; fi
git cat-file -e "${BEFORE}^{commit}" 2>/dev/null || all "previous tip $BEFORE is not in the history (rewritten branch)"

files="$(git diff --name-only "$BEFORE" "$HEAD_SHA")"
[ -n "$files" ] || out false false false false false "no files changed"
c=false; a=false; w=false; d=false; r=false
while IFS= read -r f; do
  case "$f" in
    .github/*) all "CI files changed ($f)" ;;
    contracts/deployments/*) c=true; a=true; w=true ;;
    contracts/*) c=true; a=true ;;
    app/scripts/release/*) a=true; r=true ;;
    app/src/*|app/package.json|app/bun.lock|app/tsconfig.json) a=true; w=true ;;
    app/*|docker-compose.yml) a=true ;;
    web/src/*) w=true; d=true ;;
    web/*) w=true ;;
    README.md|SECURITY.md|CHANGELOG.md|FRONTEND.md|LICENSE|.gitattributes) d=true ;;
    .audit-grade/*|.githooks/*|.gitignore) ;;
    *) all "unknown path $f runs everything" ;;
  esac
done <<<"$files"
out "$c" "$a" "$w" "$d" "$r" "diff ${BEFORE:0:7}..$(git rev-parse --short "$HEAD_SHA"): $(wc -l <<<"$files" | tr -d ' ') files"
