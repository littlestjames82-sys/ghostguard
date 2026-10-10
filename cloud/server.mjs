// GhostGuard Cloud — M3 skeleton server (M3.1 + M3.2 / Phase C).
//
// Zero-dependency Node http server: a JSONL-backed hosted audit
// store + approvals inbox behind the same gateway-record contract
// as the core package (src/gateway.ts). This is a LOCAL SKELETON
// for the future hosted layer — single node, one append-only JSONL
// file per deployment. It is not deployed anywhere and the beta
// has not started. See README.md in this folder for the API, the
// auth model, and the honest limits, and BETA_RUNBOOK.md for how a
// future deployment would be operated.
//
// M3.1: idempotent ingest (dedupe by workspace + action_id),
// decision delivery (GET a decision, with long-poll `wait`),
// full-text search + pagination over the trail, a reporting
// endpoint, server-stamped received_at, and a 1 MB body cap.
//
// M3.2 (Phase C, beta-ready hardening):
//   - Scoped keys with ids from an optional config file: multiple
//     keys per workspace (rotation overlap), per-key scopes
//     (ingest / read / decide / admin), revoke by removal.
//   - Digest-compared auth: SHA-256 both sides, timingSafeEqual on
//     digests — no key-length leak, no early exit.
//   - Per-key rate limiting (429 + Retry-After) and a cap on
//     concurrent long-poll waiters (503 past the cap).
//   - Batch + field size limits on top of the body cap.
//   - Error hygiene: responses never carry stack traces, internal
//     paths, or key material; 500s are generic, detail goes to
//     stderr only.
//   - Decision webhooks (push): per-workspace URL + HMAC-SHA256
//     signature, single attempt, outcome appended to the store,
//     never blocks the decision.
//   - GET /v1/export (workspace trail as JSONL) and
//     DELETE /v1/workspace (admin scope; purge + tombstone).
//   - Optional retention: GHOSTGUARD_CLOUD_RETENTION_DAYS compacts
//     out older entries at boot.
//   - Corrupt store lines are skipped with a stderr count instead
//     of crashing the boot.
//
// Run:
//   GHOSTGUARD_CLOUD_KEYS="myworkspace:my-secret-key" node cloud/server.mjs
//
// Environment:
//   GHOSTGUARD_CLOUD_KEYS        comma-separated workspace:key pairs
//                                (legacy form; keys are full-scope)
//   GHOSTGUARD_CLOUD_CONFIG_FILE JSON config file: scoped keys with
//                                ids + per-workspace webhooks (see
//                                config.example.json)
//   GHOSTGUARD_CLOUD_PORT        listen port (default 8787; 0 = ephemeral)
//   GHOSTGUARD_CLOUD_HOST        listen host (default 127.0.0.1)
//   GHOSTGUARD_CLOUD_STORE       JSONL store path (default ./store.jsonl
//                                next to this file)
//   GHOSTGUARD_CLOUD_MAX_BODY_BYTES  request body cap (default 1048576)
//   GHOSTGUARD_CLOUD_MAX_BATCH   max records per POST (default 500)
//   GHOSTGUARD_CLOUD_RATE_LIMIT  requests/minute per key (default 600;
//                                a config-file key may override)
//   GHOSTGUARD_CLOUD_MAX_WAITERS max concurrent long-polls (default 1000)
//   GHOSTGUARD_CLOUD_RETENTION_DAYS  drop entries older than N days at
//                                boot (unset/0 = keep forever)

import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────

const ALL_SCOPES = ["ingest", "read", "decide", "admin"];

// Key table entries: { workspace, keyId, digest (Buffer, sha256 of
// the key), scopes (Set), rateLimit (number|null), webhook }.
// Keys themselves are held only long enough to digest at boot and
// are never logged, echoed, or compared in raw form.
const keyTable = [];
const webhooks = new Map(); // workspace -> { url, secret }

