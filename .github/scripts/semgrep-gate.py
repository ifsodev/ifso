#!/usr/bin/env python3
"""Exact-match gate for Semgrep on app/: every finding must be listed in semgrep.allow, and every allowlist line must still
match a finding (stale lines fail too). Never silence Semgrep by editing source: a `nosemgrep` comment is refused here.

Key per finding: "<rule-id> <file>: <the matched source line, trimmed>". The line text (not its number) keeps the key stable
when code above it moves. A key that appears N times must be listed N times. Allowlist lines: "<key>  # reason" (the reason is
required; the key ends at the last "  # " separator).

    semgrep --config .github/semgrep/rules.yml --metrics=off --disable-version-check --json --quiet app > semgrep-report.json
    python3 .github/scripts/semgrep-gate.py semgrep-report.json .github/semgrep/semgrep.allow [repo-root]
"""
import collections
import json
import os
import sys

SEP = "  # "


def keys_from_report(path: str, root: str) -> collections.Counter:
    data = json.load(open(path))
    if data.get("errors"):
        sys.exit(f"semgrep-gate: semgrep reported errors: {data['errors'][:2]}")
    found = collections.Counter()
    cache: dict[str, list[str]] = {}
    for r in data.get("results", []):
        file = r["path"]
        if file not in cache:
            cache[file] = open(os.path.join(root, file), encoding="utf-8").read().splitlines()
        line = cache[file][r["start"]["line"] - 1].strip()
        rule = r["check_id"].split(".")[-1]
        found[f"{rule} {file}: {line}"] += 1
    return found


def keys_from_allow(path: str) -> collections.Counter:
    allowed = collections.Counter()
    for n, raw in enumerate(open(path, encoding="utf-8"), 1):
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        key, sep, reason = s.rpartition(SEP)
        if not sep or not reason.strip():
            sys.exit(f"semgrep-gate: {path}:{n} has no reason after '  # '")
        allowed[key.strip()] += 1
    return allowed


def suppressions(root: str) -> list[str]:
    hits = []
    for base, _dirs, files in os.walk(os.path.join(root, "app")):
        if "node_modules" in base.split(os.sep):
            continue
        for f in files:
            if f.endswith((".ts", ".js", ".mjs")):
                p = os.path.join(base, f)
                if "nosemgrep" in open(p, encoding="utf-8", errors="ignore").read():
                    hits.append(os.path.relpath(p, root))
    return hits


def main() -> int:
    root = sys.argv[3] if len(sys.argv) > 3 else "."
    bad = suppressions(root)
    for p in bad:
        print(f"semgrep-gate: {p} contains a nosemgrep comment; list the finding in the allowlist instead")
    if bad:
        return 1
    found, allowed = keys_from_report(sys.argv[1], root), keys_from_allow(sys.argv[2])
    new, stale = found - allowed, allowed - found
    for k, c in sorted(new.items()):
        print(f"semgrep-gate: NEW finding (x{c}), fix it or add it to the allowlist with a reason: {k}")
    for k, c in sorted(stale.items()):
        print(f"semgrep-gate: STALE allowlist line (x{c}), remove it: {k}")
    print(f"semgrep-gate: {sum(found.values())} findings, {sum(allowed.values())} allowlisted, "
          f"{sum(new.values())} new, {sum(stale.values())} stale")
    return 1 if (new or stale) else 0


if __name__ == "__main__":
    sys.exit(main())
