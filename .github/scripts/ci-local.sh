#!/usr/bin/env bash
# Local CI gate: runs the commands of every job in .github/workflows/ci.yml (same commands, same pinned tool versions)
# on ONE commit, in throwaway worktrees, and prints one PASS/FAIL line per job. No path filters: everything runs.
# Extra gates on top of CI: any "Unhandled error" line in bun/vitest output fails the job, and the passed-test count of
# every test file (forge, app bun, web vitest) must not drop below .github/ci-baseline.json in the tested commit.
#
#   bash .github/scripts/ci-local.sh [--repo DIR] [--rev REV] [--jobs a,b] [--slow] [--serial] [--update-baseline] [--keep]
#     --repo DIR          the git repo (default: the repo this script sits in)
#     --rev REV           the commit to test (default HEAD; uncommitted changes are NOT tested)
#     --jobs a,b          only these jobs (contracts invariants slither semgrep app web docs gitleaks halmos coverage mutation)
#     --slow              also run halmos, coverage and mutation (minutes to an hour; CI runs them on contract changes)
#     --serial            one job at a time (default: four parallel lanes, each in its own worktree)
#     --update-baseline   after an all-PASS run, write the per-file counts to DIR/.github/ci-baseline.json (commit it)
#     --keep              keep the worktrees and logs (printed at the end)
#     --port-base N       anvil ports N, N+1, N+2 (default 20445; CI uses 8645/8745/8946)
# Exit 0 only when every selected job passed. Needs forge/anvil 1.8.4, bun 1.4.4, semgrep 1.181.0, slither 0.11.6,
# gitleaks 8.30.1, Postgres 16 (pg_ctl), jq, python3. A tool at another version is a FAIL, never a silent substitute.
set -uo pipefail
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"

repo=""; rev=HEAD; jobs=""; slow=0; serial=0; update=0; keep=0; port=20445
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --rev) rev="$2"; shift 2 ;;
    --jobs) jobs="${2//,/ }"; shift 2 ;;
    --slow) slow=1; shift ;;
    --serial) serial=1; shift ;;
    --update-baseline) update=1; shift ;;
    --keep) keep=1; shift ;;
    --port-base) port="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "ci-local: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$repo" ] || repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --verify "$rev^{commit}")" || { echo "ci-local: FAIL: no commit $rev in $repo"; exit 1; }
[ -n "$jobs" ] || { jobs="contracts invariants slither semgrep app web docs gitleaks"; [ "$slow" = 1 ] && jobs="$jobs halmos coverage mutation"; }
if [ "$rev" = HEAD ] && [ -n "$(git -C "$repo" status --porcelain --untracked-files=no)" ]; then
  echo "ci-local: note: $repo has uncommitted changes; testing the commit ${sha:0:7} only"
fi

