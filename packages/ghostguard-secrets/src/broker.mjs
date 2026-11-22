/**
 * GhostGuard Secrets Broker.
 *
 * The problem: an agent that needs an API key usually HOLDS the key —
 * in its context, its plan, its logs — for the whole run. Anything
 * that compromises or merely observes the agent (prompt injection,
 * a verbose trace, a leaked transcript) gets the credential.
 *
 * The broker's shape: the agent never holds the value at all.
 *
 *   1. The agent proposes an action whose payload carries only a
 *      secret REFERENCE: { name, type, slot }. No value exists
 *      anywhere in the agent-facing object.
 *   2. The broker evaluates the GhostGuard policy FIRST — before the
 *      secret source is touched. The gateway record is assembled
 *      with secret descriptors (name, type, and — only on the
 *      execute path, after broker-side resolution — length). The
 *      value is never in the record; an existing GhostGuard hygiene
 *      rule the trail already lives by.
 *   3. Only on an executable verdict (allow / pre_approved — an `ask`
 *      becomes executable only when a carried human approval makes
 *      the policy itself allow the action; the broker never overrides
 *      the engine) does the broker resolve the reference from the
 *      secret source, broker-side.
 *   4. Record first: the record is handed to the recorder BEFORE the
 *      executor runs. A throwing recorder means no injection, no
 *      execution — GhostGuard's record-first contract, unchanged.
 *   5. Injection is last-moment and one-way: the executor receives
 *      the values in a separate `secrets` map keyed by slot, apart
 *      from the agent's payload. The broker clears its own map as
 *      soon as the executor returns, and scrub-redacts any resolved
 *      value out of executor results and error messages that pass
 *      back through it.
 *
 * GhostGuard itself is imported from the published ghostguard
 * package — this package's only runtime dependency — and the core
 * package is never modified.
 */

import {
  compilePolicy,
  evaluatePolicy,
  gatewayRecordFromDecision,
} from "ghostguard";

const REDACTED = "[redacted]";

/** Replace every occurrence of each secret value in a string. */
export function scrubSecrets(text, values) {
  let out = String(text ?? "");
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      out = out.split(value).join(REDACTED);
    }
  }
  return out;
}

/** Deep-scrub strings inside an executor result before it goes back
 *  to the agent-facing side: a leaky executor that echoes a secret
 *  into its return value must not smuggle it past the broker. */
export function scrubDeep(value, values) {
  if (typeof value === "string") return scrubSecrets(value, values);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, values));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, values);
    return out;
  }
  return value;
}

/**
 * Create a broker.
 *   policy       — a GhostGuard PolicyDoc ({ rules }) or an already
 *                  compiled policy from ghostguard's compilePolicy.
 *   recorder     — a GhostGuard ActionRecorder (e.g.
 *                  createJsonlRecorder(path) from the core package).
 *   secretSource — { resolve(name) -> { value, type } | null },
 *                  see sources.mjs.
 */
