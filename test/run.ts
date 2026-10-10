// GhostGuard — standalone acceptance tests (Milestone 0).
// Run: npm test
//
// The policy-engine blocks are ported from Ghost Kernel's acceptance
// suite (ghost/test/run.ts — the "OpenBot policy engine", "R2 (5)",
// and "R2 completion (3)" engine-level blocks), exercising the same
// code through the same assertions so the extraction is proven, not
// assumed. The fail-closed block adapts the Kernel's fabric-level
// block (c) to direct engine calls. The gateway blocks are new: they
// pin the gateway-record contract this package ships.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compilePolicy, evaluatePolicy, defaultKernelPolicy, mergePolicyDocs, type PolicyContext,
} from "../src/policy.js";
import { gatewayRecordFromDecision, type GatewayRecord } from "../src/gateway.js";
import { createJsonlRecorder, readGatewayRecords } from "../src/recorder.js";

let passed = 0;
function ok(name: string) { passed += 1; console.log(`  ✓ ${name}`); }

const ctx = (over: Partial<PolicyContext>): PolicyContext => ({
  kind: "fs.read", permission_class: "READ", actor: "job_1", project_id: "gw", approved: false, payload: {}, ...over,
});
const r2ctx = (over: Partial<PolicyContext>): PolicyContext => ({
  kind: "fs.write", permission_class: "WRITE_LOCAL", actor: "job_r2",
  project_id: "r2", approved: false, payload: {}, ...over,
});

// ── Ported: Policy engine expressions + the shipped default policy
// reproducing the legacy gate (approval classes ask, the rest allows).
{
  const pol = compilePolicy({ rules: [
    { id: "deny-spend", effect: "deny", when: "permission_class == 'SPEND'" },
    { id: "ask-unapproved-net", effect: "ask", when: "kind in ['git.push', 'web.fetch'] && !approved" },
    { id: "allow-reads", effect: "allow", when: "permission_class == 'READ' || startsWith(kind, 'os.')" },
    { id: "allow-approved", effect: "allow", when: "approved == true" },
  ] });
  assert.equal(evaluatePolicy(pol, ctx({})).verdict, "allow");
  assert.equal(evaluatePolicy(pol, ctx({ kind: "pay.purchase", permission_class: "SPEND" })).rule_id, "deny-spend");
  assert.equal(evaluatePolicy(pol, ctx({ kind: "git.push", permission_class: "NETWORK_WRITE" })).verdict, "ask");
  assert.equal(evaluatePolicy(pol, ctx({ kind: "git.push", permission_class: "NETWORK_WRITE", approved: true })).verdict, "allow");
  assert.equal(evaluatePolicy(pol, ctx({ kind: "shell.exec", permission_class: "EXECUTE" })).verdict, "deny");
  const dflt = compilePolicy(defaultKernelPolicy());
  assert.equal(evaluatePolicy(dflt, ctx({ kind: "deploy.production", permission_class: "DEPLOY" })).verdict, "ask");
  assert.equal(evaluatePolicy(dflt, ctx({ kind: "comms.send", permission_class: "COMMUNICATE" })).rule_id, "approval-required:COMMUNICATE");
  assert.equal(evaluatePolicy(dflt, ctx({})).verdict, "allow");
  ok("Policy engine: deny-first ordering, in/boolean/string expressions, and the shipped default policy reproduces the legacy gate exactly");
}