PIN_FORGE=1.8.4 PIN_BUN=1.4.4 PIN_GITLEAKS=8.30.1
work="${CI_LOCAL_DIR:-$HOME/.cache/ifso-ci-local}/${sha:0:10}-$$"
mkdir -p "$work/logs" "$work/res"
cleanup() {
  for p in $(jobs -p 2>/dev/null); do kill "$p" 2>/dev/null; done
  if [ "$keep" = 0 ]; then
    for wt in "$work"/wt-*; do [ -d "$wt" ] && git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1; done
    git -C "$repo" worktree prune >/dev/null 2>&1
    rm -rf "$work"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

wt() { # one detached worktree per lane, made once
  local d="$work/wt-$1"
  [ -d "$d" ] || git -C "$repo" worktree add -q --detach "$d" "$sha" >/dev/null 2>&1 || { echo "ci-local: could not make worktree $d" >&2; return 1; }
  echo "$d"
}
need_version() { # need_version <label> <wanted> <command...>: the first line of output must contain the wanted version
  local label="$1" want="$2"; shift 2
  local got; got="$("$@" 2>&1 | head -1)"
  grep -qF "$want" <<<"$got" || { echo "VERSION: $label must be $want (CI pin), found: ${got:-missing}"; return 1; }
}
no_unhandled() { # fails on any "Unhandled error" line (bun prints these yet can still exit 0)
  if grep -niE 'unhandled (error|rejection)' "$1" | head -5 | grep .; then echo "GATE: 'Unhandled error' in the output above"; return 1; fi
}
step() { echo "+ $*"; "$@"; }

# ---- jobs (each mirrors the ci.yml job of the same name, step by step) --------------------------------------------
job_contracts() {
  local r; r="$(wt contracts)" || return 1
  need_version forge "$PIN_FORGE" forge --version || return 1
  cd "$r/contracts" || return 1
  step forge fmt --check || return 1
  { forge build --sizes && bash tools/size-gate.sh; } || return 1
  step python3 tools/natspec-check.py || return 1
  step bash tools/readme-deploy-check.sh || return 1
  step bash tools/owner-powers-check.sh || return 1
  step forge doc --out "$work/forge-doc" || return 1
  echo "+ forge test (junit to $work/res/forge.xml)"
  forge test --junit >"$work/res/forge.xml"; local rc=$?
  python3 - "$work/res/forge.xml" <<'PY'
import sys, xml.etree.ElementTree as E
t = E.parse(sys.argv[1]).getroot()
s = [x for x in t.iter("testsuite")]
n = sum(int(x.get("tests", 0)) for x in s); f = sum(int(x.get("failures", 0)) + int(x.get("errors", 0)) for x in s)
print(f"forge test: {n} tests in {len(s)} suites, {f} failed")
for c in t.iter("testcase"):
    if c.find("failure") is not None or c.find("error") is not None: print("  FAILED:", c.get("classname"), c.get("name"))
PY
  [ "$rc" = 0 ] || return 1
  (cd "$r" && step bash .github/scripts/pins-check.sh) || return 1
  step bash tools/gas-snapshot.sh --check || return 1
  local p=$((port + 2))
  anvil -p "$p" --silent & local A=$!
  sleep 2
  { step bash script/local-deploy.sh "$p" && step bash script/verify-sourcify.sh 31337 --dry-run; }; rc=$?
  kill "$A" 2>/dev/null; wait "$A" 2>/dev/null
  return "$rc"
}
job_invariants() {
  local r; r="$(wt contracts)" || return 1
  cd "$r/contracts" && step env FOUNDRY_PROFILE=invariant forge test --match-test invariant -vv
}
job_slither() {
  local r; r="$(wt contracts)" || return 1
  local want; want="$(grep -oE '^slither-analyzer==[0-9.]+' "$r/.github/slither-requirements.txt" | cut -d= -f3)"
  need_version slither "$want" slither --version || return 1
  cd "$r/contracts" || return 1
  rm -f slither-report.json
  step env FOUNDRY_DYNAMIC_TEST_LINKING=false slither . --compile-force-framework foundry --foundry-compile-all \
    --filter-paths "test/|script/|src/mocks/" --exclude-informational --exclude-optimization --fail-none \
    --json slither-report.json || return 1
  step python3 tools/slither-gate.py slither-report.json slither.allow
}
job_semgrep() {
  local r; r="$(wt light)" || return 1
  local want; want="$(grep -oE '^semgrep==[0-9.]+' "$r/.github/semgrep/requirements.txt" | cut -d= -f3)"
  need_version semgrep "$want" env SEMGREP_ENABLE_VERSION_CHECK=0 semgrep --version --disable-version-check || return 1
  cd "$r" || return 1
  echo "+ semgrep --config .github/semgrep/rules.yml ... app"
  SEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0 semgrep --config .github/semgrep/rules.yml --metrics=off \
    --disable-version-check --json --quiet app >"$work/res/semgrep-report.json" || return 1
  step python3 .github/scripts/semgrep-gate.py "$work/res/semgrep-report.json" .github/semgrep/semgrep.allow .
}
job_gitleaks() {
  local r; r="$(wt light)" || return 1
  need_version gitleaks "$PIN_GITLEAKS" gitleaks version || return 1
  cd "$r" && step gitleaks detect --source . --config .github/gitleaks.toml --redact --no-banner --exit-code 1
}
job_app() {
  local r; r="$(wt app)" || return 1
  need_version forge "$PIN_FORGE" forge --version || return 1
  need_version bun "$PIN_BUN" bun --version || return 1
  (cd "$r/contracts" && step forge build) || return 1
  { anvil --version && pg_ctl --version; } || { echo "anvil or Postgres missing (the chain tests would skip silently)"; return 1; }
  cd "$r/app" || return 1
  step bun install --frozen-lockfile || return 1
  step bunx tsc --noEmit || return 1
  echo "+ bun test (junit to $work/res/app.xml)"
  CI=true IFSO_TEST_ANVIL_PORT="$port" IFSO_TEST_ANVIL_PORT_CLI="$((port + 1))" \
    bun test --reporter=junit --reporter-outfile="$work/res/app.xml" 2>&1 | tee "$work/res/app.out"
  local rc=${PIPESTATUS[0]}
  no_unhandled "$work/res/app.out" || return 1
  return "$rc"
}
job_web() {
  local r; r="$(wt web)" || return 1
  need_version bun "$PIN_BUN" bun --version || return 1
  (cd "$r/app" && step bun install --frozen-lockfile) || return 1
  cd "$r/web" || return 1
  step bun install --frozen-lockfile || return 1
  { bash scripts/sync-client.sh && git diff --exit-code -- src/vendor; } || return 1
  step bunx tsc --noEmit || return 1
  step bunx eslint src/lib/ifso src/views/ifso src/views/secret "src/app/(secret)" src/proxy.ts || return 1
  CI=true step bun run build || return 1
  echo "+ bun run test (junit to $work/res/web.xml)"
  CI=true bun run test --reporter=default --reporter=junit --outputFile.junit="$work/res/web.xml" 2>&1 | tee "$work/res/web.out"
  local rc=${PIPESTATUS[0]}
  no_unhandled "$work/res/web.out" || return 1
  return "$rc"
}
job_docs() {
  local r; r="$(wt light)" || return 1
  need_version bun "$PIN_BUN" bun --version || return 1
  cd "$r/app" || return 1
  step bun install --frozen-lockfile || return 1
  CI=true bun test test/bannedWords.test.ts test/frontendDoc.test.ts test/copyExamples.test.ts test/changelog.union.test.ts test/deps.advisories.test.ts 2>&1 | tee "$work/res/docs.out"
  local rc=${PIPESTATUS[0]}
  no_unhandled "$work/res/docs.out" || return 1
  [ "$rc" = 0 ] || return 1
  (cd "$r/contracts" && step bash tools/readme-deploy-check.sh && step bash tools/owner-powers-check.sh)
}
job_halmos() {
  local r; r="$(wt contracts)" || return 1
  cd "$r/contracts" && HALMOS_VENV="$work/halmos-venv" step bash tools/halmos.sh
}
job_coverage() {
  local r; r="$(wt contracts)" || return 1
  cd "$r/contracts" && step bash tools/coverage.sh --out "$work/coverage.md" --min-lines 90
}
job_mutation() {
  local r; r="$(wt contracts)" || return 1
  cd "$r/contracts" && step bash tools/mutation.sh --min-score 90 --out "$work/audit-grade"
}

run_job() { # run_job <name>: log, time, result file
  local j="$1" t0 rc
  t0=$(date +%s)
  ( set +e; "job_$j" ) >"$work/logs/$j.log" 2>&1; rc=$?
  echo "$rc $(( $(date +%s) - t0 ))" >"$work/res/$j.rc"
}
lane_of() {
  case "$1" in
    contracts|invariants|slither|halmos|coverage|mutation) echo contracts ;;
    app) echo app ;; web) echo web ;; *) echo light ;;
  esac
}

