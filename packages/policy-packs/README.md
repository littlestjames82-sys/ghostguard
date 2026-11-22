# Policy Packs for GhostGuard
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Release](https://img.shields.io/github/v/release/littlestjames82-sys/policy-packs)](https://github.com/littlestjames82-sys/policy-packs/releases)

**Pre-written, behavior-tested governance rule sets for agent jobs** — in
GhostGuard's real policy format, each shipped with a test suite that proves
every rule fires as designed, run against the real GhostGuard engine, not a
description of it.

A policy *engine* is not a policy. Writing good rules is the hard part:
tier semantics (strictest verdict wins), fail-closed edges, locked
team-layer rules, initiator discipline. These packs are ours, already
written and proven, so an agent can post, shop, or triage an inbox safely
without its operator learning the policy language first.

By **Ghost Developer Studio**. Part of the
[GhostGuard](https://github.com/littlestjames82-sys/ghostguard) family.
MIT licensed. Pricing (in `PLAN.md`) is **DRAFT**.

## The catalog — 8 packs, 89 behavior checks, all green

| Pack | Governs | Locked "never" rules |
| --- | --- | --- |
| `packs/social-poster/` | An agent that reads, drafts, and posts to a social account | spending |
| `packs/inbox-assistant/` | An email/chat triage agent | deletes |
| `packs/shopping-agent/` | A purchasing/research agent (checkout asks, over-cap hands off) | subscriptions, gift cards |
| `packs/research-agent/` | A web-research agent | spend, delete |
| `packs/coding-agent/` | A coding agent (push/merge ask, deploy hands off) | secrets access, force-push, branch delete |
| `packs/agency-client-work/` | An agency agent working across client projects | cross-client data access |
| `packs/marketplace-seller/` | A marketplace seller agent | listing deletes, payout/bank changes |
| `packs/home-assistant/` | A home-assistant agent (non-owner initiators held stricter) | locks/security changes, recording deletes |

Each pack is a directory with exactly the same shape:

```
packs/<pack-name>/
  policy.json     the policy document — GhostGuard PolicyDoc format, data not code
  README.md       what it governs, the classification map, tuning knobs
  test/run.ts     behavior tests against the real engine
```

The same `policy.json` document is evaluated identically by the GhostGuard
engine (TypeScript) and by Agent Seatbelt's governor (Python) — one file
serves both runtimes.

## Running the tests

The suites import the GhostGuard engine source and run under the core
repo's `tsx`, so this repo expects the core as a sibling checkout — see
the layout note at the bottom of this README. Then:

```sh
npm test    # runs all eight pack suites in sequence
```

See `PLAN.md` for the pack format definition and `REPORT.md` for the
Oct 10, 2026 build report with per-pack results.

## Repository layout note

This add-on imports the GhostGuard core engine from the **published
`ghostguard` package** (`"ghostguard": "^0.1.0"` in `package.json`; nothing
in the core is modified). To run it, clone this repo and install:

```sh
git clone https://github.com/littlestjames82-sys/policy-packs
cd policy-packs && npm install && npm test
```

Part of the GhostGuard family by **Ghost Developer Studio**.

## The GhostGuard family

GhostGuard is built in public by **Ghost Developer Studio** as a family of small, single-purpose packages around one core engine:

- [ghostguard](https://github.com/littlestjames82-sys/ghostguard) — the core — record-first gateway, fail-closed policy, approvals, and audit for any agent
- [ghostguard-mcp](https://github.com/littlestjames82-sys/ghostguard-mcp) — governed MCP proxy — every `tools/call` is classified, decided, and recorded before it is forwarded
- [ghostguard-budgets](https://github.com/littlestjames82-sys/ghostguard-budgets) — stateful budgets, velocity rules, and a kill-switch freeze (stricter-only)
- [ghostguard-secrets](https://github.com/littlestjames82-sys/ghostguard-secrets) — just-in-time secrets broker — the agent never holds the raw key
- [ghostguard-replay](https://github.com/littlestjames82-sys/ghostguard-replay) — policy replay/backtest against a recorded trail, plus the Guard Score
- [ghostguard-plan](https://github.com/littlestjames82-sys/ghostguard-plan) — hash-bound plan approvals and separation of duties / quorum
- [ghostguard-reports](https://github.com/littlestjames82-sys/ghostguard-reports) — Ed25519 agent passports, incident reports, and the Guarded-by-GhostGuard badge
- [ghostguard-voice](https://github.com/littlestjames82-sys/ghostguard-voice) — voice approval prototype — a recorded, hash-bound voice decision on a pending ask
- [ghostguard-distribution](https://github.com/littlestjames82-sys/ghostguard-distribution) — GitHub Action gate, red-team bench, plain-English policy author, approval channels, and browser Lite
- [ghostguard-services](https://github.com/littlestjames82-sys/ghostguard-services) — agent governance audit service pack and white-label audit portal prototype
- [policy-packs](https://github.com/littlestjames82-sys/policy-packs) — pre-written, behavior-tested governance policy packs for agent jobs *(this repo)*

**Studio roadmap board:** [ghost-roadmaps](https://github.com/littlestjames82-sys/ghost-roadmaps) — the visual board showing where everything in the studio stands.

More from Ghost Developer Studio: [GhostBus](https://github.com/littlestjames82-sys/ghostbus) · [Ghost Hands](https://github.com/littlestjames82-sys/ghost-hands) · [Agent Seatbelt](https://github.com/littlestjames82-sys/agent-seatbelt) · [Ghost Bridge](https://github.com/littlestjames82-sys/ghost-bridge) · [Storefront](https://github.com/littlestjames82-sys/storefront)
