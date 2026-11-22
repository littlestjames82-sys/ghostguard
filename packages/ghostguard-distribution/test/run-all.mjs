#!/usr/bin/env node
/**
 * Top-level verify: runs all five distribution test suites as
 * subprocesses and fails if any of them does.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SUITES = [
  ["github-action", join(ROOT, "github-action", "simulate.mjs")],
  ["redteam-bench", join(ROOT, "redteam-bench", "run.mjs")],
  ["policy-author", join(ROOT, "policy-author", "test", "run-tests.mjs")],
  ["approval-channels", join(ROOT, "approval-channels", "test", "run-tests.mjs")],
  ["browser-lite", join(ROOT, "browser-lite", "test", "run-tests.mjs")],
];

let failed = 0;
for (const [name, script] of SUITES) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, [script], { stdio: "inherit" });
  if (r.status !== 0) { failed++; console.error(`=== ${name}: FAILED (exit ${r.status}) ===`); }
}
console.log(`\n${"=".repeat(50)}`);
if (failed === 0) console.log("ghostguard-distribution verify: ALL 5 SUITES PASSED");
else console.error(`ghostguard-distribution verify: ${failed} suite(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
