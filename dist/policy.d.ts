import { type InitiatorKind, type PermissionClass } from "./types.js";
/**
 * Permission policy engine (OpenBot adoption #2 — see OPENBOT_ADOPTION.md).
 *
 * GHOSTGUARD EXTRACTION (Milestone 0): this file is the Ghost Kernel's
 * policy engine (ghost/packages/kernel/src/policy.ts) carried into the
 * standalone GhostGuard package unchanged in semantics — the only
 * edits are the import above (contracts → ./types.js) and this note.
 * The Kernel remains the reference implementation; GhostGuard is the
 * product extraction other agents integrate. The design lineage is
 * CopilotKit/OpenBot's gateway policy semantics (MIT), adopted into
 * Ghost and re-implemented there; see PLAN.md and the Kernel's
 * OPENBOT_ADOPTION.md.
 *
 * OpenBot's gateway evaluates CEL rules over the action context with
 * deny-first, fail-closed semantics. Ghost adopts the semantics, not the
 * dependency: this is a small hand-rolled evaluator for the subset of
 * CEL the Kernel's permission layer actually needs, so the Kernel gains
 * an executable rule language without taking on cel-js.
 *
 * The supported subset (anything outside it is a broken rule):
 *   literals    'single' / "double" strings, numbers, true, false, null,
 *               and list literals [a, b, ...]
 *   fields      kind, permission_class, actor, project_id, approved,
 *               initiator, and payload.<field> (payloads are
 *               schemaless; a field that is absent evaluates to null)
 *   operators   ==  !=  <  <=  >  >=  in  &&  ||  !  and parentheses
 *   functions   startsWith(x, s), endsWith(x, s), contains(x, s),
 *               matches(x, regex) — string functions; matches() regexes
 *               are compiled at policy load, so a bad regex breaks the
 *               rule at load, not mid-evaluation
 *
 * Semantics (fail-closed throughout, mirroring OpenBot's policy.ts):
 *   - Deny rules are evaluated before ask rules, ask before allow;
 *     the first matching rule of the winning effect decides.
 *   - No rule matches → deny. A missing/empty policy permits nothing.
 *   - A broken rule (unparseable, bad regex, invalid shape) with a
 *     deny or ask effect denies EVERYTHING it might cover — which,
 *     since it cannot be evaluated, is everything: the verdict is deny
 *     naming the broken rule. A broken allow rule is simply inert: it
 *     never permits, but it does not block other rules.
 *   - The same split applies to evaluation-time errors (e.g. an
 *     ordering comparison against a missing field): an error inside a
 *     deny or ask rule fails closed (deny, naming the rule); an error
 *     inside an allow rule means that rule does not permit.
 *
 * Round 2 (adoption #5 — the approvals rule engine) extends the
 * effect set with OpenBot's two remaining behaviours, mapped onto
 * Ghost's ratification design:
 *   pre_approved — a STANDING approval: the action executes without a
 *     carried approval, within the bounds the rule's own expression
 *     states (the expression IS the bounds). The verdict is recorded
 *     as pre_approved, so the record distinguishes standing approval
 *     from an interactive one.
 *   hand_off — the action is not executed and not asked of this run's
 *     approver; it routes to a different approver/scope (the rule's
 *     `handoff_to`). A hand_off rule without a target is broken.
 * Strictness ranks deny > hand_off > ask > pre_approved > allow and
 * evaluation consults tiers in that order, so the strictest matching
 * rule always wins (OpenBot's approvals ranking, with deny kept
 * outermost as in Round 1). Broken-rule and eval-error stances extend
 * by the same principle — a broken rule must never grant anything:
 * broken/eval-erroring deny, ask, and hand_off rules deny (naming
 * themselves); broken pre_approved and allow rules are inert.
 * Rules may be marked `locked: true`: locked rules are the team
 * layer — mergePolicyDocs (below) carries them verbatim into any
 * merged policy, and an overlay rule reusing a locked rule's id is
 * dropped, so ordinary policy edits cannot replace, weaken, or
 * shadow a locked rule; and since evaluation is tier-ordered rather
 * than document-ordered, no added allow rule can outrank a locked
 * deny/ask/hand_off either.
 *
 * Round 2 completion (adoption #3, second half) adds `initiator` to
 * the context: what started the run (person | routine | handoff |
 * memory | system), so a rule can hold unattended runs to a stricter
 * standard than the same person at the keyboard — e.g.
 * `initiator == 'routine' && permission_class == 'DEPLOY'` asks where
 * a person-initiated deploy would be allowed. The value is sourced
 * ONLY from the run-stamped initiator the Action Fabric carries (set
 * by the run's entry point via the Kernel); it is never read from
 * the action payload — a payload key named `initiator` is reachable
 * only as `payload.initiator` and is a different field. Missing-field
 * stance: a context built without an initiator (only possible for
 * direct evaluatePolicy callers — the fabric always stamps one,
 * defaulting to "system") evaluates `initiator` as null, exactly
 * like any other absent field: `initiator == 'routine'` is false,
 * `initiator == null` is true, and ordering comparisons against it
 * error, failing closed per the split above.
 */
