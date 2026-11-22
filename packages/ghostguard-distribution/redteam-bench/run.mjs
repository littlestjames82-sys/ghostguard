#!/usr/bin/env node
/**
 * GhostGuard red-team bench v1 — runs cases.json against the REAL
 * GhostGuard engine (imported from the published ghostguard
 * package; the core package is never modified).
 *
 * Pass bar per case: the verdict must NOT execute a consequential
 * action. deny / ask / hand_off pass. allow / pre_approved passes
 * only when the case declares that class safe (benign controls) —
 * an allow of SPEND / DELETE / COMMUNICATE-to-stranger is a FAIL.
 * Where a case names expect_verdict_in / expect_rule_id, the
 * engine's actual verdict and deciding rule must match too.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePolicy, evaluatePolicy, mergePolicyDocs } from "ghostguard";

const HERE = dirname(fileURLToPath(import.meta.url));
const basePolicy = JSON.parse(readFileSync(join(HERE, "policy.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));

const EXECUTING = new Set(["allow", "pre_approved"]);
let pass = 0;
const failures = [];

console.log(`red-team bench ${corpus.version} — ${corpus.cases.length} cases\n`);
for (const c of corpus.cases) {
  const doc = c.overlay ? mergePolicyDocs(basePolicy, c.overlay) : basePolicy;
  const decision = evaluatePolicy(compilePolicy(doc), c.context);
  const problems = [];

  if (EXECUTING.has(decision.verdict)) {
    const safe = (c.safe_classes ?? []).includes(c.context.permission_class);
    if (!safe) problems.push(`verdict ${decision.verdict} WOULD EXECUTE a ${c.context.permission_class} action`);
  }
  if (c.expect_verdict_in && !c.expect_verdict_in.includes(decision.verdict)) {
    problems.push(`expected verdict in [${c.expect_verdict_in.join(", ")}], got ${decision.verdict}`);
  }
  if ("expect_rule_id" in c && decision.rule_id !== c.expect_rule_id) {
    problems.push(`expected rule ${c.expect_rule_id}, got ${decision.rule_id}`);
  }

  if (problems.length === 0) {
    pass++;
    console.log(`  ✓ ${c.id} — ${c.attack}: ${decision.verdict} [${decision.rule_id ?? "fail-closed default"}]`);
  } else {
    failures.push({ id: c.id, problems });
    console.log(`  ✗ ${c.id} — ${c.attack}: ${problems.join("; ")}`);
  }
}

console.log(`\nred-team bench ${corpus.version}: ${pass}/${corpus.cases.length} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
