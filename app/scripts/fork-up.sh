#!/usr/bin/env bash
# One command: anvil fork of Robinhood Chain (4663) -> full deploy on the fork -> Postgres -> funded test wallets ->
# the real API + workers. Fork only; nothing here can reach a real network with a write (anvil answers every call).
#
#   bash app/scripts/fork-up.sh            ports: anvil 8555, API 8090 (+1 admin, +2 dev signer)
#   ANVIL_PORT=.. API_PORT=.. FORK_DIR=.. bash app/scripts/fork-up.sh
#
# State lives in app/.fork (gitignored): pids, logs, keystores, env.json, actors.json. Stop with fork-down.sh.
# Redis is not used: the fork API keeps its rate limits in memory and runs the workers on timers (see fork/serve.ts).
set -euo pipefail
export LC_ALL=C LANG=C
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"
app="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(cd "$app/.." && pwd)"
FORK_DIR="${FORK_DIR:-$app/.fork}"; export FORK_DIR
ANVIL_PORT="${ANVIL_PORT:-8555}"; API_PORT="${API_PORT:-8090}"; export ANVIL_PORT API_PORT
UPSTREAM="${FORK_UPSTREAM_RPC:-https://rpc.mainnet.chain.robinhood.com}"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}"
mkdir -p "$FORK_DIR/logs"; chmod 700 "$FORK_DIR"
[ ! -f "$FORK_DIR/anvil.pid" ] || { echo "fork-up: $FORK_DIR/anvil.pid exists; run fork-down.sh first" >&2; exit 1; }
for p in "$ANVIL_PORT" "$API_PORT" "$((API_PORT+1))" "$((API_PORT+2))"; do
  ! lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 || { echo "fork-up: port $p is busy" >&2; exit 1; }
done
rm -f "$FORK_DIR/keys.json" "$FORK_DIR/env.json" "$FORK_DIR/actors.json"

echo "fork-up: anvil fork of 4663 on :$ANVIL_PORT"
anvil --fork-url "$UPSTREAM" -p "$ANVIL_PORT" --host 127.0.0.1 --block-time 1 --silent >"$FORK_DIR/logs/anvil.log" 2>&1 &
echo $! >"$FORK_DIR/anvil.pid"
for _ in $(seq 1 60); do cast chain-id --rpc-url "http://127.0.0.1:$ANVIL_PORT" >/dev/null 2>&1 && break; sleep 0.5; done

# the resolver service key must exist before the deploy (it becomes the registered question creator)
cd "$app"
bun -e '
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { writeFileSync } from "node:fs";
const k = { relayer: generatePrivateKey(), keeper: generatePrivateKey(), resolver: generatePrivateKey() };
writeFileSync(process.env.FORK_DIR + "/keys.json", JSON.stringify(k), { mode: 0o600 });
console.log(privateKeyToAccount(k.resolver).address);
' >"$FORK_DIR/resolver.addr"
export RESOLVER_CREATOR="$(cat "$FORK_DIR/resolver.addr")"

echo "fork-up: deploy (contracts/script/fork-dryrun.sh)"
(cd "$repo/contracts" && bash script/fork-dryrun.sh "$ANVIL_PORT") | tee "$FORK_DIR/logs/deploy.log" | tail -2

echo "fork-up: postgres"
pgdir="$FORK_DIR/pg"; rm -rf "$pgdir"
"$PGBIN/initdb" -D "$pgdir/data" -U ifso --auth=trust -E UTF8 --locale=C >/dev/null
pgport="$(bun -e 'const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(s.port);s.stop(true)')"
"$PGBIN/pg_ctl" -D "$pgdir/data" -w -l "$FORK_DIR/logs/postgres.log" -o "-p $pgport -k $pgdir -c listen_addresses=127.0.0.1" start >/dev/null
echo "$pgport" >"$FORK_DIR/pg.port"
export DATABASE_URL="postgres://ifso@127.0.0.1:$pgport/postgres"
bun run src/db/migrate.ts >"$FORK_DIR/logs/migrate.log" 2>&1

echo "fork-up: keys, funding, ownership"
bun run scripts/fork/setup.ts

echo "fork-up: api + workers"
nohup bun run scripts/fork/serve.ts >"$FORK_DIR/logs/serve.log" 2>&1 &
echo $! >"$FORK_DIR/serve.pid"
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$API_PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fs "http://127.0.0.1:$API_PORT/healthz" && echo
echo "fork-up: ready. chain 4663 (fork) rpc http://127.0.0.1:$ANVIL_PORT api http://127.0.0.1:$API_PORT"
