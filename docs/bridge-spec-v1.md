# GhostGuard Bridge Spec v1

_The integration contract for any runtime that wants GhostGuard to
decide its actions. Version 1, formalised Oct 10, 2026 (Phase B) from
the working Jev bridge — `integrations/jev/ghostguard-gate.mjs` in
this package, with `integrations/jev/README.md` as its integration
note. This document describes that shipped protocol as-is; where a
host-side behaviour is a convention rather than something the bridge
enforces, it says so._

## 1. Shape of the integration

A **host** (an agent runtime in any language) proposes one action at
a time to a **gate**: a short-lived Node process running this
package's bridge script around the shipped GhostGuard build
(`dist/`). The exchange is one JSON object on the gate's stdin, one
JSON object on its stdout:

```
host                              gate (node, one process per action)
────                              ────────────────────────────────────
build intent
  → gate(intent) ─── stdin ───▶   validate request
                                  mergePolicyDocs(policy, overlay?)
                                  compilePolicy + evaluatePolicy
                                  gatewayRecordFromDecision
                                  createJsonlRecorder(audit_path)
                                    — record FIRST, before replying
      record       ◀── stdout ──  exactly one JSON line, exit 0,
                                   only after the record is written
  → execute iff the record's verdict allows it
```

The gate imports the package's build output — the same artifact an
npm consumer receives — not the TypeScript source. Run
`npm run build` in this package before relying on a gate if `dist/`
may be stale.

The price of this shape is one Node process spawn per action. The
M2 verification measured a 261 ms median raw bridge round trip in
its build sandbox. A long-lived gate process is a known future
optimisation; it is not part of v1, and v1 makes the cost visible
rather than hiding it.

## 2. Request

Exactly one JSON object on stdin:

```json
{
  "policy":         { "rules": [ … ] },
  "policy_overlay": { "rules": [ … ] } | null,
  "audit_path":     "/abs/path/audit.jsonl" | null,
  "approved":       false,
  "intent":         { … }
}
```

| Field | Required | Meaning |
|---|---|---|
| `policy` | yes | The base policy document: an object with a `rules` array (see §5). Anything else is a malformed request. |
| `policy_overlay` | no | A second policy document, or `null`/absent. When present it is folded onto `policy` with the engine's real `mergePolicyDocs` before evaluation (§6). |
| `audit_path` | no | An absolute path to a JSONL audit file, or `null`/absent. When set, the gate appends the record there via the package's reference recorder **before** replying. When absent, the record is returned but not persisted by the gate — the host is then responsible for its own record-first discipline. |
| `approved` | no | A carried human approval covering this action. Only the JSON value `true` counts; anything else evaluates as `false`. |
| `intent` | yes | The gateway intent (§3). |

Unknown top-level fields are ignored. The gate builds the evaluation
context and the record from the contract fields only — a caller
cannot smuggle extra keys into the audit trail.

### 2.1 The intent

```json
{
  "action_id":        "e3",
  "kind":             "jev.click",
  "permission_class": "NETWORK_WRITE",
  "actor":            "jev",
  "initiator":        "person",
  "project_id":       "",
  "action_payload":   { "label": "Find stays", "host": "fixture.test" },
  "target_ref":       null,
  "snapshot_id":      "…",
  "target":           { "element": "…", "label": "…", "role": "…" },
  "dry_run":          false
}
```

Required, and validated as strings by the gate: `action_id`, `kind`,
`actor`, `initiator`, `project_id`. `permission_class` must be a
string or `null`. `action_payload` must be a JSON object (not an
array, not `null`). The remaining fields are optional and default as
the record contract default them: `target_ref`, `snapshot_id`, and
`target` default to `null`; `dry_run` is `true` only when the JSON
value is exactly `true`.

Field semantics (from the gateway record contract, `src/gateway.ts`):

- **`kind`** — the host's own action vocabulary (e.g. `jev.click`,
  `fs.write`). The engine does not interpret kinds beyond what
  policy rules say about them.
- **`permission_class`** — the consequence class the host's
  classifier maps the kind onto: one of `READ`, `WRITE_LOCAL`,
  `EXECUTE`, `NETWORK_WRITE`, `DEPLOY`, `PUBLISH`, `COMMUNICATE`,
  `SPEND`, `DELETE`, or `null`. Classification is the host's job and
  it is load-bearing: when in doubt, classify up.