export function createSecretsBroker({ policy, recorder, secretSource }) {
  const compiled =
    policy && Array.isArray(policy.rules) && !("source" in policy)
      ? compilePolicy(policy)
      : policy;
  if (!compiled || !Array.isArray(compiled.rules)) {
    throw new Error("createSecretsBroker: policy must be a PolicyDoc or a compiled policy");
  }
  if (typeof recorder !== "function") {
    throw new Error("createSecretsBroker: recorder must be an ActionRecorder function");
  }
  if (!secretSource || typeof secretSource.resolve !== "function") {
    throw new Error("createSecretsBroker: secretSource must provide resolve(name)");
  }

  /**
   * Run one agent action through the broker.
   *
   * action: {
   *   action_id, kind, permission_class, actor, project_id,
   *   initiator?,            // stamped by trusted entry-point code
   *   approved?,             // carried human approval (trusted caller)
   *   payload?,              // agent-facing payload — NO secret values
   *   secret_refs?: [{ name, type?, slot? }]  // references only
   * }
   * executor: async (execution) => result, where execution is
   *   { action_id, kind, payload, secrets: { [slot]: value }, record }
   *
   * Returns (never throws with an unscrubbed message):
   *   { status: "executed" | "blocked" | "failed_closed",
   *     verdict, rule_id, reason, record, executor_result?, error? }
   */
  async function execute(action, executor) {
    const resolvedValues = [];
    const refs = (action.secret_refs ?? []).map((r) => ({
      name: r.name,
      type: r.type ?? "unknown",
      slot: r.slot ?? r.name,
    }));
    // Descriptors are what the RECORD may see: name, type, and —
    // filled in only after broker-side resolution — length. If an
    // agent smuggles an inline `value` into a ref, it is dropped
    // here and never recorded, resolved, or executed with.
    const descriptors = refs.map((r) => ({
      name: r.name,
      type: r.type,
      slot: r.slot,
      length: null,
      resolved: false,
    }));
    const recordPayload = {
      ...(action.payload ?? {}),
      secret_refs: descriptors,
      approval_carried: action.approved === true,
    };
    const intent = {
      action_id: action.action_id,
      kind: action.kind,
      permission_class: action.permission_class ?? null,
      actor: action.actor,
      initiator: action.initiator ?? "system",
      project_id: action.project_id,
      action_payload: recordPayload,
    };
    const base = { action_id: action.action_id, kind: action.kind };

    // -- 1. Decide. The secret source has NOT been touched yet. ----
    let decision;
    try {
      decision = evaluatePolicy(compiled, {
        kind: action.kind,
        permission_class: action.permission_class ?? null,
        actor: action.actor,
        project_id: action.project_id,
        approved: action.approved === true,
        initiator: action.initiator ?? "system",
        payload: recordPayload,
      });
    } catch {
      // The engine is fail-closed internally; if it ever did throw,
      // the broker still fails closed rather than improvise a grant.
      decision = {
        verdict: "deny",
        rule_id: null,
        reason: "policy evaluation failed inside the broker (fail-closed)",
        handoff_to: null,
      };
    }
    const verdictInfo = {
      verdict: decision.verdict,
      rule_id: decision.rule_id,
      reason: decision.reason,
    };

    const recordAndReturn = (status, extra = {}) => {
      const record = gatewayRecordFromDecision(intent, decision);
      try {
        recorder(record); // record-first: before any effect
      } catch (e) {
        return {
          ...base,
          status: "failed_closed",
          ...verdictInfo,
          record,
          error: {
            code: "recorder_failed",
            message: scrubSecrets(
              `audit recorder failed; action did not execute: ${e?.message ?? e}`,
              resolvedValues,
            ),
          },
        };
      }
      return { ...base, status, ...verdictInfo, record, ...extra };
    };

    // -- 2. Non-executable verdicts: record and stop. --------------
    // The source is never read on this path (deny, ask without an
    // approval the policy accepts, hand_off) — provable through the
    // source's read counter.
    if (decision.verdict !== "allow" && decision.verdict !== "pre_approved") {
      return recordAndReturn("blocked");
    }

    if (typeof executor !== "function") {
      recordPayload.broker_resolution = "failed: no executor supplied";
      return recordAndReturn("failed_closed", {
        error: { code: "no_executor", message: "no executor supplied; action did not execute" },
      });
    }

    // -- 3. Resolve, broker-side only, now that policy allows. ----
    const secretsForExecution = {};
    for (let i = 0; i < refs.length; i += 1) {
      let resolved = null;
      try {
        resolved = secretSource.resolve(refs[i].name);
      } catch (e) {
        recordPayload.broker_resolution = `failed: secret source error for ref '${refs[i].name}'`;
        return recordAndReturn("failed_closed", {
          error: {
            code: "secret_source_error",
            message: scrubSecrets(
              `secret source error for ref '${refs[i].name}'; action did not execute: ${e?.message ?? e}`,
              resolvedValues,
            ),
          },
        });
      }
      if (!resolved || typeof resolved.value !== "string") {
        recordPayload.broker_resolution = `failed: secret ref '${refs[i].name}' not found in source`;
        return recordAndReturn("failed_closed", {
          error: {
            code: "secret_not_found",
            message: `secret ref '${refs[i].name}' not found in source; action did not execute`,
          },
        });
      }
      resolvedValues.push(resolved.value);
      descriptors[i].length = resolved.value.length;
      descriptors[i].type = resolved.type ?? refs[i].type;
      descriptors[i].resolved = true;
      secretsForExecution[refs[i].slot] = resolved.value;
    }
    if (refs.length > 0) recordPayload.broker_resolution = "ok";

    // -- 4. Record, then inject + execute. -------------------------
    const record = gatewayRecordFromDecision(intent, decision);
    try {
      recorder(record);
    } catch (e) {
      for (const k of Object.keys(secretsForExecution)) delete secretsForExecution[k];
      return {
        ...base,
        status: "failed_closed",
        ...verdictInfo,
        record,
        error: {
          code: "recorder_failed",
          message: scrubSecrets(
            `audit recorder failed; action did not execute: ${e?.message ?? e}`,
            resolvedValues,
          ),
        },
      };
    }

    let executorResult;
    try {
      executorResult = await executor({
        action_id: action.action_id,
        kind: action.kind,
        payload: { ...(action.payload ?? {}) },
        secrets: secretsForExecution,
        record,
      });
    } catch (e) {
      return {
        ...base,
        status: "failed_closed",
        ...verdictInfo,
        record,
        error: {
          code: "executor_failed",
          message: scrubSecrets(e?.message ?? String(e), resolvedValues),
        },
      };
    } finally {
      // The broker drops its own references to the values as soon as
      // the execution call is over. (JS strings cannot be securely
      // erased — see README honest limits — but nothing here keeps,
      // returns, or logs them.)
      for (const k of Object.keys(secretsForExecution)) delete secretsForExecution[k];
    }

    return {
      ...base,
      status: "executed",
      ...verdictInfo,
      record,
      executor_result: scrubDeep(executorResult, resolvedValues),
    };
  }

  return { execute };
}
