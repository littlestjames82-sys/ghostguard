/**
 * ghostguard-reports test suite. Plain node, no framework.
 * Exercises: passport issue/verify/tamper, tier tightening against
 * the REAL ghostguard engine (imported from its dist — read-only),
 * trail loading/tallies/filters, incident-report content + secret
 * redaction, and the badge/summary redaction contract (asserting
 * ABSENCE of payload text and actor names).
 */

import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  compilePolicy,
  evaluatePolicy,
} from "ghostguard";
import {
  generateIssuerKeys,
  issuePassport,
  verifyPassport,
  tightenDecision,
  VERDICT_RANK,
  PERMISSION_CLASSES,
} from "../src/passport.mjs";
import {
  loadTrail,
  parseTrailText,
  filterRecords,
  tallyRecords,
  lockedRuleIds,
} from "../src/trail.mjs";
import { renderIncidentReport } from "../src/report.mjs";
import {
  summarizeTrail,
  renderBadgeSvg,
  renderSummaryHtml,
} from "../src/summary.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error("returned false");
    passed++;
    console.log("  ✓ " + name);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log("  ✗ " + name + " — " + err.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg ?? "not equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

/* ---------- passports: issue / verify / tamper ---------- */

const keys = generateIssuerKeys();
const otherKeys = generateIssuerKeys();
const baseFields = {
  agent_id: "fixture-agent-alpha",
  builder: "Fixture Builder (synthetic)",
  allowed_classes: ["READ", "WRITE_LOCAL", "EXECUTE", "NETWORK_WRITE", "SPEND"],
  trust_tier: "new",
  issued_at: "2026-10-10T12:00:00.000Z",
};
const doc = issuePassport(baseFields, keys.privateKeyPem);

check("issued passport verifies against the issuer public key", () => {
  const res = verifyPassport(doc, keys.publicKeyPem);
  assert(res.valid, "expected valid, errors: " + res.errors.join("; "));
});

const tamperCases = {
  "agent_id changed": (p) => (p.agent_id = "fixture-agent-beta"),
  "builder changed": (p) => (p.builder = "Mallory Fixture"),
  "class added to allowed_classes": (p) => p.allowed_classes.push("DELETE"),
  "trust_tier raised to trusted": (p) => (p.trust_tier = "trusted"),
  "issued_at changed": (p) => (p.issued_at = "2020-01-01T00:00:00.000Z"),
};
for (const [name, mutate] of Object.entries(tamperCases)) {
  check(`tampered passport rejected (${name})`, () => {
    const copy = JSON.parse(JSON.stringify(doc));
    mutate(copy.passport);
    assert(!verifyPassport(copy, keys.publicKeyPem).valid, "tampered passport verified!");
  });
}

check("passport rejected under a different issuer's key", () => {
  assert(!verifyPassport(doc, otherKeys.publicKeyPem).valid);
});

check("passport with flipped signature rejected", () => {
  const copy = JSON.parse(JSON.stringify(doc));
  copy.signature = Buffer.from("x".repeat(64)).toString("base64");
  assert(!verifyPassport(copy, keys.publicKeyPem).valid);
});

check("issuePassport refuses an unknown permission class", () => {
  let threw = false;
  try {
    issuePassport({ ...baseFields, allowed_classes: ["READ", "FLY"] }, keys.privateKeyPem);
  } catch {
    threw = true;
  }
  assert(threw, "issuing with an unknown class did not throw");
});

/* ---------- tier tightening against the real engine ---------- */

const allowAll = compilePolicy({ rules: [{ id: "allow-all", effect: "allow", when: "true" }] });
const fixturePolicy = compilePolicy(
  JSON.parse(readFileSync(join(root, "fixture", "policy.json"), "utf8")),
);
function engineDecision(policy, cls, initiator = "person") {
  const ctx = {
    kind: "test.action",
    permission_class: cls,
    actor: "fixture-agent-alpha",
    project_id: "fixture-project",
    approved: false,
    initiator,
    payload: {},
  };
  return { decision: evaluatePolicy(policy, ctx), ctx };
}
function passportFor(tier, classes = PERMISSION_CLASSES) {
  return issuePassport(
    { ...baseFields, trust_tier: tier, allowed_classes: classes },
    keys.privateKeyPem,
  ).passport;
}

check("engine allows NETWORK_WRITE; a 'new' passport escalates it to ask", () => {
  const { decision, ctx } = engineDecision(allowAll, "NETWORK_WRITE");
  assertEq(decision.verdict, "allow", "engine verdict");
  const tightened = tightenDecision(decision, ctx, passportFor("new"));
  assertEq(tightened.verdict, "ask", "tightened verdict");
  assertEq(tightened.rule_id, "passport:tier-gate");
});

check("an 'established' passport does NOT escalate NETWORK_WRITE (floor is SPEND)", () => {
  const { decision, ctx } = engineDecision(allowAll, "NETWORK_WRITE");
  assertEq(tightenDecision(decision, ctx, passportFor("established")).verdict, "allow");
});

check("an 'established' passport escalates SPEND to ask; 'trusted' leaves it", () => {
  const { decision, ctx } = engineDecision(allowAll, "SPEND");
  assertEq(tightenDecision(decision, ctx, passportFor("established")).verdict, "ask");
  assertEq(tightenDecision(decision, ctx, passportFor("trusted")).verdict, "allow");
});

check("a class outside the passport is denied even when the engine allows", () => {
  const { decision, ctx } = engineDecision(allowAll, "DELETE");
  const noDelete = passportFor("trusted", ["READ", "WRITE_LOCAL"]);
  const out = tightenDecision(decision, ctx, noDelete);
  assertEq(out.verdict, "deny");
  assertEq(out.rule_id, "passport:class-not-allowed");
});

check("an engine deny stays a deny under the passport gate (locked rule intact)", () => {
  const { decision, ctx } = engineDecision(fixturePolicy, "SPEND");
  assertEq(decision.verdict, "deny");
  assertEq(decision.rule_id, "no-spend-ever");
  const out = tightenDecision(decision, ctx, passportFor("trusted"));
  assertEq(out.verdict, "deny");
  assertEq(out.rule_id, "no-spend-ever");
});

check("no passport at all -> fail-closed deny", () => {
  const { decision, ctx } = engineDecision(allowAll, "READ");
  const out = tightenDecision(decision, ctx, null);
  assertEq(out.verdict, "deny");
  assertEq(out.rule_id, "passport:missing");
});

check("tightening NEVER loosens: verdict-rank sweep over tiers x verdicts x classes", () => {
  for (const tier of ["new", "established", "trusted"]) {
    const passport = passportFor(tier); // all classes allowed
    for (const verdict of Object.keys(VERDICT_RANK)) {
      for (const cls of PERMISSION_CLASSES) {
        const decision = {
          verdict,
          rule_id: "sweep-rule",
          reason: "sweep",
          handoff_to: verdict === "hand_off" ? "owner" : null,
        };
        const out = tightenDecision(decision, { permission_class: cls }, passport);
        assert(
          VERDICT_RANK[out.verdict] >= VERDICT_RANK[verdict],
          `${tier}/${verdict}/${cls} loosened to ${out.verdict}`,
        );
      }
    }
  }
});

/* ---------- trail loading, tallies, filters ---------- */

const trailPath = join(root, "fixture", "trail.jsonl");
const { records } = loadTrail(trailPath);
const policyDoc = JSON.parse(readFileSync(join(root, "fixture", "policy.json"), "utf8"));
const locked = lockedRuleIds(policyDoc);

check("fixture trail loads 9 records", () => assertEq(records.length, 9));

check("tallies match fixture counts", () => {
  const t = tallyRecords(records);
  assertEq(t.total, 9);
  assertEq(t.byVerdict.allow, 3);
  assertEq(t.byVerdict.pre_approved, 1);
  assertEq(t.byVerdict.ask, 3);
  assertEq(t.byVerdict.deny, 2);
  assertEq(t.byRule["no-spend-ever"], 1);
  assertEq(t.byRule["allow-the-rest"], 3);
});

check("actor filter keeps only that actor's records", () => {
  const out = filterRecords(records, { actors: ["fixture-agent-beta"] });
  assertEq(out.length, 3);
  assert(out.every((r) => r.actor === "fixture-agent-beta"));
});

check("time filter selects the in-range records by received_at", () => {
  const out = filterRecords(records, {
    from: "2026-10-10T12:03:00.000Z",
    to: "2026-10-10T12:05:00.000Z",
  });
  assertEq(out.map((r) => r.action_id).join(","), "fixture-04,fixture-05,fixture-06");
});

check("verdict filter selects denials", () => {
  assertEq(filterRecords(records, { verdicts: ["deny"] }).length, 2);
});

check("cloud-wrapped entries unwrap; decision entries are skipped", () => {
  const text =
    JSON.stringify({
      entry_type: "record",
      workspace: "fixture-ws",
      received_at: "2026-10-10T12:00:00.000Z",
      record: records[0],
    }) +
    "\n" +
    JSON.stringify({ entry_type: "decision", workspace: "fixture-ws", action_id: "x" }) +
    "\n";
  const parsed = parseTrailText(text);
  assertEq(parsed.records.length, 1);
  assertEq(parsed.records[0].received_at, "2026-10-10T12:00:00.000Z");
  assertEq(parsed.skippedDecisions, 1);
});

/* ---------- incident report ---------- */

const reportHtml = renderIncidentReport(records, {
  sourceName: "trail.jsonl",
  lockedRules: locked,
  totalBeforeFilter: records.length,
  generatedAt: "2026-10-10T13:00:00.000Z",
});
const fixtureSecret = records.find((r) => r.action_id === "fixture-03").action_payload.api_token;

check("report names the locked denial's deciding rule", () => {
  assert(reportHtml.includes("no-spend-ever"), "rule id missing");
  assert(reportHtml.includes("no-delete-ever"), "rule id missing");
});

check("report highlights locked-rule hits", () => {
  assert(reportHtml.includes("LOCKED RULE HIT"), "locked highlight missing");
  assert(reportHtml.includes("<strong>Locked-rule hits:</strong> 2"), "locked count wrong");
});

check("report redacts the fixture secret (raw value absent, type+length shown)", () => {
  assert(typeof fixtureSecret === "string" && fixtureSecret.length > 8, "fixture secret not found in trail");
  assert(!reportHtml.includes(fixtureSecret), "RAW FIXTURE SECRET LEAKED INTO REPORT");
  assert(
    reportHtml.includes(`[redacted: string, length ${fixtureSecret.length}]`),
    "redaction marker with type+length missing",
  );
});

check("report still shows non-secret payloads exactly (evidence, not a summary)", () => {
  assert(reportHtml.includes("fixture gift card"), "deny payload missing");
  assert(reportHtml.includes("Records in report: 9"), "record count missing");
});

check("report is one self-contained file (no external assets)", () => {
  assert(!/src=|href="http|<link/.test(reportHtml), "external asset reference found");
});

/* ---------- badge + public summary: redaction contract ---------- */

const summary = summarizeTrail(records, { lockedRules: locked });
const summaryJson = JSON.stringify(summary, null, 2);
const summaryHtml = renderSummaryHtml(summary);
const badgeSvg = renderBadgeSvg(summary);

check("summary tallies match fixture counts (incl. locked hits)", () => {
  assertEq(summary.total_actions_recorded, 9);
  assertEq(summary.by_verdict.deny, 2);
  assertEq(summary.by_verdict.ask, 3);
  assertEq(summary.locked_rule_hits, 2);
});

check("badge shows the recorded count", () => {
  assert(badgeSvg.includes("Guarded by GhostGuard"), "badge label missing");
  assert(badgeSvg.includes("9 actions recorded"), "badge count missing");
  assert(badgeSvg.startsWith("<svg"), "not an svg");
});

const FORBIDDEN_IN_PUBLIC = [
  "fixture-agent-alpha", // actor name
  "fixture-agent-beta", // actor name
  "fixture gift card", // payload text
  "hello fixture", // payload text
  "docs/guide.md", // payload text
  "fixture.invalid", // payload URL host
  "fixture-project", // project id
  "fixture-03", // action id
  fixtureSecret, // the secret itself
];
for (const surface of [
  ["summary JSON", summaryJson],
  ["summary HTML", summaryHtml],
  ["badge SVG", badgeSvg],
]) {
  check(`public ${surface[0]} contains NO payload text, actor names, or ids`, () => {
    for (const bad of FORBIDDEN_IN_PUBLIC) {
      assert(!surface[1].includes(bad), `leaked "${bad}" into ${surface[0]}`);
    }
  });
}

/* ---------- CLI end-to-end (temp dir) ---------- */

check("CLI: keygen -> issue -> verify-passport, then report + badge", () => {
  const dir = mkdtempSync(join(tmpdir(), "gg-reports-"));
  const cli = join(root, "src", "cli.mjs");
  execFileSync("node", [cli, "keygen", "--out", join(dir, "keys")]);
  execFileSync("node", [
    cli, "issue",
    "--key", join(dir, "keys", "passport-private.pem"),
    "--agent", "fixture-agent-alpha",
    "--builder", "Fixture Builder (synthetic)",
    "--classes", "READ,WRITE_LOCAL",
    "--tier", "new",
    "--out", join(dir, "passport.json"),
  ]);
  const out = execFileSync("node", [
    cli, "verify-passport",
    "--passport", join(dir, "passport.json"),
    "--pub", join(dir, "keys", "passport-public.pem"),
  ]).toString();
  assert(out.includes("VALID passport"), "CLI verify did not report VALID: " + out);
  execFileSync("node", [
    cli, "report", "--trail", trailPath,
    "--policy", join(root, "fixture", "policy.json"),
    "--out", join(dir, "incident.html"),
  ]);
  assert(existsSync(join(dir, "incident.html")), "CLI report not written");
  execFileSync("node", [
    cli, "badge", "--trail", trailPath,
    "--policy", join(root, "fixture", "policy.json"),
    "--out-dir", join(dir, "public"),
  ]);
  const s = JSON.parse(readFileSync(join(dir, "public", "summary.json"), "utf8"));
  assertEq(s.total_actions_recorded, 9);
  assert(existsSync(join(dir, "public", "badge.svg")), "badge.svg not written");
});

console.log(
  `\nghostguard-reports: ${passed} passed, ${failures.length} failed` +
    (failures.length ? "\n" + failures.map((f) => "  FAILED: " + f).join("\n") : ""),
);
process.exit(failures.length ? 1 : 0);
