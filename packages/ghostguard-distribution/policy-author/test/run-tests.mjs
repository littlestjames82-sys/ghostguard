#!/usr/bin/env node
/**
 * Policy-author test suite: compile the example English file, run
 * the GENERATED behavior tests against the real GhostGuard engine
 * (subprocess, using the shipped runner), and prove the loud-error
 * contract for unsupported/duplicate/empty input.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePolicy, evaluatePolicy } from "ghostguard";
import { AuthorError, compileEnglish, finaliseTests } from "../author.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTHOR = join(HERE, "..", "author.mjs");
const RUNNER = join(HERE, "..", "run-behavior-tests.mjs");
const EXAMPLE = join(HERE, "..", "examples", "rules.en.txt");

let pass = 0, failCount = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// 1. The example compiles to the expected rules.
const compiled = finaliseTests(compileEnglish(readFileSync(EXAMPLE, "utf8")));
const byId = new Map(compiled.policy.rules.map((r) => [r.id, r]));
check("example compiles to 7 rules", compiled.policy.rules.length === 7, `got ${compiled.policy.rules.length}`);
check("'never allow spending' -> locked deny SPEND",
  byId.get("never-spending")?.effect === "deny" && byId.get("never-spending")?.locked === true);
check("'never allow deleting' -> locked deny DELETE", byId.get("never-deleting")?.effect === "deny");
check("'always ask before deploying' -> ask DEPLOY", byId.get("ask-before-deploying")?.effect === "ask");
check("'owner must approve messages to strangers' -> hand_off to owner",
  byId.get("owner-approves-stranger-messages")?.effect === "hand_off" && byId.get("owner-approves-stranger-messages")?.handoff_to === "owner");
check("'routines must ask before network writes' -> initiator-scoped ask",
  (byId.get("routines-ask-before-network-writes")?.when ?? "").includes("initiator == 'routine'"));
check("'allow reading' -> allow READ", byId.get("allow-reading")?.effect === "allow");
check("'writing local files is pre-approved' -> pre_approved WRITE_LOCAL",
  byId.get("pre-approved-local-writes")?.effect === "pre_approved");

// The compiled policy must at least compile in the real engine.
let engineError = null;
try { compilePolicy(compiled.policy); } catch (e) { engineError = e; }
check("compiled policy compiles in the real engine", engineError === null, engineError?.message);

// 2. CLI build + generated behavior tests pass against the real engine.
const dir = mkdtempSync(join(tmpdir(), "gg-author-"));
const cli = spawnSync(process.execPath, [AUTHOR, "build", EXAMPLE, "--out", dir], { encoding: "utf8" });
check("CLI build exits 0", cli.status === 0, cli.stderr);
const run = spawnSync(process.execPath, [RUNNER, join(dir, "policy.json"), join(dir, "behavior-tests.json")], { encoding: "utf8" });
check("generated behavior tests all pass against the real engine", run.status === 0, run.stdout + run.stderr);
const generated = JSON.parse(readFileSync(join(dir, "behavior-tests.json"), "utf8"));
console.log(`    (${generated.cases.length} generated cases, runner: ${run.stdout.trim().split("\n").pop()})`);

// 3. Loud errors — never a silent drop.
function expectAuthorError(name, text) {
  try { compileEnglish(text); check(name, false, "compiled without error"); }
  catch (e) { check(name, e instanceof AuthorError, `wrong error type: ${e}`); }
}
expectAuthorError("unsupported sentence errors loudly", "please be nice to the servers");
expectAuthorError("unknown action phrase errors loudly", "never allow teleporting");
expectAuthorError("empty file errors loudly", "# only a comment\n");
expectAuthorError("duplicate rule (same statement twice) errors loudly", "allow reading\nallow reading");
expectAuthorError("unsupported sentence among valid ones still errors (no partial compile)", "allow reading\nmake the logo bigger");

// CLI surface: unsupported file exits 2 and names the line.
const badFile = join(dir, "bad.en.txt");
writeFileSync(badFile, "allow reading\nmake the logo bigger\n");
const badCli = spawnSync(process.execPath, [AUTHOR, "build", badFile, "--out", join(dir, "bad-out")], { encoding: "utf8" });
check("CLI exits 2 on unsupported statement and names line 2",
  badCli.status === 2 && /line 2/.test(badCli.stderr), `status=${badCli.status} stderr=${badCli.stderr}`);

// 4. Spot-check semantics the English promises, directly on the engine.
const engine = compilePolicy(compiled.policy);
const stranger = evaluatePolicy(engine, { kind: "msg.send", permission_class: "COMMUNICATE", actor: "a", initiator: "person", project_id: "p", approved: false, payload: { recipient_known: false } });
check("stranger message really hands off to owner in the engine", stranger.verdict === "hand_off" && stranger.handoff_to === "owner");

console.log(`\npolicy-author: ${pass} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
