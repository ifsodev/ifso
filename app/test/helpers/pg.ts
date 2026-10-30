// A throwaway plain Postgres 16 cluster on a FREE port. The port is chosen by binding :0, reading it back and
// releasing it; if another run grabs it first, start fails and we pick again (up to 8 tries), so two runs in
// parallel never fight over one port. Stops only the cluster it started, by data directory.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const pgBin = () =>
  ["/opt/homebrew/opt/postgresql@16/bin", "/usr/local/opt/postgresql@16/bin", "/usr/lib/postgresql/16/bin"].find((d) => existsSync(join(d, "pg_ctl"))) ??
  Bun.which("pg_ctl")?.replace(/\/pg_ctl$/, "");

const run = (cmd: string[]) => Bun.spawnSync(cmd, { env: { ...process.env, LC_ALL: "C", LANG: "C" }, stdout: "pipe", stderr: "pipe" });

/** Asks the OS for an unused TCP port (bind :0, read it, release it). */
export function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

export interface PgCluster {
  url: string;
  port: number;
  stop(): void;
}

export function startPg(prefix = "ifso-pg-"): PgCluster {
  const bin = pgBin();
  if (!bin) throw new Error("postgres missing");
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const data = join(dir, "data");
  const init = run([`${bin}/initdb`, "-D", data, "-U", "ifso", "--auth=trust", "-E", "UTF8", "--locale=C"]);
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
  let last = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = freePort();
    const start = run([`${bin}/pg_ctl`, "-D", data, "-w", "-l", join(dir, "log"), "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, "start"]);
    if (start.exitCode === 0) {
      return {
        url: `postgres://ifso@127.0.0.1:${port}/postgres`,
        port,
        stop() {
          run([`${bin}/pg_ctl`, "-D", data, "-m", "fast", "-w", "stop"]);
          rmSync(dir, { recursive: true, force: true });
        },
      };
    }
    last = start.stderr.toString() + start.stdout.toString();
  }
  rmSync(dir, { recursive: true, force: true });
  throw new Error(`could not start postgres on a free port: ${last.slice(0, 300)}`);
}
