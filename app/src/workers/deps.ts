import type { Env } from "../config/env";
import type { Clients } from "../chain";
import type { Db } from "../db/client";

export interface Deps {
  env: Env;
  db: Db;
  clients: Clients;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export const consoleLog = (scope: string) => (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), scope, msg, ...(extra ?? {}) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
