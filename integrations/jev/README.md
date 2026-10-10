# Jev × GhostGuard — the M2 integration

**Status: Milestone 2 done (Oct 7, 2026).** GhostGuard's first outside
consumer is a real one: the governed **Jev Ultrafast** browser agent.
With one environment switch, every action Jev's loop decides flows
through this package — policy evaluation by the shipped TypeScript
engine, the gateway record written by the package's own JSONL
recorder — *before* Jev executes anything. The local policy port in
Jev remains its default; GhostGuard is an opt-in backend that changes
nothing until selected.

```
Jev loop (Python)                GhostGuard (this package)
─────────────────                ──────────────────────────
decide action
  → governor.gate()
      classify (Jev-side)   ──▶   ghostguard-gate.mjs  (node, per action)
      build the intent            ├─ mergePolicyDocs(base, overlay?)
      spawn bridge ──────────────▶ ├─ compilePolicy + evaluatePolicy
                                  ├─ gatewayRecordFromDecision
                                  └─ createJsonlRecorder → audit JSONL
      record (stdout)      ◀─────  record JSON, exit 0 — only after
                                   the record is durably written
  → execute iff allow / pre_approved; ask/deny stop the run
```

Record-first holds across the process boundary: if the bridge is
missing, errors, or cannot write the audit record, it exits non-zero
with nothing on stdout, Jev's gate raises, and no action executes.

## Files

| File | Role |
|---|---|
| `ghostguard-gate.mjs` | The bridge. One JSON request on stdin → the gateway record on stdout. Imports the package's shipped `dist/` build, exactly as an npm consumer receives it. |
| `policy.jev-scenario.json` | The scenario policy (below), written in GhostGuard's field vocabulary. |
| `out/` (generated) | The scenario's audit JSONL + approval overlay, refreshed on every run. |
| Jev side: `jev_ultrafast/governor.py` | The `ghostguard` backend (`JEV_GOVERNOR_BACKEND`), beside the local port. |
| Jev side: `tests/test_ghostguard_bridge.py` | 6 offline contract tests for the backend. |
| Jev side: `scripts/ghostguard_scenario.py` | The end-to-end scenario runner (below). |

## The bridge protocol

Request (one JSON object on stdin):

```json
{
  "policy":         { "rules": [ … ] },
  "policy_overlay": { "rules": [ … ] } | null,
  "audit_path":     "…/audit.jsonl" | null,
  "approved":       false,
  "intent":         { "action_id": "e3", "kind": "jev.click",
                      "permission_class": "NETWORK_WRITE",
                      "actor": "jev", "initiator": "person",
                      "project_id": "",
                      "action_payload": { "label": "Find stays", … },
                      "target_ref": null, "snapshot_id": "…",
                      "target": { … }, "dry_run": false }
}
```

Response: the gateway record as one JSON line on stdout, exit 0 —
sent only after the record is appended to `audit_path` (when set).
Exit 1 = the record could not be written (nothing may execute);
exit 2 = the request itself was malformed. When `policy_overlay` is
present, the bridge folds it in with the package's real
`mergePolicyDocs` — locked base rules survive verbatim, and overlay
rules that reuse a locked rule's id are dropped.

Environment switches (Jev side):

```bash
JEV_GOVERNOR=on                    # the gate exists at all
JEV_GOVERNOR_BACKEND=ghostguard   # local (default) | ghostguard
JEV_GHOSTGUARD_BRIDGE=             # bridge path override; default: the
                                   # GhostGuard checkout beside Jev
JEV_GOVERNOR_POLICY=               # base policy JSON (either backend)
JEV_GOVERNOR_POLICY_OVERLAY=       # overlay JSON (bridge backend only)
JEV_GOVERNOR_LOG=                  # JSONL audit path (the bridge writes
                                   # it in this mode; Jev does not also
                                   # append — no double records)
```

## Translating between the two governors

Three facts shaped the integration; each is a lesson M2 feeds back
into this package's docs and examples.

