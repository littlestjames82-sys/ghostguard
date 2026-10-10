# GhostGuard — Product Plan

_By Ghost Developer Studio. Status: Milestone 0 complete (standalone
extraction, green suite). All prices in this document are **DRAFT —
not final, not published, pending Ryan's approval.** Nothing in this
plan is a public commitment until Ryan says so._

## 1. Product definition

**GhostGuard is the governance layer for agents that act in the real
world.** It sits between an agent's decision and its effect:

1. The agent proposes an action.
2. GhostGuard classifies it, evaluates an executable policy, and writes
   a complete audit record — intent, exact payload, verdict, deciding
   rule — **before** anything runs.
3. The action executes only on `allow` / `pre_approved`. On `ask`, the
   recorded payload goes to a human approver. On `hand_off`, it routes
   to a different approver. On `deny`, it never runs — and the record
   names the rule that refused.

Guarantees that define the product:

- **Record-first:** if the audit write fails, the action does not run.
- **Fail-closed policy:** no match → deny; a broken restrictive rule
  denies and names itself; a broken permissive rule grants nothing.
- **Strictest wins:** `deny > hand_off > ask > pre_approved > allow`,
  by tier, never by document order.
- **Locked rules:** a team layer that editable overlays cannot weaken.
- **Initiator provenance:** records distinguish who proposed an action
  from what started the run, so unattended runs can be held to a
  stricter standard.
- **Secret hygiene:** the record shows a secret was involved — type and
  length — never its value.

GhostGuard is deliberately *not* an agent framework, not a model
provider, and not a hosted brain. It is the permission, approval, and
paper-trail layer that any agent stack can adopt. That narrowness is
the product.

**Lineage:** the policy semantics descend from CopilotKit/OpenBot
(MIT), adopted and re-implemented inside Ghost Kernel (Ghost
Developer Studio's kernel, where this engine governs the Action Fabric
today), and extracted here as a standalone package. The Python port
built as the Jev Ultrafast governor proves the contract is
runtime-portable: one policy document, same decisions, TS and Python.

## 2. Who buys it

In priority order:

1. **Indie developers and small teams shipping effect-ful agents** —
   browser agents, coding agents, ops/support automation — who have
   hit the "it did *what*?" moment and need approval gates and an
   audit trail without building a policy engine. This is the
   open-source adoption audience and the funnel for everything paid.
2. **Small AI agencies / studios** building agents for clients, who
   need to hand a client a readable record of what the agent did,
   asked about, and was refused — and locked rules the client's own
   operators can't accidentally relax.
3. **Teams with light compliance pressure** (finance-adjacent,
   healthcare-adjacent, internal IT automation) that need
   who/what/rule/when evidence for agent actions. GhostGuard gives
   them the trail; it does not by itself certify anything (see Risks).

Explicitly not the first market: large enterprises (long cycles,
procurement, support burden a one-person studio shouldn't take on
yet) and hobbyist chatbots with no real-world effects (no pain to
solve).

## 3. Packaging

**Open core (MIT, this package):**

- `ghostguard` — the policy engine + gateway record contract + types.
  Zero runtime dependencies, Node ≥ 18, TypeScript/ESM.
- Reference recorder implementations (file/JSONL first) so an
  integrator has a working audit sink on day one.
- Example integrations (see Milestone 1).

**Hosted layer (future, paid — DRAFT):**

- **GhostGuard Cloud:** hosted audit store + approvals inbox (web UI
  where `ask` payloads land for a human decision, with the full
  record attached), policy management with locked team layers,
  search/reporting over the trail.
- The core stays self-hostable forever; Cloud sells convenience,
  hosting, and the approvals surface — not the safety semantics.

**Services (future, DRAFT):** paid integration help and policy
authoring for agencies (fixed-scope engagements), only once the
hosted layer exists to land them on.

Distribution gates (Ryan's calls, not this plan's): making the GitHub
repo public, publishing to npm, any launch posts. The package is
currently `private: true` and unpublished.

## 4. Monetization — DRAFT, pending Ryan's approval

_All figures below are **DRAFT** placeholders for Ryan to approve,
adjust, or reject. Nothing is on sale._

