#!/usr/bin/env node
/**
 * GhostGuard CI gate — the local form of the composite GitHub Action.
 *
 * Reads a GhostGuard trail (JSONL) and decides whether ONE required
 * action may proceed in this workflow:
 *
 *   PASS only when the trail holds a record for the required
 *   action_id whose verdict is allow or pre_approved — and, when
 *   --require-approval is set, a matching approval (decision) entry
 *   for that action_id. Everything else FAILS (exit 1): missing
 *   record, ask / hand_off / deny verdict, missing approval, or a
 *   trail that can't be read. Fail-closed, like the engine.
 *
 * Trail format: one JSON object per line, either shape —
 *   gateway record (from createJsonlRecorder):
 *     { action_id, verdict, ... }
 *   cloud store entry:
 *     { entry_type: "record",   record: { action_id, verdict, ... } }
 *     { entry_type: "decision", action_id, decision: "approve"|"deny", approver }
 * A plain decision line { action_id, decision: "approve", approver }
 * (no entry_type) is also accepted as an approval entry.
 *
 * Usage:
 *   node gate.mjs --trail <file> --action-id <id> [--require-approval]
 * Exit codes: 0 pass, 1 gate failure, 2 usage/IO error (also a fail
 * for CI purposes — the step does not succeed).
 */
import { readFileSync } from "node:fs";

function fail(msg) {
  console.error(`ghostguard-gate: FAIL — ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { trail: null, actionId: null, requireApproval: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--trail") out.trail = argv[++i];
    else if (a === "--action-id") out.actionId = argv[++i];
    else if (a === "--require-approval") out.requireApproval = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: node gate.mjs --trail <file> --action-id <id> [--require-approval]");
      process.exit(0);
    } else {
      console.error(`ghostguard-gate: unknown argument ${a}`);
      process.exit(2);
    }
  }
  if (!out.trail || !out.actionId) {
    console.error("ghostguard-gate: --trail and --action-id are required");
    process.exit(2);
  }
  return out;
}

export function readTrail(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`ghostguard-gate: cannot read trail ${file}: ${e.message}`);
    process.exit(2);
  }
  const records = [];
  const decisions = [];
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  lines.forEach((line, idx) => {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      console.error(`ghostguard-gate: trail line ${idx + 1} is not valid JSON`);
      process.exit(2);
    }
    if (obj.entry_type === "record" && obj.record) records.push(obj.record);
    else if (obj.entry_type === "decision") decisions.push(obj);
    else if (obj.action_id && typeof obj.verdict === "string") records.push(obj);
    else if (obj.action_id && typeof obj.decision === "string") decisions.push(obj);
    // Unknown line shapes are ignored — they are neither a record
    // for our action nor an approval for it, and the gate fails
    // closed on absence, so ignoring them grants nothing.
  });
  return { records, decisions };
}

export function gateCheck({ records, decisions }, actionId, requireApproval) {
  const rec = records.find((r) => r.action_id === actionId);
  if (!rec) return { ok: false, reason: `no record for action_id "${actionId}" in the trail` };
  if (rec.verdict !== "allow" && rec.verdict !== "pre_approved") {
    return {
      ok: false,
      reason: `record for "${actionId}" has verdict "${rec.verdict}" (rule: ${rec.rule_id ?? "none"}) — only allow/pre_approved pass`,
    };
  }
  if (requireApproval) {
    const approval = decisions.find((d) => d.action_id === actionId && d.decision === "approve");
    if (!approval) {
      return { ok: false, reason: `"${actionId}" is ${rec.verdict} but --require-approval is set and no approval decision entry matches it` };
    }
    return { ok: true, reason: `"${actionId}" verdict=${rec.verdict} (rule: ${rec.rule_id ?? "none"}), approved by ${approval.approver ?? "unknown approver"}` };
  }
  return { ok: true, reason: `"${actionId}" verdict=${rec.verdict} (rule: ${rec.rule_id ?? "none"})` };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const trail = readTrail(args.trail);
  const result = gateCheck(trail, args.actionId, args.requireApproval);
  if (!result.ok) fail(result.reason);
  console.log(`ghostguard-gate: PASS — ${result.reason}`);
}
