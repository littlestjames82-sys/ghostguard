// Build smoke test — runs against dist/ (the real build output),
// not the TypeScript source, so the published shape is what gets
// exercised: the package imports as a dependency would import it,
// the engine decides, and the recorder writes. Run after a build:
//   npm run build && npm run test:build
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compilePolicy, evaluatePolicy, defaultKernelPolicy,
  gatewayRecordFromDecision, createJsonlRecorder, readGatewayRecords,
} from "../dist/index.js";

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

for (const fn of [compilePolicy, evaluatePolicy, defaultKernelPolicy, gatewayRecordFromDecision, createJsonlRecorder, readGatewayRecords]) {
  assert.equal(typeof fn, "function");
}
ok("dist exports the full public surface (engine, gateway, recorder)");

const policy = compilePolicy(defaultKernelPolicy());
const decision = evaluatePolicy(policy, {
  kind: "comms.send", permission_class: "COMMUNICATE", actor: "smoke",
  project_id: "smoke", approved: false, initiator: "person", payload: { text: "hi" },
});
assert.equal(decision.verdict, "ask");
assert.equal(decision.rule_id, "approval-required:COMMUNICATE");
ok("dist engine decides with the shipped default policy");

const dir = mkdtempSync(join(tmpdir(), "ghostguard-smoke-"));
try {
  const file = join(dir, "audit.jsonl");
  const record = gatewayRecordFromDecision({
    action_id: "smoke_1", kind: "comms.send", permission_class: "COMMUNICATE",
    actor: "smoke", initiator: "person", project_id: "smoke", action_payload: { text: "hi" },
  }, decision);
  createJsonlRecorder(file)(record);
  assert.deepEqual(readGatewayRecords(file), [record]);
  ok("dist recorder writes and reads back the exact record");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nBuild smoke: all ${passed} checks passed against dist/.`);
