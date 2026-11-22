#!/usr/bin/env node
/**
 * GhostGuard policy author — controlled English -> GhostGuard policy.
 *
 * Reads a plain-English rule file (one statement per line; blank
 * lines and lines starting with # are ignored) and compiles it to:
 *   1. a GhostGuard policy.json (PolicyDoc JSON), and
 *   2. a behavior test file (JSON cases) generated FROM THE SAME
 *      statements, so running the tests against the real engine
 *      proves the compiled policy does what the English said.
 *
 * The grammar is intentionally tiny (see GRAMMAR.md). Anything the
 * parser does not recognise is a LOUD error (exit 2, the offending
 * line named) — a statement is never silently dropped, because a
 * silently dropped safety rule fails OPEN.
 *
 * Usage:
 *   node author.mjs build <rules.en.txt> [--out <dir>]
 *   node author.mjs verify <rules.en.txt>   (build into a temp dir
 *                                            and run the tests)
 * Importable: compileEnglish(text) -> { policy, tests, statements }
 *             throws AuthorError on any unsupported line.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

export class AuthorError extends Error {}

/** Action phrases -> PermissionClass. Keys are normalised (lowercase). */
export const ACTION_PHRASES = new Map([
  ["spending", "SPEND"], ["spend", "SPEND"], ["purchases", "SPEND"], ["buying", "SPEND"],
  ["deleting", "DELETE"], ["delete", "DELETE"], ["deletions", "DELETE"],
  ["deploying", "DEPLOY"], ["deploys", "DEPLOY"], ["deployments", "DEPLOY"],
  ["publishing", "PUBLISH"], ["posting publicly", "PUBLISH"],
  ["network writes", "NETWORK_WRITE"], ["submitting forms", "NETWORK_WRITE"],
  ["executing commands", "EXECUTE"], ["running commands", "EXECUTE"],
  ["reading", "READ"], ["writing local files", "WRITE_LOCAL"], ["local writes", "WRITE_LOCAL"],
  ["sending messages", "COMMUNICATE"], ["messages", "COMMUNICATE"],
]);

const CLASS_LABEL = {
  READ: "reading", WRITE_LOCAL: "local writes", EXECUTE: "executing commands",
  NETWORK_WRITE: "network writes", DEPLOY: "deploying", PUBLISH: "publishing",
  COMMUNICATE: "sending messages", SPEND: "spending", DELETE: "deleting",
};

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Find the longest action phrase mentioned in a normalised sentence. */
function matchClass(sentence, lineNo, raw) {
  const hits = [...ACTION_PHRASES.keys()]
    .filter((p) => new RegExp(`\\b${p.replace(/ /g, "\\s+")}\\b`).test(sentence))
    .sort((a, b) => b.length - a.length);
  if (hits.length === 0) {
    throw new AuthorError(`line ${lineNo}: no known action phrase in "${raw}" — see GRAMMAR.md for the action vocabulary`);
  }
  return ACTION_PHRASES.get(hits[0]);
}

function baseContext(cls, extra = {}) {
  return {
    kind: `demo.${slug(CLASS_LABEL[cls])}`, permission_class: cls,
    actor: "demo-agent", initiator: "person", project_id: "policy-author-demo",
    approved: false, payload: {}, ...extra,
  };
}

/**
 * Parse one normalised sentence. Returns { rule, tests } or throws.
 * Every statement also contributes an "everything else still asks"
 * style expectation only where the grammar states it — the fail-
 * closed default is an engine property, tested separately.
 */
