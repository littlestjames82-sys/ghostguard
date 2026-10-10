import { APPROVAL_REQUIRED, type InitiatorKind, type PermissionClass } from "./types.js";

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

/** Effects from strictest to most permissive: evaluation consults
 *  tiers in this order, so the strictest matching rule decides. */
const EFFECT_TIERS: readonly PolicyEffect[] = ["deny", "hand_off", "ask", "pre_approved", "allow"];

/** Effects whose rules RESTRICT. A broken or erroring restrictive
 *  rule fails closed (denies, naming itself) because what it might
 *  have covered is unknowable; a broken permissive rule (allow,
 *  pre_approved) is inert — it grants nothing, but blocks nothing. */
const RESTRICTIVE: ReadonlySet<PolicyEffect> = new Set(["deny", "ask", "hand_off"]);

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

// ── Expression AST ────────────────────────────────────────────────────

type Ast =
  | { t: "lit"; v: unknown }
  | { t: "list"; items: Ast[] }
  | { t: "ref"; path: string[] }
  | { t: "not"; x: Ast }
  | { t: "and" | "or"; l: Ast; r: Ast }
  | { t: "cmp"; op: "==" | "!=" | "<" | "<=" | ">" | ">=" | "in"; l: Ast; r: Ast }
  | { t: "call"; fn: string; args: Ast[] };

const FUNCTIONS = new Set(["startsWith", "endsWith", "contains", "matches"]);

class PolicySyntaxError extends Error {}

type Tok =
  | { k: "op"; v: string }
  | { k: "str"; v: string }
  | { k: "num"; v: number }
  | { k: "ident"; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const fail = (m: string): never => { throw new PolicySyntaxError(`${m} at offset ${i} in: ${src}`); };
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i += 1; continue; }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) { toks.push({ k: "op", v: two }); i += 2; continue; }
    if ("()[],.!<>".includes(c)) { toks.push({ k: "op", v: c }); i += 1; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1; let out = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") {
          const n = src[j + 1];
          if (n === "n") out += "\n"; else if (n === "t") out += "\t";
          else if (n === "\\") out += "\\"; else if (n === "'") out += "'"; else if (n === '"') out += '"';
          else fail(`unsupported escape \\${n ?? ""}`);
          j += 2;
        } else { out += src[j]; j += 1; }
      }
      if (j >= src.length) fail("unterminated string literal");
      toks.push({ k: "str", v: out }); i = j + 1; continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      const v = Number(src.slice(i, j));
      if (Number.isNaN(v)) fail("malformed number");
      toks.push({ k: "num", v }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      toks.push({ k: "ident", v: src.slice(i, j) }); i = j; continue;
    }
    fail(`unexpected character "${c}"`);
  }
  return toks;
}

class Parser {
  private pos = 0;
  constructor(private toks: Tok[], private src: string) {}

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private fail(m: string): never { throw new PolicySyntaxError(`${m} in: ${this.src}`); }
  private eatOp(v: string): boolean {
    const t = this.peek();
    if (t?.k === "op" && t.v === v) { this.pos += 1; return true; }
    return false;
  }
  private expectOp(v: string): void { if (!this.eatOp(v)) this.fail(`expected "${v}"`); }

  parse(): Ast {
    const ast = this.parseOr();
    if (this.pos !== this.toks.length) this.fail("trailing input after complete expression");
    return ast;
  }

  private parseOr(): Ast {
    let l = this.parseAnd();
    while (this.eatOp("||")) l = { t: "or", l, r: this.parseAnd() };
    return l;
  }

  private parseAnd(): Ast {
    let l = this.parseCmp();
    while (this.eatOp("&&")) l = { t: "and", l, r: this.parseCmp() };
    return l;
  }

