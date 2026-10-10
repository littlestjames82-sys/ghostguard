// GhostGuard Cloud — M3 skeleton server (M3.1 improvements).
//
// Zero-dependency Node http server: a JSONL-backed hosted audit
// store + approvals inbox behind the same gateway-record contract
// as the core package (src/gateway.ts). This is a LOCAL SKELETON
// for the future hosted layer — single node, one append-only JSONL
// file per deployment, skeleton Bearer-key auth. It is not
// deployed anywhere and the beta has not started. See README.md in
// this folder for the API, the auth model, and the honest limits.
//
// M3.1: idempotent ingest (dedupe by workspace + action_id),
// decision delivery (GET a decision, with long-poll `wait`),
// full-text search + pagination over the trail, a reporting
// endpoint, server-stamped received_at, and a 1 MB body cap.
//
// Run:
//   GHOSTGUARD_CLOUD_KEYS="myworkspace:my-secret-key" node cloud/server.mjs
//
// Environment:
//   GHOSTGUARD_CLOUD_KEYS  comma-separated workspace:key pairs (required)
//   GHOSTGUARD_CLOUD_PORT  listen port (default 8787; 0 = ephemeral)
//   GHOSTGUARD_CLOUD_HOST  listen host (default 127.0.0.1)
//   GHOSTGUARD_CLOUD_STORE JSONL store path (default ./store.jsonl
//                          next to this file)

import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────

function parseKeys(raw) {
  const map = new Map(); // apiKey -> workspace
  for (const pair of (raw ?? "").split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    map.set(trimmed.slice(idx + 1), trimmed.slice(0, idx));
  }
  return map;
}

const apiKeys = parseKeys(process.env.GHOSTGUARD_CLOUD_KEYS);
const PORT = Number(process.env.GHOSTGUARD_CLOUD_PORT ?? 8787);
const HOST = process.env.GHOSTGUARD_CLOUD_HOST ?? "127.0.0.1";
const STORE_PATH = process.env.GHOSTGUARD_CLOUD_STORE ?? join(here, "store.jsonl");

// ── Store ─────────────────────────────────────────────────────────
// Append-only JSONL. Two entry kinds, distinguished by entry_type:
//   { entry_type: "record",   workspace, received_at, record }
//   { entry_type: "decision", workspace, decided_at, action_id,
//     project_id, decision, approver }
// History is never rewritten: a decision is a new line, and the
// inbox is a VIEW (pending records minus decided action_ids),
// computed on read.

function loadStore() {
  if (!existsSync(STORE_PATH)) return [];
  return readFileSync(STORE_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

const entries = loadStore();

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

// ── Auth ──────────────────────────────────────────────────────────
// Skeleton auth: a static Bearer key per workspace, supplied via
// the environment. Keys are never logged and never echoed back.

function workspaceForKey(key) {
  if (!key) return null;
  const candidate = Buffer.from(key);
  for (const [known, workspace] of apiKeys) {
    const knownBuf = Buffer.from(known);
    if (knownBuf.length === candidate.length && timingSafeEqual(knownBuf, candidate)) {
      return workspace;
    }
  }
  return null;
}

function authWorkspace(req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? workspaceForKey(match[1]) : null;
}

// ── HTTP plumbing ─────────────────────────────────────────────────

const MAX_BODY = 1 * 1024 * 1024; // 1 MB request-body cap

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
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

function validateRecord(r, index) {
  if (r === null || typeof r !== "object" || Array.isArray(r)) {
    return `records[${index}] is not an object`;
  }
  for (const field of ["action_id", "verdict", "project_id"]) {
    if (typeof r[field] !== "string" || r[field].length === 0) {
      return `records[${index}].${field} must be a non-empty string`;
    }
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
<p class="meta">M3 skeleton. Pending <code>ask</code> / <code>hand_off</code> records
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
      return sendJson(res, 200, { ok: true, service: "ghostguard-cloud", milestone: "M3.1" });
    }
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(INBOX_HTML);
    }

    // Everything below requires a valid workspace key.
    const workspace = authWorkspace(req);
    if (!workspace) return sendJson(res, 401, { error: "unauthorized" });

    if (req.method === "POST" && path === "/v1/records") {
      const body = JSON.parse((await readBody(req)) || "null");
      const records = Array.isArray(body) ? body : [body];
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
      const projectId = url.searchParams.get("project_id");
      const verdict = url.searchParams.get("verdict");
      const q = url.searchParams.get("q");
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
      const decided = decidedActionIds(workspace);
      const q = url.searchParams.get("q");
      const pending = entries
        .filter((e) => e.workspace === workspace && isPending(e, decided))
        .filter((e) => !q || recordMatchesQuery(e.record, q))
        .map(publicRecord);
      return sendJson(res, 200, { pending });
    }

    const decisionMatch = /^\/v1\/inbox\/([^/]+)\/decision$/.exec(path);
    if (req.method === "GET" && decisionMatch) {
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
      const actionId = decodeURIComponent(decisionMatch[1]);
      const body = JSON.parse((await readBody(req)) || "null");
      if (body?.decision !== "approve" && body?.decision !== "deny") {
        return sendJson(res, 400, { error: 'decision must be "approve" or "deny"' });
      }
      if (typeof body?.approver !== "string" || body.approver.length === 0) {
        return sendJson(res, 400, { error: "approver must be a non-empty string" });
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
    const status = err?.status ?? (err instanceof SyntaxError ? 400 : 500);
    return sendJson(res, status, { error: String(err?.message ?? err) });
  }
});

// Only listen when run directly (`node cloud/server.mjs`), so tests
// can import nothing and spawn it as a child process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (apiKeys.size === 0) {
    console.error("GHOSTGUARD_CLOUD_KEYS is empty — set workspace:key pairs before starting.");
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    const addr = server.address();
    console.log(`ghostguard-cloud listening on http://${HOST}:${addr.port} (store: ${STORE_PATH}, workspaces: ${apiKeys.size})`);
  });
}

export { server };
