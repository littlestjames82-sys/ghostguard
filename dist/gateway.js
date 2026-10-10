/**
 * Assemble the full gateway record for an action from its intent and
 * the policy engine's decision. The record is complete and persistable
 * BEFORE any effect runs — callers hand it to their ActionRecorder
 * first, and execute only on an allow / pre_approved verdict.
 */
export function gatewayRecordFromDecision(intent, decision) {
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
