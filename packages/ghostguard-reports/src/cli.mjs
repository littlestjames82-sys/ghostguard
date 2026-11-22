#!/usr/bin/env node
/**
 * ghostguard-reports CLI — one toolset, five surfaces:
 *
 *   keygen          generate an Ed25519 passport-issuer keypair
 *   issue           sign an agent passport
 *   verify-passport check a passport against the issuer public key
 *   report          trail JSONL -> self-contained incident report HTML
 *   badge           trail JSONL -> badge SVG + redacted summary JSON/HTML
 *   demo            end-to-end synthetic demo of all of the above
 *
 * Nothing here talks to a network. Passport private keys are written
 * mode 0600 and belong in keys/ (gitignored).
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateIssuerKeys,
  issuePassport,
  verifyPassport,
} from "./passport.mjs";
import { loadTrail, filterRecords, lockedRuleIds } from "./trail.mjs";
import { renderIncidentReport } from "./report.mjs";
import { summarizeTrail, renderBadgeSvg, renderSummaryHtml } from "./summary.mjs";

function arg(args, name, fallback = undefined) {
  const i = args.indexOf("--" + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
function fail(msg) {
  console.error("error: " + msg);
  process.exit(1);
}
function writeOut(path, content, mode) {
  mkdirSync(dirname(path) || ".", { recursive: true });
  writeFileSync(path, content, "utf8");
  if (mode) chmodSync(path, mode);
  console.log(`wrote ${path}`);
}
function readPolicy(args) {
  const p = arg(args, "policy");
  if (!p) return new Set();
  return lockedRuleIds(JSON.parse(readFileSync(p, "utf8")));
}
function filtersFrom(args) {
  const filters = {};
  const actor = arg(args, "actor");
  if (actor) filters.actors = actor.split(",").map((s) => s.trim()).filter(Boolean);
  const verdict = arg(args, "verdict");
  if (verdict) filters.verdicts = verdict.split(",").map((s) => s.trim()).filter(Boolean);
  const project = arg(args, "project");
  if (project) filters.projectId = project;
  const from = arg(args, "from");
  if (from) filters.from = from;
  const to = arg(args, "to");
  if (to) filters.to = to;
  return filters;
}
function describeFilters(f) {
  const bits = [];
  if (f.actors) bits.push(`actor in [${f.actors.join(", ")}]`);
  if (f.verdicts) bits.push(`verdict in [${f.verdicts.join(", ")}]`);
  if (f.projectId) bits.push(`project = ${f.projectId}`);
  if (f.from) bits.push(`from ${f.from}`);
  if (f.to) bits.push(`to ${f.to}`);
  return bits.join("; ");
}

const [cmd, ...args] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));

switch (cmd) {
  case "keygen": {
    const outDir = arg(args, "out", "keys");
    const { publicKeyPem, privateKeyPem } = generateIssuerKeys();
    writeOut(join(outDir, "passport-private.pem"), privateKeyPem, 0o600);
    writeOut(join(outDir, "passport-public.pem"), publicKeyPem);
    console.log("Keep passport-private.pem secret — it can mint passports.");
    break;
  }
  case "issue": {
    const keyPath = arg(args, "key") ?? fail("--key <issuer private key PEM> required");
    const agent = arg(args, "agent") ?? fail("--agent <agent_id> required");
    const builder = arg(args, "builder") ?? fail("--builder <builder name> required");
    const classes = (arg(args, "classes", "READ") ?? "READ").split(",").map((s) => s.trim());
    const tier = arg(args, "tier", "new");
    const out = arg(args, "out", "passport.json");
    const doc = issuePassport(
      { agent_id: agent, builder, allowed_classes: classes, trust_tier: tier },
      readFileSync(keyPath, "utf8"),
    );
    writeOut(out, JSON.stringify(doc, null, 2) + "\n");
    break;
  }
  case "verify-passport": {
    const docPath = arg(args, "passport") ?? fail("--passport <file> required");
    const pubPath = arg(args, "pub") ?? fail("--pub <issuer public key PEM> required");
    const doc = JSON.parse(readFileSync(docPath, "utf8"));
    const res = verifyPassport(doc, readFileSync(pubPath, "utf8"));
    if (res.valid) {
      console.log(`VALID passport for agent "${doc.passport.agent_id}" (tier ${doc.passport.trust_tier})`);
    } else {
      console.log("INVALID passport: " + res.errors.join("; "));
      process.exit(2);
    }
    break;
  }
  case "report": {
    const trailPath = arg(args, "trail") ?? fail("--trail <JSONL> required");
    const out = arg(args, "out", "incident-report.html");
    const { records } = loadTrail(trailPath);
    const filters = filtersFrom(args);
    const filtered = filterRecords(records, filters);
    const html = renderIncidentReport(filtered, {
      sourceName: basename(trailPath),
      filtersDescription: describeFilters(filters) || undefined,
      lockedRules: readPolicy(args),
      totalBeforeFilter: records.length,
      generatedAt: new Date().toISOString(),
    });
    writeOut(out, html);
    console.log(`report covers ${filtered.length} of ${records.length} records`);
    break;
  }
  case "badge": {
    const trailPath = arg(args, "trail") ?? fail("--trail <JSONL> required");
    const outDir = arg(args, "out-dir", "out");
    const { records } = loadTrail(trailPath);
    const summary = summarizeTrail(records, { lockedRules: readPolicy(args) });
    writeOut(join(outDir, "badge.svg"), renderBadgeSvg(summary));
    writeOut(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    writeOut(join(outDir, "summary.html"), renderSummaryHtml(summary));
    console.log(`summary: ${summary.total_actions_recorded} actions recorded (tallies only — no payloads, no actor names)`);
    break;
  }
  case "demo": {
    const root = join(here, "..");
    const outDir = arg(args, "out-dir", join(root, "out"));
    const { publicKeyPem, privateKeyPem } = generateIssuerKeys();
    writeOut(join(outDir, "demo-private.pem"), privateKeyPem, 0o600);
    writeOut(join(outDir, "demo-public.pem"), publicKeyPem);
    const doc = issuePassport(
      {
        agent_id: "fixture-agent-alpha",
        builder: "Fixture Builder (synthetic)",
        allowed_classes: ["READ", "WRITE_LOCAL", "EXECUTE"],
        trust_tier: "new",
      },
      privateKeyPem,
    );
    writeOut(join(outDir, "demo-passport.json"), JSON.stringify(doc, null, 2) + "\n");
    console.log("demo passport verifies:", verifyPassport(doc, publicKeyPem).valid);
    const trailPath = join(root, "fixture", "trail.jsonl");
    const policyPath = join(root, "fixture", "policy.json");
    const { records } = loadTrail(trailPath);
    const locked = lockedRuleIds(JSON.parse(readFileSync(policyPath, "utf8")));
    writeOut(
      join(outDir, "incident-report.html"),
      renderIncidentReport(records, {
        sourceName: "fixture/trail.jsonl (synthetic)",
        lockedRules: locked,
        totalBeforeFilter: records.length,
        generatedAt: new Date().toISOString(),
      }),
    );
    const summary = summarizeTrail(records, { lockedRules: locked });
    writeOut(join(outDir, "badge.svg"), renderBadgeSvg(summary));
    writeOut(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    writeOut(join(outDir, "summary.html"), renderSummaryHtml(summary));
    console.log("demo complete — all inputs synthetic, all outputs local.");
    break;
  }
  default:
    console.log(
      "usage: node src/cli.mjs <keygen|issue|verify-passport|report|badge|demo> [options]\n" +
        "  keygen --out keys/\n" +
        "  issue --key keys/passport-private.pem --agent <id> --builder <name> --classes READ,WRITE_LOCAL --tier new --out passport.json\n" +
        "  verify-passport --passport passport.json --pub keys/passport-public.pem\n" +
        "  report --trail trail.jsonl [--policy policy.json] [--actor a,b] [--verdict deny,ask] [--project p] [--from ISO] [--to ISO] --out incident.html\n" +
        "  badge --trail trail.jsonl [--policy policy.json] --out-dir out/\n" +
        "  demo [--out-dir out/]",
    );
    process.exit(cmd ? 1 : 0);
}
