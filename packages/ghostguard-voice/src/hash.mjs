// Hashing helpers — canonical JSON + SHA-256 over bytes / values.
//
// The payload hash binds a voice decision to the EXACT payload of the
// ask it answers (the ratification material in the gateway record).
// Canonical encoding (sorted object keys, recursively) means the hash
// does not depend on key order in the stored JSONL line.
import { createHash } from "node:crypto";

export function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`);
  return `{${parts.join(",")}}`;
}

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 of the canonical encoding of a value (e.g. an action_payload). */
export function hashValue(value) {
  return sha256Hex(Buffer.from(canonicalStringify(value), "utf8"));
}

/** SHA-256 of raw bytes (e.g. an audio recording, treated as opaque). */
export function hashBytes(bytes) {
  return sha256Hex(bytes);
}
