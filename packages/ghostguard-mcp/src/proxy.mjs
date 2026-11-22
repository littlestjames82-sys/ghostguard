#!/usr/bin/env node
/**
 * GhostGuard MCP proxy — a governed MCP server.
 *
 * It speaks MCP (stdio, newline-delimited JSON-RPC) to the client and
 * proxies one upstream MCP server (spawned as a child process, same
 * transport). tools/list and everything else are forwarded untouched,
 * EXCEPT tools/call, which is governed:
 *
 *   1. Classify — the tool name is mapped to a GhostGuard
 *      PermissionClass via the config's toolClasses map. An unmapped
 *      tool gets the config's defaultClass (EXECUTE unless changed):
 *      a consequential class the sample policy asks on. Fail closed.
 *   2. Decide — the GhostGuard policy (base doc optionally merged
 *      with an overlay via mergePolicyDocs, so locked base rules
 *      cannot be weakened by the overlay) is evaluated with
 *      `approved` set from the local approvals file (an entry whose
 *      args_hash matches this exact tool + arguments).
 *   3. Record — a complete gateway record is assembled and appended
 *      to the JSONL audit file via GhostGuard's createJsonlRecorder
 *      BEFORE anything is forwarded. If the recorder throws, the
 *      call is not forwarded: no record, no action.
 *   4. Act — only allow / pre_approved verdicts are forwarded to the
 *      upstream. ask / hand_off / deny are blocked here and returned
 *      as a JSON-RPC error naming the verdict, the deciding rule,
 *      the reason, and (for ask) the approval hash a human can add
 *      to the approvals file to carry an approval for that exact
 *      call. `ask` means blocked until approved — the proxy never
 *      prompts on the stdio channel (that channel is the protocol).
 *
 * GhostGuard itself is imported from the published ghostguard
 * package — this package's only runtime dependency — and the core
 * package is never modified.
 *
 * Usage:
 *   node src/proxy.mjs --config <config.json>
 *   GHOSTGUARD_MCP_CONFIG=<config.json> node src/proxy.mjs
 *
 * All diagnostics go to stderr; stdout is the MCP protocol channel.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  compilePolicy,
  evaluatePolicy,
  gatewayRecordFromDecision,
  createJsonlRecorder,
  mergePolicyDocs,
} from "ghostguard";
import { loadConfig } from "./config.mjs";
import { approvalHash } from "./hash.mjs";
import { isApproved } from "./approvals.mjs";

function log(...parts) {
  process.stderr.write(`[ghostguard-mcp] ${parts.join(" ")}\n`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--config") out.config = argv[i + 1];
  }
  return out;
}

const cli = parseArgs(process.argv.slice(2));
let config;
try {
  config = loadConfig(cli.config ?? process.env.GHOSTGUARD_MCP_CONFIG);
} catch (e) {
  log(`startup failed: ${e.message}`);
  process.exit(2);
}

const policyDoc = config.overlayDoc
  ? mergePolicyDocs(config.policyDoc, config.overlayDoc)
  : config.policyDoc;
const policy = compilePolicy(policyDoc);
for (const rule of policy.rules) {
  if (rule.error) log(`warning: policy rule "${rule.id}" failed to compile (${rule.error}) — the engine fails closed for restrictive effects`);
}

let recorder;
try {
  recorder = createJsonlRecorder(config.auditFile);
} catch (e) {
  log(`startup failed: cannot open audit file ${config.auditFile}: ${e.message}`);
  process.exit(2);
}

// ── Upstream child process ──────────────────────────────────────────

const upstream = spawn(config.upstream.command, config.upstream.args, {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, ...config.upstream.env },
  cwd: config.upstream.cwd,
});
upstream.on("error", (e) => {
  log(`upstream spawn error: ${e.message}`);
  process.exit(1);
});
upstream.on("exit", (code, signal) => {
  log(`upstream exited (code=${code} signal=${signal ?? "none"}) — proxy shutting down`);
  process.exit(code ?? 0);
});

/** Client requests forwarded to the upstream, by JSON-RPC id. */
const pending = new Map();

function sendToClient(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function sendToUpstream(obj) {
  upstream.stdin.write(`${JSON.stringify(obj)}\n`);
}

const upstreamLines = createInterface({ input: upstream.stdout, crlfDelay: Infinity });
upstreamLines.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    log("upstream sent a non-JSON line; dropping it");
    return;
  }
  const isResponse = msg && (("result" in msg) || ("error" in msg)) && msg.id !== undefined && msg.id !== null;
  if (isResponse && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
    return;
  }
  // Anything else (upstream-initiated requests / notifications) is
  // forwarded to the client untouched.
  sendToClient(msg);
});