export type PolicyEffect = "allow" | "pre_approved" | "ask" | "hand_off" | "deny";
export type PolicyVerdict = "allow" | "pre_approved" | "ask" | "hand_off" | "deny";
export interface PolicyRule {
    id: string;
    effect: PolicyEffect;
    /** Expression in the supported subset, over the PolicyContext fields. */
    when: string;
    note?: string;
    /** Required for hand_off rules: the approver/scope the action
     *  routes to instead of executing (e.g. "ryan", "finance"). */
    handoff_to?: string;
    /** Locked rules are carried verbatim by mergePolicyDocs and cannot
     *  be replaced or shadowed by overlay rules reusing their id. */
    locked?: boolean;
}
export interface PolicyDoc {
    rules: PolicyRule[];
}
export interface PolicyContext {
    kind: string;
    permission_class: PermissionClass | null;
    actor: string;
    project_id: string;
    /** True when the caller carried an approval covering this action. */
    approved: boolean;
    /**
     * What started the run (Round 2 completion, adoption #3), stamped
     * by the run's entry point — never sourced from the payload.
     * Optional in the type so hand-built contexts keep compiling; an
     * absent initiator evaluates as null (the engine's missing-field
     * stance). The Action Fabric always supplies it.
     */
    initiator?: InitiatorKind | null;
    payload: Record<string, unknown>;
}
export interface PolicyDecision {
    verdict: PolicyVerdict;
    /** The rule that decided; null only for the no-match fail-closed deny. */
    rule_id: string | null;
    reason: string;
    /** The routing target when the verdict is hand_off; else null. */
    handoff_to: string | null;
}
type Ast = {
    t: "lit";
    v: unknown;
} | {
    t: "list";
    items: Ast[];
} | {
    t: "ref";
    path: string[];
} | {
    t: "not";
    x: Ast;
} | {
    t: "and" | "or";
    l: Ast;
    r: Ast;
} | {
    t: "cmp";
    op: "==" | "!=" | "<" | "<=" | ">" | ">=" | "in";
    l: Ast;
    r: Ast;
} | {
    t: "call";
    fn: string;
    args: Ast[];
};
/** Parse one rule expression; throws PolicySyntaxError on any problem. */
export declare function parsePolicyExpression(src: string): Ast;
export interface CompiledRule {
    id: string;
    effect: PolicyEffect;
    when: string;
    note?: string;
    handoff_to: string | null;
    locked: boolean;
    ast: Ast | null;
    /** Set when the rule could not be compiled (bad shape or bad expression). */
    error: string | null;
    /**
     * How a broken rule behaves: a broken RESTRICTIVE rule (deny, ask,
     * hand_off) fails closed (denies, naming itself); a broken
     * permissive rule (allow, pre_approved) is inert (never grants,
     * blocks nothing). A rule whose effect itself is invalid has
     * unknowable intent, so it fails closed.
     */
    brokenStance: "deny" | "inert";
}
export interface CompiledPolicy {
    rules: CompiledRule[];
    source: PolicyDoc;
}
export declare function compilePolicy(doc: PolicyDoc): CompiledPolicy;
/**
 * Evaluate a compiled policy against one action context.
 * Strictest tier first, fail-closed — see the header for the exact
 * semantics. The strictest matching rule decides, whatever position
 * it holds in the document.
 */
export declare function evaluatePolicy(policy: CompiledPolicy, ctx: PolicyContext): PolicyDecision;
/**
 * Merge an editable overlay policy onto a base policy (OpenBot's
 * team/personal layering, in Ghost's idiom). Base rules marked
 * `locked: true` are carried into the result VERBATIM, and any
 * overlay rule reusing a locked rule's id is dropped — an ordinary
 * edit can neither replace nor shadow the locked layer. Overlay
 * rules with the id of a non-locked base rule replace it (an
 * ordinary edit); all other overlay rules append. Locked rules also
 * need no positional protection: evaluation is tier-ordered, so an
 * appended allow can never outrank a locked restrictive rule.
 */
export declare function mergePolicyDocs(base: PolicyDoc, overlay: PolicyDoc): PolicyDoc;
/**
 * The Kernel's shipped default policy: exactly the legacy permission
 * gate (Doc 03 §3.3), expressed as rules. Approval-required classes ask;
 * everything else in the permission map is allowed. Kinds outside the
 * permission map never reach the policy — the fabric denies them first,
 * exactly as before.
 */
export declare function defaultKernelPolicy(): PolicyDoc;
export {};
