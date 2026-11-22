#!/usr/bin/env node
/**
 * ghostguard-score — Guard Score.
 *
 * Computes a structural 0–100 score from a JSONL trail of GhostGuard
 * GatewayRecords. "Structural" means every point comes from a published
 * formula over countable properties of the trail (see WEIGHTS and the
 * README) — the score is deterministic, reproducible, and always
 * reported with its per-component breakdown. It is a description of
 * how the trail is governed and recorded, NOT a certification of
 * anything (see README honesty note).
 *
 * Components whose inputs a trail does not carry are NOT guessed:
 * they are marked scored=false, excluded, and the total is
 * renormalised over the weights that were scored. The breakdown says
 * which and why. An empty trail scores null (insufficient data) —
 * never 100.
 *
 * Usage:
 *   node src/score.mjs --trail <trail.jsonl>
 *                      [--policy <policy.json>]  (the policy the trail
 *                        was recorded under — needed for locked-rule hits)
 *                      [--project <id>] [--out <score.json>] [--json]
 *
 * Exit codes: 0 = scored (or honestly insufficient data); 1 =
 * malformed trail lines found (score still produced and reported);
 * 2 = usage / IO error.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadTrail, VERDICTS } from "./trail.mjs";

export const WEIGHTS = {
  completeness: 30,
  gateEngagement: 20,
  lockedRuleHits: 15,
  unattendedStrictness: 15,
  handoffRouting: 10,
  outcomeTracking: 10,
};

const PERMISSION_CLASSES = [
  "READ", "WRITE_LOCAL", "EXECUTE", "NETWORK_WRITE",
  "DEPLOY", "PUBLISH", "COMMUNICATE", "SPEND", "DELETE",
];
const INITIATORS = ["person", "routine", "handoff", "memory", "system"];
const UNATTENDED = new Set(["routine", "memory", "system", "handoff"]);
// Fields a later approval/outcome surface may add to a record. The core
// GatewayRecord contract defines none of them.
const OUTCOME_FIELDS = ["approved", "decision", "outcome", "executed"];

// Gate-engagement sanity band: the share of records the gate actually
// engaged (deny + ask + hand_off). Below 5% the gate is barely
// engaging; 5%–50% is the healthy band; above 50% it declines linearly
// to 0 at 100% (a gate that stops almost everything is friction, not
// governance).
export const GATE_BAND = { low: 0.05, high: 0.5 };

export function gateEngagementRatio(gatedRate) {
  if (gatedRate < GATE_BAND.low) return gatedRate / GATE_BAND.low;
  if (gatedRate <= GATE_BAND.high) return 1;
  return 1 - (gatedRate - GATE_BAND.high) / (1 - GATE_BAND.high);
}

// Locked-rule hits saturate at 10% of records: a locked layer that
// fires on at least 1 in 10 actions is demonstrably load-bearing.
export const LOCKED_SATURATION = 0.1;

/** The 15 completeness checks every record is measured against. */
export const COMPLETENESS_CHECKS = [
  ["action_id", (r) => typeof r.action_id === "string" && r.action_id !== ""],
  ["kind", (r) => typeof r.kind === "string" && r.kind !== ""],
  ["permission_class", (r) => PERMISSION_CLASSES.includes(r.permission_class)],
  ["actor", (r) => typeof r.actor === "string" && r.actor !== ""],
  ["initiator", (r) => INITIATORS.includes(r.initiator)],
  ["project_id", (r) => typeof r.project_id === "string" && r.project_id !== ""],
  ["verdict", (r) => VERDICTS.includes(r.verdict)],
  ["rule_id", (r) => Object.hasOwn(r, "rule_id") && (typeof r.rule_id === "string" || r.rule_id === null)],
  ["reason", (r) => typeof r.reason === "string" && r.reason !== ""],
  ["handoff_to", (r) => Object.hasOwn(r, "handoff_to") && (typeof r.handoff_to === "string" || r.handoff_to === null)],
  ["target_ref", (r) => Object.hasOwn(r, "target_ref") && (typeof r.target_ref === "string" || r.target_ref === null)],
  ["snapshot_id", (r) => Object.hasOwn(r, "snapshot_id") && (typeof r.snapshot_id === "string" || r.snapshot_id === null)],
  ["target", (r) => Object.hasOwn(r, "target") && (r.target === null || (typeof r.target === "object" && !Array.isArray(r.target)))],
  ["action_payload", (r) => r.action_payload !== null && typeof r.action_payload === "object" && !Array.isArray(r.action_payload)],
  ["dry_run", (r) => typeof r.dry_run === "boolean"],
];

