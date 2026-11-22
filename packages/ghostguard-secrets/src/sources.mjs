import { readFileSync } from "node:fs";

/**
 * Secret sources for the broker.
 *
 * A source is the ONLY component (besides the broker itself) that ever
 * touches raw secret values. Its interface is deliberately tiny:
 *
 *   resolve(name) -> { value: string, type: string } | null
 *
 * `resolve` is the value read. Every source counts value reads in
 * `stats.valueReads` (and `stats.readsByName`), because the broker's
 * core promise is testable through that counter: on a deny / ask
 * verdict the broker never calls resolve, so the counter must not
 * move. Existence checks (`has`) never return a value.
 *
 * Sources hold values in memory; nothing here logs, prints, or
 * serialises a value.
 */

function bump(stats, name) {
  stats.valueReads += 1;
  stats.readsByName[name] = (stats.readsByName[name] ?? 0) + 1;
}

/** In-memory source — for tests and demos. Entries are either a plain
 *  string value or { type, value }. */
export function createMapSecretSource(entries = {}) {
  const stats = { valueReads: 0, readsByName: {} };
  return {
    kind: "map",
    stats,
    has(name) {
      return Object.prototype.hasOwnProperty.call(entries, name);
    },
    resolve(name) {
      bump(stats, name);
      const entry = entries[name];
      if (entry == null) return null;
      if (typeof entry === "string") return { value: entry, type: "unknown" };
      if (typeof entry.value !== "string") return null;
      return { value: entry.value, type: entry.type ?? "unknown" };
    },
  };
}

/** Environment-variable source. Secret names ARE env var names.
 *  Pass an env object (defaults to process.env) — tests pass a fake
 *  env so no real environment is ever read. */
export function createEnvSecretSource(env = process.env) {
  const stats = { valueReads: 0, readsByName: {} };
  return {
    kind: "env",
    stats,
    has(name) {
      return typeof env[name] === "string";
    },
    resolve(name) {
      bump(stats, name);
      const value = env[name];
      return typeof value === "string" ? { value, type: "env" } : null;
    },
  };
}

/**
 * Local JSON file source. File shape:
 *   { "<name>": { "type": "api_key", "value": "..." }, ... }
 * or { "<name>": "..." }.
 *
 * The file must live OUTSIDE the audit path (never next to, never
 * inside, the JSONL trail) — keeping the trail and the values in
 * different files is the whole point. The file is loaded lazily on
 * the first resolve and cached in memory; it is never copied,
 * logged, or written anywhere by this module.
 */
export function createFileSecretSource(filePath) {
  const stats = { valueReads: 0, readsByName: {} };
  let cache = null;
  function load() {
    if (cache === null) {
      cache = JSON.parse(readFileSync(filePath, "utf8"));
    }
    return cache;
  }
  return {
    kind: "file",
    stats,
    has(name) {
      return Object.prototype.hasOwnProperty.call(load(), name);
    },
    resolve(name) {
      bump(stats, name);
      const entry = load()[name];
      if (entry == null) return null;
      if (typeof entry === "string") return { value: entry, type: "unknown" };
      if (typeof entry.value !== "string") return null;
      return { value: entry.value, type: entry.type ?? "unknown" };
    },
  };
}