  private parseCmp(): Ast {
    const l = this.parseUnary();
    const t = this.peek();
    if (t?.k === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      this.pos += 1;
      const op = t.v as "==" | "!=" | "<" | "<=" | ">" | ">=";
      return { t: "cmp", op, l, r: this.parseUnary() };
    }
    if (t?.k === "ident" && t.v === "in") {
      this.pos += 1;
      return { t: "cmp", op: "in", l, r: this.parseUnary() };
    }
    return l;
  }

  private parseUnary(): Ast {
    if (this.eatOp("!")) return { t: "not", x: this.parseUnary() };
    return this.parsePrimary();
  }

  private parsePrimary(): Ast {
    const t = this.peek();
    if (!t) this.fail("unexpected end of expression");
    if (t.k === "op" && t.v === "(") {
      this.pos += 1;
      const inner = this.parseOr();
      this.expectOp(")");
      return inner;
    }
    if (t.k === "op" && t.v === "[") {
      this.pos += 1;
      const items: Ast[] = [];
      if (!this.eatOp("]")) {
        items.push(this.parseOr());
        while (this.eatOp(",")) items.push(this.parseOr());
        this.expectOp("]");
      }
      return { t: "list", items };
    }
    if (t.k === "str") { this.pos += 1; return { t: "lit", v: t.v }; }
    if (t.k === "num") { this.pos += 1; return { t: "lit", v: t.v }; }
    if (t.k === "ident") {
      if (t.v === "true") { this.pos += 1; return { t: "lit", v: true }; }
      if (t.v === "false") { this.pos += 1; return { t: "lit", v: false }; }
      if (t.v === "null") { this.pos += 1; return { t: "lit", v: null }; }
      // Function call: ident '(' args ')'
      const next = this.toks[this.pos + 1];
      if (next?.k === "op" && next.v === "(") {
        if (!FUNCTIONS.has(t.v)) this.fail(`unknown function "${t.v}" (supported: ${[...FUNCTIONS].join(", ")})`);
        this.pos += 2;
        const args: Ast[] = [this.parseOr()];
        while (this.eatOp(",")) args.push(this.parseOr());
        this.expectOp(")");
        if (args.length !== 2) this.fail(`function "${t.v}" takes exactly 2 arguments`);
        return { t: "call", fn: t.v, args };
      }
      // Field reference: dotted path
      const path = [t.v];
      this.pos += 1;
      while (this.eatOp(".")) {
        const seg = this.peek();
        if (seg?.k !== "ident") this.fail('expected a field name after "."');
        path.push(seg.v);
        this.pos += 1;
      }
      return { t: "ref", path };
    }
    return this.fail("unexpected token");
  }
}

/** Parse one rule expression; throws PolicySyntaxError on any problem. */
export function parsePolicyExpression(src: string): Ast {
  if (typeof src !== "string" || src.trim().length === 0) {
    throw new PolicySyntaxError("rule expression is empty");
  }
  return new Parser(tokenize(src), src).parse();
}

// ── Evaluation ────────────────────────────────────────────────────────

class PolicyEvalError extends Error {}

function resolveRef(path: string[], ctx: PolicyContext): unknown {
  const [root, ...rest] = path;
  let cur: unknown;
  switch (root) {
    case "kind": cur = ctx.kind; break;
    case "permission_class": cur = ctx.permission_class; break;
    case "actor": cur = ctx.actor; break;
    case "project_id": cur = ctx.project_id; break;
    case "approved": cur = ctx.approved; break;
    case "initiator": cur = ctx.initiator ?? null; break;
    case "payload": cur = ctx.payload; break;
    default: return null; // unknown root: absent, like a missing payload field
  }
  for (const seg of rest) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[seg] ?? null;
  }
  return cur ?? null;
}

