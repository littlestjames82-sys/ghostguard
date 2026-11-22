# Shopping Agent — a Policy Pack for GhostGuard

**Tested governance for an agent that researches and buys products.**

The agent may browse, compare, and build a cart freely — but
**checkout asks a human first**, spend **above a $500 cap routes to
the budget owner**, and **subscriptions and gift cards are refused
outright**. Subscriptions and gift cards are refused by `locked`
rules: your own later policy edits cannot tune them away.

By Ghost Developer Studio. Works with the GhostGuard engine
(TypeScript) and the Agent Seatbelt governor (Python) — both evaluate
this exact policy document.

## What it governs

The pack decides over actions classified into this vocabulary (your
integrator maps your agent's real operations onto these kinds).
Spends must carry `payload.amount_usd` and `payload.item_kind`
(`one_off` / `subscription` / `gift_card`) — the integrator computes
them from the actual cart and checkout total; a spend with no amount
still asks (see Semantics).

| Action kind | Class | Verdict | Why |
| --- | --- | --- | --- |
| `shop.browse` | READ | allow | Research is the day job. |
| `shop.search` | READ | allow | |
| `shop.product.read` | READ | allow | |
| `shop.compare` | READ | allow | |
| `shop.order.track` | READ | allow | Tracking moves no money. |
| `shop.cart.add` | WRITE_LOCAL | allow | Nothing is bought until checkout. |
| `shop.cart.edit` | WRITE_LOCAL | allow | |
| `shop.wishlist.add` | WRITE_LOCAL | allow | |
| `shop.checkout` with `amount_usd` ≤ 500 | SPEND | **ask** | A human approves the exact payload — amount included — first. |
| `shop.checkout` with `amount_usd` > 500 | SPEND | **hand_off → budget-owner** | Over-cap spend belongs to whoever holds the budget. |
| any other SPEND, or a SPEND with no amount | SPEND | **ask** | The generic spend ask is the floor for every purchase shape. |
| `shop.subscribe` (`item_kind: 'subscription'`) | SPEND | **deny — locked** | A subscription is a recurring commitment, not a purchase — at any price, even $5. |
| `shop.giftcard.buy` (`item_kind: 'gift_card'`) | SPEND | **deny — locked** | Untraceable and non-refundable: the canonical fraud instrument. |
| anything else | — | **deny** | Unmapped kinds (e.g. `shop.price.watch`, `shop.price-alert.create` — price alerts/watches until you map them deliberately) hit the fail-closed default — see Tuning. |

Semantics worth knowing:

- **Strictest verdict wins** (deny > hand_off > ask > pre_approved >
  allow), independent of rule order. A gift card or subscription
  priced over the cap still **denies** — the locked denies outrank
  the over-cap hand_off it also matches.
- **The cap bound is `>`, not `>=`.** Exactly $500 asks like any
  other under-cap checkout; $501 hands off. The over-cap rule checks
  the SPEND class first and guards `amount_usd != null` before the
  comparison, so a spend with no amount short-circuits to the ask
  instead of erroring into a deny.
- **`item_kind` is data, `initiator` is not.** The payload's
  `item_kind` is legitimate classification the integrator stamps
  from the real cart. The run-stamped `initiator` (person / routine
  / handoff / memory / system) is a different thing entirely: a
  payload field named `initiator` spoofs nothing, and this pack
  holds routines to the same checkout standard as people — a
  routine may research and build carts unattended, but may not
  check out without the same ask.

## Install

GhostGuard (TypeScript):

```ts
import { readFileSync } from "node:fs";
import { compilePolicy } from "ghostguard";

const pack = JSON.parse(readFileSync("packs/shopping-agent/policy.json", "utf8"));
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
npx tsx packs/shopping-agent/test/run.ts
```

11 checks: pack integrity, every verdict in the table, the cap
boundary, the missing-amount edge, the fail-closed edges, initiator
branching and spoof resistance, and the locked layer surviving a
hostile overlay. If a storefront changes its action surface, these
tests are where the pack gets re-proven.

## Tuning knobs

All rules except the locked core are yours to edit — edit a copy of
`policy.json`, keep the tests, and change the tests to match your
intent before you change the rules to match your tests.

- **Raise or lower the cap:** the cap is the `500` in
  `over-cap-to-budget-owner`'s `when` — change that one number (and
  the cap tests) to your budget. $500 is the shipped default, not a
  recommendation.
- **Route over-cap spend somewhere else:** change that rule's
  `handoff_to` from `budget-owner` to whoever actually holds the
  budget in your setup (`finance`, a named person, a channel).
- **Small purchases pre-approved:** if your flow pre-approves a
  consumables budget, express it as a bounded `pre_approved` rule
  (specific kinds, amount under your floor) — never by weakening
  `spending-asks`, and never keyed to a payload flag the agent
  itself can set.
- **Let price alerts/watches through:** classify them deliberately
  — `allow` them as READ/WRITE_LOCAL kinds with a rule naming the
  kinds if they only observe prices, or leave them unmapped and
  denied if they can place orders.
- **A second locked line** (e.g. a store or category that must
  never be bought from): add your own `locked: true` deny rule;
  locked rules you add are protected the same way in your merges.
- **Do not** unlock `gift-cards-never` or `subscriptions-never`
  casually: they are locked because "the agent bought gift cards"
  and "the agent started a subscription" are the incidents this
  pack exists to prevent. If a human-run workflow needs either,
  run the purchase itself outside the agent.

## Files

- `policy.json` — the policy document (6 rules).
- `test/run.ts` — the behavior suite described above.
- `README.md` — this file.

See `../../PLAN.md` for the pack format definition and the full
Policy Packs catalog.