function addKey(workspace, key, keyId, scopes, rateLimit) {
  if (typeof key !== "string" || key.length === 0) return;
  if (key.length < 8) {
    console.error(
      `ghostguard-cloud: warning — key "${keyId}" for workspace "${workspace}" is shorter than 8 characters`,
    );
  }
  keyTable.push({
    workspace,
    keyId,
    digest: createHash("sha256").update(key, "utf8").digest(),
    scopes: new Set(scopes && scopes.length ? scopes : ALL_SCOPES),
    rateLimit: typeof rateLimit === "number" && rateLimit > 0 ? rateLimit : null,
  });
}

function parseLegacyKeys(raw) {
  for (const pair of (raw ?? "").split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    addKey(trimmed.slice(0, idx), trimmed.slice(idx + 1), "legacy", ALL_SCOPES, null);
  }
}

function loadConfigFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.error(`ghostguard-cloud: cannot read or parse config file ${path}`);
    process.exit(1);
  }
  const workspaces = parsed?.workspaces ?? {};
  for (const [workspace, cfg] of Object.entries(workspaces)) {
    for (const k of cfg?.keys ?? []) {
      addKey(workspace, k?.key, typeof k?.id === "string" ? k.id : "config", k?.scopes, k?.rateLimit);
    }
    if (cfg?.webhook?.url) {
      webhooks.set(workspace, {
        url: String(cfg.webhook.url),
        secret: typeof cfg.webhook.secret === "string" ? cfg.webhook.secret : "",
      });
    }
  }
}

parseLegacyKeys(process.env.GHOSTGUARD_CLOUD_KEYS);
if (process.env.GHOSTGUARD_CLOUD_CONFIG_FILE) {
  loadConfigFile(process.env.GHOSTGUARD_CLOUD_CONFIG_FILE);
}

const PORT = Number(process.env.GHOSTGUARD_CLOUD_PORT ?? 8787);
const HOST = process.env.GHOSTGUARD_CLOUD_HOST ?? "127.0.0.1";
const STORE_PATH = process.env.GHOSTGUARD_CLOUD_STORE ?? join(here, "store.jsonl");
const MAX_BODY = Number(process.env.GHOSTGUARD_CLOUD_MAX_BODY_BYTES ?? 1024 * 1024);
const MAX_BATCH = Number(process.env.GHOSTGUARD_CLOUD_MAX_BATCH ?? 500);
const RATE_LIMIT = Number(process.env.GHOSTGUARD_CLOUD_RATE_LIMIT ?? 600);
const MAX_WAITERS = Number(process.env.GHOSTGUARD_CLOUD_MAX_WAITERS ?? 1000);
const RETENTION_DAYS = Number(process.env.GHOSTGUARD_CLOUD_RETENTION_DAYS ?? 0);

// ── Store ─────────────────────────────────────────────────────────
// Append-only JSONL. Entry kinds, distinguished by entry_type:
//   { entry_type: "record",   workspace, received_at, record }
//   { entry_type: "decision", workspace, decided_at, action_id,
//     project_id, decision, approver }
//   { entry_type: "webhook",  workspace, action_id, ok, status?,
//     received_at }            — decision-push delivery outcome
//   { entry_type: "purge",    workspace, purged, received_at }
//                              — tombstone left by DELETE /v1/workspace
// History is never rewritten by the API: a decision is a new line,
// and the inbox is a VIEW (pending records minus decided
// action_ids), computed on read. The two deliberate exceptions are
// operator actions: a workspace purge (DELETE, admin scope) and
// boot-time retention compaction — both rewrite the file and both
// are logged; a purge leaves the tombstone above.

function loadStore() {
  if (!existsSync(STORE_PATH)) return [];
  const out = [];
  let corrupt = 0;
  for (const line of readFileSync(STORE_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      corrupt += 1;
    }
  }
  if (corrupt > 0) {
    console.error(`ghostguard-cloud: skipped ${corrupt} corrupt store line(s) at boot`);
  }
  return out;
}

