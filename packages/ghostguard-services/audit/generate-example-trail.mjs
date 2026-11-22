// generate-example-trail.mjs — FICTIONAL worked example for the Agent Governance Audit.
//
// Runs the fictional client "Copperline Support Co."'s fictional agent action
// inventory through the REAL GhostGuard engine (imported from
// ~/workspace/ghostguard/dist — read-only, the core is never modified) and
// writes:
//   example-trail.jsonl   one real gateway record per action (via the real
//                         createJsonlRecorder + gatewayRecordFromDecision)
//   example-summary.json  tallies + structural-check results, computed from
//                         the records actually produced
// The filled example report (example-report.md) copies its numbers from
// example-summary.json. Nothing here is a real client, a real agent, or a
// real action; no effect ever executes — this is decision simulation only.

import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compilePolicy,
  evaluatePolicy,
  mergePolicyDocs,
  gatewayRecordFromDecision,
  createJsonlRecorder,
  readGatewayRecords,
} from "../../ghostguard/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = "copperline-support-fictional";
const ACTOR = "helpdesk-helper-fictional";

// The fictional action inventory (from the fictional intake).
// `pc` = classified PermissionClass; null = deliberately unmapped, to prove
// the fail-closed default. Payloads are invented; no real data, no real
// secrets (the one credential is described as type + length only).
const ACTIONS = [
  { id: "a01", kind: "ticket.read",    pc: "READ",          initiator: "person",  payload: { ticket_id: "T-1042" } },
  { id: "a02", kind: "kb.search",      pc: "READ",          initiator: "routine", payload: { query: "refund policy wording" } },
  { id: "a03", kind: "ticket.draft",   pc: "WRITE_LOCAL",   initiator: "routine", payload: { ticket_id: "T-1042", draft_chars: 412 } },
  { id: "a04", kind: "note.write",     pc: "WRITE_LOCAL",   initiator: "person",  payload: { path: "notes/shift-summary.txt" } },
  { id: "a05", kind: "email.send",     pc: "COMMUNICATE",   initiator: "person",  payload: { external: true,  to_role: "customer", subject_chars: 38 } },
  { id: "a06", kind: "email.send",     pc: "COMMUNICATE",   initiator: "person",  payload: { external: false, to_role: "teammate", subject_chars: 22 } },
  { id: "a07", kind: "email.send",     pc: "COMMUNICATE",   initiator: "routine", payload: { external: false, to_role: "teammate", subject_chars: 22 } },
  { id: "a08", kind: "refund.issue",   pc: "SPEND",         initiator: "person",  payload: { amount_cents: 2500, currency: "USD" } },
  { id: "a09", kind: "subscription.buy", pc: "SPEND",       initiator: "routine", payload: { amount_cents: 4900, currency: "USD", plan: "pro-monthly" } },
  { id: "a10", kind: "record.delete",  pc: "DELETE",        initiator: "person",  payload: { record_id: "T-0917" } },
  { id: "a11", kind: "macro.deploy",   pc: "DEPLOY",        initiator: "routine", payload: { macro: "refund-script-v3", credential: { type: "api_key", length: 40 } } },
  { id: "a12", kind: "kb.publish",     pc: "PUBLISH",       initiator: "person",  payload: { article: "how-refunds-work", words: 640 } },
  { id: "a13", kind: "form.submit",    pc: "NETWORK_WRITE", initiator: "routine", payload: { form: "vendor-status-update" } },
  { id: "a14", kind: "form.submit",    pc: "NETWORK_WRITE", initiator: "person",  payload: { form: "vendor-status-update" } },
  { id: "a15", kind: "tool.execute",   pc: "EXECUTE",       initiator: "routine", payload: { tool: "crm-lookup", args_chars: 18 } },
  { id: "a16", kind: "tool.execute",   pc: "EXECUTE",       initiator: "person",  payload: { tool: "crm-lookup", args_chars: 18 } },
  { id: "a17", kind: "mystery.action", pc: null,            initiator: "person",  payload: { note: "unmapped action from the fictional intake — must fail closed" } },
];

const policyDoc = JSON.parse(readFileSync(join(here, "policy.example.json"), "utf8"));
const policy = compilePolicy(policyDoc);

const trailPath = join(here, "example-trail.jsonl");
if (existsSync(trailPath)) rmSync(trailPath); // recorder is append-only; regenerate from scratch
const recorder = createJsonlRecorder(trailPath);