echo "ci-local: testing ${sha:0:7} ($(git -C "$repo" log -1 --format=%s "$sha" | cut -c1-70)): jobs: $jobs"
for j in $jobs; do type "job_$j" >/dev/null 2>&1 || { echo "ci-local: unknown job $j"; exit 2; }; done
# make the worktrees up front, one at a time (git worktree add takes a repo lock)
for j in $jobs; do wt "$(lane_of "$j")" >/dev/null || exit 1; done
T0=$(date +%s)
if [ "$serial" = 1 ]; then
  for j in $jobs; do run_job "$j"; done
else
  pids=""
  for lane in contracts app web light; do
    lj=""; for j in $jobs; do [ "$(lane_of "$j")" = "$lane" ] && lj="$lj $j"; done
    [ -n "$lj" ] || continue
    # the contract lane (10,000-run invariants, slither) is CPU-bound; run it niced so the app/web suites, whose
    # tests have 5 s timeouts, are not starved by it (on CI every job has its own machine)
    ( if [ "$lane" = contracts ]; then renice -n 15 -p "$(exec sh -c 'echo $PPID')" >/dev/null 2>&1 || true; fi; for j in $lj; do run_job "$j"; done ) & pids="$pids $!"
  done
  for p in $pids; do wait "$p"; done
fi