let entries = loadStore();

function entryTime(e) {
  const t = Date.parse(e.received_at ?? e.decided_at ?? "");
  return Number.isNaN(t) ? null : t;
}

function compactStore() {
  mkdirSync(dirname(STORE_PATH) || ".", { recursive: true });
  writeFileSync(STORE_PATH, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""), "utf8");
}

if (RETENTION_DAYS > 0) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const kept = entries.filter((e) => {
    const t = entryTime(e);
    return t === null || t >= cutoff;
  });
  if (kept.length !== entries.length) {
    console.error(
      `ghostguard-cloud: retention (${RETENTION_DAYS}d) compacted out ${entries.length - kept.length} entr${entries.length - kept.length === 1 ? "y" : "ies"} at boot`,
    );
    entries = kept;
    compactStore();
  }
}

function appendEntry(entry) {
  mkdirSync(dirname(STORE_PATH) || ".", { recursive: true });
  appendFileSync(STORE_PATH, JSON.stringify(entry) + "\n", "utf8");
  entries.push(entry);
  if (entry.entry_type === "record") {
    recordIndex.add(`${entry.workspace} ${entry.record.action_id}`);
  }
}

function decidedActionIds(workspace) {
  const ids = new Set();
  for (const e of entries) {
    if (e.entry_type === "decision" && e.workspace === workspace) ids.add(e.action_id);
  }
  return ids;
}

function isPending(e, decided) {
  return (
    e.entry_type === "record" &&
    (e.record.verdict === "ask" || e.record.verdict === "hand_off") &&
    !decided.has(e.record.action_id)
  );
}

function publicRecord(e) {
  return { ...e.record, workspace: e.workspace, received_at: e.received_at };
}

function publicDecision(e) {
  return {
    action_id: e.action_id,
    project_id: e.project_id,
    decision: e.decision,
    approver: e.approver,
    workspace: e.workspace,
    decided_at: e.decided_at,
    received_at: e.received_at,
  };
}

function decisionFor(workspace, actionId) {
  return entries.find(
    (e) => e.entry_type === "decision" && e.workspace === workspace && e.action_id === actionId,
  );
}

// Idempotent ingest index: `${workspace} ${action_id}` of every
// stored record. Rebuilt from the store at boot and updated on
// append. Dedupe is an ingest CHECK against this index — stored
// lines are never rewritten or removed.
const recordIndex = new Set(
  entries
    .filter((e) => e.entry_type === "record")
    .map((e) => `${e.workspace} ${e.record.action_id}`),
);

// Case-insensitive substring search over a record's searchable
// surface: kind, actor, rule_id, reason, and the JSON of target /
// action_payload (so payload text is findable too).
function recordMatchesQuery(r, q) {
  const needle = q.toLowerCase();
  const fields = [
    r.kind,
    r.actor,
    r.rule_id,
    r.reason,
    JSON.stringify(r.target ?? null),
    JSON.stringify(r.action_payload ?? null),
  ];
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(needle));
}

// ── Decision long-poll waiters ────────────────────────────────────
// GET /v1/inbox/:action_id/decision?wait=N parks here until the
// decision lands (notifyDecision, called by the POST route) or the
// wait elapses. Waiters resolve with the decision entry, or null
// on timeout / client disconnect.

const decisionWaiters = new Map(); // key -> Set<finish>

function totalWaiters() {
  let n = 0;
  for (const set of decisionWaiters.values()) n += set.size;
  return n;
}

function notifyDecision(workspace, actionId, entry) {
  const key = `${workspace} ${actionId}`;
  const set = decisionWaiters.get(key);
  if (!set) return;
  decisionWaiters.delete(key);
  for (const finish of set) finish(entry);
}

