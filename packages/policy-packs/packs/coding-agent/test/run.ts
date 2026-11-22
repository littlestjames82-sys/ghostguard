// Coding Agent pack — behavior tests.
//
// Run from the policy-packs root:
//   npx tsx packs/coding-agent/test/run.ts
//
// These tests are part of the product: they execute the pack's
// policy.json against the REAL GhostGuard engine (imported from the
// GhostGuard package — never a fork, never a vendored copy) and
// assert the verdict for every behavior the pack's README promises,
// including the fail-closed edges and the locked layer.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  compilePolicy, evaluatePolicy, mergePolicyDocs,
  type PolicyContext, type PolicyDoc,
} from "ghostguard";

let passed = 0;
function ok(name: string) { passed += 1; console.log(`  ✓ ${name}`); }

const pack = JSON.parse(
  readFileSync(new URL("../policy.json", import.meta.url), "utf8"),
) as PolicyDoc;
const pol = compilePolicy(pack);

// An action in the coding agent's vocabulary, classified per the
// pack README's map. Defaults: a person at the keyboard started the run.
const act = (over: Partial<PolicyContext>): PolicyContext => ({
  kind: "code.read", permission_class: "READ", actor: "coding-agent",
  project_id: "project", approved: false, initiator: "person", payload: {}, ...over,
});
const verdict = (over: Partial<PolicyContext>) => evaluatePolicy(pol, act(over));

// ── Pack integrity: the file compiles clean and its locked core is
// present — a pack that ships a broken rule fails here, not in use.
{
  assert.equal(pack.rules.length, 8);
  for (const r of pol.rules) assert.equal(r.error, null, `rule ${r.id} must compile`);
  const locked = pol.rules.filter((r) => r.locked);
  assert.deepEqual(locked.map((r) => r.id), ["secrets-never", "force-push-never", "delete-never"]);
  ok("Pack integrity: policy.json compiles with zero broken rules; the locked core is exactly [secrets-never, force-push-never, delete-never]");
}

// ── Reads are free — for a person AND for an unattended routine
// (initiator branching, permissive side).
{
  assert.equal(verdict({}).verdict, "allow");
  assert.equal(verdict({ kind: "code.search", payload: { q: "evaluatePolicy" } }).rule_id, "reads-are-free");
  assert.equal(verdict({ kind: "code.grep" }).verdict, "allow");
  assert.equal(verdict({ kind: "code.list" }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine" }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine", kind: "code.search" }).rule_id, "reads-are-free");
  ok("Reads are free: code.read/search/grep/list allow for person and routine initiators alike");
}

// ── Local project work is pre_approved — a standing approval, NOT a
// plain allow. That includes git.commit, classified WRITE_LOCAL in
// this pack (a local commit is reversible and not yet shared).
{
  const write = verdict({ kind: "code.write", permission_class: "WRITE_LOCAL", payload: { path: "src/app.ts" } });
  assert.equal(write.verdict, "pre_approved");
  assert.notEqual(write.verdict, "allow");
  assert.equal(write.rule_id, "local-writes-pre-approved");
  assert.equal(verdict({ kind: "code.edit", permission_class: "WRITE_LOCAL" }).verdict, "pre_approved");
  const commit = verdict({ kind: "git.commit", permission_class: "WRITE_LOCAL", payload: { message: "fix: pack tests" } });
  assert.equal(commit.verdict, "pre_approved");
  assert.equal(commit.rule_id, "local-writes-pre-approved");
  assert.equal(verdict({ kind: "code.write", permission_class: "WRITE_LOCAL", initiator: "routine" }).verdict, "pre_approved");
  ok("Local writes are pre_approved: code.write/code.edit and git.commit (WRITE_LOCAL) get the recorded standing approval, never a plain allow");
}

