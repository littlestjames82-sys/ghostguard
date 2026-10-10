# GhostGuard Cloud — M3 skeleton (+ M3.1 improvements)

_The hosted layer's skeleton: a hosted audit store + approvals inbox
behind the same gateway-record contract as the core package, plus the
Cloud recorder that ships records to it. **Local skeleton only** —
built Oct 7, 2026, not deployed anywhere, not published, and the
beta with friendly users has NOT started. The core package remains
`private: true`; everything in this folder lives outside the
package's published `files` whitelist, like `integrations/`._

_M3.1 (same day) closed the skeleton's biggest documented gaps:
idempotent ingest, decision delivery to waiting agents, search +
reporting over the trail, server-stamped times, workspace-isolation
proof, and request hardening. See "What M3.1 added" below._

## What the skeleton is

Two pieces:

1. **The Cloud recorder** (core package, `src/cloud.ts`, exported as
   `createCloudRecorder`). An audit sink that queues gateway records
   in your agent process and ships them to the Cloud server over
   HTTP (global `fetch`, zero runtime dependencies — the core stays
   dependency-free).
2. **The Cloud server** (`cloud/server.mjs`). A zero-dependency Node
   `http` server holding one workspace-scoped, append-only JSONL
   audit store, with a minimal approvals inbox (API + a single-page
   web UI). It binds `127.0.0.1` by default.

```js
import { createCloudRecorder } from "ghostguard";

const cloud = createCloudRecorder({
  baseUrl: "http://127.0.0.1:8787",
  apiKey: process.env.GHOSTGUARD_CLOUD_KEY,
});

// Per guarded action: evaluate → record → FLUSH → only then act.
cloud.recorder(record);
await cloud.flush();          // rejects loudly if delivery failed
if (record.verdict === "allow" || record.verdict === "pre_approved") {
  runTheAction();
}
// At shutdown:
await cloud.close();
```

## The async-flush contract — read this before using the recorder

The core `ActionRecorder` contract is **synchronous and
record-first**: the recorder runs before any effect, and if it
throws, the action does not run — the record is durable before the
caller proceeds. HTTP cannot honor that synchronously, so the Cloud
recorder does not fake it:

- `recorder(record)` **only queues** the record in memory. Queueing
  is not recording; a queued record is durable nowhere.
- `flush()` sends the whole queue as one batch and resolves only
  when the server has accepted it. **A caller that needs the
  record-first guarantee must `await flush()` after recording and
  before executing any effect**, and must treat a rejected flush
  exactly like a throwing synchronous recorder: no record, no
  action.
- `flush()` **never drops records silently**. On any failure
  (server down, network error, non-2xx) the batch goes back on the
  queue and `flush()` rejects with the error; `pending()` reports
  how many records are still undelivered, and a later `flush()`
  retries them.
- Retries are safe: ingest is **idempotent** (M3.1). The server
  dedupes by `(workspace, action_id)`, so if the connection dies
  *after* the server stored a batch but before the reply arrived,
  re-flushing those records does not duplicate the trail — the
  server counts them as duplicates-skipped and `flush()` treats
  that as delivered. The records are in the trail; that is the point.
- `close()` flushes whatever remains, then closes; recording after
  close throws synchronously.

If a call site cannot await a flush before acting, the Cloud
recorder is the wrong sink for it — use the reference JSONL recorder
(`src/recorder.ts`), which is synchronous and durable by
construction, and ship its lines to Cloud out of band.

## Running the server

```sh
GHOSTGUARD_CLOUD_KEYS="myworkspace:my-secret-key" node cloud/server.mjs
# → ghostguard-cloud listening on http://127.0.0.1:8787
```

| Env var | Meaning | Default |
| --- | --- | --- |
| `GHOSTGUARD_CLOUD_KEYS` | Comma-separated `workspace:key` pairs. **Required** — the server refuses to start with none. | — |
| `GHOSTGUARD_CLOUD_PORT` | Listen port (`0` = ephemeral). | `8787` |
| `GHOSTGUARD_CLOUD_HOST` | Listen host. | `127.0.0.1` |
| `GHOSTGUARD_CLOUD_STORE` | JSONL store path. | `./store.jsonl` next to `server.mjs` |

The approvals inbox UI is served at `/` — open it, paste your API
key, enter your name as approver, and decide pending asks.

## API

All `/v1` routes require `Authorization: Bearer <key>`; `/health`
and the UI page do not. Keys are scoped to one workspace: a key only
ever sees its own workspace's records and inbox.

| Route | What it does |
| --- | --- |
| `GET /health` | `{ ok: true, service: "ghostguard-cloud", milestone: "M3.1" }` |
| `POST /v1/records` | Append one gateway record or a JSON array batch. Minimal shape validation — `action_id`, `verdict`, `project_id` must be non-empty strings (`400` otherwise). **Idempotent:** records whose `(workspace, action_id)` is already in the trail are skipped, not duplicated. Returns `202 { stored, duplicates, workspace }`. |
| `GET /v1/records` | List the workspace's records, oldest first. Filters: `?project_id=`, `?verdict=`, `?q=` (case-insensitive substring over kind, actor, rule_id, reason, and the JSON of target / action_payload). Pagination: `?limit=` (default 100, max 1000) + `?offset=` (default 0). Response: `{ records, total, limit, offset }` — `total` counts all matches, before slicing. |
| `GET /v1/report` | Tallies over the workspace's trail: `{ workspace, project_id, total_records, by_verdict, by_rule, by_actor, pending }`. `?project_id=` scopes every count to one project. `by_rule` keys records with no rule as `"(none)"`. |
| `GET /v1/inbox` | Pending items: records with verdict `ask` or `hand_off` that have no decision yet, each with its full record (the exact payload is the ratification material). Optional `?q=` search, same matcher as the records list. |
| `POST /v1/inbox/:action_id/decision` | Body `{ decision: "approve" \| "deny", approver }`. **Appends** a decision entry to the store — history is never rewritten — and the item leaves the pending view. `404` if no such pending action (including already-decided ones). Wakes any long-poll waiters on the GET route below. |
| `GET /v1/inbox/:action_id/decision` | The decision entry for an action (`{ action_id, project_id, decision, approver, workspace, decided_at, received_at }`), or `404 { pending: true }` while undecided — including for actions in other workspaces (isolation is a 404, never a leak). `?wait=<seconds>` (float ok, capped at 30) long-polls: the request parks until the decision lands or the wait elapses. |

