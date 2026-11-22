# GhostGuard Services
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Release](https://img.shields.io/github/v/release/littlestjames82-sys/ghostguard-services)](https://github.com/littlestjames82-sys/ghostguard-services/releases)

The service side of [GhostGuard](https://github.com/littlestjames82-sys/ghostguard)
— Ghost Developer Studio's governance layer for agents that act in the real
world. **All pricing in this repo is DRAFT. GhostGuard produces records and
gates effects; it certifies nothing, and neither do these services.**

By **Ghost Developer Studio**. MIT licensed.

## What's here

### `audit/` — Agent Governance Audit (service pack)

A fixed-scope audit engagement, packaged end-to-end:

- `SERVICE_SHEET.md` — what the audit is, the 5 fixed-scope steps
  (intake → action inventory/classification → GhostGuard policy simulation
  → report → walkthrough), deliverables, and what the client must provide.
- `INTAKE.md` — the exact intake instrument (with a hard rule: clients
  never send real secrets — type + length only).
- `REPORT_TEMPLATE.md` — the fill-in audit report skeleton, driven by a
  real simulation trail.
- A **worked example**: a fictional client (`example-report.md`, labelled
  FICTIONAL throughout) whose 17-action inventory was evaluated through
  the real GhostGuard engine by `generate-example-trail.mjs`, producing
  `example-trail.jsonl` and `example-summary.json` — every number in the
  example report is copied from that real output.

### `whitelabel/` — White-Label Audit Portal (prototype)

- `portal.html` — a single-file, no-server prototype of the trail /
  approvals view an agency can show its own clients under its own
  branding (agency name, logo text, accent color swappable via a small
  config or URL parameters), with a "Powered by GhostGuard" line kept.
  Demo state is the same fictional 17-record trail.
- `SPEC.md` — how this becomes the hosted Agency-tier feature:
  per-agency subdomains, client workspaces, real decision appends,
  approver identity, server-side redaction.

See `REPORT.md` for the build report and the list of decisions that remain
the studio's (pricing, any public listing, sending the sheet to a client).

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
- [ghostguard-services](https://github.com/littlestjames82-sys/ghostguard-services) — agent governance audit service pack and white-label audit portal prototype *(this repo)*
- [policy-packs](https://github.com/littlestjames82-sys/policy-packs) — pre-written, behavior-tested governance policy packs for agent jobs

**Studio roadmap board:** [ghost-roadmaps](https://github.com/littlestjames82-sys/ghost-roadmaps) — the visual board showing where everything in the studio stands.

More from Ghost Developer Studio: [GhostBus](https://github.com/littlestjames82-sys/ghostbus) · [Ghost Hands](https://github.com/littlestjames82-sys/ghost-hands) · [Agent Seatbelt](https://github.com/littlestjames82-sys/agent-seatbelt) · [Ghost Bridge](https://github.com/littlestjames82-sys/ghost-bridge) · [Storefront](https://github.com/littlestjames82-sys/storefront)

## License

MIT — see `LICENSE`. Copyright (c) 2026 Ghost Developer Studio.
