# GhostGuard Cloud — M3 skeleton (+ M3.1, + M3.2 Phase C hardening)

_The hosted layer: a hosted audit store + approvals inbox
behind the same gateway-record contract as the core package, plus the
Cloud recorder that ships records to it. **Local only** —
built Oct 7, 2026 (M3/M3.1) and hardened Oct 10, 2026 (M3.2);
not deployed anywhere, and the beta with friendly users has
NOT started. How a future deployment would be stood up, checked,
and rolled back is documented in `BETA_RUNBOOK.md` — as
documentation; choosing the route and starting the beta remain
separate, gated decisions._

_M3.1 closed the skeleton's biggest documented gaps:
idempotent ingest, decision delivery to waiting agents, search +
reporting over the trail, server-stamped times, workspace-isolation
proof, and request hardening. M3.2 (Phase C) made the server
beta-ready: scoped keys with rotation/revocation, digest-compared
auth, per-key rate limits, batch/field size limits, response error
hygiene, decision webhooks, workspace export + delete, and
optional retention. See "What M3.2 added" below._

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
| `GHOSTGUARD_CLOUD_KEYS` | Comma-separated `workspace:key` pairs (legacy form; these keys are **full-scope**). The server refuses to start with no keys from either source. | — |
| `GHOSTGUARD_CLOUD_CONFIG_FILE` | Path to a JSON config file with scoped keys (ids, per-key scopes, per-key rate limits, multiple keys per workspace) and per-workspace decision webhooks. See `config.example.json`. | — |
| `GHOSTGUARD_CLOUD_PORT` | Listen port (`0` = ephemeral). | `8787` |
| `GHOSTGUARD_CLOUD_HOST` | Listen host. | `127.0.0.1` |
| `GHOSTGUARD_CLOUD_STORE` | JSONL store path. | `./store.jsonl` next to `server.mjs` |
| `GHOSTGUARD_CLOUD_MAX_BODY_BYTES` | Per-request body cap. | `1048576` (1 MB) |
| `GHOSTGUARD_CLOUD_MAX_BATCH` | Max records per `POST /v1/records`. | `500` |
| `GHOSTGUARD_CLOUD_RATE_LIMIT` | Requests/minute per key (`0` = off). A config-file key can override it. | `600` |
| `GHOSTGUARD_CLOUD_MAX_WAITERS` | Max concurrent long-poll waiters. | `1000` |
| `GHOSTGUARD_CLOUD_RETENTION_DAYS` | At boot, compact out entries older than N days. Unset = keep forever. | — |

`cloud/.env.example` documents the same surface with placeholder
values. The approvals inbox UI is served at `/` — open it, paste
your API key (it needs the `read` + `decide` scopes; a legacy key
works), enter your name as approver, and decide pending asks.

## API

All `/v1` routes require `Authorization: Bearer <key>`; `/health`
and the UI page do not. Keys are scoped to one workspace: a key only
ever sees its own workspace's records and inbox. Config-file keys
also carry **scopes** — `ingest`, `read`, `decide`, `admin` — and a
route refuses a key without its scope with a `403` (body carries no
data). Missing and wrong keys share one identical `401`. Past the
per-key rate limit, requests get a `429` with `Retry-After`.

