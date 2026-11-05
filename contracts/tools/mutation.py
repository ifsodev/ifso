#!/usr/bin/env python3
"""Mutation testing with hand-written mutants (tools/mutants.py), free and dependency-free.

For each mutant: patch one source file in a throwaway copy of contracts/, run the default forge suite, and record
KILLED (a test failed) or SURVIVED (all tests passed). A mutant that does not compile is INVALID and reported, and
a mutant whose `find` text is missing or ambiguous is STALE: any stale or invalid mutant fails the run, so a moved
line can never silently drop out of the score. Writes ../.audit-grade/mutation.md (and mutation.json).

usage: python3 tools/mutation.py [--only ID,ID] [--min-score 90] [--out DIR]
       python3 tools/mutation.py --check-find   (seconds, no forge: exit 1 when any mutant's find text is stale)"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile, time
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # contracts/
sys.path.insert(0, HERE)
from mutants import MUTANTS  # noqa: E402

SKIP = {"out", "cache", "broadcast", "node_modules", "out-halmos", "cache-halmos", "docs", ".armed"}


def run(cmd, cwd, timeout):
    env = dict(os.environ, FOUNDRY_PROFILE="default")
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env)
        return p.returncode, p.stdout + p.stderr
    except subprocess.TimeoutExpired as e:
        return 124, (e.stdout or "") + "timeout"


def check_find():
    """The cheap half of the run: every mutant's `find` text occurs exactly `count` times (default 1) in its source file,
    so a reformatted or moved line fails the fast gate instead of only the slow mutation job."""
    stale = []
    for m in MUTANTS:
        try:
            src = open(os.path.join(ROOT, "src", m["file"])).read()
        except OSError:
            stale.append(f"{m['id']}: {m['file']} not found")
            continue
        n, want = src.count(m["find"]), m.get("count", 1)
        if n != want:
            stale.append(f"{m['id']}: find text occurs {n}x in {m['file']}, expected {want}x")
    for s in stale:
        print("STALE", s)
    print(f"mutation --check-find: {len(MUTANTS) - len(stale)} of {len(MUTANTS)} mutants find their text")
    return 1 if stale else 0


def main():
    if sys.argv[1:] == ["--check-find"]:
        sys.exit(check_find())
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--min-score", type=float, default=0)
    ap.add_argument("--out", default=os.path.join(ROOT, "..", ".audit-grade"))
    a = ap.parse_args()
    only = {x for x in a.only.split(",") if x}
    work = tempfile.mkdtemp(prefix="ifso-mut-")
    tmp = os.path.join(work, "contracts")
    shutil.copytree(ROOT, tmp, ignore=lambda d, names: [n for n in names if n in SKIP])
    print(f"mutation: copy at {tmp}", flush=True)
    code, out = run(["forge", "test"], tmp, 1800)
    if code != 0:
        print(out[-3000:])
        sys.exit("mutation: the unmutated suite does not pass; fix that first")
    print("mutation: baseline green", flush=True)

    results, started = [], time.time()
    for m in MUTANTS:
        if only and m["id"] not in only:
            continue
        path = os.path.join(tmp, "src", m["file"])
        orig = open(path).read()
        n = orig.count(m["find"])
        want = m.get("count", 1)
        r = dict(id=m["id"], file=m["file"], finding=m["finding"], why=m["why"])
        if n != want:
            r["status"] = "STALE"
            r["detail"] = f"find text occurs {n}x, expected {want}x"
        else:
            nth = m.get("nth")
            if nth:
                parts = orig.split(m["find"])
                mutated = "".join(parts[i] + (m["repl"] if i == nth - 1 else m["find"]) for i in range(len(parts) - 1)) + parts[-1]
            else:
                mutated = orig.replace(m["find"], m["repl"])
            open(path, "w").write(mutated)
            code, out = run(["forge", "test"], tmp, 1800)
            open(path, "w").write(orig)
            if code == 0 and m.get("equivalent"):
                r["status"] = "EQUIVALENT"
                r["detail"] = m["equivalent"]
            elif code == 0:
                r["status"] = "SURVIVED"
            elif "Compiler run failed" in out or "Error (" in out and "[FAIL" not in out:
                r["status"] = "INVALID"
                r["detail"] = out[-300:]
            else:
                r["status"] = "KILLED"
                fails = [l.strip() for l in out.splitlines() if l.strip().startswith("[FAIL")]
                r["killedBy"] = re.sub(r"[;,]? ?counterexample.*", "", fails[0])[:120] if fails else "test failure"
        results.append(r)
        print(f"  {r['status']:9s} {r['id']:22s} {r['file']}", flush=True)
    shutil.rmtree(work, ignore_errors=True)

    by_file = OrderedDict()
    for r in results:
        d = by_file.setdefault(r["file"], dict(killed=0, total=0))
        if r["status"] in ("KILLED", "SURVIVED"):
            d["total"] += 1
            d["killed"] += r["status"] == "KILLED"
    killed = sum(d["killed"] for d in by_file.values())
    total = sum(d["total"] for d in by_file.values())
    score = 100.0 * killed / total if total else 0.0
    bad = [r for r in results if r["status"] in ("STALE", "INVALID")]
    survivors = [r for r in results if r["status"] == "SURVIVED"]
    equiv = [r for r in results if r["status"] == "EQUIVALENT"]

    os.makedirs(a.out, exist_ok=True)
    if not only:
        L = ["# Mutation score", "",
             "Hand-written mutants (`contracts/tools/mutants.py`) are patched one at a time into a throwaway copy of",
             "`contracts/src`; the default `forge test` suite (unit, fuzz and the short invariant profile) must fail.",
             "Re-run: `python3 contracts/tools/mutation.py` (needs Foundry 1.8.4; about "
             f"{int((time.time() - started) / 60)} minutes). A stale or non-compiling mutant fails the run.", "",
             f"**Total: {killed}/{total} killed ({score:.1f}%)**"
             + (f" ({len(equiv)} equivalent mutant(s) excluded, listed below)" if equiv else ""), "",
             "| File | Killed | Total | Score |", "|---|---|---|---|"]
        for f, d in by_file.items():
            L.append(f"| `{f}` | {d['killed']} | {d['total']} | {100.0 * d['killed'] / max(d['total'], 1):.1f}% |")
        L += ["", "## Review finding mutants (each undoes one fix)", "", "| Mutant | Finding | What it undoes | Result |", "|---|---|---|---|"]
        for r in results:
            if r["finding"] != "-":
                L.append(f"| {r['id']} | {r['finding']} | {r['why']} | {r['status']} |")
        L += ["", "## Survivors", ""]
        if survivors:
            L += ["| Mutant | File | What it changes |", "|---|---|---|"] + [f"| {r['id']} | `{r['file']}` | {r['why']} |" for r in survivors]
        else:
            L.append("None.")
        if equiv:
            L += ["", "## Equivalent mutants (no observable behaviour change)", ""] + [f"- {r['id']} (`{r['file']}`): {r['detail']}" for r in equiv]
        if bad:
            L += ["", "## Stale or invalid (run failed)", ""] + [f"- {r['id']}: {r['status']} {r.get('detail', '')}" for r in bad]
        L += ["", "## All mutants", "", "| Mutant | File | Result | First failing test |", "|---|---|---|---|"]
        for r in results:
            L.append(f"| {r['id']} | `{r['file']}` | {r['status']} | {r.get('killedBy', '').replace('|', '/')} |")
        open(os.path.join(a.out, "mutation.md"), "w").write("\n".join(L) + "\n")
        json.dump(dict(killed=killed, total=total, score=round(score, 1), results=results), open(os.path.join(a.out, "mutation.json"), "w"), indent=1)
    print(f"mutation score: {killed}/{total} = {score:.1f}%  survivors: {[r['id'] for r in survivors]}  stale/invalid: {[r['id'] for r in bad]}")
    if bad or score < a.min_score:
        sys.exit(1)


if __name__ == "__main__":
    main()