function parseStatement(sentence, lineNo, raw) {
  let m;

  // never allow <action> / never <action>
  if ((m = sentence.match(/^never (?:allow|permit) (.+)$/)) || (m = sentence.match(/^never (.+)$/))) {
    const cls = matchClass(sentence, lineNo, raw);
    const id = `never-${slug(CLASS_LABEL[cls])}`;
    return {
      rule: { id, effect: "deny", locked: true, when: `permission_class == '${cls}'`,
              note: `From English (line ${lineNo}): "${raw}" — locked, so overlays cannot weaken it.` },
      tests: [{ name: `${id}: ${CLASS_LABEL[cls]} denies`, context: baseContext(cls), expect_verdict: "deny", expect_rule_id: id }],
    };
  }

  // always ask before <action> / ask before <action>
  if (/^(always )?ask before .+$/.test(sentence)) {
    const cls = matchClass(sentence, lineNo, raw);
    const id = `ask-before-${slug(CLASS_LABEL[cls])}`;
    return {
      rule: { id, effect: "ask", when: `permission_class == '${cls}'`,
              note: `From English (line ${lineNo}): "${raw}"` },
      tests: [{ name: `${id}: ${CLASS_LABEL[cls]} asks`, context: baseContext(cls), expect_verdict: "ask", expect_rule_id: id }],
    };
  }

  // owner must approve messages to strangers
  if (/^owner must approve messages to strangers$/.test(sentence)) {
    const id = "owner-approves-stranger-messages";
    return {
      rule: { id, effect: "hand_off", handoff_to: "owner",
              when: "permission_class == 'COMMUNICATE' && payload.recipient_known == false",
              note: `From English (line ${lineNo}): "${raw}"` },
      tests: [
        { name: `${id}: stranger message hands off to owner`,
          context: baseContext("COMMUNICATE", { payload: { to: "someone@example.net", recipient_known: false } }),
          expect_verdict: "hand_off", expect_rule_id: id, expect_handoff_to: "owner" },
        { name: `${id}: known-recipient message is NOT handed off by this rule`,
          context: baseContext("COMMUNICATE", { payload: { to: "team@example.com", recipient_known: true } }),
          expect_not_rule_id: id },
      ],
    };
  }

  // <name> must approve <action>
  if ((m = sentence.match(/^([a-z][a-z0-9_-]*) must approve .+$/))) {
    const who = m[1];
    const cls = matchClass(sentence, lineNo, raw);
    const id = `${who}-approves-${slug(CLASS_LABEL[cls])}`;
    return {
      rule: { id, effect: "hand_off", handoff_to: who, when: `permission_class == '${cls}'`,
              note: `From English (line ${lineNo}): "${raw}"` },
      tests: [{ name: `${id}: ${CLASS_LABEL[cls]} hands off to ${who}`,
                context: baseContext(cls), expect_verdict: "hand_off", expect_rule_id: id, expect_handoff_to: who }],
    };
  }

  // routines must ask before <action>
  if (/^(routines|unattended runs) must ask before .+$/.test(sentence)) {
    const cls = matchClass(sentence, lineNo, raw);
    const id = `routines-ask-before-${slug(CLASS_LABEL[cls])}`;
    return {
      rule: { id, effect: "ask", when: `initiator == 'routine' && permission_class == '${cls}'`,
              note: `From English (line ${lineNo}): "${raw}"` },
      tests: [
        { name: `${id}: routine-initiated ${CLASS_LABEL[cls]} asks`,
          context: baseContext(cls, { initiator: "routine" }), expect_verdict: "ask", expect_rule_id: id },
        { name: `${id}: person-initiated ${CLASS_LABEL[cls]} is NOT asked by this rule`,
          context: baseContext(cls, { initiator: "person" }), expect_not_rule_id: id },
      ],
    };
  }

  // allow <action>
  if (/^allow .+$/.test(sentence)) {
    const cls = matchClass(sentence, lineNo, raw);
    const id = `allow-${slug(CLASS_LABEL[cls])}`;
    return {
      rule: { id, effect: "allow", when: `permission_class == '${cls}'`,
              note: `From English (line ${lineNo}): "${raw}"` },
      tests: [{ name: `${id}: ${CLASS_LABEL[cls]} allows`, context: baseContext(cls), expect_verdict: "allow", expect_rule_id: id }],
    };
  }

  // pre-approve <action> / <action> is pre-approved
  if (/^pre-approve .+$/.test(sentence) || /^.+ is pre-approved$/.test(sentence)) {
    const cls = matchClass(sentence, lineNo, raw);
    const id = `pre-approved-${slug(CLASS_LABEL[cls])}`;
    return {
      rule: { id, effect: "pre_approved", when: `permission_class == '${cls}'`,
              note: `From English (line ${lineNo}): "${raw}"` },
      tests: [{ name: `${id}: ${CLASS_LABEL[cls]} is pre_approved`, context: baseContext(cls), expect_verdict: "pre_approved", expect_rule_id: id }],
    };
  }

  throw new AuthorError(`line ${lineNo}: unsupported statement "${raw}" — see GRAMMAR.md for the supported forms`);
}