| Route | Scope | What it does |
| --- | --- | --- |
| `GET /health` | — | `{ ok: true, service: "ghostguard-cloud", milestone: "M3.2" }` |
| `POST /v1/records` | `ingest` | Append one gateway record or a JSON array batch (max `GHOSTGUARD_CLOUD_MAX_BATCH`). Shape-validated — `action_id`, `verdict`, `project_id` must be non-empty strings within length caps, and `verdict` must be a known gateway verdict (`400` otherwise). **Idempotent:** records whose `(workspace, action_id)` is already in the trail are skipped, not duplicated. Returns `202 { stored, duplicates, workspace }`. |
| `GET /v1/records` | `read` | List the workspace's records, oldest first. Filters: `?project_id=`, `?verdict=`, `?q=` (case-insensitive substring over kind, actor, rule_id, reason, and the JSON of target / action_payload; max 200 chars). Pagination: `?limit=` (default 100, max 1000) + `?offset=` (default 0). Response: `{ records, total, limit, offset }` — `total` counts all matches, before slicing. |
| `GET /v1/report` | `read` | Tallies over the workspace's trail: `{ workspace, project_id, total_records, by_verdict, by_rule, by_actor, pending }`. `?project_id=` scopes every count to one project. `by_rule` keys records with no rule as `"(none)"`. |
| `GET /v1/inbox` | `read` | Pending items: records with verdict `ask` or `hand_off` that have no decision yet, each with its full record (the exact payload is the ratification material). Optional `?q=` search, same matcher as the records list. |
| `POST /v1/inbox/:action_id/decision` | `decide` | Body `{ decision: "approve" \| "deny", approver }` (approver 1–100 chars). **Appends** a decision entry to the store — history is never rewritten — and the item leaves the pending view. `404` if no such pending action (including already-decided ones). Wakes any long-poll waiters on the GET route below, and fires the workspace's decision webhook if one is configured. |
| `GET /v1/inbox/:action_id/decision` | `read` | The decision entry for an action (`{ action_id, project_id, decision, approver, workspace, decided_at, received_at }`), or `404 { pending: true }` while undecided — including for actions in other workspaces (isolation is a 404, never a leak). `?wait=<seconds>` (float ok, capped at 30) long-polls: the request parks until the decision lands or the wait elapses. |
| `GET /v1/export` | `read` | The workspace's raw trail — every stored entry, as JSONL (`application/x-ndjson`): the export format is the store format. |
| `DELETE /v1/workspace` | `admin` | Purges the caller's OWN workspace (the workspace comes from the key, never from input): rewrites the store without its entries and appends a content-free `purge` tombstone (`{ entry_type: "purge", workspace, purged, received_at }`). The one deliberate non-append operation; there is no undo. Returns `{ purged, workspace }`. |

Request bodies are capped at **1 MB** (`413` over the cap);
malformed JSON is a `400`. Error responses are stable and safe:
no stack traces, no filesystem paths, no key material — unexpected
failures are a generic `500 { error: "internal error" }` with the
detail logged server-side only. Every entry is stamped by the
server at ingest: records and decisions carry `received_at` (ISO),
decisions also `decided_at`. A client-supplied `received_at` is
stripped at ingest — the server's stamp is the only one that exists.

The store file is plain JSONL with four entry kinds, distinguished
by `entry_type`: `record` (the gateway record + `workspace` +
`received_at`), `decision` (`action_id`, `project_id`,
`decision`, `approver`, `workspace`, `decided_at`, `received_at`),
`webhook` (a decision-push delivery outcome: `action_id`, `ok`,
`status`, `received_at`), and `purge` (the tombstone a workspace
delete leaves: `workspace`, `purged`, `received_at`). The inbox is
a view computed on read: pending records minus decided
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

## What M3.2 added (Phase C — beta-ready)

- **Scoped keys + key management** — the config file gives each
  key an id and scopes (`ingest` / `read` / `decide` / `admin`);
  multiple keys per workspace can be live at once, which is what
  makes **rotation** a no-downtime overlap (add new, roll clients,
  remove old) and **revocation** a removal + restart. Routes
  enforce scopes with data-free `403`s. Legacy env keys remain
  full-scope for a single-operator setup.
- **Digest-compared auth** — keys are SHA-256 digested at boot and
  compared with `timingSafeEqual` on the digests: constant-time
  for every candidate, no key-length leak. Missing and wrong keys
  return the identical `401`.
- **Rate + concurrency limits** — per-key sliding-window rate
  limit (`429` + `Retry-After`) and a cap on concurrent long-poll
  waiters (`503` past it).
- **Batch + field limits** — max records per POST, verdict
  allowlist, and length caps on ids, approver, and search queries,
  on top of the 1 MB body cap.
