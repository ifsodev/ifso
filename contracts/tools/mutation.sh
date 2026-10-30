#!/usr/bin/env bash
# Mutation testing (free, hand mutants). Writes .audit-grade/mutation.md. See tools/mutation.py.
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 tools/mutation.py "$@"