function evalAst(ast: Ast, ctx: PolicyContext): unknown {
  switch (ast.t) {
    case "lit": return ast.v;
    case "list": return ast.items.map((i) => evalAst(i, ctx));
    case "ref": return resolveRef(ast.path, ctx);
    case "not": return !evalAst(ast.x, ctx);
    case "and": return Boolean(evalAst(ast.l, ctx)) && Boolean(evalAst(ast.r, ctx));
    case "or": return Boolean(evalAst(ast.l, ctx)) || Boolean(evalAst(ast.r, ctx));
    case "cmp": {
      const l = evalAst(ast.l, ctx);
      const r = evalAst(ast.r, ctx);
      switch (ast.op) {
        case "==": return l === r || (l === null && r === null);
        case "!=": return !(l === r || (l === null && r === null));
        case "in": {
          if (!Array.isArray(r)) throw new PolicyEvalError(`right side of "in" is not a list`);
          return r.some((x) => x === l);
        }
        default: {
          if (typeof l !== typeof r || (typeof l !== "number" && typeof l !== "string")) {
            throw new PolicyEvalError(`cannot order-compare ${l === null ? "null" : typeof l} with ${r === null ? "null" : typeof r}`);
          }
          if (ast.op === "<") return (l as number) < (r as number);
          if (ast.op === "<=") return (l as number) <= (r as number);
          if (ast.op === ">") return (l as number) > (r as number);
          return (l as number) >= (r as number);
        }
      }
    }
    case "call": {
      const [a, b] = ast.args.map((x) => evalAst(x, ctx));
      if (typeof a !== "string" || typeof b !== "string") {
        throw new PolicyEvalError(`${ast.fn}() needs two string arguments`);
      }
      switch (ast.fn) {
        case "startsWith": return a.startsWith(b);
        case "endsWith": return a.endsWith(b);
        case "contains": return a.includes(b);
        case "matches": {
          let re: RegExp;
          try { re = new RegExp(b); } catch (e) { throw new PolicyEvalError(`bad regex in matches(): ${(e as Error).message}`); }
          return re.test(a);
        }
      }
      throw new PolicyEvalError(`unknown function ${ast.fn}`);
    }
  }
}

// ── Compiled policy ───────────────────────────────────────────────────

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

export function compilePolicy(doc: PolicyDoc): CompiledPolicy {
  const rules: CompiledRule[] = [];
  const rawRules = Array.isArray(doc?.rules) ? doc.rules : [];
  rawRules.forEach((raw, idx) => {
    const r = raw as Partial<PolicyRule>;
    const id = typeof r.id === "string" && r.id.trim() ? r.id : `<invalid rule #${idx + 1}>`;
    const effectOk = (EFFECT_TIERS as readonly string[]).includes(r.effect as string);
    let ast: Ast | null = null;
    let error: string | null = null;
    const handoffTo = typeof r.handoff_to === "string" && r.handoff_to.trim() ? r.handoff_to : null;
    if (!effectOk) {
      error = `effect must be one of ${EFFECT_TIERS.join(", ")} (got ${JSON.stringify(r.effect)})`;
    } else if (r.effect === "hand_off" && !handoffTo) {
      error = `hand_off rule has no handoff_to target — there is nowhere to route the action`;
    } else {
      try { ast = parsePolicyExpression(String(r.when ?? "")); }
      catch (e) { error = (e as Error).message; }
    }
    rules.push({
      id,
      effect: effectOk ? (r.effect as PolicyEffect) : "deny",
      when: String(r.when ?? ""),
      ...(typeof r.note === "string" ? { note: r.note } : {}),
      handoff_to: handoffTo,
      locked: r.locked === true,
      ast,
      error,
      brokenStance: effectOk && !RESTRICTIVE.has(r.effect as PolicyEffect) ? "inert" : "deny",
    });
  });
  return { rules, source: doc };
}

function ruleMatches(rule: CompiledRule, ctx: PolicyContext): boolean {
  return Boolean(evalAst(rule.ast!, ctx));
}

/**
 * Evaluate a compiled policy against one action context.
 * Strictest tier first, fail-closed — see the header for the exact
 * semantics. The strictest matching rule decides, whatever position
 * it holds in the document.
 */
