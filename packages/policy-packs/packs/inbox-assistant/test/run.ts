// Inbox Assistant pack — behavior tests.
//
// Run from the policy-packs root:
//   npx tsx packs/inbox-assistant/test/run.ts
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

// An action in the inbox agent's vocabulary, classified per the pack
// README's map. Defaults: a person at the keyboard started the run.
const act = (over: Partial<PolicyContext>): PolicyContext => ({
  kind: "email.read", permission_class: "READ", actor: "inbox-agent",
  project_id: "inbox", approved: false, initiator: "person", payload: {}, ...over,
});
const verdict = (over: Partial<PolicyContext>) => evaluatePolicy(pol, act(over));

// ── Pack integrity: the file compiles clean and its locked core is
// present — a pack that ships a broken rule fails here, not in use.
{
  assert.equal(pack.rules.length, 6);
  for (const r of pol.rules) assert.equal(r.error, null, `rule ${r.id} must compile`);
  const locked = pol.rules.filter((r) => r.locked);
  assert.deepEqual(locked.map((r) => r.id), ["delete-never"]);
  ok("Pack integrity: policy.json compiles with zero broken rules; the locked core is exactly [delete-never]");
}

// ── Reads and triage are free — for a person AND for an unattended
// routine (initiator branching, permissive side).
{
  assert.equal(verdict({}).verdict, "allow");
  assert.equal(verdict({ kind: "email.search", payload: { q: "invoice" } }).rule_id, "reads-are-free");
  assert.equal(verdict({ kind: "email.thread.read" }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine" }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine", kind: "email.search" }).rule_id, "reads-are-free");
  ok("Reads are free: email.read/search/thread.read allow for person and routine initiators alike");
}

// ── Drafting is free (a draft has been sent to nobody), again for
// both initiators.
{
  assert.equal(verdict({ kind: "email.draft.create", permission_class: "WRITE_LOCAL", payload: { text: "…" } }).verdict, "allow");
  assert.equal(verdict({ kind: "email.draft.edit", permission_class: "WRITE_LOCAL" }).rule_id, "drafting-is-free");
  assert.equal(verdict({ kind: "email.draft.create", permission_class: "WRITE_LOCAL", initiator: "routine" }).verdict, "allow");
  ok("Drafting is free: draft create/edit allow for person and routine initiators");
}

// ── Plain sends ask — the headline behavior. Person or routine, the
// verdict is ask on the exact payload, and a plain send does NOT
// hand off: no attachment and no external recipient means the
// hand-off rule stays silent.
{
  const send = verdict({ kind: "email.send", permission_class: "COMMUNICATE", payload: { to: "teammate", text: "…" } });
  assert.equal(send.verdict, "ask");
  assert.equal(send.rule_id, "sends-ask");
  assert.equal(send.handoff_to, null);
  assert.equal(verdict({ kind: "email.send", permission_class: "COMMUNICATE", initiator: "routine" }).verdict, "ask");
  assert.equal(verdict({ kind: "email.send", permission_class: "COMMUNICATE", payload: { has_attachment: false, external_recipient: false } }).verdict, "ask");
  ok("Plain sends ask: email.send asks (never hands off) for person and routine initiators");
}

// ── Sends with an attachment hand off to the owner — not an ask to
// this run's approver.
{
  const att = verdict({ kind: "email.send", permission_class: "COMMUNICATE", payload: { to: "teammate", has_attachment: true } });
  assert.equal(att.verdict, "hand_off");
  assert.equal(att.rule_id, "risky-sends-to-owner");
  assert.equal(att.handoff_to, "owner");
  assert.equal(verdict({ kind: "email.send", permission_class: "COMMUNICATE", initiator: "routine", payload: { has_attachment: true } }).verdict, "hand_off");
  ok("Sends with attachments hand off: email.send with has_attachment routes to 'owner'");
}

// ── Sends to an external recipient hand off to the owner too — the
// exfiltration-shaped send gets the owner, not this run's approver.
{
  const ext = verdict({ kind: "email.send", permission_class: "COMMUNICATE", payload: { to: "outside@example.com", external_recipient: true } });
  assert.equal(ext.verdict, "hand_off");
  assert.equal(ext.rule_id, "risky-sends-to-owner");
  assert.equal(ext.handoff_to, "owner");
  ok("Sends to external recipients hand off: email.send with external_recipient routes to 'owner'");
}

// ── The initiator is not the payload: a payload field named
// 'initiator' spoofs nothing. A routine run claiming in its payload
// to be a person still gets the routine treatment — reads allow,
// sends ask, risky sends hand off.
{
  assert.equal(verdict({ initiator: "routine", payload: { initiator: "person" } }).verdict, "allow");
  assert.equal(verdict({ kind: "email.send", permission_class: "COMMUNICATE", initiator: "routine", payload: { initiator: "person" } }).verdict, "ask");
  assert.equal(verdict({ kind: "email.send", permission_class: "COMMUNICATE", initiator: "routine", payload: { initiator: "person", has_attachment: true } }).verdict, "hand_off");
  ok("No spoofing: a payload 'initiator' field changes nothing — routine runs keep routine verdicts");
}

