# Social Poster — a Policy Pack for GhostGuard

**Tested governance for an agent that runs a social media account.**

The agent may read and research freely, draft freely, and upload media
under a standing approval — but the moment anything becomes **public**
it asks a human first, **DMs route to the account owner**, and
**deleting, account settings, and spending are refused outright**.
Spending is refused by a `locked` rule: your own later policy edits
cannot tune it away.

By Ghost Developer Studio. Works with the GhostGuard engine
(TypeScript) and the Agent Seatbelt governor (Python) — both evaluate
this exact policy document.

## What it governs

The pack decides over actions classified into this vocabulary (your
integrator maps your agent's real operations onto these kinds):

| Action kind | Class | Verdict | Why |
| --- | --- | --- | --- |
| `social.feed.read` | READ | allow | Research is the day job. |
| `social.search` | READ | allow | |
| `social.profile.read` | READ | allow | |
| `social.metrics.read` | READ | allow | |
| `social.draft.create` | WRITE_LOCAL | allow | A draft is invisible until published. |
| `social.draft.edit` | WRITE_LOCAL | allow | |
| `social.media.upload` | NETWORK_WRITE | **pre_approved** | Standing approval, bounded to this kind. Uploaded media is not public yet. |
| `social.post.publish` | PUBLISH | **ask** | Public, under your name — a human approves the exact payload first. |
| `social.comment.reply` | PUBLISH | **ask** | Public replies are publishing. |
| `social.dm.send` | COMMUNICATE | **hand_off → owner** | Private conversations belong to the owner, not this run's approver. |
| `social.post.delete` | DELETE | **deny** | Irreversible and public. Humans delete by hand. |
| `social.account.edit` (any `social.account.*`) | any | **deny** | Settings/identity/credentials are the takeover surface. |
| `social.ads.create`, `social.post.boost` (any SPEND) | SPEND | **deny — locked** | The agent never spends. Ads are a human channel. |
| anything else | — | **deny** | Unmapped kinds (e.g. `social.like`, `social.follow`, webhook changes) hit the fail-closed default until you map them deliberately — see Tuning. |

Semantics worth knowing:

- **Strictest verdict wins** (deny > hand_off > ask > pre_approved >
  allow), independent of rule order. An allow you add later can never
  outrank this pack's restrictive rules.
- **Auto-review never overrides ask.** A payload flag like
  `auto_review_passed: true` is just payload data; no rule reads it.
  A publish clears only through the human approval flow, on the exact
  recorded payload.
- **The initiator is not the payload.** Rules see the run-stamped
  `initiator` (person / routine / handoff / memory / system). A
  payload field named `initiator` is a different field and spoofs
  nothing. This pack holds routines to the same public-action standard
  as people: a routine may research and draft unattended, but may not
  publish without the same ask.

## Install

GhostGuard (TypeScript):

```ts
import { readFileSync } from "node:fs";
import { compilePolicy } from "ghostguard";

const pack = JSON.parse(readFileSync("packs/social-poster/policy.json", "utf8"));
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
npm test
```

11 checks: pack integrity, every verdict in the table, the
fail-closed edges, initiator branching and spoof resistance, and the
locked layer surviving a hostile overlay. If a platform changes its
action surface, these tests are where the pack gets re-proven.

## Tuning knobs

All rules except the locked core are yours to edit — edit a copy of
`policy.json`, keep the tests, and change the tests to match your
intent before you change the rules to match your tests.

- **Let likes/follows through (or make them ask):** add a rule, e.g.
  `{ "id": "likes-ask", "effect": "ask", "when": "kind in ['social.like', 'social.follow']" }`
  and classify those kinds as PUBLISH — or `allow` them as
  NETWORK_WRITE with an allow rule naming the kinds. Deliberate, in
  writing, either way.
- **DMs ask instead of handing off:** change `dms-to-owner` to effect
  `ask` and drop `handoff_to` — only if the run's approver genuinely
  is the right person to answer customers.
- **A second locked line** (e.g. a specific account that must never
  be posted to): add your own `locked: true` deny rule; locked rules
  you add are protected the same way in your merges.
- **Scheduled-post exception:** if your flow pre-approves a content
  calendar, express it as a bounded `pre_approved` rule (specific
  kinds, specific project) — never by weakening `publishing-asks`,
  and never keyed to a payload flag the agent itself can set.
- **Do not** unlock `spend-never` casually: it is locked because
  "the agent bought ads" is the incident this pack exists to
  prevent. If a human-run ads workflow needs the agent to *prepare*
  campaigns, map preparation to a draft kind (WRITE_LOCAL) and keep
  the purchase itself outside the agent.

## Files

- `policy.json` — the policy document (8 rules).
- `test/run.ts` — the behavior suite described above.
- `README.md` — this file.

See `../../PLAN.md` for the pack format definition and the full
Policy Packs catalog.
