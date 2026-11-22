# GhostGuard Replay + Guard Score
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Release](https://img.shields.io/github/v/release/littlestjames82-sys/ghostguard-replay)](https://github.com/littlestjames82-sys/ghostguard-replay/releases)

**Backtest a policy change against a recorded trail before you activate it — and score the trail's governance shape, with the maths shown.**

Two CLIs built on the real GhostGuard engine, for anyone running
GhostGuard (or the GhostGuard MCP adapter, or any integration that
writes GatewayRecords):

- **Policy Replay / Backtest** (`ghostguard-replay`) — ideas-list #3:
  "run any recorded trail back through a *new* policy draft and diff
  the verdicts before activating it."
- **Guard Score** (`ghostguard-score`) — ideas-list #5: a per-trail
  structural score from countable properties of the trail, always
  reported with its per-component breakdown.

By **Ghost Developer Studio**. Standalone package: Node ≥ 18, ESM,
one runtime dependency. It imports the GhostGuard engine from the
published `ghostguard` package and never modifies the core. Public repository — v0.1.0.

## Quick start

```sh
npm test   # 17 checks, incl. CLI end-to-end

# Replay the sample trail against a tightened policy draft
node src/replay.mjs --trail fixtures/trail.sample.jsonl --policy fixtures/policy.tightened.json

# Score the sample trail (with the policy it was recorded under,
# so locked-rule hits can be measured)
node src/score.mjs --trail fixtures/trail.sample.jsonl --policy fixtures/policy.original.json
```

Both CLIs accept `--project <id>` (filter by `project_id`), `--json`
(machine report on stdout), and `--out <file>` (write the JSON report
to a file as well as printing). Exit codes: `0` clean; `1` malformed
trail lines were found (the report is still produced — see below);
`2` usage / IO / policy error.

## Policy Replay

Input: a JSONL trail of GatewayRecords (the format GhostGuard's
reference JSONL recorder writes) and a new policy document in
GhostGuard `PolicyDoc` format (`{ rules: [...] }`). Each record's
intent — kind, permission_class, actor, project_id, initiator, and the
exact recorded payload — is re-evaluated through the real engine
(`compilePolicy` / `evaluatePolicy`), and the new verdict is diffed
against the recorded one.

### Diff categories

Permissiveness ranks: `allow` 4 (executes unconditionally) >
`pre_approved` 3 (executes under a standing approval) > `ask` 2 >
`hand_off` 1 > `deny` 0 (never executes). A change is **tightened**
when the new verdict is less permissive, **loosened** when more.

| Category | Meaning |
| --- | --- |
| `unchanged` | Same verdict under the new policy. |
| `would-deny` | New verdict is `deny`; it wasn't before. |
| `would-handoff` | New verdict is `hand_off`; it wasn't before. |
| `would-ask` | New verdict is `ask`; it wasn't before. |
| `would-execute` | Was stopped (`deny` / `ask` / `hand_off`), would now run (`allow` / `pre_approved`). Always loosening. |
| `tightened-other` / `loosened-other` | Any other strictness change (e.g. `allow` → `pre_approved`, `deny` → `ask`). |

### Loosening is flagged loudly

Loosening is the dangerous direction: a draft that would have allowed
previously-denied actions can look innocuous as a diff count. The
report therefore carries a top-level `danger: true`, a separate
`loosened` total, the `looseningActionIds` list, and the human output
prints a `⚠⚠ LOOSENING WARNING` naming every loosened record with its
old/new verdicts and deciding rules. If your policy change loosens
anything, replay makes you look at exactly what.

### Honest limits of replay

- **The carried-approval flag is not in the record.** The
  GatewayRecord contract does not store the context's `approved`
  boolean, so replay uses a top-level boolean `approved` when a trail
  carries one and assumes `false` otherwise. Every report states this
  (`approvedAssumption`). A trail recorded from runs that carried
  approvals may replay stricter than reality for approval-sensitive
  rules.
- **Replay is stateless**, like the engine: it re-decides each action
  on its own recorded context. It does not model budgets, sequences,
  or what the agent would have done differently earlier in the run.
- Replay judges the *recorded payload*. If an integration classified
  or recorded an action wrongly, replay faithfully re-decides the
  wrong description — garbage trail, garbage backtest.

## Guard Score

A single number is only useful if you can see where it came from, so
the score is always reported as a breakdown: each component's weight,
ratio, points, and the raw counts behind the ratio. The score is
deterministic — same trail (+ same policy) in, same score out.

### Weights and formulas (as implemented in `src/score.mjs`)

| Component | Weight | Formula |
| --- | --- | --- |
| Completeness | 30 | Average over records of the fraction of 15 record checks passed (non-empty `action_id` / `kind` / `actor` / `project_id` / `reason`; valid `permission_class` / `initiator` / `verdict`; `rule_id`, `handoff_to`, `target_ref`, `snapshot_id`, `target` keys present with string-or-null values; `action_payload` an object; `dry_run` boolean). |
| Gate engagement | 20 | Share of records the gate engaged (`deny` + `ask` + `hand_off`). Sanity band: below 5% the ratio is `rate / 0.05` (a gate that never engages is suspect); 5%–50% scores 1.0; above 50% it declines linearly to 0 at 100% (a gate that stops almost everything is friction, not governance). |
| Locked-rule hits | 15 | Share of records decided by a `locked: true` rule of the supplied policy, saturating at 10% (`min(1, rate / 0.10)`) — a locked layer firing on 1 in 10 actions is demonstrably load-bearing. Requires `--policy` (the policy the trail was recorded under). If the supplied policy has **no** locked rules, this scores 0: the locked layer is absent. |
| Unattended strictness | 15 | Of records whose initiator is unattended (`routine`, `memory`, `system`, `handoff`), the fraction NOT waved through on a plain `allow` (`pre_approved` / `ask` / `hand_off` / `deny` all count as held). Vacuously 1.0 when a trail has no unattended records. |
| Hand_off routing | 10 | Of `hand_off` records, the fraction carrying a non-empty `handoff_to`. Not scored when a trail has no `hand_off` records (routing was never exercised). |
| Outcome tracking | 10 | Of decidable records (`ask` / `hand_off`), the fraction carrying an approval/outcome field (`approved`, `decision`, `outcome`, `executed`). Scored **only** when the trail carries such fields at all — the core GatewayRecord contract defines none, so a trail that never promised them is not punished for their absence; partial tracking, once started, is a real gap. |

Components that are not scored are excluded and the total is
**renormalised** over the scored weights (`score = earned / available
× 100`, one decimal). The breakdown always says which components were
excluded and why — a score out of 65 available points is labelled as
such, never silently presented as out of 100.

**Empty trail → score `null`, status `insufficient_data`.** An empty
trail is not a perfect trail, and this tool will not invent a number
for it.

### Honesty note

The Guard Score is **structural, not a certification**. It describes
the recorded shape of one trail under the published formulas above:
how completely actions were recorded, whether the gate engaged,
whether locked rules and unattended-run strictness show up, whether
hand-offs were routed, whether outcomes were tracked. It does **not**
measure whether the policy was *right*, whether the agent behaved
well in the world, or whether anything complies with anything — and
it must never be presented as a compliance or safety certification.
Approval *latency* is deliberately not scored: GatewayRecords carry
no timestamps, so there is nothing honest to measure it from.

## Malformed trails

Blank lines are ignored. Any other line that is not valid JSON, or
that parses but is not GatewayRecord-shaped (missing/invalid
`action_id`, `kind`, or `verdict`), is **reported with its line
number** in the report's `malformedLines` and on stderr — never
silently skipped — and the CLIs exit `1` after producing the report
over the valid records.

## Layout

| File | What it is |
| --- | --- |
| `src/trail.mjs` | Trail parsing/loading with per-line error reporting. |
| `src/replay.mjs` | Replay library + `ghostguard-replay` CLI. |
| `src/score.mjs` | Guard Score library (weights + formulas live here) + `ghostguard-score` CLI. |
| `fixtures/trail.sample.jsonl` | Synthetic, labelled 10-record trail with known properties (see the test file for the hand-computed expectations). |
| `fixtures/policy.original.json` | The policy the sample trail was recorded under (locked no-spend / no-delete). |
| `fixtures/policy.tightened.json` | Original + locked no-deploy + routine-reads-ask: flips exactly 2 records, loosens none. |
| `fixtures/policy.loosening.json` | An allow-everything draft: replay must flag it (7 loosened, 5 would-execute). |
| `fixtures/trail.malformed.jsonl` / `trail.empty.jsonl` | Error-reporting and insufficient-data fixtures. |
| `test/run-tests.mjs` | The suite — every expected number hand-computed from the fixtures. |

See `REPORT.md` for the build/verification record.

## The GhostGuard family

GhostGuard is built in public by **Ghost Developer Studio** as a family of small, single-purpose packages around one core engine:

- [ghostguard](https://github.com/littlestjames82-sys/ghostguard) — the core — record-first gateway, fail-closed policy, approvals, and audit for any agent
- [ghostguard-mcp](https://github.com/littlestjames82-sys/ghostguard-mcp) — governed MCP proxy — every `tools/call` is classified, decided, and recorded before it is forwarded
- [ghostguard-budgets](https://github.com/littlestjames82-sys/ghostguard-budgets) — stateful budgets, velocity rules, and a kill-switch freeze (stricter-only)
- [ghostguard-secrets](https://github.com/littlestjames82-sys/ghostguard-secrets) — just-in-time secrets broker — the agent never holds the raw key
- [ghostguard-replay](https://github.com/littlestjames82-sys/ghostguard-replay) — policy replay/backtest against a recorded trail, plus the Guard Score *(this repo)*
- [ghostguard-plan](https://github.com/littlestjames82-sys/ghostguard-plan) — hash-bound plan approvals and separation of duties / quorum
- [ghostguard-reports](https://github.com/littlestjames82-sys/ghostguard-reports) — Ed25519 agent passports, incident reports, and the Guarded-by-GhostGuard badge
- [ghostguard-voice](https://github.com/littlestjames82-sys/ghostguard-voice) — voice approval prototype — a recorded, hash-bound voice decision on a pending ask
- [ghostguard-distribution](https://github.com/littlestjames82-sys/ghostguard-distribution) — GitHub Action gate, red-team bench, plain-English policy author, approval channels, and browser Lite
- [ghostguard-services](https://github.com/littlestjames82-sys/ghostguard-services) — agent governance audit service pack and white-label audit portal prototype
- [policy-packs](https://github.com/littlestjames82-sys/policy-packs) — pre-written, behavior-tested governance policy packs for agent jobs

**Studio roadmap board:** [ghost-roadmaps](https://github.com/littlestjames82-sys/ghost-roadmaps) — the visual board showing where everything in the studio stands.

More from Ghost Developer Studio: [GhostBus](https://github.com/littlestjames82-sys/ghostbus) · [Ghost Hands](https://github.com/littlestjames82-sys/ghost-hands) · [Agent Seatbelt](https://github.com/littlestjames82-sys/agent-seatbelt) · [Ghost Bridge](https://github.com/littlestjames82-sys/ghost-bridge) · [Storefront](https://github.com/littlestjames82-sys/storefront)

## License

MIT — see `LICENSE`. Copyright (c) 2026 Ghost Developer Studio.
