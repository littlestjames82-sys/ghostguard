#!/usr/bin/env node
/**
 * ghostguard-mcp end-to-end test suite.
 *
 * Spawns the REAL proxy as a child process, configured against the
 * REAL fake-upstream fixture, and speaks MCP (NDJSON JSON-RPC) to
 * the proxy's stdio. Proves:
 *
 *   1. initialize + tools/list are forwarded to the upstream.
 *   2. An allowed (READ) tool executes via the upstream, and the
 *      upstream fixture saw the audit record already written
 *      (audit_seen=true) — record before execution.
 *   3. A SPEND tool is denied by the locked rule and NEVER reaches
 *      the upstream (upstream call log has no entry for it).
 *   4. A DELETE tool is denied the same way.
 *   5. A hand_off (PUBLISH) tool is blocked and never forwarded.
 *   6. An ask-class (COMMUNICATE) tool is blocked while unapproved,
 *      never forwarded, and its error names the ask rule + carries
 *      an args_hash.
 *   7. After a human adds that exact approval via the approve CLI,
 *      the same call executes; a DIFFERENT-args call stays blocked
 *      (approvals are exact-args, not blanket).
 *   8. An unmapped tool fails closed (defaultClass EXECUTE -> ask),
 *      never forwarded.
 *   9. A hostile policy overlay (reuses the locked deny's id as an
 *      allow + allow-everything) cannot weaken the locked rule:
 *      the SPEND call is still denied.
 *  10. The audit trail holds a record for every tools/call —
 *      allowed, denied, asked, handed off — in call order.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "ghostguard-mcp-test-"));

const auditFile = join(tmp, "audit.jsonl");
const upstreamLog = join(tmp, "upstream.log");
const approvalsFile = join(tmp, "approvals.json");
const policyFile = join(tmp, "policy.json");
const overlayFile = join(tmp, "overlay.json");
const configFile = join(tmp, "config.json");

writeFileSync(policyFile, readFileSync(join(pkgRoot, "policy.example.json"), "utf8"), "utf8");
writeFileSync(overlayFile, readFileSync(join(pkgRoot, "overlay.hostile.example.json"), "utf8"), "utf8");
writeFileSync(configFile, JSON.stringify({
  upstream: {
    command: process.execPath,
    args: [join(pkgRoot, "fixture", "fake-upstream.mjs")],
    env: { FAKE_UPSTREAM_LOG: upstreamLog, FAKE_UPSTREAM_AUDIT_FILE: auditFile },
  },
  policyFile,
  overlayFile,
  auditFile,
  approvalsFile,
  actor: "mcp-test-client",
  projectId: "ghostguard-mcp-test",
  initiator: "person",
  defaultClass: "EXECUTE",
  toolClasses: {
    echo: "READ",
    add: "READ",
    write_note: "WRITE_LOCAL",
    send_email: "COMMUNICATE",
    buy: "SPEND",
    delete_file: "DELETE",
    publish_post: "PUBLISH",
    // mystery_tool deliberately unmapped
  },
}, null, 2), "utf8");

// ── Minimal MCP client over the proxy's stdio ──────────────────────

const proxy = spawn(process.execPath, [join(pkgRoot, "src", "proxy.mjs"), "--config", configFile], {
  stdio: ["pipe", "pipe", "pipe"],
});
let proxyStderr = "";
proxy.stderr.on("data", (d) => { proxyStderr += d.toString(); });

const pending = new Map();
let nextId = 1;
const lines = createInterface({ input: proxy.stdout, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function request(method, params) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method} (id ${id})`)), 10000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
function notify(method, params) {
  proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}
const callTool = (name, args) => request("tools/call", { name, arguments: args });

// ── Assertions ───────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

function upstreamCalls() {
  if (!existsSync(upstreamLog)) return [];
  return readFileSync(upstreamLog, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
function auditRecords() {
  if (!existsSync(auditFile)) return [];
  return readFileSync(auditFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
const upstreamSaw = (tool) => upstreamCalls().some((c) => c.tool === tool);

try {
  // 1. initialize + tools/list forwarded
  const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  check("initialize forwarded to upstream", init.result?.serverInfo?.name === "fake-upstream", JSON.stringify(init).slice(0, 200));
  notify("notifications/initialized", {});
  const list = await request("tools/list", {});
  const toolNames = (list.result?.tools ?? []).map((t) => t.name);
  check("tools/list forwarded (8 tools incl. mystery_tool)", toolNames.length === 8 && toolNames.includes("mystery_tool"), toolNames.join(","));

  // 2. allowed READ tool executes, record-first
  const echo = await callTool("echo", { message: "hello" });
  check("echo (READ) executes via upstream", echo.result?.content?.[0]?.text === "echo: hello", JSON.stringify(echo).slice(0, 200));
  const echoUp = upstreamCalls().find((c) => c.tool === "echo");
  check("upstream saw echo with audit_seen=true (record written BEFORE execution)", echoUp?.audit_seen === true, JSON.stringify(echoUp));
  const add = await callTool("add", { a: 2, b: 40 });
  check("add (READ) executes and computes", add.result?.content?.[0]?.text === "42", JSON.stringify(add).slice(0, 200));

  // 3. SPEND denied by locked rule, never reaches upstream — with hostile overlay active
  const buy = await callTool("buy", { item: "gift card", amount: 25 });
  const buyGg = buy.error?.data?.ghostguard;
  check("buy (SPEND) blocked with JSON-RPC error", !!buy.error, JSON.stringify(buy).slice(0, 300));
  check("buy verdict=deny, rule=no-spend-ever (locked rule held against hostile overlay)",
    buyGg?.verdict === "deny" && buyGg?.rule_id === "no-spend-ever", JSON.stringify(buyGg));
  check("buy NEVER reached upstream", !upstreamSaw("buy"));

  // 4. DELETE denied
  const del = await callTool("delete_file", { path: "/tmp/important" });
  check("delete_file (DELETE) verdict=deny rule=no-delete-ever, never forwarded",
    del.error?.data?.ghostguard?.verdict === "deny" && del.error?.data?.ghostguard?.rule_id === "no-delete-ever" && !upstreamSaw("delete_file"),
    JSON.stringify(del.error?.data?.ghostguard));

  // 5. PUBLISH hand_off blocked
  const pub = await callTool("publish_post", { title: "hello world" });
  check("publish_post (PUBLISH) verdict=hand_off to owner, never forwarded",
    pub.error?.data?.ghostguard?.verdict === "hand_off" && pub.error?.data?.ghostguard?.handoff_to === "owner" && !upstreamSaw("publish_post"),
    JSON.stringify(pub.error?.data?.ghostguard));

  // 6. COMMUNICATE ask blocked while unapproved
  const emailArgs = { to: "client@example.com", body: "hi" };
  const mail1 = await callTool("send_email", emailArgs);
  const mailGg = mail1.error?.data?.ghostguard;
  check("send_email (COMMUNICATE) blocked verdict=ask rule=comms-ask, never forwarded",
    mailGg?.verdict === "ask" && mailGg?.rule_id === "comms-ask" && !upstreamSaw("send_email"), JSON.stringify(mailGg));
  check("blocked ask error names the verdict + rule and carries an args_hash",
    /verdict=ask/.test(mail1.error?.message ?? "") && /comms-ask/.test(mail1.error?.message ?? "") && typeof mailGg?.args_hash === "string" && mailGg.args_hash.length === 64,
    mail1.error?.message);

  // 7. approval flow via the real approve CLI, then retry
  const approve = spawnSync(process.execPath, [
    join(pkgRoot, "src", "approve.mjs"),
    "--approvals", approvalsFile,
    "--tool", "send_email",
    "--args", JSON.stringify(emailArgs),
    "--by", "test-human",
  ], { encoding: "utf8" });
  check("approve CLI writes the approval", approve.status === 0 && existsSync(approvalsFile), approve.stderr || approve.stdout);
  const mail2 = await callTool("send_email", emailArgs);
  check("approved send_email (exact args) now executes via upstream",
    mail2.result && !mail2.error && upstreamSaw("send_email"), JSON.stringify(mail2).slice(0, 200));
  const mailUp = upstreamCalls().find((c) => c.tool === "send_email");
  check("approved execution was also record-first (audit_seen=true)", mailUp?.audit_seen === true, JSON.stringify(mailUp));
  const mail3 = await callTool("send_email", { to: "someone-else@example.com", body: "hi" });
  check("send_email with DIFFERENT args stays blocked (approval is exact-args)",
    mail3.error?.data?.ghostguard?.verdict === "ask", JSON.stringify(mail3.error?.data?.ghostguard));

  // 8. unmapped tool fails closed
  const mystery = await callTool("mystery_tool", { x: "1" });
  const mysGg = mystery.error?.data?.ghostguard;
  check("mystery_tool (unmapped) fails closed: defaultClass EXECUTE -> verdict=ask, never forwarded",
    mysGg?.verdict === "ask" && mysGg?.permission_class === "EXECUTE" && mysGg?.mapped === false && !upstreamSaw("mystery_tool"),
    JSON.stringify(mysGg));

  // 10. audit trail completeness + order
  const records = auditRecords();
  const verdicts = records.map((r) => `${r.action_payload.tool}:${r.verdict}`);
  check("audit trail holds a record for every tools/call (9 calls)",
    records.length === 9, `got ${records.length}: ${verdicts.join(", ")}`);
  check("audit order matches call order (echo, add, buy, delete_file, publish_post, send_email x3, mystery_tool)",
    JSON.stringify(records.map((r) => r.action_payload.tool)) === JSON.stringify(["echo", "add", "buy", "delete_file", "publish_post", "send_email", "send_email", "send_email", "mystery_tool"]),
    verdicts.join(", "));
  check("every record names its deciding rule (or the fail-closed default)",
    records.every((r) => typeof r.reason === "string" && r.reason.length > 0 && "rule_id" in r));
  const approvedRecord = records.filter((r) => r.action_payload.tool === "send_email")[1];
  check("approved retry's record shows verdict=allow", approvedRecord?.verdict === "allow", JSON.stringify(approvedRecord?.verdict));
} catch (e) {
  failed += 1;
  console.log(`  ✗ suite crashed: ${e.message}`);
} finally {
  proxy.stdin.end();
  proxy.kill();
}

console.log(`\nghostguard-mcp: ${passed} passed, ${failed} failed${failed ? `\nproxy stderr:\n${proxyStderr}` : ""}`);
process.exit(failed === 0 ? 0 : 1);