const round1 = (n) => Math.round(n * 10) / 10;
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Compute the Guard Score over parsed records. `policyDoc` (optional)
 * is the policy the trail was recorded under — only its locked rule
 * ids are used. Pure and deterministic.
 */
export function computeGuardScore(records, { policyDoc = null } = {}) {
  const total = records.length;
  if (total === 0) {
    return {
      status: "insufficient_data",
      score: null,
      totalRecords: 0,
      components: [],
      note: "empty trail — no records to score; a score is not invented",
    };
  }

  const components = [];
  const add = (id, ratio, detail, scored = true, note = null) => {
    components.push({
      id,
      weight: WEIGHTS[id],
      scored,
      ratio: scored ? round4(ratio) : null,
      points: scored ? round4(ratio * WEIGHTS[id]) : null,
      detail,
      ...(note ? { note } : {}),
    });
  };

  // 1. Completeness — average fraction of the 15 checks passed.
  let checksPassed = 0;
  let fullyClean = 0;
  for (const r of records) {
    let passed = 0;
    for (const [, check] of COMPLETENESS_CHECKS) if (check(r)) passed++;
    checksPassed += passed;
    if (passed === COMPLETENESS_CHECKS.length) fullyClean++;
  }
  add("completeness", checksPassed / (total * COMPLETENESS_CHECKS.length), {
    checksPerRecord: COMPLETENESS_CHECKS.length,
    checksPassed,
    checksTotal: total * COMPLETENESS_CHECKS.length,
    fullyCleanRecords: fullyClean,
  });

  // 2. Gate engagement — deny + ask + hand_off share vs the sanity band.
  const gated = records.filter(
    (r) => r.verdict === "deny" || r.verdict === "ask" || r.verdict === "hand_off",
  ).length;
  const gatedRate = gated / total;
  add("gateEngagement", gateEngagementRatio(gatedRate), {
    gatedRecords: gated,
    gatedRate: round4(gatedRate),
    band: GATE_BAND,
  });

  // 3. Locked-rule hits — needs the recording policy's locked rule ids.
  if (policyDoc == null) {
    add("lockedRuleHits", 0, { lockedRuleIds: null }, false,
      "no --policy supplied: which rules were locked is unknown, component not scored");
  } else {
    const lockedIds = (policyDoc.rules ?? []).filter((r) => r.locked === true).map((r) => r.id);
    if (lockedIds.length === 0) {
      add("lockedRuleHits", 0, { lockedRuleIds: [] },
        true, "the supplied policy has NO locked rules — the locked layer is absent");
    } else {
      const hits = records.filter((r) => lockedIds.includes(r.rule_id)).length;
      add("lockedRuleHits", Math.min(1, hits / total / LOCKED_SATURATION), {
        lockedRuleIds: lockedIds,
        lockedHits: hits,
        lockedHitRate: round4(hits / total),
        saturationRate: LOCKED_SATURATION,
      });
    }
  }

  // 4. Unattended strictness — unattended-initiated records should not
  // sail through on a plain allow; ask/deny/hand_off/pre_approved all
  // count as held to a standard. Vacuously 1 when a trail has no
  // unattended records (the risk is absent, not unmeasured).
  const unattended = records.filter((r) => UNATTENDED.has(r.initiator));
  if (unattended.length === 0) {
    add("unattendedStrictness", 1, { unattendedRecords: 0, heldRecords: 0 },
      true, "no unattended records in trail — vacuously held");
  } else {
    const held = unattended.filter((r) => r.verdict !== "allow").length;
    add("unattendedStrictness", held / unattended.length, {
      unattendedRecords: unattended.length,
      heldRecords: held,
    });
  }

  // 5. Hand_off routing — every hand_off record must name its target.
  const handoffs = records.filter((r) => r.verdict === "hand_off");
  if (handoffs.length === 0) {
    add("handoffRouting", 0, { handoffRecords: 0 }, false,
      "no hand_off records in trail — routing not exercised, component not scored");
  } else {
    const routed = handoffs.filter(
      (r) => typeof r.handoff_to === "string" && r.handoff_to !== "",
    ).length;
    add("handoffRouting", routed / handoffs.length, {
      handoffRecords: handoffs.length,
      routedRecords: routed,
    });
  }

  // 6. Outcome tracking — scored only when the trail carries outcome
  // fields at all (the core contract defines none, so a trail without
  // any is not punished for a field it never promised). When some
  // records carry them, decidable records (ask / hand_off) are
  // expected to: partial outcome tracking is a real gap.
  const carriesOutcome = (r) => OUTCOME_FIELDS.some((f) => Object.hasOwn(r, f));
  const anyOutcome = records.some(carriesOutcome);
  const decidable = records.filter((r) => r.verdict === "ask" || r.verdict === "hand_off");
  if (!anyOutcome) {
    add("outcomeTracking", 0, { outcomeFields: OUTCOME_FIELDS, decidableRecords: decidable.length },
      false, "trail carries no approval/outcome fields — component not scored");
  } else if (decidable.length === 0) {
    add("outcomeTracking", 0, { outcomeFields: OUTCOME_FIELDS, decidableRecords: 0 },
      false, "no decidable (ask/hand_off) records — component not scored");
  } else {
    const withOutcome = decidable.filter(carriesOutcome).length;
    add("outcomeTracking", withOutcome / decidable.length, {
      outcomeFields: OUTCOME_FIELDS,
      decidableRecords: decidable.length,
      decidableWithOutcome: withOutcome,
    });
  }

  const scoredComponents = components.filter((c) => c.scored);
  const earned = scoredComponents.reduce((sum, c) => sum + c.ratio * c.weight, 0);
  const available = scoredComponents.reduce((sum, c) => sum + c.weight, 0);
  const score = round1((earned / available) * 100);
  return {
    status: "scored",
    score,
    totalRecords: total,
    pointsEarned: round4(earned),
    pointsAvailable: available,
    components,
    note: "structural score over the trail — deterministic and explainable from the breakdown above; not a certification",
  };
}

