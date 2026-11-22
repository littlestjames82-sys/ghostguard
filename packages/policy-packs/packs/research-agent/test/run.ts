// Research Agent pack — behavior tests.
//
// Run from the policy-packs root:
//   npx tsx packs/research-agent/test/run.ts
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

// An action in the research agent's vocabulary, classified per the
// pack README's map. Defaults: a person at the keyboard started the run.
const act = (over: Partial<PolicyContext>): PolicyContext => ({
  kind: "web.fetch", permission_class: "READ", actor: "research-agent",
  project_id: "research", approved: false, initiator: "person", payload: {}, ...over,
});
const verdict = (over: Partial<PolicyContext>) => evaluatePolicy(pol, act(over));

// ── Pack integrity: the file compiles clean and its locked core is
// present — a pack that ships a broken rule fails here, not in use.
{
  assert.equal(pack.rules.length, 6);
  for (const r of pol.rules) assert.equal(r.error, null, `rule ${r.id} must compile`);
  const locked = pol.rules.filter((r) => r.locked);
  assert.deepEqual(locked.map((r) => r.id), ["spend-never", "delete-never"]);
  ok("Pack integrity: policy.json compiles with zero broken rules; the locked core is exactly [spend-never, delete-never]");
}

// ── Reads and research are free — for a person AND for an unattended
// routine (initiator branching, permissive side).
{
  assert.equal(verdict({}).verdict, "allow");
  assert.equal(verdict({ kind: "web.search", payload: { q: "oakdale plumber" } }).rule_id, "reads-are-free");
  assert.equal(verdict({ kind: "web.page.read" }).verdict, "allow");
  assert.equal(verdict({ kind: "web.extract" }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine" }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine", kind: "web.search" }).rule_id, "reads-are-free");
  ok("Reads are free: fetch/search/page.read/extract allow for person and routine initiators alike");
}

// ── Downloads fetch as READ, and saving fetched content to local
// disk is a free local write — nothing leaves the machine here.
{
  assert.equal(verdict({ kind: "web.download", permission_class: "READ", payload: { url: "https://example.com/report.pdf" } }).verdict, "allow");
  assert.equal(verdict({ kind: "web.download", permission_class: "READ", initiator: "routine" }).rule_id, "reads-are-free");
  const save = verdict({ kind: "web.download.save", permission_class: "WRITE_LOCAL", payload: { path: "notes/report.pdf" } });
  assert.equal(save.verdict, "allow");
  assert.equal(save.rule_id, "local-writes-are-free");
  ok("Downloads and local saves are free: web.download allows as READ, web.download.save allows as WRITE_LOCAL");
}

// ── Form submits ask — the headline behavior. It covers a plain form
// AND account creation (both NETWORK_WRITE in this pack), for person
// or routine initiators, and a payload initiator spoof changes nothing.
{
  const form = verdict({ kind: "web.form.submit", permission_class: "NETWORK_WRITE", payload: { form: "contact", fields: { name: "…" } } });
  assert.equal(form.verdict, "ask");
  assert.equal(form.rule_id, "network-writes-ask");
  const signup = verdict({ kind: "web.account.create", permission_class: "NETWORK_WRITE", payload: { site: "example.com" } });
  assert.equal(signup.verdict, "ask");
  assert.equal(signup.rule_id, "network-writes-ask");
  assert.equal(verdict({ kind: "web.form.submit", permission_class: "NETWORK_WRITE", initiator: "routine" }).verdict, "ask");
  assert.equal(verdict({ kind: "web.form.submit", permission_class: "NETWORK_WRITE", initiator: "routine", payload: { initiator: "person" } }).verdict, "ask");
  ok("Form submits ask: form.submit and account.create ask for person and routine initiators; payload initiator spoofing changes nothing");
}

// ── Uploading a LOCAL file hands off to the owner — not an ask to
// this run's approver, because the disclosure is the owner's call.
{
  const up = verdict({ kind: "web.upload", permission_class: "NETWORK_WRITE", payload: { source: "local_file", path: "notes/private.md" } });
  assert.equal(up.verdict, "hand_off");
  assert.equal(up.rule_id, "local-file-uploads-to-owner");
  assert.equal(up.handoff_to, "owner");
  assert.equal(verdict({ kind: "web.upload", permission_class: "NETWORK_WRITE", initiator: "routine", payload: { source: "local_file" } }).verdict, "hand_off");
  ok("Local-file uploads hand off: web.upload with payload.source 'local_file' routes to 'owner' (hand_off)");
}

