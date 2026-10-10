// GhostGuard Cloud — end-to-end test (Milestones 3 + 3.1).
// Run: npm run test:cloud   (builds first, so dist/ is current)
//
// Boots the real cloud server (cloud/server.mjs) as a child process
// on an ephemeral port with a temp JSONL store, then drives it
// through the package's real cloud recorder (dist build):
// records in → filters → inbox → a decision lands → inbox empties.
// M3.1 coverage: idempotent ingest, search + pagination, reporting,
// decision delivery (GET + waitForDecision, incl. its fail-closed
// timeout), server-stamped received_at, workspace isolation, and
// request hardening (413 / malformed-JSON 400). Plus the two
// failure modes that matter: a bad key gets a 401, and a flush
// against a dead server REJECTS with the records still queued —
// never a silent drop.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCloudRecorder } from "../dist/index.js";

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "server.mjs");
const KEY = "test-key-123";
const KEY_B = "other-key-456"; // second workspace, for isolation checks
const HOOK_SECRET = "test-hook-secret";
const dir = mkdtempSync(join(tmpdir(), "ghostguard-cloud-"));
const store = join(dir, "store.jsonl");

// ── M3.2 fixtures ────────────────────────────────────────────────
// A webhook receiver the test controls (raw body kept for HMAC
// verification), and a scoped-keys config file: ws-scoped gets one
// key per scope plus a rotation pair and a rate-limited reader;
// ws-deadhook gets a webhook pointing at a dead port.
const hookHits = [];
const hookServer = createHttpServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    hookHits.push({ headers: req.headers, raw });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
});
await new Promise((r) => hookServer.listen(0, "127.0.0.1", r));
const hookUrl = `http://127.0.0.1:${hookServer.address().port}/hook`;

const configPath = join(dir, "config.json");
writeFileSync(configPath, JSON.stringify({
  workspaces: {
    "ws-hook": {
      keys: [{ id: "main", key: "hook-key-12345" }],
      webhook: { url: hookUrl, secret: HOOK_SECRET },
    },
    "ws-scoped": {
      keys: [
        { id: "agent", key: "scoped-ingest-key", scopes: ["ingest"] },
        { id: "reader", key: "scoped-read-key", scopes: ["read"] },
        { id: "human", key: "scoped-decide-key", scopes: ["decide"] },
        { id: "ops", key: "scoped-admin-key", scopes: ["admin"] },
        { id: "rot-a", key: "scoped-rot-a-key" },
        { id: "rot-b", key: "scoped-rot-b-key" },
        { id: "rl", key: "scoped-rl-key", scopes: ["read"], rateLimit: 3 },
      ],
    },
    "ws-deadhook": {
      keys: [{ id: "main", key: "deadhook-key-1" }],
      webhook: { url: "http://127.0.0.1:1/hook", secret: "dead-secret" },
    },
  },
}));

const until = async (fn, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
};

const record = (action_id, verdict, over = {}) => ({
  action_id,
  kind: "comms.send",
  permission_class: "COMMUNICATE",
  actor: "cloud-test",
  initiator: "person",
  project_id: "proj-a",
  verdict,
  rule_id: verdict === "ask" ? "approval-required:COMMUNICATE" : null,
  reason: verdict === "ask" ? "COMMUNICATE actions ask by default" : "allowed",
  handoff_to: null,
  target_ref: null,
  snapshot_id: null,
  target: null,
  action_payload: { text: `payload for ${action_id}` },
  dry_run: false,
  ...over,
});

function bootServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [serverPath], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server did not start; output so far: ${out}`)), 15000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const m = /listening on http:\/\/[^:]+:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ child, baseUrl: `http://127.0.0.1:${m[1]}` });
      }
    });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}); output: ${out}`));
    });
  });
}

const api = async (baseUrl, path, { key = KEY, method = "GET", body } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

let child;
let baseUrl;
try {
  const booted = await bootServer({
    GHOSTGUARD_CLOUD_KEYS: `ws-test:${KEY},ws-other:${KEY_B}`,
    GHOSTGUARD_CLOUD_CONFIG_FILE: configPath,
    GHOSTGUARD_CLOUD_PORT: "0",
    GHOSTGUARD_CLOUD_STORE: store,
  });
  child = booted.child;
  baseUrl = booted.baseUrl;
} catch (err) {
  console.error(err);
  process.exit(1);
}

try {
  // /health answers without auth.
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  ok("server boots standalone; GET /health answers");

  // A bad key is refused on the API.
  const bad = await api(baseUrl, "/v1/records", { key: "wrong-key" });
  assert.equal(bad.status, 401);
  ok("bad API key gets 401");

  // Records go in through the real cloud recorder: one allow, one
  // ask. Queueing alone is not delivery — flush() is the delivery.
  const cloud = createCloudRecorder({ baseUrl, apiKey: KEY });
  cloud.recorder(record("act_allow", "allow"));
  cloud.recorder(record("act_ask", "ask"));
  assert.equal(cloud.pending(), 2, "records queue before flush");
  await cloud.flush();
  assert.equal(cloud.pending(), 0, "flush delivers the queue");
  ok("cloud recorder queues, then flush() delivers a batch through the real server");

  // Idempotent ingest: re-sending the same batch (the "connection
  // died after the store, before the reply" retry) stores nothing
  // twice — every record is counted as a duplicate and skipped.
  const retry = await api(baseUrl, "/v1/records", {
    method: "POST",
    body: [record("act_allow", "allow"), record("act_ask", "ask")],
  });
  assert.equal(retry.status, 202);
  assert.equal(retry.json.stored, 0, "a retried batch stores nothing new");
  assert.equal(retry.json.duplicates, 2, "both records report as duplicates");
  ok("idempotent ingest: a retried batch is duplicate-skipped, never double-stored");

  // The store on disk is append-only JSONL and holds both records.
  const lines = readFileSync(store, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).record.action_id, "act_ask");
  ok("server store is append-only JSONL, one entry per record");

  // Listing + filters.
  const all = await api(baseUrl, "/v1/records");
  assert.equal(all.json.records.length, 2);
  const asks = await api(baseUrl, "/v1/records?verdict=ask");
  assert.deepEqual(asks.json.records.map((r) => r.action_id), ["act_ask"]);
  const none = await api(baseUrl, "/v1/records?project_id=nope");
  assert.equal(none.json.records.length, 0);
  ok("GET /v1/records lists with project_id / verdict filters");

  // Search: q matches payload JSON and actor, case-insensitively.
  const byPayload = await api(baseUrl, "/v1/records?q=payload%20for%20act_ask");
  assert.deepEqual(byPayload.json.records.map((r) => r.action_id), ["act_ask"]);
  assert.equal(byPayload.json.total, 1);
  const byActor = await api(baseUrl, "/v1/records?q=CLOUD-TEST");
  assert.equal(byActor.json.total, 2, "q is case-insensitive over actor");
  // Pagination: limit/offset slice the matches; total counts them all.
  const page1 = await api(baseUrl, "/v1/records?limit=1");
  assert.equal(page1.json.records.length, 1);
  assert.equal(page1.json.total, 2);
  const page2 = await api(baseUrl, "/v1/records?limit=1&offset=1");
  assert.equal(page2.json.records.length, 1);
  assert.notEqual(page2.json.records[0].action_id, page1.json.records[0].action_id);
  // Every listed record carries the server-stamped received_at.
  assert.equal(typeof page1.json.records[0].received_at, "string");
  assert.ok(!Number.isNaN(Date.parse(page1.json.records[0].received_at)));
  ok("GET /v1/records supports q search and limit/offset pagination with a total");

  // Reporting: tallies over the trail + the pending count.
  const report = await api(baseUrl, "/v1/report");
  assert.equal(report.json.total_records, 2);
  assert.deepEqual(report.json.by_verdict, { allow: 1, ask: 1 });
  assert.equal(report.json.by_actor["cloud-test"], 2);
  assert.equal(report.json.by_rule["approval-required:COMMUNICATE"], 1);
  assert.equal(report.json.by_rule["(none)"], 1);
  assert.equal(report.json.pending, 1, "the undecided ask counts as pending");
  const scoped = await api(baseUrl, "/v1/report?project_id=nope");
  assert.equal(scoped.json.total_records, 0);
  assert.equal(scoped.json.pending, 0);
  ok("GET /v1/report tallies by verdict, rule, and actor, plus the pending count");

  // A malformed record is rejected, not stored.
  const malformed = await api(baseUrl, "/v1/records", {
    method: "POST",
    body: { verdict: "allow" },
  });
  assert.equal(malformed.status, 400);
  ok("POST /v1/records validates the record shape (action_id, verdict, project_id)");

  // The inbox holds exactly the pending ask.
  const inbox1 = await api(baseUrl, "/v1/inbox");
  assert.deepEqual(inbox1.json.pending.map((r) => r.action_id), ["act_ask"]);
  assert.equal(inbox1.json.pending[0].action_payload.text, "payload for act_ask");
  ok("GET /v1/inbox returns the pending ask with its ratification payload");

  // An approve decision lands as an appended entry; history stays.
  const decision = await api(baseUrl, "/v1/inbox/act_ask/decision", {
    method: "POST",
    body: { decision: "approve", approver: "ryan" },
  });
  assert.equal(decision.status, 200);
  const inbox2 = await api(baseUrl, "/v1/inbox");
  assert.equal(inbox2.json.pending.length, 0, "decided ask leaves the inbox");
  const after = await api(baseUrl, "/v1/records");
  assert.equal(after.json.records.length, 2, "the record itself is still in the audit trail");
  const trail = readFileSync(store, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(trail.length, 3);
  assert.equal(trail[2].entry_type, "decision");
  assert.equal(trail[2].decision, "approve");
  assert.equal(trail[2].approver, "ryan");
  assert.equal(trail[2].workspace, "ws-test");
  assert.equal(typeof trail[2].received_at, "string", "decisions are server-stamped too");
  assert.equal(typeof trail[2].decided_at, "string");
  ok("decision appends to the store (history never rewritten) and empties the inbox");

  // A second decision on the same action is a 404, not a rewrite.
  const again = await api(baseUrl, "/v1/inbox/act_ask/decision", {
    method: "POST",
    body: { decision: "deny", approver: "ryan" },
  });
  assert.equal(again.status, 404);
  ok("re-deciding a settled action 404s instead of rewriting history");

  // ── M3.1: decision delivery ──────────────────────────────────
  // Two fresh asks. act_ask3 stays pending (for the isolation
  // checks below); act_ask2 gets decided while an agent waits.
  cloud.recorder(record("act_ask2", "ask"));
  cloud.recorder(record("act_ask3", "ask"));
  await cloud.flush();

  // While pending, the decision endpoint is a 404 — not a leak,
  // not a guess.
  const pendingGet = await api(baseUrl, "/v1/inbox/act_ask3/decision");
  assert.equal(pendingGet.status, 404);
  assert.equal(pendingGet.json.pending, true);

  // The agent waits; the human denies; the SAME decision reaches
  // the agent through waitForDecision (server long-poll wakes it).
  const waiting = cloud.waitForDecision("act_ask2", { timeoutMs: 10000, pollMs: 50 });
  await new Promise((r) => setTimeout(r, 150));
  const decide2 = await api(baseUrl, "/v1/inbox/act_ask2/decision", {
    method: "POST",
    body: { decision: "deny", approver: "ryan" },
  });
  assert.equal(decide2.status, 200);
  const got = await waiting;
  assert.equal(got.action_id, "act_ask2");
  assert.equal(got.decision, "deny", "a deny resolves the wait too — it is not an approval");
  assert.equal(got.approver, "ryan");
  const decidedGet = await api(baseUrl, "/v1/inbox/act_ask2/decision");
  assert.equal(decidedGet.status, 200);
  assert.equal(decidedGet.json.decision, "deny");
  assert.equal(typeof decidedGet.json.received_at, "string");
  ok("decision delivery: GET returns the decision; waitForDecision resolves when it lands");

  // A wait that never gets a decision rejects — fail-closed.
  await assert.rejects(
    () => cloud.waitForDecision("act_ask3", { timeoutMs: 300, pollMs: 50 }),
    /no decision/i,
    "timeout must reject with a clear no-decision error",
  );
  ok("waitForDecision timeout rejects — no decision is never an approval");

  // ── M3.1: server-stamped times ────────────────────────────────
  // A client-supplied received_at is overwritten, never trusted.
  const stamped = await api(baseUrl, "/v1/records", {
    method: "POST",
    body: record("act_stamped", "allow", { received_at: "1999-01-01T00:00:00.000Z" }),
  });
  assert.equal(stamped.json.stored, 1);
  const gotStamped = await api(baseUrl, "/v1/records?q=act_stamped");
  assert.equal(gotStamped.json.total, 1);
  assert.notEqual(gotStamped.json.records[0].received_at, "1999-01-01T00:00:00.000Z");
  assert.ok(
    Math.abs(Date.now() - Date.parse(gotStamped.json.records[0].received_at)) < 60000,
    "received_at is stamped at ingest, not taken from the client",
  );
  ok("server stamps received_at at ingest; a client-supplied value is never trusted");

  // Mixed batch: the known record skips, the new one stores.
  const mixed = await api(baseUrl, "/v1/records", {
    method: "POST",
    body: [record("act_stamped", "allow"), record("act_new2", "allow")],
  });
  assert.equal(mixed.json.stored, 1);
  assert.equal(mixed.json.duplicates, 1);
  ok("mixed batch: new records store, duplicates skip — ingest is idempotent per record");

  // ── M3.1: workspace isolation ────────────────────────────────
  // ws-other's key sees NONE of ws-test's trail: no list, no
  // inbox, no decision read, no decide, no report — 404s, not leaks.
  const bList = await api(baseUrl, "/v1/records", { key: KEY_B });
  assert.equal(bList.json.total, 0);
  const bInbox = await api(baseUrl, "/v1/inbox", { key: KEY_B });
  assert.equal(bInbox.json.pending.length, 0);
  const bGetDecision = await api(baseUrl, "/v1/inbox/act_ask3/decision", { key: KEY_B });
  assert.equal(bGetDecision.status, 404, "cross-workspace decision read is a 404");
  const bDecide = await api(baseUrl, "/v1/inbox/act_ask3/decision", {
    key: KEY_B,
    method: "POST",
    body: { decision: "approve", approver: "mallory" },
  });
  assert.equal(bDecide.status, 404, "cross-workspace decide is a 404");
  const bReport = await api(baseUrl, "/v1/report", { key: KEY_B });
  assert.equal(bReport.json.total_records, 0);
  assert.equal(bReport.json.pending, 0);
  const aInbox = await api(baseUrl, "/v1/inbox");
  assert.deepEqual(
    aInbox.json.pending.map((r) => r.action_id),
    ["act_ask3"],
    "A's pending ask is untouched by B's attempts",
  );
  ok("workspace isolation: B cannot list, read, decide, or report on A's records");

  // The dedupe index is scoped by (workspace, action_id): B can
  // store its OWN record under an action_id A already used.
  const bPost = await api(baseUrl, "/v1/records", {
    key: KEY_B,
    method: "POST",
    body: record("act_allow", "allow", { project_id: "proj-b", actor: "other-actor" }),
  });
  assert.equal(bPost.json.stored, 1, "same action_id in another workspace is not a duplicate");
  const bList2 = await api(baseUrl, "/v1/records", { key: KEY_B });
  assert.equal(bList2.json.total, 1);
  const aList = await api(baseUrl, "/v1/records");
  assert.equal(aList.json.total, 6, "A's trail is unchanged by B's ingest");
  assert.ok(!aList.json.records.some((r) => r.actor === "other-actor"));
  ok("dedupe is scoped by (workspace, action_id), not action_id alone");

  // ── M3.1: request hardening ──────────────────────────────────
  const authHeaders = {
    "content-type": "application/json",
    authorization: `Bearer ${KEY}`,
  };
  const big = await fetch(`${baseUrl}/v1/records`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(
      record("act_big", "allow", { action_payload: { text: "x".repeat(1_100_000) } }),
    ),
  });
  assert.equal(big.status, 413, "a body over the 1 MB cap is refused");
  await big.text(); // drain
  const garbled = await fetch(`${baseUrl}/v1/records`, {
    method: "POST",
    headers: authHeaders,
    body: "{not json",
  });
  assert.equal(garbled.status, 400, "malformed JSON is a 400, not a 500");
  await garbled.text(); // drain
  ok("request hardening: oversized body → 413, malformed JSON → 400");

  // ── M3.2: scoped keys ────────────────────────────────────────
  // One key per scope in ws-scoped: each scope reaches exactly
  // its own surface — everything else is a 403 with no data.
  const INGEST = "scoped-ingest-key";
  const READ = "scoped-read-key";
  const DECIDE = "scoped-decide-key";
  const ADMIN = "scoped-admin-key";
  const scopedPost = await api(baseUrl, "/v1/records", {
    key: INGEST,
    method: "POST",
    body: record("scoped_ask", "ask", { project_id: "proj-s" }),
  });
  assert.equal(scopedPost.status, 202, "ingest scope can post records");
  assert.equal((await api(baseUrl, "/v1/records", { key: INGEST })).status, 403);
  assert.equal((await api(baseUrl, "/v1/inbox", { key: READ })).json.pending.length, 1);
  assert.equal(
    (await api(baseUrl, "/v1/records", { key: READ, method: "POST", body: record("x1", "allow") })).status,
    403,
    "read scope cannot ingest",
  );
  assert.equal(
    (await api(baseUrl, "/v1/inbox/scoped_ask/decision", { key: INGEST, method: "POST", body: { decision: "approve", approver: "a" } })).status,
    403,
    "ingest scope cannot decide",
  );
  assert.equal(
    (await api(baseUrl, "/v1/records", { key: DECIDE })).status,
    403,
    "decide scope cannot read the trail",
  );
  const scopedDecision = await api(baseUrl, "/v1/inbox/scoped_ask/decision", {
    key: DECIDE,
    method: "POST",
    body: { decision: "approve", approver: "sam" },
  });
  assert.equal(scopedDecision.status, 200, "decide scope can decide");
  const forbidden = await api(baseUrl, "/v1/records", { key: INGEST });
  assert.deepEqual(Object.keys(forbidden.json), ["error"], "a 403 body carries no data");
  ok("scoped keys: ingest / read / decide each reach only their own surface (403 elsewhere)");

  // Rotation: two full keys for one workspace are both live at
  // once (that's what makes rotation without downtime possible);
  // a key that is not configured is a plain 401 — the same body
  // as a missing header, so the response is no oracle.
  assert.equal((await api(baseUrl, "/v1/records", { key: "scoped-rot-a-key" })).status, 200);
  assert.equal((await api(baseUrl, "/v1/records", { key: "scoped-rot-b-key" })).status, 200);
  const unknownKey = await api(baseUrl, "/v1/records", { key: "scoped-rot-c-key" });
  assert.equal(unknownKey.status, 401);
  const noKeyRes = await fetch(`${baseUrl}/v1/records`);
  assert.equal(noKeyRes.status, 401);
  assert.deepEqual(await noKeyRes.json(), unknownKey.json, "missing and wrong keys are indistinguishable");
  ok("key rotation: overlapping keys both authenticate; unknown/missing keys share one 401");

  // Rate limit: the rl key allows 3 requests/minute — the 4th is
  // a 429 carrying Retry-After.
  for (let i = 0; i < 3; i++) {
    assert.equal((await api(baseUrl, "/v1/records", { key: "scoped-rl-key" })).status, 200);
  }
  const limited = await fetch(`${baseUrl}/v1/records`, {
    headers: { authorization: "Bearer scoped-rl-key" },
  });
  assert.equal(limited.status, 429, "the request past the per-key limit is refused");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1, "429 carries Retry-After");
  await limited.text();
  ok("per-key rate limiting: past the limit → 429 + Retry-After");

  // Batch + field limits, on top of the 1 MB body cap.
  const bigBatch = await api(baseUrl, "/v1/records", {
    key: INGEST,
    method: "POST",
    body: Array.from({ length: 501 }, (_, i) => record(`bulk_${i}`, "allow")),
  });
  assert.equal(bigBatch.status, 400, "a batch over the max-records cap is refused");
  const longId = await api(baseUrl, "/v1/records", {
    key: INGEST,
    method: "POST",
    body: record("x".repeat(201), "allow"),
  });
  assert.equal(longId.status, 400, "an over-length action_id is refused");
  const badVerdict = await api(baseUrl, "/v1/records", {
    key: INGEST,
    method: "POST",
    body: record("act_badverdict", "maybe"),
  });
  assert.equal(badVerdict.status, 400, "an unknown verdict is refused");
  const longApprover = await api(baseUrl, "/v1/inbox/scoped_ask/decision", {
    key: DECIDE,
    method: "POST",
    body: { decision: "deny", approver: "a".repeat(101) },
  });
  assert.equal(longApprover.status, 400, "an over-length approver is refused");
  const longQuery = await api(baseUrl, `/v1/records?q=${"q".repeat(201)}`, { key: READ });
  assert.equal(longQuery.status, 400, "an over-length search query is refused");
  ok("size limits: batch cap, id/verdict/approver/query validation all refuse with 400");

  // Error hygiene: error bodies carry no stack trace, no store
  // path, no key material; hardening headers are present.
  const garbledRes = await fetch(`${baseUrl}/v1/records`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: "{not json",
  });
  const garbledBody = await garbledRes.text();
  assert.equal(garbledRes.status, 400);
  assert.ok(!garbledBody.includes("node:"), "no stack frames in error bodies");
  assert.ok(!garbledBody.includes(store), "no filesystem paths in error bodies");
  assert.ok(!garbledBody.includes(KEY), "no key material in error bodies");
  assert.equal(garbledRes.headers.get("x-content-type-options"), "nosniff");
  assert.equal(garbledRes.headers.get("cache-control"), "no-store");
  const notFound = await api(baseUrl, "/v1/nope");
  assert.deepEqual(notFound.json, { error: "not found" });
  ok("error hygiene: stable safe messages, no stacks/paths/keys, nosniff + no-store headers");

  // ── M3.2: decision webhooks (push) ───────────────────────────
  // ws-hook has a webhook at the test receiver: deciding its ask
  // POSTs the decision, HMAC-signed over the exact body bytes,
  // and the delivery outcome is appended to the store.
  const HOOK_KEY = "hook-key-12345";
  const hookPost = await api(baseUrl, "/v1/records", {
    key: HOOK_KEY,
    method: "POST",
    body: record("hook_ask", "ask", { project_id: "proj-h" }),
  });
  assert.equal(hookPost.json.stored, 1);
  const hookDecide = await api(baseUrl, "/v1/inbox/hook_ask/decision", {
    key: HOOK_KEY,
    method: "POST",
    body: { decision: "approve", approver: "ryan" },
  });
  assert.equal(hookDecide.status, 200);
  const hit = await until(() => hookHits.find((h) => h.raw.includes("hook_ask")));
  assert.ok(hit, "the webhook fired after the decision");
  const expectedSig =
    "sha256=" + createHmac("sha256", HOOK_SECRET).update(hit.raw, "utf8").digest("hex");
  assert.equal(hit.headers["x-ghostguard-signature"], expectedSig, "webhook is HMAC-SHA256 signed");
  const hookPayload = JSON.parse(hit.raw);
  assert.equal(hookPayload.event, "decision");
  assert.equal(hookPayload.decision, "approve");
  assert.equal(hookPayload.workspace, "ws-hook");
  const hookEntry = await until(() => {
    const lines = readFileSync(store, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    return lines.find((e) => e.entry_type === "webhook" && e.workspace === "ws-hook");
  });
  assert.ok(hookEntry, "the delivery outcome is appended to the store");
  assert.equal(hookEntry.ok, true);
  assert.equal(hookEntry.status, 200);
  ok("decision webhook: signed push lands, outcome recorded in the trail");

  // A dead webhook endpoint never blocks or fails the decision —
  // the failure is what's recorded instead.
  const DEAD_KEY = "deadhook-key-1";
  await api(baseUrl, "/v1/records", {
    key: DEAD_KEY,
    method: "POST",
    body: record("dead_ask", "ask", { project_id: "proj-d" }),
  });
  const deadDecide = await api(baseUrl, "/v1/inbox/dead_ask/decision", {
    key: DEAD_KEY,
    method: "POST",
    body: { decision: "deny", approver: "ryan" },
  });
  assert.equal(deadDecide.status, 200, "the decision succeeds despite the dead webhook");
  const deadEntry = await until(() => {
    const lines = readFileSync(store, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    return lines.find((e) => e.entry_type === "webhook" && e.workspace === "ws-deadhook");
  });
  assert.ok(deadEntry, "the failed delivery is recorded");
  assert.equal(deadEntry.ok, false);
  ok("webhook failure is recorded, never fatal: the decision still lands");

  // ── M3.2: export + workspace delete ──────────────────────────
  const exportRes = await fetch(`${baseUrl}/v1/export`, {
    headers: { authorization: `Bearer ${KEY}` },
  });
  assert.equal(exportRes.status, 200);
  assert.match(exportRes.headers.get("content-type") ?? "", /ndjson/);
  const exportLines = (await exportRes.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(exportLines.length >= 8, "export carries the workspace's entries");
  assert.ok(exportLines.every((e) => e.workspace === "ws-test"), "export is workspace-scoped");
  assert.ok(exportLines.some((e) => e.entry_type === "decision"), "export includes decisions");
  assert.equal(
    (await fetch(`${baseUrl}/v1/export`, { headers: { authorization: `Bearer ${INGEST}` } })).status,
    403,
    "export requires the read scope",
  );
  ok("GET /v1/export returns exactly the caller's workspace trail as JSONL");

  // Delete: read scope cannot; admin scope purges ONLY its own
  // workspace and leaves a content-free tombstone behind.
  const wsTestTotalBefore = (await api(baseUrl, "/v1/records")).json.total;
  const deleteForbidden = await fetch(`${baseUrl}/v1/workspace`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${READ}` },
  });
  assert.equal(deleteForbidden.status, 403, "delete requires the admin scope");
  await deleteForbidden.text();
  const purge = await api(baseUrl, "/v1/workspace", { key: ADMIN, method: "DELETE" });
  assert.equal(purge.status, 200);
  assert.ok(purge.json.purged >= 2, "the scoped workspace's entries were purged");
  assert.equal((await api(baseUrl, "/v1/records", { key: READ })).json.total, 0);
  const scopedExport = await fetch(`${baseUrl}/v1/export`, {
    headers: { authorization: `Bearer ${READ}` },
  });
  const scopedLines = (await scopedExport.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(scopedLines.length, 1, "only the tombstone remains");
  assert.equal(scopedLines[0].entry_type, "purge");
  assert.ok(!JSON.stringify(scopedLines).includes("scoped_ask"), "no purged content is retained");
  assert.equal(
    (await api(baseUrl, "/v1/records")).json.total,
    wsTestTotalBefore,
    "another workspace's trail is untouched by the purge",
  );
  ok("DELETE /v1/workspace: admin-only, own-workspace purge with a content-free tombstone");

  await cloud.close();

  // Failure mode: flush against a dead server rejects loudly and
  // KEEPS the records queued — no silent drop.
  child.kill();
  await new Promise((r) => child.on("exit", r));
  const dead = createCloudRecorder({ baseUrl, apiKey: KEY });
  dead.recorder(record("act_orphan", "allow"));
  await assert.rejects(() => dead.flush(), "flush against a dead server must reject");
  assert.equal(dead.pending(), 1, "the failed batch stays queued after a rejected flush");
  ok("dead-server flush rejects and retains the queue — records are never dropped silently");
} finally {
  try { child?.kill(); } catch { /* already gone */ }
  try { hookServer.close(); } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true });
}

