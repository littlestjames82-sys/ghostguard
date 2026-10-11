import { APPROVAL_REQUIRED } from "./types.js";
/** Effects from strictest to most permissive: evaluation consults
 *  tiers in this order, so the strictest matching rule decides. */
const EFFECT_TIERS = ["deny", "hand_off", "ask", "pre_approved", "allow"];
/** Effects whose rules RESTRICT. A broken or erroring restrictive
 *  rule fails closed (denies, naming itself) because what it might
 *  have covered is unknowable; a broken permissive rule (allow,
 *  pre_approved) is inert — it grants nothing, but blocks nothing. */
const RESTRICTIVE = new Set(["deny", "ask", "hand_off"]);
export function validatePolicyDoc(doc) {
    const diagnostics = [];
    if (!doc || !Array.isArray(doc.rules)) {
        return [{
                level: "error",
                code: "invalid-policy-doc",
                message: "Policy document must include a rules array.",
            }];
    }
    const seenIds = new Map();
    const allowTrueRules = [];
    if (doc.rules.length === 0) {
        diagnostics.push({
            level: "warning",
            code: "empty-policy",
            message: "Policy has no rules; the fail-closed default will deny every action.",
        });
    }
    for (let index = 0; index < doc.rules.length; index += 1) {
        const raw = doc.rules[index];
        const ruleId = typeof raw?.id === "string" ? raw.id.trim() : "";
        if (!ruleId) {
            diagnostics.push({
                level: "error",
                code: "missing-rule-id",
                message: `Rule #${index + 1} is missing a unique id.`,
            });
        }
        else {
            const firstIndex = seenIds.get(ruleId);
            if (firstIndex !== undefined) {
                diagnostics.push({
                    level: "error",
                    code: "duplicate-rule-id",
                    rule_id: ruleId,
                    message: `Duplicate rule id "${ruleId}" also appears at rule #${firstIndex}.`,
                });
            }
            else {
                seenIds.set(ruleId, index + 1);
            }
        }
        const effect = raw?.effect;
        const validEffect = Array.isArray(EFFECT_TIERS) && EFFECT_TIERS.includes(effect);
        if (!validEffect) {
            diagnostics.push({
                level: "error",
                code: "invalid-rule-effect",
                rule_id: ruleId || null,
                message: `Rule ${ruleId ? `"${ruleId}"` : `#${index + 1}`} has an invalid effect: ${JSON.stringify(raw?.effect)}.`,
            });
        }
        const when = typeof raw?.when === "string" ? raw.when.trim() : "";
        if (effect === "hand_off" && !(typeof raw?.handoff_to === "string" && raw.handoff_to.trim())) {
            diagnostics.push({
                level: "error",
                code: "missing-handoff-target",
                rule_id: ruleId || null,
                message: `Rule ${ruleId ? `"${ruleId}"` : `#${index + 1}`} uses effect "hand_off" but has no handoff_to target.`,
            });
        }
        if (when.length === 0) {
            diagnostics.push({
                level: "error",
                code: "empty-rule-expression",
                rule_id: ruleId || null,
                message: `Rule ${ruleId ? `"${ruleId}"` : `#${index + 1}`} has an empty when expression.`,
            });
        }
        else {
            try {
                parsePolicyExpression(when);
            }
            catch (error) {
                diagnostics.push({
                    level: "error",
                    code: "invalid-rule-expression",
                    rule_id: ruleId || null,
                    message: `Rule ${ruleId ? `"${ruleId}"` : `#${index + 1}`} has an invalid expression: ${error.message}.`,
                });
            }
        }
        if (effect === "allow" && /^true$/i.test(when)) {
            allowTrueRules.push(ruleId || `#${index + 1}`);
        }
    }
    if (allowTrueRules.length > 0) {
        diagnostics.push({
            level: "warning",
            code: "allow-all",
            message: `Allow rules matching true (${allowTrueRules.join(", ")}) make this policy effectively allow-all unless stricter rules still outrank it.`,
        });
    }
    return diagnostics;
}
const FUNCTIONS = new Set(["startsWith", "endsWith", "contains", "matches"]);
class PolicySyntaxError extends Error {
}
function tokenize(src) {
    const toks = [];
    let i = 0;
    const fail = (m) => { throw new PolicySyntaxError(`${m} at offset ${i} in: ${src}`); };
    while (i < src.length) {
        const c = src[i];
        if (c === " " || c === "\t" || c === "\n" || c === "\r") {
            i += 1;
            continue;
        }
        const two = src.slice(i, i + 2);
        if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
            toks.push({ k: "op", v: two });
            i += 2;
            continue;
        }
        if ("()[],.!<>".includes(c)) {
            toks.push({ k: "op", v: c });
            i += 1;
            continue;
        }
        if (c === "'" || c === '"') {
            let j = i + 1;
            let out = "";
            while (j < src.length && src[j] !== c) {
                if (src[j] === "\\") {
                    const n = src[j + 1];
                    if (n === "n")
                        out += "\n";
                    else if (n === "t")
                        out += "\t";
                    else if (n === "\\")
                        out += "\\";
                    else if (n === "'")
                        out += "'";
                    else if (n === '"')
                        out += '"';
                    else
                        fail(`unsupported escape \\${n ?? ""}`);
                    j += 2;
                }
                else {
                    out += src[j];
                    j += 1;
                }
            }
            if (j >= src.length)
                fail("unterminated string literal");
            toks.push({ k: "str", v: out });
            i = j + 1;
            continue;
        }
        if (c >= "0" && c <= "9") {
            let j = i;
            while (j < src.length && /[0-9.]/.test(src[j]))
                j += 1;
            const v = Number(src.slice(i, j));
            if (Number.isNaN(v))
                fail("malformed number");
            toks.push({ k: "num", v });
            i = j;
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            let j = i;
            while (j < src.length && /[A-Za-z0-9_]/.test(src[j]))
                j += 1;
            toks.push({ k: "ident", v: src.slice(i, j) });
            i = j;
            continue;
        }
        fail(`unexpected character "${c}"`);
    }
    return toks;
}
class Parser {
    toks;
    src;
    pos = 0;
    constructor(toks, src) {
        this.toks = toks;
        this.src = src;
    }
    peek() { return this.toks[this.pos]; }
    fail(m) { throw new PolicySyntaxError(`${m} in: ${this.src}`); }
    eatOp(v) {
        const t = this.peek();
        if (t?.k === "op" && t.v === v) {
            this.pos += 1;
            return true;
        }
        return false;
    }
    expectOp(v) { if (!this.eatOp(v))
        this.fail(`expected "${v}"`); }
    parse() {
        const ast = this.parseOr();
        if (this.pos !== this.toks.length)
            this.fail("trailing input after complete expression");
        return ast;
    }
    parseOr() {
        let l = this.parseAnd();
        while (this.eatOp("||"))
            l = { t: "or", l, r: this.parseAnd() };
        return l;
    }
    parseAnd() {
        let l = this.parseCmp();
        while (this.eatOp("&&"))
            l = { t: "and", l, r: this.parseCmp() };
        return l;
    }
    parseCmp() {
        const l = this.parseUnary();
        const t = this.peek();
        if (t?.k === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) {
            this.pos += 1;
            const op = t.v;
            return { t: "cmp", op, l, r: this.parseUnary() };
        }
        if (t?.k === "ident" && t.v === "in") {
            this.pos += 1;
            return { t: "cmp", op: "in", l, r: this.parseUnary() };
        }
        return l;
    }
    parseUnary() {
        if (this.eatOp("!"))
            return { t: "not", x: this.parseUnary() };
        return this.parsePrimary();
    }
    parsePrimary() {
        const t = this.peek();
        if (!t)
            this.fail("unexpected end of expression");
        if (t.k === "op" && t.v === "(") {
            this.pos += 1;
            const inner = this.parseOr();
            this.expectOp(")");
            return inner;
        }
        if (t.k === "op" && t.v === "[") {
            this.pos += 1;
            const items = [];
            if (!this.eatOp("]")) {
                items.push(this.parseOr());
                while (this.eatOp(","))
                    items.push(this.parseOr());
                this.expectOp("]");
            }
            return { t: "list", items };
        }
        if (t.k === "str") {
            this.pos += 1;
            return { t: "lit", v: t.v };
        }
        if (t.k === "num") {
            this.pos += 1;
            return { t: "lit", v: t.v };
        }
        if (t.k === "ident") {
            if (t.v === "true") {
                this.pos += 1;
                return { t: "lit", v: true };
            }
            if (t.v === "false") {
                this.pos += 1;
                return { t: "lit", v: false };
            }
            if (t.v === "null") {
                this.pos += 1;
                return { t: "lit", v: null };
            }
            // Function call: ident '(' args ')'
            const next = this.toks[this.pos + 1];
            if (next?.k === "op" && next.v === "(") {
                if (!FUNCTIONS.has(t.v))
                    this.fail(`unknown function "${t.v}" (supported: ${[...FUNCTIONS].join(", ")})`);
                this.pos += 2;
                const args = [this.parseOr()];
                while (this.eatOp(","))
                    args.push(this.parseOr());
                this.expectOp(")");
                if (args.length !== 2)
                    this.fail(`function "${t.v}" takes exactly 2 arguments`);
                return { t: "call", fn: t.v, args };
            }
            // Field reference: dotted path
            const path = [t.v];
            this.pos += 1;
            while (this.eatOp(".")) {
                const seg = this.peek();
                if (seg?.k !== "ident")
                    this.fail('expected a field name after "."');
                path.push(seg.v);
                this.pos += 1;
            }
            return { t: "ref", path };
        }
        return this.fail("unexpected token");
    }
}
/** Parse one rule expression; throws PolicySyntaxError on any problem. */
export function parsePolicyExpression(src) {
    if (typeof src !== "string" || src.trim().length === 0) {
        throw new PolicySyntaxError("rule expression is empty");
    }
    return new Parser(tokenize(src), src).parse();
}
// ── Evaluation ────────────────────────────────────────────────────────
class PolicyEvalError extends Error {
}
function resolveRef(path, ctx) {
    const [root, ...rest] = path;
    let cur;
    switch (root) {
        case "kind":
            cur = ctx.kind;
            break;
        case "permission_class":
            cur = ctx.permission_class;
            break;
        case "actor":
            cur = ctx.actor;
            break;
        case "project_id":
            cur = ctx.project_id;
            break;
        case "approved":
            cur = ctx.approved;
            break;
        case "initiator":
            cur = ctx.initiator ?? null;
            break;
        case "payload":
            cur = ctx.payload;
            break;
        default: return null; // unknown root: absent, like a missing payload field
    }
    for (const seg of rest) {
        if (cur === null || typeof cur !== "object")
            return null;
        cur = cur[seg] ?? null;
    }
    return cur ?? null;
}
function evalAst(ast, ctx) {
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
                    if (!Array.isArray(r))
                        throw new PolicyEvalError(`right side of "in" is not a list`);
                    return r.some((x) => x === l);
                }
                default: {
                    if (typeof l !== typeof r || (typeof l !== "number" && typeof l !== "string")) {
                        throw new PolicyEvalError(`cannot order-compare ${l === null ? "null" : typeof l} with ${r === null ? "null" : typeof r}`);
                    }
                    if (ast.op === "<")
                        return l < r;
                    if (ast.op === "<=")
                        return l <= r;
                    if (ast.op === ">")
                        return l > r;
                    return l >= r;
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
                    let re;
                    try {
                        re = new RegExp(b);
                    }
                    catch (e) {
                        throw new PolicyEvalError(`bad regex in matches(): ${e.message}`);
                    }
                    return re.test(a);
                }
            }
            throw new PolicyEvalError(`unknown function ${ast.fn}`);
        }
    }
}
export function compilePolicy(doc) {
    const diagnostics = validatePolicyDoc(doc);
    const rules = [];
    const rawRules = Array.isArray(doc?.rules) ? doc.rules : [];
    rawRules.forEach((raw, idx) => {
        const r = raw;
        const id = typeof r.id === "string" && r.id.trim() ? r.id : `<invalid rule #${idx + 1}>`;
        const effectOk = EFFECT_TIERS.includes(r.effect);
        let ast = null;
        let error = null;
        const handoffTo = typeof r.handoff_to === "string" && r.handoff_to.trim() ? r.handoff_to : null;
        if (!effectOk) {
            error = `effect must be one of ${EFFECT_TIERS.join(", ")} (got ${JSON.stringify(r.effect)})`;
        }
        else if (r.effect === "hand_off" && !handoffTo) {
            error = `hand_off rule has no handoff_to target — there is nowhere to route the action`;
        }
        else {
            try {
                ast = parsePolicyExpression(String(r.when ?? ""));
            }
            catch (e) {
                error = e.message;
            }
        }
        rules.push({
            id,
            effect: effectOk ? r.effect : "deny",
            when: String(r.when ?? ""),
            ...(typeof r.note === "string" ? { note: r.note } : {}),
            handoff_to: handoffTo,
            locked: r.locked === true,
            ast,
            error,
            brokenStance: effectOk && !RESTRICTIVE.has(r.effect) ? "inert" : "deny",
        });
    });
    return { rules, source: doc, diagnostics };
}
function ruleMatches(rule, ctx) {
    return Boolean(evalAst(rule.ast, ctx));
}
/**
 * Evaluate a compiled policy against one action context.
 * Strictest tier first, fail-closed — see the header for the exact
 * semantics. The strictest matching rule decides, whatever position
 * it holds in the document.
 */
