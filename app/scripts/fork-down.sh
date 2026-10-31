#!/usr/bin/env bash
# Stops what fork-up.sh started, by PID file only (never a pattern kill). Keeps app/.fork logs and keys unless --clean.
set -uo pipefail
app="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORK_DIR="${FORK_DIR:-$app/.fork}"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}"
stop() { [ -f "$FORK_DIR/$1.pid" ] && { kill "$(cat "$FORK_DIR/$1.pid")" 2>/dev/null; rm -f "$FORK_DIR/$1.pid"; echo "stopped $1"; }; }
stop serve; stop anvil
[ -d "$FORK_DIR/pg/data" ] && "$PGBIN/pg_ctl" -D "$FORK_DIR/pg/data" -m fast -w stop >/dev/null 2>&1 && echo "stopped postgres"
[ "${1:-}" = "--clean" ] && rm -rf "$FORK_DIR"
exit 0
