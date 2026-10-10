# GhostGuard Phase B — Completion Report

_Built Oct 10, 2026, on Ryan's instruction "Knock em out dont publish."
Everything local and verified only: nothing published, nothing pushed,
nothing deployed, no pricing changed, and `ghostguard/package.json`
still carries `"private": true` (checked after the final verify run)._

## What was built

### 1. Bridge Spec v1 — `docs/bridge-spec-v1.md`

The Jev gate protocol formalised as the integration contract for any
runtime, written from the actual bridge code
(`integrations/jev/ghostguard-gate.mjs`), the gateway/policy sources,
and the M2 integration README — not invented:

- The one-request/one-reply shape: policy + optional overlay + audit
  path + carried-approval flag + gateway intent on stdin; the gateway
  record on stdout, exit 0, **only after** the record is appended to
  the audit (record-before-reply across the process boundary).
- Request/intent field tables with the gate's real validation rules
  (required string fields, `permission_class` string-or-null,
  `action_payload` must be an object, only contract fields cross into
  the record).
- Evaluation-context derivation (`payload = intent.action_payload`),
  the product field vocabulary vs host-native roots that resolve to
  null, verdict-handling table (allow / pre_approved / ask /
  hand_off / deny), and the fail-closed exit-code table (0 reply,
  1 unwritable record, 2 malformed request, any other failure = no
  record, no action).
- Locked-rule/overlay semantics from `mergePolicyDocs` (locked rules
  verbatim, overlay rules reusing a locked id dropped, non-locked
  rules replaceable, tier order beats document order) and both
  approval paths — carried flag and the "narrow the asker, scope the
  approval" overlay pattern M2 proved.
- `actor` vs `initiator` semantics: initiator is entry-point-stamped,
  never payload-sourced; `payload.initiator` is a different field.
- A host checklist and the conformance definition (§7 of the spec).

### 2. Shared conformance fixtures — `conformance/`

- `conformance/fixtures.json` — one policy document plus 12 action
  cases. The policy includes the locked `no-spend-ever` deny
  (`permission_class == 'SPEND'`), a `hand_off` to `owner` for
  COMMUNICATE, initiator branching (routine deploys ask, person
  deploys allow), a NETWORK_WRITE ask with a `!approved` clause,
  two standing approvals (fixture-host fills, docs writes), and
  read/carried-approval allows — with **no catch-all allow**, so the
  no-match case exercises the fail-closed default.
- Cases cover every verdict — allow (×3), pre_approved (×2), ask
  (×2), hand_off, deny (×2) — plus a payload-`initiator` spoof case
  (payload claims `routine`, stamped initiator `person` → still
  allowed) and a hostile-overlay case (overlay reuses the locked
  `no-spend-ever` id as allow, plus an allow-everything rule → still
  denied by the locked rule).
- `conformance/run.ts` — a TS runner that evaluates every case
  exactly as the bridge does (merge overlay → compile → evaluate
  over the intent-derived context → assemble the record) and asserts
  the shared fields: verdict, rule_id, handoff_to.
- Wired into the verify chain: new `test:conformance` script, and
  `npm run verify` is now build → typecheck → acceptance → build
  smoke → **conformance** → cloud e2e.

### 3. Ghost Hands GhostGuard backend — `~/workspace/ghost-hands/`

