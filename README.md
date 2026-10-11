# GhostGuard

**Record-first gateway, fail-closed policy, approvals, and audit — for any agent.**

GhostGuard is the governance layer an agent's actions pass through *before*
they happen. Every action an agent proposes is classified, decided by an
executable policy, and written to an audit record **first** — and only then,
if the verdict allows it, executed. A refusal is recorded with the rule that
refused. An action that was not recorded did not happen.

It is framework-neutral: GhostGuard doesn't care whether the agent is a
browser bot, a coding agent, a workflow runner, or a chat assistant. The
integrator describes each action in GhostGuard's vocabulary, and GhostGuard
decides and records. The agent brings the effects; GhostGuard brings the
permission, the paper trail, and the brakes.

By **Ghost Developer Studio**. MIT licensed.

## Why

Agents that can click "submit," send email, spend money, deploy, and delete
are useful precisely because those actions are consequential — and dangerous
for the same reason. The usual failure modes:

- The agent acts first and the log (if any) is written after — or never,
  when the action crashes the process.
- "Approval" is a prompt the agent itself can route around.
- A typo'd or half-written safety rule silently stops matching, and the
  system fails *open*.
- Nobody can answer, afterwards, *which rule* allowed the thing that went
  wrong — or who (or what) actually started the run.

GhostGuard's answers are structural, not advisory:

- **Record first, act second.** The gateway record is assembled complete —
  intent, exact payload, verdict, deciding rule — and handed to your
  recorder *before* any effect runs. If the recorder throws, the action
  does not run.
- **Fail closed, everywhere.** No matching rule → deny. A missing or empty
  policy permits nothing. A *broken* restrictive rule (unparseable,
  unevaluable) denies everything and names itself; a broken permissive rule
  is inert — it never grants, but blocks nothing.
- **Strictest verdict wins.** Effects rank
  `deny > hand_off > ask > pre_approved > allow`, evaluated by tier, never
  by document order. An allow rule appended later can never outrank a deny.
- **Approvals are data, not prompts.** An `ask` verdict carries the exact
  payload that was refused; your approvals surface proposes exactly that
  payload for a human decision. `pre_approved` is a standing approval whose
  bounds are the rule's own expression. `hand_off` routes an action to a
  different approver or scope instead of executing it.
- **Locked rules.** Rules marked `locked: true` are the team layer:
  merging an editable overlay policy can never replace, weaken, or shadow
  them.
- **Initiator ≠ actor.** Every record distinguishes who proposed the action
  (`actor`) from what started the run (`initiator`: person, routine,
  handoff, memory, system) — stamped by trusted entry-point code, never by
  the proposer, so policy can hold unattended runs to a stricter standard
  than the same person at the keyboard.
- **Secret hygiene.** The record shows that a secret was involved — its
  type and length — never its value. (In the reference implementation,
  redaction runs at the event-store write boundary, before signing, so no
  caller can bypass it.)

## What's in the box

| File | What it is |
| --- | --- |
| `src/policy.ts` | The policy engine: a small hand-rolled evaluator for a CEL subset, tier-ordered verdicts, fail-closed broken-rule semantics, locked-rule merging, and a shipped default policy. Zero runtime dependencies. |
| `src/gateway.ts` | The gateway record contract: `GatewayRecord`, `GatewayIntent`, the `ActionRecorder` type, and `gatewayRecordFromDecision()` to assemble a complete record from an intent + a decision. |
| `src/recorder.ts` | The reference recorder: `createJsonlRecorder(path)` — an append-only JSONL `ActionRecorder` that throws on write failure, plus `readGatewayRecords(path)` to read a trail back. A working audit sink on day one. |
| `src/types.ts` | The shared vocabulary: `PermissionClass` (the consequence classes an integrator maps action kinds onto) and `InitiatorKind`. |
| `examples/` | Two worked examples: a guarded CLI agent (`npm run example:cli`) and a browser-action classifier in the Jev-governor style (`npm run example:browser`). |
| `docs/reading-a-denial.md` | How to read a refusal: one real record, walked field by field. |
| `test/run.ts` | The acceptance suite — the same assertions the engine passes inside Ghost Kernel, plus gateway-contract and recorder tests. Run with `npm test`. |
| `integrations/jev/` | The first outside integration (M2): a gate bridge the governed Jev browser agent calls per action, its scenario policy, and the integration note. Not part of the published package. |

You bring: the action effects themselves, and — if you use `ask` — an
approvals surface that shows a human the recorded payload and returns
their decision. A recorder is included (the JSONL reference above);
bring your own sink when the trail needs to live somewhere else.

## Quick start

```sh
npm install
npm test                 # acceptance suite (source)
npm run build            # tsc emit to dist/ (JS + .d.ts)
npm run example:cli      # a guarded agent: approve its asks with `y`
npm run example:browser  # the classifier walkthrough (non-interactive)
```

