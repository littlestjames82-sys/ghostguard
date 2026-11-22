/**
 * Config loading + normalisation for ghostguard-budgets.
 *
 * The config is data, not code: spend budgets and velocity rules with
 * rolling windows. Normalisation is deliberately fail-closed:
 *  - an `onExceed` outside {ask, hand_off, deny} is CLAMPED to "deny"
 *    and reported in `warnings` — a stateful rule can never be
 *    configured to loosen anything, not even by accident;
 *  - a rule with an unusable window or limit throws at load time
 *    (fail loud at startup, before any action runs), never silently
 *    mid-run.
 */
import { readFileSync } from "node:fs";

const VALID_ON_EXCEED = new Set(["ask", "hand_off", "deny"]);
const VALID_SCOPES = new Set(["actor", "project", "actor_project", "global"]);

export function parseDuration(value, field) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
    if (m) {
      const mult = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
      return Number(m[1]) * mult;
    }
  }
  throw new Error(`ghostguard-budgets: ${field} is not a usable duration: ${JSON.stringify(value)}`);
}

function windowOf(rule, field) {
  if (rule.windowMs !== undefined) return parseDuration(rule.windowMs, field);
  if (rule.window !== undefined) return parseDuration(rule.window, field);
  if (rule.windowSeconds !== undefined) return Number(rule.windowSeconds) * 1_000;
  if (rule.windowMinutes !== undefined) return Number(rule.windowMinutes) * 60_000;
  if (rule.windowHours !== undefined) return Number(rule.windowHours) * 3_600_000;
  if (rule.windowDays !== undefined) return Number(rule.windowDays) * 86_400_000;
  throw new Error(`ghostguard-budgets: ${field} has no window (window / windowMs / windowHours / ...)`);
}

function onExceedOf(rule, warnings) {
  const v = rule.onExceed ?? "deny";
  if (VALID_ON_EXCEED.has(v)) return v;
  warnings.push(
    `rule "${rule.id}": onExceed ${JSON.stringify(v)} is not ask/hand_off/deny — clamped to "deny" (stateful rules only ever tighten)`,
  );
  return "deny";
}

function scopeOf(rule, warnings) {
  const v = rule.scope ?? "actor_project";
  if (VALID_SCOPES.has(v)) return v;
  warnings.push(`rule "${rule.id}": unknown scope ${JSON.stringify(v)} — clamped to "actor_project"`);
  return "actor_project";
}

export function normalizeConfig(raw = {}) {
  const warnings = [];
  const spendBudgets = (raw.spendBudgets ?? []).map((r) => {
    if (!r.id) throw new Error("ghostguard-budgets: every spend budget needs an id");
    const limit = Number(r.limit);
    if (!Number.isFinite(limit)) throw new Error(`ghostguard-budgets: budget "${r.id}" limit is not a number`);
    if (limit < 0) warnings.push(`budget "${r.id}": negative limit ${limit} — every spend will exceed it (fail-closed)`);
    return {
      id: String(r.id),
      scope: scopeOf(r, warnings),
      windowMs: windowOf(r, `budget "${r.id}"`),
      limit,
      amountField: r.amountField ?? "amount",
      classes: r.classes ?? ["SPEND"],
      onExceed: onExceedOf(r, warnings),
    };
  });
  const velocityRules = (raw.velocityRules ?? []).map((r) => {
    if (!r.id) throw new Error("ghostguard-budgets: every velocity rule needs an id");
    let maxInWindow = Number(r.maxInWindow ?? r.limit);
    if (!Number.isFinite(maxInWindow)) throw new Error(`ghostguard-budgets: velocity rule "${r.id}" maxInWindow is not a number`);
    if (maxInWindow < 0) {
      warnings.push(`velocity rule "${r.id}": negative maxInWindow ${maxInWindow} — clamped to 0`);
      maxInWindow = 0;
    }
    const match = r.match ?? {};
    return {
      id: String(r.id),
      scope: scopeOf(r, warnings),
      windowMs: windowOf(r, `velocity rule "${r.id}"`),
      maxInWindow,
      match: {
        kind: match.kind ?? null,
        kinds: match.kinds ?? null,
        permission_class: match.permission_class ?? match.class ?? null,
        permission_classes: match.permission_classes ?? match.classes ?? null,
      },
      onExceed: onExceedOf(r, warnings),
    };
  });
  const maxWindowMs = Math.max(0, ...spendBudgets.map((b) => b.windowMs), ...velocityRules.map((v) => v.windowMs));
  return { spendBudgets, velocityRules, maxWindowMs, warnings };
}

export function loadConfigFile(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return normalizeConfig(raw);
}
