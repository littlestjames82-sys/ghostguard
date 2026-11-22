# GhostGuard Budgets + Kill Switch — Build Report

_Built Oct 10, 2026 on Ryan's "Knock em out" (GhostGuard more-ideas
#1 stateful budgets/velocity + #4 kill switch, as ONE add-on).
Standalone package at `~/workspace/ghostguard-budgets/`. Nothing
published, pushed, or deployed; `private: true`. The GhostGuard core
at `~/workspace/ghostguard` and Ghost Hands were only read/imported
(built `dist/`), never modified. Zero runtime dependencies._

## What was built

- `src/guard.mjs` — `createStatefulGuard({ policy, config|configPath,
  statePath, freezePath, recorder, now })`. Decision flow: load state
  (failure → deny all, `state-store-unavailable`) → kill switch
  (frozen → deny every class except READ, rule `kill-switch-freeze`,
  re-read per decision) → stateless GhostGuard `evaluatePolicy` →
  stateful candidate from spend budgets + velocity rules, combined
  stricter-only by verdict rank → counted actions (final
  allow/pre_approved) appended + persisted before the decision
  returns (persist failure overrides to deny). Optional recorder
  emits the GhostGuard gateway record for every decision.
- `src/config.mjs` — config normalisation: duration parsing
  (`"24h"`, `windowMs`, …), scopes (`actor` / `project` /
  `actor_project` / `global`), fail-closed clamps (invalid
  `onExceed` → `deny` + warning; negative velocity cap → 0 + warning;
  unusable window/limit throws at load).
- `src/state.mjs` — JSON state store: strict load (missing = empty,
  corrupt/wrong-shape throws `StateStoreError`), atomic-ish save
  (temp file + rename), window pruning on counted writes.
- `src/freeze.mjs` — freeze flag: existence = frozen unless body is
  `{"frozen": false}`; unparseable/unreadable = frozen (fail closed);
  `freeze()` / `unfreeze()` / `readFreeze()`.
- `src/cli.mjs` — `freeze` / `unfreeze` / `status` commands
  (paths via flags or `GHOSTGUARD_FREEZE_FILE` /
  `GHOSTGUARD_BUDGETS_STATE` env; `status --config` reports
  per-budget used/remaining and velocity counts).
- `config.example.json` — daily spend cap (deny) + weekly project
  spend (ask) + third-delete-asks + write velocity cap.
- `README.md` — config format, semantics, failure behaviour, honest
  limits (single-node file state, freeze file is trusted-writer,
  amounts trusted as classified, not a compliance tool).

## Verification — exact commands and results

```sh
cd ~/workspace/ghostguard-budgets && npm test     # = npm run verify
```

**39 passed, 0 failed.** Groups:

- Budgets (8): under-cap allow, cumulative counting, over-cap deny
  (`daily-spend-cap`), denied spend not counted (==cap boundary
  allows), at-cap deny, `status()` used/remaining, per-actor scope
  isolation, window expiry frees budget (+25h, injected clock).
- Amount missing (1): SPEND with no numeric amount → `ask`
  (`daily-spend-cap`, cannot verify).
- Velocity (6): 1st/2nd DELETE allow, 3rd escalates allow→`ask`
  (`third-delete-asks`), asked action not counted, unrelated READ
  unaffected, window expiry resets count (+1h, injected clock).
- Stricter-only (4): huge budget cannot loosen a locked stateless
  `no-spend-ever` deny; stateless `ask` survives untouched; hostile
  `onExceed: "allow"` clamped to deny on a real decision; the clamp
  surfaces in `guard.warnings`.
- Kill switch (9): flow before freeze; freeze flipped mid-run denies
  the next SPEND (rule `kill-switch-freeze`), DELETE, COMMUNICATE;
  READ still allows while frozen; `status()` reports frozen + detail;
  unfreeze restores flow on the next action; `{"frozen": false}` file
  does not freeze; corrupt freeze file stays frozen (fail closed).
- Fail-closed state (3): corrupt JSON denies SPEND and even READ
  (`state-store-unavailable`); wrong-shape state (no events array)
  denies.
- Persistence + recorder (4): spend in one guard instance denies in a
  second instance on the same state file; state file on disk is valid
  JSON with the event; recorder trail holds both decisions with
  verdicts + deciding rule.
- CLI (4): `freeze` writes flag + reports, `status` reports frozen
  with by/reason, `unfreeze` removes flag, `status` after reports
  `frozen: false`.

Additional smoke (not in the suite): `node src/cli.mjs status
--config config.example.json` against temp paths printed the example
budgets/velocity windows correctly, and a programmatic decide through
the example config returned `allow` for a $42 spend with zero
warnings.

## Left undone / known limits (by design, see README)

- Single-node JSON file state — no cross-host/process-shared budget,
  no locking beyond atomic rename.
- `hand_off` as a stateful `onExceed` routes to a placeholder target
  `"owner"`; wiring real approver routing is the approvals layer's
  job, not this add-on's.
- No dashboard/UI for budgets or the kill switch — CLI + API only.
- Nothing published or priced; the core package and Ghost Hands are
  untouched.
