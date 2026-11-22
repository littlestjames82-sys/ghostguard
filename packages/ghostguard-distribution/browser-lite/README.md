# GhostGuard Lite — one file, in the page

`ghostguard-lite.js` is a single dependency-free JS file (no build
step) a page or browser agent includes directly:

```html
<script src="ghostguard-lite.js"></script>
<script>
  const gg = window.GhostGuardLite;
  const policy = gg.compilePolicy(policyJson);
  const { decision, record } = gg.evaluateAndRecord(policy, intent, myRecordSink);
  if (decision.verdict === "allow" || decision.verdict === "pre_approved") runIt();
</script>
```

It provides:
- **`classifyAction(action)`** — DOM-ish actions → PermissionClass:
  navigate/read → READ, fill/click → WRITE_LOCAL, submit →
  NETWORK_WRITE ("classify up"), send → COMMUNICATE, pay/buy →
  SPEND, delete → DELETE, deploy/publish, and `null` for unmapped
  (callers refuse those before policy, the gateway stance).
- **`compilePolicy` / `evaluatePolicy` / `mergePolicyDocs`** — the
  GhostGuard semantics for the supported expression subset:
  strictest tier wins, fail-closed, broken restrictive rules deny
  by name, broken permissive rules are inert, locked rules survive
  overlays.
- **`evaluateAndRecord(policy, intent, recordSink)`** — builds the
  gateway record and hands it to your sink *before* returning; a
  throwing sink stops the flow.

## Parity
`shared/cases.json` holds one policy + 12 action contexts (plus a
hostile-overlay case). The test runs every case through **both**
Lite and the real engine and requires identical
verdict / rule_id / handoff_to.

## Honest limits
Lite re-implements the semantics in miniature — the real engine in
the published `ghostguard` package is canonical. Parity is proven on the
shared fixture set, not on every possible policy; exotic
expressions outside the documented subset can diverge, and a
browser page is not a trust boundary (an agent that controls the
page controls Lite too — Lite is for honest agents that want a
guard, not for containing hostile code).
