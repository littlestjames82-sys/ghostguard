# GhostGuard Secrets Broker
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Release](https://img.shields.io/github/v/release/littlestjames82-sys/ghostguard-secrets)](https://github.com/littlestjames82-sys/ghostguard-secrets/releases)

**Just-in-time secret injection for governed agent actions — the agent can't leak what it never had.**

An agent that needs an API key usually *holds* the key: in its context window, its plan, its traces, for the whole run. Anything that compromises or merely observes the agent — a prompt injection, a verbose log, a leaked transcript — gets the credential with it.

The Secrets Broker removes the value from the agent's world entirely:

- The agent proposes actions carrying only a secret **reference** — `{ name, type, slot }`. No value exists anywhere in the agent-facing action, the broker's result, or the audit trail.
- The **GhostGuard policy decides first**, before the secret source is touched. On `deny`, `ask` (without a carried approval the policy accepts), or `hand_off`, the secret is **never resolved** — provable through the source's read counter, which the test suite asserts stays at zero on those paths.
- Only on an executable verdict does the broker resolve the reference from a local secret source (env vars, or a local JSON file kept outside the audit path), broker-side.
- The gateway record is written **before** execution, per GhostGuard's record-first contract, and shows the secret exactly the way the trail already treats secrets: **name, type, and length — never the value**. (Length is filled in only on the execute path, after broker-side resolution; on a refusal it stays `null`, because the broker honestly never learned it.)
- Injection is last-moment and one-way: the executor receives values in a separate `secrets` map keyed by slot, apart from the agent's payload. The broker clears its own map when the call returns, and **scrubs** any resolved value out of executor results and error messages that pass back through it — a leaky executor that throws or echoes the key gets `[redacted]`, not a leak.

By **Ghost Developer Studio**. Standalone prototype; imports the GhostGuard engine from the published `ghostguard` package — its only runtime dependency.

## Flow

```
agent ── action + secret_refs [{name, type, slot}] ──► broker
                                                          │ 1. evaluate policy (real GhostGuard engine)
                                                          │ 2. deny / ask / hand_off → record, STOP
                                                          │    (secret source untouched: 0 reads)
                                                          │ 3. allow / pre_approved → resolve refs
                                                          │    broker-side from the secret source
                                                          │ 4. write gateway record (name/type/length)
                                                          │ 5. executor(payload, secrets{slot: value})
                                                          │ 6. scrub result/errors, drop value refs
executor ── effect (HTTP call, tool run, …) ──► world
```

Approvals: an `ask` becomes executable only when a **carried human approval** makes the policy itself allow the action — the approval is passed as the context's `approved` flag by trusted caller code, and approval-shaped rules (`… && approved == false` → ask) stop firing. The broker never overrides the engine's verdict; there is no broker-side "force run".

## Threat model

**What this defends against**

- A compromised, injected, or simply careless **agent/planner**: it only ever sees references. Its context, plans, and transcripts contain no credential to steal or repeat.
- **Trail/log exposure**: the JSONL audit record carries name + type + length, never the value. The demo executor's own log follows the same rule (SHA-256 hashes + lengths).
- **Unapproved use**: resolution is gated on the verdict. A denied or unapproved action doesn't just fail to execute — the secret is never even read, so there is nothing in broker memory to scrape for it.
- **Leaky effects**: executor errors and results are scrubbed of resolved values before returning to the agent side (tested with an executor that deliberately embeds the secret in both).

**What it does not defend against (honest limits)**

- **A compromised executor.** At the injection moment the executor necessarily holds the raw value — it has to, to make the call. A malicious executor can exfiltrate it then. The win is narrower and real: the *agent* (the part exposed to prompts, tools, and transcripts) never holds it, and the exposure window shrinks from "the whole run" to "inside one effect call". Choose executors you trust; the broker cannot fix an untrusted effect.
- **Same-process prototype.** Broker, source, and executor share one Node process and its memory. A production version wants a process (or service) boundary, with the broker holding the source and handing values over a narrow channel — and even then, see the executor point above.
- **No secure erasure.** JavaScript strings are immutable and may linger in heap memory after the broker drops its references. This prototype drops references promptly and never copies values into records/results, but it cannot zero memory.
- **Length leaks a little.** Recording length (existing GhostGuard hygiene) tells an observer the credential's length. That's the trail's established trade-off, kept here deliberately.
- **The source is the operator's problem.** Env vars and a local JSON file are prototype-grade stores. File permissions, and keeping the secrets file *outside* the audit path, are on the operator; a production broker should sit in front of a real secret manager behind the same `resolve(name)` interface.
- **Not a compliance anything.** Like GhostGuard itself, the broker produces records and gates effects; it certifies nothing.

One ordering note: on the execute path the broker resolves *before* writing the record, so the record can carry the length. If the recorder then throws, the action still does not execute (record-first holds) — the value was read broker-side and is dropped, never injected.

## Usage

```js
import { createJsonlRecorder } from "ghostguard";
import {
  createSecretsBroker,
  createFileSecretSource,
  createFakeHttpExecutor, // demo stand-in for a real effect
} from "./src/index.mjs";

const broker = createSecretsBroker({
  policy: policyDoc,                       // GhostGuard PolicyDoc or compiled policy
  recorder: createJsonlRecorder("trail/audit.jsonl"),
  secretSource: createFileSecretSource("secrets/local.json"), // outside the audit path
});

const result = await broker.execute(
  {
    action_id: "a1",
    kind: "http.call",
    permission_class: "NETWORK_WRITE",
    actor: "demo-agent",
    initiator: "person",
    project_id: "secrets-demo",
    approved: false,                       // carried human approval, if any
    payload: { method: "POST", url: "https://api.example.test/charge" },
    secret_refs: [{ name: "example_api_key", type: "api_key", slot: "authorization" }],
  },
  myExecutor, // async ({ payload, secrets, record }) => result
);
// result.status: "executed" | "blocked" | "failed_closed"
// result.record: the gateway record (name/type/length only)
```

Secret sources (`src/sources.mjs`) all expose `resolve(name) -> { value, type } | null` plus a `stats.valueReads` counter:

| Source | Backing store |
| --- | --- |
| `createMapSecretSource(entries)` | In-memory map — tests/demos |
| `createEnvSecretSource(env)` | Environment variables (names are env var names) |
| `createFileSecretSource(path)` | Local JSON file: `{ name: { type, value } }` |

If an agent smuggles an inline `value` into a secret ref, the broker drops it: refs are rebuilt from `name`/`type`/`slot` only, and the record shows the *source's* secret (proven by hash in tests), never the smuggled one.

## Files

| File | What it is |
| --- | --- |
| `src/broker.mjs` | The broker: decide → resolve → record → inject → scrub |
| `src/sources.mjs` | Map / env / file secret sources, each with a value-read counter |
| `src/fake-http-executor.mjs` | Demo executor: "calls" HTTP, logs hashes + lengths only |
| `src/hash.mjs` | SHA-256 helper (the only form a value may be evidenced in) |
| `policy.example.json` | Example policy: locked no-delete/no-spend, ask-on-comms/deploy, allow the rest |
| `examples/demo.mjs` | `npm run demo` — allow, deny, ask, ask+approval, end to end |
| `test/run-tests.mjs` | `npm test` — 27 checks (see REPORT.md) |

## Status

Prototype, built Oct 10, 2026 and public at v0.1.0. All test fixtures use obviously fake secret values; no real secret exists anywhere in this package. See `REPORT.md` for verification detail.

## Repository layout note

This add-on imports the GhostGuard core engine from the **published
`ghostguard` package** (`"ghostguard": "^0.1.0"` in `package.json`; nothing
in the core is modified). To run it, clone this repo and install:

```sh
git clone https://github.com/littlestjames82-sys/ghostguard-secrets
cd ghostguard-secrets && npm install && npm test
```

Part of the GhostGuard family by **Ghost Developer Studio**.

## The GhostGuard family

GhostGuard is built in public by **Ghost Developer Studio** as a family of small, single-purpose packages around one core engine:

- [ghostguard](https://github.com/littlestjames82-sys/ghostguard) — the core — record-first gateway, fail-closed policy, approvals, and audit for any agent
- [ghostguard-mcp](https://github.com/littlestjames82-sys/ghostguard-mcp) — governed MCP proxy — every `tools/call` is classified, decided, and recorded before it is forwarded
- [ghostguard-budgets](https://github.com/littlestjames82-sys/ghostguard-budgets) — stateful budgets, velocity rules, and a kill-switch freeze (stricter-only)
- [ghostguard-secrets](https://github.com/littlestjames82-sys/ghostguard-secrets) — just-in-time secrets broker — the agent never holds the raw key *(this repo)*
- [ghostguard-replay](https://github.com/littlestjames82-sys/ghostguard-replay) — policy replay/backtest against a recorded trail, plus the Guard Score
- [ghostguard-plan](https://github.com/littlestjames82-sys/ghostguard-plan) — hash-bound plan approvals and separation of duties / quorum
- [ghostguard-reports](https://github.com/littlestjames82-sys/ghostguard-reports) — Ed25519 agent passports, incident reports, and the Guarded-by-GhostGuard badge
- [ghostguard-voice](https://github.com/littlestjames82-sys/ghostguard-voice) — voice approval prototype — a recorded, hash-bound voice decision on a pending ask
- [ghostguard-distribution](https://github.com/littlestjames82-sys/ghostguard-distribution) — GitHub Action gate, red-team bench, plain-English policy author, approval channels, and browser Lite
- [ghostguard-services](https://github.com/littlestjames82-sys/ghostguard-services) — agent governance audit service pack and white-label audit portal prototype
- [policy-packs](https://github.com/littlestjames82-sys/policy-packs) — pre-written, behavior-tested governance policy packs for agent jobs

**Studio roadmap board:** [ghost-roadmaps](https://github.com/littlestjames82-sys/ghost-roadmaps) — the visual board showing where everything in the studio stands.

More from Ghost Developer Studio: [GhostBus](https://github.com/littlestjames82-sys/ghostbus) · [Ghost Hands](https://github.com/littlestjames82-sys/ghost-hands) · [Agent Seatbelt](https://github.com/littlestjames82-sys/agent-seatbelt) · [Ghost Bridge](https://github.com/littlestjames82-sys/ghost-bridge) · [Storefront](https://github.com/littlestjames82-sys/storefront)

## License

MIT — see `LICENSE`. Copyright (c) 2026 Ghost Developer Studio.
