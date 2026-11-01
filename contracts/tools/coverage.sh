#!/usr/bin/env bash
# forge coverage (summary) over the deployable sources, written as markdown for .audit-grade/coverage.md.
#   tools/coverage.sh [--out FILE] [--min-lines PCT]
# Mocks, tests and scripts are excluded. Falls back to --ir-minimum when the default run hits stack-too-deep.
set -euo pipefail
cd "$(dirname "$0")/.."
out="../.audit-grade/coverage.md"; min=0
while [ $# -gt 0 ]; do case "$1" in --out) out="$2"; shift 2;; --min-lines) min="$2"; shift 2;; *) echo "unknown arg $1"; exit 2;; esac; done
raw="$(mktemp)"; trap 'rm -f "$raw"' EXIT
# Coverage instruments the bytecode, so the test that compares runtime code with the build cannot pass under it; it
# runs in the normal `forge test` job.
skip="test_PostDeploy_RuntimeCodeMatchesBuild"
mode="default"
if ! forge coverage --report summary --code-size-limit 500000 --no-match-coverage '(^test/|^script/|^src/mocks/)' --no-match-test "$skip" >"$raw" 2>&1; then
  mode="--ir-minimum"
  forge coverage --report summary --ir-minimum --code-size-limit 500000 --no-match-coverage '(^test/|^script/|^src/mocks/)' --no-match-test "$skip" >"$raw" 2>&1
fi
python3 - "$raw" "$out" "$min" "$mode" <<'PY'
import re, sys, datetime
raw, out, mn, mode = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
rows = []
for l in open(raw):
    if l.startswith("|") and "File" not in l and not l.startswith("|--") and not l.startswith("| --"):
        cells = [c.strip() for c in l.strip().strip("|").split("|")]
        if len(cells) == 5 and (cells[0].startswith("src/") or cells[0] == "Total"):
            rows.append(cells)
if not rows:
    sys.exit("coverage: no table in forge output:\n" + open(raw).read()[-2000:])
pct = lambda c: float(re.match(r"([\d.]+)%", c).group(1))
total = [r for r in rows if r[0] == "Total"][0]
files = [r for r in rows if r[0] != "Total"]
L = ["# Coverage", "",
     "`forge coverage --report summary` over the deployable sources (`src/`, mocks excluded), default test profile"
     f"{'' if mode == 'default' else ' with --ir-minimum'}. Re-run: `bash contracts/tools/coverage.sh`.",
     "Fork tests are skipped without an RPC, so fork-only paths are not counted here.", "",
     "| File | Lines | Statements | Branches | Functions |", "|---|---|---|---|---|"]
for r in files:
    L.append("| `%s` | %s | %s | %s | %s |" % tuple(r))
L.append("| **Total** | **%s** | **%s** | **%s** | **%s** |" % tuple(total[1:]))
L += ["", f"**Line coverage {pct(total[1]):.2f}%, branch coverage {pct(total[3]):.2f}%.**", ""]
open(out, "w").write("\n".join(L))
print(f"coverage: lines {total[1]} statements {total[2]} branches {total[3]} functions {total[4]}")
if pct(total[1]) < mn:
    sys.exit(f"coverage: line coverage {pct(total[1])}% is below the floor {mn}%")
PY
