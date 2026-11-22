/*
 * GhostGuard Lite — single-file, no build step, no dependencies.
 *
 * Include it in a page or a browser agent:
 *   <script src="ghostguard-lite.js"></script>
 *   const gg = window.GhostGuardLite;
 *   const policy = gg.compilePolicy(policyJson);
 *   const decision = gg.evaluatePolicy(policy, {
 *     kind: "browser.submit_click", permission_class: gg.classifyAction({type:"submit"}),
 *     actor: "browser-agent", initiator: "person", project_id: "demo",
 *     approved: false, payload: { button: "Place order" },
 *   });
 *   // decision: { verdict, rule_id, reason, handoff_to }
 *   // execute ONLY on verdict allow / pre_approved.
 *
 * It implements the same semantics as the GhostGuard engine for the
 * supported policy subset: strictest verdict wins
 * (deny > hand_off > ask > pre_approved > allow), fail-closed
 * everywhere (no match -> deny; a broken restrictive rule denies
 * and names itself; a broken permissive rule is inert; locked
 * rules survive overlay merges).
 *
 * In Node it also works: import this file for its side effect and
 * read globalThis.GhostGuardLite (the parity test does exactly that).
 */
(function () {
  "use strict";

  // --- Classifier: DOM-ish action -> GhostGuard PermissionClass ---
  // When in doubt, classify UP (submit-capable click -> NETWORK_WRITE).
  function classifyAction(action) {
    if (!action || typeof action.type !== "string") return null;
    switch (action.type) {
      case "navigate": case "read": case "extract": case "scroll": return "READ";
      case "fill": case "type": case "click": return "WRITE_LOCAL";
      case "submit": case "submit_click": case "form_submit": return "NETWORK_WRITE";
      case "execute": case "run_script": return "EXECUTE";
      case "deploy": return "DEPLOY";
      case "publish": case "post": return "PUBLISH";
      case "send": case "send_message": case "email": case "dm": return "COMMUNICATE";
      case "pay": case "buy": case "purchase": case "checkout": return "SPEND";
      case "delete": case "remove": return "DELETE";
      default: return null; // unmapped: callers must refuse before policy (the gateway stance)
    }
  }

  // --- Tiny expression engine for the GhostGuard CEL subset ---
  function tokenize(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "'" || c === '"') {
        let j = i + 1, out = "";
        while (j < src.length && src[j] !== c) {
          if (src[j] === "\\" && j + 1 < src.length) { out += src[j + 1]; j += 2; }
          else { out += src[j]; j++; }
        }
        if (j >= src.length) throw new Error("unterminated string");
        tokens.push({ t: "str", v: out }); i = j + 1; continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
        tokens.push({ t: "num", v: Number(src.slice(i, j)) }); i = j; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i; while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
        tokens.push({ t: "ident", v: src.slice(i, j) }); i = j; continue;
      }
      const two = src.slice(i, i + 2);
      if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) { tokens.push({ t: "op", v: two }); i += 2; continue; }
      if ("<>!(),[]".includes(c)) { tokens.push({ t: "op", v: c }); i++; continue; }
      throw new Error(`unexpected character "${c}"`);
    }
    return tokens;
  }

  function parse(src) {
    const tokens = tokenize(src);
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    function expect(v) { const t = next(); if (!t || t.v !== v) throw new Error(`expected "${v}"`); }
    function parseOr() {
      let l = parseAnd();
      while (peek() && peek().v === "||") { next(); l = { t: "or", l, r: parseAnd() }; }
      return l;
    }
    function parseAnd() {
      let l = parseCmp();
      while (peek() && peek().v === "&&") { next(); l = { t: "and", l, r: parseCmp() }; }
      return l;
    }
    function parseCmp() {
      let l = parseUnary();
      const t = peek();
      if (t && (["==", "!=", "<", "<=", ">", ">="].includes(t.v) || (t.t === "ident" && t.v === "in"))) {
        next(); return { t: "cmp", op: t.v, l, r: parseUnary() };
      }
      return l;
    }
    function parseUnary() {
      const t = peek();
      if (t && t.v === "!") { next(); return { t: "not", x: parseUnary() }; }
      return parsePrimary();
    }
    function parsePrimary() {
      const t = next();
      if (!t) throw new Error("unexpected end of expression");
      if (t.v === "(") { const e = parseOr(); expect(")"); return e; }
      if (t.v === "[") {
        const items = [];
        if (!(peek() && peek().v === "]")) {
          items.push(parseOr());
          while (peek() && peek().v === ",") { next(); items.push(parseOr()); }
        }
        expect("]"); return { t: "list", items };
      }
      if (t.t === "str" || t.t === "num") return { t: "lit", v: t.v };
      if (t.t === "ident") {
        if (t.v === "true") return { t: "lit", v: true };
        if (t.v === "false") return { t: "lit", v: false };
        if (t.v === "null") return { t: "lit", v: null };
        if (peek() && peek().v === "(") {
          next();
          const args = [];
          if (!(peek() && peek().v === ")")) {
            args.push(parseOr());
            while (peek() && peek().v === ",") { next(); args.push(parseOr()); }
          }
          expect(")");
          return { t: "call", fn: t.v, args };
        }
        return { t: "ref", path: t.v.split(".") };
      }
      throw new Error(`unexpected token "${t.v}"`);
    }
    const ast = parseOr();
    if (pos !== tokens.length) throw new Error("trailing tokens in expression");
    return ast;
  }

  function lookup(ctx, path) {
    let cur = ctx;
    for (const key of path) {
      if (cur === null || cur === undefined || typeof cur !== "object") return null;
      cur = cur[key];
    }
    return cur === undefined ? null : cur;
  }

  function evalAst(node, ctx) {
    switch (node.t) {
      case "lit": return node.v;
      case "list": return node.items.map((x) => evalAst(x, ctx));
      case "ref": return lookup(ctx, node.path);
      case "not": return !evalAst(node.x, ctx);
      case "and": return Boolean(evalAst(node.l, ctx)) && Boolean(evalAst(node.r, ctx));
      case "or": return Boolean(evalAst(node.l, ctx)) || Boolean(evalAst(node.r, ctx));
      case "cmp": {
        const l = evalAst(node.l, ctx), r = evalAst(node.r, ctx);
        switch (node.op) {
          case "==": return l === r;
          case "!=": return l !== r;
          case "in":
            if (!Array.isArray(r)) throw new Error("'in' needs a list on the right");
            return r.includes(l);
          case "<": case "<=": case ">": case ">=": {
            const ok = (typeof l === "number" && typeof r === "number") || (typeof l === "string" && typeof r === "string");
            if (!ok) throw new Error(`ordering comparison "${node.op}" needs two numbers or two strings (got ${l === null ? "null" : typeof l} and ${r === null ? "null" : typeof r})`);
            if (node.op === "<") return l < r;
            if (node.op === "<=") return l <= r;
            if (node.op === ">") return l > r;
            return l >= r;
          }
        }
        throw new Error(`bad operator ${node.op}`);
      }
      case "call": {
        const args = node.args.map((a) => evalAst(a, ctx));
        const [x, s] = args;
        if (typeof x !== "string" || typeof s !== "string") throw new Error(`${node.fn} needs string arguments`);
        switch (node.fn) {
          case "startsWith": return x.startsWith(s);
          case "endsWith": return x.endsWith(s);
          case "contains": return x.includes(s);
          case "matches": return new RegExp(s).test(x);
          default: throw new Error(`unknown function ${node.fn}`);
        }
      }
    }
    throw new Error("bad expression node");
  }

  // --- Policy compile / merge / evaluate (engine semantics) ---
  const TIERS = ["deny", "hand_off", "ask", "pre_approved", "allow"];
  const RESTRICTIVE = new Set(["deny", "hand_off", "ask"]);

  function compilePolicy(doc) {
    const rules = ((doc && doc.rules) || []).map((r) => {
      let ast = null, error = null;
      if (!r || typeof r.id !== "string" || typeof r.when !== "string" || typeof r.effect !== "string") {
        error = "rule is missing id/when/effect";
      } else if (!TIERS.includes(r.effect)) {
        error = `invalid effect "${r.effect}"`;
      } else if (r.effect === "hand_off" && !r.handoff_to) {
        error = "hand_off rule has no handoff_to";
      } else {
        try {
          ast = parse(r.when);
          // compile regexes at load so a bad one breaks the rule now
          (function walk(n) {
            if (!n || typeof n !== "object") return;
            if (n.t === "call" && n.fn === "matches" && n.args[1] && n.args[1].t === "lit") new RegExp(n.args[1].v);
            Object.values(n).forEach((v) => { if (Array.isArray(v)) v.forEach(walk); else walk(v); });
          })(ast);
        } catch (e) { error = e.message; ast = null; }
      }
      const brokenStance = !TIERS.includes(r && r.effect) || RESTRICTIVE.has(r && r.effect) ? "deny" : "inert";
      return { id: r && r.id, effect: r && r.effect, when: r && r.when, note: r && r.note,
               handoff_to: (r && r.handoff_to) || null, locked: Boolean(r && r.locked),
               ast, error, brokenStance };
    });
    return { rules, source: doc };
  }

  function evaluatePolicy(policy, ctx) {
    for (const tier of TIERS) {
      for (const rule of policy.rules) {
        if (rule.effect !== tier) {
          // A rule with an invalid effect has unknowable intent: fail closed.
          if (!TIERS.includes(rule.effect) && tier === "deny") {
            return { verdict: "deny", rule_id: rule.id || null, handoff_to: null,
                     reason: `rule "${rule.id}" is broken (${rule.error}) — failing closed` };
          }
          continue;
        }
        if (rule.error) {
          if (rule.brokenStance === "deny") {
            return { verdict: "deny", rule_id: rule.id, handoff_to: null,
                     reason: `rule "${rule.id}" is broken (${rule.error}) — failing closed` };
          }
          continue; // broken permissive rule: inert
        }
        let matched = false;
        try { matched = Boolean(evalAst(rule.ast, ctx)); }
        catch (e) {
          if (RESTRICTIVE.has(tier)) {
            return { verdict: "deny", rule_id: rule.id, handoff_to: null,
                     reason: `rule "${rule.id}" errored (${e.message}) — failing closed` };
          }
          continue;
        }
        if (matched) {
          return { verdict: tier, rule_id: rule.id,
                   handoff_to: tier === "hand_off" ? rule.handoff_to : null,
                   reason: `rule "${rule.id}" matched` };
        }
      }
    }
    return { verdict: "deny", rule_id: null, handoff_to: null,
             reason: "no rule matched — failing closed" };
  }

  function mergePolicyDocs(base, overlay) {
    const lockedIds = new Set(((base && base.rules) || []).filter((r) => r.locked).map((r) => r.id));
    const byId = new Map();
    const order = [];
    for (const r of (base && base.rules) || []) { byId.set(r.id, r); order.push(r.id); }
    for (const r of (overlay && overlay.rules) || []) {
      if (lockedIds.has(r.id)) continue; // locked rules cannot be replaced or shadowed
      if (!byId.has(r.id)) order.push(r.id);
      byId.set(r.id, r);
    }
    return { rules: order.map((id) => byId.get(id)) };
  }

  /**
   * Decide + record: builds the gateway record and hands it to the
   * record sink BEFORE returning the decision. Callers execute only
   * on allow / pre_approved. If the sink throws, this throws — a
   * record that failed to write means the action does not run.
   */
  function evaluateAndRecord(policy, intent, recordSink) {
    const decision = evaluatePolicy(policy, {
      kind: intent.kind, permission_class: intent.permission_class,
      actor: intent.actor, project_id: intent.project_id,
      approved: Boolean(intent.approved), initiator: intent.initiator ?? null,
      payload: intent.action_payload || {},
    });
    const record = {
      action_id: intent.action_id, kind: intent.kind,
      permission_class: intent.permission_class, actor: intent.actor,
      initiator: intent.initiator, project_id: intent.project_id,
      verdict: decision.verdict, rule_id: decision.rule_id, reason: decision.reason,
      handoff_to: decision.handoff_to, target_ref: intent.target_ref ?? null,
      snapshot_id: intent.snapshot_id ?? null, target: intent.target ?? null,
      action_payload: intent.action_payload || {}, dry_run: Boolean(intent.dry_run),
    };
    if (typeof recordSink === "function") recordSink(record);
    return { decision, record };
  }

  globalThis.GhostGuardLite = { classifyAction, compilePolicy, evaluatePolicy, mergePolicyDocs, evaluateAndRecord };
})();