function forwardRequest(msg) {
  return new Promise((resolve, reject) => {
    pending.set(msg.id, { resolve, reject });
    try {
      sendToUpstream(msg);
    } catch (e) {
      pending.delete(msg.id);
      reject(e);
    }
  });
}

// ── Governance for tools/call ───────────────────────────────────────

function classify(toolName) {
  if (Object.prototype.hasOwnProperty.call(config.toolClasses, toolName)) {
    return { permissionClass: config.toolClasses[toolName], mapped: true };
  }
  return { permissionClass: config.defaultClass, mapped: false };
}

async function handleToolsCall(msg) {
  const params = msg.params ?? {};
  const tool = typeof params.name === "string" ? params.name : "";
  const args = (params.arguments && typeof params.arguments === "object") ? params.arguments : {};
  const { permissionClass, mapped } = classify(tool);
  const hash = approvalHash(tool, args);

  let approved = false;
  try {
    approved = isApproved(config.approvalsFile, hash);
  } catch (e) {
    // A broken approvals file can never grant anything (fail closed):
    // treat as unapproved and say so on stderr.
    log(`approvals file unreadable (${e.message}) — treating call as unapproved`);
    approved = false;
  }

  const decision = evaluatePolicy(policy, {
    kind: "mcp.tools/call",
    permission_class: permissionClass,
    actor: config.actor,
    project_id: config.projectId,
    approved,
    initiator: config.initiator,
    payload: { tool, arguments: args },
  });

  const record = gatewayRecordFromDecision({
    action_id: `mcp-${randomUUID()}`,
    kind: "mcp.tools/call",
    permission_class: permissionClass,
    actor: config.actor,
    initiator: config.initiator,
    project_id: config.projectId,
    target_ref: tool || null,
    target: { tool, mapped },
    action_payload: { tool, arguments: args, args_hash: hash },
  }, decision);

  // Record FIRST. A throwing recorder means the call never runs.
  try {
    recorder(record);
  } catch (e) {
    log(`audit write failed for action ${record.action_id}: ${e.message} — call NOT forwarded`);
    return {
      jsonrpc: "2.0",
      id: msg.id,
      error: {
        code: -32050,
        message: `GhostGuard blocked tools/call: audit record could not be written (${e.message}); no record, no action.`,
        data: { ghostguard: { verdict: "deny", rule_id: null, reason: "recorder failure — fail closed", action_id: record.action_id } },
      },
    };
  }

  if (decision.verdict === "allow" || decision.verdict === "pre_approved") {
    return forwardRequest(msg);
  }

  const approvalHint = decision.verdict === "ask"
    ? ` To approve this exact call, add its hash to the approvals file (${config.approvalsFile}) with: node src/approve.mjs --approvals ${config.approvalsFile} --tool ${JSON.stringify(tool)} --args '${JSON.stringify(args)}' — then retry the call.`
    : "";
  log(`blocked tools/call tool=${tool} class=${permissionClass} verdict=${decision.verdict} rule=${decision.rule_id} action=${record.action_id}`);
  return {
    jsonrpc: "2.0",
    id: msg.id,
    error: {
      code: -32042,
      message: `GhostGuard blocked tools/call "${tool}": verdict=${decision.verdict} rule=${decision.rule_id ?? "(none — fail-closed default)"} — ${decision.reason}.${approvalHint}`,
      data: {
        ghostguard: {
          verdict: decision.verdict,
          rule_id: decision.rule_id,
          reason: decision.reason,
          handoff_to: decision.handoff_to,
          permission_class: permissionClass,
          mapped,
          action_id: record.action_id,
          args_hash: hash,
        },
      },
    },
  };
}

// ── Client (proxy stdin) loop ───────────────────────────────────────

const clientLines = createInterface({ input: process.stdin, crlfDelay: Infinity });
clientLines.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    log("client sent a non-JSON line; dropping it");
    return;
  }
  // Notifications (no id) are forwarded as-is, including
  // notifications/initialized and notifications/cancelled.
  if (msg.id === undefined || msg.id === null) {
    if (upstream.stdin.writable) sendToUpstream(msg);
    return;
  }
  if (msg.method === "tools/call") {
    const response = await handleToolsCall(msg);
    if (response) sendToClient(response);
    return;
  }
  // initialize, tools/list, ping, resources/*, prompts/*, … :
  // forwarded untouched; governance applies to tools/call only.
  const response = await forwardRequest(msg);
  sendToClient(response);
});
clientLines.on("close", () => {
  if (upstream.stdin.writable) upstream.stdin.end();
  upstream.kill();
});

log(`proxying upstream "${config.upstream.command} ${config.upstream.args.join(" ")}" — audit: ${config.auditFile} — approvals: ${config.approvalsFile}`);
