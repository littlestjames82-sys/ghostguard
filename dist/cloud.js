export function createCloudRecorder(options) {
    const baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (!baseUrl)
        throw new Error("createCloudRecorder: baseUrl is required");
    if (!options.apiKey)
        throw new Error("createCloudRecorder: apiKey is required");
    const doFetch = options.fetchImpl ?? fetch;
    let queue = [];
    let closed = false;
    // Serialize flushes: each flush waits for the previous one, so two
    // overlapping flush() calls can never interleave batches or race
    // the queue. A rejected flush does not poison the chain — the tail
    // swallows the rejection after the caller's own promise sees it.
    let tail = Promise.resolve();
    const recorder = (record) => {
        if (closed) {
            throw new Error("createCloudRecorder: recorder is closed — no record, no action");
        }
        queue.push(record);
    };
    async function sendQueued() {
        if (queue.length === 0)
            return;
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
                throw new Error(`GhostGuard Cloud flush failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
            }
        }
        catch (err) {
            // No silent drops: the batch goes back on the FRONT of the
            // queue (ahead of anything queued while we were sending) and
            // the failure surfaces to the caller of flush().
            queue = batch.concat(queue);
            throw err;
        }
    }
    function flush() {
        const run = tail.then(sendQueued);
        tail = run.catch(() => undefined);
        return run;
    }
    async function close() {
        if (closed)
            return;
        // Mark closed first so nothing new queues while the final flush
        // is in flight; a failed final flush rejects and the records
        // remain queued (pending()) — still not dropped.
        closed = true;
        await flush();
    }
    async function waitForDecision(actionId, waitOptions = {}) {
        if (!actionId)
            throw new Error("createCloudRecorder: waitForDecision requires an actionId");
        if (closed)
            throw new Error("createCloudRecorder: recorder is closed");
        const timeoutMs = waitOptions.timeoutMs ?? 60_000;
        const pollMs = waitOptions.pollMs ?? 1_000;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                break;
            // Ask the server to long-poll for the remainder (its cap is
            // 30s per request), so a decision wakes this wait promptly
            // instead of on the next poll tick.
            const waitSec = Math.min(30, remaining / 1000);
            const res = await doFetch(`${baseUrl}/v1/inbox/${encodeURIComponent(actionId)}/decision?wait=${waitSec}`, { headers: { authorization: `Bearer ${options.apiKey}` } });
            if (res.ok)
                return (await res.json());
            if (res.status !== 404) {
                const detail = await res.text().catch(() => "");
                throw new Error(`GhostGuard Cloud decision lookup failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
            }
            // 404 = still pending. The server already held the request
            // for waitSec; pause briefly before the next round.
            const pause = Math.min(pollMs, Math.max(0, deadline - Date.now()));
            if (pause > 0)
                await new Promise((r) => setTimeout(r, pause));
        }
        throw new Error(`GhostGuard Cloud: no decision for action ${actionId} within ${timeoutMs}ms — ` +
            "a timeout is NOT an approval; the action stays unexecuted (fail-closed).");
    }
    return {
        recorder,
        flush,
        close,
        pending: () => queue.length,
        waitForDecision,
    };
}
