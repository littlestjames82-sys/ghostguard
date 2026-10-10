#!/usr/bin/env node
/**
 * ghostguard-gate — the Jev ↔ GhostGuard bridge (Milestone 2).
 *
 * A tiny stdin/stdout gate around the shipped GhostGuard build. Jev
 * Ultrafast (a Python browser agent) sends one JSON request per
 * decided action; this process evaluates the action with the real
 * GhostGuard policy engine, assembles the gateway record, writes it
 * to the JSONL audit via the package's reference recorder — record
 * FIRST — and only then prints the record as JSON on stdout. Jev
 * executes only after this process exits 0 with a record whose
 * verdict allows it. Any failure here (bad request, broken policy is
 * handled by the engine's fail-closed semantics, recorder write
 * failure) exits non-zero with the reason on stderr and nothing on
 * stdout: no record, no action.
 *
 * This is the adapter route Jev's GOVERNOR_NOTES.md deferred at
 * governor time — the in-repo Python port remains Jev's default
 * backend; this bridge is the opt-in backend that runs the product
 * itself. It imports the package's build output (../../dist), the
 * same artifact an npm consumer would get; run `npm run build`
 * first if dist/ is stale.
 *
 * Protocol — one request object on stdin:
 *   {
 *     "policy":         PolicyDoc,             // required
 *     "policy_overlay": PolicyDoc | null,      // optional; merged
 *                       // onto `policy` with mergePolicyDocs, so
 *                       // locked base rules survive it verbatim
 *     "audit_path":     "/abs/path.jsonl" | null,
 *                       // when set, the record is appended there
 *                       // via createJsonlRecorder before replying
 *     "approved":       boolean,               // a carried human
 *                       // approval covering this action (Jev's loop
 *                       // carries none and always sends false;
 *                       // hosts that collect approvals can send
 *                       // true and watch an ask flip)
 *     "intent":         GatewayIntent          // action_id, kind,
 *                       // permission_class, actor, initiator,
 *                       // project_id, action_payload, and the
 *                       // optional target_ref / snapshot_id /
 *                       // target / dry_run fields
 *   }
 *
 * Reply — exactly one JSON object on stdout: the GatewayRecord.
 * The evaluation context is derived from the intent (payload =
 * intent.action_payload), so policy rules see the Kernel field set:
 * kind, permission_class, actor, project_id, approved, initiator,
 * payload.<field>. Jev-native roots from the Python port
 * (classification, operation, role, label, host) do NOT exist in
 * this engine — rules for the bridge are written over payload
 * fields instead (payload.label, payload.host, …). See
 * integrations/jev/README.md for the translation notes.
 */
import { compilePolicy, evaluatePolicy, mergePolicyDocs, gatewayRecordFromDecision, createJsonlRecorder } from "../../dist/index.js";

function fail(code, message) {
  process.stderr.write(`ghostguard-gate: ${message}\n`);
  process.exit(code);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    fail(2, `request is not valid JSON (${e.message})`);
  }
  if (req === null || typeof req !== "object" || Array.isArray(req)) {
    fail(2, "request must be a JSON object");
  }
  const { policy, policy_overlay, audit_path, approved, intent } = req;
  if (policy === null || typeof policy !== "object" || !Array.isArray(policy.rules)) {
    fail(2, "request.policy must be a policy document ({ rules: [...] })");
  }
  if (policy_overlay !== undefined && policy_overlay !== null &&
      (typeof policy_overlay !== "object" || !Array.isArray(policy_overlay.rules))) {
    fail(2, "request.policy_overlay must be a policy document or null");
  }
  if (intent === null || typeof intent !== "object" || Array.isArray(intent)) {
    fail(2, "request.intent must be a gateway intent object");
  }
  for (const field of ["action_id", "kind", "actor", "initiator", "project_id"]) {
    if (typeof intent[field] !== "string") {
      fail(2, `request.intent.${field} must be a string`);
    }
  }
  if (intent.permission_class !== null && typeof intent.permission_class !== "string") {
    fail(2, "request.intent.permission_class must be a string or null");
  }
  if (intent.action_payload === null || typeof intent.action_payload !== "object" || Array.isArray(intent.action_payload)) {
    fail(2, "request.intent.action_payload must be an object");
  }

  const doc = policy_overlay ? mergePolicyDocs(policy, policy_overlay) : policy;
  const compiled = compilePolicy(doc);
  const decision = evaluatePolicy(compiled, {
    kind: intent.kind,
    permission_class: intent.permission_class,
    actor: intent.actor,
    project_id: intent.project_id,
    approved: approved === true,
    initiator: intent.initiator,
    payload: intent.action_payload,
  });

  // Only the contract's fields cross into the record — a caller
  // cannot smuggle extra keys into the audit trail.
  const record = gatewayRecordFromDecision({
    action_id: intent.action_id,
    kind: intent.kind,
    permission_class: intent.permission_class,
    actor: intent.actor,
    initiator: intent.initiator,
    project_id: intent.project_id,
    action_payload: intent.action_payload,
    target_ref: intent.target_ref ?? null,
    snapshot_id: intent.snapshot_id ?? null,
    target: intent.target ?? null,
    dry_run: intent.dry_run === true,
  }, decision);

  if (audit_path !== undefined && audit_path !== null) {
    if (typeof audit_path !== "string" || audit_path.length === 0) {
      fail(2, "request.audit_path must be a non-empty string or null");
    }
    try {
      // Record FIRST: the record is durable on disk before the
      // reply below lets the caller proceed to any effect. A write
      // failure is fatal to the request, never to the trail.
      createJsonlRecorder(audit_path)(record);
    } catch (e) {
      fail(1, `audit record could not be written (${e.message}); no action may execute`);
    }
  }

  process.stdout.write(JSON.stringify(record) + "\n");
});
