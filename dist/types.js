/**
 * GhostGuard contract types — the vocabulary a guarded action is
 * described in, shared by the policy engine (policy.ts) and the
 * gateway record (gateway.ts).
 *
 * Extracted at Milestone 0 from Ghost Kernel's contracts
 * (ghost/packages/contracts/src/types.ts), where these types serve
 * the Kernel's Action Fabric. In GhostGuard they are the integration
 * contract for ANY agent: the integrator classifies each action kind
 * into a PermissionClass, stamps who proposed it (actor) and what
 * started the run (initiator), and GhostGuard decides and records.
 */
/**
 * The classes the reference default policy (defaultKernelPolicy in
 * policy.ts) requires human approval for. This is the set Ghost
 * Kernel ships; integrators writing their own policy documents can
 * choose their own ask-boundaries rule by rule.
 */
export const APPROVAL_REQUIRED = new Set([
    "DEPLOY", "PUBLISH", "COMMUNICATE", "SPEND", "DELETE",
]);