**1. Policies for the bridge are written in GhostGuard's fields.**
Jev's in-repo port resolves extra context roots (`classification`,
`operation`, `role`, `label`, `host`) that the product engine does
not. Over the bridge, the same facts arrive as contract fields:
`permission_class` carries the classification (`classification ==
'read_only'` holds exactly when `permission_class == 'READ'`, so
Jev's default policy translates losslessly), and label/host travel
in `action_payload`. A policy written against Jev's native roots
will not error at the bridge — its roots resolve to `null` and its
rules silently never match — so bridge policies must use the
product vocabulary. (The scenario policy does; the parity test pins
both engines to identical verdicts on it.)

**2. An approval is an overlay, not a flag — and tier order rules it.**
Jev carries no approvals: an `ask` ends the run, and any approval
lands in a later run as amended policy (`JEV_GOVERNOR_POLICY_OVERLAY`,
merged by `mergePolicyDocs` inside the bridge). The sharp edge: an
overlay `pre_approved` rule **cannot** override a base `ask` rule —
`ask` is the stricter tier and strictest wins. A real approval
therefore *edits the asking rule* (the overlay replaces the
non-locked `submit-clicks-ask` with a narrowed version that excludes
the approved payload, then adds a scoped `pre_approved` rule). That
pattern — narrow the asker, scope the approval — is the documented
way to approve through policy overlays, and the scenario proves it
end-to-end.

**3. Locked rules are locked against the approver too.** The
scenario's overlay also carries a planted hostile rule reusing the
locked `no-spend-ever` id with effect `allow`. `mergePolicyDocs`
drops it; the purchase still denies by the locked rule's name. The
integration inherits the product's tamper story unchanged.

One deliberate shape difference: the JSONL audit in bridge mode
holds GhostGuard's **canonical** GatewayRecord (no Jev-specific
fields), while Jev's in-state record adds `classification` /
`classification_basis` so its inspector shows the same record the
local backend produces.

## The scenario (proof, not a mock)

`scripts/ghostguard_scenario.py` in the Jev repo drives Jev's real
loop through its own offline test harness (stub browser + stub text
helper — Jev's established proof standard; the loop, governor,
bridge, engine, and recorder are the shipped code). No network, no
external sites, no real submissions, no spend. Two runs over a
local fixture page (`fixture.test`):

| # | Action | Class | Verdict | Rule | Executed |
|---|---|---|---|---|---|
| 1 | click "Home" (link) | READ | allow | `allow-read-only` | yes |
| 2 | scroll results | READ | allow | `allow-read-only` | yes |
| 3 | fill "Destination" ← "Lisbon" | WRITE_LOCAL | pre_approved | `fixture-fills-standing-approval` | yes |
| 4 | click "Find stays" (submit) | NETWORK_WRITE | **ask** | `submit-clicks-ask` | **no — run stops** |
| — | *a human approves the recorded payload; the answer is written as a policy overlay (with the planted hostile rule inside)* | | | | |
| 5 | click "Find stays" | NETWORK_WRITE | pre_approved | `approved-submit` (overlay) | yes |
| 6 | click "Buy gift card" | NETWORK_WRITE | **deny** | `no-spend-ever` (locked) | **never** |

The audit (`out/jev-run-audit.jsonl`) holds exactly those six
records, in order, in the canonical shape; the scenario asserts
every row and exits non-zero on any mismatch.

**Cost, measured honestly:** the bridge spawns one node process per
action — the cross-runtime price Jev's design notes recorded when
this route was deferred. In the build sandbox, the verification
run measured a **261 ms median raw bridge round trip**, and gated
`act` steps averaged **262 ms** end-to-end in the loop. That is the
real number for this shape on this machine; a long-lived bridge
process is the obvious optimization if a deployment feels it, and
M2's job was to make the cost visible next to the guarantee.

## Run it

```bash
# GhostGuard side: engine, bridge contract, build — 9 checks
cd ghostguard && npm run verify

# Jev side: full suite (91 tests, 6 of them this integration)
cd jev-ultrafast && uv run pytest && uv run ruff check .

# The scenario itself (writes integrations/jev/out/)
cd jev-ultrafast && uv run python scripts/ghostguard_scenario.py
```

## What M2 leaves open

- The scenario runs on Jev's offline harness. The same backend
  drives a live Jev run unchanged (`JEV_GOVERNOR_BACKEND=ghostguard`
  on a real `uv run jev`) — that run needs a browser session and a
  decision model, so it is an operator's proof, not a CI one.
- Approvals today are policy overlays written by hand. A hosted
  approval surface is M3's subject (PLAN.md §6), and this
  integration is its first client shape.
- `project_id` is empty in Jev's intents — Jev has no project
  scope. Multi-project agents will exercise the field properly.