// ── Ported: (5a) Strictest wins across the approvals behaviours,
// independent of document order: deny > hand_off > ask > pre_approved
// > allow.
{
  const policy = compilePolicy({ rules: [
    { id: "allow-all", effect: "allow", when: "true" },
    { id: "pre-docs", effect: "pre_approved", when: "kind == 'fs.write'" },
    { id: "ask-shell", effect: "ask", when: "kind in ['shell.exec', 'fs.write']" },
    { id: "handoff-comms", effect: "hand_off", handoff_to: "ryan", when: "kind in ['comms.send', 'fs.write']" },
    { id: "deny-delete", effect: "deny", when: "kind in ['data.delete', 'fs.write']" },
  ] });
  // fs.write matches allow, pre_approved, ask, hand_off AND deny → deny.
  assert.equal(evaluatePolicy(policy, r2ctx({})).verdict, "deny");
  const noDeny = compilePolicy({ rules: [
    { id: "allow-all", effect: "allow", when: "true" },
    { id: "pre-docs", effect: "pre_approved", when: "kind == 'fs.write'" },
    { id: "ask-shell", effect: "ask", when: "kind in ['shell.exec', 'fs.write']" },
    { id: "handoff-comms", effect: "hand_off", handoff_to: "ryan", when: "kind in ['comms.send', 'fs.write']" },
  ] });
  const ho = evaluatePolicy(noDeny, r2ctx({}));
  assert.equal(ho.verdict, "hand_off", "hand_off beats ask, pre_approved and allow");
  assert.equal(ho.handoff_to, "ryan");
  assert.equal(evaluatePolicy(noDeny, r2ctx({ kind: "shell.exec", permission_class: "EXECUTE" })).verdict, "ask", "ask beats allow");
  const noAsk = compilePolicy({ rules: [
    { id: "allow-all", effect: "allow", when: "true" },
    { id: "pre-docs", effect: "pre_approved", when: "kind == 'fs.write'" },
  ] });
  assert.equal(evaluatePolicy(noAsk, r2ctx({})).verdict, "pre_approved", "pre_approved beats allow");
  assert.equal(evaluatePolicy(noAsk, r2ctx({ kind: "fs.read", permission_class: "READ" })).verdict, "allow");
  // Broken hand_off (no target) fails closed like a broken deny.
  const brokenHo = compilePolicy({ rules: [
    { id: "handoff-nowhere", effect: "hand_off", when: "true" },
    { id: "allow-all", effect: "allow", when: "true" },
  ] });
  const bd = evaluatePolicy(brokenHo, r2ctx({}));
  assert.equal(bd.verdict, "deny");
  assert.equal(bd.rule_id, "handoff-nowhere");
  ok("Strictest wins: deny > hand_off > ask > pre_approved > allow regardless of rule order; a targetless hand_off denies");
}

// ── Ported: (5b) Locked rules: the locked layer survives merging
// verbatim — an overlay rule reusing its id is dropped, an overlay
// allow cannot outrank it — while ordinary rules stay editable.
{
  const base = { rules: [
    { id: "no-spend-ever", effect: "deny" as const, locked: true, when: "permission_class == 'SPEND'" },
    { id: "scratch-allow", effect: "allow" as const, when: "kind == 'fs.write'" },
  ] };
  const overlay = { rules: [
    { id: "no-spend-ever", effect: "allow" as const, when: "true" },
    { id: "scratch-allow", effect: "deny" as const, when: "kind == 'fs.write'" },
    { id: "allow-all", effect: "allow" as const, when: "true" },
  ] };
  const merged = mergePolicyDocs(base, overlay);
  const locked = merged.rules.find((r) => r.id === "no-spend-ever")!;
  assert.equal(locked.effect, "deny", "the overlay's replacement for a locked rule is dropped");
  assert.equal(locked.locked, true);
  const spend = evaluatePolicy(compilePolicy(merged), r2ctx({ kind: "pay.purchase", permission_class: "SPEND" }));
  assert.equal(spend.verdict, "deny");
  assert.equal(spend.rule_id, "no-spend-ever", "the locked rule still decides, by name");
  const edited = evaluatePolicy(compilePolicy(merged), r2ctx({}));
  assert.equal(edited.verdict, "deny");
  assert.equal(edited.rule_id, "scratch-allow", "a non-locked rule WAS replaced by the overlay — ordinary edits still work");
  ok("Locked rules: a locked deny cannot be replaced, shadowed, or outranked by ordinary policy edits");
}

