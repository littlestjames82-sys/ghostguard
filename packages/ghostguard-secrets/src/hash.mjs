import { createHash } from "node:crypto";

/** SHA-256 hex digest of a string — the only form in which a secret
 *  value may appear in executor logs or test evidence. */
export function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}
