import type { Env } from "../config/env";
import type { Clients } from "../chain";
import type { Db } from "../db/client";
import type { AlertFn } from "../ops/alerts";
import type { SourceFetchers } from "../sources";

export interface Deps {
  env: Env;
  db: Db;
  clients: Clients;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Ops alert (deduped per cause, log-only unless ALERTS_ARMED=1). Workers raise through `raise`. */
  alert?: AlertFn;
  /** Provider reads for the resolver. Defaults to the live providers; tests replay recorded fixtures. */
  sources?: SourceFetchers;
}

export const consoleLog = (scope: string) => (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), scope, msg, ...(extra ?? {}) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

/** Ops alert from a worker. Never throws: an alert failure must not stop a sweep. Falls back to a log line. */
export async function raise(deps: Deps, cause: string, text: string): Promise<void> {
  try {
    if (deps.alert) await deps.alert(cause, text);
    else deps.log(`ALERT ${cause}`, { text });
  } catch (e) {
    deps.log("alert failed", { cause, error: String((e as Error)?.message ?? e) });
  }
}
