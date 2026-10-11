# Reading a denial

Your agent just stopped, and somewhere in your audit trail there is a
record like the one below. This page walks it field by field — because
"why was this denied?" is the first support question every fail-closed
system gets, and the record is designed to answer it without anyone
opening the policy engine.

This is a real record, produced by the shipped engine. An unattended
run (a routine) had an agent propose a purchase; the policy carried a
**locked** rule against spending, and the purchase never happened.

```json
{
  "action_id": "act_2026_1042",
  "kind": "pay.purchase",
  "permission_class": "SPEND",
  "actor": "ops-agent",
  "initiator": "routine",
  "project_id": "studio-ops",
  "verdict": "deny",
  "rule_id": "no-spend-ever",
  "reason": "denied by policy rule \"no-spend-ever\"",
  "handoff_to": null,
  "target_ref": null,
  "snapshot_id": null,
  "target": null,
  "action_payload": {
    "item": "gpu-hours",
    "amount": 240,
    "currency": "USD"
  },
  "dry_run": false
}
```

## Field by field

| Field | Here | What it tells you |
| --- | --- | --- |
| `action_id` | `act_2026_1042` | The integrator's id for this proposed action. Search your trail by it to find everything decided about this action (an ask, an approval, a re-evaluation are separate records under the same id). |
| `kind` | `pay.purchase` | The action in the *integrator's* vocabulary — what the agent was trying to do. |
| `permission_class` | `SPEND` | The consequence class the integrator's classifier mapped `kind` onto. Most rules match on this, not on `kind`. If a verdict surprises you, check the classification first — when in doubt, integrators are told to classify up. |
| `actor` | `ops-agent` | **Who proposed** the action. |
| `initiator` | `routine` | **What started the run** — here, an unattended routine, not a person at a keyboard. Stamped by the run's entry point, never by the proposer, so this field can be trusted in a way a payload field cannot. Policies can (and do) hold routines to a stricter standard. |
| `project_id` | `studio-ops` | The project/workspace scope the action belonged to. |
| `verdict` | `deny` | The decision. The action **did not run**. (A record existing does not mean an action happened — it means an action was *decided*. Read the verdict.) |
| `rule_id` | `no-spend-ever` | The rule that decided, by name. This is the single most useful field: find this id in your policy document and you are looking at the exact line that refused. |
| `reason` | `denied by policy rule "no-spend-ever"` | The engine's plain-language rendering of the decision. For a deny, it names the rule; for a fail-closed deny (below), it says what broke. |
| `handoff_to` | `null` | Only set on a `hand_off` verdict — the approver/scope the action was routed to instead. |
| `target_ref` / `snapshot_id` / `target` | `null` | Set when the caller addressed the target by an opaque ref: `target` then carries the resolved target fields from the snapshot. Here the payload identified the target directly, so they are null. |
| `action_payload` | `{ item, amount, currency }` | **The exact payload that would have run** — post-resolution, byte for byte. On an `ask`, this is the ratification material: the approvals surface proposes exactly this to the human, nothing paraphrased. |
| `dry_run` | `false` | Whether the run was in dry-run mode (decided and recorded, never executed regardless of verdict). |

## The three questions a denial answers

1. **What was refused?** — `kind` + `action_payload`. Not a summary:
   the exact thing.
2. **Who is responsible for proposing it?** — `actor`, and
   `initiator` for what set the run in motion. A `routine`-initiated
   denial at 3 a.m. is a different conversation than a
   `person`-initiated one.
3. **What refused it, and what would change the answer?** —
   `rule_id`. In this case the rule is *locked* (`locked: true` in
   the policy), so the honest answer is "nothing an operator can
   edit" — the team layer decided this class of action never runs,
   and changing that is a deliberate policy change by whoever owns
   the locked layer, not an approval click.

## Two special cases worth recognising

- **`rule_id` is `null` on a deny.** No rule matched at all, and the
  fail-closed default denied it (`reason` says so). The fix is one
  of: classify the kind correctly, or add a rule that covers it. A
  missing policy permits nothing — that is the design, not a bug.
- **The rule names *itself* and the reason says it is "broken".** A
  restrictive rule whose expression can't be parsed or evaluated
  denies everything it might cover, naming itself — because what it
  meant to cover is unknowable. Fix the expression; until then the
  deny is the safe answer. (A broken *permissive* rule does the
  opposite: it is inert — it grants nothing and blocks nothing.)

## Denial triage checklist for operators

When the record shows a denial, triage in this order:

1. Check `rule_id` and `reason` — this tells you exactly which rule
  decided and whether the rule is missing, broken, or intentional.
2. Check `initiator` and `actor` — a routine-initiated action often
  needs stricter rules than a person-initiated one.
3. Check `permission_class` — a bad classification can make an allowed
  action appear denied or vice versa.
4. Check the rule for the `handoff_to` or expression issue if the
  policy is malformed; these are immediate authoring defects.
5. If the rule is valid and intentional, treat the denial as the correct
  safety outcome and inspect the upstream request path instead of
  relaxing policy.

And the corollary for `ask` records: an `ask` is not a denial. The
action hasn't run *yet*; the record's payload is waiting for a human
decision, and if the human approves, the approval is carried into a
fresh evaluation — which produces its own record, under the same
`action_id`.