### Production-safe integration pattern

Use the same path in every integration:

1. Evaluate the policy.
2. Assemble the gateway record from the decision.
3. Write the record synchronously.
4. Flush the recorder before any effect is allowed to run.
5. Only then execute the effect, and only if the verdict is `allow` or `pre_approved`.

```ts
const policy = compileValidatedPolicy(policyDoc, { throwOnWarning: false });
for (const d of policy.diagnostics) {
  if (d.level === "error") throw new Error(d.message);
  console.warn(d.message);
}

const decision = evaluatePolicy(policy, context);
const record = gatewayRecordFromDecision(intent, decision);
jsonlRecorder(record);
await cloudRecorder.flush();

if (record.verdict === "allow" || record.verdict === "pre_approved") {
  execute(action);
}
```

This is the default contract for real deployments: no record, no action.

### Release checklist for package consumers

Before shipping a policy to production, confirm all of the following:

- Validate the policy document with `compileValidatedPolicy(policyDoc)` or `assertPolicyValid(policyDoc)` in CI and pre-deploy checks.
- Treat all diagnostic errors as blockers: duplicate IDs, invalid expressions, missing `handoff_to`, and malformed policy documents.
- Review warnings deliberately: a permissive `allow` rule like `when: "true"` is not automatically fatal, but it is exactly the kind of rule that can hide a bad default.
- Keep the team-layer locked rules separate from the editable overlay; overlay policies should never replace a locked deny/ask/hand_off rule.
- Keep the fail-closed ordering intact: `deny > hand_off > ask > pre_approved > allow`.

### Migration: `compilePolicy()` to `compileValidatedPolicy()`

If you are upgrading from the low-level compiler, move to the validated entry point before evaluation:

```ts
import { compilePolicy, compileValidatedPolicy } from "ghostguard";

const unsafe = compilePolicy({ rules: [
  { id: "allow-some", effect: "allow", when: "true" },
] });

const safe = compileValidatedPolicy({ rules: [
  { id: "allow-some", effect: "allow", when: "true" },
] }, { throwOnWarning: false });
```

The difference is not in the engine semantics — the fail-closed core remains the same — but in the authoring guardrails. The validated path surfaces malformed expressions, duplicate IDs, and missing `handoff_to` values up front instead of silently letting an invalid policy ship.

What breaks if you skip validation?

```ts
const bad = compilePolicy({ rules: [
  { id: "route-email", effect: "hand_off", when: "permission_class == 'COMMUNICATE'" },
  { id: "broken", effect: "ask", when: "kind ==" },
] });
```

This policy is unsafe even though the compiler may still produce a compiled object. The first rule has no `handoff_to` target, and the second rule's expression is syntactically invalid. A validated build would fail fast before the action path ever reached runtime.

### Operator denial triage

When an action is refused, the fastest workflow is:

1. Read the `rule_id` and `reason` from the record.
2. Find the exact rule in the policy document and check whether it is a locked base rule or an editable overlay.
3. Confirm the `initiator`, `actor`, and `permission_class` match the actual runtime context.
4. If the rule is malformed or missing a `handoff_to`, fix the policy and redeploy with validation enabled.
5. If the rule is intentional, treat the denial as the correct outcome and investigate the request path, not the engine.

Hit a denial and want to know exactly why? Read
[`docs/reading-a-denial.md`](docs/reading-a-denial.md) — it walks one
real record field by field.

### Policy authoring checklist

- Keep the `deny > hand_off > ask > pre_approved > allow` ordering intact.
- Prefer validated compilation: `compileValidatedPolicy(policyDoc)` before evaluation.
- Treat duplicate IDs, invalid expressions, and missing handoff targets as errors.
- Treat `when: "true"` allow rules as warnings unless you intentionally want a permissive default.
- Keep locked rules for the team layer and overlay only editable policy.

## How an agent integrates

Four steps, all in the integrator's existing action path:

**1. Classify.** Map each of your agent's action kinds onto a
`PermissionClass`:

```ts
type PermissionClass =
  | "READ" | "WRITE_LOCAL" | "EXECUTE" | "NETWORK_WRITE"
  | "DEPLOY" | "PUBLISH" | "COMMUNICATE" | "SPEND" | "DELETE";
```

(Example: a browser agent might map navigation and page reads → `READ`,
form fills → `WRITE_LOCAL`, submit-capable clicks → `NETWORK_WRITE`. When
in doubt, classify up — unknown shapes are consequential.)

**2. Write a policy.** Rules are data. Each rule has an `id`, an `effect`,
and a `when` expression over the action context (`kind`,
`permission_class`, `actor`, `project_id`, `approved`, `initiator`,
`payload.<field>`; operators `== != < <= > >= in && || !`; string functions
`startsWith`, `endsWith`, `contains`, `matches`):

