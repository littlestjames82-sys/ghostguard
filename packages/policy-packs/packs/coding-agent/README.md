# Coding Agent — a Policy Pack for GhostGuard

**Tested governance for an agent that writes software.**

The agent may read the codebase freely, and write files, commit
locally, and run tests and builds under **standing approvals** — but
**pushing and merging ask a human first**, **deploys and releases
route to the owner**, and **reading secrets, force-pushing, and
deleting are refused outright**. Those three refusals are `locked`
rules: your own later policy edits cannot tune them away.

By Ghost Developer Studio. Works with the GhostGuard engine
(TypeScript) and the Agent Seatbelt governor (Python) — both evaluate
this exact policy document.

## What it governs

The pack decides over actions classified into this vocabulary (your
integrator maps your agent's real operations onto these kinds):

| Action kind | Class | Verdict | Why |
| --- | --- | --- | --- |
| `code.read` | READ | allow | Understanding the codebase is the day job. |
| `code.search` | READ | allow | |
| `code.grep` | READ | allow | |
| `code.list` | READ | allow | |
| `code.write` | WRITE_LOCAL | **pre_approved** | Standing approval for local project work — recorded as pre_approved, not a silent allow. |
| `code.edit` | WRITE_LOCAL | **pre_approved** | |
| `git.commit` | WRITE_LOCAL | **pre_approved** | Classified WRITE_LOCAL in this pack: a local commit is reversible and not yet shared. Pushing it asks. |
| `code.test.run` | EXECUTE | **pre_approved** | Standing approval, bounded to this kind. An agent that must ask to run tests cannot work. |
| `code.build` | EXECUTE | **pre_approved** | Standing approval, bounded to this kind. |
| `git.push` | NETWORK_WRITE | **ask** | Changes shared state other people build on — a human approves the exact payload first. |
| `git.pr.merge` | NETWORK_WRITE | **ask** | Merging is publishing code to the shared branch. |
| `git.push` (`payload.force == true`) | NETWORK_WRITE | **deny — locked** | Force pushes rewrite shared history and can destroy other people's work. |
| `deploy.release` | DEPLOY | **hand_off → owner** | Shipping to users is the owner's call, not this run's approver's. |
| `deploy.promote` | DEPLOY | **hand_off → owner** | |
| `release.publish` | PUBLISH | **hand_off → owner** | |
| `code.secrets.read` (any `code.secrets.*`) | EXECUTE | **deny — locked** | Secrets are never part of the agent's own job, whatever class the tool assigns. |
| `env.secrets.access` (any `env.secrets.*`) | EXECUTE | **deny — locked** | |
| `git.branch.delete` | DELETE | **deny — locked** | Any DELETE class is refused locked (`delete-never`), which covers branch deletion and every other deletion. Humans delete by hand. |
| anything else | — | **deny** | Unmapped kinds (e.g. an EXECUTE kind that is not test/build, dependency installs, shell escapes) hit the fail-closed default until you map them deliberately — see Tuning. |

Semantics worth knowing:

- **Strictest verdict wins** (deny > hand_off > ask > pre_approved >
  allow), independent of rule order. A force push matches the push
  ask rule too — the locked deny tier outranks it. A secrets read
  classified EXECUTE matches no permissive rule, and the locked
  deny decides before class ever matters.
- **`git.commit` is WRITE_LOCAL in this pack.** That classification
  is the document's deliberate choice: commit lands in
  `local-writes-pre-approved` at **pre_approved**, not allow. If
  your integrator classifies commit as EXECUTE instead, it is
  unmapped in this pack and denies — change the classification,
  not the rule, to get the documented verdict.
- **The initiator is not the payload.** Rules see the run-stamped
  `initiator` (person / routine / handoff / memory / system). A
  payload field named `initiator` is a different field and spoofs
  nothing. A routine gets the same standing approvals a person does
  for local work, and the same ask / hand_off for shared and
  shipped work — a routine deploy still hands off to the owner.
- **Force is a payload fact, checked exactly.** `git.push` denies
  only when `payload.force == true`. A push with no `force` field
  at all asks — the absent field evaluates to null, and
  `null == true` is false, so absence never manufactures a deny
  (or an approval).

## Install

GhostGuard (TypeScript):

```ts
import { readFileSync } from "node:fs";
import { compilePolicy } from "ghostguard";

const pack = JSON.parse(readFileSync("packs/coding-agent/policy.json", "utf8"));
const policy = compilePolicy(pack);
// evaluate per action with evaluatePolicy(policy, ctx) — see the
// GhostGuard README for the record-first gateway flow.
```

Agent Seatbelt (Python): load the same `policy.json` as the governor's
policy document — the format is shared, the verdicts are identical.

Then classify your agent's operations per the table above and route
every action through the gateway **before** executing it. That wiring
is the whole integration; the pack replaces the policy-writing step.

## Verify your copy

The pack ships its behavior tests; run them against your engine
before you trust it (from the policy-packs root):

```
npx tsx packs/coding-agent/test/run.ts
```

11 checks: pack integrity, every verdict in the table, the
strictest-wins interactions, the fail-closed edges, initiator
branching and spoof resistance, and the locked layer surviving a
hostile overlay. If a platform changes its action surface, these
tests are where the pack gets re-proven.

## Tuning knobs

All rules except the locked core are yours to edit — edit a copy of
`policy.json`, keep the tests, and change the tests to match your
intent before you change the rules to match your tests.

- **Make tests ask on sensitive projects:** change
  `tests-and-builds-pre-approved` to effect `ask`, or bound the
  standing approval by adding a `project_id` condition for the
  projects where it holds — never by weakening the ask rules.
- **Pre-approve pushes to a scratch repository:** add a bounded
  `pre_approved` rule for `git.push` on that specific `project_id`
  — never by weakening `push-and-merge-ask` for every project, and
  it still cannot outrank the locked force-push deny.
- **Change who deploys hand off to:** change
  `deploy-and-publish-to-owner`'s `handoff_to` from `owner` to a
  release-manager scope — only if that scope genuinely owns the
  ship decision.
- **Admit another EXECUTE kind** (e.g. a linter or formatter): add
  its kind to a bounded rule in the style of
  `tests-and-builds-pre-approved`. EXECUTE is deliberately not
  blanket-approved: an unmapped executor is how agents end up
  running arbitrary shell.
- **A second locked line** (e.g. a protected branch or a repo that
  must never be pushed to): add your own `locked: true` deny rule;
  locked rules you add are protected the same way in your merges.
- **Do not** unlock the locked core casually: `secrets-never`,
  `force-push-never`, and `delete-never` are locked because "the
  agent read the credentials", "the agent rewrote shared history",
  and "the agent deleted the branch" are the incidents this pack
  exists to prevent. A human does those steps by hand, outside the
  agent.

## Files

- `policy.json` — the policy document (8 rules).
- `test/run.ts` — the behavior suite described above.
- `README.md` — this file.

See `../../PLAN.md` for the pack format definition and the full
Policy Packs catalog.
