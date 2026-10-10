// GhostGuard — shared conformance runner (Phase B).
// Run: npm run test:conformance
//
// Loads conformance/fixtures.json — the ONE policy document + action
// case set for the whole stack — and runs every case against the real
// engine in this package, exactly as the gate bridge (Bridge Spec v1)
// evaluates a request: merge the case overlay with mergePolicyDocs,
// compilePolicy, evaluatePolicy over a context derived from the
// intent, then assemble the record with gatewayRecordFromDecision.
// A case passes when the record's verdict / rule_id / handoff_to
// match the fixture's expected shared fields. Other runtimes (the
// Ghost Hands GhostGuard backend, the Jev bridge) run the same file
// and must agree on those fields — drift is a failing test here and
// there, not a surprise.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePolicy, evaluatePolicy, mergePolicyDocs, type PolicyDoc } from "../src/policy.js";
import { gatewayRecordFromDecision, type GatewayIntent } from "../src/gateway.js";

interface FixtureCase {
  id: string;
  intent: GatewayIntent;
  approved: boolean;
  policy_overlay: PolicyDoc | null;
  expected: { verdict: string; rule_id: string | null; handoff_to: string | null };
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, "fixtures.json"), "utf8")) as {
  version: number;
  policy: PolicyDoc;
  cases: FixtureCase[];
};

assert.equal(fixtures.version, 1, "conformance fixtures version must be 1");
assert.ok(Array.isArray(fixtures.cases) && fixtures.cases.length > 0, "fixtures must carry cases");

let passed = 0;
for (const c of fixtures.cases) {
  const doc = c.policy_overlay ? mergePolicyDocs(fixtures.policy, c.policy_overlay) : fixtures.policy;
  const decision = evaluatePolicy(compilePolicy(doc), {
    kind: c.intent.kind,
    permission_class: c.intent.permission_class,
    actor: c.intent.actor,
    project_id: c.intent.project_id,
    approved: c.approved === true,
    initiator: c.intent.initiator,
    payload: c.intent.action_payload,
  });
  const record = gatewayRecordFromDecision(c.intent, decision);
  assert.equal(record.verdict, c.expected.verdict, `${c.id}: verdict`);
  assert.equal(record.rule_id, c.expected.rule_id, `${c.id}: rule_id`);
  assert.equal(record.handoff_to, c.expected.handoff_to, `${c.id}: handoff_to`);
  // The record echoes the intent's shared fields verbatim.
  assert.equal(record.action_id, c.intent.action_id, `${c.id}: action_id`);
  assert.equal(record.actor, c.intent.actor, `${c.id}: actor`);
  assert.equal(record.initiator, c.intent.initiator, `${c.id}: initiator`);
  assert.deepEqual(record.action_payload, c.intent.action_payload, `${c.id}: action_payload`);
  passed += 1;
  console.log(`  ✓ ${c.id}: ${record.verdict} by ${record.rule_id ?? "(fail-closed default)"}`);
}

console.log(`\nConformance: all ${passed} fixture cases passed against the GhostGuard engine.`);