// ── Running tests and builds is pre_approved too, bounded to exactly
// those two kinds — an agent that must ask to run tests cannot work.
{
  const test = verdict({ kind: "code.test.run", permission_class: "EXECUTE", payload: { suite: "unit" } });
  assert.equal(test.verdict, "pre_approved");
  assert.equal(test.rule_id, "tests-and-builds-pre-approved");
  assert.equal(verdict({ kind: "code.build", permission_class: "EXECUTE" }).verdict, "pre_approved");
  assert.equal(verdict({ kind: "code.test.run", permission_class: "EXECUTE", initiator: "routine" }).verdict, "pre_approved");
  ok("Tests and builds are pre_approved: code.test.run and code.build run under the standing approval, for person and routine initiators");
}

// ── Pushing and merging ask — shared state changes get a human, on
// the exact payload. A push whose payload carries no force field asks
// (absence is not force), and a payload initiator spoof changes nothing.
{
  const push = verdict({ kind: "git.push", permission_class: "NETWORK_WRITE", payload: { remote: "origin", branch: "main" } });
  assert.equal(push.verdict, "ask");
  assert.equal(push.rule_id, "push-and-merge-ask");
  assert.equal(verdict({ kind: "git.push", permission_class: "NETWORK_WRITE", payload: {} }).verdict, "ask");
  assert.equal(verdict({ kind: "git.push", permission_class: "NETWORK_WRITE", payload: { force: false } }).verdict, "ask");
  const merge = verdict({ kind: "git.pr.merge", permission_class: "NETWORK_WRITE", payload: { pr: 42 } });
  assert.equal(merge.verdict, "ask");
  assert.equal(merge.rule_id, "push-and-merge-ask");
  assert.equal(verdict({ kind: "git.push", permission_class: "NETWORK_WRITE", initiator: "routine", payload: { initiator: "person" } }).verdict, "ask");
  ok("Push and merge ask: normal git.push and git.pr.merge ask; a push with force absent or false asks (never denies), and payload initiator spoofing changes nothing");
}

// ── Force-pushing is denied by the LOCKED rule.
{
  const force = verdict({ kind: "git.push", permission_class: "NETWORK_WRITE", payload: { force: true, branch: "main" } });
  assert.equal(force.verdict, "deny");
  assert.equal(force.rule_id, "force-push-never");
  assert.equal(verdict({ kind: "git.push", permission_class: "NETWORK_WRITE", initiator: "routine", payload: { force: true } }).rule_id, "force-push-never");
  ok("Force push denies via the locked rule: git.push with payload.force true refused by force-push-never");
}

// ── Deploys and publishes hand off to the owner — not an ask to this
// run's approver, and not free for routines either: shipping is the
// owner's decision however the run started.
{
  const deploy = verdict({ kind: "deploy.release", permission_class: "DEPLOY", payload: { version: "1.2.0" } });
  assert.equal(deploy.verdict, "hand_off");
  assert.equal(deploy.rule_id, "deploy-and-publish-to-owner");
  assert.equal(deploy.handoff_to, "owner");
  assert.equal(verdict({ kind: "deploy.promote", permission_class: "DEPLOY" }).verdict, "hand_off");
  const pub = verdict({ kind: "release.publish", permission_class: "PUBLISH", payload: { version: "1.2.0" } });
  assert.equal(pub.verdict, "hand_off");
  assert.equal(pub.handoff_to, "owner");
  assert.equal(verdict({ kind: "deploy.release", permission_class: "DEPLOY", initiator: "routine" }).verdict, "hand_off");
  ok("Deploy and publish hand off: deploy.release/deploy.promote and release.publish route to 'owner' (hand_off), for person and routine initiators");
}

// ── Secrets access and branch deletion are denied by LOCKED rules —
// secrets even for a person initiator, and even though the secrets
// kinds are classified EXECUTE (the deny tier decides, not class).
{
  const secret = verdict({ kind: "code.secrets.read", permission_class: "EXECUTE", payload: { name: "API_KEY" } });
  assert.equal(secret.verdict, "deny");
  assert.equal(secret.rule_id, "secrets-never");
  assert.equal(verdict({ kind: "env.secrets.access", permission_class: "EXECUTE", initiator: "person" }).rule_id, "secrets-never");
  assert.equal(verdict({ kind: "code.secrets.list", permission_class: "READ" }).verdict, "deny");
  const branch = verdict({ kind: "git.branch.delete", permission_class: "DELETE", payload: { branch: "old-feature" } });
  assert.equal(branch.verdict, "deny");
  assert.equal(branch.rule_id, "delete-never");
  ok("Secrets and branch deletes deny via locked rules: code.secrets.*/env.secrets.* refused by secrets-never (even for a person, even as EXECUTE), git.branch.delete refused by delete-never");
}

