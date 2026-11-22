#!/usr/bin/env node
/**
 * Browser-lite tests (run in Node — the library itself is plain JS
 * with no Node APIs):
 *  1. verdict parity: every shared case runs through BOTH the real
 *     GhostGuard engine (the published ghostguard package) and Lite;
 *     verdict, rule_id, and handoff_to must agree exactly.
 *  2. the classifier maps DOM-ish actions to the right classes.
 *  3. the record sink: evaluateAndRecord delivers a complete record
 *     before returning, and a throwing sink stops the flow.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compilePolicy, evaluatePolicy, mergePolicyDocs } from "ghostguard";

const HERE = dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(join(HERE, "..", "ghostguard-lite.js")).href);
const Lite = globalThis.GhostGuardLite;
if (!Lite) { console.error("ghostguard-lite.js did not set globalThis.GhostGuardLite"); process.exit(1); }

let pass = 0, failCount = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// 1. Parity on shared cases.
const shared = JSON.parse(readFileSync(join(HERE, "..", "shared", "cases.json"), "utf8"));
for (const c of shared.cases) {
  const realDoc = c.overlay ? mergePolicyDocs(shared.policy, c.overlay) : shared.policy;
  const liteDoc = c.overlay ? Lite.mergePolicyDocs(shared.policy, c.overlay) : shared.policy;
  const real = evaluatePolicy(compilePolicy(realDoc), c.context);
  const lite = Lite.evaluatePolicy(Lite.compilePolicy(liteDoc), c.context);
  const same = real.verdict === lite.verdict && real.rule_id === lite.rule_id && real.handoff_to === lite.handoff_to;
  check(`parity: ${c.id} (${real.verdict})`, same,
    `real=${real.verdict}/${real.rule_id}/${real.handoff_to} lite=${lite.verdict}/${lite.rule_id}/${lite.handoff_to}`);
}

// 2. Classifier.
const CLASS_CASES = [
  [{ type: "navigate" }, "READ"], [{ type: "read" }, "READ"],
  [{ type: "fill" }, "WRITE_LOCAL"], [{ type: "click" }, "WRITE_LOCAL"],
  [{ type: "submit" }, "NETWORK_WRITE"], [{ type: "form_submit" }, "NETWORK_WRITE"],
  [{ type: "send_message" }, "COMMUNICATE"], [{ type: "pay" }, "SPEND"],
  [{ type: "buy" }, "SPEND"], [{ type: "delete" }, "DELETE"],
  [{ type: "deploy" }, "DEPLOY"], [{ type: "publish" }, "PUBLISH"],
  [{ type: "teleport" }, null], [{}, null], [null, null],
];
for (const [action, expected] of CLASS_CASES) {
  check(`classify ${JSON.stringify(action)} -> ${expected}`, Lite.classifyAction(action) === expected,
    `got ${Lite.classifyAction(action)}`);
}

// 3. Record sink.
const policy = Lite.compilePolicy(shared.policy);
const sinkRecords = [];
const { decision, record } = Lite.evaluateAndRecord(policy, {
  action_id: "lite_1", kind: "browser.purchase", permission_class: "SPEND",
  actor: "browser-agent", initiator: "person", project_id: "lite-parity",
  approved: false, action_payload: { item: "gift card" },
}, (r) => sinkRecords.push(r));
check("evaluateAndRecord returns the deny decision", decision.verdict === "deny" && decision.rule_id === "no-spend-ever");
check("sink received exactly one record, identical to the returned record",
  sinkRecords.length === 1 && sinkRecords[0] === record && record.action_id === "lite_1" && record.verdict === "deny");

let sinkThrew = false;
try {
  Lite.evaluateAndRecord(policy, {
    action_id: "lite_2", kind: "browser.navigate", permission_class: "READ",
    actor: "a", initiator: "person", project_id: "p", approved: false, action_payload: {},
  }, () => { throw new Error("disk full"); });
} catch { sinkThrew = true; }
check("a throwing record sink stops the flow (record-first)", sinkThrew);

console.log(`\nbrowser-lite: ${pass} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
