// Home Assistant pack — behavior tests.
//
// Run from the policy-packs root:
//   npx tsx packs/home-assistant/test/run.ts
//
// These tests are part of the product: they execute the pack's
// policy.json against the REAL GhostGuard engine (imported from the
// GhostGuard package — never a fork, never a vendored copy) and
// assert the verdict for every behavior the pack's README promises,
// including the initiator branching (this pack's headline), the
// fail-closed edges, and the locked layer.
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

// An action in the home agent's vocabulary, classified per the pack
// README's map. Defaults: the homeowner (a person) started the run,
// reading a sensor.
const act = (over: Partial<PolicyContext>): PolicyContext => ({
  kind: "home.sensor.read", permission_class: "READ", actor: "home-agent",
  project_id: "home", approved: false, initiator: "person", payload: {}, ...over,
});
const verdict = (over: Partial<PolicyContext>) => evaluatePolicy(pol, act(over));

// ── Pack integrity: the file compiles clean and its locked core is
// present — a pack that ships a broken rule fails here, not in use.
{
  assert.equal(pack.rules.length, 9);
  for (const r of pol.rules) assert.equal(r.error, null, `rule ${r.id} must compile`);
  const locked = pol.rules.filter((r) => r.locked);
  assert.deepEqual(locked.map((r) => r.id), ["security-never", "delete-never"]);
  ok("Pack integrity: policy.json compiles with zero broken rules; the locked core is exactly [security-never, delete-never]");
}

