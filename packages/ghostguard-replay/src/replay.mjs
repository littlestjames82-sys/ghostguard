#!/usr/bin/env node
/**
 * ghostguard-replay — Policy Replay / Backtest.
 *
 * Takes a JSONL trail of real GhostGuard GatewayRecords and a NEW
 * policy document (GhostGuard PolicyDoc format), re-evaluates each
 * recorded action's intent through the REAL GhostGuard engine
 * (compilePolicy / evaluatePolicy from the published ghostguard package — this package
 * never modifies the core), and diffs old verdict vs new verdict.
 *
 * The dangerous direction is LOOSENING: a new policy that would have
 * allowed (or asked less strictly about) actions the old policy
 * stopped. Loosening is totalled separately, listed per record, and
 * flagged loudly in the human summary.
 *
 * Replay context: the engine needs (kind, permission_class, actor,
 * project_id, approved, initiator, payload). A GatewayRecord carries
 * all of those EXCEPT `approved` — the record contract does not store
 * the carried-approval flag. Replay therefore uses a top-level boolean
 * `approved` when the trail carries one, and assumes false otherwise.
 * That assumption is stated in every report (`approvedAssumption`).
 *
 * Usage:
 *   node src/replay.mjs --trail <trail.jsonl> --policy <policy.json>
 *                       [--project <id>] [--out <report.json>] [--json]
 *
 * Exit codes: 0 = clean diff produced; 1 = malformed trail lines were
 * found (the diff over the valid records is still produced and
 * reported first); 2 = usage / IO / policy error.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compilePolicy, evaluatePolicy } from "ghostguard";
import { loadTrail } from "./trail.mjs";

/**
 * How permissive a verdict is — higher executes more freely.
 * allow executes unconditionally; pre_approved executes under a
 * standing approval; ask / hand_off do not execute (a human or a
 * different approver is involved); deny never executes.
 */
export const PERMISSIVENESS = {
  deny: 0,
  hand_off: 1,
  ask: 2,
  pre_approved: 3,
  allow: 4,
};

export function categorize(oldVerdict, newVerdict) {
  if (oldVerdict === newVerdict) {
    return { category: "unchanged", direction: "unchanged" };
  }
  const delta = PERMISSIVENESS[newVerdict] - PERMISSIVENESS[oldVerdict];
  const direction = delta > 0 ? "loosened" : "tightened";
  if (newVerdict === "deny") return { category: "would-deny", direction };
  if (newVerdict === "hand_off") return { category: "would-handoff", direction };
  if (newVerdict === "ask") return { category: "would-ask", direction };
  if (
    (newVerdict === "allow" || newVerdict === "pre_approved") &&
    (oldVerdict === "deny" || oldVerdict === "hand_off" || oldVerdict === "ask")
  ) {
    return { category: "would-execute", direction };
  }
  return {
    category: direction === "loosened" ? "loosened-other" : "tightened-other",
    direction,
  };
}

/** Rebuild the engine context for one recorded action. */
export function contextFromRecord(record) {
  return {
    kind: record.kind,
    permission_class: record.permission_class ?? null,
    actor: typeof record.actor === "string" ? record.actor : "",
    project_id: typeof record.project_id === "string" ? record.project_id : "",
    approved: typeof record.approved === "boolean" ? record.approved : false,
    initiator: record.initiator ?? null,
    payload:
      record.action_payload && typeof record.action_payload === "object"
        ? record.action_payload
        : {},
  };
}

/**
 * Replay records through a compiled policy. Pure and deterministic:
 * same trail + same policy doc -> same report.
 */
export function replayRecords(records, policyDoc) {
  const policy = compilePolicy(policyDoc);
  const diffs = records.map((record) => {
    const decision = evaluatePolicy(policy, contextFromRecord(record));
    const { category, direction } = categorize(record.verdict, decision.verdict);
    return {
      action_id: record.action_id,
      line: record._line ?? null,
      kind: record.kind,
      permission_class: record.permission_class ?? null,
      actor: record.actor ?? null,
      initiator: record.initiator ?? null,
      project_id: record.project_id ?? null,
      old_verdict: record.verdict,
      old_rule_id: record.rule_id ?? null,
      new_verdict: decision.verdict,
      new_rule_id: decision.rule_id,
      new_reason: decision.reason,
      category,
      direction,
    };
  });

  const count = (pred) => diffs.filter(pred).length;
  const loosened = diffs.filter((d) => d.direction === "loosened");
  const summary = {
    total: diffs.length,
    unchanged: count((d) => d.category === "unchanged"),
    changed: count((d) => d.category !== "unchanged"),
    wouldDeny: count((d) => d.category === "would-deny"),
    wouldHandoff: count((d) => d.category === "would-handoff"),
    wouldAsk: count((d) => d.category === "would-ask"),
    wouldExecute: count((d) => d.category === "would-execute"),
    tightened: count((d) => d.direction === "tightened"),
    loosened: loosened.length,
  };
  return {
    summary,
    // The dangerous direction, called out on its own.
    danger: loosened.length > 0,
    looseningActionIds: loosened.map((d) => d.action_id),
    diffs,
  };
}

