#!/usr/bin/env node
/**
 * ghostguard-mcp-approve — add (or list) carried approvals.
 *
 * A human runs this to approve ONE exact tool call: the approval is
 * the SHA-256 of the canonical { tool, arguments }, so it covers
 * that tool with those exact arguments and nothing else. The hash
 * can be computed from the intended call (below) or copied from the
 * `args_hash` in a blocked call's GhostGuard error.
 *
 * Usage:
 *   node src/approve.mjs --approvals <file> --tool <name> --args '<json>' [--by <name>] [--note <text>]
 *   node src/approve.mjs --approvals <file> --hash <sha256> [--tool <name>] [--by <name>]
 *   node src/approve.mjs --approvals <file> --list
 *   node src/approve.mjs --approvals <file> --revoke <sha256>
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { approvalHash } from "./hash.mjs";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(flag) {
  return process.argv.includes(flag);
}

const approvalsFile = arg("--approvals") ?? process.env.GHOSTGUARD_MCP_APPROVALS;
if (!approvalsFile) {
  process.stderr.write("error: --approvals <file> is required\n");
  process.exit(2);
}

function load() {
  if (!existsSync(approvalsFile)) return [];
  const text = readFileSync(approvalsFile, "utf8").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : parsed.approvals ?? [];
}
function save(entries) {
  mkdirSync(dirname(approvalsFile) || ".", { recursive: true });
  writeFileSync(approvalsFile, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

if (has("--list")) {
  const entries = load();
  if (entries.length === 0) process.stdout.write("(no approvals)\n");
  for (const e of entries) process.stdout.write(`${e.args_hash}  tool=${e.tool ?? "?"}  by=${e.approved_by ?? "?"}  at=${e.approved_at ?? "?"}\n`);
  process.exit(0);
}

if (has("--revoke")) {
  const hash = arg("--revoke");
  const before = load();
  const after = before.filter((e) => e.args_hash !== hash && e.hash !== hash);
  save(after);
  process.stdout.write(`revoked ${before.length - after.length} approval(s) for hash ${hash}\n`);
  process.exit(0);
}

let hash = arg("--hash");
const tool = arg("--tool");
if (!hash) {
  if (!tool) {
    process.stderr.write("error: --tool is required when computing a hash from a call\n");
    process.exit(2);
  }
  let args = {};
  if (arg("--args")) {
    try { args = JSON.parse(arg("--args")); } catch (e) {
      process.stderr.write(`error: --args is not valid JSON: ${e.message}\n`);
      process.exit(2);
    }
  }
  hash = approvalHash(tool, args);
}

const entries = load();
if (entries.some((e) => e.args_hash === hash)) {
  process.stdout.write(`already approved: ${hash}\n`);
  process.exit(0);
}
entries.push({
  tool: tool ?? null,
  args_hash: hash,
  approved_by: arg("--by") ?? "unknown",
  approved_at: new Date().toISOString(),
  ...(arg("--note") ? { note: arg("--note") } : {}),
});
save(entries);
process.stdout.write(`approved ${tool ?? "(by hash)"} — args_hash ${hash} written to ${approvalsFile}\n`);