// ── Ported: (3f) Policy expressions branch on initiator (engine
// level): the field is the run-stamped origin; payload.initiator is
// a different field; an unstamped context sees null.
{
  const pol = compilePolicy({ rules: [
    { id: "routine-deploys-ask", effect: "ask", when: "initiator == 'routine' && permission_class == 'DEPLOY'" },
    { id: "allow-rest", effect: "allow", when: "true" },
  ] });
  const deploy = { kind: "deploy.production", permission_class: "DEPLOY" as const };
  assert.equal(evaluatePolicy(pol, r2ctx({ ...deploy, initiator: "routine" })).rule_id, "routine-deploys-ask",
    "a routine-initiated deploy asks");
  assert.equal(evaluatePolicy(pol, r2ctx({ ...deploy, initiator: "person" })).verdict, "allow",
    "the identical person-initiated deploy is allowed");
  assert.equal(evaluatePolicy(pol, r2ctx({ ...deploy })).verdict, "allow",
    "an unstamped context is not 'routine' — initiator evaluates as null, like any absent field");
  const nullPol = compilePolicy({ rules: [
    { id: "unstamped-asks", effect: "ask", when: "initiator == null" },
    { id: "allow-rest", effect: "allow", when: "true" },
  ] });
  assert.equal(evaluatePolicy(nullPol, r2ctx({})).rule_id, "unstamped-asks", "initiator == null matches an unstamped context");
  assert.equal(evaluatePolicy(nullPol, r2ctx({ initiator: "system" })).verdict, "allow",
    "a stamped context is not null, whatever its value");
  assert.equal(evaluatePolicy(pol, r2ctx({ ...deploy, initiator: "person", payload: { initiator: "routine" } })).verdict, "allow",
    "a payload asserting initiator: 'routine' does not change the field the rule sees");
  ok("Initiator in policy expressions: rules branch on the run's origin; unstamped is null; payload.initiator is a different field");
}

// ── Adapted from the Kernel's fabric-level block (c): fail-closed
// stances, exercised directly against the engine.
{
  // A broken deny rule denies everything, naming itself.
  const brokenDeny = compilePolicy({ rules: [
    { id: "broken-deny", effect: "deny", when: "kind ==" },
    { id: "allow-all", effect: "allow", when: "true" },
  ] });
  const bd = evaluatePolicy(brokenDeny, ctx({}));
  assert.equal(bd.verdict, "deny");
  assert.equal(bd.rule_id, "broken-deny");
  // No matching rule denies — a missing policy permits nothing.
  const noMatch = compilePolicy({ rules: [
    { id: "shell-only", effect: "allow", when: "kind == 'shell.exec'" },
  ] });
  const nm = evaluatePolicy(noMatch, ctx({}));
  assert.equal(nm.verdict, "deny");
  assert.equal(nm.rule_id, null);
  // A broken allow rule is inert: it never permits, but blocks nothing.
  const brokenAllow = compilePolicy({ rules: [
    { id: "broken-allow", effect: "allow", when: "kind ==" },
    { id: "allow-reads", effect: "allow", when: "permission_class == 'READ'" },
  ] });
  assert.equal(evaluatePolicy(brokenAllow, ctx({})).rule_id, "allow-reads");
  // An evaluation error inside a deny rule fails closed, naming the
  // rule (ordering comparison against a missing payload field).
  const errDeny = compilePolicy({ rules: [
    { id: "big-amounts", effect: "deny", when: "payload.amount > 5" },
    { id: "allow-all", effect: "allow", when: "true" },
  ] });
  const ed = evaluatePolicy(errDeny, ctx({}));
  assert.equal(ed.verdict, "deny");
  assert.equal(ed.rule_id, "big-amounts");
  // The same error inside an allow rule is inert.
  const errAllow = compilePolicy({ rules: [
    { id: "big-allow", effect: "allow", when: "payload.amount > 5" },
  ] });
  const ea = evaluatePolicy(errAllow, ctx({}));
  assert.equal(ea.verdict, "deny", "an erroring allow grants nothing; the fail-closed default decides");
  assert.equal(ea.rule_id, null);
  ok("Fail-closed: broken deny denies by name, no-match denies, broken/erroring permissive rules are inert");
}

