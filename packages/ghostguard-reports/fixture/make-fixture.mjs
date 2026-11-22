/**
 * Generate fixture/trail.jsonl — a SYNTHETIC trail (no real data;
 * every name, host, and "secret" below is an invented fixture value,
 * labelled as such) produced the honest way: every record is a real
 * GhostGuard engine decision over fixture/policy.json, assembled by
 * gatewayRecordFromDecision and written by the engine's own JSONL
 * recorder (imported from the published ghostguard package).
 * A received_at stamp is added per line, mirroring the shape the
 * GhostGuard Cloud list endpoint returns.
 *
 * Run: npm run fixture
 */

import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compilePolicy,
  evaluatePolicy,
  gatewayRecordFromDecision,
  createJsonlRecorder,
} from "ghostguard";

const here = dirname(fileURLToPath(import.meta.url));
const policy = compilePolicy(JSON.parse(readFileSync(join(here, "policy.json"), "utf8")));
const trailPath = join(here, "trail.jsonl");
rmSync(trailPath, { force: true });
const record = createJsonlRecorder(trailPath);

// Synthetic fixture secret — invented for the redaction tests, NOT a
// real credential. The tests assert this exact string never appears
// in the rendered incident report.
export const FIXTURE_SECRET = "FIXTURE-SECRET-TOKEN-0000-SYNTHETIC";

const BASE_MS = Date.parse("2026-10-10T12:00:00.000Z");

const cases = [
  { kind: "web.fetch", permission_class: "READ", actor: "fixture-agent-alpha", initiator: "person",
    action_payload: { url: "https://fixture.invalid/page" } },
  { kind: "fs.write", permission_class: "WRITE_LOCAL", actor: "fixture-agent-alpha", initiator: "person",
    action_payload: { path: "docs/guide.md", bytes: 128 } },
  { kind: "deploy.run", permission_class: "DEPLOY", actor: "fixture-agent-beta", initiator: "routine",
    action_payload: { target: "fixture-prod", api_token: FIXTURE_SECRET } },
  { kind: "pay.purchase", permission_class: "SPEND", actor: "fixture-agent-alpha", initiator: "person",
    action_payload: { amount: 25, item: "fixture gift card" } },
  { kind: "fs.delete", permission_class: "DELETE", actor: "fixture-agent-alpha", initiator: "person",
    action_payload: { path: "fixture.tmp" } },
  { kind: "comms.send", permission_class: "COMMUNICATE", actor: "fixture-agent-beta", initiator: "person",
    action_payload: { to: "fixture@example.invalid", text: "hello fixture" } },
  { kind: "web.submit", permission_class: "NETWORK_WRITE", actor: "fixture-agent-beta", initiator: "person",
    action_payload: { form: "fixture-form" } },
  { kind: "web.fetch", permission_class: "READ", actor: "fixture-agent-alpha", initiator: "routine",
    action_payload: { url: "https://fixture.invalid/status" } },
  { kind: "shell.exec", permission_class: "EXECUTE", actor: "fixture-agent-alpha", initiator: "person",
    action_payload: { command: "echo fixture" } },
];

cases.forEach((c, i) => {
  const intent = {
    action_id: `fixture-${String(i + 1).padStart(2, "0")}`,
    kind: c.kind,
    permission_class: c.permission_class,
    actor: c.actor,
    initiator: c.initiator,
    project_id: "fixture-project",
    action_payload: c.action_payload,
  };
  const decision = evaluatePolicy(policy, {
    kind: c.kind,
    permission_class: c.permission_class,
    actor: c.actor,
    project_id: "fixture-project",
    approved: false,
    initiator: c.initiator,
    payload: c.action_payload,
  });
  record(gatewayRecordFromDecision(intent, decision));
});

// Add a received_at stamp per line (the shape the Cloud list
// endpoint returns), preserving the recorder's line order/content.
const stamped = readFileSync(trailPath, "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((line, i) => ({
    ...JSON.parse(line),
    received_at: new Date(BASE_MS + i * 60_000).toISOString(),
  }));
writeFileSync(trailPath, stamped.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
console.log(`fixture trail written: ${stamped.length} records -> ${trailPath}`);
console.log("verdicts:", stamped.map((r) => `${r.action_id}:${r.verdict}/${r.rule_id}`).join(" "));
