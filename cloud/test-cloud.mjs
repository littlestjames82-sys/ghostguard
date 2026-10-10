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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const dir = mkdtempSync(join(tmpdir(), "ghostguard-cloud-"));
const store = join(dir, "store.jsonl");

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
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nCloud e2e: all ${passed} checks passed.`);