export function buildScoreReport({ trailSource, records, errors, policyDoc, projectId }) {
  const result = computeGuardScore(records, { policyDoc });
  return {
    tool: "ghostguard-score",
    version: "0.1.0",
    trail: trailSource,
    projectFilter: projectId ?? null,
    weights: WEIGHTS,
    malformedLines: errors,
    ...result,
  };
}

export function formatScoreHuman(report) {
  const lines = [];
  lines.push(`Guard Score — ${report.totalRecords} record(s) from ${report.trail}`);
  if (report.projectFilter) lines.push(`Project filter: ${report.projectFilter}`);
  lines.push("");
  if (report.status === "insufficient_data") {
    lines.push("Score: null — insufficient data (empty trail). An empty trail is not a perfect trail.");
  } else {
    lines.push(`Score: ${report.score} / 100  (${report.pointsEarned} of ${report.pointsAvailable} available points)`);
    lines.push("");
    lines.push("Breakdown (weight × ratio = points):");
    for (const c of report.components) {
      if (!c.scored) {
        lines.push(`  ${c.id} — not scored (weight ${c.weight} excluded): ${c.note}`);
      } else {
        lines.push(`  ${c.id}: weight ${c.weight} × ${c.ratio} = ${c.points} pts — ${JSON.stringify(c.detail)}`);
      }
    }
  }
  lines.push("");
  lines.push("Structural, not a certification: this score describes the trail's recorded");
  lines.push("shape under published formulas. It certifies nothing.");
  if (report.malformedLines.length > 0) {
    lines.push("");
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
  return args;
}

export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`ghostguard-score: ${err.message}`);
    console.error("usage: node src/score.mjs --trail <trail.jsonl> [--policy <policy.json>] [--project <id>] [--out <score.json>] [--json]");
    return 2;
  }
  let loaded, policyDoc = null;
  try {
    loaded = loadTrail(args.trail);
    if (args.policy) policyDoc = JSON.parse(readFileSync(args.policy, "utf8"));
  } catch (err) {
    console.error(`ghostguard-score: ${err.message}`);
    return 2;
  }
  let records = loaded.records;
  if (args.project) records = records.filter((r) => r.project_id === args.project);
  const report = buildScoreReport({
    trailSource: args.trail,
    records,
    errors: loaded.errors,
    policyDoc,
    projectId: args.project ?? null,
  });
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n");
  console.log(args.json ? JSON.stringify(report, null, 2) : formatScoreHuman(report));
  if (loaded.errors.length > 0) {
    console.error(`ghostguard-score: ${loaded.errors.length} malformed trail line(s) — see report`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
