# GhostGuard Distribution — Build Report

_Built Oct 10, 2026 (Ghost Developer Studio). Ryan's instruction:
"Knock em out" (more-ideas items 10, 13, 14, 15, 16). Local
deliverables only — **nothing published, pushed, or deployed**;
no real webhook was ever called (approval-channel tests run
against a local stub server booted by the test itself)._

## What was built

New directory `~/workspace/ghostguard-distribution/` — Node ESM,
zero runtime dependencies, `private: true`, one subfolder per play.
All suites exercise the **real** GhostGuard engine, imported
read-only from `~/workspace/ghostguard/dist`. Neither
`~/workspace/ghostguard` nor `~/workspace/agent-seatbelt` was
modified (imports only).

### 1. github-action/ — CI gate as a composite Action (files only)
`action.yml` (composite: setup-node → `gate.mjs`) + `gate.mjs`
(zero-dep): given a trail JSONL and a required action_id, the step
PASSES only on a record with verdict allow/pre_approved — and, with
`--require-approval`, a matching `decision: "approve"` entry.
Accepts plain gateway records and Cloud `{entry_type}` lines;
fails closed on missing/denied/asked records and unreadable trails.
`simulate.mjs` runs the gate as a subprocess against 4 fixture
trails, exactly as the Action would.

### 2. redteam-bench/ — attack corpus v1
`cases.json` (16 cases, labelled corpus v1) + `policy.json` (locked
no-spend/no-delete, stranger-comms hand_off, ask rules) + `run.mjs`
against the real engine incl. `mergePolicyDocs` for hostile
overlays. Pass bar: verdict must not execute a consequential action
(deny/ask/hand_off pass; allow passes only for declared safe
classes — the 2 benign controls). Categories: injection-shaped
payloads (3), encrypted-looking payload (1), hostile overlays (4),
approval spoofs — payload-claimed initiator/approver, carried-flag
(3), classification spoofs incl. unmapped null class (3), benign
controls (2).

### 3. policy-author/ — plain-English policy author
`author.mjs` CLI (`build` / `verify`) + `GRAMMAR.md`: 7 statement
forms ("never allow spending", "always ask before deploying",
"owner must approve messages to strangers", "routines must ask
before …", "allow reading", "… is pre-approved", "<name> must
approve …") over a 9-class action vocabulary. Emits `policy.json`
+ `behavior-tests.json` generated from the same statements
(incl. negative tests and a fail-closed-default test);
`run-behavior-tests.mjs` runs them against the real engine.
Unsupported statements, unknown action phrases, duplicates, and
empty files are loud errors (exit 2, line named) — never a silent
drop.

### 4. approval-channels/ — ask-notifier with fail-closed timeout
`notify.mjs`: formats a pending ask/hand_off record and POSTs it to
a config webhook URL in generic / slack (`{text}`) / discord
(`{content}`) / telegram shapes. The message carries `asked_at`,
`escalate_after`, `timeout_at` and states **TIMEOUT = DENY** in the
text; `meta.on_timeout` is `"deny"`. `expireTimeouts()` appends a
DENY decision entry (approver `ghostguard-timeout`) to a decisions
JSONL for timed-out, undecided asks only — human-decided asks are
never overridden, re-runs never duplicate, and a timeout can never
write an approval. Dead webhooks fail loudly.

### 5. browser-lite/ — single-file in-page guard
`ghostguard-lite.js` (no build step, no deps, sets
`globalThis.GhostGuardLite`): `classifyAction` for DOM-ish actions
(navigate/read → READ, fill/click → WRITE_LOCAL, submit →
NETWORK_WRITE, send → COMMUNICATE, pay/buy → SPEND, delete →
DELETE, deploy/publish/execute; unmapped → null), a mini evaluator
for the policy expression subset with the engine's semantics
(strictest tier wins, fail-closed, broken-rule stances, locked
overlay merges), and `evaluateAndRecord` with a record sink
(record-first: a throwing sink stops the flow). `shared/cases.json`
runs 12 cases (+1 hostile overlay) through BOTH Lite and the real
engine requiring identical verdict / rule_id / handoff_to.

## Verification — exact commands and results

```sh
cd ~/workspace/ghostguard-distribution
npm run verify        # = node test/run-all.mjs (all five suites)
```

| Suite | Command (also run standalone) | Result |
|---|---|---|
| github-action | `node github-action/simulate.mjs` | **9 passed, 0 failed** (missing→fail, denied→fail, ask→fail, pre_approved→pass, allow→pass, require-approval without→fail, approved deploy→pass, decision-was-deny→fail, missing file→exit 2) |
| redteam-bench | `node redteam-bench/run.mjs` | **16/16 passed** — every attack denied/asked/handed off; locked rules held against all 4 hostile overlays; controls behaved |
| policy-author | `node policy-author/test/run-tests.mjs` | **18 passed, 0 failed** — incl. 10 generated behavior cases passing against the real engine via the shipped runner, and 5 loud-error cases |
| approval-channels | `node approval-channels/test/run-tests.mjs` | **18 passed, 0 failed** — local stub server only; formats, metadata, timeout-deny, idempotence, human-decision protection |
| browser-lite | `node browser-lite/test/run-tests.mjs` | **30 passed, 0 failed** — 12/12 parity cases identical to the real engine, 15 classifier cases, 3 record-sink checks |

**Top level: ALL 5 SUITES PASSED — 91 checks total, exit 0.**
(One cosmetic fix during the build: a red-team control-case note
initially said known-recipient comms "fails closed to ask"; the
engine actually falls to the no-match deny. The note was corrected
to match the engine, and the case's expected verdict set covers the
real outcome.)

## Honest limits

- **GitHub Action**: delivered as files + simulation only. It has
  never run inside GitHub Actions; the composite syntax follows the
  documented format but is unproven in a real workflow until Ryan
  chooses to copy it into a repo. The gate trusts the trail file
  it's given — it verifies a record exists, not that the trail is
  untampered.
- **Red-team bench**: proves engine verdicts under the bench policy
  and honest classifications. It cannot prove an integrator
  classified honestly, and payload-field rules cannot inspect a
  payload that is still opaque at decision time (class-level rules
  are the defence there — exactly what the encrypted-payload case
  shows). Corpus v1 is a starting set.
- **Policy author**: a controlled vocabulary, not NLP — 7 forms,
  9 classes, no amounts/fields/time windows. Richer policy still
  belongs in hand-written GhostGuard policy.
- **Approval channels**: a notifier + timeout writer, not an
  approvals surface; collecting the human's decision is the Cloud
  inbox / MCP approvals job. The telegram shape targets bot-API
  style relay webhooks. Webhook URLs in config are secrets.
- **Browser Lite**: re-implements the semantics in miniature; the
  real engine is canonical and parity is proven on the fixture set,
  not all possible policies. A web page is not a trust boundary —
  Lite guards honest agents, it does not contain hostile code.
- Nothing here changes any pricing, and nothing was published,
  pushed, or deployed — using any of it publicly is Ryan's
  separate call, as before.
