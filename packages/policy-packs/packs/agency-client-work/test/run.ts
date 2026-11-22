// Agency Client Work pack — behavior tests.
//
// Run from the policy-packs root:
//   npx tsx packs/agency-client-work/test/run.ts
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

// An action in the agency agent's vocabulary, classified per the pack
// README's map. Defaults: a run scoped to client-a's project, started
// by a person at the keyboard.
const act = (over: Partial<PolicyContext>): PolicyContext => ({
  kind: "client.file.read", permission_class: "READ", actor: "agency-agent",
  project_id: "client-a", approved: false, initiator: "person", payload: {}, ...over,
});
const verdict = (over: Partial<PolicyContext>) => evaluatePolicy(pol, act(over));

// ── Pack integrity: the file compiles clean and its locked core is
// present — a pack that ships a broken rule fails here, not in use.
{
  assert.equal(pack.rules.length, 6);
  for (const r of pol.rules) assert.equal(r.error, null, `rule ${r.id} must compile`);
  const locked = pol.rules.filter((r) => r.locked);
  assert.deepEqual(locked.map((r) => r.id), ["cross-client-never"]);
  ok("Pack integrity: policy.json compiles with zero broken rules; the locked core is exactly [cross-client-never]");
}

// ── In-project reads are free — for a person AND for an unattended
// routine (initiator branching, permissive side).
{
  assert.equal(verdict({}).verdict, "allow");
  assert.equal(verdict({}).rule_id, "reads-are-free");
  assert.equal(verdict({ kind: "client.doc.read", payload: { doc: "brief.pdf" } }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine" }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine", kind: "client.doc.read" }).rule_id, "reads-are-free");
  ok("In-project reads are free: file.read and doc.read allow for person and routine initiators alike");
}

// ── Internal writes and drafts are free — nothing has left the
// project, reached a client, or spent anything.
{
  assert.equal(verdict({ kind: "client.file.write", permission_class: "WRITE_LOCAL", payload: { path: "deck.md" } }).verdict, "allow");
  assert.equal(verdict({ kind: "client.file.write", permission_class: "WRITE_LOCAL" }).rule_id, "internal-writes-are-free");
  assert.equal(verdict({ kind: "client.draft.create", permission_class: "WRITE_LOCAL", payload: { title: "Proposal draft" } }).verdict, "allow");
  assert.equal(verdict({ kind: "client.draft.create", permission_class: "WRITE_LOCAL", initiator: "routine" }).verdict, "allow");
  ok("Internal writes and drafts are free: file.write and draft.create allow for person and routine initiators");
}

// ── Client comms hand off to the owner — not an ask to this run's
// approver, for message and email kinds, person and routine alike.
{
  const msg = verdict({ kind: "client.message.send", permission_class: "COMMUNICATE", payload: { to: "client", text: "…" } });
  assert.equal(msg.verdict, "hand_off");
  assert.equal(msg.rule_id, "comms-to-owner");
  assert.equal(msg.handoff_to, "owner");
  assert.equal(verdict({ kind: "client.email.send", permission_class: "COMMUNICATE", payload: { to: "client@example.com" } }).verdict, "hand_off");
  assert.equal(verdict({ kind: "client.email.send", permission_class: "COMMUNICATE", initiator: "routine" }).handoff_to, "owner");
  assert.equal(verdict({ kind: "client.message.send", permission_class: "COMMUNICATE", initiator: "routine" }).verdict, "hand_off");
  ok("Client comms hand off: message.send and email.send route to 'owner' (hand_off), for person and routine initiators");
}

// ── Sending files outside the project asks — send and share kinds,
// classified NETWORK_WRITE with payload.external == true.
{
  const send = verdict({ kind: "client.file.send", permission_class: "NETWORK_WRITE", payload: { external: true, file: "deck.pdf" } });
  assert.equal(send.verdict, "ask");
  assert.equal(send.rule_id, "external-file-send-asks");
  assert.equal(verdict({ kind: "client.file.share", permission_class: "NETWORK_WRITE", payload: { external: true, link: "…" } }).verdict, "ask");
  assert.equal(verdict({ kind: "client.file.send", permission_class: "NETWORK_WRITE", initiator: "routine", payload: { external: true } }).verdict, "ask");
  ok("External file sends ask: file.send and file.share ask for person and routine initiators");
}

// ── Spending asks — client money moves only with a human's approval.
{
  const spend = verdict({ kind: "client.spend", permission_class: "SPEND", payload: { amount_usd: 200 } });
  assert.equal(spend.verdict, "ask");
  assert.equal(spend.rule_id, "spend-asks");
  assert.equal(verdict({ kind: "client.ads.buy", permission_class: "SPEND", payload: { amount_usd: 50 } }).verdict, "ask");
  assert.equal(verdict({ kind: "client.spend", permission_class: "SPEND", initiator: "routine" }).verdict, "ask");
  ok("Spending asks: client.spend and client.ads.buy ask for person and routine initiators");
}