| Tier | DRAFT price | What it would include |
| --- | --- | --- |
| Open source | $0 | The MIT package, self-hosted, community support. |
| Cloud — Solo | **DRAFT $12/mo** | Hosted audit + approvals inbox for one developer / a handful of agents, capped monthly record volume. |
| Cloud — Team | **DRAFT $39/mo** | Multiple approvers, locked team policy layers, longer retention, reporting. |
| Cloud — Agency | **DRAFT $99/mo** | Multiple client workspaces, per-client trails and approvers. |
| Integration engagement | **DRAFT $499 one-time** | Fixed-scope: wire GhostGuard into one agent stack + author its first policy. |

Pricing logic: priced like a developer tool, not an enterprise
platform — below the pain threshold for the indie/agency buyers
above, with the free core doing the marketing. Usage dimension is
recorded actions (the audit trail is the cost driver), not seats
alone.

> **INTERNAL NOTE — 2026-10-07. Not public copy; not a pricing
> change.** Competitor **Belay** ships phone/chat remote approvals
> free in an AGPL package. Implication for packaging: basic remote
> approval ("approve an `ask` from your phone") is becoming table
> stakes rather than a differentiator, so the Cloud tiers should not
> lean on the approvals-inbox mechanic alone as the paid wedge. The
> defensible paid surface is the hosted audit store, search/reporting
> over the trail, locked team policy layers, and multi-workspace
> (agency) trails. The DRAFT prices above are **unchanged** by this
> note; any repricing or repackaging is Ryan's call.

## 5. Risks

- **A funded incumbent tells the same story.** CopilotKit/OpenBot
  markets decide-before/record-after governance with a company behind
  it. Mitigation: GhostGuard's wedge is narrowness and embeddability —
  a dependency you add in an afternoon, no platform, no proprietary
  hosted brain required (the dependency OpenBot *does* impose).
  Compete on "governance without adopting our stack."
- **Honesty ceiling on compliance claims.** The audit trail is real,
  but GhostGuard is not a compliance certification and must never be
  marketed as one. All copy stays at "produces the record," never
  "makes you compliant."
- **Two implementations can drift.** The Kernel keeps its reference
  copy; this package is the product. Mitigation already in place: the
  package's suite ports the Kernel's own acceptance assertions, and
  the extraction diff is import-path-only. Any Kernel engine change
  must re-run this suite before the package claims parity.
- **Integrator effort is the adoption tax.** Classification and
  recorder plumbing are small but nonzero; a developer who bounces
  off the first integration never reaches the paid tier. Mitigation:
  Milestone 1's reference recorder + worked examples exist precisely
  to cut time-to-first-guarded-action.
- **Support burden on a one-person studio.** Fail-closed software
  generates "why was this denied?" questions. Mitigation: the record
  names the deciding rule and reason in plain language by design;
  docs lead with reading a denial.
- **Policy-language subset limits.** The CEL subset covers the
  Kernel's real needs; exotic policies will outgrow it. Mitigation:
  anything outside the subset is a *broken rule* (fails closed,
  loudly) rather than silently mis-evaluated — an acceptable v1
  posture, revisited only on real demand.

## 6. Milestone map

- **M0 — Extraction (DONE, Oct 5–6, 2026).** Standalone package:
  policy engine + gateway contract + types carried from the Kernel
  with semantics verified (import-path-only diff; ported acceptance
  suite green, 7 checks; strict typecheck clean). PLAN.md + README.md
  written. Nothing published; repo private.
- **M1 — Ship-ready v0.1 (DONE, Oct 7, 2026; defined below).** The
  package is now something a stranger can adopt in an afternoon:
  real build output, reference JSONL recorder, two worked examples,
  denial-reading docs — suite, typecheck, and build smoke test all
  green. Stopped at the publish gate as planned: package still
  `private: true`, nothing published; the flip is Ryan's decision.
- **M2 — First external integration (DONE, Oct 7, 2026; §8).**
  One real outside agent — the governed Jev — runs GhostGuard
  end-to-end as an opt-in governor backend: its real loop's actions
  are decided by this package's shipped engine and recorded by its
  recorder through a gate bridge, proven by a scripted scenario;
  the lessons are folded back in §8 and `integrations/jev/`.
