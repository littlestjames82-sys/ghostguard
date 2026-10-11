# GhostGuard operator playbook

This is the short operational path for real deployments: the engine is already fail-closed, so the operational risk is mostly policy authoring and triage.

## 1. Keep the default path validated

Use `compileValidatedPolicy(policyDoc)` in every integration path that builds a policy at runtime. If you need warnings to be visible, pass `{ throwOnWarning: false }` and log them; if a warning is intentional, review it as a policy decision, not as a silent default.

Example:

```ts
const policy = compileValidatedPolicy(policyDoc, { throwOnWarning: false });
for (const d of policy.diagnostics) {
  if (d.level === "error") throw new Error(d.message);
  console.warn(d.message);
}
```

## 2. Treat validation failures as deployment blockers

The validated authoring path should fail on:

- duplicate IDs
- invalid expressions
- missing `handoff_to` for `hand_off`
- malformed policy documents
- broken restrictive rules that cannot be evaluated

Warnings should be reviewed, especially `when: "true"` allow rules. They are not always wrong, but they are the classic place where a permissive default escapes a review.

## 3. Triage denials with the record, not the engine

When a deny or ask lands:

- read `rule_id`
- read `reason`
- confirm `initiator` and `actor`
- confirm `permission_class`
- inspect the exact `action_payload`

This is the operator workflow the package is designed to support: the record tells you what happened and why, without re-deriving the policy from memory.

## 4. Use the validated path for migrations

If you currently call `compilePolicy()` directly, switch to `compileValidatedPolicy()` before any production rollout. The core semantics stay the same, but the validated path prevents invalid rule docs from reaching runtime.

## 5. Keep approvals and record-first ordering front and center

The deployment contract remains:

1. evaluate policy
2. assemble record
3. write record synchronously
4. flush recorder
5. execute only if the verdict is `allow` or `pre_approved`

This keeps the system understandable and auditable even when an effect fails or a process crashes.