// ── Cross-client access is denied by the LOCKED rule: a read whose
// payload names a different client project than the run's project_id.
{
  const read = verdict({ payload: { target_project_id: "client-b" } });
  assert.equal(read.verdict, "deny");
  assert.equal(read.rule_id, "cross-client-never");
  assert.equal(verdict({ kind: "client.doc.read", payload: { target_project_id: "client-b" } }).rule_id, "cross-client-never");
  assert.equal(verdict({ kind: "client.file.write", permission_class: "WRITE_LOCAL", payload: { target_project_id: "client-b" } }).verdict, "deny");
  assert.equal(verdict({ initiator: "routine", payload: { target_project_id: "client-b" } }).verdict, "deny");
  ok("Cross-client access denies via the locked rule: reads and writes naming another client project are refused by cross-client-never");
}

// ── Cross-client SEND denies — it does NOT hand off. The locked deny
// is stricter than the comms hand_off and the file-send ask, so a
// send aimed into another client's project is refused outright.
// This is the pack's key strictest-wins test.
{
  const send = verdict({ kind: "client.message.send", permission_class: "COMMUNICATE", payload: { target_project_id: "client-b", text: "…" } });
  assert.equal(send.verdict, "deny");
  assert.equal(send.rule_id, "cross-client-never");
  assert.equal(send.handoff_to, null);
  const fileSend = verdict({ kind: "client.file.send", permission_class: "NETWORK_WRITE", payload: { external: true, target_project_id: "client-b" } });
  assert.equal(fileSend.verdict, "deny");
  assert.equal(fileSend.rule_id, "cross-client-never");
  ok("Cross-client sends deny (strictest wins): a cross-client message denies by cross-client-never instead of handing off, and a cross-client file send denies instead of asking");
}

// ── The cross-client rule does not misfire: a target that MATCHES the
// run's project, an explicitly null target, and no target at all all
// proceed under their ordinary rules.
{
  const comms = verdict({ kind: "client.message.send", permission_class: "COMMUNICATE", payload: { target_project_id: "client-a" } });
  assert.equal(comms.verdict, "hand_off");
  assert.equal(comms.rule_id, "comms-to-owner");
  assert.equal(verdict({ payload: { target_project_id: "client-a" } }).verdict, "allow");
  assert.equal(verdict({ payload: {} }).verdict, "allow");
  assert.equal(verdict({ payload: { target_project_id: null } }).verdict, "allow");
  ok("No misfires: matching target_project_id comms still hand off, and matching, null, or absent targets leave in-project reads allowed");
}

// ── Fail closed: DELETE is deliberately unmapped in this pack, so a
// delete matches no rule and denies by the engine's default
// (rule_id null) — as do unknown kinds and unmapped classes.
{
  const del = verdict({ kind: "client.file.delete", permission_class: "DELETE", payload: { path: "old.pdf" } });
  assert.equal(del.verdict, "deny");
  assert.equal(del.rule_id, null); // the fail-closed default, not a rule
  const unknown = verdict({ kind: "client.teleport", permission_class: null });
  assert.equal(unknown.verdict, "deny");
  assert.equal(unknown.rule_id, null);
  assert.equal(verdict({ kind: "client.webhook.register", permission_class: "NETWORK_WRITE" }).verdict, "deny");
  assert.equal(verdict({ kind: "client.unknown", permission_class: "EXECUTE" }).verdict, "deny");
  assert.equal(verdict({ kind: "", permission_class: null }).verdict, "deny");
  ok("Fail closed: DELETE denies by the no-match default (rule_id null), as do unknown kinds, unmapped NETWORK_WRITE/EXECUTE, and malformed actions");
}

// ── The locked layer cannot be tuned away, and payload spoofing
// changes nothing: an overlay that tries to replace cross-client-never
// with an allow AND adds a catch-all allow-all softens neither the
// cross-client deny, the comms hand_off, nor the spend ask; a payload
// field named 'initiator' is not the run-stamped initiator.
{
  assert.equal(verdict({ kind: "client.message.send", permission_class: "COMMUNICATE", initiator: "routine", payload: { initiator: "person" } }).verdict, "hand_off");
  assert.equal(verdict({ kind: "client.spend", permission_class: "SPEND", payload: { initiator: "person", amount_usd: 10 } }).verdict, "ask");
  assert.equal(verdict({ initiator: "routine", payload: { initiator: "person", target_project_id: "client-b" } }).verdict, "deny");
  const hostileOverlay: PolicyDoc = { rules: [
    { id: "cross-client-never", effect: "allow", when: "true" },
    { id: "allow-everything", effect: "allow", when: "true" },
  ] };
  const merged = compilePolicy(mergePolicyDocs(pack, hostileOverlay));
  const crossRule = merged.source.rules.find((r) => r.id === "cross-client-never");
  assert.equal(crossRule?.effect, "deny");
  assert.equal(crossRule?.locked, true);
  assert.equal(evaluatePolicy(merged, act({ payload: { target_project_id: "client-b" } })).rule_id, "cross-client-never");
  assert.equal(evaluatePolicy(merged, act({ kind: "client.message.send", permission_class: "COMMUNICATE" })).verdict, "hand_off");
  assert.equal(evaluatePolicy(merged, act({ kind: "client.spend", permission_class: "SPEND" })).verdict, "ask");
  assert.equal(evaluatePolicy(merged, act({ kind: "client.file.send", permission_class: "NETWORK_WRITE", payload: { external: true } })).verdict, "ask");
  ok("Locked layer survives overlays and spoofs: replacing cross-client-never is dropped, a catch-all allow outranks neither comms hand_off nor spend/file-send asks, and payload initiator spoofing changes nothing");
}

console.log(`\nAgency Client Work pack: all ${passed} behavior checks passed.`);