// ── Deletes deny by the LOCKED rule, and filter/rule/settings
// changes deny by name — the pack's two refused surfaces.
{
  const del = verdict({ kind: "email.delete", permission_class: "DELETE", payload: { message_id: "m_1" } });
  assert.equal(del.verdict, "deny");
  assert.equal(del.rule_id, "delete-never");
  assert.equal(verdict({ kind: "message.delete", permission_class: "DELETE" }).rule_id, "delete-never");
  const filter = verdict({ kind: "email.filter.create", permission_class: "EXECUTE", payload: { match: "invoice", forward_to: "x" } });
  assert.equal(filter.verdict, "deny");
  assert.equal(filter.rule_id, "filters-and-settings-never");
  assert.equal(verdict({ kind: "email.rule.change", permission_class: "NETWORK_WRITE" }).rule_id, "filters-and-settings-never");
  assert.equal(verdict({ kind: "email.settings.forwarding", permission_class: "NETWORK_WRITE" }).rule_id, "filters-and-settings-never");
  ok("Deletes and filter/rule/settings changes deny: deletes by the locked delete-never, mail-flow changes by name");
}

// ── Strictest verdict wins, independent of rule order: a delete
// dressed up with send-shaped payload flags still denies (deny
// outranks hand_off), and the attachment hand_off outranks the
// plain-send ask it also matches.
{
  const dressed = verdict({ kind: "email.delete", permission_class: "DELETE", payload: { has_attachment: true, external_recipient: true } });
  assert.equal(dressed.verdict, "deny");
  assert.equal(dressed.rule_id, "delete-never");
  const risky = verdict({ kind: "email.send", permission_class: "COMMUNICATE", payload: { has_attachment: true } });
  assert.equal(risky.verdict, "hand_off");
  assert.notEqual(risky.rule_id, "sends-ask");
  ok("Strictest wins: a DELETE with send-shaped payload still denies, and attachment hand_off outranks the plain-send ask");
}

// ── Fail closed: anything the pack does not map denies — unknown
// kinds, unmapped classes, malformed actions. No catch-all allow
// exists in the pack, so the engine's no-match default is the floor.
{
  const unknown = verdict({ kind: "email.teleport", permission_class: null });
  assert.equal(unknown.verdict, "deny");
  assert.equal(unknown.rule_id, null); // the fail-closed default, not a rule
  assert.equal(verdict({ kind: "email.webhook.register", permission_class: "NETWORK_WRITE" }).verdict, "deny");
  assert.equal(verdict({ kind: "email.unknown", permission_class: "EXECUTE" }).verdict, "deny");
  assert.equal(verdict({ kind: "", permission_class: null }).verdict, "deny");
  assert.equal(verdict({ kind: "", permission_class: null }).rule_id, null);
  ok("Fail closed: unknown kinds, unmapped NETWORK_WRITE/EXECUTE, and malformed actions all deny");
}

// ── The locked layer cannot be tuned away: an overlay that tries to
// replace delete-never with an allow AND adds a catch-all allow-all
// changes none of the pack's restrictive verdicts (strictest-wins
// tiers + locked-rule merge semantics).
{
  const hostileOverlay: PolicyDoc = { rules: [
    { id: "delete-never", effect: "allow", when: "true" },
    { id: "allow-everything", effect: "allow", when: "true" },
  ] };
  const merged = compilePolicy(mergePolicyDocs(pack, hostileOverlay));
  const deleteRule = merged.source.rules.find((r) => r.id === "delete-never");
  assert.equal(deleteRule?.effect, "deny");
  assert.equal(deleteRule?.locked, true);
  assert.equal(evaluatePolicy(merged, act({ kind: "email.delete", permission_class: "DELETE" })).rule_id, "delete-never");
  assert.equal(evaluatePolicy(merged, act({ kind: "email.send", permission_class: "COMMUNICATE" })).verdict, "ask");
  assert.equal(evaluatePolicy(merged, act({ kind: "email.send", permission_class: "COMMUNICATE", payload: { has_attachment: true } })).verdict, "hand_off");
  assert.equal(evaluatePolicy(merged, act({ kind: "email.filter.create", permission_class: "EXECUTE" })).verdict, "deny");
  ok("Locked layer survives overlays: replacing delete-never is dropped, and a catch-all allow softens neither sends nor risky sends");
}

console.log(`\nInbox Assistant pack: all ${passed} behavior checks passed.`);
