#!/usr/bin/env node
/**
 * Secrets Broker demo — fake secrets, fake HTTP executor, real
 * GhostGuard engine + JSONL recorder.
 *
 * Prints the audit records and the executor's hash log. Neither can
 * contain a secret value: the records carry name/type/length only,
 * and the executor logs SHA-256 hashes only. (Deliberately: there is
 * nothing in this file that CAN print a value.)
 *
 * Run: npm run demo
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { createJsonlRecorder } from "ghostguard";
import { createSecretsBroker } from "../src/broker.mjs";
import { createMapSecretSource } from "../src/sources.mjs";
import { createFakeHttpExecutor } from "../src/fake-http-executor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const policyDoc = JSON.parse(readFileSync(join(here, "..", "policy.example.json"), "utf8"));

const work = mkdtempSync(join(tmpdir(), "ghostguard-secrets-demo-"));
const auditPath = join(work, "audit.jsonl");

const source = createMapSecretSource({
  example_api_key: { type: "api_key", value: "FAKE-TEST-KEY-123" },
  example_email_token: { type: "api_token", value: "FAKE-TEST-TOKEN-456" },
});
const broker = createSecretsBroker({
  policy: policyDoc,
  recorder: createJsonlRecorder(auditPath),
  secretSource: source,
});
const executor = createFakeHttpExecutor();
const base = { actor: "demo-agent", project_id: "secrets-demo", initiator: "person" };

async function show(label, action) {
  const result = await broker.execute(action, executor);
  console.log(`\n${label}`);
  console.log(`  status=${result.status} verdict=${result.verdict} rule=${result.rule_id}`);
  if (result.error) console.log(`  error[${result.error.code}]: ${result.error.message}`);
  return result;
}

await show("1) HTTP call with an API-key ref (allow → injected at execution)", {
  ...base,
  action_id: "demo-1",
  kind: "http.call",
  permission_class: "NETWORK_WRITE",
  payload: { method: "POST", url: "https://api.example.test/charge" },
  secret_refs: [{ name: "example_api_key", type: "api_key", slot: "authorization" }],
});

await show("2) File delete with a key ref (locked deny → secret never resolved)", {
  ...base,
  action_id: "demo-2",
  kind: "file.delete",
  permission_class: "DELETE",
  payload: { path: "docs/old.md" },
  secret_refs: [{ name: "example_api_key", type: "api_key", slot: "authorization" }],
});

await show("3) Email send, no approval (ask → blocked, secret never resolved)", {
  ...base,
  action_id: "demo-3",
  kind: "email.send",
  permission_class: "COMMUNICATE",
  payload: { to: "client@example.test", subject: "Report" },
  secret_refs: [{ name: "example_email_token", type: "api_token", slot: "authorization" }],
});

await show("4) Same email send WITH a carried approval (executes)", {
  ...base,
  action_id: "demo-4",
  kind: "email.send",
  permission_class: "COMMUNICATE",
  approved: true,
  payload: { to: "client@example.test", subject: "Report" },
  secret_refs: [{ name: "example_email_token", type: "api_token", slot: "authorization" }],
});

console.log(`\nSecret source value reads total: ${source.stats.valueReads} (only the two executed actions)`);
console.log("\nExecutor private log (hashes + lengths only — proof of injection):");
for (const entry of executor.log) console.log(" ", JSON.stringify(entry));
console.log("\nAudit trail (JSONL — names, types, lengths; never values):");
process.stdout.write(readFileSync(auditPath, "utf8"));
