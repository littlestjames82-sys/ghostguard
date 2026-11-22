#!/usr/bin/env node
/**
 * Approval-channels tests — the ONLY webhook these tests ever call
 * is a local stub HTTP server booted right here on an ephemeral
 * port. No real service is contacted, ever.
 *
 * Proves: the payload format per template, the escalation metadata
 * + "timeout = deny" stated in the message, a loud failure on a
 * dead webhook, and the fail-closed timeout pass (a timed-out ask
 * gets a DENY decision entry; a human-decided ask is untouched; a
 * not-yet-timed-out ask is untouched).
 */
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expireTimeouts, formatAskMessage, notifyAsk, readDecisions, NotifyError } from "../notify.mjs";

let pass = 0, failCount = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ASK = {
  action_id: "act_deploy_42", kind: "ops.deploy", permission_class: "DEPLOY",
  actor: "ci-agent", initiator: "routine", project_id: "demo",
  verdict: "ask", rule_id: "deploys-ask", reason: "deploys need a human first",
  handoff_to: null, target_ref: null, snapshot_id: null, target: null,
  action_payload: { service: "web", ref: "main" }, dry_run: false,
};
const T0 = new Date("2026-10-10T05:00:00.000Z");
const CONFIG = { format: "generic", timeoutMs: 15 * 60 * 1000, escalateAfterMs: 5 * 60 * 1000, channelLabel: "test" };

// --- local stub webhook server (the only server involved) ---
const received = [];
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => { received.push({ url: req.url, body }); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.address().port}/hook`;

try {
  // 1. Generic format end-to-end against the stub.
  const sent = await notifyAsk(ASK, { ...CONFIG, webhookUrl: stubUrl }, { now: T0 });
  check("notifyAsk posts to the local stub and reports sent", sent.sent === true && received.length === 1);
  const payload = JSON.parse(received[0].body);
  check("generic payload carries text + record + meta", typeof payload.text === "string" && payload.record?.action_id === "act_deploy_42" && !!payload.meta);
  check("message states the held action, rule, and exact payload",
    payload.text.includes("ops.deploy") && payload.text.includes("deploys-ask") && payload.text.includes('"service":"web"'));
  check("message carries asked_at + escalate_after",
    payload.text.includes("asked_at: 2026-10-10T05:00:00.000Z") && payload.text.includes("escalate_after: 2026-10-10T05:05:00.000Z"));
  check("message states TIMEOUT = DENY out loud", /Timeout = DENY/.test(payload.text) && /never an approval/.test(payload.text));
  check("meta.on_timeout is 'deny'", sent.meta.on_timeout === "deny");

  // 2. Format templates.
  const meta = sent.meta;
  check("slack template is { text }", JSON.stringify(Object.keys(formatAskMessage(ASK, meta, "slack"))) === JSON.stringify(["text"]));
  check("discord template is { content }", typeof formatAskMessage(ASK, meta, "discord").content === "string");
  check("telegram template is { text, parse_mode }", typeof formatAskMessage(ASK, meta, "telegram").text === "string");
  const slackSent = await notifyAsk(ASK, { ...CONFIG, webhookUrl: stubUrl, format: "slack" }, { now: T0 });
  check("slack-format notify also lands on the stub", slackSent.sent === true && received.length === 2);

  // 3. Guard rails.
  let threw = null;
  try { await notifyAsk({ ...ASK, verdict: "allow" }, { ...CONFIG, webhookUrl: stubUrl }, { now: T0 }); } catch (e) { threw = e; }
  check("a non-ask record is refused (NotifyError)", threw instanceof NotifyError);
  threw = null;
  try { await notifyAsk(ASK, { ...CONFIG, webhookUrl: "http://127.0.0.1:1/hook" }, { now: T0 }); } catch (e) { threw = e; }
  check("a dead webhook is a loud failure, not a silent drop", threw instanceof NotifyError);

  // 4. Fail-closed timeout pass.
  const dir = mkdtempSync(join(tmpdir(), "gg-chan-"));
  const decisionsFile = join(dir, "decisions.jsonl");
  const timedOutMeta = { ...meta, timeout_at: "2026-10-10T05:15:00.000Z" };
  const after = new Date("2026-10-10T05:16:00.000Z");

  const written = expireTimeouts([{ record: ASK, meta: timedOutMeta }], decisionsFile, { now: after });
  check("timed-out, undecided ask gets exactly one decision entry", written.length === 1 && existsSync(decisionsFile));
  check("the timeout entry is a DENY by ghostguard-timeout (never an approval)",
    written[0].decision === "deny" && written[0].approver === "ghostguard-timeout");
  const onDisk = readDecisions(decisionsFile);
  check("deny entry is on disk and readable", onDisk.length === 1 && onDisk[0].action_id === "act_deploy_42");

  const again = expireTimeouts([{ record: ASK, meta: timedOutMeta }], decisionsFile, { now: new Date("2026-10-10T06:00:00.000Z") });
  check("re-running the timeout pass writes nothing twice", again.length === 0 && readDecisions(decisionsFile).length === 1);

  const notYet = expireTimeouts([{ record: { ...ASK, action_id: "act_later" }, meta: timedOutMeta }], decisionsFile, { now: new Date("2026-10-10T05:10:00.000Z") });
  check("an ask inside its timeout is untouched", notYet.length === 0);

  // A human decision already on file protects the ask from the timeout pass.
  const decidedFile = join(dir, "decisions2.jsonl");
  const { appendFileSync } = await import("node:fs");
  appendFileSync(decidedFile, JSON.stringify({ entry_type: "decision", action_id: "act_decided", decision: "approve", approver: "ryan", decided_at: "2026-10-10T05:05:00.000Z" }) + "\n");
  const human = expireTimeouts([{ record: { ...ASK, action_id: "act_decided" }, meta: timedOutMeta }], decidedFile, { now: after });
  check("a human-decided ask is never overridden by the timeout pass",
    human.length === 0 && readDecisions(decidedFile).length === 1 && readDecisions(decidedFile)[0].decision === "approve");
} finally {
  stub.close();
}

console.log(`\napproval-channels: ${pass} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