- **`actor`** — who proposed the action.
- **`initiator`** — what started the run: `person`, `routine`,
  `handoff`, `memory`, or `system`. This is stamped by the host's
  entry point (trusted code), never read from the action or its
  payload. A payload key named `initiator` is reachable in policy
  only as `payload.initiator` and is a different field.
- **`project_id`** — the host's project scope; a host with no
  project scope (Jev) sends `""`.
- **`action_payload`** — the exact payload that will run if the
  action is allowed — post-resolution, not a sketch of it. For an
  `ask` or a denial this payload is the ratification material: an
  approvals surface proposes exactly it for a human decision.
- **`target_ref` / `snapshot_id` / `target`** — the resolved target
  the host addressed, when it used one.
- **`dry_run`** — the host is simulating; the record carries the
  flag so a dry run's records are distinguishable in the trail.

## 3. Evaluation

The gate derives the policy context from the intent — the payload is
`intent.action_payload`, and `approved` is the request's flag:

```
context = { kind, permission_class, actor, project_id,
            approved, initiator, payload: intent.action_payload }
```

Rules are written over exactly these fields: `kind`,
`permission_class`, `actor`, `project_id`, `approved`, `initiator`,
and `payload.<field>`, in the CEL subset the engine documents
(`src/policy.ts`: literals and list literals; `== != < <= > >= in
&& || !` and parentheses; the string functions `startsWith`,
`endsWith`, `contains`, `matches`). Roots a host's native governor
may know (Jev's `classification`, `operation`, `role`, `label`,
`host`, …) do **not** exist in this engine — they resolve to `null`
and rules using them silently never match. Host facts travel as
contract fields instead: classification as `permission_class`,
label/host as `payload.label` / `payload.host`.

## 4. Reply

On success the gate prints **exactly one JSON object on stdout** —
the gateway record — and exits `0`. The record is the contract type
from `src/gateway.ts`: the intent's fields, plus the decision half
(`verdict`, `rule_id`, `reason`, `handoff_to`), plus `target_ref`,
`snapshot_id`, `target`, `action_payload`, and `dry_run`. `rule_id`
is `null` only for the no-match fail-closed deny.

The reply is sent **only after** the record has been appended to
`audit_path` (when one was given). Record-first therefore holds
across the process boundary: a record the host acts on is already
durable.

### 4.1 Verdict handling (host convention)

The gate decides and records; what the verdict means for execution
is the host's contract with itself, and every conforming host
follows the gateway semantics:

| Verdict | Host behaviour |
|---|---|
| `allow` | Execute the action. |
| `pre_approved` | Execute; the record names the standing-approval rule whose bounds covered it. |
| `ask` | Do not execute. Surface the record's exact payload to a human approver; execute later only under a carried approval (§6.1). A host whose loop carries no approvals (Jev) stops the run here. |
| `hand_off` | Do not execute. Route the record to `handoff_to` — a different approver or scope decides. |
| `deny` | Never execute. The record names the rule that refused. |

### 4.2 Failure handling — fail closed, always

| Exit | Meaning | Host behaviour |
|---|---|---|
| `0` | Record on stdout. | Act per §4.1. |
| `1` | The audit record could not be written. Reason on stderr, nothing on stdout. | No action may execute. |
| `2` | The request itself was malformed (bad JSON, missing/invalid `policy`, `policy_overlay`, or `intent` fields). Reason on stderr, nothing on stdout. | No action may execute. |
| non-zero / no output for any other reason (gate missing, spawn failure, timeout, unreadable reply) | The gate could not be reached or did not produce a record. | No action may execute. |

There is no path on which a failed gate permits an action: no
record, no action. Policy-level failures are handled inside the
engine before this table is reached — a broken restrictive rule
denies and names itself, a broken permissive rule grants nothing, no
matching rule denies — so a malformed *policy* still produces a
(recorded) decision, while a malformed *request* produces none.

## 5. Policy documents

A policy document is `{ "rules": [ rule, … ] }`. A rule:

