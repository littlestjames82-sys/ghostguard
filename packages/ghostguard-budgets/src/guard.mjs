/**
 * createStatefulGuard — GhostGuard ideas #1 + #4 as one add-on:
 * stateful budgets/velocity rules and a kill switch, wrapped around
 * the real (stateless) GhostGuard engine imported from its built dist.
 *
 * Decision flow per action (strictly in this order):
 *   0. Load state. If the state store fails (corrupt/unreadable),
 *      the decision is DENY, rule "state-store-unavailable" — for
 *      every class, READ included. A guard that cannot see its own
 *      budgets must not silently allow anything.
 *   1. Kill switch. The freeze file is re-read on EVERY decision.
 *      While frozen, every class except READ is denied with rule_id
 *      "kill-switch-freeze". READ still flows through the rest of
 *      the pipeline normally.
 *   2. Stateless policy — the GhostGuard engine decides as usual.
 *   3. Stateful rules. Spend budgets and velocity rules compute a
 *      candidate verdict from the recorded history in the rolling
 *      window. The candidate is combined with the stateless verdict
 *      by STRICTNESS RANK ONLY (deny > hand_off > ask > pre_approved
 *      > allow): the final verdict is never looser than either input.
 *      Stateful rules cannot grant, widen, or resurrect anything.
 *   4. Counting. Only a final allow / pre_approved is appended to the
 *      state (and persisted BEFORE the decision is returned — if the
 *      persist fails, the verdict is overridden to deny, rule
 *      "state-store-unavailable": an action the guard could not
 *      record against its budgets does not run).
 *
 * Counting semantics: budgets and velocity measure actions that were
 * cleared to execute, not attempts. A denied/asked action does not
 * consume budget.
 */
import { randomUUID } from "node:crypto";
import {
  compilePolicy,
  evaluatePolicy,
  gatewayRecordFromDecision,
} from "ghostguard";
import { loadConfigFile, normalizeConfig } from "./config.mjs";
import { StateStoreError, loadState, saveState } from "./state.mjs";
import { readFreeze } from "./freeze.mjs";

export const RANK = { allow: 0, pre_approved: 1, ask: 2, hand_off: 3, deny: 4 };

function stricterOf(a, b) {
  return RANK[b.verdict] > RANK[a.verdict] ? b : a;
}

function scopeMatches(scope, event, action) {
  if (scope === "global") return true;
  if (scope === "actor") return event.actor === action.actor;
  if (scope === "project") return event.project_id === action.project_id;
  return event.actor === action.actor && event.project_id === action.project_id; // actor_project
}

function velocityMatches(match, candidate) {
  if (match.kind && candidate.kind !== match.kind) return false;
  if (match.kinds && !match.kinds.includes(candidate.kind)) return false;
  if (match.permission_class && candidate.permission_class !== match.permission_class) return false;
  if (match.permission_classes && !match.permission_classes.includes(candidate.permission_class)) return false;
  return true;
}

function inWindow(event, now, windowMs) {
  return event.ts > now - windowMs && event.ts <= now;
}