- **Error hygiene** — responses never carry stack traces, internal
  paths, or key material; `500`s are generic. API responses send
  `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.
  Corrupt store lines are skipped at boot with a stderr count
  instead of crashing; an invalid port exits with one clean line.
- **Decision webhooks (push)** — a workspace can configure a
  webhook URL + secret; each decision POSTs the decision JSON
  there, signed `x-ghostguard-signature: sha256=<HMAC-SHA256 of
  the exact body>`. Single attempt, 5s timeout, fire-and-forget:
  the outcome is appended to the store as a `webhook` entry and a
  dead endpoint never blocks or fails the decision.
- **Export + delete + retention** — `GET /v1/export` (the
  workspace's trail as JSONL), `DELETE /v1/workspace` (admin
  scope, own workspace only, purge + tombstone), and
  `GHOSTGUARD_CLOUD_RETENTION_DAYS` boot-time compaction.
- **Config surface + runbook** — every setting is env-driven
  (`cloud/.env.example`, `cloud/config.example.json`, placeholders
  only), and `BETA_RUNBOOK.md` documents how a future deployment
  would be stood up, health-checked, key-managed, backed up, and
  rolled back.

## Auth model

Bearer keys, one or more per workspace, supplied via the
environment (legacy form) or the config file (scoped form).
Comparison digests both sides with SHA-256 and is constant-time
on the digests; keys are never logged or echoed. There are no
user accounts or sessions, and no TLS in the server itself (bind
localhost or put it behind something that terminates TLS). Treat
a key like a password — scoped as narrowly as its holder allows:
an `ingest` key can append records but cannot read the trail or
decide anything; a `decide` key can decide but cannot read the
trail; `admin` exists only to purge a workspace and should not be
a day-to-day key. The `approver` string on a decision is still
self-reported — attributable to the `decide` key that was used
and the name its holder typed, not to a verified identity.
Real accounts (magic-link) remain future work, gated on the
deploy decision.

## Honest limits

- **Single-node JSONL store.** One file, loaded into memory at boot,
  appended per write. Fine for a skeleton and a friendly beta;
  not a database — no indexing, no concurrent writers, and record
  volume will outgrow it. Retention and purge compact it, but the
  scale fix is a real store (SQLite/Turso — the Phase C engine
  choice, deliberately not made yet). The store format is
  the contract, not the storage engine.
- **Scoped-key auth, still no accounts.** M3.2 scopes keys and
  makes them rotatable/revocable, but there are no users or
  sessions: a decision's `approver` is a self-reported name,
  attributable to the decide-scoped key used, not to a verified
  person. Magic-link accounts remain gated on the deploy route.
- **Async delivery semantics.** The recorder's queue-and-flush
  model (above) is weaker than the core contract by physics, and
  the docs say so rather than papering over it: durability begins
  at a successful `flush()`, not at `recorder()`.
- **Decision delivery is poll + best-effort push.** `waitForDecision`
  long-polls (30s server cap per round), and a configured webhook
  pushes each decision once — single attempt, no retry queue, so a
  receiver that is down at decision time misses the push (the
  decision itself is always in the trail and the failure is
  recorded). What an agent does with an approval afterwards
  (execute now, carry it as a scoped policy overlay like the M2
  Jev bridge) remains the integrator's call.
- **No policy management, no billing.** Those are later concerns.
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
plus the M3.1 coverage (retried-batch dedupe, `q` search +
pagination, report tallies, decision delivery and its fail-closed
timeout, `received_at` stamping, two-workspace isolation, and the
413 / malformed-JSON hardening) — plus the M3.2 coverage: scoped
keys (403 matrix, data-free refusals), key rotation overlap and
the uniform 401, per-key rate limiting, batch/field limits, error
hygiene (no stacks/paths/keys in bodies), signed decision
webhooks and recorded webhook failure, workspace export, admin
purge with tombstone, retention compaction, corrupt-line boot
tolerance, and clean startup validation. 31 checks; part of
`npm run verify`.
