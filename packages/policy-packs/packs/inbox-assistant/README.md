# Inbox Assistant — a Policy Pack for GhostGuard

**Tested governance for an agent that triages an email/chat inbox.**

The agent may read, search, and draft replies freely — but **sending
asks a human first**, a send carrying an **attachment or an external
recipient routes to the owner**, and **deleting mail and changing
filters, rules, or settings are refused outright**. Deleting is
refused by a `locked` rule: your own later policy edits cannot tune
it away.

By Ghost Developer Studio. Works with the GhostGuard engine
(TypeScript) and the Agent Seatbelt governor (Python) — both evaluate
this exact policy document.

## What it governs

The pack decides over actions classified into this vocabulary (your
integrator maps your agent's real operations onto these kinds).
Sends must also carry the payload flags `has_attachment` and
`external_recipient` — the integrator computes them from the actual
message; the agent does not get to assert them away.

| Action kind | Class | Verdict | Why |
| --- | --- | --- | --- |
| `email.read` | READ | allow | Triage is the day job. |
| `email.search` | READ | allow | |
| `email.thread.read` | READ | allow | |
| `email.draft.create` | WRITE_LOCAL | allow | A draft has been sent to nobody. |
| `email.draft.edit` | WRITE_LOCAL | allow | |
| `email.send` (no attachment, internal recipient) | COMMUNICATE | **ask** | A human approves the exact payload first. |
| `email.send` with `has_attachment: true` | COMMUNICATE | **hand_off → owner** | Attachments are the leak vector; the owner sees them leave. |
| `email.send` with `external_recipient: true` | COMMUNICATE | **hand_off → owner** | Mail leaving the organization belongs to the owner. |
| `email.delete`, `message.delete` (any DELETE) | DELETE | **deny — locked** | Irreversible, and destroys the record. Humans delete by hand. |
| `email.filter.create`, `email.rule.change` | any | **deny** | A forwarding/filter rule redirects all future mail — the takeover move. |
| `email.settings.*` (any settings kind) | any | **deny** | Inbox settings are the account owner's hands only. |
| anything else | — | **deny** | Unmapped kinds (e.g. `email.webhook.register`, label/tag mutations you have not classified) hit the fail-closed default until you map them deliberately — see Tuning. |

Semantics worth knowing:

- **Strictest verdict wins** (deny > hand_off > ask > pre_approved >
  allow), independent of rule order. A delete dressed up with
  send-shaped payload flags still denies, and the attachment/external
  hand_off outranks the plain-send ask it also matches.
- **A plain send never hands off, and never auto-sends.** Absent
  payload flags evaluate as not-true, so an ordinary internal send
  lands on the ask — it clears only through the human approval flow,
  on the exact recorded payload.
- **The initiator is not the payload.** Rules see the run-stamped
  `initiator` (person / routine / handoff / memory / system). A
  payload field named `initiator` is a different field and spoofs
  nothing. This pack holds routines to the same sending standard as
  people: a routine may read and draft unattended, but may not send
  without the same ask, or hand-off where the flags demand it.

## Install

GhostGuard (TypeScript):

```ts
import { readFileSync } from "node:fs";
import { compilePolicy } from "ghostguard";

const pack = JSON.parse(readFileSync("packs/inbox-assistant/policy.json", "utf8"));
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
npx tsx packs/inbox-assistant/test/run.ts
```

11 checks: pack integrity, every verdict in the table, the
fail-closed edges, initiator branching and spoof resistance, and the
locked layer surviving a hostile overlay. If a mail platform changes
its action surface, these tests are where the pack gets re-proven.

## Tuning knobs

All rules except the locked core are yours to edit — edit a copy of
`policy.json`, keep the tests, and change the tests to match your
intent before you change the rules to match your tests.

- **Risky sends ask instead of handing off:** change
  `risky-sends-to-owner` to effect `ask` and drop `handoff_to` —
  only if the run's approver genuinely is the right person to clear
  attachments and external mail.
- **Attachments to known-internal domains pass as plain sends:** if
  your classifier can prove a recipient is internal, set
  `external_recipient: false` at classification time — fix the
  classification, never weaken the hand-off rule to trust a payload
  flag the agent supplies itself.
- **Let the agent archive/label freely:** classify archive and
  label operations as WRITE_LOCAL kinds (e.g. `email.archive`,
  `email.label.apply`) — drafting-is-free allows them, because they
  delete nothing. Do **not** reclassify delete as archive.
- **A second locked line** (e.g. a mailbox that must never be sent
  from): add your own `locked: true` deny rule; locked rules you
  add are protected the same way in your merges.
- **Filter changes ask instead of denying:** change
  `filters-and-settings-never` to `ask` if a human-in-the-loop
  filter workflow genuinely exists — but know that an approved
  forwarding rule is still a forwarding rule; the deny is the
  default because that rule shape is the takeover pattern.
- **Do not** unlock `delete-never` casually: it is locked because
  "the agent deleted the thread" is the incident this pack exists
  to prevent. If an audited retention workflow needs deletion, run
  it as a separate human-initiated job outside this agent.

## Files

- `policy.json` — the policy document (6 rules).
- `test/run.ts` — the behavior suite described above.
- `README.md` — this file.

See `../../PLAN.md` for the pack format definition and the full
Policy Packs catalog.