/**
 * Compile a controlled-English rule file. Throws AuthorError listing
 * the offending line on ANY unsupported statement.
 */
export function compileEnglish(text) {
  const rules = [];
  const tests = [];
  const statements = [];
  const seenIds = new Map();
  const lines = text.split("\n");
  lines.forEach((rawLine, i) => {
    const raw = rawLine.trim();
    if (raw === "" || raw.startsWith("#")) return;
    const lineNo = i + 1;
    const sentence = raw.toLowerCase().replace(/\s+/g, " ").replace(/[.?!]+$/, "");
    const { rule, tests: t } = parseStatement(sentence, lineNo, raw);
    if (seenIds.has(rule.id)) {
      throw new AuthorError(`line ${lineNo}: "${raw}" compiles to rule id "${rule.id}", already produced by line ${seenIds.get(rule.id)} — reword one of them`);
    }
    seenIds.set(rule.id, lineNo);
    rules.push(rule);
    tests.push(...t);
    statements.push({ line: lineNo, text: raw, rule_id: rule.id });
  });
  if (rules.length === 0) throw new AuthorError("no statements found — the file is empty or all comments");
  // Engine-property test, always generated: an action no statement
  // mentions must fail closed (deny, no rule), never slip through.
  tests.push({
    name: "fail-closed default: an unmentioned EXECUTE action denies with no rule",
    context: baseContext("EXECUTE", { kind: "demo.unmentioned" }),
    expect_verdict: "deny", expect_rule_id: null, only_when_unmentioned: "EXECUTE",
  });
  return { policy: { rules }, tests: { generated_from: "policy-author", cases: tests }, statements };
}

/** Drop the fail-closed test when another statement DOES cover that
 * class head-on (a pure `permission_class == 'X'` rule of any effect
 * would decide it instead of the no-match default). */
export function finaliseTests(compiled) {
  const covered = new Set(compiled.policy.rules.map((r) => {
    const m = r.when.match(/^permission_class == '([A-Z_]+)'$/);
    return m ? m[1] : null;
  }));
  compiled.tests.cases = compiled.tests.cases.filter(
    (t) => !(t.only_when_unmentioned && covered.has(t.only_when_unmentioned)),
  );
  return compiled;
}

function build(rulesFile, outDir) {
  const text = readFileSync(rulesFile, "utf8");
  const compiled = finaliseTests(compileEnglish(text));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "policy.json"), JSON.stringify(compiled.policy, null, 2) + "\n");
  writeFileSync(join(outDir, "behavior-tests.json"), JSON.stringify(compiled.tests, null, 2) + "\n");
  return compiled;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [cmd, rulesFile, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "build" && rulesFile) {
      const outIdx = rest.indexOf("--out");
      const outDir = outIdx >= 0 ? rest[outIdx + 1] : join(dirname(rulesFile), "out");
      const compiled = build(rulesFile, outDir);
      console.log(`policy-author: ${compiled.statements.length} statements -> ${compiled.policy.rules.length} rules, ${compiled.tests.cases.length} behavior tests`);
      console.log(`  wrote ${join(outDir, "policy.json")}`);
      console.log(`  wrote ${join(outDir, "behavior-tests.json")}`);
    } else if (cmd === "verify" && rulesFile) {
      const outDir = join(dirname(rulesFile), ".author-verify-tmp");
      build(rulesFile, outDir);
      const { spawnSync } = await import("node:child_process");
      const runner = join(dirname(fileURLToPath(import.meta.url)), "run-behavior-tests.mjs");
      const r = spawnSync(process.execPath, [runner, join(outDir, "policy.json"), join(outDir, "behavior-tests.json")], { stdio: "inherit" });
      process.exit(r.status ?? 1);
    } else {
      console.error("usage: node author.mjs build <rules.en.txt> [--out <dir>] | node author.mjs verify <rules.en.txt>");
      process.exit(2);
    }
  } catch (e) {
    if (e instanceof AuthorError) { console.error(`policy-author: ERROR — ${e.message}`); process.exit(2); }
    throw e;
  }
}
