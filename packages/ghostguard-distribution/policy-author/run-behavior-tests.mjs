#!/usr/bin/env node
/**
 * Runs a generated behavior-tests.json against a policy.json using
 * the REAL GhostGuard engine (the published ghostguard package).
 *
 * Usage: node run-behavior-tests.mjs <policy.json> <behavior-tests.json>
 */
import { readFileSync } from "node:fs";
import { compilePolicy, evaluatePolicy } from "ghostguard";

const [policyPath, testsPath] = process.argv.slice(2);
if (!policyPath || !testsPath) {
  console.error("usage: node run-behavior-tests.mjs <policy.json> <behavior-tests.json>");
  process.exit(2);
}
const policy = compilePolicy(JSON.parse(readFileSync(policyPath, "utf8")));
const suite = JSON.parse(readFileSync(testsPath, "utf8"));

let pass = 0, failCount = 0;
for (const t of suite.cases) {
  const d = evaluatePolicy(policy, t.context);
  const problems = [];
  if (t.expect_verdict && d.verdict !== t.expect_verdict) problems.push(`expected ${t.expect_verdict}, got ${d.verdict}`);
  if ("expect_rule_id" in t && d.rule_id !== t.expect_rule_id) problems.push(`expected rule ${t.expect_rule_id}, got ${d.rule_id}`);
  if (t.expect_not_rule_id && d.rule_id === t.expect_not_rule_id) problems.push(`rule ${t.expect_not_rule_id} must not decide this, but did`);
  if (t.expect_handoff_to && d.handoff_to !== t.expect_handoff_to) problems.push(`expected handoff_to ${t.expect_handoff_to}, got ${d.handoff_to}`);
  if (problems.length === 0) { pass++; console.log(`  ✓ ${t.name}`); }
  else { failCount++; console.log(`  ✗ ${t.name} — ${problems.join("; ")}`); }
}
console.log(`\nbehavior tests: ${pass} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
