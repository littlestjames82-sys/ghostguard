// Social Poster pack — behavior tests.
//
// Run from ~/workspace/policy-packs:  npm test
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

// An action in the social agent's vocabulary, classified per the pack
// README's map. Defaults: a person at the keyboard started the run.
const act = (over: Partial<PolicyContext>): PolicyContext => ({
  kind: "social.feed.read", permission_class: "READ", actor: "social-agent",
  project_id: "social", approved: false, initiator: "person", payload: {}, ...over,
});
const verdict = (over: Partial<PolicyContext>) => evaluatePolicy(pol, act(over));

// ── Pack integrity: the file compiles clean and its locked core is
// present — a pack that ships a broken rule fails here, not in use.
{
  assert.equal(pack.rules.length, 8);
  for (const r of pol.rules) assert.equal(r.error, null, `rule ${r.id} must compile`);
  const locked = pol.rules.filter((r) => r.locked);
  assert.deepEqual(locked.map((r) => r.id), ["spend-never"]);
  ok("Pack integrity: policy.json compiles with zero broken rules; the locked core is exactly [spend-never]");
}

// ── Reads and research are free — for a person AND for an unattended
// routine (initiator branching, permissive side).
{
  assert.equal(verdict({}).verdict, "allow");
  assert.equal(verdict({ kind: "social.search", payload: { q: "oakdale plumber" } }).rule_id, "reads-are-free");
  assert.equal(verdict({ kind: "social.profile.read" }).verdict, "allow");
  assert.equal(verdict({ kind: "social.metrics.read" }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine" }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine", kind: "social.search" }).rule_id, "reads-are-free");
  ok("Reads are free: feed/search/profile/metrics allow for person and routine initiators alike");
}

// ── Drafting is free (drafts are invisible until a publish action),
// again for both initiators.
{
  assert.equal(verdict({ kind: "social.draft.create", permission_class: "WRITE_LOCAL", payload: { text: "…" } }).verdict, "allow");
  assert.equal(verdict({ kind: "social.draft.edit", permission_class: "WRITE_LOCAL" }).rule_id, "drafting-is-free");
  assert.equal(verdict({ kind: "social.draft.create", permission_class: "WRITE_LOCAL", initiator: "routine" }).verdict, "allow");
  ok("Drafting is free: draft create/edit allow for person and routine initiators");
}

// ── Media upload is the pack's one standing approval — pre_approved,
// bounded to the upload kind; it is NOT a publish.
{
  const d = verdict({ kind: "social.media.upload", permission_class: "NETWORK_WRITE", payload: { file: "clip.mp4" } });
  assert.equal(d.verdict, "pre_approved");
  assert.equal(d.rule_id, "media-upload-pre-approved");
  ok("Media upload: pre_approved standing approval, bounded to social.media.upload");
}

// ── Publishing asks — the headline behavior. Person or routine, post
// or comment reply, the verdict is ask on the exact payload.
{
  const post = verdict({ kind: "social.post.publish", permission_class: "PUBLISH", payload: { text: "New video up" } });
  assert.equal(post.verdict, "ask");
  assert.equal(post.rule_id, "publishing-asks");
  assert.equal(verdict({ kind: "social.post.publish", permission_class: "PUBLISH", initiator: "routine" }).verdict, "ask");
  assert.equal(verdict({ kind: "social.comment.reply", permission_class: "PUBLISH", payload: { in_reply_to: "c_123" } }).verdict, "ask");
  ok("Publishing asks: post.publish and comment.reply ask for person and routine initiators");
}

// ── Auto-review never overrides ask: a payload flag claiming an
// automated review passed changes nothing, and a payload field named
// 'initiator' cannot spoof the run-stamped initiator.
{
  assert.equal(verdict({ kind: "social.post.publish", permission_class: "PUBLISH", payload: { text: "…", auto_review_passed: true } }).verdict, "ask");
  assert.equal(verdict({ kind: "social.post.publish", permission_class: "PUBLISH", initiator: "routine", payload: { initiator: "person" } }).verdict, "ask");
  ok("No downgrades: payload auto-review flags and payload initiator spoofing never soften a publish ask");
}

