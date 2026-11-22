#!/usr/bin/env node
/**
 * Local simulation of the GitHub Action gate — runs gate.mjs as a
 * subprocess against the fixture trails, exactly as the composite
 * action would, and checks exit codes. No GitHub involved.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, "gate.mjs");
const FIX = (n) => join(HERE, "fixtures", n);

const CASES = [
  { name: "missing record -> fail", trail: "trail-allow.jsonl", id: "deploy_nope", approval: false, expect: 1 },
  { name: "denied record -> fail", trail: "trail-deny.jsonl", id: "deploy_prod_1", approval: false, expect: 1 },
  { name: "ask record -> fail", trail: "trail-ask.jsonl", id: "deploy_prod_1", approval: false, expect: 1 },
  { name: "pre_approved deploy -> pass", trail: "trail-allow.jsonl", id: "deploy_prod_1", approval: false, expect: 0 },
  { name: "plain allow record -> pass", trail: "trail-allow.jsonl", id: "act_read_1", approval: false, expect: 0 },
  { name: "require-approval, none present -> fail", trail: "trail-allow.jsonl", id: "deploy_prod_1", approval: true, expect: 1 },
  { name: "require-approval, approved deploy -> pass", trail: "trail-approved.jsonl", id: "deploy_prod_9", approval: true, expect: 0 },
  { name: "require-approval, decision was DENY -> fail", trail: "trail-approved.jsonl", id: "deploy_prod_10", approval: true, expect: 1 },
  { name: "missing trail file -> fail (exit 2)", trail: "does-not-exist.jsonl", id: "deploy_prod_1", approval: false, expect: 2 },
];

let pass = 0, failCount = 0;
for (const c of CASES) {
  const args = [GATE, "--trail", FIX(c.trail), "--action-id", c.id];
  if (c.approval) args.push("--require-approval");
  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  const ok = r.status === c.expect;
  if (ok) { pass++; console.log(`  ✓ ${c.name} (exit ${r.status})`); }
  else {
    failCount++;
    console.log(`  ✗ ${c.name} — expected exit ${c.expect}, got ${r.status}\n    stdout: ${r.stdout}\n    stderr: ${r.stderr}`);
  }
}
console.log(`\ngithub-action simulation: ${pass} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
