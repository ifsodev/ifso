#!/usr/bin/env bash
# Runs the symbolic proofs in test/halmos with Halmos (free, pip). Installs into a throwaway venv from the
# hash-locked tools/halmos-requirements.txt unless `halmos` is already on PATH (CI installs it the same way).
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v halmos >/dev/null 2>&1; then
  py="${PYTHON:-python3}"
  venv="${HALMOS_VENV:-$(mktemp -d)/venv}"
  "$py" -m venv "$venv"
  "$venv/bin/pip" install -q --require-hashes -r tools/halmos-requirements.txt
  export PATH="$venv/bin:$PATH"
fi
halmos --version
FOUNDRY_PROFILE=halmos halmos --forge-build-out out-halmos --contract IfsoHalmosTest \
  --solver-timeout-assertion 120000 --json-output "${HALMOS_JSON:-/dev/null}" "$@"
