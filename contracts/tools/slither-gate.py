#!/usr/bin/env python3
"""Exact-match gate for Slither: every finding must be listed in slither.allow, and every allowlist line must
still match a finding (stale lines fail too). Never silence Slither by editing deployed source: an inline
disable comment would change the verified source on the explorer.

Key per finding: "<check> <file>:<element>" (first element of the result). A key that appears N times must be
listed N times. Allowlist lines: "<key>  # reason" (the reason is required).

    python3 tools/slither-gate.py slither-report.json slither.allow
"""
import collections
import json
import sys


def keys_from_report(path: str) -> collections.Counter:
    data = json.load(open(path))
    if not data.get("success", False):
        sys.exit(f"slither-gate: slither did not succeed: {data.get('error')}")
    found = collections.Counter()
    for r in (data.get("results") or {}).get("detectors", []):
        el = r["elements"][0] if r.get("elements") else {}
        file = el.get("source_mapping", {}).get("filename_relative", "?")
        found[f"{r['check']} {file}:{el.get('name', '?')}"] += 1
    return found


def keys_from_allow(path: str) -> collections.Counter:
    allowed = collections.Counter()
    for n, line in enumerate(open(path), 1):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        key, sep, reason = s.partition("#")
        if not sep or not reason.strip():
            sys.exit(f"slither-gate: {path}:{n} has no reason after '#'")
        allowed[key.strip()] += 1
    return allowed


def main() -> int:
    found, allowed = keys_from_report(sys.argv[1]), keys_from_allow(sys.argv[2])
    new = found - allowed
    stale = allowed - found
    for k, c in sorted(new.items()):
        print(f"slither-gate: NEW finding (x{c}), fix it or add it to the allowlist with a reason: {k}")
    for k, c in sorted(stale.items()):
        print(f"slither-gate: STALE allowlist line (x{c}), remove it: {k}")
    print(f"slither-gate: {sum(found.values())} findings, {sum(allowed.values())} allowlisted, "
          f"{sum(new.values())} new, {sum(stale.values())} stale")
    return 1 if new or stale else 0


if __name__ == "__main__":
    sys.exit(main())
