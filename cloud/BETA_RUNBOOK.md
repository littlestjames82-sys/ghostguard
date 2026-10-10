# GhostGuard Cloud — Beta Runbook (M3.2)

_Operator documentation for a FUTURE beta deployment. Nothing in
this runbook has been run against a real host: as of Oct 10, 2026
the Cloud server is a local skeleton, not deployed anywhere, and
the beta has not started. Standing the beta up — like choosing the
deploy route — is Ryan's separate decision. This document exists
so that, when that decision is taken, the deploy is a checklist
instead of an improvisation._

## 0. Preconditions (all Ryan's calls, none assumed)

- [ ] Deploy route picked (see §1).
- [ ] Beta cohort picked: 3–5 friendly users, no billing.
- [ ] Real keys generated (long random, per workspace + scope —
      see §3). Keys live in the host's secret store / env, never
      in the repo, never in chat.
- [ ] A backup location for the JSONL store chosen.

## 1. Deploy routes (free-first, per the Phase C plan)

The server is a zero-dependency Node process (`node
cloud/server.mjs`, Node ≥ 18) binding `127.0.0.1:8787` by default.
It does **not** terminate TLS — every route below puts something
in front of it that does.

**Route A — Ryan's PC + Cloudflare tunnel** (the GhostBus relay
pattern). Always free; up only while the PC is up.
1. On the PC: clone the repo, `npm ci`, `npm run build`.
2. Write the real env (from `cloud/.env.example`) into the
   process environment; write the scoped-key config (from
   `cloud/config.example.json`) outside the repo.
3. Start the server; confirm the boot line prints the expected
   workspace count.
4. Start `cloudflared tunnel` pointing at `127.0.0.1:8787`
   (named tunnel, not a quick tunnel, so the hostname is stable).
5. Run §2 health checks against the public hostname.

**Route B — Netlify + Turso free tier** (the Storefront pattern).
Always-on within free limits. Note honestly: the server today is
a long-lived Node process with a file store; this route needs the
store moved to Turso (Phase C item 1, not yet built) or a host
that runs the process as-is. Do not promise Route B until that
work exists — today, Route A is the deployable one.

## 2. Health checks (run after every start/restart)

```sh
curl -s https://<host>/health
# → {"ok":true,"service":"ghostguard-cloud","milestone":"M3.2"}

# Auth + ingest smoke (beta workspace key):
curl -s -X POST https://<host>/v1/records \
  -H "authorization: Bearer <ingest-key>" \
  -H "content-type: application/json" \
  -d '{"action_id":"smoke-1","verdict":"allow","project_id":"smoke"}'
# → 202 {"stored":1,...}

curl -s "https://<host>/v1/records?q=smoke-1" \
  -H "authorization: Bearer <read-key>"
# → the record, with a server-stamped received_at

# Bad key must be a 401:
curl -s -o /dev/null -w "%{http_code}\n" https://<host>/v1/records \
  -H "authorization: Bearer wrong"
# → 401
```

In the repo, `npm run verify` (which includes the 31-check cloud
e2e) is the pre-deploy gate: never deploy a tree where it is red.

## 3. Key management

- **Issue:** add an entry to the config file (`id`, `key`,
  `scopes`), restart the server. Give agents `ingest` + `read`
  only; give the human approver `read` + `decide`; keep `admin`
  on an operator key that is not used day-to-day.
- **Rotate:** add the NEW key alongside the old (both work),
  roll clients onto the new key, then remove the old entry and
  restart. No downtime, no shared-secret gap.
- **Revoke:** remove the entry and restart. Effective at restart;
  there is no hot-reload in the skeleton — plan revocations
  accordingly.
- **Legacy env keys** (`GHOSTGUARD_CLOUD_KEYS`) are full-scope.
  Acceptable for a solo beta; migrate to the config file before
  inviting anyone else.

## 4. Backups

- The store file (`GHOSTGUARD_CLOUD_STORE`) IS the audit trail.
  Copy it on a schedule (it's append-only JSONL — a plain file
  copy of a quiesced or live file is a valid backup; the server
  appends whole lines).
- Any workspace can also self-export: `GET /v1/export` with a
  read-scoped key returns its full trail as JSONL.
- Restore = put the file back and restart; the ingest dedupe
  index rebuilds from the file at boot.

## 5. Retention & workspace deletion (destructive — operator only)

- **Retention:** set `GHOSTGUARD_CLOUD_RETENTION_DAYS` and
  restart; entries older than the cutoff are compacted out at
  boot and the count is logged to stderr. Export first.
- **Delete a workspace:** `DELETE /v1/workspace` with an
  admin-scoped key purges that key's OWN workspace only, rewrites
  the store, and leaves a content-free `purge` tombstone entry.
  There is no undo.

## 6. Rollback

The server is stateless apart from the store file, so rollback is
a code swap, not a migration:

1. Stop the server.
2. Check out the previous known-good tree (the last one whose
   `npm run verify` was green).
3. Restore the store file from the pre-deploy backup IF the bad
   build wrote to it (a build that only read is safe to roll back
   without a store restore — when in doubt, restore).
4. Restart with the same env/config; re-run §2 health checks.
5. Tell the beta cohort what happened and for how long the trail
   gap is — the records are the product; a silent gap is the one
   unforgivable failure. (Agents' recorders keep undelivered
   records queued through an outage and re-flush idempotently,
   so a short outage should mean a delayed trail, not a lost one.)

## 7. Incident notes

- **Server down:** agents' `flush()` rejects and RETAINS queued
  records; `waitForDecision` times out fail-closed. Nothing
  approves itself while you're down. Restart, health-check, and
  agents re-flush.
- **Webhook failures:** recorded as `webhook` entries in the
  store (`ok:false`); decisions themselves never depend on them.
  Grep the store for `"entry_type":"webhook"` + `"ok":false`.
- **Corrupt store lines** are skipped at boot with a stderr
  count — if that count is ever non-zero, pull a backup and diff
  before trusting the trail.
- **Rate limiting** is per key (429 + `Retry-After`). A noisy
  agent gets throttled, not the whole workspace — unless it
  shares a key, which is why agents get their own keys.
