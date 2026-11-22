# Agency Client Work — a Policy Pack for GhostGuard

**Tested governance for an agency agent that works across client projects.**

Every run is scoped to **one client project** — the `project_id` of the
workspace the run belongs to. Inside that project the agent may read,
write, and draft freely — but **client communications route to the
studio owner**, **sending files outside the project asks**, **spending
asks**, and **reaching into another client's project is refused
outright** by a `locked` rule: your own later policy edits cannot tune
it away.

By Ghost Developer Studio. Works with the GhostGuard engine
(TypeScript) and the Agent Seatbelt governor (Python) — both evaluate
this exact policy document.

## What it governs

The pack decides over actions classified into this vocabulary (your
integrator maps your agent's real operations onto these kinds):

| Action kind | Class | Verdict | Why |
| --- | --- | --- | --- |
| `client.file.read` | READ | allow | Working inside the client's own project is the day job. |
| `client.doc.read` | READ | allow | |
| `client.file.write` | WRITE_LOCAL | allow | Internal work; nothing has left the project. |
| `client.draft.create` | WRITE_LOCAL | allow | A draft is internal until a send action. |
| `client.message.send` | COMMUNICATE | **hand_off → owner** | The studio owner speaks to clients, not the agent or this run's approver. |
| `client.email.send` | COMMUNICATE | **hand_off → owner** | Same line for email. |
| `client.file.send` (with `payload.external == true`) | NETWORK_WRITE | **ask** | A file leaving the project is a disclosure — a human approves the exact payload first. |
| `client.file.share` (with `payload.external == true`) | NETWORK_WRITE | **ask** | Sharing a link out is sending, by another name. |
| `client.spend` | SPEND | **ask** | Client money moves only with a human's approval, on the exact amount. |
| `client.ads.buy` | SPEND | **ask** | Ad buys are spend. |
| `client.file.delete` | DELETE | **deny** | DELETE is deliberately unmapped in this pack, so deletes hit the fail-closed default (no rule matches — see Semantics). A human deletes by hand. |
| any kind, with `payload.target_project_id` naming a different project than the run's `project_id` | any | **deny — locked** | Cross-client access, in either direction, for any initiator. Client data never crosses client lines. |
| anything else | — | **deny** | Unmapped kinds (e.g. other NETWORK_WRITE, EXECUTE, DEPLOY, PUBLISH) hit the fail-closed default until you map them deliberately — see Tuning. |

Semantics worth knowing:

- **Strictest verdict wins** (deny > hand_off > ask > pre_approved >
  allow), independent of rule order. In particular, the locked
  cross-client **deny beats the comms hand_off**: a message addressed
  into another client's project is refused, not politely routed to
  the owner as if it were legitimate client work.
- **Project scope is two different fields.** `project_id` is the
  run-stamped context field — the client whose workspace this run
  belongs to, set by trusted code. `payload.target_project_id` is the
  project an action reaches *into*, carried in the payload. The locked
  rule fires only when a target is named **and** differs. An absent
  target evaluates to `null`, the `!= null` guard is false, and the
  rule does not misfire: ordinary in-project work with no target
  named proceeds under its own rules, and work naming its own project
  proceeds too.
- **DELETE fails closed by omission.** No rule in this pack maps the
  DELETE class, so a delete matches nothing and the engine's
  no-match default denies it (`rule_id: null`). That is deliberate:
  adding delete support later means writing a rule, in the open.
- **The initiator is not the payload.** Rules see the run-stamped
  `initiator` (person / routine / handoff / memory / system). A
  payload field named `initiator` is a different field and spoofs
  nothing. This pack holds routines to the same standard as people
  on everything except the free in-project work: a routine may read,
  write, and draft unattended, but its comms still hand off and its
  spend still asks.

## Install

GhostGuard (TypeScript):

```ts
import { readFileSync } from "node:fs";
import { compilePolicy } from "ghostguard";

const pack = JSON.parse(readFileSync("packs/agency-client-work/policy.json", "utf8"));
const policy = compilePolicy(pack);
// evaluate per action with evaluatePolicy(policy, ctx) — see the
// GhostGuard README for the record-first gateway flow.
```

Agent Seatbelt (Python): load the same `policy.json` as the governor's
policy document — the format is shared, the verdicts are identical.

Then classify your agent's operations per the table above and route
every action through the gateway **before** executing it. Stamp each
run's context with the one `project_id` it is scoped to, and have your
integrator set `payload.target_project_id` whenever an action names a
project other than implicitly its own. That wiring is the whole
integration; the pack replaces the policy-writing step.

## Verify your copy

The pack ships its behavior tests; run them against your engine
before you trust it (from the policy-packs root):

```
npx tsx packs/agency-client-work/test/run.ts
```

11 checks: pack integrity, every verdict in the table, the
cross-client locked line (including the deny-beats-hand_off send), the
fail-closed edges, initiator branching and spoof resistance, and the
locked layer surviving a hostile overlay. If a platform changes its
action surface, these tests are where the pack gets re-proven.

## Tuning knobs

All rules except the locked core are yours to edit — edit a copy of
`policy.json`, keep the tests, and change the tests to match your
intent before you change the rules to match your tests.

- **Comms ask instead of handing off:** change `comms-to-owner` to
  effect `ask` and drop `handoff_to` — only if the run's approver
  genuinely is the right person to speak for the studio to clients.
- **A trusted client's standing send approval:** express it as a
  bounded `pre_approved` rule (specific kinds, specific `project_id`)
  — never by weakening `external-file-send-asks`, and never keyed to
  a payload flag the agent itself can set.
- **A spend ceiling that hands off:** add a rule handing SPEND over a
  payload amount bound off to whoever holds the budget, e.g.
  `permission_class == 'SPEND' && payload.amount_usd > 500` with
  effect `hand_off` — amounts below it still ask via `spend-asks`.
- **Deliberate delete support:** if a workflow truly needs deletes,
  add a narrow rule naming the exact kinds (an `ask`, bounded by
  `project_id`) instead of mapping the whole DELETE class — and keep
  the fail-closed test, updated to your new intent.
- **A second locked line** (e.g. one client whose files must never
  leave their project at all): add your own `locked: true` deny rule
  naming that `project_id`; locked rules you add are protected the
  same way in your merges.
- **Do not** unlock `cross-client-never` casually: it is locked
  because "the agent pasted Client A's numbers into Client B's deck"
  is the incident this pack exists to prevent. If a human-run
  cross-client workflow needs material moved, a human moves it, or
  prepares it as an in-project draft (WRITE_LOCAL) in each project
  separately.

## Files

- `policy.json` — the policy document (6 rules).
- `test/run.ts` — the behavior suite described above.
- `README.md` — this file.

See `../../PLAN.md` for the pack format definition and the full
Policy Packs catalog.
