/**
 * Trail loading for GhostGuard Replay + Guard Score.
 *
 * A trail is a JSONL file of GhostGuard GatewayRecords — one record per
 * line, exactly what GhostGuard's reference recorder
 * (createJsonlRecorder in the ghostguard package) writes. Blank lines are
 * ignored. Anything else that is not a record-shaped object is reported
 * in `errors` with its 1-based line number — never silently skipped.
 * (GhostGuard's own readGatewayRecords throws on a malformed line; this
 * loader is for reporting tools, so it collects every problem and lets
 * the caller decide — the CLIs print the errors and exit 1.)
 */

import { readFileSync } from "node:fs";

export const VERDICTS = ["allow", "pre_approved", "ask", "hand_off", "deny"];

/** Minimal shape a line must have to count as a GatewayRecord at all. */
export function recordShapeProblem(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "not a JSON object";
  }
  if (typeof value.action_id !== "string" || value.action_id === "") {
    return "missing/non-string action_id";
  }
  if (typeof value.kind !== "string" || value.kind === "") {
    return "missing/non-string kind";
  }
  if (typeof value.verdict !== "string" || !VERDICTS.includes(value.verdict)) {
    return `missing/invalid verdict (${JSON.stringify(value.verdict ?? null)})`;
  }
  return null;
}

/**
 * Parse trail text. Returns { records, errors } where each record is
 * the parsed object plus a `_line` field (1-based source line) the
 * reporting tools carry through to their diffs.
 */
export function parseTrail(text) {
  const records = [];
  const errors = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === "") continue;
    const line = i + 1;
    let value;
    try {
      value = JSON.parse(raw);
    } catch (err) {
      errors.push({ line, message: `invalid JSON: ${err.message}` });
      continue;
    }
    const problem = recordShapeProblem(value);
    if (problem) {
      errors.push({ line, message: `not a GatewayRecord: ${problem}` });
      continue;
    }
    records.push({ ...value, _line: line });
  }
  return { records, errors };
}

export function loadTrail(filePath) {
  const text = readFileSync(filePath, "utf8");
  const { records, errors } = parseTrail(text);
  return { records, errors, source: filePath };
}

/** Strip the loader's bookkeeping field before emitting a record. */
export function publicRecord(record) {
  const { _line, ...rest } = record;
  return rest;
}
