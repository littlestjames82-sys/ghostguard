#!/usr/bin/env node
/**
 * Fake upstream MCP server — test/demo fixture for ghostguard-mcp.
 *
 * Speaks newline-delimited JSON-RPC MCP on stdio and implements:
 * initialize, ping, tools/list, tools/call.
 *
 * Tools (the sample config classifies them; mystery_tool is
 * deliberately left unmapped there):
 *   echo        (sample class READ)         returns its `message` arg
 *   add         (sample class READ)         returns a + b
 *   write_note  (sample class WRITE_LOCAL)  pretends to write a note
 *   send_email  (sample class COMMUNICATE)  pretends to send email
 *   buy         (sample class SPEND)        pretends to buy something
 *   delete_file (sample class DELETE)       pretends to delete a file
 *   publish_post(sample class PUBLISH)      pretends to publish
 *   mystery_tool(no sample mapping)         exists upstream, unmapped
 *
 * Proof hooks for the test suite:
 *   FAKE_UPSTREAM_LOG       — every tools/call that REACHES this
 *                             server is appended here as JSONL. If a
 *                             call is absent from this log, it never
 *                             reached the upstream.
 *   FAKE_UPSTREAM_AUDIT_FILE — the proxy's audit file. On each call
 *                             the fixture checks whether the audit
 *                             trail ALREADY holds an allow/pre_approved
 *                             record for this exact tool+arguments,
 *                             and logs that as `audit_seen`. True
 *                             proves record-before-execution.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG = process.env.FAKE_UPSTREAM_LOG;
const AUDIT = process.env.FAKE_UPSTREAM_AUDIT_FILE;

const TOOLS = [
  { name: "echo", description: "Echo back the message argument.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
  { name: "write_note", description: "Write a local note.", inputSchema: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } } } },
  { name: "send_email", description: "Send an email.", inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } } } },
  { name: "buy", description: "Buy something (spends money).", inputSchema: { type: "object", properties: { item: { type: "string" }, amount: { type: "number" } } } },
  { name: "delete_file", description: "Delete a file.", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "publish_post", description: "Publish a post.", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
  { name: "mystery_tool", description: "A tool the proxy config does not map.", inputSchema: { type: "object", properties: { x: { type: "string" } } } },
];

function auditAlreadyRecorded(tool, args) {
  if (!AUDIT || !existsSync(AUDIT)) return false;
  const lines = readFileSync(AUDIT, "utf8").split("\n").filter((l) => l.trim());
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const p = rec.action_payload ?? {};
    if (p.tool !== tool) continue;
    if (!["allow", "pre_approved"].includes(rec.verdict)) continue;
    if (JSON.stringify(p.arguments ?? {}) === JSON.stringify(args ?? {})) return true;
  }
  return false;
}

function logCall(tool, args, auditSeen) {
  if (!LOG) return;
  appendFileSync(LOG, `${JSON.stringify({ tool, arguments: args, audit_seen: auditSeen, at: new Date().toISOString() })}\n`, "utf8");
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return; // notification: nothing to do

  switch (msg.method) {
    case "initialize":
      reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-upstream", version: "0.1.0" },
      });
      return;
    case "ping":
      reply(msg.id, {});
      return;
    case "tools/list":
      reply(msg.id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      const auditSeen = auditAlreadyRecorded(name, args);
      logCall(name, args, auditSeen);
      if (!TOOLS.some((t) => t.name === name)) {
        replyError(msg.id, -32602, `unknown tool: ${name}`);
        return;
      }
      let text;
      if (name === "echo") text = `echo: ${args.message ?? ""}`;
      else if (name === "add") text = String((args.a ?? 0) + (args.b ?? 0));
      else text = `${name} executed with ${JSON.stringify(args)}`;
      reply(msg.id, { content: [{ type: "text", text }], isError: false });
      return;
    }
    default:
      replyError(msg.id, -32601, `method not found: ${msg.method}`);
  }
});