// ── DMs hand off to the owner — not an ask to this run's approver,
{
  const dm = verdict({ kind: "social.dm.send", permission_class: "COMMUNICATE", payload: { to: "customer", text: "…" } });
  assert.equal(dm.verdict, "hand_off");
  assert.equal(dm.rule_id, "dms-to-owner");
  assert.equal(dm.handoff_to, "owner");
  assert.equal(verdict({ kind: "social.dm.send", permission_class: "COMMUNICATE", initiator: "routine" }).verdict, "hand_off");
  ok("DMs hand off: social.dm.send routes to 'owner' (hand_off), for person and routine initiators");
}

// ── Deletes and account settings are denied, by name.
{
  const del = verdict({ kind: "social.post.delete", permission_class: "DELETE", payload: { post_id: "p_1" } });
  assert.equal(del.verdict, "deny");
  assert.equal(del.rule_id, "delete-never");
  const settings = verdict({ kind: "social.account.edit", permission_class: "NETWORK_WRITE", payload: { field: "display_name" } });
  assert.equal(settings.verdict, "deny");
  assert.equal(settings.rule_id, "account-settings-never");
  assert.equal(verdict({ kind: "social.account.credentials", permission_class: "EXECUTE" }).verdict, "deny");
  ok("Deletes and account settings deny: post.delete, account.edit, account.credentials all refused by name");
}

// ── Spending is denied by the LOCKED rule.
{
  const ad = verdict({ kind: "social.ads.create", permission_class: "SPEND", payload: { budget_usd: 50 } });
  assert.equal(ad.verdict, "deny");
  assert.equal(ad.rule_id, "spend-never");
  assert.equal(verdict({ kind: "social.post.boost", permission_class: "SPEND", initiator: "routine" }).rule_id, "spend-never");
  ok("Spending denies via the locked rule: ads.create and post.boost refused by spend-never");
}

// ── Fail closed: anything the pack does not map denies — unknown
// kinds, unmapped classes, malformed actions. No catch-all allow
// exists in the pack, so the engine's no-match default is the floor.
{
  const unknown = verdict({ kind: "social.teleport", permission_class: null });
  assert.equal(unknown.verdict, "deny");
  assert.equal(unknown.rule_id, null); // the fail-closed default, not a rule
  assert.equal(verdict({ kind: "social.webhook.register", permission_class: "NETWORK_WRITE" }).verdict, "deny");
  assert.equal(verdict({ kind: "social.unknown", permission_class: "EXECUTE" }).verdict, "deny");
  assert.equal(verdict({ kind: "", permission_class: null }).verdict, "deny");
  ok("Fail closed: unknown kinds, unmapped NETWORK_WRITE/EXECUTE, and malformed actions all deny");
}

// ── The locked layer cannot be tuned away: an overlay that tries to
// replace spend-never with an allow AND adds a catch-all allow-all
// changes none of the pack's restrictive verdicts (strictest-wins
// tiers + locked-rule merge semantics).
{
  const hostileOverlay: PolicyDoc = { rules: [
    { id: "spend-never", effect: "allow", when: "true" },
    { id: "allow-everything", effect: "allow", when: "true" },
  ] };
  const merged = compilePolicy(mergePolicyDocs(pack, hostileOverlay));
  const spendRule = merged.source.rules.find((r) => r.id === "spend-never");
  assert.equal(spendRule?.effect, "deny");
  assert.equal(spendRule?.locked, true);
  assert.equal(evaluatePolicy(merged, act({ kind: "social.ads.create", permission_class: "SPEND" })).rule_id, "spend-never");
  assert.equal(evaluatePolicy(merged, act({ kind: "social.post.publish", permission_class: "PUBLISH" })).verdict, "ask");
  assert.equal(evaluatePolicy(merged, act({ kind: "social.dm.send", permission_class: "COMMUNICATE" })).verdict, "hand_off");
  assert.equal(evaluatePolicy(merged, act({ kind: "social.post.delete", permission_class: "DELETE" })).verdict, "deny");
  ok("Locked layer survives overlays: replacing spend-never is dropped, and a catch-all allow outranks nothing restrictive");
}

console.log(`\nSocial Poster pack: all ${passed} behavior checks passed.`);
