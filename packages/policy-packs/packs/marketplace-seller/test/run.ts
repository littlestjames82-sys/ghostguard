// Marketplace Seller pack — behavior tests.
//
// Run from the policy-packs root:
//   npx tsx packs/marketplace-seller/test/run.ts
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

// An action in the marketplace seller agent's vocabulary, classified
// per the pack README's map. Defaults: a person at the keyboard
// started the run.
const act = (over: Partial<PolicyContext>): PolicyContext => ({
  kind: "market.listing.browse", permission_class: "READ", actor: "seller-agent",
  project_id: "marketplace", approved: false, initiator: "person", payload: {}, ...over,
});
const verdict = (over: Partial<PolicyContext>) => evaluatePolicy(pol, act(over));

// ── Pack integrity: the file compiles clean and its locked core is
// present — a pack that ships a broken rule fails here, not in use.
{
  assert.equal(pack.rules.length, 7);
  for (const r of pol.rules) assert.equal(r.error, null, `rule ${r.id} must compile`);
  const locked = pol.rules.filter((r) => r.locked);
  assert.deepEqual(locked.map((r) => r.id), ["delete-never", "payout-never"]);
  ok("Pack integrity: policy.json compiles with zero broken rules; the locked core is exactly [delete-never, payout-never]");
}

// ── Browsing and reading the seller's own listings are free — for a
// person AND for an unattended routine (initiator branching,
// permissive side).
{
  assert.equal(verdict({}).verdict, "allow");
  assert.equal(verdict({}).rule_id, "browsing-is-free");
  assert.equal(verdict({ kind: "market.listing.search", payload: { q: "oak table" } }).verdict, "allow");
  assert.equal(verdict({ kind: "market.listing.own.read", payload: { listing_id: "l_1" } }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine" }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine", kind: "market.listing.search" }).rule_id, "browsing-is-free");
  ok("Browsing is free: listing browse/search and reading the seller's own listings allow for person and routine initiators alike");
}

// ── Drafting is free — the pack's headline. A listing draft and a
// reply draft are both local and invisible to buyers.
{
  assert.equal(verdict({ kind: "market.listing.draft", permission_class: "WRITE_LOCAL", payload: { title: "Oak table" } }).verdict, "allow");
  assert.equal(verdict({ kind: "market.listing.draft", permission_class: "WRITE_LOCAL" }).rule_id, "drafting-is-free");
  assert.equal(verdict({ kind: "market.message.draft.create", permission_class: "WRITE_LOCAL", payload: { text: "Yes, still available" } }).verdict, "allow");
  assert.equal(verdict({ kind: "market.message.draft.create", permission_class: "WRITE_LOCAL", initiator: "routine" }).verdict, "allow");
  ok("Drafting is free: listing drafts and reply drafts allow for person and routine initiators");
}

// ── Sending messages asks — drafting the reply was free; delivering
// it to a real buyer is not.
{
  const msg = verdict({ kind: "market.message.send", permission_class: "COMMUNICATE", payload: { to: "buyer", text: "…" } });
  assert.equal(msg.verdict, "ask");
  assert.equal(msg.rule_id, "message-sends-ask");
  assert.equal(verdict({ kind: "market.message.send", permission_class: "COMMUNICATE", initiator: "routine" }).verdict, "ask");
  ok("Message sends ask: market.message.send asks for person and routine initiators");
}

// ── Sending offers asks — an offer is a binding price commitment,
// classified NETWORK_WRITE and governed by its own kind rule.
{
  const offer = verdict({ kind: "market.offer.send", permission_class: "NETWORK_WRITE", payload: { listing_id: "l_1", amount_usd: 80 } });
  assert.equal(offer.verdict, "ask");
  assert.equal(offer.rule_id, "offer-sends-ask");
  assert.equal(verdict({ kind: "market.offer.send", permission_class: "NETWORK_WRITE", initiator: "routine" }).verdict, "ask");
  ok("Offer sends ask: market.offer.send asks for person and routine initiators");
}

// ── Price changes ask — a public commitment a human approves first.
{
  const price = verdict({ kind: "market.price.change", permission_class: "NETWORK_WRITE", payload: { listing_id: "l_1", price_usd: 95 } });
  assert.equal(price.verdict, "ask");
  assert.equal(price.rule_id, "price-changes-ask");
  assert.equal(verdict({ kind: "market.price.change", permission_class: "NETWORK_WRITE", initiator: "routine" }).verdict, "ask");
  ok("Price changes ask: market.price.change asks for person and routine initiators");
}

// ── Listing deletes are denied by the LOCKED delete-never rule —
// from a person, and just the same from an unattended routine.
{
  const del = verdict({ kind: "market.listing.delete", permission_class: "DELETE", payload: { listing_id: "l_1" } });
  assert.equal(del.verdict, "deny");
  assert.equal(del.rule_id, "delete-never");
  assert.equal(verdict({ kind: "market.listing.delete", permission_class: "DELETE", initiator: "routine" }).rule_id, "delete-never");
  ok("Listing deletes deny via the locked rule: market.listing.delete refused by delete-never for person and routine initiators");
}

