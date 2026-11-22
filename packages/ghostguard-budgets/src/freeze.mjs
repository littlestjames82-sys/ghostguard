/**
 * Kill switch — a freeze flag file.
 *
 * The flag is the file's EXISTENCE, refined by its content when the
 * content parses: a JSON body with "frozen": false means not frozen;
 * anything else (including an unparseable body) means FROZEN. That is
 * deliberate: a half-written or corrupted freeze file must fail
 * closed, never silently unfreeze the system.
 *
 * The guard re-reads this file on EVERY decision, so flipping it
 * mid-run takes effect on the next action — no restart, no reload.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function readFreeze(freezePath) {
  if (!freezePath || !existsSync(freezePath)) return { frozen: false, detail: null };
  let raw;
  try {
    raw = readFileSync(freezePath, "utf8");
  } catch {
    return { frozen: true, detail: { unreadable: true } };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.frozen === false) return { frozen: false, detail: parsed };
    return { frozen: true, detail: parsed && typeof parsed === "object" ? parsed : { frozen: true } };
  } catch {
    return { frozen: true, detail: { unparseable: true } };
  }
}

export function freeze(freezePath, { by = null, reason = null, at = null } = {}) {
  const detail = {
    frozen: true,
    frozen_at: new Date(at ?? Date.now()).toISOString(),
    by,
    reason,
  };
  mkdirSync(dirname(freezePath), { recursive: true });
  const tmp = `${freezePath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(detail, null, 2) + "\n", "utf8");
  renameSync(tmp, freezePath);
  return detail;
}

export function unfreeze(freezePath) {
  if (freezePath && existsSync(freezePath)) {
    unlinkSync(freezePath);
    return true;
  }
  return false;
}