// ── Strictest wins: tiers decide, not rule order. A force push also
// matches the push ask (deny wins), and a routine deploy still hands
// off instead of riding any permissive routine path.
{
  assert.equal(verdict({ kind: "git.push", permission_class: "NETWORK_WRITE", payload: { force: true } }).verdict, "deny");
  assert.equal(verdict({ kind: "deploy.release", permission_class: "DEPLOY", initiator: "routine" }).verdict, "hand_off");
  assert.equal(verdict({ kind: "code.secrets.read", permission_class: "EXECUTE" }).verdict, "deny");
  ok("Strictest wins: force-push deny beats the push ask, routine deploy still hands off, and secrets deny beats any EXECUTE treatment");
}

// ── Fail closed: anything the pack does not map denies — unknown
// kinds, unmapped classes, and EXECUTE kinds other than test/build.
// No catch-all allow or blanket EXECUTE approval exists in the pack.
{
  const unknown = verdict({ kind: "code.teleport", permission_class: null });
  assert.equal(unknown.verdict, "deny");
  assert.equal(unknown.rule_id, null); // the fail-closed default, not a rule
  assert.equal(verdict({ kind: "git.unknown-exec", permission_class: "EXECUTE" }).verdict, "deny");
  assert.equal(verdict({ kind: "code.shell.run", permission_class: "EXECUTE" }).rule_id, null);
  assert.equal(verdict({ kind: "", permission_class: null }).verdict, "deny");
  ok("Fail closed: unknown kinds, unmapped EXECUTE (git.unknown-exec, code.shell.run), and malformed actions all deny with rule_id null");
}

// ── The locked layer cannot be tuned away: an overlay that tries to
// replace all three locked denies with allows AND adds a catch-all
// allow-all changes none of the pack's restrictive verdicts
// (strictest-wins tiers + locked-rule merge semantics).
{
  const hostileOverlay: PolicyDoc = { rules: [
    { id: "secrets-never", effect: "allow", when: "true" },
    { id: "force-push-never", effect: "allow", when: "true" },
    { id: "delete-never", effect: "allow", when: "true" },
    { id: "allow-everything", effect: "allow", when: "true" },
  ] };
  const merged = compilePolicy(mergePolicyDocs(pack, hostileOverlay));
  for (const id of ["secrets-never", "force-push-never", "delete-never"]) {
    const rule = merged.source.rules.find((r) => r.id === id);
    assert.equal(rule?.effect, "deny");
    assert.equal(rule?.locked, true);
  }
  assert.equal(evaluatePolicy(merged, act({ kind: "code.secrets.read", permission_class: "EXECUTE" })).rule_id, "secrets-never");
  assert.equal(evaluatePolicy(merged, act({ kind: "git.push", permission_class: "NETWORK_WRITE", payload: { force: true } })).rule_id, "force-push-never");
  assert.equal(evaluatePolicy(merged, act({ kind: "git.branch.delete", permission_class: "DELETE" })).rule_id, "delete-never");
  assert.equal(evaluatePolicy(merged, act({ kind: "git.push", permission_class: "NETWORK_WRITE" })).verdict, "ask");
  assert.equal(evaluatePolicy(merged, act({ kind: "deploy.release", permission_class: "DEPLOY" })).verdict, "hand_off");
  ok("Locked layer survives overlays: replacing the three locked denies is dropped, a catch-all allow outranks nothing restrictive, and the push ask and deploy hand_off hold");
}

console.log(`\nCoding Agent pack: all ${passed} behavior checks passed.`);