export function evaluatePolicy(policy: CompiledPolicy, ctx: PolicyContext): PolicyDecision {
  // A broken fail-closed rule denies everything it might cover — and
  // since it cannot be evaluated, that is everything. Checked first,
  // ahead of every other rule, whatever its declared position.
  for (const rule of policy.rules) {
    if (rule.error && rule.brokenStance === "deny") {
      return {
        verdict: "deny",
        rule_id: rule.id,
        reason: `policy rule "${rule.id}" is broken (${rule.error}) — broken rules fail closed`,
        handoff_to: null,
      };
    }
  }
  for (const effect of EFFECT_TIERS) {
    for (const rule of policy.rules) {
      if (rule.effect !== effect || rule.error) continue;
      let matched: boolean;
      try {
        matched = ruleMatches(rule, ctx);
      } catch (e) {
        if (!RESTRICTIVE.has(effect)) continue; // an erroring permissive rule never grants
        return {
          verdict: "deny",
          rule_id: rule.id,
          reason: `policy rule "${rule.id}" failed to evaluate (${(e as Error).message}) — failing closed`,
          handoff_to: null,
        };
      }
      if (matched) {
        return {
          verdict: effect,
          rule_id: rule.id,
          reason:
            effect === "deny" ? `denied by policy rule "${rule.id}"`
            : effect === "ask" ? `policy rule "${rule.id}" requires human approval (ask)`
            : effect === "hand_off" ? `policy rule "${rule.id}" hands this action off to "${rule.handoff_to}" instead of executing it`
            : effect === "pre_approved" ? `policy rule "${rule.id}" grants standing approval (pre-approved within its bounds)`
            : `allowed by policy rule "${rule.id}"`,
          handoff_to: effect === "hand_off" ? rule.handoff_to : null,
        };
      }
    }
  }
  return {
    verdict: "deny",
    rule_id: null,
    reason: "no policy rule matched this action — denied by the fail-closed default",
    handoff_to: null,
  };
}

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
export function mergePolicyDocs(base: PolicyDoc, overlay: PolicyDoc): PolicyDoc {
  const baseRules = Array.isArray(base?.rules) ? base.rules : [];
  const overlayRules = Array.isArray(overlay?.rules) ? overlay.rules : [];
  const lockedIds = new Set(baseRules.filter((r) => r.locked === true).map((r) => r.id));
  const overlayById = new Map<string, PolicyRule>();
  for (const r of overlayRules) {
    if (r && typeof r.id === "string" && !lockedIds.has(r.id)) overlayById.set(r.id, r);
  }
  const merged: PolicyRule[] = [];
  const consumed = new Set<string>();
  for (const r of baseRules) {
    const replacement = r.locked === true ? undefined : overlayById.get(r.id);
    if (replacement) { merged.push(replacement); consumed.add(r.id); }
    else merged.push(r);
  }
  for (const r of overlayRules) {
    if (!r || typeof r.id !== "string" || lockedIds.has(r.id) || consumed.has(r.id)) continue;
    if (baseRules.some((b) => b.id === r.id)) continue; // already placed as a replacement
    merged.push(r);
  }
  return { rules: merged };
}

/**
 * The Kernel's shipped default policy: exactly the legacy permission
 * gate (Doc 03 §3.3), expressed as rules. Approval-required classes ask;
 * everything else in the permission map is allowed. Kinds outside the
 * permission map never reach the policy — the fabric denies them first,
 * exactly as before.
 */
export function defaultKernelPolicy(): PolicyDoc {
  const rules: PolicyRule[] = [...APPROVAL_REQUIRED].map((cls: PermissionClass) => ({
    id: `approval-required:${cls}`,
    effect: "ask" as const,
    when: `permission_class == '${cls}'`,
    note: "Mirrors APPROVAL_REQUIRED in contracts (Doc 03 §3.3): this class asks a human first. An approval carried with the run satisfies the ask.",
  }));
  rules.push({
    id: "default-allow",
    effect: "allow",
    when: "true",
    note: "Any known kind no rule above claims is allowed, as under the legacy gate.",
  });
  return { rules };
}