// ── Uploading by REMOTE URL asks — it is a NETWORK_WRITE like any
// other, and does NOT hand off: no local file leaves the machine.
{
  const up = verdict({ kind: "web.upload", permission_class: "NETWORK_WRITE", payload: { source: "remote_url", url: "https://example.com/file.pdf" } });
  assert.equal(up.verdict, "ask");
  assert.equal(up.rule_id, "network-writes-ask");
  assert.equal(up.handoff_to, null);
  assert.equal(verdict({ kind: "web.upload", permission_class: "NETWORK_WRITE", payload: {} }).verdict, "ask");
  ok("Remote-URL uploads ask: web.upload with payload.source 'remote_url' (or no source) asks, and never hands off");
}

// ── Spending is denied by the LOCKED rule.
{
  const buy = verdict({ kind: "web.data.purchase", permission_class: "SPEND", payload: { price_usd: 25 } });
  assert.equal(buy.verdict, "deny");
  assert.equal(buy.rule_id, "spend-never");
  assert.equal(verdict({ kind: "web.subscription.start", permission_class: "SPEND", initiator: "routine" }).rule_id, "spend-never");
  ok("Spending denies via the locked rule: data.purchase and subscription.start refused by spend-never");
}

// ── Deleting is denied by the LOCKED rule.
{
  const del = verdict({ kind: "web.file.delete", permission_class: "DELETE", payload: { path: "notes/report.pdf" } });
  assert.equal(del.verdict, "deny");
  assert.equal(del.rule_id, "delete-never");
  assert.equal(verdict({ kind: "web.account.delete", permission_class: "DELETE", initiator: "routine" }).rule_id, "delete-never");
  ok("Deleting denies via the locked rule: file.delete and account.delete refused by delete-never");
}

// ── Strictest wins: tiers decide, not rule order. A local upload
// matches both the hand_off rule and the generic NETWORK_WRITE ask
// (hand_off wins), and a somehow-SPEND upload matches the locked
// deny (deny wins over both hand_off and ask).
{
  assert.equal(verdict({ kind: "web.upload", permission_class: "NETWORK_WRITE", payload: { source: "local_file" } }).verdict, "hand_off");
  const spendy = verdict({ kind: "web.upload", permission_class: "SPEND", payload: { source: "local_file" } });
  assert.equal(spendy.verdict, "deny");
  assert.equal(spendy.rule_id, "spend-never");
  ok("Strictest wins: local-upload hand_off beats the generic NETWORK_WRITE ask, and a SPEND-class upload denies via the locked rule");
}

// ── Fail closed: anything the pack does not map denies — unknown
// kinds, unmapped classes, malformed actions. No catch-all allow
// exists in the pack, so the engine's no-match default is the floor.
{
  const unknown = verdict({ kind: "web.teleport", permission_class: null });
  assert.equal(unknown.verdict, "deny");
  assert.equal(unknown.rule_id, null); // the fail-closed default, not a rule
  assert.equal(verdict({ kind: "web.script.run", permission_class: "EXECUTE" }).verdict, "deny");
  assert.equal(verdict({ kind: "", permission_class: null }).verdict, "deny");
  assert.equal(verdict({ kind: "", permission_class: null }).rule_id, null);
  ok("Fail closed: unknown kinds, unmapped EXECUTE, and malformed actions all deny with rule_id null");
}

// ── The locked layer cannot be tuned away: an overlay that tries to
// replace both locked denies with allows AND adds a catch-all
// allow-all changes none of the pack's restrictive verdicts
// (strictest-wins tiers + locked-rule merge semantics).
{
  const hostileOverlay: PolicyDoc = { rules: [
    { id: "spend-never", effect: "allow", when: "true" },
    { id: "delete-never", effect: "allow", when: "true" },
    { id: "allow-everything", effect: "allow", when: "true" },
  ] };
  const merged = compilePolicy(mergePolicyDocs(pack, hostileOverlay));
  for (const id of ["spend-never", "delete-never"]) {
    const rule = merged.source.rules.find((r) => r.id === id);
    assert.equal(rule?.effect, "deny");
    assert.equal(rule?.locked, true);
  }
  assert.equal(evaluatePolicy(merged, act({ kind: "web.data.purchase", permission_class: "SPEND" })).rule_id, "spend-never");
  assert.equal(evaluatePolicy(merged, act({ kind: "web.file.delete", permission_class: "DELETE" })).rule_id, "delete-never");
  assert.equal(evaluatePolicy(merged, act({ kind: "web.form.submit", permission_class: "NETWORK_WRITE" })).verdict, "ask");
  assert.equal(evaluatePolicy(merged, act({ kind: "web.upload", permission_class: "NETWORK_WRITE", payload: { source: "local_file" } })).verdict, "hand_off");
  ok("Locked layer survives overlays: replacing spend-never/delete-never is dropped, a catch-all allow outranks nothing restrictive, and the form ask holds");
}

console.log(`\nResearch Agent pack: all ${passed} behavior checks passed.`);
