# GhostGuard Reports — Build Report

_Built Oct 10, 2026 on Ryan's "Knock em out" for more-ideas #8 (Agent Passports), #9 (Incident Report Generator), and #17 ("Guarded by GhostGuard" badge). Standalone package at `~/workspace/ghostguard-reports/`. **Nothing published, pushed, or deployed; `private: true`. `~/workspace/ghostguard` was only read — its `dist/` imported for the real engine, its trail format followed; no core file was modified.** All fixture data is synthetic and labelled._

## What was built

- **Passports (`src/passport.mjs`)** — Ed25519 issuer keypairs via `node:crypto`; `issuePassport` (validates fields, refuses to mint an invalid passport), `verifyPassport` (canonical key-sorted JSON signature check; any field change, a flipped signature, or a wrong issuer key → invalid), and `tightenDecision`, the policy-context helper that composes with a real engine decision stricter-only: missing passport → deny, class outside `allowed_classes` → deny, tier escalation (`new`: NETWORK_WRITE+ escalates allow/pre_approved → ask; `established`: SPEND/DELETE → ask; `trusted`: unchanged). Ed25519-over-HMAC justification is in the README (asymmetric verification: checking a passport must not confer the power to mint one).
- **Trail core (`src/trail.mjs`)** — loader for plain JSONL gateway records and Cloud-store wrapped entries (decisions skipped, malformed lines throw), actor/verdict/project/time filters, tallies, locked-rule identification from a PolicyDoc, and name-based secret redaction to `[redacted: <type>, length <n>]`.
- **Incident report (`src/report.mjs`, CLI `report`)** — one self-contained HTML file (inline CSS, zero external assets/scripts): tallies, locked-hit count, full timeline with locked hits badged, and detail cards for every deny/ask/hand_off with deciding rule, reason, routing, and the exact payload (secrets redacted). Carries the honesty notice: evidence, not a compliance certification.
- **Badge + public summary (`src/summary.mjs`, CLI `badge`)** — shields-style SVG ("Guarded by GhostGuard — N actions recorded", studio violet), plus `summary.json`/`summary.html` under a tallies-only redaction contract: no payloads, no actor names, no action/project ids, no timestamps.
- **CLI (`src/cli.mjs`)** — `keygen`, `issue`, `verify-passport`, `report`, `badge`, `demo`.
- **Fixture (`fixture/`)** — `policy.json` (two locked rules) + `make-fixture.mjs`, which runs 9 synthetic actions through the real engine and its own JSONL recorder → `trail.jsonl` (allow 3, pre_approved 1, ask 3, deny 2; locked hits 2). One payload carries an invented, labelled fixture secret used only as the redaction canary.

## Verification

`npm run verify` (= `node test/run-tests.mjs`) — **33 passed, 0 failed**, covering every behaviour the task named:

- Passport verifies; tampering with **each** signed field (agent_id, builder, added class, raised tier, issued_at) is rejected; wrong-key and flipped-signature rejected; issuing an unknown class throws.
- Tier tightening **against the real ghostguard engine** (`compilePolicy`/`evaluatePolicy` from its dist): engine-allowed NETWORK_WRITE escalates to ask under `new`, not under `established`; SPEND escalates under `established`, not `trusted`; out-of-passport class denied under `trusted`; the locked engine deny (`no-spend-ever`) survives tightening unchanged; no passport → fail-closed deny; and a full sweep (3 tiers × 5 verdicts × 9 classes) proves tightening **never loosens**.
- Trail: fixture loads 9, tallies match, actor/time/verdict filters select exactly the expected records, Cloud-wrapped entries unwrap and decision entries skip.
- Report: contains the locked denials' rule ids (`no-spend-ever`, `no-delete-ever`) and the locked-hit highlight/count; the raw fixture secret string is **absent** while `[redacted: string, length N]` is present; non-secret payloads still render exactly; no external asset references.
- Badge/summary: tallies match (total 9, locked hits 2, badge reads "9 actions recorded"); for **each** public surface (summary JSON, summary HTML, badge SVG) the tests assert absence of both actor names, all payload text samples, the project id, an action id, and the fixture secret.
- CLI end-to-end in a temp dir: keygen → issue → verify-passport prints VALID; report and badge produce files with the right counts.

`npm run demo` also ran clean, producing `out/` artifacts from the fixture (demo passport verifies `true`; summary total 9, locked hits 2). The demo private key in `out/` is a throwaway fixture key, gitignored like all `*.pem`.

## Left undone (deliberate, stated in README "Honest limits")

- No passport key-binding / challenge-response: a passport proves issuer signature, not presenter identity — v1 scope.
- No signed/hash-chained trail, so badge counts are operator-reported tallies, not third-party attestation; a public registry remains the future step idea #17 names.
- Report redaction is field-name-based (the second net); the recorder contract's redact-before-recording stance remains primary.
