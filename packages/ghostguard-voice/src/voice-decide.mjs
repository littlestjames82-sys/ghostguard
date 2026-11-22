// GhostGuard voice approval — library.
//
// Answers a pending GhostGuard `ask` / `hand_off` gateway record with a
// decision carried by a voice recording. The recording is treated as
// OPAQUE BYTES: it is copied verbatim into an evidence folder and its
// SHA-256 is recorded. It is never transcribed, normalised, or altered
// by this code, and NOTHING here attempts to identify the speaker —
// v1 is "voice as the channel, the human's device/recording as the
// evidence", not a biometric. See SPEC.md.
//
// Shapes follow GhostGuard's own contracts (read, not modified):
//  - Trail records are GatewayRecord objects (src/gateway.ts in the
//    ghostguard package), one per JSONL line; Cloud-store files may
//    wrap them as { entry_type: "record", record: {...} }.
//  - Decision entries mirror the Cloud store's decision shape
//    ({ entry_type: "decision", action_id, project_id, decision,
//    approver, decided_at }) plus the voice-evidence fields.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { hashBytes, hashValue } from "./hash.mjs";

export const DECIDABLE_VERDICTS = new Set(["ask", "hand_off"]);

function parseJsonl(path, label) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const entries = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      throw new Error(`${label}: line ${i + 1} is not valid JSON (${path})`);
    }
  }
  return entries;
}

/** Unwrap a trail line to its gateway record, or null if it isn't one. */
function asRecord(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.entry_type === "record" && entry.record) return entry.record;
  if (entry.entry_type === "decision") return null;
  if (typeof entry.action_id === "string" && typeof entry.verdict === "string") return entry;
  return null;
}

function isDecisionFor(entry, actionId) {
  return entry && entry.entry_type === "decision" && entry.action_id === actionId;
}

/** Load the gateway records from a JSONL trail file. */
export function readTrail(trailPath) {
  return parseJsonl(trailPath, "trail").map(asRecord).filter(Boolean);
}

/** Load decision entries from a decisions JSONL file (missing file = none). */
export function readDecisions(decisionsPath) {
  return parseJsonl(decisionsPath, "decisions").filter((e) => e && e.entry_type === "decision");
}

/** Pending = decidable verdicts (ask / hand_off) with no decision yet. */
export function listPending(trailPath, decisionsPath) {
  const decided = new Set(readDecisions(decisionsPath).map((d) => d.action_id));
  return readTrail(trailPath).filter(
    (r) => DECIDABLE_VERDICTS.has(r.verdict) && !decided.has(r.action_id),
  );
}

function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, "_");
}

/**
 * Record a voice decision for a pending ask.
 *
 * @param {object} opts
 * @param {string} opts.trailPath     JSONL trail containing the ask record.
 * @param {string} opts.decisionsPath JSONL decisions file (appended to, never rewritten).
 * @param {string} opts.evidenceDir   Folder the recording is copied into, verbatim.
 * @param {string} opts.actionId      The ask's action_id.
 * @param {string} opts.audioPath     The voice recording (any format, opaque bytes).
 * @param {"approve"|"deny"} opts.decision
 * @param {string} opts.approver      The human's name (self-asserted — see SPEC.md).
 * @param {string} [opts.decidedAt]   ISO timestamp override (tests); defaults to now.
 * @returns {object} the decision entry that was appended.
 *
 * Throws (and writes nothing) when: the action is unknown, the record's
 * verdict is not ask/hand_off (a policy `deny` can never be voice-overridden),
 * the action was already decided, inputs are invalid, or the audio is missing.
 */
export function decideWithVoice(opts) {
  const { trailPath, decisionsPath, evidenceDir, actionId, audioPath, decision, approver } = opts ?? {};
  if (decision !== "approve" && decision !== "deny") {
    throw new Error(`decision must be "approve" or "deny", got ${JSON.stringify(decision)}`);
  }
  if (!approver || typeof approver !== "string" || !approver.trim()) {
    throw new Error("approver is required (the human's name)");
  }
  if (!actionId || typeof actionId !== "string") throw new Error("actionId is required");
  if (!audioPath || !existsSync(audioPath)) throw new Error(`audio file not found: ${audioPath}`);

  const trailEntries = parseJsonl(trailPath, "trail");
  const record = trailEntries.map(asRecord).find((r) => r && r.action_id === actionId);
  if (!record) throw new Error(`unknown action_id: ${actionId} (no record in ${trailPath})`);

  if (!DECIDABLE_VERDICTS.has(record.verdict)) {
    throw new Error(
      `action ${actionId} has verdict "${record.verdict}" — only ask/hand_off can be decided; ` +
        `a voice decision cannot override a policy verdict`,
    );
  }

  const alreadyInTrail = trailEntries.some((e) => isDecisionFor(e, actionId));
  const decisions = readDecisions(decisionsPath);
  if (alreadyInTrail || decisions.some((d) => d.action_id === actionId)) {
    throw new Error(`action ${actionId} is already decided — decisions are append-only and cannot be re-decided`);
  }

  const audioBytes = readFileSync(audioPath);
  if (audioBytes.length === 0) throw new Error(`audio file is empty: ${audioPath}`);
  const audioSha256 = hashBytes(audioBytes);
  const payloadSha256 = hashValue(record.action_payload ?? {});

  mkdirSync(evidenceDir, { recursive: true });
  const ext = extname(audioPath) || ".bin";
  const audioFile = `${safeName(actionId)}-${audioSha256.slice(0, 12)}${ext}`;
  copyFileSync(audioPath, join(evidenceDir, audioFile)); // verbatim copy — never altered

  const entry = {
    entry_type: "decision",
    channel: "voice",
    action_id: actionId,
    project_id: record.project_id ?? null,
    decision,
    approver: approver.trim(),
    decided_at: opts.decidedAt ?? new Date().toISOString(),
    verdict_answered: record.verdict,
    rule_id: record.rule_id ?? null,
    payload_sha256: payloadSha256,
    audio_sha256: audioSha256,
    audio_file: audioFile,
    audio_bytes: audioBytes.length,
    audio_original_name: basename(audioPath),
  };
  // Append-only: one new line; existing lines are never rewritten.
  appendFileSync(decisionsPath, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

/**
 * Re-hash every stored evidence recording and compare it to the
 * audio_sha256 in its decision entry. Any file that changed (or went
 * missing) after the decision was recorded is reported as a mismatch —
 * that is how tampering with stored evidence is DETECTED. (Detection
 * is not prevention; see SPEC.md.)
 */
export function verifyEvidence(decisionsPath, evidenceDir) {
  const decisions = readDecisions(decisionsPath);
  const mismatches = [];
  for (const d of decisions) {
    if (d.channel !== "voice") continue;
    const file = join(evidenceDir, d.audio_file ?? "");
    if (!d.audio_file || !existsSync(file)) {
      mismatches.push({ action_id: d.action_id, audio_file: d.audio_file ?? null, problem: "evidence file missing" });
      continue;
    }
    const actual = hashBytes(readFileSync(file));
    if (actual !== d.audio_sha256) {
      mismatches.push({
        action_id: d.action_id,
        audio_file: d.audio_file,
        problem: "audio_sha256 mismatch — stored recording changed after the decision was recorded",
        recorded_sha256: d.audio_sha256,
        actual_sha256: actual,
      });
    }
  }
  return { ok: mismatches.length === 0, checked: decisions.filter((d) => d.channel === "voice").length, mismatches };
}
