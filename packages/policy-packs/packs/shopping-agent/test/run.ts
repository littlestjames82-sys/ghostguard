// Shopping Agent pack — behavior tests.
//
// Run from the policy-packs root:
//   npx tsx packs/shopping-agent/test/run.ts
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

// An action in the shopping agent's vocabulary, classified per the
// pack README's map. Defaults: a person at the keyboard started the run.
const act = (over: Partial<PolicyContext>): PolicyContext => ({
  kind: "shop.browse", permission_class: "READ", actor: "shopping-agent",
  project_id: "shopping", approved: false, initiator: "person", payload: {}, ...over,
});
const verdict = (over: Partial<PolicyContext>) => evaluatePolicy(pol, act(over));

// ── Pack integrity: the file compiles clean and its locked core is
// present — a pack that ships a broken rule fails here, not in use.
{
  assert.equal(pack.rules.length, 6);
  for (const r of pol.rules) assert.equal(r.error, null, `rule ${r.id} must compile`);
  const locked = pol.rules.filter((r) => r.locked);
  assert.deepEqual(locked.map((r) => r.id), ["gift-cards-never", "subscriptions-never"]);
  ok("Pack integrity: policy.json compiles with zero broken rules; the locked core is exactly [gift-cards-never, subscriptions-never]");
}

// ── Browsing and research are free — for a person AND for an
// unattended routine (initiator branching, permissive side).
{
  assert.equal(verdict({}).verdict, "allow");
  assert.equal(verdict({ kind: "shop.search", payload: { q: "standing desk" } }).rule_id, "reads-are-free");
  assert.equal(verdict({ kind: "shop.product.read" }).verdict, "allow");
  assert.equal(verdict({ kind: "shop.compare" }).verdict, "allow");
  assert.equal(verdict({ kind: "shop.order.track" }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine" }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine", kind: "shop.search" }).rule_id, "reads-are-free");
  ok("Research is free: browse/search/product.read/compare/order.track allow for person and routine initiators alike");
}

// ── Cart-building is free (nothing is bought until checkout), again
// for both initiators.
{
  assert.equal(verdict({ kind: "shop.cart.add", permission_class: "WRITE_LOCAL", payload: { sku: "desk-1" } }).verdict, "allow");
  assert.equal(verdict({ kind: "shop.cart.edit", permission_class: "WRITE_LOCAL" }).rule_id, "cart-is-free");
  assert.equal(verdict({ kind: "shop.wishlist.add", permission_class: "WRITE_LOCAL" }).verdict, "allow");
  assert.equal(verdict({ kind: "shop.cart.add", permission_class: "WRITE_LOCAL", initiator: "routine" }).verdict, "allow");
  ok("Cart-building is free: cart add/edit and wishlist add allow for person and routine initiators");
}

// ── Checkout at or under the cap asks — the headline behavior. And
// the initiator discipline: a routine checkout asks exactly like a
// person's, and a payload field named 'initiator' spoofs nothing
// (payload.item_kind is real classification data; payload.initiator
// is not the run-stamped initiator).
{
  const buy = verdict({ kind: "shop.checkout", permission_class: "SPEND", payload: { amount_usd: 120 } });
  assert.equal(buy.verdict, "ask");
  assert.equal(buy.rule_id, "spending-asks");
  assert.equal(buy.handoff_to, null);
  assert.equal(verdict({ kind: "shop.checkout", permission_class: "SPEND", initiator: "routine", payload: { amount_usd: 120 } }).verdict, "ask");
  assert.equal(verdict({ kind: "shop.checkout", permission_class: "SPEND", initiator: "routine", payload: { amount_usd: 120, initiator: "person" } }).verdict, "ask");
  ok("Checkout under the cap asks: $120 checkout asks for person and routine, and payload initiator spoofing changes nothing");
}

// ── The cap bound is strict: exactly $500 still asks, $501 hands
// off to the budget owner — not an ask to this run's approver.
{
  const atCap = verdict({ kind: "shop.checkout", permission_class: "SPEND", payload: { amount_usd: 500 } });
  assert.equal(atCap.verdict, "ask");
  assert.equal(atCap.rule_id, "spending-asks");
  const over = verdict({ kind: "shop.checkout", permission_class: "SPEND", payload: { amount_usd: 501 } });
  assert.equal(over.verdict, "hand_off");
  assert.equal(over.rule_id, "over-cap-to-budget-owner");
  assert.equal(over.handoff_to, "budget-owner");
  assert.equal(verdict({ kind: "shop.checkout", permission_class: "SPEND", payload: { amount_usd: 1200 } }).handoff_to, "budget-owner");
  ok("Cap boundary: checkout at exactly $500 asks; $501 and above hand off to 'budget-owner'");
}

// ── Subscriptions deny by a LOCKED rule — even a $5 one. Price is
// no defense: a subscription is a recurring commitment, not a buy.
{
  const sub = verdict({ kind: "shop.subscribe", permission_class: "SPEND", payload: { item_kind: "subscription", amount_usd: 5 } });
  assert.equal(sub.verdict, "deny");
  assert.equal(sub.rule_id, "subscriptions-never");
  assert.equal(verdict({ kind: "shop.subscribe", permission_class: "SPEND", initiator: "routine", payload: { item_kind: "subscription", amount_usd: 15 } }).rule_id, "subscriptions-never");
  ok("Subscriptions deny via the locked rule: shop.subscribe refused by subscriptions-never, even at $5");
}

