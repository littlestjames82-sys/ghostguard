import { createHash } from "node:crypto";

/**
 * Canonical JSON + hashing for carried approvals.
 *
 * An approval covers exactly one tool call: the tool name plus its
 * exact arguments. The hash is computed over a canonical encoding
 * (object keys sorted recursively) so the same logical arguments hash
 * identically regardless of key order in the JSON the client sent,
 * while any change to any argument value produces a different hash.
 */

export function canonicalStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`);
  return `{${parts.join(",")}}`;
}

export function approvalHash(tool, args) {
  const canonical = canonicalStringify({ tool, arguments: args ?? {} });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
