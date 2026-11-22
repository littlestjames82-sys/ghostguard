#!/usr/bin/env node
/**
 * ghostguard-replay test suite.
 *
 * All expected numbers below are HAND-COMPUTED from the fixtures —
 * see the arithmetic in the comments — not copied from the tool's
 * output. If a number changes, the fixture or the formula changed,
 * and this suite is supposed to notice.
 *
 * Fixture trail (fixtures/trail.sample.jsonl), 10 synthetic records:
 *   a01 READ allow/person        a06 SPEND deny/routine (locked)
 *   a02 READ allow/person        a07 DELETE deny/person (locked)
 *   a03 WRITE_LOCAL pre_appr.    a08 PUBLISH hand_off/person -> owner
 *   a04 NETWORK_WRITE ask/routine (+ decision field)
 *   a05 COMMUNICATE ask/person   a09 DEPLOY pre_appr./routine
 *                                a10 READ allow/routine (side-project)
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadTrail, parseTrail } from "../src/trail.mjs";
import { replayRecords, buildReplayReport, categorize } from "../src/replay.mjs";
import { computeGuardScore, gateEngagementRatio, WEIGHTS } from "../src/score.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fx = (name) => join(root, "fixtures", name);
const readJson = (name) => JSON.parse(readFileSync(fx(name), "utf8"));

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const { records, errors } = loadTrail(fx("trail.sample.jsonl"));
const original = readJson("policy.original.json");
const tightened = readJson("policy.tightened.json");
const loosening = readJson("policy.loosening.json");

check("sample trail parses clean: 10 records, 0 errors", () => {
  assert.equal(errors.length, 0);
  assert.equal(records.length, 10);
});

// --- Replay ---------------------------------------------------------------

check("replay against the ORIGINAL policy reproduces every recorded verdict (10 unchanged)", () => {
  const r = replayRecords(records, original);
  assert.equal(r.summary.total, 10);
  assert.equal(r.summary.unchanged, 10);
  assert.equal(r.summary.changed, 0);
  assert.equal(r.danger, false);
});

check("tightened policy: exactly a09 would-deny and a10 would-ask (8 unchanged, 0 loosened)", () => {
  const r = replayRecords(records, tightened);
  assert.equal(r.summary.unchanged, 8);
  assert.equal(r.summary.wouldDeny, 1);
  assert.equal(r.summary.wouldAsk, 1);
  assert.equal(r.summary.loosened, 0);
  assert.equal(r.danger, false);
  const byId = Object.fromEntries(r.diffs.map((d) => [d.action_id, d]));
  assert.equal(byId.a09.old_verdict, "pre_approved");
  assert.equal(byId.a09.new_verdict, "deny");
  assert.equal(byId.a09.new_rule_id, "no-deploy-ever");
  assert.equal(byId.a09.category, "would-deny");
  assert.equal(byId.a10.old_verdict, "allow");
  assert.equal(byId.a10.new_verdict, "ask");
  assert.equal(byId.a10.new_rule_id, "routine-reads-ask");
  assert.equal(byId.a10.category, "would-ask");
});

check("loosening policy is FLAGGED: danger=true, 7 loosened, 5 would-execute", () => {
  // Hand count vs allow-everything: a03 pre_approved->allow (loosened-other),
  // a04 ask->allow, a05 ask->allow, a06 deny->allow, a07 deny->allow,
  // a08 hand_off->allow, a09 pre_approved->allow (loosened-other) = 7 loosened;
  // the 5 that were blocked (ask/deny/hand_off) are would-execute.
  // a01, a02, a10 stay allow = 3 unchanged.
  const r = replayRecords(records, loosening);
  assert.equal(r.danger, true);
  assert.equal(r.summary.loosened, 7);
  assert.equal(r.summary.wouldExecute, 5);
  assert.equal(r.summary.unchanged, 3);
  assert.deepEqual(
    [...r.looseningActionIds].sort(),
    ["a03", "a04", "a05", "a06", "a07", "a08", "a09"],
  );
});

check("categorize() direction math: stricter vs looser by permissiveness", () => {
  assert.deepEqual(categorize("allow", "allow"), { category: "unchanged", direction: "unchanged" });
  assert.deepEqual(categorize("allow", "pre_approved"), { category: "tightened-other", direction: "tightened" });
  assert.deepEqual(categorize("deny", "ask"), { category: "would-ask", direction: "loosened" });
  assert.deepEqual(categorize("ask", "hand_off"), { category: "would-handoff", direction: "tightened" });
  assert.deepEqual(categorize("hand_off", "pre_approved"), { category: "would-execute", direction: "loosened" });
});

check("replay is deterministic: two runs produce identical reports", () => {
  const a = buildReplayReport({ trailSource: "x", policySource: "y", records, errors: [], policyDoc: tightened, projectId: null });
  const b = buildReplayReport({ trailSource: "x", policySource: "y", records, errors: [], policyDoc: tightened, projectId: null });
  assert.deepEqual(a, b);
});

// --- Guard Score ----------------------------------------------------------
//
// Hand computation for the fixture (with policy.original.json, whose
// locked rules are no-spend-ever + no-delete-ever):
//   completeness        10 records × 15 checks, all pass -> 150/150 = 1.0    -> 30 pts
//   gateEngagement      gated = ask a04,a05 + deny a06,a07 + hand_off a08 = 5/10 = 0.5,
//                       inside the 5%–50% band -> 1.0                        -> 20 pts
//   lockedRuleHits      a06 + a07 = 2/10 = 0.2, saturates at 0.10 -> 1.0     -> 15 pts
//   unattendedStrict.   unattended = a04 ask, a06 deny, a09 pre_approved,
//                       a10 allow -> held (not plain allow) 3/4 = 0.75       -> 11.25 pts
//   handoffRouting      1 hand_off (a08), routed to "owner" -> 1.0           -> 10 pts
//   outcomeTracking     decidable = a04, a05, a08; only a04 carries an
//                       outcome field (decision) -> 1/3                      -> 3.3333 pts
//   TOTAL               89.5833 of 100 -> score 89.6

check("guard score on fixture matches the hand-computed breakdown (89.6)", () => {
  const s = computeGuardScore(records, { policyDoc: original });
  assert.equal(s.status, "scored");
  assert.equal(s.totalRecords, 10);
  const byId = Object.fromEntries(s.components.map((c) => [c.id, c]));
  assert.equal(byId.completeness.ratio, 1);
  assert.equal(byId.completeness.points, 30);
  assert.equal(byId.completeness.detail.fullyCleanRecords, 10);
  assert.equal(byId.gateEngagement.ratio, 1);
  assert.equal(byId.gateEngagement.detail.gatedRecords, 5);
  assert.equal(byId.lockedRuleHits.ratio, 1);
  assert.equal(byId.lockedRuleHits.detail.lockedHits, 2);
  assert.equal(byId.unattendedStrictness.ratio, 0.75);
  assert.equal(byId.unattendedStrictness.points, 11.25);
  assert.equal(byId.handoffRouting.ratio, 1);
  assert.ok(Math.abs(byId.outcomeTracking.ratio - 1 / 3) < 0.001);
  assert.equal(s.pointsAvailable, 100);
  assert.equal(s.score, 89.6);
});

check("weights sum to 100 and are the published ones", () => {
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

check("gate band formula: 0 -> 0, in-band -> 1, 100% gated -> 0", () => {
  assert.equal(gateEngagementRatio(0), 0);
  assert.equal(gateEngagementRatio(0.025), 0.5);
  assert.equal(gateEngagementRatio(0.05), 1);
  assert.equal(gateEngagementRatio(0.5), 1);
  assert.equal(gateEngagementRatio(1), 0);
});

check("score without --policy excludes lockedRuleHits and renormalises (87.7)", () => {
  // Earned without locked: 30 + 20 + 11.25 + 10 + 3.3333 = 74.5833
  // over 85 available -> 87.745... -> 87.7
  const s = computeGuardScore(records, {});
  const locked = s.components.find((c) => c.id === "lockedRuleHits");
  assert.equal(locked.scored, false);
  assert.equal(s.pointsAvailable, 85);
  assert.equal(s.score, 87.7);
});

check("empty trail: score is null / insufficient_data, NOT 100", () => {
  const empty = loadTrail(fx("trail.empty.jsonl"));
  assert.equal(empty.records.length, 0);
  const s = computeGuardScore(empty.records, { policyDoc: original });
  assert.equal(s.status, "insufficient_data");
  assert.equal(s.score, null);
});

// --- Malformed trails -----------------------------------------------------

check("malformed lines are reported with line numbers, never silently skipped", () => {
  const bad = loadTrail(fx("trail.malformed.jsonl"));
  assert.equal(bad.records.length, 1);
  assert.equal(bad.records[0].action_id, "m01");
  assert.equal(bad.errors.length, 2);
  assert.equal(bad.errors[0].line, 2);
  assert.match(bad.errors[0].message, /invalid JSON/);
  assert.equal(bad.errors[1].line, 3);
  assert.match(bad.errors[1].message, /not a GatewayRecord/);
  // Replay over the malformed file still diffs the one valid record.
  const r = replayRecords(bad.records, original);
  assert.equal(r.summary.total, 1);
  assert.equal(r.summary.unchanged, 1);
});

check("parseTrail ignores blank lines but not garbage", () => {
  const { records: recs, errors: errs } = parseTrail('\n\n{"x":1}\n');
  assert.equal(recs.length, 0);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].line, 3);
});

// --- CLI end-to-end -------------------------------------------------------

const runCli = (args) =>
  spawnSync("node", args, { cwd: root, encoding: "utf8" });

check("CLI replay --json: tightened diff + project filter (9 records, no would-ask)", () => {
  const out = runCli(["src/replay.mjs", "--trail", "fixtures/trail.sample.jsonl", "--policy", "fixtures/policy.tightened.json", "--json"]);
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(out.stdout);
  assert.equal(report.summary.wouldDeny, 1);
  assert.equal(report.summary.wouldAsk, 1);
  const filtered = runCli(["src/replay.mjs", "--trail", "fixtures/trail.sample.jsonl", "--policy", "fixtures/policy.tightened.json", "--project", "demo-project", "--json"]);
  assert.equal(filtered.status, 0, filtered.stderr);
  const fr = JSON.parse(filtered.stdout);
  assert.equal(fr.summary.total, 9); // a10 is side-project
  assert.equal(fr.summary.wouldAsk, 0);
  assert.equal(fr.summary.wouldDeny, 1);
});

check("CLI replay human output flags loosening LOUDLY", () => {
  const out = runCli(["src/replay.mjs", "--trail", "fixtures/trail.sample.jsonl", "--policy", "fixtures/policy.loosening.json"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /LOOSENING WARNING/);
  assert.match(out.stdout, /would EXECUTE now/);
});

check("CLI score --json matches library score; malformed trail exits 1 with errors in report", () => {
  const out = runCli(["src/score.mjs", "--trail", "fixtures/trail.sample.jsonl", "--policy", "fixtures/policy.original.json", "--json"]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).score, 89.6);
  const bad = runCli(["src/score.mjs", "--trail", "fixtures/trail.malformed.jsonl", "--json"]);
  assert.equal(bad.status, 1);
  const badReport = JSON.parse(bad.stdout);
  assert.equal(badReport.malformedLines.length, 2);
  assert.equal(badReport.totalRecords, 1);
});

check("CLI score on empty trail prints score null and exits 0 (honest, not an error)", () => {
  const out = runCli(["src/score.mjs", "--trail", "fixtures/trail.empty.jsonl", "--json"]);
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(out.stdout);
  assert.equal(report.score, null);
  assert.equal(report.status, "insufficient_data");
});

console.log(`\nghostguard-replay: ${passed} checks passed, 0 failed`);