// ── Reads are free — for the owner AND for every non-owner initiator.
// Sensors, climate state, and camera snapshots change nothing, so
// unattended runs keep them: a routine may check the house at 2am.
{
  assert.equal(verdict({}).verdict, "allow");
  assert.equal(verdict({ kind: "home.climate.read" }).rule_id, "reads-are-free");
  assert.equal(verdict({ kind: "home.camera.snapshot.view", payload: { camera: "porch" } }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine" }).verdict, "allow");
  assert.equal(verdict({ initiator: "routine", kind: "home.climate.read" }).rule_id, "reads-are-free");
  assert.equal(verdict({ initiator: "handoff", kind: "home.camera.snapshot.view" }).verdict, "allow");
  assert.equal(verdict({ initiator: "memory" }).verdict, "allow");
  assert.equal(verdict({ initiator: "system" }).verdict, "allow");
  ok("Reads are free: sensor/climate/camera reads allow for person, routine, handoff, memory, and system initiators alike");
}

// ── Lights, media, and thermostat are pre-approved for the owner —
// a bounded standing approval over exactly those three kinds. A
// payload field named 'initiator' claiming "routine" spoofs nothing:
// the run-stamped initiator (person) is what the rules see.
{
  const lights = verdict({ kind: "home.light.set", permission_class: "EXECUTE", payload: { room: "kitchen", on: true } });
  assert.equal(lights.verdict, "pre_approved");
  assert.equal(lights.rule_id, "devices-pre-approved");
  assert.equal(verdict({ kind: "home.media.play", permission_class: "EXECUTE", payload: { uri: "playlist:evening" } }).verdict, "pre_approved");
  assert.equal(verdict({ kind: "home.thermostat.set", permission_class: "EXECUTE", payload: { target_c: 21 } }).verdict, "pre_approved");
  assert.equal(verdict({ kind: "home.light.set", permission_class: "EXECUTE", payload: { initiator: "routine" } }).verdict, "pre_approved");
  ok("Device actuation pre-approved for the owner: light.set, media.play, thermostat.set run on standing approval — payload initiator spoofing changes nothing");
}

// ── THE INITIATOR BRANCH: the identical action, started unattended,
// asks. A routine turning the lights on hits unattended-actuation-asks
// (ask tier) which outranks devices-pre-approved — and a payload
// field named 'initiator' claiming "person" cannot soften it back.
{
  const routineLights = verdict({ kind: "home.light.set", permission_class: "EXECUTE", initiator: "routine", payload: { room: "kitchen", on: true } });
  assert.equal(routineLights.verdict, "ask");
  assert.equal(routineLights.rule_id, "unattended-actuation-asks");
  assert.equal(verdict({ kind: "home.media.play", permission_class: "EXECUTE", initiator: "routine" }).verdict, "ask");
  assert.equal(verdict({ kind: "home.thermostat.set", permission_class: "EXECUTE", initiator: "memory", payload: { target_c: 18 } }).verdict, "ask");
  assert.equal(verdict({ kind: "home.light.set", permission_class: "EXECUTE", initiator: "routine", payload: { initiator: "person" } }).verdict, "ask");
  ok("Unattended actuation asks: routine/memory light, media, and thermostat actions ask where the owner's identical actions are pre-approved — payload initiator spoofing changes nothing");
}

// ── Locks and alarms deny via the LOCKED rule — for the owner too,
// and for a routine the deny still wins over the unattended ask
// (deny tier outranks ask): a routine lock attempt refuses, it does
// not ask.
{
  const lock = verdict({ kind: "home.lock.set", permission_class: "EXECUTE", payload: { door: "front", locked: true } });
  assert.equal(lock.verdict, "deny");
  assert.equal(lock.rule_id, "security-never");
  assert.equal(verdict({ kind: "home.alarm.arm", permission_class: "EXECUTE", payload: { mode: "away" } }).verdict, "deny");
  assert.equal(verdict({ kind: "home.alarm.disarm", permission_class: "EXECUTE" }).rule_id, "security-never");
  const routineLock = verdict({ kind: "home.lock.set", permission_class: "EXECUTE", initiator: "routine" });
  assert.equal(routineLock.verdict, "deny");
  assert.equal(routineLock.rule_id, "security-never");
  assert.equal(verdict({ kind: "home.alarm.disarm", permission_class: "EXECUTE", initiator: "routine" }).verdict, "deny");
  ok("Locks and alarms deny via the locked rule: lock.set, alarm.arm, alarm.disarm refused for person and routine — a routine attempt denies, never asks");
}

// ── Deleting recordings denies via the LOCKED rule. In this agent
// DELETE is recordings/evidence, and evidence is never the agent's
// to destroy — for any initiator.
{
  const del = verdict({ kind: "home.recording.delete", permission_class: "DELETE", payload: { clip_id: "clip_1" } });
  assert.equal(del.verdict, "deny");
  assert.equal(del.rule_id, "delete-never");
  assert.equal(verdict({ kind: "home.recording.delete", permission_class: "DELETE", initiator: "routine" }).rule_id, "delete-never");
  ok("Recording deletion denies via the locked rule: home.recording.delete refused by delete-never for person and routine");
}

// ── THE SPEND BRANCH: an owner-initiated purchase asks — but the
// same purchase from a routine or a remembered trigger denies
// outright. unattended-spend-never (deny tier) beats purchases-ask:
// unattended money is not an ask, it is a refusal.
{
  const buy = verdict({ kind: "home.purchase.order", permission_class: "SPEND", payload: { item: "air filters", amount_usd: 24 } });
  assert.equal(buy.verdict, "ask");
  assert.equal(buy.rule_id, "purchases-ask");
  const routineBuy = verdict({ kind: "home.purchase.order", permission_class: "SPEND", initiator: "routine", payload: { item: "air filters", amount_usd: 24 } });
  assert.equal(routineBuy.verdict, "deny");
  assert.equal(routineBuy.rule_id, "unattended-spend-never");
  assert.equal(verdict({ kind: "home.purchase.order", permission_class: "SPEND", initiator: "memory" }).verdict, "deny");
  assert.equal(verdict({ kind: "home.purchase.order", permission_class: "SPEND", initiator: "memory" }).rule_id, "unattended-spend-never");
  ok("Purchase branching: the owner's purchase asks (purchases-ask); a routine or memory-initiated purchase denies (unattended-spend-never)");
}

// ── A message to a known contact asks — payload.to_contact == true
// is the marker. Routines are held to ask-or-stricter here too: a
// routine messaging a contact still asks.
{
  const msg = verdict({ kind: "home.message.send", permission_class: "COMMUNICATE", payload: { to_contact: true, text: "…" } });
  assert.equal(msg.verdict, "ask");
  assert.equal(msg.rule_id, "messages-ask");
  assert.equal(verdict({ kind: "home.message.send", permission_class: "COMMUNICATE", initiator: "routine", payload: { to_contact: true, text: "…" } }).verdict, "ask");
  ok("Contact messages ask: home.message.send with to_contact == true asks for person and routine initiators");
}

// ── A message to a non-contact (to_contact == false) hands off to
// the owner — hand_off outranks the general COMMUNICATE ask, and it
// holds for unattended runs too: a routine may not message strangers
// on an ask, it routes to the owner.
{
  const msg = verdict({ kind: "home.message.send", permission_class: "COMMUNICATE", payload: { to_contact: false, text: "…" } });
  assert.equal(msg.verdict, "hand_off");
  assert.equal(msg.rule_id, "messages-to-noncontacts-handoff");
  assert.equal(msg.handoff_to, "owner");
  assert.equal(verdict({ kind: "home.message.send", permission_class: "COMMUNICATE", initiator: "routine", payload: { to_contact: false } }).verdict, "hand_off");
  ok("Non-contact messages hand off: to_contact == false routes to 'owner' (hand_off) for person and routine initiators");
}

// ── A message with NO to_contact marker hands off too: the absent
// field evaluates to null, null != true, so the recipient is treated
// as unknown — and unknown means non-contact, the fail-safe
// direction. Forgetting the marker can never widen who gets messaged.
{
  const msg = verdict({ kind: "home.message.send", permission_class: "COMMUNICATE", payload: { text: "…" } });
  assert.equal(msg.verdict, "hand_off");
  assert.equal(msg.rule_id, "messages-to-noncontacts-handoff");
  assert.equal(msg.handoff_to, "owner");
  ok("Unmarked messages hand off: absent payload.to_contact counts as non-contact and routes to 'owner'");
}

// ── Fail closed: home.garage.open is the pack's deliberate gap — a
// consequential kind no rule covers on purpose (see the README), so
// an owner-initiated attempt hits the engine's no-match deny, naming
// no rule. Unknown kinds and malformed actions deny the same way.
{
  const garage = verdict({ kind: "home.garage.open", permission_class: "EXECUTE", payload: { door: "main" } });
  assert.equal(garage.verdict, "deny");
  assert.equal(garage.rule_id, null); // the fail-closed default, not a rule
  const unknown = verdict({ kind: "home.teleport", permission_class: null });
  assert.equal(unknown.verdict, "deny");
  assert.equal(unknown.rule_id, null);
  assert.equal(verdict({ kind: "home.unknown", permission_class: "NETWORK_WRITE" }).verdict, "deny");
  assert.equal(verdict({ kind: "", permission_class: null }).verdict, "deny");
  ok("Fail closed: home.garage.open (deliberate gap), unknown kinds, unmapped classes, and malformed actions all deny with no rule named");
}

// ── The locked layer cannot be tuned away: an overlay that tries to
// replace BOTH locked denies with allows AND adds a catch-all
// allow-all cannot unlock a lock, delete a recording, soften the
// owner's purchase ask, or keep a non-contact message from handing
// off. (unattended-spend-never is deliberately NOT locked — it is
// initiator policy, yours to tune — so this block asserts only the
// locked lines and the tier-protected verdicts.)
{
  const hostileOverlay: PolicyDoc = { rules: [
    { id: "security-never", effect: "allow", when: "true" },
    { id: "delete-never", effect: "allow", when: "true" },
    { id: "allow-everything", effect: "allow", when: "true" },
  ] };
  const merged = compilePolicy(mergePolicyDocs(pack, hostileOverlay));
  const securityRule = merged.source.rules.find((r) => r.id === "security-never");
  assert.equal(securityRule?.effect, "deny");
  assert.equal(securityRule?.locked, true);
  const deleteRule = merged.source.rules.find((r) => r.id === "delete-never");
  assert.equal(deleteRule?.effect, "deny");
  assert.equal(deleteRule?.locked, true);
  assert.equal(evaluatePolicy(merged, act({ kind: "home.lock.set", permission_class: "EXECUTE" })).rule_id, "security-never");
  assert.equal(evaluatePolicy(merged, act({ kind: "home.alarm.disarm", permission_class: "EXECUTE" })).verdict, "deny");
  assert.equal(evaluatePolicy(merged, act({ kind: "home.recording.delete", permission_class: "DELETE" })).rule_id, "delete-never");
  assert.equal(evaluatePolicy(merged, act({ kind: "home.purchase.order", permission_class: "SPEND" })).verdict, "ask");
  assert.equal(evaluatePolicy(merged, act({ kind: "home.message.send", permission_class: "COMMUNICATE", payload: { to_contact: false } })).verdict, "hand_off");
  ok("Locked layer survives overlays: replacing security-never/delete-never is dropped, and a catch-all allow outranks neither the purchase ask nor the non-contact hand_off");
}

console.log(`\nHome Assistant pack: all ${passed} behavior checks passed.`);
