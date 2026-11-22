# GhostGuard Reports — Passports, Incident Reports, Badge
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Release](https://img.shields.io/github/v/release/littlestjames82-sys/ghostguard-reports)](https://github.com/littlestjames82-sys/ghostguard-reports/releases)

**Signed agent identity, human-readable incident evidence, and a public trust badge — for any agent behind GhostGuard.**

Three of the GhostGuard more-ideas, built as one standalone toolset (they share one trail loader and one redaction core):

- **#8 Agent Passports** — a signed identity per agent: who it is, who built it, what permission classes it may ever request, and its trust tier.
- **#9 Incident Report Generator** — a JSONL gateway trail becomes one self-contained HTML report: timeline, tallies, and every denial/ask with its deciding rule and exact (secret-redacted) payload.
- **#17 "Guarded by GhostGuard" Badge** — a small SVG badge plus a *tallies-only* public summary page an agent or agency can link: counts and rule statistics, no payloads, no actor names, ever.

By **Ghost Developer Studio**. Standalone add-on: it uses the GhostGuard engine from the published `ghostguard` package (read-only) for policy evaluation in the passport gate and fixture generation; it does not modify the core package. One runtime dependency (the core); Node ≥ 18. Public repository — v0.1.0.

```sh
npm run verify   # the full test suite (33 checks)
npm run demo     # synthetic end-to-end demo into out/
npm run fixture  # regenerate the synthetic fixture trail
```

## 1. Agent Passports

```sh
node src/cli.mjs keygen --out keys/
node src/cli.mjs issue --key keys/passport-private.pem \
  --agent research-bot --builder "Ghost Developer Studio" \
  --classes READ,WRITE_LOCAL,NETWORK_WRITE --tier new --out passport.json
node src/cli.mjs verify-passport --passport passport.json --pub keys/passport-public.pem
```

A passport document is `{ format: "ghostguard-passport/v1", passport: { agent_id, builder, allowed_classes, trust_tier, issued_at }, alg: "Ed25519", signature }`. The signature covers a canonical (key-sorted) rendering of the passport body; **changing any field — agent, builder, a single class, the tier, the date — invalidates it**, as does verifying against a different issuer's key.

**Why Ed25519, not HMAC:** a symmetric MAC makes every verifier a potential forger — whoever can check a passport could mint one. Passports are meant to be *shown* to other systems (a bus, a client portal, another gateway), so verification must not hand out signing power. Ed25519 is asymmetric, deterministic, and built into `node:crypto`. The issuer's private key stays with the issuer (the CLI writes it mode `0600`; `keys/` is gitignored).

### The tier gate (stricter-only)

`tightenDecision(decision, ctx, verifiedPassportBody)` takes a decision the **real GhostGuard engine** already made and returns the decision the gateway should act on:

| Situation | Result |
| --- | --- |
| No passport presented | `deny` (`passport:missing`) — fail-closed |
| Action class not in `allowed_classes` | `deny` (`passport:class-not-allowed`) |
| Tier `new`, class is NETWORK_WRITE or above, engine said allow/pre_approved | escalated to `ask` (`passport:tier-gate`) |
| Tier `established`, class is SPEND or DELETE, engine said allow/pre_approved | escalated to `ask` |
| Tier `trusted` | engine decision unchanged (class bounds still apply) |
| Anything else (ask / hand_off / deny) | unchanged |

It can never loosen: the returned verdict is always at least as strict as the engine's, for every tier × verdict × class combination — the test suite sweeps all of them. Earning a higher tier means the issuer signs a new passport; there is no self-promotion path.

## 2. Incident reports

```sh
node src/cli.mjs report --trail trail.jsonl --policy policy.json --out incident.html
# optional filters: --actor a,b  --verdict deny,ask  --project p  --from ISO  --to ISO
```

The loader accepts both trail shapes GhostGuard produces: plain JSONL gateway records (the reference recorder's format, optionally `received_at`-stamped as the Cloud list endpoint returns) and Cloud store entries (`{ entry_type: "record", … }`, unwrapped; decision entries skipped). A malformed line throws — a corrupt trail is loud, not silently truncated.

The report is **one HTML file, inline CSS, no external assets, no scripts**: summary tallies (by verdict / rule / class), the locked-rule hit count, a full timeline, and a detail card for every `deny` / `ask` / `hand_off` showing the deciding rule, the reason, the routing target, and the exact payload. Payload fields whose names look secret-ish (`token`, `password`, `api_key`, `secret`, `credential`, `auth`, …) are rendered as `[redacted: string, length 35]` — a secret was involved, its type and length, never its value. Records decided by a rule marked `locked: true` in the supplied `--policy` are highlighted as **LOCKED RULE HIT**s.

Time filters match the timestamp a record carries (`received_at`); records with no timestamp are excluded when a time bound is set — they cannot be shown to be in range.

Printed on the report itself, because it's true: *this is evidence assembled from the recorded trail, not a compliance certification.*

## 3. Badge + public summary

```sh
node src/cli.mjs badge --trail trail.jsonl --policy policy.json --out-dir out/
# writes out/badge.svg, out/summary.json, out/summary.html
```

`badge.svg` reads **"Guarded by GhostGuard — N actions recorded"** (studio violet `#6716f3`). `summary.json` / `summary.html` are the page the badge links to. Their redaction contract is the product: **tallies only** — total actions, counts by verdict, by deciding rule, by permission class, and the locked-rule hit count. No payloads or payload text, no actor names, no action or project ids, no timestamps. The tests assert the *absence* of every fixture payload string, actor name, and secret from all three public surfaces.

## Fixtures

Everything demo/test data here is **synthetic and labelled**: `fixture/trail.jsonl` is generated by `fixture/make-fixture.mjs`, which runs nine invented actions (fixture agents, `fixture.invalid` hosts) through the real GhostGuard engine over `fixture/policy.json` and writes them with the engine's own JSONL recorder. One payload carries an invented secret (`api_token`) purely so the tests can prove it never reaches the report. Expected tallies: 9 records — allow 3, pre_approved 1, ask 3, deny 2; locked-rule hits 2.

## Honest limits

- **A passport proves the issuer signed those fields — nothing more.** It does not prove the presenter *is* that agent (no key-binding / challenge-response in v1); pair it with your transport's authentication. Tier is an issuer claim, not a measurement.
- **The tier gate is a post-decision wrapper**, not new policy semantics: it composes with the engine by tightening its verdicts. Policies that need tier *inside* an expression should branch on fields the integrator stamps in the context instead.
- **Reports render what the trail holds.** If an integrator recorded a secret in a payload field with an innocent name, the name-based redaction will not catch it — the recorder contract's stance (redact before recording) still applies; this is the second net, not the first.
- **The badge count is operator-reported.** Until a public registry with signed summaries exists, the badge is a display of the operator's own trail tallies, not a third-party attestation.
- The JSONL trail is not a tamper-proof store (same stance as the core recorder); hash-chaining/signing the trail is future work, deliberately out of scope here.

## Layout

| File | What it is |
| --- | --- |
| `src/passport.mjs` | Key generation, issue/verify (Ed25519, canonical JSON), `tightenDecision` tier gate |
| `src/trail.mjs` | Trail loading (plain + Cloud-wrapped), filters, tallies, secret redaction |
| `src/report.mjs` | Self-contained incident-report HTML renderer |
| `src/summary.mjs` | Redacted summary object, badge SVG, summary HTML |
| `src/cli.mjs` | `keygen` / `issue` / `verify-passport` / `report` / `badge` / `demo` |
| `fixture/` | Synthetic policy + trail generator + generated trail |
| `test/run-tests.mjs` | 33 checks — `npm run verify` |

## Repository layout note

This add-on imports the GhostGuard core engine from the **published
`ghostguard` package** (`"ghostguard": "^0.1.0"` in `package.json`; nothing
in the core is modified). To run it, clone this repo and install:

```sh
git clone https://github.com/littlestjames82-sys/ghostguard-reports
cd ghostguard-reports && npm install && npm test
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
- [ghostguard-reports](https://github.com/littlestjames82-sys/ghostguard-reports) — Ed25519 agent passports, incident reports, and the Guarded-by-GhostGuard badge *(this repo)*
- [ghostguard-voice](https://github.com/littlestjames82-sys/ghostguard-voice) — voice approval prototype — a recorded, hash-bound voice decision on a pending ask
- [ghostguard-distribution](https://github.com/littlestjames82-sys/ghostguard-distribution) — GitHub Action gate, red-team bench, plain-English policy author, approval channels, and browser Lite
- [ghostguard-services](https://github.com/littlestjames82-sys/ghostguard-services) — agent governance audit service pack and white-label audit portal prototype
- [policy-packs](https://github.com/littlestjames82-sys/policy-packs) — pre-written, behavior-tested governance policy packs for agent jobs

**Studio roadmap board:** [ghost-roadmaps](https://github.com/littlestjames82-sys/ghost-roadmaps) — the visual board showing where everything in the studio stands.

More from Ghost Developer Studio: [GhostBus](https://github.com/littlestjames82-sys/ghostbus) · [Ghost Hands](https://github.com/littlestjames82-sys/ghost-hands) · [Agent Seatbelt](https://github.com/littlestjames82-sys/agent-seatbelt) · [Ghost Bridge](https://github.com/littlestjames82-sys/ghost-bridge) · [Storefront](https://github.com/littlestjames82-sys/storefront)

## License

MIT — see `LICENSE`. Copyright (c) 2026 Ghost Developer Studio.