# ---- per-file test counts vs the baseline -------------------------------------------------------------------------
base_file="$work/wt-$(lane_of "${jobs%% *}")/.github/ci-baseline.json"
counts_rc=0
python3 - "$work/res" "$base_file" "$work/res/counts.json" <<'PY' || counts_rc=$?
import json, os, sys, xml.etree.ElementTree as E
res, base_path, out = sys.argv[1:4]
cur = {}
for key, fn in (("forge", "forge.xml"), ("app", "app.xml"), ("web", "web.xml")):
    p = os.path.join(res, fn)
    if not os.path.exists(p) or os.path.getsize(p) == 0: continue
    root = E.parse(p).getroot()
    suites = [s for s in root if s.tag == "testsuite"] if root.tag == "testsuites" else [root]
    d = {}
    for s in suites:
        n = int(s.get("tests", 0)) - int(s.get("failures", 0)) - int(s.get("errors", 0)) - int(s.get("skipped", 0))
        d[s.get("name")] = d.get(s.get("name"), 0) + n
    cur[key] = dict(sorted(d.items()))
json.dump(cur, open(out, "w"), indent=1, sort_keys=True)
if not os.path.exists(base_path):
    print("counts: no .github/ci-baseline.json in this commit; run with --update-baseline and commit it"); sys.exit(1)
base = json.load(open(base_path))
drops = []
for key, files in base.items():
    if key not in cur: continue   # that job was not selected this run
    for f, n in files.items():
        got = cur[key].get(f, 0)
        if got < n: drops.append(f"{key} {f}: {got} passed, baseline {n}")
for key in cur:
    new = sum(cur[key].values()) - sum(base.get(key, {}).values())
    print(f"counts: {key} {sum(cur[key].values())} passed in {len(cur[key])} files (baseline {sum(base.get(key, {}).values())}, {new:+d})")
for d in drops: print("counts: DROP", d)
sys.exit(1 if drops else 0)
PY

fail_reason() { # "at <last step>: <first error-looking line after it>", one line
  local log="$1" n stepl detail
  [ -s "$log" ] || { echo "job did not start (no log)"; return; }
  n="$(grep -n '^+ ' "$log" | tail -1 | cut -d: -f1)"; n="${n:-0}"
  stepl="$(sed -n "${n}p" "$log" | cut -c3-80)"
  detail="$(tail -n +"$((n + 1))" "$log" | grep -m1 -E '\(fail\)|FAIL|DROP|GATE|VERSION|[Ee]rror|leaks found|not pinned|stale|new finding|Diff in|failed' | cut -c1-110)"
  echo "at ${stepl:-start}: ${detail:-see log}"
}
# ---- report -------------------------------------------------------------------------------------------------------
fail=0; jobfail=0
echo "ci-local: ${sha:0:7} results (logs: $work/logs)"
for j in $jobs; do
  if [ -f "$work/res/$j.rc" ]; then read -r rc secs <"$work/res/$j.rc"; else rc=1; secs=0; fi
  if [ "$rc" = 0 ]; then printf 'PASS %-11s %4ss\n' "$j" "$secs"
  else
    printf 'FAIL %-11s %4ss  %s\n' "$j" "$secs" "$(fail_reason "$work/logs/$j.log")"
    fail=1; jobfail=1
  fi
done
if [ "$counts_rc" = 0 ]; then echo "PASS test-counts"; else echo "FAIL test-counts  (a test file passed fewer tests than .github/ci-baseline.json)"; fail=1; fi
echo "ci-local: total $(( $(date +%s) - T0 ))s"
if [ "$update" = 1 ]; then
  if [ "$jobfail" = 0 ]; then   # every job passed; the counts may move either way (that is what an update is for)
    python3 - "$work/res/counts.json" "$repo/.github/ci-baseline.json" <<'PY'
import json, sys
cur = json.load(open(sys.argv[1])); p = sys.argv[2]
try: base = json.load(open(p))
except FileNotFoundError: base = {}
base.update(cur)   # only the suites that ran this time are replaced
json.dump(base, open(p, "w"), indent=1, sort_keys=True); open(p, "a").write("\n")
print("ci-local: wrote", p)
PY
  else echo "ci-local: baseline NOT written: a job failed"; fi
fi
[ "$keep" = 1 ] && echo "ci-local: kept $work"
if [ "$fail" = 0 ]; then echo "ci-local: PASS ${sha:0:7}"; else echo "ci-local: FAIL ${sha:0:7}"; fi
exit "$fail"