export function createStatefulGuard(options = {}) {
  const {
    statePath,
    freezePath = null,
    recorder = null,
    now = () => Date.now(),
  } = options;
  if (!statePath) throw new Error("ghostguard-budgets: statePath is required");

  const policy = options.policy
    ? options.policy.source
      ? options.policy // already compiled (CompiledPolicy carries .source)
      : compilePolicy(options.policy)
    : (() => {
        throw new Error("ghostguard-budgets: a GhostGuard policy (doc or compiled) is required");
      })();

  const config = options.configPath
    ? loadConfigFile(options.configPath)
    : normalizeConfig(options.config ?? {});
  const warnings = [...config.warnings];

  function statefulCandidate(events, action, nowMs) {
    let candidate = null;
    const applied = [];
    const consider = (c) => {
      applied.push(c.rule_id);
      candidate = candidate === null ? c : stricterOf(candidate, c);
    };

    for (const budget of config.spendBudgets) {
      if (!budget.classes.includes(action.permission_class)) continue;
      const amount = action.payload?.[budget.amountField];
      if (typeof amount !== "number" || !Number.isFinite(amount)) {
        consider({
          verdict: "ask",
          rule_id: budget.id,
          reason: `spend amount missing or non-numeric (payload.${budget.amountField}); cannot verify against budget "${budget.id}" (limit ${budget.limit} per ${budget.windowMs}ms)`,
          handoff_to: null,
        });
        continue;
      }
      const used = events
        .filter((e) => inWindow(e, nowMs, budget.windowMs) && scopeMatches(budget.scope, e, action) && budget.classes.includes(e.permission_class))
        .reduce((sum, e) => sum + (typeof e.amount === "number" ? e.amount : 0), 0);
      if (used + amount > budget.limit) {
        consider({
          verdict: budget.onExceed,
          rule_id: budget.id,
          reason: `budget "${budget.id}" exceeded: ${used} already spent in window + ${amount} requested > limit ${budget.limit}`,
          handoff_to: budget.onExceed === "hand_off" ? "owner" : null,
        });
      }
    }

    for (const rule of config.velocityRules) {
      if (!velocityMatches(rule.match, action)) continue;
      const count = events.filter(
        (e) => inWindow(e, nowMs, rule.windowMs) && scopeMatches(rule.scope, e, action) && velocityMatches(rule.match, e),
      ).length;
      if (count >= rule.maxInWindow) {
        consider({
          verdict: rule.onExceed,
          rule_id: rule.id,
          reason: `velocity rule "${rule.id}": ${count} matching actions already in window (max ${rule.maxInWindow} per ${rule.windowMs}ms) — this would be #${count + 1}`,
          handoff_to: rule.onExceed === "hand_off" ? "owner" : null,
        });
      }
    }

    return { candidate, applied };
  }

  function decide(input) {
    const nowMs = now();
    const action = {
      kind: input.kind,
      permission_class: input.permission_class ?? null,
      actor: input.actor,
      project_id: input.project_id,
      approved: input.approved ?? false,
      initiator: input.initiator ?? "system",
      payload: input.payload ?? {},
    };
    const intent = {
      action_id: input.action_id ?? randomUUID(),
      kind: action.kind,
      permission_class: action.permission_class,
      actor: action.actor,
      initiator: action.initiator,
      project_id: action.project_id,
      action_payload: action.payload,
      target_ref: input.target_ref ?? null,
      snapshot_id: input.snapshot_id ?? null,
      target: input.target ?? null,
      dry_run: input.dry_run ?? false,
    };

    const finish = (decision, stateful) => {
      const record = gatewayRecordFromDecision(intent, decision);
      if (recorder) recorder(record); // throws → the caller does not execute. No record, no action.
      return { decision, record, stateful };
    };

    // 0 — state must load, or everything fails closed.
    let state;
    try {
      state = loadState(statePath);
    } catch (err) {
      if (!(err instanceof StateStoreError)) throw err;
      return finish(
        {
          verdict: "deny",
          rule_id: "state-store-unavailable",
          reason: `state store failure — failing closed: ${err.message}`,
          handoff_to: null,
        },
        { applied: ["state-store-unavailable"], frozen: readFreeze(freezePath).frozen },
      );
    }

    // 1 — kill switch, checked fresh per action.
    const freeze = readFreeze(freezePath);
    if (freeze.frozen && action.permission_class !== "READ") {
      return finish(
        {
          verdict: "deny",
          rule_id: "kill-switch-freeze",
          reason: `kill switch is engaged (frozen${freeze.detail?.frozen_at ? ` at ${freeze.detail.frozen_at}` : ""}${freeze.detail?.by ? ` by ${freeze.detail.by}` : ""}${freeze.detail?.reason ? `: ${freeze.detail.reason}` : ""}) — all consequential classes are denied until unfreeze`,
          handoff_to: null,
        },
        { applied: ["kill-switch-freeze"], frozen: true },
      );
    }

    // 2 — stateless GhostGuard policy.
    const stateless = evaluatePolicy(policy, action);

    // 3 — stateful rules; stricter-only combination.
    const { candidate, applied } = statefulCandidate(state.events, action, nowMs);
    let final = candidate ? stricterOf(stateless, candidate) : stateless;
    const statefulInfo = {
      applied,
      frozen: false,
      stateless_verdict: stateless.verdict,
      stateful_verdict: candidate?.verdict ?? null,
    };
    if (candidate && final === candidate) {
      final = { ...candidate };
      statefulInfo.decided_by = "stateful";
    } else {
      statefulInfo.decided_by = "stateless";
    }

    // 4 — count cleared actions; persist before returning.
    if (final.verdict === "allow" || final.verdict === "pre_approved") {
      const amountField = config.spendBudgets.find((b) => b.classes.includes(action.permission_class))?.amountField ?? "amount";
      const rawAmount = action.payload?.[amountField];
      state.events.push({
        ts: nowMs,
        actor: action.actor,
        project_id: action.project_id,
        kind: action.kind,
        permission_class: action.permission_class,
        amount: typeof rawAmount === "number" && Number.isFinite(rawAmount) ? rawAmount : null,
      });
      if (config.maxWindowMs > 0) {
        const cutoff = nowMs - config.maxWindowMs;
        state.events = state.events.filter((e) => e.ts > cutoff);
      }
      try {
        saveState(statePath, state);
      } catch (err) {
        if (!(err instanceof StateStoreError)) throw err;
        return finish(
          {
            verdict: "deny",
            rule_id: "state-store-unavailable",
            reason: `could not persist state — failing closed: ${err.message}`,
            handoff_to: null,
          },
          { ...statefulInfo, applied: [...applied, "state-store-unavailable"] },
        );
      }
    }

    return finish(final, statefulInfo);
  }

  function status(scope = {}) {
    const nowMs = now();
    let events = [];
    let stateError = null;
    try {
      events = loadState(statePath).events;
    } catch (err) {
      stateError = err.message;
    }
    const probe = { actor: scope.actor ?? null, project_id: scope.project_id ?? null };
    return {
      frozen: readFreeze(freezePath),
      state_error: stateError,
      events_in_state: events.length,
      spendBudgets: config.spendBudgets.map((b) => {
        const used = events
          .filter((e) => inWindow(e, nowMs, b.windowMs) && b.classes.includes(e.permission_class) && (scope.actor || scope.project_id ? scopeMatches(b.scope, e, probe) : true))
          .reduce((s, e) => s + (typeof e.amount === "number" ? e.amount : 0), 0);
        return { id: b.id, limit: b.limit, windowMs: b.windowMs, used, remaining: b.limit - used };
      }),
      velocityRules: config.velocityRules.map((r) => ({
        id: r.id,
        maxInWindow: r.maxInWindow,
        windowMs: r.windowMs,
        count: events.filter((e) => inWindow(e, nowMs, r.windowMs) && velocityMatches(r.match, e)).length,
      })),
    };
  }

  return { decide, status, warnings, config };
}