// ── Gift cards deny by a LOCKED rule — the fraud instrument gets
// no ask and no hand-off, at any amount.
{
  const gc = verdict({ kind: "shop.giftcard.buy", permission_class: "SPEND", payload: { item_kind: "gift_card", amount_usd: 25 } });
  assert.equal(gc.verdict, "deny");
  assert.equal(gc.rule_id, "gift-cards-never");
  assert.equal(verdict({ kind: "shop.giftcard.buy", permission_class: "SPEND", initiator: "routine", payload: { item_kind: "gift_card", amount_usd: 100 } }).rule_id, "gift-cards-never");
  ok("Gift cards deny via the locked rule: shop.giftcard.buy refused by gift-cards-never");
}

// ── A SPEND with no amount asks — it must NOT deny by evaluation
// error. The over-cap rule guards amount != null after the SPEND
// discriminator, so a missing amount short-circuits safely and the
// generic spend ask decides.
{
  const noAmount = verdict({ kind: "shop.checkout", permission_class: "SPEND", payload: {} });
  assert.equal(noAmount.verdict, "ask");
  assert.equal(noAmount.rule_id, "spending-asks");
  assert.equal(verdict({ kind: "shop.checkout", permission_class: "SPEND", payload: { item_kind: "one_off" } }).verdict, "ask");
  ok("Missing amount asks (no error-deny): a SPEND with no amount_usd falls through to spending-asks");
}

// ── Strictest verdict wins, independent of rule order: a gift card
// or subscription priced over the cap still denies — the locked
// denies outrank the over-cap hand_off they also match.
{
  const gcOver = verdict({ kind: "shop.giftcard.buy", permission_class: "SPEND", payload: { item_kind: "gift_card", amount_usd: 900 } });
  assert.equal(gcOver.verdict, "deny");
  assert.equal(gcOver.rule_id, "gift-cards-never");
  const subOver = verdict({ kind: "shop.subscribe", permission_class: "SPEND", payload: { item_kind: "subscription", amount_usd: 900 } });
  assert.equal(subOver.verdict, "deny");
  assert.equal(subOver.rule_id, "subscriptions-never");
  ok("Strictest wins: over-cap gift cards and subscriptions deny by the locked rules, never hand off");
}

// ── Fail closed: anything the pack does not map denies — unknown
// kinds, unmapped classes (price alerts/watches are unmapped until
// deliberately classified), malformed actions.
{
  const unknown = verdict({ kind: "shop.teleport", permission_class: null });
  assert.equal(unknown.verdict, "deny");
  assert.equal(unknown.rule_id, null); // the fail-closed default, not a rule
  assert.equal(verdict({ kind: "shop.price.watch", permission_class: "NETWORK_WRITE" }).verdict, "deny");
  assert.equal(verdict({ kind: "shop.price.watch", permission_class: "NETWORK_WRITE" }).rule_id, null);
  assert.equal(verdict({ kind: "shop.unknown", permission_class: "EXECUTE" }).verdict, "deny");
  assert.equal(verdict({ kind: "", permission_class: null }).verdict, "deny");
  ok("Fail closed: unknown kinds, unmapped price-alert/watch kinds, and malformed actions all deny");
}

// ── The locked layer cannot be tuned away: an overlay that tries
// to replace BOTH locked rules with allows AND adds a catch-all
// allow-all changes none of the pack's restrictive verdicts.
{
  const hostileOverlay: PolicyDoc = { rules: [
    { id: "gift-cards-never", effect: "allow", when: "true" },
    { id: "subscriptions-never", effect: "allow", when: "true" },
    { id: "allow-everything", effect: "allow", when: "true" },
  ] };
  const merged = compilePolicy(mergePolicyDocs(pack, hostileOverlay));
  const gcRule = merged.source.rules.find((r) => r.id === "gift-cards-never");
  assert.equal(gcRule?.effect, "deny");
  assert.equal(gcRule?.locked, true);
  const subRule = merged.source.rules.find((r) => r.id === "subscriptions-never");
  assert.equal(subRule?.effect, "deny");
  assert.equal(subRule?.locked, true);
  assert.equal(evaluatePolicy(merged, act({ kind: "shop.giftcard.buy", permission_class: "SPEND", payload: { item_kind: "gift_card", amount_usd: 25 } })).rule_id, "gift-cards-never");
  assert.equal(evaluatePolicy(merged, act({ kind: "shop.subscribe", permission_class: "SPEND", payload: { item_kind: "subscription", amount_usd: 5 } })).rule_id, "subscriptions-never");
  assert.equal(evaluatePolicy(merged, act({ kind: "shop.checkout", permission_class: "SPEND", payload: { amount_usd: 120 } })).verdict, "ask");
  assert.equal(evaluatePolicy(merged, act({ kind: "shop.checkout", permission_class: "SPEND", payload: { amount_usd: 900 } })).verdict, "hand_off");
  ok("Locked layer survives overlays: replacing the locked denies is dropped, and a catch-all allow softens neither checkout asks nor the cap hand-off");
}

console.log(`\nShopping Agent pack: all ${passed} behavior checks passed.`);
