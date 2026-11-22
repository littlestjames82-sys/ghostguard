import { existsSync, readFileSync } from "node:fs";

/**
 * Carried approvals: a local JSON file a human edits (directly or
 * via src/approve.mjs). Each entry approves exactly one tool call —
 * a tool name plus the SHA-256 hash of its canonical arguments.
 *
 * Format: a JSON array of entries, or an object { "approvals": [...] }:
 *   { "tool": "send_email",
 *     "args_hash": "<sha256 from the blocked call's error / approve CLI>",
 *     "approved_by": "ryan",
 *     "approved_at": "2026-10-10T00:00:00.000Z",
 *     "note": "optional" }
 *
 * Trust model (honest): this file is a local trust boundary. Anyone
 * who can write it can approve actions. It is checked fresh on every
 * tools/call, so an approval lands without restarting the proxy —
 * and removing an entry revokes it from the next call on.
 */

export function readApprovals(approvalsFile) {
  if (!approvalsFile || !existsSync(approvalsFile)) return [];
  const text = readFileSync(approvalsFile, "utf8").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  const entries = Array.isArray(parsed) ? parsed : parsed.approvals;
  if (!Array.isArray(entries)) {
    throw new Error(`approvals file ${approvalsFile} must be a JSON array or { "approvals": [...] }`);
  }
  return entries;
}

export function isApproved(approvalsFile, hash) {
  return readApprovals(approvalsFile).some(
    (entry) => entry && (entry.args_hash === hash || entry.hash === hash),
  );
}