- New module `src/ghost_hands/ghostguard.py`:
  - `GhostGuardGovernor` — duck-type compatible with the native
    `Governor` (`classify` / `evaluate`, same signatures, returns the
    native `Decision`), so the Runner and MCP server can use it
    unchanged.
  - Native classification is preserved for the trail and mapped to
    GhostGuard classes: readonly → READ, write → WRITE_LOCAL,
    consequential → NETWORK_WRITE, with any non-readonly
    spend-smelling target upgraded to SPEND (a plain "Buy …" button
    is a native write but a gateway spend — the locked rule keys on
    the class).
  - `gate(intent, approved, policy_overlay)` — the Bridge Spec v1
    client: spawns `node <bridge>` with the JSON request, parses the
    record reply. Bridge path: `GHOST_HANDS_GHOSTGUARD_BRIDGE`, else
    the reference gate in the sibling GhostGuard checkout
    (`GHOSTGUARD_DIR` overridable). Base policy:
    `GHOST_HANDS_GHOSTGUARD_POLICY`, else the shared conformance
    policy itself — one policy document for the whole stack. Audit:
    `GHOST_HANDS_GHOSTGUARD_AUDIT`, appended by the bridge before it
    replies.
  - Verdict mapping: allow / pre_approved → allow; ask → ask (the
    Runner's approver flow takes it from there, as with the native
    governor); hand_off → deny with the routing target named (Ghost
    Hands has no second approver scope); deny → deny.
  - Fail-closed twice: `gate()` raises `GhostGuardBridgeError` on a
    missing bridge, non-zero exit, or unreadable reply;
    `evaluate()` converts that into a deny Decision, so a broken
    bridge never lets an action through the Runner.
  - `governor_from_env()` — `GHOST_HANDS_GOVERNOR_BACKEND=native`
    (default) or `ghostguard`, mirroring Jev's
    `JEV_GOVERNOR_BACKEND` stance; unknown values are a loud
    `HandsError`, never a silent fallback.
  - Exported from `ghost_hands/__init__.py`:
    `GhostGuardGovernor`, `GhostGuardBridgeError`,
    `governor_from_env`.
- New tests `tests/test_ghostguard_backend.py` (13 tests):
  - **Parity:** every conformance fixture case driven through
    `gate()` matches the fixture's verdict / rule_id / handoff_to;
    the locked no-spend case re-asserted on its own; records proven
    written to the bridge audit before `gate()` returns, in order.
  - **Native translation:** readonly navigate → allow, submit click
    → ask (network-writes-ask), "Buy gift card" click → deny via
    the SPEND upgrade (no-spend-ever), fixture-host fill →
    pre_approved.
  - **Fail-closed / selection:** missing bridge denies via
    `evaluate()` and raises via `gate()`; a directory as audit path
    denies; `governor_from_env` defaults native, selects ghostguard,
    rejects unknown backends.
  - Stack-dependent tests skip loudly if the sibling GhostGuard
    checkout is absent (a stack test, not a shipped-alone unit test).

## Test commands and results

GhostGuard (`~/workspace/ghostguard`):

- `npx tsx conformance/run.ts` — **12/12 fixture cases passed**.
- `npm run verify` (run twice) — **green end-to-end**: build clean,
  strict typecheck clean, **9/9 acceptance**, **3/3 build smoke**,
  **12/12 conformance** (new), **20/20 cloud e2e**. `private: true`
  confirmed still present in package.json afterwards.

Ghost Hands (`~/workspace/ghost-hands`, `.venv/bin/python -m pytest`):

- `tests/test_ghostguard_backend.py tests/test_governor.py` —
  initially 41 passed / 1 failed (the "Buy" button SPEND-upgrade
  gap described above; fixed in the mapping, not in the test).
- `tests/test_ghostguard_backend.py tests/test_governor.py
  tests/test_runner.py` — **54 passed**.
- Full suite `tests/` — **408 passed** (171s; includes the 13 new
  backend tests). No regressions.

## Left undone, with why

- **Phase B item 4 from the plan (GhostBus as approval transport)**
  was explicitly optional in the plan and not in this task's
  deliverables; not built.
- **No CLI/MCP flag wiring** in Ghost Hands beyond
  `governor_from_env()`: the MCP server and CLI construct their
  governors in several places with pack-based policies; switching
  those call sites to the env-selected backend is a behaviour change
  for existing users and was left for a follow-up so this round
  stays purely opt-in. Any caller can pass `GhostGuardGovernor()`
  (or `governor_from_env()`) to `Runner(governor=…)` today.
- **A long-lived bridge process** remains the known optimisation
  (one Node spawn per action, 261 ms median measured in M2); Bridge
  Spec v1 documents the cost instead of changing the protocol.
- **Jev itself was not modified** — its bridge and tests already pin
  the protocol the spec formalises.
