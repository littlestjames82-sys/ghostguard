# Marketplace Seller — a Policy Pack for GhostGuard

**Tested governance for an agent that helps a seller on a marketplace.**

The agent may browse the market and read the seller's own listings
freely, and **drafting is free** — listing drafts and reply drafts
alike. But **sending messages and offers asks**, **price changes
ask**, and **deleting listings and changing payout or bank details
are refused outright**. Both refusals are `locked` rules: your own
later policy edits cannot tune them away.

By Ghost Developer Studio. Works with the GhostGuard engine
(TypeScript) and the Agent Seatbelt governor (Python) — both evaluate
this exact policy document.

## What it governs

The pack decides over actions classified into this vocabulary (your
integrator maps your agent's real operations onto these kinds):

| Action kind | Class | Verdict | Why |
| --- | --- | --- | --- |
| `market.listing.browse` | READ | allow | Watching the market is the day job. |
| `market.listing.search` | READ | allow | |
| `market.listing.own.read` | READ | allow | The seller's own listings, prices, and inquiries. |
| `market.listing.draft` | WRITE_LOCAL | allow | A draft listing is invisible to buyers. |
| `market.message.draft.create` | WRITE_LOCAL | allow | **Drafting replies is free** — the headline of this pack. A draft reaches nobody. |
| `market.message.send` | COMMUNICATE | **ask** | Words that reach a real buyer, under the seller's name — a human approves the exact payload first. |
| `market.offer.send` | NETWORK_WRITE | **ask** | An offer is a binding price commitment, not a draft. (Design: offers ask by this kind rule; messages ask by the COMMUNICATE class rule — both surfaces ask, by two rules, deliberately.) |
| `market.price.change` | NETWORK_WRITE | **ask** | A price is a public commitment; a typo becomes a negotiation the seller did not choose. |
| `market.listing.delete` | DELETE | **deny — locked** | Irreversible: photos, description, and inquiry history go with the listing. Humans delete by hand. |
| `market.payout.change` (any `market.payout.*`) | NETWORK_WRITE | **deny — locked** | Where the money goes is the account-drain surface. The seller changes it by hand, in the platform's own settings. |
| `market.bank.change` (any `market.bank.*`) | NETWORK_WRITE | **deny — locked** | Same line for bank details. |
| anything else | — | **deny** | Unmapped kinds and classes hit the fail-closed default — including SPEND (a seller agent never spends) — until you map them deliberately — see Tuning. |

Semantics worth knowing:

- **Strictest verdict wins** (deny > hand_off > ask > pre_approved >
  allow), independent of rule order. A payout change classified
  NETWORK_WRITE walks the same class as price changes and offers —
  which ask — and still **denies**, by name, via the locked rule. An
  allow or ask you add later can never outrank either locked deny.
- **Drafting is not sending.** The pack's whole shape is the gap
  between WRITE_LOCAL (free) and COMMUNICATE / offer sends (ask).
  If your integrator classifies a "draft" that the platform actually
  delivers to a buyer, that is a send — classify it as one.
- **SPEND fails closed by omission.** No rule in this pack maps the
  SPEND class: a seller agent has no legitimate reason to spend, so a
  spend matches nothing and the engine's no-match default denies it
  (`rule_id: null`). Adding spend later means writing a rule, in the
  open.
- **The initiator is not the payload.** Rules see the run-stamped
  `initiator` (person / routine / handoff / memory / system). A
  payload field named `initiator` is a different field and spoofs
  nothing. This pack holds routines to the same standard as people
  on everything except the free work: a routine may browse and draft
  unattended, but its message sends still ask and its deletes still
  deny.

## Install

GhostGuard (TypeScript):

```ts
import { readFileSync } from "node:fs";
import { compilePolicy } from "ghostguard";

const pack = JSON.parse(readFileSync("packs/marketplace-seller/policy.json", "utf8"));
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
npx tsx packs/marketplace-seller/test/run.ts
```

11 checks: pack integrity, every verdict in the table, both locked
lines, the fail-closed edges, initiator branching and spoof
resistance, and the locked layer surviving a hostile overlay. If a
platform changes its action surface, these tests are where the pack
gets re-proven.

## Tuning knobs

All rules except the locked core are yours to edit — edit a copy of
`policy.json`, keep the tests, and change the tests to match your
intent before you change the rules to match your tests.

- **A standard reply that may send itself:** if your flow uses canned
  answers (e.g. "yes, it's still available"), express that as a
  bounded `pre_approved` rule naming the exact template kind or id —
  never by weakening `message-sends-ask` for all messages, and never
  keyed to a payload flag the agent itself can set.
- **Small price moves without an ask:** add a bounded rule for
  `market.price.change` keyed to a payload bound your integrator
  computes honestly (e.g. a percentage field) — or keep every change
  asking; for most sellers the ask *is* the feature.
- **End-of-listing cleanup:** if sold listings must come down on a
  schedule, that is a human habit, not an agent power — have the
  agent *draft* a cleanup list (WRITE_LOCAL) for the seller to work
  through, and leave `delete-never` alone.
- **A second locked line** (e.g. a second marketplace account the
  agent must never touch): add your own `locked: true` deny rule;
  locked rules you add are protected the same way in your merges.
- **Do not** unlock `payout-never` or `delete-never` casually: they
  are locked because "the agent moved the payout account" and "the
  agent deleted the wrong listing" are the incidents this pack
  exists to prevent. Payout and bank changes take a human two
  minutes in the platform's own settings — that friction is the
  control.

## Files

- `policy.json` — the policy document (7 rules).
- `test/run.ts` — the behavior suite described above.
- `README.md` — this file.

See `../../PLAN.md` for the pack format definition and the full
Policy Packs catalog.