// ── Payout and bank changes are denied by the LOCKED payout-never
// rule. Strictest wins: a payout change is classified NETWORK_WRITE —
// the same class whose price-change and offer rules ask — and still
// denies, by name (rule_id proves the locked rule fired; this is not
// the fail-closed default).
{
  const payout = verdict({ kind: "market.payout.change", permission_class: "NETWORK_WRITE", payload: { method: "bank" } });
  assert.equal(payout.verdict, "deny");
  assert.equal(payout.rule_id, "payout-never");
  assert.equal(verdict({ kind: "market.payout.schedule", permission_class: "NETWORK_WRITE" }).rule_id, "payout-never");
  const bank = verdict({ kind: "market.bank.change", permission_class: "NETWORK_WRITE", payload: { field: "account" } });
  assert.equal(bank.verdict, "deny");
  assert.equal(bank.rule_id, "payout-never");
  assert.equal(verdict({ kind: "market.bank.update", permission_class: "EXECUTE" }).verdict, "deny");
  assert.equal(verdict({ kind: "market.payout.change", permission_class: "NETWORK_WRITE", initiator: "routine" }).verdict, "deny");
  ok("Payout and bank changes deny via the locked rule: market.payout.* and market.bank.* refused by payout-never, despite sharing NETWORK_WRITE with the ask rules");
}

// ── Fail closed: SPEND is unmapped in this pack (a seller agent never
// spends), so it denies by the engine's default (rule_id null) — as
// do unknown kinds, unmapped classes, and malformed actions.
{
  const spend = verdict({ kind: "market.purchase", permission_class: "SPEND", payload: { amount_usd: 20 } });
  assert.equal(spend.verdict, "deny");
  assert.equal(spend.rule_id, null); // the fail-closed default, not a rule
  const unknown = verdict({ kind: "market.teleport", permission_class: null });
  assert.equal(unknown.verdict, "deny");
  assert.equal(unknown.rule_id, null);
  assert.equal(verdict({ kind: "market.unknown", permission_class: "EXECUTE" }).verdict, "deny");
  assert.equal(verdict({ kind: "", permission_class: null }).verdict, "deny");
  ok("Fail closed: SPEND denies by the no-match default (rule_id null), as do unknown kinds, unmapped EXECUTE, and malformed actions");
}

// ── No routine discount and no spoofing: routines browse and draft
// freely, but a routine's message send still asks — and a payload
// field named 'initiator' claiming a person started the run changes
// nothing, because rules read the run-stamped initiator.
{
  assert.equal(verdict({ initiator: "routine" }).verdict, "allow");
  assert.equal(verdict({ kind: "market.message.draft.create", permission_class: "WRITE_LOCAL", initiator: "routine" }).verdict, "allow");
  assert.equal(verdict({ kind: "market.message.send", permission_class: "COMMUNICATE", initiator: "routine", payload: { initiator: "person" } }).verdict, "ask");
  assert.equal(verdict({ kind: "market.offer.send", permission_class: "NETWORK_WRITE", payload: { initiator: "person" } }).verdict, "ask");
  assert.equal(verdict({ kind: "market.listing.delete", permission_class: "DELETE", payload: { initiator: "person" } }).verdict, "deny");
  ok("No spoofs, no routine discount: routines browse and draft freely but still ask to send, and payload initiator spoofing softens neither an ask nor a locked deny");
}

// ── The locked layer cannot be tuned away: an overlay that tries to
// replace BOTH locked rules with allows AND adds a catch-all
// allow-all changes none of the pack's restrictive verdicts
// (strictest-wins tiers + locked-rule merge semantics).
{
  const hostileOverlay: PolicyDoc = { rules: [
    { id: "delete-never", effect: "allow", when: "true" },
    { id: "payout-never", effect: "allow", when: "true" },
    { id: "allow-everything", effect: "allow", when: "true" },
  ] };
  const merged = compilePolicy(mergePolicyDocs(pack, hostileOverlay));
  const deleteRule = merged.source.rules.find((r) => r.id === "delete-never");
  assert.equal(deleteRule?.effect, "deny");
  assert.equal(deleteRule?.locked, true);
  const payoutRule = merged.source.rules.find((r) => r.id === "payout-never");
  assert.equal(payoutRule?.effect, "deny");
  assert.equal(payoutRule?.locked, true);
  assert.equal(evaluatePolicy(merged, act({ kind: "market.listing.delete", permission_class: "DELETE" })).rule_id, "delete-never");
  assert.equal(evaluatePolicy(merged, act({ kind: "market.payout.change", permission_class: "NETWORK_WRITE" })).rule_id, "payout-never");
  assert.equal(evaluatePolicy(merged, act({ kind: "market.bank.change", permission_class: "NETWORK_WRITE" })).verdict, "deny");
  assert.equal(evaluatePolicy(merged, act({ kind: "market.message.send", permission_class: "COMMUNICATE" })).verdict, "ask");
  assert.equal(evaluatePolicy(merged, act({ kind: "market.price.change", permission_class: "NETWORK_WRITE" })).verdict, "ask");
  ok("Locked layer survives overlays: replacing either locked rule is dropped, and a catch-all allow outranks neither locked deny nor the message/price asks");
}

console.log(`\nMarketplace Seller pack: all ${passed} behavior checks passed.`);
