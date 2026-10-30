#!/usr/bin/env python3
"""NatSpec gate: every external/public function in the deployable sources has @notice (or @inheritdoc) and an
@param line for each named parameter. Scans src/*.sol and src/utils/*.sol (mocks, interfaces and libraries of
internal helpers are out of scope). Exit 1 with one line per gap.

    python3 tools/natspec-check.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = sorted(list((ROOT / "src").glob("*.sol")) + list((ROOT / "src" / "utils").glob("*.sol")))
FUNC = re.compile(r"^\s*function\s+(\w+)\s*\(", re.M)


def signature_at(text: str, start: int) -> str:
    """Text from `function` up to the opening brace or semicolon."""
    end = min(i for i in (text.find("{", start), text.find(";", start)) if i != -1)
    return text[start:end]


def params_of(sig: str) -> list[str]:
    inner = sig[sig.index("(") + 1:]
    depth, buf = 1, ""
    for ch in inner:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                break
        buf += ch
    names = []
    for part in buf.split(","):
        words = part.split()
        if len(words) >= 2 and words[-1] not in ("memory", "calldata", "storage", "payable"):
            names.append(words[-1])
    return names


def doc_before(text: str, start: int) -> str:
    lines = text[:start].rstrip("\n").split("\n")
    doc = []
    for line in reversed(lines):
        s = line.strip()
        if s.startswith("///") or s.startswith("*") or s.startswith("/**"):
            doc.append(s)
        else:
            break
    return "\n".join(reversed(doc))


def main() -> int:
    gaps, checked = [], 0
    for f in FILES:
        text = f.read_text()
        for m in FUNC.finditer(text):
            sig = signature_at(text, m.start())
            if not re.search(r"\b(external|public)\b", sig.split(")", 1)[-1] if ")" in sig else sig):
                continue
            checked += 1
            doc = doc_before(text, m.start())
            rel = f.relative_to(ROOT)
            if "@inheritdoc" in doc:
                continue
            if "@notice" not in doc:
                gaps.append(f"{rel}: {m.group(1)}: missing @notice")
            for p in params_of(sig):
                if not re.search(rf"@param\s+{re.escape(p)}\b", doc):
                    gaps.append(f"{rel}: {m.group(1)}: missing @param {p}")
    for g in gaps:
        print(g)
    print(f"natspec-check: {checked} external/public functions, {len(gaps)} gaps")
    return 1 if gaps else 0


if __name__ == "__main__":
    sys.exit(main())
