#!/usr/bin/env node
/**
 * GhostGuard Secrets Broker — behavior tests.
 *
 * Fixture secrets are OBVIOUSLY FAKE values, defined once below and
 * used only as in-memory fixture data. No test output, assertion
 * message, or log line ever prints them: assertions check hashes,
 * lengths, counters, and substring ABSENCE only.
 *
 * Proves:
 *  (a) an allowed action executes with the secret injected at
 *      execution; the JSONL audit trail contains NO raw secret but
 *      records name + type + length;
 *  (b) a denied action, and an ask without a carried approval, never
 *      resolve the secret — the source's value-read counter stays
 *      at zero for those calls;
 *  (c) ask + carried approval executes (the policy itself allows
 *      once `approved` is carried; the broker never overrides it);
 *  (d) a missing secret ref fails closed — nothing executes;
 *  (e) the secret value never appears in any error message or
 *      agent-facing result on failure paths, even when the executor
 *      itself leaks it (broker scrubbing);
 *  plus: recorder failure blocks execution, file/env sources work,
 *  and a smuggled inline `value` in a ref is dropped, never used.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createJsonlRecorder, readGatewayRecords } from "ghostguard";
import { createSecretsBroker } from "../src/broker.mjs";
import {
  createMapSecretSource,
  createEnvSecretSource,
  createFileSecretSource,
} from "../src/sources.mjs";
import { createFakeHttpExecutor } from "../src/fake-http-executor.mjs";
import { sha256Hex } from "../src/hash.mjs";

// --- Fixtures (fake values; never printed) -------------------------
const FAKE_KEY = "FAKE-TEST-KEY-123"; // example_api_key
const FAKE_TOKEN = "FAKE-TEST-TOKEN-456"; // example_email_token
const FAKE_FILE_KEY = "FAKE-FILE-KEY-789"; // file source
const FAKE_ENV_KEY = "FAKE-ENV-KEY-000"; // env source
const ALL_FAKES = [FAKE_KEY, FAKE_TOKEN, FAKE_FILE_KEY, FAKE_ENV_KEY];

const here = dirname(fileURLToPath(import.meta.url));
const policyDoc = JSON.parse(readFileSync(join(here, "..", "policy.example.json"), "utf8"));

let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}
function containsNoFake(text) {
  return !ALL_FAKES.some((v) => String(text).includes(v));
}

const work = mkdtempSync(join(tmpdir(), "ghostguard-secrets-test-"));
const auditPath = join(work, "audit.jsonl");

const source = createMapSecretSource({
  example_api_key: { type: "api_key", value: FAKE_KEY },
  example_email_token: { type: "api_token", value: FAKE_TOKEN },
});
const broker = createSecretsBroker({
  policy: policyDoc,
  recorder: createJsonlRecorder(auditPath),
  secretSource: source,
});
const executor = createFakeHttpExecutor();
const base = { actor: "demo-agent", project_id: "secrets-demo", initiator: "person" };

// --- (a) allowed action: injection at execution, clean trail -------
const httpAction = {
  ...base,
  action_id: "a1",
  kind: "http.call",
  permission_class: "NETWORK_WRITE",
  payload: { method: "POST", url: "https://api.example.test/charge" },
  secret_refs: [{ name: "example_api_key", type: "api_key", slot: "authorization" }],
};
const a = await broker.execute(httpAction, executor);
check("(a) allowed action executes", a.status === "executed" && a.verdict === "allow");
check(
  "(a) executor received the right secret (hash proof, hash only)",
  executor.log.length === 1 && executor.log[0].secret_hashes.authorization === sha256Hex(FAKE_KEY),
);
check("(a) secret was resolved exactly once", source.stats.valueReads === 1);
check(
  "(a) agent-facing result contains no raw secret",
  containsNoFake(JSON.stringify(a)),
);
check(
  "(a) agent's action object was not mutated to carry the secret",
  !("secrets" in httpAction) && containsNoFake(JSON.stringify(httpAction)),
);
const auditTextA = readFileSync(auditPath, "utf8");
check("(a) audit JSONL contains no raw secret", containsNoFake(auditTextA));
const recA = readGatewayRecords(auditPath)[0];
const descA = recA.action_payload.secret_refs[0];
check(
  "(a) audit record shows name + type + length, resolved=true",
  descA.name === "example_api_key" &&
    descA.type === "api_key" &&
    descA.length === FAKE_KEY.length &&
    descA.resolved === true,
);

// --- (b) denied + ask-without-approval: zero secret reads ---------
const readsBefore = source.stats.valueReads;
const denyAction = {
  ...base,
  action_id: "a2",
  kind: "file.delete",
  permission_class: "DELETE",
  payload: { path: "docs/old.md" },
  secret_refs: [{ name: "example_api_key", type: "api_key", slot: "authorization" }],
};
const b1 = await broker.execute(denyAction, executor);
check(
  "(b) DELETE is denied by the locked rule and blocked",
  b1.status === "blocked" && b1.verdict === "deny" && b1.rule_id === "no-delete-ever",
);
const askAction = {
  ...base,
  action_id: "a3",
  kind: "email.send",
  permission_class: "COMMUNICATE",
  payload: { to: "client@example.test", subject: "Report" },
  secret_refs: [{ name: "example_email_token", type: "api_token", slot: "authorization" }],
};
const b2 = await broker.execute(askAction, executor);
check(
  "(b) COMMUNICATE without approval asks and blocks",
  b2.status === "blocked" && b2.verdict === "ask" && b2.rule_id === "comms-ask-unapproved",
);
check(
  "(b) deny + ask caused ZERO secret resolutions",
  source.stats.valueReads === readsBefore,
);
check("(b) executor never ran for deny/ask", executor.log.length === 1);
const recsB = readGatewayRecords(auditPath);
check(
  "(b) refusals are recorded, with secret length still unknown (null)",
  recsB.length === 3 &&
    recsB[1].verdict === "deny" &&
    recsB[2].verdict === "ask" &&
    recsB[1].action_payload.secret_refs[0].length === null &&
    recsB[2].action_payload.secret_refs[0].length === null,
);

// --- (c) ask + carried approval executes ---------------------------
const c = await broker.execute({ ...askAction, action_id: "a4", approved: true }, executor);
check(
  "(c) ask + carried approval executes",
  c.status === "executed" && executor.log.length === 2,
);
check(
  "(c) the carried approval is what the policy decided on (verdict allow, approval recorded)",
  c.verdict === "allow" && c.record.action_payload.approval_carried === true,
);
check(
  "(c) executor received the token secret (hash proof)",
  executor.log[1].secret_hashes.authorization === sha256Hex(FAKE_TOKEN),
);

// --- (d) missing secret ref fails closed ---------------------------
const d = await broker.execute(
  {
    ...base,
    action_id: "a5",
    kind: "http.call",
    permission_class: "NETWORK_WRITE",
    payload: { method: "GET", url: "https://api.example.test/x" },
    secret_refs: [{ name: "missing_key", type: "api_key", slot: "authorization" }],
  },
  executor,
);
check(
  "(d) missing secret ref fails closed, nothing executes",
  d.status === "failed_closed" && d.error?.code === "secret_not_found" && executor.log.length === 2,
);
check(
  "(d) the failed resolution is on the record, not hidden",
  typeof d.record.action_payload.broker_resolution === "string" &&
    d.record.action_payload.broker_resolution.startsWith("failed"),
);

// --- (e) failure paths never leak the value ------------------------
const errorTexts = [d.error?.message ?? ""];
// (e1) a leaky executor that throws an error embedding the secret
const leakyBroker = createSecretsBroker({
  policy: policyDoc,
  recorder: createJsonlRecorder(join(work, "audit-leaky.jsonl")),
  secretSource: createMapSecretSource({
    example_api_key: { type: "api_key", value: FAKE_KEY },
  }),
});
const e1 = await leakyBroker.execute(
  httpAction,
  async (execution) => {
    throw new Error(`upstream 401, key was ${execution.secrets.authorization}`);
  },
);
errorTexts.push(e1.error?.message ?? "");
check(
  "(e) leaky executor error is scrubbed by the broker",
  e1.status === "failed_closed" &&
    containsNoFake(e1.error?.message ?? "") &&
    (e1.error?.message ?? "").includes("[redacted]"),
);
// (e2) an executor that echoes the secret in its RESULT
const e2 = await leakyBroker.execute(httpAction, async (execution) => ({
  ok: true,
  echo: execution.secrets.authorization,
}));
check(
  "(e) leaky executor result is scrubbed before returning agent-side",
  e2.status === "executed" &&
    e2.executor_result.echo === "[redacted]" &&
    containsNoFake(JSON.stringify(e2)),
);
// (e3) a throwing secret source
const throwingBroker = createSecretsBroker({
  policy: policyDoc,
  recorder: createJsonlRecorder(join(work, "audit-throwing.jsonl")),
  secretSource: {
    resolve() {
      throw new Error("secret backend exploded");
    },
  },
});
const e3 = await throwingBroker.execute(httpAction, executor);
errorTexts.push(e3.error?.message ?? "");
check(
  "(e) throwing source fails closed with a clean error",
  e3.status === "failed_closed" && e3.error?.code === "secret_source_error",
);
check(
  "(e) NO error message on any failure path contains a secret value",
  errorTexts.every(containsNoFake),
);

// --- recorder failure: record-first means no execution -------------
let recorderExecRuns = 0;
const recorderBroker = createSecretsBroker({
  policy: policyDoc,
  recorder: () => {
    throw new Error("disk full");
  },
  secretSource: createMapSecretSource({
    example_api_key: { type: "api_key", value: FAKE_KEY },
  }),
});
const rf = await recorderBroker.execute(httpAction, async () => {
  recorderExecRuns += 1;
  return { ok: true };
});
check(
  "recorder failure blocks execution (record-first contract)",
  rf.status === "failed_closed" && rf.error?.code === "recorder_failed" && recorderExecRuns === 0,
);

// --- smuggled inline value in a ref is dropped, never used ---------
const smuggleSource = createMapSecretSource({
  example_api_key: { type: "api_key", value: FAKE_KEY },
});
const smuggleBroker = createSecretsBroker({
  policy: policyDoc,
  recorder: createJsonlRecorder(join(work, "audit-smuggle.jsonl")),
  secretSource: smuggleSource,
});
const smuggleExecutor = createFakeHttpExecutor();
const sm = await smuggleBroker.execute(
  {
    ...httpAction,
    action_id: "a6",
    secret_refs: [
      { name: "example_api_key", type: "api_key", slot: "authorization", value: "SMUGGLED-NOT-REAL" },
    ],
  },
  smuggleExecutor,
);
check(
  "smuggled inline ref value is ignored; the source value is what executes (hash proof)",
  sm.status === "executed" &&
    smuggleExecutor.log[0].secret_hashes.authorization === sha256Hex(FAKE_KEY) &&
    !JSON.stringify(sm.record).includes("SMUGGLED-NOT-REAL"),
);

// --- file source (JSON file outside the audit path) ----------------
const secretsFile = join(work, "secrets.json");
writeFileSync(
  secretsFile,
  JSON.stringify({ file_key: { type: "api_key", value: FAKE_FILE_KEY } }),
);
const fileSource = createFileSecretSource(secretsFile);
const fileBroker = createSecretsBroker({
  policy: policyDoc,
  recorder: createJsonlRecorder(join(work, "audit-file.jsonl")),
  secretSource: fileSource,
});
const fileExecutor = createFakeHttpExecutor();
const f = await fileBroker.execute(
  {
    ...base,
    action_id: "a7",
    kind: "tool.run",
    permission_class: "EXECUTE",
    payload: { tool: "deploy-preview" },
    secret_refs: [{ name: "file_key", type: "api_key", slot: "authorization" }],
  },
  fileExecutor,
);
check(
  "file source: allowed action executes, one value read, hash proof",
  f.status === "executed" &&
    fileSource.stats.valueReads === 1 &&
    fileExecutor.log[0].secret_hashes.authorization === sha256Hex(FAKE_FILE_KEY),
);
check(
  "file source: its audit trail contains no raw secret",
  containsNoFake(readFileSync(join(work, "audit-file.jsonl"), "utf8")),
);

// --- env source (fake env object; real process env untouched) ------
const envSource = createEnvSecretSource({ EXAMPLE_ENV_KEY: FAKE_ENV_KEY });
const envBroker = createSecretsBroker({
  policy: policyDoc,
  recorder: createJsonlRecorder(join(work, "audit-env.jsonl")),
  secretSource: envSource,
});
const envExecutor = createFakeHttpExecutor();
const envRes = await envBroker.execute(
  {
    ...base,
    action_id: "a8",
    kind: "http.call",
    permission_class: "NETWORK_WRITE",
    payload: { method: "GET", url: "https://api.example.test/ping" },
    secret_refs: [{ name: "EXAMPLE_ENV_KEY", type: "api_key", slot: "authorization" }],
  },
  envExecutor,
);
check(
  "env source: allowed action executes with the env secret (hash proof)",
  envRes.status === "executed" &&
    envExecutor.log[0].secret_hashes.authorization === sha256Hex(FAKE_ENV_KEY),
);

// --- whole-trail sweep ----------------------------------------------
check(
  "whole main audit trail is free of every fixture secret",
  containsNoFake(readFileSync(auditPath, "utf8")),
);

console.log(
  failures.length === 0
    ? `\nghostguard-secrets: ${passed} passed, 0 failed`
    : `\nghostguard-secrets: ${passed} passed, ${failures.length} failed: ${failures.join("; ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