function waitForDecisionEntry(workspace, actionId, timeoutMs, res) {
  return new Promise((resolve) => {
    const key = `${workspace} ${actionId}`;
    let set = decisionWaiters.get(key);
    if (!set) {
      set = new Set();
      decisionWaiters.set(key, set);
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      set.delete(finish);
      if (set.size === 0) decisionWaiters.delete(key);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    set.add(finish);
    res.on("close", () => finish(null));
  });
}

// ── Decision webhooks (push) ──────────────────────────────────────
// When a workspace has a webhook configured, a decision append
// fires one POST: the public decision JSON, signed with
// HMAC-SHA256 (hex) over the exact body bytes in the
// `x-ghostguard-signature` header (`sha256=<hex>`). Single
// attempt, 5s timeout, fire-and-forget: the outcome is appended
// to the store as a webhook entry — the decision itself never
// waits on, or fails because of, a webhook.

function fireDecisionWebhook(workspace, entry) {
  const hook = webhooks.get(workspace);
  if (!hook) return;
  const body = JSON.stringify({ event: "decision", ...publicDecision(entry) });
  const signature = "sha256=" + createHmac("sha256", hook.secret).update(body, "utf8").digest("hex");
  const stamp = () => new Date().toISOString();
  (async () => {
    let ok = false;
    let status = null;
    try {
      const res = await fetch(hook.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ghostguard-signature": signature },
        body,
        signal: AbortSignal.timeout(5000),
      });
      status = res.status;
      ok = res.ok;
      await res.text().catch(() => "");
    } catch {
      ok = false;
    }
    appendEntry({
      entry_type: "webhook",
      workspace,
      action_id: entry.action_id,
      ok,
      status,
      received_at: stamp(),
    });
  })().catch(() => {
    // The webhook outcome could not even be recorded (store write
    // failed). Nothing safe left to do but say so on stderr.
    console.error(`ghostguard-cloud: webhook outcome for ${workspace} could not be recorded`);
  });
}

// ── Auth ──────────────────────────────────────────────────────────
// Bearer keys, supplied via the environment (legacy form) or the
// config file (scoped form). Comparison digests both sides with
// SHA-256 and uses timingSafeEqual on the digests: constant-time
// for every candidate, and no key-length information leaks. Keys
// are never logged and never echoed back.

function authForKey(key) {
  if (!key) return null;
  const candidate = createHash("sha256").update(key, "utf8").digest();
  let found = null;
  for (const entry of keyTable) {
    if (timingSafeEqual(entry.digest, candidate)) found = entry;
  }
  return found;
}

function authRequest(req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? authForKey(match[1]) : null;
}

// ── Rate limiting ─────────────────────────────────────────────────
// Sliding 60-second window per key (workspace + key id). The limit
// is the key's own override from the config file when present,
// else GHOSTGUARD_CLOUD_RATE_LIMIT. /health is exempt.

const rateBuckets = new Map(); // authId -> number[] (timestamps)

function rateLimited(auth) {
  const limit = auth.rateLimit ?? RATE_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const id = `${auth.workspace} ${auth.keyId}`;
  const now = Date.now();
  const windowStart = now - 60_000;
  const stamps = (rateBuckets.get(id) ?? []).filter((t) => t > windowStart);
  if (stamps.length >= limit) {
    rateBuckets.set(id, stamps);
    return Math.max(1, Math.ceil((stamps[0] + 60_000 - now) / 1000));
  }
  stamps.push(now);
  rateBuckets.set(id, stamps);
  return 0;
}

// ── HTTP plumbing ─────────────────────────────────────────────────

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        // Over the cap: keep draining (so the connection stays
        // healthy enough to deliver the 413) but keep nothing.
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || "null");
  } catch {
    throw Object.assign(new Error("malformed JSON"), { status: 400 });
  }
}

const VERDICTS = new Set(["allow", "pre_approved", "ask", "hand_off", "deny"]);
const MAX_ID_LEN = 200;
const MAX_APPROVER_LEN = 100;
const MAX_QUERY_LEN = 200;

