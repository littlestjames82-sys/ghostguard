# GhostGuard Distribution
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Release](https://img.shields.io/github/v/release/littlestjames82-sys/ghostguard-distribution)](https://github.com/littlestjames82-sys/ghostguard-distribution/releases)

Five standalone plays that take GhostGuard to where agents already
run. Built Oct 10, 2026 and public at v0.1.0 — one runtime
dependency (the published `ghostguard` core package), Node ≥ 18, ESM.

Every suite runs against the **real** GhostGuard engine, imported
read-only from the sibling core checkout's built `dist/` (see the
repository layout note below). The core package is never modified.

| Folder | What it is | Suite |
|---|---|---|
| `github-action/` | Composite GitHub Action + gate script: a workflow step fails unless the trail records the required action allow/pre_approved (optionally + matching approval). Delivered as files + local simulation. | 9 cases |
| `redteam-bench/` | Versioned attack corpus (**v1**, 16 cases): injection-shaped + encrypted-looking payloads, hostile overlays, approval spoofs, classification spoofs, benign controls — asserting no attack executes a consequential action. | 16 cases |
| `policy-author/` | Controlled-English → GhostGuard `policy.json` + generated behavior tests from the same statements. Unsupported sentences error loudly, never silently drop. | 18 checks |
| `approval-channels/` | Ask-notifier: POSTs a pending ask to a generic webhook (generic/Slack/Discord/Telegram shapes) with escalation metadata and **timeout = deny** as a fail-closed decisions-JSONL entry. Tests hit a local stub server only. | 18 checks |
| `browser-lite/` | Single-file `ghostguard-lite.js`: classifyAction for DOM-ish actions, mini policy evaluator, record sink — with verdict parity vs the real engine on shared fixtures. | 30 checks |

## Verify everything
```sh
npm run verify   # 5 suites, 91 checks total
```

See `REPORT.md` for the full results and honest limits, and each
subfolder's `README.md` for its own details.

## Repository layout note

This add-on imports the GhostGuard core engine from the **published
`ghostguard` package** (`"ghostguard": "^0.1.0"` in `package.json`; nothing
in the core is modified). To run it, clone this repo and install:

```sh
git clone https://github.com/littlestjames82-sys/ghostguard-distribution
cd ghostguard-distribution && npm install && npm test
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
- [ghostguard-distribution](https://github.com/littlestjames82-sys/ghostguard-distribution) — GitHub Action gate, red-team bench, plain-English policy author, approval channels, and browser Lite *(this repo)*
- [ghostguard-services](https://github.com/littlestjames82-sys/ghostguard-services) — agent governance audit service pack and white-label audit portal prototype
- [policy-packs](https://github.com/littlestjames82-sys/policy-packs) — pre-written, behavior-tested governance policy packs for agent jobs

**Studio roadmap board:** [ghost-roadmaps](https://github.com/littlestjames82-sys/ghost-roadmaps) — the visual board showing where everything in the studio stands.

More from Ghost Developer Studio: [GhostBus](https://github.com/littlestjames82-sys/ghostbus) · [Ghost Hands](https://github.com/littlestjames82-sys/ghost-hands) · [Agent Seatbelt](https://github.com/littlestjames82-sys/agent-seatbelt) · [Ghost Bridge](https://github.com/littlestjames82-sys/ghost-bridge) · [Storefront](https://github.com/littlestjames82-sys/storefront)

## License

MIT — see `LICENSE`. Copyright (c) 2026 Ghost Developer Studio.
