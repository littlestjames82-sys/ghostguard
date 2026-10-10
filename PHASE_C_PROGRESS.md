# GhostGuard Phase C (M3.2) — cloud beta-ready — progress

Started: Oct 10, 2026. Constraint for the whole pass: NOTHING published,
deployed, pushed, or made public. Local code + tests + docs only.

Baseline (Oct 10, before changes): `npm run verify` GREEN — build,
strict typecheck, 9/9 acceptance, 3/3 build smoke, conformance,
20/20 cloud e2e.

⚠ STATE NOTE: package.json on disk reads `"private": false` (v0.1.0),
not `private: true` as the task brief assumed — Ryan took the Phase A
publish gate earlier on Oct 10 (per main-agent context: "Publish
everything, add-ons too", GhostGuard repos public with v0.1.0
releases). This pass does NOT change the flag either way and makes no
publish/push/deploy action. No git repo exists in this tree.

## Gap audit — M3.x skeleton vs plan Phase C criteria

### Closable in this pass (local code/tests/docs only)
- [x] **Key management (plan C3):** skeleton has static full-power env
      keys only. Add: optional config file (env-pointed) with key ids,
      MULTIPLE keys per workspace (rotation overlap), per-key SCOPES
      (ingest / read / decide / admin), revoke = remove entry +
      restart (documented). Legacy GHOSTGUARD_CLOUD_KEYS unchanged
      semantics (full-scope).
- [x] **Push webhooks (plan C5):** decisions only long-poll today.
      Add outbound decision webhook per workspace (config file):
      POST decision JSON, HMAC-SHA256 signature header, single
      attempt, failure appended as a store entry, never blocks the
      decision response.
- [x] **Export + delete (plan C7):** add GET /v1/export (JSONL of the
      caller's workspace entries, read scope) and DELETE
      /v1/workspace (admin scope; purges ONLY the caller's
      workspace, leaves a content-free tombstone entry; the one
      deliberate non-append operation — documented).
- [x] **Retention (plan C7):** GHOSTGUARD_CLOUD_RETENTION_DAYS env;
      at boot, entries older than the cutoff are compacted out and
      the count is logged to stderr. Unset = keep forever.
- [x] **Rate limits (brief):** per-key sliding-window limit
      (env default + per-key override in config), 429 +
      Retry-After. Cap concurrent long-poll waiters (503 past cap).
- [x] **Size limits (brief):** body cap exists (1 MB). Add: max
      records per batch (env, default 500 → 400), field length caps
      (action_id/project_id ≤ 200, approver ≤ 100, q ≤ 200 → 400).
- [x] **Auth/token handling (brief):** compare SHA-256 digests with
      timingSafeEqual (kills key-length leak / early exit). Uniform
      401 for missing/bad key (already true — keep + test). 403 for
      authenticated-but-wrong-scope (no data in body).
- [x] **Error hygiene (brief):** catch-all currently returns raw
      err.message — fs errors could leak the store path. Fix: known
      statuses keep safe messages; 500 → generic "internal error",
      detail to stderr only. No stack traces in ANY response.
      X-Content-Type-Options + Cache-Control: no-store on /v1.
- [x] **Boot robustness:** a corrupt store line currently crashes
      loadStore with a stack. Skip corrupt lines, count to stderr.
      Invalid PORT → one-line startup error, exit 1, no stack.
- [x] **Config surface (brief):** all settings env-driven; add
      cloud/.env.example + cloud/config.example.json (placeholders
      only, no real secrets).
- [x] **Beta runbook (plan C4, docs only):** cloud/BETA_RUNBOOK.md —
      how a future deploy would be stood up (both free routes from
      the plan), health-checked, key-rotated, rolled back. Docs
      only; deploy route remains Ryan's gate.

### Deferred — documented, NOT built (need Ryan's gates / external services)
- **Store → SQLite/Turso (plan C1):** engine + deploy route are
  Ryan's Phase C gate #3; needs credentials/an external service.
  JSONL stays the engine for the beta skeleton; JSONL export added.
- **Real approver identity / magic-link accounts (plan C2):** needs
  an email provider + a deployment. Mitigated here: decide-scope
  keys separate from agent ingest keys; approver string remains
  self-reported — docs keep saying so, honestly.
- **Policy management UI (plan C6):** post-identity work; the inbox
  decides recorded asks, policy stays in the gateway/engine.
- **Deploy itself (plan C4):** Ryan picks the route; runbook only.

## Build log
- Baseline verify GREEN before changes (9/9 acceptance, 3/3 build
  smoke, 12/12 conformance, 20/20 cloud e2e).
- Rewrote `cloud/server.mjs` (M3.2): scoped config-file keys with
  ids + rotation overlap + revoke-by-removal, SHA-256 digest auth,
  per-key rate limiting (429 + Retry-After), long-poll waiter cap
  (503), batch cap (500) + verdict allowlist + field length caps,
  generic-500 error hygiene with nosniff/no-store headers, decision
  webhooks (HMAC-SHA256, outcome appended, never blocking),
  GET /v1/export, DELETE /v1/workspace (admin, purge + tombstone),
  GHOSTGUARD_CLOUD_RETENTION_DAYS boot compaction, corrupt-line
  boot tolerance, clean one-line startup errors. Legacy
  GHOSTGUARD_CLOUD_KEYS behavior unchanged (full-scope keys).
- Extended `cloud/test-cloud.mjs`: 11 new M3.2 checks (scopes 403
  matrix, rotation + uniform 401, rate limit, batch/field limits,
  error hygiene, signed webhook + recorded failure, export, purge
  + tombstone, retention + corrupt line, invalid-port startup).
- Docs: `cloud/BETA_RUNBOOK.md` (deploy routes as documentation,
  health checks, key management, backups, retention/delete,
  rollback, incidents), `cloud/.env.example`,
  `cloud/config.example.json` (placeholders only), README updated
  to M3.2 (API/scopes/auth/limits/honest-limits; deferred items —
  Turso store, magic-link identity, policy UI — still named as
  deferred, not silently dropped).
- FINAL VERIFY (run twice, both green end-to-end, exit 0):
  build clean, strict typecheck clean, **9/9 acceptance, 3/3
  build smoke, 12/12 conformance, 31/31 cloud e2e** (20 M3/M3.1 +
  11 new M3.2).
- Nothing-published confirmation: no git repo exists in this tree
  (nothing to push with), no deploy was run, no external calls
  were made (all tests are localhost; the only webhook targets
  were the test's own receiver and a dead loopback port).
  package.json was NOT modified by this pass — it reads
  `"private": false` as found (Ryan's Oct 10 Phase A publish
  decision), version still 0.1.0.
