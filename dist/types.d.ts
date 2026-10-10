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
 * What started the run an action belongs to — the counterpart of
 * actor (who/what is proposing the action). Distinguishes a person
 * at the keyboard from the same person's unattended machinery: a
 * workflow/routine step, a handoff from another run, a
 * memory-triggered run, or the system itself. The value is stamped
 * by the run's entry point (trusted code) — never by the action
 * proposer — so policy can hold unattended runs to a stricter
 * standard than the same person at the keyboard.
 */
export type InitiatorKind = "person" | "routine" | "handoff" | "memory" | "system";
/**
 * The coarse consequence class of an action kind. Integrators map
 * their own action kinds onto these classes (e.g. the Jev governor
 * classifies browser actions: navigation/reads → READ, fills →
 * WRITE_LOCAL, submit-capable clicks → NETWORK_WRITE).
 */
export type PermissionClass = "READ" | "WRITE_LOCAL" | "EXECUTE" | "NETWORK_WRITE" | "DEPLOY" | "PUBLISH" | "COMMUNICATE" | "SPEND" | "DELETE";
/**
 * The classes the reference default policy (defaultKernelPolicy in
 * policy.ts) requires human approval for. This is the set Ghost
 * Kernel ships; integrators writing their own policy documents can
 * choose their own ask-boundaries rule by rule.
 */
export declare const APPROVAL_REQUIRED: ReadonlySet<PermissionClass>;
