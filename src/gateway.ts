import type { InitiatorKind, PermissionClass } from "./types.js";
import type { PolicyDecision } from "./policy.js";

/**
 * The gateway record contract — the one artifact every guarded
 * action produces. Extracted at Milestone 0 from Ghost Kernel's
 * Action Fabric (ghost/packages/kernel/src/actions.ts), where the
 * fabric hands this record to its recorder BEFORE any effect runs;
 * a refusal is recorded with the rule that refused. The Jev governor
 * (jev-ultrafast/jev_ultrafast/governor.py) implements the same
 * contract in Python — the portability proof GhostGuard productizes.
 *
 * The discipline the contract encodes:
 *   record first, act second — a recorder is called synchronously
 *   before any effect; if it throws, the action does not run. An
 *   action that was not recorded did not happen.
 */
export interface GatewayRecord {
  action_id: string;
  kind: string;
  permission_class: PermissionClass | null;
  actor: string;
  /**
   * What started the run. Stamped from the gateway's run context —
   * set by the run's entry point — NEVER from the action or its
   * payload: a proposer asserting `initiator` in its payload
   * changes nothing here. Distinct from `actor`, which is who
   * proposed the action.
   */
  initiator: InitiatorKind;
  project_id: string;
  verdict: "allow" | "pre_approved" | "deny" | "ask" | "hand_off";
  /** The policy rule that decided; null for the legacy gate / no-match deny. */
  rule_id: string | null;
  reason: string;
  /** The approver/scope a hand_off verdict routes to; else null. */
  handoff_to: string | null;
  /** The opaque target ref the caller addressed, when it used one. */
  target_ref: string | null;
  snapshot_id: string | null;
  /** The resolved target fields — from the snapshot entry when a ref
   *  was used, else the target-identifying fields of the payload. */
  target: Record<string, unknown> | null;
  /** The exact payload that will run (post-resolution) or was refused.
   *  For an ask/denial this is the ratification material: an approvals
   *  surface proposes exactly this payload for a human DECISION. */
  action_payload: Record<string, unknown>;
  dry_run: boolean;
}

/**
 * A recorder persists the gateway record (the Kernel's recorder
 * appends an ACTION_EVALUATED event to the project's Event Graph).
 * It is called synchronously before any effect; if it throws, the
 * action does not run — an action that was not recorded did not
 * happen.
 */
export type ActionRecorder = (record: GatewayRecord) => void;

/**
 * The intent half of a gateway record: everything the proposer and
 * the gateway know about an action BEFORE the policy decides. The
 * decision half (verdict / rule_id / reason / handoff_to) comes from
 * the policy engine — see gatewayRecordFromDecision.
 */
export interface GatewayIntent {
  action_id: string;
  kind: string;
  permission_class: PermissionClass | null;
  /** Who proposed the action. */
  actor: string;
  /** What started the run — stamped by the entry point, never the payload. */
  initiator: InitiatorKind;
  project_id: string;
  /** The exact payload that will run if allowed. */
  action_payload: Record<string, unknown>;
  target_ref?: string | null;
  snapshot_id?: string | null;
  /** Resolved target fields, when the gateway resolved a ref. */
  target?: Record<string, unknown> | null;
  dry_run?: boolean;
}

/**
 * Assemble the full gateway record for an action from its intent and
 * the policy engine's decision. The record is complete and persistable
 * BEFORE any effect runs — callers hand it to their ActionRecorder
 * first, and execute only on an allow / pre_approved verdict.
 */
export function gatewayRecordFromDecision(intent: GatewayIntent, decision: PolicyDecision): GatewayRecord {
  return {
    action_id: intent.action_id,
    kind: intent.kind,
    permission_class: intent.permission_class,
    actor: intent.actor,
    initiator: intent.initiator,
    project_id: intent.project_id,
    verdict: decision.verdict,
    rule_id: decision.rule_id,
    reason: decision.reason,
    handoff_to: decision.handoff_to,
    target_ref: intent.target_ref ?? null,
    snapshot_id: intent.snapshot_id ?? null,
    target: intent.target ?? null,
    action_payload: intent.action_payload,
    dry_run: intent.dry_run ?? false,
  };
}
