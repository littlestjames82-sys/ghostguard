import { sha256Hex } from "./hash.mjs";

/**
 * Demo executor — a fake HTTP-call recorder standing in for a real
 * effect (an HTTP client, a tool runner, …).
 *
 * It receives the injected secrets at execution time, the way a real
 * HTTP executor would use them to build an Authorization header, and
 * it proves injection happened WITHOUT ever storing a value: its
 * private log records only the SHA-256 hash and length of each
 * injected secret, alongside the method/URL it "called". No network
 * is touched; the "call" always succeeds with status 200.
 *
 * The log is the executor's own — in a real deployment this is the
 * effect-side evidence, separate from the GhostGuard audit trail.
 */
export function createFakeHttpExecutor() {
  const log = [];
  const executor = async (execution) => {
    const secretHashes = {};
    const secretLengths = {};
    for (const [slot, value] of Object.entries(execution.secrets ?? {})) {
      secretHashes[slot] = sha256Hex(value);
      secretLengths[slot] = value.length;
    }
    const entry = {
      action_id: execution.action_id,
      method: execution.payload?.method ?? "GET",
      url: execution.payload?.url ?? null,
      secret_hashes: secretHashes,
      secret_lengths: secretLengths,
      status: 200,
    };
    log.push(entry);
    return { ok: true, status: 200, secret_hashes: secretHashes };
  };
  executor.log = log;
  return executor;
}
