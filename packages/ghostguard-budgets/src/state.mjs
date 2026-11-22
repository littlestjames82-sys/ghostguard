/**
 * File-backed state store for ghostguard-budgets.
 *
 * State shape: { version: 1, events: [{ ts, actor, project_id, kind,
 * permission_class, amount }] } — one event per action whose final
 * verdict was allow / pre_approved (i.e. the action was cleared to
 * execute). Denied / asked actions are never counted: a budget measures
 * what actually went out, not what was attempted.
 *
 * Writes are atomic-ish: serialise to a temp file in the same
 * directory, then rename over the target, so a crash mid-write leaves
 * either the old state or the new state, never a torn file.
 *
 * Loads are strict on purpose: a file that exists but cannot be read
 * or parsed throws StateStoreError, and the guard turns that into a
 * fail-closed deny. Only a MISSING file means "empty state".
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class StateStoreError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "StateStoreError";
    if (cause) this.cause = cause;
  }
}

export function loadState(statePath) {
  if (!existsSync(statePath)) return { version: 1, events: [] };
  let raw;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch (err) {
    throw new StateStoreError(`cannot read state file ${statePath}: ${err.message}`, err);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StateStoreError(`state file ${statePath} is corrupt (not JSON): ${err.message}`, err);
  }
  if (!parsed || !Array.isArray(parsed.events)) {
    throw new StateStoreError(`state file ${statePath} is corrupt (no events array)`);
  }
  return { version: 1, events: parsed.events };
}

export function saveState(statePath, state) {
  const dir = dirname(statePath);
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${statePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    renameSync(tmp, statePath);
  } catch (err) {
    throw new StateStoreError(`cannot persist state file ${statePath}: ${err.message}`, err);
  }
}