function validateRecord(r, index) {
  if (r === null || typeof r !== "object" || Array.isArray(r)) {
    return `records[${index}] is not an object`;
  }
  for (const field of ["action_id", "verdict", "project_id"]) {
    if (typeof r[field] !== "string" || r[field].length === 0) {
      return `records[${index}].${field} must be a non-empty string`;
    }
    if (r[field].length > MAX_ID_LEN) {
      return `records[${index}].${field} exceeds ${MAX_ID_LEN} characters`;
    }
  }
  if (!VERDICTS.has(r.verdict)) {
    return `records[${index}].verdict is not a known verdict`;
  }
  return null;
}

// ── Approvals inbox UI (single static page, no framework) ───────

const INBOX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GhostGuard Cloud — Approvals Inbox (skeleton)</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 56rem; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  .bar { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
  input { padding: .45rem .6rem; border: 1px solid #bbb; border-radius: .4rem; }
  button { padding: .45rem .9rem; border: 0; border-radius: .4rem; cursor: pointer; }
  .approve { background: #16794c; color: #fff; }
  .deny { background: #b3261e; color: #fff; }
  .card { border: 1px solid #ddd; border-radius: .6rem; padding: 1rem; margin-bottom: 1rem; }
  .meta { color: #555; font-size: .9rem; }
  pre { background: #f6f6f6; padding: .6rem; border-radius: .4rem; overflow-x: auto; }
  .err { color: #b3261e; }
</style>
</head>
<body>
<h1>GhostGuard Cloud — Approvals Inbox</h1>
<p class="meta">Local skeleton. Pending <code>ask</code> / <code>hand_off</code> records
for your workspace. Decisions are appended to the audit store — history is never rewritten.</p>
<div class="bar">
  <input id="key" type="password" placeholder="API key" size="36">
  <input id="approver" type="text" placeholder="Your name (approver)" size="24">
  <input id="search" type="search" placeholder="Search pending (kind, actor, payload…)" size="32">
  <button id="load">Load inbox</button>
</div>
<p id="report" class="meta"></p>
<p id="status" class="meta"></p>
<div id="list"></div>
<script>
const $ = (id) => document.getElementById(id);
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json",
               authorization: "Bearer " + $("key").value.trim(),
               ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " — " + (await res.text()));
  return res.json();
}
async function decide(actionId, decision) {
  const approver = $("approver").value.trim();
  if (!approver) { $("status").textContent = "Enter your name as approver first."; return; }
  await api("/v1/inbox/" + encodeURIComponent(actionId) + "/decision", {
    method: "POST",
    body: JSON.stringify({ decision, approver }),
  });
  load();
}
async function load() {
  const list = $("list");
  try {
    const q = $("search").value.trim();
    const [inbox, report] = await Promise.all([
      api("/v1/inbox" + (q ? "?q=" + encodeURIComponent(q) : "")),
      api("/v1/report"),
    ]);
    const { pending } = inbox;
    const parts = Object.entries(report.by_verdict).map(([k, v]) => k + ": " + v);
    $("report").textContent =
      "Trail totals — " + (parts.length ? parts.join(" · ") : "none") +
      " · pending: " + report.pending;
    $("status").textContent = pending.length + " pending";
    list.innerHTML = "";
    for (const r of pending) {
      const card = document.createElement("div");
      card.className = "card";
      const payload = document.createElement("pre");
      payload.textContent = JSON.stringify(r.action_payload, null, 2);
      const head = document.createElement("div");
      head.innerHTML = "<strong></strong> <span class=\\"meta\\"></span>";
      head.querySelector("strong").textContent = r.kind + " — " + r.verdict;
      head.querySelector(".meta").textContent =
        "actor: " + r.actor + " · project: " + r.project_id + " · action: " + r.action_id +
        (r.handoff_to ? " · hand off to: " + r.handoff_to : "");
      const reason = document.createElement("p");
      reason.textContent = r.reason || "";
      const approve = document.createElement("button");
      approve.className = "approve"; approve.textContent = "Approve";
      approve.onclick = () => decide(r.action_id, "approve");
      const deny = document.createElement("button");
      deny.className = "deny"; deny.textContent = "Deny";
      deny.onclick = () => decide(r.action_id, "deny");
      const bar = document.createElement("div");
      bar.className = "bar"; bar.append(approve, deny);
      card.append(head, reason, payload, bar);
      list.append(card);
    }
  } catch (err) {
    $("status").innerHTML = "<span class=\\"err\\">" + err.message + "</span>";
  }
}
$("load").onclick = load;
$("search").addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
</script>
</body>
</html>`;

// ── Routes ────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      return sendJson(res, 200, { ok: true, service: "ghostguard-cloud", milestone: "M3.2" });
    }
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      return res.end(INBOX_HTML);
    }

    // Everything below requires a valid workspace key. Missing
    // and wrong keys get the identical 401 — no oracle.
    const auth = authRequest(req);
    if (!auth) return sendJson(res, 401, { error: "unauthorized" });
    const workspace = auth.workspace;

    const retryAfter = rateLimited(auth);
    if (retryAfter > 0) {
      return sendJson(res, 429, { error: "rate limited" }, { "retry-after": String(retryAfter) });
    }

    const requireScope = (scope) => {
      if (auth.scopes.has(scope)) return true;
      sendJson(res, 403, { error: "forbidden" });
      return false;
    };

    if (req.method === "POST" && path === "/v1/records") {
      if (!requireScope("ingest")) return;
      const body = await readJsonBody(req);
      const records = Array.isArray(body) ? body : [body];
      if (records.length > MAX_BATCH) {
        return sendJson(res, 400, { error: `batch exceeds ${MAX_BATCH} records` });
      }
      for (let i = 0; i < records.length; i++) {
        const problem = validateRecord(records[i], i);
        if (problem) return sendJson(res, 400, { error: problem });
      }
      // Idempotent ingest: a record whose (workspace, action_id)
      // already exists in the trail is a RETRY — the documented
      // "connection died after the store, before the reply" case —
      // not a new event. It is counted and skipped, never appended
      // twice. The store stays append-only; this is a check, not a
      // rewrite.
      let stored = 0;
      let duplicates = 0;
      for (const record of records) {
        if (recordIndex.has(`${workspace} ${record.action_id}`)) {
          duplicates += 1;
          continue;
        }
        // The server's ingest stamp is authoritative: strip any
        // client-supplied received_at; the entry carries the stamp.
        const clean = { ...record };
        delete clean.received_at;
        appendEntry({
          entry_type: "record",
          workspace,
          received_at: new Date().toISOString(),
          record: clean,
        });
        stored += 1;
      }
      return sendJson(res, 202, { stored, duplicates, workspace });
    }

    if (req.method === "GET" && path === "/v1/records") {
      if (!requireScope("read")) return;
      const projectId = url.searchParams.get("project_id");
      const verdict = url.searchParams.get("verdict");
      const q = url.searchParams.get("q");
      if (q && q.length > MAX_QUERY_LEN) {
        return sendJson(res, 400, { error: `q exceeds ${MAX_QUERY_LEN} characters` });
      }
      const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit =
        Number.isFinite(parsedLimit) && parsedLimit >= 0 ? Math.min(parsedLimit, 1000) : 100;
      const parsedOffset = Number.parseInt(url.searchParams.get("offset") ?? "", 10);
      const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
      const matched = entries
        .filter((e) => e.entry_type === "record" && e.workspace === workspace)
        .filter((e) => !projectId || e.record.project_id === projectId)
        .filter((e) => !verdict || e.record.verdict === verdict)
        .filter((e) => !q || recordMatchesQuery(e.record, q))
        .map(publicRecord);
      return sendJson(res, 200, {
        records: matched.slice(offset, offset + limit),
        total: matched.length,
        limit,
        offset,
      });
    }

    if (req.method === "GET" && path === "/v1/report") {
      if (!requireScope("read")) return;
      const projectId = url.searchParams.get("project_id");
      const decided = decidedActionIds(workspace);
      const recs = entries.filter(
        (e) =>
          e.entry_type === "record" &&
          e.workspace === workspace &&
          (!projectId || e.record.project_id === projectId),
      );
      const tally = (keyFn) => {
        const out = {};
        for (const e of recs) {
          const k = keyFn(e.record);
          out[k] = (out[k] ?? 0) + 1;
        }
        return out;
      };
      return sendJson(res, 200, {
        workspace,
        project_id: projectId,
        total_records: recs.length,
        by_verdict: tally((r) => r.verdict),
        by_rule: tally((r) => r.rule_id ?? "(none)"),
        by_actor: tally((r) => r.actor ?? "(unknown)"),
        pending: recs.filter((e) => isPending(e, decided)).length,
      });
    }

    if (req.method === "GET" && path === "/v1/inbox") {
      if (!requireScope("read")) return;
      const decided = decidedActionIds(workspace);
      const q = url.searchParams.get("q");
      if (q && q.length > MAX_QUERY_LEN) {
        return sendJson(res, 400, { error: `q exceeds ${MAX_QUERY_LEN} characters` });
      }
      const pending = entries
        .filter((e) => e.workspace === workspace && isPending(e, decided))
        .filter((e) => !q || recordMatchesQuery(e.record, q))
        .map(publicRecord);
      return sendJson(res, 200, { pending });
    }

    if (req.method === "GET" && path === "/v1/export") {
      if (!requireScope("read")) return;
      // The workspace's raw trail (every entry kind, as stored),
      // JSONL — the export format is the store format.
      const lines = entries
        .filter((e) => e.workspace === workspace)
        .map((e) => JSON.stringify(e));
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": `attachment; filename="ghostguard-${workspace}-export.jsonl"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      return res.end(lines.length ? lines.join("\n") + "\n" : "");
    }

    if (req.method === "DELETE" && path === "/v1/workspace") {
      if (!requireScope("admin")) return;
      // Operator action: purge ONLY the caller's own workspace
      // (the workspace comes from the key, never from input).
      // Rewrites the store without that workspace's entries and
      // leaves a content-free tombstone, so the trail itself shows
      // that a purge happened — and how much went — with none of
      // the purged content retained.
      const purged = entries.filter((e) => e.workspace === workspace).length;
      entries = entries.filter((e) => e.workspace !== workspace);
      for (const id of [...recordIndex]) {
        if (id.startsWith(`${workspace} `)) recordIndex.delete(id);
      }
      for (const key of [...decisionWaiters.keys()]) {
        if (key.startsWith(`${workspace} `)) {
          const set = decisionWaiters.get(key);
          decisionWaiters.delete(key);
          for (const finish of set) finish(null);
        }
      }
      compactStore();
      appendEntry({
        entry_type: "purge",
        workspace,
        purged,
        received_at: new Date().toISOString(),
      });
      console.error(`ghostguard-cloud: workspace "${workspace}" purged ${purged} entries (DELETE /v1/workspace)`);
      return sendJson(res, 200, { purged, workspace });
    }

    const decisionMatch = /^\/v1\/inbox\/([^/]+)\/decision$/.exec(path);
    if (req.method === "GET" && decisionMatch) {
      if (!requireScope("read")) return;
      const actionId = decodeURIComponent(decisionMatch[1]);
      let entry = decisionFor(workspace, actionId);
      if (!entry) {
        // Long-poll: ?wait=<seconds> (float ok, capped at 30)
        // parks the request until the decision lands.
        const waitSec = Number.parseFloat(url.searchParams.get("wait") ?? "0");
        const waitMs = Number.isFinite(waitSec)
          ? Math.min(30, Math.max(0, waitSec)) * 1000
          : 0;
        if (waitMs > 0) {
          if (totalWaiters() >= MAX_WAITERS) {
            return sendJson(res, 503, { error: "too many waiting requests" });
          }
          entry = await waitForDecisionEntry(workspace, actionId, waitMs, res);
          // A decision that landed exactly as the wait elapsed
          // is still a decision — re-check before saying 404.
          if (!entry) entry = decisionFor(workspace, actionId);
        }
      }
      if (!entry) {
        return sendJson(res, 404, { error: `no decision for ${actionId}`, pending: true });
      }
      return sendJson(res, 200, publicDecision(entry));
    }

    if (req.method === "POST" && decisionMatch) {
      if (!requireScope("decide")) return;
      const actionId = decodeURIComponent(decisionMatch[1]);
      const body = await readJsonBody(req);
      if (body?.decision !== "approve" && body?.decision !== "deny") {
        return sendJson(res, 400, { error: 'decision must be "approve" or "deny"' });
      }
      if (
        typeof body?.approver !== "string" ||
        body.approver.length === 0 ||
        body.approver.length > MAX_APPROVER_LEN
      ) {
        return sendJson(res, 400, { error: `approver must be a string of 1–${MAX_APPROVER_LEN} characters` });
      }
      const decided = decidedActionIds(workspace);
      const target = entries.find(
        (e) => e.workspace === workspace && e.record?.action_id === actionId && isPending(e, decided),
      );
      if (!target) return sendJson(res, 404, { error: `no pending action ${actionId}` });
      const now = new Date().toISOString();
      const entry = {
        entry_type: "decision",
        workspace,
        decided_at: now,
        received_at: now,
        action_id: actionId,
        project_id: target.record.project_id,
        decision: body.decision,
        approver: body.approver,
      };
      appendEntry(entry);
      // Wake any long-poll waiters — this is how the human's
      // decision actually reaches the agent that asked.
      notifyDecision(workspace, actionId, entry);
      // Push the decision to the workspace's webhook, if any.
      // Fire-and-forget: delivery never delays or fails this.
      fireDecisionWebhook(workspace, entry);
      return sendJson(res, 200, {
        action_id: actionId,
        decision: body.decision,
        approver: body.approver,
        decided_at: now,
        received_at: now,
      });
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    // Error hygiene: the client gets a stable, safe message. Our
    // own 4xx errors carry their message; anything unexpected is
    // a generic 500 and the detail goes to stderr only — never a
    // stack trace, a filesystem path, or key material in a body.
    const status = typeof err?.status === "number" ? err.status : 500;
    if (status >= 500) {
      console.error(`ghostguard-cloud: internal error: ${err?.message ?? err}`);
      return sendJson(res, 500, { error: "internal error" });
    }
    return sendJson(res, status, { error: String(err?.message ?? "bad request") });
  }
});

// Only listen when run directly (`node cloud/server.mjs`), so tests
// can import nothing and spawn it as a child process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (keyTable.length === 0) {
    console.error(
      "ghostguard-cloud: no API keys configured — set GHOSTGUARD_CLOUD_KEYS or GHOSTGUARD_CLOUD_CONFIG_FILE before starting.",
    );
    process.exit(1);
  }
  if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
    console.error(`ghostguard-cloud: GHOSTGUARD_CLOUD_PORT is not a valid port: ${process.env.GHOSTGUARD_CLOUD_PORT}`);
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    const addr = server.address();
    const workspaces = new Set(keyTable.map((k) => k.workspace)).size;
    console.log(`ghostguard-cloud listening on http://${HOST}:${addr.port} (store: ${STORE_PATH}, workspaces: ${workspaces})`);
  });
}

export { server };