- **M3 — Cloud skeleton (BUILT — local skeleton, Oct 7, 2026;
  §9).** Hosted audit store + approvals inbox behind the same
  record contract; the core package gains a Cloud recorder. The
  skeleton is built and verified locally; the beta with friendly
  users has NOT started — nothing is deployed — and starting it is
  a separate gated decision, like the publish gate.
  **M3.1 — Cloud skeleton improvements (BUILT, Oct 7, 2026;
  §10):** idempotent ingest, decision delivery to waiting agents,
  search + reporting over the trail, server-stamped times,
  workspace-isolation proof, request hardening.
- **M4 — Paid tiers live.** Billing on the Cloud tiers (DRAFT prices
  finalized by Ryan), agency workspace support, launch — all gated on
  Ryan's explicit go-ahead at each step.

## 7. Milestone 1 — Ship-ready v0.1 (the next build)

Scope, in order:

1. **Real build output.** `tsc` emit to `dist/` (JS + `.d.ts`),
   `package.json` exports pointed at the build, `files` whitelist —
   the package installs and imports cleanly as a dependency, not just
   from source. Test + typecheck stay green against the build too.
2. **Reference JSONL recorder.** A small file-backed `ActionRecorder`
   in the package (append-only JSONL, one record per line, throws on
   write failure — preserving record-first), with tests.
3. **Two worked examples under `examples/`:**
   - a minimal guarded CLI agent (proposes file writes + a "send"
     action; consequential ones ask via stdin, everything recorded);
   - a classifier example mapping browser-style actions
     (navigate/read → READ, fill → WRITE_LOCAL, submit-click →
     NETWORK_WRITE) onto the default policy, Jev-governor style.
4. **Denial-reading docs.** A short "Reading a denial" section
   (README or docs/) walking one record field by field — the support
   burden mitigation from Risks, done up front.
5. **Publish gate (Ryan's decision, end of M1).** With 1–4 done,
   Ryan decides: flip `private`, public GitHub repo, npm publish,
   and any announcement. Nothing in M1 publishes anything by itself.

M1 is complete when a fresh clone can `npm install`, run the suite
green, and follow an example from zero to a recorded, policy-decided,
human-approved action — without reading the Kernel's source.

**Outcome (Oct 7, 2026):** items 1–4 delivered and verified — `tsc`
build to `dist/` with exports/`files` wired and a smoke test running
against the build; `src/recorder.ts` (JSONL, append-only, throws on
write failure) with acceptance tests; `examples/guarded-cli.ts` and
`examples/browser-classifier.ts`, both run end-to-end (the CLI
example reaches a human-approved action via stdin); and
`docs/reading-a-denial.md` walking a real engine-produced record.
Item 5 (publish gate) was **not** taken: the package remains
`private: true` and unpublished, awaiting Ryan's decision.

## 8. Milestone 2 — First external integration (outcome)

**Delivered Oct 7, 2026.** The governed Jev browser agent
(`~/workspace/jev-ultrafast`) gained an opt-in governor backend,
`JEV_GOVERNOR_BACKEND=ghostguard`, under which its real loop's
actions are decided by this package instead of Jev's in-repo port
(the port remains the default; stock behavior is unchanged with the
switch unset). Per action, Jev's gate spawns the bridge —
`integrations/jev/ghostguard-gate.mjs`, a small Node process around
the package's shipped `dist/` build — which optionally merges a
policy overlay with the real `mergePolicyDocs`, evaluates with the
real engine, assembles the record via `gatewayRecordFromDecision`,
and appends it to the JSONL audit via `createJsonlRecorder`
**before** replying; any bridge or write failure raises in Jev and
nothing executes. Record-first survives the process boundary.

**Proof.** Jev's `scripts/ghostguard_scenario.py` drives the real
loop on its offline harness (local fixture page; no network, no
external sites, no real submissions, no spend): navigate → allow,
scroll → allow, form fill → pre_approved (standing rule), submit →
**ask** (run stops, nothing executed); a human approver answers the
recorded payload as a policy overlay; run 2: submit → pre_approved
(executes), "Buy gift card" → **deny** by the locked
`no-spend-ever` rule — which the same overlay tried, and failed, to
replace with an allow (the merge drops overlay rules that reuse a
locked id). The audit holds exactly the six expected canonical
records, in order. Full transcript, protocol, and run instructions:
`integrations/jev/README.md`.

**Verification (Oct 7, 2026).** GhostGuard `npm run verify` green:
build + strict typecheck + **9/9 acceptance** (a new M2 block runs
the actual bridge: verdicts, carried approvals, hostile-overlay
denial, record-before-reply round-trip, unwritable-audit failure) +
build smoke 3/3. Jev: **91 passed** (85 pre-existing unchanged + 6
new bridge contract tests, including local-vs-bridge verdict parity
on shared fields and record-written-before-execution), `ruff check`
clean. The package's publish surface is unchanged — `integrations/`
is outside the `files` whitelist; the M1 publish gate remains
untaken and pricing remains DRAFT.

**Lessons folded back** (detail in `integrations/jev/README.md`):
bridge policies must be written in the product's field vocabulary —
Jev's native expression roots (`classification`, `operation`, …)
do not cross, and `classification == 'read_only'` ≡
`permission_class == 'READ'` is what makes the default policy
translation exact; an approval expressed as an overlay cannot
outrank an `ask` (strictest tier wins), so approval overlays work
by narrowing the asking rule and adding a scoped `pre_approved`
rule; the audit in bridge mode carries the canonical GatewayRecord
while Jev's in-state record adds its classification fields for the
inspector. **Cost, measured:** one node spawn per action — median
raw bridge round trip 261 ms in the build sandbox (verification
run); a long-lived bridge is the known optimization if a
deployment feels it.

**Left in M2:** nothing required. The scenario runs on Jev's
offline harness by design; the same backend drives a live Jev run
unchanged, which is an operator's proof (browser session +
decision model), not a CI one. M3 (hosted audit + approvals inbox)
now has its first client shape: this bridge's request/record
contract.