// ── M3.2: retention + boot robustness (second boot) ──────────
// A store seeded with an old entry, a recent entry, and one
// corrupt line: with RETENTION_DAYS=30 the old entry is compacted
// out at boot, the corrupt line is skipped, and the server still
// boots and serves the recent entry.
const dir2 = mkdtempSync(join(tmpdir(), "ghostguard-cloud-ret-"));
const store2 = join(dir2, "store.jsonl");
const entryLine = (actionId, receivedAt) =>
  JSON.stringify({
    entry_type: "record",
    workspace: "ws-test",
    received_at: receivedAt,
    record: record(actionId, "allow"),
  });
writeFileSync(store2, [
  entryLine("act_old", "2020-01-01T00:00:00.000Z"),
  entryLine("act_recent", new Date().toISOString()),
  "{corrupt line",
].join("\n") + "\n");
let child2;
try {
  const booted2 = await bootServer({
    GHOSTGUARD_CLOUD_KEYS: `ws-test:${KEY}`,
    GHOSTGUARD_CLOUD_PORT: "0",
    GHOSTGUARD_CLOUD_STORE: store2,
    GHOSTGUARD_CLOUD_RETENTION_DAYS: "30",
  });
  child2 = booted2.child;
  const list2 = await api(booted2.baseUrl, "/v1/records");
  assert.deepEqual(list2.json.records.map((r) => r.action_id), ["act_recent"]);
  assert.ok(!readFileSync(store2, "utf8").includes("act_old"), "retention rewrote the store");
  ok("retention: old entries compact out at boot; a corrupt line never stops the boot");
} finally {
  try { child2?.kill(); } catch { /* already gone */ }
  rmSync(dir2, { recursive: true, force: true });
}

// An invalid port is a one-line startup error and exit 1 — never
// a stack trace.
const badPort = await new Promise((resolve) => {
  const child = spawn("node", [serverPath], {
    env: {
      ...process.env,
      GHOSTGUARD_CLOUD_KEYS: `ws-test:${KEY}`,
      GHOSTGUARD_CLOUD_PORT: "abc",
      GHOSTGUARD_CLOUD_STORE: join(dir2, "unused.jsonl"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (c) => { err += c; });
  child.on("exit", (code) => resolve({ code, err }));
});
assert.notEqual(badPort.code, 0);
assert.match(badPort.err, /not a valid port/);
assert.ok(!badPort.err.includes("node:internal"), "startup errors carry no stack trace");
ok("startup validation: an invalid port exits with one clean line, no stack");

console.log(`\nCloud e2e: all ${passed} checks passed.`);