for (const a of ACTIONS) {
  const ctx = {
    kind: a.kind,
    permission_class: a.pc,
    actor: ACTOR,
    project_id: PROJECT,
    approved: false,
    initiator: a.initiator,
    payload: a.payload,
  };
  const decision = evaluatePolicy(policy, ctx);
  const record = gatewayRecordFromDecision(
    {
      action_id: a.id,
      kind: a.kind,
      permission_class: a.pc,
      actor: ACTOR,
      initiator: a.initiator,
      project_id: PROJECT,
      action_payload: a.payload,
    },
    decision,
  );
  recorder(record); // record-first: in a live gateway the effect would run only after this, and only on allow/pre_approved
}

const records = readGatewayRecords(trailPath);

// --- Structural check 1: hostile overlay cannot weaken a locked rule --------
// An overlay that tries to REPLACE the locked no-spend-ever / no-delete-ever
// rules with allows (reusing their ids) must be dropped by mergePolicyDocs.
const hostileOverlay = {
  rules: [
    { id: "no-spend-ever", effect: "allow", when: "permission_class == 'SPEND'" },
    { id: "no-delete-ever", effect: "allow", when: "permission_class == 'DELETE'" },
    { id: "blanket-allow", effect: "allow", when: "true" },
  ],
};
const merged = compilePolicy(mergePolicyDocs(policyDoc, hostileOverlay));
const spendUnderAttack = evaluatePolicy(merged, {
  kind: "refund.issue", permission_class: "SPEND", actor: ACTOR,
  project_id: PROJECT, approved: false, initiator: "person", payload: { amount_cents: 2500 },
});
const deleteUnderAttack = evaluatePolicy(merged, {
  kind: "record.delete", permission_class: "DELETE", actor: ACTOR,
  project_id: PROJECT, approved: false, initiator: "person", payload: { record_id: "T-0917" },
});
const lockedHeld =
  spendUnderAttack.verdict === "deny" && spendUnderAttack.rule_id === "no-spend-ever" &&
  deleteUnderAttack.verdict === "deny" && deleteUnderAttack.rule_id === "no-delete-ever";

// --- Structural check 2: strictest wins --------------------------------------
// a05 matches both comms-ask (ask) and external-comms-to-owner (hand_off);
// hand_off is the stricter tier and must decide.
const a05 = records.find((r) => r.action_id === "a05");
const strictestHeld = a05.verdict === "hand_off" && a05.rule_id === "external-comms-to-owner";

// --- Structural check 3: initiator discipline --------------------------------
// Same form.submit: routine asks, person allows. Same tool.execute likewise.
const byId = Object.fromEntries(records.map((r) => [r.action_id, r]));
const initiatorHeld =
  byId.a13.verdict === "ask" && byId.a14.verdict === "allow" &&
  byId.a15.verdict === "ask" && byId.a16.verdict === "allow";

// --- Structural check 4: unmapped action fails closed ------------------------
const unmapped = byId.a17;
const failClosedHeld = unmapped.verdict === "deny" && unmapped.rule_id === null;

// --- Tallies ------------------------------------------------------------------
const tally = (keyFn) => {
  const out = {};
  for (const r of records) { const k = keyFn(r); out[k] = (out[k] ?? 0) + 1; }
  return out;
};

const summary = {
  fictional: true,
  client: "Copperline Support Co. (FICTIONAL)",
  agent: "helpdesk-helper-fictional (FICTIONAL)",
  project_id: PROJECT,
  total_actions: records.length,
  by_verdict: tally((r) => r.verdict),
  by_rule: tally((r) => r.rule_id ?? "(none — fail-closed default)"),
  by_class: tally((r) => r.permission_class ?? "(unmapped)"),
  by_initiator: tally((r) => r.initiator),
  results: records.map((r) => ({
    action_id: r.action_id, kind: r.kind, permission_class: r.permission_class,
    initiator: r.initiator, verdict: r.verdict, rule_id: r.rule_id, reason: r.reason,
    handoff_to: r.handoff_to,
  })),
  structural_checks: {
    locked_rules_held_against_hostile_overlay: lockedHeld,
    strictest_verdict_wins_a05_handoff_over_ask: strictestHeld,
    initiator_discipline_routine_stricter: initiatorHeld,
    unmapped_action_fail_closed_a17: failClosedHeld,
    record_completeness_all_fields:
      records.every((r) => r.action_id && r.kind && r.verdict && "rule_id" in r && r.reason && r.action_payload),
  },
};

writeFileSync(join(here, "example-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