## 9. Milestone 3 — Cloud skeleton (outcome)

**Built Oct 7, 2026 — local skeleton only.** The hosted layer now
exists as runnable code behind the same gateway-record contract:
a Cloud recorder in the core package, and a zero-dependency Node
server holding the audit store + approvals inbox. Nothing is
deployed, nothing is published, the package remains
`private: true`, and pricing remains DRAFT (§4 untouched).

**Delivered.** (1) `src/cloud.ts` — `createCloudRecorder` (exported
from the package index): queues gateway records in memory and ships
them over HTTP (global `fetch`; the core stays at zero runtime
dependencies) to the Cloud server. (2) `cloud/server.mjs` —
zero-dependency `node:http` server: append-only JSONL store (one
workspace-scoped store per deployment; record and decision entries,
history never rewritten), Bearer API-key auth with `workspace:key`
pairs supplied via `GHOSTGUARD_CLOUD_KEYS` (keys never logged),
`GET /health`, `POST /v1/records` (single or batch, minimal shape
validation), `GET /v1/records` with `project_id` / `verdict`
filters, `GET /v1/inbox` (pending = `ask` / `hand_off` with no
decision yet), `POST /v1/inbox/:action_id/decision` (appends a
decision entry; the item leaves the pending view), and a
single-page approvals inbox UI at `/` (framework-free; pending
asks with kind / actor / reason / payload and Approve / Deny wired
to the API). Binds `127.0.0.1:8787` by default. (3)
`cloud/test-cloud.mjs`, wired as `npm run test:cloud` and into the
`verify` chain. Full operator docs, API, auth model, and limits:
`cloud/README.md`.

**The async tension, handled honestly.** The core recorder
contract is synchronous and record-first — durable before any
effect, throw on failure. HTTP cannot be synchronous, so the Cloud
recorder does not impersonate the contract: `recorder()` only
queues; strict record-first callers must `await flush()` before
executing effects and treat a rejected flush exactly like a
throwing synchronous recorder (no record, no action). A failed
flush rejects loudly and **keeps the batch queued** — records are
never dropped silently; `pending()` exposes the backlog and
`close()` flushes what remains. One documented caveat: a
connection that dies after the server stored a batch but before
the reply arrived makes a retry deliver duplicates — the server
appends what it receives, and `action_id` is the stated dedupe
key. Call sites that cannot await a flush are told to use the
synchronous JSONL recorder and ship its lines out of band.

