# Policy Packs — Build Report (Oct 10, 2026)

_Built on Ryan's "Knock em out". Nothing published, pushed, or
deployed. `~/workspace/ghostguard` was only read/imported — the packs
test against its real engine, never a fork. Pricing in PLAN.md is
unchanged and still DRAFT. The Social Poster pack is unchanged; its
suite was re-run as part of the full harness._

## Result

Eight packs, **89 behavior checks, all green** via the root harness
(`npm test` in `~/workspace/policy-packs`, now wired to run all eight
suites in sequence, exit 0 — re-run and confirmed by the coordinator
after the individual builders finished).

| Pack | Rules | Locked rules | Checks | Result |
| --- | --- | --- | --- | --- |
| social-poster (existing, unchanged) | 8 | `spend-never` | 11 | ✅ all 11 passed |
| inbox-assistant | 6 | `delete-never` | 11 | ✅ all 11 passed |
| shopping-agent | 6 | `gift-cards-never`, `subscriptions-never` | 11 | ✅ all 11 passed |
| research-agent | 6 | `spend-never`, `delete-never` | 11 | ✅ all 11 passed |
| coding-agent | 8 | `secrets-never`, `force-push-never`, `delete-never` | 11 | ✅ all 11 passed |
| agency-client-work | 6 | `cross-client-never` | 11 | ✅ all 11 passed |
| marketplace-seller | 7 | `delete-never`, `payout-never` | 11 | ✅ all 11 passed |
| home-assistant | 9 | `security-never`, `delete-never` | 12 | ✅ all 12 passed |

## Per-pack summary

- **Inbox Assistant** — reads/drafts allow (person + routine); plain
  sends ask and do *not* hand off; sends with attachments or external
  recipients hand off to owner; deletes deny via the locked rule;
  filter/rule/settings changes deny (`filters-and-settings-never`);
  DELETE carrying a send-shaped payload still denies (strictest wins).
- **Shopping Agent** — browse/search/cart allow; checkout asks at
  $120 and at exactly $500 (the bound is `>`); $501+ hands off to
  budget-owner; subscriptions and gift cards deny locked at any
  amount; a SPEND with no amount asks instead of error-denying
  (`SPEND && amount != null && amount > 500` three-part guard).
- **Research Agent** — fetch/search/download allow; form submits and
  account creation ask (NETWORK_WRITE); local-file uploads hand off
  to owner while remote-URL uploads only ask; SPEND and DELETE deny
  locked — a SPEND-classed upload denies, not hands off.
- **Coding Agent** — reads allow; local writes, commits, tests, and
  builds are `pre_approved` (asserted pre_approved, not allow);
  push and PR merge ask; deploy/publish hand off to owner; secrets
  access, force-push, and branch delete deny locked; unmapped
  EXECUTE kinds fail closed.
- **Agency Client Work** — in-project reads/writes allow; client
  comms hand off to owner; external file sends ask; spend asks;
  cross-client access denies locked — including a cross-client
  *send*, which denies instead of handing off (strictest wins).
  Matching/absent target projects don't misfire. DELETE is
  deliberately unmapped → fail-closed deny, documented and tested.
- **Marketplace Seller** — browsing own listings and drafting
  replies allow; message sends, offer sends, and price changes ask;
  listing deletes and payout/bank changes deny locked (a
  NETWORK_WRITE payout change proves the locked rule fired, not the
  fail-closed default). SPEND is deliberately unmapped → deny.
- **Home Assistant** — sensors/reads allow for all initiators;
  lights/media/thermostat `pre_approved` for the owner (`person`);
  the branch pair is proven: a routine doing the same actuation
  *asks*. Owner purchases ask, routine/memory purchases *deny*.
  Contact messages ask, non-contact (or unmarked-recipient) messages
  hand off to owner. Locks/alarms and recording deletes deny locked.
  `home.garage.open` is deliberately unmapped → fail-closed deny,
  documented in the README as the deliberate-gap example.

## Discipline checks (every new suite)

Each suite asserts, against the real engine: pack integrity (rule
count, zero compile errors, exact locked-id set); every headline
verdict in its README table; strictest-wins interactions; fail-closed
behavior on unknown kinds, unmapped classes, and malformed actions
(deny, `rule_id: null`); initiator branching where the pack specifies
it; payload-initiator spoof resistance; and that a hostile overlay
(replacing a locked rule's id with an allow + adding a catch-all
allow) cannot remove a locked deny or soften the pack's ask/hand_off
verdicts (via `mergePolicyDocs`).

## PLAN.md updates made

- Status line: eight packs built, nothing published, pricing DRAFT.
- Catalog: launch three marked built; four extended packs added
  (Coding Agent, Agency Client Work, Marketplace Seller, Home
  Assistant).
- Milestones: M1 marked done with the extended catalog noted;
  open decision 3 marked resolved (build-now). M2/M3 remain Ryan's
  calls. Pricing section untouched.

## Not done (by design / gates)

- No `loadPack()` helper or GhostGuard-repo catalog listing (M2) —
  that touches `~/workspace/ghostguard`, out of scope for this pass.
- No sales page, license terms, or launch (M3) — Ryan's gate.
- Root `npm test` runs the suites serially; each pack can also be run
  standalone with
  `../ghostguard/node_modules/.bin/tsx packs/<pack>/test/run.ts`.
