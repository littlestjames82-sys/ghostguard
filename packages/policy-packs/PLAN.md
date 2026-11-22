# Policy Packs — tested governance rule sets for agent jobs

**What this is.** GhostGuard (Ghost Developer Studio's policy engine for
agents) is free and small on purpose — but a policy *engine* is not a
policy. Writing good rules is the hard part: operators `&&`/`in`/
`startsWith`, tier semantics (strictest verdict wins), fail-closed
edges, locked team-layer rules, initiator discipline. Most developers
running an agent do not want to learn that language before their bot
can post, shop, or triage an inbox safely.

Policy Packs sell them ours: **pre-written, behavior-tested rule sets
for a specific agent job**, in GhostGuard's real policy format, each
shipped with a test suite that proves every rule fires as designed —
run against the real engine, not a description of it.

Status: Milestones 0–1 + extended catalog built — pack format defined,
all eight packs built and green (Oct 10, 2026). Nothing published;
pricing below is DRAFT.

## Pack format (the definition every pack follows)

A pack is a directory. Four parts, no more:

```
packs/<pack-name>/
  policy.json     the policy document — GhostGuard PolicyDoc format
  README.md       what it governs, install, tuning knobs
  test/
    run.ts        behavior tests: sample actions → expected verdicts,
                  executed against the customer's own GhostGuard engine
```

- **`policy.json` is data, not code.** It is exactly the
  `{ rules: [...] }` document `compilePolicy()` accepts — an `id`, an
  `effect` (`allow` / `pre_approved` / `ask` / `hand_off` / `deny`),
  a `when` expression in GhostGuard's CEL subset, an optional human
  `note` explaining intent, `handoff_to` for hand_off rules, and
  `locked: true` for the never-rules. Because it is the same document
  shape the GhostGuard engine (TypeScript) and the Agent Seatbelt
  governor (Python) both evaluate, one pack file serves both runtimes.
- **The classification map lives in the README.** GhostGuard decides
  over *classified* actions (`kind` + `permission_class`), so every
  pack documents how the target agent's action kinds map onto
  GhostGuard's `PermissionClass` vocabulary. The pack governs only
  what the map covers; anything unmapped falls to the fail-closed
  default — that is a feature, and the README says so out loud.
- **Tests are part of the product.** Each pack's suite imports the
  engine from the buyer's GhostGuard install (never a fork, never a
  vendored copy) and asserts: every headline behavior, the
  strictest-wins interactions, the fail-closed cases (unmapped and
  malformed actions deny), initiator branching (unattended runs held
  to the stricter standard), and that the pack's `locked` rules
  cannot be tuned away by an ordinary overlay policy.
- **Locked core convention.** Every pack ships a small set of
  `locked: true` rules — the "never" lines for that job (for Social
  Poster: spending). Locked rules are the layer a user's own edits
  cannot replace, weaken, or shadow; everything else in the pack is
  theirs to tune.

## Launch catalog

| Pack | Scope (one line) |
| --- | --- |
| **Social Poster** ✅ built | Governs an agent that reads, drafts, and posts to a social account: publishing asks, DMs hand off, deletes/settings/spend denied. |
| **Inbox Assistant** ✅ built | Governs an email/chat triage agent: reading and drafting replies free, sending asks, anything with attachments or external recipients hands off, deletes and rule/filter changes denied. |
| **Shopping Agent** ✅ built | Governs a purchasing/research agent: browsing and cart-building free, checkout asks with a payload amount bound, subscriptions and gift cards denied, spend above a cap hands off to a human with the budget. |
| **Research Agent** ✅ built | Governs a web-research agent: reading/fetching free, form submissions and account creation ask, uploads of local files hand off, anything classified SPEND or DELETE denied. |
| **Coding Agent** ✅ built | Governs a software dev agent: read/search free, local project writes + tests/builds pre-approved, git push + PR merge ask, deploy/publish hand off to owner, secrets access + force-push + branch deletion denied (locked). |
| **Agency Client Work** ✅ built | Governs an agency agent scoped to one client project per run: in-project reads/writes free, client comms hand off to the owner, sending files outside the project asks, spend asks, cross-client data access denied (locked). |
| **Marketplace Seller** ✅ built | Governs a seller's marketplace agent: browsing own listings and drafting replies free, sending messages/offers and price changes ask, deleting listings + payout/bank changes denied (locked). |
| **Home Assistant** ✅ built | Governs a home agent: sensors/reads free, lights/media/thermostat pre-approved for the owner, purchases ask, messages to non-contacts hand off, locks/security changes + deleting recordings denied (locked); non-owner initiators held stricter (unattended actuation asks, unattended purchases deny). |

## Pricing (DRAFT — placeholders for Ryan, not a price list)

- Per pack: **$49 one-time** (DRAFT) — includes the policy file, the
  behavior suite, and updates within the pack's major version.
- All-pack bundle: **$149 one-time** (DRAFT) — the four launch packs.
- Funnel pricing: packs are **free with any paid GhostGuard tier**
  if/when one exists (DRAFT) — the pack is the onboarding ramp, the
  hosted gateway/audit is the subscription.
- Custom pack (a studio engagement, not a download): priced per job
  (DRAFT, no number yet).

## Distribution

- **With GhostGuard:** packs ship alongside the GhostGuard package
  (a `packs/` catalog + a loader note in its README), so the engine's
  users meet the packs at install time.
- **Agent Seatbelt funnel:** Seatbelt (the free Python governor for
  browser agents) evaluates the same policy documents; the Research
  Agent pack is the natural Seatbelt companion and the top-of-funnel
  giveaway — a Seatbelt user who outgrows one pack is a GhostGuard +
  full-catalog customer.
- No marketplace, no DRM: packs are JSON + tests under the studio's
  license terms; the value is that they are *tested and maintained*,
  not that they are hard to copy.

## Milestones

- **M0 (done):** pack format defined; Social Poster pack built —
  policy file, README, behavior suite green against the real
  GhostGuard engine in `~/workspace/ghostguard`.
- **M1 (done, Oct 10, 2026):** the remaining three launch packs
  (Inbox Assistant, Shopping Agent, Research Agent) built to the same
  bar — same format, same test discipline, each green against the
  engine. The extended catalog was built in the same pass: Coding
  Agent, Agency Client Work, Marketplace Seller, and Home Assistant —
  eight packs total, 89 behavior checks, all green (see REPORT.md).
  The root `npm test` harness now runs all eight suites.
- **M2:** GhostGuard integration — catalog listing in the GhostGuard
  repo, a documented `loadPack()` path (read JSON → `compilePolicy`),
  and the Seatbelt funnel hook (Research Agent pack referenced from
  Seatbelt's README).
- **M3:** commercial launch — real pricing (Ryan's call), a sales
  page, license terms, and the update/support policy for pack
  revisions when platforms change their action surfaces.

## Open decisions for Ryan

1. Pricing: per-pack $49 / bundle $149 drafts — set real numbers, or
   hold packs as free-with-GhostGuard only.
2. License terms for packs (they are data + tests; MIT like the
   engine, or a commercial license despite the funnel argument).
3. ~~Whether M1's three packs are built now or Social Poster rides
   alone until GhostGuard/Seatbelt distribution exists.~~ Resolved
   Oct 10, 2026: all launch packs plus the four extended packs were
   built (Ryan: "Knock em out"). Distribution (M2/M3) is still
   Ryan's call; nothing is published.
