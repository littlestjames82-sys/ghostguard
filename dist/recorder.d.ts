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
export declare function createJsonlRecorder(filePath: string): ActionRecorder;
/**
 * Read back a JSONL trail written by createJsonlRecorder — one
 * parsed GatewayRecord per line, in file order. For examples,
 * tests, and small reporting jobs; a production trail belongs in a
 * real store. Throws on a malformed line: a corrupt trail should be
 * loud, not silently truncated.
 */
export declare function readGatewayRecords(filePath: string): GatewayRecord[];