Request bodies are capped at **1 MB** (`413` over the cap);
malformed JSON is a `400`. Every stored entry is stamped by the
server at ingest: records and decisions carry `received_at` (ISO),
decisions also `decided_at`. A client-supplied `received_at` is
stripped at ingest — the server's stamp is the only one that exists.

The store file is plain JSONL with two entry kinds, distinguished
by `entry_type`: `record` (the gateway record + `workspace` +
`received_at`) and `decision` (`action_id`, `project_id`,
`decision`, `approver`, `workspace`, `decided_at`, `received_at`).
The inbox is a view computed on read: pending records minus decided
`action_id`s.

## Waiting for a decision (decision delivery)

An `ask` is a question; M3.1 delivers the answer. The agent flow:

```js
cloud.recorder(askRecord);
await cloud.flush();                    // the ask is in the inbox
const decision = await cloud.waitForDecision(askRecord.action_id, {
  timeoutMs: 120_000,
});
if (decision.decision === "approve") runTheAction();
// "deny" resolves too — check the field. A timeout REJECTS:
// no decision is not an approval, and the action stays unexecuted.
```

`waitForDecision` (on the object `createCloudRecorder` returns)
long-polls `GET /v1/inbox/:action_id/decision?wait=…` in rounds
until the decision lands or the deadline passes. Awaiting a human
is inherently async — there is no synchronous version — and the
helper does not pretend otherwise: while waiting, and on timeout,
the asked action remains unexecuted. Fail-closed.

## What M3.1 added

- **Idempotent ingest** — dedupe by `(workspace, action_id)`
  against an index rebuilt from the store at boot; the store stays
  append-only (dedupe is a check, never a rewrite). Responses
  report `stored` vs `duplicates`.
- **Decision delivery** — the GET decision route + long-poll, and
  the client's `waitForDecision`. The M3 gap ("a human's decision
  never reaches the agent that asked") is closed.
- **Search + reporting** — `q` over the trail, limit/offset
  pagination with totals, and `/v1/report` tallies (the paid-wedge
  surface: the hosted trail you can actually read). The inbox UI
  shows the report header and a search box.
- **Server-stamped times** — `received_at` on every entry,
  server-side only.
- **Isolation proof + hardening** — e2e tests prove a second
  workspace's key cannot list, read, decide, or report on the
  first workspace's records (all 404s), and the 1 MB body cap /
  malformed-JSON 400 are enforced and tested.

## Auth model (skeleton)

Static Bearer keys, one per workspace, supplied via the environment.
Comparison is constant-time for equal-length candidates; keys are
never logged or echoed. That is the whole model — no users, no
sessions, no key rotation, no TLS (bind localhost or put it behind
something that terminates TLS). Treat the key like a password:
anyone holding it can read that workspace's trail and decide its
pending asks.

## Honest limits

- **Single-node JSONL store.** One file, loaded into memory at boot,
  appended per write. Fine for a skeleton and a friendly beta;
  not a database — no indexing, no concurrent writers, no
  retention, and record volume will outgrow it. The store format is
  the contract, not the storage engine.
- **Skeleton auth.** Static env keys (above). No per-approver
  identity beyond the self-reported `approver` string on a
  decision; decisions are attributable to a name someone typed,
  not a verified identity.
- **Async delivery semantics.** The recorder's queue-and-flush
  model (above) is weaker than the core contract by physics, and
  the docs say so rather than papering over it: durability begins
  at a successful `flush()`, not at `recorder()`.
- **Decision delivery is polling, not push.** `waitForDecision`
  long-polls (30s server cap per round) — prompt enough for human
  timescales, but there is no webhook/push channel, and a decision
  only ever reaches an agent that is actively waiting or comes
  back to ask. What an agent does with an approval afterwards
  (execute now, carry it as a scoped policy overlay like the M2
  Jev bridge) remains the integrator's call.
- **No policy management, no billing.** Those are M4 concerns.
  The inbox decides already-recorded asks; it does not edit
  policy, and an approval here is an audit event, not a policy
  change.
- **Beta not started.** No friendly users, no deployment, no
  hosting. Starting the beta — like publishing the package — is a
  separate, gated decision.

## Test

```sh
npm run test:cloud
```

Builds the package, boots the server on an ephemeral port with a
temp store, and drives the whole loop through the real recorder:
records in → list filters → inbox → approve lands → inbox empties →
bad key 401 → dead-server flush rejects with the queue retained —
plus the M3.1 coverage: retried-batch dedupe, `q` search +
pagination, report tallies, decision delivery and its fail-closed
timeout, `received_at` stamping, two-workspace isolation, and the
413 / malformed-JSON hardening. 20 checks; part of
`npm run verify`.
