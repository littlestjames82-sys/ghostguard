# GhostGuard Replay + Guard Score — Completion Report

_Built Oct 10, 2026, per Ryan's "Knock em out" on the GhostGuard
more-ideas list (items #3 Policy Replay/Backtest and #5 Guard Score).
Standalone package at `~/workspace/ghostguard-replay/`. Nothing
published, pushed, or deployed; no pricing changed;
`~/workspace/ghostguard` was only read/imported via its built `dist/`
(core untouched, its `private: true` confirmed still in place; this
package is also `private: true`, zero runtime dependencies)._

## What was built

- **Replay CLI** (`src/replay.mjs`, bin `ghostguard-replay`): loads a
  JSONL trail of GatewayRecords, rebuilds each record's engine context
  (kind, permission_class, actor, project_id, initiator, exact
  recorded payload; `approved` from a top-level boolean when present,
  else false — the record contract doesn't store it, and every report
  states that assumption), re-evaluates through the real GhostGuard
  engine (`compilePolicy`/`evaluatePolicy` from
  `../../ghostguard/dist/index.js`), and diffs old vs new verdict per
  record. Categories: `unchanged`, `would-deny`, `would-handoff`,
  `would-ask`, `would-execute`, `tightened-other`, `loosened-other`,
  assigned by a published permissiveness ranking
  (allow 4 > pre_approved 3 > ask 2 > hand_off 1 > deny 0). Output is
  a human summary and/or a machine JSON diff report (`--json`,
  `--out`), with `--project` filtering. **Loosening is flagged
  loudly**: top-level `danger: true`, separate loosened total,
  `looseningActionIds`, and a `⚠⚠ LOOSENING WARNING` block in human
  output naming every loosened record.
- **Guard Score CLI** (`src/score.mjs`, bin `ghostguard-score`):
  structural 0–100 over the same trail, weights published in code
  (`WEIGHTS`) and README — completeness 30, gate engagement 20
  (5%–50% sanity band), locked-rule hits 15 (needs `--policy`;
  saturates at 10% of records), unattended strictness 15, hand_off
  routing 10, outcome tracking 10. Always emits the per-component
  breakdown (weight × ratio = points, with raw counts). Components a
  trail can't support are marked not-scored, excluded, and the total
  renormalised over the scored weights — the report says which and
  why. **Empty trail → `score: null`, `insufficient_data`, never
  100.**
- **Shared trail loader** (`src/trail.mjs`): blank lines ignored;
  invalid-JSON and non-record lines reported with line numbers in
  `malformedLines` — never silently skipped; CLIs produce the report
  over the valid records and exit 1.
- **Fixtures** (all synthetic, labelled): 10-record sample trail with
  known properties (a04 carries a `decision` outcome field; a10 is a
  second project for filter tests), the policy it was recorded under
  (locked no-spend/no-delete), a tightened draft, an
  allow-everything loosening draft, a malformed trail, an empty
  trail.

## Verification (exact commands + results)

```sh
cd ~/workspace/ghostguard-replay && npm test        # = npm run verify
```

Result: **17 checks passed, 0 failed.** Every expected number was
hand-computed from the fixtures before running (arithmetic in the
test file's comments). Highlights:

1. **Self-consistency**: replaying the sample trail against the
   policy it was recorded under reproduces all 10 verdicts
   (10 unchanged).
2. **Tightened policy diff is exact**: adding locked `no-deploy-ever`
   flips a09 `pre_approved → deny` (would-deny 1) and
   `routine-reads-ask` flips a10 `allow → ask` (would-ask 1);
   8 unchanged, 0 loosened, `danger: false`.
3. **Loosening is flagged**: the allow-everything draft yields
   `danger: true`, 7 loosened, 5 would-execute (a04–a08), with the
   loosening action-id list asserted exactly.
4. **Guard Score matches hand computation**: completeness 1.0 (150/150
   checks), gate engagement 1.0 (5/10 gated, in band), locked hits
   1.0 (2 hits, saturates), unattended strictness 0.75 (3/4 held),
   hand_off routing 1.0, outcome tracking 1/3 → **89.6 / 100**.
   Without `--policy`, locked-rule hits are excluded and the score
   renormalises to **87.7** (74.5833 of 85) — asserted.
5. **Empty trail** → `score: null`, `insufficient_data`, exit 0.
6. **Malformed trail** → 1 valid record kept, errors reported for
   line 2 (invalid JSON) and line 3 (not a GatewayRecord), CLI exit 1
   with the errors inside the JSON report.
7. CLI end-to-end: `--json` parsing, `--project` filter (9 records,
   would-ask drops to 0), `--out` file writing (smoke-checked), and
   determinism (two replay runs produce deep-equal reports).

Demo outputs captured during the build: replay vs the loosening
draft prints the `⚠⚠ LOOSENING WARNING` header with 7 loosened / 5
would-execute; score on the sample fixture prints the full breakdown
ending at 89.6.

## Left undone (by design / honest limits)

- Replay cannot recover the original context's carried-approval flag
  (not in the GatewayRecord contract) — documented assumption, stated
  in every report.
- Replay is per-action stateless, like the engine: no sequence or
  budget simulation.
- Guard Score does not score approval latency — GatewayRecords carry
  no timestamps, so there is nothing honest to measure. The score is
  structural and is never presented as a certification (stated in
  README and in the CLI's own output).
- Cloud-store trails (GhostGuard Cloud's wrapped entry format) are
  not unwrapped by the loader; it reads plain GatewayRecord JSONL —
  the recorder format — as specified.
- No packaging/publishing step taken, per instructions.