**Verification (Oct 7, 2026).** `npm run verify` green end-to-end:
build + strict typecheck + **9/9 acceptance** (unchanged) + build
smoke 3/3 + **cloud e2e 10/10** — the test boots the real server on
an ephemeral port with a temp store, posts an allow + an ask
through the real recorder, lists with filters, validates a
malformed record (400), finds the ask in the inbox, lands an
approve decision (store grows by an appended decision entry; the
record stays in the trail; the inbox empties), re-deciding 404s, a
bad key 401s, and a flush against the killed server rejects with
the record still queued. The server also boots standalone:
`/health` answers and the inbox UI serves.

**Left in M3:** the beta itself — friendly users, a deployment,
TLS, real approver identity, key rotation, a store that outgrows
one JSONL file, and wiring decisions back into waiting agent runs
are all unstarted, on purpose. M4 (paid tiers live) remains gated
on Ryan's explicit go-ahead at each step, and the M1 publish gate
remains untaken.

## 10. Milestone 3.1 — Cloud skeleton improvements (outcome)

**Built Oct 7, 2026 — local only, same gates as M3.** A hardening
and gap-closing round on the M3 skeleton, aimed at its own
documented limits. Nothing deployed, nothing published, the
package remains `private: true` at zero runtime dependencies, and
pricing remains DRAFT (§4 untouched).

**Delivered.** (1) **Idempotent ingest:** `POST /v1/records`
dedupes by `(workspace, action_id)` against an index rebuilt from
the store at boot and maintained on append — the "connection died
after the store, before the reply" retry no longer duplicates
trail entries, and the response reports `stored` vs `duplicates`.
The store stays append-only: dedupe is an ingest check, never a
rewrite. (2) **Decision delivery:** `GET /v1/inbox/:action_id/
decision` returns the decision entry (or `404` while pending),
with `?wait=<seconds>` (capped at 30) long-polling until the
decision lands; the core package's cloud client gains
`waitForDecision(actionId, { timeoutMs, pollMs })`, which resolves
with the decision — approve *or* deny — and rejects on timeout.
The sync/async honesty is kept and stated in the code: awaiting a
human is inherently async, the asked action stays unexecuted while
waiting, and a timeout is not an approval (fail-closed). This
closes M3's biggest functional gap: a human's inbox decision now
reaches the agent that asked. (3) **Search + reporting:** `GET
/v1/records` gains `q` (case-insensitive substring over kind,
actor, rule_id, reason, and the JSON of target / action_payload)
and limit/offset pagination with a `total` count; new `GET
/v1/report` returns counts by verdict, by rule, by actor, and the
pending-inbox count, workspace-scoped and optionally
project-scoped — the paid-wedge surface named in §4's internal
note (the hosted trail you can search and report on). The inbox
UI gains the report header and a search box, still framework-free.
(4) **Server-stamped times:** every stored record and decision
carries a server-side `received_at` (decisions also `decided_at`,
as before); a client-supplied `received_at` is stripped at
ingest — never trusted. (5) **Isolation proof + hardening:** e2e
tests prove a second workspace's key cannot list, read, decide,
or report on the first workspace's records (cross-workspace
`action_id` access is a 404, not a leak) and that dedupe is scoped
per workspace; request bodies are capped at 1 MB (`413`) and
malformed JSON is a `400`, both tested.

**Verification (Oct 7, 2026).** `npm run verify` green end-to-end:
build + strict typecheck + **9/9 acceptance** (unchanged) + build
smoke 3/3 + **cloud e2e 20/20** (the M3 ten, unchanged in intent,
plus ten new: retried-batch dedupe, search + pagination, report
tallies, decision delivery through the real recorder, the
fail-closed wait timeout, `received_at` stamping, mixed-batch
partial dedupe, workspace isolation, per-workspace dedupe scope,
and the 413/400 hardening). The inbox UI was also served and
checked standalone with the new reporting header and search box.

**Left after M3.1:** decision delivery is long-poll, not push —
no webhooks; an approval's effect on a run (execute now, carry as
a scoped overlay) remains the integrator's call, as in M2. Beyond
that, M3's remaining list stands: the beta itself, TLS, real
approver identity, key rotation, and a store that outgrows one
JSONL file. M4 remains gated on Ryan's explicit go-ahead at each
step, and the M1 publish gate remains untaken.
