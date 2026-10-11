import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ActionRecorder, GatewayRecord } from "./gateway.js";

/**
 * Reference recorder — the audit sink an integrator gets on day one
 * (Milestone 1). Append-only JSONL: one gateway record per line, in
 * the order actions were decided. File-backed and synchronous,
 * matching the ActionRecorder contract: it is called BEFORE any
 * effect runs, and if the write fails it throws — and a throwing
 * recorder means the action does not run. An action that was not
 * recorded did not happen; this recorder's whole job is to make
 * "recorded" cheap and hard to get wrong.
 *
 * Append-only is by construction: the recorder opens the file in
 * append mode for each record and never rewrites earlier lines, so
 * the trail can only grow. (It is a reference implementation, not a
 * tamper-proof store — pair it with filesystem permissions or ship
 * the lines to your real event store if you need stronger
 * guarantees.)
 *
 * What lands in the file is exactly the record the gateway assembled
 * — intent, exact payload, verdict, deciding rule. If your payloads
 * can carry secrets, redact them before they reach the record (the
 * contract's stance: a record shows a secret was involved — type
 * and length — never its value).
 */
export function createJsonlRecorder(filePath: string): ActionRecorder {
  // Create the parent directory up front so a missing folder is a
  // setup-time error, not a surprise at the first guarded action.
  // A bad path (e.g. under an existing file) throws here, loudly.
  mkdirSync(dirname(filePath) || ".", { recursive: true });
  return (record: GatewayRecord): void => {
    // Synchronous append: the record is durable before the caller
    // proceeds to any effect. A failure (disk full, permissions,
    // the path replaced by a directory, …) throws, and the
    // record-first contract turns that throw into "no action".
    appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
  };
}

/**
 * Read back a JSONL trail written by createJsonlRecorder — one
 * parsed GatewayRecord per line, in file order. For examples,
 * tests, and small reporting jobs; a production trail belongs in a
 * real store. Throws on a malformed line: a corrupt trail should be
 * loud, not silently truncated.
 */
export function readGatewayRecords(filePath: string): GatewayRecord[] {
  const text = readFileSync(filePath, "utf8");
  return text
    .split("\n")
    .filter((line: string) => line.trim().length > 0)
    .map((line: string) => JSON.parse(line) as GatewayRecord);
}
