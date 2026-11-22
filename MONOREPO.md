# GhostGuard Monorepo

As of Nov 22, 2026, the GhostGuard family lives in this one repository.

## Layout

- **Root** — the GhostGuard core engine (`ghostguard`): record-first gateway,
  fail-closed policy, approvals and audit for any agent. Unchanged from the
  former standalone core repo.
- **packages/** — the add-ons, each in its own folder, byte-for-byte as they
  were in their own repos (including their own README, LICENSE, tests, and
  package.json, which already depend on the bare `ghostguard` package):

| Package | Files | What it is |
|---|---|---|
| `packages/ghostguard-mcp/` | 22 | GhostGuard MCP adapter — a governed MCP proxy: every upstream tools/call is classified, policy-decided, and recorded before it is forwarded. By Ghost Developer Studio. |
| `packages/ghostguard-budgets/` | 20 | GhostGuard add-on — stateful budgets/velocity rules and a kill switch on top of the stateless GhostGuard engine. By Ghost Developer Studio. |
| `packages/ghostguard-secrets/` | 20 | GhostGuard Secrets Broker — just-in-time secret injection for governed agent actions: the agent holds only a secret reference, the broker resolves and injects the value at execution, only after an allow verdict. By Ghost Developer Studio. |
| `packages/ghostguard-replay/` | 22 | GhostGuard Policy Replay/Backtest + Guard Score — re-evaluate a recorded GatewayRecord trail through a new policy and diff the verdicts, and compute a structural, explainable Guard Score from a trail. By Ghost Developer Studio. |
| `packages/ghostguard-plan/` | 18 | GhostGuard Plan Approval + Separation of Duties prototype — dry-run plans, hash-bound approvals, quorum for large spends. By Ghost Developer Studio. |
| `packages/ghostguard-reports/` | 22 | GhostGuard add-on toolset: agent passports (Ed25519-signed identity + tier gate), incident report generator (trail -> self-contained HTML), and the 'Guarded by GhostGuard' badge + redacted public trail summary. By Ghost Developer Studio. Standalone; imports the ghostguard engine dist, never modifies it. |
| `packages/ghostguard-voice/` | 17 | GhostGuard voice approval prototype — answer a pending GhostGuard ask with a recorded voice decision. Voice is the channel, NOT an identity proof: no voice-match/biometric verification is implemented. |
| `packages/ghostguard-distribution/` | 39 | GhostGuard distribution plays — local deliverables (GitHub Action gate, red-team bench, plain-English policy author, approval channels, browser Lite). Nothing published; all suites run against the real GhostGuard engine from the published ghostguard package. By Ghost Developer Studio. |
| `packages/ghostguard-services/` | 19 |  |
| `packages/policy-packs/` | 37 | Policy Packs for GhostGuard — tested governance rule sets for agent jobs. By Ghost Developer Studio. |

## Original repos

The former standalone repos (ghostguard-mcp, ghostguard-budgets,
ghostguard-secrets, ghostguard-replay, ghostguard-plan, ghostguard-reports,
ghostguard-voice, ghostguard-distribution, ghostguard-services,
policy-packs) are archived on GitHub (GitHub's Public archive banner is
the pointer; archived repos are read-only, so their descriptions could
not be updated after archiving). Their v0.1.0 releases stay attached to
those repos.

## Notes

- Each package's `.github/` folder is preserved for reference; only the
  workflows at this repo's root run on GitHub. Per-package npm publishing
  stays on the staged core-first sequence.
- Nothing in the core changed in this move: the root tree is identical to
  the pre-monorepo core repo, verified file by file before the push.

By Ghost Developer Studio.