export function evaluatePolicy(policy, ctx) {
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
            if (rule.effect !== effect || rule.error)
                continue;
            let matched;
            try {
                matched = ruleMatches(rule, ctx);
            }
            catch (e) {
                if (!RESTRICTIVE.has(effect))
                    continue; // an erroring permissive rule never grants
                return {
                    verdict: "deny",
                    rule_id: rule.id,
                    reason: `policy rule "${rule.id}" failed to evaluate (${e.message}) — failing closed`,
                    handoff_to: null,
                };
            }
            if (matched) {
                return {
                    verdict: effect,
                    rule_id: rule.id,
                    reason: effect === "deny" ? `denied by policy rule "${rule.id}"`
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
export function mergePolicyDocs(base, overlay) {
    const baseRules = Array.isArray(base?.rules) ? base.rules : [];
    const overlayRules = Array.isArray(overlay?.rules) ? overlay.rules : [];
    const lockedIds = new Set(baseRules.filter((r) => r.locked === true).map((r) => r.id));
    const overlayById = new Map();
    for (const r of overlayRules) {
        if (r && typeof r.id === "string" && !lockedIds.has(r.id))
            overlayById.set(r.id, r);
    }
    const merged = [];
    const consumed = new Set();
    for (const r of baseRules) {
        const replacement = r.locked === true ? undefined : overlayById.get(r.id);
        if (replacement) {
            merged.push(replacement);
            consumed.add(r.id);
        }
        else
            merged.push(r);
    }
    for (const r of overlayRules) {
        if (!r || typeof r.id !== "string" || lockedIds.has(r.id) || consumed.has(r.id))
            continue;
        if (baseRules.some((b) => b.id === r.id))
            continue; // already placed as a replacement
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
export function defaultKernelPolicy() {
    const rules = [...APPROVAL_REQUIRED].map((cls) => ({
        id: `approval-required:${cls}`,
        effect: "ask",
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