export function buildReplayReport({ trailSource, policySource, records, errors, policyDoc, projectId }) {
  const replay = replayRecords(records, policyDoc);
  return {
    tool: "ghostguard-replay",
    version: "0.1.0",
    trail: trailSource,
    policy: policySource,
    projectFilter: projectId ?? null,
    approvedAssumption:
      "context.approved = the record's top-level boolean `approved` when present, else false — the GatewayRecord contract does not store the carried-approval flag",
    malformedLines: errors,
    ...replay,
  };
}

export function formatReplayHuman(report) {
  const s = report.summary;
  const lines = [];
  lines.push(`GhostGuard Replay — ${s.total} record(s) from ${report.trail}`);
  lines.push(`New policy: ${report.policy}`);
  if (report.projectFilter) lines.push(`Project filter: ${report.projectFilter}`);
  lines.push("");
  lines.push(`  unchanged:     ${s.unchanged}`);
  lines.push(`  would-deny:    ${s.wouldDeny}`);
  lines.push(`  would-handoff: ${s.wouldHandoff}`);
  lines.push(`  would-ask:     ${s.wouldAsk}`);
  lines.push(`  would-execute: ${s.wouldExecute}  (blocked before, would run now)`);
  lines.push(`  tightened:     ${s.tightened}`);
  lines.push(`  loosened:      ${s.loosened}`);
  lines.push("");
  if (report.danger) {
    lines.push(
      `⚠⚠ LOOSENING WARNING: this policy would have been MORE permissive on ${s.loosened} past action(s)` +
        ` — ${s.wouldExecute} of them were stopped before (deny/ask/hand_off) and would EXECUTE now.`,
    );
    lines.push("   Loosening is the dangerous direction. Review every record below before activating:");
    for (const d of report.diffs.filter((x) => x.direction === "loosened")) {
      lines.push(
        `   ⚠ ${d.action_id} ${d.kind} (${d.permission_class}): ${d.old_verdict} [${d.old_rule_id ?? "no rule"}] -> ${d.new_verdict} [${d.new_rule_id ?? "no rule"}]`,
      );
    }
    lines.push("");
  } else if (s.total > 0) {
    lines.push("✓ No loosening: this policy is nowhere more permissive than the recorded verdicts.");
    lines.push("");
  }
  const changed = report.diffs.filter((d) => d.category !== "unchanged");
  if (changed.length > 0) {
    lines.push("Changed records:");
    for (const d of changed) {
      lines.push(
        `  ${d.action_id} ${d.kind} (${d.permission_class}, initiator=${d.initiator}): ${d.old_verdict} -> ${d.new_verdict} [${d.category}; new rule: ${d.new_rule_id ?? "no-match deny"}]`,
      );
    }
    lines.push("");
  }
  if (s.total === 0) {
    lines.push("Trail held no replayable records — nothing to diff.");
  }
  if (report.malformedLines.length > 0) {
    lines.push(`Malformed trail lines (reported, NOT silently skipped): ${report.malformedLines.length}`);
    for (const e of report.malformedLines) lines.push(`  line ${e.line}: ${e.message}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--trail") args.trail = argv[++i];
    else if (a === "--policy") args.policy = argv[++i];
    else if (a === "--project") args.project = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--json") args.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.trail) throw new Error("--trail <trail.jsonl> is required");
  if (!args.policy) throw new Error("--policy <policy.json> is required");
  return args;
}

export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`ghostguard-replay: ${err.message}`);
    console.error("usage: node src/replay.mjs --trail <trail.jsonl> --policy <policy.json> [--project <id>] [--out <report.json>] [--json]");
    return 2;
  }
  let loaded, policyDoc;
  try {
    loaded = loadTrail(args.trail);
    policyDoc = JSON.parse(readFileSync(args.policy, "utf8"));
  } catch (err) {
    console.error(`ghostguard-replay: ${err.message}`);
    return 2;
  }
  let records = loaded.records;
  if (args.project) records = records.filter((r) => r.project_id === args.project);
  const report = buildReplayReport({
    trailSource: args.trail,
    policySource: args.policy,
    records,
    errors: loaded.errors,
    policyDoc,
    projectId: args.project ?? null,
  });
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n");
  console.log(args.json ? JSON.stringify(report, null, 2) : formatReplayHuman(report));
  if (loaded.errors.length > 0) {
    console.error(`ghostguard-replay: ${loaded.errors.length} malformed trail line(s) — see report`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