// ── New: the gateway-record contract. A record assembled from an
// intent + a decision carries the verdict, the deciding rule, and
// the exact payload — complete before any effect could run.
{
  const policy = compilePolicy(defaultKernelPolicy());
  const decision = evaluatePolicy(policy, ctx({
    kind: "deploy.production", permission_class: "DEPLOY", initiator: "person",
    payload: { target: "prod" },
  }));
  const record = gatewayRecordFromDecision({
    action_id: "act_1",
    kind: "deploy.production",
    permission_class: "DEPLOY",
    actor: "job_1",
    initiator: "person",
    project_id: "gw",
    action_payload: { target: "prod" },
    target: { host: "prod" },
  }, decision);
  assert.equal(record.verdict, "ask");
  assert.equal(record.rule_id, "approval-required:DEPLOY");
  assert.equal(record.handoff_to, null);
  assert.equal(record.initiator, "person");
  assert.deepEqual(record.action_payload, { target: "prod" });
  assert.equal(record.target_ref, null);
  assert.equal(record.snapshot_id, null);
  assert.equal(record.dry_run, false);
  // A hand_off decision routes its target onto the record.
  const hoPolicy = compilePolicy({ rules: [
    { id: "comms-to-owner", effect: "hand_off", handoff_to: "owner", when: "permission_class == 'COMMUNICATE'" },
  ] });
  const hoDecision = evaluatePolicy(hoPolicy, ctx({ kind: "comms.send", permission_class: "COMMUNICATE" }));
  const hoRecord = gatewayRecordFromDecision({
    action_id: "act_2", kind: "comms.send", permission_class: "COMMUNICATE",
    actor: "job_1", initiator: "routine", project_id: "gw",
    action_payload: { text: "hello" }, dry_run: true,
  }, hoDecision);
  assert.equal(hoRecord.verdict, "hand_off");
  assert.equal(hoRecord.handoff_to, "owner");
  assert.equal(hoRecord.dry_run, true);
  ok("Gateway record contract: intent + decision assemble into a complete record — verdict, deciding rule, routing, exact payload");
}

// ── New: record-first composition — the exact flow an integrator
// wires: evaluate, record, and only then (elsewhere) act. A recorder
// that throws leaves the caller with no verdict to act on.
{
  const records: GatewayRecord[] = [];
  const recorder = (r: GatewayRecord) => { records.push(r); };
  const policy = compilePolicy({ rules: [
    { id: "allow-reads", effect: "allow", when: "permission_class == 'READ'" },
  ] });
  const decision = evaluatePolicy(policy, ctx({}));
  recorder(gatewayRecordFromDecision({
    action_id: "act_3", kind: "fs.read", permission_class: "READ",
    actor: "job_1", initiator: "system", project_id: "gw", action_payload: { path: "a.txt" },
  }, decision));
  assert.equal(records.length, 1);
  assert.equal(records[0].verdict, "allow");
  assert.throws(() => { throw new Error("sink down"); }, /sink down/,
    "a recorder failure surfaces as an exception — the caller's contract is: no record, no action");
  ok("Record-first composition: the record is written from the decision before any effect; a failing recorder stops the flow");
}

