import type { ActionRecorder } from "./gateway.js";
/**
 * Cloud recorder — the audit sink that ships gateway records to a
 * GhostGuard Cloud server (Milestone 3 skeleton; see cloud/ in the
 * repo). Same destination contract as the reference JSONL recorder —
 * the records that land server-side are exactly the records the
 * gateway assembled — but a different delivery contract, and the
 * difference matters:
 *
 * ── The honest part: async flush vs the sync record-first contract ──
 *
 * The core ActionRecorder contract (gateway.ts) is SYNCHRONOUS and
 * record-first: the recorder is called before any effect, and if it
 * throws, the action does not run — the record is durable before the
 * caller proceeds. HTTP is not synchronous and cannot be made so.
 * This recorder therefore does NOT pretend to be a drop-in
 * synchronous recorder:
 *
 * - `recorder(record)` only QUEUES the record in memory. Queueing is
 *   not recording. A queued record is not durable anywhere.
 * - `flush()` sends everything queued to the server in one batch and
 *   resolves only when the server has accepted the batch. A caller
 *   that needs the record-first guarantee MUST `await flush()` after
 *   recording and BEFORE executing any effect — and must treat a
 *   rejected flush exactly like a throwing synchronous recorder:
 *   no record, no action.
 * - `flush()` never drops records silently. If the send fails
 *   (server down, network error, non-2xx), the batch is put back on
 *   the queue and flush() rejects with the error — loudly. The
 *   records stay available via `pending()` and a later flush().
 *   Retries are safe: the server dedupes ingest by
 *   (workspace, action_id), so if the connection dies AFTER the
 *   server stored a batch but before the reply arrived, re-flushing
 *   the same records does not duplicate the trail — the server
 *   counts them as duplicates-skipped, and flush() treats that as
 *   delivered (the records ARE in the trail; that is the point).
 * - `close()` flushes whatever remains and then closes the recorder;
 *   recording after close throws synchronously.
 *
 * ── Waiting for a decision ──
 *
 * `waitForDecision(actionId)` is how an agent receives the human's
 * answer to an `ask`: it long-polls the server until the decision
 * lands, then resolves with it. Two honesty notes, same spirit as
 * the flush contract:
 *
 * - Awaiting a decision is inherently async — there is no
 *   synchronous version of "a human decides later." While waiting,
 *   and if the wait TIMES OUT, the asked action stays unexecuted:
 *   a timeout rejects with an error, and no decision is not an
 *   approval. Fail-closed, always.
 * - Resolving is not approving: the promise resolves with the
 *   decision entry whether it says "approve" or "deny." Check
 *   `decision` before acting on it.
 *
 * If your integration cannot await a flush before acting, the Cloud
 * recorder is the wrong sink for that call site — use the reference
 * JSONL recorder (recorder.ts), which is synchronous and durable by
 * construction, and ship its lines to Cloud out of band.
 */
export interface CloudRecorderOptions {
    /** Base URL of the GhostGuard Cloud server, e.g. "http://127.0.0.1:8787". */
    baseUrl: string;
    /** Bearer API key issued for your workspace. Sent as `Authorization: Bearer <key>`. */
    apiKey: string;
    /**
     * Fetch implementation to use; defaults to the global fetch
     * (Node ≥ 18). Injectable for tests and non-standard runtimes.
     */
    fetchImpl?: typeof fetch;
}
/** A human's decision on a pending ask, as stored by the server. */
export interface CloudDecision {
    action_id: string;
    project_id: string;
    /** The human's answer. Resolving with "deny" is still a resolution — check this field. */
    decision: "approve" | "deny";
    /** Who decided (self-reported name from the inbox; skeleton auth). */
    approver: string;
    workspace: string;
    /** Server-stamped decision time (ISO). */
    decided_at: string;
    /** Server-stamped ingest time (ISO) — never client-supplied. */
    received_at: string;
}
export interface WaitForDecisionOptions {
    /**
     * Give up after this long (default 60s). Giving up REJECTS — a
     * timeout is not an approval, and the action must not execute.
     */
    timeoutMs?: number;
    /**
     * Pause between long-poll rounds (default 1s). Each round asks
     * the server to hold the request for up to 30s, so a decision
     * normally wakes the wait immediately; this only paces retries.
     */
    pollMs?: number;
}
export interface CloudRecorder {
    /**
     * The ActionRecorder half: queues a record for the next flush.
     * Synchronous and non-blocking — and NOT, by itself, durable.
     * See the module comment: await flush() before any effect.
     */
    recorder: ActionRecorder;
    /**
     * Send every queued record to the server, in queue order, as one
     * batch. Resolves when the server has accepted them; rejects —
     * with the records still queued — on any failure.
     */
    flush: () => Promise<void>;
    /** Flush remaining records, then close. Recording after close throws. */
    close: () => Promise<void>;
    /** How many records are queued but not yet accepted by the server. */
    pending: () => number;
    /**
     * Wait for the human decision on a pending `ask` / `hand_off`
     * record (which must already be flushed). Resolves with the
     * decision entry — approve OR deny; rejects on timeout or on a
     * server/network error. While waiting and on timeout, the asked
     * action must NOT execute: no decision is not an approval.
     */
    waitForDecision: (actionId: string, options?: WaitForDecisionOptions) => Promise<CloudDecision>;
}
export declare function createCloudRecorder(options: CloudRecorderOptions): CloudRecorder;
