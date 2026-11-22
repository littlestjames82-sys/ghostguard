/**
 * Trail loading, filtering, tallies, and secret redaction — shared
 * by the incident report (more-ideas #9) and the public badge /
 * summary (more-ideas #17).
 *
 * Accepted JSONL shapes (one per line):
 *   1. A plain GatewayRecord, as written by ghostguard's reference
 *      JSONL recorder (optionally carrying a received_at stamp, as
 *      the Cloud list endpoint returns them).
 *   2. A Cloud store entry { entry_type: "record", workspace,
 *      received_at, record } — unwrapped, stamp carried over.
 *      Decision entries are skipped (they are not actions).
 * A malformed line throws: a corrupt trail should be loud, not
 * silently truncated — the same stance as readGatewayRecords().
 */

import { readFileSync } from "node:fs";

export function parseTrailText(text) {
  const records = [];
  let skippedDecisions = 0;
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  lines.forEach((line, i) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (err) {
      throw new Error(`trail line ${i + 1} is not valid JSON: ${err.message}`);
    }
    if (entry && entry.entry_type === "decision") {
      skippedDecisions++;
      return;
    }
    if (entry && entry.entry_type === "record" && entry.record) {
      records.push({ ...entry.record, received_at: entry.received_at ?? null });
      return;
    }
    records.push(entry);
  });
  return { records, skippedDecisions };
}

export function loadTrail(path) {
  return parseTrailText(readFileSync(path, "utf8"));
}

/** The timestamp a record carries, if any (received_at from Cloud,
 *  or a timestamp field on plain records). Null when un-stamped. */
export function recordTime(r) {
  const t = r.received_at ?? r.timestamp ?? null;
  if (typeof t !== "string") return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : t;
}

/**
 * Filter records. All filters optional:
 *   actors:  string[] — keep records whose actor is in the list
 *   verdicts: string[] — keep matching verdicts
 *   projectId: string
 *   from/to: ISO strings — keep records whose carried timestamp is
 *            in range. Records with NO timestamp are excluded when a
 *            time bound is set (they cannot be shown to be in range;
 *            fail-closed filtering for an evidence report).
 */
export function filterRecords(records, filters = {}) {
  const { actors, verdicts, projectId, from, to } = filters;
  const fromMs = from ? Date.parse(from) : null;
  const toMs = to ? Date.parse(to) : null;
  return records.filter((r) => {
    if (actors && actors.length > 0 && !actors.includes(r.actor)) return false;
    if (verdicts && verdicts.length > 0 && !verdicts.includes(r.verdict)) return false;
    if (projectId && r.project_id !== projectId) return false;
    if (fromMs !== null || toMs !== null) {
      const t = recordTime(r);
      if (t === null) return false;
      const ms = Date.parse(t);
      if (fromMs !== null && ms < fromMs) return false;
      if (toMs !== null && ms > toMs) return false;
    }
    return true;
  });
}

/** Tallies over a record set. Counts only — safe at any audience. */
export function tallyRecords(records) {
  const byVerdict = {};
  const byRule = {};
  const byClass = {};
  for (const r of records) {
    byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
    const rule = r.rule_id ?? "(none)";
    byRule[rule] = (byRule[rule] ?? 0) + 1;
    const cls = r.permission_class ?? "(unclassified)";
    byClass[cls] = (byClass[cls] ?? 0) + 1;
  }
  return { total: records.length, byVerdict, byRule, byClass };
}

/** Locked rule ids from a ghostguard PolicyDoc ({ rules: [...] }). */
export function lockedRuleIds(policyDoc) {
  if (!policyDoc || !Array.isArray(policyDoc.rules)) return new Set();
  return new Set(policyDoc.rules.filter((r) => r.locked).map((r) => r.id));
}

/* ---------------- secret hygiene ---------------- */

const SECRET_FIELD =
  /(secret|token|pass(word|wd)?|api[-_]?key|private[-_]?key|credential|auth|cookie|session)/i;

export function isSecretField(name) {
  return SECRET_FIELD.test(String(name));
}

function describeValue(v) {
  if (typeof v === "string") return { type: "string", length: v.length };
  if (v === null) return { type: "null", length: 0 };
  if (Array.isArray(v)) return { type: "array", length: v.length };
  if (typeof v === "object") return { type: "object", length: Object.keys(v).length };
  return { type: typeof v, length: String(v).length };
}

/**
 * Return a deep copy of a payload/target with every secret-ish field
 * replaced by "[redacted: <type>, length <n>]" — the record shows a
 * secret was involved, its type and length, never its value. The
 * same stance the ghostguard recorder contract takes.
 */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretField(k)) {
        const d = describeValue(v);
        out[k] = `[redacted: ${d.type}, length ${d.length}]`;
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

/** HTML-escape any interpolated value. Reports render record data,
 *  which is attacker-shaped until proven otherwise. */
export function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