// ── New (M1): the reference JSONL recorder. Append-only, one
// record per line, round-trips through readGatewayRecords, and a
// failed write throws — the record-first contract's enforcement
// point: no record, no action.
{
  const dir = mkdtempSync(join(tmpdir(), "ghostguard-recorder-"));
  try {
    const file = join(dir, "nested", "audit.jsonl");
    const recorder = createJsonlRecorder(file); // creates nested dirs up front
    const policy = compilePolicy(defaultKernelPolicy());
    const mk = (id: string, kind: string, cls: "READ" | "SPEND"): GatewayRecord => gatewayRecordFromDecision({
      action_id: id, kind, permission_class: cls, actor: "job_1", initiator: "person",
      project_id: "gw", action_payload: { n: id },
    }, evaluatePolicy(policy, ctx({ kind, permission_class: cls })));
    const first = mk("rec_1", "fs.read", "READ");
    recorder(first);
    const afterFirst = readFileSync(file, "utf8");
    assert.equal(afterFirst.trim().split("\n").length, 1, "one record is exactly one line");
    const second = mk("rec_2", "pay.purchase", "SPEND");
    recorder(second);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "a second record appends a second line");
    assert.equal(lines[0], afterFirst.trim(), "append-only: the first line is never rewritten");
    const back = readGatewayRecords(file);
    assert.deepEqual(back, [first, second], "records round-trip through JSONL unchanged");
    assert.equal(back[1].verdict, "ask");
    assert.equal(back[1].rule_id, "approval-required:SPEND");
    // A sink that cannot be written throws synchronously on record —
    // pointed at an existing directory, append fails every time.
    const badRecorder = createJsonlRecorder(dir);
    assert.throws(() => badRecorder(first), "a failed audit write throws instead of losing the record");
    ok("Reference JSONL recorder: append-only lines, exact round-trip, parent dirs created, write failure throws");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── New (M2): the Jev gate bridge — the integration surface an
// outside agent calls per action. Jev Ultrafast (a Python browser
// agent) sends one JSON request per decided action; the bridge
// evaluates it with this package's engine, appends the record to
// the JSONL audit via the reference recorder, and only then
// replies — record-first across a process boundary. These
// assertions run the actual bridge under node, against the shipped
// build the bridge imports (npm run verify builds first).
{
  const here = dirname(fileURLToPath(import.meta.url));
  const bridge = join(here, "..", "integrations", "jev", "ghostguard-gate.mjs");
  const scenarioPolicy = JSON.parse(
    readFileSync(join(here, "..", "integrations", "jev", "policy.jev-scenario.json"), "utf8"),
  );
  const dir = mkdtempSync(join(tmpdir(), "ghostguard-bridge-"));
  try {
    const audit = join(dir, "jev-audit.jsonl");
    const gate = (intent: Record<string, unknown>, over: Record<string, unknown> = {}) =>
      JSON.parse(execFileSync("node", [bridge], {
        input: JSON.stringify({ policy: scenarioPolicy, audit_path: audit, approved: false, intent, ...over }),
        encoding: "utf8",
      }));
    const intent = (action_id: string, kind: string, cls: string, label: string) => ({
      action_id, kind, permission_class: cls, actor: "jev", initiator: "person", project_id: "",
      action_payload: { label, host: "fixture.test" },
    });
    const nav = gate(intent("e2", "jev.click", "READ", "Home"));
    assert.equal(nav.verdict, "allow");
    assert.equal(nav.rule_id, "allow-read-only");
    const fill = gate(intent("e1", "jev.fill", "WRITE_LOCAL", "Destination"));
    assert.equal(fill.verdict, "pre_approved");
    assert.equal(fill.rule_id, "fixture-fills-standing-approval");
    const submit = gate(intent("e3", "jev.click", "NETWORK_WRITE", "Find stays"));
    assert.equal(submit.verdict, "ask");
    assert.equal(submit.rule_id, "submit-clicks-ask");
    // The same submit, re-presented with a carried approval, lands
    // on allow: the ask rule's !approved clause steps aside.
    const approvedSubmit = gate(intent("e3", "jev.click", "NETWORK_WRITE", "Find stays"), { approved: true });
    assert.equal(approvedSubmit.verdict, "allow");
    assert.equal(approvedSubmit.rule_id, "allow-carried-approvals");
    // A hostile overlay — one reusing the locked rule's id to allow
    // everything — is dropped by mergePolicyDocs inside the bridge:
    // the purchase click still dies on the locked rule, by name.
    const buy = gate(intent("e4", "jev.click", "NETWORK_WRITE", "Buy gift card"), {
      policy_overlay: { rules: [{ id: "no-spend-ever", effect: "allow", when: "true" }] },
    });
    assert.equal(buy.verdict, "deny");
    assert.equal(buy.rule_id, "no-spend-ever");
    // Every reply above was recorded before it was returned, in
    // order, exactly as returned.
    const trail = readGatewayRecords(audit);
    assert.deepEqual(trail, [nav, fill, submit, approvedSubmit, buy]);
    // An audit path that cannot be written fails the request
    // (non-zero exit): the caller gets no record to act on.
    assert.throws(() => execFileSync("node", [bridge], {
      input: JSON.stringify({
        policy: scenarioPolicy, audit_path: dir,
        intent: intent("e9", "jev.click", "READ", "Home"),
      }),
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }));
    ok("Jev gate bridge (M2): the shipped engine decides an outside agent's actions and records them before replying; carried approvals land; a hostile overlay cannot weaken the locked rule");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nAll ${passed} acceptance checks passed.`);