```ts
import { compilePolicy } from "ghostguard";

const policy = compilePolicy({ rules: [
  { id: "no-spend-ever", effect: "deny", locked: true,
    when: "permission_class == 'SPEND'" },
  { id: "routines-ask-on-deploys", effect: "ask",
    when: "initiator == 'routine' && permission_class == 'DEPLOY'" },
  { id: "docs-are-pre-approved", effect: "pre_approved",
    when: "kind == 'fs.write' && startsWith(payload.path, 'docs/')" },
  { id: "comms-go-to-owner", effect: "hand_off", handoff_to: "owner",
    when: "permission_class == 'COMMUNICATE'" },
  { id: "allow-the-rest", effect: "allow", when: "true" },
] });
```

Or start from the shipped default — approval-required classes
(`DEPLOY`, `PUBLISH`, `COMMUNICATE`, `SPEND`, `DELETE`) ask, everything
else in the map allows — via `defaultKernelPolicy()`. Layer an editable
overlay over a locked base with `mergePolicyDocs(base, overlay)`.

**3. Decide and record — before acting.**

```ts
import { evaluatePolicy, gatewayRecordFromDecision } from "ghostguard";

const decision = evaluatePolicy(policy, {
  kind: action.kind,
  permission_class: classify(action.kind),
  actor: action.proposedBy,
  initiator: run.initiator,          // stamped by the run's entry point
  project_id: run.projectId,
  approved: approvalCovers(action),  // a carried human approval, if any
  payload: action.payload,
});

const record = gatewayRecordFromDecision({
  action_id: action.id,
  kind: action.kind,
  permission_class: classify(action.kind),
  actor: action.proposedBy,
  initiator: run.initiator,
  project_id: run.projectId,
  action_payload: action.payload,    // the exact payload that will run
}, decision);

recorder(record);  // throws → the action does not run. No record, no action.
```

**4. Act on the verdict.**

| Verdict | Meaning | Integrator behaviour |
| --- | --- | --- |
| `allow` | Permitted. | Execute. |
| `pre_approved` | Permitted under a standing approval. | Execute; the record says which rule's bounds covered it. |
| `ask` | Needs a human first. | Do not execute. Surface the record's exact payload to your approver; execute later only under a carried approval. |
| `hand_off` | Not this approver's call. | Do not execute. Route the record to `record.handoff_to`. |
| `deny` | Refused. | Do not execute. The record names the rule that refused (`record.rule_id`; `null` only for the no-match fail-closed default). |

That's the whole contract. Everything else — how effects run, where
records are stored, how approvals render — stays yours.

## Provenance and proof

GhostGuard is an extraction, not a rewrite. The policy engine and gateway
record contract were built inside **Ghost Kernel** (Ghost Developer
Studio's cognitive-supervisor kernel), where they govern its Action Fabric
in exactly this shape, and were carried into this package with semantics
verified unchanged: `src/policy.ts` differs from the Kernel's reference
implementation only in its import path and an extraction note, and this
package's acceptance suite ports the Kernel's own engine-level assertions.

The design lineage runs through **CopilotKit/OpenBot** (MIT): its gateway
policy semantics — decide before acting, record the decision, fail closed
— were adopted into Ghost Kernel (documented in the Kernel's
`OPENBOT_ADOPTION.md`) and re-implemented there in TypeScript; GhostGuard
carries that implementation out as a standalone product. OpenBot's
proprietary Intelligence dependency was deliberately *not* adopted.

Portability proof: the same contract is implemented in Python by the
governor built for **Jev Ultrafast** (a browser agent) — a Kernel-shaped
policy document decides the same way in both runtimes, and Jev's
consequential actions (form submits, sends, purchases) now ask by default
instead of executing unguarded. Since Milestone 2, Jev can also skip
the port: with `JEV_GOVERNOR_BACKEND=ghostguard`, its loop delegates
each action to this package itself over the gate bridge in
`integrations/jev/` — the first outside agent running GhostGuard
end-to-end, recorded by GhostGuard's own recorder.

## Status

Milestone 1 complete: ship-ready v0.1 — real build output (`dist/`,
JS + type declarations; the acceptance suite and a build smoke test
both run green, the smoke test against the build itself), the
reference JSONL recorder, two worked examples, and denial-reading
docs. Zero runtime dependencies; Node ≥ 18; ESM.

Milestone 2 complete: first external integration — the governed Jev
runs this package end-to-end as an opt-in governor backend (bridge,
scenario proof, and lessons in `integrations/jev/` and `PLAN.md`
§8); the acceptance suite now covers the bridge contract too (9
checks).

Not yet published: the package is `private: true` and the publish
decision (public repo, npm) is the maintainer's, per `PLAN.md`.

See `PLAN.md` for the product plan.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Ghost Developer Studio.
Design lineage: CopilotKit/OpenBot (MIT), via Ghost Kernel.
