import type { ActionRecorder, GatewayRecord } from "./gateway.js";

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
  waitForDecision: (
    actionId: string,
    options?: WaitForDecisionOptions,
  ) => Promise<CloudDecision>;
}

export function createCloudRecorder(options: CloudRecorderOptions): CloudRecorder {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("createCloudRecorder: baseUrl is required");
  if (!options.apiKey) throw new Error("createCloudRecorder: apiKey is required");
  const doFetch: typeof fetch = options.fetchImpl ?? fetch;

  let queue: GatewayRecord[] = [];
  let closed = false;
  // Serialize flushes: each flush waits for the previous one, so two
  // overlapping flush() calls can never interleave batches or race
  // the queue. A rejected flush does not poison the chain — the tail
  // swallows the rejection after the caller's own promise sees it.
  let tail: Promise<void> = Promise.resolve();

  const recorder: ActionRecorder = (record: GatewayRecord): void => {
    if (closed) {
      throw new Error("createCloudRecorder: recorder is closed — no record, no action");
    }
    queue.push(record);
  };

  async function sendQueued(): Promise<void> {
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    try {
      const res = await doFetch(`${baseUrl}/v1/records`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `GhostGuard Cloud flush failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
        );
      }
    } catch (err) {
      // No silent drops: the batch goes back on the FRONT of the
      // queue (ahead of anything queued while we were sending) and
      // the failure surfaces to the caller of flush().
      queue = batch.concat(queue);
      throw err;
    }
  }

  function flush(): Promise<void> {
    const run = tail.then(sendQueued);
    tail = run.catch(() => undefined);
    return run;
  }

  async function close(): Promise<void> {
    if (closed) return;
    // Mark closed first so nothing new queues while the final flush
    // is in flight; a failed final flush rejects and the records
    // remain queued (pending()) — still not dropped.
    closed = true;
    await flush();
  }

  async function waitForDecision(
    actionId: string,
    waitOptions: WaitForDecisionOptions = {},
  ): Promise<CloudDecision> {
    if (!actionId) throw new Error("createCloudRecorder: waitForDecision requires an actionId");
    if (closed) throw new Error("createCloudRecorder: recorder is closed");
    const timeoutMs = waitOptions.timeoutMs ?? 60_000;
    const pollMs = waitOptions.pollMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // Ask the server to long-poll for the remainder (its cap is
      // 30s per request), so a decision wakes this wait promptly
      // instead of on the next poll tick.
      const waitSec = Math.min(30, remaining / 1000);
      const res = await doFetch(
        `${baseUrl}/v1/inbox/${encodeURIComponent(actionId)}/decision?wait=${waitSec}`,
        { headers: { authorization: `Bearer ${options.apiKey}` } },
      );
      if (res.ok) return (await res.json()) as CloudDecision;
      if (res.status !== 404) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `GhostGuard Cloud decision lookup failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
        );
      }
      // 404 = still pending. The server already held the request
      // for waitSec; pause briefly before the next round.
      const pause = Math.min(pollMs, Math.max(0, deadline - Date.now()));
      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
    }
    throw new Error(
      `GhostGuard Cloud: no decision for action ${actionId} within ${timeoutMs}ms — ` +
        "a timeout is NOT an approval; the action stays unexecuted (fail-closed).",
    );
  }

  return {
    recorder,
    flush,
    close,
    pending: () => queue.length,
    waitForDecision,
  };
}