```json
{ "id": "no-spend-ever", "effect": "deny", "locked": true,
  "when": "permission_class == 'SPEND'", "note": "…" }
```

- `effect` is one of `allow`, `pre_approved`, `ask`, `hand_off`,
  `deny`. Verdicts are chosen by strictness tier —
  `deny > hand_off > ask > pre_approved > allow` — never by document
  order, so a permissive rule appended later can never outrank a
  restrictive one.
- `hand_off` rules must carry `handoff_to`; a targetless `hand_off`
  rule is broken, and a broken restrictive rule fails closed.
- `note` is free text for humans; the engine ignores it.

## 6. Overlays and locked rules

When a request carries `policy_overlay`, the gate merges it onto
the base with `mergePolicyDocs` (base, overlay) before compiling:

- A base rule marked `locked: true` is carried into the merged
  document **verbatim**. An overlay rule reusing a locked rule's id
  is **dropped** — it can neither replace, weaken, nor shadow the
  locked rule.
- An overlay rule with the id of a *non-locked* base rule replaces
  that rule (an ordinary edit). All other overlay rules append —
  and because evaluation is tier-ordered, an appended `allow` still
  cannot outrank a locked `deny` / `ask` / `hand_off`.

### 6.1 Approvals are overlays (or a carried flag), never a rewrite

Two approval paths exist, and hosts use whichever their loop
supports:

1. **Carried approval** — the host collects a human's decision and
   re-presents the same action with `"approved": true`. Rules
   written with a `!approved` clause (the usual shape of an `ask`
   rule) step aside; an `approved`-matching rule decides.
2. **Policy overlay** — the approval lands as policy for a later
   run. The sharp edge: an overlay `pre_approved` rule **cannot**
   outrank a base `ask` rule — `ask` is the stricter tier and
   strictest wins. A real overlay approval therefore *edits the
   asking rule*: the overlay replaces the non-locked asking rule
   with a narrowed version that excludes the approved payload, and
   adds a scoped `pre_approved` rule for it. Narrow the asker, scope
   the approval. The Jev scenario (`integrations/jev/README.md`)
   proves this end-to-end, including a planted hostile overlay rule
   reusing the locked `no-spend-ever` id that still fails to let a
   purchase through.

In both paths the locked layer is locked against the approver too:
no approval mechanism in this spec can weaken a locked rule.

## 7. Conformance

`conformance/fixtures.json` in this package is the normative case
set for v1: one policy document (including the locked
`no-spend-ever` rule) and action cases covering `allow`,
`pre_approved`, `ask`, `hand_off`, and `deny`; initiator branching
(a routine deploy asks where a person deploy allows, and a payload
spoofing `initiator` changes nothing); a carried approval; the
no-match fail-closed deny; and a hostile overlay against the locked
rule.

A runtime conforms to Bridge Spec v1 when, evaluating each fixture
case exactly as §3 prescribes (merge overlay → compile → evaluate
over the intent-derived context), its decisions match the fixture's
expected `verdict`, `rule_id`, and `handoff_to` — the shared fields.
Runners in tree:

- TypeScript (canonical): `npm run test:conformance` in this
  package; also part of `npm run verify`.
- Ghost Hands (Python backend): `tests/test_ghostguard_backend.py`
  in the Ghost Hands package, which drives this spec's reference
  gate per fixture case.
- Jev: its bridge contract tests pin the same gate against the Jev
  scenario policy (`tests/test_ghostguard_bridge.py` in Jev).

## 8. Host checklist

A new host conforms by doing five things, all in its existing
action path:

1. **Classify** each action kind onto a `permission_class`
   (classify up when in doubt).
2. **Stamp** `actor` (proposer) and `initiator` (run origin, from
   trusted entry-point code — never from the payload).
3. **Gate before acting**: build the intent, spawn the gate with
   the deployment's policy (and the audit path), and treat any gate
   failure as a denial (§4.2).
4. **Act on the verdict** per §4.1 — execute only on `allow` /
   `pre_approved`, and only the exact payload that was recorded.
5. **Keep bridge policies in the product vocabulary** (§3) — rules
   written against host-native context roots will not error; they
   will silently never match.
