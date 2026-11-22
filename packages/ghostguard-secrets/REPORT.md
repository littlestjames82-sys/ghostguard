# GhostGuard Secrets Broker — Build Report

_Built Oct 10, 2026 at Ryan's direction ("Knock em out" — more-ideas list item 2). Private prototype: nothing published, pushed, or deployed. `~/workspace/ghostguard` was only read and imported via its built `dist/`; no other project was modified. This report contains no secret values and no hashes of them — fixture values are referred to generically only._

## What was built

New standalone package at `~/workspace/ghostguard-secrets/` — Node ESM, zero runtime dependencies, `private: true`:

- **`src/broker.mjs`** — `createSecretsBroker({ policy, recorder, secretSource })`. Per action: builds secret descriptors from refs only (any smuggled inline `value` is dropped), evaluates the real GhostGuard policy **before touching the source**, blocks on deny/ask/hand_off with the record written and zero source reads, resolves refs broker-side only on allow/pre_approved, writes the gateway record (name + type + length, never value) before execution, injects values into the executor via a separate `secrets` map keyed by slot, clears its map afterwards, and scrubs resolved values (`[redacted]`) out of executor results and every error message it returns.
- **`src/sources.mjs`** — three sources behind `resolve(name) -> { value, type } | null`, each with a `stats.valueReads` counter (the counter is what makes "never resolved on deny" provable): map (tests/demos), env vars, and a local JSON file (documented as belonging outside the audit path).
- **`src/fake-http-executor.mjs`** — demo executor: stands in for an HTTP effect, logs only SHA-256 hashes + lengths of injected secrets as injection evidence.
- **`src/hash.mjs`**, **`src/index.mjs`**, **`policy.example.json`** (locked no-delete / no-spend, ask-on-COMMUNICATE/DEPLOY-unapproved, allow the rest), **`examples/demo.mjs`**.

Approvals: an `ask` executes only when a carried approval (`approved: true`, stamped by trusted caller code) makes the policy itself allow the action. The broker never overrides a verdict.

## Verification

Commands run from `~/workspace/ghostguard-secrets/`:

- `npm test` (= `npm run verify`) — **27 passed, 0 failed**, run twice (initial run and the verify re-run), same result.
- `npm run demo` — all four scenarios behaved as labelled (allow executes, locked deny blocks, ask blocks, ask+approval executes); the source's total value-read count after the demo was **2** (only the two executed actions); a grep of the demo's stdout for the fixture values returned **0 matches**.

What the 27 checks prove, mapped to the brief:

- **(a)** Allowed action executes; the executor's log proves it received the correct secret by SHA-256 hash comparison (hash only); it was resolved exactly once; the JSONL audit trail contains **no** raw secret (substring sweep) while its record shows name + type + length with `resolved: true`; the agent-facing result and the agent's own action object contain no value and were not mutated to carry one.
- **(b)** A DELETE action is denied by the locked rule and an unapproved COMMUNICATE action asks; across both, the source's value-read counter **did not move (zero resolutions)** and the executor never ran. Both refusals are recorded, with secret length honestly `null` (never learned).
- **(c)** The same COMMUNICATE action with a carried approval executes; verdict allow, `approval_carried: true` on the record, correct secret proven by hash.
- **(d)** A missing secret ref returns `failed_closed` / `secret_not_found`; the executor did not run; the failed resolution is noted on the record rather than hidden.
- **(e)** An executor that throws an error embedding the secret gets a scrubbed broker error (`[redacted]` present, value absent); an executor that echoes the secret in its *result* gets a scrubbed result; a throwing secret source fails closed cleanly; a sweep asserts **no error message on any failure path contains any fixture value**.
- **Plus:** recorder failure blocks execution (record-first contract); a smuggled inline ref value is ignored and the source's secret is what executes (hash proof); file source and env source each execute correctly with exactly one value read and clean trails; a whole-trail sweep finds no fixture value anywhere.

Leak sweep of the package: fixture values exist only as in-memory fixture definitions in `test/run-tests.mjs` and `examples/demo.mjs` (source code, never output). They appear in **no** file under `src/`, in no doc (README/REPORT), in no config, in no audit trail, and in no console output.

One fix during the build: the test and demo initially imported the GhostGuard dist with one `../` too many and failed with ERR_MODULE_NOT_FOUND; corrected to the same relative depth the `src/` modules use. No other failures.

## Left undone / honest limits

- Same-process prototype: broker, source, and executor share one process. The stated win is that the **agent/planner never holds the value**; a compromised *executor* can still exfiltrate at the injection moment, because it must hold the value to make its call. Documented in the README threat model, not papered over.
- No secure memory erasure (JS strings), no real secret-manager backend (env/file/map only, behind the `resolve` interface), no process/service boundary, no rotation or multi-secret transactional semantics.
- Length is recorded (existing GhostGuard trail hygiene) — a small, deliberate information leak, called out in the README.
- Nothing wired into GhostGuard Cloud, Ghost Hands, or the MCP adapter; this is a standalone prototype pending Ryan's direction.
